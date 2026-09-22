import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import {
  createPostgresOrderClosureStore,
  createPostgresOrderClosurePosition,
  type OrderClosureRecord,
  parseOrderingInstant,
} from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrderClosureAuthority } from "./merchant-order-closure-authority.js";
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
import { createSettledOrderClose } from "./settled-order-close.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  actorReference: string;
}
interface Command {
  orderReference: string;
  operationReference: string;
  expectedOrderVersion: number;
  expectedClosureVersion: number;
  reasonCode: string;
}
const fail = (): never => {
  throw new Error("ORDER_CLOSE_COMMAND_UNAVAILABLE");
};
/** Server-owned employee command; no client proof, Actor, Store, timestamp or Audit. */
export function createMerchantDiningOrderCloseCommand(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope,
    command: Command,
    authority: { authorize(): Promise<boolean> },
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    diningSessionReference: string;
    guestSessionReference: string;
  }>;
  newReference(): string;
  audit: Pick<AppendAuditRecordInput, "retentionPolicyCode" | "retentionPolicyVersion">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "orderReference",
      "operationReference",
      "expectedOrderVersion",
      "expectedClosureVersion",
      "reasonCode",
    ]);
    const reference = (v: unknown) => String(parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID"));
    const version = (v: unknown, min: number) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v >= 2147483647)
        return fail();
      return v;
    };
    if (typeof raw.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode))
      return fail();
    const command = Object.freeze({
      orderReference: reference(raw.orderReference),
      operationReference: reference(raw.operationReference),
      expectedOrderVersion: version(raw.expectedOrderVersion, 1),
      expectedClosureVersion: version(raw.expectedClosureVersion, 0),
      reasonCode: raw.reasonCode,
    });
    return options.persistence.transactions.run(async (transaction) => {
      const current = await resolveScope(
        transaction,
        input.sessionCookie,
        "order.close",
        authenticated.sessionReference,
      );
      if ((await current.allowed()) !== true) return fail();
      const scope = {
          tenantReference: current.selected.tenantReference,
          brandReference: String(current.context.brand.brandReference),
          storeReference: String(current.store.storeReference),
        },
        actorReference = String(current.actorReference);
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object") return fail();
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown,
            rowCount = Object.getOwnPropertyDescriptor(result, "rowCount")?.value as unknown;
          if (
            !Array.isArray(rows) ||
            (rowCount !== null &&
              (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0))
          )
            return fail();
          return { rows: rows as readonly Row[], rowCount: rowCount as number | null };
        },
      };
      const merchantAuthority = createMerchantOrderClosureAuthority(
        options.persistence,
        input.sessionCookie,
      );
      const authorize = async () => (await current.allowed()) === true;
      const authorizeRecord = async (inner: ConsumerTransaction, record: OrderClosureRecord) =>
        record.orderReference === command.orderReference &&
        String(record.actorReference) === actorReference &&
        (await authorize()) &&
        (await merchantAuthority(inner, record));
      const closureAudit = async (record: OrderClosureRecord) => ({
        ...options.audit,
        auditId: options.newReference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: actorReference },
        actionCode: "ORDER_CLOSURE_RECORDED",
        targetType: "Order",
        targetId: record.orderReference,
        afterSummary: { status: "Closed", closureVersion: record.closureVersion },
        reasonCode: record.reasonCode,
        correlationId: record.operationReference,
        occurredAt: record.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
      });
      const receiptStore = createPostgresOrderClosureStore({
        ...scope,
        authorize: authorizeRecord,
        audit: closureAudit,
        closeEvidence: async () => fail(),
        reopenEvidence: async () => fail(),
      });
      const now = String(parseOrderingInstant(options.persistence.now()));
      const prior = await receiptStore.readOperation(
        tx,
        {
          orderReference: command.orderReference,
          operationReference: command.operationReference,
          observedAt: now,
        },
        authorize,
      );
      if (
        prior &&
        (prior.status !== "Closed" ||
          prior.actorType !== "User" ||
          String(prior.actorReference) !== actorReference ||
          prior.orderVersion !== command.expectedOrderVersion ||
          prior.closureVersion !== command.expectedClosureVersion + 1 ||
          prior.reasonCode !== command.reasonCode)
      )
        return fail();
      const configuration = await options.resolveConfiguration(
        tx,
        { ...scope, actorReference },
        command,
        { authorize },
      );
      const sourceOptions = {
        ...scope,
        diningScope: scope,
        paymentScope: {
          ...scope,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
        },
        authorize,
        authorizeKitchen: authorize,
        authorizeDining: authorize,
      };
      const evidence = createDiningSettledCloseEvidence(sourceOptions);
      const observedAt = prior ? String(prior.occurredAt) : now;
      const evidenceInput = {
        ...scope,
        transaction: tx,
        orderReference: command.orderReference,
        diningSessionReference: configuration.diningSessionReference,
        guestSessionReference: configuration.guestSessionReference,
        observedAt,
      };
      const runtime = createSettledOrderClose({
        payment: {
          scope,
          providerAccountReference: configuration.providerAccountReference,
          environment: configuration.environment,
          authorize,
          audit: async (fact) => ({
            ...options.audit,
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "ORDER_FINANCIAL_FINALITY_RECORDED",
            targetType: "Order",
            targetId: fact.orderReference,
            afterSummary: { classification: "Settled" },
            reasonCode: "ORDER_SETTLED",
            correlationId: fact.operationReference,
            occurredAt: fact.decidedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
          }),
        },
        closure: { ...scope, authorize: authorizeRecord, audit: closureAudit },
        closeEvidence: async (_inner, _record, fact) =>
          (await evidence.load(evidenceInput, fact)).evidence,
      });
      const financial = {
        finalityReference: prior?.financialFinalityReference ?? reference(options.newReference()),
        operationReference: command.operationReference,
        orderReference: command.orderReference,
        expectedOrderVersion: command.expectedOrderVersion,
        observedAt,
      };
      let result;
      if (prior) {
        result = await runtime.commit(tx, { closure: prior, financial });
      } else {
        const position = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, {
          orderReference: command.orderReference,
          observedAt,
        });
        if (
          position.status !== "Open" ||
          position.orderVersion !== command.expectedOrderVersion ||
          position.closureVersion !== command.expectedClosureVersion
        )
          return fail();
        const closureReference = reference(options.newReference());
        result = await runtime.commitPrepared(tx, {
          financial,
          authorizeIntent: authorize,
          prepareClosure: async (fact) => {
            const proof = await evidence.load(evidenceInput, fact);
            if (!proof.decision.eligible) return fail();
            return {
              ...scope,
              closureReference,
              operationReference: command.operationReference,
              orderReference: command.orderReference,
              closureVersion: position.closureVersion + 1,
              orderVersion: position.orderVersion,
              previousClosureReference: position.closureReference,
              status: "Closed",
              actorType: "User",
              actorReference,
              reasonCode: command.reasonCode,
              financialFinalityReference: fact.finalityReference,
              evidenceDigest: proof.evidenceDigest,
              occurredAt: observedAt,
            };
          },
        });
      }
      if ((await authorize()) !== true) return fail();
      return Object.freeze({
        status: result.status,
        closedOrderVersion: result.closure.orderVersion,
        closureVersion: result.closure.closureVersion,
      });
    });
  };
}

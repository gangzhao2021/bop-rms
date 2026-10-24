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
import {
  withMerchantTransactionAuthorization,
  type MerchantTransactionAuthority,
} from "./merchant-transaction-authorization.js";
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
export type OrderCloseCommandErrorCode =
  | "ORDER_CLOSE_INPUT_INVALID"
  | "ORDER_CLOSE_PERMISSION_DENIED"
  | "ORDER_CLOSE_VERSION_CONFLICT"
  | "ORDER_CLOSE_ALREADY_CLOSED"
  | "ORDER_CLOSE_NOT_READY"
  | "ORDER_CLOSE_UNAVAILABLE";
/**
 * WP-2423 (B759): why an Order close was refused, so staff see the real reason (never a
 * permission message for an Order that is simply not ready). `reasons` are the settlement and
 * closure-eligibility reason codes of ORDER_CLOSE_NOT_READY.
 */
export class OrderCloseCommandError extends Error {
  constructor(
    readonly code: OrderCloseCommandErrorCode,
    readonly reasons: readonly string[] = [],
  ) {
    super(code);
    this.name = "OrderCloseCommandError";
  }
}
const reference = (v: unknown) => String(parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID"));
const refuse = (code: OrderCloseCommandErrorCode, reasons: readonly string[] = []): never => {
  throw new OrderCloseCommandError(code, reasons);
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
    try {
      return await run(input);
    } catch (error) {
      if (error instanceof OrderCloseCommandError) throw error;
      return refuse("ORDER_CLOSE_UNAVAILABLE");
    }
  };
  async function run(input: { sessionCookie: unknown; csrf: unknown; command: unknown }) {
    let authenticated: Awaited<ReturnType<MerchantBffService["authorize"]>>;
    try {
      authenticated = await options.authentication.authorize(input);
    } catch {
      return refuse("ORDER_CLOSE_PERMISSION_DENIED");
    }
    let command: Command;
    try {
      command = parseCommand(input.command);
    } catch {
      return refuse("ORDER_CLOSE_INPUT_INVALID");
    }
    return runCommand(input, authenticated, command);
  }
  function parseCommand(value: unknown): Command {
    const raw = readClosedRecord(value, [
      "orderReference",
      "operationReference",
      "expectedOrderVersion",
      "expectedClosureVersion",
      "reasonCode",
    ]);
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
    return command;
  }
  function runCommand(
    input: { sessionCookie: unknown },
    authenticated: Awaited<ReturnType<MerchantBffService["authorize"]>>,
    command: Command,
  ) {
    // WP-2423: one authorized run. The caller (Session, selection, membership, store assignment and
    // the `order.close` permission) is resolved in full once at the start and once more before the
    // reply; every owner read in between is fenced by the run's guard, which costs no query.
    // Re-resolving the caller inside every owner read (as before) cost thousands of statements and
    // held the Order's payment and closure rows for 7-8 s on a one-round table.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            let current: Awaited<ReturnType<typeof resolveScope>>;
            try {
              current = await resolveScope(
                transaction,
                input.sessionCookie,
                "order.close",
                authenticated.sessionReference,
              );
            } catch {
              return refuse("ORDER_CLOSE_PERMISSION_DENIED");
            }
            if ((await current.allowed()) !== true) return refuse("ORDER_CLOSE_PERMISSION_DENIED");
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied: () => refuse("ORDER_CLOSE_PERMISSION_DENIED"),
        },
        (authority) => closeInRun(transaction, authority, command),
      ),
    );
  }
  async function closeInRun(
    transaction: Parameters<Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]>[0],
    authority: MerchantTransactionAuthority<Awaited<ReturnType<typeof resolveScope>>>,
    command: Command,
  ) {
    const current = authority.scope;
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
    // Owner reads: fenced by this run (no query); the caller is re-resolved in full before the reply.
    const authorize = () => authority.guard();
    // The closure record is this staff member's, for this Order, in the Store resolved for the run.
    const authorizeRecord = async (_inner: ConsumerTransaction, record: OrderClosureRecord) =>
      record.orderReference === command.orderReference &&
      record.status === "Closed" &&
      record.actorType === "User" &&
      String(record.actorReference) === actorReference &&
      String(record.tenantReference) === String(scope.tenantReference) &&
      String(record.brandReference) === scope.brandReference &&
      String(record.storeReference) === scope.storeReference &&
      (await authorize());
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
      // WP-2423 item 2: an Order whose every round was cancelled can be closed (nothing owed).
      includeCancelled: true,
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
      if (position.status !== "Open") return refuse("ORDER_CLOSE_ALREADY_CLOSED");
      if (
        position.orderVersion !== command.expectedOrderVersion ||
        position.closureVersion !== command.expectedClosureVersion
      )
        return refuse("ORDER_CLOSE_VERSION_CONFLICT");
      // WP-2423 (B759): the same evaluation the closure evidence applies, read first so a
      // refusal names what is outstanding (refund still processing, items not resolved, …).
      const readiness = await evidence.readiness(evidenceInput);
      if (readiness === null) return refuse("ORDER_CLOSE_ALREADY_CLOSED");
      if (readiness.orderVersion !== command.expectedOrderVersion)
        return refuse("ORDER_CLOSE_VERSION_CONFLICT");
      if (readiness.reasons.length > 0) return refuse("ORDER_CLOSE_NOT_READY", readiness.reasons);
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
  }
}

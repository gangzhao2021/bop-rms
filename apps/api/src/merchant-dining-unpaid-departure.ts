import type { ConsumerTransaction } from "@bop/eventing";
import type { AppendAuditRecordInput } from "@bop/audit";
import { readClosedRecord, parseOpaqueUuidV7 } from "@bop/identity";
import { createPostgresDiningSessionReadStore } from "@rms/dining";
import {
  createPostgresOrderClosurePosition,
  createPostgresOrderClosureStore,
  parseOrderingInstant,
  type OrderClosureRecord,
} from "@rms/ordering";
import {
  createPostgresDiningTableSettlementStore,
  DiningTableSettlementStoreError,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createDiningSettledCloseEvidence } from "./dining-settled-close-evidence.js";
import type { createMerchantDiningOrderCloseCommand } from "./merchant-dining-order-close-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a table left without paying what it still owed. A manager
 * (`payment.refund.approve`, who may also close Orders) records it with its reason; Payment keeps
 * the write-off (the amount still owed, who decided, when, on which Order version) and the table's
 * Order is closed on it in the same transaction, as an Order the store wrote off — never hidden or
 * removed: the sale and what was paid stay in every report. The table is then closed as usual.
 * Everything else a close requires still applies (items served or resolved, nothing pending).
 */
export const unpaidDepartureApprovalPermission = "payment.refund.approve" as const;
export const unpaidDepartureReasonCode = "GUEST_LEFT_UNPAID" as const;

export type UnpaidDepartureErrorCode =
  | "UNPAID_DEPARTURE_INPUT_INVALID"
  | "UNPAID_DEPARTURE_PERMISSION_DENIED"
  | "UNPAID_DEPARTURE_NOT_AT_CHECKOUT"
  | "UNPAID_DEPARTURE_NOTHING_OWED"
  | "UNPAID_DEPARTURE_NOT_READY"
  | "UNPAID_DEPARTURE_VERSION_CONFLICT"
  | "UNPAID_DEPARTURE_ALREADY_CLOSED"
  | "UNPAID_DEPARTURE_UNAVAILABLE";
export class UnpaidDepartureError extends Error {
  constructor(
    readonly code: UnpaidDepartureErrorCode,
    readonly reasons: readonly string[] = [],
  ) {
    super(code);
    this.name = "UnpaidDepartureError";
  }
}
const refuse = (code: UnpaidDepartureErrorCode, reasons: readonly string[] = []): never => {
  throw new UnpaidDepartureError(code, reasons);
};
const reference = (v: unknown) => String(parseOpaqueUuidV7(v, "ACTOR_REFERENCE_INVALID"));

type Resolve = Parameters<typeof createMerchantDiningOrderCloseCommand>[0]["resolveConfiguration"];

export function createMerchantDiningUnpaidDeparture(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration: Resolve;
  newReference(): string;
  audit: Pick<AppendAuditRecordInput, "retentionPolicyCode" | "retentionPolicyVersion">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    let authenticated: Awaited<ReturnType<MerchantBffService["authorize"]>>;
    try {
      authenticated = await options.authentication.authorize(input);
    } catch {
      return refuse("UNPAID_DEPARTURE_PERMISSION_DENIED");
    }
    let command: {
      orderReference: string;
      operationReference: string;
      expectedOrderVersion: number;
      expectedClosureVersion: number;
    };
    try {
      const raw = readClosedRecord(input.command, [
        "orderReference",
        "operationReference",
        "expectedOrderVersion",
        "expectedClosureVersion",
      ]);
      const version = (v: unknown, min: number) => {
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v >= 2147483647)
          throw new Error();
        return v;
      };
      command = {
        orderReference: reference(raw.orderReference),
        operationReference: reference(raw.operationReference),
        expectedOrderVersion: version(raw.expectedOrderVersion, 1),
        expectedClosureVersion: version(raw.expectedClosureVersion, 0),
      };
    } catch {
      return refuse("UNPAID_DEPARTURE_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                "order.close",
                authenticated.sessionReference,
              ).catch(() => refuse("UNPAID_DEPARTURE_PERMISSION_DENIED"));
              const decisions = await current.authorizeActions([
                "order.close",
                unpaidDepartureApprovalPermission,
              ]);
              if (
                decisions.get("order.close")?.effect !== "Allow" ||
                decisions.get(unpaidDepartureApprovalPermission)?.effect !== "Allow"
              )
                return refuse("UNPAID_DEPARTURE_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => refuse("UNPAID_DEPARTURE_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const current = authority.scope;
            const scope = {
                tenantReference: String(current.selected.tenantReference),
                brandReference: String(current.context.brand.brandReference),
                storeReference: String(current.store.storeReference),
              },
              actorReference = String(current.actorReference);
            const authorize = () => authority.guard();
            const configuration = await options.resolveConfiguration(
              tx,
              { ...scope, actorReference },
              { ...command, reasonCode: unpaidDepartureReasonCode },
              { authorize },
            );
            const payment = createPostgresDiningTableSettlementStore({
              scope,
              authorize: async (_tx, value) =>
                value.orderReference === command.orderReference && (await authorize()) === true,
            });
            const closureAudit = async (record: OrderClosureRecord) => ({
              ...options.audit,
              auditId: options.newReference(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "User" as const, reference: actorReference },
              actionCode: "ORDER_CLOSURE_RECORDED",
              targetType: "Order",
              targetId: record.orderReference,
              afterSummary: { status: "Closed", closureVersion: record.closureVersion },
              reasonCode: record.reasonCode,
              correlationId: record.operationReference,
              occurredAt: record.occurredAt,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Restricted" as const,
            });
            const authorizeRecord = async (
              _inner: ConsumerTransaction,
              record: OrderClosureRecord,
            ) =>
              record.orderReference === command.orderReference &&
              record.status === "Closed" &&
              record.actorType === "User" &&
              String(record.actorReference) === actorReference &&
              record.reasonCode === unpaidDepartureReasonCode &&
              (await authorize()) === true;
            const now = String(parseOrderingInstant(options.persistence.now()));
            const evidence = createDiningSettledCloseEvidence({
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
              includeCancelled: true,
            });
            const evidenceInput = {
              ...scope,
              transaction: tx,
              orderReference: command.orderReference,
              diningSessionReference: configuration.diningSessionReference,
              guestSessionReference: configuration.guestSessionReference,
              observedAt: now,
            };
            // A retry of the same command returns what it recorded.
            const prior = (await payment.listWriteOffsByOrders(tx, [command.orderReference]))[0];
            if (prior !== undefined) {
              if (prior.operationReference !== command.operationReference)
                return refuse("UNPAID_DEPARTURE_ALREADY_CLOSED");
              return Object.freeze({
                status: "AlreadyRecorded" as const,
                writtenOffMinor: prior.writtenOffMinor.toString(),
              });
            }
            const [session] = await createPostgresDiningSessionReadStore(
              { run: (work) => work(tx) },
              scope,
            ).loadSessions([configuration.diningSessionReference]);
            if (!session || session.phase !== "Closing")
              return refuse("UNPAID_DEPARTURE_NOT_AT_CHECKOUT");
            const position = await createPostgresOrderClosurePosition({ ...scope, authorize })(tx, {
              orderReference: command.orderReference,
              observedAt: now,
            });
            if (position.status !== "Open") return refuse("UNPAID_DEPARTURE_ALREADY_CLOSED");
            if (
              position.orderVersion !== command.expectedOrderVersion ||
              position.closureVersion !== command.expectedClosureVersion
            )
              return refuse("UNPAID_DEPARTURE_VERSION_CONFLICT");
            const basis = await evidence.writeOffBasis(evidenceInput);
            if (basis === null) return refuse("UNPAID_DEPARTURE_ALREADY_CLOSED");
            if (basis.orderVersion !== command.expectedOrderVersion)
              return refuse("UNPAID_DEPARTURE_VERSION_CONFLICT");
            if (basis.classification !== "Unpaid" || basis.owedMinor <= 0n)
              return refuse(
                basis.reasons.length > 0
                  ? "UNPAID_DEPARTURE_NOT_READY"
                  : "UNPAID_DEPARTURE_NOTHING_OWED",
                basis.reasons,
              );
            if (basis.reasons.length > 0)
              return refuse("UNPAID_DEPARTURE_NOT_READY", basis.reasons);
            const writeOffReference = reference(options.newReference());
            await tx.query("SAVEPOINT unpaid_departure", []);
            try {
              const recorded = await payment.recordWriteOff(tx, {
                writeOffReference,
                operationReference: command.operationReference,
                diningSessionReference: configuration.diningSessionReference,
                orderReference: command.orderReference,
                orderVersion: basis.orderVersion,
                orderCheckpoint: basis.orderCheckpoint,
                reasonCode: unpaidDepartureReasonCode,
                pricedOrderTotalMinor: basis.pricedOrderTotalMinor,
                capturedOrderAllocationMinor: basis.capturedOrderAllocationMinor,
                writtenOffMinor: basis.owedMinor,
                requestedByActorReference: actorReference,
                approvedByActorReference: actorReference,
                orderEvidenceDigest: basis.orderEvidenceDigest,
                paymentEvidenceDigest: basis.paymentEvidenceDigest,
                decidedAt: basis.observedAt,
                auditReference: options.newReference(),
                correlationReference: command.operationReference,
              });
              const writeOff = recorded.writeOff;
              const proof = await evidence.loadWriteOff(evidenceInput, writeOff);
              if (!proof.decision.eligible)
                return refuse("UNPAID_DEPARTURE_NOT_READY", proof.decision.reasons);
              const closure = await createPostgresOrderClosureStore({
                ...scope,
                authorize: authorizeRecord,
                audit: closureAudit,
                reopenEvidence: async () => refuse("UNPAID_DEPARTURE_UNAVAILABLE"),
                closeEvidence: async () =>
                  (await evidence.loadWriteOff(evidenceInput, writeOff)).evidence,
              }).commit(tx, {
                ...scope,
                closureReference: reference(options.newReference()),
                operationReference: command.operationReference,
                orderReference: command.orderReference,
                closureVersion: position.closureVersion + 1,
                orderVersion: position.orderVersion,
                previousClosureReference: position.closureReference,
                status: "Closed",
                actorType: "User",
                actorReference,
                reasonCode: unpaidDepartureReasonCode,
                financialFinalityReference: writeOff.writeOffReference,
                evidenceDigest: proof.evidenceDigest,
                occurredAt: basis.observedAt,
              });
              await tx.query("RELEASE SAVEPOINT unpaid_departure", []);
              if ((await authorize()) !== true) return refuse("UNPAID_DEPARTURE_PERMISSION_DENIED");
              return Object.freeze({
                status: "Recorded" as const,
                writtenOffMinor: writeOff.writtenOffMinor.toString(),
                closedOrderVersion: closure.record.orderVersion,
                closureVersion: closure.record.closureVersion,
              });
            } catch (error) {
              await tx.query("ROLLBACK TO SAVEPOINT unpaid_departure", []);
              await tx.query("RELEASE SAVEPOINT unpaid_departure", []);
              throw error;
            }
          },
        ),
      );
    } catch (error) {
      if (error instanceof UnpaidDepartureError) throw error;
      if (
        error instanceof DiningTableSettlementStoreError &&
        error.code === "DINING_TABLE_WRITE_OFF_ALREADY_RECORDED"
      )
        return refuse("UNPAID_DEPARTURE_ALREADY_CLOSED");
      return refuse("UNPAID_DEPARTURE_UNAVAILABLE");
    }
  };
}

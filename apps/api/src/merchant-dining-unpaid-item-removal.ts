import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createPostgresFulfillmentItemCancellation } from "@rms/fulfillment";
import {
  createPostgresKitchenBatchCancellation,
  KitchenBatchCancellationError,
} from "@rms/kitchen";
import {
  createPostgresPayLaterItemCancellationStore,
  parseOrderingInstant,
  parseOrderingReference,
  parseStaffItemCancellationSelection,
  staffOrderCancellationReasonCodes,
  type StaffOrderCancellationReasonCode,
} from "@rms/ordering";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (rule 2): staff take dishes — or a whole round — off the bill of a
 * table that pays at the end, before it pays, with who and why. One transaction, as a paid item
 * cancellation without the refund: Ordering's fence and eligibility → the kitchen cancels the work
 * of exactly those lines (still unstarted) → Ordering's append-only cancellation on the
 * 'PayLater' basis (revision, audit) → fulfillment leaves them out → their reserved stock returns.
 * Refused once the table has paid (a paid table's dishes are refunded instead).
 */
export type UnpaidItemRemovalErrorCode =
  | "UNPAID_ITEM_REMOVAL_INPUT_INVALID"
  | "UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"
  | "UNPAID_ITEM_REMOVAL_NOT_FOUND"
  | "UNPAID_ITEM_REMOVAL_NOT_PAY_LATER"
  | "UNPAID_ITEM_REMOVAL_ALREADY_PAID"
  | "UNPAID_ITEM_REMOVAL_VERSION_CONFLICT"
  | "UNPAID_ITEM_REMOVAL_NOT_REMOVABLE"
  | "UNPAID_ITEM_REMOVAL_PREPARATION_STARTED"
  | "UNPAID_ITEM_REMOVAL_UNAVAILABLE";
export class UnpaidItemRemovalError extends Error {
  constructor(readonly code: UnpaidItemRemovalErrorCode) {
    super(code);
    this.name = "UnpaidItemRemovalError";
  }
}
const fail = (code: UnpaidItemRemovalErrorCode): never => {
  throw new UnpaidItemRemovalError(code);
};
const databaseCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

export function createMerchantDiningUnpaidItemRemoval(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    let intent: {
      orderReference: string;
      orderBatchReference: string;
      orderItemReferences: readonly string[];
      expectedOrderVersion: number;
      operationReference: string;
      reasonCode: StaffOrderCancellationReasonCode;
    };
    try {
      const raw = readClosedRecord(input.command, [
        "orderReference",
        "orderBatchReference",
        "orderItemReferences",
        "expectedOrderVersion",
        "operationReference",
        "reasonCode",
      ]);
      if (
        typeof raw.expectedOrderVersion !== "number" ||
        !Number.isSafeInteger(raw.expectedOrderVersion) ||
        raw.expectedOrderVersion < 2 ||
        typeof raw.reasonCode !== "string" ||
        !(staffOrderCancellationReasonCodes as readonly string[]).includes(raw.reasonCode)
      )
        throw new Error();
      intent = {
        orderReference: String(parseOrderingReference(raw.orderReference)),
        orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
        orderItemReferences: parseStaffItemCancellationSelection(raw.orderItemReferences).map(
          String,
        ),
        expectedOrderVersion: raw.expectedOrderVersion,
        operationReference: String(parseOrderingReference(raw.operationReference)),
        reasonCode: raw.reasonCode as StaffOrderCancellationReasonCode,
      };
    } catch {
      return fail("UNPAID_ITEM_REMOVAL_INPUT_INVALID");
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
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(() => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("UNPAID_ITEM_REMOVAL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = authority.scope;
            const guard = () => authority.guard();
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            await options.installContext(tx, selected);
            const ordering = createPostgresPayLaterItemCancellationStore({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: async (t, value) =>
                t === tx && value.orderReference === intent.orderReference && (await guard()),
            });
            const result = (
              record: Awaited<ReturnType<typeof ordering.loadByOperation>> & object,
              status: "Removed" | "AlreadyRemoved",
            ) =>
              Object.freeze({
                status,
                orderReference: record.orderReference,
                orderBatchReference: record.orderBatchReference,
                orderItemReferences: record.orderItemReferences,
                cancelledOrderVersion: record.cancelledOrderVersion,
              });
            const prior = await ordering.loadByOperation(tx, intent.operationReference);
            if (prior !== null) {
              if (
                prior.orderReference !== intent.orderReference ||
                prior.orderBatchReference !== intent.orderBatchReference ||
                prior.orderItemReferences.join(",") !== intent.orderItemReferences.join(",") ||
                prior.reasonCode !== intent.reasonCode ||
                prior.actorReference !== actorReference
              )
                return fail("UNPAID_ITEM_REMOVAL_NOT_REMOVABLE");
              return result(prior, "AlreadyRemoved");
            }
            // Once the table paid, its dishes are refunded instead (never taken off a paid bill).
            const payments = createPostgresDiningTableSettlementStore({
              scope: selected,
              authorize: async (_t, value) =>
                value.orderReference === intent.orderReference && (await guard()) === true,
            });
            const paid = await payments.listByOrders(tx, [intent.orderReference]);
            if (paid.length > 0) return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            // S4: while a guest pays the whole table on their phone, the bill can't change.
            if (
              (await payments.listOnlinePaymentsByOrders(tx, [intent.orderReference])).some(
                (attempt) => attempt.outcome === null,
              )
            )
              return fail("UNPAID_ITEM_REMOVAL_ALREADY_PAID");
            const prepared = await ordering.prepare(tx, intent);
            if (prepared.status === "NotEligible")
              return fail(
                prepared.reason === "NotFound" || prepared.reason === "ItemNotInBatch"
                  ? "UNPAID_ITEM_REMOVAL_NOT_FOUND"
                  : prepared.reason === "NotPayLater"
                    ? "UNPAID_ITEM_REMOVAL_NOT_PAY_LATER"
                    : prepared.reason === "VersionConflict"
                      ? "UNPAID_ITEM_REMOVAL_VERSION_CONFLICT"
                      : "UNPAID_ITEM_REMOVAL_NOT_REMOVABLE",
              );
            const plan = prepared.plan;
            const cancellationReference = String(parseOrderingReference(options.nextReference()));
            const cancelledAt = String(parseOrderingInstant(options.persistence.now()));
            const owned = async (
              t: ConsumerTransaction,
              identity: { orderReference: string; orderBatchReference: string },
            ) =>
              t === tx &&
              identity.orderReference === intent.orderReference &&
              identity.orderBatchReference === intent.orderBatchReference &&
              (await guard());
            const lines = plan.lines.map((line) => line.orderItemReference);
            const kitchen = await createPostgresKitchenBatchCancellation({
              ...selected,
              authorize: owned,
            }).cancelItems(tx, {
              orderReference: intent.orderReference,
              orderBatchReference: intent.orderBatchReference,
              orderItemReferences: lines,
              operationReference: intent.operationReference,
              orderCancellationReference: cancellationReference,
              actorReference,
              cancelledAt,
              auditReference: options.nextReference(),
              eventReference: options.nextReference(),
              nextReference: options.nextReference,
            });
            const { record } = await ordering.commit(tx, {
              plan,
              cancellationReference,
              operationReference: intent.operationReference,
              actorReference,
              reasonCode: intent.reasonCode,
              kitchenEvidenceDigest: kitchen.evidenceDigest,
              auditReference: options.nextReference(),
              cancelledAt,
            });
            await createPostgresFulfillmentItemCancellation({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: owned,
            }).cancelItems(tx, {
              orderReference: intent.orderReference,
              orderBatchReference: intent.orderBatchReference,
              orderItemReferences: lines,
              orderCancellationReference: cancellationReference,
              operationReference: options.nextReference(),
              auditReference: options.nextReference(),
              actorReference,
              cancelledAt,
              nextReference: options.nextReference,
            });
            const inventory = await createSubmissionInventoryRelease({
              scope: selected,
              systemActorReference: actorReference,
              reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
              now: options.persistence.now,
            }).releaseLines(tx, {
              source: {
                kind: "StaffItemCancellationInventory/v1",
                reference: cancellationReference,
                submissionReference: record.submissionReference,
                orderReference: record.orderReference,
                occurredAt: record.cancelledAt,
              },
              releasedAt: record.cancelledAt,
              authorize: guard,
              cartLineReferences: plan.lines.map((line) => line.sourceCartLineReference),
            });
            if (inventory.status === "NotReleasable")
              return fail("UNPAID_ITEM_REMOVAL_NOT_REMOVABLE");
            return result(record, "Removed");
          },
        ),
      );
    } catch (error) {
      if (error instanceof UnpaidItemRemovalError) throw error;
      if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
        return fail("UNPAID_ITEM_REMOVAL_PREPARATION_STARTED");
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("UNPAID_ITEM_REMOVAL_VERSION_CONFLICT");
      return fail("UNPAID_ITEM_REMOVAL_UNAVAILABLE");
    }
  };
}

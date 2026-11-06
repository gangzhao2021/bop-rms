import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createPostgresAsapCapacityStore } from "@rms/fulfillment";
import {
  counterUnpaidCancellationReasons,
  createPostgresCounterUnpaidCancellation,
  loadCounterOrderCapacityLink,
  parseOrderingInstant,
  parseOrderingReference,
  type CounterUnpaidCancellationReason,
} from "@rms/ordering";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentOperationFence,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";

export const counterCancellationErrorCodes = [
  "COUNTER_CANCEL_INPUT_INVALID",
  "COUNTER_CANCEL_PERMISSION_DENIED",
  "COUNTER_CANCEL_NOT_FOUND",
  "COUNTER_CANCEL_ALREADY_PAID",
  "COUNTER_CANCEL_PAPER_ORDER",
  "COUNTER_CANCEL_NOT_CANCELLABLE",
  "COUNTER_CANCEL_VERSION_CONFLICT",
  "COUNTER_CANCEL_STOCK_NOT_RELEASABLE",
  "COUNTER_CANCEL_UNAVAILABLE",
] as const;
export type CounterCancellationErrorCode = (typeof counterCancellationErrorCodes)[number];
export class CounterCancellationError extends Error {
  readonly code: CounterCancellationErrorCode;
  constructor(code: CounterCancellationErrorCode) {
    super("counter order cancellation is unavailable");
    this.name = "CounterCancellationError";
    this.code = code;
  }
}
const fail = (code: CounterCancellationErrorCode): never => {
  throw new CounterCancellationError(code);
};

/**
 * WP-2423 M127: a manager cancels a counter order nobody paid for (the guest changed their mind, it
 * was entered by mistake, or the guest left without paying), so its items go back to stock at once
 * instead of at the end of its payment window. Same people who may cancel orders and unpaid table
 * rounds (`ordering.order.cancel`). One transaction:
 * 1. the counter order's capacity link (Ordering's read); a paper order entered after an outage is
 *    a sale that already happened and is refused (it is recorded and paid, never cancelled);
 * 2. Payment's operation fence, then the batch's card-machine payment under the lock recording
 *    takes: a recorded payment refuses ("just paid"), and a payment recorded after this commits
 *    finds the order cancelled;
 * 3. Fulfillment's capacity commitment must not be consumed (no payment reached it);
 * 4. Ordering's append-only User termination naming the staff member and the reason, with audit;
 * 5. the reserved stock released in the same transaction (all or nothing).
 * The cancelled order stays on Orders as cancelled before payment by that staff member. Same
 * operation reference → the original outcome, nothing written.
 */
export function createMerchantCounterOrderCancellation(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ status: "Cancelled" | "AlreadyCancelled"; cancelledAt: string }> => {
    const session = await options.authentication.authorize(input);
    let orderReference: string,
      orderBatchReference: string,
      operationReference: string,
      expectedOrderVersion: number,
      reasonCode: CounterUnpaidCancellationReason;
    try {
      const intent = readClosedRecord(input.command, [
        "operationReference",
        "orderReference",
        "orderBatchReference",
        "expectedOrderVersion",
        "reasonCode",
      ]);
      orderReference = String(parseOrderingReference(intent.orderReference));
      orderBatchReference = String(parseOrderingReference(intent.orderBatchReference));
      operationReference = String(parseOrderingReference(intent.operationReference));
      const version = intent.expectedOrderVersion;
      const reason = counterUnpaidCancellationReasons.find((code) => code === intent.reasonCode);
      if (
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > 2147483646 ||
        reason === undefined
      )
        return fail("COUNTER_CANCEL_INPUT_INVALID");
      expectedOrderVersion = version;
      reasonCode = reason;
    } catch (error) {
      if (error instanceof CounterCancellationError) throw error;
      return fail("COUNTER_CANCEL_INPUT_INVALID");
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
              ).catch(onlyRefusal(() => fail("COUNTER_CANCEL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("COUNTER_CANCEL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("COUNTER_CANCEL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const scope = authority.scope;
            const allowed = () => authority.guard();
            const tx = transaction as unknown as ConsumerTransaction;
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            await options.installContext(tx, selected);
            const identity = { orderReference, orderBatchReference };
            const counter = await loadCounterOrderCapacityLink(tx, selected, identity);
            if (counter === null) return fail("COUNTER_CANCEL_NOT_FOUND");
            if (counter.recordedAfterOutage) return fail("COUNTER_CANCEL_PAPER_ORDER");
            const link = counter.link;
            await createPostgresPaymentOperationFence({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              now: options.persistence.now,
              authorize: async (t, query) =>
                (t as unknown) === tx &&
                query.orderReference === orderReference &&
                query.paymentOperationReference === String(link.paymentOperationReference) &&
                (await allowed()),
            }).acquire(tx, {
              orderReference,
              paymentOperationReference: link.paymentOperationReference,
            });
            const payments = createPostgresCardMachinePaymentStore({
              scope: selected,
              authorize: async (_t, value) =>
                value.orderReference === orderReference && (await allowed()),
            });
            if (
              (await payments.lockAndLoadByBatch(tx, orderReference, orderBatchReference)) !== null
            )
              return fail("COUNTER_CANCEL_ALREADY_PAID");
            const commitment = await createPostgresAsapCapacityStore(
              { run: async (work) => work(tx) },
              { brandReference: selected.brandReference, storeReference: selected.storeReference },
              { now: options.persistence.now },
            ).withCurrentSubmission(link.submissionReference, async (_, current) => current);
            if (
              commitment === null ||
              String(commitment.orderReference) !== orderReference ||
              String(commitment.orderBatchReference) !== orderBatchReference
            )
              return fail("COUNTER_CANCEL_UNAVAILABLE");
            if (commitment.state === "Consumed") return fail("COUNTER_CANCEL_ALREADY_PAID");
            const cancelled = await createPostgresCounterUnpaidCancellation({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: async (t, value) =>
                t === tx &&
                value.orderReference === orderReference &&
                value.orderBatchReference === orderBatchReference &&
                (await allowed()),
            }).cancel(tx, {
              ...identity,
              operationReference,
              expectedOrderVersion,
              actorReference,
              reasonCode,
              cancelledAt: parseOrderingInstant(options.persistence.now()),
              terminationReference: options.nextReference(),
              auditReference: options.nextReference(),
            });
            if (cancelled.status === "NotEligible")
              return fail(
                cancelled.reason === "PaymentRecorded"
                  ? "COUNTER_CANCEL_ALREADY_PAID"
                  : cancelled.reason === "PaperOrder"
                    ? "COUNTER_CANCEL_PAPER_ORDER"
                    : cancelled.reason === "VersionConflict"
                      ? "COUNTER_CANCEL_VERSION_CONFLICT"
                      : cancelled.reason === "NotCounter"
                        ? "COUNTER_CANCEL_NOT_FOUND"
                        : "COUNTER_CANCEL_NOT_CANCELLABLE",
              );
            const record = cancelled.record;
            // The ledger movement names the staff member; a replay verifies the earlier release.
            const inventory = await createSubmissionInventoryRelease({
              scope: selected,
              systemActorReference: actorReference,
              reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
              now: options.persistence.now,
            }).release(tx, {
              source: {
                kind: "CounterUnpaidCancellationInventory/v1",
                reference: String(record.terminationReference),
                submissionReference: String(link.submissionReference),
                orderReference,
                occurredAt: String(record.terminatedAt),
              },
              releasedAt:
                cancelled.status === "Cancelled"
                  ? String(record.terminatedAt)
                  : options.persistence.now(),
              authorize: allowed,
            });
            if (inventory.status === "NotReleasable")
              return fail("COUNTER_CANCEL_STOCK_NOT_RELEASABLE");
            return Object.freeze({
              status: cancelled.status,
              cancelledAt: String(record.terminatedAt),
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof CounterCancellationError) throw error;
      return keepingCause(() => fail("COUNTER_CANCEL_UNAVAILABLE"))(error);
    }
  };
}

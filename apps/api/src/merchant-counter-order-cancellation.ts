import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createPostgresAsapCapacityStore, releaseCancelledAsapCapacity } from "@rms/fulfillment";
import {
  counterUnpaidCancellationReasons,
  createPostgresCounterUnpaidCancellation,
  listPaperReentryCandidates,
  loadCounterOrderBatch,
  loadCounterOrderCapacityLink,
  parseOrderingInstant,
  parseOrderingReference,
  type CounterUnpaidCancellationReason,
} from "@rms/ordering";
import {
  cardMachinePaymentTakenMinor,
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
  /**
   * DEC-PAPER-ORDER-NEVER-RELEASED: the paper order's payment can still be recorded on it (its
   * payment window has not ended), so it is recorded there, not entered again.
   */
  "COUNTER_CANCEL_PAPER_STILL_RECORDABLE",
  /** The new order is not a paper order of this Store, sent after this one, with its payment. */
  "COUNTER_CANCEL_REENTRY_INVALID",
  /** The new order already stands for another paper order. */
  "COUNTER_CANCEL_REENTRY_USED",
  /**
   * The new order's sale (dishes with tax, before tip) is lower than the paper order's: it cannot
   * carry that sale.
   */
  "COUNTER_CANCEL_REENTRY_AMOUNT_LOWER",
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
 * 5. the reserved stock released in the same transaction (all or nothing);
 * 6. Fulfillment's capacity commitment released, so its pickup place is free at once
 *    (DEC-CANCELLED-ORDER-FREES-PICKUP-PLACE).
 * The cancelled order stays on Orders as cancelled before payment by that staff member. Same
 * operation reference → the original outcome, nothing written.
 *
 * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order is never cancelled, and its payment window never
 * releases it. When its payment could not be recorded before that window ended, staff enter it
 * again from the paper slip as a new paper order (whose payment is recorded with it); a manager
 * then closes the old one as entered again (`COUNTER_PAPER_REENTERED`), naming the new order: only
 * after the old one's window ended, only a paper counter order of this Store sent after it whose
 * payment Payment holds, and each new order once. The sale is then in the books once, as the new
 * order, and the old one reads on Orders as entered again.
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
      reasonCode: CounterUnpaidCancellationReason,
      reenteredOrderReference: string | null = null;
    try {
      const reentry =
        input.command !== null &&
        typeof input.command === "object" &&
        (input.command as { reasonCode?: unknown }).reasonCode === "COUNTER_PAPER_REENTERED";
      const intent = readClosedRecord(input.command, [
        "operationReference",
        "orderReference",
        "orderBatchReference",
        "expectedOrderVersion",
        "reasonCode",
        ...(reentry ? ["reenteredOrderReference"] : []),
      ]);
      if (reentry)
        reenteredOrderReference = String(parseOrderingReference(intent.reenteredOrderReference));
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
            if (counter.recordedAfterOutage !== (reenteredOrderReference !== null))
              return fail(
                counter.recordedAfterOutage
                  ? "COUNTER_CANCEL_PAPER_ORDER"
                  : "COUNTER_CANCEL_NOT_CANCELLABLE",
              );
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
            if (reenteredOrderReference !== null) {
              // Its payment is recorded on it while its window is open; only after it is it
              // entered again.
              const endsAt = commitment.capacityExpiresAt ?? commitment.preparationValidUntil;
              if (String(parseOrderingInstant(options.persistence.now())) < String(endsAt))
                return fail("COUNTER_CANCEL_PAPER_STILL_RECORDABLE");
              // The new order's payment is Payment's fact.
              const reentered = await loadCounterOrderBatch(tx, selected, reenteredOrderReference);
              if (reentered === null || !reentered.recordedAfterOutage || reentered.ended)
                return fail("COUNTER_CANCEL_REENTRY_INVALID");
              const reenteredPayment = await createPostgresCardMachinePaymentStore({
                scope: selected,
                authorize: async (_t, value) =>
                  value.orderReference === reenteredOrderReference && (await allowed()),
              }).loadByBatch(tx, reenteredOrderReference, reentered.orderBatchReference);
              if (reenteredPayment === null) return fail("COUNTER_CANCEL_REENTRY_INVALID");
            }
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
              ...(reenteredOrderReference === null ? {} : { reenteredOrderReference }),
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
                    : cancelled.reason === "ReentryInvalid"
                      ? "COUNTER_CANCEL_REENTRY_INVALID"
                      : cancelled.reason === "ReentryUsed"
                        ? "COUNTER_CANCEL_REENTRY_USED"
                        : cancelled.reason === "ReentryAmountLower"
                          ? "COUNTER_CANCEL_REENTRY_AMOUNT_LOWER"
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
            // DEC-CANCELLED-ORDER-FREES-PICKUP-PLACE: its pickup place is free at once, as the
            // full-hour notice tells staff. A replay releases one an earlier build left holding.
            await releaseCancelledAsapCapacity(
              transaction,
              { brandReference: selected.brandReference, storeReference: selected.storeReference },
              {
                submissionReference: String(link.submissionReference),
                orderReference,
                orderBatchReference,
                auditReference: options.nextReference(),
                correlationReference: String(record.terminationReference),
              },
            );
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

/** DEC-PAPER-ORDER-NEVER-RELEASED: what a manager chooses from when linking a re-entered order. */
export type PaperReentryCandidates = Readonly<{
  /** The paper order to close: its number and sale (dishes with tax, before tip). */
  paperOrder: Readonly<{ orderNumber: string; saleMinor: string; currencyCode: string }>;
  /**
   * Paper orders of this Store sent no earlier, still open, standing for no other paper order and
   * with their payment recorded, newest first, from any business day. `coversSale` is false when
   * the new order's sale is lower than the paper order's (it cannot be linked).
   */
  candidates: readonly Readonly<{
    orderReference: string;
    orderNumber: string;
    submittedAt: string;
    saleMinor: string;
    paidMinor: string;
    coversSale: boolean;
  }>[];
}>;

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED (v15 batch-8 review): the new paper orders a manager may link to
 * a paper order entered again from its slip, read on the server across business days (a re-entered
 * order is paid at send and may be accepted, made and gone from the counter's current list by the
 * time a manager opens the dialog), with both orders' amounts so a cheaper order is never chosen.
 * Same people who may close it (`ordering.order.cancel`); the close checks everything again.
 */
export function createMerchantPaperReentryCandidates(options: {
  persistence: PersistentMerchantBffOptions;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    orderReference: unknown;
  }): Promise<PaperReentryCandidates> => {
    let orderReference: string;
    try {
      orderReference = String(parseOrderingReference(input.orderReference));
    } catch {
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
              ).catch(onlyRefusal(() => fail("COUNTER_CANCEL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("COUNTER_CANCEL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("COUNTER_CANCEL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const current = authority.scope;
            const allowed = () => authority.guard();
            const tx = transaction as unknown as ConsumerTransaction;
            const selected = {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            };
            await options.installContext(tx, selected);
            const paper = await loadCounterOrderBatch(tx, selected, orderReference);
            if (paper === null || !paper.recordedAfterOutage || paper.sale === null)
              return fail("COUNTER_CANCEL_NOT_FOUND");
            const sale = paper.sale;
            const listed = await listPaperReentryCandidates(tx, selected, orderReference);
            const references = new Set(listed.map((candidate) => candidate.orderReference));
            // Whether each one's payment is recorded is Payment's fact.
            const paid = await createPostgresCardMachinePaymentStore({
              scope: selected,
              authorize: async (_t, value) =>
                references.has(value.orderReference) && (await allowed()),
            }).listByBatches(
              tx,
              listed.map((candidate) => ({
                orderReference: candidate.orderReference,
                orderBatchReference: candidate.orderBatchReference,
              })),
            );
            const candidates = listed.flatMap((candidate) => {
              const payment = paid.get(candidate.orderBatchReference);
              if (
                payment === undefined ||
                candidate.sale === null ||
                candidate.sale.currencyCode !== sale.currencyCode
              )
                return [];
              return [
                Object.freeze({
                  orderReference: candidate.orderReference,
                  orderNumber: candidate.orderNumber,
                  submittedAt: candidate.submittedAt,
                  saleMinor: candidate.sale.amountMinor.toString(),
                  paidMinor: cardMachinePaymentTakenMinor(payment).toString(),
                  coversSale: candidate.sale.amountMinor >= sale.amountMinor,
                }),
              ];
            });
            return Object.freeze({
              paperOrder: Object.freeze({
                orderNumber: paper.orderNumber,
                saleMinor: sale.amountMinor.toString(),
                currencyCode: sale.currencyCode,
              }),
              candidates: Object.freeze(candidates),
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

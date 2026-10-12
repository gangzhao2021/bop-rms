import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listStoreConfirmedOrderBatches,
  listStoreDiningBatchPaymentDeadlines,
  listStorePaidOrderBatches,
  listStoreUnfulfillablePaidOrders,
  loadMerchantOrderLines,
  type StaffOrderCancellationRecord,
} from "@rms/ordering";
import { listStoreKitchenOrderItemStates, listStoreStartedKitchenBatches } from "@rms/kitchen";
import {
  listStorePickupAcceptanceDeadlines,
  listStoreUncollectedPickupOrders,
} from "@rms/fulfillment";
import { listStoreOrderBatchPaymentOutcomes } from "@rms/payment";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import {
  readStaffCancellationRefundStatus,
  staffOrderCancellationPermission,
  type StaffOrderRefundStatus,
} from "./merchant-order-staff-cancellation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readItemCancellationRefundStatus } from "./merchant-order-item-staff-cancellation.js";
import {
  resolveMerchantBatchPaymentDue,
  type BatchPaymentOutcome,
} from "./dining-batch-payment-due.js";

/** Read-only merchant intent; session identity and selected scope are resolved inside its transaction. */
export function createPersistentMerchantOrderQueue(options: {
  persistence: PersistentMerchantBffOptions;
  quoteVersion: 1 | 2;
  acceptanceConfigured?: boolean;
  /** WP-2423: the locale item names are shown in on the order detail (the Store's locale). */
  locale?: string;
  /** WP-2423 Q6 step 2a: Payment configuration the item cancellation refunds are read under. */
  resolveRefundConfiguration?(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<{ providerAccountReference: string; environment: "Test" | "Live" }>;
}) {
  const source = options.persistence;
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now: source.now,
    currentActor: source.currentActor,
  });
  const resolveScope = createMerchantStoreScope(source);
  return async (input: {
    sessionCookie: unknown;
    afterOrderReference: string | null;
    /** WP-2423 OPS-ORDER-DETAIL: the one Order the detail shows. */
    orderReference?: string;
  }) =>
    source.transactions.run(async (transaction) => {
      const session = await currentSession(transaction, input.sessionCookie);
      const businessTransaction: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object")
            throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null &&
              (typeof count.value !== "number" ||
                !Number.isSafeInteger(count.value) ||
                count.value < 0))
          )
            throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      let acceptanceAllowed = false;
      let cancelAllowed = false;
      let stillAllowed: () => Promise<boolean> = async () => false;
      let ownerScope: { brandReference: string; storeReference: string } | null = null;
      let tenantReference: string | null = null;
      const read = createMerchantOrderQueueRead({
        transactions: { run: (work) => work(businessTransaction) },
        quoteVersion: options.quoteVersion,
        now: source.now,
        authorize: async () => {
          const resolved = await resolveScope(
            transaction,
            input.sessionCookie,
            "ordering.operate",
            session.sessionReference,
          );
          if ((await resolved.allowed()) !== true) return null;
          acceptanceAllowed =
            options.acceptanceConfigured === true &&
            (await resolved.authorizeAction("order.accept"))?.effect === "Allow";
          // WP-2423 Q6: staff cancellation is offered only to holders of ordering.order.cancel.
          cancelAllowed =
            (await resolved.authorizeAction(staffOrderCancellationPermission))?.effect === "Allow";
          stillAllowed = async () => (await resolved.allowed()) === true;
          ownerScope = {
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
          };
          tenantReference = String(resolved.selected.tenantReference);
          return {
            tenantReference: resolved.selected.tenantReference,
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
            sessionReference: String(session.sessionReference),
          };
        },
      });
      const result = await read({
        sessionCookie: input.sessionCookie,
        afterOrderReference: input.orderReference === undefined ? input.afterOrderReference : null,
        limit: input.orderReference === undefined ? 50 : 1,
        ...(input.orderReference === undefined ? {} : { onlyOrderReference: input.orderReference }),
      });
      // What was ordered, read in the same transaction under the same ordering.operate scope.
      const only = result.items[0];
      const lines =
        input.orderReference === undefined || only === undefined
          ? null
          : await (async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                "ordering.operate",
                session.sessionReference,
              );
              if ((await resolved.allowed()) !== true)
                throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
              return loadMerchantOrderLines(
                businessTransaction,
                {
                  brandReference: String(resolved.context.brand.brandReference),
                  storeReference: String(resolved.store.storeReference),
                },
                only.orderReference,
                options.locale ?? "en-CA",
              );
            })();
      // WP-2423: a paid Order that can no longer be fulfilled (for example not accepted before its
      // capacity expired) is refunded by Payment; it is shown as such and never offered for acceptance.
      const unfulfillable =
        ownerScope === null || result.items.length === 0
          ? new Map<string, string>()
          : await listStoreUnfulfillablePaidOrders(
              businessTransaction,
              ownerScope,
              result.items.map((item) => item.orderReference),
            );
      // WP-2423: pickup orders the Store closed as not collected (Fulfillment's public read).
      const uncollected =
        ownerScope === null || result.items.length === 0
          ? new Set<string>()
          : await listStoreUncollectedPickupOrders(
              businessTransaction,
              ownerScope,
              result.items.map((item) => item.orderReference),
            );
      // WP-2423 Q1: only a batch whose payment Ordering recorded as awaiting acceptance is offered
      // for acceptance; an Order with no recorded payment is still awaiting the customer's payment.
      const payments =
        ownerScope === null || result.items.length === 0
          ? {
              paidOrders: new Set<string>(),
              paidBatches: new Set<string>(),
              awaitingAcceptance: new Set<string>(),
            }
          : await listStorePaidOrderBatches(
              businessTransaction,
              ownerScope,
              result.items.map((item) => item.orderReference),
            );
      // WP-2423: an unpaid dine-in round is cancelled automatically once its payment window ends if
      // its payment failed; staff see that, and when, before it happens (Ordering's deadline and
      // Payment's latest outcome per batch).
      const diningOrders = result.items
        .filter((item) => item.orderType === "DineIn")
        .map((item) => item.orderReference);
      const paymentDeadlines = new Map<string, string>();
      const paymentOutcomes = new Map<string, BatchPaymentOutcome>();
      if (ownerScope !== null && diningOrders.length > 0) {
        for (const entry of await listStoreDiningBatchPaymentDeadlines(
          businessTransaction,
          ownerScope,
          diningOrders,
        ))
          paymentDeadlines.set(entry.orderBatchReference, entry.paymentDeadline);
        for (const entry of await listStoreOrderBatchPaymentOutcomes(
          businessTransaction,
          ownerScope,
          diningOrders,
        ))
          paymentOutcomes.set(entry.orderBatchReference, entry.status);
      }
      // WP-2423 Q1: when a paid pickup Order not yet accepted stops being acceptable (Fulfillment's
      // capacity expiry); staff are warned before it lapses and Payment refunds it.
      const waiting = result.items.filter(
        (item) =>
          item.orderType === "Pickup" &&
          item.currentPhase === "Submitted" &&
          !unfulfillable.has(item.orderReference) &&
          payments.awaitingAcceptance.has(item.initialBatchReference),
      );
      const deadlines =
        ownerScope === null || waiting.length === 0
          ? new Map<string, string>()
          : await listStorePickupAcceptanceDeadlines(
              businessTransaction,
              ownerScope,
              waiting.map((item) => item.orderReference),
            );
      // WP-2423 Q6: staff cancellations (with refund status) and which paid, accepted batches the
      // kitchen has not started, so the cancel action is offered only where the command accepts it.
      const orderReferences = result.items.map((item) => item.orderReference);
      const scoped = ownerScope as { brandReference: string; storeReference: string } | null;
      const cancellations = new Map<
        string,
        {
          reasonCode: StaffOrderCancellationRecord["reasonCode"];
          cancelledAt: string;
          refundStatus: StaffOrderRefundStatus;
        }
      >();
      let confirmed: ReadonlySet<string> = new Set<string>();
      const started = new Set<string>();
      const itemCancellations = new Map<
        string,
        {
          cancellationReference: string;
          reasonCode: StaffOrderCancellationRecord["reasonCode"];
          cancelledAt: string;
          refundStatus: "Pending" | "Refunded";
        }
      >();
      /** Line → its batch, for lines whose kitchen work has not started. */
      const cancellableLines = new Map<string, string>();
      if (scoped !== null && orderReferences.length > 0) {
        for (const record of await createPostgresStaffOrderCancellationReader(scoped).listByOrders(
          businessTransaction,
          orderReferences,
        ))
          cancellations.set(String(record.orderBatchReference), {
            reasonCode: record.reasonCode,
            cancelledAt: String(record.cancelledAt),
            refundStatus: await readStaffCancellationRefundStatus(
              businessTransaction,
              scoped,
              record,
              stillAllowed,
            ),
          });
        if (cancelAllowed) {
          confirmed = await listStoreConfirmedOrderBatches(
            businessTransaction,
            scoped,
            orderReferences,
          );
          const open = [...confirmed].filter((batch) => !cancellations.has(batch));
          for (let index = 0; index < open.length; index += 100)
            for (const batch of await listStoreStartedKitchenBatches(
              businessTransaction,
              scoped,
              open.slice(index, index + 100),
            ))
              started.add(batch);
        }
        // WP-2423 Q6 step 2a: lines staff cancelled (with their refund) and which lines of the
        // paid, accepted batches the kitchen has not started.
        for (const record of await createPostgresStaffItemCancellationReader(scoped).listByOrders(
          businessTransaction,
          orderReferences,
        )) {
          const refundStatus =
            options.resolveRefundConfiguration === undefined || tenantReference === null
              ? ("Pending" as const)
              : await readItemCancellationRefundStatus(
                  businessTransaction,
                  {
                    tenantReference,
                    ...scoped,
                    ...(await options.resolveRefundConfiguration(businessTransaction, {
                      tenantReference,
                      ...scoped,
                    })),
                  },
                  record,
                  stillAllowed,
                );
          for (const line of record.orderItemReferences)
            itemCancellations.set(String(line), {
              cancellationReference: String(record.cancellationReference),
              reasonCode: record.reasonCode,
              cancelledAt: String(record.cancelledAt),
              // A Provider-failed refund stays "pending" here; "Check refund" shows the failure.
              refundStatus: refundStatus === "Refunded" ? "Refunded" : "Pending",
            });
        }
        if (cancelAllowed)
          for (const batch of [...confirmed].filter((value) => !cancellations.has(value)))
            for (const [line, state] of await listStoreKitchenOrderItemStates(
              businessTransaction,
              scoped,
              [batch],
            ))
              if (state === "NotStarted" && !itemCancellations.has(line))
                cancellableLines.set(line, batch);
        if (!(await stillAllowed())) throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
      }
      const batchOpen = (
        item: (typeof result.items)[number],
        batch: (typeof result.items)[number]["batches"][number],
      ) => {
        const closed = unfulfillable.get(item.orderReference) ?? null;
        return (
          cancelAllowed &&
          closed === null &&
          !uncollected.has(item.orderReference) &&
          batch.acceptanceStatus === "Accepted" &&
          confirmed.has(batch.orderBatchReference) &&
          !cancellations.has(batch.orderBatchReference) &&
          item.currentVersion !== null &&
          (item.orderType === "Pickup"
            ? item.currentPhase === "Accepted"
            : ["Submitted", "Accepted", "InProgress", "Ready"].includes(String(item.currentPhase)))
        );
      };
      const openBatches = new Set(
        result.items.flatMap((item) =>
          item.batches
            .filter((batch) => batchOpen(item, batch))
            .map((batch) => batch.orderBatchReference),
        ),
      );
      const lineCancellable = (line: string) => {
        const batch = cancellableLines.get(line);
        return batch !== undefined && openBatches.has(batch);
      };
      const detailLines =
        lines === null || only === undefined
          ? lines
          : Object.freeze({
              ...lines,
              items: Object.freeze(
                lines.items.map((line) => {
                  const cancelled = itemCancellations.get(line.orderItemReference) ?? null;
                  return Object.freeze({
                    ...line,
                    canCancel: cancelled === null && lineCancellable(line.orderItemReference),
                    cancellation:
                      cancelled === null
                        ? null
                        : Object.freeze({
                            ...cancelled,
                            // A whole line is refunded: its net (after discount) plus tax, no tip.
                            refund: Object.freeze({
                              amountMinor: (
                                BigInt(line.subtotal.amountMinor) -
                                BigInt(line.discount.amountMinor) +
                                BigInt(line.tax.amountMinor)
                              ).toString(),
                              currencyCode: line.tax.currencyCode,
                            }),
                          }),
                  });
                }),
              ),
            });
      return Object.freeze({
        ...result,
        lines: detailLines,
        items: Object.freeze(
          result.items.map((item) => {
            const latestBatchSequence = item.batches.reduce(
              (latest, batch) => Math.max(latest, batch.sequence),
              0,
            );
            const closed = unfulfillable.get(item.orderReference) ?? null;
            return Object.freeze({
              ...item,
              unfulfillable: closed,
              pickupNotCollected: uncollected.has(item.orderReference),
              acceptBy: deadlines.get(item.orderReference) ?? null,
              awaitingPayment:
                closed === null &&
                item.currentPhase === "Submitted" &&
                !payments.paidOrders.has(item.orderReference),
              batches: Object.freeze(
                item.batches.map((batch) =>
                  Object.freeze({
                    ...batch,
                    canRequestAcceptance:
                      closed === null &&
                      acceptanceAllowed &&
                      payments.awaitingAcceptance.has(batch.orderBatchReference) &&
                      batch.acceptanceStatus === "NotAccepted" &&
                      item.currentVersion !== null &&
                      ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                        String(item.currentPhase),
                      ) &&
                      (batch.sequence > 1 ||
                        (item.orderType === "DineIn" && batch.sequence === latestBatchSequence) ||
                        item.currentVersion === 1),
                    canCancel:
                      cancelAllowed &&
                      closed === null &&
                      !uncollected.has(item.orderReference) &&
                      batch.acceptanceStatus === "Accepted" &&
                      confirmed.has(batch.orderBatchReference) &&
                      !cancellations.has(batch.orderBatchReference) &&
                      !started.has(batch.orderBatchReference) &&
                      item.currentVersion !== null &&
                      (item.orderType === "Pickup"
                        ? item.currentPhase === "Accepted"
                        : ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                            String(item.currentPhase),
                          )),
                    staffCancellation: cancellations.get(batch.orderBatchReference) ?? null,
                    paymentDue: resolveMerchantBatchPaymentDue({
                      orderType: item.orderType,
                      open:
                        closed === null &&
                        ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                          String(item.currentPhase),
                        ),
                      batch,
                      paidBatches: payments.paidBatches,
                      deadlines: paymentDeadlines,
                      outcomes: paymentOutcomes,
                    }),
                    canCancelItems:
                      openBatches.has(batch.orderBatchReference) &&
                      [...cancellableLines.values()].includes(batch.orderBatchReference),
                  }),
                ),
              ),
              canRequestAcceptance:
                closed === null &&
                acceptanceAllowed &&
                payments.awaitingAcceptance.has(item.initialBatchReference) &&
                item.currentPhase === "Submitted" &&
                item.currentVersion === 1,
            });
          }),
        ),
      });
    });
}

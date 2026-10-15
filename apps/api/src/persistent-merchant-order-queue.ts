import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresCounterOrderEntryStore,
  createPostgresStaffDiningRoundEntryStore,
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listStoreConfirmedOrderBatches,
  listStoreDiningBatchPaymentDeadlines,
  listStorePaidOrderBatches,
  listStoreOrderAcceptanceHolds,
  listStoreUnfulfillablePaidOrders,
  loadMerchantOrderLines,
  loadOrderPickupContact,
  type OrderAcceptanceHold,
  type StaffOrderCancellationRecord,
} from "@rms/ordering";
import { listStoreKitchenOrderItemStates, listStoreStartedKitchenBatches } from "@rms/kitchen";
import {
  listStorePickupAcceptanceDeadlines,
  listStoreUncollectedPickupOrders,
} from "@rms/fulfillment";
import {
  createPostgresCardMachinePaymentStore,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
  listStoreOrderOnlinePaidTotals,
} from "@rms/payment";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { randomBytes } from "node:crypto";
import { readStaffDiningRoundPaymentPreparation } from "./staff-dining-round-payment-preparation.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import {
  readCardMachineCancellationRefund,
  readStaffCancellationRefundStatus,
  staffOrderCancellationPermission,
  type StaffOrderRefundStatus,
} from "./merchant-order-staff-cancellation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { readItemCancellationRefundStatus } from "./merchant-order-item-staff-cancellation.js";
import { readCustomerReceiptFinancial } from "./customer-receipt-financial.js";
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
  /**
   * WP-2423 Q9-G1: staff reading the Orders page are present at the Store. Called after a
   * successful read, outside its transaction; it never fails the read.
   */
  storePresence?: {
    observe(scope: { brandReference: string; storeReference: string }): Promise<void>;
  };
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
  }) => {
    const observed: { scope: { brandReference: string; storeReference: string } | null } = {
      scope: null,
    };
    const unavailable = (): never => {
      throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
    };
    const view = await source.transactions.run((transaction) =>
      // WP-2423: the caller (Session, Store, ordering.operate) is resolved in full at the start of
      // the transaction and once more before the reply. The owner reads in between (several per
      // order) only confirm they run in this authorized transaction; re-resolving the scope in
      // each of them cost ~30 queries per owner read and grew with every order on the page.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const session = await currentSession(transaction, input.sessionCookie);
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              "ordering.operate",
              session.sessionReference,
            );
            // The read's permission and the actions it offers, from one current-fact read.
            const decisions = await resolved.authorizeActions([
              "ordering.operate",
              "order.accept",
              staffOrderCancellationPermission,
            ]);
            if (decisions.get("ordering.operate")?.effect !== "Allow") return unavailable();
            return Object.freeze({
              session,
              resolved,
              acceptanceAllowed:
                options.acceptanceConfigured === true &&
                decisions.get("order.accept")?.effect === "Allow",
              // WP-2423 Q6: staff cancellation is offered only to holders of ordering.order.cancel.
              cancelAllowed: decisions.get(staffOrderCancellationPermission)?.effect === "Allow",
            });
          },
          recheck: async ({ resolved }) => (await resolved.allowed()) === true,
          denied: unavailable,
        },
        async (authority) => {
          const { session, resolved, acceptanceAllowed, cancelAllowed } = authority.scope;
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

          authority.bind(businessTransaction);
          const stillAllowed = () => authority.guard();
          const ownerScope: { brandReference: string; storeReference: string } | null = {
            brandReference: String(resolved.context.brand.brandReference),
            storeReference: String(resolved.store.storeReference),
          };
          const tenantReference: string | null = String(resolved.selected.tenantReference);
          const read = createMerchantOrderQueueRead({
            transactions: { run: (work) => work(businessTransaction) },
            quoteVersion: options.quoteVersion,
            now: source.now,
            // WP-2423 D4: the Store's current business day, so an older table's Order with a
            // round today is listed with today's orders.
            today: (tx) =>
              createMerchantBusinessDayWindows({
                persistence: source,
                scope: {
                  tenantReference: String(resolved.selected.tenantReference),
                  brandReference: String(resolved.context.brand.brandReference),
                  storeReference: String(resolved.store.storeReference),
                },
                timeZone: resolved.store.timeZone,
                authorize: async (t) => authority.guard(t),
              }).today(tx, source.now()),
            authorize: async (tx) => {
              if (!(await authority.guard(tx))) return null;
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
            afterOrderReference:
              input.orderReference === undefined ? input.afterOrderReference : null,
            limit: input.orderReference === undefined ? 50 : 1,
            ...(input.orderReference === undefined
              ? {}
              : { onlyOrderReference: input.orderReference }),
          });
          // What was ordered, read in the same transaction under the same ordering.operate scope.
          const only = result.items[0];
          const lines =
            input.orderReference === undefined || only === undefined
              ? null
              : await (async () => {
                  if (!(await authority.guard(businessTransaction))) return unavailable();
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
          // WP-2423 Q9-G1: paid pickup orders held because the Store was offline at their deadline.
          const held =
            ownerScope === null || result.items.length === 0
              ? new Map<string, OrderAcceptanceHold>()
              : await listStoreOrderAcceptanceHolds(
                  businessTransaction,
                  ownerScope,
                  result.items
                    .filter((item) => item.orderType === "Pickup")
                    .map((item) => item.orderReference),
                );
          observed.scope = ownerScope;
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
          // WP-2423 item 5: rounds whose payment was started (online here; card machine below).
          const paymentStarted = new Set<string>();
          if (ownerScope !== null && diningOrders.length > 0) {
            for (const batch of await listStoreOrderBatchesWithOnlinePayment(
              businessTransaction,
              ownerScope,
              diningOrders,
            ))
              paymentStarted.add(batch);
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
          // WP-2423: what each Order was paid online (Payment's status projection), so staff see a
          // paid online order as paid, as they do a counter order paid on the card machine.
          const paidOnline = new Map<string, { amountMinor: string; currencyCode: "CAD" }>();
          if (ownerScope !== null && result.items.length > 0)
            for (const entry of await listStoreOrderOnlinePaidTotals(
              businessTransaction,
              ownerScope,
              result.items.map((item) => item.orderReference),
            ))
              paidOnline.set(entry.orderReference, {
                amountMinor: entry.amountMinor,
                currencyCode: entry.currencyCode,
              });
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
              /** WP-2423 Q7: refunded on the Store's card machine (amount to refund or refunded). */
              refundMethod: "Online" | "CardMachine";
              refundAmountMinor: string | null;
            }
          >();
          /** WP-2423 Q7: counter orders (staff-taken) and their card-machine payment, by Order. */
          const counter = new Map<
            string,
            {
              recordedAfterOutage: boolean;
              paidOnCardMachine: {
                amountMinor: string;
                takenAt: string;
                recordedAfterOutage: boolean;
                refundedMinor: string;
              } | null;
            }
          >();
          /**
           * WP-2423 Q7 slice 2: dine-in rounds staff entered for a table, by batch, and the
           * card-machine payment of each (DEC-STAFF-DINE-IN-ROUND).
           */
          const staffRounds = new Map<
            string,
            {
              recordedAfterOutage: boolean;
              paidOnCardMachine: { amountMinor: string; takenAt: string } | null;
              /** WP-2423 D5: what to charge on the card machine while it is unpaid (else null). */
              amountDueMinor: string | null;
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
            for (const record of await createPostgresStaffOrderCancellationReader(
              scoped,
            ).listByOrders(businessTransaction, orderReferences)) {
              const card = await readCardMachineCancellationRefund(
                businessTransaction,
                scoped,
                record,
                stillAllowed,
              );
              cancellations.set(String(record.orderBatchReference), {
                reasonCode: record.reasonCode,
                cancelledAt: String(record.cancelledAt),
                refundStatus:
                  card?.status ??
                  (await readStaffCancellationRefundStatus(
                    businessTransaction,
                    scoped,
                    record,
                    stillAllowed,
                  )),
                refundMethod: card === null ? "Online" : "CardMachine",
                refundAmountMinor: card?.amountMinor ?? null,
              });
            }
            const entries = await createPostgresCounterOrderEntryStore({
              ...scoped,
              authorize: stillAllowed,
            }).listByOrders(businessTransaction, orderReferences);
            const cardPayments = createPostgresCardMachinePaymentStore({
              scope: scoped,
              authorize: async () => stillAllowed(),
            });
            // One read for every counter order's card-machine payment (and its refunds).
            const counterPayments = await cardPayments.listByOrders(businessTransaction, [
              ...entries.keys(),
            ]);
            for (const [order, entry] of entries) {
              const paid = counterPayments.get(order)?.[0];
              counter.set(order, {
                recordedAfterOutage: entry.recordedAfterOutage,
                paidOnCardMachine:
                  paid === undefined
                    ? null
                    : {
                        amountMinor: paid.payment.preparation.total.amountMinor.toString(),
                        takenAt: String(paid.payment.takenAt),
                        recordedAfterOutage: paid.payment.recordingReason === "RecordedAfterOutage",
                        refundedMinor: paid.refunds
                          .reduce((sum, refund) => sum + refund.amountMinor, 0n)
                          .toString(),
                      },
              });
            }
            const roundEntries = createPostgresStaffDiningRoundEntryStore({
              ...scoped,
              authorize: stillAllowed,
            });
            const rounds = await roundEntries.listByOrders(businessTransaction, orderReferences);
            // One Payment read for every staff round on the page.
            const roundPayments = await cardPayments.listByBatches(
              businessTransaction,
              [...rounds].map(([batch, round]) => ({
                orderReference: round.orderReference,
                orderBatchReference: batch,
              })),
            );
            for (const [batch, round] of rounds) {
              const paid = roundPayments.get(batch) ?? null;
              // WP-2423 D5: an unpaid round can be paid from Orders too, for the amount the
              // card-machine record checks (quote with tax plus the tip staff keyed), while its
              // Dining payment clock is open. The amount is rebuilt from five owners' records, so
              // only the one-order read (the order's page, or the list's payment form when staff
              // open it) builds it; the list polled by every tablet does not.
              let amountDueMinor: string | null = null;
              if (paid === null && tenantReference !== null && input.orderReference !== undefined) {
                const submitted = await roundEntries.loadBatch(
                  businessTransaction,
                  String(round.entry.guestSessionReference),
                );
                if (submitted !== null && String(submitted.orderBatchReference) === batch) {
                  const due = await readStaffDiningRoundPaymentPreparation(
                    businessTransaction,
                    {
                      scope: { tenantReference, ...scoped },
                      now: source.now,
                      nextPreparationReference: transientReference,
                      authorize: async () => (await stillAllowed()) === true,
                    },
                    {
                      submissionReference: String(submitted.submissionReference),
                      guestSessionReference: String(round.entry.guestSessionReference),
                      tipSelectionReference: String(round.entry.tipSelectionReference),
                    },
                  );
                  amountDueMinor = due?.preparation.total.amountMinor.toString() ?? null;
                }
              }
              if (paid !== null) paymentStarted.add(batch);
              staffRounds.set(batch, {
                recordedAfterOutage: round.entry.recordedAfterOutage,
                amountDueMinor,
                paidOnCardMachine:
                  paid === null
                    ? null
                    : {
                        amountMinor: paid.preparation.total.amountMinor.toString(),
                        takenAt: String(paid.takenAt),
                      },
              });
            }
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
            for (const record of await createPostgresStaffItemCancellationReader(
              scoped,
            ).listByOrders(businessTransaction, orderReferences)) {
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
                : ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                    String(item.currentPhase),
                  ))
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
          // WP-2423 Q10: on one order's detail only (never the list), the contact a pickup customer
          // gave so the Store can reach them about this order — or that it was removed after the
          // retention period. Read under the same ordering.operate scope in this transaction.
          const pickupContact =
            input.orderReference === undefined ||
            only === undefined ||
            only.orderType !== "Pickup" ||
            ownerScope === null
              ? null
              : await loadOrderPickupContact(businessTransaction, ownerScope, only.orderReference);
          // WP-2423: on one order's detail only, how much of its online payment Payment has refunded
          // or is refunding (ordinary, cancellation and automatic refunds), as the receipt reads it.
          // Optional evidence: when it cannot be read the detail shows the payment without it.
          const onlineFinancial =
            input.orderReference === undefined ||
            only === undefined ||
            !paidOnline.has(only.orderReference) ||
            counter.has(only.orderReference) ||
            ownerScope === null ||
            tenantReference === null ||
            options.resolveRefundConfiguration === undefined
              ? null
              : await readCustomerReceiptFinancial(
                  businessTransaction,
                  {
                    scope: { tenantReference, ...ownerScope },
                    ...(await options.resolveRefundConfiguration(businessTransaction, {
                      tenantReference,
                      ...ownerScope,
                    })),
                  },
                  { orderReference: only.orderReference, observedAt: String(source.now()) },
                  stillAllowed,
                );
          const paymentPosition =
            onlineFinancial === null || onlineFinancial.currencyCode !== "CAD"
              ? null
              : Object.freeze({
                  refundedMinor: onlineFinancial.confirmedRefundMinor.toString(),
                  refundPendingMinor: onlineFinancial.pendingRefundMinor.toString(),
                });
          return Object.freeze({
            ...result,
            lines: detailLines,
            pickupContact,
            paymentPosition,
            items: Object.freeze(
              result.items.map((item) => {
                const latestBatchSequence = item.batches.reduce(
                  (latest, batch) => Math.max(latest, batch.sequence),
                  0,
                );
                const closed = unfulfillable.get(item.orderReference) ?? null;
                const hold = closed === null ? (held.get(item.orderReference) ?? null) : null;
                const decideBy =
                  hold === null || hold.resolutions.length === 0
                    ? null
                    : hold.resolutions
                        .map((entry) => entry.decideBy)
                        .reduce((earliest, value) => (value < earliest ? value : earliest));
                const refundChosen =
                  hold?.resolutions.some((entry) => entry.resolution === "StaffRefund") ?? false;
                return Object.freeze({
                  ...item,
                  unfulfillable: closed,
                  pickupNotCollected: uncollected.has(item.orderReference),
                  counter: counter.get(item.orderReference) ?? null,
                  // A counter order's payment is the card-machine payment above.
                  paidOnline: counter.has(item.orderReference)
                    ? null
                    : (paidOnline.get(item.orderReference) ?? null),
                  // A held order's deadline is the decision deadline once staff are back (none while
                  // it is held); otherwise Fulfillment's capacity expiry.
                  acceptBy: hold === null ? (deadlines.get(item.orderReference) ?? null) : decideBy,
                  acceptanceHold:
                    hold === null || item.currentPhase !== "Submitted"
                      ? null
                      : Object.freeze({
                          holdReference: hold.holdReference,
                          orderBatchReference: hold.orderBatchReference,
                          heldAt: hold.heldAt,
                          lapsedDeadline: hold.lapsedDeadline,
                          storeLastSeenAt: hold.storeLastSeenAt,
                          decideBy,
                          refundChosen,
                          canRefund: cancelAllowed && !refundChosen,
                        }),
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
                            (item.orderType === "DineIn" &&
                              batch.sequence === latestBatchSequence) ||
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
                        // WP-2423 Q7 slice 2: a round staff entered for the table (or null).
                        staffRound: staffRounds.get(batch.orderBatchReference) ?? null,
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
                          paymentStarted,
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
        },
      ),
    );
    if (options.storePresence !== undefined && observed.scope !== null)
      await options.storePresence.observe(observed.scope);
    return view;
  };
}

/** A throwaway reference for a payment preparation built only to read its amount (never stored). */
function transientReference(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${(8 + (Number.parseInt(random.slice(3, 4), 16) % 4)).toString(16)}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

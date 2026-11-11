import {
  orderLinesUnavailableNow,
  type LineUnavailableNow,
} from "./merchant-order-sold-out-now.js";
import { listAlcoholSkus } from "@rms/catalog";
import { staffNameLocales } from "./staff-content-locale.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresCounterOrderEntryStore,
  createPostgresOrderPayLaterConfirmationStore,
  createPostgresPayLaterItemCancellationStore,
  createPostgresStaffDiningRoundEntryStore,
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listStoreConfirmedOrderBatches,
  listStoreDiningBatchPaymentDeadlines,
  listStorePaidOrderBatches,
  listStoreOrderAcceptanceHolds,
  listStoreOrderAutoAcceptanceFacts,
  listStoreUnfulfillablePaidOrders,
  computeBillTaxRounding,
  listOrderItemPrices,
  listOrderBillOrders,
  listOrderDiningSessions,
  listOrderMergedInto,
  loadMerchantOrderLines,
  loadMerchantOrderListSummaries,
  loadOrderPickupContact,
  type MerchantOrderListSummary,
  type OrderAcceptanceHold,
  type OrderAutoAcceptanceBatchFact,
  type StaffOrderCancellationRecord,
  listOrderPriceReductions,
  orderPriceReductionPermission,
  listCounterUnpaidCancellations,
  listOrderRoundAcceptances,
} from "@rms/ordering";
import {
  listStoreKitchenBatchReceivedAt,
  listStoreKitchenBatchTouches,
  listStoreKitchenBatchesNotPrepared,
  listStoreKitchenBatchesWithNothingToPrepare,
  listStoreKitchenOrderItemStates,
  listStoreStartedKitchenBatches,
} from "@rms/kitchen";
import { listDiningGuestStartedSessions, listDiningSessionTableLabels } from "@rms/dining";
import {
  listStorePickupAcceptanceDeadlines,
  listStoreUncollectedPickupOrders,
  listOrderPickupHandoffActors,
} from "@rms/fulfillment";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresDiningTableSettlementStore,
  type CardMachinePaymentRecord,
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderBatchesWithOnlinePayment,
  listStoreOrderOnlinePaidTotals,
  listStoreOrdersWithOnlineRefunds,
  readStoreOrderOnlinePaidTip,
  listOrderOrdinaryRefundApprovers,
  listOrderOrdinaryRefundRequesters,
} from "@rms/payment";
import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { createHash, randomBytes } from "node:crypto";
import { readStaffDiningRoundPaymentPreparation } from "./staff-dining-round-payment-preparation.js";
import { readCounterPaymentPreparation } from "./counter-payment-preparation.js";
import { counterOrderPermission } from "./merchant-counter-order.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createStaffLabels } from "./merchant-staff-labels.js";
import {
  listStoreMembers,
  memberDisplayNames,
  type MemberDirectoryTransaction,
} from "@bop/membership";
import type { RoleAssignmentTransaction } from "@bop/permission";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
import { pickupAcceptanceDeadline } from "./pickup-acceptance-deadline.js";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import {
  readCardMachineCancellationRefund,
  readStaffCancellationRefundPosition,
  staffOrderCancellationPermission,
  type StaffOrderRefundStatus,
} from "./merchant-order-staff-cancellation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import {
  readDiningTableBill,
  readOrderTaxRoundingShare,
  tableRefundedMinor,
} from "./merchant-dining-table-checkout.js";
import { withOptionalRead } from "./merchant-round-business-date.js";
import { readPaidOrderWatch } from "./merchant-paid-order-watch.js";
import { readItemCancellationRefund } from "./merchant-order-item-staff-cancellation.js";
import { readCustomerReceiptFinancial } from "./customer-receipt-financial.js";
import {
  resolveMerchantBatchPaymentDue,
  type BatchPaymentOutcome,
} from "./dining-batch-payment-due.js";
import { listRoundsWaitingForStaff } from "./dining-waiting-rounds.js";
import {
  emptyOrderRecordFacts,
  nameOrderRecord,
  ordinaryRefundRecordEntries,
} from "./merchant-order-record-people.js";

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
    const denied = (): never => {
      throw new Error("MERCHANT_ORDER_QUEUE_DENIED");
    };
    // WP-2423 (v15 2026-10-18, 55P03): Orders, its detail and Home's count are polled by every
    // staff screen. They read one snapshot of every owner and take no Order fence or row lock, so
    // they neither queue behind each other nor hold up staff commands (snapshot-read).
    const view = await runMerchantSnapshotRead(source.transactions, (transaction) =>
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
              // WP-2423 (v15 751dd768): what the person may do with an order's payment, so Orders
              // offers only what the server lets them do (the commands still check).
              counterOrderPermission,
              "payment.refund.request",
              "payment.refund.approve",
              // WP-2423 item 8 ① segment 2: comps and discounts are offered to managers only.
              orderPriceReductionPermission,
              // DEC-PAID-ORDER-AUTO-ACCEPT: who may turn automatic sending off from this page.
              "store.service.pause",
            ]);
            if (decisions.get("ordering.operate")?.effect !== "Allow") return denied();
            return Object.freeze({
              session,
              resolved,
              acceptanceAllowed:
                options.acceptanceConfigured === true &&
                decisions.get("order.accept")?.effect === "Allow",
              // WP-2423 Q6: staff cancellation is offered only to holders of ordering.order.cancel.
              cancelAllowed: decisions.get(staffOrderCancellationPermission)?.effect === "Allow",
              compAllowed: decisions.get(orderPriceReductionPermission)?.effect === "Allow",
              pauseAllowed: decisions.get("store.service.pause")?.effect === "Allow",
              // The card-machine payment record (counter orders and staff-entered table rounds).
              cardMachinePaymentAllowed: decisions.get(counterOrderPermission)?.effect === "Allow",
              // Payments and refunds are read by refund requesters (Manager) and approvers
              // (Owner/Finance); the read rechecks the exact role.
              paymentsAllowed:
                decisions.get("payment.refund.request")?.effect === "Allow" ||
                decisions.get("payment.refund.approve")?.effect === "Allow",
            });
          },
          recheck: async ({ resolved }) => (await resolved.allowed()) === true,
          denied,
        },
        async (authority) => {
          const {
            session,
            resolved,
            acceptanceAllowed,
            cancelAllowed,
            compAllowed,
            pauseAllowed,
            cardMachinePaymentAllowed,
            paymentsAllowed,
          } = authority.scope;
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
                    staffNameLocales(options.locale ?? "en-CA"),
                  );
                })();
          // WP-2423 DEC-ALCOHOL: which lines remind staff to check the guest's age.
          const alcoholSkus =
            lines === null
              ? new Set<string>()
              : await listAlcoholSkus(
                  businessTransaction as never,
                  { brandReference: String(resolved.context.brand.brandReference) },
                  lines.items.map((line) => line.sellableReference),
                );
          // WP-2423 (M23): orders not accepted yet that hold a dish (or a choice) sold out or off the
          // menu here since the guest ordered: the row and each line say so before staff accept.
          // An advisory read: if it fails, the list loads without the mark (savepoint), never as
          // a refusal.
          const soldOutNow = new Map<string, ReadonlyMap<string, LineUnavailableNow>>();
          const awaitingNow = result.items
            .filter((item) => item.currentPhase === "Submitted")
            .slice(0, 20);
          if (awaitingNow.length > 0) {
            const brandAndStore = {
              brandReference: String(resolved.context.brand.brandReference),
              storeReference: String(resolved.store.storeReference),
            };
            const at = new Date(Date.parse(String(source.now()))).toISOString();
            await businessTransaction.query("SAVEPOINT order_sold_out_now", []);
            try {
              for (const item of awaitingNow) {
                const orderLines =
                  lines !== null && only?.orderReference === item.orderReference
                    ? lines
                    : await loadMerchantOrderLines(
                        businessTransaction,
                        brandAndStore,
                        item.orderReference,
                        staffNameLocales(options.locale ?? "en-CA"),
                      );
                const marked = await orderLinesUnavailableNow(businessTransaction, brandAndStore, {
                  orderType: item.orderType,
                  at,
                  lines: orderLines?.items ?? [],
                });
                if (marked.size > 0) soldOutNow.set(item.orderReference, marked);
              }
              await businessTransaction.query("RELEASE SAVEPOINT order_sold_out_now", []);
            } catch {
              await businessTransaction.query("ROLLBACK TO SAVEPOINT order_sold_out_now", []);
              soldOutNow.clear();
            }
          }
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
                  awaitingSince: new Map<string, string>(),
                  acceptedNotReleased: new Map<string, string>(),
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
          // WP-2423 item 8 ⑤ decisions 5–7: guest rounds waiting for staff (the same read as
          // Tables): no payment is due for them, they are not on the bill, never cancelled by time.
          const waitingForStaff = new Map<string, { heldAt: string }>();
          if (ownerScope !== null)
            for (let start = 0; start < diningOrders.length; start += 200)
              for (const hold of await listRoundsWaitingForStaff(
                businessTransaction as never,
                ownerScope,
                diningOrders.slice(start, start + 200),
                async () => (await stillAllowed()) === true,
              ))
                waitingForStaff.set(String(hold.orderBatchReference), {
                  heldAt: String(hold.heldAt),
                });
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
          // DEC-PAID-ORDER-AUTO-ACCEPT: what the System did or why it did not, per batch (most have
          // nothing), and what every screen warns about. An unreadable answer never blanks Orders.
          const autoAcceptance =
            ownerScope === null || result.items.length === 0
              ? new Map<string, OrderAutoAcceptanceBatchFact>()
              : await withOptionalRead(
                  businessTransaction,
                  () =>
                    listStoreOrderAutoAcceptanceFacts(
                      businessTransaction,
                      ownerScope,
                      result.items.map((item) => item.orderReference),
                    ),
                  new Map<string, OrderAutoAcceptanceBatchFact>(),
                );
          const paidOrderWatch =
            ownerScope === null || input.orderReference !== undefined
              ? null
              : await withOptionalRead(
                  businessTransaction,
                  () => readPaidOrderWatch(businessTransaction, ownerScope, String(source.now())),
                  null,
                );
          const automaticBatches = [...autoAcceptance]
            .filter(([, fact]) => fact.kind === "Accepted")
            .map(([batch]) => batch);
          // Which of them never got to the kitchen, and which the kitchen does not make at all.
          const automaticKitchen =
            ownerScope === null || automaticBatches.length === 0
              ? {
                  reached: new Set<string>(),
                  notPrepared: new Set<string>() as ReadonlySet<string>,
                }
              : await withOptionalRead(
                  businessTransaction,
                  async () => {
                    const reached = new Set<string>();
                    for (let index = 0; index < automaticBatches.length; index += 200)
                      for (const batch of (
                        await listStoreKitchenBatchTouches(
                          businessTransaction,
                          ownerScope,
                          automaticBatches.slice(index, index + 200),
                        )
                      ).keys())
                        reached.add(batch);
                    const notPrepared = new Set<string>();
                    for (let index = 0; index < automaticBatches.length; index += 200)
                      for (const batch of await listStoreKitchenBatchesNotPrepared(
                        businessTransaction,
                        ownerScope,
                        automaticBatches.slice(index, index + 200),
                      ))
                        notPrepared.add(batch);
                    return { reached, notPrepared: notPrepared as ReadonlySet<string> };
                  },
                  // Unreadable: no claim that it failed to arrive, and Can't make it not offered.
                  {
                    reached: new Set<string>(automaticBatches),
                    notPrepared: new Set<string>(automaticBatches) as ReadonlySet<string>,
                  },
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
              /**
               * WP-2423 (v15 751dd768): while it is unpaid, when it is released if not paid
               * (Fulfillment's pickup capacity expiry), else null.
               */
              payBy: string | null;
              /** While unpaid, on the one-order read only: what to charge on the card machine. */
              amountDueMinor: string | null;
              /**
               * WP-2423 M127: the caller may cancel it now (unpaid, still payable, not a paper
               * order; holders of ordering.order.cancel, as for an unpaid table round).
               */
              canCancelUnpaid: boolean;
              /** WP-2423 M127: staff cancelled it before payment (why and when), else null. */
              cancelledBeforePayment: { reasonCode: string; cancelledAt: string } | null;
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
              /**
               * refundedMinor: what was refunded on the machine for this round (staff
               * cancellations of the round or its items, and ordinary refunds), as the order's
               * settlement counts card-machine refunds.
               */
              paidOnCardMachine: {
                amountMinor: string;
                takenAt: string;
                refundedMinor: string;
              } | null;
              /** WP-2423 D5: what to charge on the card machine while it is unpaid (else null). */
              amountDueMinor: string | null;
            }
          >();
          /**
           * WP-2423 (3cd0f8dd M1): the tip each Order's card-machine payments took (staff keyed it),
           * so the order detail's total is what was paid.
           */
          const cardMachineTips = new Map<string, bigint>();
          const cardMachineTipped = new Set<string>();
          const addCardMachineTip = (payment: CardMachinePaymentRecord) => {
            if (cardMachineTipped.has(payment.cardMachinePaymentReference)) return;
            cardMachineTipped.add(payment.cardMachinePaymentReference);
            const order = String(payment.orderReference);
            cardMachineTips.set(
              order,
              (cardMachineTips.get(order) ?? 0n) + payment.preparation.tip.amountMinor,
            );
          };
          let confirmed: ReadonlySet<string> = new Set<string>();
          const started = new Set<string>();
          /**
           * WP-2423 item 8a: rounds the kitchen had nothing to prepare for (a bottle, a bag fee). A
           * pickup of one is ready for collection at once: handed over or refunded, never cancelled.
           */
          const nothingToPrepare = new Set<string>();
          const itemCancellations = new Map<
            string,
            {
              cancellationReference: string;
              reasonCode: StaffOrderCancellationRecord["reasonCode"];
              cancelledAt: string;
              refundStatus: "Pending" | "Refunded";
              /** What Payment's claim returns for this line (tip share included), when read. */
              refundMinor: bigint | null;
            }
          >();
          /** Line → its batch, for lines whose kitchen work has not started. */
          const cancellableLines = new Map<string, string>();
          /**
           * DEC-DINE-IN-PAY-LATER (rule 2): per pay-later round of a table that has not paid, the
           * dishes the kitchen has not started (they can come off the bill), and the dishes already
           * taken off it (never charged).
           */
          const unpaidRemovable = new Map<string, string[]>();
          /** DEC-DINE-IN-PAY-LATER: a pay-later table's bill by Order (owed, or what it paid). */
          const tableBills = new Map<
            string,
            {
              totalMinor: string;
              /** Owner 2026-11-04 walkthrough: the guests left; the amount written off. */
              writtenOffMinor?: string;
              /**
               * v15 M176: this table was merged into another; its dishes are on that table's bill
               * (and in its amount), paid there or still to be.
               */
              mergedInto?: { tableLabel: string | null; paid: boolean };
              /** Owner 2026-11-03 walkthrough: a split bill with some parts paid: what is left. */
              partlyPaid?: {
                remainingMinor: string;
                paidParts: number;
                partCount: number;
              };
              paid: {
                amountMinor: string;
                /** WP-2423 item 8 ④: "Split" — paid part by part (any methods), every part paid. */
                method: "CardMachine" | "Cash" | "Online" | "Split";
                /** Owner 2026-11-03: what went back (absent while nothing has). */
                refundedMinor?: string;
              } | null;
            }
          >();
          const unpaidRemoved = new Map<string, string[]>();
          // WP-2423 item 8 ① segment 2: dishes a manager may comp or discount on an unpaid
          // pay-later round (started in the kitchen), and those comped or discounted.
          const compable = new Map<string, string[]>();
          const comped = new Map<
            string,
            {
              orderItemReference: string;
              kind: "Comp" | "Percent" | "Amount";
              percent: number | null;
              amountMinor: string;
              /** v15 M87/M161: why, when and by whom, as recorded (points: the guest's own). */
              reasonCode: string;
              decidedAt: string;
              byLabel: string | null;
            }[]
          >();
          // WP-2423 M61: who did what, on the one-order read only (see merchant-order-record-people).
          const recordFacts = input.orderReference === undefined ? null : emptyOrderRecordFacts();
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
              // WP-2423 (46940b76 L2): an online refund's amount is what Payment's compensation
              // returns (null until its case opens; "0" when an earlier refund had returned it).
              let online: { status: StaffOrderRefundStatus; amountMinor: string | null } | null =
                null;
              if (card === null)
                if (record.refundDisposition === "AlreadyRefunded")
                  online = { status: "Refunded", amountMinor: "0" };
                else {
                  const position = await readStaffCancellationRefundPosition(
                    businessTransaction,
                    scoped,
                    record,
                    stillAllowed,
                  );
                  const total = position.confirmedMinor + position.pendingMinor;
                  online = {
                    status:
                      position.confirmedMinor > 0n && position.pendingMinor === 0n
                        ? "Refunded"
                        : "Pending",
                    amountMinor: total > 0n ? total.toString() : null,
                  };
                }
              recordFacts?.cancellations.push({
                what: record.orderType === "DineIn" ? "Round" : "Order",
                actor: String(record.actorReference),
                at: String(record.cancelledAt),
              });
              cancellations.set(String(record.orderBatchReference), {
                reasonCode: record.reasonCode,
                cancelledAt: String(record.cancelledAt),
                refundStatus: card?.status ?? online?.status ?? "Pending",
                refundMethod: card === null ? "Online" : "CardMachine",
                refundAmountMinor: card?.amountMinor ?? online?.amountMinor ?? null,
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
            // WP-2423 (v15 751dd768): a sent counter order not paid yet can be charged from Orders
            // and the counter page after a reload; staff see when it is released.
            const unpaidCounter = [...entries.keys()].filter(
              (order) => counterPayments.get(order)?.[0] === undefined,
            );
            const counterPayBy =
              unpaidCounter.length === 0
                ? new Map<string, string>()
                : await listStorePickupAcceptanceDeadlines(
                    businessTransaction,
                    scoped,
                    unpaidCounter,
                  );
            const counterCancelled = await listCounterUnpaidCancellations(
              businessTransaction,
              scoped,
              [...entries.keys()],
            );
            for (const [order, entry] of entries) {
              const cancelledCounter = counterCancelled.get(order);
              // WP-2423 M61/M127: an unpaid counter order cancelled by staff names who cancelled it.
              if (cancelledCounter !== undefined)
                recordFacts?.cancellations.push({
                  what: "Order",
                  actor: cancelledCounter.actorReference,
                  at: cancelledCounter.cancelledAt,
                });
              const paid = counterPayments.get(order)?.[0];
              if (paid !== undefined) addCardMachineTip(paid.payment);
              if (paid !== undefined && recordFacts !== null) {
                recordFacts.payments.push({
                  method: "CardMachine",
                  part: null,
                  batch: null,
                  actor: String(paid.payment.actorReference),
                  at: String(paid.payment.takenAt),
                });
                for (const refund of paid.refunds)
                  recordFacts.refunds.push({
                    method: "CardMachine",
                    amountMinor: refund.amountMinor.toString(),
                    actor: String(refund.actorReference),
                    approver: null,
                    at: String(refund.refundedAt),
                  });
              }
              // The amount is rebuilt from five owners' records (as the payment record checks it),
              // so only the one-order read builds it, like a staff round's amount below.
              let amountDueMinor: string | null = null;
              const payBy = paid === undefined ? (counterPayBy.get(order) ?? null) : null;
              if (
                payBy !== null &&
                tenantReference !== null &&
                input.orderReference !== undefined &&
                order === input.orderReference
              ) {
                const placed = await createPostgresCounterOrderEntryStore({
                  ...scoped,
                  authorize: stillAllowed,
                }).loadOrder(businessTransaction, String(entry.cartReference));
                if (placed !== null && String(placed.orderReference) === order) {
                  const due = await readCounterPaymentPreparation(
                    businessTransaction,
                    {
                      scope: { tenantReference, ...scoped },
                      now: source.now,
                      nextPreparationReference: transientReference,
                      authorize: async () => (await stillAllowed()) === true,
                    },
                    {
                      submissionReference: String(placed.submissionReference),
                      guestSessionReference: String(entry.guestSessionReference),
                      tipSelectionReference: String(entry.tipSelectionReference),
                    },
                  );
                  amountDueMinor = due?.preparation.total.amountMinor.toString() ?? null;
                }
              }
              counter.set(order, {
                payBy,
                amountDueMinor,
                // A cancelled order keeps its capacity until its pay-by time (so payBy stays set):
                // the cancellation itself says it is no longer cancellable.
                canCancelUnpaid:
                  cancelAllowed &&
                  payBy !== null &&
                  !entry.recordedAfterOutage &&
                  !counterCancelled.has(order),
                // Who cancelled is said only on the order's record, by name (never an identifier).
                cancelledBeforePayment:
                  cancelledCounter === undefined
                    ? null
                    : {
                        reasonCode: cancelledCounter.reasonCode,
                        cancelledAt: cancelledCounter.cancelledAt,
                      },
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
            // One Payment read (payments and their refunds) for every staff round on the page.
            const roundPayments = new Map<
              string,
              { payment: CardMachinePaymentRecord; refundedMinor: bigint }
            >();
            for (const recorded of (
              await cardPayments.listByOrders(businessTransaction, [
                ...new Set([...rounds.values()].map((round) => String(round.orderReference))),
              ])
            ).values())
              for (const { payment, refunds } of recorded) {
                addCardMachineTip(payment);
                if (recordFacts !== null) {
                  recordFacts.payments.push({
                    method: "CardMachine",
                    part: null,
                    batch: String(payment.orderBatchReference),
                    actor: String(payment.actorReference),
                    at: String(payment.takenAt),
                  });
                  for (const refund of refunds)
                    recordFacts.refunds.push({
                      method: "CardMachine",
                      amountMinor: refund.amountMinor.toString(),
                      actor: String(refund.actorReference),
                      approver: null,
                      at: String(refund.refundedAt),
                    });
                }
                roundPayments.set(String(payment.orderBatchReference), {
                  payment,
                  refundedMinor: refunds.reduce((sum, refund) => sum + refund.amountMinor, 0n),
                });
              }
            for (const [batch, round] of rounds) {
              const machine = roundPayments.get(batch) ?? null;
              const paid = machine?.payment ?? null;
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
                        refundedMinor: (machine?.refundedMinor ?? 0n).toString(),
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
              for (let index = 0; index < open.length; index += 100)
                for (const batch of await listStoreKitchenBatchesWithNothingToPrepare(
                  businessTransaction,
                  scoped,
                  open.slice(index, index + 100),
                ))
                  nothingToPrepare.add(batch);
            }
            // "Can't make it" is offered to whoever can accept, on batches the System accepted.
            if (!cancelAllowed && acceptanceAllowed && automaticBatches.length > 0) {
              confirmed = await listStoreConfirmedOrderBatches(
                businessTransaction,
                scoped,
                orderReferences,
              );
              const open = automaticBatches.filter(
                (batch) => confirmed.has(batch) && !cancellations.has(batch),
              );
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
              const refund =
                options.resolveRefundConfiguration === undefined || tenantReference === null
                  ? null
                  : await readItemCancellationRefund(
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
              recordFacts?.cancellations.push({
                what: "Items",
                actor: String(record.actorReference),
                at: String(record.cancelledAt),
              });
              for (const line of record.orderItemReferences)
                itemCancellations.set(String(line), {
                  cancellationReference: String(record.cancellationReference),
                  reasonCode: record.reasonCode,
                  cancelledAt: String(record.cancelledAt),
                  // A Provider-failed refund stays "pending" here; "Check refund" shows the failure.
                  refundStatus: refund?.status === "Refunded" ? "Refunded" : "Pending",
                  refundMinor:
                    refund?.items.find((item) => item.orderItemReference === String(line))
                      ?.amountMinor ?? null,
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
            for (let index = 0; index < orderReferences.length; index += 200) {
              const orders = orderReferences.slice(index, index + 200);
              const removed = new Set<string>();
              for (const record of await createPostgresPayLaterItemCancellationStore({
                ...scoped,
                authorize: async () => stillAllowed(),
              }).listByOrders(businessTransaction, orders))
                for (const line of record.orderItemReferences) {
                  removed.add(line);
                  unpaidRemoved.set(record.orderBatchReference, [
                    ...(unpaidRemoved.get(record.orderBatchReference) ?? []),
                    line,
                  ]);
                }
              if (tenantReference === null) continue;
              const rounds = await createPostgresOrderPayLaterConfirmationStore({
                ...scoped,
                quoteVersion: 2,
                sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
                authorize: async () => stillAllowed(),
              }).listByOrders({ transaction: businessTransaction, orderReferences: orders });
              if (rounds.length === 0) continue;
              const payLaterOrders = [
                ...new Set(rounds.map((round) => String(round.orderReference))),
              ];
              const tableStore = createPostgresDiningTableSettlementStore({
                scope: { tenantReference, ...scoped },
                authorize: async () => stillAllowed(),
              });
              const settlements = await tableStore.listByOrders(
                businessTransaction,
                payLaterOrders,
              );
              if (recordFacts !== null)
                for (const settlement of settlements)
                  recordFacts.payments.push({
                    method: settlement.method,
                    part: settlement.part?.partNumber ?? null,
                    batch: null,
                    actor:
                      settlement.method === "Online" ? null : String(settlement.actorReference),
                    at: String(settlement.takenAt),
                  });
              const writeOffs = await tableStore.listWriteOffsByOrders(
                businessTransaction,
                payLaterOrders,
              );
              if (recordFacts !== null && payLaterOrders.length > 0) {
                // A table's refunds are recorded by the manager who made them.
                for (const [method, refunds] of [
                  [
                    "Cash",
                    await tableStore.listCashRefundsByOrders(businessTransaction, payLaterOrders),
                  ],
                  [
                    "CardMachine",
                    await tableStore.listCardRefundsByOrders(businessTransaction, payLaterOrders),
                  ],
                ] as const)
                  for (const refund of refunds)
                    recordFacts.refunds.push({
                      method,
                      amountMinor: refund.amountMinor.toString(),
                      actor: String(refund.approvedByActorReference),
                      approver: null,
                      at: String(refund.refundedAt),
                    });
                for (const refund of await tableStore.listOnlineRefundsByOrders(
                  businessTransaction,
                  payLaterOrders,
                ))
                  if (refund.outcome?.status !== "Failed")
                    recordFacts.refunds.push({
                      method: "Online",
                      amountMinor: refund.amountMinor.toString(),
                      actor: String(refund.approvedByActorReference),
                      approver: null,
                      at: String(refund.requestedAt),
                    });
              }
              if (recordFacts !== null)
                for (const entry of writeOffs)
                  recordFacts.writeOff = {
                    amountMinor: entry.writtenOffMinor.toString(),
                    actor: String(entry.requestedByActorReference),
                    approver: String(entry.approvedByActorReference),
                    at: String(entry.decidedAt),
                  };
              const writtenOff = new Map(
                writeOffs.map(
                  (entry) =>
                    [String(entry.orderReference), entry.writtenOffMinor.toString()] as const,
                ),
              );
              // WP-2423 item 8 ④: a split bill counts as paid once every part of its split is.
              const splitOrders = [
                ...new Set(
                  settlements
                    .filter((entry) => entry.part !== null)
                    .map((entry) => String(entry.orderReference)),
                ),
              ];
              const splitPlans = new Map(
                (splitOrders.length === 0
                  ? []
                  : await tableStore.listSplitPlans(businessTransaction, splitOrders)
                ).map((plan) => [String(plan.orderReference), plan] as const),
              );
              const paid = new Set(
                settlements.map((settlement) => String(settlement.orderReference)),
              );
              if (!(await stillAllowed())) return unavailable();
              const reductions = await listOrderPriceReductions(
                businessTransaction,
                scoped,
                payLaterOrders,
              );
              const reduced = new Map(
                reductions.map((record) => [record.orderItemReference, record]),
              );
              // v15 M87/M161: who decided each comp, by name ("You" for the viewer), or their role.
              const decidedBy =
                reductions.length === 0 || ownerScope === null
                  ? null
                  : await (async () => {
                      const directory =
                        businessTransaction as unknown as MemberDirectoryTransaction;
                      const names = new Map<string, string | null>(
                        (await listStoreMembers(directory, ownerScope)).map((member) => [
                          member.actorReference,
                          member.displayName,
                        ]),
                      );
                      const others = [
                        ...new Set(reductions.map((record) => record.actorReference)),
                      ].filter((actor) => !names.has(actor));
                      for (const [actor, name] of await memberDisplayNames(
                        directory,
                        ownerScope,
                        others,
                      ))
                        names.set(actor, name);
                      return createStaffLabels(
                        businessTransaction as unknown as RoleAssignmentTransaction,
                        ownerScope,
                        {
                          viewer: String(resolved.actorReference),
                          at: new Date(Date.parse(String(source.now()))).toISOString(),
                          names,
                        },
                      );
                    })().catch(() => null);
              if (!(await stillAllowed())) return unavailable();
              for (const record of reductions)
                comped.set(record.orderBatchReference, [
                  ...(comped.get(record.orderBatchReference) ?? []),
                  {
                    orderItemReference: record.orderItemReference,
                    kind: record.kind,
                    percent: record.percent,
                    amountMinor: record.totalMinor.toString(),
                    reasonCode: record.reasonCode,
                    decidedAt: record.decidedAt,
                    byLabel:
                      record.reasonCode === "POINTS_REDEMPTION" || decidedBy === null
                        ? null
                        : decidedBy(record.actorReference),
                  },
                ]);
              // v15 M176: tables merged into another, and the Order whose bill they are on now.
              const mergedTargets = new Map<string, string>();
              for (let index = 0; index < payLaterOrders.length; index += 200)
                for (const [source, target] of await listOrderMergedInto(
                  businessTransaction,
                  scoped,
                  payLaterOrders.slice(index, index + 200),
                ))
                  mergedTargets.set(source, target);
              // The table's bill on the Orders list: what it paid, else what its rounds come to.
              for (const order of payLaterOrders) {
                // The guests left and it was written off: nothing is waiting to be paid.
                const writtenOffMinor = writtenOff.get(order);
                if (writtenOffMinor !== undefined) {
                  tableBills.set(order, { totalMinor: "0", paid: null, writtenOffMinor });
                  continue;
                }
                const settlement = settlements.find(
                  (entry) => String(entry.orderReference) === order && entry.part === null,
                );
                const parts = settlements.filter(
                  (entry) => String(entry.orderReference) === order && entry.part !== null,
                );
                const plan = splitPlans.get(order);
                if (
                  settlement === undefined &&
                  plan !== undefined &&
                  plan.mode !== "Whole" &&
                  plan.parts.length > 0 &&
                  plan.parts.every((part) =>
                    parts.some((entry) => entry.part?.partNumber === part.partNumber),
                  )
                ) {
                  const refunded = await tableRefundedMinor(
                    businessTransaction as never,
                    tableStore,
                    order,
                  );
                  tableBills.set(order, {
                    totalMinor: parts
                      .reduce((sum, entry) => sum + entry.roundsMinor, 0n)
                      .toString(),
                    paid: {
                      amountMinor: parts
                        .reduce((sum, entry) => sum + entry.totalMinor, 0n)
                        .toString(),
                      method: "Split",
                      ...(refunded > 0n ? { refundedMinor: refunded.toString() } : {}),
                    },
                  });
                  continue;
                }
                if (settlement !== undefined) {
                  const refunded = await tableRefundedMinor(
                    businessTransaction as never,
                    tableStore,
                    order,
                  );
                  tableBills.set(order, {
                    totalMinor: settlement.roundsMinor.toString(),
                    paid: {
                      amountMinor: settlement.totalMinor.toString(),
                      method: settlement.method,
                      ...(refunded > 0n ? { refundedMinor: refunded.toString() } : {}),
                    },
                  });
                  continue;
                }
                // v15 M176: merged into another table, its dishes are on that table's bill: said so,
                // with whether it was paid there; no amount of its own (it is in that bill's).
                const into = mergedTargets.get(order);
                if (into !== undefined && settlement === undefined && parts.length === 0) {
                  const there = await tableStore.listByOrders(businessTransaction, [into]);
                  let paidThere = there.some((entry) => entry.part === null);
                  if (!paidThere && there.some((entry) => entry.part !== null)) {
                    const [targetPlan] = await tableStore.listSplitPlans(businessTransaction, [
                      into,
                    ]);
                    paidThere =
                      targetPlan !== undefined &&
                      targetPlan.mode !== "Whole" &&
                      targetPlan.parts.length > 0 &&
                      targetPlan.parts.every((part) =>
                        there.some((entry) => entry.part?.partNumber === part.partNumber),
                      );
                  }
                  const session = (
                    await listOrderDiningSessions(businessTransaction, scoped, [into])
                  ).get(into);
                  const tableLabel =
                    session === undefined
                      ? null
                      : ((
                          await listDiningSessionTableLabels(businessTransaction, scoped, [session])
                        ).get(session) ?? null);
                  tableBills.set(order, {
                    totalMinor: "0",
                    paid: null,
                    mergedInto: { tableLabel, paid: paidThere },
                  });
                  continue;
                }
                // WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): a table with tables merged into it
                // has one bill — every Order on it (Payment's own figure, as the table panel).
                if (
                  tenantReference !== null &&
                  (await listOrderBillOrders(businessTransaction, scoped, order)).length > 1
                ) {
                  const session = (
                    await listOrderDiningSessions(businessTransaction, scoped, [order])
                  ).get(order);
                  if (session !== undefined) {
                    const merged = await readDiningTableBill(
                      businessTransaction,
                      { tenantReference, ...scoped },
                      {
                        diningSessionReference: session,
                        observedAt: new Date(Date.parse(String(source.now()))).toISOString(),
                        authorize: async () => stillAllowed(),
                      },
                    );
                    tableBills.set(order, {
                      totalMinor: merged.rounds
                        .reduce((sum, round) => sum + BigInt(round.totalMinor), 0n)
                        .toString(),
                      paid: null,
                    });
                    continue;
                  }
                }
                const sent = new Set(
                  rounds
                    .filter((round) => String(round.orderReference) === order)
                    .map((round) => String(round.orderBatchReference)),
                );
                const billed = (
                  await listOrderItemPrices(businessTransaction, scoped, order)
                ).filter(
                  (price) =>
                    sent.has(String(price.orderBatchReference)) &&
                    !removed.has(String(price.orderItemReference)),
                );
                // Owner 2026-11-03 walkthrough: the same figure as the table's own bill, with its
                // tax worked out once over the whole bill (DEC-TAX-WHOLE-RECEIPT).
                const owed =
                  billed.reduce(
                    (sum, price) =>
                      sum +
                      price.total.amountMinor -
                      (reduced.get(String(price.orderItemReference))?.totalMinor ?? 0n),
                    0n,
                  ) +
                  computeBillTaxRounding(
                    [...sent].map((batch) => ({
                      orderReference: order,
                      orderBatchReference: batch,
                      items: billed
                        .filter((price) => String(price.orderBatchReference) === batch)
                        .map((price) => {
                          const reduction = reduced.get(String(price.orderItemReference));
                          return {
                            orderItemReference: String(price.orderItemReference),
                            netMinor: price.subtotal.amountMinor - price.discountMinor,
                            taxComponents: price.taxComponents,
                            reduction:
                              reduction === undefined
                                ? null
                                : { netMinor: reduction.netMinor, taxMinor: reduction.taxMinor },
                          };
                        }),
                    })),
                  ).lines.reduce((sum, line) => sum + line.amountMinor, 0n);
                tableBills.set(order, {
                  totalMinor: owed.toString(),
                  ...(plan !== undefined && plan.mode !== "Whole" && parts.length > 0
                    ? {
                        partlyPaid: {
                          remainingMinor: (
                            owed - parts.reduce((sum, entry) => sum + entry.roundsMinor, 0n)
                          ).toString(),
                          paidParts: parts.length,
                          partCount: plan.parts.length,
                        },
                      }
                    : {}),
                  paid: null,
                });
              }
              if (!cancelAllowed && !compAllowed) continue;
              for (const round of rounds) {
                if (paid.has(String(round.orderReference))) continue;
                const batch = String(round.orderBatchReference);
                for (const [line, state] of await listStoreKitchenOrderItemStates(
                  businessTransaction,
                  scoped,
                  [batch],
                )) {
                  // A comped or discounted dish stays on the bill (see the removal command).
                  if (
                    cancelAllowed &&
                    state === "NotStarted" &&
                    !removed.has(line) &&
                    !reduced.has(line)
                  )
                    unpaidRemovable.set(batch, [...(unpaidRemovable.get(batch) ?? []), line]);
                  // DEC-KITCHEN-ONE-TAP: any dish that reached the kitchen (see the comp command).
                  if (
                    compAllowed &&
                    state !== "Cancelled" &&
                    !removed.has(line) &&
                    !reduced.has(line)
                  )
                    compable.set(batch, [...(compable.get(batch) ?? []), line]);
                }
              }
            }
          }
          // DEC-KITCHEN-ONE-TAP: a dish with no Start fact may already be in the pan, so what takes it
          // back (cancel, take off the bill) says how long the kitchen has had it.
          const kitchenReceived = new Map<string, string>();
          if (cancelAllowed && scoped !== null) {
            const rounds = result.items.flatMap((item) =>
              item.batches.map((batch) => String(batch.orderBatchReference)),
            );
            for (let index = 0; index < rounds.length; index += 100)
              for (const [round, at] of await listStoreKitchenBatchReceivedAt(
                businessTransaction,
                scoped,
                rounds.slice(index, index + 100),
              ))
                kitchenReceived.set(round, at);
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
          // WP-2423 (3cd0f8dd M1): the tip the order's payments carried (online and card machine),
          // on the detail only, so staff read a total equal to what was paid, as the guest's page and
          // receipt do. Refunds are shown apart, against the payment.
          const tipMinor =
            lines === null || only === undefined || ownerScope === null
              ? 0n
              : (paidOnline.has(only.orderReference) && !counter.has(only.orderReference)
                  ? await readStoreOrderOnlinePaidTip(
                      businessTransaction,
                      ownerScope,
                      only.orderReference,
                    )
                  : 0n) + (cardMachineTips.get(only.orderReference) ?? 0n);
          // WP-2423 DEC-TAX-WHOLE-RECEIPT: a pay-at-end table's tax is rounded once over its bill;
          // this Order's share of that rounding is part of its total (as checkout charges it). The
          // lines' total is before comps, so Total less the comps is what checkout asks for.
          const taxRoundingMinor =
            lines === null || only === undefined || scoped === null || tenantReference === null
              ? 0n
              : await readOrderTaxRoundingShare(
                  businessTransaction,
                  { tenantReference, ...scoped },
                  {
                    orderReference: only.orderReference,
                    observedAt: new Date(Date.parse(String(source.now()))).toISOString(),
                    authorize: async () => stillAllowed(),
                  },
                );
          const detailLines =
            lines === null || only === undefined
              ? lines
              : Object.freeze({
                  ...lines,
                  totals: Object.freeze({
                    ...lines.totals,
                    taxRounding: Object.freeze({
                      amountMinor: taxRoundingMinor.toString(),
                      currencyCode: lines.totals.total.currencyCode,
                    }),
                    total: Object.freeze({
                      amountMinor: (
                        BigInt(lines.totals.total.amountMinor) + taxRoundingMinor
                      ).toString(),
                      currencyCode: lines.totals.total.currencyCode,
                    }),
                    tip: Object.freeze({
                      amountMinor: tipMinor.toString(),
                      currencyCode: lines.totals.total.currencyCode,
                    }),
                  }),
                  items: Object.freeze(
                    lines.items.map(({ sellableReference, ...line }) => {
                      const cancelled = itemCancellations.get(line.orderItemReference) ?? null;
                      const unavailableNow = soldOutNow
                        .get(only.orderReference)
                        ?.get(line.orderItemReference);
                      return Object.freeze({
                        ...line,
                        ...(alcoholSkus.has(sellableReference) ? { ageCheck: true } : {}),
                        // WP-2423 (M23): sold out or off the menu here since it was ordered.
                        ...(unavailableNow === undefined ? {} : { unavailableNow }),
                        // The detail shows each option by name (v15 2026-10-29: the choice
                        // reference added for combos made every order with options unreadable).
                        options: Object.freeze(
                          line.options.map((option) =>
                            Object.freeze({ name: option.name, quantity: option.quantity }),
                          ),
                        ),
                        canCancel: cancelled === null && lineCancellable(line.orderItemReference),
                        cancellation:
                          cancelled === null
                            ? null
                            : (({ refundMinor, ...shown }) =>
                                Object.freeze({
                                  ...shown,
                                  // A whole line is refunded: what Payment's claim returns for it
                                  // (net after discount, tax and its share of the tip,
                                  // DEC-TIP-REFUND-PROPORTIONAL); unread, its net plus tax.
                                  refund: Object.freeze({
                                    amountMinor: (
                                      refundMinor ??
                                      BigInt(line.subtotal.amountMinor) -
                                        BigInt(line.discount.amountMinor) +
                                        BigInt(line.tax.amountMinor)
                                    ).toString(),
                                    currencyCode: line.tax.currencyCode,
                                  }),
                                }))(cancelled),
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
          // Orders v2 (Owner 2026-10-26, "a row doesn't say what or who"): each listed order's
          // items, the pickup name (never the phone or email) and a table's label, read under the
          // same ordering.operate scope in this transaction.
          const summaries =
            ownerScope === null || result.items.length === 0
              ? new Map<string, MerchantOrderListSummary>()
              : await (async () => {
                  if (!(await authority.guard(businessTransaction))) return unavailable();
                  return loadMerchantOrderListSummaries(
                    businessTransaction,
                    ownerScope,
                    result.items.map((item) => item.orderReference),
                    staffNameLocales(options.locale ?? "en-CA"),
                  );
                })();
          const sessions = [
            ...new Set(
              result.items.flatMap((item) =>
                item.diningSessionReference === null ? [] : [item.diningSessionReference],
              ),
            ),
          ];
          const tables =
            ownerScope === null || sessions.length === 0
              ? new Map<string, string>()
              : await (async () => {
                  if (!(await authority.guard(businessTransaction))) return unavailable();
                  return listDiningSessionTableLabels(businessTransaction, ownerScope, sessions);
                })();
          // DEC-DINING-GUEST-TABLE-START: at a table a guest started nobody has to carry a finished
          // dish over, so Home doesn't raise it as something to serve. Said only of those Orders.
          const guestStartedSessions =
            ownerScope === null || sessions.length === 0
              ? new Map<string, { readonly startedAt: string }>()
              : await (async () => {
                  if (!(await authority.guard(businessTransaction))) return unavailable();
                  return listDiningGuestStartedSessions(businessTransaction, ownerScope, sessions);
                })();
          // WP-2423: how much of an order's online payment Payment has refunded or is refunding
          // (ordinary, item-cancellation, cancellation and automatic refunds), as the receipt reads
          // it. The one-order detail always reads it; the list reads the same position for orders
          // with a recorded refund, so a list row says "partly refunded" exactly when the detail
          // does. Optional evidence: when it cannot be read the payment is shown without it.
          const positionOrders =
            ownerScope === null ||
            tenantReference === null ||
            options.resolveRefundConfiguration === undefined
              ? []
              : input.orderReference !== undefined
                ? only !== undefined &&
                  paidOnline.has(only.orderReference) &&
                  !counter.has(only.orderReference)
                  ? [only.orderReference]
                  : []
                : await (async () => {
                    const online = result.items
                      .map((item) => item.orderReference)
                      .filter((order) => paidOnline.has(order) && !counter.has(order));
                    if (online.length === 0) return [];
                    // Read like the paid totals above (a failed statement ends the transaction).
                    const refunded = await listStoreOrdersWithOnlineRefunds(
                      businessTransaction,
                      ownerScope,
                      online,
                    );
                    // A bounded number per list read; a row beyond it is exact once opened.
                    return online.filter((order) => refunded.has(order)).slice(0, 25);
                  })();
          const paymentPositions = new Map<
            string,
            { readonly refundedMinor: string; readonly refundPendingMinor: string }
          >();
          if (
            positionOrders.length > 0 &&
            ownerScope !== null &&
            tenantReference !== null &&
            options.resolveRefundConfiguration !== undefined
          ) {
            const refundConfiguration = await options.resolveRefundConfiguration(
              businessTransaction,
              { tenantReference, ...ownerScope },
            );
            for (const orderReference of positionOrders) {
              const onlineFinancial = await readCustomerReceiptFinancial(
                businessTransaction,
                { scope: { tenantReference, ...ownerScope }, ...refundConfiguration },
                { orderReference, observedAt: String(source.now()) },
                stillAllowed,
              );
              if (onlineFinancial !== null && onlineFinancial.currencyCode === "CAD")
                paymentPositions.set(
                  orderReference,
                  Object.freeze({
                    refundedMinor: onlineFinancial.confirmedRefundMinor.toString(),
                    refundPendingMinor: onlineFinancial.pendingRefundMinor.toString(),
                  }),
                );
            }
          }
          const paymentPosition =
            only === undefined ? null : (paymentPositions.get(only.orderReference) ?? null);
          // WP-2423 M127: only an order still waiting to be accepted (Submitted) can be cancelled
          // unpaid; once accepted, cancelled or closed it never offers the cancel.
          const counterFor = (item: (typeof result.items)[number]) => {
            const current = counter.get(item.orderReference);
            if (current === undefined) return null;
            return current.canCancelUnpaid && item.currentPhase !== "Submitted"
              ? { ...current, canCancelUnpaid: false }
              : current;
          };
          // WP-2423 M61: who accepted, handed over, took payment, cancelled, refunded and approved.
          const record =
            recordFacts === null || only === undefined || scoped === null
              ? null
              : await (async () => {
                  if (!(await authority.guard(businessTransaction))) return unavailable();
                  const rounds = await listOrderRoundAcceptances(
                    businessTransaction,
                    scoped,
                    only.orderReference,
                  );
                  for (const round of rounds)
                    if (round.accepted !== null)
                      recordFacts.accepted.push({
                        round: round.roundNumber,
                        actor: round.accepted.actorReference,
                        at: round.accepted.acceptedAt,
                      });
                  if (only.orderType === "Pickup")
                    for (const handoff of await listOrderPickupHandoffActors(
                      businessTransaction,
                      scoped,
                      only.orderReference,
                    ))
                      recordFacts.handedOver.push({
                        actor: handoff.actorReference,
                        at: handoff.handedOverAt,
                      });
                  // Ordinary refunds Payment sent back: who asked, and who approved (a second
                  // person, or the sole operator on their own under DEC-SOLE-OPERATOR).
                  recordFacts.refunds.push(
                    ...ordinaryRefundRecordEntries(
                      await listOrderOrdinaryRefundRequesters(
                        businessTransaction,
                        scoped,
                        only.orderReference,
                      ),
                      await listOrderOrdinaryRefundApprovers(
                        businessTransaction,
                        scoped,
                        only.orderReference,
                      ),
                    ),
                  );
                  const named = await nameOrderRecord(businessTransaction, scoped, {
                    viewer: String(resolved.actorReference),
                    at: String(source.now()),
                    facts: recordFacts,
                    rounds: new Map(
                      rounds.map((round) => [round.orderBatchReference, round.roundNumber]),
                    ),
                  });
                  return Object.freeze({
                    ...named,
                    paidOnlineByGuest:
                      paidOnline.has(only.orderReference) && !counter.has(only.orderReference),
                  });
                })();
          return Object.freeze({
            ...result,
            lines: detailLines,
            record,
            pickupContact,
            paymentPosition,
            // DEC-PAID-ORDER-AUTO-ACCEPT: only at a Store that has it on or has orders from it.
            ...(paidOrderWatch === null
              ? {}
              : {
                  paidOrderWatch: Object.freeze({
                    ...paidOrderWatch,
                    canTurnOff: pauseAllowed,
                    canAcceptOrders: acceptanceAllowed,
                  }),
                }),
            items: Object.freeze(
              result.items.map((item) => {
                const observedAtMs = Date.parse(String(source.now()));
                const closed = unfulfillable.get(item.orderReference) ?? null;
                const hold = closed === null ? (held.get(item.orderReference) ?? null) : null;
                const { decideBy, refundChosen } = pickupAcceptanceDeadline(null, hold);
                const acceptBy =
                  hold === null ? (deadlines.get(item.orderReference) ?? null) : decideBy;
                const summary = summaries.get(item.orderReference);
                return Object.freeze({
                  ...item,
                  /** Orders v2: what the order is and who it is for (null when not read). */
                  summary:
                    summary === undefined
                      ? null
                      : Object.freeze({
                          items: summary.items,
                          lineCount: summary.lineCount,
                          pickupName: item.orderType === "Pickup" ? summary.pickupName : null,
                          tableLabel:
                            item.diningSessionReference === null
                              ? null
                              : (tables.get(item.diningSessionReference) ?? null),
                        }),
                  unfulfillable: closed,
                  pickupNotCollected: uncollected.has(item.orderReference),
                  counter: counterFor(item),
                  // A counter order's payment is the card-machine payment above.
                  paidOnline: counter.has(item.orderReference)
                    ? null
                    : (paidOnline.get(item.orderReference) ?? null),
                  // WP-2423: the refunds of that online payment, when read (see above).
                  paymentPosition: paymentPositions.get(item.orderReference) ?? null,
                  // A held order's deadline is the decision deadline once staff are back (none while
                  // it is held); otherwise Fulfillment's capacity expiry.
                  acceptBy,
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
                    item.batches.map((batch) => {
                      const paymentDue = resolveMerchantBatchPaymentDue({
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
                        waitingForStaff: new Set(waitingForStaff.keys()),
                      });
                      const canRequestAcceptance =
                        closed === null &&
                        acceptanceAllowed &&
                        payments.awaitingAcceptance.has(batch.orderBatchReference) &&
                        batch.acceptanceStatus === "NotAccepted" &&
                        item.currentVersion !== null &&
                        ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                          String(item.currentPhase),
                        ) &&
                        // WP-2423: every paid round of a table is accepted on its own, in any
                        // order and whatever later rounds did (submitted, paid, accepted or
                        // cancelled); the command checks the Order's current version. A pickup
                        // order has one round, acceptable only while nothing else changed it.
                        (batch.sequence > 1 ||
                          item.orderType === "DineIn" ||
                          item.currentVersion === 1);
                      // DEC-PAID-ORDER-AUTO-ACCEPT: keys only where they apply, so a tablet at a
                      // Store without it keeps reading the list it knows.
                      const automatic = autoAcceptance.get(batch.orderBatchReference);
                      const canCantMake =
                        automatic?.kind === "Accepted" &&
                        acceptanceAllowed &&
                        closed === null &&
                        item.currentVersion !== null &&
                        !uncollected.has(item.orderReference) &&
                        !cancellations.has(batch.orderBatchReference) &&
                        confirmed.has(batch.orderBatchReference) &&
                        !started.has(batch.orderBatchReference) &&
                        !automaticKitchen.notPrepared.has(batch.orderBatchReference) &&
                        // The same phases the general cancel is offered in.
                        (item.orderType === "Pickup"
                          ? item.currentPhase === "Accepted"
                          : ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                              String(item.currentPhase),
                            ));
                      const automaticKeys: {
                        acceptedAutomaticallyAt?: string;
                        canCantMake?: boolean;
                        reachedKitchen?: boolean;
                        kept?: boolean;
                        canKeep?: boolean;
                        notSentAutomatically?: Readonly<{
                          reason: string;
                          itemCount: number | null;
                        }>;
                      } =
                        automatic?.kind === "Accepted"
                          ? {
                              acceptedAutomaticallyAt: automatic.acceptedAt,
                              canCantMake,
                              reachedKitchen: automaticKitchen.reached.has(
                                batch.orderBatchReference,
                              ),
                              kept: automatic.kept,
                              // A table round made on paper too: it leaves the warnings.
                              canKeep: canCantMake && !automatic.kept,
                            }
                          : automatic?.kind === "Skipped" &&
                              batch.acceptanceStatus === "NotAccepted"
                            ? {
                                notSentAutomatically: Object.freeze({
                                  reason: automatic.reason,
                                  itemCount: automatic.itemCount,
                                }),
                              }
                            : {};
                      return Object.freeze({
                        ...batch,
                        ...automaticKeys,
                        canRequestAcceptance,
                        // WP-2423: when a paid dine-in round staff can accept was paid. It is never
                        // refunded automatically, so staff are warned while it waits (pickups
                        // have their acceptance deadline, `acceptBy`).
                        awaitingAcceptanceSince:
                          canRequestAcceptance && item.orderType === "DineIn"
                            ? (payments.awaitingSince.get(batch.orderBatchReference) ?? null)
                            : null,
                        canCancel:
                          cancelAllowed &&
                          closed === null &&
                          !uncollected.has(item.orderReference) &&
                          !cancellations.has(batch.orderBatchReference) &&
                          item.currentVersion !== null &&
                          // v15 2026-11-01: paid and waiting for acceptance, the Store may refuse
                          // and refund it directly (no Accept first).
                          (canRequestAcceptance ||
                            (batch.acceptanceStatus === "Accepted" &&
                              confirmed.has(batch.orderBatchReference) &&
                              !started.has(batch.orderBatchReference) &&
                              (item.orderType === "Pickup"
                                ? item.currentPhase === "Accepted" &&
                                  !nothingToPrepare.has(batch.orderBatchReference)
                                : ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                                    String(item.currentPhase),
                                  )))),
                        staffCancellation: cancellations.get(batch.orderBatchReference) ?? null,
                        // WP-2423 Q7 slice 2: a round staff entered for the table (or null).
                        staffRound: staffRounds.get(batch.orderBatchReference) ?? null,
                        paymentDue,
                        // WP-2423 abandoned payment: a manager may cancel a round nobody paid for
                        // (the command proves from Payment that nothing was charged).
                        canCancelUnpaid: cancelAllowed && paymentDue !== null,
                        canCancelItems:
                          openBatches.has(batch.orderBatchReference) &&
                          [...cancellableLines.values()].includes(batch.orderBatchReference),
                        // DEC-DINE-IN-PAY-LATER (rule 2): dishes staff may take off this unpaid
                        // pay-later round now, and those already taken off (never charged).
                        unpaidRemovableItems: Object.freeze(
                          closed === null &&
                            item.currentVersion !== null &&
                            batch.acceptanceStatus === "Accepted" &&
                            ["Submitted", "Accepted", "InProgress", "Ready"].includes(
                              String(item.currentPhase),
                            )
                            ? (unpaidRemovable.get(batch.orderBatchReference) ?? [])
                            : [],
                        ),
                        unpaidRemovedItems: Object.freeze(
                          unpaidRemoved.get(batch.orderBatchReference) ?? [],
                        ),
                        // WP-2423 item 8 ① segment 2: comps and discounts on this round.
                        compableItems: Object.freeze(
                          closed === null && item.currentVersion !== null
                            ? (compable.get(batch.orderBatchReference) ?? [])
                            : [],
                        ),
                        compedItems: Object.freeze(
                          (comped.get(batch.orderBatchReference) ?? []).map((entry) =>
                            Object.freeze(entry),
                          ),
                        ),
                        kitchenReceivedAt: kitchenReceived.get(batch.orderBatchReference) ?? null,
                        // WP-2423 item 8 ⑤: a guest round waiting for staff (not on the bill).
                        waitingForStaff: waitingForStaff.get(batch.orderBatchReference) ?? null,
                        // WP-2423 M04: a paid round accepted but not yet released to the kitchen
                        // (the payment worker releases it within seconds). "NotInKitchen" a minute
                        // after acceptance: staff make it from its dishes, or reject and refund.
                        kitchenRelease: kitchenRelease(
                          closed === null && batch.acceptanceStatus === "Accepted"
                            ? (payments.acceptedNotReleased.get(batch.orderBatchReference) ?? null)
                            : null,
                          observedAtMs,
                        ),
                        // A paid pickup not accepted by its deadline is refunded by the System
                        // within seconds; still here a minute later, staff reject and refund it.
                        automaticRefundLate:
                          item.orderType === "Pickup" &&
                          canRequestAcceptance &&
                          hold === null &&
                          acceptBy !== null &&
                          observedAtMs - Date.parse(acceptBy) >= kitchenReleaseLateMs,
                      });
                    }),
                  ),
                  canRequestAcceptance:
                    closed === null &&
                    acceptanceAllowed &&
                    payments.awaitingAcceptance.has(item.initialBatchReference) &&
                    item.currentPhase === "Submitted" &&
                    item.currentVersion === 1,
                  // WP-2423 (M23): a dish in it sold out or came off the menu since it was ordered.
                  ...(soldOutNow.has(item.orderReference) ? { soldOutNow: true as const } : {}),
                  // DEC-DINE-IN-PAY-LATER: on the table's bill (owed), or what the table paid.
                  tableBill: tableBills.get(item.orderReference) ?? null,
                  ...(item.diningSessionReference !== null &&
                  guestStartedSessions.has(item.diningSessionReference)
                    ? { startedByGuest: true as const }
                    : {}),
                  // WP-2423 (v15 751dd768): whether this person may record a card-machine payment
                  // and open the order's payments and refunds (the commands and reads recheck).
                  canRecordCardMachinePayment: cardMachinePaymentAllowed,
                  canViewPayments: paymentsAllowed,
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

/** WP-2423 M04: a healthy payment worker releases an accepted paid round within a few seconds. */
const kitchenReleaseLateMs = 60_000;
/** WP-2423 M04: an accepted paid round still on its way to the kitchen (null once released). */
function kitchenRelease(
  acceptedAt: string | null,
  observedAtMs: number,
): Readonly<{ state: "Sending" | "NotInKitchen"; acceptedAt: string }> | null {
  if (acceptedAt === null) return null;
  return Object.freeze({
    state:
      observedAtMs - Date.parse(acceptedAt) >= kitchenReleaseLateMs ? "NotInKitchen" : "Sending",
    acceptedAt,
  });
}

/** A throwaway reference for a payment preparation built only to read its amount (never stored). */
function transientReference(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = randomBytes(10).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${(8 + (Number.parseInt(random.slice(3, 4), 16) % 4)).toString(16)}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

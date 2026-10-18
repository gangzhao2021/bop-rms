import {
  createDiningOrderDeliveryProgress,
  servedOrderItemFacts,
} from "./dining-order-delivery-progress.js";

type DiningDelivery = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDiningOrderDeliveryProgress>["load"]>>
>;
import {
  createPostgresKitchenCustomerStatusReader,
  listOpenKitchenReworkItems,
} from "@rms/kitchen";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentStatusStore,
  listOrderPaymentTerminalOutcomes,
  listStoreOrderBatchPaymentOutcomes,
} from "@rms/payment";
import { loadPickupNotCollected } from "@rms/fulfillment";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionService,
  GuestSessionError,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  acquireOrderDispositionFence,
  createOrderStatusQueryService,
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listStoreDiningBatchPaymentDeadlines,
  listStoreOrderAcceptanceHolds,
  listStoreUnpaidBatchCancellations,
  listOrderItemPrices,
  loadOrderNotAcceptedClosure,
  loadPickupPaymentWindowClosure,
  createPostgresOrderStatusProjectionStore,
  createPostgresDigitalReceiptStore,
  createPostgresDiningSessionOrderLookup,
  findGuestSessionOrder,
  loadOrderCanonicalPhase,
  OrderStatusProjectionError,
  parseOrderingReference,
  readCheckoutContactPresence,
  type CartQueryTransactionRunner,
  type CheckoutContactPresence,
} from "@rms/ordering";
import { readCurrentStoreReceiptProfile } from "@rms/store";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { withFailureCause } from "./customer-failure-diagnostic.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import type { PersistentPublicStoreProfileOptions } from "./persistent-public-store-profile.js";
import { readCustomerStoreContact, type CustomerStoreContact } from "./customer-store-contact.js";
import { readStaffCancellationRefundStatus } from "./merchant-order-staff-cancellation.js";
import { readItemCancellationRefundStatus } from "./merchant-order-item-staff-cancellation.js";
import {
  resolveCustomerBatchPayments,
  type BatchPaymentOutcome,
  type CustomerBatchPayment,
} from "./dining-batch-payment-due.js";

/** WP-2423 Q6: customer-safe reason categories; staff identity and internal codes stay private. */
const customerCancellationReasons = Object.freeze({
  CUSTOMER_REQUEST: "CustomerRequest",
  SOLD_OUT: "SoldOut",
  STORE_ERROR: "StoreError",
  DUPLICATE_ORDER: "DuplicateOrder",
  // DEC-TABLE-CLOSE-GUESTS-LEFT: the table was closed after the party left.
  GUEST_LEFT: "GuestLeft",
} as const);

/** Current Guest credentials are resolved inside the same transaction as the owner projection. */
export function createCustomerOrderStatusRead(
  options: Omit<CustomerCheckoutSessionAuthorizationOptions, "transactions"> & {
    readonly diningScope?: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
    };
    readonly paymentScope?: {
      brandReference: string;
      storeReference: string;
      providerAccountReference: string;
      environment: "Test" | "Live";
    };
    /** WP-2423 Q6 step 2a: Payment scope item cancellation refunds are read under. */
    readonly itemRefundScope?: {
      tenantReference: string;
      providerAccountReference: string;
      environment: "Test" | "Live";
    };
    /** WP-2423 Q10: the Store's published phone and address, shown with the order. */
    readonly publicProfile?: PersistentPublicStoreProfileOptions;
    /**
     * WP-2423 Q16: say whether this Session's order still holds a contact the customer can remove,
     * and link the Store's privacy notice (Store receipt profile) when its Owner entered one.
     */
    readonly contactPrivacy?: boolean;
    readonly transactions: {
      run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
    };
  },
) {
  return Object.freeze({
    async read(value: unknown) {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let orderReference: string;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "orderReference",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        orderReference = String(parseOrderingReference(raw.orderReference));
      } catch {
        throw new OrderStatusProjectionError("ORDER_STATUS_INPUT_INVALID");
      }
      // v15 2026-10-16: a deadlock or lock wait with a payment outcome or acceptance (which take
      // the Order fence, then lock the Dining table row) is rerun instead of answering 503.
      const transactions = {
        run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) =>
          retryTransactionConflict(() => options.transactions.run(work)),
      };
      try {
        return await transactions.run(async (transaction) => {
          // WP-2423 lock order: the Order's disposition fence comes before the guest authorization
          // below reads the Dining table row FOR SHARE. Taken after it, a payment outcome holding
          // the fence and waiting for that row deadlocked this read (v15 2026-10-16: 40P01 each
          // time a guest reopened the payment result).
          await acquireOrderDispositionFence(transaction, { ...options.scope, orderReference });
          const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
          let previous: string | undefined;
          const now = () => {
            const at = String(parseCanonicalInstant(options.now()));
            if (previous !== undefined && at < previous)
              throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
            previous = at;
            return at;
          };
          const identity = new GuestSessionService({
            store: createPostgresGuestSessionEntryStore(runner, options.scope),
            credentials: options.credentials,
            binding: options.binding(transaction),
            now,
            admission: { consume: async () => null },
          });
          const authorize = async () => {
            const guest = await identity.authorize({ ...credentials, observedAt: now() });
            if (
              guest.brandReference !== options.scope.brandReference ||
              guest.storeReference !== options.scope.storeReference
            )
              throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
            return guest;
          };
          const guest = await authorize();
          const fingerprint = JSON.stringify(guest);
          const stillAuthorized = async () => JSON.stringify(await authorize()) === fingerprint;
          const store = createPostgresOrderStatusProjectionStore({
            ...options.scope,
            authorize: async (_tx, scope) =>
              scope.access === "Load" &&
              scope.orderReference === orderReference &&
              scope.brandReference === options.scope.brandReference &&
              scope.storeReference === options.scope.storeReference &&
              (await stillAuthorized()),
            validateCurrentSource: async () => false,
          });
          // One Dining delivery read per status read: the phase merge and the served quantities
          // shown to the guest come from the same facts.
          let deliveryRead: Promise<DiningDelivery | null> | undefined;
          const loadDelivery = (): Promise<DiningDelivery | null> => {
            if (options.diningScope === undefined) return Promise.resolve(null);
            if (guest.channel !== "DineIn" || guest.diningSessionReference === null)
              throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
            const diningScope = options.diningScope;
            const diningSessionReference = String(guest.diningSessionReference);
            deliveryRead ??= createDiningOrderDeliveryProgress({
              ...options.scope,
              diningScope,
              authorize: async () => stillAuthorized(),
              authorizeKitchen: async () => stillAuthorized(),
              authorizeDining: async () => stillAuthorized(),
            }).load({
              transaction,
              ...options.scope,
              orderReference,
              diningSessionReference,
              guestSessionReference: String(guest.sessionReference),
              observedAt: now(),
            });
            return deliveryRead;
          };
          // WP-2423 (v15 8c4480dd M1, DEC-DINING-ANY-PARTICIPANT-SUBMIT): a dine-in table shares one
          // Order across rounds, so a guest who submitted and paid a later round reads the table's
          // Order here like its first guest does. Only the Order of this guest's own dining
          // session (Ordering's order header), decided after the owner check refused it.
          let tableParticipant = false;
          const query = createOrderStatusQueryService({
            authorization: {
              authorizeCustomer: async (input) =>
                input.orderReference === orderReference && (await stillAuthorized())
                  ? { guestSession: guest }
                  : null,
              authorizeDiningParticipant: async (input) =>
                tableParticipant &&
                input.orderReference === orderReference &&
                (await stillAuthorized())
                  ? { guestSession: guest }
                  : null,
              authorizeMerchant: async () => null,
            },
            projections: {
              load: (reference) => store.load({ transaction, orderReference: reference }),
              list: async () => {
                throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
              },
            },
            // WP-2423 / DEC-PILOT-BATCH-PHASE-01: the current phase Ordering merges from its own
            // records and the Kitchen facts it consumed (accepted, preparing, ready, collected).
            // Dining publishes no events: a dine-in Order's served items come from Dining's public
            // served-quantity reader here, under the same fence, so every remaining item served
            // reads Fulfilled (rule 2). Ordering never reads Dining's tables.
            phases: {
              load: async (reference, order) => {
                if (reference !== orderReference || !(await stillAuthorized()))
                  throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
                // A guest outside the table's dining session is refused by the dining read below.
                const delivery =
                  order.orderType === "DineIn" &&
                  guest.channel === "DineIn" &&
                  guest.diningSessionReference !== null
                    ? await loadDelivery()
                    : null;
                return loadOrderCanonicalPhase(
                  transaction,
                  options.scope,
                  reference,
                  delivery === null ? null : servedOrderItemFacts(delivery.items),
                );
              },
            },
          });
          let result: Awaited<ReturnType<typeof query.getCustomer>>;
          try {
            result = await query.getCustomer({ orderReference, observedAt: now() });
          } catch (error) {
            if (
              !(error instanceof OrderStatusProjectionError) ||
              error.code !== "ORDER_STATUS_PERMISSION_DENIED"
            )
              throw error;
            tableParticipant = await isGuestTableOrder(transaction, {
              scope: options.scope,
              guest,
              orderReference,
              now,
              stillAuthorized,
            });
            if (!tableParticipant) throw error;
            result = await query.getDiningParticipant({ orderReference, observedAt: now() });
          }
          let dining: null | {
            items: {
              orderItemReference: string;
              orderBatchReference: string;
              servedQuantity: number;
            }[];
          } = null;
          if (result.order.orderType === "DineIn" && options.diningScope !== undefined) {
            const delivery = await loadDelivery();
            const members = result.order.batches.flatMap((batch) =>
              batch.items.map((item) => ({
                orderBatchReference: String(batch.orderBatchReference),
                orderItemReference: String(item.orderItemReference),
                quantity: item.quantity,
              })),
            );
            if (
              !delivery ||
              delivery.items.length !== members.length ||
              delivery.items.some(
                (item) =>
                  !members.some(
                    (member) =>
                      member.orderItemReference === item.orderItemReference &&
                      member.orderBatchReference === item.orderBatchReference &&
                      member.quantity === item.orderedQuantity,
                  ),
              )
            )
              throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
            dining = {
              items: delivery.items.map((item) => ({
                orderItemReference: item.orderItemReference,
                orderBatchReference: item.orderBatchReference,
                servedQuantity: item.deliveredQuantity,
              })),
            };
          }
          const kitchenReader = createPostgresKitchenCustomerStatusReader({
            ...options.scope,
            authorize: async (_tx, scope) =>
              scope.orderReference === orderReference && (await stillAuthorized()),
          });
          const kitchen = await kitchenReader.loadByOrder({ transaction, orderReference });
          const expectedBatches = new Set(
            result.order.batches.map((batch) => String(batch.orderBatchReference)),
          );
          const scopedKitchen =
            kitchen !== null &&
            kitchen.batches.length > 0 &&
            kitchen.batches.length <= expectedBatches.size &&
            kitchen.batches.every((batch) =>
              expectedBatches.has(String(batch.orderBatchReference)),
            );
          let payments:
            | null
            | {
                status: "Succeeded" | "Failed";
                occurredAt: string;
                amount: { amountMinor: bigint; currencyCode: string } | null;
                freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
                /** WP-2423 (v15 3cd0f8dd H1): set for a payment taken on the Store's card machine. */
                method?: "CardMachine";
                orderBatchReference?: string;
              }[] = null;
          let tips:
            | null
            | {
                orderBatchReference: string;
                amount: { amountMinor: bigint; currencyCode: string };
              }[] = null;
          if (options.paymentScope !== undefined) {
            if (
              options.paymentScope.brandReference !== options.scope.brandReference ||
              options.paymentScope.storeReference !== options.scope.storeReference
            )
              throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
            const paymentReader = createPostgresPaymentStatusStore({
              scope: options.paymentScope,
              authorizeOrder: async (_tx, scope) =>
                scope.orderReference === orderReference && (await stillAuthorized()),
              authorize: async () => stillAuthorized(),
            });
            const projections = await paymentReader.listByOrder({ transaction, orderReference });
            payments = projections.map((projection) => ({
              status: projection.snapshot.terminalStatus,
              occurredAt: projection.snapshot.terminalOccurredAt,
              amount: projection.snapshot.amount,
              freshnessStatus: projection.freshnessStatus,
            }));
            // WP-2423 Q10: the status projection is updated asynchronously. A payment the Payment
            // owner already recorded as final (what the payment result page shows) is reported
            // from that fact, so this page never says "pending" after "Payment confirmed".
            if (await stillAuthorized()) {
              const projected = new Set(
                projections.map((projection) => String(projection.snapshot.paymentIntentReference)),
              );
              const facts = await listOrderPaymentTerminalOutcomes(
                transaction,
                options.paymentScope,
                orderReference,
              );
              // WP-2423 (v15 aa3d9fac D2): the tip of each round's successful payment, so the
              // order's total is what was paid (and what the receipt prints), not items only.
              const tipByBatch = new Map<string, bigint>();
              for (const fact of facts)
                if (
                  fact.outcome === "Succeeded" &&
                  fact.tip !== null &&
                  expectedBatches.has(fact.orderBatchReference)
                )
                  tipByBatch.set(
                    fact.orderBatchReference,
                    (tipByBatch.get(fact.orderBatchReference) ?? 0n) + fact.tip.amountMinor,
                  );
              tips = [...tipByBatch].map(([orderBatchReference, amountMinor]) => ({
                orderBatchReference,
                amount: { amountMinor, currencyCode: "CAD" },
              }));
              for (const fact of facts)
                if (!projected.has(fact.paymentIntentReference))
                  payments.push({
                    status: fact.outcome,
                    occurredAt: fact.occurredAt,
                    amount: fact.amount,
                    freshnessStatus: "Fresh",
                  });
              // WP-2423 (v15 3cd0f8dd H1): a round staff took payment for on the Store's card
              // machine is paid too. Payment owns both tenders and the staff order view reads the
              // same records, so the guest sees everything paid for the order (and that round's
              // tip in the total), never an online-only amount that looks like money is owed.
              if (await stillAuthorized()) {
                const machine = await createPostgresCardMachinePaymentStore({
                  scope: {
                    brandReference: options.paymentScope.brandReference,
                    storeReference: options.paymentScope.storeReference,
                  },
                  authorize: async (_tx, query) =>
                    query.orderReference === orderReference && (await stillAuthorized()),
                }).listByOrder(transaction, orderReference);
                for (const { payment } of machine) {
                  const batch = String(payment.orderBatchReference);
                  if (!expectedBatches.has(batch)) continue;
                  payments.push({
                    status: "Succeeded",
                    occurredAt: String(payment.recordedAt),
                    amount: {
                      amountMinor: payment.preparation.total.amountMinor,
                      currencyCode: payment.preparation.total.currencyCode,
                    },
                    freshnessStatus: "Fresh",
                    method: "CardMachine",
                    orderBatchReference: batch,
                  });
                  if (payment.preparation.tip.amountMinor > 0n)
                    tipByBatch.set(
                      batch,
                      (tipByBatch.get(batch) ?? 0n) + payment.preparation.tip.amountMinor,
                    );
                }
                tips = [...tipByBatch].map(([orderBatchReference, amountMinor]) => ({
                  orderBatchReference,
                  amount: { amountMinor, currencyCode: "CAD" },
                }));
              }
            }
          }
          // WP-2423: a pickup the Store closed as not collected (Fulfillment's fact).
          const pickup =
            result.order.orderType === "Pickup" && (await stillAuthorized())
              ? await loadPickupNotCollected(transaction, options.scope, orderReference)
              : undefined;
          // WP-2423 Q12: a pickup the System cancelled because its payment window ended unpaid.
          const unpaid =
            result.order.orderType === "Pickup" && (await stillAuthorized())
              ? await loadPickupPaymentWindowClosure(transaction, options.scope, orderReference)
              : undefined;
          // WP-2423 Q9-G1: a paid pickup the Store did not accept in time is refunded automatically
          // (with the refund's progress); one held because the Store was offline awaits the Store.
          let storeAcceptance:
            | { state: "AwaitingStore" }
            | { state: "NotAccepted"; closedAt: string; refundStatus: "Pending" | "Refunded" }
            | null = null;
          if (result.order.orderType === "Pickup" && (await stillAuthorized())) {
            const closure = await loadOrderNotAcceptedClosure(
              transaction,
              options.scope,
              orderReference,
            );
            if (closure !== null)
              storeAcceptance = {
                state: "NotAccepted",
                closedAt: closure.closedAt,
                refundStatus: await readStaffCancellationRefundStatus(
                  transaction,
                  options.scope,
                  closure,
                  stillAuthorized,
                ),
              };
            else {
              const hold = (
                await listStoreOrderAcceptanceHolds(transaction, options.scope, [orderReference])
              ).get(orderReference);
              if (
                hold !== undefined &&
                !hold.resolutions.some((entry) => entry.resolution === "StaffRefund")
              )
                storeAcceptance = { state: "AwaitingStore" };
            }
          }
          // WP-2423 Q6: batches the Store cancelled after payment, with the refund's progress.
          const staffCancellations = [];
          if (await stillAuthorized())
            for (const record of await createPostgresStaffOrderCancellationReader(
              options.scope,
            ).listByOrders(transaction, [orderReference]))
              staffCancellations.push({
                orderBatchReference: String(record.orderBatchReference),
                cancelledAt: String(record.cancelledAt),
                reason: customerCancellationReasons[record.reasonCode],
                refundStatus: await readStaffCancellationRefundStatus(
                  transaction,
                  options.scope,
                  record,
                  stillAuthorized,
                ),
              });
          // WP-2423 Q6 step 2a: lines the Store cancelled after payment and their refund.
          const itemCancellations = [];
          if (await stillAuthorized())
            for (const record of await createPostgresStaffItemCancellationReader(
              options.scope,
            ).listByOrders(transaction, [orderReference]))
              itemCancellations.push({
                orderBatchReference: String(record.orderBatchReference),
                orderItemReferences: record.orderItemReferences.map(String),
                cancelledAt: String(record.cancelledAt),
                reason: customerCancellationReasons[record.reasonCode],
                refundStatus:
                  options.itemRefundScope === undefined
                    ? ("Pending" as const)
                    : await readItemCancellationRefundStatus(
                        transaction,
                        { ...options.scope, ...options.itemRefundScope },
                        record,
                        stillAuthorized,
                      ),
                refundAmount: {
                  amountMinor: record.refundAmountMinor,
                  currencyCode: record.currencyCode,
                },
              });
          // WP-2423 (v15 3cd0f8dd M3): the refunds confirmed on this order and what each returned,
          // as the order's latest receipt version states them (Ordering's receipt, issued from the
          // Payment owner's confirmed refunds), so this page and the receipt never disagree. A
          // receipt that can't be read leaves the page as it was rather than failing it.
          let refunds: null | {
            refunded: { amountMinor: bigint; currencyCode: string };
            entries: {
              kind: "Refund" | "ItemCancellation" | "RoundRefund" | "Other";
              orderItemReferences: string[];
              total: { amountMinor: bigint; currencyCode: string };
              tip: { amountMinor: bigint; currencyCode: string };
            }[];
          } = null;
          if (await stillAuthorized()) {
            await transaction.query("SAVEPOINT customer_order_refunds", []);
            try {
              const chain = await createPostgresDigitalReceiptStore({
                ...options.scope,
                authorize: async (_tx, access) =>
                  access.action === "Read" &&
                  access.orderReference === orderReference &&
                  (await stillAuthorized()),
                validateSources: async () => false,
              }).load({ transaction, orderReference });
              const latest = chain?.records.at(-1);
              if (latest !== undefined && latest.kind !== "Void") {
                const snapshot = latest.snapshot;
                if (snapshot.refundedTotal.amountMinor > 0n)
                  refunds = {
                    refunded: snapshot.refundedTotal,
                    entries: (snapshot.refunds ?? []).map((refund) => ({
                      kind: refund.kind,
                      orderItemReferences: refund.lines.map((line) => line.lineReference),
                      total: refund.total,
                      tip: refund.tip,
                    })),
                  };
              }
              await transaction.query("RELEASE SAVEPOINT customer_order_refunds", []);
            } catch {
              refunds = null;
              await transaction.query("ROLLBACK TO SAVEPOINT customer_order_refunds", []);
              await transaction.query("RELEASE SAVEPOINT customer_order_refunds", []);
            }
          }
          // WP-2423 Q26: dishes the kitchen is remaking (Kitchen's public Query, by Order item), so
          // the customer is not told the order is ready while part of it is being made again.
          const remakes: { orderItemReference: string; quantity: number }[] = [];
          if (await stillAuthorized())
            for (const entry of await listOpenKitchenReworkItems(transaction, options.scope, [
              orderReference,
            ]))
              remakes.push({
                orderItemReference: entry.orderItemReference,
                quantity: entry.openQuantity,
              });
          // WP-2423 D5: each item's frozen price before tax, so the page prints item prices, then
          // the subtotal and tax, like the receipt. Ordering's own frozen order items; only for the
          // items this projection shows. If they can't be read, the page keeps the totals it has.
          // WP-2423: with each item's chosen options (and what each added) and, on a pickup order,
          // the guest's own note, from the same frozen items the cart and checkout showed.
          let itemPrices:
            | {
                orderItemReference: string;
                subtotal: { amountMinor: bigint; currencyCode: string };
                tax: { amountMinor: bigint; currencyCode: string };
                options: readonly {
                  displayName: string;
                  quantity: number;
                  amount: { amountMinor: bigint; currencyCode: string };
                }[];
                customerNote: string | null;
              }[]
            | null = null;
          if (await stillAuthorized()) {
            const shown = new Map(
              result.order.batches.flatMap((batch) =>
                batch.items.map((item) => [String(item.orderItemReference), item] as const),
              ),
            );
            try {
              await transaction.query("SAVEPOINT customer_order_item_prices", []);
              const prices = await listOrderItemPrices(
                transaction,
                options.scope,
                orderReference,
                String(guest.locale),
              );
              await transaction.query("RELEASE SAVEPOINT customer_order_item_prices", []);
              const matched = prices.filter((price) => shown.has(price.orderItemReference));
              if (
                matched.length === shown.size &&
                matched.every(
                  (price) =>
                    shown.get(price.orderItemReference)?.lineTotal.amountMinor ===
                      price.total.amountMinor &&
                    shown.get(price.orderItemReference)?.lineTotal.currencyCode ===
                      price.total.currencyCode,
                )
              )
                itemPrices = matched.map((price) => ({
                  orderItemReference: price.orderItemReference,
                  subtotal: price.subtotal,
                  tax: price.tax,
                  options: price.options,
                  // A shared table's items were added by several guests; like the cart, a note
                  // is shown only to the guest who wrote it, so dine-in notes stay off this page.
                  customerNote:
                    price.addedByParticipantReference === null ? price.customerNote : null,
                }));
            } catch {
              await transaction.query("ROLLBACK TO SAVEPOINT customer_order_item_prices", []);
              await transaction.query("RELEASE SAVEPOINT customer_order_item_prices", []);
            }
          }
          // WP-2423: a dine-in round whose payment failed is cancelled automatically when its payment
          // window ends; the customer is told when before it happens, and that it was not charged.
          let batchPayments: readonly CustomerBatchPayment[] = [];
          const unpaidCancellations: {
            orderBatchReference: string;
            cancelledAt: string;
            /** A manager cancelled it (nothing was charged); otherwise its payment never completed. */
            byStore: boolean;
          }[] = [];
          if (result.order.orderType === "DineIn" && (await stillAuthorized())) {
            for (const entry of await listStoreUnpaidBatchCancellations(
              transaction,
              options.scope,
              [orderReference],
            ))
              unpaidCancellations.push({
                orderBatchReference: entry.orderBatchReference,
                cancelledAt: entry.cancelledAt,
                byStore: entry.reasonCode === "STAFF_CANCELLED_UNPAID",
              });
            const deadlines = new Map<string, string>();
            for (const entry of await listStoreDiningBatchPaymentDeadlines(
              transaction,
              options.scope,
              [orderReference],
            ))
              deadlines.set(entry.orderBatchReference, entry.paymentDeadline);
            const outcomes = new Map<string, BatchPaymentOutcome>();
            if (await stillAuthorized())
              for (const entry of await listStoreOrderBatchPaymentOutcomes(
                transaction,
                options.scope,
                [orderReference],
              ))
                outcomes.set(entry.orderBatchReference, entry.status);
            batchPayments = resolveCustomerBatchPayments({
              batchReferences: result.order.batches.map((batch) =>
                String(batch.orderBatchReference),
              ),
              deadlines,
              outcomes,
              cancelled: new Set(unpaidCancellations.map((entry) => entry.orderBatchReference)),
            });
          }
          // WP-2423 Q10: how to reach the Store about this order (public profile owner read).
          let storeContact: CustomerStoreContact | null = null;
          if (options.publicProfile !== undefined && (await stillAuthorized()))
            storeContact = await readCustomerStoreContact(
              transaction,
              options.publicProfile,
              {
                publicStoreReference: String(guest.publicStoreReference),
                locale: String(guest.locale),
              },
              now(),
            );
          let contactDetails: CheckoutContactPresence | null = null;
          let privacyNoticeUrl: string | null = null;
          if (options.contactPrivacy === true && (await stillAuthorized())) {
            contactDetails = await readCheckoutContactPresence(transaction, options.scope, {
              orderReference,
              guestSessionReference: String(guest.sessionReference),
            });
            privacyNoticeUrl =
              (await readCurrentStoreReceiptProfile(transaction, options.scope))
                ?.privacyNoticeUrl ?? null;
          }
          if (!(await stillAuthorized()))
            throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
          const checkedAt = now();
          return {
            ...result,
            sources: {
              checkedAt,
              ...(dining === null ? {} : { dining }),
              kitchen:
                scopedKitchen && kitchen !== null
                  ? {
                      batches: kitchen.batches.map((batch) => ({
                        orderBatchReference: batch.orderBatchReference,
                        status: batch.status,
                        updatedAt: batch.updatedAt,
                      })),
                    }
                  : null,
              payments,
              ...(pickup === undefined
                ? {}
                : { pickup: pickup === null ? null : { notCollectedAt: pickup.closedAt } }),
              ...(unpaid === undefined
                ? {}
                : {
                    unpaidCancellation: unpaid === null ? null : { cancelledAt: unpaid.closedAt },
                  }),
              ...(staffCancellations.length === 0 ? {} : { staffCancellations }),
              ...(itemCancellations.length === 0 ? {} : { itemCancellations }),
              ...(remakes.length === 0 ? {} : { remakes }),
              ...(refunds === null ? {} : { refunds }),
              ...(itemPrices === null ? {} : { itemPrices }),
              ...(tips === null ? {} : { tips }),
              ...(batchPayments.length === 0 ? {} : { batchPayments }),
              ...(unpaidCancellations.length === 0 ? {} : { unpaidCancellations }),
              ...(storeContact === null ? {} : { storeContact }),
              ...(contactDetails === null ? {} : { contactDetails }),
              ...(privacyNoticeUrl === null ? {} : { privacyNoticeUrl }),
              ...(storeAcceptance === null ? {} : { storeAcceptance }),
            },
          };
        });
      } catch (error) {
        if (error instanceof OrderStatusProjectionError) throw error;
        if (error instanceof GuestSessionError)
          throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
        throw withFailureCause(
          new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"),
          error,
        );
      }
    },
    /**
     * WP-2423 (v15 2026-10-16): the customer status projection is built by the outbox worker after
     * the Order is created, so a guest who opens the page right after paying can arrive before it.
     * Called only when `read` found no projection: the same guest authorization (fence first, same
     * lock order as `read`), then Ordering's own record of the Order this Session placed. `null`
     * (refused like today) for an unknown Order or one another Session placed.
     */
    async received(value: unknown): Promise<CustomerOrderReceived | null> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let orderReference: string;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "orderReference",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        orderReference = String(parseOrderingReference(raw.orderReference));
      } catch {
        throw new OrderStatusProjectionError("ORDER_STATUS_INPUT_INVALID");
      }
      try {
        return await retryTransactionConflict(() =>
          options.transactions.run(async (transaction) => {
            await acquireOrderDispositionFence(transaction, { ...options.scope, orderReference });
            const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
            let previous: string | undefined;
            const now = () => {
              const at = String(parseCanonicalInstant(options.now()));
              if (previous !== undefined && at < previous)
                throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
              previous = at;
              return at;
            };
            const guest = await new GuestSessionService({
              store: createPostgresGuestSessionEntryStore(runner, options.scope),
              credentials: options.credentials,
              binding: options.binding(transaction),
              now,
              admission: { consume: async () => null },
            }).authorize({ ...credentials, observedAt: now() });
            if (
              guest.brandReference !== options.scope.brandReference ||
              guest.storeReference !== options.scope.storeReference
            )
              return null;
            const order = await findGuestSessionOrder(transaction, options.scope, {
              orderReference,
              guestSessionReference: String(guest.sessionReference),
            });
            // A dine-in order is shown only to its own table's guest (as `read` requires).
            if (
              order === null ||
              order.orderReference !== orderReference ||
              (order.orderType === "DineIn" &&
                (guest.channel !== "DineIn" || guest.diningSessionReference === null))
            )
              return null;
            return Object.freeze({
              orderReference: order.orderReference,
              orderNumber: order.orderNumber,
              orderType: order.orderType,
              submittedAt: order.createdAt,
              checkedAt: now(),
            });
          }),
        );
      } catch (error) {
        if (error instanceof OrderStatusProjectionError) throw error;
        if (error instanceof GuestSessionError)
          throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
        throw withFailureCause(
          new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"),
          error,
        );
      }
    },
    /**
     * WP-2423 (46940b76 L5): called only when this guest may not read the Order on its status page.
     * True when the Order is the current Order of the open table this guest has joined (another
     * guest at the table placed it), so the page can send them to their table's view instead of
     * "not found". Same guest authorization and lock order as `read`; never reveals anything for an
     * Order of another table, another party or another Store.
     */
    async tableOrder(value: unknown): Promise<boolean> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let orderReference: string;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "orderReference",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        orderReference = String(parseOrderingReference(raw.orderReference));
      } catch {
        return false;
      }
      try {
        return await retryTransactionConflict(() =>
          options.transactions.run(async (transaction) => {
            await acquireOrderDispositionFence(transaction, { ...options.scope, orderReference });
            const runner: CartQueryTransactionRunner = { run: async (work) => work(transaction) };
            const now = () => String(parseCanonicalInstant(options.now()));
            const service = new GuestSessionService({
              store: createPostgresGuestSessionEntryStore(runner, options.scope),
              credentials: options.credentials,
              binding: options.binding(transaction),
              now,
              admission: { consume: async () => null },
            });
            const guest = await service.authorize({ ...credentials, observedAt: now() });
            const fingerprint = JSON.stringify(guest);
            if (
              guest.brandReference !== options.scope.brandReference ||
              guest.storeReference !== options.scope.storeReference ||
              guest.channel !== "DineIn" ||
              guest.diningSessionReference === null
            )
              return false;
            const diningSessionReference = String(guest.diningSessionReference);
            const guestSessionReference = String(guest.sessionReference);
            const tableOrder = await createPostgresDiningSessionOrderLookup({
              ...options.scope,
              authorize: async (_tx, query) =>
                String(query.diningSessionReference) === diningSessionReference &&
                String(query.guestSessionReference) === guestSessionReference &&
                JSON.stringify(await service.authorize({ ...credentials, observedAt: now() })) ===
                  fingerprint,
            }).load(transaction, {
              diningSessionReference,
              guestSessionReference,
              observedAt: now(),
            });
            return tableOrder === orderReference;
          }),
        );
      } catch (error) {
        if (error instanceof OrderStatusProjectionError || error instanceof GuestSessionError)
          return false;
        throw withFailureCause(
          new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"),
          error,
        );
      }
    },
  });
}

/** WP-2423: an Order this guest placed whose status page is still being prepared. */
export interface CustomerOrderReceived {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly submittedAt: string;
  readonly checkedAt: string;
}

/**
 * WP-2423 (v15 8c4480dd M1): whether this guest's own dining session's dine-in Order is the given
 * Order (Ordering's order header for that session; one Order per session). A guest at the table
 * then reads the table's Order and its receipt like the guest who placed its first round; an Order
 * of any other table, party or Store is never matched.
 */
export async function isGuestTableOrder(
  transaction: ConsumerTransaction,
  input: {
    readonly scope: { readonly brandReference: string; readonly storeReference: string };
    readonly guest: {
      readonly channel: string;
      readonly diningSessionReference: string | null;
      readonly sessionReference: string;
    };
    readonly orderReference: string;
    now(): string;
    stillAuthorized(): Promise<boolean>;
  },
): Promise<boolean> {
  const { guest } = input;
  if (guest.channel !== "DineIn" || guest.diningSessionReference === null) return false;
  const diningSessionReference = String(guest.diningSessionReference);
  const guestSessionReference = String(guest.sessionReference);
  const order = await createPostgresDiningSessionOrderLookup({
    ...input.scope,
    authorize: async (_tx, query) =>
      String(query.diningSessionReference) === diningSessionReference &&
      String(query.guestSessionReference) === guestSessionReference &&
      (await input.stillAuthorized()),
  }).load(transaction, {
    diningSessionReference,
    guestSessionReference,
    observedAt: input.now(),
  });
  return order === input.orderReference;
}

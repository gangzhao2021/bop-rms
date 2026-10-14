import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { createPostgresKitchenCustomerStatusReader } from "@rms/kitchen";
import {
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
  createOrderStatusQueryService,
  createPostgresStaffItemCancellationReader,
  createPostgresStaffOrderCancellationReader,
  listStoreDiningBatchPaymentDeadlines,
  listStoreUnpaidBatchCancellations,
  loadPickupPaymentWindowClosure,
  createPostgresOrderStatusProjectionStore,
  OrderStatusProjectionError,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
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
      try {
        return await options.transactions.run(async (transaction) => {
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
          const query = createOrderStatusQueryService({
            authorization: {
              authorizeCustomer: async (input) =>
                input.orderReference === orderReference && (await stillAuthorized())
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
          });
          const result = await query.getCustomer({ orderReference, observedAt: now() });
          let dining: null | {
            items: {
              orderItemReference: string;
              orderBatchReference: string;
              servedQuantity: number;
            }[];
          } = null;
          if (result.order.orderType === "DineIn" && options.diningScope !== undefined) {
            if (guest.channel !== "DineIn" || guest.diningSessionReference === null)
              throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
            const delivery = await createDiningOrderDeliveryProgress({
              ...options.scope,
              diningScope: options.diningScope,
              authorize: async () => stillAuthorized(),
              authorizeKitchen: async () => stillAuthorized(),
              authorizeDining: async () => stillAuthorized(),
            }).load({
              transaction,
              ...options.scope,
              orderReference,
              diningSessionReference: String(guest.diningSessionReference),
              guestSessionReference: String(guest.sessionReference),
              observedAt: now(),
            });
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
              for (const fact of await listOrderPaymentTerminalOutcomes(
                transaction,
                options.paymentScope,
                orderReference,
              ))
                if (!projected.has(fact.paymentIntentReference))
                  payments.push({
                    status: fact.outcome,
                    occurredAt: fact.occurredAt,
                    amount: fact.amount,
                    freshnessStatus: "Fresh",
                  });
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
          // WP-2423: a dine-in round whose payment failed is cancelled automatically when its payment
          // window ends; the customer is told when before it happens, and that it was not charged.
          let batchPayments: readonly CustomerBatchPayment[] = [];
          const unpaidCancellations: { orderBatchReference: string; cancelledAt: string }[] = [];
          if (result.order.orderType === "DineIn" && (await stillAuthorized())) {
            for (const entry of await listStoreUnpaidBatchCancellations(
              transaction,
              options.scope,
              [orderReference],
            ))
              unpaidCancellations.push({
                orderBatchReference: entry.orderBatchReference,
                cancelledAt: entry.cancelledAt,
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
              ...(batchPayments.length === 0 ? {} : { batchPayments }),
              ...(unpaidCancellations.length === 0 ? {} : { unpaidCancellations }),
              ...(storeContact === null ? {} : { storeContact }),
            },
          };
        });
      } catch (error) {
        if (error instanceof OrderStatusProjectionError) throw error;
        if (error instanceof GuestSessionError)
          throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
        throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

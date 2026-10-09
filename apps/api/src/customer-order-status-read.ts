import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { createPostgresKitchenCustomerStatusReader } from "@rms/kitchen";
import { createPostgresPaymentStatusStore } from "@rms/payment";
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
  createPostgresOrderStatusProjectionStore,
  OrderStatusProjectionError,
  parseOrderingReference,
  type CartQueryTransactionRunner,
} from "@rms/ordering";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";

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
          let payments = null;
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
          }
          // WP-2423: a pickup the Store closed as not collected (Fulfillment's fact).
          const pickup =
            result.order.orderType === "Pickup" && (await stillAuthorized())
              ? await loadPickupNotCollected(transaction, options.scope, orderReference)
              : undefined;
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

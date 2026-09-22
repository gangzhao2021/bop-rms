import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningSessionOrderInventory,
  createPostgresMerchantOrderIndex,
  createPostgresOrderClosurePosition,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import { createPostgresOrderSettledFinalityStore } from "@rms/payment";
import { createDiningOrderClosureInputs } from "./dining-order-closure-inputs.js";
type Options = Parameters<typeof createDiningOrderClosureInputs>[0];
interface Query {
  diningSessionReference: string;
  observedAt: string;
}
const fail = (): never => {
  throw new Error("DINING_SESSION_CLOSURE_INPUTS_UNAVAILABLE");
};
/** Caller holds Dining admission fence through outer transaction. These are owner
 * facts, not Finalize authorization: historical finality and fresh balances stay separate. */
export function createDiningSessionClosureInputs(
  options: Options & {
    authorizeAndFence(tx: ConsumerTransaction, query: Query): Promise<boolean>;
  },
) {
  return {
    async load(tx: ConsumerTransaction, input: Query) {
      try {
        const query = {
          diningSessionReference: String(parseOrderingReference(input.diningSessionReference)),
          observedAt: String(parseOrderingInstant(input.observedAt)),
        };
        const authorize = () => options.authorizeAndFence(tx, query);
        if ((await authorize()) !== true) return fail();
        const inventory = await createPostgresDiningSessionOrderInventory({
          ...options,
          authorizeAndFence: authorize,
        }).load(tx, query);
        if (
          inventory.brandReference !== options.brandReference ||
          inventory.storeReference !== options.storeReference ||
          inventory.diningSessionReference !== query.diningSessionReference ||
          inventory.observedAt !== query.observedAt
        )
          return fail();
        const seen = new Set<string>();
        const orders = [];
        for (const entry of inventory.orders) {
          if (seen.has(entry.orderReference)) return fail();
          seen.add(entry.orderReference);
          const binding = await createPostgresMerchantOrderIndex({ ...options, authorize }).find({
            transaction: tx,
            orderReference: entry.orderReference,
          });
          if (
            !binding ||
            binding.orderReference !== entry.orderReference ||
            binding.orderType !== "DineIn" ||
            binding.diningSessionReference !== query.diningSessionReference
          )
            return fail();
          const orderQuery = { orderReference: entry.orderReference, observedAt: query.observedAt };
          const closure = await createPostgresOrderClosurePosition({
            ...options.diningScope,
            authorize,
          })(tx, orderQuery);
          const current = await createDiningOrderClosureInputs(options).load({
            transaction: tx,
            ...options.diningScope,
            ...query,
            orderReference: entry.orderReference,
            guestSessionReference: binding.guestSessionReference,
          });
          if (
            !current ||
            closure.orderVersion !== current.execution.orderVersion ||
            closure.orderCheckpoint !== current.execution.revisionCheckpoint
          )
            return fail();
          const batches = new Set(
            current.execution.items.map((item) => String(item.orderBatchReference)),
          );
          if (
            batches.size !== entry.batches.length ||
            entry.batches.some((batch) => !batches.has(batch.orderBatchReference))
          )
            return fail();
          const finality =
            closure.financialFinalityReference === null
              ? null
              : await createPostgresOrderSettledFinalityStore({
                  scope: options.diningScope,
                  providerAccountReference: options.paymentScope.providerAccountReference,
                  environment: options.paymentScope.environment,
                  authorize,
                  audit: async () => fail(),
                }).readFinality(tx, {
                  ...orderQuery,
                  finalityReference: closure.financialFinalityReference,
                  expectedOrderVersion: closure.orderVersion,
                });
          if (
            closure.status === "Closed" &&
            (!finality || String(finality.orderCheckpoint) !== String(closure.orderCheckpoint))
          )
            return fail();
          orders.push(
            Object.freeze({ inventory: entry, closure, current, historicalFinality: finality }),
          );
        }
        if ((await authorize()) !== true) return fail();
        return Object.freeze({ ...query, ...options.diningScope, orders: Object.freeze(orders) });
      } catch {
        return fail();
      }
    },
  };
}

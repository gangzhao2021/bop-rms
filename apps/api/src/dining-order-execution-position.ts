import { createHash } from "node:crypto";
import {
  createPostgresOrderRevisionPosition,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
const fail = (): never => {
  throw new Error("DINING_ORDER_EXECUTION_POSITION_UNAVAILABLE");
};
type Options = Parameters<typeof createDiningOrderDeliveryProgress>[0];
type Input = Parameters<ReturnType<typeof createDiningOrderDeliveryProgress>["load"]>[0];
/** Current active Dining execution facts. Retain Order→Kitchen→Dining fences.
 * Missing Kitchen evidence is explicit; no cancellation/financial/close permission. */
export function createDiningOrderExecutionPosition(options: Options) {
  const brand = String(parseOrderingReference(options.brandReference)),
    store = String(parseOrderingReference(options.storeReference));
  const delivery = createDiningOrderDeliveryProgress(options);
  return Object.freeze({
    async load(input: Input) {
      try {
        const order = String(parseOrderingReference(input.orderReference)),
          at = String(parseOrderingInstant(input.observedAt));
        const revision = await createPostgresOrderRevisionPosition({
          brandReference: brand,
          storeReference: store,
          authorize: (tx) => options.authorize(tx, input),
        })(input.transaction, { orderReference: order, observedAt: at });
        if (revision.terminalOperation !== null) return null;
        const progress = await delivery.load(input);
        if (!progress) return fail();
        if (
          progress.brandReference !== brand ||
          progress.storeReference !== store ||
          progress.orderReference !== order ||
          progress.observedAt !== at ||
          progress.orderVersion !== revision.version ||
          typeof progress.kitchenEvidenceComplete !== "boolean"
        )
          return fail();
        const batches = new Set(progress.items.map((item) => item.orderBatchReference));
        if (
          batches.size !== revision.batchReferences.length ||
          revision.batchReferences.some((batch) => !batches.has(batch))
        )
          return fail();
        const items = Object.freeze(progress.items.map((item) => Object.freeze({ ...item })));
        if ((await options.authorize(input.transaction, input)) !== true) return fail();
        return Object.freeze({
          ...progress,
          items,
          revisionCheckpoint: revision.checkpoint,
          revisionDigest: revision.snapshotDigest,
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify(
                  [
                    revision.snapshotDigest,
                    progress.phase,
                    progress.kitchenEvidenceComplete,
                    items,
                  ],
                  (_key, value) => (typeof value === "bigint" ? value.toString() : value),
                ),
              )
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}

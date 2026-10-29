import {
  createPostgresDiningOrderItemStateReader,
  summarizeOrderItemProgress,
} from "@rms/ordering";
import {
  createPostgresKitchenCustomerStatusReader,
  listKitchenNotPreparedOrderItems,
} from "@rms/kitchen";

type OrderOptions = Parameters<typeof createPostgresDiningOrderItemStateReader>[0];
type KitchenOptions = Parameters<typeof createPostgresKitchenCustomerStatusReader>[0];
type Input = Parameters<ReturnType<typeof createPostgresDiningOrderItemStateReader>["load"]>[0];

/** Preparation progress only; serving/closure must be resolved separately.
 * Retain Ordering then Kitchen fences in this caller-owned transaction.
 */
export function createDiningOrderPreparationProgress(
  options: OrderOptions & {
    authorizeKitchen: KitchenOptions["authorize"];
  },
) {
  const ordering = createPostgresDiningOrderItemStateReader(options);
  const kitchen = createPostgresKitchenCustomerStatusReader({
    brandReference: options.brandReference,
    storeReference: options.storeReference,
    authorize: options.authorizeKitchen,
  });
  return Object.freeze({
    async load(input: Input) {
      const order = await ordering.load(input);
      if (!order) return null;
      const work = await kitchen.loadByOrder({
        transaction: input.transaction,
        orderReference: order.orderReference,
      });
      // WP-2423 item 8 ⑦ (decision 2): dishes the kitchen did not prepare (decided as each round
      // reached it) are ready, and served, once ordered; they need no kitchen work.
      const notPrepared = await listKitchenNotPreparedOrderItems(
        input.transaction as unknown as Parameters<typeof listKitchenNotPreparedOrderItems>[0],
        { brandReference: options.brandReference, storeReference: options.storeReference },
        String(order.orderReference),
      );
      const membership = new Map(order.items.map((item) => [item.orderItemReference, item]));
      const progress = new Map<string, "Queued" | "InProgress" | "Ready">();
      const kitchenCancelled = new Set<string>();
      for (const batch of work?.batches ?? []) {
        if (batch.updatedAt > input.observedAt) throw new Error("ORDER_PROGRESS_UNAVAILABLE");
        for (const item of batch.items) {
          const member = membership.get(item.orderItemReference);
          if (
            !member ||
            member.orderBatchReference !== batch.orderBatchReference ||
            !member.acceptance ||
            member.cancellation ||
            progress.has(item.orderItemReference) ||
            kitchenCancelled.has(item.orderItemReference) ||
            // WP-2423 Q6: kitchen work is Cancelled exactly when staff cancelled its batch or line.
            (item.status === "Cancelled") !==
              Boolean(member.staffCancellation || member.itemStaffCancellation)
          )
            throw new Error("ORDER_PROGRESS_UNAVAILABLE");
          if (item.status === "Cancelled") kitchenCancelled.add(item.orderItemReference);
          else progress.set(item.orderItemReference, item.status);
        }
      }
      const items = order.items.map((item) => {
        const current =
          item.acceptance !== null && notPrepared.has(String(item.orderItemReference))
            ? ("Ready" as const)
            : progress.get(item.orderItemReference);
        return Object.freeze({
          orderItemReference: item.orderItemReference,
          orderBatchReference: item.orderBatchReference,
          orderedQuantity: item.orderedQuantity,
          phase:
            item.cancellation || item.staffCancellation || item.itemStaffCancellation
              ? ("Cancelled" as const)
              : current === "Ready"
                ? ("Ready" as const)
                : current === "InProgress"
                  ? ("InProgress" as const)
                  : item.acceptance
                    ? ("Accepted" as const)
                    : ("Submitted" as const),
          everAccepted: item.acceptance !== null,
          everStarted: current === "Ready" || current === "InProgress",
        });
      });
      if (
        (await options.authorize(input.transaction, input)) !== true ||
        (await options.authorizeKitchen(input.transaction, order)) !== true
      )
        throw new Error("ORDER_PROGRESS_UNAVAILABLE");
      const summary = summarizeOrderItemProgress(items);
      return Object.freeze({
        brandReference: order.brandReference,
        storeReference: order.storeReference,
        orderReference: order.orderReference,
        orderVersion: order.orderVersion,
        orderCheckpoint: order.orderCheckpoint,
        preparationPhase: summary.phase,
        // A staff-cancelled batch needs no kitchen progress (it never started, or never reached it).
        kitchenEvidenceComplete: order.items.every(
          (item) =>
            item.acceptance === null ||
            Boolean(item.staffCancellation || item.itemStaffCancellation) ||
            progress.has(item.orderItemReference) ||
            notPrepared.has(String(item.orderItemReference)),
        ),
        // The items no one serves: counted as served once ordered (delivery progress).
        notPreparedItems: Object.freeze(
          order.items
            .filter(
              (item) =>
                item.acceptance !== null && notPrepared.has(String(item.orderItemReference)),
            )
            .map((item) => String(item.orderItemReference)),
        ),
        items: Object.freeze(items),
        observedAt: input.observedAt,
      });
    },
  });
}

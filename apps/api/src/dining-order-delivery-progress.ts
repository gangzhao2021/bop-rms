import { createPostgresDiningItemServiceReader } from "@rms/dining";
import { resolveOrderItemDeliveryProgress, summarizeOrderItemProgress } from "@rms/ordering";
import { createDiningOrderPreparationProgress } from "./dining-order-preparation-progress.js";

type PreparationOptions = Parameters<typeof createDiningOrderPreparationProgress>[0];
type ServiceOptions = Parameters<typeof createPostgresDiningItemServiceReader>[0];
type Input = Parameters<ReturnType<typeof createDiningOrderPreparationProgress>["load"]>[0];

/** Public owner composition: Ordering -> Kitchen -> Dining locks, retained by caller.
 * Derived delivery progress is not payment settlement or permission to close.
 */
export function createDiningOrderDeliveryProgress(
  options: PreparationOptions & {
    diningScope: ServiceOptions["scope"];
    authorizeDining: ServiceOptions["authorize"];
  },
) {
  if (
    options.diningScope.brandReference !== options.brandReference ||
    options.diningScope.storeReference !== options.storeReference
  )
    throw new Error("ORDER_DELIVERY_PROGRESS_UNAVAILABLE");
  const preparation = createDiningOrderPreparationProgress(options);
  const service = createPostgresDiningItemServiceReader({
    scope: options.diningScope,
    authorize: options.authorizeDining,
  });
  return Object.freeze({
    async load(input: Input) {
      const current = await preparation.load(input);
      if (!current) return null;
      const items = [];
      for (const item of current.items) {
        const delivered = await service.load({
          transaction: input.transaction,
          diningSessionReference: input.diningSessionReference,
          orderReference: current.orderReference,
          orderBatchReference: item.orderBatchReference,
          orderItemReference: item.orderItemReference,
          observedAt: input.observedAt,
        });
        const progress = resolveOrderItemDeliveryProgress({
          ...item,
          deliveredQuantity: delivered.servedQuantity,
        });
        items.push(
          Object.freeze({
            ...progress,
            orderBatchReference: item.orderBatchReference,
            itemServiceVersion: delivered.itemServiceVersion,
          }),
        );
      }
      if (
        (await options.authorize(input.transaction, input)) !== true ||
        (await options.authorizeKitchen(input.transaction, current)) !== true
      )
        throw new Error("ORDER_DELIVERY_PROGRESS_UNAVAILABLE");
      const summary = summarizeOrderItemProgress(items);
      return Object.freeze({
        brandReference: current.brandReference,
        storeReference: current.storeReference,
        orderReference: current.orderReference,
        orderVersion: current.orderVersion,
        orderCheckpoint: current.orderCheckpoint,
        phase: summary.phase,
        kitchenEvidenceComplete: current.kitchenEvidenceComplete,
        everAccepted: summary.everAccepted,
        everStarted: summary.everStarted,
        items: Object.freeze(items),
        observedAt: input.observedAt,
      });
    },
  });
}

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
          // WP-2423 item 8 ⑦: a dish the kitchen does not prepare is served once ordered.
          deliveredQuantity:
            item.phase !== "Cancelled" &&
            current.notPreparedItems.includes(String(item.orderItemReference))
              ? item.orderedQuantity
              : delivered.servedQuantity,
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

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: the served facts Ordering's phase merge takes for a dine-in
 * Order — the items whose whole ordered quantity Dining recorded as served. Dining publishes no
 * events, so this composition (holding both public sources) hands them to
 * `loadOrderCanonicalPhase`; a partly served or cancelled item is not listed.
 */
export function servedOrderItemFacts(
  items: readonly { readonly orderItemReference: string; readonly remainingQuantity: number }[],
): { readonly servedItems: readonly string[] } {
  return Object.freeze({
    servedItems: Object.freeze(
      items.filter((item) => item.remainingQuantity === 0).map((item) => item.orderItemReference),
    ),
  });
}

/**
 * WP-2423: items (quantities) the kitchen marked ready and nobody has served yet — waiting at the
 * pass. A partly served item stays Ready; cancelled items never count. The one rule the Tables
 * page (closing a table) and the Home's "ready to serve" both use. WP-2423 (2026-10-18): portions
 * the kitchen is remaking (open remakes by Order item, Kitchen's public Query) are not ready to
 * serve, as on the serving page.
 */
export function readyToServeQuantity(
  items: readonly {
    readonly phase: string;
    readonly remainingQuantity: number;
    readonly orderItemReference?: string;
  }[],
  remaking: ReadonlyMap<string, number> = new Map(),
): number {
  return items
    .filter((item) => item.phase === "Ready" && item.remainingQuantity > 0)
    .reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          item.remainingQuantity -
            (item.orderItemReference === undefined
              ? 0
              : (remaking.get(item.orderItemReference) ?? 0)),
        ),
      0,
    );
}

/** WP-2423 (2026-10-18): portions of an Order's items the kitchen is remaking (cancelled excluded). */
export function remakingQuantity(
  items: readonly {
    readonly phase: string;
    readonly orderedQuantity: number;
    readonly orderItemReference: string;
  }[],
  remaking: ReadonlyMap<string, number>,
): number {
  return items.reduce((sum, item) => {
    const open = remaking.get(item.orderItemReference);
    return item.phase === "Cancelled" || open === undefined
      ? sum
      : sum + Math.min(open, item.orderedQuantity);
  }, 0);
}

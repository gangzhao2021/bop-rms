import {
  parsePickupExecution,
  parsePickupQueueView,
  parsePickupReference,
  PickupClientError,
  type PickupClient,
} from "./pickup.js";
function fail(): never {
  throw new PickupClientError("Unavailable");
}
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  return value as Record<string, unknown>;
}
/** One current Store page per request; no automatic replay or browser storage. */
export function createPickupClient(options: {
  csrf: string;
  storeReference: string;
  storeLabel: string;
  fetcher?: typeof fetch;
}): PickupClient {
  const fetcher = options.fetcher ?? fetch;
  return {
    async loadQueue(input = { afterFulfillmentReference: null, includeCompleted: false }) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(options.csrf)) return fail();
      const after =
        input.afterFulfillmentReference === null
          ? null
          : parsePickupReference(input.afterFulfillmentReference);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetcher("/merchant/pickup/query", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": options.csrf,
          },
          body: JSON.stringify({
            afterFulfillmentReference: after,
            limit: 50,
            includeCompleted: input.includeCompleted,
          }),
        });
        if (response.status === 401 || response.status === 403)
          throw new PickupClientError("PermissionDenied");
        if (response.status === 404) throw new PickupClientError("NotFound");
        if (response.status === 409) throw new PickupClientError("Conflict");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.startsWith("application/json")
        )
          return fail();
        const text = await response.text();
        if (controller.signal.aborted || text.length > 1048576) return fail();
        const result = record(JSON.parse(text));
        if (
          result.source !== "CurrentFulfillment" ||
          result.storeReference !== options.storeReference ||
          !Array.isArray(result.items) ||
          result.items.length > 50 ||
          !("nextAfterFulfillmentReference" in result)
        )
          return fail();
        parsePickupReference(result.storeReference);
        const view = parsePickupQueueView({
          screenId: "FUL-PICKUP-QUEUE",
          projectionName: "fulfillment_pickup_queue_v1",
          projectionVersion: 1,
          storeLabel: options.storeLabel,
          projectedAt: result.observedAt,
          freshnessStatus: "Fresh",
          workstation: result.workstation ?? null,
          nextAfterFulfillmentReference: result.nextAfterFulfillmentReference,
          items: result.items.map((value) => {
            const raw = record(value);
            const execution = parsePickupExecution({
              aggregateVersion: raw.aggregateVersion,
              publicOrderReference: raw.publicOrderReference,
              proof: raw.proof,
              items: raw.items,
            });
            return {
              fulfillmentReference: raw.fulfillmentReference,
              orderReference: raw.orderReference,
              phase: raw.phase,
              readyAt: raw.readyAt,
              publicOrderNumber: null,
              proofReadiness:
                raw.phase === "Ready" &&
                execution.proof &&
                typeof result.observedAt === "string" &&
                Date.parse(execution.proof.expiresAt) > Date.parse(result.observedAt)
                  ? "Ready"
                  : "Unavailable",
              stagingLocation: null,
              claimStatus: "Unavailable",
              exceptionStatus: "Unavailable",
              packageCount: null,
              allergenCue: "Unavailable",
              execution,
            };
          }),
        });
        if (
          typeof view.nextAfterFulfillmentReference === "string" &&
          after !== null &&
          view.nextAfterFulfillmentReference <= after
        )
          return fail();
        return view;
      } catch (error) {
        if (error instanceof PickupClientError) throw error;
        if (error instanceof TypeError || controller.signal.aborted)
          throw new PickupClientError("Offline");
        return fail();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

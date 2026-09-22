import {
  parseKitchenRouteReference,
  parseKitchenWorkItemView,
  type KitchenBoardItem,
} from "./kitchen-board.js";
export type KitchenAction =
  | "AcceptKitchenWorkItem"
  | "StartKitchenWorkItem"
  | "CompleteKitchenWorkItem"
  | "MarkKitchenOrderItemReady";
export class KitchenWorkClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "PreconditionFailed"
      | "Invalid"
      | "OutcomeUnknown",
  ) {
    super("Kitchen action could not be confirmed");
    this.name = "KitchenWorkClientError";
  }
}
function fail(code: KitchenWorkClientError["code"]): never {
  throw new KitchenWorkClientError(code);
}
function version(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail("OutcomeUnknown");
  return value;
}
/** One immutable body per user intent; caller explicitly retries the SAME operation. */
export function createKitchenWorkClient(fetcher: typeof fetch = fetch) {
  return {
    prepare(input: {
      action: KitchenAction;
      storeReference: string;
      item: KitchenBoardItem;
      idempotencyKey: string;
      correlationReference: string;
    }) {
      const item = parseKitchenWorkItemView(input.item),
        execution = item.execution;
      if (
        !execution ||
        ![
          "AcceptKitchenWorkItem",
          "StartKitchenWorkItem",
          "CompleteKitchenWorkItem",
          "MarkKitchenOrderItemReady",
        ].includes(input.action)
      )
        return fail("Invalid");
      const action = input.action;
      const command = {
        authority: "CurrentMerchantSession",
        action,
        storeReference: parseKitchenRouteReference(input.storeReference),
        ticketReference: item.ticketReference,
        orderItemReference: execution.orderItemReference,
        expectedTicketVersion: execution.ticketVersion,
        idempotencyKey: parseKitchenRouteReference(input.idempotencyKey),
        correlationReference: parseKitchenRouteReference(input.correlationReference),
        ...(action === "MarkKitchenOrderItemReady"
          ? {
              workItems: [
                {
                  workItemReference: item.workItemReference,
                  expectedWorkItemVersion: execution.workItemVersion,
                },
              ],
            }
          : {
              workItemReference: item.workItemReference,
              expectedWorkItemVersion: execution.workItemVersion,
            }),
        ...(action === "CompleteKitchenWorkItem"
          ? { quantityDelta: item.requiredQuantity - item.completedQuantity }
          : {}),
      };
      if (action === "CompleteKitchenWorkItem" && item.requiredQuantity <= item.completedQuantity)
        return fail("Invalid");
      const body = JSON.stringify(command);
      return Object.freeze({
        async execute(csrf: string, signal?: AbortSignal) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted) return fail("Invalid");
          const controller = new AbortController(),
            abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(abort, 15000);
          try {
            const response = await fetcher("/merchant/kitchen/work", {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: controller.signal,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": csrf,
              },
              body,
            });
            if (controller.signal.aborted) return fail("OutcomeUnknown");
            if (response.status === 401 || response.status === 403) return fail("PermissionDenied");
            if (response.status === 404) return fail("NotFound");
            if (response.status === 409) return fail("Conflict");
            if (response.status === 422) return fail("PreconditionFailed");
            if (response.status === 400) return fail("Invalid");
            if (
              !response.ok ||
              response.headers.get("cache-control") !== "no-store" ||
              !response.headers.get("content-type")?.startsWith("application/json")
            )
              return fail("OutcomeUnknown");
            const text = await response.text();
            if (text.length > 16384) return fail("OutcomeUnknown");
            const result: unknown = JSON.parse(text);
            if (!result || typeof result !== "object" || Array.isArray(result))
              return fail("OutcomeUnknown");
            const raw = result as Record<string, unknown>;
            if (
              raw.action !== action ||
              raw.ticketReference !== item.ticketReference ||
              raw.workItemReference !== item.workItemReference ||
              raw.orderItemReference !== execution.orderItemReference ||
              raw.projectionName !== "kitchen_work_queue_v1" ||
              raw.projectionPending !== true
            )
              return fail("OutcomeUnknown");
            const ticketVersion = version(raw.ticketVersion),
              workItemVersion = version(raw.workItemVersion);
            if (
              BigInt(ticketVersion) <= BigInt(execution.ticketVersion) ||
              BigInt(workItemVersion) < BigInt(execution.workItemVersion) ||
              ![
                "Accepted",
                "Started",
                "ProgressRecorded",
                "Completed",
                "CompletedAndOrderItemReady",
                "OrderItemReady",
              ].includes(String(raw.outcome))
            )
              return fail("OutcomeUnknown");
            return Object.freeze({
              outcome: String(raw.outcome),
              ticketVersion,
              workItemVersion,
              projectionPending: true as const,
            });
          } catch (error) {
            if (error instanceof KitchenWorkClientError) throw error;
            return fail("OutcomeUnknown");
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  };
}

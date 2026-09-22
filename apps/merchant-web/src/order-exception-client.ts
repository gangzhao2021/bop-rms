import type { OrderExceptionClient } from "./OrderExceptionPage.js";

export function createOrderExceptionClient(fetcher: typeof fetch = fetch): OrderExceptionClient {
  return Object.freeze({
    async load(signal?: AbortSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetcher("/merchant/order-exceptions", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          throw new Error("ORDER_EXCEPTION_UNAVAILABLE");
        const text = await response.text();
        if (controller.signal.aborted || text.length > 262144)
          throw new Error("ORDER_EXCEPTION_UNAVAILABLE");
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("ORDER_EXCEPTION_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}

import type { OrderExceptionClient } from "./order-exception-view.js";

export function createOrderExceptionClient(fetcher: typeof fetch = fetch): OrderExceptionClient {
  return Object.freeze({
    async load(signal?: AbortSignal, resolvedBefore?: string) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 15000);
      try {
        if (
          resolvedBefore !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            resolvedBefore,
          )
        )
          throw new Error("ORDER_EXCEPTION_UNAVAILABLE");
        const path =
          resolvedBefore === undefined
            ? "/merchant/order-exceptions"
            : `/merchant/order-exceptions?resolvedBefore=${resolvedBefore}`;
        const response = await fetcher(path, {
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
        if (controller.signal.aborted || text.length > 1048576)
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

import {
  parseProductDraftBaselineView,
  ProductDraftBaselineClientError,
  type ProductDraftBaselineExpectedScope,
  type ProductDraftBaselineView,
} from "./catalog-product-draft-baseline.js";
import { productCommandRecord, parseCatalogReference } from "./catalog-product-command-values.js";
export class ProductDraftBaselineTransportClientError extends Error {
  constructor(readonly code: "Denied" | "FeatureDisabled" | "Stale" | "Unavailable" | "NotFound") {
    super("Product draft could not be read");
    this.name = "ProductDraftBaselineTransportClientError";
  }
}
const fail = (): never => {
  throw new ProductDraftBaselineTransportClientError("Unavailable");
};
function expectedScope(value: unknown): ProductDraftBaselineExpectedScope {
  try {
    const raw = productCommandRecord(value, [
      "brandReference",
      "storeReference",
      "productReference",
    ]);
    return Object.freeze({
      brandReference: parseCatalogReference(raw.brandReference),
      storeReference: parseCatalogReference(raw.storeReference),
      productReference: parseCatalogReference(raw.productReference),
    });
  } catch {
    return fail();
  }
}
export const productDraftBaselineMaximumResponseBytes = 8 * 1024 * 1024;
export function createProductDraftBaselineTransportClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      expected: ProductDraftBaselineExpectedScope,
      signal: AbortSignal,
    ): Promise<ProductDraftBaselineView> {
      const selected = expectedScope(expected),
        controller = new AbortController();
      const cancelled = () => new DOMException("Product draft read cancelled", "AbortError");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(
              signal.aborted
                ? cancelled()
                : new ProductDraftBaselineTransportClientError("Unavailable"),
            );
          if (controller.signal.aborted) {
            void promise.catch(() => undefined);
            interrupted();
            return;
          }
          controller.signal.addEventListener("abort", interrupted, { once: true });
          promise
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener("abort", interrupted))
            .catch(() => undefined);
        });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        finished = false;
      try {
        if (controller.signal.aborted) throw cancelled();
        const bytes = new TextEncoder().encode(
            JSON.stringify({ productReference: selected.productReference }),
          ),
          encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/u, "");
        const response = await guard(
          fetcher("/merchant/catalog/products/draft-baseline", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: { Accept: "application/json", "x-bop-product-draft-baseline": encoded },
          }),
        );
        if (
          response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !response.body ||
          response.redirected
        )
          return fail();
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(length) ||
            !Number.isSafeInteger(Number(length)) ||
            Number(length) > productDraftBaselineMaximumResponseBytes)
        )
          return fail();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let total = 0,
          body = "";
        while (true) {
          const chunk = await guard(reader.read());
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return fail();
          total += chunk.value.byteLength;
          if (total > productDraftBaselineMaximumResponseBytes) return fail();
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        finished = true;
        if (length !== null && Number(length) !== total) return fail();
        if (controller.signal.aborted) {
          if (signal.aborted) throw cancelled();
          return fail();
        }
        const raw: unknown = JSON.parse(body);
        if (!response.ok) {
          const error = productCommandRecord(raw, ["error"]).error;
          if (
            (response.status === 401 || response.status === 403) &&
            (error === "request_denied" || error === "product_draft_baseline_denied")
          )
            throw new ProductDraftBaselineTransportClientError("Denied");
          if (response.status === 409 && error === "product_draft_baseline_feature_disabled")
            throw new ProductDraftBaselineTransportClientError("FeatureDisabled");
          if (response.status === 409 && error === "product_draft_baseline_stale")
            throw new ProductDraftBaselineTransportClientError("Stale");
          return fail();
        }
        if (response.status !== 200) return fail();
        const envelope = productCommandRecord(raw, ["scope", "baseline"]),
          scope = productCommandRecord(envelope.scope, ["brandReference", "storeReference"]);
        if (
          scope.brandReference !== selected.brandReference ||
          scope.storeReference !== selected.storeReference
        )
          return fail();
        if (envelope.baseline === null)
          throw new ProductDraftBaselineTransportClientError("NotFound");
        return parseProductDraftBaselineView(raw, selected, now());
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductDraftBaselineTransportClientError) throw error;
        if (error instanceof ProductDraftBaselineClientError)
          throw new ProductDraftBaselineTransportClientError(error.code);
        return fail();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (reader) {
          try {
            if (!finished) void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          } catch {
            // Cleanup must not replace the bounded transport error.
          }
        }
        controller.abort();
      }
    },
  });
}
export type ProductDraftBaselineTransportClient = ReturnType<
  typeof createProductDraftBaselineTransportClient
>;

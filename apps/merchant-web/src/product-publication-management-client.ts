import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  parseProductPublicationPeriod,
  parseProductPublicationScopes,
} from "./product-publication-command-client.js";
import {
  parseProductScopeJournalRequest,
  type ProductScopeJournalRequest,
} from "./product-scope-journal-client.js";
export interface ProductPublicationManagementRequest extends ProductScopeJournalRequest {
  readonly tenantReference: string;
}
export class ProductPublicationManagementClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Stale" | "ScopeChanged" | "Invalid") {
    super("Current Product publication management could not be loaded");
    this.name = "ProductPublicationManagementClientError";
  }
}
const fail = (code: ProductPublicationManagementClientError["code"] = "Unavailable"): never => {
  throw new ProductPublicationManagementClientError(code);
};
export const productPublicationManagementMaximumResponseBytes = 2 * 1024 * 1024;
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 2147483647)
    return fail();
  return value as number;
}
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
function parseManagementRequest(value: unknown): ProductPublicationManagementRequest {
  try {
    const r = record(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
      "expectedAggregateVersion",
    ]);
    const { tenantReference, ...request } = r;
    return Object.freeze({
      ...parseProductScopeJournalRequest(request),
      tenantReference: ref(tenantReference),
    });
  } catch {
    return fail("Invalid");
  }
}
function copy(value: unknown): unknown {
  let budget = 100000;
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
      return v;
    if (typeof v === "string") return v.length <= 4096 ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 10000 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return fail();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return fail();
            return visit(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 128)
        return fail();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((key) => {
            const d = Object.getOwnPropertyDescriptor(v, key);
            if (typeof key !== "string" || !d?.enumerable || !("value" in d)) return fail();
            return [key, visit(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  return visit(value, 0);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
/** Parses the recorded owning projection only, never current qualification. */
export async function parseProductPublicationManagementView(
  value: unknown,
  expected: ProductPublicationManagementRequest,
  now: () => number = Date.now,
) {
  try {
    const request = parseManagementRequest(expected),
      safe = copy(value),
      raw = record(safe, [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "productReference",
        "aggregateVersion",
        "observedAt",
        "validUntil",
        "coverage",
        "eligibility",
        "publishValidation",
        "draft",
        "versions",
        "digest",
      ]);
    if (
      new TextEncoder().encode(JSON.stringify(safe)).byteLength >
      productPublicationManagementMaximumResponseBytes
    )
      return fail();
    if (
      raw.profile !== "CatalogProductPublicationManagementV1" ||
      raw.coverage !== "CompleteRecordedPublicationManagement" ||
      raw.eligibility !== "NotEvaluated" ||
      raw.publishValidation !== "Incomplete"
    )
      return fail();
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "productReference",
    ] as const) {
      ref(raw[key]);
      if (raw[key] !== request[key]) return fail("ScopeChanged");
    }
    integer(raw.aggregateVersion, 1);
    if (raw.aggregateVersion !== request.expectedAggregateVersion) return fail("Stale");
    const observedAt = instant(raw.observedAt),
      validUntil = instant(raw.validUntil);
    const first = now();
    const freshness = () => {
      const at = now();
      if (
        !Number.isFinite(first) ||
        !Number.isFinite(at) ||
        at < first ||
        Date.parse(validUntil) <= Date.parse(observedAt) ||
        Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
        at < Date.parse(observedAt) ||
        at >= Date.parse(validUntil)
      )
        return fail("Stale");
    };
    freshness();
    const { digest, ...body } = raw;
    hash(digest);
    const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(body)));
    const actual =
      "sha256:" +
      Array.from(new Uint8Array(hashed), (b) => b.toString(16).padStart(2, "0")).join("");
    if (actual !== digest) return fail();
    const d = record(raw.draft, [
      "versionReference",
      "contentDigest",
      "configurationDigest",
      "contentStatus",
    ]);
    if (d.contentStatus !== "Present" && d.contentStatus !== "Unavailable") return fail();
    const draft = Object.freeze({
      versionReference: ref(d.versionReference),
      contentDigest: hash(d.contentDigest),
      configurationDigest: hash(d.configurationDigest),
      contentStatus: d.contentStatus,
    });
    if (!Array.isArray(raw.versions) || raw.versions.length > 1000) return fail();
    const versions = raw.versions.map((value) => {
      const v = record(value, [
        "versionReference",
        "publicationVersion",
        "state",
        "contentDigest",
        "configurationDigest",
        "scopeSet",
        "effectivePeriod",
        "scheduleReference",
        "scheduleVersion",
        "recordedAt",
      ]);
      if (
        !["Draft", "InReview", "Approved", "Scheduled", "Published", "Superseded"].includes(
          String(v.state),
        ) ||
        typeof v.state !== "string"
      )
        return fail();
      const scopeSet = parseProductPublicationScopes(v.scopeSet),
        effectivePeriod = parseProductPublicationPeriod(v.effectivePeriod);
      if (
        canonical(scopeSet) !== canonical(v.scopeSet) ||
        canonical(effectivePeriod) !== canonical(v.effectivePeriod)
      )
        return fail();
      const scheduleReference = v.scheduleReference === null ? null : ref(v.scheduleReference),
        scheduleVersion = integer(v.scheduleVersion),
        recordedAt = instant(v.recordedAt);
      if (
        (scheduleReference === null) !== (scheduleVersion === 0) ||
        (v.state === "Scheduled" && scheduleReference === null) ||
        recordedAt > observedAt
      )
        return fail();
      return Object.freeze({
        versionReference: ref(v.versionReference),
        publicationVersion: integer(v.publicationVersion, 1),
        state: v.state as
          "Draft" | "InReview" | "Approved" | "Scheduled" | "Published" | "Superseded",
        contentDigest: hash(v.contentDigest),
        configurationDigest: hash(v.configurationDigest),
        scopeSet,
        effectivePeriod,
        scheduleReference,
        scheduleVersion,
        recordedAt,
      });
    });
    if (new Set(versions.map((v) => v.versionReference)).size !== versions.length) return fail();
    freshness();
    return Object.freeze({
      tenantReference: request.tenantReference,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
      productReference: request.productReference,
      revision: request.expectedAggregateVersion,
      observedAt,
      validUntil,
      coverage: "CompleteRecordedPublicationManagement" as const,
      eligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
      draft,
      versions: Object.freeze(versions),
    });
  } catch (error) {
    if (error instanceof ProductPublicationManagementClientError) throw error;
    return fail();
  }
}
export type ProductPublicationManagementView = Awaited<
  ReturnType<typeof parseProductPublicationManagementView>
>;
export function createProductPublicationManagementClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      input: { request: ProductPublicationManagementRequest; csrf: string },
      signal: AbortSignal,
    ): Promise<ProductPublicationManagementView> {
      const selected = parseManagementRequest(input.request),
        controller = new AbortController();
      if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))
        return fail("Invalid");
      const cancelled = () =>
        new DOMException("Product publication management read cancelled", "AbortError");
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
                : new ProductPublicationManagementClientError("Unavailable"),
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
            JSON.stringify({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            }),
          ),
          encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/u, "");
        const response = await guard(
          fetcher("/merchant/catalog/products/publication/management", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "x-bop-csrf": input.csrf,
              "x-bop-catalog-scope": encoded,
            },
            body: JSON.stringify({
              productReference: selected.productReference,
              expectedAggregateVersion: selected.expectedAggregateVersion,
            }),
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
            Number(length) > productPublicationManagementMaximumResponseBytes)
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
          if (total > productPublicationManagementMaximumResponseBytes) return fail();
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
          const error = record(raw, ["error"]).error;
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (response.status === 400 && error === "product_publication_management_invalid")
            return fail("Invalid");
          return fail();
        }
        if (response.status !== 200) return fail();
        const parsed = await guard(parseProductPublicationManagementView(raw, selected, now));
        if (controller.signal.aborted) throw cancelled();
        return parsed;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductPublicationManagementClientError) throw error;

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

export type ProductPublicationManagementClient = ReturnType<
  typeof createProductPublicationManagementClient
>;

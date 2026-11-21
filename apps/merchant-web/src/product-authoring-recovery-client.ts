import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";
export type ProductAuthoringAction = "Create" | "ReplaceDraft";
export interface ProductAuthoringRecoveryScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly action: ProductAuthoringAction;
  readonly productReference: string | null;
}
export interface ProductAuthoringCursor {
  readonly profile: "CatalogProductAuthoringCursorV1";
  readonly scope: ProductAuthoringRecoveryScope;
  readonly operationReference: string;
  readonly expectedAggregateVersion: number | null;
}
export class ProductAuthoringRecoveryError extends Error {
  constructor(
    readonly code:
      "Denied" | "Unavailable" | "Invalid" | "ScopeChanged" | "Stale" | "PendingOriginal",
  ) {
    super("Original Product request recovery is unavailable");
  }
}
const fail = (code: ProductAuthoringRecoveryError["code"] = "Unavailable"): never => {
  throw new ProductAuthoringRecoveryError(code);
};
function version(v: unknown) {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) return fail();
  return v as number;
}
export function parseProductAuthoringCursor(
  value: unknown,
  expected: ProductAuthoringRecoveryScope,
): ProductAuthoringCursor {
  const raw = record(copyProductCommandValue(value), [
      "profile",
      "scope",
      "operationReference",
      "expectedAggregateVersion",
    ]),
    scope = record(raw.scope, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "action",
      "productReference",
    ]);
  if (
    raw.profile !== "CatalogProductAuthoringCursorV1" ||
    JSON.stringify(scope) !== JSON.stringify(expected)
  ) {
    // Property order is not part of the cursor identity.
    if (
      raw.profile !== "CatalogProductAuthoringCursorV1" ||
      Object.keys(scope).some(
        (key) => scope[key] !== expected[key as keyof ProductAuthoringRecoveryScope],
      )
    )
      return fail("ScopeChanged");
  }
  for (const field of [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ] as const)
    ref(scope[field]);
  if (scope.action !== "Create" && scope.action !== "ReplaceDraft") return fail();
  if (
    scope.action === "Create" &&
    (scope.productReference !== null || raw.expectedAggregateVersion !== null)
  )
    return fail();
  if (scope.action === "ReplaceDraft") {
    ref(scope.productReference);
    version(raw.expectedAggregateVersion);
  }
  return Object.freeze({
    profile: "CatalogProductAuthoringCursorV1",
    scope: Object.freeze({ ...expected }),
    operationReference: ref(raw.operationReference),
    expectedAggregateVersion:
      scope.action === "Create" ? null : version(raw.expectedAggregateVersion),
  });
}
export interface ProductAuthoringResolutionView {
  readonly outcome: "Committed" | "Abandoned";
  readonly productReference: string | null;
  readonly versionReference: string | null;
  readonly aggregateVersion: number | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function createProductAuthoringRecoveryClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  async function post(
    path: string,
    body: unknown,
    scope: { readonly brandReference: string; readonly storeReference: string },
    csrf: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const selected = {
      brandReference: ref(scope.brandReference),
      storeReference: ref(scope.storeReference),
    };
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail("Invalid");
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const interrupted = () => rejectAbort?.(new ProductAuthoringRecoveryError("Unavailable"));
    controller.signal.addEventListener("abort", interrupted, { once: true });
    const timer = setTimeout(abort, 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (controller.signal.aborted) return fail();
      const response = await Promise.race([
        fetcher(path, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-bop-csrf": csrf,
            "x-bop-catalog-scope": btoa(JSON.stringify(selected))
              .replace(/\+/gu, "-")
              .replace(/\//gu, "_")
              .replace(/=+$/u, ""),
          },
          body: JSON.stringify(body),
        }),
        aborted,
      ]);
      if (
        response.redirected ||
        response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json" ||
        !response.body
      )
        return fail();
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8192) return fail();
        text += decoder.decode(chunk.value, { stream: true });
      }
      const value: unknown = JSON.parse(text + decoder.decode());
      if (controller.signal.aborted) return fail();
      if (!response.ok) {
        if (
          (response.status === 401 || response.status === 403) &&
          record(value, ["error"]).error === "request_denied"
        )
          return fail("Denied");
        return fail();
      }
      if (response.status !== 200) return fail();
      return value;
    } catch (error) {
      if (error instanceof ProductAuthoringRecoveryError) throw error;
      return fail();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", interrupted);
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      controller.abort();
    }
  }
  return Object.freeze({
    async context(
      action: ProductAuthoringAction,
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      const raw = record(
        await post("/merchant/catalog/products/authoring-context", { action }, scope, csrf, signal),
        [
          "profile",
          "action",
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
          "observedAt",
          "validUntil",
        ],
      );
      const observed = parseCatalogInstant(raw.observedAt),
        until = parseCatalogInstant(raw.validUntil),
        at = now();
      if (
        raw.profile !== "CatalogProductAuthoringContextV1" ||
        raw.action !== action ||
        raw.brandReference !== scope.brandReference ||
        raw.storeReference !== scope.storeReference
      )
        return fail("ScopeChanged");
      if (
        !Number.isFinite(at) ||
        Date.parse(until) !== Date.parse(observed) + 5000 ||
        at < Date.parse(observed) ||
        at >= Date.parse(until)
      )
        return fail("Stale");
      return Object.freeze({
        tenantReference: ref(raw.tenantReference),
        brandReference: ref(raw.brandReference),
        storeReference: ref(raw.storeReference),
        actorReference: ref(raw.actorReference),
        action,
        observedAt: observed,
        validUntil: until,
      });
    },
    async resolve(
      cursor: ProductAuthoringCursor,
      csrf: string,
      signal: AbortSignal,
    ): Promise<ProductAuthoringResolutionView> {
      const original = parseProductAuthoringCursor(cursor, cursor.scope),
        s = original.scope;
      const raw = record(
        await post(
          "/merchant/catalog/products/authoring-resolution",
          {
            profile: "CatalogProductAuthoringResolutionRequestV1",
            tenantReference: s.tenantReference,
            action: s.action,
            operationReference: original.operationReference,
            productReference: s.productReference,
            expectedAggregateVersion: original.expectedAggregateVersion,
          },
          s,
          csrf,
          signal,
        ),
        ["profile", "storeReference", "resolution"],
      );
      if (
        raw.profile !== "CatalogProductAuthoringResolutionResultV1" ||
        raw.storeReference !== s.storeReference
      )
        return fail("ScopeChanged");
      const r = record(raw.resolution, [
          "profile",
          "outcome",
          "command",
          "productReference",
          "versionReference",
          "aggregateVersion",
          "originalIntentDigest",
          "recordedAt",
          "digest",
        ]),
        c = record(r.command, [
          "profile",
          "tenantReference",
          "brandReference",
          "actorReference",
          "action",
          "operationReference",
          "productReference",
          "expectedAggregateVersion",
        ]);
      if (
        r.profile !== "CatalogProductAuthoringResolutionV1" ||
        c.profile !== "CatalogProductAuthoringResolutionCommandV1" ||
        c.tenantReference !== s.tenantReference ||
        c.brandReference !== s.brandReference ||
        c.actorReference !== s.actorReference ||
        c.action !== s.action ||
        c.operationReference !== original.operationReference ||
        c.productReference !== s.productReference ||
        c.expectedAggregateVersion !== original.expectedAggregateVersion
      )
        return fail("ScopeChanged");
      parseCatalogInstant(r.recordedAt);
      if (r.outcome === "Committed") {
        ref(r.productReference);
        ref(r.versionReference);
        if (
          r.aggregateVersion !==
            (s.action === "Create" ? 1 : (original.expectedAggregateVersion ?? 0) + 1) ||
          (s.action === "ReplaceDraft" && r.productReference !== s.productReference) ||
          typeof r.originalIntentDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(r.originalIntentDigest)
        )
          return fail();
      } else if (
        r.outcome !== "Abandoned" ||
        r.productReference !== s.productReference ||
        r.versionReference !== null ||
        r.aggregateVersion !== null ||
        r.originalIntentDigest !== null
      )
        return fail();
      const { digest, ...body } = r,
        hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(body))),
        actual =
          "sha256:" +
          Array.from(new Uint8Array(hashed), (b) => b.toString(16).padStart(2, "0")).join("");
      if (digest !== actual || signal.aborted) return fail();
      return Object.freeze({
        outcome: r.outcome,
        productReference: r.productReference as string | null,
        versionReference: r.versionReference as string | null,
        aggregateVersion: r.aggregateVersion as number | null,
      });
    },
  });
}

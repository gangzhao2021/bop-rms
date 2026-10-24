import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";
import { ProductSellingUnitsError } from "./product-selling-units-client.js";
export interface SellingUnitRecoveryScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
export interface SellingUnitCursor {
  readonly profile: "CatalogSellingUnitRegistrationCursorV1";
  readonly scope: SellingUnitRecoveryScope;
  readonly action: "Create" | "ReplaceDraft";
  readonly operationReference: string;
  readonly expectedRegistryVersion: number;
}
const fail = (code: ProductSellingUnitsError["code"] = "Unavailable"): never => {
  throw new ProductSellingUnitsError(code);
};
export function parseSellingUnitCursor(
  value: unknown,
  expected: SellingUnitRecoveryScope,
): SellingUnitCursor {
  const r = record(copyProductCommandValue(value), [
      "profile",
      "scope",
      "action",
      "operationReference",
      "expectedRegistryVersion",
    ]),
    s = record(r.scope, ["tenantReference", "brandReference", "storeReference", "actorReference"]);
  if (
    r.profile !== "CatalogSellingUnitRegistrationCursorV1" ||
    (r.action !== "Create" && r.action !== "ReplaceDraft") ||
    !Number.isSafeInteger(r.expectedRegistryVersion) ||
    (r.expectedRegistryVersion as number) < 0 ||
    (r.expectedRegistryVersion as number) >= 2147483647
  )
    return fail("Invalid");
  for (const field of [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ] as const)
    if (ref(s[field]) !== ref(expected[field])) return fail("Conflict");
  return Object.freeze({
    profile: r.profile,
    scope: Object.freeze({
      tenantReference: expected.tenantReference,
      brandReference: expected.brandReference,
      storeReference: expected.storeReference,
      actorReference: expected.actorReference,
    }),
    action: r.action,
    operationReference: ref(r.operationReference),
    expectedRegistryVersion: r.expectedRegistryVersion as number,
  });
}
export interface SellingUnitResolution {
  readonly outcome: "Committed" | "Abandoned";
  readonly registryReference: string | null;
  readonly versionReference: string | null;
  readonly registryVersion: number | null;
  readonly originalIntentDigest: string | null;
  readonly snapshotDigest: string | null;
  readonly recordedAt: string;
  readonly digest: string;
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
export function createSellingUnitRecoveryClient(
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
    const interrupted = () => rejectAbort?.(new ProductSellingUnitsError("Unavailable"));
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
        if (response.status === 409) {
          const error = record(value, ["error"]).error;
          return fail(
            typeof error === "string" && error.includes("feature_disabled")
              ? "Disabled"
              : "Conflict",
          );
        }
        return fail();
      }
      if (response.status !== 200) return fail();
      return value;
    } catch (error) {
      if (error instanceof ProductSellingUnitsError) throw error;
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
      action: "Create" | "ReplaceDraft",
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal: AbortSignal,
    ) {
      if (action !== "Create" && action !== "ReplaceDraft") return fail("Invalid");
      const r = record(
          copyProductCommandValue(
            await post(
              "/merchant/catalog/products/selling-units/context",
              { action },
              scope,
              csrf,
              signal,
            ),
          ),
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
        ),
        observedAt = parseCatalogInstant(r.observedAt),
        validUntil = parseCatalogInstant(r.validUntil),
        at = now();
      if (
        r.profile !== "CatalogSellingUnitRegistrationContextV1" ||
        r.action !== action ||
        r.brandReference !== scope.brandReference ||
        r.storeReference !== scope.storeReference
      )
        return fail("Conflict");
      if (
        !Number.isFinite(at) ||
        Date.parse(validUntil) !== Date.parse(observedAt) + 5000 ||
        at < Date.parse(observedAt) ||
        at >= Date.parse(validUntil)
      )
        return fail("Stale");
      return Object.freeze({
        tenantReference: ref(r.tenantReference),
        brandReference: ref(r.brandReference),
        storeReference: ref(r.storeReference),
        actorReference: ref(r.actorReference),
        action,
        observedAt,
        validUntil,
      });
    },
    async resolve(
      cursor: SellingUnitCursor,
      csrf: string,
      signal: AbortSignal,
    ): Promise<SellingUnitResolution> {
      const original = parseSellingUnitCursor(cursor, cursor.scope),
        s = original.scope;
      const raw = record(
        copyProductCommandValue(
          await post(
            "/merchant/catalog/products/selling-units/resolve",
            {
              profile: "CatalogSellingUnitRegistrationResolutionRequestV1",
              tenantReference: s.tenantReference,
              actorReference: s.actorReference,
              action: original.action,
              operationReference: original.operationReference,
              expectedRegistryVersion: original.expectedRegistryVersion,
            },
            s,
            csrf,
            signal,
          ),
        ),
        ["profile", "storeReference", "resolution"],
      );
      if (
        raw.profile !== "CatalogSellingUnitRegistrationResolutionResultV1" ||
        raw.storeReference !== s.storeReference
      )
        return fail("Conflict");
      const r = record(raw.resolution, [
          "profile",
          "outcome",
          "command",
          "registryReference",
          "versionReference",
          "registryVersion",
          "originalIntentDigest",
          "snapshotDigest",
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
          "expectedRegistryVersion",
        ]);
      if (
        r.profile !== "CatalogSellingUnitRegistrationResolutionV1" ||
        c.profile !== "CatalogSellingUnitRegistrationResolutionCommandV1" ||
        c.tenantReference !== s.tenantReference ||
        c.brandReference !== s.brandReference ||
        c.actorReference !== s.actorReference ||
        c.action !== original.action ||
        c.operationReference !== original.operationReference ||
        c.expectedRegistryVersion !== original.expectedRegistryVersion
      )
        return fail("Conflict");
      const recordedAt = parseCatalogInstant(r.recordedAt),
        hash = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
      if (r.outcome === "Committed") {
        ref(r.registryReference);
        ref(r.versionReference);
        if (
          r.registryVersion !== original.expectedRegistryVersion + 1 ||
          !hash(r.originalIntentDigest) ||
          !hash(r.snapshotDigest)
        )
          return fail();
      } else if (
        r.outcome !== "Abandoned" ||
        r.registryReference !== null ||
        r.versionReference !== null ||
        r.registryVersion !== null ||
        r.originalIntentDigest !== null ||
        r.snapshotDigest !== null
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
        registryReference: r.registryReference as string | null,
        versionReference: r.versionReference as string | null,
        registryVersion: r.registryVersion as number | null,
        originalIntentDigest: r.originalIntentDigest as string | null,
        snapshotDigest: r.snapshotDigest as string | null,
        recordedAt,
        digest: actual,
      });
    },
  });
}

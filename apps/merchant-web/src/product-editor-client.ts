import {
  productCommandRecord as record,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductVersion,
  parseCatalogCode,
} from "./catalog-product-command-values.js";
import {
  parseProductScopeJournalRequest,
  type ProductScopeJournalRequest,
} from "./product-scope-journal-client.js";
export class ProductEditorClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Stale" | "ScopeChanged" | "Invalid") {
    super("Current Product content could not be loaded");
    this.name = "ProductEditorClientError";
  }
}
const fail = (code: ProductEditorClientError["code"] = "Unavailable"): never => {
  throw new ProductEditorClientError(code);
};
export const productEditorMaximumResponseBytes = 8 * 1024 * 1024;
function parseRequest(value: unknown): ProductScopeJournalRequest {
  try {
    return parseProductScopeJournalRequest(value);
  } catch {
    return fail("Invalid");
  }
}
function integer(v: unknown, min = 0): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > 2147483647) return fail();
  return v as number;
}
function list<T>(v: unknown, parse: (item: unknown) => T, max = 1000): readonly T[] {
  if (!Array.isArray(v) || v.length > max) return fail();
  return Object.freeze(v.map(parse));
}
const ref = (v: unknown) => parseCatalogReference(v);
const nullable = (v: unknown) => (v === null ? null : ref(v));
const refs = (v: unknown) => list(v, ref);
function choice<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) return fail();
  return v as T;
}
function hasControls(text: string, lines = false): boolean {
  return [...text].some((c) => {
    const n = c.charCodeAt(0);
    return n === 127 || (n < 32 && !(lines && (n === 9 || n === 10)));
  });
}
function localized(v: unknown, max: number) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 32) return fail();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(v).map(([locale, text]) => {
        if (
          !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale) ||
          typeof text !== "string" ||
          text.length < 1 ||
          text.length > max ||
          /[<>\u202a-\u202e\u2066-\u2069]/u.test(text) ||
          hasControls(text, true)
        )
          return fail();
        return [locale, text];
      }),
    ),
  );
}
function pair(v: unknown) {
  if (v === null) return null;
  const r = record(v, ["reference", "versionReference"]);
  return Object.freeze({ reference: ref(r.reference), versionReference: ref(r.versionReference) });
}
function selections(v: unknown) {
  return list(v, (s) => {
    const r = record(s, ["dimensionReference", "valueReference"]);
    return Object.freeze({
      dimensionReference: ref(r.dimensionReference),
      valueReference: ref(r.valueReference),
    });
  });
}
/** Closed wire/presentation shape only. Owner graph/reference/uniqueness policy remains server-owned. */
function content(v: unknown) {
  const r = record(v, [
    "profile",
    "localizedShortDescriptions",
    "localizedDescriptions",
    "preparationNotes",
    "tagReferences",
    "attributeValues",
    "media",
    "variantDimensions",
    "variantCombinations",
    "optionRules",
    "allergenReferences",
    "nutritionProfile",
  ]);
  if (r.profile !== "CatalogProductEditorContentV1") return fail();
  const attributeValues = list(r.attributeValues, (v) => {
    const type = (v as Record<string, unknown>)?.type;
    const a = record(
      v,
      type === "Decimal"
        ? ["attributeReference", "type", "value", "unitCode"]
        : type === "Enum"
          ? ["attributeReference", "type", "valueReference"]
          : ["attributeReference", "type", "value"],
    );
    ref(a.attributeReference);
    if (type === "Enum") {
      ref(a.valueReference);
      return Object.freeze({ type, display: "Reference configured" });
    }
    if (type === "Boolean" && typeof a.value === "boolean")
      return Object.freeze({ type, display: a.value ? "Yes" : "No" });
    if (
      type === "Text" &&
      typeof a.value === "string" &&
      a.value.length <= 240 &&
      !/[<>]/u.test(a.value) &&
      !hasControls(a.value)
    )
      return Object.freeze({ type, display: a.value });
    if (
      type === "Decimal" &&
      typeof a.value === "string" &&
      /^-?(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/u.test(a.value)
    )
      return Object.freeze({
        type,
        display: a.value + (a.unitCode === null ? "" : " " + parseCatalogCode(a.unitCode)),
      });
    return fail();
  });
  const media = list(
    r.media,
    (v) => {
      const m = record(v, [
        "mediaReference",
        "assetReference",
        "assetVersionReference",
        "role",
        "altText",
        "sortOrder",
        "cropReference",
        "focusReference",
      ]);
      ref(m.mediaReference);
      ref(m.assetReference);
      ref(m.assetVersionReference);
      nullable(m.cropReference);
      nullable(m.focusReference);
      return Object.freeze({
        role: choice(m.role, [
          "Primary",
          "Gallery",
          "ThumbnailCandidate",
          "Instructional",
        ] as const),
        altText: localized(m.altText, 240),
        sortOrder: integer(m.sortOrder),
      });
    },
    100,
  );
  const dimensions = list(r.variantDimensions, (v) => {
    const d = record(v, [
      "dimensionReference",
      "code",
      "localizedNames",
      "sortOrder",
      "selectionRequirement",
      "values",
    ]);
    return Object.freeze({
      reference: ref(d.dimensionReference),
      code: parseCatalogCode(d.code),
      names: localized(d.localizedNames, 240),
      sortOrder: integer(d.sortOrder),
      requirement: choice(d.selectionRequirement, ["Required", "Optional"] as const),
      values: list(d.values, (v) => {
        const x = record(v, [
          "valueReference",
          "code",
          "localizedNames",
          "sortOrder",
          "attributeReference",
          "mediaReference",
        ]);
        nullable(x.attributeReference);
        nullable(x.mediaReference);
        return Object.freeze({
          reference: ref(x.valueReference),
          code: parseCatalogCode(x.code),
          names: localized(x.localizedNames, 240),
          sortOrder: integer(x.sortOrder),
        });
      }),
    });
  });
  const combinations = list(r.variantCombinations, (v) => {
    const c = record(v, ["selections", "disposition", "skuReference"]);
    return Object.freeze({
      selections: selections(c.selections),
      disposition: choice(c.disposition, ["Valid", "Invalid", "NotGenerated"] as const),
      skuReference: nullable(c.skuReference),
    });
  });
  const optionRules = list(r.optionRules, (v) => {
    const o = record(v, [
      "bindingReference",
      "versionResolution",
      "pricingRule",
      "conditionalRule",
      "conflictRule",
      "variantCondition",
    ]);
    return Object.freeze({
      bindingReference: ref(o.bindingReference),
      resolution: choice(o.versionResolution, ["Pinned", "CurrentPublished"] as const),
      pricing: pair(o.pricingRule) !== null,
      condition: pair(o.conditionalRule) !== null,
      conflict: pair(o.conflictRule) !== null,
      variants: selections(o.variantCondition),
    });
  });
  return Object.freeze({
    shortDescriptions: localized(r.localizedShortDescriptions, 240),
    descriptions: localized(r.localizedDescriptions, 4096),
    preparation: localized(r.preparationNotes, 4096),
    tagCount: refs(r.tagReferences).length,
    attributeValues,
    media,
    dimensions,
    combinations,
    optionRules,
    allergenCount: refs(r.allergenReferences).length,
    nutritionConfigured: pair(r.nutritionProfile) !== null,
  });
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
const hashToken = (v: unknown) =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
export async function parseProductEditorView(
  value: unknown,
  expected: ProductScopeJournalRequest,
  now: () => number = Date.now,
) {
  try {
    const request = parseRequest(expected),
      safe = copy(value),
      raw = record(safe, [
        "profile",
        "tenantReference",
        "brandReference",
        "productReference",
        "aggregateVersion",
        "aggregate",
        "contentDigest",
        "configurationDigest",
        "contentStatus",
        "observedAt",
        "validUntil",
        "referenceEligibility",
        "publishValidation",
        "eligibility",
        "digest",
      ]);
    if (
      new TextEncoder().encode(JSON.stringify(safe)).byteLength > productEditorMaximumResponseBytes
    )
      return fail();
    if (
      raw.profile !== "CatalogProductEditorSnapshotV1" ||
      raw.referenceEligibility !== "NotEvaluated" ||
      raw.publishValidation !== "Incomplete" ||
      raw.eligibility !== "NotEvaluated"
    )
      return fail();
    ref(raw.tenantReference);
    hashToken(raw.contentDigest);
    hashToken(raw.configurationDigest);
    hashToken(raw.digest);
    if (
      raw.brandReference !== request.brandReference ||
      raw.productReference !== request.productReference
    )
      return fail("ScopeChanged");
    if (raw.aggregateVersion !== request.expectedAggregateVersion) return fail("Stale");
    const observedAt = parseCatalogInstant(raw.observedAt),
      validUntil = parseCatalogInstant(raw.validUntil);
    const freshness = () => {
      const at = now();
      if (
        !Number.isFinite(at) ||
        Date.parse(validUntil) !== Date.parse(observedAt) + 5000 ||
        at < Date.parse(observedAt) ||
        at >= Date.parse(validUntil)
      )
        return fail("Stale");
    };
    freshness();
    const { digest, ...body } = raw;
    const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(body)));
    const actual =
      "sha256:" +
      Array.from(new Uint8Array(hashed), (b) => b.toString(16).padStart(2, "0")).join("");
    if (actual !== digest) return fail();
    const a = record(raw.aggregate, [
      "productReference",
      "brandReference",
      "internalCode",
      "productType",
      "lifecycle",
      "aggregateVersion",
      "createdAt",
      "createdByActorReference",
      "updatedAt",
      "draft",
    ]);
    if (
      a.productReference !== request.productReference ||
      a.brandReference !== request.brandReference ||
      a.aggregateVersion !== request.expectedAggregateVersion
    )
      return fail();
    const sourceDraft = a.draft as Record<string, unknown>,
      editorContent = sourceDraft.editorContent;
    const draft = parseProductVersion(sourceDraft);
    if (canonical(draft) !== canonical(sourceDraft)) return fail();
    const createdAt = parseCatalogInstant(a.createdAt),
      updatedAt = parseCatalogInstant(a.updatedAt);
    ref(a.createdByActorReference);
    if (
      createdAt > updatedAt ||
      updatedAt > observedAt ||
      draft.updatedAt > updatedAt ||
      draft.createdAt < createdAt ||
      draft.skus.some(
        (s) =>
          s.productReference !== a.productReference ||
          s.brandReference !== a.brandReference ||
          s.createdAt > draft.updatedAt,
      )
    )
      return fail();
    if (raw.contentStatus !== (editorContent === undefined ? "Unavailable" : "Present"))
      return fail();
    const details = editorContent === undefined ? null : content(editorContent);
    freshness();
    return Object.freeze({
      tenantReference: ref(raw.tenantReference),
      observedAt,
      validUntil,
      revision: request.expectedAggregateVersion,
      internalCode: parseCatalogCode(a.internalCode),
      productType: choice(a.productType, ["PreparedFood", "NonAlcoholicBeverage"] as const),
      lifecycle: choice(a.lifecycle, [
        "Draft",
        "Active",
        "Suspended",
        "Discontinued",
        "Archived",
      ] as const),
      draft,
      content: details,
    });
  } catch (error) {
    if (error instanceof ProductEditorClientError) throw error;
    return fail();
  }
}
export type ProductEditorView = Awaited<ReturnType<typeof parseProductEditorView>>;

export function createProductEditorClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      input: { request: ProductScopeJournalRequest; csrf: string },
      signal: AbortSignal,
    ): Promise<ProductEditorView> {
      const selected = parseRequest(input.request),
        controller = new AbortController();
      if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.csrf))
        return fail("Invalid");
      const cancelled = () => new DOMException("Product content read cancelled", "AbortError");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(signal.aborted ? cancelled() : new ProductEditorClientError("Unavailable"));
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
          fetcher("/merchant/catalog/products/editor", {
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
            Number(length) > productEditorMaximumResponseBytes)
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
          if (total > productEditorMaximumResponseBytes) return fail();
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
          if (response.status === 400 && error === "product_editor_invalid") return fail("Invalid");
          return fail();
        }
        if (response.status !== 200) return fail();
        const parsed = await guard(parseProductEditorView(raw, selected, now));
        if (controller.signal.aborted) throw cancelled();
        return parsed;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductEditorClientError) throw error;

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

export type ProductEditorClient = ReturnType<typeof createProductEditorClient>;

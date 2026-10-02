import {
  productCommandRecord as record,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
} from "./catalog-product-command-values.js";
export class ProductScopeJournalClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Stale" | "ScopeChanged" | "Invalid") {
    super("Product scope history could not be loaded");
    this.name = "ProductScopeJournalClientError";
  }
}
const fail = (code: ProductScopeJournalClientError["code"] = "Unavailable"): never => {
  throw new ProductScopeJournalClientError(code);
};
export const productScopeJournalMaximumResponseBytes = 2 * 1024 * 1024;
export interface ProductScopeJournalRequest {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
}
function integer(value: unknown, min = 1, max = 2147483647): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return fail();
  return value as number;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail();
  return value;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  return value;
}
function copy(value: unknown): unknown {
  let budget = 100000;
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))
      return v;
    if (typeof v === "string") {
      if (v.length > 4096) return fail();
      return v;
    }
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
      if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 64)
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
export function parseProductScopeJournalRequest(value: unknown): ProductScopeJournalRequest {
  try {
    const r = record(value, [
      "brandReference",
      "storeReference",
      "productReference",
      "expectedAggregateVersion",
    ]);
    return Object.freeze({
      brandReference: parseCatalogReference(r.brandReference),
      storeReference: parseCatalogReference(r.storeReference),
      productReference: parseCatalogReference(r.productReference),
      expectedAggregateVersion: integer(r.expectedAggregateVersion),
    });
  } catch {
    return fail("Invalid");
  }
}
function codes(value: unknown) {
  const parsed = list(value, 100).map((v) => {
    const result = parseCatalogCode(v);
    if (result !== v) return fail();
    return result;
  });
  if (new Set(parsed).size !== parsed.length) return fail();
  return Object.freeze(parsed);
}
export function parseProductScopeJournalView(
  value: unknown,
  expected: ProductScopeJournalRequest,
  now: number,
) {
  try {
    const request = parseProductScopeJournalRequest(expected),
      safe = copy(value);
    if (
      new TextEncoder().encode(JSON.stringify(safe)).byteLength >
      productScopeJournalMaximumResponseBytes
    )
      return fail();
    const r = record(safe, [
        "profile",
        "tenantReference",
        "brandReference",
        "productReference",
        "aggregateVersion",
        "sourceDigest",
        "observedAt",
        "validUntil",
        "coverage",
        "versions",
        "eligibility",
        "currentDisposition",
        "digest",
      ]),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductScopeJournalManagementV1" ||
      r.coverage !== "CompleteRecordedScopeJournalCoverage" ||
      r.eligibility !== "NotEvaluated" ||
      r.currentDisposition !== "NotEvaluated"
    )
      return fail();
    parseCatalogReference(r.tenantReference);
    digest(r.sourceDigest);
    digest(r.digest);
    if (
      r.brandReference !== request.brandReference ||
      r.productReference !== request.productReference
    )
      return fail("ScopeChanged");
    if (r.aggregateVersion !== request.expectedAggregateVersion) return fail("Stale");
    if (
      !Number.isFinite(now) ||
      Date.parse(validUntil) !== Date.parse(observedAt) + 5000 ||
      now < Date.parse(observedAt) ||
      now >= Date.parse(validUntil)
    )
      return fail("Stale");
    let relations = 0;
    const versions = list(r.versions, 1000).map((value) => {
      const v = record(value, [
          "versionReference",
          "currentPublicationVersion",
          "currentState",
          "originalPublicationOperationReference",
          "recordStatus",
          "journal",
        ]),
        versionReference = parseCatalogReference(v.versionReference),
        originalOperation =
          v.originalPublicationOperationReference === null
            ? null
            : parseCatalogReference(v.originalPublicationOperationReference);
      integer(v.currentPublicationVersion);
      if (
        !["Draft", "InReview", "Approved", "Scheduled", "Published", "Superseded"].includes(
          String(v.currentState),
        )
      )
        return fail();
      const published = v.currentState === "Published" || v.currentState === "Superseded";
      if (
        !["Recorded", "NotRecorded", "NotApplicable"].includes(String(v.recordStatus)) ||
        published !== (originalOperation !== null) ||
        (v.recordStatus === "NotApplicable") !== (originalOperation === null) ||
        (v.recordStatus === "Recorded") !== (v.journal !== null)
      )
        return fail();
      const j =
        v.journal === null
          ? null
          : record(v.journal, [
              "digest",
              "sourceHeadDigest",
              "sourceAggregateVersion",
              "policyReference",
              "policyVersion",
              "policyEvidenceReference",
              "recordedAt",
              "originalEvidenceValidUntil",
              "relations",
            ]);
      const journal =
        j === null
          ? null
          : (() => {
              digest(j.digest);
              digest(j.sourceHeadDigest);
              parseCatalogReference(j.policyReference);
              parseCatalogReference(j.policyEvidenceReference);
              integer(j.policyVersion);
              const recordedAt = parseCatalogInstant(j.recordedAt),
                originalEvidenceValidUntil = parseCatalogInstant(j.originalEvidenceValidUntil);
              if (
                recordedAt > observedAt ||
                originalEvidenceValidUntil <= recordedAt ||
                integer(j.sourceAggregateVersion) >= request.expectedAggregateVersion
              )
                return fail();
              const rows = list(j.relations, 10000).map((value) => {
                if (++relations > 10000) return fail();
                const p = record(value, [
                    "previousVersionReference",
                    "previousOperationReference",
                    "previousIntentDigest",
                    "previousScopeDigest",
                    "previousSelectorIndex",
                    "incomingSelectorIndex",
                    "storeReference",
                    "channelCodes",
                    "orderTypeCodes",
                    "effectiveFrom",
                    "effectiveUntil",
                    "relation",
                  ]),
                  previousVersionReference = parseCatalogReference(p.previousVersionReference),
                  previousOperationReference = parseCatalogReference(p.previousOperationReference),
                  from = parseCatalogInstant(p.effectiveFrom),
                  until = p.effectiveUntil === null ? null : parseCatalogInstant(p.effectiveUntil);
                digest(p.previousIntentDigest);
                digest(p.previousScopeDigest);
                integer(p.previousSelectorIndex, 0, 999);
                integer(p.incomingSelectorIndex, 0, 999);
                if (
                  previousVersionReference === versionReference ||
                  (until !== null && until <= from) ||
                  ![
                    "IncomingSelectorPreferred",
                    "ExistingSelectorPreferred",
                    "EqualPrecedenceOverlap",
                  ].includes(String(p.relation))
                )
                  return fail();
                return Object.freeze({
                  previousVersionReference,
                  previousOperationReference,
                  storeReference:
                    p.storeReference === null ? null : parseCatalogReference(p.storeReference),
                  channelCodes: codes(p.channelCodes),
                  orderTypeCodes: codes(p.orderTypeCodes),
                  effectiveFrom: from,
                  effectiveUntil: until,
                  relation: p.relation as
                    | "IncomingSelectorPreferred"
                    | "ExistingSelectorPreferred"
                    | "EqualPrecedenceOverlap",
                });
              });
              return Object.freeze({
                recordedAt,
                originalEvidenceValidUntil,
                relations: Object.freeze(rows),
              });
            })();
      return Object.freeze({
        versionReference,
        publicationVersion: v.currentPublicationVersion as number,
        state: v.currentState as string,
        originalOperation,
        recordStatus: v.recordStatus as "Recorded" | "NotRecorded" | "NotApplicable",
        journal,
      });
    });
    const byReference = new Map(versions.map((v) => [v.versionReference, v]));
    if (byReference.size !== versions.length) return fail();
    for (const version of versions)
      for (const row of version.journal?.relations ?? []) {
        if (
          byReference.get(row.previousVersionReference)?.originalOperation !==
          row.previousOperationReference
        )
          return fail();
      }
    // Client shape/freshness checks are not validation, approval or fingerprint authority.
    return Object.freeze({
      observedAt,
      validUntil,
      aggregateVersion: request.expectedAggregateVersion,
      versions: Object.freeze(versions),
    });
  } catch (error) {
    if (error instanceof ProductScopeJournalClientError) throw error;
    return fail();
  }
}
export type ProductScopeJournalView = ReturnType<typeof parseProductScopeJournalView>;

export function createProductScopeJournalClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      input: { request: ProductScopeJournalRequest; csrf: string },
      signal: AbortSignal,
    ): Promise<ProductScopeJournalView> {
      const selected = parseProductScopeJournalRequest(input.request),
        controller = new AbortController();
      if (typeof input.csrf !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.csrf))
        return fail("Invalid");
      const cancelled = () => new DOMException("Product history read cancelled", "AbortError");
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(
              signal.aborted ? cancelled() : new ProductScopeJournalClientError("Unavailable"),
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
          fetcher("/merchant/catalog/products/publication/scope-journals", {
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
            Number(length) > productScopeJournalMaximumResponseBytes)
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
          if (total > productScopeJournalMaximumResponseBytes) return fail();
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
          if (response.status === 400 && error === "product_scope_journals_invalid")
            return fail("Invalid");
          return fail();
        }
        if (response.status !== 200) return fail();
        return parseProductScopeJournalView(raw, selected, now());
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (error instanceof ProductScopeJournalClientError) throw error;

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

export type ProductScopeJournalClient = ReturnType<typeof createProductScopeJournalClient>;

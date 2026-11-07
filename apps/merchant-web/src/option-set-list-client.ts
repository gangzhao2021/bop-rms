import {
  copyProductCommandValue,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogCode,
  parseLocalizedNames,
} from "./catalog-product-command-values.js";
export class OptionSetListClientError extends Error {
  constructor(
    readonly code:
      "Invalid" | "Denied" | "FeatureDisabled" | "Stale" | "Unavailable" | "ScopeChanged",
  ) {
    super("Option Sets could not be loaded");
    this.name = "OptionSetListClientError";
  }
}
const fail = (code: OptionSetListClientError["code"] = "Unavailable"): never => {
  throw new OptionSetListClientError(code);
};
// Plain browser wire values only; recorded references are not qualifications.
export const optionSetListFields = Object.freeze([
  "optionSetReference",
  "internalCode",
  "lifecycle",
  "aggregateVersion",
  "draftVersionReference",
  "createdAt",
  "updatedAt",
  "defaultLocale",
  "localizedNames",
  "optionLocalizedNames",
  "optionCode",
  "selectionRule",
  "optionCount",
  "activeOptionCount",
  "productBindingCount",
  "recordedPricingReference",
  "recordedConsumptionReference",
  "recordedConflict",
  "publishingStatus",
  "referenceEligibility",
] as const);
export type OptionSetListSort = "updatedAt" | "createdAt" | "internalCode" | "name";
export type OptionSetListPresence =
  Readonly<{ status: "Known"; present: boolean }> | Readonly<{ status: "Unknown" }>;
export interface OptionSetListRequest {
  readonly locale: string;
  readonly search: string | null;
  readonly lifecycle: "Draft" | "Archived" | null;
  readonly selectionType: "SingleChoice" | "MultiChoice" | "Quantity" | null;
  readonly includeArchived: boolean;
  readonly hasProductBinding: boolean | null;
  readonly hasPricingReference: boolean | null;
  readonly hasConsumptionReference: boolean | null;
  readonly hasConflict: boolean | null;
  readonly missingTranslationLocale: string | null;
  readonly publishingStatus: "Draft" | "InReview" | "Approved" | "Published" | "Archived" | null;
  readonly sort: OptionSetListSort;
  readonly direction: "ASC" | "DESC";
  readonly limit: number;
  readonly cursor: string | null;
}
export interface OptionSetListItem {
  readonly optionSetReference: string;
  readonly internalCode: string;
  readonly lifecycle: "Draft" | "Archived";
  readonly aggregateVersion: number;
  readonly draftVersionReference: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly name: string;
  readonly nameLocale: string;
  readonly localeFallback: boolean;
  readonly selectionRule: Readonly<{
    displayStyle: "SingleChoice" | "MultiChoice" | "Quantity";
    minimumSelection: number;
    maximumSelection: number | null;
    allowRepeatedOption: boolean;
    perOptionMaximumQuantity: number;
    maximumTotalQuantity: number | null;
  }>;
  readonly optionCount: number;
  readonly activeOptionCount: number;
  readonly productBindingCount: number;
  readonly recordedPricingReference: OptionSetListPresence;
  readonly recordedConsumptionReference: OptionSetListPresence;
  readonly recordedConflict: OptionSetListPresence;
  readonly publishingStatus: Readonly<{ status: "Unavailable" }>;
  readonly referenceEligibility: "NotEvaluated";
}
export interface OptionSetListView {
  readonly projection: Readonly<{
    name: "catalog_option_set_search_v1";
    version: 1;
    asOfUtc: string;
    stale: false;
    partial: true;
    sourceGeneration: string;
  }>;
  readonly scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
  }>;
  readonly locale: string;
  readonly items: readonly OptionSetListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
const invalid = (): never => {
  throw new OptionSetListClientError("Invalid");
};
function sourceGeneration(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return invalid();
  return value;
}
export function optionSetListRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((k) => typeof k !== "string" || !keys.includes(k)))
    return invalid();
  return Object.fromEntries(
    keys.map((k) => {
      const d = descriptors[k];
      if (!d?.enumerable || !("value" in d)) return invalid();
      return [k, d.value];
    }),
  );
}
export function optionSetListInteger(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
export function optionSetListBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}
export function optionSetListStyle(value: unknown): "SingleChoice" | "MultiChoice" | "Quantity" {
  if (value !== "SingleChoice" && value !== "MultiChoice" && value !== "Quantity") return invalid();
  return value;
}
export function optionSetListLifecycle(value: unknown): "Draft" | "Archived" {
  if (value !== "Draft" && value !== "Archived") return invalid();
  return value;
}
function nullableBoolean(value: unknown): boolean | null {
  return value === null ? null : optionSetListBoolean(value);
}
function parseRequest(value: unknown): OptionSetListRequest {
  const r = optionSetListRecord(copyProductCommandValue(value), [
    "locale",
    "search",
    "lifecycle",
    "selectionType",
    "includeArchived",
    "hasProductBinding",
    "hasPricingReference",
    "hasConsumptionReference",
    "hasConflict",
    "missingTranslationLocale",
    "publishingStatus",
    "sort",
    "direction",
    "limit",
    "cursor",
  ]);
  if (
    r.search !== null &&
    (typeof r.search !== "string" ||
      r.search.length < 1 ||
      r.search.length > 200 ||
      r.search.trim() !== r.search ||
      Array.from(r.search).some(
        (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
      ))
  )
    return invalid();
  if (
    r.cursor !== null &&
    (typeof r.cursor !== "string" || r.cursor.length < 1 || r.cursor.length > 4096)
  )
    return invalid();
  if (
    r.sort !== "updatedAt" &&
    r.sort !== "createdAt" &&
    r.sort !== "internalCode" &&
    r.sort !== "name"
  )
    return invalid();
  if (r.direction !== "ASC" && r.direction !== "DESC") return invalid();
  if (
    r.publishingStatus !== null &&
    r.publishingStatus !== "Draft" &&
    r.publishingStatus !== "InReview" &&
    r.publishingStatus !== "Approved" &&
    r.publishingStatus !== "Published" &&
    r.publishingStatus !== "Archived"
  )
    return invalid();
  return Object.freeze({
    locale: parseCatalogLocale(r.locale),
    search: r.search,
    lifecycle: r.lifecycle === null ? null : optionSetListLifecycle(r.lifecycle),
    selectionType: r.selectionType === null ? null : optionSetListStyle(r.selectionType),
    includeArchived: optionSetListBoolean(r.includeArchived),
    hasProductBinding: nullableBoolean(r.hasProductBinding),
    hasPricingReference: nullableBoolean(r.hasPricingReference),
    hasConsumptionReference: nullableBoolean(r.hasConsumptionReference),
    hasConflict: nullableBoolean(r.hasConflict),
    missingTranslationLocale:
      r.missingTranslationLocale === null ? null : parseCatalogLocale(r.missingTranslationLocale),
    publishingStatus: r.publishingStatus,
    sort: r.sort,
    direction: r.direction,
    limit: optionSetListInteger(r.limit, 1, 100),
    cursor: r.cursor,
  });
}
function boundary<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof OptionSetListClientError) throw error;
    return invalid();
  }
}
export function parseOptionSetListRequest(value: unknown): OptionSetListRequest {
  return boundary(() => parseRequest(value));
}
function presence(value: unknown): OptionSetListPresence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const status = Object.getOwnPropertyDescriptor(value, "status");
  if (!status || !("value" in status)) return invalid();
  if (status.value === "Unknown") {
    optionSetListRecord(value, ["status"]);
    return Object.freeze({ status: "Unknown" });
  }
  const r = optionSetListRecord(value, ["status", "present"]);
  if (r.status !== "Known") return invalid();
  return Object.freeze({ status: "Known", present: optionSetListBoolean(r.present) });
}
export function parseOptionSetListItem(value: unknown): OptionSetListItem {
  return boundary(() => {
    const r = optionSetListRecord(copyProductCommandValue(value), [
        "optionSetReference",
        "internalCode",
        "lifecycle",
        "aggregateVersion",
        "draftVersionReference",
        "createdAt",
        "updatedAt",
        "name",
        "nameLocale",
        "localeFallback",
        "selectionRule",
        "optionCount",
        "activeOptionCount",
        "productBindingCount",
        "recordedPricingReference",
        "recordedConsumptionReference",
        "recordedConflict",
        "publishingStatus",
        "referenceEligibility",
      ]),
      s = optionSetListRecord(r.selectionRule, [
        "displayStyle",
        "minimumSelection",
        "maximumSelection",
        "allowRepeatedOption",
        "perOptionMaximumQuantity",
        "maximumTotalQuantity",
      ]);
    const minimum = optionSetListInteger(s.minimumSelection),
      maximum = s.maximumSelection === null ? null : optionSetListInteger(s.maximumSelection),
      per = optionSetListInteger(s.perOptionMaximumQuantity, 1),
      total = s.maximumTotalQuantity === null ? null : optionSetListInteger(s.maximumTotalQuantity),
      repeat = optionSetListBoolean(s.allowRepeatedOption),
      count = optionSetListInteger(r.optionCount),
      active = optionSetListInteger(r.activeOptionCount),
      created = parseCatalogInstant(r.createdAt),
      updated = parseCatalogInstant(r.updatedAt),
      locale = parseCatalogLocale(r.nameLocale);
    const name = parseLocalizedNames({ [locale]: r.name }, locale)[locale];
    if (
      !name ||
      name !== r.name ||
      parseCatalogCode(r.internalCode) !== r.internalCode ||
      created > updated ||
      active > count ||
      (maximum !== null && maximum < minimum) ||
      (total !== null && (total < minimum || per > total)) ||
      (!repeat && per !== 1)
    )
      return invalid();
    const published = optionSetListRecord(r.publishingStatus, ["status"]);
    if (published.status !== "Unavailable" || r.referenceEligibility !== "NotEvaluated")
      return invalid();
    return Object.freeze({
      optionSetReference: parseCatalogReference(r.optionSetReference),
      internalCode: parseCatalogCode(r.internalCode),
      lifecycle: optionSetListLifecycle(r.lifecycle),
      aggregateVersion: optionSetListInteger(r.aggregateVersion, 1),
      draftVersionReference: parseCatalogReference(r.draftVersionReference),
      createdAt: created,
      updatedAt: updated,
      name,
      nameLocale: locale,
      localeFallback: optionSetListBoolean(r.localeFallback),
      selectionRule: Object.freeze({
        displayStyle: optionSetListStyle(s.displayStyle),
        minimumSelection: minimum,
        maximumSelection: maximum,
        allowRepeatedOption: repeat,
        perOptionMaximumQuantity: per,
        maximumTotalQuantity: total,
      }),
      optionCount: count,
      activeOptionCount: active,
      productBindingCount: optionSetListInteger(r.productBindingCount),
      recordedPricingReference: presence(r.recordedPricingReference),
      recordedConsumptionReference: presence(r.recordedConsumptionReference),
      recordedConflict: presence(r.recordedConflict),
      publishingStatus: Object.freeze({ status: "Unavailable" }),
      referenceEligibility: "NotEvaluated",
    });
  });
}
export function parseOptionSetListView(value: unknown): OptionSetListView {
  return boundary(() => {
    const r = optionSetListRecord(copyProductCommandValue(value), [
        "projection",
        "scope",
        "locale",
        "items",
        "hasMore",
        "nextCursor",
      ]),
      p = optionSetListRecord(r.projection, [
        "name",
        "version",
        "asOfUtc",
        "stale",
        "partial",
        "sourceGeneration",
      ]),
      s = optionSetListRecord(r.scope, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
    if (
      p.name !== "catalog_option_set_search_v1" ||
      p.version !== 1 ||
      p.stale !== false ||
      p.partial !== true ||
      !Array.isArray(r.items) ||
      r.items.length > 100 ||
      r.hasMore !== (r.nextCursor !== null) ||
      (r.nextCursor !== null &&
        (typeof r.nextCursor !== "string" || r.nextCursor.length < 1 || r.nextCursor.length > 4096))
    )
      return invalid();
    const items = Object.freeze(r.items.map(parseOptionSetListItem)),
      locale = parseCatalogLocale(r.locale),
      asOf = parseCatalogInstant(p.asOfUtc);
    if (
      new Set(items.map((i) => i.optionSetReference)).size !== items.length ||
      (r.hasMore === true && items.length === 0) ||
      items.some((i) => i.updatedAt > asOf || i.localeFallback !== (i.nameLocale !== locale))
    )
      return invalid();
    return Object.freeze({
      projection: Object.freeze({
        name: "catalog_option_set_search_v1",
        version: 1,
        asOfUtc: parseCatalogInstant(p.asOfUtc),
        stale: false,
        partial: true,
        sourceGeneration: sourceGeneration(p.sourceGeneration),
      }),
      scope: Object.freeze({
        tenantReference: parseCatalogReference(s.tenantReference),
        brandReference: parseCatalogReference(s.brandReference),
        storeReference: parseCatalogReference(s.storeReference),
        actorReference: parseCatalogReference(s.actorReference),
      }),
      locale: parseCatalogLocale(r.locale),
      items,
      hasMore: optionSetListBoolean(r.hasMore),
      nextCursor: r.nextCursor,
    });
  });
}
export interface OptionSetListScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
export interface OptionSetListSelectedScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
function selectedScope(value: unknown): OptionSetListSelectedScope {
  const r = optionSetListRecord(copyProductCommandValue(value), [
    "brandReference",
    "storeReference",
  ]);
  return Object.freeze({
    brandReference: parseCatalogReference(r.brandReference),
    storeReference: parseCatalogReference(r.storeReference),
  });
}
function responseValue<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return fail();
  }
}
function fullScope(value: unknown): OptionSetListScope {
  const r = optionSetListRecord(copyProductCommandValue(value), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ]);
  return Object.freeze({
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    storeReference: parseCatalogReference(r.storeReference),
    actorReference: parseCatalogReference(r.actorReference),
  });
}
export function createOptionSetListClient(fetcher: typeof fetch = globalThis.fetch) {
  if (typeof fetcher !== "function") return fail();
  const transport = fetcher.bind(globalThis);
  return Object.freeze({
    async load(request: {
      readonly filters: unknown;
      readonly expectedScope: unknown;
      readonly csrf: string;
      readonly signal?: AbortSignal;
      readonly expectedFullScope?: unknown;
    }): Promise<OptionSetListView> {
      let filters: OptionSetListRequest,
        scope: OptionSetListSelectedScope,
        expected: OptionSetListScope | undefined;
      try {
        filters = parseOptionSetListRequest(request.filters);
        scope = selectedScope(request.expectedScope);
        if (request.expectedFullScope !== undefined)
          expected = fullScope(request.expectedFullScope);
      } catch {
        return fail("Invalid");
      }
      if (
        expected &&
        (expected.brandReference !== scope.brandReference ||
          expected.storeReference !== scope.storeReference)
      )
        return fail("ScopeChanged");
      if (typeof request.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(request.csrf))
        return fail("Invalid");
      const body = JSON.stringify(filters);
      if (new TextEncoder().encode(body).byteLength > 8192) return fail("Invalid");
      if (request.signal?.aborted) return fail();
      const controller = new AbortController();
      let rejectAbort: ((reason: unknown) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        }),
        abort = () => {
          controller.abort();
          rejectAbort?.(new OptionSetListClientError("Unavailable"));
        };
      request.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await Promise.race([
          transport("/merchant/catalog/option-sets/list", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            body,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": request.csrf,
              "X-BOP-Catalog-Scope": btoa(JSON.stringify(scope))
                .replace(/\+/gu, "-")
                .replace(/\//gu, "_")
                .replace(/=+$/u, ""),
            },
          }),
          aborted,
        ]);
        if (
          controller.signal.aborted ||
          response.headers.get("cache-control") !== "no-store" ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
          !response.body
        )
          return fail();
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          bytes = 0;
        try {
          while (true) {
            const chunk = await Promise.race([reader.read(), aborted]);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 262144) return fail();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (controller.signal.aborted) return fail();
        const value: unknown = JSON.parse(text);
        if (response.status !== 200) {
          const error = responseValue(() => optionSetListRecord(value, ["error"]).error);
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (
            (response.status === 400 || response.status === 413) &&
            error === "option_set_list_invalid"
          )
            return fail("Invalid");
          if (response.status === 409 && error === "option_set_list_feature_disabled")
            return fail("FeatureDisabled");
          if (response.status === 409 && error === "option_set_list_stale") return fail("Stale");
          return fail();
        }
        const view = responseValue(() => parseOptionSetListView(value));
        if (
          view.scope.brandReference !== scope.brandReference ||
          view.scope.storeReference !== scope.storeReference ||
          (expected &&
            (view.scope.tenantReference !== expected.tenantReference ||
              view.scope.actorReference !== expected.actorReference))
        )
          return fail("ScopeChanged");
        if (view.locale !== filters.locale || view.items.length > filters.limit) return fail();
        return view;
      } catch (error) {
        if (error instanceof OptionSetListClientError) throw error;
        return fail();
      } finally {
        controller.abort();
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
      }
    },
  });
}

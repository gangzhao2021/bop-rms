import {
  copyProductCommandValue,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode as code,
  parseCatalogLocale as locale,
  parseLocalizedNames as names,
  productCommandRecord as record,
} from "./catalog-product-command-values.js";
export class ProductOptionPickerError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "FeatureDisabled"
      | "Conflict"
      | "Stale"
      | "ScopeChanged"
      | "Unavailable",
  ) {
    super("Option binding choices could not be loaded");
    this.name = "ProductOptionPickerError";
  }
}
export interface ProductOptionPickerScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
export interface ProductOptionPickerRequest {
  readonly optionSetReference: string;
  readonly versionReference: string | null;
}
export interface ProductOptionPickerView extends ProductOptionPickerScope {
  readonly profile: "CatalogProductOptionBindingPickerV1";
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly bindingReference: string;
  readonly internalCode: string;
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly rootSelectionRule: Readonly<{
    minimumSelection: number;
    maximumSelection: number | null;
    allowRepeatedOption: boolean;
    perOptionMaximumQuantity: number;
    maximumTotalQuantity: number | null;
    displayStyle: "SingleChoice" | "MultiChoice" | "Quantity";
  }>;
  readonly options: readonly Readonly<{
    optionReference: string;
    stableCode: string;
    lifecycle: "Draft" | "Active" | "Inactive" | "Archived";
    localizedNames: Readonly<Record<string, string>>;
    sortOrder: number;
    defaultEligible: boolean;
    quantityRule: Readonly<{ minimumQuantity: number; maximumQuantity: number | null }>;
    selectionDisabled: boolean;
    disabledReason: string | null;
  }>[];
  readonly selectionDisabled: boolean;
  readonly disabledReason: string | null;
  readonly originalRecordDigest: string;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly sourceAuthority: "CurrentPublishingReleaseAndFrozenContent" | "RecordedFrozen";
  readonly publicationReference: string | null;
  readonly referenceEligibility: "NotEvaluated";
  readonly publishValidation: "Incomplete";
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (c: ProductOptionPickerError["code"] = "Invalid"): never => {
  throw new ProductOptionPickerError(c);
};
const integer = (v: unknown, min = 0) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > 2147483647) return fail();
  return v;
};
const optional = (v: unknown) => (v === null ? null : integer(v));
const bool = (v: unknown) => {
  if (typeof v !== "boolean") return fail();
  return v;
};
const digest = (v: unknown) => {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return fail();
  return v;
};
function choice<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) return fail();
  return v as T;
}
export function parseProductOptionPickerScope(v: unknown): ProductOptionPickerScope {
  const r = record(v, ["tenantReference", "brandReference", "storeReference", "actorReference"]);
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
    actorReference: ref(r.actorReference),
  });
}
export function parseProductOptionPickerRequest(v: unknown): ProductOptionPickerRequest {
  const r = record(v, ["optionSetReference", "versionReference"]);
  return Object.freeze({
    optionSetReference: ref(r.optionSetReference),
    versionReference: r.versionReference === null ? null : ref(r.versionReference),
  });
}
export function parseProductOptionPickerView(
  v: unknown,
  requestValue: unknown,
  scopeValue: unknown,
  now = new Date().toISOString(),
): ProductOptionPickerView {
  try {
    const request = parseProductOptionPickerRequest(requestValue),
      scope = parseProductOptionPickerScope(scopeValue),
      r = record(copyProductCommandValue(v), [
        "profile",
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
        "optionSetReference",
        "versionReference",
        "bindingReference",
        "internalCode",
        "defaultLocale",
        "localizedNames",
        "rootSelectionRule",
        "options",
        "selectionDisabled",
        "disabledReason",
        "originalRecordDigest",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "sourceAuthority",
        "publicationReference",
        "referenceEligibility",
        "publishValidation",
        "observedAt",
        "validUntil",
      ]);
    for (const k of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ] as const)
      if (r[k] !== scope[k]) return fail("ScopeChanged");
    const observedAt = instant(r.observedAt),
      validUntil = instant(r.validUntil),
      versionReference = ref(r.versionReference),
      sourceAuthority = choice(r.sourceAuthority, [
        "CurrentPublishingReleaseAndFrozenContent",
        "RecordedFrozen",
      ]),
      publicationReference = r.publicationReference === null ? null : ref(r.publicationReference);
    if (
      observedAt > instant(now) ||
      validUntil <= now ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail("Stale");
    if (
      r.profile !== "CatalogProductOptionBindingPickerV1" ||
      r.optionSetReference !== request.optionSetReference ||
      (request.versionReference !== null && versionReference !== request.versionReference) ||
      sourceAuthority !==
        (request.versionReference === null
          ? "CurrentPublishingReleaseAndFrozenContent"
          : "RecordedFrozen") ||
      (request.versionReference === null
        ? publicationReference === null
        : publicationReference !== null) ||
      r.referenceEligibility !== "NotEvaluated" ||
      r.publishValidation !== "Incomplete"
    )
      return fail();
    const s = record(r.rootSelectionRule, [
        "minimumSelection",
        "maximumSelection",
        "allowRepeatedOption",
        "perOptionMaximumQuantity",
        "maximumTotalQuantity",
        "displayStyle",
      ]),
      rootSelectionRule = Object.freeze({
        minimumSelection: integer(s.minimumSelection),
        maximumSelection: optional(s.maximumSelection),
        allowRepeatedOption: bool(s.allowRepeatedOption),
        perOptionMaximumQuantity: integer(s.perOptionMaximumQuantity, 1),
        maximumTotalQuantity: optional(s.maximumTotalQuantity),
        displayStyle: choice(s.displayStyle, ["SingleChoice", "MultiChoice", "Quantity"]),
      });
    if (
      rootSelectionRule.maximumSelection !== null &&
      rootSelectionRule.maximumSelection < rootSelectionRule.minimumSelection
    )
      return fail();
    const disabled = (flag: unknown, reason: unknown) => {
      const yes = bool(flag);
      if (yes ? reason !== "OptionArchived" && reason !== "OptionSetArchived" : reason !== null)
        return fail();
      return { selectionDisabled: yes, disabledReason: reason === null ? null : String(reason) };
    };
    if (
      !Array.isArray(r.options) ||
      r.options.length > 100 ||
      Object.getPrototypeOf(r.options) !== Array.prototype ||
      Reflect.ownKeys(r.options).length !== r.options.length + 1
    )
      return fail();
    const defaultLocale = locale(r.defaultLocale);
    const options = Object.freeze(
      r.options.map((v) => {
        const o = record(v, [
            "optionReference",
            "stableCode",
            "lifecycle",
            "localizedNames",
            "sortOrder",
            "defaultEligible",
            "quantityRule",
            "selectionDisabled",
            "disabledReason",
          ]),
          q = record(o.quantityRule, ["minimumQuantity", "maximumQuantity"]),
          quantityRule = Object.freeze({
            minimumQuantity: integer(q.minimumQuantity),
            maximumQuantity: optional(q.maximumQuantity),
          }),
          lifecycle = choice(o.lifecycle, ["Draft", "Active", "Inactive", "Archived"]);
        if (
          quantityRule.maximumQuantity !== null &&
          quantityRule.maximumQuantity < quantityRule.minimumQuantity
        )
          return fail();
        const d = disabled(o.selectionDisabled, o.disabledReason);
        if ((lifecycle === "Archived") !== d.selectionDisabled) return fail();
        return Object.freeze({
          optionReference: ref(o.optionReference),
          stableCode: code(o.stableCode),
          lifecycle,
          localizedNames: names(o.localizedNames, defaultLocale),
          sortOrder: integer(o.sortOrder),
          defaultEligible: bool(o.defaultEligible),
          quantityRule,
          ...d,
        });
      }),
    );
    if (
      new Set(options.map((o) => o.optionReference)).size !== options.length ||
      new Set(options.map((o) => o.stableCode)).size !== options.length
    )
      return fail();
    if (r.selectionDisabled ? r.disabledReason !== "OptionSetArchived" : r.disabledReason !== null)
      return fail();
    const localizedNames = names(r.localizedNames, defaultLocale);
    if (
      !Object.hasOwn(localizedNames, defaultLocale) ||
      options.some((o) => !Object.hasOwn(o.localizedNames, defaultLocale))
    )
      return fail();
    return Object.freeze({
      profile: "CatalogProductOptionBindingPickerV1",
      ...scope,
      optionSetReference: request.optionSetReference,
      versionReference,
      bindingReference: ref(r.bindingReference),
      internalCode: code(r.internalCode),
      defaultLocale,
      localizedNames,
      rootSelectionRule,
      options,
      ...disabled(r.selectionDisabled, r.disabledReason),
      originalRecordDigest: digest(r.originalRecordDigest),
      sourceDigest: digest(r.sourceDigest),
      contentDigest: digest(r.contentDigest),
      configurationDigest: digest(r.configurationDigest),
      sourceAuthority,
      publicationReference,
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      observedAt,
      validUntil,
    });
  } catch (e) {
    if (e instanceof ProductOptionPickerError) throw e;
    return fail();
  }
}
export function createProductOptionPickerClient(fetcher: typeof fetch = globalThis.fetch) {
  if (typeof fetcher !== "function") return fail();
  const transport = fetcher.bind(globalThis);
  return Object.freeze({
    async load(input: {
      command: unknown;
      expectedScope: ProductOptionPickerScope;
      csrf: string;
      signal: AbortSignal;
    }): Promise<ProductOptionPickerView> {
      let command, scope;
      try {
        command = parseProductOptionPickerRequest(input.command);
        scope = parseProductOptionPickerScope(input.expectedScope);
      } catch {
        return fail();
      }
      if (!/^[A-Za-z0-9_-]{43}$/u.test(input.csrf)) return fail();
      if (input.signal.aborted) return fail("Unavailable");
      const controller = new AbortController();
      let rejectAbort: ((reason: unknown) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        }),
        abort = () => {
          controller.abort();
          rejectAbort?.(new ProductOptionPickerError("Unavailable"));
        };
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await Promise.race([
          transport("/merchant/catalog/products/option-binding-picker", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            body: JSON.stringify(command),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-BOP-CSRF": input.csrf,
              "X-BOP-Catalog-Scope": btoa(
                JSON.stringify({
                  brandReference: scope.brandReference,
                  storeReference: scope.storeReference,
                }),
              )
                .replace(/\+/gu, "-")
                .replace(/\//gu, "_")
                .replace(/=+$/u, ""),
            },
          }),
          aborted,
        ]);
        if (
          response.headers.get("cache-control") !== "no-store" ||
          !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
          !response.body
        )
          return fail("Unavailable");
        const reader = response.body.getReader(),
          decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0,
          text = "";
        try {
          while (true) {
            const part = await Promise.race([reader.read(), aborted]);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 2097152) return fail("Unavailable");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        if (controller.signal.aborted) return fail("Unavailable");
        const value: unknown = JSON.parse(text);
        if (response.status !== 200) {
          const error = record(value, ["error"]).error;
          if ((response.status === 401 || response.status === 403) && error === "request_denied")
            return fail("Denied");
          if (response.status === 409 && error === "product_option_picker_feature_disabled")
            return fail("FeatureDisabled");
          if (response.status === 409 && error === "product_option_picker_conflict")
            return fail("Conflict");
          if (response.status === 400 && error === "product_option_picker_invalid")
            return fail("Invalid");
          return fail("Unavailable");
        }
        return parseProductOptionPickerView(value, command, scope);
      } catch (e) {
        if (e instanceof ProductOptionPickerError) throw e;
        return fail("Unavailable");
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
      }
    },
  });
}

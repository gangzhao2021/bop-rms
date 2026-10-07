import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode as code,
  parseCatalogLocale as locale,
  parseLocalizedNames as names,
  parseProductOptionBinding,
} from "./catalog-product-command-values.js";
import { parseProductPublicationPeriod as period } from "./product-publication-command-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
import { parseOptionSetAuthoringScope } from "./option-set-authoring-client.js";

export type OptionPriceAuthoringScope = ReturnType<typeof parseOptionSetAuthoringScope>;
export type OptionPriceQueryScope =
  Pick<OptionPriceAuthoringScope, "brandReference" | "storeReference"> | OptionPriceAuthoringScope;
export type OptionPriceAuthoringAction = "CreateDraft" | "ReplaceDraft" | "Publish" | "Archive";
export type OptionPriceAuthoringClientCode =
  | "Invalid"
  | "Denied"
  | "FeatureDisabled"
  | "Conflict"
  | "Unavailable"
  | "OutcomeUnknown"
  | "Stale"
  | "ScopeChanged";
export class OptionPriceAuthoringClientError extends Error {
  constructor(
    readonly code: OptionPriceAuthoringClientCode,
    readonly attemptCode?: OptionPriceAuthoringClientCode,
  ) {
    super("Option price request could not be confirmed");
    this.name = "OptionPriceAuthoringClientError";
  }
}
const fail = (code: OptionPriceAuthoringClientCode = "Invalid"): never => {
  throw new OptionPriceAuthoringClientError(code);
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
// Detached plain JSON only; the bound accommodates the owner's at most 1,000 complete states.
function copy(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 300000 || depth > 16) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 8192) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return fail();
      return v;
    }
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 1000 ||
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
      if (Object.getPrototypeOf(v) !== Object.prototype) return fail();
      const keys = Reflect.ownKeys(v);
      if (keys.length > 128) return fail();
      const result: Record<string, unknown> = {};
      for (const k of keys) {
        if (typeof k !== "string" || k === "__proto__") return fail();
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d?.enumerable || !("value" in d)) return fail();
        result[k] = visit(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  }
  return visit(value, 0);
}
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof OptionPriceAuthoringClientError) throw e;
    return fail();
  }
}
// Only the initial read can discover Tenant/Actor from the authenticated response.
// Command preparation, journals and review requests still require the full scope.
function queryScope(value: unknown): OptionPriceQueryScope {
  const detached = copy(value);
  if (
    detached &&
    typeof detached === "object" &&
    !Array.isArray(detached) &&
    Reflect.ownKeys(detached).length === 2
  ) {
    const r = record(detached, ["brandReference", "storeReference"]);
    return Object.freeze({
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
    });
  }
  return parseOptionSetAuthoringScope(detached);
}
function matchesQueryScope(actual: OptionPriceAuthoringScope, expected: OptionPriceQueryScope) {
  return (
    actual.brandReference === expected.brandReference &&
    actual.storeReference === expected.storeReference &&
    (!("tenantReference" in expected) ||
      (actual.tenantReference === expected.tenantReference &&
        actual.actorReference === expected.actorReference))
  );
}
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  for (const candidate of choices) if (candidate === v) return candidate;
  return fail();
}
const integer = (v: unknown, minimum = 1, maximum = 2147483647): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < minimum || v > maximum)
    return fail();
  return v;
};
const optionalRef = (v: unknown) => (v === null ? null : ref(v));
function hash(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(v)) return fail();
  return v;
}
function minor(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(v) ||
    BigInt(v) > 9223372036854775807n
  )
    return fail();
  return v;
}
function currency(v: unknown) {
  const r = record(v, [
    "currencyCode",
    "minorUnitExponent",
    "metadataVersion",
    "metadataVersionReference",
    "metadataDigest",
  ]);
  if (typeof r.currencyCode !== "string" || !/^[A-Z]{3}$/u.test(r.currencyCode)) return fail();
  return Object.freeze({
    currencyCode: r.currencyCode,
    minorUnitExponent: integer(r.minorUnitExponent, 0, 6),
    metadataVersion: integer(r.metadataVersion, 1, Number.MAX_SAFE_INTEGER),
    metadataVersionReference: ref(r.metadataVersionReference),
    metadataDigest: hash(r.metadataDigest),
  });
}
function content(v: unknown) {
  const r = record(v, [
    "skuReference",
    "scopeKind",
    "scopeReference",
    "channelCode",
    "orderType",
    "unitAmountMinor",
    "includedQuantity",
    "effectivePeriod",
  ]);
  const scopeKind = choice(r.scopeKind, ["Brand", "Store", "StoreGroup", "Region"] as const),
    scopeReference = optionalRef(r.scopeReference);
  if ((scopeKind === "Brand") !== (scopeReference === null)) return fail();
  return Object.freeze({
    skuReference: optionalRef(r.skuReference),
    scopeKind,
    scopeReference,
    channelCode: r.channelCode === null ? null : code(r.channelCode),
    orderType: r.orderType === null ? null : choice(r.orderType, ["DineIn", "Pickup"] as const),
    unitAmountMinor: minor(r.unitAmountMinor),
    includedQuantity: integer(r.includedQuantity, 0),
    effectivePeriod: period(r.effectivePeriod),
  });
}
export function parseOptionPriceAuthoringCommand(value: unknown) {
  return safe(() => {
    const r = record(copy(value), [
      "action",
      "operationReference",
      "ruleReference",
      "expectedAggregateVersion",
      "bindingReference",
      "optionReference",
      "content",
    ]);
    const action = choice(r.action, ["CreateDraft", "ReplaceDraft", "Publish", "Archive"] as const);
    if (
      action === "CreateDraft"
        ? r.bindingReference === null || r.optionReference === null || r.content === null
        : r.bindingReference !== null ||
          r.optionReference !== null ||
          r.expectedAggregateVersion === null ||
          (action === "ReplaceDraft") !== (r.content !== null)
    )
      return fail();
    return Object.freeze({
      action,
      operationReference: ref(r.operationReference),
      ruleReference: ref(r.ruleReference),
      expectedAggregateVersion:
        r.expectedAggregateVersion === null ? null : integer(r.expectedAggregateVersion),
      bindingReference: optionalRef(r.bindingReference),
      optionReference: optionalRef(r.optionReference),
      content: r.content === null ? null : content(r.content),
    });
  });
}
export type OptionPriceAuthoringCommand = ReturnType<typeof parseOptionPriceAuthoringCommand>;
function snapshot(v: unknown) {
  const r = record(v, [
    "ruleReference",
    "versionReference",
    "snapshotDigest",
    "brandReference",
    "bindingReference",
    "optionReference",
    "skuReference",
    "scopeKind",
    "scopeReference",
    "channelCode",
    "orderType",
    "lifecycle",
    "currencyMetadata",
    "unitAmount",
    "includedQuantity",
    "quantityBasis",
    "effectivePeriod",
    "createdAt",
  ]);
  const money = record(r.unitAmount, ["amountMinor", "currencyCode"]),
    metadata = currency(r.currencyMetadata),
    scopeKind = choice(r.scopeKind, ["Brand", "Store", "StoreGroup", "Region"] as const),
    scopeReference = optionalRef(r.scopeReference);
  if (
    money.currencyCode !== metadata.currencyCode ||
    r.quantityBasis !== "PerItemChoice" ||
    (scopeKind === "Brand") !== (scopeReference === null)
  )
    return fail();
  return Object.freeze({
    ruleReference: ref(r.ruleReference),
    versionReference: ref(r.versionReference),
    snapshotDigest: hash(r.snapshotDigest),
    brandReference: ref(r.brandReference),
    bindingReference: ref(r.bindingReference),
    optionReference: ref(r.optionReference),
    skuReference: optionalRef(r.skuReference),
    scopeKind,
    scopeReference,
    channelCode: r.channelCode === null ? null : code(r.channelCode),
    orderType: r.orderType === null ? null : choice(r.orderType, ["DineIn", "Pickup"] as const),
    lifecycle: choice(r.lifecycle, ["Draft", "Published", "Archived"] as const),
    currencyMetadata: metadata,
    unitAmount: Object.freeze({
      amountMinor: minor(money.amountMinor),
      currencyCode: metadata.currencyCode,
    }),
    includedQuantity: integer(r.includedQuantity, 0),
    quantityBasis: "PerItemChoice" as const,
    effectivePeriod: period(r.effectivePeriod),
    createdAt: instant(r.createdAt),
  });
}
function state(v: unknown) {
  const r = record(v, [
    "profile",
    "brandReference",
    "ruleReference",
    "bindingReference",
    "optionReference",
    "aggregateVersion",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
    "draftAuthorActorReference",
    "draft",
    "currentPublished",
    "latestVersion",
  ]);
  if (r.profile !== "OptionPriceAuthoringStateV1") return fail();
  const result = Object.freeze({
    profile: "OptionPriceAuthoringStateV1" as const,
    brandReference: ref(r.brandReference),
    ruleReference: ref(r.ruleReference),
    bindingReference: ref(r.bindingReference),
    optionReference: ref(r.optionReference),
    aggregateVersion: integer(r.aggregateVersion),
    createdAt: instant(r.createdAt),
    createdByActorReference: ref(r.createdByActorReference),
    updatedAt: instant(r.updatedAt),
    draftAuthorActorReference: optionalRef(r.draftAuthorActorReference),
    draft: r.draft === null ? null : snapshot(r.draft),
    currentPublished: r.currentPublished === null ? null : snapshot(r.currentPublished),
    latestVersion: snapshot(r.latestVersion),
  });
  if (
    result.createdAt > result.updatedAt ||
    result.latestVersion.createdAt !== result.updatedAt ||
    (result.draft === null) !== (result.draftAuthorActorReference === null) ||
    (result.draft && result.draft.lifecycle !== "Draft") ||
    (result.currentPublished && result.currentPublished.lifecycle !== "Published") ||
    (result.draft &&
      result.currentPublished &&
      result.draft.versionReference === result.currentPublished.versionReference)
  )
    return fail();
  for (const s of [result.draft, result.currentPublished, result.latestVersion])
    if (
      s &&
      (s.brandReference !== result.brandReference ||
        s.ruleReference !== result.ruleReference ||
        s.bindingReference !== result.bindingReference ||
        s.optionReference !== result.optionReference ||
        s.createdAt < result.createdAt ||
        s.createdAt > result.updatedAt)
    )
      return fail();
  return result;
}
export type OptionPriceAuthoringState = ReturnType<typeof state>;
async function checkDigests(states: readonly OptionPriceAuthoringState[]) {
  for (const s of states)
    for (const version of [s.draft, s.currentPublished, s.latestVersion])
      if (version) {
        const { snapshotDigest, ...wire } = version;
        if ((await digest(wire)) !== snapshotDigest) return fail();
      }
}
function lease(observed: unknown, until: unknown) {
  const observedAt = instant(observed),
    validUntil = instant(until);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  if (Date.now() < Date.parse(observedAt) || Date.now() >= Date.parse(validUntil))
    return fail("Stale");
  return { observedAt, validUntil };
}
function anchor(v: unknown) {
  const r = record(v, ["productReference", "expectedProductAggregateVersion"]);
  return Object.freeze({
    productReference: ref(r.productReference),
    expectedProductAggregateVersion: integer(r.expectedProductAggregateVersion),
  });
}
function selected(v: unknown) {
  const r = record(v, [
    "productReference",
    "expectedProductAggregateVersion",
    "bindingReference",
    "optionReference",
  ]);
  return Object.freeze({
    ...anchor({
      productReference: r.productReference,
      expectedProductAggregateVersion: r.expectedProductAggregateVersion,
    }),
    bindingReference: ref(r.bindingReference),
    optionReference: ref(r.optionReference),
  });
}
function list<T>(v: unknown, parse: (v: unknown) => T, key: (v: T) => string): readonly T[] {
  if (!Array.isArray(v) || v.length > 1000) return fail();
  const result = v.map(parse);
  if (new Set(result.map(key)).size !== result.length) return fail();
  return Object.freeze(result);
}
function context(
  v: unknown,
  scope: OptionPriceAuthoringScope,
  requested: ReturnType<typeof selected>,
) {
  const r = record(v, [
    "profile",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "productReference",
    "productAggregateVersion",
    "productVersionReference",
    "productSnapshotDigest",
    "binding",
    "versionResolution",
    "optionReference",
    "optionSetReference",
    "optionSetVersionReference",
    "optionSourceDigest",
    "optionSourceAuthority",
    "defaultLocale",
    "localizedNames",
    "choices",
    "skus",
    "currencyMetadata",
    "referenceEligibility",
    "publishValidation",
    "observedAt",
    "validUntil",
  ]);
  if (
    r.profile !== "MerchantOptionPriceContextV1" ||
    r.referenceEligibility !== "NotEvaluated" ||
    r.publishValidation !== "Incomplete"
  )
    return fail();
  const actualScope = parseOptionSetAuthoringScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
  if (!same(actualScope, scope)) return fail("ScopeChanged");
  const binding = parseProductOptionBinding(r.binding),
    defaultLocale = locale(r.defaultLocale),
    versionResolution = choice(r.versionResolution, ["Pinned", "CurrentPublished"] as const);
  const choices = list(
    r.choices,
    (v) => {
      const c = record(v, ["optionReference", "stableCode", "lifecycle", "localizedNames"]);
      return Object.freeze({
        optionReference: ref(c.optionReference),
        stableCode: code(c.stableCode),
        lifecycle: choice(c.lifecycle, ["Draft", "Active", "Inactive", "Archived"] as const),
        localizedNames: names(c.localizedNames, defaultLocale),
      });
    },
    (c) => c.optionReference,
  );
  const skus = list(
    r.skus,
    (v) => {
      const s = record(v, ["skuReference", "skuCode", "lifecycle", "localizedNames"]),
        labels = s.localizedNames;
      if (!labels || typeof labels !== "object" || Array.isArray(labels)) return fail();
      const labelLocale = Object.keys(labels)[0];
      if (!labelLocale) return fail();
      return Object.freeze({
        skuReference: ref(s.skuReference),
        skuCode: code(s.skuCode),
        lifecycle: choice(s.lifecycle, [
          "Draft",
          "Active",
          "Suspended",
          "Discontinued",
          "Archived",
        ] as const),
        localizedNames: names(labels, locale(labelLocale)),
      });
    },
    (s) => s.skuReference,
  );
  if (
    new Set(choices.map((c) => c.stableCode)).size !== choices.length ||
    new Set(skus.map((s) => s.skuCode)).size !== skus.length ||
    [...binding.includedSkuReferences, ...binding.excludedSkuReferences].some(
      (id) => !skus.some((s) => s.skuReference === id),
    )
  )
    return fail();
  if (
    r.productReference !== requested.productReference ||
    r.productAggregateVersion !== requested.expectedProductAggregateVersion ||
    binding.bindingReference !== requested.bindingReference ||
    r.optionReference !== requested.optionReference ||
    r.optionSetReference !== binding.optionSetReference ||
    r.optionSetVersionReference !== binding.optionSetVersionReference ||
    choices.length !== binding.enabledOptionReferences.length ||
    choices.some((c) => !binding.enabledOptionReferences.includes(c.optionReference)) ||
    !choices.some((c) => c.optionReference === requested.optionReference) ||
    r.optionSourceAuthority !==
      (versionResolution === "Pinned"
        ? "RecordedFrozen"
        : "CurrentPublishingReleaseAndFrozenContent")
  )
    return fail();
  return Object.freeze({
    profile: "MerchantOptionPriceContextV1" as const,
    ...actualScope,
    productReference: ref(r.productReference),
    productAggregateVersion: integer(r.productAggregateVersion),
    productVersionReference: ref(r.productVersionReference),
    productSnapshotDigest: hash(r.productSnapshotDigest),
    binding,
    versionResolution,
    optionReference: ref(r.optionReference),
    optionSetReference: binding.optionSetReference,
    optionSetVersionReference: binding.optionSetVersionReference,
    optionSourceDigest: hash(r.optionSourceDigest),
    optionSourceAuthority: choice(r.optionSourceAuthority, [
      "RecordedFrozen",
      "CurrentPublishingReleaseAndFrozenContent",
    ] as const),
    defaultLocale,
    localizedNames: names(r.localizedNames, defaultLocale),
    choices,
    skus,
    currencyMetadata: currency(r.currencyMetadata),
    referenceEligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    ...lease(r.observedAt, r.validUntil),
  });
}
export type OptionPriceAuthoringContext = ReturnType<typeof context>;
function queryResult(
  v: unknown,
  scope: OptionPriceQueryScope,
  requested: ReturnType<typeof selected>,
) {
  const r = record(copy(v), [
    "profile",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "context",
    "states",
    "observedAt",
    "validUntil",
  ]);
  if (r.profile !== "MerchantOptionPriceAuthoringQueryV1") return fail();
  const actualScope = parseOptionSetAuthoringScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
  if (!matchesQueryScope(actualScope, scope)) return fail("ScopeChanged");
  const window = lease(r.observedAt, r.validUntil),
    c = context(r.context, actualScope, requested),
    states = list(r.states, state, (s) => s.ruleReference);
  if (
    c.observedAt > window.observedAt ||
    c.validUntil !== window.validUntil ||
    states.some(
      (s) =>
        s.updatedAt > window.observedAt ||
        s.brandReference !== scope.brandReference ||
        s.bindingReference !== requested.bindingReference ||
        s.optionReference !== requested.optionReference,
    )
  )
    return fail();
  return Object.freeze({
    profile: "MerchantOptionPriceAuthoringQueryV1" as const,
    ...actualScope,
    context: c,
    states,
    ...window,
  });
}
export type OptionPriceAuthoringQuery = ReturnType<typeof queryResult>;
function receipt(
  v: unknown,
  scope: OptionPriceAuthoringScope,
  command: OptionPriceAuthoringCommand,
) {
  const r = record(copy(v), [
    "profile",
    "action",
    "operationReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "outcome",
    "state",
    "occurredAt",
    "observedAt",
    "validUntil",
  ]);
  if (
    r.profile !== "MerchantOptionPriceAuthoringResultV1" ||
    r.action !== command.action ||
    r.operationReference !== command.operationReference
  )
    return fail();
  const actualScope = parseOptionSetAuthoringScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
  if (!same(actualScope, scope)) return fail("ScopeChanged");
  const outcome = choice(r.outcome, ["Committed", "Abandoned"] as const),
    s = r.state === null ? null : state(r.state),
    window = lease(r.observedAt, r.validUntil),
    occurredAt = instant(r.occurredAt);
  if ((outcome === "Abandoned") !== (s === null) || occurredAt > window.observedAt) return fail();
  if (
    s &&
    (s.ruleReference !== command.ruleReference ||
      s.brandReference !== scope.brandReference ||
      s.updatedAt !== occurredAt ||
      s.aggregateVersion !== (command.expectedAggregateVersion ?? 0) + 1 ||
      (command.action === "CreateDraft" &&
        (s.bindingReference !== command.bindingReference ||
          s.optionReference !== command.optionReference)) ||
      (command.action === "Publish"
        ? s.latestVersion.lifecycle !== "Published"
        : command.action === "Archive"
          ? s.latestVersion.lifecycle !== "Archived"
          : s.latestVersion.lifecycle !== "Draft"))
  )
    return fail();
  if (
    s &&
    (command.action === "Publish"
      ? s.draft !== null ||
        s.draftAuthorActorReference !== null ||
        !same(s.currentPublished, s.latestVersion)
      : command.action === "Archive"
        ? s.currentPublished !== null
        : !same(s.draft, s.latestVersion) || s.draftAuthorActorReference !== scope.actorReference)
  )
    return fail();
  if (
    s &&
    command.action === "CreateDraft" &&
    command.expectedAggregateVersion === null &&
    (s.createdAt !== occurredAt || s.createdByActorReference !== scope.actorReference)
  )
    return fail();
  if (s && command.content) {
    const actual = s.latestVersion,
      proposed = command.content;
    if (
      !same(proposed, {
        skuReference: actual.skuReference,
        scopeKind: actual.scopeKind,
        scopeReference: actual.scopeReference,
        channelCode: actual.channelCode,
        orderType: actual.orderType,
        unitAmountMinor: actual.unitAmount.amountMinor,
        includedQuantity: actual.includedQuantity,
        effectivePeriod: actual.effectivePeriod,
      })
    )
      return fail();
  }
  return Object.freeze({
    profile: "MerchantOptionPriceAuthoringResultV1" as const,
    action: command.action,
    operationReference: command.operationReference,
    ...actualScope,
    outcome,
    state: s,
    occurredAt,
    ...window,
  });
}
export type OptionPriceAuthoringResult = ReturnType<typeof receipt>;
function scopeResult(value: unknown, expected: OptionPriceQueryScope) {
  const r = record(copy(value), [
    "profile",
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "observedAt",
    "validUntil",
  ]);
  if (r.profile !== "MerchantOptionPriceScopeV1") return fail();
  const scope = parseOptionSetAuthoringScope({
    tenantReference: r.tenantReference,
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    actorReference: r.actorReference,
  });
  if (!matchesQueryScope(scope, expected)) return fail("ScopeChanged");
  return Object.freeze({
    profile: "MerchantOptionPriceScopeV1" as const,
    ...scope,
    ...lease(r.observedAt, r.validUntil),
  });
}
export type OptionPriceScopeResult = ReturnType<typeof scopeResult>;
export interface OptionPriceRequestControl {
  readonly csrf: string;
  readonly signal?: AbortSignal;
}
export function createOptionPriceAuthoringClient(fetcher: typeof fetch = globalThis.fetch) {
  const transport = fetcher.bind(globalThis),
    definitive = new WeakSet<OptionPriceAuthoringClientError>();
  function serverError(code: OptionPriceAuthoringClientCode): never {
    const error = new OptionPriceAuthoringClientError(code);
    definitive.add(error);
    throw error;
  }
  async function post(
    path: string,
    body: string,
    scope: OptionPriceQueryScope,
    control: OptionPriceRequestControl,
  ) {
    if (typeof control.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(control.csrf))
      return fail();
    if (control.signal?.aborted) return fail("Unavailable");
    const controller = new AbortController();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      controller.abort();
      rejectAbort?.(new OptionPriceAuthoringClientError("Unavailable"));
    };
    control.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await Promise.race([
        transport(path, {
          method: "POST",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": control.csrf,
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
          body,
        }),
        aborted,
      ]);
      if (
        controller.signal.aborted ||
        response.headers.get("cache-control") !== "no-store" ||
        !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        !response.body
      )
        return fail("Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8388608) return fail("Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(text);
      if (response.status !== 200) {
        const error = record(copy(value), ["error"]).error;
        if ((response.status === 401 || response.status === 403) && error === "request_denied")
          return serverError("Denied");
        if (response.status === 409 && error === "option_price_conflict")
          return serverError("Conflict");
        if (response.status === 409 && error === "option_price_feature_disabled")
          return serverError("FeatureDisabled");
        if (
          (response.status === 400 || response.status === 413) &&
          error === "option_price_invalid"
        )
          return serverError("Invalid");
        return fail("Unavailable");
      }
      return value;
    } catch (e) {
      if (e instanceof OptionPriceAuthoringClientError) throw e;
      return fail("Unavailable");
    } finally {
      controller.abort();
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
    }
  }
  const serialize = (value: unknown) => {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > 8192) return fail();
    return body;
  };
  return Object.freeze({
    async scope(input: OptionPriceRequestControl & { readonly expectedScope: unknown }) {
      const expected = safe(() => queryScope(input.expectedScope)),
        raw = await post("/merchant/pricing/option-prices/scope", "{}", expected, input);
      try {
        const result = scopeResult(raw, expected);
        if (!same(queryScope(input.expectedScope), expected)) return fail("ScopeChanged");
        if (input.signal?.aborted) return fail("Unavailable");
        return result;
      } catch (error) {
        if (
          error instanceof OptionPriceAuthoringClientError &&
          (error.code === "ScopeChanged" || error.code === "Stale")
        )
          throw error;
        return fail("Unavailable");
      }
    },
    async query(
      input: OptionPriceRequestControl & {
        readonly context: unknown;
        readonly expectedScope: unknown;
      },
    ) {
      const scope = safe(() => queryScope(input.expectedScope)),
        requested = safe(() => selected(copy(input.context)));
      const raw = await post(
        "/merchant/pricing/option-prices/current",
        serialize({ context: requested }),
        scope,
        input,
      );
      try {
        const result = queryResult(raw, scope, requested);
        await checkDigests(result.states);
        lease(result.observedAt, result.validUntil);
        if (!same(queryScope(input.expectedScope), scope)) return fail("ScopeChanged");
        if (input.signal?.aborted) return fail("Unavailable");
        return result;
      } catch (e) {
        if (
          e instanceof OptionPriceAuthoringClientError &&
          (e.code === "ScopeChanged" || e.code === "Stale")
        )
          throw e;
        return fail("Unavailable");
      }
    },
    prepare(input: {
      readonly command: unknown;
      readonly context: unknown;
      readonly expectedScope: unknown;
    }) {
      const scope = safe(() => parseOptionSetAuthoringScope(copy(input.expectedScope))),
        command = parseOptionPriceAuthoringCommand(input.command),
        qualification = safe(() => anchor(copy(input.context))),
        body = serialize({ command, context: qualification }),
        resolveBody = serialize({ command });
      let pending = false,
        active = false;
      async function attempt(
        resolve: boolean,
        control: OptionPriceRequestControl & { readonly scope?: unknown },
      ) {
        if (active) return fail(pending ? "OutcomeUnknown" : "Unavailable");
        if (control.scope !== undefined) {
          let matches: boolean;
          try {
            matches = same(parseOptionSetAuthoringScope(copy(control.scope)), scope);
          } catch {
            return fail("ScopeChanged");
          }
          if (!matches) return fail("ScopeChanged");
        }
        if (control.signal?.aborted) return fail(pending ? "OutcomeUnknown" : "Unavailable");
        if (typeof control.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(control.csrf)) {
          if (pending) throw new OptionPriceAuthoringClientError("OutcomeUnknown", "Invalid");
          return fail();
        }
        active = true;
        const wasPending = pending;
        // Once sent, only an authenticated original terminal receipt can settle uncertainty.
        pending = true;
        try {
          const raw = await post(
              resolve
                ? "/merchant/pricing/option-prices/resolve"
                : "/merchant/pricing/option-prices/command",
              resolve ? resolveBody : body,
              scope,
              control,
            ),
            result = receipt(raw, scope, command);
          await checkDigests(result.state ? [result.state] : []);
          lease(result.observedAt, result.validUntil);
          if (control.signal?.aborted) return fail("Unavailable");
          if (
            control.scope !== undefined &&
            !same(parseOptionSetAuthoringScope(copy(control.scope)), scope)
          )
            return fail("ScopeChanged");
          pending = false;
          return result;
        } catch (e) {
          const attemptCode = e instanceof OptionPriceAuthoringClientError ? e.code : "Unavailable";
          if (
            !wasPending &&
            !resolve &&
            e instanceof OptionPriceAuthoringClientError &&
            definitive.has(e)
          ) {
            pending = false;
            throw e;
          }
          throw new OptionPriceAuthoringClientError("OutcomeUnknown", attemptCode);
        } finally {
          active = false;
        }
      }
      return Object.freeze({
        command,
        context: qualification,
        scope,
        get pending() {
          return pending;
        },
        execute: (control: OptionPriceRequestControl & { readonly scope?: unknown }) =>
          attempt(false, control),
        resolve: (control: OptionPriceRequestControl & { readonly scope?: unknown }) =>
          attempt(true, control),
      });
    },
  });
}

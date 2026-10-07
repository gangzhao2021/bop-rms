import {
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogLocale,
  parseCatalogCode,
  parseLocalizedNames,
} from "./catalog-product-command-values.js";
import { parseProductPublicationPeriod as period } from "./product-publication-command-client.js";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as hashValue,
} from "./product-publication-command-client-v2.js";
import { parseStoreSetupScope, type StoreSetupScope } from "./store-setup-client.js";

export type TaxConfigAuthoringScope = StoreSetupScope;
export class TaxConfigAuthoringClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "FeatureDisabled"
      | "Conflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged"
      | "Stale",
  ) {
    super("Tax Draft request could not be confirmed");
    this.name = "TaxConfigAuthoringClientError";
  }
}
const fail = (code: TaxConfigAuthoringClientError["code"] = "Invalid"): never => {
  throw new TaxConfigAuthoringClientError(code);
};
function safe<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof TaxConfigAuthoringClientError) throw e;
    return fail();
  }
}
async function digest(value: unknown): Promise<string> {
  try {
    return await hashValue(value);
  } catch {
    return fail("Unavailable");
  }
}
const scopeKeys = ["tenantReference", "brandReference", "storeReference", "actorReference"];
const ruleKeys = [
  "taxClassificationReference",
  "orderType",
  "chargeType",
  "taxComponentCode",
  "treatment",
  "rate",
  "priceInclusion",
  "roundingMode",
  "calculationOrder",
  "compoundOnPriorTax",
  "exceptionEvidenceReference",
  "receiptPresentationCode",
] as const;
const optionalRef = (value: unknown) => (value === null ? null : ref(value));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const integer = (v: unknown, min = 1, max = 2147483647) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const hash = (v: unknown) =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const code = (v: unknown) =>
  typeof v === "string" && v.length <= 64 && /^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*$/u.test(v)
    ? v
    : fail();
function choice<const T extends string>(v: unknown, choices: readonly T[]): T {
  for (const c of choices) if (c === v) return c;
  return fail();
}
function copy(value: unknown, maximumBytes = 65536): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 300000 || depth > 16) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 16384 ? v : fail();
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (!v || typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 4096 ||
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
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (typeof key !== "string" || key === "__proto__" || !d?.enumerable || !("value" in d))
          return fail();
        result[key] = visit(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(canonical(result)).length > maximumBytes) return fail();
  return result;
}
const scopeFrom = (r: Record<string, unknown>) =>
  parseStoreSetupScope(Object.fromEntries(scopeKeys.map((key) => [key, r[key]])));
export interface TaxConfigAuthoringRule {
  readonly taxClassificationReference: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly chargeType: "Sellable" | "ServiceCharge" | "DeliveryFee" | "Tip";
  readonly taxComponentCode: string;
  readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
  readonly rate: string;
  readonly priceInclusion: "Exclusive" | "Inclusive";
  readonly roundingMode: "HalfUp" | "HalfEven" | "TowardZero" | "AwayFromZero";
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly exceptionEvidenceReference: string | null;
  readonly receiptPresentationCode: string;
}
export interface TaxConfigAuthoringContent {
  readonly stableCode: string;
  readonly effectivePeriod: ReturnType<typeof period>;
  readonly rules: readonly TaxConfigAuthoringRule[];
}
export interface TaxConfigAuthoringCommand {
  readonly action: "CreateDraft" | "ReplaceDraft";
  readonly operationReference: string;
  readonly configurationReference: string | null;
  readonly expectedAggregateVersion: number | null;
  readonly content: TaxConfigAuthoringContent;
}
export interface TaxConfigAuthoringResolve extends Omit<TaxConfigAuthoringCommand, "content"> {
  readonly intentDigest: string;
}
export interface TaxConfigAuthoringCursor extends TaxConfigAuthoringResolve {
  readonly profile: "TaxConfigAuthoringPendingOriginalV1";
  readonly scope: TaxConfigAuthoringScope;
}
export interface PreparedTaxConfigAuthoringCommand {
  readonly scope: TaxConfigAuthoringScope;
  readonly command: TaxConfigAuthoringCommand;
  readonly intentDigest: string;
  readonly cursor: TaxConfigAuthoringCursor;
}
export interface TaxConfigDraftSnapshot {
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly stableCode: string;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: string;
  readonly lifecycle: "Draft";
  readonly jurisdictionCode: "CA-ON";
  readonly currencyMetadata: Readonly<{
    currencyCode: "CAD";
    minorUnitExponent: number;
    metadataVersion: number;
    metadataVersionReference: string;
    metadataDigest: string;
  }>;
  readonly effectivePeriod: ReturnType<typeof period>;
  readonly registrationEvidence: null;
  readonly professionalEvidence: null;
  readonly rules: readonly (TaxConfigAuthoringRule & { readonly ruleReference: string })[];
  readonly createdAt: string;
}
export interface TaxConfigAuthoringState {
  readonly profile: "TaxConfigAuthoringStateV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly draftAuthorActorReference: string;
  readonly snapshot: TaxConfigDraftSnapshot;
}
export interface TaxConfigAuthoringCurrent extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringCurrentV1";
  readonly configurationReference: string | null;
  readonly state: TaxConfigAuthoringState | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export interface TaxConfigAuthoringRoster extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringRosterV1";
  readonly afterConfiguration: string | null;
  readonly entries: readonly TaxConfigAuthoringState[];
  readonly nextAfterConfiguration: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export interface TaxConfigAuthoringReceipt
  extends TaxConfigAuthoringScope, Omit<TaxConfigAuthoringCommand, "content"> {
  readonly profile: "TaxConfigAuthoringOperationV1";
  readonly command: TaxConfigAuthoringCommand | null;
  readonly intentDigest: string;
  readonly serviceIntentDigest: string | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: TaxConfigDraftSnapshot | null;
  readonly auditReference: string;
  readonly eventReference: string | null;
  readonly occurredAt: string;
}
function pins(r: Record<string, unknown>): Omit<TaxConfigAuthoringCommand, "content"> {
  const action = choice(r.action, ["CreateDraft", "ReplaceDraft"]),
    configurationReference = optionalRef(r.configurationReference),
    expectedAggregateVersion =
      r.expectedAggregateVersion === null
        ? null
        : integer(r.expectedAggregateVersion, 1, 2147483646);
  if (
    action === "CreateDraft"
      ? configurationReference !== null || expectedAggregateVersion !== null
      : configurationReference === null || expectedAggregateVersion === null
  )
    return fail();
  return {
    action,
    operationReference: ref(r.operationReference),
    configurationReference,
    expectedAggregateVersion,
  };
}
function rule(value: unknown): TaxConfigAuthoringRule {
  const r = record(value, ruleKeys),
    rate = r.rate;
  if (
    typeof rate !== "string" ||
    !/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?$/u.test(rate) ||
    typeof r.compoundOnPriorTax !== "boolean"
  )
    return fail();
  const treatment = choice(r.treatment, ["Taxable", "Exempt", "ZeroRated"]),
    calculationOrder = integer(r.calculationOrder, 1, 16),
    exceptionEvidenceReference = optionalRef(r.exceptionEvidenceReference);
  if (
    (calculationOrder === 1 && r.compoundOnPriorTax) ||
    (treatment === "Taxable"
      ? exceptionEvidenceReference !== null
      : rate !== "0" || exceptionEvidenceReference === null)
  )
    return fail();
  return Object.freeze({
    taxClassificationReference: ref(r.taxClassificationReference),
    orderType: choice(r.orderType, ["DineIn", "Pickup"]),
    chargeType: choice(r.chargeType, ["Sellable", "ServiceCharge", "DeliveryFee", "Tip"]),
    taxComponentCode: code(r.taxComponentCode),
    treatment,
    rate,
    priceInclusion: choice(r.priceInclusion, ["Exclusive", "Inclusive"]),
    roundingMode: choice(r.roundingMode, ["HalfUp", "HalfEven", "TowardZero", "AwayFromZero"]),
    calculationOrder,
    compoundOnPriorTax: r.compoundOnPriorTax,
    exceptionEvidenceReference,
    receiptPresentationCode: code(r.receiptPresentationCode),
  });
}
function groups(rules: readonly TaxConfigAuthoringRule[]) {
  const g = new Map<string, TaxConfigAuthoringRule[]>();
  for (const r of rules) {
    const k = `${r.taxClassificationReference}|${r.orderType}|${r.chargeType}`,
      v = g.get(k) ?? [];
    v.push(r);
    g.set(k, v);
  }
  for (const v of g.values())
    if (
      [...v]
        .sort((a, b) => a.calculationOrder - b.calculationOrder)
        .some((r, i) => r.calculationOrder !== i + 1) ||
      new Set(v.map((r) => r.taxComponentCode)).size !== v.length ||
      new Set(v.map((r) => r.priceInclusion)).size !== 1
    )
      return fail();
}
export function parseTaxConfigAuthoringContent(value: unknown): TaxConfigAuthoringContent {
  return safe(() => {
    const r = record(copy(value), ["stableCode", "effectivePeriod", "rules"]);
    if (!Array.isArray(r.rules) || r.rules.length > 256) return fail();
    const rules = Object.freeze(r.rules.map(rule));
    groups(rules);
    return Object.freeze({
      stableCode: code(r.stableCode),
      effectivePeriod: period(r.effectivePeriod),
      rules,
    });
  });
}
export function parseTaxConfigAuthoringCommand(value: unknown): TaxConfigAuthoringCommand {
  return safe(() => {
    const r = record(copy(value), [
      "action",
      "operationReference",
      "configurationReference",
      "expectedAggregateVersion",
      "content",
    ]);
    return Object.freeze({ ...pins(r), content: parseTaxConfigAuthoringContent(r.content) });
  });
}
export function parseTaxConfigAuthoringResolve(value: unknown): TaxConfigAuthoringResolve {
  return safe(() => {
    const r = record(value, [
      "action",
      "operationReference",
      "configurationReference",
      "expectedAggregateVersion",
      "intentDigest",
    ]);
    return Object.freeze({ ...pins(r), intentDigest: hash(r.intentDigest) });
  });
}
export function parseTaxConfigAuthoringCursor(value: unknown): TaxConfigAuthoringCursor {
  return safe(() => {
    const r = record(value, [
      "profile",
      "scope",
      "action",
      "operationReference",
      "configurationReference",
      "expectedAggregateVersion",
      "intentDigest",
    ]);
    if (r.profile !== "TaxConfigAuthoringPendingOriginalV1") return fail();
    return Object.freeze({
      profile: "TaxConfigAuthoringPendingOriginalV1",
      scope: parseStoreSetupScope(r.scope),
      ...pins(r),
      intentDigest: hash(r.intentDigest),
    });
  });
}
export function parseTaxConfigDraftSnapshot(value: unknown): TaxConfigDraftSnapshot {
  return safe(() => {
    const r = record(copy(value), [
      "configurationReference",
      "versionReference",
      "brandReference",
      "storeReference",
      "stableCode",
      "aggregateVersion",
      "versionNumber",
      "snapshotDigest",
      "lifecycle",
      "jurisdictionCode",
      "currencyMetadata",
      "effectivePeriod",
      "registrationEvidence",
      "professionalEvidence",
      "rules",
      "createdAt",
    ]);
    if (
      r.lifecycle !== "Draft" ||
      r.jurisdictionCode !== "CA-ON" ||
      r.registrationEvidence !== null ||
      r.professionalEvidence !== null ||
      !Array.isArray(r.rules) ||
      r.rules.length > 256
    )
      return fail();
    const m = record(r.currencyMetadata, [
      "currencyCode",
      "minorUnitExponent",
      "metadataVersion",
      "metadataVersionReference",
      "metadataDigest",
    ]);
    if (m.currencyCode !== "CAD") return fail();
    const currencyMetadata = Object.freeze({
      currencyCode: "CAD" as const,
      minorUnitExponent: integer(m.minorUnitExponent, 0, 6),
      metadataVersion: integer(m.metadataVersion, 1, Number.MAX_SAFE_INTEGER),
      metadataVersionReference: ref(m.metadataVersionReference),
      metadataDigest: hash(m.metadataDigest),
    });
    const rules = Object.freeze(
      r.rules.map((value) => {
        const v = record(value, ["ruleReference", ...ruleKeys]);
        return Object.freeze({
          ruleReference: ref(v.ruleReference),
          ...rule(Object.fromEntries(ruleKeys.map((key) => [key, v[key]]))),
        });
      }),
    );
    if (new Set(rules.map((r) => r.ruleReference)).size !== rules.length) return fail();
    groups(rules);
    return Object.freeze({
      configurationReference: ref(r.configurationReference),
      versionReference: ref(r.versionReference),
      brandReference: ref(r.brandReference),
      storeReference: ref(r.storeReference),
      stableCode: code(r.stableCode),
      aggregateVersion: integer(r.aggregateVersion),
      versionNumber: integer(r.versionNumber),
      snapshotDigest: hash(r.snapshotDigest),
      lifecycle: "Draft",
      jurisdictionCode: "CA-ON",
      currencyMetadata,
      effectivePeriod: period(r.effectivePeriod),
      registrationEvidence: null,
      professionalEvidence: null,
      rules,
      createdAt: instant(r.createdAt),
    });
  });
}
export function parseTaxConfigAuthoringState(value: unknown): TaxConfigAuthoringState {
  return safe(() => {
    const r = record(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "draftAuthorActorReference",
      "snapshot",
    ]);
    if (r.profile !== "TaxConfigAuthoringStateV1") return fail();
    const tenantReference = ref(r.tenantReference),
      brandReference = ref(r.brandReference),
      storeReference = ref(r.storeReference),
      snapshot = parseTaxConfigDraftSnapshot(r.snapshot);
    if (snapshot.brandReference !== brandReference || snapshot.storeReference !== storeReference)
      return fail();
    return Object.freeze({
      profile: "TaxConfigAuthoringStateV1",
      tenantReference,
      brandReference,
      storeReference,
      draftAuthorActorReference: ref(r.draftAuthorActorReference),
      snapshot,
    });
  });
}
function window(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    Date.parse(validUntil) <= Date.parse(observedAt) ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  return { observedAt, validUntil };
}
function stateScope(state: TaxConfigAuthoringState, scope: TaxConfigAuthoringScope, at: string) {
  if (
    state.tenantReference !== scope.tenantReference ||
    state.brandReference !== scope.brandReference ||
    state.storeReference !== scope.storeReference ||
    state.snapshot.createdAt > at
  )
    return fail();
}
export function parseTaxConfigAuthoringCurrent(
  value: unknown,
  scopeValue: TaxConfigAuthoringScope,
  configurationReference: string | null,
): TaxConfigAuthoringCurrent {
  return safe(() => {
    const r = record(copy(value, 196608), [
        "profile",
        ...scopeKeys,
        "configurationReference",
        "state",
        "observedAt",
        "validUntil",
        "referenceEligibility",
      ]),
      scope = scopeFrom(r),
      expected = parseStoreSetupScope(scopeValue),
      configuration = optionalRef(r.configurationReference),
      state = r.state === null ? null : parseTaxConfigAuthoringState(r.state),
      w = window(r);
    if (
      r.profile !== "TaxConfigAuthoringCurrentV1" ||
      r.referenceEligibility !== "NotEvaluated" ||
      !same(scope, expected) ||
      configuration !== optionalRef(configurationReference)
    )
      return fail();
    if (state) {
      stateScope(state, scope, w.observedAt);
      if (state.snapshot.configurationReference !== configuration) return fail();
    }
    return Object.freeze({
      profile: "TaxConfigAuthoringCurrentV1",
      ...scope,
      configurationReference: configuration,
      state,
      ...w,
      referenceEligibility: "NotEvaluated",
    });
  });
}
export function parseTaxConfigAuthoringRoster(
  value: unknown,
  scopeValue: TaxConfigAuthoringScope,
  afterValue: string | null,
): TaxConfigAuthoringRoster {
  return safe(() => {
    const r = record(copy(value, 1048576), [
        "profile",
        ...scopeKeys,
        "afterConfiguration",
        "entries",
        "nextAfterConfiguration",
        "observedAt",
        "validUntil",
        "referenceEligibility",
      ]),
      scope = scopeFrom(r),
      afterConfiguration = optionalRef(r.afterConfiguration),
      nextAfterConfiguration = optionalRef(r.nextAfterConfiguration),
      w = window(r);
    if (
      r.profile !== "TaxConfigAuthoringRosterV1" ||
      r.referenceEligibility !== "NotEvaluated" ||
      !same(scope, parseStoreSetupScope(scopeValue)) ||
      afterConfiguration !== optionalRef(afterValue) ||
      !Array.isArray(r.entries) ||
      r.entries.length > 50
    )
      return fail();
    const entries = Object.freeze(r.entries.map(parseTaxConfigAuthoringState));
    let previous = afterConfiguration;
    for (const entry of entries) {
      stateScope(entry, scope, w.observedAt);
      if (previous !== null && entry.snapshot.configurationReference <= previous) return fail();
      previous = entry.snapshot.configurationReference;
    }
    if (
      nextAfterConfiguration !== null &&
      (entries.length !== 50 || nextAfterConfiguration !== previous)
    )
      return fail();
    return Object.freeze({
      profile: "TaxConfigAuthoringRosterV1",
      ...scope,
      afterConfiguration,
      entries,
      nextAfterConfiguration,
      ...w,
      referenceEligibility: "NotEvaluated",
    });
  });
}
export async function validateTaxConfigDraftSnapshot(
  value: unknown,
): Promise<TaxConfigDraftSnapshot> {
  const snapshot = parseTaxConfigDraftSnapshot(value),
    { snapshotDigest, ...body } = snapshot;
  if ((await digest(body)) !== snapshotDigest) return fail();
  return snapshot;
}
export async function validateTaxConfigAuthoringReceipt(
  value: unknown,
  cursorValue: TaxConfigAuthoringCursor,
): Promise<TaxConfigAuthoringReceipt> {
  const cursor = parseTaxConfigAuthoringCursor(cursorValue);
  const parsed = safe(() => {
    const r = record(copy(value, 196608), [
        "profile",
        ...scopeKeys,
        "action",
        "operationReference",
        "configurationReference",
        "expectedAggregateVersion",
        "command",
        "intentDigest",
        "serviceIntentDigest",
        "outcome",
        "snapshot",
        "auditReference",
        "eventReference",
        "occurredAt",
      ]),
      scope = scopeFrom(r),
      p = pins(r),
      command = r.command === null ? null : parseTaxConfigAuthoringCommand(r.command),
      snapshot = r.snapshot === null ? null : parseTaxConfigDraftSnapshot(r.snapshot),
      serviceIntentDigest = r.serviceIntentDigest === null ? null : hash(r.serviceIntentDigest),
      eventReference = optionalRef(r.eventReference),
      outcome = choice(r.outcome, ["Committed", "Abandoned"]),
      occurredAt = instant(r.occurredAt);
    if (
      r.profile !== "TaxConfigAuthoringOperationV1" ||
      !same(scope, cursor.scope) ||
      hash(r.intentDigest) !== cursor.intentDigest
    )
      return fail();
    for (const key of [
      "action",
      "operationReference",
      "configurationReference",
      "expectedAggregateVersion",
    ] as const)
      if (p[key] !== cursor[key]) return fail();
    if (
      outcome === "Abandoned"
        ? command !== null ||
          snapshot !== null ||
          eventReference !== null ||
          serviceIntentDigest !== null
        : command === null ||
          snapshot === null ||
          eventReference === null ||
          serviceIntentDigest === null
    )
      return fail();
    if (command && snapshot) {
      for (const key of [
        "action",
        "operationReference",
        "configurationReference",
        "expectedAggregateVersion",
      ] as const)
        if (command[key] !== p[key]) return fail();
      if (
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.createdAt !== occurredAt ||
        snapshot.aggregateVersion !==
          (p.expectedAggregateVersion === null ? 1 : p.expectedAggregateVersion + 1) ||
        (p.configurationReference !== null &&
          snapshot.configurationReference !== p.configurationReference)
      )
        return fail();
      if (
        !same(
          command.content,
          parseTaxConfigAuthoringContent({
            stableCode: snapshot.stableCode,
            effectivePeriod: snapshot.effectivePeriod,
            rules: snapshot.rules.map((r) =>
              Object.fromEntries(ruleKeys.map((key) => [key, r[key]])),
            ),
          }),
        )
      )
        return fail();
    }
    return Object.freeze({
      profile: "TaxConfigAuthoringOperationV1" as const,
      ...scope,
      ...p,
      command,
      intentDigest: cursor.intentDigest,
      serviceIntentDigest,
      outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      eventReference,
      occurredAt,
    });
  });
  if (
    parsed.command &&
    (await digest({ scope: cursor.scope, command: parsed.command })) !== cursor.intentDigest
  )
    return fail();
  if (parsed.snapshot) await validateTaxConfigDraftSnapshot(parsed.snapshot);
  return parsed;
}
export interface TaxConfigClassificationChoices {
  readonly profile: "TaxConfigClassificationChoicesV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly registryReference: string;
  readonly versionReference: string;
  readonly registryVersion: number;
  readonly snapshotDigest: string;
  readonly defaultLocale: string;
  readonly choices: readonly {
    readonly classificationReference: string;
    readonly code: string;
    readonly localizedNames: ReturnType<typeof parseLocalizedNames>;
    readonly lifecycle: "Active" | "Inactive" | "Retired";
  }[];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export interface TaxConfigDraftFixture {
  readonly profile: "TaxDraftFixtureV1";
  readonly fixtureReference: string;
  readonly kind: "Basket" | "Refund";
  readonly evaluatedAt: string;
  readonly lines: readonly {
    readonly lineReference: string;
    readonly calculationReferences: readonly string[];
    readonly labelCode: string;
    readonly taxClassificationReference: string;
    readonly orderType: "DineIn" | "Pickup";
    readonly chargeType: "Sellable" | "ServiceCharge" | "DeliveryFee" | "Tip";
    readonly amountMinor: string;
  }[];
}
export interface TaxConfigSimulationCommand {
  readonly configurationReference: string;
  readonly expectedVersionReference: string;
  readonly expectedSnapshotDigest: string;
  readonly fixture: TaxConfigDraftFixture;
}
export interface TaxConfigAuthoringSimulation {
  readonly profile: "TaxConfigAuthoringSimulationV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly snapshotDigest: string;
  readonly simulation: {
    readonly profile: "TaxDraftFixtureSimulationV1";
    readonly fixtureReference: string;
    readonly kind: "Basket" | "Refund";
    readonly configurationReference: string;
    readonly versionReference: string;
    readonly snapshotDigest: string;
    readonly netAmountMinor: string;
    readonly taxAmountMinor: string;
    readonly grossAmountMinor: string;
    readonly receiptPreview: readonly {
      readonly lineReference: string;
      readonly labelCode: string;
      readonly componentCode: string;
      readonly treatment: "Taxable" | "Exempt" | "ZeroRated";
      readonly rate: string;
      readonly taxAmountMinor: string;
    }[];
    readonly professionalReviewStatus: "NotEvaluated";
    readonly legalConclusion: "NotEvaluated";
  };
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
function scopedRecord(value: unknown, keys: readonly string[], scope: TaxConfigAuthoringScope) {
  const r = record(copy(value, 1048576), keys);
  if (!same(scopeFrom(r), scope)) return fail("ScopeChanged");
  return r;
}
export function parseTaxConfigClassificationChoices(
  value: unknown,
  scope: TaxConfigAuthoringScope,
): TaxConfigClassificationChoices {
  return safe(() => {
    const r = scopedRecord(
      value,
      [
        "profile",
        ...scopeKeys,
        "registryReference",
        "versionReference",
        "registryVersion",
        "snapshotDigest",
        "defaultLocale",
        "choices",
        "observedAt",
        "validUntil",
        "sourceQualification",
      ],
      scope,
    );
    if (
      r.profile !== "TaxConfigClassificationChoicesV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      !Array.isArray(r.choices) ||
      r.choices.length > 1000
    )
      return fail();
    const defaultLocale = parseCatalogLocale(r.defaultLocale),
      ids = new Set<string>(),
      codes = new Set<string>();
    const choices = r.choices.map((v) => {
      const c = record(v, ["classificationReference", "code", "localizedNames", "lifecycle"]),
        classificationReference = ref(c.classificationReference),
        stableCode = parseCatalogCode(c.code);
      if (ids.has(classificationReference) || codes.has(stableCode)) return fail();
      ids.add(classificationReference);
      codes.add(stableCode);
      return Object.freeze({
        classificationReference,
        code: stableCode,
        localizedNames: parseLocalizedNames(c.localizedNames, defaultLocale),
        lifecycle: choice(c.lifecycle, ["Active", "Inactive", "Retired"]),
      });
    });
    return Object.freeze({
      profile: "TaxConfigClassificationChoicesV1",
      ...scope,
      registryReference: ref(r.registryReference),
      versionReference: ref(r.versionReference),
      registryVersion: integer(r.registryVersion),
      snapshotDigest: hash(r.snapshotDigest),
      defaultLocale,
      choices: Object.freeze(choices),
      ...window(r),
      sourceQualification: "NotEvaluated",
    });
  });
}
function minor(value: unknown): string {
  if (typeof value !== "string" || value.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/u.test(value))
    return fail();
  const n = BigInt(value);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) return fail();
  return value;
}
export function parseTaxConfigDraftFixture(value: unknown): TaxConfigDraftFixture {
  return safe(() => {
    const r = record(copy(value, 131072), [
      "profile",
      "fixtureReference",
      "kind",
      "evaluatedAt",
      "lines",
    ]);
    if (
      r.profile !== "TaxDraftFixtureV1" ||
      !Array.isArray(r.lines) ||
      r.lines.length < 1 ||
      r.lines.length > 256
    )
      return fail();
    const fixtureReference = ref(r.fixtureReference),
      kind = choice(r.kind, ["Basket", "Refund"]),
      used = new Set([fixtureReference]);
    const unique = (v: unknown) => {
      const id = ref(v);
      if (used.has(id)) return fail();
      used.add(id);
      return id;
    };
    const lines = r.lines.map((v) => {
      const l = record(v, [
        "lineReference",
        "calculationReferences",
        "labelCode",
        "taxClassificationReference",
        "orderType",
        "chargeType",
        "amountMinor",
      ]);
      if (
        !Array.isArray(l.calculationReferences) ||
        l.calculationReferences.length < 1 ||
        l.calculationReferences.length > 16
      )
        return fail();
      const amountMinor = minor(l.amountMinor);
      if (kind === "Basket" ? BigInt(amountMinor) < 0n : BigInt(amountMinor) > 0n) return fail();
      return Object.freeze({
        lineReference: unique(l.lineReference),
        calculationReferences: Object.freeze(l.calculationReferences.map(unique)),
        labelCode: code(l.labelCode),
        taxClassificationReference: ref(l.taxClassificationReference),
        orderType: choice(l.orderType, ["DineIn", "Pickup"]),
        chargeType: choice(l.chargeType, ["Sellable", "ServiceCharge", "DeliveryFee", "Tip"]),
        amountMinor,
      });
    });
    return Object.freeze({
      profile: "TaxDraftFixtureV1",
      fixtureReference,
      kind,
      evaluatedAt: instant(r.evaluatedAt),
      lines: Object.freeze(lines),
    });
  });
}
export function parseTaxConfigSimulationCommand(value: unknown): TaxConfigSimulationCommand {
  return safe(() => {
    const r = record(copy(value, 196608), [
      "configurationReference",
      "expectedVersionReference",
      "expectedSnapshotDigest",
      "fixture",
    ]);
    return Object.freeze({
      configurationReference: ref(r.configurationReference),
      expectedVersionReference: ref(r.expectedVersionReference),
      expectedSnapshotDigest: hash(r.expectedSnapshotDigest),
      fixture: parseTaxConfigDraftFixture(r.fixture),
    });
  });
}
export function parseTaxConfigAuthoringSimulation(
  value: unknown,
  scope: TaxConfigAuthoringScope,
  command: TaxConfigSimulationCommand,
): TaxConfigAuthoringSimulation {
  return safe(() => {
    const r = scopedRecord(
      value,
      [
        "profile",
        ...scopeKeys,
        "configurationReference",
        "versionReference",
        "snapshotDigest",
        "simulation",
        "observedAt",
        "validUntil",
        "referenceEligibility",
      ],
      scope,
    );
    if (
      r.profile !== "TaxConfigAuthoringSimulationV1" ||
      r.referenceEligibility !== "NotEvaluated" ||
      r.configurationReference !== command.configurationReference ||
      r.versionReference !== command.expectedVersionReference ||
      r.snapshotDigest !== command.expectedSnapshotDigest
    )
      return fail();
    const v = record(r.simulation, [
      "profile",
      "fixtureReference",
      "kind",
      "configurationReference",
      "versionReference",
      "snapshotDigest",
      "netAmountMinor",
      "taxAmountMinor",
      "grossAmountMinor",
      "receiptPreview",
      "professionalReviewStatus",
      "legalConclusion",
    ]);
    if (
      v.profile !== "TaxDraftFixtureSimulationV1" ||
      v.fixtureReference !== command.fixture.fixtureReference ||
      v.kind !== command.fixture.kind ||
      v.configurationReference !== r.configurationReference ||
      v.versionReference !== r.versionReference ||
      v.snapshotDigest !== r.snapshotDigest ||
      v.professionalReviewStatus !== "NotEvaluated" ||
      v.legalConclusion !== "NotEvaluated" ||
      !Array.isArray(v.receiptPreview) ||
      v.receiptPreview.length > 4096
    )
      return fail();
    const netAmountMinor = minor(v.netAmountMinor),
      taxAmountMinor = minor(v.taxAmountMinor),
      grossAmountMinor = minor(v.grossAmountMinor);
    if (
      BigInt(netAmountMinor) + BigInt(taxAmountMinor) !== BigInt(grossAmountMinor) ||
      [netAmountMinor, taxAmountMinor, grossAmountMinor].some((v) =>
        command.fixture.kind === "Basket" ? BigInt(v) < 0n : BigInt(v) > 0n,
      )
    )
      return fail();
    const used = new Set<string>();
    const receiptPreview = v.receiptPreview.map((x) => {
      const p = record(x, [
          "lineReference",
          "labelCode",
          "componentCode",
          "treatment",
          "rate",
          "taxAmountMinor",
        ]),
        lineReference = ref(p.lineReference),
        componentCode = code(p.componentCode),
        line = command.fixture.lines.find((l) => l.lineReference === lineReference),
        key = lineReference + ":" + componentCode;
      if (
        !line ||
        p.labelCode !== line.labelCode ||
        used.has(key) ||
        typeof p.rate !== "string" ||
        !/^(?:0|(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{0,11}[1-9])?)$/u.test(p.rate)
      )
        return fail();
      used.add(key);
      if (p.treatment !== "Taxable" && p.rate !== "0") return fail();
      return Object.freeze({
        lineReference,
        labelCode: code(p.labelCode),
        componentCode,
        treatment: choice(p.treatment, ["Taxable", "Exempt", "ZeroRated"]),
        rate: p.rate,
        taxAmountMinor: minor(p.taxAmountMinor),
      });
    });
    if (
      command.fixture.lines.some(
        (l) =>
          receiptPreview.filter((p) => p.lineReference === l.lineReference).length !==
          l.calculationReferences.length,
      ) ||
      receiptPreview.reduce((n, p) => n + BigInt(p.taxAmountMinor), 0n) !== BigInt(taxAmountMinor)
    )
      return fail();
    return Object.freeze({
      profile: "TaxConfigAuthoringSimulationV1",
      ...scope,
      configurationReference: command.configurationReference,
      versionReference: command.expectedVersionReference,
      snapshotDigest: command.expectedSnapshotDigest,
      simulation: Object.freeze({
        profile: "TaxDraftFixtureSimulationV1",
        fixtureReference: command.fixture.fixtureReference,
        kind: command.fixture.kind,
        configurationReference: command.configurationReference,
        versionReference: command.expectedVersionReference,
        snapshotDigest: command.expectedSnapshotDigest,
        netAmountMinor,
        taxAmountMinor,
        grossAmountMinor,
        receiptPreview: Object.freeze(receiptPreview),
        professionalReviewStatus: "NotEvaluated",
        legalConclusion: "NotEvaluated",
      }),
      ...window(r),
      referenceEligibility: "NotEvaluated",
    });
  });
}

export interface TaxConfigAuthoringRequestOptions {
  readonly csrf?: string;
  readonly signal?: AbortSignal;
}
export function createTaxConfigAuthoringClient(fetcher: typeof fetch = fetch) {
  let epoch = 0;
  const begin = () => ++epoch;
  const active = (e: number, signal: AbortSignal | undefined, write = false) => {
    if (e !== epoch) return fail("ScopeChanged");
    if (signal?.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
  };
  const request = async (
    path: string,
    scope: TaxConfigAuthoringScope | undefined,
    options: TaxConfigAuthoringRequestOptions,
    body: unknown | undefined,
    e: number,
    maximumBytes: number,
  ) => {
    const csrf = options.csrf,
      signal = options.signal,
      write = body !== undefined;
    active(e, signal);
    if (write && (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf))) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    let sent = false,
      definitive = false;
    try {
      const encoded = write ? canonical(body) : undefined;
      if (
        encoded !== undefined &&
        new TextEncoder().encode(encoded).length > (path === "simulate" ? 196608 : 65536)
      )
        return fail();
      sent = true;
      const response = await fetcher(`/merchant/tax-config/authoring/${path}`, {
        method: write ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(scope
            ? {
                "X-BOP-Store-Setup-Scope": btoa(canonical(scope))
                  .replace(/\+/gu, "-")
                  .replace(/\//gu, "_")
                  .replace(/=+$/u, ""),
              }
            : {}),
          ...(write ? { "Content-Type": "application/json", "X-BOP-CSRF": csrf ?? "" } : {}),
        },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
      active(e, signal, write);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (!response.body) return fail(write ? "OutcomeUnknown" : "Unavailable");
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (response.ok ? maximumBytes : 4096))
            return fail(write ? "OutcomeUnknown" : "Unavailable");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      active(e, signal, write);
      if (controller.signal.aborted) return fail(write ? "OutcomeUnknown" : "Unavailable");
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const error = safe(() => record(value, ["error"])).error;
        if (response.status === 403 && error === "request_denied") {
          definitive = true;
          return fail("Denied");
        }
        if (response.status === 400 && error === "tax_config_authoring_invalid") {
          definitive = true;
          return fail("Invalid");
        }
        if (response.status === 409 && error === "tax_config_authoring_conflict") {
          definitive = true;
          return fail("Conflict");
        }
        if (response.status === 503 && error === "tax_config_authoring_feature_disabled") {
          definitive = true;
          return fail("FeatureDisabled");
        }
        return fail(write ? "OutcomeUnknown" : "Unavailable");
      }
      return value;
    } catch (error) {
      if (error instanceof TaxConfigAuthoringClientError) {
        if (write && sent && !definitive && error.code === "Invalid") return fail("OutcomeUnknown");
        throw error;
      }
      return fail(write && sent ? "OutcomeUnknown" : "Unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const live = (value: { observedAt: string; validUntil: string }) => {
    if (Date.now() < Date.parse(value.observedAt) || Date.now() >= Date.parse(value.validUntil))
      return fail("Stale");
  };
  const finish = async (
    raw: unknown,
    cursor: TaxConfigAuthoringCursor,
    e: number,
    options: TaxConfigAuthoringRequestOptions,
  ) => {
    const csrf = options.csrf,
      signal = options.signal;
    try {
      const result = await validateTaxConfigAuthoringReceipt(raw, cursor);
      active(e, signal, true);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      return result;
    } catch (error) {
      if (
        error instanceof TaxConfigAuthoringClientError &&
        (error.code === "ScopeChanged" || error.code === "OutcomeUnknown")
      )
        throw error;
      return fail("OutcomeUnknown");
    }
  };
  const prepare = async (
    scopeValue: TaxConfigAuthoringScope,
    commandValue: unknown,
    options: Pick<TaxConfigAuthoringRequestOptions, "signal"> = {},
  ): Promise<PreparedTaxConfigAuthoringCommand> => {
    const scope = safe(() => parseStoreSetupScope(scopeValue)),
      command = parseTaxConfigAuthoringCommand(commandValue),
      e = begin(),
      signal = options.signal;
    active(e, signal);
    const intentDigest = await digest({ scope, command });
    active(e, signal);
    if (options.signal !== signal) return fail("ScopeChanged");
    const cursor = parseTaxConfigAuthoringCursor({
      profile: "TaxConfigAuthoringPendingOriginalV1",
      scope,
      action: command.action,
      operationReference: command.operationReference,
      configurationReference: command.configurationReference,
      expectedAggregateVersion: command.expectedAggregateVersion,
      intentDigest,
    });
    return Object.freeze({ scope, command, intentDigest, cursor });
  };
  return Object.freeze({
    async scope(input: { readonly storeReference: string; readonly signal?: AbortSignal }) {
      const store = safe(() => ref(input.storeReference)),
        signal = input.signal,
        e = begin();
      const raw = await request(
        `scope?storeReference=${store}`,
        undefined,
        signal === undefined ? {} : { signal },
        undefined,
        e,
        196608,
      );
      const discovered = safe(() =>
        scopeFrom(
          record(raw, [
            "profile",
            ...scopeKeys,
            "configurationReference",
            "state",
            "observedAt",
            "validUntil",
            "referenceEligibility",
          ]),
        ),
      );
      if (discovered.storeReference !== store) return fail("ScopeChanged");
      const value = parseTaxConfigAuthoringCurrent(raw, discovered, null);
      active(e, signal);
      if (input.signal !== signal) return fail("ScopeChanged");
      live(value);
      return value;
    },
    async current(
      input: {
        readonly scope: TaxConfigAuthoringScope;
        readonly configurationReference: string | null;
      },
      options: TaxConfigAuthoringRequestOptions = {},
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        scope = safe(() => parseStoreSetupScope(input.scope)),
        target = safe(() => optionalRef(input.configurationReference)),
        e = begin(),
        raw = await request(
          `current?storeReference=${scope.storeReference}${target === null ? "" : `&configurationReference=${target}`}`,
          scope,
          options,
          undefined,
          e,
          196608,
        ),
        value = parseTaxConfigAuthoringCurrent(raw, scope, target);
      if (value.state) await validateTaxConfigDraftSnapshot(value.state.snapshot);
      active(e, signal);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      live(value);
      return value;
    },
    async roster(
      input: {
        readonly scope: TaxConfigAuthoringScope;
        readonly afterConfiguration: string | null;
      },
      options: TaxConfigAuthoringRequestOptions = {},
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        scope = safe(() => parseStoreSetupScope(input.scope)),
        after = safe(() => optionalRef(input.afterConfiguration)),
        e = begin(),
        raw = await request(
          `roster?storeReference=${scope.storeReference}${after === null ? "" : `&afterConfiguration=${after}`}`,
          scope,
          options,
          undefined,
          e,
          1048576,
        ),
        value = parseTaxConfigAuthoringRoster(raw, scope, after);
      await Promise.all(
        value.entries.map((entry) => validateTaxConfigDraftSnapshot(entry.snapshot)),
      );
      active(e, signal);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      live(value);
      return value;
    },
    async classifications(
      input: { readonly scope: TaxConfigAuthoringScope },
      options: TaxConfigAuthoringRequestOptions = {},
    ) {
      const scope = safe(() => parseStoreSetupScope(input.scope)),
        e = begin(),
        signal = options.signal,
        csrf = options.csrf;
      const raw = await request(
        `classifications?storeReference=${scope.storeReference}`,
        scope,
        options,
        undefined,
        e,
        1048576,
      );
      const result = parseTaxConfigClassificationChoices(raw, scope);
      active(e, signal);
      if (options.signal !== signal || options.csrf !== csrf) return fail("ScopeChanged");
      live(result);
      return result;
    },
    async simulate(
      input: {
        readonly scope: TaxConfigAuthoringScope;
        readonly command: TaxConfigSimulationCommand;
      },
      options: TaxConfigAuthoringRequestOptions,
    ) {
      const scope = safe(() => parseStoreSetupScope(input.scope)),
        command = parseTaxConfigSimulationCommand(input.command),
        e = begin(),
        signal = options.signal,
        csrf = options.csrf;
      const raw = await request("simulate", scope, options, command, e, 1048576);
      const result = parseTaxConfigAuthoringSimulation(raw, scope, command);
      active(e, signal);
      if (options.signal !== signal || options.csrf !== csrf) return fail("ScopeChanged");
      live(result);
      return result;
    },
    prepare,
    async execute(
      scopeValue: TaxConfigAuthoringScope,
      commandValue: unknown,
      options: TaxConfigAuthoringRequestOptions,
    ) {
      const csrf = options.csrf,
        signal = options.signal,
        p = await prepare(scopeValue, commandValue, signal === undefined ? {} : { signal }),
        e = epoch;
      active(e, signal);
      if (options.csrf !== csrf || options.signal !== signal) return fail("ScopeChanged");
      const raw = await request("commands", p.scope, options, p.command, e, 196608);
      return finish(raw, p.cursor, e, options);
    },
    async resolve(
      scopeValue: TaxConfigAuthoringScope,
      tupleValue: unknown,
      options: TaxConfigAuthoringRequestOptions,
    ) {
      const scope = safe(() => parseStoreSetupScope(scopeValue)),
        tuple = parseTaxConfigAuthoringResolve(tupleValue),
        cursor = parseTaxConfigAuthoringCursor({
          profile: "TaxConfigAuthoringPendingOriginalV1",
          scope,
          ...tuple,
        }),
        e = begin(),
        raw = await request("resolve-original", scope, options, tuple, e, 196608);
      return finish(raw, cursor, e, options);
    },
  });
}

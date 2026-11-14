import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import {
  createTaxConfigurationSnapshot,
  type TaxConfigurationRule,
  type TaxConfigurationSnapshot,
} from "../domain/tax-configuration.js";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  parseTaxRate,
  roundingModes,
  type PricingReference,
  type PricingDigest,
} from "../domain/money-tax-contract.js";

export interface TaxConfigAuthoringScope {
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly actorReference: PricingReference;
}
export type TaxConfigAuthoringRule = Omit<TaxConfigurationRule, "ruleReference">;
export interface TaxConfigAuthoringContent {
  readonly stableCode: TaxConfigurationSnapshot["stableCode"];
  readonly effectivePeriod: EffectivePeriod;
  readonly rules: readonly TaxConfigAuthoringRule[];
}
export interface TaxConfigAuthoringCommand {
  readonly action: "CreateDraft" | "ReplaceDraft";
  readonly operationReference: PricingReference;
  readonly configurationReference: PricingReference | null;
  readonly expectedAggregateVersion: number | null;
  readonly content: TaxConfigAuthoringContent;
}
export interface TaxConfigAuthoringResolve {
  readonly action: TaxConfigAuthoringCommand["action"];
  readonly operationReference: PricingReference;
  readonly configurationReference: PricingReference | null;
  readonly expectedAggregateVersion: number | null;
  readonly intentDigest: PricingDigest;
}
export interface TaxConfigAuthoringState {
  readonly profile: "TaxConfigAuthoringStateV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly draftAuthorActorReference: PricingReference;
  readonly snapshot: TaxConfigurationSnapshot;
}
export interface TaxConfigAuthoringOperation extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringOperationV1";
  readonly action: TaxConfigAuthoringCommand["action"];
  readonly operationReference: PricingReference;
  readonly configurationReference: PricingReference | null;
  readonly expectedAggregateVersion: number | null;
  readonly command: TaxConfigAuthoringCommand | null;
  /** Scope-bound browser intent; distinct from the existing service's generated candidate digest. */
  readonly intentDigest: PricingDigest;
  readonly serviceIntentDigest: PricingDigest | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: TaxConfigurationSnapshot | null;
  readonly auditReference: PricingReference;
  readonly eventReference: PricingReference | null;
  readonly occurredAt: string;
}
export interface TaxConfigAuthoringCurrent extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringCurrentV1";
  readonly configurationReference: PricingReference | null;
  readonly state: TaxConfigAuthoringState | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export const taxConfigAuthoringRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "configurationReference",
  "operationReference",
  "expectedAggregateVersion",
  "content",
  "snapshot",
  "originalOperation",
  "audit",
  "event",
] as const);
export const taxConfigAuthoringMaximumRules = 256;
export const taxConfigAuthoringMaximumBytes = 65536;
/** Original receipt contains both the original content and the actual immutable snapshot. */
export const taxConfigAuthoringMaximumResultBytes = 196608;
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
const commandKeys = [
  "action",
  "operationReference",
  "configurationReference",
  "expectedAggregateVersion",
  "content",
] as const;
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
const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
function normalized<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
/** Descriptor-safe bounded primitive copy before public owner constructors inspect nested values. */
function copy(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 10000 || depth > 16) return invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16384) return invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 1000 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      return invalid();
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d?.enumerable || !("value" in d)) return invalid();
      out.push(copy(d.value, depth + 1, budget));
    }
    return Object.freeze(out);
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__") return invalid();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    out[key] = copy(d.value, depth + 1, budget);
  }
  return Object.freeze(out);
}
function bounded(value: unknown, maximumBytes = taxConfigAuthoringMaximumBytes): unknown {
  const result = copy(value);
  if (new TextEncoder().encode(canonicalizeRfc8785(result)).length > maximumBytes) return invalid();
  return result;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647)
    return invalid();
  return value;
}
function period(value: unknown): EffectivePeriod {
  const r = closed(value, ["timeZone", "effectiveFrom", "effectiveUntil"]);
  if (typeof r.timeZone !== "string") return invalid();
  const boundary = (value: unknown) => {
    const b = closed(value, ["instant", "localDateTime", "utcOffsetMinutes"]);
    if (typeof b.localDateTime !== "string" || typeof b.utcOffsetMinutes !== "number")
      return invalid();
    return {
      instant: parseCanonicalInstant(b.instant),
      localDateTime: b.localDateTime,
      utcOffsetMinutes: b.utcOffsetMinutes,
    };
  };
  return createEffectivePeriod({
    timeZone: r.timeZone,
    effectiveFrom: boundary(r.effectiveFrom),
    effectiveUntil: r.effectiveUntil === null ? null : boundary(r.effectiveUntil),
  });
}
function currency(value: unknown) {
  const r = closed(value, [
    "currencyCode",
    "minorUnitExponent",
    "metadataVersion",
    "metadataVersionReference",
    "metadataDigest",
  ]);
  if (typeof r.minorUnitExponent !== "number" || typeof r.metadataVersion !== "number")
    return invalid();
  return createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode(r.currencyCode),
    minorUnitExponent: r.minorUnitExponent,
    metadataVersion: r.metadataVersion,
    metadataVersionReference: parsePricingReference(r.metadataVersionReference),
    metadataDigest: parsePricingDigest(r.metadataDigest),
  });
}
function optionalReference(value: unknown) {
  return value === null ? null : parsePricingReference(value);
}
function pins(
  raw: Record<string, unknown>,
): Pick<
  TaxConfigAuthoringCommand,
  "action" | "operationReference" | "configurationReference" | "expectedAggregateVersion"
> {
  const action = raw.action;
  if (action !== "CreateDraft" && action !== "ReplaceDraft") return invalid();
  const configurationReference = optionalReference(raw.configurationReference);
  const expectedAggregateVersion =
    raw.expectedAggregateVersion === null ? null : positive(raw.expectedAggregateVersion);
  if (
    action === "CreateDraft"
      ? configurationReference !== null || expectedAggregateVersion !== null
      : configurationReference === null ||
        expectedAggregateVersion === null ||
        expectedAggregateVersion === 2147483647
  )
    return invalid();
  return {
    action,
    operationReference: parsePricingReference(raw.operationReference),
    configurationReference,
    expectedAggregateVersion,
  };
}
export function parseTaxConfigAuthoringScope(value: unknown): TaxConfigAuthoringScope {
  return normalized(() => {
    const r = closed(value, scopeKeys);
    return Object.freeze({
      tenantReference: parsePricingReference(r.tenantReference),
      brandReference: parsePricingReference(r.brandReference),
      storeReference: parsePricingReference(r.storeReference),
      actorReference: parsePricingReference(r.actorReference),
    });
  });
}
function rule(value: unknown): TaxConfigAuthoringRule {
  const r = closed(value, ruleKeys);
  const orderType = r.orderType,
    chargeType = r.chargeType,
    treatment = r.treatment,
    priceInclusion = r.priceInclusion,
    roundingMode = r.roundingMode;
  if (orderType !== "DineIn" && orderType !== "Pickup") return invalid();
  if (
    chargeType !== "Sellable" &&
    chargeType !== "ServiceCharge" &&
    chargeType !== "DeliveryFee" &&
    chargeType !== "Tip"
  )
    return invalid();
  if (treatment !== "Taxable" && treatment !== "Exempt" && treatment !== "ZeroRated")
    return invalid();
  if (priceInclusion !== "Exclusive" && priceInclusion !== "Inclusive") return invalid();
  if (
    roundingMode !== "HalfUp" &&
    roundingMode !== "HalfEven" &&
    roundingMode !== "TowardZero" &&
    roundingMode !== "AwayFromZero"
  )
    return invalid();
  if (!roundingModes.includes(roundingMode)) return invalid();
  const rate = parseTaxRate(r.rate),
    calculationOrder = positive(r.calculationOrder),
    exceptionEvidenceReference = optionalReference(r.exceptionEvidenceReference);
  if (
    calculationOrder > 16 ||
    typeof r.compoundOnPriorTax !== "boolean" ||
    (calculationOrder === 1 && r.compoundOnPriorTax) ||
    (treatment === "Taxable"
      ? exceptionEvidenceReference !== null
      : rate !== "0" || exceptionEvidenceReference === null)
  )
    return invalid();
  return Object.freeze({
    taxClassificationReference: parsePricingReference(r.taxClassificationReference),
    orderType,
    chargeType,
    taxComponentCode: parsePricingCode(r.taxComponentCode),
    treatment,
    rate,
    priceInclusion,
    roundingMode,
    calculationOrder,
    compoundOnPriorTax: r.compoundOnPriorTax,
    exceptionEvidenceReference,
    receiptPresentationCode: parsePricingCode(r.receiptPresentationCode),
  });
}
export function parseTaxConfigAuthoringContent(value: unknown): TaxConfigAuthoringContent {
  return normalized(() => {
    const r = closed(bounded(value), ["stableCode", "effectivePeriod", "rules"]);
    if (!Array.isArray(r.rules) || r.rules.length > taxConfigAuthoringMaximumRules)
      return invalid();
    const rules = Object.freeze(r.rules.map(rule));
    const groups = new Map<string, TaxConfigAuthoringRule[]>();
    for (const item of rules) {
      const key = `${item.taxClassificationReference}|${item.orderType}|${item.chargeType}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.calculationOrder - b.calculationOrder);
      if (
        sorted.some((item, i) => item.calculationOrder !== i + 1) ||
        new Set(group.map((item) => item.taxComponentCode)).size !== group.length ||
        new Set(group.map((item) => item.priceInclusion)).size !== 1
      )
        return invalid();
    }
    return Object.freeze({
      stableCode: parsePricingCode(r.stableCode),
      effectivePeriod: period(r.effectivePeriod),
      rules,
    });
  });
}
export function parseTaxConfigAuthoringCommand(value: unknown): TaxConfigAuthoringCommand {
  return normalized(() => {
    const r = closed(bounded(value), commandKeys);
    return Object.freeze({ ...pins(r), content: parseTaxConfigAuthoringContent(r.content) });
  });
}
export function parseTaxConfigAuthoringResolve(value: unknown): TaxConfigAuthoringResolve {
  return normalized(() => {
    const r = closed(value, [
      "action",
      "operationReference",
      "configurationReference",
      "expectedAggregateVersion",
      "intentDigest",
    ]);
    return Object.freeze({ ...pins(r), intentDigest: parsePricingDigest(r.intentDigest) });
  });
}
export function taxConfigAuthoringIntentDigest(scope: unknown, command: unknown): PricingDigest {
  return normalized(() =>
    parsePricingDigest(
      `sha256:${sha256Hex(canonicalizeRfc8785({ scope: parseTaxConfigAuthoringScope(scope), command: parseTaxConfigAuthoringCommand(command) }))}`,
    ),
  );
}
function draft(value: unknown): TaxConfigurationSnapshot {
  const r = closed(bounded(value), [
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
    r.registrationEvidence !== null ||
    r.professionalEvidence !== null ||
    !Array.isArray(r.rules) ||
    r.rules.length > taxConfigAuthoringMaximumRules
  )
    return invalid();
  const rules = Object.freeze(
    r.rules.map((value) => {
      const v = closed(value, ["ruleReference", ...ruleKeys]);
      const content: Record<string, unknown> = {};
      for (const key of ruleKeys) content[key] = v[key];
      return Object.freeze({
        ruleReference: parsePricingReference(v.ruleReference),
        ...rule(content),
      });
    }),
  );
  return createTaxConfigurationSnapshot({
    configurationReference: parsePricingReference(r.configurationReference),
    versionReference: parsePricingReference(r.versionReference),
    brandReference: parsePricingReference(r.brandReference),
    storeReference: parsePricingReference(r.storeReference),
    stableCode: parsePricingCode(r.stableCode),
    aggregateVersion: positive(r.aggregateVersion),
    versionNumber: positive(r.versionNumber),
    snapshotDigest: parsePricingDigest(r.snapshotDigest),
    lifecycle: "Draft",
    jurisdictionCode: parsePricingCode(r.jurisdictionCode),
    currencyMetadata: currency(r.currencyMetadata),
    effectivePeriod: period(r.effectivePeriod),
    registrationEvidence: null,
    professionalEvidence: null,
    rules,
    createdAt: parseCanonicalInstant(r.createdAt),
  });
}
export function parseTaxConfigAuthoringState(value: unknown): TaxConfigAuthoringState {
  return normalized(() => {
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "draftAuthorActorReference",
      "snapshot",
    ]);
    if (r.profile !== "TaxConfigAuthoringStateV1") return invalid();
    const tenantReference = parsePricingReference(r.tenantReference),
      brandReference = parsePricingReference(r.brandReference),
      storeReference = parsePricingReference(r.storeReference),
      snapshot = draft(r.snapshot);
    if (snapshot.brandReference !== brandReference || snapshot.storeReference !== storeReference)
      return invalid();
    return Object.freeze({
      profile: "TaxConfigAuthoringStateV1",
      tenantReference,
      brandReference,
      storeReference,
      draftAuthorActorReference: parsePricingReference(r.draftAuthorActorReference),
      snapshot,
    });
  });
}
export function parseTaxConfigAuthoringOperation(value: unknown): TaxConfigAuthoringOperation {
  return normalized(() => {
    const r = closed(bounded(value, taxConfigAuthoringMaximumResultBytes), [
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
    ]);
    if (
      r.profile !== "TaxConfigAuthoringOperationV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const scope = parseTaxConfigAuthoringScope(
        Object.fromEntries(scopeKeys.map((key) => [key, r[key]])),
      ),
      original = pins(r),
      command = r.command === null ? null : parseTaxConfigAuthoringCommand(r.command),
      intentDigest = parsePricingDigest(r.intentDigest),
      occurredAt = parseCanonicalInstant(r.occurredAt);
    const snapshot = r.snapshot === null ? null : draft(r.snapshot),
      serviceIntentDigest =
        r.serviceIntentDigest === null ? null : parsePricingDigest(r.serviceIntentDigest),
      eventReference = optionalReference(r.eventReference);
    if (
      r.outcome === "Abandoned"
        ? command !== null ||
          snapshot !== null ||
          eventReference !== null ||
          serviceIntentDigest !== null
        : command === null ||
          snapshot === null ||
          eventReference === null ||
          serviceIntentDigest === null
    )
      return invalid();
    if (command !== null) {
      for (const key of [
        "action",
        "operationReference",
        "configurationReference",
        "expectedAggregateVersion",
      ] as const)
        if (command[key] !== original[key]) return invalid();
      if (taxConfigAuthoringIntentDigest(scope, command) !== intentDigest || snapshot === null)
        return invalid();
      if (
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.createdAt !== occurredAt ||
        snapshot.aggregateVersion !==
          (command.expectedAggregateVersion === null ? 1 : command.expectedAggregateVersion + 1) ||
        (command.configurationReference !== null &&
          snapshot.configurationReference !== command.configurationReference)
      )
        return invalid();
      const content = parseTaxConfigAuthoringContent({
        stableCode: snapshot.stableCode,
        effectivePeriod: snapshot.effectivePeriod,
        rules: snapshot.rules.map((item) =>
          Object.fromEntries(ruleKeys.map((key) => [key, item[key]])),
        ),
      });
      if (canonicalizeRfc8785(content) !== canonicalizeRfc8785(command.content)) return invalid();
    }
    return Object.freeze({
      profile: "TaxConfigAuthoringOperationV1",
      ...scope,
      ...original,
      command,
      intentDigest,
      serviceIntentDigest,
      outcome: r.outcome,
      snapshot,
      auditReference: parsePricingReference(r.auditReference),
      eventReference,
      occurredAt,
    });
  });
}
export function parseTaxConfigAuthoringCurrent(
  value: unknown,
  expectedConfigurationReference?: unknown,
): TaxConfigAuthoringCurrent {
  return normalized(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "state",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ]);
    if (r.profile !== "TaxConfigAuthoringCurrentV1" || r.referenceEligibility !== "NotEvaluated")
      return invalid();
    const scope = parseTaxConfigAuthoringScope(
        Object.fromEntries(scopeKeys.map((key) => [key, r[key]])),
      ),
      configurationReference = optionalReference(r.configurationReference),
      state = r.state === null ? null : parseTaxConfigAuthoringState(r.state),
      observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (
      (expectedConfigurationReference !== undefined &&
        configurationReference !== optionalReference(expectedConfigurationReference)) ||
      Date.parse(validUntil) <= Date.parse(observedAt) ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      (state !== null &&
        (state.tenantReference !== scope.tenantReference ||
          state.brandReference !== scope.brandReference ||
          state.storeReference !== scope.storeReference ||
          state.snapshot.configurationReference !== configurationReference ||
          Date.parse(state.snapshot.createdAt) > Date.parse(observedAt)))
    )
      return invalid();
    return Object.freeze({
      profile: "TaxConfigAuthoringCurrentV1",
      ...scope,
      configurationReference,
      state,
      observedAt,
      validUntil,
      referenceEligibility: "NotEvaluated",
    });
  });
}

export interface TaxConfigAuthoringRoster extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringRosterV1";
  readonly afterConfiguration: PricingReference | null;
  readonly entries: readonly TaxConfigAuthoringState[];
  readonly nextAfterConfiguration: PricingReference | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export const taxConfigAuthoringRosterPageSize = 50;
export const taxConfigAuthoringRosterMaximumBytes = 1048576;
/** A page is a current observation, not a stable cross-page snapshot or evidence qualification.
 * The owning reader must establish that a non-null cursor belongs to an actual same-scope root.
 */
export function parseTaxConfigAuthoringRoster(
  value: unknown,
  expectedAfterConfiguration?: unknown,
): TaxConfigAuthoringRoster {
  return normalized(() => {
    const r = closed(value, [
      "profile",
      ...scopeKeys,
      "afterConfiguration",
      "entries",
      "nextAfterConfiguration",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ]);
    if (r.profile !== "TaxConfigAuthoringRosterV1" || r.referenceEligibility !== "NotEvaluated")
      return invalid();
    const scope = parseTaxConfigAuthoringScope(
      Object.fromEntries(scopeKeys.map((key) => [key, r[key]])),
    );
    const afterConfiguration = optionalReference(r.afterConfiguration),
      nextAfterConfiguration = optionalReference(r.nextAfterConfiguration);
    const observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (
      (expectedAfterConfiguration !== undefined &&
        afterConfiguration !== optionalReference(expectedAfterConfiguration)) ||
      Date.parse(validUntil) <= Date.parse(observedAt) ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return invalid();
    const raw = r.entries;
    if (
      !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length > taxConfigAuthoringRosterPageSize ||
      Reflect.ownKeys(raw).length !== raw.length + 1
    )
      return invalid();
    const entries: TaxConfigAuthoringState[] = [];
    let previous = afterConfiguration;
    for (let i = 0; i < raw.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      const entry = parseTaxConfigAuthoringState(descriptor.value),
        reference = entry.snapshot.configurationReference;
      if (
        entry.tenantReference !== scope.tenantReference ||
        entry.brandReference !== scope.brandReference ||
        entry.storeReference !== scope.storeReference ||
        (previous !== null && reference <= previous) ||
        Date.parse(entry.snapshot.createdAt) > Date.parse(observedAt)
      )
        return invalid();
      previous = reference;
      entries.push(entry);
    }
    if (
      nextAfterConfiguration !== null &&
      (entries.length !== taxConfigAuthoringRosterPageSize || nextAfterConfiguration !== previous)
    )
      return invalid();
    const result = Object.freeze({
      profile: "TaxConfigAuthoringRosterV1" as const,
      ...scope,
      afterConfiguration,
      entries: Object.freeze(entries),
      nextAfterConfiguration,
      observedAt,
      validUntil,
      referenceEligibility: "NotEvaluated" as const,
    });
    if (
      new TextEncoder().encode(canonicalizeRfc8785(result)).length >
      taxConfigAuthoringRosterMaximumBytes
    )
      return invalid();
    return result;
  });
}

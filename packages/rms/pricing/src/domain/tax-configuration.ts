import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";

import {
  createCurrencyMetadataSnapshot,
  createResolvedTaxRuleSnapshot,
  parsePricingCode,
  parsePricingDigest,
  parsePricingReference,
  parseTaxRate,
  roundingModes,
  type CurrencyMetadataSnapshot,
  type PricingCode,
  type PricingDigest,
  type PricingReference,
  type ResolvedTaxRuleSnapshot,
  type RoundingMode,
  type TaxRate,
} from "./money-tax-contract.js";

export type TaxConfigurationLifecycle = "Draft" | "Published";
export type TaxTreatment = "Taxable" | "Exempt" | "ZeroRated";
export type TaxPriceInclusion = "Exclusive" | "Inclusive";
export type TaxOrderType = "DineIn" | "Pickup";
export type TaxChargeType = "Sellable" | "ServiceCharge" | "DeliveryFee" | "Tip";

export interface TaxRegistrationEvidence {
  readonly applicabilityReference: PricingReference;
  readonly operatingEntityTaxReference: PricingReference;
  readonly jurisdictionProfileReference: PricingReference;
  readonly status: "Verified";
  readonly validUntil: string;
}

export interface TaxProfessionalEvidence {
  readonly evidenceReference: PricingReference;
  readonly snapshotReference: PricingReference;
  readonly snapshotDigest: PricingDigest;
  readonly professionalReviewReference: PricingReference;
  readonly fixtureSuiteReference: PricingReference;
  readonly fixtureSuiteDigest: PricingDigest;
  readonly result: "Pass";
  readonly reviewedAt: string;
  readonly validUntil: string;
}

export interface TaxConfigurationRule {
  readonly ruleReference: PricingReference;
  readonly taxClassificationReference: PricingReference;
  readonly orderType: TaxOrderType;
  readonly chargeType: TaxChargeType;
  readonly taxComponentCode: PricingCode;
  readonly treatment: TaxTreatment;
  readonly rate: TaxRate;
  readonly priceInclusion: TaxPriceInclusion;
  readonly roundingMode: RoundingMode;
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly exceptionEvidenceReference: PricingReference | null;
  readonly receiptPresentationCode: PricingCode;
}

export interface TaxConfigurationSnapshot {
  readonly configurationReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly stableCode: PricingCode;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: PricingDigest;
  readonly lifecycle: TaxConfigurationLifecycle;
  readonly jurisdictionCode: PricingCode;
  readonly currencyMetadata: CurrencyMetadataSnapshot;
  readonly effectivePeriod: EffectivePeriod;
  readonly registrationEvidence: TaxRegistrationEvidence | null;
  readonly professionalEvidence: TaxProfessionalEvidence | null;
  readonly rules: readonly TaxConfigurationRule[];
  readonly createdAt: string;
}

export interface TaxResolutionContext {
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly jurisdictionCode: PricingCode;
  readonly currencyCode: string;
  readonly taxClassificationReference: PricingReference;
  readonly orderType: TaxOrderType;
  readonly chargeType: TaxChargeType;
  readonly evaluatedAt: string;
}

export interface ResolvedTaxRuleComponent {
  readonly calculationOrder: number;
  readonly compoundOnPriorTax: boolean;
  readonly receiptPresentationCode: PricingCode;
  readonly resolvedRule: ResolvedTaxRuleSnapshot;
}

export interface TaxConfigurationResolution {
  readonly configurationReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly snapshotDigest: PricingDigest;
  readonly effectivePeriod: EffectivePeriod;
  readonly rules: readonly ResolvedTaxRuleComponent[];
}

export const taxConfigurationErrorCodes = [
  "TAX_CONFIGURATION_INPUT_INVALID",
  "TAX_CONFIGURATION_SCOPE_MISMATCH",
  "TAX_CONFIGURATION_EVIDENCE_INVALID",
  "TAX_CONFIGURATION_RULE_CONFLICT",
  "TAX_CONFIGURATION_COVERAGE_MISSING",
  "TAX_CONFIGURATION_NOT_EFFECTIVE",
] as const;
export type TaxConfigurationErrorCode = (typeof taxConfigurationErrorCodes)[number];

export class TaxConfigurationError extends Error {
  readonly code: TaxConfigurationErrorCode;

  constructor(code: TaxConfigurationErrorCode) {
    super("tax configuration is unavailable");
    this.name = "TaxConfigurationError";
    this.code = code;
  }
}

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code: TaxConfigurationErrorCode): never {
  throw new TaxConfigurationError(code);
}

function exact(value: object, fields: readonly string[], code: TaxConfigurationErrorCode): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(fields);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !allowed.has(field)) ||
    keys.some((field) => {
      if (typeof field !== "string") return true;
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail(code);
}

function parseInstant(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    fail("TAX_CONFIGURATION_INPUT_INVALID");
  return value;
}

function reference(value: unknown): PricingReference {
  try {
    return parsePricingReference(value);
  } catch {
    return fail("TAX_CONFIGURATION_INPUT_INVALID");
  }
}

function digest(value: unknown): PricingDigest {
  try {
    return parsePricingDigest(value);
  } catch {
    return fail("TAX_CONFIGURATION_INPUT_INVALID");
  }
}

function code(value: unknown): PricingCode {
  try {
    return parsePricingCode(value);
  } catch {
    return fail("TAX_CONFIGURATION_INPUT_INVALID");
  }
}

function createRegistrationEvidence(input: TaxRegistrationEvidence): TaxRegistrationEvidence {
  exact(
    input,
    [
      "applicabilityReference",
      "operatingEntityTaxReference",
      "jurisdictionProfileReference",
      "status",
      "validUntil",
    ],
    "TAX_CONFIGURATION_EVIDENCE_INVALID",
  );
  if (input.status !== "Verified") fail("TAX_CONFIGURATION_EVIDENCE_INVALID");
  return Object.freeze({
    applicabilityReference: reference(input.applicabilityReference),
    operatingEntityTaxReference: reference(input.operatingEntityTaxReference),
    jurisdictionProfileReference: reference(input.jurisdictionProfileReference),
    status: input.status,
    validUntil: parseInstant(input.validUntil),
  });
}

function createProfessionalEvidence(input: TaxProfessionalEvidence): TaxProfessionalEvidence {
  exact(
    input,
    [
      "evidenceReference",
      "snapshotReference",
      "snapshotDigest",
      "professionalReviewReference",
      "fixtureSuiteReference",
      "fixtureSuiteDigest",
      "result",
      "reviewedAt",
      "validUntil",
    ],
    "TAX_CONFIGURATION_EVIDENCE_INVALID",
  );
  const reviewedAt = parseInstant(input.reviewedAt);
  const validUntil = parseInstant(input.validUntil);
  if (input.result !== "Pass" || Date.parse(validUntil) <= Date.parse(reviewedAt))
    fail("TAX_CONFIGURATION_EVIDENCE_INVALID");
  return Object.freeze({
    evidenceReference: reference(input.evidenceReference),
    snapshotReference: reference(input.snapshotReference),
    snapshotDigest: digest(input.snapshotDigest),
    professionalReviewReference: reference(input.professionalReviewReference),
    fixtureSuiteReference: reference(input.fixtureSuiteReference),
    fixtureSuiteDigest: digest(input.fixtureSuiteDigest),
    result: input.result,
    reviewedAt,
    validUntil,
  });
}

function createRule(input: TaxConfigurationRule): TaxConfigurationRule {
  exact(
    input,
    [
      "ruleReference",
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
    ],
    "TAX_CONFIGURATION_INPUT_INVALID",
  );
  let rate: TaxRate;
  try {
    rate = parseTaxRate(input.rate);
  } catch {
    return fail("TAX_CONFIGURATION_INPUT_INVALID");
  }
  if (
    (input.orderType !== "DineIn" && input.orderType !== "Pickup") ||
    !["Sellable", "ServiceCharge", "DeliveryFee", "Tip"].includes(input.chargeType) ||
    !["Taxable", "Exempt", "ZeroRated"].includes(input.treatment) ||
    (input.priceInclusion !== "Exclusive" && input.priceInclusion !== "Inclusive") ||
    !roundingModes.includes(input.roundingMode) ||
    !Number.isSafeInteger(input.calculationOrder) ||
    input.calculationOrder < 1 ||
    input.calculationOrder > 16 ||
    typeof input.compoundOnPriorTax !== "boolean" ||
    (input.calculationOrder === 1 && input.compoundOnPriorTax) ||
    (input.treatment === "Taxable" && input.exceptionEvidenceReference !== null) ||
    (input.treatment !== "Taxable" && (rate !== "0" || input.exceptionEvidenceReference === null))
  )
    fail("TAX_CONFIGURATION_INPUT_INVALID");
  return Object.freeze({
    ruleReference: reference(input.ruleReference),
    taxClassificationReference: reference(input.taxClassificationReference),
    orderType: input.orderType,
    chargeType: input.chargeType,
    taxComponentCode: code(input.taxComponentCode),
    treatment: input.treatment,
    rate,
    priceInclusion: input.priceInclusion,
    roundingMode: input.roundingMode,
    calculationOrder: input.calculationOrder,
    compoundOnPriorTax: input.compoundOnPriorTax,
    exceptionEvidenceReference:
      input.exceptionEvidenceReference === null
        ? null
        : reference(input.exceptionEvidenceReference),
    receiptPresentationCode: code(input.receiptPresentationCode),
  });
}

function groupKey(rule: TaxConfigurationRule): string {
  return [rule.taxClassificationReference, rule.orderType, rule.chargeType].join("|");
}

function validateRuleGroups(rules: readonly TaxConfigurationRule[]): void {
  const identities = new Set<string>();
  const groups = new Map<string, TaxConfigurationRule[]>();
  for (const rule of rules) {
    if (identities.has(rule.ruleReference)) fail("TAX_CONFIGURATION_RULE_CONFLICT");
    identities.add(rule.ruleReference);
    const group = groups.get(groupKey(rule)) ?? [];
    group.push(rule);
    groups.set(groupKey(rule), group);
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => left.calculationOrder - right.calculationOrder);
    if (
      sorted.some((rule, index) => rule.calculationOrder !== index + 1) ||
      new Set(sorted.map((rule) => rule.taxComponentCode)).size !== sorted.length ||
      new Set(sorted.map((rule) => rule.priceInclusion)).size !== 1
    )
      fail("TAX_CONFIGURATION_RULE_CONFLICT");
  }
}

export function createTaxConfigurationSnapshot(
  input: TaxConfigurationSnapshot,
): TaxConfigurationSnapshot {
  exact(
    input,
    [
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
    ],
    "TAX_CONFIGURATION_INPUT_INVALID",
  );
  if (
    (input.lifecycle !== "Draft" && input.lifecycle !== "Published") ||
    !Number.isSafeInteger(input.aggregateVersion) ||
    input.aggregateVersion < 1 ||
    !Number.isSafeInteger(input.versionNumber) ||
    input.versionNumber < 1 ||
    !Array.isArray(input.rules)
  )
    fail("TAX_CONFIGURATION_INPUT_INVALID");
  const versionReference = reference(input.versionReference);
  const snapshotDigest = digest(input.snapshotDigest);
  const jurisdictionCode = code(input.jurisdictionCode);
  let currencyMetadata: CurrencyMetadataSnapshot;
  let effectivePeriod: EffectivePeriod;
  try {
    currencyMetadata = createCurrencyMetadataSnapshot(input.currencyMetadata);
    effectivePeriod = createEffectivePeriod(input.effectivePeriod);
  } catch {
    return fail("TAX_CONFIGURATION_INPUT_INVALID");
  }
  if (jurisdictionCode !== "CA-ON" || currencyMetadata.currencyCode !== "CAD")
    fail("TAX_CONFIGURATION_SCOPE_MISMATCH");
  const rules = Object.freeze(input.rules.map(createRule));
  validateRuleGroups(rules);
  const registrationEvidence =
    input.registrationEvidence === null
      ? null
      : createRegistrationEvidence(input.registrationEvidence);
  const professionalEvidence =
    input.professionalEvidence === null
      ? null
      : createProfessionalEvidence(input.professionalEvidence);
  if (
    input.lifecycle === "Published" &&
    (rules.length === 0 ||
      registrationEvidence === null ||
      professionalEvidence === null ||
      professionalEvidence.snapshotReference !== versionReference ||
      professionalEvidence.snapshotDigest !== snapshotDigest)
  )
    fail("TAX_CONFIGURATION_EVIDENCE_INVALID");
  return Object.freeze({
    configurationReference: reference(input.configurationReference),
    versionReference,
    brandReference: reference(input.brandReference),
    storeReference: reference(input.storeReference),
    stableCode: code(input.stableCode),
    aggregateVersion: input.aggregateVersion,
    versionNumber: input.versionNumber,
    snapshotDigest,
    lifecycle: input.lifecycle,
    jurisdictionCode,
    currencyMetadata,
    effectivePeriod,
    registrationEvidence,
    professionalEvidence,
    rules,
    createdAt: parseInstant(input.createdAt),
  });
}

export function validateTaxConfigurationCoverage(
  snapshotInput: TaxConfigurationSnapshot,
  requiredContexts: readonly Pick<
    TaxResolutionContext,
    "taxClassificationReference" | "orderType" | "chargeType"
  >[],
): void {
  const snapshot = createTaxConfigurationSnapshot(snapshotInput);
  if (!Array.isArray(requiredContexts) || requiredContexts.length === 0)
    fail("TAX_CONFIGURATION_COVERAGE_MISSING");
  for (const context of requiredContexts) {
    if (
      snapshot.rules.every(
        (rule) =>
          rule.taxClassificationReference !== context.taxClassificationReference ||
          rule.orderType !== context.orderType ||
          rule.chargeType !== context.chargeType,
      )
    )
      fail("TAX_CONFIGURATION_COVERAGE_MISSING");
  }
}

export function resolveTaxConfiguration(
  snapshotInput: TaxConfigurationSnapshot,
  context: TaxResolutionContext,
): TaxConfigurationResolution {
  const snapshot = createTaxConfigurationSnapshot(snapshotInput);
  exact(
    context,
    [
      "brandReference",
      "storeReference",
      "jurisdictionCode",
      "currencyCode",
      "taxClassificationReference",
      "orderType",
      "chargeType",
      "evaluatedAt",
    ],
    "TAX_CONFIGURATION_INPUT_INVALID",
  );
  const evaluatedAt = parseInstant(context.evaluatedAt);
  if (
    snapshot.lifecycle !== "Published" ||
    context.brandReference !== snapshot.brandReference ||
    context.storeReference !== snapshot.storeReference ||
    context.jurisdictionCode !== snapshot.jurisdictionCode ||
    context.currencyCode !== snapshot.currencyMetadata.currencyCode
  )
    fail("TAX_CONFIGURATION_SCOPE_MISMATCH");
  if (
    snapshot.registrationEvidence === null ||
    snapshot.professionalEvidence === null ||
    Date.parse(snapshot.registrationEvidence.validUntil) <= Date.parse(evaluatedAt) ||
    Date.parse(snapshot.professionalEvidence.validUntil) <= Date.parse(evaluatedAt)
  )
    fail("TAX_CONFIGURATION_EVIDENCE_INVALID");
  if (
    Date.parse(evaluatedAt) < Date.parse(snapshot.effectivePeriod.effectiveFrom.instant) ||
    (snapshot.effectivePeriod.effectiveUntil !== null &&
      Date.parse(evaluatedAt) >= Date.parse(snapshot.effectivePeriod.effectiveUntil.instant))
  )
    fail("TAX_CONFIGURATION_NOT_EFFECTIVE");
  const matched = snapshot.rules
    .filter(
      (rule) =>
        rule.taxClassificationReference === context.taxClassificationReference &&
        rule.orderType === context.orderType &&
        rule.chargeType === context.chargeType,
    )
    .sort((left, right) => left.calculationOrder - right.calculationOrder);
  if (matched.length === 0) fail("TAX_CONFIGURATION_COVERAGE_MISSING");
  return Object.freeze({
    configurationReference: snapshot.configurationReference,
    versionReference: snapshot.versionReference,
    snapshotDigest: snapshot.snapshotDigest,
    effectivePeriod: snapshot.effectivePeriod,
    rules: Object.freeze(
      matched.map((rule) =>
        Object.freeze({
          calculationOrder: rule.calculationOrder,
          compoundOnPriorTax: rule.compoundOnPriorTax,
          receiptPresentationCode: rule.receiptPresentationCode,
          resolvedRule: createResolvedTaxRuleSnapshot({
            ruleVersionReference: rule.ruleReference,
            ruleVersionDigest: snapshot.snapshotDigest,
            jurisdictionCode: snapshot.jurisdictionCode,
            taxComponentCode: rule.taxComponentCode,
            taxClassificationReference: rule.taxClassificationReference,
            treatment: rule.treatment,
            rate: rule.rate,
            priceInclusion: rule.priceInclusion,
            roundingMode: rule.roundingMode,
          }),
        }),
      ),
    ),
  });
}

import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createTaxConfigurationSnapshot,
  type TaxConfigurationSnapshot,
  type TaxConfigurationRule,
  type TaxRegistrationEvidence,
  type TaxProfessionalEvidence,
} from "../domain/tax-configuration.js";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
  parseCurrencyCode,
  createCurrencyMetadataSnapshot,
  type PricingReference,
  type PricingDigest,
} from "../domain/money-tax-contract.js";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import {
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringContent,
  type TaxConfigAuthoringState,
  taxConfigAuthoringMaximumRules,
  taxConfigAuthoringMaximumResultBytes,
} from "./tax-config-authoring.js";

export interface TaxPublicationSourceRuleBinding {
  readonly sourceRuleReference: PricingReference;
  readonly targetRuleReference: PricingReference;
}
export interface TaxPublicationRegistrationMaterial {
  readonly materialReference: PricingReference;
  readonly versionReference: PricingReference;
  readonly contentDigest: PricingDigest;
}
export interface TaxPublicationCandidateContent {
  readonly profile: "TaxPublicationCandidateContentV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly configurationReference: PricingReference;
  readonly baseDraft: Readonly<{
    versionReference: PricingReference;
    snapshotDigest: PricingDigest;
    aggregateVersion: number;
    versionNumber: number;
  }>;
  readonly targetVersionReference: PricingReference;
  readonly targetAggregateVersion: number;
  readonly targetVersionNumber: number;
  readonly stableCode: TaxConfigurationSnapshot["stableCode"];
  readonly jurisdictionCode: TaxConfigurationSnapshot["jurisdictionCode"];
  readonly currencyMetadata: TaxConfigurationSnapshot["currencyMetadata"];
  readonly effectivePeriod: TaxConfigurationSnapshot["effectivePeriod"];
  readonly rules: readonly TaxConfigurationRule[];
  readonly sourceRuleBindings: readonly TaxPublicationSourceRuleBinding[];
  readonly registrationMaterial: TaxPublicationRegistrationMaterial;
}
export interface TaxPublicationCandidate {
  readonly profile: "TaxPublicationCandidateV1";
  readonly content: TaxPublicationCandidateContent;
  readonly contentDigest: PricingDigest;
}
const fail = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
const closed = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const found = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (found.length !== keys.length || found.some((k) => typeof k !== "string" || !keys.includes(k)))
    return fail();
  return Object.fromEntries(
    keys.map((k) => {
      const d = descriptors[k];
      if (!d?.enumerable || !("value" in d)) return fail();
      return [k, d.value];
    }),
  );
};
function detached(value: unknown): unknown {
  let remaining = 20000;
  const visit = (v: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 16) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string")
      return v;
    if (!v || typeof v !== "object") return fail();
    const keys = Reflect.ownKeys(v),
      ds = Object.getOwnPropertyDescriptors(v);
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > taxConfigAuthoringMaximumRules ||
        keys.length !== v.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = ds[String(i)];
          if (!d?.enumerable || !("value" in d)) return fail();
          return visit(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return fail();
    return Object.freeze(
      Object.fromEntries(
        keys.map((k) => {
          const d = typeof k === "string" ? ds[k] : undefined;
          if (!d?.enumerable || !("value" in d)) return fail();
          return [k, visit(d.value, depth + 1)];
        }),
      ),
    );
  };
  const result = visit(value, 0);
  if (
    new TextEncoder().encode(canonicalizeRfc8785(result)).byteLength >
    taxConfigAuthoringMaximumResultBytes
  )
    return fail();
  return result;
}
const positive = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return fail();
  return v;
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (value: unknown) =>
  parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(value)));
const baseKeys = [
  "versionReference",
  "snapshotDigest",
  "aggregateVersion",
  "versionNumber",
] as const;
const contentKeys = [
  "profile",
  "tenantReference",
  "brandReference",
  "storeReference",
  "configurationReference",
  "baseDraft",
  "targetVersionReference",
  "targetAggregateVersion",
  "targetVersionNumber",
  "stableCode",
  "jurisdictionCode",
  "currencyMetadata",
  "effectivePeriod",
  "rules",
  "sourceRuleBindings",
  "registrationMaterial",
] as const;
function bindings(value: unknown): readonly TaxPublicationSourceRuleBinding[] {
  if (!Array.isArray(value) || value.length > taxConfigAuthoringMaximumRules) return fail();
  return Object.freeze(
    value.map((v) => {
      const r = closed(v, ["sourceRuleReference", "targetRuleReference"]);
      return Object.freeze({
        sourceRuleReference: parsePricingReference(r.sourceRuleReference),
        targetRuleReference: parsePricingReference(r.targetRuleReference),
      });
    }),
  );
}
function material(value: unknown): TaxPublicationRegistrationMaterial {
  const r = closed(value, ["materialReference", "versionReference", "contentDigest"]);
  return Object.freeze({
    materialReference: parsePricingReference(r.materialReference),
    versionReference: parsePricingReference(r.versionReference),
    contentDigest: parsePricingDigest(r.contentDigest),
  });
}
function parseContent(value: unknown): TaxPublicationCandidateContent {
  const r = closed(detached(value), contentKeys),
    base = closed(r.baseDraft, baseKeys);
  if (r.profile !== "TaxPublicationCandidateContentV1") return fail();
  const tenantReference = parsePricingReference(r.tenantReference),
    brandReference = parsePricingReference(r.brandReference),
    storeReference = parsePricingReference(r.storeReference),
    configurationReference = parsePricingReference(r.configurationReference),
    targetVersionReference = parsePricingReference(r.targetVersionReference);
  const baseDraft = Object.freeze({
    versionReference: parsePricingReference(base.versionReference),
    snapshotDigest: parsePricingDigest(base.snapshotDigest),
    aggregateVersion: positive(base.aggregateVersion),
    versionNumber: positive(base.versionNumber),
  });
  const targetAggregateVersion = positive(r.targetAggregateVersion),
    targetVersionNumber = positive(r.targetVersionNumber);
  if (
    targetAggregateVersion !== baseDraft.aggregateVersion + 1 ||
    targetVersionNumber !== baseDraft.versionNumber + 1 ||
    targetVersionReference === baseDraft.versionReference
  )
    return fail();
  if (!Array.isArray(r.rules)) return fail();
  const ruleRecords = r.rules.map((v) =>
    closed(v, [
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
    ]),
  );
  const values = parseTaxConfigAuthoringContent({
    stableCode: r.stableCode,
    effectivePeriod: r.effectivePeriod,
    rules: ruleRecords.map((v) => {
      const { ruleReference, ...content } = v;
      parsePricingReference(ruleReference);
      return content;
    }),
  });
  const rules = Object.freeze(
    ruleRecords.map((v, i) => {
      const content = values.rules[i];
      if (!content) return fail();
      return Object.freeze({ ruleReference: parsePricingReference(v.ruleReference), ...content });
    }),
  );
  const cm = closed(r.currencyMetadata, [
    "currencyCode",
    "minorUnitExponent",
    "metadataVersion",
    "metadataVersionReference",
    "metadataDigest",
  ]);
  if (typeof cm.minorUnitExponent !== "number") return fail();
  const currencyMetadata = createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode(cm.currencyCode),
      minorUnitExponent: cm.minorUnitExponent,
      metadataVersion: positive(cm.metadataVersion),
      metadataVersionReference: parsePricingReference(cm.metadataVersionReference),
      metadataDigest: parsePricingDigest(cm.metadataDigest),
    }),
    jurisdictionCode = parsePricingCode(r.jurisdictionCode);
  if (currencyMetadata.currencyCode !== "CAD" || jurisdictionCode !== "CA-ON") return fail();
  const sourceRuleBindings = bindings(r.sourceRuleBindings),
    registrationMaterial = material(r.registrationMaterial);
  if (
    sourceRuleBindings.length !== rules.length ||
    sourceRuleBindings.some((b, i) => b.targetRuleReference !== rules[i]?.ruleReference) ||
    new Set(sourceRuleBindings.map((b) => b.sourceRuleReference)).size !== rules.length ||
    new Set(sourceRuleBindings.map((b) => b.targetRuleReference)).size !== rules.length
  )
    return fail();
  const reserved = new Set<string>([
    tenantReference,
    brandReference,
    storeReference,
    configurationReference,
    baseDraft.versionReference,
    targetVersionReference,
    registrationMaterial.materialReference,
    registrationMaterial.versionReference,
    ...sourceRuleBindings.map((b) => b.sourceRuleReference),
  ]);
  for (const rule of rules) {
    reserved.add(rule.taxClassificationReference);
    if (rule.exceptionEvidenceReference !== null) reserved.add(rule.exceptionEvidenceReference);
  }
  reserved.add(currencyMetadata.metadataVersionReference);
  if (
    [
      tenantReference,
      brandReference,
      storeReference,
      configurationReference,
      baseDraft.versionReference,
      registrationMaterial.materialReference,
      registrationMaterial.versionReference,
      ...sourceRuleBindings.map((b) => b.sourceRuleReference),
      ...rules.map((rule) => rule.taxClassificationReference),
      ...rules.flatMap((rule) =>
        rule.exceptionEvidenceReference === null ? [] : [rule.exceptionEvidenceReference],
      ),
      currencyMetadata.metadataVersionReference,
    ].includes(targetVersionReference) ||
    sourceRuleBindings.some((b) => reserved.has(b.targetRuleReference))
  )
    return fail();
  return Object.freeze({
    profile: "TaxPublicationCandidateContentV1",
    tenantReference,
    brandReference,
    storeReference,
    configurationReference,
    baseDraft,
    targetVersionReference,
    targetAggregateVersion,
    targetVersionNumber,
    stableCode: values.stableCode,
    jurisdictionCode,
    currencyMetadata,
    effectivePeriod: values.effectivePeriod,
    rules,
    sourceRuleBindings,
    registrationMaterial,
  });
}
function normalized<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return fail();
  }
}
/** Closed content only: excludes professional/suite bodies, self digest,
 * qualification decisions, approval/release and the future publication clock. */
export function parseTaxPublicationCandidateContent(
  value: unknown,
): TaxPublicationCandidateContent {
  return normalized(() => parseContent(value));
}
export function parseTaxPublicationCandidate(value: unknown): TaxPublicationCandidate {
  return normalized(() => {
    const r = closed(detached(value), ["profile", "content", "contentDigest"]);
    if (r.profile !== "TaxPublicationCandidateV1") return fail();
    const content = parseContent(r.content),
      contentDigest = parsePricingDigest(r.contentDigest);
    if (hash(content) !== contentDigest) return fail();
    return Object.freeze({ profile: "TaxPublicationCandidateV1", content, contentDigest });
  });
}
export function assertTaxPublicationCandidateDraft(
  candidateValue: unknown,
  draftValue: unknown,
): TaxPublicationCandidate {
  return normalized(() => {
    const candidate = parseTaxPublicationCandidate(candidateValue),
      draft = parseTaxConfigAuthoringState(detached(draftValue)),
      c = candidate.content,
      s = draft.snapshot;
    const { snapshotDigest, ...body } = s;
    if (hash(body) !== snapshotDigest) return fail();
    if (
      c.tenantReference !== draft.tenantReference ||
      c.brandReference !== draft.brandReference ||
      c.storeReference !== draft.storeReference ||
      c.configurationReference !== s.configurationReference ||
      !equal(c.baseDraft, {
        versionReference: s.versionReference,
        snapshotDigest: s.snapshotDigest,
        aggregateVersion: s.aggregateVersion,
        versionNumber: s.versionNumber,
      }) ||
      c.stableCode !== s.stableCode ||
      c.jurisdictionCode !== s.jurisdictionCode ||
      !equal(c.currencyMetadata, s.currencyMetadata) ||
      !equal(c.effectivePeriod, s.effectivePeriod) ||
      s.rules.length !== c.rules.length
    )
      return fail();
    for (let i = 0; i < s.rules.length; i++) {
      const source = s.rules[i],
        target = c.rules[i],
        b = c.sourceRuleBindings[i];
      if (
        !source ||
        !target ||
        !b ||
        b.sourceRuleReference !== source.ruleReference ||
        b.targetRuleReference !== target.ruleReference ||
        !equal({ ...source, ruleReference: target.ruleReference }, target)
      )
        return fail();
    }
    return candidate;
  });
}
export function createTaxPublicationCandidate(
  input: Readonly<{
    draft: TaxConfigAuthoringState;
    targetVersionReference: unknown;
    sourceRuleBindings: unknown;
    registrationMaterial: unknown;
  }>,
): TaxPublicationCandidate {
  return normalized(() => {
    const r = closed(detached(input), [
        "draft",
        "targetVersionReference",
        "sourceRuleBindings",
        "registrationMaterial",
      ]),
      draft = parseTaxConfigAuthoringState(r.draft),
      s = draft.snapshot,
      sourceRuleBindings = bindings(r.sourceRuleBindings);
    if (sourceRuleBindings.length !== s.rules.length) return fail();
    const content = parseContent({
      profile: "TaxPublicationCandidateContentV1",
      tenantReference: draft.tenantReference,
      brandReference: draft.brandReference,
      storeReference: draft.storeReference,
      configurationReference: s.configurationReference,
      baseDraft: {
        versionReference: s.versionReference,
        snapshotDigest: s.snapshotDigest,
        aggregateVersion: s.aggregateVersion,
        versionNumber: s.versionNumber,
      },
      targetVersionReference: r.targetVersionReference,
      targetAggregateVersion: s.aggregateVersion + 1,
      targetVersionNumber: s.versionNumber + 1,
      stableCode: s.stableCode,
      jurisdictionCode: s.jurisdictionCode,
      currencyMetadata: s.currencyMetadata,
      effectivePeriod: s.effectivePeriod,
      rules: s.rules.map((rule, i) => ({
        ...rule,
        ruleReference: sourceRuleBindings[i]?.targetRuleReference,
      })),
      sourceRuleBindings,
      registrationMaterial: r.registrationMaterial,
    });
    return assertTaxPublicationCandidateDraft(
      { profile: "TaxPublicationCandidateV1", content, contentDigest: hash(content) },
      draft,
    );
  });
}
/** Content parity only. The caller still needs actual registration/professional,
 * suite, approval and release sources; this helper never grants publication. */
export function matchTaxPublicationCandidatePublishedSnapshot(
  candidateValue: unknown,
  snapshotValue: unknown,
  publishedAtValue: unknown,
): TaxConfigurationSnapshot {
  return normalized(() => {
    const candidate = parseTaxPublicationCandidate(candidateValue),
      raw = closed(detached(snapshotValue), [
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
    const c = candidate.content,
      publishedAt = String(parseCanonicalInstant(publishedAtValue));
    if (
      raw.lifecycle !== "Published" ||
      raw.createdAt !== publishedAt ||
      raw.configurationReference !== c.configurationReference ||
      raw.versionReference !== c.targetVersionReference ||
      raw.brandReference !== c.brandReference ||
      raw.storeReference !== c.storeReference ||
      raw.aggregateVersion !== c.targetAggregateVersion ||
      raw.versionNumber !== c.targetVersionNumber ||
      raw.snapshotDigest !== candidate.contentDigest ||
      raw.stableCode !== c.stableCode ||
      raw.jurisdictionCode !== c.jurisdictionCode ||
      !equal(raw.currencyMetadata, c.currencyMetadata) ||
      !equal(raw.effectivePeriod, c.effectivePeriod) ||
      !equal(raw.rules, c.rules)
    )
      return fail();
    const r = closed(raw.registrationEvidence, [
      "applicabilityReference",
      "operatingEntityTaxReference",
      "jurisdictionProfileReference",
      "status",
      "validUntil",
    ]);
    if (r.status !== "Verified") return fail();
    const registrationEvidence: TaxRegistrationEvidence = {
      applicabilityReference: parsePricingReference(r.applicabilityReference),
      operatingEntityTaxReference: parsePricingReference(r.operatingEntityTaxReference),
      jurisdictionProfileReference: parsePricingReference(r.jurisdictionProfileReference),
      status: r.status,
      validUntil: String(parseCanonicalInstant(r.validUntil)),
    };
    const p = closed(raw.professionalEvidence, [
      "evidenceReference",
      "snapshotReference",
      "snapshotDigest",
      "professionalReviewReference",
      "fixtureSuiteReference",
      "fixtureSuiteDigest",
      "result",
      "reviewedAt",
      "validUntil",
    ]);
    if (p.result !== "Pass") return fail();
    const professionalEvidence: TaxProfessionalEvidence = {
      evidenceReference: parsePricingReference(p.evidenceReference),
      snapshotReference: parsePricingReference(p.snapshotReference),
      snapshotDigest: parsePricingDigest(p.snapshotDigest),
      professionalReviewReference: parsePricingReference(p.professionalReviewReference),
      fixtureSuiteReference: parsePricingReference(p.fixtureSuiteReference),
      fixtureSuiteDigest: parsePricingDigest(p.fixtureSuiteDigest),
      result: p.result,
      reviewedAt: String(parseCanonicalInstant(p.reviewedAt)),
      validUntil: String(parseCanonicalInstant(p.validUntil)),
    };
    const snapshot = createTaxConfigurationSnapshot({
      configurationReference: c.configurationReference,
      versionReference: c.targetVersionReference,
      brandReference: c.brandReference,
      storeReference: c.storeReference,
      stableCode: c.stableCode,
      aggregateVersion: c.targetAggregateVersion,
      versionNumber: c.targetVersionNumber,
      snapshotDigest: candidate.contentDigest,
      lifecycle: "Published",
      jurisdictionCode: c.jurisdictionCode,
      currencyMetadata: c.currencyMetadata,
      effectivePeriod: c.effectivePeriod,
      rules: c.rules,
      createdAt: publishedAt,
      registrationEvidence,
      professionalEvidence,
    });
    return snapshot;
  });
}

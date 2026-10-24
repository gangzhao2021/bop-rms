import { readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  parseCatalogCode,
  parseCatalogLocale,
  parseLocalizedNames,
  type CatalogProductTaxClassificationDefinition,
} from "@rms/catalog";
import {
  parsePricingReference,
  parsePricingDigest,
  parseAmountMinor,
  parseTaxRate,
  parsePricingCode,
  parseTaxConfigAuthoringScope,
  TaxConfigWorkflowError,
  type TaxConfigAuthoringScope,
  type DraftTaxFixtureSimulation,
  type DraftTaxFixture,
  type TaxConfigCandidateFixtureComparison,
  taxConfigCandidateFixtureComparisonFields,
} from "@rms/pricing";
const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
/** A detached bounded wire value; descriptors are inspected before any value is read. */
function copy(value: unknown, maximum = 1048576): unknown {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 40000 || depth > 20) return invalid();
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v || typeof v !== "object") return invalid();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        Reflect.ownKeys(v).length !== v.length + 1 ||
        v.length > 4096
      )
        return invalid();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return invalid();
          return visit(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    return Object.freeze(
      Object.fromEntries(
        Reflect.ownKeys(v).map((k) => {
          if (typeof k !== "string") return invalid();
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d?.enumerable || !("value" in d)) return invalid();
          return [k, visit(d.value, depth + 1)];
        }),
      ),
    );
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximum) return invalid();
  return result;
}
function closed(value: unknown, keys: readonly string[]) {
  return readClosedRecord(value, keys);
}
function scope(r: Record<string, unknown>) {
  return parseTaxConfigAuthoringScope(Object.fromEntries(scopeKeys.map((k) => [k, r[k]])));
}
function lease(r: Record<string, unknown>) {
  const observedAt = String(parseCanonicalInstant(r.observedAt)),
    validUntil = String(parseCanonicalInstant(r.validUntil));
  if (validUntil <= observedAt || Date.parse(validUntil) > Date.parse(observedAt) + 5000)
    return invalid();
  return { observedAt, validUntil };
}
export interface TaxConfigClassificationChoices extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigClassificationChoicesV1";
  readonly registryReference: string;
  readonly versionReference: string;
  readonly registryVersion: number;
  readonly snapshotDigest: string;
  readonly defaultLocale: string;
  readonly choices: readonly CatalogProductTaxClassificationDefinition[];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
}
export function parseTaxConfigClassificationChoices(
  value: unknown,
): TaxConfigClassificationChoices {
  try {
    const r = closed(copy(value), [
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
    ]);
    if (
      r.profile !== "TaxConfigClassificationChoicesV1" ||
      r.sourceQualification !== "NotEvaluated" ||
      typeof r.registryVersion !== "number" ||
      !Number.isInteger(r.registryVersion) ||
      r.registryVersion < 1 ||
      r.registryVersion > 2147483647 ||
      !Array.isArray(r.choices) ||
      r.choices.length > 1000
    )
      return invalid();
    const defaultLocale = parseCatalogLocale(r.defaultLocale);
    const choices = r.choices.map((value): CatalogProductTaxClassificationDefinition => {
      const d = closed(value, ["classificationReference", "code", "localizedNames", "lifecycle"]);
      if (d.lifecycle !== "Active" && d.lifecycle !== "Inactive" && d.lifecycle !== "Retired")
        return invalid();
      return Object.freeze({
        classificationReference: parsePricingReference(d.classificationReference),
        code: parseCatalogCode(d.code),
        localizedNames: parseLocalizedNames(d.localizedNames, defaultLocale),
        lifecycle: d.lifecycle,
      });
    });
    if (
      new Set(choices.map((d) => d.classificationReference)).size !== choices.length ||
      new Set(choices.map((d) => d.code)).size !== choices.length
    )
      return invalid();
    return Object.freeze({
      profile: "TaxConfigClassificationChoicesV1",
      ...scope(r),
      registryReference: parsePricingReference(r.registryReference),
      versionReference: parsePricingReference(r.versionReference),
      registryVersion: r.registryVersion,
      snapshotDigest: parsePricingDigest(r.snapshotDigest),
      defaultLocale,
      choices: Object.freeze(choices),
      ...lease(r),
      sourceQualification: "NotEvaluated",
    });
  } catch {
    return invalid();
  }
}
export interface TaxConfigAuthoringSimulation extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigAuthoringSimulationV1";
  readonly configurationReference: string;
  readonly versionReference: string;
  readonly snapshotDigest: string;
  readonly simulation: DraftTaxFixtureSimulation;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
function minor(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(value) ||
    value.length > 20
  )
    return invalid();
  parseAmountMinor(BigInt(value));
  return value;
}
export function parseTaxConfigAuthoringSimulation(value: unknown): TaxConfigAuthoringSimulation {
  try {
    const r = closed(copy(value), [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "versionReference",
      "snapshotDigest",
      "simulation",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ]);
    if (r.profile !== "TaxConfigAuthoringSimulationV1" || r.referenceEligibility !== "NotEvaluated")
      return invalid();
    const configurationReference = parsePricingReference(r.configurationReference),
      versionReference = parsePricingReference(r.versionReference),
      snapshotDigest = parsePricingDigest(r.snapshotDigest);
    const s = closed(r.simulation, [
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
      s.profile !== "TaxDraftFixtureSimulationV1" ||
      (s.kind !== "Basket" && s.kind !== "Refund") ||
      s.professionalReviewStatus !== "NotEvaluated" ||
      s.legalConclusion !== "NotEvaluated" ||
      s.configurationReference !== configurationReference ||
      s.versionReference !== versionReference ||
      s.snapshotDigest !== snapshotDigest ||
      !Array.isArray(s.receiptPreview) ||
      s.receiptPreview.length < 1 ||
      s.receiptPreview.length > 4096
    )
      return invalid();
    const netAmountMinor = minor(s.netAmountMinor),
      taxAmountMinor = minor(s.taxAmountMinor),
      grossAmountMinor = minor(s.grossAmountMinor);
    if (BigInt(netAmountMinor) + BigInt(taxAmountMinor) !== BigInt(grossAmountMinor))
      return invalid();
    if (
      (s.kind === "Basket" &&
        [netAmountMinor, taxAmountMinor, grossAmountMinor].some((v) => BigInt(v) < 0n)) ||
      (s.kind === "Refund" &&
        [netAmountMinor, taxAmountMinor, grossAmountMinor].some((v) => BigInt(v) > 0n))
    )
      return invalid();
    const receiptPreview = s.receiptPreview.map((v) => {
      const p = closed(v, [
        "lineReference",
        "labelCode",
        "componentCode",
        "treatment",
        "rate",
        "taxAmountMinor",
      ]);
      if (
        typeof p.treatment !== "string" ||
        !["Taxable", "ZeroRated", "Exempt"].includes(p.treatment)
      )
        return invalid();
      const rate = parseTaxRate(p.rate);
      if (p.treatment !== "Taxable" && rate !== "0") return invalid();
      return Object.freeze({
        lineReference: parsePricingReference(p.lineReference),
        labelCode: parseCatalogCode(p.labelCode),
        componentCode: parseCatalogCode(p.componentCode),
        treatment: p.treatment,
        rate,
        taxAmountMinor: minor(p.taxAmountMinor),
      });
    });
    if (
      receiptPreview.reduce((sum, p) => sum + BigInt(p.taxAmountMinor), 0n) !==
      BigInt(taxAmountMinor)
    )
      return invalid();
    const simulation: DraftTaxFixtureSimulation = Object.freeze({
      profile: "TaxDraftFixtureSimulationV1",
      fixtureReference: parsePricingReference(s.fixtureReference),
      kind: s.kind,
      configurationReference,
      versionReference,
      snapshotDigest,
      netAmountMinor,
      taxAmountMinor,
      grossAmountMinor,
      receiptPreview: Object.freeze(receiptPreview),
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    });
    return Object.freeze({
      profile: "TaxConfigAuthoringSimulationV1",
      ...scope(r),
      configurationReference,
      versionReference,
      snapshotDigest,
      simulation,
      ...lease(r),
      referenceEligibility: "NotEvaluated",
    });
  } catch {
    return invalid();
  }
}
function parseFixture(value: unknown): DraftTaxFixture {
  const r = closed(value, ["profile", "fixtureReference", "kind", "evaluatedAt", "lines"]);
  if (
    r.profile !== "TaxDraftFixtureV1" ||
    (r.kind !== "Basket" && r.kind !== "Refund") ||
    !Array.isArray(r.lines) ||
    r.lines.length < 1 ||
    r.lines.length > 256
  )
    return invalid();
  const fixtureReference = parsePricingReference(r.fixtureReference);
  const identities = new Set<string>([fixtureReference]);
  const unique = (value: unknown) => {
    const reference = parsePricingReference(value);
    if (identities.has(reference)) return invalid();
    identities.add(reference);
    return reference;
  };
  const lines = r.lines.map((value) => {
    const line = closed(value, [
      "lineReference",
      "calculationReferences",
      "labelCode",
      "taxClassificationReference",
      "orderType",
      "chargeType",
      "amountMinor",
    ]);
    if (
      (line.orderType !== "DineIn" && line.orderType !== "Pickup") ||
      (line.chargeType !== "Sellable" &&
        line.chargeType !== "ServiceCharge" &&
        line.chargeType !== "DeliveryFee" &&
        line.chargeType !== "Tip") ||
      !Array.isArray(line.calculationReferences) ||
      line.calculationReferences.length < 1 ||
      line.calculationReferences.length > 16
    )
      return invalid();
    const amountMinor = minor(line.amountMinor);
    if (
      (r.kind === "Basket" && BigInt(amountMinor) < 0n) ||
      (r.kind === "Refund" && BigInt(amountMinor) > 0n)
    )
      return invalid();
    return Object.freeze({
      lineReference: unique(line.lineReference),
      calculationReferences: Object.freeze(line.calculationReferences.map(unique)),
      labelCode: parsePricingCode(line.labelCode),
      taxClassificationReference: parsePricingReference(line.taxClassificationReference),
      orderType: line.orderType,
      chargeType: line.chargeType,
      amountMinor,
    });
  });
  return Object.freeze({
    profile: "TaxDraftFixtureV1",
    fixtureReference,
    kind: r.kind,
    evaluatedAt: String(parseCanonicalInstant(r.evaluatedAt)),
    lines: Object.freeze(lines),
  });
}
export function parseMerchantTaxConfigSimulationCommand(value: unknown) {
  try {
    const r = closed(copy(value, 131072), [
      "configurationReference",
      "expectedVersionReference",
      "expectedSnapshotDigest",
      "fixture",
    ]);
    return Object.freeze({
      configurationReference: parsePricingReference(r.configurationReference),
      expectedVersionReference: parsePricingReference(r.expectedVersionReference),
      expectedSnapshotDigest: parsePricingDigest(r.expectedSnapshotDigest),
      fixture: parseFixture(r.fixture),
    });
  } catch {
    return invalid();
  }
}

export interface MerchantTaxConfigMaterialComparisonCommand {
  readonly configurationReference: ReturnType<typeof parsePricingReference>;
  readonly targetPublicationCandidate: Readonly<{
    versionReference: ReturnType<typeof parsePricingReference>;
    contentDigest: ReturnType<typeof parsePricingDigest>;
  }>;
  readonly fixtureSuiteMaterial: Readonly<{
    materialReference: ReturnType<typeof parsePricingReference>;
    versionReference: ReturnType<typeof parsePricingReference>;
    contentDigest: ReturnType<typeof parsePricingDigest>;
  }>;
}
function comparisonPin(value: unknown) {
  const r = closed(value, ["versionReference", "contentDigest"]);
  return Object.freeze({
    versionReference: parsePricingReference(r.versionReference),
    contentDigest: parsePricingDigest(r.contentDigest),
  });
}
export function parseMerchantTaxConfigMaterialComparisonCommand(
  value: unknown,
): MerchantTaxConfigMaterialComparisonCommand {
  try {
    const r = closed(copy(value, 8192), [
      "configurationReference",
      "targetPublicationCandidate",
      "fixtureSuiteMaterial",
    ]);
    const suite = closed(r.fixtureSuiteMaterial, [
      "materialReference",
      "versionReference",
      "contentDigest",
    ]);
    return Object.freeze({
      configurationReference: parsePricingReference(r.configurationReference),
      targetPublicationCandidate: comparisonPin(r.targetPublicationCandidate),
      fixtureSuiteMaterial: Object.freeze({
        materialReference: parsePricingReference(suite.materialReference),
        ...comparisonPin({
          versionReference: suite.versionReference,
          contentDigest: suite.contentDigest,
        }),
      }),
    });
  } catch {
    return invalid();
  }
}
export interface TaxConfigMaterialComparison extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigMaterialComparisonV1";
  readonly comparison: TaxConfigCandidateFixtureComparison;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly referenceEligibility: "NotEvaluated";
}
export function parseTaxConfigMaterialComparison(value: unknown): TaxConfigMaterialComparison {
  try {
    const r = closed(copy(value), [
      "profile",
      ...scopeKeys,
      "comparison",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ]);
    if (r.profile !== "TaxConfigMaterialComparisonV1" || r.referenceEligibility !== "NotEvaluated")
      return invalid();
    const actualScope = scope(r),
      times = lease(r);
    const c = closed(r.comparison, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "candidate",
      "suite",
      "cases",
      "allCasesMatched",
      "professionalReviewStatus",
      "legalConclusion",
    ]);
    if (
      c.profile !== "TaxConfigCandidateFixtureComparisonV1" ||
      c.professionalReviewStatus !== "NotEvaluated" ||
      c.legalConclusion !== "NotEvaluated" ||
      c.tenantReference !== actualScope.tenantReference ||
      c.brandReference !== actualScope.brandReference ||
      c.storeReference !== actualScope.storeReference ||
      typeof c.allCasesMatched !== "boolean" ||
      !Array.isArray(c.cases) ||
      c.cases.length < 1 ||
      c.cases.length > 256
    )
      return invalid();
    const candidate = comparisonPin(c.candidate),
      suite = closed(c.suite, ["materialReference", "versionReference", "contentDigest"]);
    const identities = new Set<string>();
    const cases = Object.freeze(
      c.cases.map((value) => {
        const row = closed(value, [
          "fixtureReference",
          "matches",
          "actualDigest",
          "expectedDigest",
          "mismatchedFields",
        ]);
        const fixtureReference = parsePricingReference(row.fixtureReference),
          actualDigest = parsePricingDigest(row.actualDigest),
          expectedDigest = parsePricingDigest(row.expectedDigest);
        if (
          identities.has(fixtureReference) ||
          typeof row.matches !== "boolean" ||
          !Array.isArray(row.mismatchedFields) ||
          row.mismatchedFields.length > 9
        )
          return invalid();
        identities.add(fixtureReference);
        let last = -1;
        const mismatchedFields = Object.freeze(
          row.mismatchedFields.map((value) => {
            const field = taxConfigCandidateFixtureComparisonFields.find(
              (field) => field === value,
            );
            if (field === undefined) return invalid();
            const index = taxConfigCandidateFixtureComparisonFields.indexOf(field);
            if (index <= last) return invalid();
            last = index;
            return field;
          }),
        );
        // Digests are owning comparison declarations; this wire parser has no result preimages.
        if (
          row.matches !== (mismatchedFields.length === 0) ||
          row.matches !== (actualDigest === expectedDigest)
        )
          return invalid();
        return Object.freeze({
          fixtureReference,
          matches: row.matches,
          actualDigest,
          expectedDigest,
          mismatchedFields,
        });
      }),
    );
    if (c.allCasesMatched !== cases.every((row) => row.matches)) return invalid();
    const comparison: TaxConfigCandidateFixtureComparison = Object.freeze({
      profile: "TaxConfigCandidateFixtureComparisonV1",
      tenantReference: actualScope.tenantReference,
      brandReference: actualScope.brandReference,
      storeReference: actualScope.storeReference,
      candidate,
      suite: Object.freeze({
        materialReference: parsePricingReference(suite.materialReference),
        ...comparisonPin({
          versionReference: suite.versionReference,
          contentDigest: suite.contentDigest,
        }),
      }),
      cases,
      allCasesMatched: c.allCasesMatched,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    });
    return Object.freeze({
      profile: "TaxConfigMaterialComparisonV1",
      ...actualScope,
      comparison,
      ...times,
      referenceEligibility: "NotEvaluated",
    });
  } catch {
    return invalid();
  }
}

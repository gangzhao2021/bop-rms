import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import { createTaxConfigurationSnapshot } from "../domain/tax-configuration.js";
import {
  simulateDraftTaxFixture,
  type TaxFixtureSimulation,
} from "../domain/tax-fixture-simulation.js";
import {
  parsePricingDigest,
  type PricingDigest,
  type PricingReference,
} from "../domain/money-tax-contract.js";
import {
  parseTaxConfigCandidateRecord,
  type TaxConfigCandidateRecord,
} from "./tax-config-candidate-authoring.js";
import {
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialContent,
} from "./tax-config-material.js";

export const taxConfigCandidateFixtureComparisonFields = Object.freeze([
  "fixtureReference",
  "kind",
  "configurationReference",
  "versionReference",
  "snapshotDigest",
  "netAmountMinor",
  "taxAmountMinor",
  "grossAmountMinor",
  "receiptPreview",
] as const);
export type TaxConfigCandidateFixtureComparisonField =
  (typeof taxConfigCandidateFixtureComparisonFields)[number];
export interface TaxConfigCandidateFixtureComparison {
  readonly profile: "TaxConfigCandidateFixtureComparisonV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly candidate: Readonly<{
    versionReference: PricingReference;
    contentDigest: PricingDigest;
  }>;
  readonly suite: Readonly<{
    materialReference: PricingReference;
    versionReference: PricingReference;
    contentDigest: PricingDigest;
  }>;
  readonly cases: readonly Readonly<{
    fixtureReference: PricingReference;
    matches: boolean;
    actualDigest: PricingDigest;
    expectedDigest: PricingDigest;
    mismatchedFields: readonly TaxConfigCandidateFixtureComparisonField[];
  }>[];
  readonly allCasesMatched: boolean;
  readonly professionalReviewStatus: "NotEvaluated";
  readonly legalConclusion: "NotEvaluated";
}
const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
const digest = (value: unknown): PricingDigest =>
  parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(value)));

function simulate(record: TaxConfigCandidateRecord, fixture: unknown): TaxFixtureSimulation {
  const c = record.candidate.content;
  // This private unapproved computational view is never persisted or exported as a Draft
  // or Published snapshot. Its separate digest is not the immutable candidate digest.
  const body = {
    configurationReference: c.configurationReference,
    versionReference: c.targetVersionReference,
    brandReference: c.brandReference,
    storeReference: c.storeReference,
    stableCode: c.stableCode,
    aggregateVersion: c.targetAggregateVersion,
    versionNumber: c.targetVersionNumber,
    lifecycle: "Draft" as const,
    jurisdictionCode: c.jurisdictionCode,
    currencyMetadata: c.currencyMetadata,
    effectivePeriod: c.effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: c.rules,
    createdAt: record.preparedAt,
  };
  const view = createTaxConfigurationSnapshot({ ...body, snapshotDigest: digest(body) });
  const result = simulateDraftTaxFixture(view, fixture);
  return Object.freeze({
    fixtureReference: result.fixtureReference,
    kind: result.kind,
    configurationReference: c.configurationReference,
    versionReference: c.targetVersionReference,
    snapshotDigest: record.candidate.contentDigest,
    netAmountMinor: result.netAmountMinor,
    taxAmountMinor: result.taxAmountMinor,
    grossAmountMinor: result.grossAmountMinor,
    receiptPreview: result.receiptPreview,
  });
}
export function simulateTaxConfigCandidateFixture(
  record: unknown,
  fixture: unknown,
): TaxFixtureSimulation {
  return simulate(parseTaxConfigCandidateRecord(record), fixture);
}
export function compareTaxConfigCandidateFixtureSuite(
  recordInput: unknown,
  suiteInput: unknown,
): TaxConfigCandidateFixtureComparison {
  const record = parseTaxConfigCandidateRecord(recordInput),
    suite = parseTaxConfigMaterialVersion(suiteInput);
  if (
    suite.materialKind !== "FixtureSuite" ||
    suite.tenantReference !== record.tenantReference ||
    suite.brandReference !== record.brandReference ||
    suite.storeReference !== record.storeReference
  )
    return invalid();
  const content = parseTaxConfigMaterialContent(suite.content, "FixtureSuite"),
    c = record.candidate.content;
  if (
    !("cases" in content) ||
    content.cases.length < 1 ||
    content.cases.length > 256 ||
    content.targetPublicationCandidate.versionReference !== c.targetVersionReference ||
    content.targetPublicationCandidate.contentDigest !== record.candidate.contentDigest ||
    canonicalizeRfc8785(content.currencyMetadata) !== canonicalizeRfc8785(c.currencyMetadata)
  )
    return invalid();
  const cases = Object.freeze(
    content.cases.map(({ fixture, expected }) => {
      if (
        expected.configurationReference !== c.configurationReference ||
        expected.versionReference !== c.targetVersionReference ||
        expected.snapshotDigest !== record.candidate.contentDigest
      )
        return invalid();
      const actual = simulate(record, fixture);
      const mismatchedFields = Object.freeze(
        taxConfigCandidateFixtureComparisonFields.filter(
          (field) => canonicalizeRfc8785(actual[field]) !== canonicalizeRfc8785(expected[field]),
        ),
      );
      return Object.freeze({
        fixtureReference: fixture.fixtureReference,
        matches: mismatchedFields.length === 0,
        actualDigest: digest(actual),
        expectedDigest: digest(expected),
        mismatchedFields,
      });
    }),
  );
  const result: TaxConfigCandidateFixtureComparison = Object.freeze({
    profile: "TaxConfigCandidateFixtureComparisonV1",
    tenantReference: record.tenantReference,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
    candidate: Object.freeze({
      versionReference: c.targetVersionReference,
      contentDigest: record.candidate.contentDigest,
    }),
    suite: Object.freeze({
      materialReference: suite.materialReference,
      versionReference: suite.versionReference,
      contentDigest: suite.contentDigest,
    }),
    cases,
    allCasesMatched: cases.every((value) => value.matches),
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  });
  if (new TextEncoder().encode(canonicalizeRfc8785(result)).length > 1048576) return invalid();
  return result;
}

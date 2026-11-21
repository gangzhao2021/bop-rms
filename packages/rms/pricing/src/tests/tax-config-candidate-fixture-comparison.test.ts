import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { input } from "./price-quote.fixture.js";
import { createTaxConfigurationSnapshot } from "../domain/tax-configuration.js";
import {
  simulateApprovedTaxFixture,
  simulateDraftTaxFixture,
} from "../domain/tax-fixture-simulation.js";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
  parseTaxRate,
} from "../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringScope,
} from "../contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialContent,
  taxConfigMaterialContentDigest,
  type TaxFixtureSuiteMaterial,
} from "../contracts/tax-config-material.js";
import { createTaxPublicationCandidate } from "../contracts/tax-config-publication-candidate.js";
import {
  parseTaxConfigCandidateCommand,
  createTaxConfigCandidateRecord,
} from "../contracts/tax-config-candidate-authoring.js";
import {
  simulateTaxConfigCandidateFixture,
  compareTaxConfigCandidateFixtureSuite,
  taxConfigCandidateFixtureComparisonFields,
} from "../contracts/tax-config-candidate-fixture-comparison.js";
// Controlled source packets, not current IAM, professional applicability or publication proof.
const id = (n: number) =>
  parsePricingReference(`01902602-0017-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = (v: unknown) => parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(v)));
const preparedAt = "2026-10-01T16:00:00.000Z";
function candidateFixture(inclusion: "Exclusive" | "Inclusive" = "Exclusive", compound = false) {
  const original = input().taxConfiguration;
  const { snapshotDigest: originalDigest, ...source } = original;
  expect(originalDigest).toMatch(/^sha256:/u);
  const body = {
    ...source,
    lifecycle: "Draft" as const,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: source.rules.map((rule) => ({ ...rule, priceInclusion: inclusion })),
  };
  if (compound) {
    const first = body.rules[0];
    if (!first) throw new Error("missing controlled rule");
    body.rules = [
      { ...first, rate: parseTaxRate("0.05") },
      {
        ...first,
        ruleReference: id(300),
        taxComponentCode: parsePricingCode("SECOND"),
        rate: parseTaxRate("0.08"),
        calculationOrder: 2,
        compoundOnPriorTax: true,
      },
    ];
  }
  const snapshot = createTaxConfigurationSnapshot({ ...body, snapshotDigest: hash(body) });
  const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    actorReference: id(2),
  });
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: id(3),
    snapshot,
  });
  const content = {
    operatingEntityProfileVersionReference: id(50),
    operatingEntityTaxReference: null,
    jurisdictionCode: "CA-ON",
    applicability: "Applicable",
    sourceIssuedAt: "2026-09-01T00:00:00.000Z",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: null,
    declaredSourceDigest: null,
  };
  const registration = parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(5),
    versionReference: id(6),
    revision: 1,
    previousVersionReference: null,
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "RegistrationApplicability"),
    recordedByActorReference: id(4),
    createdAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const registrationMaterial = {
    materialReference: registration.materialReference,
    versionReference: registration.versionReference,
    contentDigest: registration.contentDigest,
  };
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(9),
    sourceRuleBindings: snapshot.rules.map((rule, i) => ({
      sourceRuleReference: rule.ruleReference,
      targetRuleReference: id(100 + i),
    })),
    registrationMaterial,
  });
  const command = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(12),
    configurationReference: snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial,
  });
  const allocation = {
    scope,
    command,
    candidate,
    draft,
    registrationMaterial: registration,
    preparedAt,
    auditReference: id(10),
    eventReference: id(11),
  };
  const record = createTaxConfigCandidateRecord(allocation);
  return { record, draft };
}
function basket(
  record: ReturnType<typeof candidateFixture>["record"],
  kind: "Basket" | "Refund" = "Basket",
  n = 400,
) {
  const rule = record.candidate.content.rules[0];
  if (!rule) throw new Error("missing controlled rule");
  return {
    profile: "TaxDraftFixtureV1" as const,
    fixtureReference: id(n),
    kind,
    evaluatedAt: "2026-08-13T16:00:00.000Z",
    lines: [
      {
        lineReference: id(n + 1),
        calculationReferences: record.candidate.content.rules.map((_, i) => id(n + 2 + i)),
        labelCode: "SYNTHETIC_MEAL",
        taxClassificationReference: rule.taxClassificationReference,
        orderType: "Pickup" as const,
        chargeType: "Sellable" as const,
        amountMinor: kind === "Basket" ? "1000" : "-1000",
      },
    ],
  };
}
function suite(
  record: ReturnType<typeof candidateFixture>["record"],
  cases?: TaxFixtureSuiteMaterial["cases"],
) {
  const f = basket(record);
  const content = {
    targetPublicationCandidate: {
      versionReference: record.candidate.content.targetVersionReference,
      contentDigest: record.candidate.contentDigest,
    },
    currencyMetadata: record.candidate.content.currencyMetadata,
    cases: cases ?? [{ fixture: f, expected: simulateTaxConfigCandidateFixture(record, f) }],
    sourceIssuedAt: preparedAt,
    declaredSourceDigest: null,
  };
  return parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: record.tenantReference,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
    materialReference: id(600),
    versionReference: id(601),
    revision: 1,
    previousVersionReference: null,
    materialKind: "FixtureSuite",
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "FixtureSuite"),
    recordedByActorReference: id(602),
    createdAt: preparedAt,
    recordedAt: preparedAt,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
}
describe("immutable Candidate fixture comparison (controlled source facts, no professional qualification)", () => {
  it.each(["Exclusive", "Inclusive"] as const)(
    "computes %s without a qualified Published snapshot",
    (inclusion) => {
      const { record, draft } = candidateFixture(inclusion),
        f = basket(record);
      const result = simulateTaxConfigCandidateFixture(record, f);
      expect(result).toMatchObject(
        inclusion === "Exclusive"
          ? { netAmountMinor: "1000", taxAmountMinor: "130", grossAmountMinor: "1130" }
          : { netAmountMinor: "885", taxAmountMinor: "115", grossAmountMinor: "1000" },
      );
      expect(Object.keys(result)).toEqual([...taxConfigCandidateFixtureComparisonFields]);
      expect(result.snapshotDigest).toBe(record.candidate.contentDigest);
      expect(result.snapshotDigest).not.toBe(draft.snapshot.snapshotDigest);
      expect(Object.isFrozen(result.receiptPreview)).toBe(true);
      expect(() =>
        simulateApprovedTaxFixture(draft.snapshot, {
          ...f,
          fixtureSuiteReference: id(800),
          fixtureSuiteDigest: hash("controlled"),
        }),
      ).toThrow();
      expect(simulateDraftTaxFixture(draft.snapshot, f).profile).toBe(
        "TaxDraftFixtureSimulationV1",
      );
    },
  );
  it("compares every Basket and Refund and hashes all nine fields", () => {
    const { record } = candidateFixture(),
      f = basket(record),
      refund = basket(record, "Refund", 500);
    const actual = simulateTaxConfigCandidateFixture(record, f),
      negative = simulateTaxConfigCandidateFixture(record, refund);
    expect(negative).toMatchObject({
      netAmountMinor: "-1000",
      taxAmountMinor: "-130",
      grossAmountMinor: "-1130",
    });
    const s = suite(record, [
      { fixture: f, expected: actual },
      { fixture: refund, expected: negative },
    ]);
    const result = compareTaxConfigCandidateFixtureSuite(record, s);
    expect(result.allCasesMatched).toBe(true);
    expect(result.cases.map((c) => c.actualDigest)).toEqual([hash(actual), hash(negative)]);
    expect(result.cases.every((c) => c.expectedDigest === c.actualDigest && c.matches)).toBe(true);
    expect(result).toMatchObject({
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    });
    expect(Object.isFrozen(result.cases[0]?.mismatchedFields)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("receiptPreview");
  });
  it("reports coherent declared wrong amounts rather than approving them", () => {
    const { record } = candidateFixture(),
      f = basket(record),
      actual = simulateTaxConfigCandidateFixture(record, f);
    const expected = {
      ...actual,
      taxAmountMinor: "131",
      grossAmountMinor: "1131",
      receiptPreview: actual.receiptPreview.map((p) => ({ ...p, taxAmountMinor: "131" })),
    };
    const result = compareTaxConfigCandidateFixtureSuite(
      record,
      suite(record, [{ fixture: f, expected }]),
    );
    expect(result.allCasesMatched).toBe(false);
    expect(result.cases[0]?.mismatchedFields).toEqual([
      "taxAmountMinor",
      "grossAmountMinor",
      "receiptPreview",
    ]);
    expect(result.cases[0]?.expectedDigest).toBe(hash(expected));
  });
  it("uses ordered compound components and detects receipt order and rate changes", () => {
    const { record } = candidateFixture("Exclusive", true),
      f = basket(record),
      actual = simulateTaxConfigCandidateFixture(record, f);
    expect(actual.taxAmountMinor).toBe("134");
    expect(actual.receiptPreview.map((p) => p.taxAmountMinor)).toEqual(["50", "84"]);
    const expected = {
      ...actual,
      receiptPreview: [...actual.receiptPreview].reverse().map((p) => ({ ...p, rate: "0.09" })),
    };
    const result = compareTaxConfigCandidateFixtureSuite(
      record,
      suite(record, [{ fixture: f, expected }]),
    );
    expect(result.cases[0]?.mismatchedFields).toEqual(["receiptPreview"]);
    expect(result.cases[0]?.actualDigest).not.toBe(result.cases[0]?.expectedDigest);
  });
  it("detaches input receipts and rejects accessors without evaluating them", () => {
    const { record } = candidateFixture(),
      original = suite(record);
    const inputPacket = JSON.parse(JSON.stringify(original));
    const result = compareTaxConfigCandidateFixtureSuite(record, inputPacket);
    inputPacket.content.cases[0].expected.receiptPreview[0].rate = "0.99";
    expect(result.allCasesMatched).toBe(true);
    expect(result.cases[0]?.actualDigest).toBe(result.cases[0]?.expectedDigest);
    let visited = false;
    const forged = Object.defineProperty({ ...original }, "content", {
      enumerable: true,
      get() {
        visited = true;
        return original.content;
      },
    });
    expect(() => compareTaxConfigCandidateFixtureSuite(record, forged)).toThrow();
    expect(visited).toBe(false);
    expect(() =>
      simulateTaxConfigCandidateFixture(record, {
        ...basket(record),
        lines: Array.from({ length: 257 }, () => basket(record).lines[0]),
      }),
    ).toThrow();
  });
  it("rejects missing coverage, inactive periods and forged input fields", () => {
    const { record } = candidateFixture(),
      f = basket(record);
    expect(() =>
      simulateTaxConfigCandidateFixture(record, { ...f, evaluatedAt: "2026-07-01T00:00:00.000Z" }),
    ).toThrow();
    expect(() =>
      simulateTaxConfigCandidateFixture(record, {
        ...f,
        lines: f.lines.map((l) => ({ ...l, taxClassificationReference: id(999) })),
      }),
    ).toThrow();
    expect(() => simulateTaxConfigCandidateFixture(record, { ...f, approved: true })).toThrow();
    expect(() =>
      simulateTaxConfigCandidateFixture({ ...record, qualification: "Verified" }, f),
    ).toThrow();
    const getter = Object.defineProperty({ ...f }, "lines", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() => simulateTaxConfigCandidateFixture(record, getter)).toThrow();
    expect(() => simulateTaxConfigCandidateFixture(record, { ...f, lines: [] })).toThrow();
  });
  it("rejects foreign scope, wrong candidate configuration and forged immutable hashes", () => {
    const { record } = candidateFixture(),
      s = suite(record),
      f = basket(record),
      actual = simulateTaxConfigCandidateFixture(record, f);
    expect(() =>
      compareTaxConfigCandidateFixtureSuite(record, { ...s, tenantReference: id(900) }),
    ).toThrow();
    expect(() =>
      compareTaxConfigCandidateFixtureSuite(record, { ...s, contentDigest: hash("forged") }),
    ).toThrow();
    expect(() =>
      compareTaxConfigCandidateFixtureSuite(
        record,
        suite(record, [{ fixture: f, expected: { ...actual, configurationReference: id(901) } }]),
      ),
    ).toThrow();
    expect(() =>
      compareTaxConfigCandidateFixtureSuite(
        { ...record, candidate: { ...record.candidate, contentDigest: hash("forged") } },
        s,
      ),
    ).toThrow();
  });
  it("rejects full currency drift, wrong target pins and absent or excessive case arrays", () => {
    const { record } = candidateFixture(),
      original = suite(record);
    const content: TaxFixtureSuiteMaterial = parseSuiteContent(original.content);
    for (const changed of [
      { ...content, currencyMetadata: { ...content.currencyMetadata, metadataVersion: 2 } },
      {
        ...content,
        targetPublicationCandidate: {
          ...content.targetPublicationCandidate,
          versionReference: id(910),
        },
      },
      { ...content, cases: [] },
      { ...content, cases: Array.from({ length: 257 }, () => content.cases[0]) },
    ]) {
      expect(() =>
        compareTaxConfigCandidateFixtureSuite(record, {
          ...original,
          content: changed,
          contentDigest: taxConfigMaterialContentDigest(changed, "FixtureSuite"),
        }),
      ).toThrow();
    }
  });
});
function parseSuiteContent(value: unknown): TaxFixtureSuiteMaterial {
  const parsed = parseTaxConfigMaterialContent(value, "FixtureSuite");
  if (!("cases" in parsed)) throw new Error("not a controlled Suite");
  return parsed;
}

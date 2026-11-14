import { expect, it } from "vitest";
import {
  parseTaxConfigClassificationChoices,
  parseTaxConfigAuthoringSimulation,
  parseMerchantTaxConfigSimulationCommand,
  parseMerchantTaxConfigMaterialComparisonCommand,
  parseTaxConfigMaterialComparison,
} from "./merchant-tax-config-workbench-values.js";
const id = (n: number) => `01902421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const at = "2026-10-06T14:00:00.000Z",
  until = "2026-10-06T14:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
const choices = () => ({
  profile: "TaxConfigClassificationChoicesV1",
  ...scope,
  registryReference: id(5),
  versionReference: id(6),
  registryVersion: 1,
  snapshotDigest: hash,
  defaultLocale: "en-CA",
  choices: [
    {
      classificationReference: id(7),
      code: "TAX",
      localizedNames: { "en-CA": "Tax classification" },
      lifecycle: "Inactive",
    },
  ],
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const simulation = () => ({
  profile: "TaxConfigAuthoringSimulationV1",
  ...scope,
  configurationReference: id(8),
  versionReference: id(9),
  snapshotDigest: hash,
  simulation: {
    profile: "TaxDraftFixtureSimulationV1",
    fixtureReference: id(10),
    kind: "Basket",
    configurationReference: id(8),
    versionReference: id(9),
    snapshotDigest: hash,
    netAmountMinor: "100",
    taxAmountMinor: "13",
    grossAmountMinor: "113",
    receiptPreview: [
      {
        lineReference: id(11),
        labelCode: "MEAL",
        componentCode: "TAX",
        treatment: "Taxable",
        rate: "0.13",
        taxAmountMinor: "13",
      },
    ],
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  },
  observedAt: at,
  validUntil: until,
  referenceEligibility: "NotEvaluated",
});
it("copies actual inactive definitions truthfully without permission or professional qualification", () => {
  const input = choices(),
    result = parseTaxConfigClassificationChoices(input);
  const originalChoice = input.choices[0];
  if (!originalChoice) throw new Error("Missing fixture choice");
  originalChoice.localizedNames["en-CA"] = "Changed";
  expect(result.choices[0]?.localizedNames["en-CA"]).toBe("Tax classification");
  expect(result.choices[0]?.lifecycle).toBe("Inactive");
  expect(Object.isFrozen(result.choices)).toBe(true);
});
it.each(["sourceQualification", "registryVersion", "snapshotDigest", "defaultLocale"])(
  "rejects malformed classification %s",
  (key) => {
    const value = { ...choices(), [key]: key === "registryVersion" ? 2147483648 : "Invalid" };
    expect(() => parseTaxConfigClassificationChoices(value)).toThrow();
  },
);
it("rejects duplicate definition identities, unknown fields and getters without invoking them", () => {
  const input = choices();
  expect(() =>
    parseTaxConfigClassificationChoices({
      ...input,
      choices: [...input.choices, ...input.choices],
    }),
  ).toThrow();
  expect(() => parseTaxConfigClassificationChoices({ ...input, approved: true })).toThrow();
  let invoked = false;
  Object.defineProperty(input, "choices", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  expect(() => parseTaxConfigClassificationChoices(input)).toThrow();
  expect(invoked).toBe(false);
});
it("bounds actual choices and original lease, rejecting sparse arrays", () => {
  const input = choices();
  expect(() => parseTaxConfigClassificationChoices({ ...input, choices: new Array(1) })).toThrow();
  expect(() =>
    parseTaxConfigClassificationChoices({
      ...input,
      choices: Array.from({ length: 1001 }, () => input.choices[0]),
    }),
  ).toThrow();
  expect(() =>
    parseTaxConfigClassificationChoices({ ...input, validUntil: "2026-10-06T14:00:05.001Z" }),
  ).toThrow();
});
it("preserves detached exact mechanical result without claiming approved fixture evidence", () => {
  const input = simulation(),
    result = parseTaxConfigAuthoringSimulation(input);
  const originalLine = input.simulation.receiptPreview[0];
  if (!originalLine) throw new Error("Missing fixture receipt line");
  originalLine.rate = "0.2";
  expect(result.simulation.receiptPreview[0]?.rate).toBe("0.13");
  expect(result.simulation.professionalReviewStatus).toBe("NotEvaluated");
  expect(Object.isFrozen(result.simulation)).toBe(true);
});
it.each(["configurationReference", "versionReference", "snapshotDigest"])(
  "rejects simulation inner/outer %s drift",
  (key) => {
    const input = simulation();
    expect(() =>
      parseTaxConfigAuthoringSimulation({
        ...input,
        simulation: {
          ...input.simulation,
          [key]: key === "snapshotDigest" ? "sha256:" + "b".repeat(64) : id(99),
        },
      }),
    ).toThrow();
  },
);
it("rejects fabricated professional approval, changed totals and credential fields", () => {
  const input = simulation();
  expect(() =>
    parseTaxConfigAuthoringSimulation({
      ...input,
      simulation: { ...input.simulation, professionalReviewStatus: "Pass" },
    }),
  ).toThrow();
  expect(() =>
    parseTaxConfigAuthoringSimulation({
      ...input,
      simulation: { ...input.simulation, grossAmountMinor: "114" },
    }),
  ).toThrow();
  expect(() => parseTaxConfigAuthoringSimulation({ ...input, token: "hidden" })).toThrow();
});
it("accepts signed refund mechanical totals without a professional suite", () => {
  const input = simulation();
  expect(
    parseTaxConfigAuthoringSimulation({
      ...input,
      simulation: {
        ...input.simulation,
        kind: "Refund",
        netAmountMinor: "-100",
        taxAmountMinor: "-13",
        grossAmountMinor: "-113",
        receiptPreview: [{ ...input.simulation.receiptPreview[0], taxAmountMinor: "-13" }],
      },
    }).simulation.grossAmountMinor,
  ).toBe("-113");
});
it("detaches fixture before authorization and refuses forged server fields", () => {
  const fixture = {
    profile: "TaxDraftFixtureV1",
    fixtureReference: id(10),
    kind: "Basket",
    evaluatedAt: at,
    lines: [
      {
        lineReference: id(11),
        calculationReferences: [id(12)],
        labelCode: "MEAL",
        taxClassificationReference: id(7),
        orderType: "Pickup",
        chargeType: "Sellable",
        amountMinor: "100",
      },
    ],
  };
  const input = {
    configurationReference: id(8),
    expectedVersionReference: id(9),
    expectedSnapshotDigest: hash,
    fixture,
  };
  const parsed = parseMerchantTaxConfigSimulationCommand(input);
  fixture.profile = "Changed";
  expect(parsed.fixture).not.toBe(fixture);
  expect(parsed.fixture.fixtureReference).toBe(id(10));
  expect(parsed.fixture.kind).toBe("Basket");
  expect(parsed.fixture.lines[0]?.amountMinor).toBe("100");
  expect(() =>
    parseMerchantTaxConfigSimulationCommand({ ...input, professionalEvidence: null }),
  ).toThrow();
});

it("rejects extra fixture fields, duplicate generated IDs and signed Basket input before acquisition", () => {
  const fixture = {
    profile: "TaxDraftFixtureV1",
    fixtureReference: id(10),
    kind: "Basket",
    evaluatedAt: at,
    lines: [
      {
        lineReference: id(11),
        calculationReferences: [id(12)],
        labelCode: "MEAL",
        taxClassificationReference: id(7),
        orderType: "Pickup",
        chargeType: "Sellable",
        amountMinor: "100",
      },
    ],
  };
  const base = {
    configurationReference: id(8),
    expectedVersionReference: id(9),
    expectedSnapshotDigest: hash,
    fixture,
  };
  expect(() =>
    parseMerchantTaxConfigSimulationCommand({ ...base, fixture: { ...fixture, approved: true } }),
  ).toThrow();
  expect(() =>
    parseMerchantTaxConfigSimulationCommand({
      ...base,
      fixture: { ...fixture, lines: [{ ...fixture.lines[0], calculationReferences: [id(11)] }] },
    }),
  ).toThrow();
  expect(() =>
    parseMerchantTaxConfigSimulationCommand({
      ...base,
      fixture: { ...fixture, lines: [{ ...fixture.lines[0], amountMinor: "-100" }] },
    }),
  ).toThrow();
});

const comparisonCommand = () => ({
  configurationReference: id(20),
  targetPublicationCandidate: { versionReference: id(21), contentDigest: hash },
  fixtureSuiteMaterial: {
    materialReference: id(22),
    versionReference: id(23),
    contentDigest: hash,
  },
});
const comparisonPacket = () => ({
  profile: "TaxConfigMaterialComparisonV1",
  ...scope,
  comparison: {
    profile: "TaxConfigCandidateFixtureComparisonV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    candidate: comparisonCommand().targetPublicationCandidate,
    suite: comparisonCommand().fixtureSuiteMaterial,
    cases: [
      {
        fixtureReference: id(24),
        matches: true,
        actualDigest: hash,
        expectedDigest: hash,
        mismatchedFields: [] as string[],
      },
    ],
    allCasesMatched: true,
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  },
  observedAt: at,
  validUntil: until,
  referenceEligibility: "NotEvaluated",
});
it("parses detached exact comparison source pins and retains truthful nonmatch summaries", () => {
  const command = comparisonCommand(),
    parsed = parseMerchantTaxConfigMaterialComparisonCommand(command);
  command.fixtureSuiteMaterial.materialReference = id(999);
  expect(parsed.fixtureSuiteMaterial.materialReference).toBe(id(22));
  const packet = comparisonPacket();
  packet.comparison.allCasesMatched = false;
  packet.comparison.cases = [
    {
      fixtureReference: id(24),
      matches: false,
      actualDigest: hash,
      expectedDigest: "sha256:" + "b".repeat(64),
      mismatchedFields: ["taxAmountMinor", "receiptPreview"],
    },
  ];
  const result = parseTaxConfigMaterialComparison(packet);
  expect(result.comparison.allCasesMatched).toBe(false);
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(result.comparison.cases[0]?.mismatchedFields)).toBe(true);
});
it("rejects comparison scope, qualification, lease, hash and summary coherence drift", () => {
  const row = comparisonPacket().comparison.cases[0];
  if (!row) throw Error("missing controlled comparison row");
  const changes = [
    { ...comparisonPacket(), referenceEligibility: "Eligible" },
    { ...comparisonPacket(), validUntil: "2026-10-06T14:00:06.000Z" },
    {
      ...comparisonPacket(),
      comparison: { ...comparisonPacket().comparison, tenantReference: id(99) },
    },
    {
      ...comparisonPacket(),
      comparison: { ...comparisonPacket().comparison, allCasesMatched: false },
    },
    {
      ...comparisonPacket(),
      comparison: { ...comparisonPacket().comparison, cases: [{ ...row, matches: false }] },
    },
    {
      ...comparisonPacket(),
      comparison: {
        ...comparisonPacket().comparison,
        cases: [{ ...row, actualDigest: "invalid" }],
      },
    },
    { ...comparisonPacket(), comparison: { ...comparisonPacket().comparison, cases: [row, row] } },
    {
      ...comparisonPacket(),
      comparison: { ...comparisonPacket().comparison, professionalReviewStatus: "Verified" },
    },
  ];
  for (const value of changes) expect(() => parseTaxConfigMaterialComparison(value)).toThrow();
});
it("rejects unknown, duplicate, unordered comparison fields and missing/excess cases", () => {
  const row = comparisonPacket().comparison.cases[0];
  if (!row) throw Error("missing controlled comparison row");
  for (const mismatchedFields of [
    ["rate"],
    ["receiptPreview", "taxAmountMinor"],
    ["taxAmountMinor", "taxAmountMinor"],
  ])
    expect(() =>
      parseTaxConfigMaterialComparison({
        ...comparisonPacket(),
        comparison: {
          ...comparisonPacket().comparison,
          allCasesMatched: false,
          cases: [
            {
              ...row,
              matches: false,
              expectedDigest: "sha256:" + "b".repeat(64),
              mismatchedFields,
            },
          ],
        },
      }),
    ).toThrow();
  for (const cases of [[], Array.from({ length: 257 }, () => row)])
    expect(() =>
      parseTaxConfigMaterialComparison({
        ...comparisonPacket(),
        comparison: { ...comparisonPacket().comparison, cases },
      }),
    ).toThrow();
});
it("rejects getter and extra command fields before reading supplied values", () => {
  let visited = false;
  const command = Object.defineProperty(comparisonCommand(), "fixtureSuiteMaterial", {
    enumerable: true,
    get() {
      visited = true;
      return null;
    },
  });
  expect(() => parseMerchantTaxConfigMaterialComparisonCommand(command)).toThrow();
  expect(visited).toBe(false);
  expect(() =>
    parseMerchantTaxConfigMaterialComparisonCommand({ ...comparisonCommand(), approved: true }),
  ).toThrow();
  expect(() =>
    parseTaxConfigMaterialComparison({ ...comparisonPacket(), fullExpected: {} }),
  ).toThrow();
});

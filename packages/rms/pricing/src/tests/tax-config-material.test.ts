import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { input } from "./price-quote.fixture.js";
import { parsePricingReference, parsePricingDigest } from "../domain/money-tax-contract.js";
import { parseTaxConfigAuthoringScope } from "../contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialContent,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialSummary,
  parseTaxConfigMaterialRoster,
  taxConfigMaterialContentDigest,
  taxConfigMaterialIntentDigest,
} from "../contracts/tax-config-material.js";

// Controlled structured external declarations; these are not verified professional facts.
const id = (n: number) =>
  parsePricingReference(`018ff400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = (letter: string) => parsePricingDigest(`sha256:${letter.repeat(64)}`);
const at = "2026-10-01T16:00:00.000Z";
const later = "2026-10-01T16:00:01.000Z";
const until = "2026-10-01T16:00:05.000Z";
const scope = parseTaxConfigAuthoringScope({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
});
const candidate = { versionReference: id(40), contentDigest: hash("c") };
function registration() {
  return {
    operatingEntityProfileVersionReference: id(10),
    operatingEntityTaxReference: id(11),
    jurisdictionCode: "CA-ON",
    applicability: "Applicable",
    sourceIssuedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
    declaredSourceDigest: hash("d"),
  };
}
function report() {
  return {
    targetPublicationCandidate: { ...candidate },
    registrationMaterial: { versionReference: id(20), contentDigest: hash("a") },
    fixtureSuiteMaterial: { versionReference: id(21), contentDigest: hash("b") },
    declaredIssuer: {
      displayName: "Synthetic reviewer",
      organizationName: "Synthetic organization",
      credentialIdentifier: "DECLARED_ONLY",
    },
    reviewedAt: at,
    validUntil: "2026-10-02T16:00:00.000Z",
    declaredConclusion: "Pass",
    declaredSourceDigest: hash("d"),
  };
}
function suiteCase(ref = 50, kind: "Basket" | "Refund" = "Basket") {
  const sign = kind === "Refund" ? "-" : "";
  return {
    fixture: {
      profile: "TaxDraftFixtureV1",
      fixtureReference: id(ref),
      kind,
      evaluatedAt: at,
      lines: [
        {
          lineReference: id(ref + 1),
          calculationReferences: [id(ref + 2)],
          labelCode: "SYNTHETIC_MEAL",
          taxClassificationReference: id(13),
          orderType: "Pickup",
          chargeType: "Sellable",
          amountMinor: `${sign}1000`,
        },
      ],
    },
    expected: {
      fixtureReference: id(ref),
      kind,
      configurationReference: id(30),
      versionReference: candidate.versionReference,
      snapshotDigest: candidate.contentDigest,
      netAmountMinor: `${sign}1000`,
      taxAmountMinor: `${sign}130`,
      grossAmountMinor: `${sign}1130`,
      receiptPreview: [
        {
          lineReference: id(ref + 1),
          labelCode: "SYNTHETIC_MEAL",
          componentCode: "SYNTHETIC_TAX",
          treatment: "Taxable",
          rate: "0.13",
          taxAmountMinor: `${sign}130`,
        },
      ],
    },
  };
}
function suite() {
  return {
    targetPublicationCandidate: { ...candidate },
    currencyMetadata: input().currencyMetadata,
    cases: [suiteCase(), suiteCase(60, "Refund")],
    sourceIssuedAt: at,
    declaredSourceDigest: null,
  };
}
function fixture() {
  const content = parseTaxConfigMaterialContent(registration(), "RegistrationApplicability");
  const command = parseTaxConfigMaterialCommand({
    action: "CreateMaterial",
    operationReference: id(5),
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content,
  });
  const version = parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(6),
    versionReference: id(7),
    revision: 1,
    previousVersionReference: null,
    materialKind: command.materialKind,
    content,
    contentDigest: taxConfigMaterialContentDigest(content, command.materialKind),
    recordedByActorReference: scope.actorReference,
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const operation = {
    profile: "TaxConfigMaterialOperationV1",
    ...scope,
    action: command.action,
    operationReference: command.operationReference,
    materialReference: command.materialReference,
    expectedRevision: command.expectedRevision,
    materialKind: command.materialKind,
    command,
    intentDigest: taxConfigMaterialIntentDigest(scope, command),
    outcome: "Committed",
    version,
    auditReference: id(8),
    eventReference: id(9),
    occurredAt: at,
  };
  const current = {
    profile: "TaxConfigMaterialCurrentV1",
    ...scope,
    materialReference: version.materialReference,
    materialKind: version.materialKind,
    version,
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  };
  const summary = {
    tenantReference: version.tenantReference,
    brandReference: version.brandReference,
    storeReference: version.storeReference,
    materialReference: version.materialReference,
    versionReference: version.versionReference,
    revision: version.revision,
    materialKind: version.materialKind,
    contentDigest: version.contentDigest,
    recordedAt: version.recordedAt,
    status: version.status,
    qualification: version.qualification,
  };
  return { content, command, version, operation, current, summary };
}
function invalid(work: () => unknown) {
  expect(work).toThrow(expect.objectContaining({ code: "TAX_CONFIG_INPUT_INVALID" }));
}

describe("Tax material content", () => {
  it("records actual structured declarations without manufacturing registration verification", () => {
    const source = registration(),
      parsed = parseTaxConfigMaterialContent(source, "RegistrationApplicability");
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(taxConfigMaterialContentDigest(source, "RegistrationApplicability")).not.toBe(
      source.declaredSourceDigest,
    );
    source.applicability = "NotApplicable";
    expect(parsed).toHaveProperty("applicability", "Applicable");
  });
  it("binds reports to a frozen candidate and exact material versions, retaining only declared issuer claims", () => {
    const source = report(),
      parsed = parseTaxConfigMaterialContent(source, "ProfessionalReport");
    expect(parsed).toEqual(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(Reflect.get(parsed, "declaredIssuer"))).toBe(true);
    source.targetPublicationCandidate.versionReference = id(90);
    expect(parsed).toHaveProperty(
      "targetPublicationCandidate.versionReference",
      candidate.versionReference,
    );
    expect(parsed).not.toHaveProperty("reviewStatus");
    expect(parsed).not.toHaveProperty("professionalVerified");
  });
  it("accepts both signed Basket and Refund expected component results without claiming approved coverage", () => {
    const parsed = parseTaxConfigMaterialContent(suite(), "FixtureSuite");
    expect(parsed).toHaveProperty("cases.1.expected.taxAmountMinor", "-130");
    expect(Object.isFrozen(Reflect.get(parsed, "cases"))).toBe(true);
    expect(parsed).not.toHaveProperty("approved");
  });
  it.each(["targetPublicationCandidate", "registrationMaterial", "fixtureSuiteMaterial"])(
    "requires closed immutable target %s",
    (field) => {
      const original = report();
      invalid(() =>
        parseTaxConfigMaterialContent(
          {
            ...original,
            [field]: { versionReference: id(41), contentDigest: hash("a"), scope: scope },
          },
          "ProfessionalReport",
        ),
      );
    },
  );
  it.each([
    { jurisdictionCode: "US-NY" },
    { applicability: "Verified" },
    { effectiveUntil: at },
    { declaredSourceDigest: "d".repeat(64) },
    { sourceIssuedAt: "2026-10-01T16:00:00Z" },
    { operatingEntityTaxReference: "018ff400-0000-4000-8000-000000000011" },
  ])("rejects invalid registration metadata %j", (change) =>
    invalid(() =>
      parseTaxConfigMaterialContent({ ...registration(), ...change }, "RegistrationApplicability"),
    ),
  );
  it.each([
    { reviewStatus: "Pass" },
    { professionalVerified: true },
    { validUntil: at },
    { declaredConclusion: "Verified" },
    { publishedAt: at },
    { providerReady: true },
  ])("rejects certification or extra publication claims %j", (change) =>
    invalid(() => parseTaxConfigMaterialContent({ ...report(), ...change }, "ProfessionalReport")),
  );
  it("rejects issuer markup/credential objects without disclosing the supplied text", () => {
    const value = {
      ...report(),
      declaredIssuer: {
        ...report().declaredIssuer,
        displayName: "<script>private issuer</script>",
      },
    };
    try {
      parseTaxConfigMaterialContent(value, "ProfessionalReport");
      expect.fail("must refuse");
    } catch (error) {
      expect(error).toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
      expect(String(error)).not.toContain("private issuer");
    }
    invalid(() =>
      parseTaxConfigMaterialContent(
        {
          ...report(),
          declaredIssuer: {
            ...report().declaredIssuer,
            credentialIdentifier: { secret: "private" },
          },
        },
        "ProfessionalReport",
      ),
    );
  });
  it("rejects accessors without invoking them, sparse arrays and unexpected prototypes", () => {
    let calls = 0;
    const value = report();
    Object.defineProperty(value, "reviewedAt", {
      enumerable: true,
      get() {
        calls++;
        return at;
      },
    });
    invalid(() => parseTaxConfigMaterialContent(value, "ProfessionalReport"));
    expect(calls).toBe(0);
    const sparse = suite();
    delete sparse.cases[0];
    invalid(() => parseTaxConfigMaterialContent(sparse, "FixtureSuite"));
    invalid(() =>
      parseTaxConfigMaterialContent(
        Object.assign(Object.create(null), registration()),
        "RegistrationApplicability",
      ),
    );
  });
  it("refuses Draft/future target mismatches, duplicate fixture IDs and incomplete expected results", () => {
    const value = suite();
    invalid(() =>
      parseTaxConfigMaterialContent(
        {
          ...value,
          cases: [
            { ...suiteCase(), expected: { ...suiteCase().expected, versionReference: id(99) } },
          ],
        },
        "FixtureSuite",
      ),
    );
    invalid(() =>
      parseTaxConfigMaterialContent(
        { ...value, cases: [suiteCase(), suiteCase()] },
        "FixtureSuite",
      ),
    );
    invalid(() =>
      parseTaxConfigMaterialContent(
        {
          ...value,
          cases: [{ ...suiteCase(), expected: { ...suiteCase().expected, receiptPreview: [] } }],
        },
        "FixtureSuite",
      ),
    );
  });
  it("rejects wrong signs, floating minors, unbalanced totals and omitted calculation components", () => {
    const value = suite(),
      item = suiteCase();
    for (const change of [
      { netAmountMinor: "1.5" },
      { grossAmountMinor: "1129" },
      { taxAmountMinor: "-130", grossAmountMinor: "870" },
    ])
      invalid(() =>
        parseTaxConfigMaterialContent(
          { ...value, cases: [{ ...item, expected: { ...item.expected, ...change } }] },
          "FixtureSuite",
        ),
      );
    invalid(() =>
      parseTaxConfigMaterialContent(
        {
          ...value,
          cases: [
            {
              ...item,
              fixture: {
                ...item.fixture,
                lines: [{ ...item.fixture.lines[0], amountMinor: "-1000" }],
              },
            },
          ],
        },
        "FixtureSuite",
      ),
    );
    invalid(() =>
      parseTaxConfigMaterialContent(
        {
          ...value,
          cases: [
            {
              ...item,
              fixture: {
                ...item.fixture,
                lines: [{ ...item.fixture.lines[0], calculationReferences: [id(52), id(53)] }],
              },
            },
          ],
        },
        "FixtureSuite",
      ),
    );
  });
  it("rejects non-taxable nonzero rates, foreign line results and overflowing integer totals", () => {
    const item = suiteCase(),
      first = item.expected.receiptPreview[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("fixture component missing");
    for (const change of [
      { treatment: "Exempt" },
      { treatment: "ZeroRated", rate: "0" },
      { lineReference: id(90) },
      { taxAmountMinor: "9223372036854775808" },
    ])
      invalid(() =>
        parseTaxConfigMaterialContent(
          {
            ...suite(),
            cases: [
              {
                ...item,
                expected: { ...item.expected, receiptPreview: [{ ...first, ...change }] },
              },
            ],
          },
          "FixtureSuite",
        ),
      );
  });
  it("refuses content above one MiB and oversized case arrays before issuing any qualified result", () => {
    invalid(() =>
      parseTaxConfigMaterialContent(
        { ...suite(), cases: Array.from({ length: 257 }, (_, i) => suiteCase(100 + i * 3)) },
        "FixtureSuite",
      ),
    );
    const over = {
      ...suite(),
      cases: Array.from({ length: 256 }, (_, i) => ({
        ...suiteCase(100 + i * 3),
        unexpected: "x".repeat(5000),
      })),
    };
    invalid(() => parseTaxConfigMaterialContent(over, "FixtureSuite"));
  });
});

describe("Tax material immutable operations and reads", () => {
  it("binds the exact original six-field command and actual scope into its immutable receipt", () => {
    const f = fixture(),
      parsed = parseTaxConfigMaterialOperation(f.operation);
    expect(parsed).toEqual(f.operation);
    expect(parsed.intentDigest).toBe(
      `sha256:${sha256Hex(canonicalizeRfc8785({ scope, command: f.command }))}`,
    );
    const moved = parseTaxConfigAuthoringScope({ ...scope, actorReference: id(90) });
    expect(taxConfigMaterialIntentDigest(moved, f.command)).not.toBe(parsed.intentDigest);
    expect(
      parseTaxConfigMaterialResolve({
        action: f.command.action,
        operationReference: f.command.operationReference,
        materialReference: null,
        expectedRevision: null,
        materialKind: f.command.materialKind,
        intentDigest: parsed.intentDigest,
      }),
    ).not.toHaveProperty("content");
  });
  it("replacement records the new writer, preserving root creation time and immutable predecessor", () => {
    const f = fixture(),
      content = parseTaxConfigMaterialContent(
        { ...registration(), applicability: "NotApplicable" },
        "RegistrationApplicability",
      );
    const command = parseTaxConfigMaterialCommand({
      action: "ReplaceMaterial",
      operationReference: id(80),
      materialReference: f.version.materialReference,
      expectedRevision: 1,
      materialKind: "RegistrationApplicability",
      content,
    });
    const next = parseTaxConfigMaterialVersion({
      ...f.version,
      versionReference: id(81),
      revision: 2,
      previousVersionReference: f.version.versionReference,
      content,
      contentDigest: taxConfigMaterialContentDigest(content, command.materialKind),
      recordedByActorReference: id(82),
      recordedAt: later,
    });
    const nextScope = parseTaxConfigAuthoringScope({ ...scope, actorReference: id(82) });
    expect(
      parseTaxConfigMaterialOperation({
        ...f.operation,
        ...nextScope,
        action: command.action,
        operationReference: command.operationReference,
        materialReference: command.materialReference,
        expectedRevision: 1,
        command,
        intentDigest: taxConfigMaterialIntentDigest(nextScope, command),
        version: next,
        occurredAt: later,
      }).version?.createdAt,
    ).toBe(at);
  });
  it("preserves historical issuer validity without pretending the history is current qualification", () => {
    const content = parseTaxConfigMaterialContent(report(), "ProfessionalReport"),
      f = fixture();
    const version = parseTaxConfigMaterialVersion({
      ...f.version,
      materialKind: "ProfessionalReport",
      content,
      contentDigest: taxConfigMaterialContentDigest(content, "ProfessionalReport"),
    });
    expect(version.status).toBe("Recorded");
    expect(version.qualification).toBe("NotEvaluated");
    expect(
      parseTaxConfigMaterialCurrent({
        ...f.current,
        materialKind: "ProfessionalReport",
        version,
        observedAt: "2026-10-03T16:00:00.000Z",
        validUntil: "2026-10-03T16:00:05.000Z",
      }).version,
    ).toEqual(version);
  });
  it("allows current reader and historical author to differ without changing the stored author", () => {
    const f = fixture(),
      parsed = parseTaxConfigMaterialCurrent({ ...f.current, actorReference: id(91) });
    expect(parsed.actorReference).toBe(id(91));
    expect(parsed.version?.recordedByActorReference).toBe(scope.actorReference);
  });
  it("Abandoned contains no fabricated body, version or event and retains original identity", () => {
    const f = fixture(),
      parsed = parseTaxConfigMaterialOperation({
        ...f.operation,
        outcome: "Abandoned",
        command: null,
        version: null,
        eventReference: null,
      });
    expect(parsed.command).toBeNull();
    expect(parsed.version).toBeNull();
    invalid(() => parseTaxConfigMaterialOperation({ ...parsed, version: f.version }));
    invalid(() => parseTaxConfigMaterialOperation({ ...parsed, eventReference: id(90) }));
  });
  it.each([
    { actorReference: id(91) },
    { intentDigest: hash("a") },
    { expectedRevision: 1 },
    { materialReference: id(90) },
    { occurredAt: later },
  ])("rejects changed original scope/body/CAS/time %j", (change) =>
    invalid(() => parseTaxConfigMaterialOperation({ ...fixture().operation, ...change })),
  );
  it("rejects wrong scope, predecessor, forged content digest and future material provenance", () => {
    const f = fixture();
    for (const change of [
      { storeReference: id(90) },
      { contentDigest: hash("f") },
      { previousVersionReference: id(90) },
      { recordedAt: "2026-10-01T15:59:59.000Z" },
      { qualification: "Verified" },
    ])
      invalid(() =>
        parseTaxConfigMaterialOperation({ ...f.operation, version: { ...f.version, ...change } }),
      );
  });
  it("does not execute an original-command accessor or accept content under another material kind", () => {
    const f = fixture();
    let accessed = 0;
    const value = { ...f.command };
    Object.defineProperty(value, "content", {
      enumerable: true,
      get() {
        accessed++;
        return registration();
      },
    });
    invalid(() => parseTaxConfigMaterialCommand(value));
    expect(accessed).toBe(0);
    invalid(() =>
      parseTaxConfigMaterialCommand({ ...f.command, materialKind: "ProfessionalReport" }),
    );
    invalid(() => parseTaxConfigMaterialResolve({ ...f.command, intentDigest: hash("a") }));
  });
  it("refuses null-vs-absent and overflow CAS instead of inventing a creation default", () => {
    const f = fixture();
    invalid(() => parseTaxConfigMaterialCommand({ ...f.command, expectedRevision: 0 }));
    const { materialReference, ...missing } = f.command;
    expect(materialReference).toBeNull();
    invalid(() => parseTaxConfigMaterialCommand(missing));
    invalid(() =>
      parseTaxConfigMaterialCommand({
        ...f.command,
        action: "ReplaceMaterial",
        materialReference: id(90),
        expectedRevision: 2147483647,
      }),
    );
  });
  it("enforces a fresh bounded read observation but does not renew professional validity", () => {
    const f = fixture();
    invalid(() => parseTaxConfigMaterialCurrent({ ...f.current, validUntil: at }));
    invalid(() =>
      parseTaxConfigMaterialCurrent({ ...f.current, validUntil: "2026-10-01T16:00:05.001Z" }),
    );
    invalid(() =>
      parseTaxConfigMaterialCurrent({ ...f.current, observedAt: "2026-10-01T15:59:59.000Z" }),
    );
  });
  it("lists metadata only, with no Confidential issuer/content packet or qualification shortcut", () => {
    const f = fixture(),
      packet = {
        profile: "TaxConfigMaterialRosterV1",
        ...scope,
        materialKind: f.command.materialKind,
        afterMaterial: null,
        entries: [f.summary],
        nextAfterMaterial: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      };
    const parsed = parseTaxConfigMaterialRoster(packet);
    expect(parsed.entries[0]).toEqual(f.summary);
    expect(parsed.entries[0]).not.toHaveProperty("content");
    expect(parsed.entries[0]).not.toHaveProperty("recordedByActorReference");
    invalid(() => parseTaxConfigMaterialRoster({ ...packet, entries: [f.version] }));
    invalid(() => parseTaxConfigMaterialSummary({ ...f.summary, content: f.content }));
  });
  it("rejects duplicate/out-of-order/foreign summary roots and invalid pagination", () => {
    const f = fixture(),
      packet = {
        profile: "TaxConfigMaterialRosterV1",
        ...scope,
        materialKind: f.command.materialKind,
        afterMaterial: null,
        entries: [f.summary],
        nextAfterMaterial: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      };
    invalid(() => parseTaxConfigMaterialRoster({ ...packet, entries: [f.summary, f.summary] }));
    invalid(() =>
      parseTaxConfigMaterialRoster({
        ...packet,
        entries: [{ ...f.summary, storeReference: id(90) }],
      }),
    );
    invalid(() =>
      parseTaxConfigMaterialRoster({ ...packet, nextAfterMaterial: f.summary.materialReference }),
    );
    invalid(() =>
      parseTaxConfigMaterialRoster({ ...packet, afterMaterial: f.summary.materialReference }),
    );
    const entries = Array.from({ length: 50 }, (_, i) => ({
        ...f.summary,
        materialReference: id(100 + i),
      })),
      last = entries[49];
    if (!last) throw new Error("fixture roster missing");
    expect(
      parseTaxConfigMaterialRoster({
        ...packet,
        entries,
        nextAfterMaterial: last.materialReference,
      }).nextAfterMaterial,
    ).toBe(last.materialReference);
  });
});

it("records an absent actual tax registration without creating jurisdiction or verification facts", () => {
  for (const applicability of ["Applicable", "NotApplicable"] as const) {
    const material = parseTaxConfigMaterialContent(
      { ...registration(), operatingEntityTaxReference: null, applicability },
      "RegistrationApplicability",
    );
    expect(material).toMatchObject({ operatingEntityTaxReference: null, applicability });
    expect(Object.keys(material)).toHaveLength(8);
    expect(material).not.toHaveProperty("jurisdictionProfileReference");
    expect(material).not.toHaveProperty("status");
    expect(Object.isFrozen(material)).toBe(true);
  }
});
it("rejects fabricated jurisdiction identifiers and omitted nullable registration fields", () => {
  invalid(() =>
    parseTaxConfigMaterialContent(
      { ...registration(), jurisdictionProfileReference: id(12) },
      "RegistrationApplicability",
    ),
  );
  const { operatingEntityTaxReference, ...missing } = registration();
  void operatingEntityTaxReference;
  invalid(() => parseTaxConfigMaterialContent(missing, "RegistrationApplicability"));
  invalid(() =>
    parseTaxConfigMaterialContent(
      { ...registration(), operatingEntityTaxReference: undefined },
      "RegistrationApplicability",
    ),
  );
});

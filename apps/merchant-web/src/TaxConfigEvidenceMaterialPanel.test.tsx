// Actual browser parsers/transports with controlled HTTP and journal boundaries.
// These declarations are not native IAM or qualified professional evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxConfigEvidenceMaterialPanel,
  saveTaxConfigEvidenceMaterial,
  compareTaxConfigEvidenceMaterial,
  finishTaxConfigEvidenceComparison,
  TaxConfigMaterialComparisonView,
  type TaxConfigEvidenceMaterialFields,
} from "./TaxConfigEvidenceMaterialPanel.js";
import { finishTaxConfigMaterialOriginal } from "./TaxConfigMaterialPanel.js";
import {
  createTaxConfigMaterialClient,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialComparison,
  type TaxConfigMaterialCursor,
} from "./tax-config-material-client.js";
import { parseTaxConfigCandidateCurrent } from "./tax-config-candidate-client.js";
import { type TaxConfigMaterialPendingJournal } from "./tax-config-material-pending-journal.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902604-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  hash = `sha256:${"a".repeat(64)}`,
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  const registrationContent = {
    operatingEntityProfileVersionReference: id(80),
    operatingEntityTaxReference: null,
    jurisdictionCode: "CA-ON",
    applicability: "NotApplicable",
    sourceIssuedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
    declaredSourceDigest: null,
  };
  const registrationDigest = await digest(registrationContent);
  const currencyMetadata = {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(10),
      metadataDigest: hash,
    },
    pin = { versionReference: id(20), contentDigest: hash };
  const content = {
    profile: "TaxPublicationCandidateContentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(5),
    baseDraft: {
      versionReference: id(6),
      snapshotDigest: hash,
      aggregateVersion: 1,
      versionNumber: 1,
    },
    targetVersionReference: id(20),
    targetAggregateVersion: 2,
    targetVersionNumber: 2,
    stableCode: "SYNTHETIC",
    jurisdictionCode: "CA-ON",
    currencyMetadata,
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-10-01T04:00:00.000Z",
        localDateTime: "2026-10-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    rules: [],
    sourceRuleBindings: [],
    registrationMaterial: {
      materialReference: id(30),
      versionReference: id(31),
      contentDigest: registrationDigest,
    },
  };
  const candidateContentDigest = await digest(content),
    record = {
      profile: "TaxConfigCandidateRecordV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      preparedByActorReference: id(40),
      operationReference: id(41),
      candidate: {
        profile: "TaxPublicationCandidateV1",
        content,
        contentDigest: candidateContentDigest,
      },
      auditReference: id(42),
      eventReference: id(43),
      preparedAt: at,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    },
    candidate = parseTaxConfigCandidateCurrent(
      {
        profile: "TaxConfigCandidateCurrentV1",
        ...scope,
        configurationReference: id(5),
        targetVersionReference: id(20),
        record,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      },
      scope,
      { configurationReference: id(5), targetVersionReference: id(20) },
    );
  pin.contentDigest = candidateContentDigest;
  const suiteContent = {
    targetPublicationCandidate: pin,
    currencyMetadata,
    cases: [
      {
        fixture: {
          profile: "TaxDraftFixtureV1",
          fixtureReference: id(50),
          kind: "Basket",
          evaluatedAt: at,
          lines: [
            {
              lineReference: id(51),
              calculationReferences: [id(52)],
              labelCode: "MEAL",
              taxClassificationReference: id(53),
              orderType: "Pickup",
              chargeType: "Sellable",
              amountMinor: "100",
            },
          ],
        },
        expected: {
          fixtureReference: id(50),
          kind: "Basket",
          configurationReference: id(5),
          versionReference: id(20),
          snapshotDigest: candidateContentDigest,
          netAmountMinor: "100",
          taxAmountMinor: "13",
          grossAmountMinor: "113",
          receiptPreview: [
            {
              lineReference: id(51),
              labelCode: "MEAL",
              componentCode: "HST",
              treatment: "Taxable",
              rate: "0.13",
              taxAmountMinor: "13",
            },
          ],
        },
      },
    ],
    sourceIssuedAt: at,
    declaredSourceDigest: null,
  };
  const suite = {
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    materialReference: id(60),
    versionReference: id(61),
    revision: 1,
    previousVersionReference: null,
    materialKind: "FixtureSuite",
    content: suiteContent,
    contentDigest: await digest(suiteContent),
    recordedByActorReference: id(70),
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  };
  const baseline = (materialKind: "FixtureSuite" | "ProfessionalReport") =>
    parseTaxConfigMaterialCurrent(
      {
        profile: "TaxConfigMaterialCurrentV1",
        ...scope,
        materialReference: null,
        materialKind,
        version: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      },
      scope,
      { materialKind, materialReference: null },
    );
  const fields: TaxConfigEvidenceMaterialFields = {
    suiteJson: JSON.stringify(suiteContent),
    displayName: "Synthetic external issuer",
    organizationName: "",
    credentialIdentifier: "",
    reviewedAt: at,
    validUntil: "2026-10-07T10:00:00.000Z",
    conclusion: "Pass",
    sourceDigest: "",
  };
  let original: TaxConfigMaterialCursor | null = null,
    receipt: unknown,
    lastVersion: unknown;
  const events: string[] = [],
    state = {
      changedCandidate: false,
      changedBaseline: false,
      deny: false,
      lose: false,
      failRefresh: false,
      cleanup: false,
      comparisonMismatch: false,
      comparisonWrongPin: false,
      beforeComparison: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  const journal: TaxConfigMaterialPendingJournal = {
    load: async () => original,
    reserve: async (c) => {
      events.push("reserve");
      original = c;
    },
    complete: async () => {
      events.push("complete");
      if (state.cleanup) throw Error("Controlled durability failure");
      original = null;
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, options) => {
      const path = new URL(String(input), "https://example.test").pathname;
      if (path.endsWith("candidates/current")) {
        events.push("candidate");
        return response(state.changedCandidate ? { ...candidate, record: null } : candidate);
      }
      if (path.endsWith("materials/version")) {
        events.push("version");
        const u = new URL(String(input), "https://example.test");
        if (u.searchParams.get("materialKind") === "FixtureSuite")
          return response({
            ...baseline("FixtureSuite"),
            materialReference: id(60),
            version: suite,
          });
        const version = {
          ...suite,
          materialKind: "RegistrationApplicability",
          materialReference: id(30),
          versionReference: id(31),
          content: registrationContent,
          contentDigest: await digest(registrationContent),
        };
        return response({
          ...baseline("FixtureSuite"),
          materialKind: "RegistrationApplicability",
          materialReference: id(30),
          version,
        });
      }
      if (path.endsWith("materials/compare")) {
        events.push("compare");
        await state.beforeComparison();
        const command = JSON.parse(String(options?.body));
        expect(command).toEqual({
          configurationReference: id(5),
          targetPublicationCandidate: {
            versionReference: id(20),
            contentDigest: candidateContentDigest,
          },
          fixtureSuiteMaterial: {
            materialReference: id(60),
            versionReference: id(61),
            contentDigest: suite.contentDigest,
          },
        });
        expect(JSON.stringify(command)).not.toMatch(/cases|operationReference|issuer/);
        const matches = !state.comparisonMismatch;
        return response({
          profile: "TaxConfigMaterialComparisonV1",
          ...scope,
          comparison: {
            profile: "TaxConfigCandidateFixtureComparisonV1",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            candidate: command.targetPublicationCandidate,
            suite: state.comparisonWrongPin
              ? { ...command.fixtureSuiteMaterial, versionReference: id(99) }
              : command.fixtureSuiteMaterial,
            cases: [
              {
                fixtureReference: id(50),
                matches,
                actualDigest: hash,
                expectedDigest: matches ? hash : `sha256:${"b".repeat(64)}`,
                mismatchedFields: matches
                  ? []
                  : ["taxAmountMinor", "grossAmountMinor", "receiptPreview"],
              },
            ],
            allCasesMatched: matches,
            professionalReviewStatus: "NotEvaluated",
            legalConclusion: "NotEvaluated",
          },
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        });
      }
      if (path.endsWith("materials/current")) {
        events.push("current");
        if (state.failRefresh && receipt)
          return response({ error: "tax_config_authoring_unavailable" }, 503);
        const u = new URL(String(input), "https://example.test"),
          kind =
            u.searchParams.get("materialKind") === "ProfessionalReport"
              ? "ProfessionalReport"
              : "FixtureSuite";
        return response(
          receipt
            ? { ...baseline(kind), materialReference: id(90), version: lastVersion }
            : state.changedBaseline
              ? { ...baseline(kind), materialReference: id(91) }
              : baseline(kind),
        );
      }
      if (path.endsWith("materials/resolve-original")) {
        events.push("resolve");
        if (state.deny) return response({ error: "request_denied" }, 403);
        return response(receipt);
      }
      if (path.endsWith("materials/commands")) {
        events.push("execute");
        expect(original).not.toBeNull();
        const raw = JSON.parse(String(options?.body));
        const version = {
          ...suite,
          materialKind: raw.materialKind,
          materialReference: id(90),
          versionReference: id(92),
          content: raw.content,
          contentDigest: await digest(raw.content),
          recordedByActorReference: id(4),
        };
        lastVersion = version;
        receipt = {
          profile: "TaxConfigMaterialOperationV1",
          ...scope,
          action: raw.action,
          operationReference: raw.operationReference,
          materialReference: raw.materialReference,
          expectedRevision: raw.expectedRevision,
          materialKind: raw.materialKind,
          command: raw,
          intentDigest: await digest({ scope, command: raw }),
          outcome: "Committed",
          version,
          auditReference: id(93),
          eventReference: id(94),
          occurredAt: at,
        };
        if (state.lose) throw Error("Controlled lost reply");
        return response(receipt);
      }
      throw Error("Unexpected controlled route");
    }),
  );
  const client = createTaxConfigMaterialClient(),
    operation = {
      client,
      journal,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
  const actualSuite = parseTaxConfigMaterialCurrent(
    { ...baseline("FixtureSuite"), materialReference: id(60), version: suite },
    scope,
    { materialKind: "FixtureSuite", materialReference: id(60) },
  ).version;
  if (!actualSuite) throw Error("Missing controlled suite version");
  return {
    candidate,
    suiteContent,
    suite: actualSuite,
    baseline,
    fields,
    state,
    events,
    operation,
    pending: () => original,
  };
}
it("renders ordinary saved-source controls with no arbitrary reference inputs or enabled publishing", () => {
  const html = renderToStaticMarkup(
    <TaxConfigEvidenceMaterialPanel scope={scope} csrf={csrf} draft={null} />,
  );
  expect(html).toContain("Professional reports and fixture suites");
  expect(html).toContain("Structured fixture suite JSON");
  expect(html).toContain("not evaluated");
  expect(html).not.toContain('type="file"');
  expect(html).not.toContain('aria-label="Registration UUID"');
  expect(html).not.toContain(">Publish<");
});
it("rechecks selected actual candidate and CAS, then reserves before full-suite dispatch and refresh", async () => {
  const f = await setup(),
    result = await saveTaxConfigEvidenceMaterial({
      ...f.operation,
      scope,
      kind: "FixtureSuite",
      baseline: f.baseline("FixtureSuite"),
      candidate: f.candidate,
      suite: null,
      fields: f.fields,
      onReserved: vi.fn(),
    });
  expect(result.receipt.outcome).toBe("Committed");
  expect(f.events).toEqual(["candidate", "current", "reserve", "execute", "current", "complete"]);
  expect(f.pending()).toBeNull();
  expect(result.current.version?.qualification).toBe("NotEvaluated");
});
it.each(["changedCandidate", "changedBaseline"] as const)(
  "refuses %s before reserving or dispatching",
  async (name) => {
    const f = await setup();
    f.state[name] = true;
    await expect(
      saveTaxConfigEvidenceMaterial({
        ...f.operation,
        scope,
        kind: "FixtureSuite",
        baseline: f.baseline("FixtureSuite"),
        candidate: f.candidate,
        suite: null,
        fields: f.fields,
        onReserved: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(f.pending()).toBeNull();
    expect(f.events).not.toContain("execute");
  },
);
it("refuses arbitrary suite target and mismatched Currency before reservation", async () => {
  const f = await setup();
  for (const content of [
    {
      ...f.suiteContent,
      targetPublicationCandidate: { versionReference: id(99), contentDigest: hash },
    },
    {
      ...f.suiteContent,
      currencyMetadata: { ...f.suiteContent.currencyMetadata, minorUnitExponent: 3 },
    },
  ]) {
    await expect(
      saveTaxConfigEvidenceMaterial({
        ...f.operation,
        scope,
        kind: "FixtureSuite",
        baseline: f.baseline("FixtureSuite"),
        candidate: f.candidate,
        suite: null,
        fields: { ...f.fields, suiteJson: JSON.stringify(content) },
        onReserved: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(f.pending()).toBeNull();
  }
});
it("lost reply and denied recovery preserve exact cursor; original resolve does not read today's candidate", async () => {
  const f = await setup();
  f.state.lose = true;
  await expect(
    saveTaxConfigEvidenceMaterial({
      ...f.operation,
      scope,
      kind: "FixtureSuite",
      baseline: f.baseline("FixtureSuite"),
      candidate: f.candidate,
      suite: null,
      fields: f.fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor) throw Error("Missing durable original");
  f.events.length = 0;
  f.state.deny = true;
  await expect(finishTaxConfigMaterialOriginal({ ...f.operation, cursor })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(f.pending()).toEqual(cursor);
  f.state.deny = false;
  f.state.changedCandidate = true;
  f.events.length = 0;
  await finishTaxConfigMaterialOriginal({ ...f.operation, cursor });
  expect(f.events).toEqual(["resolve", "current", "complete"]);
  expect(f.pending()).toBeNull();
});
it("failed current refresh or cleanup keeps the reservation", async () => {
  for (const name of ["failRefresh", "cleanup"] as const) {
    const f = await setup();
    f.state[name] = true;
    await expect(
      saveTaxConfigEvidenceMaterial({
        ...f.operation,
        scope,
        kind: "FixtureSuite",
        baseline: f.baseline("FixtureSuite"),
        candidate: f.candidate,
        suite: null,
        fields: f.fields,
        onReserved: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(f.pending()).not.toBeNull();
  }
});
it("aborted or stale identity does not reserve a new material", async () => {
  const f = await setup();
  await expect(
    saveTaxConfigEvidenceMaterial({
      ...f.operation,
      isCurrent: () => false,
      scope,
      kind: "FixtureSuite",
      baseline: f.baseline("FixtureSuite"),
      candidate: f.candidate,
      suite: null,
      fields: f.fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.events).toEqual([]);
});
it("records a declared report bound to actual candidate, immutable Registration and Suite; never certifies Pass", async () => {
  const f = await setup(),
    result = await saveTaxConfigEvidenceMaterial({
      ...f.operation,
      scope,
      kind: "ProfessionalReport",
      baseline: f.baseline("ProfessionalReport"),
      candidate: f.candidate,
      suite: f.suite,
      fields: f.fields,
      onReserved: vi.fn(),
    });
  const content = result.current.version?.content;
  if (!content || !("declaredIssuer" in content)) throw Error("Missing controlled report result");
  expect(content.declaredConclusion).toBe("Pass");
  expect(content.fixtureSuiteMaterial).toEqual({
    versionReference: f.suite.versionReference,
    contentDigest: f.suite.contentDigest,
  });
  expect(content.registrationMaterial).toEqual({
    versionReference: f.candidate.record?.candidate.content.registrationMaterial.versionReference,
    contentDigest: f.candidate.record?.candidate.content.registrationMaterial.contentDigest,
  });
  expect(result.current.version?.qualification).toBe("NotEvaluated");
  expect(canonical(content)).not.toContain("Verified");
  expect(f.events).toEqual([
    "candidate",
    "current",
    "version",
    "version",
    "reserve",
    "execute",
    "current",
    "complete",
  ]);
});
it("report cannot use a Suite selected for another actual candidate", async () => {
  const f = await setup();
  await expect(
    saveTaxConfigEvidenceMaterial({
      ...f.operation,
      scope,
      kind: "ProfessionalReport",
      baseline: f.baseline("ProfessionalReport"),
      candidate: f.candidate,
      suite: { ...f.suite, versionReference: id(99) },
      fields: f.fields,
      onReserved: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(f.pending()).toBeNull();
  expect(f.events).not.toContain("execute");
});
it.each([false, true])(
  "compares true selected immutable sources with mismatches=%s and no journal effects",
  async (mismatch) => {
    const f = await setup();
    f.state.comparisonMismatch = mismatch;
    const result = await compareTaxConfigEvidenceMaterial({
      ...f.operation,
      scope,
      candidate: f.candidate,
      suite: f.suite,
    });
    expect(result.comparison.allCasesMatched).toBe(!mismatch);
    expect(f.events).toEqual(["candidate", "version", "compare"]);
    expect(f.pending()).toBeNull();
    const html = renderToStaticMarkup(<TaxConfigMaterialComparisonView value={result} />);
    expect(html).toContain(mismatch ? "Case 1: Mismatch" : "Case 1: Match");
    expect(html).toContain("approved coverage");
    expect(html).toContain("Not evaluated");
    if (mismatch) expect(html).toContain("taxAmountMinor, grossAmountMinor, receiptPreview");
  },
);
it("refuses actual changed candidate or wrong returned Suite pins without trusting a successful HTTP status", async () => {
  for (const name of ["changedCandidate", "comparisonWrongPin"] as const) {
    const f = await setup();
    f.state[name] = true;
    await expect(
      compareTaxConfigEvidenceMaterial({
        ...f.operation,
        scope,
        candidate: f.candidate,
        suite: f.suite,
      }),
    ).rejects.toThrow();
    expect(f.pending()).toBeNull();
    expect(f.events).not.toContain("reserve");
  }
});
it("comparison summaries are readonly and cannot establish a professional or legal pass", () => {
  const command = {
      configurationReference: id(5),
      targetPublicationCandidate: { versionReference: id(20), contentDigest: hash },
      fixtureSuiteMaterial: {
        materialReference: id(60),
        versionReference: id(61),
        contentDigest: hash,
      },
    },
    value = parseTaxConfigMaterialComparison(
      {
        profile: "TaxConfigMaterialComparisonV1",
        ...scope,
        comparison: {
          profile: "TaxConfigCandidateFixtureComparisonV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          candidate: command.targetPublicationCandidate,
          suite: command.fixtureSuiteMaterial,
          cases: [
            {
              fixtureReference: id(50),
              matches: true,
              actualDigest: hash,
              expectedDigest: hash,
              mismatchedFields: [],
            },
          ],
          allCasesMatched: true,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        },
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      },
      scope,
      command,
    );
  const html = renderToStaticMarkup(<TaxConfigMaterialComparisonView value={value} />);
  expect(html).toContain("All declared cases match");
  expect(html).not.toContain("button");
  expect(html).not.toContain("Approved");
  expect(html).toContain(at);
});
it("invalidated read-only comparison cannot restore summary after parent disable/source change", async () => {
  const f = await setup(),
    apply = vi.fn();
  let parentDisabled = false,
    release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeComparison.mockImplementation(() => delayed);
  const work = finishTaxConfigEvidenceComparison(
    {
      ...f.operation,
      isCurrent: () => !parentDisabled,
      scope,
      candidate: f.candidate,
      suite: f.suite,
    },
    apply,
  );
  const failure = expect(work).rejects.toMatchObject({ code: "ScopeChanged" });
  await vi.waitFor(() => expect(f.state.beforeComparison).toHaveBeenCalledOnce());
  parentDisabled = true;
  if (!release) throw Error("Missing delayed comparison transport");
  release();
  await failure;
  expect(apply).not.toHaveBeenCalled();
  expect(f.pending()).toBeNull();
  expect(f.events).toEqual(["candidate", "version", "compare"]);
});
it.each([false, true])("still applies a current read result with mismatch=%s", async (mismatch) => {
  const f = await setup(),
    apply = vi.fn();
  f.state.comparisonMismatch = mismatch;
  const value = await finishTaxConfigEvidenceComparison(
    { ...f.operation, scope, candidate: f.candidate, suite: f.suite },
    apply,
  );
  expect(apply).toHaveBeenCalledExactlyOnceWith(value);
  expect(value.comparison.allCasesMatched).toBe(!mismatch);
  expect(f.pending()).toBeNull();
});

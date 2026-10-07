// Controlled HTTP contracts; this suite does not claim native IAM or professional qualification.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTaxConfigMaterialClient,
  parseTaxConfigMaterialContent,
  parseTaxConfigMaterialComparison,
  parseTaxConfigMaterialCursor,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxRegistrantCurrentSource,
  validateTaxConfigMaterialVersion,
  validateTaxConfigMaterialReceipt,
  type PreparedTaxConfigMaterialCommand,
} from "./tax-config-material-client.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  hash = `sha256:${"a".repeat(64)}`,
  csrf = "c".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = {
  operatingEntityProfileVersionReference: id(10),
  operatingEntityTaxReference: null,
  jurisdictionCode: "CA-ON",
  applicability: "NotApplicable",
  sourceIssuedAt: at,
  effectiveFrom: at,
  effectiveUntil: null,
  declaredSourceDigest: null,
};
const command = {
  action: "CreateMaterial",
  operationReference: id(5),
  materialReference: null,
  expectedRevision: null,
  materialKind: "RegistrationApplicability",
  content,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
async function version(overrides: Record<string, unknown> = {}) {
  return {
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    materialReference: id(6),
    versionReference: id(7),
    revision: 1,
    previousVersionReference: null,
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: await digest(content),
    recordedByActorReference: id(4),
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
    ...overrides,
  };
}
async function current(overrides: Record<string, unknown> = {}) {
  return {
    profile: "TaxConfigMaterialCurrentV1",
    ...scope,
    materialReference: id(6),
    materialKind: "RegistrationApplicability",
    version: await version(),
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
    ...overrides,
  };
}
async function receipt(p: PreparedTaxConfigMaterialCommand, abandoned = false) {
  return {
    profile: "TaxConfigMaterialOperationV1",
    ...scope,
    action: p.command.action,
    operationReference: p.command.operationReference,
    materialReference: p.command.materialReference,
    expectedRevision: p.command.expectedRevision,
    materialKind: p.command.materialKind,
    command: abandoned ? null : p.command,
    intentDigest: p.intentDigest,
    outcome: abandoned ? "Abandoned" : "Committed",
    version: abandoned ? null : await version(),
    auditReference: id(8),
    eventReference: abandoned ? null : id(9),
    occurredAt: at,
  };
}
const registrant = () => ({
  profile: "TaxRegistrantCurrentSourceV1",
  ...scope,
  businessFunction: "TaxRegistrant",
  effectiveAt: at,
  assignmentReference: id(11),
  assignmentVersion: 1,
  effectiveFrom: at,
  effectiveUntil: null,
  operatingEntityReference: id(12),
  entityVersion: 1,
  operatingEntityProfileVersionReference: id(10),
  profileVersion: 1,
  legalName: "Controlled legal entity",
  jurisdictionCode: "CA-ON",
  registrationReference: null,
  taxRegistrationReference: null,
  observedAt: at,
  validUntil: until,
  qualification: "NotEvaluated",
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("prepares detached full scope-bound canonical original, without a request", async () => {
  const fetcher = vi.fn<typeof fetch>(),
    client = createTaxConfigMaterialClient(fetcher);
  const input = structuredClone(command),
    p = await client.prepare(scope, input);
  input.content.applicability = "Applicable";
  expect(p.command.content).toEqual(content);
  expect(p.intentDigest).toBe(await digest({ scope, command }));
  expect(Object.isFrozen(p.command.content)).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  expect(Object.keys(p.cursor).sort()).toEqual(
    [
      "profile",
      "scope",
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "intentDigest",
    ].sort(),
  );
});
it("dispatches exact6 save with actual scope header/CSRF and verifies immutable actual receipt", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command),
    r = await receipt(p),
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(r)),
    client = createTaxConfigMaterialClient(fetcher);
  const actual = await client.execute(p, { csrf });
  expect(actual.version?.contentDigest).toBe(await digest(content));
  expect(actual.outcome).toBe("Committed");
  const call = fetcher.mock.calls[0];
  expect(call).toBeDefined();
  if (!call) return;
  expect(call[0]).toBe("/merchant/tax-config/authoring/materials/commands");
  expect(call[1]?.body).toBe(canonical(command));
  expect(call[1]?.credentials).toBe("same-origin");
  const headers = new Headers(call[1]?.headers);
  expect(headers.get("X-BOP-CSRF")).toBe(csrf);
  const encoded = headers.get("X-BOP-Store-Setup-Scope");
  expect(encoded).not.toBeNull();
  if (encoded)
    expect(JSON.parse(atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/")))).toEqual(scope);
});
it("resolves original without material content or today's registrant read", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command),
    fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(await receipt(p, true))),
    client = createTaxConfigMaterialClient(fetcher);
  expect((await client.resolve(p.cursor, { csrf })).outcome).toBe("Abandoned");
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("missing controlled request");
  const body = JSON.parse(String(call[1]?.body));
  expect(Object.keys(body).sort()).toEqual(
    [
      "action",
      "operationReference",
      "materialReference",
      "expectedRevision",
      "materialKind",
      "intentDigest",
    ].sort(),
  );
  expect(JSON.stringify(body)).not.toContain("operatingEntity");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reads exact historical version with different current reader and rejects wrong original version", async () => {
  const packet = await current({ version: await version({ recordedByActorReference: id(13) }) }),
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(packet)),
    client = createTaxConfigMaterialClient(fetcher);
  expect(
    (
      await client.version(scope, {
        materialKind: "RegistrationApplicability",
        versionReference: id(7),
      })
    ).version?.recordedByActorReference,
  ).toBe(id(13));
  await expect(
    client.version(scope, { materialKind: "RegistrationApplicability", versionReference: id(14) }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("rejects material hash tamper and fabricated qualification before exposing a current source", async () => {
  const bad = await current({ version: await version({ contentDigest: hash }) }),
    client = createTaxConfigMaterialClient(async () => response(bad));
  await expect(
    client.current(scope, { materialKind: "RegistrationApplicability", materialReference: id(6) }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(() =>
    parseTaxConfigMaterialCurrent({ ...bad, qualification: "Verified" }, scope, {
      materialKind: "RegistrationApplicability",
      materialReference: id(6),
    }),
  ).toThrow();
});
it("rejects getters, unknown fields, missing fields, malformed references and noncanonical periods", () => {
  const getter = Object.defineProperty({ ...content }, "applicability", {
    enumerable: true,
    get: () => {
      throw new Error("must not run");
    },
  });
  for (const value of [
    getter,
    { ...content, approved: true },
    { ...content, effectiveUntil: undefined },
    { ...content, operatingEntityProfileVersionReference: id(3).replace("-7000-", "-4000-") },
    { ...content, effectiveFrom: "2026-10-06T10:00:00Z" },
    { ...content, effectiveUntil: at },
  ])
    expect(() => parseTaxConfigMaterialContent(value, "RegistrationApplicability")).toThrow();
});
it("retains nullable tax reference and never turns an external report declaration into certification", () => {
  const source = parseTaxRegistrantCurrentSource(registrant(), scope);
  expect(source.taxRegistrationReference).toBeNull();
  expect(source.qualification).toBe("NotEvaluated");
  const pin = { versionReference: id(7), contentDigest: hash };
  const report = parseTaxConfigMaterialContent(
    {
      targetPublicationCandidate: pin,
      registrationMaterial: pin,
      fixtureSuiteMaterial: pin,
      declaredIssuer: {
        displayName: "Declared reviewer",
        organizationName: null,
        credentialIdentifier: null,
      },
      reviewedAt: at,
      validUntil: until,
      declaredConclusion: "Pass",
      declaredSourceDigest: null,
    },
    "ProfessionalReport",
  );
  expect("declaredConclusion" in report && report.declaredConclusion).toBe("Pass");
  expect(() =>
    parseTaxConfigMaterialContent({ ...report, qualification: "Verified" }, "ProfessionalReport"),
  ).toThrow();
  expect(() => parseTaxConfigMaterialContent({ cases: [] }, "FixtureSuite")).toThrow();
});
it("reads actual registrant and permits source absence without inventing entity pins", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(registrant())),
    client = createTaxConfigMaterialClient(fetcher);
  expect((await client.registrant(scope))?.operatingEntityProfileVersionReference).toBe(id(10));
  expect(
    await createTaxConfigMaterialClient(async () => response(null)).registrant(scope),
  ).toBeNull();
  expect(() =>
    parseTaxRegistrantCurrentSource({ ...registrant(), actorReference: id(13) }, scope),
  ).toThrow();
  expect(() =>
    parseTaxRegistrantCurrentSource({ ...registrant(), effectiveUntil: at }, scope),
  ).toThrow();
});
it("accepts metadata-only roster while rejecting leaked content, duplicate roots and false next cursor", () => {
  const summary = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      materialReference: id(6),
      versionReference: id(7),
      revision: 1,
      materialKind: "FixtureSuite",
      contentDigest: hash,
      recordedAt: at,
      status: "Recorded",
      qualification: "NotEvaluated",
    },
    packet = {
      profile: "TaxConfigMaterialRosterV1",
      ...scope,
      materialKind: "FixtureSuite",
      afterMaterial: null,
      entries: [summary],
      nextAfterMaterial: null,
      observedAt: at,
      validUntil: until,
      qualification: "NotEvaluated",
    },
    selector = { materialKind: "FixtureSuite" as const, afterMaterial: null };
  expect(parseTaxConfigMaterialRoster(packet, scope, selector).entries).toHaveLength(1);
  for (const bad of [
    { ...packet, entries: [{ ...summary, content }] },
    { ...packet, entries: [summary, summary] },
    { ...packet, nextAfterMaterial: id(6) },
    { ...packet, afterMaterial: id(6) },
  ])
    expect(() => parseTaxConfigMaterialRoster(bad, scope, selector)).toThrow();
});
it("refuses overlong or expired current leases", async () => {
  const packet = await current({ validUntil: "2026-10-06T10:00:05.001Z" });
  expect(() =>
    parseTaxConfigMaterialCurrent(packet, scope, {
      materialKind: "RegistrationApplicability",
      materialReference: id(6),
    }),
  ).toThrow();
  vi.mocked(Date.now).mockReturnValue(Date.parse(until));
  await expect(
    createTaxConfigMaterialClient(async () => response(await current())).current(scope, {
      materialKind: "RegistrationApplicability",
      materialReference: id(6),
    }),
  ).rejects.toMatchObject({ code: "Stale" });
});
it.each([
  [403, "request_denied", "Denied"],
  [409, "tax_config_authoring_conflict", "Conflict"],
  [400, "tax_config_authoring_invalid", "Invalid"],
  [503, "tax_config_authoring_feature_disabled", "FeatureDisabled"],
])("maps finite %s errors without source echo", async (status, error, code) => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command);
  await expect(
    createTaxConfigMaterialClient(async () => response({ error }, Number(status))).execute(p, {
      csrf,
    }),
  ).rejects.toMatchObject({ code });
});
it("retains unknown write outcome for lost reply, malformed success, wrong original and abort after dispatch", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command);
  for (const fetcher of [
    async () => {
      throw new Error("controlled network");
    },
    async () => response({}),
    async () => response({ ...(await receipt(p)), operationReference: id(14) }),
  ])
    await expect(createTaxConfigMaterialClient(fetcher).execute(p, { csrf })).rejects.toMatchObject(
      { code: "OutcomeUnknown" },
    );
  const c = new AbortController();
  await expect(
    createTaxConfigMaterialClient(async () => {
      c.abort();
      return response(await receipt(p));
    }).execute(p, { csrf, signal: c.signal }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("cancels stale scope epoch and rejects mutable options after a real dispatch", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command),
    options = { csrf },
    client = createTaxConfigMaterialClient(async () => {
      options.csrf = "d".repeat(43);
      return response(await receipt(p));
    });
  await expect(client.execute(p, options)).rejects.toMatchObject({ code: "ScopeChanged" });
  let release: (value: Response) => void = () => undefined;
  const delayed = createTaxConfigMaterialClient(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const pending = delayed.current(scope, {
    materialKind: "RegistrationApplicability",
    materialReference: id(6),
  });
  delayed.invalidate();
  release(response(await current()));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("does not send invalid CSRF, forged prepared digest, or content-bearing recovery", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command),
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({})),
    client = createTaxConfigMaterialClient(fetcher);
  await expect(client.execute(p, { csrf: "bad" })).rejects.toMatchObject({ code: "Invalid" });
  await expect(client.execute({ ...p, intentDigest: hash }, { csrf })).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(() => parseTaxConfigMaterialCursor({ ...p.cursor, content })).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("caps streamed bodies and requires no-store JSON", async () => {
  await expect(
    createTaxConfigMaterialClient(
      async () =>
        new Response(" ".repeat(65537), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }),
    ).registrant(scope),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    createTaxConfigMaterialClient(
      async () =>
        new Response(JSON.stringify(registrant()), {
          headers: { "Content-Type": "application/json" },
        }),
    ).registrant(scope),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("requires exact current writer and original body hash in a committed receipt", async () => {
  const p = await createTaxConfigMaterialClient().prepare(scope, command),
    r = await receipt(p);
  await expect(
    validateTaxConfigMaterialReceipt(
      { ...r, version: await version({ recordedByActorReference: id(13) }) },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateTaxConfigMaterialReceipt(
      { ...r, command: { ...p.command, content: { ...content, applicability: "Applicable" } } },
      p.cursor,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    validateTaxConfigMaterialVersion({ ...(await version()), contentDigest: hash }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("uses only canonical material roster query pins and rejects late actual Actor drift", async () => {
  const packet = {
      profile: "TaxConfigMaterialRosterV1",
      ...scope,
      materialKind: "RegistrationApplicability",
      afterMaterial: null,
      entries: [],
      nextAfterMaterial: null,
      observedAt: at,
      validUntil: until,
      qualification: "NotEvaluated",
    },
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(packet)),
    client = createTaxConfigMaterialClient(fetcher);
  await client.roster(scope, { materialKind: "RegistrationApplicability", afterMaterial: null });
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `/merchant/tax-config/authoring/materials/roster?storeReference=${id(3)}&materialKind=RegistrationApplicability`,
  );
  const changed = { ...scope };
  await expect(
    createTaxConfigMaterialClient(async () => {
      changed.actorReference = id(12);
      return response(await current());
    }).current(changed, { materialKind: "RegistrationApplicability", materialReference: id(6) }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("refuses getter-bearing content and sparse roster arrays", () => {
  const entries = new Array(1),
    packet = {
      profile: "TaxConfigMaterialRosterV1",
      ...scope,
      materialKind: "RegistrationApplicability",
      afterMaterial: null,
      entries,
      nextAfterMaterial: null,
      observedAt: at,
      validUntil: until,
      qualification: "NotEvaluated",
    };
  expect(() =>
    parseTaxConfigMaterialRoster(packet, scope, {
      materialKind: "RegistrationApplicability",
      afterMaterial: null,
    }),
  ).toThrow();
  const getter = Object.defineProperty({ ...content }, "sourceIssuedAt", {
    enumerable: true,
    get: vi.fn(() => at),
  });
  expect(() => parseTaxConfigMaterialContent(getter, "RegistrationApplicability")).toThrow();
  const descriptor = Object.getOwnPropertyDescriptor(getter, "sourceIssuedAt");
  expect(descriptor?.get).not.toHaveBeenCalled();
});
function fixtureSuite(kind: "Basket" | "Refund" = "Basket") {
  const signed = (v: string) => (kind === "Refund" ? "-" + v : v);
  return {
    targetPublicationCandidate: { versionReference: id(40), contentDigest: hash },
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(41),
      metadataDigest: hash,
    },
    cases: [
      {
        fixture: {
          profile: "TaxDraftFixtureV1",
          fixtureReference: id(42),
          kind,
          evaluatedAt: at,
          lines: [
            {
              lineReference: id(43),
              calculationReferences: [id(44)],
              labelCode: "MEAL",
              taxClassificationReference: id(45),
              orderType: "Pickup",
              chargeType: "Sellable",
              amountMinor: signed("100"),
            },
          ],
        },
        expected: {
          fixtureReference: id(42),
          kind,
          configurationReference: id(46),
          versionReference: id(40),
          snapshotDigest: hash,
          netAmountMinor: signed("100"),
          taxAmountMinor: signed("13"),
          grossAmountMinor: signed("113"),
          receiptPreview: [
            {
              lineReference: id(43),
              labelCode: "MEAL",
              componentCode: "ON-HST",
              treatment: "Taxable",
              rate: "0.13",
              taxAmountMinor: signed("13"),
            },
          ],
        },
      },
    ],
    sourceIssuedAt: at,
    declaredSourceDigest: null,
  };
}
it.each(["Basket", "Refund"] as const)(
  "parses complete declared %s suite without adding qualification",
  (kind) => {
    const input = fixtureSuite(kind),
      parsed = parseTaxConfigMaterialContent(input, "FixtureSuite");
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect("cases" in parsed && Object.isFrozen(parsed.cases[0]?.expected.receiptPreview)).toBe(
      true,
    );
    expect(parsed).not.toHaveProperty("professionalReviewStatus");
  },
);
it("refuses suite totals, signs, source pins, duplicate fixture IDs and missing component parity", () => {
  const input = fixtureSuite(),
    item = input.cases[0];
  if (!item) throw Error("Missing controlled suite case");
  const bad = [
    { ...input, cases: [{ ...item, expected: { ...item.expected, grossAmountMinor: "114" } }] },
    { ...input, cases: [{ ...item, expected: { ...item.expected, versionReference: id(47) } }] },
    { ...input, cases: [item, item] },
    { ...input, cases: [{ ...item, expected: { ...item.expected, receiptPreview: [] } }] },
    {
      ...input,
      cases: [
        {
          ...item,
          fixture: { ...item.fixture, lines: [{ ...item.fixture.lines[0], amountMinor: "-100" }] },
        },
      ],
    },
  ];
  for (const value of bad)
    expect(() => parseTaxConfigMaterialContent(value, "FixtureSuite")).toThrow();
});
it("refuses suite sparse arrays, getters, floats, noncanonical amounts and fake professional status", () => {
  const input = fixtureSuite(),
    item = input.cases[0];
  if (!item) throw Error("Missing controlled suite case");
  const getter = vi.fn(() => at),
    value = Object.defineProperty({ ...input }, "sourceIssuedAt", {
      enumerable: true,
      get: getter,
    });
  expect(() => parseTaxConfigMaterialContent(value, "FixtureSuite")).toThrow();
  expect(getter).not.toHaveBeenCalled();
  for (const cases of [new Array(1), [], Array.from({ length: 257 }, () => item)])
    expect(() => parseTaxConfigMaterialContent({ ...input, cases }, "FixtureSuite")).toThrow();
  for (const tax of [13, "013", "1.3", "9223372036854775808"])
    expect(() =>
      parseTaxConfigMaterialContent(
        { ...input, cases: [{ ...item, expected: { ...item.expected, taxAmountMinor: tax } }] },
        "FixtureSuite",
      ),
    ).toThrow();
  expect(() =>
    parseTaxConfigMaterialContent({ ...input, qualification: "Pass" }, "FixtureSuite"),
  ).toThrow();
});
it("validates declared suite version digests and allows a different original recorder", async () => {
  const suite = fixtureSuite(),
    v = await version({
      materialKind: "FixtureSuite",
      content: suite,
      contentDigest: await digest(suite),
      recordedByActorReference: id(80),
    });
  expect((await validateTaxConfigMaterialVersion(v)).materialKind).toBe("FixtureSuite");
  await expect(validateTaxConfigMaterialVersion({ ...v, contentDigest: hash })).rejects.toThrow();
});
it("prepares and transmits full suite but its recovery cursor has no declared cases or rates", async () => {
  const suite = fixtureSuite(),
    client = createTaxConfigMaterialClient();
  const p = await client.prepare(scope, {
    ...command,
    materialKind: "FixtureSuite",
    content: suite,
  });
  expect(p.command.content).toEqual(suite);
  expect(JSON.stringify(p.cursor)).not.toMatch(/cases|"rate"|"expected"|currencyMetadata/);
  expect(p.cursor.materialKind).toBe("FixtureSuite");
});
const comparisonCommand = {
  configurationReference: id(46),
  targetPublicationCandidate: { versionReference: id(40), contentDigest: hash },
  fixtureSuiteMaterial: {
    materialReference: id(60),
    versionReference: id(61),
    contentDigest: hash,
  },
};
function comparisonOutput(matches = true) {
  return {
    profile: "TaxConfigMaterialComparisonV1",
    ...scope,
    comparison: {
      profile: "TaxConfigCandidateFixtureComparisonV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      candidate: comparisonCommand.targetPublicationCandidate,
      suite: comparisonCommand.fixtureSuiteMaterial,
      cases: [
        {
          fixtureReference: id(42),
          matches,
          actualDigest: hash,
          expectedDigest: matches ? hash : `sha256:${"b".repeat(64)}`,
          mismatchedFields: matches ? [] : ["taxAmountMinor", "grossAmountMinor", "receiptPreview"],
        },
      ],
      allCasesMatched: matches,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    },
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  };
}
it.each([true, false])(
  "accepts finite declared comparison matches=%s as mechanical-only, not an approval",
  async (matches) => {
    const fetcher = vi.fn<typeof fetch>(async () => response(comparisonOutput(matches))),
      client = createTaxConfigMaterialClient(fetcher),
      result = await client.compare(scope, comparisonCommand, { csrf });
    expect(result.comparison.allCasesMatched).toBe(matches);
    expect(result.referenceEligibility).toBe("NotEvaluated");
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/merchant/tax-config/authoring/materials/compare");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ "X-BOP-CSRF": csrf });
    expect(JSON.parse(String(request?.body))).toEqual(comparisonCommand);
    expect(String(request?.body)).not.toMatch(/fixtureReference|cases|issuer|operationReference/);
  },
);
it("rejects wrong scope/pins, inconsistent case booleans/digests, unknown mismatch fields and unordered arrays", () => {
  const output = comparisonOutput(false),
    c = output.comparison,
    entry = c.cases[0];
  if (!entry) throw Error("Missing controlled comparison case");
  const bad = [
    { ...output, actorReference: id(90) },
    { ...output, comparison: { ...c, suite: { ...c.suite, versionReference: id(90) } } },
    { ...output, comparison: { ...c, allCasesMatched: true } },
    { ...output, comparison: { ...c, cases: [{ ...entry, matches: true }] } },
    { ...output, comparison: { ...c, cases: [{ ...entry, expectedDigest: entry.actualDigest }] } },
    { ...output, comparison: { ...c, cases: [{ ...entry, mismatchedFields: ["Approved"] }] } },
    {
      ...output,
      comparison: {
        ...c,
        cases: [{ ...entry, mismatchedFields: ["receiptPreview", "taxAmountMinor"] }],
      },
    },
    { ...output, comparison: { ...c, cases: [entry, entry] } },
    { ...output, comparison: { ...c, professionalReviewStatus: "Pass" } },
  ];
  for (const value of bad)
    expect(() => parseTaxConfigMaterialComparison(value, scope, comparisonCommand)).toThrow();
});
it("readonly compare never treats a lost/malformed reply or abort as OutcomeUnknown", async () => {
  for (const fetcher of [
    vi.fn<typeof fetch>(async () => {
      throw Error("Controlled lost read");
    }),
    vi.fn<typeof fetch>(async () => response({ unexpected: true })),
  ])
    await expect(
      createTaxConfigMaterialClient(fetcher).compare(scope, comparisonCommand, { csrf }),
    ).rejects.not.toMatchObject({ code: "OutcomeUnknown" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    createTaxConfigMaterialClient().compare(scope, comparisonCommand, {
      csrf,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("requires a fresh 5-second comparison lease and original captured scope after dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    response({ ...comparisonOutput(), validUntil: at }),
  );
  await expect(
    createTaxConfigMaterialClient(fetcher).compare(scope, comparisonCommand, { csrf }),
  ).rejects.toThrow();
  const expired = vi.fn<typeof fetch>(async () =>
    response({ ...comparisonOutput(), observedAt: "2026-10-06T09:59:55.000Z", validUntil: at }),
  );
  await expect(
    createTaxConfigMaterialClient(expired).compare(scope, comparisonCommand, { csrf }),
  ).rejects.toMatchObject({ code: "Stale" });
  const changed = { ...scope },
    drift = vi.fn<typeof fetch>(async () => {
      changed.actorReference = id(90);
      return response(comparisonOutput());
    });
  await expect(
    createTaxConfigMaterialClient(drift).compare(changed, comparisonCommand, { csrf }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});

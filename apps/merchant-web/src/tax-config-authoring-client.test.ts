// Controlled HTTP and synthetic rule inputs; no native IAM, professional approval or tax advice.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canonicalPublicationValue as canonical,
  publicationValueDigest as digest,
} from "./product-publication-command-client-v2.js";
import {
  createTaxConfigAuthoringClient,
  parseTaxConfigDraftFixture,
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringContent,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringCursor,
  validateTaxConfigAuthoringReceipt,
  validateTaxConfigDraftSnapshot,
  type PreparedTaxConfigAuthoringCommand,
} from "./tax-config-authoring-client.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43),
  hash = `sha256:${"a".repeat(64)}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = () => ({
  stableCode: "SYNTHETIC_TAX",
  effectivePeriod: {
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: "2026-10-05T04:00:00.000Z",
      localDateTime: "2026-10-05T00:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil: null,
  },
  rules: [],
});
const command = (operationReference = id(5)) => ({
  action: "CreateDraft",
  operationReference,
  configurationReference: null,
  expectedAggregateVersion: null,
  content: content(),
});
const prepared = () => createTaxConfigAuthoringClient().prepare(scope, command());
async function snapshot() {
  const base = {
    configurationReference: id(6),
    versionReference: id(7),
    brandReference: id(2),
    storeReference: id(3),
    stableCode: "SYNTHETIC_TAX",
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft",
    jurisdictionCode: "CA-ON",
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 3,
      metadataVersion: 1,
      metadataVersionReference: id(8),
      metadataDigest: hash,
    },
    effectivePeriod: content().effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: [],
    createdAt: at,
  };
  return { ...base, snapshotDigest: await digest(base) };
}
async function receipt(p: PreparedTaxConfigAuthoringCommand, abandoned = false) {
  return {
    profile: "TaxConfigAuthoringOperationV1",
    ...scope,
    action: p.command.action,
    operationReference: p.command.operationReference,
    configurationReference: p.command.configurationReference,
    expectedAggregateVersion: p.command.expectedAggregateVersion,
    command: abandoned ? null : p.command,
    intentDigest: p.intentDigest,
    serviceIntentDigest: abandoned ? null : hash,
    outcome: abandoned ? "Abandoned" : "Committed",
    snapshot: abandoned ? null : await snapshot(),
    auditReference: id(9),
    eventReference: abandoned ? null : id(10),
    occurredAt: at,
  };
}
async function current(target: string | null = id(6)) {
  return {
    profile: "TaxConfigAuthoringCurrentV1",
    ...scope,
    configurationReference: target,
    state:
      target === null
        ? null
        : {
            profile: "TaxConfigAuthoringStateV1",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            draftAuthorActorReference: id(11),
            snapshot: await snapshot(),
          },
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  };
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("prepares detached frozen full original and a payload-free scope-bound cursor", async () => {
  const raw = command(),
    p = await createTaxConfigAuthoringClient().prepare(scope, raw);
  raw.content.stableCode = "CHANGED";
  expect(p.command.content.stableCode).toBe("SYNTHETIC_TAX");
  expect(p.intentDigest).toBe(await digest({ scope, command: p.command }));
  expect(Object.isFrozen(p.command.content.effectivePeriod.effectiveFrom)).toBe(true);
  expect(Object.keys(p.cursor).sort()).toEqual(
    [
      "action",
      "configurationReference",
      "expectedAggregateVersion",
      "intentDigest",
      "operationReference",
      "profile",
      "scope",
    ].sort(),
  );
  expect(JSON.stringify(p.cursor)).not.toContain("content");
});
it("permits incomplete Draft and rejects caller-owned evidence, identity and allocation", () => {
  expect(parseTaxConfigAuthoringCommand(command()).content.rules).toEqual([]);
  for (const name of [
    "professionalEvidence",
    "registrationEvidence",
    "currencyMetadata",
    "actorReference",
    "createdAt",
    "versionReference",
  ])
    expect(() =>
      parseTaxConfigAuthoringCommand({ ...command(), content: { ...content(), [name]: null } }),
    ).toThrow();
  expect(() =>
    parseTaxConfigAuthoringCommand({ ...command(), configurationReference: id(6) }),
  ).toThrow();
});
it("refuses sparse rules, accessor input, invalid rate and incoherent component groups", () => {
  expect(() => parseTaxConfigAuthoringContent({ ...content(), rules: new Array(1) })).toThrow();
  let invoked = false;
  const raw = command();
  Object.defineProperty(raw, "content", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("must not run");
    },
  });
  expect(() => parseTaxConfigAuthoringCommand(raw)).toThrow();
  expect(invoked).toBe(false);
  const rule = {
    taxClassificationReference: id(12),
    orderType: "Pickup",
    chargeType: "Sellable",
    taxComponentCode: "SYNTHETIC",
    treatment: "Taxable",
    rate: "0.13",
    priceInclusion: "Exclusive",
    roundingMode: "HalfUp",
    calculationOrder: 1,
    compoundOnPriorTax: false,
    exceptionEvidenceReference: null,
    receiptPresentationCode: "SYNTHETIC",
  };
  for (const rate of [0.13, "0.130", "-0.1", "1e-2"])
    expect(() =>
      parseTaxConfigAuthoringContent({ ...content(), rules: [{ ...rule, rate }] }),
    ).toThrow();
  expect(() => parseTaxConfigAuthoringContent({ ...content(), rules: [rule, rule] })).toThrow();
  expect(() =>
    parseTaxConfigAuthoringContent({ ...content(), rules: [{ ...rule, ruleReference: id(13) }] }),
  ).toThrow();
  expect(parseTaxConfigAuthoringContent({ ...content(), rules: [rule] }).rules[0]?.rate).toBe(
    "0.13",
  );
});
it("loads current with exact scope header and GET query, preserving a different historical author", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await current())),
    c = createTaxConfigAuthoringClient(f),
    v = await c.current({ scope, configurationReference: id(6) });
  expect(v.state?.draftAuthorActorReference).toBe(id(11));
  expect(v.actorReference).toBe(id(4));
  expect(v.state?.snapshot.currencyMetadata.minorUnitExponent).toBe(3);
  const [url, options] = f.mock.calls[0] ?? [];
  expect(url).toBe(
    `/merchant/tax-config/authoring/current?storeReference=${id(3)}&configurationReference=${id(6)}`,
  );
  expect(options).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(options?.headers);
  expect(headers.has("X-BOP-CSRF")).toBe(false);
  expect(JSON.parse(atob(headers.get("X-BOP-Store-Setup-Scope") ?? ""))).toEqual(scope);
});
it("omits null current target and reads actual empty workspace", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await current(null)));
  expect(
    (await createTaxConfigAuthoringClient(f).current({ scope, configurationReference: null }))
      .state,
  ).toBeNull();
  expect(String(f.mock.calls[0]?.[0])).not.toContain("configurationReference=");
});
it("validates actual snapshot digest and refuses malformed or foreign current facts", async () => {
  const s = await snapshot();
  await expect(
    validateTaxConfigDraftSnapshot({ ...s, stableCode: "CHANGED" }),
  ).rejects.toMatchObject({ code: "Invalid" });
  const raw = await current();
  for (const change of [
    { actorReference: id(99) },
    { configurationReference: id(99) },
    { validUntil: "2026-10-05T10:00:05.001Z" },
  ])
    expect(() => parseTaxConfigAuthoringCurrent({ ...raw, ...change }, scope, id(6))).toThrow();
  const f = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      response({ ...raw, state: { ...raw.state, snapshot: { ...s, snapshotDigest: hash } } }),
    );
  await expect(
    createTaxConfigAuthoringClient(f).current({ scope, configurationReference: id(6) }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("checks roster request cursor/order/scope/digest without claiming qualification", async () => {
  const v = await current(),
    state = v.state;
  if (!state) throw new Error("controlled state absent");
  const raw = {
    profile: "TaxConfigAuthoringRosterV1",
    ...scope,
    afterConfiguration: null,
    entries: [state],
    nextAfterConfiguration: null,
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  };
  const f = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
  expect(
    (await createTaxConfigAuthoringClient(f).roster({ scope, afterConfiguration: null })).entries,
  ).toHaveLength(1);
  for (const change of [
    { entries: [state, state] },
    { nextAfterConfiguration: id(6) },
    { afterConfiguration: id(5) },
    { entries: [{ ...state, tenantReference: id(99) }] },
  ])
    expect(() => parseTaxConfigAuthoringRoster({ ...raw, ...change }, scope, null)).toThrow();
});
it("dispatches exact closed bytes and validates committed original without rewriting Create pins", async () => {
  const p = await prepared(),
    f = vi.fn<typeof fetch>().mockImplementation(async () => response(await receipt(p))),
    r = await createTaxConfigAuthoringClient(f).execute(scope, p.command, { csrf });
  expect(r.command?.configurationReference).toBeNull();
  expect(r.snapshot?.configurationReference).toBe(id(6));
  expect(r.intentDigest).not.toBe(r.serviceIntentDigest);
  expect(f.mock.calls[0]?.[1]?.body).toBe(canonical(p.command));
  expect(new Headers(f.mock.calls[0]?.[1]?.headers).get("X-BOP-CSRF")).toBe(csrf);
});
it("retries identical body and resolves the exact payload-free original tuple", async () => {
  const p = await prepared(),
    f = vi.fn<typeof fetch>().mockImplementation(async () => response(await receipt(p))),
    c = createTaxConfigAuthoringClient(f);
  await c.execute(scope, p.command, { csrf });
  await c.execute(scope, p.command, { csrf });
  const tuple = {
    action: p.command.action,
    operationReference: p.command.operationReference,
    configurationReference: null,
    expectedAggregateVersion: null,
    intentDigest: p.intentDigest,
  };
  await c.resolve(scope, tuple, { csrf });
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  expect(f.mock.calls[2]?.[1]?.body).toBe(canonical(tuple));
  expect(String(f.mock.calls[2]?.[0])).toMatch(/resolve-original$/u);
});
it("accepts Abandoned without fabricating command content, snapshot or event", async () => {
  const p = await prepared(),
    r = await validateTaxConfigAuthoringReceipt(await receipt(p, true), p.cursor);
  expect(r.command).toBeNull();
  expect(r.snapshot).toBeNull();
  expect(r.eventReference).toBeNull();
  await expect(
    validateTaxConfigAuthoringReceipt({ ...r, command: p.command }, p.cursor),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("unknown and malformed successful write responses remain OutcomeUnknown", async () => {
  const p = await prepared();
  for (const value of [
    { ok: true },
    { ...(await receipt(p)), actorReference: id(99) },
    { ...(await receipt(p)), snapshot: { ...(await snapshot()), snapshotDigest: hash } },
  ]) {
    const f = vi.fn<typeof fetch>().mockResolvedValue(response(value));
    await expect(
      createTaxConfigAuthoringClient(f).execute(scope, p.command, { csrf }),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  }
  await expect(
    createTaxConfigAuthoringClient(
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("controlled lost reply")),
    ).execute(scope, p.command, { csrf }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  [403, "request_denied", "Denied"],
  [400, "tax_config_authoring_invalid", "Invalid"],
  [409, "tax_config_authoring_conflict", "Conflict"],
  [503, "tax_config_authoring_feature_disabled", "FeatureDisabled"],
])("maps only finite closed rejection %s", async (status, error, code) => {
  const p = await prepared(),
    f = vi.fn<typeof fetch>().mockResolvedValue(response({ error }, Number(status)));
  await expect(
    createTaxConfigAuthoringClient(f).execute(scope, p.command, { csrf }),
  ).rejects.toMatchObject({ code });
});
it("refuses raw error echoes and missing no-store proof after dispatch", async () => {
  const p = await prepared(),
    f = vi.fn<typeof fetch>().mockResolvedValue(response({ error: "raw sensitive message" }, 403));
  await expect(
    createTaxConfigAuthoringClient(f).execute(scope, p.command, { csrf }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const g = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(await receipt(p)), {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(
    createTaxConfigAuthoringClient(g).execute(scope, p.command, { csrf }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("checks Abort before and after preparation hashing and refuses bad CSRF before dispatch", async () => {
  const controller = new AbortController(),
    f = vi.fn<typeof fetch>(),
    c = createTaxConfigAuthoringClient(f),
    pending = c.prepare(scope, command(), { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "Unavailable" });
  await expect(c.execute(scope, command(), { csrf: "invalid" })).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(f).not.toHaveBeenCalled();
});
it("an abort after actual dispatch remains an unknown original result", async () => {
  const p = await prepared(),
    controller = new AbortController();
  let announce: (() => void) | undefined, release: ((response: Response) => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const f = vi.fn<typeof fetch>().mockImplementation(() => {
    announce?.();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = createTaxConfigAuthoringClient(f).execute(scope, p.command, {
    csrf,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  if (!release) throw new Error("controlled dispatched response absent");
  release(response(await receipt(p)));
  await expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f).toHaveBeenCalledTimes(1);
});
it("suppresses an old scope response after a newer request starts", async () => {
  let release: ((response: Response) => void) | undefined;
  const f = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(async () =>
        response({ ...(await current(null)), actorReference: id(22) }),
      ),
    c = createTaxConfigAuthoringClient(f);
  const old = c.current({ scope, configurationReference: null });
  const newScope = { ...scope, actorReference: id(22) };
  await c.current({ scope: newScope, configurationReference: null });
  if (!release) throw new Error("controlled response not held");
  release(response(await current(null)));
  await expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("refuses content inserted into durable cursor and stale observations", async () => {
  const p = await prepared();
  expect(() =>
    parseTaxConfigAuthoringCursor({ ...p.cursor, content: p.command.content }),
  ).toThrow();
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await current()));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createTaxConfigAuthoringClient(f).current({ scope, configurationReference: id(6) }),
  ).rejects.toMatchObject({ code: "Stale" });
});

it("bootstraps only the actual Store reader scope without a guessed scope header", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await current(null))),
    c = createTaxConfigAuthoringClient(f);
  expect((await c.scope({ storeReference: scope.storeReference })).actorReference).toBe(
    scope.actorReference,
  );
  expect(f.mock.calls[0]?.[0]).toBe(
    `/merchant/tax-config/authoring/scope?storeReference=${scope.storeReference}`,
  );
  expect(f.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-BOP-Store-Setup-Scope");
});
it("refuses a scope bootstrap for a different actual Store", async () => {
  const raw = await current(null);
  raw.storeReference = id(99);
  await expect(
    createTaxConfigAuthoringClient(async () => response(raw)).scope({
      storeReference: scope.storeReference,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
const classificationPacket = () => ({
  profile: "TaxConfigClassificationChoicesV1",
  ...scope,
  registryReference: id(90),
  versionReference: id(91),
  registryVersion: 1,
  snapshotDigest: hash,
  defaultLocale: "en-CA",
  choices: [
    {
      classificationReference: id(92),
      code: "SYNTHETIC",
      localizedNames: { "en-CA": "Synthetic classification" },
      lifecycle: "Active",
    },
  ],
  observedAt: at,
  validUntil: until,
  sourceQualification: "NotEvaluated",
});
const simulationCommand = () => ({
  configurationReference: id(6),
  expectedVersionReference: id(7),
  expectedSnapshotDigest: hash,
  fixture: {
    profile: "TaxDraftFixtureV1" as const,
    fixtureReference: id(93),
    kind: "Basket" as const,
    evaluatedAt: at,
    lines: [
      {
        lineReference: id(94),
        calculationReferences: [id(95)],
        labelCode: "SYNTHETIC_LINE",
        taxClassificationReference: id(92),
        orderType: "Pickup" as const,
        chargeType: "Sellable" as const,
        amountMinor: "1000",
      },
    ],
  },
});
const simulationPacket = () => ({
  profile: "TaxConfigAuthoringSimulationV1",
  ...scope,
  configurationReference: id(6),
  versionReference: id(7),
  snapshotDigest: hash,
  simulation: {
    profile: "TaxDraftFixtureSimulationV1",
    fixtureReference: id(93),
    kind: "Basket",
    configurationReference: id(6),
    versionReference: id(7),
    snapshotDigest: hash,
    netAmountMinor: "900",
    taxAmountMinor: "100",
    grossAmountMinor: "1000",
    receiptPreview: [
      {
        lineReference: id(94),
        labelCode: "SYNTHETIC_LINE",
        componentCode: "SYNTHETIC_COMPONENT",
        treatment: "Taxable",
        rate: "0.1",
        taxAmountMinor: "100",
      },
    ],
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  },
  observedAt: at,
  validUntil: until,
  referenceEligibility: "NotEvaluated",
});
it("reads real classification identities with current reader scope and no professional claim", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(classificationPacket()));
  const value = await createTaxConfigAuthoringClient(f).classifications({ scope });
  expect(value.choices[0]?.lifecycle).toBe("Active");
  expect(Object.isFrozen(value.choices[0]?.localizedNames)).toBe(true);
  expect(f.mock.calls[0]?.[0]).toContain("/classifications?");
  expect(f.mock.calls[0]?.[1]?.headers).toHaveProperty("X-BOP-Store-Setup-Scope");
});
it("refuses fabricated classification qualification and duplicate identities", async () => {
  const raw = classificationPacket();
  await expect(
    createTaxConfigAuthoringClient(async () =>
      response({ ...raw, sourceQualification: "Pass" }),
    ).classifications({ scope }),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    createTaxConfigAuthoringClient(async () =>
      response({ ...raw, choices: [...raw.choices, ...raw.choices] }),
    ).classifications({ scope }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("accepts actual inclusive mechanical totals and sends exact immutable source pins", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(simulationPacket()));
  const c = createTaxConfigAuthoringClient(f);
  const value = await c.simulate({ scope, command: simulationCommand() }, { csrf });
  expect(value.simulation.netAmountMinor).toBe("900");
  expect(value.simulation.professionalReviewStatus).toBe("NotEvaluated");
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual(simulationCommand());
});
it("rejects refund sign, binary money, nonce reuse and injected professional claims", async () => {
  const base = simulationCommand();
  for (const fixture of [
    { ...base.fixture, kind: "Refund" },
    { ...base.fixture, lines: [{ ...base.fixture.lines[0], amountMinor: 1.5 }] },
    { ...base.fixture, fixtureReference: id(94) },
  ]) {
    expect(() => parseTaxConfigDraftFixture(fixture)).toThrow();
  }
  const packet = simulationPacket();
  await expect(
    createTaxConfigAuthoringClient(async () =>
      response({ ...packet, simulation: { ...packet.simulation, legalConclusion: "Pass" } }),
    ).simulate({ scope, command: base }, { csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
});
it("accepts actual negative Refund totals and rejects source drift or inconsistent sums", async () => {
  const base = simulationCommand(),
    command = {
      ...base,
      fixture: {
        ...base.fixture,
        kind: "Refund" as const,
        lines: base.fixture.lines.map((l) => ({ ...l, amountMinor: "-1000" })),
      },
    },
    p = simulationPacket();
  const raw = {
    ...p,
    simulation: {
      ...p.simulation,
      kind: "Refund",
      netAmountMinor: "-900",
      taxAmountMinor: "-100",
      grossAmountMinor: "-1000",
      receiptPreview: p.simulation.receiptPreview.map((l) => ({ ...l, taxAmountMinor: "-100" })),
    },
  };
  expect(
    (
      await createTaxConfigAuthoringClient(async () => response(raw)).simulate(
        { scope, command },
        { csrf },
      )
    ).simulation.grossAmountMinor,
  ).toBe("-1000");
  for (const bad of [
    { ...raw, versionReference: id(99) },
    { ...raw, simulation: { ...raw.simulation, grossAmountMinor: "-1001" } },
  ])
    await expect(
      createTaxConfigAuthoringClient(async () => response(bad)).simulate(
        { scope, command },
        { csrf },
      ),
    ).rejects.toMatchObject({ code: "Invalid" });
});
it("rejects late abort and expired classification observations", async () => {
  const expired = { ...classificationPacket(), validUntil: at };
  await expect(
    createTaxConfigAuthoringClient(async () => response(expired)).classifications({ scope }),
  ).rejects.toMatchObject({ code: "Invalid" });
  const c = new AbortController();
  const fetcher: typeof fetch = async () => {
    c.abort();
    return response(classificationPacket());
  };
  await expect(
    createTaxConfigAuthoringClient(fetcher).classifications({ scope }, { signal: c.signal }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});

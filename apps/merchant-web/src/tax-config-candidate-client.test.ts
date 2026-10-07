// Controlled HTTP packets, not current IAM, persistence or professional qualification.
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  createTaxConfigCandidateClient,
  parseTaxConfigCandidateCursor,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  validateTaxConfigCandidateReceipt,
  validateTaxConfigCandidateRecord,
} from "./tax-config-candidate-client.js";
import { publicationValueDigest as digest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902602-0017-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z",
  hash = "sha256:" + "a".repeat(64),
  csrf = "c".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const command = {
  action: "PrepareCandidate",
  operationReference: id(5),
  configurationReference: id(6),
  expectedDraft: {
    versionReference: id(7),
    snapshotDigest: hash,
    aggregateVersion: 1,
    versionNumber: 1,
  },
  registrationMaterial: { materialReference: id(8), versionReference: id(9), contentDigest: hash },
};
async function record() {
  const content = {
    profile: "TaxPublicationCandidateContentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(6),
    baseDraft: command.expectedDraft,
    targetVersionReference: id(10),
    targetAggregateVersion: 2,
    targetVersionNumber: 2,
    stableCode: "SYNTHETIC",
    jurisdictionCode: "CA-ON",
    currencyMetadata: {
      currencyCode: "CAD",
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: id(11),
      metadataDigest: hash,
    },
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
    registrationMaterial: command.registrationMaterial,
  };
  return {
    profile: "TaxConfigCandidateRecordV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    preparedByActorReference: id(4),
    operationReference: id(5),
    candidate: {
      profile: "TaxPublicationCandidateV1",
      content,
      contentDigest: await digest(content),
    },
    auditReference: id(12),
    eventReference: id(13),
    preparedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  };
}
async function receipt(abandoned = false) {
  return {
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command: abandoned ? null : command,
    intentDigest: await digest({ scope, command }),
    outcome: abandoned ? "Abandoned" : "Committed",
    result: abandoned ? null : await record(),
    auditReference: id(12),
    eventReference: abandoned ? null : id(13),
    occurredAt: at,
  };
}
async function current() {
  return {
    profile: "TaxConfigCandidateCurrentV1",
    ...scope,
    configurationReference: id(6),
    targetVersionReference: id(10),
    record: await record(),
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  };
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("prepares detached exact original pins without dispatch or full rules/material body", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const c = createTaxConfigCandidateClient(fetcher),
    p = await c.prepare(scope, command);
  expect(fetcher).not.toHaveBeenCalled();
  expect(Object.isFrozen(p.cursor.expectedDraft)).toBe(true);
  expect(p.cursor.intentDigest).toBe(await digest({ scope, command }));
  expect(p.cursor).toEqual({
    ...command,
    profile: "TaxConfigCandidatePendingOriginalV1",
    scope,
    intentDigest: p.intentDigest,
  });
  expect(() => parseTaxConfigCandidateCursor({ ...p.cursor, rules: [] })).toThrow();
});
it("validates actual content digest and immutable original, rejecting altered content or pins", async () => {
  const p = await createTaxConfigCandidateClient().prepare(scope, command),
    r = await receipt();
  expect((await validateTaxConfigCandidateReceipt(r, p.cursor)).result?.qualification).toBe(
    "NotEvaluated",
  );
  await expect(
    validateTaxConfigCandidateRecord({
      ...(await record()),
      candidate: { ...(await record()).candidate, contentDigest: hash },
    }),
  ).rejects.toThrow();
  await expect(
    validateTaxConfigCandidateReceipt({ ...r, operationReference: id(30) }, p.cursor),
  ).rejects.toThrow();
});
it("sends genuine scope/CSRF at correct ordinary paths, resolves same prepared pins with a new response", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await receipt())),
    c = createTaxConfigCandidateClient(f),
    p = await c.prepare(scope, command);
  await c.execute(p, { csrf });
  await c.resolve(p.cursor, { csrf });
  expect(f.mock.calls.map(([path]) => path)).toEqual([
    "/merchant/tax-config/authoring/candidates/commands",
    "/merchant/tax-config/authoring/candidates/resolve-original",
  ]);
  const opts = f.mock.calls[0]?.[1];
  expect(opts?.credentials).toBe("same-origin");
  expect(opts?.cache).toBe("no-store");
  expect(opts?.headers).toMatchObject({
    "X-BOP-CSRF": csrf,
    "X-BOP-Store-Setup-Scope": expect.any(String),
  });
  expect(JSON.parse(String(f.mock.calls[1]?.[1]?.body))).toEqual({
    ...command,
    intentDigest: p.intentDigest,
  });
});
it("reads genuine latest while enforcing explicit historical target, scope and fresh lease", async () => {
  const f = vi.fn<typeof fetch>().mockImplementation(async () => response(await current())),
    c = createTaxConfigCandidateClient(f);
  expect(
    (await c.current(scope, { configurationReference: id(6), targetVersionReference: null }))
      .targetVersionReference,
  ).toBe(id(10));
  await expect(
    c.current(scope, { configurationReference: id(6), targetVersionReference: id(30) }),
  ).rejects.toThrow();
  vi.mocked(Date.now).mockReturnValue(Date.parse(until));
  await expect(
    c.current(scope, { configurationReference: id(6), targetVersionReference: null }),
  ).rejects.toMatchObject({ code: "Stale" });
  expect(() =>
    parseTaxConfigCandidateCurrent({ ...scope, profile: "TaxConfigCandidateCurrentV1" }, scope, {
      configurationReference: id(6),
      targetVersionReference: null,
    }),
  ).toThrow();
});
it("retains malformed/lost reply as OutcomeUnknown and maps bounded denial/conflict", async () => {
  const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network")),
    c = createTaxConfigCandidateClient(f),
    p = await c.prepare(scope, command);
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  f.mockImplementation(async () => response({ error: "request_denied" }, 403));
  await expect(c.resolve(p.cursor, { csrf })).rejects.toMatchObject({ code: "Denied" });
  f.mockImplementation(async () => response({ error: "tax_config_authoring_conflict" }, 409));
  await expect(c.resolve(p.cursor, { csrf })).rejects.toMatchObject({ code: "Conflict" });
  f.mockImplementation(async () => response({ unexpected: true }));
  await expect(c.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("abort and invalidation cannot apply a delayed original response", async () => {
  let deliver: (v: Response) => void = vi.fn<(v: Response) => void>();
  const f = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    ),
    c = createTaxConfigCandidateClient(f),
    p = await c.prepare(scope, command),
    pending = c.resolve(p.cursor, { csrf });
  c.invalidate();
  deliver(response(await receipt()));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
  const a = new AbortController();
  a.abort();
  await expect(c.prepare(scope, command, { signal: a.signal })).rejects.toThrow();
});
it("rejects accessors, sparse rules and false qualification, and bounded roster foreign/cursor mismatches", async () => {
  const c = createTaxConfigCandidateClient();
  let invoked = false;
  await expect(
    c.prepare(scope, {
      ...command,
      get actorReference() {
        invoked = true;
        return id(4);
      },
    }),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
  const v = await record();
  const sparse = new Array(1);
  await expect(
    validateTaxConfigCandidateRecord({
      ...v,
      candidate: { ...v.candidate, content: { ...v.candidate.content, rules: sparse } },
    }),
  ).rejects.toThrow();
  await expect(
    validateTaxConfigCandidateRecord({ ...v, qualification: "Qualified" }),
  ).rejects.toThrow();
  const page = {
    profile: "TaxConfigCandidateRosterV1",
    ...scope,
    configurationReference: id(6),
    afterCandidate: null,
    entries: [],
    nextAfterCandidate: null,
    observedAt: at,
    validUntil: until,
    qualification: "NotEvaluated",
  };
  expect(
    parseTaxConfigCandidateRoster(page, scope, {
      configurationReference: id(6),
      afterCandidate: null,
    }).entries,
  ).toEqual([]);
  expect(() =>
    parseTaxConfigCandidateRoster({ ...page, actorReference: id(30) }, scope, {
      configurationReference: id(6),
      afterCandidate: null,
    }),
  ).toThrow();
  expect(() =>
    parseTaxConfigCandidateRoster({ ...page, nextAfterCandidate: id(10) }, scope, {
      configurationReference: id(6),
      afterCandidate: null,
    }),
  ).toThrow();
});

it("bounded roster rejects duplicate/out-of-order roots and false page continuation", async () => {
  const r = await record(),
    c = r.candidate.content;
  const entry = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationReference: id(6),
    targetVersionReference: id(10),
    targetAggregateVersion: 2,
    targetVersionNumber: 2,
    contentDigest: r.candidate.contentDigest,
    baseDraft: command.expectedDraft,
    registrationMaterial: command.registrationMaterial,
    preparedByActorReference: id(4),
    operationReference: id(5),
    preparedAt: at,
    status: "Recorded",
    qualification: "NotEvaluated",
  };
  const page = {
      profile: "TaxConfigCandidateRosterV1",
      ...scope,
      configurationReference: c.configurationReference,
      afterCandidate: null,
      entries: [entry],
      nextAfterCandidate: null,
      observedAt: at,
      validUntil: until,
      qualification: "NotEvaluated",
    },
    selected = { configurationReference: id(6), afterCandidate: null };
  expect(parseTaxConfigCandidateRoster(page, scope, selected).entries).toHaveLength(1);
  expect(() =>
    parseTaxConfigCandidateRoster({ ...page, entries: [entry, entry] }, scope, selected),
  ).toThrow();
  expect(() =>
    parseTaxConfigCandidateRoster(
      { ...page, entries: Array.from({ length: 21 }, () => entry) },
      scope,
      selected,
    ),
  ).toThrow();
  expect(() =>
    parseTaxConfigCandidateRoster({ ...page, nextAfterCandidate: id(10) }, scope, selected),
  ).toThrow();
});

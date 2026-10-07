// Controlled browser transport and durable-journal boundary; not native IAM or professional approval.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxConfigDraftPage,
  saveTaxConfigDraft,
  finishTaxConfigDraftOriginal,
  taxConfigUtcBoundary,
  taxConfigDraftContentFromUtc,
} from "./TaxConfigDraftPage.js";
import {
  createTaxConfigAuthoringClient,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringContent,
  type TaxConfigAuthoringCursor,
} from "./tax-config-authoring-client.js";
import type { TaxConfigAuthoringPendingJournal } from "./tax-config-authoring-pending-journal.js";
import { publicationValueDigest as digest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902601-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43),
  hash = `sha256:${"a".repeat(64)}`;
const content = parseTaxConfigAuthoringContent({
  stableCode: "SYNTHETIC_TAX",
  effectivePeriod: {
    timeZone: "UTC",
    effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
    effectiveUntil: null,
  },
  rules: [],
});
const empty = () => ({
  profile: "TaxConfigAuthoringCurrentV1",
  ...scope,
  configurationReference: null,
  state: null,
  observedAt: at,
  validUntil: until,
  referenceEligibility: "NotEvaluated",
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
async function fixture(lost = false) {
  const base = {
    configurationReference: id(6),
    versionReference: id(7),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    stableCode: content.stableCode,
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
    effectivePeriod: content.effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: [],
    createdAt: at,
  };
  const snapshot = { ...base, snapshotDigest: await digest(base) };
  let stored: TaxConfigAuthoringCursor | null = null,
    committed = false,
    requestBody: unknown = null;
  const j: TaxConfigAuthoringPendingJournal = {
    load: async () => stored,
    reserve: async (c) => {
      if (stored) throw Error("occupied");
      stored = c;
    },
    complete: vi.fn(async (c) => {
      if (stored !== c) throw Error("cursor mismatch");
      stored = null;
    }),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    const path = String(url);
    if (path.includes("/scope?")) return response(empty());
    if (path.includes("/current?"))
      return response(
        committed
          ? {
              ...empty(),
              configurationReference: id(6),
              state: {
                profile: "TaxConfigAuthoringStateV1",
                tenantReference: scope.tenantReference,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                draftAuthorActorReference: scope.actorReference,
                snapshot,
              },
            }
          : empty(),
      );
    if (path.endsWith("/commands")) {
      expect(stored).not.toBeNull();
      requestBody = JSON.parse(String(options?.body));
      committed = true;
      if (lost) throw Error("lost reply");
      const cursor = stored;
      if (!cursor) throw Error("missing reservation");
      return response({
        profile: "TaxConfigAuthoringOperationV1",
        ...scope,
        action: cursor.action,
        operationReference: cursor.operationReference,
        configurationReference: cursor.configurationReference,
        expectedAggregateVersion: cursor.expectedAggregateVersion,
        command: requestBody,
        intentDigest: cursor.intentDigest,
        serviceIntentDigest: hash,
        outcome: "Committed",
        snapshot,
        auditReference: id(9),
        eventReference: id(10),
        occurredAt: at,
      });
    }
    if (path.endsWith("/resolve-original")) {
      const cursor = stored;
      if (!cursor) throw Error("no original");
      expect(JSON.parse(String(options?.body))).toEqual({
        action: cursor.action,
        operationReference: cursor.operationReference,
        configurationReference: cursor.configurationReference,
        expectedAggregateVersion: cursor.expectedAggregateVersion,
        intentDigest: cursor.intentDigest,
      });
      return response({
        profile: "TaxConfigAuthoringOperationV1",
        ...scope,
        action: cursor.action,
        operationReference: cursor.operationReference,
        configurationReference: cursor.configurationReference,
        expectedAggregateVersion: cursor.expectedAggregateVersion,
        command: committed ? requestBody : null,
        intentDigest: cursor.intentDigest,
        serviceIntentDigest: committed ? hash : null,
        outcome: committed ? "Committed" : "Abandoned",
        snapshot: committed ? snapshot : null,
        auditReference: id(9),
        eventReference: committed ? id(10) : null,
        occurredAt: at,
      });
    }
    throw Error("unexpected route");
  });
  return {
    client: createTaxConfigAuthoringClient(fetcher),
    journal: j,
    fetcher,
    load: () => stored,
  };
}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
it("renders canonical ordinary Draft inputs and honest professional simulation boundaries", () => {
  const html = renderToStaticMarkup(
    <TaxConfigDraftPage storeReference={scope.storeReference} csrf={csrf} />,
  );
  expect(html).toContain('aria-label="Saved Tax Draft"');
  expect(html).toContain('aria-label="Effective from (UTC)"');
  expect(html).toContain('aria-label="Amount in minor units"');
  expect(html).toContain("Publishing remains unavailable");
  expect(html).not.toContain('type="number" value="0.13"');
});
it("reserves the payload-free original before POST and clears only after current result read", async () => {
  const f = await fixture(),
    c = new AbortController();
  const result = await saveTaxConfigDraft({
    client: f.client,
    journal: f.journal,
    scope,
    baseline: parseTaxConfigAuthoringCurrent(empty(), scope, null),
    content,
    operationReference: id(5),
    csrf,
    signal: c.signal,
  });
  expect(result.current.state?.snapshot.aggregateVersion).toBe(1);
  expect(f.load()).toBeNull();
  const paths = f.fetcher.mock.calls.map(([p]) => String(p));
  expect(paths.at(-1)).toContain("/current?");
  expect(paths.filter((p) => p.endsWith("/commands"))).toHaveLength(1);
});
it("lost result freezes the original through reload and explicitly resolves exact identity", async () => {
  const f = await fixture(true),
    c = new AbortController();
  await expect(
    saveTaxConfigDraft({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: parseTaxConfigAuthoringCurrent(empty(), scope, null),
      content,
      operationReference: id(5),
      csrf,
      signal: c.signal,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.load();
  expect(cursor).not.toBeNull();
  if (!cursor) throw Error("original missing");
  expect(JSON.stringify(cursor)).not.toContain("stableCode");
  const result = await finishTaxConfigDraftOriginal({
    client: f.client,
    journal: f.journal,
    cursor,
    csrf,
    signal: c.signal,
  });
  expect(result.receipt.outcome).toBe("Committed");
  expect(f.load()).toBeNull();
  expect(f.fetcher.mock.calls.filter(([p]) => String(p).endsWith("/commands"))).toHaveLength(1);
});
it("a switched actor blocks before reserve or business POST", async () => {
  const f = await fixture(),
    client = createTaxConfigAuthoringClient(async () =>
      response({ ...empty(), actorReference: id(99) }),
    );
  await expect(
    saveTaxConfigDraft({
      client,
      journal: f.journal,
      scope,
      baseline: parseTaxConfigAuthoringCurrent(empty(), scope, null),
      content,
      operationReference: id(5),
      csrf,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.load()).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("failed post-write refresh or cleanup preserves the original", async () => {
  const f = await fixture();
  f.journal.complete = async () => {
    throw Error("durability failure");
  };
  await expect(
    saveTaxConfigDraft({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: parseTaxConfigAuthoringCurrent(empty(), scope, null),
      content,
      operationReference: id(5),
      csrf,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("durability failure");
  expect(f.load()).not.toBeNull();
});
it("retains loaded IANA offsets and rejects guessed or malformed UTC boundaries", () => {
  expect(taxConfigUtcBoundary("2026-10-05T04:00:00.000Z", "America/Toronto")).toEqual({
    instant: "2026-10-05T04:00:00.000Z",
    localDateTime: "2026-10-05T00:00:00.000",
    utcOffsetMinutes: -240,
  });
  expect(() => taxConfigUtcBoundary("2026-02-30T00:00:00.000Z", "UTC")).toThrow();
});
it("recovery dispatches Resolve before current sources and denied recovery keeps its cursor", async () => {
  const f = await fixture(true),
    signal = new AbortController().signal;
  await expect(
    saveTaxConfigDraft({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: parseTaxConfigAuthoringCurrent(empty(), scope, null),
      content,
      operationReference: id(5),
      csrf,
      signal,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.load();
  if (!cursor) throw Error("missing original");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ error: "request_denied" }, 403));
  await expect(
    finishTaxConfigDraftOriginal({
      client: createTaxConfigAuthoringClient(fetcher),
      journal: f.journal,
      cursor,
      csrf,
      signal,
    }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(fetcher.mock.calls[0]?.[0]).toContain("/resolve-original");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.load()).toEqual(cursor);
});

it("requires explicit new-Draft time zone and produces actual Toronto offsets from UTC inputs", () => {
  const input = {
    stableCode: "SYNTHETIC_TAX",
    timeZone: "",
    effectiveFrom: "2026-10-05T04:00:00.000Z",
    effectiveUntil: "2026-12-05T05:00:00.000Z",
    rules: [],
  };
  expect(() => taxConfigDraftContentFromUtc(input)).toThrow();
  const parsed = taxConfigDraftContentFromUtc({ ...input, timeZone: "America/Toronto" });
  expect(parsed.effectivePeriod.timeZone).toBe("America/Toronto");
  expect(parsed.effectivePeriod.effectiveFrom).toEqual({
    instant: input.effectiveFrom,
    localDateTime: "2026-10-05T00:00:00.000",
    utcOffsetMinutes: -240,
  });
  expect(parsed.effectivePeriod.effectiveUntil).toEqual({
    instant: input.effectiveUntil,
    localDateTime: "2026-12-05T00:00:00.000",
    utcOffsetMinutes: -300,
  });
  const html = renderToStaticMarkup(
    <TaxConfigDraftPage storeReference={scope.storeReference} csrf={csrf} />,
  );
  expect(html).toContain('aria-label="Effective time zone" required=""');
  expect(html).toContain('value="" selected=""');
  expect(html).toContain("current CA-ON Tax profile");
});

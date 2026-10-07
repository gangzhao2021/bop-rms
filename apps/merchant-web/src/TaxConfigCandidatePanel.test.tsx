// Real browser clients with controlled HTTP/journal ports; not IAM or native persistence.
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TaxConfigCandidatePanel,
  prepareTaxConfigCandidate,
  finishTaxConfigCandidateOriginal,
} from "./TaxConfigCandidatePanel.js";
import {
  createTaxConfigCandidateClient,
  type TaxConfigCandidateCursor,
} from "./tax-config-candidate-client.js";
import { parseTaxConfigAuthoringCurrent } from "./tax-config-authoring-client.js";
import { parseTaxConfigMaterialCurrent } from "./tax-config-material-client.js";
import {
  publicationValueDigest as digest,
  canonicalPublicationValue as canonical,
} from "./product-publication-command-client-v2.js";
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
async function fixture() {
  const body = {
    configurationReference: id(6),
    versionReference: id(7),
    brandReference: id(2),
    storeReference: id(3),
    stableCode: "SYNTHETIC",
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft",
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
    registrationEvidence: null,
    professionalEvidence: null,
    rules: [],
    createdAt: at,
  };
  const snapshot = { ...body, snapshotDigest: await digest(body) },
    draft = parseTaxConfigAuthoringCurrent(
      {
        profile: "TaxConfigAuthoringCurrentV1",
        ...scope,
        configurationReference: id(6),
        state: {
          profile: "TaxConfigAuthoringStateV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          draftAuthorActorReference: id(4),
          snapshot,
        },
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      },
      scope,
      id(6),
    );
  const content = {
      operatingEntityProfileVersionReference: id(20),
      operatingEntityTaxReference: null,
      jurisdictionCode: "CA-ON",
      applicability: "NotApplicable",
      sourceIssuedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      declaredSourceDigest: null,
    },
    material = parseTaxConfigMaterialCurrent(
      {
        profile: "TaxConfigMaterialCurrentV1",
        ...scope,
        materialReference: id(8),
        materialKind: "RegistrationApplicability",
        version: {
          profile: "TaxConfigMaterialVersionV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          materialReference: id(8),
          versionReference: id(9),
          revision: 1,
          previousVersionReference: null,
          materialKind: "RegistrationApplicability",
          content,
          contentDigest: await digest(content),
          recordedByActorReference: id(30),
          createdAt: at,
          recordedAt: at,
          dataClassification: "Confidential",
          status: "Recorded",
          qualification: "NotEvaluated",
        },
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      },
      scope,
      { materialKind: "RegistrationApplicability", materialReference: id(8) },
    );
  let stored: unknown,
    original: TaxConfigCandidateCursor | null = null;
  const events: string[] = [];
  const state = {
    draftChanged: false,
    materialChanged: false,
    lost: false,
    deny: false,
    refreshFail: false,
    cleanupFail: false,
  };
  const fetcher = vi.fn<typeof fetch>(async (path, options) => {
    const url = String(path);
    if (url.includes("/authoring/current?")) {
      events.push("draft-current");
      return response(state.draftChanged ? { ...draft, state: null } : draft);
    }
    if (url.includes("materials/current?")) {
      events.push("material-current");
      return response(state.materialChanged ? { ...material, version: null } : material);
    }
    if (url.endsWith("candidates/commands")) {
      events.push("post");
      expect(original).not.toBeNull();
      const c = JSON.parse(String(options?.body));
      expect(canonical(c.expectedDraft)).toBe(
        canonical({
          versionReference: snapshot.versionReference,
          snapshotDigest: snapshot.snapshotDigest,
          aggregateVersion: 1,
          versionNumber: 1,
        }),
      );
      const candidateContent = {
          profile: "TaxPublicationCandidateContentV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          configurationReference: id(6),
          baseDraft: c.expectedDraft,
          targetVersionReference: id(10),
          targetAggregateVersion: 2,
          targetVersionNumber: 2,
          stableCode: "SYNTHETIC",
          jurisdictionCode: "CA-ON",
          currencyMetadata: body.currencyMetadata,
          effectivePeriod: body.effectivePeriod,
          rules: [],
          sourceRuleBindings: [],
          registrationMaterial: c.registrationMaterial,
        },
        record = {
          profile: "TaxConfigCandidateRecordV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          preparedByActorReference: id(4),
          operationReference: c.operationReference,
          candidate: {
            profile: "TaxPublicationCandidateV1",
            content: candidateContent,
            contentDigest: await digest(candidateContent),
          },
          auditReference: id(12),
          eventReference: id(13),
          preparedAt: at,
          dataClassification: "Confidential",
          status: "Recorded",
          qualification: "NotEvaluated",
        };
      stored = {
        profile: "TaxConfigCandidateOperationV1",
        ...scope,
        ...c,
        command: c,
        intentDigest: await digest({ scope, command: c }),
        outcome: "Committed",
        result: record,
        auditReference: id(12),
        eventReference: id(13),
        occurredAt: at,
      };
      if (state.lost) throw Error("lost reply");
      return response(stored);
    }
    if (url.endsWith("candidates/resolve-original")) {
      events.push("resolve");
      if (state.deny) return response({ error: "request_denied" }, 403);
      return response(stored);
    }
    if (url.includes("candidates/current?")) {
      events.push("candidate-current");
      if (state.refreshFail) throw Error("refresh unavailable");
      const r = stored as { result: unknown };
      return response({
        profile: "TaxConfigCandidateCurrentV1",
        ...scope,
        configurationReference: id(6),
        targetVersionReference: id(10),
        record: r.result,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    }
    throw Error("unselected controlled request");
  });
  vi.stubGlobal("fetch", fetcher);
  const journal = {
    load: vi.fn(async () => original),
    reserve: vi.fn(async (c: TaxConfigCandidateCursor) => {
      events.push("reserve");
      original = c;
    }),
    complete: vi.fn(async () => {
      events.push("complete");
      if (state.cleanupFail) throw Error("cleanup refused");
      original = null;
    }),
  };
  const o = {
    client: createTaxConfigCandidateClient(fetcher),
    journal,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return { o, draft, material, state, events, original: () => original, fetcher };
}
it("renders saved-source choices and truthful export without opaque ID inputs or enabled publication actions", () => {
  const html = renderToStaticMarkup(
    <TaxConfigCandidatePanel scope={scope} csrf={csrf} draft={null} />,
  );
  expect(html).toContain("Saved registration declaration");
  expect(html).toContain("Save a Tax Draft");
  expect(html).toContain("not establish professional approval");
  expect(html).not.toMatch(/<input|>Submit|>Approve|>Publish</u);
});
it("freshly compares actual Draft and immutable material before reserve/POST, then refreshes exact original before clear", async () => {
  const f = await fixture();
  const onReserved = vi.fn();
  const result = await prepareTaxConfigCandidate({
    ...f.o,
    scope,
    draft: f.draft,
    material: f.material,
    onReserved,
  });
  expect(result.receipt.outcome).toBe("Committed");
  expect(f.events).toEqual([
    "draft-current",
    "material-current",
    "reserve",
    "post",
    "candidate-current",
    "complete",
  ]);
  expect(onReserved).toHaveBeenCalledOnce();
  expect(f.original()).toBeNull();
});
it.each(["draftChanged", "materialChanged"] as const)(
  "changed actual source %s blocks before IDB reserve or command",
  async (key) => {
    const f = await fixture();
    f.state[key] = true;
    await expect(
      prepareTaxConfigCandidate({
        ...f.o,
        scope,
        draft: f.draft,
        material: f.material,
        onReserved: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(f.o.journal.reserve).not.toHaveBeenCalled();
    expect(f.events).not.toContain("post");
  },
);
it("lost reply retains exact original, and denied recovery never reads today's Draft/material", async () => {
  const f = await fixture();
  f.state.lost = true;
  await expect(
    prepareTaxConfigCandidate({
      ...f.o,
      scope,
      draft: f.draft,
      material: f.material,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.original();
  if (!cursor) throw Error("missing original");
  f.events.length = 0;
  f.state.deny = true;
  await expect(finishTaxConfigCandidateOriginal({ ...f.o, cursor })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(f.events).toEqual(["resolve"]);
  expect(f.original()).toEqual(cursor);
  f.state.deny = false;
  f.events.length = 0;
  await finishTaxConfigCandidateOriginal({ ...f.o, cursor });
  expect(f.events).toEqual(["resolve", "candidate-current", "complete"]);
  expect(f.original()).toBeNull();
});
it("failed authoritative refresh or cleanup keeps pending and stale scope cannot finish", async () => {
  const f = await fixture();
  f.state.refreshFail = true;
  await expect(
    prepareTaxConfigCandidate({
      ...f.o,
      scope,
      draft: f.draft,
      material: f.material,
      onReserved: vi.fn(),
    }),
  ).rejects.toThrow();
  const cursor = f.original();
  if (!cursor) throw Error("missing original");
  f.state.refreshFail = false;
  f.state.cleanupFail = true;
  await expect(finishTaxConfigCandidateOriginal({ ...f.o, cursor })).rejects.toThrow();
  expect(f.original()).toEqual(cursor);
  await expect(
    finishTaxConfigCandidateOriginal({ ...f.o, cursor, isCurrent: () => false }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});

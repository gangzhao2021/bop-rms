// Static render and controlled recovery composition; real browser acceptance is separate.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BrandConfigurationPanel,
  createInitialBrandConfigurationDraft,
  refreshBrandTemplateSelection,
  brandConfigurationExpectedBrandVersion,
  executeBrandConfigurationOriginal,
  recoverBrandConfigurationOriginal,
} from "./BrandConfigurationPanel.js";
import {
  createMerchantBrandConfigurationClient,
  parseBrandTemplateCandidate,
  parseBrandTemplateCandidates,
  type BrandConfigurationOriginal,
} from "./merchant-brand-configuration-client.js";
import type { BrandConfigurationPendingJournal } from "./brand-configuration-pending-journal.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(1), actorReference: id(2) },
  csrf = "a".repeat(43);
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const calls: string[] = [];
  let terminal: unknown = null;
  const fetcher = vi.fn<typeof fetch>(async (path) => {
    const mode = String(path).split("/").at(-1) ?? "";
    calls.push(mode);
    const base = {
      ...scope,
      observedAt: at,
      validUntil: until,
      currentPublication: "NotEvaluated",
    };
    const value =
      mode === "current"
        ? {
            profile: "TenantBrandConfigurationCurrentV1",
            ...base,
            current: null,
            recordedReview: null,
          }
        : mode === "history"
          ? {
              profile: "TenantBrandConfigurationHistoryV1",
              ...base,
              beforeRevision: null,
              entries: [],
              nextBeforeRevision: null,
            }
          : terminal;
    return new Response(JSON.stringify(value), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  });
  const client = createMerchantBrandConfigurationClient(fetcher),
    prepared = await client.prepare({
      profile: "TenantBrandConfigurationCommandV1",
      ...scope,
      command: "SaveConfigurationDraft",
      operationReference: id(3),
      expectedBrandVersion: 1,
      expectedHead: null,
      purposeCode: "BRAND_CONFIGURATION",
      configuration: {
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA"],
        mediaThemeReference: null,
        catalogSourceReference: id(4),
        platformTemplateReference: id(5),
        overrideAllowedFieldCodes: [],
        hardRequirementFieldCodes: ["CURRENCY"],
        effectiveFrom: at,
        effectiveUntil: null,
        reasonCode: "AUTHOR_EDIT",
      },
      reviewValidUntil: null,
    });
  const { profile, ...pins } = prepared.original;
  void profile;
  terminal = {
    profile: "TenantBrandConfigurationOperationV1",
    ...pins,
    originalCommand: null,
    outcome: "Abandoned",
    snapshot: null,
    auditReference: id(6),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  let pending: BrandConfigurationOriginal | null = null;
  const journal: BrandConfigurationPendingJournal = {
    load: vi.fn(async () => pending),
    reserve: vi.fn(async (original) => {
      calls.push("reserve");
      pending = original;
    }),
    complete: vi.fn(async () => {
      calls.push("compare-clear");
      pending = null;
    }),
  };
  const input = {
    client,
    journal,
    prepared,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
    canDispatch: () => true,
    onReserved: vi.fn(),
  };
  return { input, calls, fetcher, getPending: () => pending };
}
it("renders a named configuration region and offers refresh without invented reference inputs", () => {
  const journal: BrandConfigurationPendingJournal = {
    load: async () => null,
    reserve: async () => undefined,
    complete: async () => undefined,
  };
  const html = renderToStaticMarkup(
    <BrandConfigurationPanel
      scope={scope}
      csrf={csrf}
      brandVersion={7}
      journalFactory={() => journal}
      freshDisabled
    />,
  );
  expect(html).toContain('aria-labelledby="brand-configuration-title"');
  expect(html).toContain("Refresh configuration");
  expect(html).toContain("Load the current saved configuration");
  expect(html).not.toContain(id(1));
  expect(html).not.toContain('type="text"');
});
it("reserves before dispatch and reobserves the exact owner twice before current/history and clearing", async () => {
  const s = await setup();
  await executeBrandConfigurationOriginal(s.input);
  expect(s.calls).toEqual([
    "reserve",
    "execute",
    "resolve",
    "resolve",
    "current",
    "history",
    "compare-clear",
  ]);
  expect(s.input.onReserved).toHaveBeenCalledWith(s.input.prepared.original);
  expect(s.getPending()).toBeNull();
});
it("keeps a reserved original when edits change during asynchronous reservation", async () => {
  const s = await setup();
  await expect(
    executeBrandConfigurationOriginal({ ...s.input, canDispatch: () => false }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.calls).toEqual(["reserve"]);
  expect(s.getPending()).toEqual(s.input.prepared.original);
});
it("does not dispatch after scope generation changes while reservation is awaiting", async () => {
  const s = await setup();
  let current = true;
  const reserve = s.input.journal.reserve;
  s.input.journal.reserve = async (original) => {
    await reserve(original);
    current = false;
  };
  await expect(
    executeBrandConfigurationOriginal({ ...s.input, isCurrent: () => current }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(s.calls).toEqual(["reserve"]);
  expect(s.getPending()).toEqual(s.input.prepared.original);
});
it("retains the immutable original on an unknown response and permits later recovery", async () => {
  const s = await setup();
  s.fetcher.mockImplementationOnce(async () => {
    throw new Error("connection lost");
  });
  await expect(executeBrandConfigurationOriginal(s.input)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.getPending()).toEqual(s.input.prepared.original);
  await recoverBrandConfigurationOriginal({ ...s.input, original: s.input.prepared.original });
  expect(s.getPending()).toBeNull();
  expect(s.calls).toEqual(["reserve", "resolve", "resolve", "current", "history", "compare-clear"]);
});
it("does not clear when a real owner refusal occurs during reobservation", async () => {
  const s = await setup();
  await s.input.journal.reserve(s.input.prepared.original);
  s.fetcher.mockImplementationOnce(async () => new Response("{}", { status: 403 }));
  await expect(
    recoverBrandConfigurationOriginal({ ...s.input, original: s.input.prepared.original }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(s.input.journal.complete).not.toHaveBeenCalled();
  expect(s.getPending()).toEqual(s.input.prepared.original);
});
it("recovery does not depend on fresh-edit qualification or a new command allocation", async () => {
  const s = await setup();
  await s.input.journal.reserve(s.input.prepared.original);
  await recoverBrandConfigurationOriginal({ ...s.input, original: s.input.prepared.original });
  expect(s.calls).toEqual(["reserve", "resolve", "resolve", "current", "history", "compare-clear"]);
  expect(s.fetcher.mock.calls.every(([path]) => !String(path).endsWith("execute"))).toBe(true);
});
it("abort after reserve retains the scalar original and prevents dispatch", async () => {
  const s = await setup(),
    controller = new AbortController();
  const reserve = s.input.journal.reserve;
  s.input.journal.reserve = async (original) => {
    await reserve(original);
    controller.abort();
  };
  await expect(
    executeBrandConfigurationOriginal({ ...s.input, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(s.calls).toEqual(["reserve"]);
  expect(s.getPending()).toEqual(s.input.prepared.original);
});

it("uses only the latest of genuine observed owner versions without inventing an increment", () => {
  expect(brandConfigurationExpectedBrandVersion(7, 5)).toBe(7);
  expect(brandConfigurationExpectedBrandVersion(7, 8)).toBe(8);
  expect(brandConfigurationExpectedBrandVersion(7)).toBe(7);
  expect(() => brandConfigurationExpectedBrandVersion(0, 8)).toThrow();
});

it("refuses dispatch when another tab has replaced the durable scalar original", async () => {
  const s = await setup();
  s.input.journal.load = async () => ({ ...s.input.prepared.original, operationReference: id(9) });
  await expect(executeBrandConfigurationOriginal(s.input)).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.calls).toEqual(["reserve"]);
});
it("rechecks an explicit submit business deadline after durable reservation", async () => {
  const s = await setup(),
    prepared = await s.input.client.prepare({
      ...s.input.prepared.command,
      command: "SubmitConfiguration",
      expectedHead: {
        revision: 1,
        configurationVersionReference: id(11),
        sourceDigest: "sha256:" + "a".repeat(64),
      },
      configuration: null,
      reviewValidUntil: until,
    });
  const reserve = s.input.journal.reserve;
  s.input.journal.reserve = async (original) => {
    await reserve(original);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  };
  await expect(executeBrandConfigurationOriginal({ ...s.input, prepared })).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(s.calls).toEqual(["reserve"]);
  expect(s.getPending()).toEqual(prepared.original);
});

const selectedTemplate = () =>
  parseBrandTemplateCandidate({
    templateReference: id(20),
    templateVersionReference: id(21),
    revision: 1,
    contentDigest: "sha256:" + "a".repeat(64),
    code: "STANDARD",
    name: "Standard brand",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA", "fr-CA"],
    overrideAllowedFieldCodes: ["CONTACT"],
    hardRequirementFieldCodes: ["CURRENCY"],
    effectiveFrom: at,
    effectiveUntil: null,
    reasonCode: "TEMPLATE_AUTHORING",
  });
const initialFields = () => ({
  candidate: selectedTemplate(),
  catalogSourceReference: id(4),
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  overrideAllowedFieldCodes: [],
  effectiveFrom: "2026-10-06T10:01",
  effectiveUntil: "",
  reasonCode: "INITIAL_SETUP",
});
it("builds the first Draft only from selected owner content, real catalogue and explicit business fields", async () => {
  const fields = createInitialBrandConfigurationDraft(initialFields());
  expect(fields).toMatchObject({
    platformTemplateReference: id(21),
    catalogSourceReference: id(4),
    mediaThemeReference: null,
    hardRequirementFieldCodes: ["CURRENCY"],
    effectiveFrom: "2026-10-06T10:01:00.000Z",
    reasonCode: "INITIAL_SETUP",
  });
  const client = createMerchantBrandConfigurationClient(),
    prepared = await client.prepare({
      profile: "TenantBrandConfigurationCommandV1",
      ...scope,
      command: "SaveConfigurationDraft",
      operationReference: id(22),
      expectedBrandVersion: 1,
      expectedHead: null,
      purposeCode: "BRAND_CONFIGURATION",
      configuration: fields,
      reviewValidUntil: null,
    });
  expect(prepared.original.expectedHead).toBeNull();
  expect(prepared.original).not.toHaveProperty("configuration");
});
it.each(["from", "reason", "locale", "override", "period"])(
  "does not invent or exceed first-Draft %s values",
  (field) => {
    const value = initialFields(),
      invalid =
        field === "from"
          ? { ...value, effectiveFrom: "" }
          : field === "reason"
            ? { ...value, reasonCode: "" }
            : field === "locale"
              ? { ...value, supportedLocales: ["de-DE"] }
              : field === "override"
                ? { ...value, overrideAllowedFieldCodes: ["CURRENCY"] }
                : {
                    ...value,
                    candidate: { ...value.candidate, effectiveUntil: "2026-10-06T10:02:00.000Z" },
                  };
    expect(() => createInitialBrandConfigurationDraft(invalid)).toThrow();
  },
);
it("retains a first-Save original if its selected reference expires during reservation", async () => {
  const s = await setup(),
    prepared = await s.input.client.prepare({
      ...s.input.prepared.command,
      configuration: createInitialBrandConfigurationDraft(initialFields()),
    });
  let eligible = true;
  const reserve = s.input.journal.reserve;
  s.input.journal.reserve = async (original) => {
    await reserve(original);
    eligible = false;
  };
  await expect(
    executeBrandConfigurationOriginal({ ...s.input, prepared, canDispatch: () => eligible }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.calls).toEqual(["reserve"]);
  expect(s.getPending()).toEqual(prepared.original);
});

it("refreshes a selected later page from real new observations and takes the shortest lease", async () => {
  const secondCursor = id(30),
    nextAt = "2026-10-06T10:00:06.000Z",
    pageEnd = "2026-10-06T10:00:10.000Z",
    firstEnd = "2026-10-06T10:00:09.000Z",
    candidate = { ...selectedTemplate(), templateReference: id(31) },
    page = (after: string | null, items: unknown[], end: string) =>
      parseBrandTemplateCandidates(
        {
          profile: "MerchantBrandTemplateCandidatesV1",
          ...scope,
          afterTemplateReference: after,
          items,
          hasMore: false,
          nextAfterTemplateReference: null,
          observedAt: nextAt,
          validUntil: end,
        },
        scope,
        after,
      ),
    templates = vi.fn(async (_scope: typeof scope, after: string | null) =>
      after === null ? page(null, [], firstEnd) : page(secondCursor, [candidate], pageEnd),
    );
  const observed = await refreshBrandTemplateSelection({
    client: { templates },
    scope,
    selectedAfterTemplateReference: secondCursor,
    csrf,
    signal: new AbortController().signal,
  });
  expect(templates.mock.calls.map((call) => call[1])).toEqual([null, secondCursor]);
  expect(observed.candidates.items[0]?.templateVersionReference).toBe(
    candidate.templateVersionReference,
  );
  expect(observed.candidates.validUntil).toBe(firstEnd);
  expect(observed.candidates.observedAt).toBe(nextAt);
});
it("does not substitute a disappeared selected later-page candidate during refresh", async () => {
  const templates = vi.fn(async (_scope: typeof scope, after: string | null) =>
    parseBrandTemplateCandidates(
      {
        profile: "MerchantBrandTemplateCandidatesV1",
        ...scope,
        afterTemplateReference: after,
        items: [],
        hasMore: false,
        nextAfterTemplateReference: null,
        observedAt: at,
        validUntil: until,
      },
      scope,
      after,
    ),
  );
  const observed = await refreshBrandTemplateSelection({
    client: { templates },
    scope,
    selectedAfterTemplateReference: id(30),
    csrf,
    signal: new AbortController().signal,
  });
  expect(observed.candidates.items).toEqual([]);
  expect(templates).toHaveBeenCalledTimes(2);
  await refreshBrandTemplateSelection({
    client: { templates },
    scope,
    selectedAfterTemplateReference: null,
    csrf,
    signal: new AbortController().signal,
  });
  expect(templates).toHaveBeenCalledTimes(3);
});

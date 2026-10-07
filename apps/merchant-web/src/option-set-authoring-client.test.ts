import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Test-only owning public contracts establish authentic complete fixtures/digests.
// No Catalog runtime is imported by the browser implementation.
import {
  materializeFullOptionSetCreation,
  materializeFullOptionSetEdit,
  parseCatalogReference,
  parseCatalogInstant,
  createCatalogOptionSetAuthoringIdentity,
  createCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringResolutionCommand,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createOptionSetAuthoringClient,
  parseOptionSetAuthoringCursor,
  parseOptionSetEditorContent,
} from "./option-set-authoring-client.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const after = (ms: number) => parseCatalogInstant(new Date(Date.parse(at) + ms).toISOString());
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    operationReference: id(7),
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  };
}
function owningCreate(value: unknown = creation(), brandReference = scope.brandReference) {
  return materializeFullOptionSetCreation(
    {
      ...(value as ReturnType<typeof creation>),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference,
      actorReference: scope.actorReference,
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  );
}
function editing() {
  const original = creation();
  return {
    optionSetReference: id(6),
    expectedAggregateVersion: 1,
    operationReference: id(10),
    draft: {
      ...original.draft,
      options: original.draft.options.map((o) => ({
        ...o,
        identity: { kind: "Existing", optionReference: id(9) },
      })),
    },
    additionalContent: original.additionalContent,
    archiveOptionReferences: [],
  };
}
function owningEdit() {
  return materializeFullOptionSetEdit(
    { ...editing(), occurredAt: after(1), reasonCode: "AUTHORIZED_OPERATION" },
    owningCreate().content,
    { actorReference: scope.actorReference, newOptions: [] },
  );
}
function receipt(action: "Create" | "Edit" = "Create") {
  const source = action === "Create" ? owningCreate() : owningEdit();
  return {
    profile: "CatalogOptionSetAuthoringCommandResultV1",
    action,
    status: "Applied",
    operationReference: action === "Create" ? id(7) : id(10),
    storeReference: scope.storeReference,
    content: source.content,
    contentDigest: source.contentDigest,
    configurationDigest: source.configurationDigest,
    referenceEligibility: "NotEvaluated",
  };
}
function current() {
  const source = owningCreate();
  return {
    profile: "CatalogOptionSetCurrentEditorResultV1",
    ...scope,
    content: source.content,
    sourceDigest: source.sourceDigest,
    contentDigest: source.contentDigest,
    configurationDigest: source.configurationDigest,
    referenceEligibility: "NotEvaluated",
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function fetcher(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => response(body, status));
}
it("Create preserves exact original bytes/op for explicit same-page retry and validates actual owning full receipt", async () => {
  const f = fetcher(receipt()),
    client = createOptionSetAuthoringClient(f),
    input = creation(),
    prepared = client.prepareCreate(input, scope);
  input.internalCode = "MUTATED";
  expect((await prepared.execute(csrf)).content).toEqual(owningCreate().content);
  await prepared.execute(csrf);
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/create");
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).not.toHaveProperty("occurredAt");
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).not.toHaveProperty("actorReference");
  expect(f.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(prepared.cursor).toMatchObject({
    profile: "CatalogOptionSetAuthoringCursorV1",
    operationReference: id(7),
    optionSetReference: null,
    scope,
  });
  expect(prepared.cursor).not.toHaveProperty("content");
  expect(prepared.cursor).not.toHaveProperty("draft");
});
it("complete Edit preserves recorded IDs/content and validates owning root2 receipt", async () => {
  const f = fetcher(receipt("Edit")),
    p = createOptionSetAuthoringClient(f).prepareDraft(editing(), scope, owningCreate().content),
    r = await p.execute(csrf);
  expect(r.content).toEqual(owningEdit().content);
  expect(p.cursor.expectedAggregateVersion).toBe(1);
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/draft");
});
it("reads actual latest or explicit current full content and all three digests", async () => {
  const f = fetcher(current()),
    client = createOptionSetAuthoringClient(f);
  const r = await client.readCurrent(
    { optionSetReference: id(6), expectedAggregateVersion: null },
    scope,
    csrf,
  );
  expect(r.content).toEqual(owningCreate().content);
  expect(r.sourceDigest).toBe(owningCreate().sourceDigest);
  expect(r.referenceEligibility).toBe("NotEvaluated");
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/current-editor");
});
it("context accepts actual short lease and exposes only authentic scope", async () => {
  const f = fetcher({
      profile: "CatalogOptionSetAuthoringContextV1",
      action: "Create",
      ...scope,
      observedAt: at,
      validUntil: after(5000),
    }),
    r = await createOptionSetAuthoringClient(f).context(
      "Create",
      { brandReference: id(2), storeReference: id(3) },
      csrf,
    );
  expect(r.scope).toEqual(scope);
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/authoring/context");
});
it("stale context never becomes a fresh identity", async () => {
  const f = fetcher({
    profile: "CatalogOptionSetAuthoringContextV1",
    action: "Create",
    ...scope,
    observedAt: at,
    validUntil: after(5000),
  });
  vi.setSystemTime(after(5000));
  await expect(
    createOptionSetAuthoringClient(f).context(
      "Create",
      { brandReference: id(2), storeReference: id(3) },
      csrf,
    ),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("foreign Actor anchor/current root is refused", async () => {
  const f = fetcher({ ...current(), actorReference: id(99) });
  await expect(
    createOptionSetAuthoringClient(f).readCurrent(
      { optionSetReference: id(6), expectedAggregateVersion: null },
      scope,
      csrf,
    ),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it.each(["sourceDigest", "contentDigest", "configurationDigest"])(
  "current %s substitution fails",
  async (key) => {
    const f = fetcher({ ...current(), [key]: "sha256:" + "0".repeat(64) });
    await expect(
      createOptionSetAuthoringClient(f).readCurrent(
        { optionSetReference: id(6), expectedAggregateVersion: null },
        scope,
        csrf,
      ),
    ).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it.each(["contentDigest", "configurationDigest"])(
  "write %s substitution preserves unknown original",
  async (key) => {
    const f = fetcher({ ...receipt(), [key]: "sha256:" + "0".repeat(64) }),
      p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope);
    await expect(p.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(p.cursor.operationReference).toBe(id(7));
    expect(f).toHaveBeenCalledTimes(1);
  },
);
it("stale explicit root is refused without replacing request version", async () => {
  const f = fetcher(current());
  await expect(
    createOptionSetAuthoringClient(f).readCurrent(
      { optionSetReference: id(6), expectedAggregateVersion: 2 },
      scope,
      csrf,
    ),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("unknown response then Denied retains original identity and exact retry bytes", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Error("Synthetic response loss"))
      .mockResolvedValueOnce(response({ error: "request_denied" }, 403))
      .mockResolvedValueOnce(response(receipt())),
    p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope);
  await expect(p.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(p.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect((await p.execute(csrf)).operationReference).toBe(id(7));
  expect(new Set(f.mock.calls.map((c) => c[1]?.body)).size).toBe(1);
});
it("known initial Denied/Conflict use only closed public codes", async () => {
  await expect(
    createOptionSetAuthoringClient(fetcher({ error: "request_denied" }, 403))
      .prepareCreate(creation(), scope)
      .execute(csrf),
  ).rejects.toMatchObject({ code: "Denied" });
  await expect(
    createOptionSetAuthoringClient(fetcher({ error: "option_set_authoring_conflict" }, 409))
      .prepareCreate(creation(), scope)
      .execute(csrf),
  ).rejects.toMatchObject({ code: "Conflict" });
});
it("error payload with raw extra details is not treated as known denial", async () => {
  const p = createOptionSetAuthoringClient(
    fetcher({ error: "request_denied", detail: "Synthetic private material" }, 403),
  ).prepareCreate(creation(), scope);
  await expect(p.execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
    message: "Option Set request could not be confirmed",
  });
});
it("pre-dispatch aborted signal and invalid CSRF do not dispatch", async () => {
  const f = fetcher(receipt()),
    p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope),
    controller = new AbortController();
  controller.abort();
  await expect(p.execute(csrf, controller.signal)).rejects.toMatchObject({ code: "Unavailable" });
  await expect(p.execute("invalid")).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
});
it("abort after dispatch remains unknown even when transport ignores AbortSignal", async () => {
  const f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope),
    controller = new AbortController(),
    pending = p.execute(csrf, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f).toHaveBeenCalledTimes(1);
});
it("finite timeout leaves unknown original and does not automatically retry", async () => {
  const f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope),
    pending = p.execute(csrf);
  const observed = expect(pending).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await vi.advanceTimersByTimeAsync(15000);
  await observed;
  expect(f).toHaveBeenCalledTimes(1);
});
it("malformed full content cannot erase Additional fields", () => {
  const input = creation(),
    { optionDetails: ignored, ...rest } = input.additionalContent;
  void ignored;
  expect(() =>
    createOptionSetAuthoringClient(fetcher(receipt())).prepareCreate(
      { ...input, additionalContent: rest },
      scope,
    ),
  ).toThrow();
  expect(() =>
    parseOptionSetEditorContent({ ...owningCreate().content, optionDetails: [] }),
  ).toThrow();
});
it("closed body forbids client clock and Actor", () => {
  expect(() =>
    createOptionSetAuthoringClient().prepareCreate({ ...creation(), occurredAt: at }, scope),
  ).toThrow();
  expect(() =>
    createOptionSetAuthoringClient().prepareCreate({ ...creation(), actorReference: id(4) }, scope),
  ).toThrow();
});
it("Edit cannot silently delete historical options or change existing identity", () => {
  const c = editing();
  expect(() =>
    createOptionSetAuthoringClient().prepareDraft(
      {
        ...c,
        draft: { ...c.draft, options: [] },
        additionalContent: { ...c.additionalContent, optionDetails: [] },
      },
      scope,
      owningCreate().content,
    ),
  ).toThrow();
  expect(() =>
    createOptionSetAuthoringClient().prepareDraft(
      {
        ...c,
        draft: {
          ...c.draft,
          options: c.draft.options.map((o) => ({
            ...o,
            identity: { kind: "Existing", optionReference: id(99) },
          })),
        },
      },
      scope,
      owningCreate().content,
    ),
  ).toThrow();
});
function recovery(outcome: "Committed" | "Abandoned") {
  const cursor = createOptionSetAuthoringClient().prepareCreate(creation(), scope).cursor,
    command = parseCatalogOptionSetAuthoringResolutionCommand({
      profile: "CatalogOptionSetAuthoringResolutionCommandV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: scope.actorReference,
      action: "Create" as const,
      reasonCode: "AUTHORIZED_OPERATION",
      operationReference: id(7),
      optionSetReference: null,
      expectedAggregateVersion: null,
    });
  const source = owningCreate(),
    identity =
      outcome === "Abandoned"
        ? null
        : createCatalogOptionSetAuthoringIdentity({
            command,
            sourceOperationReference: id(7),
            optionSetReference: id(6),
            versionReference: id(8),
            aggregateVersion: 1,
            originalOccurredAt: at,
            auditReference: id(12),
            originalIntentDigest: "sha256:" + "1".repeat(64),
            sourceDigest: source.sourceDigest,
            contentDigest: source.contentDigest,
            configurationDigest: source.configurationDigest,
          }),
    resolution = createCatalogOptionSetAuthoringResolution({
      outcome,
      command,
      identity,
      recordedAt: at,
    });
  return {
    cursor,
    result: {
      profile: "CatalogOptionSetAuthoringResolutionResultV1",
      storeReference: scope.storeReference,
      resolution,
      content: identity ? source.content : null,
    },
  };
}
it.each(["Committed", "Abandoned"] as const)(
  "resolves owning %s exact original with identity-only request",
  async (outcome) => {
    const data = recovery(outcome),
      f = fetcher(data.result),
      r = await createOptionSetAuthoringClient(f).resolve(data.cursor, scope, csrf);
    expect(r.resolution.outcome).toBe(outcome);
    expect(r.content).toEqual(outcome === "Committed" ? owningCreate().content : null);
    const body = JSON.parse(String(f.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("actorReference");
    expect(body).not.toHaveProperty("content");
    expect(body.operationReference).toBe(id(7));
    expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/authoring/resolve");
  },
);
it("foreign cursor identity is not sent as a new actor's recovery", async () => {
  const data = recovery("Committed"),
    f = fetcher(data.result);
  await expect(
    createOptionSetAuthoringClient(f).resolve(
      data.cursor,
      { ...scope, actorReference: id(99) },
      csrf,
    ),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f).not.toHaveBeenCalled();
});
it("tampered original resolution digest is refused", async () => {
  const data = recovery("Committed"),
    f = fetcher({
      ...data.result,
      resolution: { ...data.result.resolution, digest: "sha256:" + "0".repeat(64) },
    });
  await expect(
    createOptionSetAuthoringClient(f).resolve(data.cursor, scope, csrf),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("cursor accepts no full payload or invented Create reference", () => {
  const cursor = recovery("Abandoned").cursor;
  expect(() =>
    parseOptionSetAuthoringCursor({ ...cursor, content: owningCreate().content }),
  ).toThrow();
  expect(() => parseOptionSetAuthoringCursor({ ...cursor, optionSetReference: id(6) })).toThrow();
});
it("oversized response fails boundedly", async () => {
  const f = fetcher({ padding: "x".repeat(2097153) }),
    p = createOptionSetAuthoringClient(f).prepareCreate(creation(), scope);
  await expect(p.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("requires no-store JSON response", async () => {
  const f = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(receipt()), { headers: { "Content-Type": "application/json" } }),
  );
  await expect(
    createOptionSetAuthoringClient(f).prepareCreate(creation(), scope).execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("New plus explicit Archive preserves old history and receives actual server allocations", async () => {
  const original = creation(),
    command = {
      ...editing(),
      archiveOptionReferences: [id(9)],
      draft: {
        ...original.draft,
        options: original.draft.options.map((o) => ({
          ...o,
          stableCode: "NEW",
          localizedNames: { "en-CA": "Synthetic new choice" },
          identity: { kind: "New" },
        })),
      },
      additionalContent: {
        ...original.additionalContent,
        optionDetails: original.additionalContent.optionDetails.map((d) => ({
          ...d,
          stableCode: "NEW",
        })),
      },
    },
    materialized = materializeFullOptionSetEdit(
      { ...command, occurredAt: after(1), reasonCode: "AUTHORIZED_OPERATION" },
      owningCreate().content,
      {
        actorReference: scope.actorReference,
        newOptions: [{ stableCode: "NEW", optionReference: id(13) }],
      },
    ),
    f = fetcher({
      ...receipt("Edit"),
      content: materialized.content,
      contentDigest: materialized.contentDigest,
      configurationDigest: materialized.configurationDigest,
    }),
    result = await createOptionSetAuthoringClient(f)
      .prepareDraft(command, scope, owningCreate().content)
      .execute(csrf);
  expect(
    result.content.sourceAggregate.draft.options.find((o) => o.stableCode === "NEW")
      ?.optionReference,
  ).toBe(id(13));
  expect(
    result.content.sourceAggregate.draft.options.find((o) => o.stableCode === "CHOICE"),
  ).toMatchObject({
    optionReference: id(9),
    lifecycle: "Archived",
    createdAt: at,
    createdByActorReference: scope.actorReference,
  });
});
it("full Pricing/Consumption/Media pins and local rules remain intact without qualification", async () => {
  const input = creation(),
    command = {
      ...input,
      draft: {
        ...input.draft,
        options: [
          ...input.draft.options,
          { ...input.draft.options[0], stableCode: "SECOND", sortOrder: 1 },
        ],
      },
      additionalContent: {
        ...input.additionalContent,
        optionDetails: [
          {
            ...input.additionalContent.optionDetails[0],
            stableCode: "CHOICE",
            media: {
              mediaReference: id(30),
              assetReference: id(31),
              assetVersionReference: id(32),
              altText: { "en-CA": "#1 synthetic choice" },
            },
            pricingRule: { reference: id(33), versionReference: id(34) },
            consumption: {
              kind: "Inventory",
              reference: id(35),
              versionReference: id(36),
              quantity: "0.25",
              unitCode: "GRAM",
            },
          },
          { ...input.additionalContent.optionDetails[0], stableCode: "SECOND" },
        ],
        conditionalRules: [
          {
            ruleReference: id(37),
            whenAllSelectedCodes: ["CHOICE"],
            requiredOptionCodes: ["SECOND"],
          },
        ],
      },
    },
    source = materializeFullOptionSetCreation(
      { ...command, occurredAt: at, reasonCode: "AUTHORIZED_OPERATION" },
      {
        brandReference: scope.brandReference,
        actorReference: scope.actorReference,
        allocations: {
          optionSetReference: id(6),
          versionReference: id(8),
          options: [
            { stableCode: "CHOICE", optionReference: id(9) },
            { stableCode: "SECOND", optionReference: id(14) },
          ],
        },
      },
    ),
    result = await createOptionSetAuthoringClient(
      fetcher({
        ...receipt(),
        content: source.content,
        contentDigest: source.contentDigest,
        configurationDigest: source.configurationDigest,
      }),
    )
      .prepareCreate(command, scope)
      .execute(csrf);
  expect(result.content).toEqual(source.content);
  expect(result.referenceEligibility).toBe("NotEvaluated");
});
it("rich document above Product's 10k nodes remains accepted within actual Option one-MiB budget", async () => {
  const base = creation(),
    localizedDescriptions = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [
        "en-" + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)),
        "Synthetic description ".repeat(3),
      ]),
    ),
    localizedNames = Object.fromEntries(
      Object.keys(localizedDescriptions).map((k) => [k, "Synthetic rich choice"]),
    ),
    command = {
      ...base,
      draft: {
        ...base.draft,
        options: Array.from({ length: 100 }, (_, i) => ({
          ...base.draft.options[0],
          stableCode: "CHOICE_" + i,
          sortOrder: i,
          localizedDescriptions,
          localizedNames,
        })),
      },
      additionalContent: {
        ...base.additionalContent,
        optionDetails: Array.from({ length: 100 }, (_, i) => ({
          ...base.additionalContent.optionDetails[0],
          stableCode: "CHOICE_" + i,
        })),
      },
    },
    source = materializeFullOptionSetCreation(
      { ...command, occurredAt: at, reasonCode: "AUTHORIZED_OPERATION" },
      {
        brandReference: scope.brandReference,
        actorReference: scope.actorReference,
        allocations: {
          optionSetReference: id(6),
          versionReference: id(8),
          options: Array.from({ length: 100 }, (_, i) => ({
            stableCode: "CHOICE_" + i,
            optionReference: id(100 + i),
          })),
        },
      },
    ),
    f = fetcher({
      ...receipt(),
      content: source.content,
      contentDigest: source.contentDigest,
      configurationDigest: source.configurationDigest,
    });
  expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeLessThan(1048576);
  expect(
    (await createOptionSetAuthoringClient(f).prepareCreate(command, scope).execute(csrf)).content,
  ).toEqual(source.content);
});

it("initial Detail read acquires real complete scope from current-editor without an Edit context", async () => {
  const f = fetcher(current());
  const result = await createOptionSetAuthoringClient(f).readCurrent(
    { optionSetReference: id(6), expectedAggregateVersion: null },
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
    csrf,
  );
  expect(result.scope).toEqual(scope);
  expect(result.content).toEqual(owningCreate().content);
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0]?.[0]).toBe("/merchant/catalog/option-sets/current-editor");
  const headers = f.mock.calls[0]?.[1]?.headers as Record<string, string>;
  expect(JSON.parse(atob(headers["X-BOP-Catalog-Scope"] ?? ""))).toEqual({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
});
it.each(["brandReference", "storeReference"])("initial Detail rejects changed %s", async (key) => {
  await expect(
    createOptionSetAuthoringClient(fetcher({ ...current(), [key]: id(99) })).readCurrent(
      { optionSetReference: id(6), expectedAggregateVersion: null },
      { brandReference: scope.brandReference, storeReference: scope.storeReference },
      csrf,
    ),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it.each(["tenantReference", "actorReference"])(
  "initial Detail still requires valid owner %s",
  async (key) => {
    await expect(
      createOptionSetAuthoringClient(fetcher({ ...current(), [key]: null })).readCurrent(
        { optionSetReference: id(6), expectedAggregateVersion: null },
        { brandReference: scope.brandReference, storeReference: scope.storeReference },
        csrf,
      ),
    ).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it.each(["tenantReference", "actorReference"])(
  "known Detail rejects changed %s instead of reacquiring identity",
  async (key) => {
    await expect(
      createOptionSetAuthoringClient(fetcher({ ...current(), [key]: id(99) })).readCurrent(
        { optionSetReference: id(6), expectedAggregateVersion: null },
        scope,
        csrf,
      ),
    ).rejects.toMatchObject({ code: "ScopeChanged" });
  },
);
it("refuses a partial identity anchor before dispatch", async () => {
  const f = fetcher(current());
  await expect(
    createOptionSetAuthoringClient(f).readCurrent(
      { optionSetReference: id(6), expectedAggregateVersion: null },
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorReference: scope.actorReference,
      },
      csrf,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
});

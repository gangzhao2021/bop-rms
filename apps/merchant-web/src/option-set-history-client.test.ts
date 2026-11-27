import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  materializeFullOptionSetCreation,
  parseCatalogReference,
  parseCatalogInstant,
  createCatalogFullOptionSetPublicationMaterialization,
  compareCatalogOptionSetContent,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createOptionSetHistoryClient,
  optionSetHistorySelectorFromEntry,
  isOptionSetHistoryListResult,
  isOptionSetHistorySelectedResult,
  isOptionSetHistoryComparisonResult,
  isOptionSetHistoryPublishingResult,
  parseOptionSetHistoryPacket,
} from "./option-set-history-client.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  until = "2026-10-05T12:00:05.000Z",
  intent = "sha256:" + "a".repeat(64);
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

function fixture() {
  const full = owningCreate();
  const { sourceAggregate, ...additional } = full.content;
  const frozen = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, additional, {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    versionReference: id(8),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(22),
    publicationIntentDigest: intent,
    successorDraftVersionReference: id(23),
    sealedAt: at,
    sourceDigest: full.sourceDigest,
    contentDigest: full.contentDigest,
    configurationDigest: full.configurationDigest,
  }).content;
  const tuple = {
    operationReference: id(7),
    versionReference: id(8),
    resultAggregateVersion: 1,
    action: "Create",
    intentDigest: intent,
    occurredAt: at,
  };
  const draft = {
    profile: "CatalogOptionSetHistoricalDraftV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    originalTuple: tuple,
    ...full,
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
  };
  const sealed = {
    profile: "CatalogOptionSetHistoricalFrozenV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    originalTuple: {
      ...tuple,
      operationReference: id(22),
      resultAggregateVersion: 2,
      action: "Publish",
    },
    content: frozen,
    sourceDigest: frozen.sourceDigest,
    contentDigest: frozen.contentDigest,
    configurationDigest: frozen.configurationDigest,
    recordDigest: frozen.digest,
    observedAt: at,
    validUntil: until,
    recordingStatus: "RecordedFrozen",
    referenceEligibility: "NotEvaluated",
  };
  const list = {
    profile: "CatalogOptionSetHistoryV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(6),
    currentAggregateVersion: 2,
    entries: [
      {
        resultAggregateVersion: 2,
        operationReference: id(22),
        kind: "FrozenSeal",
        action: "Publish",
        occurredAt: at,
        availability: "Complete",
        versionReference: id(8),
        sourceAggregateVersion: 1,
        sourceDigest: frozen.sourceDigest,
        contentDigest: frozen.contentDigest,
        configurationDigest: frozen.configurationDigest,
        recordDigest: frozen.digest,
      },
      {
        resultAggregateVersion: 1,
        operationReference: id(7),
        kind: "DraftSnapshot",
        action: "Create",
        occurredAt: at,
        availability: "Complete",
        versionReference: id(8),
        sourceAggregateVersion: 1,
        sourceDigest: full.sourceDigest,
        contentDigest: full.contentDigest,
        configurationDigest: full.configurationDigest,
        recordDigest: null,
      },
    ],
    nextBefore: null,
    observedAt: at,
    validUntil: until,
    publicationStatus: "NotEvaluated",
  };
  const publishing = {
    profile: "PublishingOptionSetHistoryV1",
    scope: {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      selectedStoreReference: scope.storeReference,
      actorReference: scope.actorReference,
    },
    familyReference: id(6),
    entries: [
      {
        operationReference: id(24),
        lifecycleReference: id(25),
        lifecycleVersion: 1,
        operation: "CreateDraft",
        actorKind: "User",
        actorReference: scope.actorReference,
        occurredAt: at,
        recordedAt: at,
        reasonCode: "AUTHORIZED_OPERATION",
        fromState: null,
        toState: "Draft",
        snapshotReference: id(26),
        snapshotDigest: intent,
        releaseReference: null,
        releaseSequence: null,
        supersededReleaseReference: null,
        rollbackTargetReleaseReference: null,
      },
    ],
    nextBefore: null,
    observedAt: at,
    validUntil: until,
  };
  const comparison = {
    profile: "CatalogOptionSetHistoryComparisonV1",
    left: { kind: "Draft", view: draft },
    right: { kind: "Frozen", view: sealed },
    comparison: compareCatalogOptionSetContent({ left: full.content, right: frozen.editorContent }),
    observedAt: at,
    validUntil: until,
  };
  let transform: (value: Record<string, unknown>) => unknown = (value) => value;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const packet = JSON.parse(String(init?.body)) as { action: string };
    const view =
      packet.action === "List"
        ? list
        : packet.action === "Draft"
          ? draft
          : packet.action === "Frozen"
            ? sealed
            : packet.action === "Publishing"
              ? publishing
              : comparison;
    return response(
      transform({
        profile: "CatalogOptionSetHistoryQueryResultV1",
        action: packet.action,
        storeReference: scope.storeReference,
        actorReference: scope.actorReference,
        view,
      }),
    );
  });
  const client = createOptionSetHistoryClient(fetcher);
  const input = { expectedScope: scope, csrf };
  const request = {
    action: "List",
    command: { optionSetReference: id(6), expectedAggregateVersion: null, before: null, limit: 50 },
  };
  async function roster() {
    const result = await client.load({ ...input, packet: request });
    if (!isOptionSetHistoryListResult(result)) throw new Error("Expected List");
    return result.view;
  }
  async function selection(kind: "Draft" | "Frozen") {
    const view = await roster(),
      entry = view.entries.find(
        (e) => e.kind === (kind === "Draft" ? "DraftSnapshot" : "FrozenSeal"),
      );
    if (!entry) throw new Error("Missing entry");
    return { roster: view, selector: optionSetHistorySelectorFromEntry(id(6), entry) };
  }
  return {
    client,
    fetcher,
    input,
    request,
    list,
    draft,
    sealed,
    publishing,
    comparison,
    roster,
    selection,
    transform: (fn: typeof transform) => {
      transform = fn;
    },
  };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
it("loads real bounded roster headers using same-origin CSRF/scope and no-store", async () => {
  const f = fixture(),
    view = await f.roster();
  expect(view.entries).toHaveLength(2);
  expect(view.publicationStatus).toBe("NotEvaluated");
  expect(Object.isFrozen(view.entries)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
  const args = f.fetcher.mock.calls[0];
  expect(args?.[0]).toBe("/merchant/catalog/option-sets/history");
  expect(args?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
});
it.each(["Draft", "Frozen"] as const)(
  "loads original %s through actual roster pins and full digests",
  async (kind) => {
    const f = fixture(),
      s = await f.selection(kind),
      result = await f.client.load({
        ...f.input,
        packet: { action: kind, command: s.selector.command },
        rosters: [s.roster],
      });
    expect(isOptionSetHistorySelectedResult(result)).toBe(true);
    if (!isOptionSetHistorySelectedResult(result)) throw new Error("Expected selected");
    expect(result.view.referenceEligibility).toBe("NotEvaluated");
    expect(result.view.originalTuple.operationReference).toBe(
      s.selector.command.operationReference,
    );
    if (kind === "Frozen") expect(result.view.recordingStatus).toBe("RecordedFrozen");
  },
);
it("verifies source-contained Compare without issuing repeated side reads", async () => {
  const f = fixture(),
    view = await f.roster(),
    draft = view.entries.find((e) => e.kind === "DraftSnapshot"),
    frozen = view.entries.find((e) => e.kind === "FrozenSeal");
  if (!draft || !frozen) throw new Error("Missing entries");
  const result = await f.client.load({
    ...f.input,
    packet: {
      action: "Compare",
      command: {
        left: optionSetHistorySelectorFromEntry(id(6), draft),
        right: optionSetHistorySelectorFromEntry(id(6), frozen),
      },
    },
    rosters: [view],
  });
  expect(isOptionSetHistoryComparisonResult(result)).toBe(true);
  if (!isOptionSetHistoryComparisonResult(result)) throw new Error("Expected Compare");
  expect(result.view.comparison.businessContentChanged).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("reads separate actual Publishing timeline without naming Frozen history Published", async () => {
  const f = fixture(),
    result = await f.client.load({
      ...f.input,
      packet: {
        action: "Publishing",
        command: { optionSetReference: id(6), before: null, limit: 50 },
      },
    });
  expect(isOptionSetHistoryPublishingResult(result)).toBe(true);
  if (!isOptionSetHistoryPublishingResult(result)) throw new Error("Expected Publishing");
  expect(result.view.entries[0]?.operation).toBe("CreateDraft");
});
it("refuses free selected IDs and roster substitution before transport", async () => {
  const f = fixture(),
    s = await f.selection("Draft");
  f.fetcher.mockClear();
  await expect(
    f.client.load({ ...f.input, packet: { action: "Draft", command: s.selector.command } }),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    f.client.load({
      ...f.input,
      packet: { action: "Draft", command: s.selector.command },
      rosters: [{ ...s.roster }],
    }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["actor", "Store", "Brand", "Tenant", "lease", "revision", "duplicate", "legacy", "extra"])(
  "rejects roster %s wire substitution",
  async (kind) => {
    const f = fixture();
    f.transform((value) => {
      const view = { ...f.list, entries: [...f.list.entries] };
      if (kind === "actor") return { ...value, actorReference: id(99) };
      if (kind === "Store") return { ...value, storeReference: id(99) };
      if (kind === "Brand") view.brandReference = id(99);
      if (kind === "Tenant") view.tenantReference = id(99);
      if (kind === "lease") view.validUntil = at;
      if (kind === "revision") view.currentAggregateVersion = 1;
      if (kind === "duplicate") view.entries = [...view.entries, ...view.entries];
      if (kind === "legacy")
        view.entries = view.entries.map((e) => ({ ...e, availability: "UnavailableLegacy" }));
      return { ...value, view, ...(kind === "extra" ? { privateFacts: true } : {}) };
    });
    await expect(f.roster()).rejects.toBeDefined();
  },
);
it.each(["content", "recordDigest", "intent", "version", "Published", "supported", "time"])(
  "rejects Frozen %s tampering",
  async (kind) => {
    const f = fixture(),
      s = await f.selection("Frozen");
    f.transform((value) => {
      const v: Record<string, unknown> = { ...f.sealed };
      if (kind === "recordDigest") v.recordDigest = intent;
      if (kind === "Published") v.recordingStatus = "Published";
      if (kind === "intent")
        v.originalTuple = { ...f.sealed.originalTuple, intentDigest: "sha256:" + "b".repeat(64) };
      if (kind === "version")
        v.originalTuple = { ...f.sealed.originalTuple, versionReference: id(99) };
      if (kind === "time")
        v.originalTuple = {
          ...f.sealed.originalTuple,
          occurredAt: parseCatalogInstant("2026-10-05T12:00:00.001Z"),
        };
      if (kind === "content")
        v.content = {
          ...f.sealed.content,
          editorContent: {
            ...f.sealed.content.editorContent,
            sourceAggregate: {
              ...f.sealed.content.editorContent.sourceAggregate,
              internalCode: "FORGED",
            },
          },
        };
      if (kind === "supported")
        v.content = {
          ...f.sealed.content,
          supportedContent: { ...f.sealed.content.supportedContent, configurationDigest: intent },
        };
      return { ...value, view: v };
    });
    await expect(
      f.client.load({
        ...f.input,
        packet: { action: "Frozen", command: s.selector.command },
        rosters: [s.roster],
      }),
    ).rejects.toBeDefined();
  },
);
it.each(["diff", "boolean", "preimage", "scope"])(
  "rejects counterfeit Compare %s",
  async (kind) => {
    const f = fixture(),
      view = await f.roster(),
      draft = view.entries.find((e) => e.kind === "DraftSnapshot"),
      frozen = view.entries.find((e) => e.kind === "FrozenSeal");
    if (!draft || !frozen) throw new Error("Missing entries");
    f.transform((value) => ({
      ...value,
      view: {
        ...f.comparison,
        comparison: {
          ...f.comparison.comparison,
          ...(kind === "diff" ? { fields: [{ field: "unknown", left: null, right: null }] } : {}),
          ...(kind === "boolean" ? { businessContentChanged: true } : {}),
          ...(kind === "scope" ? { brandReference: id(99) } : {}),
        },
        ...(kind === "preimage"
          ? { left: { kind: "Draft", view: { ...f.draft, content: f.sealed.content } } }
          : {}),
      },
    }));
    await expect(
      f.client.load({
        ...f.input,
        packet: {
          action: "Compare",
          command: {
            left: optionSetHistorySelectorFromEntry(id(6), draft),
            right: optionSetHistorySelectorFromEntry(id(6), frozen),
          },
        },
        rosters: [view],
      }),
    ).rejects.toBeDefined();
  },
);
it.each([
  [403, "request_denied", "Denied"],
  [409, "option_set_history_conflict", "Conflict"],
  [409, "option_set_history_feature_disabled", "FeatureDisabled"],
  [400, "option_set_history_invalid", "Invalid"],
  [503, "option_set_history_unavailable", "Unavailable"],
])("maps bounded HTTP %s/%s without automatic retry", async (status, error, code) => {
  const f = fixture(),
    fetcher = vi.fn(async () => response({ error }, Number(status)));
  await expect(
    createOptionSetHistoryClient(fetcher).load({ ...f.input, packet: f.request }),
  ).rejects.toMatchObject({ code });
  expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects malformed closed input and getter without evaluating it", () => {
  let calls = 0;
  expect(() =>
    parseOptionSetHistoryPacket({
      action: "List",
      get command() {
        calls++;
        return {};
      },
    }),
  ).toThrow();
  expect(calls).toBe(0);
  expect(() =>
    parseOptionSetHistoryPacket({
      action: "Publishing",
      command: { optionSetReference: id(6), familyReference: id(99), before: null, limit: 50 },
    }),
  ).toThrow();
});
it("rejects offline and cancellation including late transport reply", async () => {
  const f = fixture(),
    offline = vi.fn(async () => {
      throw new Error("offline");
    });
  await expect(
    createOptionSetHistoryClient(offline).load({ ...f.input, packet: f.request }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  let release: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
    abort = new AbortController(),
    pending = createOptionSetHistoryClient(fetcher).load({
      ...f.input,
      packet: f.request,
      signal: abort.signal,
    });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "Unavailable" });
  release?.(response({}));
  expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects expiry while streaming, invalid response headers and oversized bodies", async () => {
  const f = fixture();
  for (const headers of [{ "Cache-Control": "public" }, { "Content-Type": "text/html" }])
    await expect(
      createOptionSetHistoryClient(vi.fn(async () => response({}, 200, headers))).load({
        ...f.input,
        packet: f.request,
      }),
    ).rejects.toMatchObject({ code: "Unavailable" });
  const large = new Response(new Uint8Array(8_388_609), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  await expect(
    createOptionSetHistoryClient(vi.fn(async () => large)).load({ ...f.input, packet: f.request }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});

it("rejects lease expiry during an actual response before exposing original contents", async () => {
  const f = fixture();
  f.transform((value) => {
    vi.setSystemTime(until);
    return value;
  });
  await expect(f.roster()).rejects.toMatchObject({ code: "Stale" });
});

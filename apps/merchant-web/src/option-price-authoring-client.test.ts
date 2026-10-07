import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Owning public constructors are test-only; the browser has no Pricing runtime dependency.
import {
  createCurrencyMetadataSnapshot,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  optionPriceWireState,
  parseCurrencyCode,
  parseOptionPriceAuthoringCommand as owningCommand,
  parseOptionPriceAuthoringState,
  parsePricingDigest,
  parsePricingReference,
} from "../../../packages/rms/pricing/src/index.js";
import {
  createOptionPriceAuthoringClient,
  parseOptionPriceAuthoringCommand,
  OptionPriceAuthoringClientError,
} from "./option-price-authoring-client.js";
const id = (n: number) =>
  parsePricingReference("01902421-7990-7000-8000-" + n.toString(16).padStart(12, "0"));
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  csrf = "A".repeat(43),
  hash = "sha256:" + "a".repeat(64);
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  anchor = { productReference: id(30), expectedProductAggregateVersion: 2 },
  selection = { ...anchor, bindingReference: id(22), optionReference: id(23) };
const currency = createCurrencyMetadataSnapshot({
  currencyCode: parseCurrencyCode("CAD"),
  minorUnitExponent: 2,
  metadataVersion: 1,
  metadataVersionReference: id(8),
  metadataDigest: parsePricingDigest(hash),
});
function command() {
  return {
    action: "CreateDraft",
    operationReference: id(20),
    ruleReference: id(21),
    expectedAggregateVersion: null,
    bindingReference: id(22),
    optionReference: id(23),
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "9223372036854775807",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  };
}
function state() {
  const c = owningCommand(command()),
    version = materializeOptionPriceVersion({
      command: c,
      current: null,
      brandReference: scope.brandReference,
      versionReference: id(24),
      occurredAt: at,
      currencyMetadata: currency,
    });
  return structuredClone(
    optionPriceWireState(
      parseOptionPriceAuthoringState({
        profile: "OptionPriceAuthoringStateV1",
        brandReference: scope.brandReference,
        ruleReference: id(21),
        bindingReference: id(22),
        optionReference: id(23),
        aggregateVersion: 1,
        createdAt: at,
        createdByActorReference: scope.actorReference,
        updatedAt: at,
        draftAuthorActorReference: scope.actorReference,
        draft: optionPriceWireSnapshot(version),
        currentPublished: null,
        latestVersion: optionPriceWireSnapshot(version),
      }),
    ),
  );
}
function receipt() {
  return {
    profile: "MerchantOptionPriceAuthoringResultV1",
    action: "CreateDraft",
    operationReference: id(20),
    ...scope,
    outcome: "Committed",
    state: state(),
    occurredAt: at,
    observedAt: at,
    validUntil: until,
  };
}
function current() {
  return {
    profile: "MerchantOptionPriceAuthoringQueryV1",
    ...scope,
    observedAt: at,
    validUntil: until,
    states: [state()],
    context: {
      profile: "MerchantOptionPriceContextV1",
      ...scope,
      productReference: id(30),
      productAggregateVersion: 2,
      productVersionReference: id(31),
      productSnapshotDigest: hash,
      binding: {
        bindingReference: id(22),
        optionSetReference: id(32),
        optionSetVersionReference: id(33),
        purpose: "EXTRAS",
        sortOrder: 0,
        enabledOptionReferences: [id(23)],
        defaultSelections: [],
        minimumSelectionOverride: null,
        maximumSelectionOverride: null,
        includedSkuReferences: [],
        excludedSkuReferences: [],
        channelCodes: [],
        storeOverrideAllowed: false,
      },
      versionResolution: "CurrentPublished",
      optionReference: id(23),
      optionSetReference: id(32),
      optionSetVersionReference: id(33),
      optionSourceDigest: hash,
      optionSourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      choices: [
        {
          optionReference: id(23),
          stableCode: "CHOICE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic choice" },
        },
      ],
      skus: [
        {
          skuReference: id(35),
          skuCode: "SYNTH",
          lifecycle: "Active",
          localizedNames: { "fr-CA": "Article synthétique" },
        },
      ],
      currencyMetadata: currency,
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      observedAt: at,
      validUntil: until,
    },
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const fetcher = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => response(body, status));
const prepare = (f: typeof fetch) =>
  createOptionPriceAuthoringClient(f).prepare({
    command: command(),
    context: anchor,
    expectedScope: scope,
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.useRealTimers();
});
it("reads the actual scoped Choice, complete states, decimal wire and independently localized SKU", async () => {
  const f = fetcher(current()),
    view = await createOptionPriceAuthoringClient(f).query({
      context: selection,
      expectedScope: scope,
      csrf,
    });
  expect(view.states[0]?.latestVersion.unitAmount.amountMinor).toBe("9223372036854775807");
  expect(view.context.skus[0]?.localizedNames).toEqual({ "fr-CA": "Article synthétique" });
  expect(view.context.referenceEligibility).toBe("NotEvaluated");
  expect(f).toHaveBeenCalledWith(
    "/merchant/pricing/option-prices/current",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      body: JSON.stringify({ context: selection }),
    }),
  );
  const headers = new Headers(f.mock.calls[0]?.[1]?.headers);
  expect(JSON.parse(atob(headers.get("X-BOP-Catalog-Scope") ?? ""))).toEqual({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  expect(headers.get("X-BOP-CSRF")).toBe(csrf);
});
it("discovers the authenticated full scope from an initial Brand/Store read without putting Tenant or Actor in the header", async () => {
  const initialScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    f = fetcher(current()),
    result = await createOptionPriceAuthoringClient(f).query({
      context: selection,
      expectedScope: initialScope,
      csrf,
    });
  expect(result.tenantReference).toBe(scope.tenantReference);
  expect(result.actorReference).toBe(scope.actorReference);
  expect(result.context.tenantReference).toBe(scope.tenantReference);
  expect(result.context.actorReference).toBe(scope.actorReference);
  expect(result.states).toHaveLength(1);
  const headers = new Headers(f.mock.calls[0]?.[1]?.headers);
  expect(JSON.parse(atob(headers.get("X-BOP-Catalog-Scope") ?? ""))).toEqual(initialScope);
  // The newly discovered scope can prepare an intent; the two-field anchor cannot.
  const client = createOptionPriceAuthoringClient(f);
  expect(() =>
    client.prepare({ command: command(), context: anchor, expectedScope: initialScope }),
  ).toThrow(OptionPriceAuthoringClientError);
  expect(() =>
    client.prepare({
      command: command(),
      context: anchor,
      expectedScope: {
        tenantReference: result.tenantReference,
        brandReference: result.brandReference,
        storeReference: result.storeReference,
        actorReference: result.actorReference,
      },
    }),
  ).not.toThrow();
});
it.each([
  { brandReference: scope.brandReference },
  {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    actorReference: scope.actorReference,
  },
  { brandReference: scope.brandReference, storeReference: scope.storeReference, extra: true },
  { brandReference: scope.brandReference, storeReference: "not-a-reference" },
])("refuses partial or nonclosed initial query scope before HTTP %#", async (expectedScope) => {
  const f = fetcher(current());
  await expect(
    createOptionPriceAuthoringClient(f).query({ context: selection, expectedScope, csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
});
it("requires the context full scope to agree with the discovered response header", async () => {
  const value = current();
  value.context.actorReference = id(90);
  await expect(
    createOptionPriceAuthoringClient(fetcher(value)).query({
      context: selection,
      expectedScope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
      csrf,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it.each(["brandReference", "storeReference"] as const)(
  "rejects discovered %s drift against the initial anchor",
  async (field) => {
    const value = current();
    value[field] = id(90);
    await expect(
      createOptionPriceAuthoringClient(fetcher(value)).query({
        context: selection,
        expectedScope: {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        },
        csrf,
      }),
    ).rejects.toMatchObject({ code: "ScopeChanged" });
  },
);
it("rejects an initial scope anchor changed while the actual query is in flight", async () => {
  const expectedScope = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    f = fetcher(current());
  f.mockImplementationOnce(async () => {
    expectedScope.storeReference = id(90);
    return new Response(JSON.stringify(current()), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  });
  await expect(
    createOptionPriceAuthoringClient(f).query({ context: selection, expectedScope, csrf }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("accepts actual Pinned source classification without silently upgrading the saved version", async () => {
  const v = current();
  v.context.versionResolution = "Pinned";
  v.context.optionSourceAuthority = "RecordedFrozen";
  const result = await createOptionPriceAuthoringClient(fetcher(v)).query({
    context: selection,
    expectedScope: scope,
    csrf,
  });
  expect(result.context.optionSetVersionReference).toBe(id(33));
  expect(result.context.versionResolution).toBe("Pinned");
});
it("retains the exact detached command, context and operation across explicit retries", async () => {
  const f = fetcher(receipt()),
    original = command(),
    qualifier = { ...anchor },
    p = createOptionPriceAuthoringClient(f).prepare({
      command: original,
      context: qualifier,
      expectedScope: scope,
    });
  original.content.unitAmountMinor = "5";
  qualifier.expectedProductAggregateVersion = 99;
  const result = await p.execute({ csrf });
  expect(p.pending).toBe(false);
  expect(result.state?.latestVersion.unitAmount.amountMinor).toBe("9223372036854775807");
  await p.execute({ csrf });
  expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
    command: command(),
    context: anchor,
  });
  expect(Object.isFrozen(p.command.content)).toBe(true);
});
it.each([
  ["Denied", 403, "request_denied"],
  ["Conflict", 409, "option_price_conflict"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Invalid", 400, "option_price_invalid"],
] as const)(
  "a first definitive %s refuses mutation without inventing a pending receipt",
  async (code, status, error) => {
    const p = prepare(fetcher({ error }, status));
    await expect(p.execute({ csrf })).rejects.toMatchObject({ code });
    expect(p.pending).toBe(false);
  },
);
it.each([
  ["Denied", 403, "request_denied"],
  ["Conflict", 409, "option_price_conflict"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Invalid", 400, "option_price_invalid"],
  ["Unavailable", 503, "option_price_unavailable"],
] as const)(
  "an unknown original remains pending after later %s",
  async (attemptCode, status, error) => {
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce(response({ error }, status))
      .mockResolvedValueOnce(response(receipt()));
    const p = prepare(f);
    await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(p.pending).toBe(true);
    await expect(p.execute({ csrf })).rejects.toMatchObject({
      code: "OutcomeUnknown",
      attemptCode,
    });
    expect(p.pending).toBe(true);
    const resolved = await p.resolve({ csrf });
    expect(resolved.outcome).toBe("Committed");
    expect(p.pending).toBe(false);
    expect(f.mock.calls[0]?.[1]?.body).toBe(f.mock.calls[1]?.[1]?.body);
    expect(f.mock.calls[2]?.[0]).toBe("/merchant/pricing/option-prices/resolve");
    expect(JSON.parse(String(f.mock.calls[2]?.[1]?.body))).toEqual({ command: command() });
  },
);
it("only actual original Abandoned clears unknown without a business state", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(response({ ...receipt(), outcome: "Abandoned", state: null })),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect((await p.resolve({ csrf })).outcome).toBe("Abandoned");
  expect(p.pending).toBe(false);
});
it.each([
  {
    name: "wrong operation",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, operationReference: id(90) }),
  },
  {
    name: "wrong Actor",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, actorReference: id(90) }),
  },
  {
    name: "fake absence",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, outcome: "Abandoned" }),
  },
  {
    name: "changed root",
    change: (v: ReturnType<typeof receipt>) => ({
      ...v,
      state: { ...v.state, aggregateVersion: 2 },
    }),
  },
  {
    name: "numeric minor amount",
    change: (v: ReturnType<typeof receipt>) => ({
      ...v,
      state: {
        ...v.state,
        latestVersion: {
          ...v.state.latestVersion,
          unitAmount: { amountMinor: 125, currencyCode: "CAD" },
        },
      },
    }),
  },
  {
    name: "changed content",
    change: (v: ReturnType<typeof receipt>) => ({
      ...v,
      state: { ...v.state, latestVersion: { ...v.state.latestVersion, includedQuantity: 2 } },
    }),
  },
  {
    name: "unbounded lease",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, validUntil: "2026-10-05T12:00:06.000Z" }),
  },
  {
    name: "foreign extra fields",
    change: (v: ReturnType<typeof receipt>) => ({ ...v, policyEvidence: "private" }),
  },
])("malformed $name cannot settle or replace an original", async ({ change }) => {
  const p = prepare(fetcher(change(receipt())));
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
it.each([
  {
    name: "missing enabled choice",
    change: (v: ReturnType<typeof current>) => ({ ...v, context: { ...v.context, choices: [] } }),
  },
  {
    name: "silent version upgrade",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      context: { ...v.context, optionSetVersionReference: id(90) },
    }),
  },
  {
    name: "current classified as Frozen",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      context: { ...v.context, optionSourceAuthority: "RecordedFrozen" },
    }),
  },
  {
    name: "duplicate state roots",
    change: (v: ReturnType<typeof current>) => ({ ...v, states: [v.states[0], v.states[0]] }),
  },
  {
    name: "foreign binding state",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      states: [{ ...state(), bindingReference: id(90) }],
    }),
  },
  {
    name: "invalid currency exponent",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      context: { ...v.context, currencyMetadata: { ...currency, minorUnitExponent: 7 } },
    }),
  },
  {
    name: "claimed sale qualification",
    change: (v: ReturnType<typeof current>) => ({
      ...v,
      context: { ...v.context, referenceEligibility: "Pass" },
    }),
  },
])("rejects query $name instead of returning an empty qualified view", async ({ change }) => {
  await expect(
    createOptionPriceAuthoringClient(fetcher(change(current()))).query({
      context: selection,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("scope changes block retry but retain the unknown original and exclude cross-scope HTTP", async () => {
  const f = vi.fn<typeof fetch>().mockRejectedValue(new Error()),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(
    p.resolve({ csrf, scope: { ...scope, actorReference: id(90) } }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(p.pending).toBe(true);
  expect(f).toHaveBeenCalledTimes(1);
});
it("query cross-scope response is explicit ScopeChanged", async () => {
  await expect(
    createOptionPriceAuthoringClient(fetcher({ ...current(), actorReference: id(90) })).query({
      context: selection,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("checks the supplied Tenant as well as Actor when the initial query already has full scope", async () => {
  await expect(
    createOptionPriceAuthoringClient(fetcher({ ...current(), tenantReference: id(90) })).query({
      context: selection,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("an expired query is Stale while an expired receipt cannot settle a sent command", async () => {
  vi.setSystemTime(until);
  await expect(
    createOptionPriceAuthoringClient(fetcher(current())).query({
      context: selection,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Stale" });
  const p = prepare(fetcher(receipt()));
  await expect(p.execute({ csrf })).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Stale",
  });
  expect(p.pending).toBe(true);
});
it("rejects accessors, sparse arrays and unknown command keys without invoking getters or transport", () => {
  let calls = 0;
  const candidate = command();
  Object.defineProperty(candidate, "action", {
    enumerable: true,
    get() {
      calls++;
      return "CreateDraft";
    },
  });
  expect(() => parseOptionPriceAuthoringCommand(candidate)).toThrow(
    OptionPriceAuthoringClientError,
  );
  expect(calls).toBe(0);
  expect(() => parseOptionPriceAuthoringCommand({ ...command(), actorReference: id(4) })).toThrow(
    OptionPriceAuthoringClientError,
  );
  expect(() =>
    parseOptionPriceAuthoringCommand({
      ...command(),
      content: { ...command().content, unitAmountMinor: "01" },
    }),
  ).toThrow(OptionPriceAuthoringClientError);
});
it("refuses malformed caller selection and CSRF without posting", async () => {
  const f = fetcher(current()),
    client = createOptionPriceAuthoringClient(f);
  await expect(
    client.query({ context: { ...selection, optionReference: null }, expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(prepare(f).execute({ csrf: "bad" })).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
});
it("a response missing no-store remains unknown and never echoes private transport details", async () => {
  const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(receipt()), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
    p = prepare(f);
  const error = await p.execute({ csrf }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "OutcomeUnknown" });
  expect(String(error)).not.toContain(id(20));
  expect(p.pending).toBe(true);
});
it("an abort after dispatch retains uncertainty; later resolution is still original-only", async () => {
  const controller = new AbortController(),
    f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = prepare(f),
    sent = p.execute({ csrf, signal: controller.signal });
  controller.abort();
  await expect(sent).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
  expect(f.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("bounded timeout also settles an uncooperative fetch without unlocking the mutation", async () => {
  const f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = prepare(f),
    sent = p.execute({ csrf });
  const checked = expect(sent).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await vi.advanceTimersByTimeAsync(15000);
  await checked;
  expect(p.pending).toBe(true);
});
it("rejects reentry while a mutation is unresolved", async () => {
  const controller = new AbortController(),
    f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    p = prepare(f),
    sent = p.execute({ csrf, signal: controller.signal });
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(f).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(sent).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it("bounded response streaming cancels oversized output and leaves the original pending", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8388609));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }),
    ),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
  expect(cancelled).toBe(true);
});
it.each(["ReplaceDraft", "Publish", "Archive"] as const)(
  "validates genuine public %s materialization and its exact retained command",
  async (action) => {
    let prior = parseOptionPriceAuthoringState(state());
    function advance(
      selectedAction: "ReplaceDraft" | "Publish" | "Archive",
      operation: number,
      versionId: number,
    ) {
      const c = owningCommand({
        ...command(),
        action: selectedAction,
        operationReference: id(operation),
        expectedAggregateVersion: prior.aggregateVersion,
        bindingReference: null,
        optionReference: null,
        content:
          selectedAction === "ReplaceDraft"
            ? { ...command().content, unitAmountMinor: "125" }
            : null,
      });
      const version = materializeOptionPriceVersion({
        command: c,
        current: prior,
        brandReference: scope.brandReference,
        versionReference: id(versionId),
        occurredAt: at,
        currencyMetadata: currency,
      });
      prior = parseOptionPriceAuthoringState({
        ...optionPriceWireState(prior),
        aggregateVersion: prior.aggregateVersion + 1,
        updatedAt: at,
        draftAuthorActorReference: selectedAction === "ReplaceDraft" ? scope.actorReference : null,
        draft: selectedAction === "ReplaceDraft" ? optionPriceWireSnapshot(version) : null,
        currentPublished:
          selectedAction === "Publish"
            ? optionPriceWireSnapshot(version)
            : selectedAction === "Archive"
              ? null
              : prior.currentPublished === null
                ? null
                : optionPriceWireSnapshot(prior.currentPublished),
        latestVersion: optionPriceWireSnapshot(version),
      });
      return c;
    }
    if (action === "Archive") advance("Publish", 40, 41);
    const c = advance(action, 42, 43),
      f = fetcher({
        ...receipt(),
        action,
        operationReference: c.operationReference,
        state: optionPriceWireState(prior),
      }),
      p = createOptionPriceAuthoringClient(f).prepare({
        command: c,
        context: anchor,
        expectedScope: scope,
      });
    expect((await p.execute({ csrf })).state?.latestVersion.lifecycle).toBe(
      action === "Publish" ? "Published" : action === "Archive" ? "Archived" : "Draft",
    );
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({ command: c, context: anchor });
    expect(p.pending).toBe(false);
  },
);
it("a syntactically valid snapshot hash must equal the actual complete canonical wire", async () => {
  const v = current();
  v.states[0] = state();
  const first = v.states[0];
  if (!first) throw new Error("fixture state required");
  v.states[0] = {
    ...first,
    latestVersion: {
      ...first.latestVersion,
      snapshotDigest: parsePricingDigest("sha256:" + "b".repeat(64)),
    },
  };
  await expect(
    createOptionPriceAuthoringClient(fetcher(v)).query({
      context: selection,
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("unknown errors with spoofed conflict fields cannot manufacture a definitive refusal", async () => {
  const p = prepare(fetcher({ error: "option_price_conflict", secret: "private" }, 409));
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
it("a pre-dispatch abort sends nothing and cannot manufacture unknown mutation", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fetcher(receipt()),
    p = prepare(f);
  await expect(p.execute({ csrf, signal: controller.signal })).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(p.pending).toBe(false);
  expect(f).not.toHaveBeenCalled();
});
it("a scope mutated during the actual response cannot admit the old reply", async () => {
  const changed = { ...scope };
  const f = vi.fn<typeof fetch>(async () => {
      changed.actorReference = id(90);
      return response(receipt());
    }),
    p = prepare(f);
  await expect(p.execute({ csrf, scope: changed })).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "ScopeChanged",
  });
  expect(p.pending).toBe(true);
});
it("dense arrays and safe immutable records reject caller aliasing before preparing intent", () => {
  const sparse: string[] = [];
  sparse.length = 1;
  expect(() =>
    createOptionPriceAuthoringClient(fetcher(receipt())).prepare({
      command: { ...command(), content: { ...command().content, unitAmountMinor: sparse } },
      context: anchor,
      expectedScope: scope,
    }),
  ).toThrow(OptionPriceAuthoringClientError);
});
it.each([
  ["Denied", 403, "request_denied"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Conflict", 409, "option_price_conflict"],
  ["Invalid", 400, "option_price_invalid"],
  ["Unavailable", 503, "option_price_unavailable"],
] as const)(
  "query reports finite %s without inventing an empty current source",
  async (code, status, error) => {
    await expect(
      createOptionPriceAuthoringClient(fetcher({ error }, status)).query({
        context: selection,
        expectedScope: scope,
        csrf,
      }),
    ).rejects.toMatchObject({ code });
  },
);
it("later malformed resolution cannot clear the first unknown original", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(response({ ...receipt(), state: null })),
    p = prepare(f);
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(p.resolve({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(p.pending).toBe(true);
});
function actualScope() {
  return { profile: "MerchantOptionPriceScopeV1", ...scope, observedAt: at, validUntil: until };
}
it.each(["BrandStore", "Full"] as const)(
  "reads genuine scope from %s expectation without any Product or Choice request",
  async (kind) => {
    const expectedScope =
        kind === "Full"
          ? scope
          : { brandReference: scope.brandReference, storeReference: scope.storeReference },
      f = fetcher(actualScope()),
      result = await createOptionPriceAuthoringClient(f).scope({ expectedScope, csrf });
    expect(result).toEqual(actualScope());
    expect(f.mock.calls[0]?.[0]).toBe("/merchant/pricing/option-prices/scope");
    expect(f.mock.calls[0]?.[1]?.body).toBe("{}");
    expect(f.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  },
);
it.each([
  { ...scope, actorReference: id(90) },
  { brandReference: id(90), storeReference: scope.storeReference },
])(
  "scope refuses actual identity drift without resolving a pending original",
  async (expectedScope) => {
    await expect(
      createOptionPriceAuthoringClient(fetcher(actualScope())).scope({ expectedScope, csrf }),
    ).rejects.toMatchObject({ code: "ScopeChanged" });
  },
);
it("scope succeeds after unavailable binding but never settles the pending command", async () => {
  const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(response(actualScope())),
    client = createOptionPriceAuthoringClient(f),
    p = client.prepare({ command: command(), context: anchor, expectedScope: scope });
  await expect(p.execute({ csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const result = await client.scope({
    expectedScope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
    csrf,
  });
  expect(result.actorReference).toBe(scope.actorReference);
  expect(p.pending).toBe(true);
});
it.each([
  { ...actualScope(), profile: "FakeScope" },
  { ...actualScope(), actorReference: "invalid" },
  { ...actualScope(), validUntil: at },
  { ...actualScope(), context: selection },
])("scope refuses malformed sources instead of inventing current identity", async (value) => {
  await expect(
    createOptionPriceAuthoringClient(fetcher(value)).scope({ expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([
  ["Denied", 403, "request_denied"],
  ["FeatureDisabled", 409, "option_price_feature_disabled"],
  ["Unavailable", 503, "option_price_unavailable"],
] as const)("scope preserves finite %s", async (code, status, error) => {
  await expect(
    createOptionPriceAuthoringClient(fetcher({ error }, status)).scope({
      expectedScope: scope,
      csrf,
    }),
  ).rejects.toMatchObject({ code });
});
it("scope retains response lease expiry and external abort", async () => {
  vi.setSystemTime(until);
  await expect(
    createOptionPriceAuthoringClient(fetcher(actualScope())).scope({ expectedScope: scope, csrf }),
  ).rejects.toMatchObject({ code: "Stale" });
  vi.setSystemTime(at);
  const controller = new AbortController(),
    f = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    read = createOptionPriceAuthoringClient(f).scope({
      expectedScope: scope,
      csrf,
      signal: controller.signal,
    });
  controller.abort();
  await expect(read).rejects.toMatchObject({ code: "Unavailable" });
});
it("scope rejects malformed caller envelopes and suppresses changed selection during response", async () => {
  const f = fetcher(actualScope()),
    client = createOptionPriceAuthoringClient(f);
  await expect(
    client.scope({ expectedScope: { ...scope, extra: true }, csrf }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f).not.toHaveBeenCalled();
  const changed = { brandReference: scope.brandReference, storeReference: scope.storeReference },
    g = vi.fn<typeof fetch>(async () => {
      changed.storeReference = id(90);
      return response(actualScope());
    });
  await expect(
    createOptionPriceAuthoringClient(g).scope({ expectedScope: changed, csrf }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
});

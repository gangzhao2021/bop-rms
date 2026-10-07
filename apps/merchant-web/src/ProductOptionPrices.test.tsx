import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProductOptionPrices,
  optionPriceFormContent,
  optionPriceEmptyFields,
  dispatchOptionPriceOriginal,
  discoverOptionPriceOriginals,
  OptionPriceRecoveryList,
} from "./ProductOptionPrices.js";
import {
  createOptionPriceAuthoringClient,
  OptionPriceAuthoringClientError,
} from "./option-price-authoring-client.js";
import {
  parseOptionPricePendingOriginal,
  type OptionPricePendingJournal,
  type OptionPricePendingOriginal,
} from "./option-price-pending-journal.js";
import { parseProductVersion } from "./catalog-product-command-values.js";
import {
  createCurrencyMetadataSnapshot,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  optionPriceWireState,
  parseCurrencyCode,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  parsePricingDigest,
  parsePricingReference,
} from "../../../packages/rms/pricing/src/index.js";
// Controlled durable storage and public wire fixtures; no native IAM or database claim.
const id = (n: number) =>
  parsePricingReference(`01902421-7990-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const fields = { ...optionPriceEmptyFields, amount: "9007199254740993", quantity: "0", from: at };
function command() {
  return {
    action: "CreateDraft",
    operationReference: id(20),
    ruleReference: id(21),
    expectedAggregateVersion: null,
    bindingReference: id(22),
    optionReference: id(23),
    content: optionPriceFormContent(fields, scope.storeReference),
  };
}
function prepared(fetcher: typeof fetch) {
  return createOptionPriceAuthoringClient(fetcher).prepare({
    command: command(),
    context: { productReference: id(30), expectedProductAggregateVersion: 2 },
    expectedScope: scope,
  });
}
function receipt() {
  const metadata = createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode("CAD"),
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: id(8),
    metadataDigest: parsePricingDigest(`sha256:${"a".repeat(64)}`),
  });
  const version = materializeOptionPriceVersion({
    command: parseOptionPriceAuthoringCommand(command()),
    current: null,
    brandReference: scope.brandReference,
    versionReference: id(24),
    occurredAt: at,
    currencyMetadata: metadata,
  });
  const state = optionPriceWireState(
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
  );
  return {
    profile: "MerchantOptionPriceAuthoringResultV1",
    action: "CreateDraft",
    operationReference: id(20),
    ...scope,
    outcome: "Committed",
    state,
    occurredAt: at,
    observedAt: at,
    validUntil: until,
  };
}
function cursor(p: ReturnType<typeof prepared>): OptionPricePendingOriginal {
  return parseOptionPricePendingOriginal({
    profile: "OptionPricePendingOriginalV1",
    kind: "Authoring",
    scope: p.scope,
    command: p.command,
    context: p.context,
  });
}
function storage() {
  let original: OptionPricePendingOriginal | null = null;
  const journal: OptionPricePendingJournal = {
    load: vi.fn(async () => original),
    reserve: vi.fn(async (value) => {
      if (original && JSON.stringify(original) !== JSON.stringify(value)) throw new Error();
      original = value;
    }),
    complete: vi.fn(async (value) => {
      if (JSON.stringify(original) !== JSON.stringify(value)) throw new Error();
      original = null;
    }),
  };
  return journal;
}
it("renders the contextual saved Binding entry without claiming a current price or root authority from SKUs", () => {
  const draft = parseProductVersion({
    versionReference: id(31),
    baseVersionReference: null,
    status: "Draft",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic saved Product" },
    taxClassificationReference: null,
    createdAt: at,
    updatedAt: at,
    skus: [],
    optionBindings: [
      {
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
    ],
  });
  const markup = renderToStaticMarkup(
    <ProductOptionPrices
      entry={{
        tenantReference: id(1),
        revision: 2,
        internalCode: "SYNTHETIC",
        productType: "PreparedFood",
        lifecycle: "Draft",
        draft,
        content: null,
        observedAt: at,
        validUntil: until,
      }}
      productReference={id(30)}
      storeReference={scope.storeReference}
      csrf={csrf}
    />,
  );
  expect(markup).toContain("Saved price binding");
  expect(markup).toContain("Binding 1 · EXTRAS");
  expect(markup).toContain("Saved price option choice");
  expect(markup).not.toContain("Current Published:");
  expect(markup).not.toContain("Current Draft:");
  expect(markup).not.toContain("<form");
});
it("requires an actual saved Product before displaying price controls", () => {
  const markup = renderToStaticMarkup(
    <ProductOptionPrices
      entry={null}
      productReference={id(30)}
      storeReference={scope.storeReference}
      csrf={csrf}
    />,
  );
  expect(markup).toContain("Read the saved Product");
  expect(markup).not.toContain("Saved price binding");
});
it("keeps exact minor-unit strings beyond Number precision and explicitly chooses UTC/selected Store", () => {
  expect(optionPriceFormContent({ ...fields, scope: "Store" }, scope.storeReference)).toEqual({
    skuReference: null,
    scopeKind: "Store",
    scopeReference: scope.storeReference,
    channelCode: null,
    orderType: null,
    unitAmountMinor: "9007199254740993",
    includedQuantity: 0,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  });
});
it.each([
  { amount: "1.2" },
  { amount: "9223372036854775808" },
  { quantity: "-1" },
  { quantity: "2147483648" },
  { quantity: "" },
  { from: "2026-02-30T12:00:00.000Z" },
  { from: "2026-10-05T12:00:00Z" },
  { scope: "Region" },
])("does not coerce invalid local input into a saved price %#", (change) => {
  expect(() => optionPriceFormContent({ ...fields, ...change }, scope.storeReference)).toThrow(
    OptionPriceAuthoringClientError,
  );
});
it("reserves the original before real transport and completes only the matching terminal", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const journal = storage(),
      f = vi.fn<typeof fetch>(async () => {
        expect(await journal.load()).toEqual(original);
        return new Response(JSON.stringify(receipt()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }),
      p = prepared(f),
      original = cursor(p);
    await dispatchOptionPriceOriginal(journal, original, () => p.execute({ csrf }));
    expect(await journal.load()).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
it("retains unknown originals across reload, resolving the exact immutable body without allocating a replacement", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const journal = storage(),
      f = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("controlled transport loss"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(receipt()), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }),
        ),
      p = prepared(f),
      original = cursor(p);
    await expect(
      dispatchOptionPriceOriginal(journal, original, () => p.execute({ csrf })),
    ).rejects.toMatchObject({ code: "OutcomeUnknown" });
    const restored = await journal.load();
    if (!restored) throw new Error("Expected retained original");
    expect(restored).toEqual(original);
    const reloaded = createOptionPriceAuthoringClient(f).prepare({
      command: restored.command,
      context: restored.context,
      expectedScope: restored.scope,
    });
    await reloaded.resolve({ csrf, scope: restored.scope });
    await journal.complete(restored);
    expect(await journal.load()).toBeNull();
    expect(f.mock.calls[1]?.[0]).toBe("/merchant/pricing/option-prices/resolve");
    expect(JSON.parse(String(f.mock.calls[1]?.[1]?.body))).toEqual({ command: original.command });
  } finally {
    clock.mockRestore();
  }
});
it("blocks dispatch on journal failure and retains the exact original after cleanup failure", async () => {
  const journal = storage(),
    p = prepared(vi.fn<typeof fetch>()),
    original = cursor(p),
    dispatch = vi.fn(async () => ({ outcome: "Committed" }));
  const failing: OptionPricePendingJournal = {
    ...journal,
    reserve: async () => {
      throw new Error();
    },
  };
  await expect(dispatchOptionPriceOriginal(failing, original, dispatch)).rejects.toBeDefined();
  expect(dispatch).not.toHaveBeenCalled();
  const failedCleanup: OptionPricePendingJournal = {
    ...journal,
    complete: async () => {
      throw new Error();
    },
  };
  await expect(
    dispatchOptionPriceOriginal(failedCleanup, original, dispatch),
  ).rejects.toBeDefined();
  expect(await journal.load()).toEqual(original);
});
it("a current fine denial never creates a positive terminal or clears the retained recovery original", async () => {
  const journal = storage(),
    f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "request_denied" }), {
          status: 403,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    ),
    p = prepared(f),
    original = cursor(p);
  await expect(
    dispatchOptionPriceOriginal(journal, original, () => p.execute({ csrf })),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(await journal.load()).toEqual(original);
});

it("discovers removed-Binding originals using the genuine scope endpoint before any semantic source read", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            profile: "MerchantOptionPriceScopeV1",
            ...scope,
            observedAt: at,
            validUntil: until,
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        ),
    );
    const p = prepared(f),
      original = cursor(p),
      journal = storage();
    const discoveryFactory = vi.fn(
      (
        actual: Parameters<
          typeof import("./option-price-pending-journal.js").createOptionPricePendingDiscovery
        >[0],
      ) => {
        expect(actual).toEqual({ ...scope, productReference: id(30) });
        return {
          load: async () => [{ bindingReference: id(22), optionReference: id(23), original }],
        };
      },
    );
    const result = await discoverOptionPriceOriginals(
      createOptionPriceAuthoringClient(f),
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        productReference: id(30),
        csrf,
        signal: new AbortController().signal,
      },
      discoveryFactory,
      () => journal,
    );
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[0]).toBe("/merchant/pricing/option-prices/scope");
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(result.originals[0]?.cursor).toEqual(original);
    expect(result.originals[0]?.journal).toBe(journal);
  } finally {
    clock.mockRestore();
  }
});
it("uses the actual current Actor for discovery rather than a cached original Actor", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const actualScope = { ...scope, actorReference: id(90) },
      f = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              profile: "MerchantOptionPriceScopeV1",
              ...actualScope,
              observedAt: at,
              validUntil: until,
            }),
            { headers: { "content-type": "application/json", "cache-control": "no-store" } },
          ),
      );
    const discoveryFactory = vi.fn(
      (
        actual: Parameters<
          typeof import("./option-price-pending-journal.js").createOptionPricePendingDiscovery
        >[0],
      ) => {
        expect(actual.actorReference).toBe(id(90));
        return { load: async () => [] };
      },
    );
    const result = await discoverOptionPriceOriginals(
      createOptionPriceAuthoringClient(f),
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        productReference: id(30),
        csrf,
        signal: new AbortController().signal,
      },
      discoveryFactory,
    );
    expect(result.originals).toEqual([]);
    expect(discoveryFactory).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
it("does not inspect persisted originals when current scope permission is denied", async () => {
  const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "request_denied" }), {
          status: 403,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    ),
    discoveryFactory = vi.fn(() => ({ load: async () => [] }));
  await expect(
    discoverOptionPriceOriginals(
      createOptionPriceAuthoringClient(f),
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        productReference: id(30),
        csrf,
        signal: new AbortController().signal,
      },
      discoveryFactory,
    ),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(discoveryFactory).not.toHaveBeenCalled();
});
it("does not turn discovery failure or scope expiry during IDB work into a ready empty journal", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            profile: "MerchantOptionPriceScopeV1",
            ...scope,
            observedAt: at,
            validUntil: until,
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        ),
    );
    const input = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      productReference: id(30),
      csrf,
      signal: new AbortController().signal,
    };
    await expect(
      discoverOptionPriceOriginals(createOptionPriceAuthoringClient(f), input, () => ({
        load: async () => {
          throw new Error();
        },
      })),
    ).rejects.toThrow("RecoveryUnavailable");
    await expect(
      discoverOptionPriceOriginals(createOptionPriceAuthoringClient(f), input, () => ({
        load: async () => {
          clock.mockReturnValue(Date.parse(until));
          return [];
        },
      })),
    ).rejects.toMatchObject({ code: "Stale" });
  } finally {
    clock.mockRestore();
  }
});
it("renders all discovered originals as explicit separate Resolve choices without silently choosing or deleting one", () => {
  const journal = storage(),
    p = prepared(vi.fn<typeof fetch>()),
    first = cursor(p),
    second = parseOptionPricePendingOriginal({
      ...first,
      command: { ...first.command, operationReference: id(90) },
    }),
    resolve = vi.fn();
  const markup = renderToStaticMarkup(
    <OptionPriceRecoveryList
      originals={[
        { cursor: first, journal },
        { cursor: second, journal },
      ]}
      busy={false}
      onResolve={resolve}
    />,
  );
  expect(markup).toContain("Resolve original price operation 1");
  expect(markup).toContain("Resolve original price operation 2");
  expect(markup).not.toContain(first.command.operationReference);
  expect(resolve).not.toHaveBeenCalled();
});

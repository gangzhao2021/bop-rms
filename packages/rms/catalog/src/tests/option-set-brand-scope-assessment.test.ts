import { expect, it, vi } from "vitest";
import {
  assessCatalogOptionSetBrandScope as assess,
  parseCatalogOptionSetEditorContent,
  evaluateCatalogOptionSetRuleSatisfiability,
} from "../index.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-30T12:00:00.000Z",
  end = "2026-09-30T12:00:05.000Z";
function node(n = 1) {
  const set = id(n * 100),
    version = id(n * 100 + 1);
  const source = {
    optionSetReference: set,
    brandReference: id(2),
    internalCode: "SET_" + n,
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic set" } as Record<string, string>,
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 1,
      maximumSelection: 2,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: 2,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(n * 100 + 10),
          optionSetReference: set,
          brandReference: id(2),
          stableCode: "OPT",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic option" } as Record<string, string>,
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null as string | null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(n * 100 + 10),
        quantityRule: { minimumQuantity: 1, maximumQuantity: 2 },
        media: null as null | {
          mediaReference: string;
          assetReference: string;
          assetVersionReference: string;
          altText: Record<string, string>;
        },
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null as string | null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [
      {
        level: "Brand",
        reference: null,
        channelCodes: [] as string[],
        orderTypeCodes: [] as string[],
      },
    ],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null as null | {
        instant: string;
        localDateTime: string;
        utcOffsetMinutes: number;
      },
    },
  };
  return { source, details };
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("SYNTHETIC_FIXTURE_MISSING");
  return item;
}
function fixture(change?: (n: ReturnType<typeof node>) => void) {
  const n = node();
  change?.(n);
  const prepared = parseCatalogOptionSetEditorContent(n.source, n.details);
  const graph = {
    brandReference: id(2),
    rootOptionSetReference: n.source.optionSetReference,
    rootVersionReference: n.source.draft.versionReference,
    contents: [prepared.content],
  };
  const binding = {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: n.source.optionSetReference,
    versionReference: n.source.draft.versionReference,
    expectedAggregateVersion: 7,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    graphDigest: evaluateCatalogOptionSetRuleSatisfiability(graph).graphDigest,
    originalIntentDigest: "sha256:" + "a".repeat(64),
    observedAt: at,
    validUntil: end,
    activationAt: at,
  };
  const brand = {
    profile: "CatalogOptionSetBrandConstraintsV1",
    tenantReference: id(1),
    brandReference: id(2),
    brandVersion: 1,
    configurationVersionReference: id(4),
    contentDigest: "sha256:" + "b".repeat(64),
    currentPublicationReference: id(5),
    supportedLocales: ["en-CA"],
    effectiveFrom: at,
    effectiveUntil: null as string | null,
    originalIntentDigest: binding.originalIntentDigest,
    observedAt: at,
    validUntil: end,
  };
  const roster = {
    profile: "TenantStoreReferenceV1",
    brandReference: id(2),
    brandLifecycle: "Active",
    brandVersion: "1",
    generation: "1",
    referenceCount: "0",
    originalIntentDigest: binding.originalIntentDigest,
    observedAt: at,
    references: [] as {
      storeReference: string;
      lifecycle: string;
      version: string;
      createdAt: string;
      updatedAt: string;
    }[],
  };
  return { graph, binding, brand, roster, run: () => assess(graph, brand, roster, binding) };
}
it("assesses actual represented Brand scope without requiring a Store or claiming qualification", () => {
  const f = fixture(),
    result = f.run();
  expect(result.decision).toBe("PassForAssessedBrandStoreRules");
  expect(result.missingSources).toEqual([]);
  expect(result.sourceAuthority).toBe("NotEvaluated");
  expect(result.brandFieldRequirements).toBe("NotEvaluated");
  expect(result.publishValidation).toBe("Incomplete");
});
it("resolves Store selectors against the actual active sameBrand roster", () => {
  const f = fixture((n) => {
    n.details.scopeSet = [
      { level: "Store", reference: id(8), channelCodes: [], orderTypeCodes: [] },
    ] as unknown as typeof n.details.scopeSet;
  });
  expect(f.run().decision).toBe("HardError");
  f.roster.referenceCount = "1";
  f.roster.references = [
    { storeReference: id(8), lifecycle: "Active", version: "1", createdAt: at, updatedAt: at },
  ];
  expect(f.run().decision).toBe("PassForAssessedBrandStoreRules");
  first(f.roster.references).lifecycle = "Archived";
  expect(f.run().decision).toBe("HardError");
});
it.each(["Region", "StoreGroup", "Channel", "OrderType"])(
  "does not treat syntactically valid %s as registered topology",
  (level) => {
    const f = fixture((n) => {
      n.details.scopeSet = [
        {
          level,
          reference: level === "Channel" || level === "OrderType" ? "VALID_CODE" : id(8),
          channelCodes: level === "Channel" ? ["VALID_CODE"] : [],
          orderTypeCodes: level === "OrderType" ? ["VALID_CODE"] : [],
        },
      ] as unknown as typeof n.details.scopeSet;
    });
    expect(f.run().decision).toBe("Indeterminate");
    expect(f.run().missingSources.length).toBeGreaterThan(0);
  },
);
it("restricted channel/orderType lists require actual registration even on Brand scope", () => {
  const f = fixture((n) => {
    first(n.details.scopeSet).channelCodes = ["POS"];
    first(n.details.scopeSet).orderTypeCodes = ["PICKUP"];
  });
  expect(f.run().missingSources).toEqual(["ChannelRegistration", "OrderTypeStoreConfiguration"]);
  expect(f.run().decision).toBe("Indeterminate");
});
it("retains hard conflicts even when additional registrations are missing", () => {
  const f = fixture((n) => {
    first(n.details.scopeSet).channelCodes = ["POS"];
  });
  f.brand.supportedLocales = ["fr-CA"];
  expect(f.run().decision).toBe("HardError");
  expect(f.run().checks.find((c) => c.code === "SupportedLocales")?.outcome).toBe("HardError");
});
it.each(["inactiveBrand", "unsupportedOptionLocale", "unsupportedMediaAlt", "expiredActivation"])(
  "rejects real semantic %s",
  (cause) => {
    const f = fixture((n) => {
      if (cause === "unsupportedOptionLocale")
        first(n.source.draft.options).localizedNames["de-DE"] = "Unsupported";
      if (cause === "unsupportedMediaAlt")
        first(n.details.optionDetails).media = {
          mediaReference: id(20),
          assetReference: id(21),
          assetVersionReference: id(22),
          altText: { "en-CA": "Synthetic image", "de-DE": "Unsupported" },
        };
    });
    if (cause === "inactiveBrand") f.roster.brandLifecycle = "Archived";
    if (cause === "expiredActivation") {
      f.brand.effectiveUntil = "2026-09-30T12:00:01.000Z";
      f.binding.activationAt = f.brand.effectiveUntil;
      f.brand.validUntil = f.brand.effectiveUntil;
    }
    expect(f.run().decision).toBe("HardError");
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "originalIntentDigest",
  "sourceDigest",
  "graphDigest",
  "configurationDigest",
  "expectedAggregateVersion",
])("rejects substituted root binding %s", (field) => {
  const f = fixture();
  Object.assign(f.binding, { [field]: field === "expectedAggregateVersion" ? 8 : id(99) });
  expect(f.run).toThrow();
});
it("rejects source snapshot scope/version/deadline mismatches rather than silently narrowing identity", () => {
  const f = fixture();
  f.roster.brandVersion = "2";
  expect(f.run).toThrow();
  f.roster.brandVersion = "1";
  f.brand.validUntil = at;
  expect(f.run).toThrow();
});
it("does not execute source or nested getters", () => {
  const f = fixture(),
    getter = vi.fn(() => ["en-CA"]);
  Object.defineProperty(f.brand, "supportedLocales", { get: getter, enumerable: true });
  expect(f.run).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

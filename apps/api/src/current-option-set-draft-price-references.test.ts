import { beforeEach, expect, it, vi } from "vitest";
import { parseCatalogOptionSetEditorContent } from "@rms/catalog";
import { createCurrentOptionSetDraftPriceReferenceSource } from "./current-option-set-draft-price-references.js";
const state = vi.hoisted(() => ({
  body: undefined as unknown,
  pricing: undefined as unknown,
  mode: "Once",
  pricingCalls: 0,
  calls: 0,
  until: "2026-09-30T12:00:30.000Z",
  observed: "2026-09-30T12:00:00.000Z",
}));
vi.mock("@rms/catalog", async (original) => {
  const real = await original<typeof import("@rms/catalog")>();
  return {
    ...real,
    // Public owning-read protocol synthetic here; actual source/locks are checked by isolated SQL.
    createPostgresCurrentFullOptionSetDraftStore: (
      options: Parameters<typeof real.createPostgresCurrentFullOptionSetDraftStore>[0],
    ) => ({
      async readCurrent(input: { optionSetReference: string; expectedAggregateVersion: number }) {
        state.calls++;
        return options.transactions.run(async (tx) => {
          await options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            actorKind: "User",
            permission: "catalog.manage",
            action: "catalog.option_set.read",
            purposeCode: "CATALOG_OPTION_SET_DRAFT",
            requiredFields: ["internalCode", "optionDetails", "effectivePeriod"],
            optionSetReference: input.optionSetReference,
            content: state.body,
            observedAt: options.clock.now(),
          });
          return state.body;
        });
      },
    }),
  };
});
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  end = "2026-09-30T12:00:30.000Z";
function content(trigger = false, name = "Synthetic") {
  const source = {
    optionSetReference: id(100),
    brandReference: id(2),
    internalCode: "SYNTHETIC",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(101),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": name },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(110),
          optionSetReference: id(100),
          brandReference: id(2),
          stableCode: "OPTION",
          lifecycle: "Inactive",
          localizedNames: { "en-CA": "Synthetic" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: trigger ? id(200) : null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  };
  return parseCatalogOptionSetEditorContent(source, {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(110),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: { reference: id(4), versionReference: id(7) },
        consumption: null,
        triggeredOptionSetVersionReference: trigger ? id(201) : null,
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
  });
}

import {
  buildConfigurationReferenceSourceSnapshot,
  buildPriceBookReferenceSourceSnapshot,
  buildOptionPriceReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
} from "@rms/pricing";
vi.mock("@rms/pricing", async (original) => {
  const real = await original<typeof import("@rms/pricing")>();
  return {
    ...real,
    createPostgresConfigurationReferenceSourceStore: (
      options: Parameters<typeof real.createPostgresConfigurationReferenceSourceStore>[0],
    ) => ({
      async withCurrentSnapshot(
        request: Parameters<typeof real.parsePriceBookReferenceSourceRequest>[0],
        work: (v: unknown) => Promise<unknown>,
      ) {
        state.pricingCalls++;
        if (state.mode === "NoCall") return 1;
        return options.transactions.run(async (tx) => {
          await options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: options.tenantReference,
            request: real.parsePriceBookReferenceSourceRequest(request),
            requiredScope: "Brand",
            requiredPermissions: ["pricing.price-book.manage", "pricing.promotion.manage"],
            requiredFields: ["generation", "sourceDigests"],
            observedAt: options.clock.now(),
          });
          const result = await work(state.pricing);
          if (state.mode === "Twice") await work(state.pricing);
          if (state.mode === "LateDenial") throw new Error("synthetic late Pricing refusal");
          return state.mode === "WrongReturn" ? "synthetic different" : result;
        });
      },
    }),
  };
});
const pricingRequest = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(50),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
function fixture() {
  const p = content(),
    tx = { query: vi.fn(async () => ({ rows: [] })) };
  let clock = at;
  state.body = {
    content: p.content,
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
    observedAt: at,
    validUntil: end,
    referenceEligibility: "NotEvaluated",
  };
  const empty = { observedAt: at, references: [] };
  state.pricing = buildConfigurationReferenceSourceSnapshot(
    {
      generation: "0",
      priceBooks: buildPriceBookReferenceSourceSnapshot(empty, pricingRequest, at),
      optionPrices: buildOptionPriceReferenceSourceSnapshot(empty, pricingRequest, at),
      promotions: buildPromotionReferenceSourceSnapshot(empty, pricingRequest, at),
    },
    pricingRequest,
    at,
  );
  const hold = vi.fn(async (actual: unknown) => {
    expect(actual).toBe(tx);
  });
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => clock },
    readAuthority: {
      holdUntilTransactionCompletes: vi.fn(
        async (actual: unknown, input: { observedAt: string }) => {
          expect(actual).toBe(tx);
          return { observedAt: input.observedAt, validUntil: end };
        },
      ),
    },
    pricingAuthority: { holdUntilTransactionCompletes: hold },
    priceBookAuthority: { holdUntilTransactionCompletes: hold },
    optionPriceAuthority: { holdUntilTransactionCompletes: hold },
    promotionAuthority: { holdUntilTransactionCompletes: hold },
  };
  const input = {
    graphRequest: {
      optionSetReference: id(100),
      versionReference: id(101),
      expectedAggregateVersion: 1,
      sourceDigest: p.sourceDigest,
      contentDigest: p.contentDigest,
      configurationDigest: p.configurationDigest,
      observedAt: at,
      validUntil: end,
    },
    pricingRequest,
    activationAt: at,
  };
  return {
    provider: createCurrentOptionSetDraftPriceReferenceSource(options),
    tx,
    options,
    input,
    advance: (next: string) => {
      clock = next;
    },
  };
}
beforeEach(() => {
  Object.assign(state, { calls: 0, pricingCalls: 0, mode: "Once", until: end, observed: at });
});
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("derives pins from held actual-root protocol and uses full current Pricing metadata", async () => {
  const f = fixture(),
    r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(r.assessment.decision).toBe("HardError");
  expect(r.assessment.references[0]?.status).toBe("MissingRule");
  expect(r.validUntil).toBe("2026-09-30T12:00:05.000Z");
  expect(r.assessment.request.catalogIntentDigest).toBe(pricingRequest.catalogIntentDigest);
  expect(r.assessment.referenceEligibility).toBe("NotEvaluated");
  expect(state.calls).toBe(2);
  expect(state.pricingCalls).toBe(1);
  expect(Object.isFrozen(r)).toBe(true);
});
it.each(["NoCall", "Twice", "WrongReturn", "LateDenial"])(
  "Pricing protocol %s refuses",
  async (mode) => {
    const f = fixture();
    state.mode = mode;
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => 1),
    ).rejects.toThrowError(refused);
  },
);
it.each(["2026-09-30T12:00:05.000Z", "2026-09-30T11:59:59.999Z"])(
  "original freshness/backward %s refuses",
  async (next) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => {
        f.advance(next);
        return 1;
      }),
    ).rejects.toThrowError(refused);
  },
);
it("caught recursive failure poisons outer and future admissions", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentAssessment(f.tx, f.input, async () => {
      await expect(
        f.provider.withCurrentAssessment(f.tx, f.input, async () => 2),
      ).rejects.toThrowError(refused);
      return 1;
    }),
  ).rejects.toThrowError(refused);
  const before = state.calls;
  await expect(f.provider.withCurrentAssessment(f.tx, f.input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(state.calls).toBe(before);
});
it("captures clock/current authority methods and rejects query substitution", async () => {
  const f = fixture();
  f.options.clock.now = () => end;
  f.options.pricingAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw new Error("replaced object method");
  });
  await expect(f.provider.withCurrentAssessment(f.tx, f.input, async () => 1)).resolves.toBe(1);
  const g = fixture();
  await expect(
    g.provider.withCurrentAssessment(g.tx, g.input, async () => {
      g.tx.query = vi.fn(async () => ({ rows: [] }));
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it("late root read denial remains mandatory", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentAssessment(f.tx, f.input, async () => {
      f.options.readAuthority.holdUntilTransactionCompletes.mockImplementation(async () => {
        throw new Error("synthetic denial");
      });
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it.each(["brandReference", "actorReference"])(
  "foreign Pricing %s refused before acquisition",
  async (key) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentAssessment(
        f.tx,
        { ...f.input, pricingRequest: { ...f.input.pricingRequest, [key]: id(999) } },
        async () => 1,
      ),
    ).rejects.toThrowError(refused);
    expect(state.calls).toBe(0);
    expect(state.pricingCalls).toBe(0);
  },
);
it("client graph/mapping/Ready and getters are refused", async () => {
  for (const key of ["graph", "mapping", "Ready"]) {
    const f = fixture();
    await expect(
      f.provider.withCurrentAssessment(f.tx, { ...f.input, [key]: true }, async () => 1),
    ).rejects.toThrowError(refused);
  }
  const f = fixture(),
    getter = vi.fn(() => pricingRequest),
    input = { ...f.input };
  Object.defineProperty(input, "pricingRequest", { get: getter, enumerable: true });
  await expect(f.provider.withCurrentAssessment(f.tx, input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(getter).not.toHaveBeenCalled();
});

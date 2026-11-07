import { beforeEach, expect, it, vi } from "vitest";
import { parseCatalogOptionSetEditorContent } from "@rms/catalog";
import { createCurrentOptionSetDraftGraphSource } from "./current-option-set-draft-graph.js";
const state = vi.hoisted(() => ({
  body: undefined as unknown,
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
        pricingRule: null,
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
function fixture(trigger = false) {
  const p = content(trigger),
    tx = { query: vi.fn(async () => ({ rows: [] })) };
  let clock = at;
  const authority = {
    holdUntilTransactionCompletes: vi.fn(async (actualTx, input) => {
      expect(actualTx).toBe(tx);
      expect(input.permission).toBe("catalog.manage");
      expect(input.actorKind).toBe("User");
      expect(input.action).toBe("catalog.option_set.read");
      return { observedAt: input.observedAt, validUntil: end };
    }),
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => clock },
    authority,
  };
  state.body = {
    content: p.content,
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
    observedAt: state.observed,
    validUntil: state.until,
    referenceEligibility: "NotEvaluated",
  };
  const input = {
    optionSetReference: id(100),
    versionReference: id(101),
    expectedAggregateVersion: 1,
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
    observedAt: at,
    validUntil: end,
  };
  return {
    provider: createCurrentOptionSetDraftGraphSource(options),
    tx,
    options,
    input,
    advance: (to: string) => {
      clock = to;
    },
  };
}
beforeEach(() => {
  Object.assign(state, { calls: 0, until: end, observed: at });
});
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("derives held current singleton graph from owner only and verifies again after callback", async () => {
  const f = fixture(),
    work = vi.fn(async (source) => source);
  const r = await f.provider.withCurrentGraph(f.tx, f.input, work);
  expect(state.calls).toBe(2);
  expect(work).toHaveBeenCalledOnce();
  expect(f.options.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(r).toMatchObject({
    profile: "CurrentOptionSetDraftGraphV1",
    sourceAuthority: "CurrentDraftRootOnly",
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    originalObservedAt: at,
    observedAt: at,
    validUntil: end,
  });
  expect(r.graph.contents).toHaveLength(1);
  expect(r.graphDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(r.graph.contents)).toBe(true);
  expect(Object.isFrozen(r.graph.contents[0]?.sourceAggregate.draft)).toBe(true);
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("refuses unresolved exact trigger even disabled and optional rather than dropping child", async () => {
  const f = fixture(true),
    work = vi.fn(async () => 1);
  await expect(f.provider.withCurrentGraph(f.tx, f.input, work)).rejects.toThrowError(refused);
  expect(work).not.toHaveBeenCalled();
  expect(state.calls).toBe(1);
});
it.each(["sourceDigest", "contentDigest", "configurationDigest"])(
  "refuses stale pin %s before callback",
  async (key) => {
    const f = fixture(),
      work = vi.fn(async () => 1);
    await expect(
      f.provider.withCurrentGraph(f.tx, { ...f.input, [key]: "sha256:" + "b".repeat(64) }, work),
    ).rejects.toThrowError(refused);
    expect(work).not.toHaveBeenCalled();
  },
);
it.each(["versionReference", "optionSetReference"])(
  "refuses foreign root selector %s",
  async (key) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentGraph(f.tx, { ...f.input, [key]: id(999) }, async () => 1),
    ).rejects.toThrowError(refused);
  },
);
it.each([0, 2147483648, 1.1, 2])("refuses invalid/stale revision %s", async (revision) => {
  const f = fixture();
  await expect(
    f.provider.withCurrentGraph(
      f.tx,
      { ...f.input, expectedAggregateVersion: revision },
      async () => 1,
    ),
  ).rejects.toThrowError(refused);
});
it("retains original cap and actual source observation while selecting earlier current lease", async () => {
  state.observed = "2026-09-30T12:00:05.000Z";
  state.until = "2026-09-30T12:00:25.000Z";
  const f = fixture();
  f.advance(state.observed);
  f.input.validUntil = "2026-09-30T12:00:10.000Z";
  const r = await f.provider.withCurrentGraph(f.tx, f.input, async (source) => source);
  expect(r).toMatchObject({
    originalObservedAt: at,
    observedAt: state.observed,
    validUntil: f.input.validUntil,
  });
});
it.each(["2026-09-30T12:00:30.001Z", at, "2026-09-30T11:59:59.999Z"])(
  "refuses invalid caller lease %s before source",
  async (until) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentGraph(f.tx, { ...f.input, validUntil: until }, async () => 1),
    ).rejects.toThrowError(refused);
    expect(state.calls).toBe(0);
  },
);
it.each([end, "2026-09-30T11:59:59.999Z"])(
  "refuses callback expiry/backward time %s",
  async (next) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentGraph(f.tx, f.input, async () => {
        f.advance(next);
        return 1;
      }),
    ).rejects.toThrowError(refused);
  },
);
it("refuses current read/field authority initially and after tentative work", async () => {
  const f = fixture(),
    work = vi.fn(async () => 1);
  f.options.authority.holdUntilTransactionCompletes.mockRejectedValueOnce(
    new Error("synthetic initial deny"),
  );
  await expect(f.provider.withCurrentGraph(f.tx, f.input, work)).rejects.toThrowError(refused);
  expect(work).not.toHaveBeenCalled();
  const next = fixture();
  await expect(
    next.provider.withCurrentGraph(next.tx, next.input, async () => {
      next.options.authority.holdUntilTransactionCompletes.mockRejectedValueOnce(
        new Error("synthetic final deny"),
      );
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it("current own-head/body mutation and a shortened final source window refuse", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentGraph(f.tx, f.input, async () => {
      const p = content(false, "Changed synthetic");
      state.body = {
        ...(state.body as object),
        content: p.content,
        sourceDigest: p.sourceDigest,
        contentDigest: p.contentDigest,
        configurationDigest: p.configurationDigest,
      };
      return 1;
    }),
  ).rejects.toThrowError(refused);
  const next = fixture();
  await expect(
    next.provider.withCurrentGraph(next.tx, next.input, async () => {
      state.body = { ...(state.body as object), validUntil: "2026-09-30T12:00:20.000Z" };
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it("captured clock/current authority cannot be replaced and original callback input is detached", async () => {
  const f = fixture();
  f.options.clock.now = () => "2030-01-01T00:00:00.000Z";
  const original = f.options.authority.holdUntilTransactionCompletes;
  f.options.authority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw new Error("replaced");
  });
  const r = await f.provider.withCurrentGraph(f.tx, f.input, async (source) => {
    f.input.sourceDigest = "sha256:" + "b".repeat(64);
    return source;
  });
  expect(original).toHaveBeenCalledTimes(2);
  expect(r.sourceDigest).not.toBe(f.input.sourceDigest);
});
it("caught recursion/query replacement and callback errors poison this transaction", async () => {
  for (const mode of ["Recursive", "Query", "Throw"]) {
    const f = fixture();
    await expect(
      f.provider.withCurrentGraph(f.tx, f.input, async () => {
        if (mode === "Recursive")
          await expect(
            f.provider.withCurrentGraph(f.tx, f.input, async () => 2),
          ).rejects.toThrowError(refused);
        if (mode === "Query") f.tx.query = vi.fn(async () => ({ rows: [] }));
        if (mode === "Throw") throw new Error("synthetic callback error");
        return 1;
      }),
    ).rejects.toThrowError(refused);
    await expect(f.provider.withCurrentGraph(f.tx, f.input, async () => 1)).rejects.toThrowError(
      refused,
    );
  }
});
it("client graph/ready extras and accessors cannot replace owning source", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentGraph(f.tx, { ...f.input, graph: {} }, async () => 1),
  ).rejects.toThrowError(refused);
  const fresh = fixture(),
    getter = vi.fn(() => fresh.input.optionSetReference),
    input = { ...fresh.input };
  Object.defineProperty(input, "optionSetReference", { get: getter, enumerable: true });
  await expect(
    fresh.provider.withCurrentGraph(fresh.tx, input, async () => 1),
  ).rejects.toThrowError(refused);
  expect(getter).not.toHaveBeenCalled();
  expect(state.calls).toBe(0);
});

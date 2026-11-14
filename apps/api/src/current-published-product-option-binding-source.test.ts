import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  parseProductOptionBinding,
  parseCatalogInstant,
  evaluateCatalogOptionSetRuleSatisfiability,
  assessCatalogFullProductOptionBindingPrerequisites,
  createCatalogFullOptionSetPublicationMaterialization,
} from "@rms/catalog";
import { createCurrentPublishedProductOptionBindingSource } from "./current-published-product-option-binding-source.js";
import type {
  createCurrentPublishedOptionSetGraphSource,
  CurrentPublishedOptionSetGraphOptions,
} from "./current-published-option-set-graph.js";
const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./current-published-option-set-graph.js", () => ({
  createCurrentPublishedOptionSetGraphSource: boundary.create,
}));
const id = (n: number) => "01902421-8800-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
type Graph = Parameters<
  ReturnType<typeof createCurrentPublishedOptionSetGraphSource>["withCurrentGraph"]
>[1] extends (value: infer G) => Promise<unknown>
  ? G
  : never;
type Transaction = CurrentPublishedOptionSetGraphOptions["transaction"];
beforeEach(() => vi.clearAllMocks());
function full(set = 100, revision = 1) {
  const first = materializeFullOptionSetCreation(
    {
      internalCode: "HISTORY",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Original" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "ONE",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "One" },
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
            stableCode: "ONE",
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
      operationReference: id(set + 3),
      occurredAt: at,
      reasonCode: "SYNTHETIC_CONFIGURATION",
    },
    {
      brandReference: id(11),
      actorReference: id(12),
      allocations: {
        optionSetReference: id(set),
        versionReference: id(set + 1),
        options: [{ stableCode: "ONE", optionReference: id(set + 2) }],
      },
    },
  );
  const { sourceAggregate, ...details } = first.content;
  return parseCatalogOptionSetEditorContent(
    {
      ...sourceAggregate,
      aggregateVersion: revision,
      draft: {
        ...sourceAggregate.draft,
        localizedNames: { "en-CA": revision === 1 ? "Original" : "Changed" },
      },
    },
    details,
  );
}

function graph(set = 100): Graph {
  const prepared = full(set),
    content = prepared.content,
    { sourceAggregate, ...details } = content;
  const sealed = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, details, {
    tenantReference: id(10),
    brandReference: id(11),
    optionSetReference: id(set),
    versionReference: id(set + 1),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(set + 4),
    publicationIntentDigest: hash,
    successorDraftVersionReference: id(set + 5),
    sealedAt: at,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  }).content;
  const input = {
      brandReference: id(11),
      rootOptionSetReference: id(set),
      rootVersionReference: id(set + 1),
      contents: [content],
    },
    rules = evaluateCatalogOptionSetRuleSatisfiability(input);
  return Object.freeze({
    profile: "CurrentPublishedOptionSetGraphV1",
    graph: input,
    sourceRecords: [
      {
        optionSetReference: id(set),
        versionReference: id(set + 1),
        publicationReference: id(set + 6),
        releaseRecordDigest: hash,
        sealRecordDigest: sealed.digest,
        approvalDisposition: "Approved" as const,
      },
    ],
    graphDigest: rules.graphDigest,
    rules: {
      status: rules.status,
      reason: "reason" in rules ? rules.reason : null,
      searchNodes: rules.searchNodes,
    },
    originalObservedAt: at,
    observedAt: at,
    validUntil: until,
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
}
function binding(set = 100, identity = 500) {
  return parseProductOptionBinding({
    bindingReference: id(identity),
    optionSetReference: id(set),
    optionSetVersionReference: id(set + 1),
    purpose: "EXTRAS",
    sortOrder: 0,
    enabledOptionReferences: [id(set + 2)],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  });
}
function fixture(privateCount = 3) {
  const state = {
    clock: at,
    denied: false,
    headChanged: false,
    skipAsync: false,
    repeatAsync: false,
    skipFinal: false,
    committed: false,
    foreignRegistration: false,
    noCallback: false,
    twoCallbacks: false,
    malformedSource: false,
    privateError: false,
  };
  const tx: Transaction = {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  };
  const asyncGuards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    calls: { set: string; version: string }[] = [],
    order: string[] = [];
  const current: CurrentPublishedOptionSetGraphOptions["currentAuthorization"] = {
    authorizeActions: vi.fn(async () => {
      if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    assertCurrent: () => {
      if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return parseCatalogInstant(state.clock);
    },
    leaseDeadline: () => until,
    async withCurrentStoreScope() {
      throw new Error("Controlled graph boundary does not call this port");
    },
  };
  const options: CurrentPublishedOptionSetGraphOptions = {
    transaction: tx,
    tenantReference: id(10),
    brandReference: id(11),
    storeReference: id(13),
    actorReference: id(12),
    sessionReference: id(14),
    clock: { now: () => state.clock },
    originalValidUntil: until,
    currentAuthorization: current,
    capability: { holdUntilCommit: vi.fn(async () => undefined), leaseDeadline: () => until },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      asyncGuards.push(guard);
      if (final) finals.push(final);
    },
    events: { generateReference: () => id(999) },
  };
  // Only the existing graph acquisition boundary is controlled here. It still
  // registers real callback-shaped asynchronous and synchronous host checks;
  // this does not claim owning SQL, actual IAM or native Published evidence.
  boundary.create.mockImplementation((input: CurrentPublishedOptionSetGraphOptions) => ({
    async withCurrentGraph<T>(request: unknown, work: (source: Graph) => Promise<T>): Promise<T> {
      const r = request as { optionSetReference: string; versionReference: string };
      const number = parseInt(r.optionSetReference.slice(-12), 16),
        packet = graph(number);
      calls.push({ set: r.optionSetReference, version: r.versionReference });
      if (r.versionReference !== packet.graph.rootVersionReference)
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      const complete = new Set<number>();
      for (let i = 0; i < privateCount; i++)
        await input.registerBeforeCommit(
          state.foreignRegistration
            ? {
                async query<Row>() {
                  return { rows: [] as readonly Row[] };
                },
              }
            : tx,
          async () => {
            order.push(`async:${r.optionSetReference}:${i}`);
            if (state.headChanged || state.privateError)
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            input.currentAuthorization.assertCurrent();
            if (input.clock.now() >= until)
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            complete.add(i);
          },
          () => {
            order.push(`final:${r.optionSetReference}:${i}`);
            if (!complete.has(i) || state.headChanged || input.clock.now() >= until)
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          },
        );
      if (state.noCallback) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      const source = state.malformedSource
        ? { ...packet, graph: { ...packet.graph, rootVersionReference: id(998) } }
        : packet;
      const result = await work(source);
      if (state.twoCallbacks) await work(source);
      return result;
    },
  }));
  const source = createCurrentPublishedProductOptionBindingSource(options);
  async function run<T>(work: () => Promise<T>) {
    const result = await work();
    if (!state.skipAsync)
      for (const guard of asyncGuards) {
        await guard();
        if (state.repeatAsync) await guard();
      }
    if (!state.skipFinal) for (const final of finals) final();
    state.committed = true;
    return result;
  }
  return { state, tx, options, current, source, run, calls, order, asyncGuards, finals };
}
it("resolves exact current root and deduplicates subsequent binding assessment on the identical host", async () => {
  const f = fixture(),
    b = binding();
  await f.run(async () => {
    const resolved = await f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: b.optionSetReference,
      optionSetVersionReference: b.optionSetVersionReference,
    });
    expect(resolved).toEqual(full().content.sourceAggregate);
    for (let i = 0; i < 3; i++)
      await f.source.withBindingAssessment(f.tx, b, async (value) => {
        const actual = assessCatalogFullProductOptionBindingPrerequisites({
          graph: graph().graph,
          binding: b,
        });
        expect(value.bindingDigest).toBe(actual.bindingDigest);
        expect(value.rules.status).toBe(actual.status);
        expect(value.sourceRecords[0]?.recordDigest).toBe(
          graph().sourceRecords[0]?.sealRecordDigest,
        );
      });
  });
  expect(boundary.create).toHaveBeenCalledOnce();
  expect(f.calls).toEqual([{ set: id(100), version: id(101) }]);
  expect(f.asyncGuards).toHaveLength(1);
  expect(f.finals).toHaveLength(1);
  expect(f.order).toHaveLength(6);
});
it("never upgrades a selected pin to the controlled current head", async () => {
  const f = fixture();
  await expect(
    f.run(() =>
      f.source.resolveVersion({
        brandReference: id(11),
        optionSetReference: id(100),
        optionSetVersionReference: id(999),
      }),
    ),
  ).rejects.toBeDefined();
  expect(f.calls[0]?.version).toBe(id(999));
  expect(f.state.committed).toBe(false);
});
it("evaluates distinct bindings sharing one graph with their own default and hard-limit rules", async () => {
  const f = fixture(),
    good = binding(),
    bad = parseProductOptionBinding({
      ...good,
      bindingReference: id(501),
      defaultSelections: [{ optionReference: id(102), quantity: 2 }],
    });
  await f.run(async () => {
    await f.source.withBindingAssessment(f.tx, good, async (value) => {
      expect(value.rules.status).toBe("Satisfiable");
    });
    await f.source.withBindingAssessment(f.tx, bad, async (value) => {
      const own = assessCatalogFullProductOptionBindingPrerequisites({
        graph: graph().graph,
        binding: bad,
      });
      expect(value.rules.status).toBe(own.status);
      expect(value.rules.status).not.toBe("Satisfiable");
      expect(value.bindingDigest).not.toBe(
        assessCatalogFullProductOptionBindingPrerequisites({ graph: graph().graph, binding: good })
          .bindingDigest,
      );
    });
  });
  expect(boundary.create).toHaveBeenCalledOnce();
});
it.each(["head", "permission", "expiry", "query", "privateError"])(
  "retains genuine private guards and refuses late %s",
  async (kind) => {
    const f = fixture();
    await expect(
      f.run(async () => {
        await f.source.withBindingAssessment(f.tx, binding(), async () => undefined);
        if (kind === "head") f.state.headChanged = true;
        if (kind === "permission") f.state.denied = true;
        if (kind === "expiry") f.state.clock = until;
        if (kind === "query") f.tx.query = async () => ({ rows: [] });
        if (kind === "privateError") f.state.privateError = true;
      }),
    ).rejects.toBeDefined();
    expect(f.state.committed).toBe(false);
  },
);
it("refuses foreign transactions and poisons later cached reuse", async () => {
  const f = fixture();
  await expect(
    f.source.withBindingAssessment(
      {
        async query<Row>() {
          return { rows: [] as readonly Row[] };
        },
      },
      binding(),
      async () => undefined,
    ),
  ).rejects.toBeDefined();
  await expect(
    f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: id(100),
      optionSetVersionReference: id(101),
    }),
  ).rejects.toBeDefined();
  expect(boundary.create).not.toHaveBeenCalled();
});
it("poisons a failed consumer callback before permitting reuse of an acquired graph", async () => {
  const f = fixture();
  await expect(
    f.source.withBindingAssessment(f.tx, binding(), async () => {
      throw new Error("controlled callback failure");
    }),
  ).rejects.toBeDefined();
  await expect(
    f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: id(100),
      optionSetVersionReference: id(101),
    }),
  ).rejects.toBeDefined();
});
it.each(["foreignRegistration", "noCallback", "twoCallbacks", "malformedSource"])(
  "refuses controlled graph boundary %s and its cache",
  async (kind) => {
    const f = fixture();
    f.state[kind as "foreignRegistration" | "noCallback" | "twoCallbacks" | "malformedSource"] =
      true;
    await expect(
      f.source.resolveVersion({
        brandReference: id(11),
        optionSetReference: id(100),
        optionSetVersionReference: id(101),
      }),
    ).rejects.toBeDefined();
    await expect(
      f.source.resolveVersion({
        brandReference: id(11),
        optionSetReference: id(100),
        optionSetVersionReference: id(101),
      }),
    ).rejects.toBeDefined();
  },
);
it("consolidates finite graph guards while all private asynchronous checks precede every final", async () => {
  const f = fixture(65);
  await f.run(async () => {
    for (const set of [100, 110, 120])
      await f.source.withBindingAssessment(f.tx, binding(set, set + 500), async () => undefined);
  });
  expect(f.asyncGuards).toHaveLength(3);
  expect(f.finals).toHaveLength(3);
  expect(f.order).toHaveLength(390);
  const firstFinal = f.order.findIndex((item) => item.startsWith("final:"));
  expect(firstFinal).toBe(195);
  expect(f.order.slice(firstFinal).every((item) => item.startsWith("final:"))).toBe(true);
});
it("rejects repeated coordinator checks and skipped asynchronous admission before final", async () => {
  for (const mode of ["repeatAsync", "skipAsync"] as const) {
    const f = fixture();
    f.state[mode] = true;
    await expect(
      f.run(() => f.source.withBindingAssessment(f.tx, binding(), async () => undefined)),
    ).rejects.toBeDefined();
    expect(f.state.committed).toBe(false);
  }
});
it.each(["clock", "authority", "registration"])(
  "refuses captured port %s replacement after acquisition",
  async (kind) => {
    const f = fixture();
    await f.source.withBindingAssessment(f.tx, binding(), async () => undefined);
    if (kind === "clock") f.options.clock.now = () => at;
    if (kind === "authority")
      Object.defineProperty(f.current, "assertCurrent", { value: () => parseCatalogInstant(at) });
    if (kind === "registration")
      Object.defineProperty(f.options, "registerBeforeCommit", { value: async () => undefined });
    await expect(
      f.source.withBindingAssessment(f.tx, binding(), async () => undefined),
    ).rejects.toBeDefined();
  },
);
it("keeps the original five-second deadline rather than renewing on another assessment", async () => {
  const f = fixture();
  await f.source.withBindingAssessment(f.tx, binding(), async () => undefined);
  f.state.clock = "2026-10-05T12:00:04.999Z";
  await f.source.withBindingAssessment(f.tx, binding(), async (value) => {
    expect(value.validUntil).toBe(until);
  });
  f.state.clock = until;
  await expect(
    f.source.withBindingAssessment(f.tx, binding(), async () => undefined),
  ).rejects.toBeDefined();
});
it("accepts exactly 32 distinct graphs and refuses the thirty-third without widening private guard capacity", async () => {
  const f = fixture(1);
  for (let index = 0; index < 32; index++) {
    const set = 100 + index * 10;
    await f.source.withBindingAssessment(f.tx, binding(set, set + 500), async () => undefined);
  }
  expect(f.asyncGuards).toHaveLength(32);
  await expect(
    f.source.withBindingAssessment(f.tx, binding(500, 999), async () => undefined),
  ).rejects.toBeDefined();
  expect(boundary.create).toHaveBeenCalledTimes(32);
});
it("refuses excess private guard registration instead of dropping owner checks", async () => {
  const f = fixture(129);
  await expect(
    f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: id(100),
      optionSetVersionReference: id(101),
    }),
  ).rejects.toBeDefined();
  await expect(
    f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: id(100),
      optionSetVersionReference: id(101),
    }),
  ).rejects.toBeDefined();
});
it("refuses another Brand without acquiring or populating a source cache", async () => {
  const f = fixture();
  await expect(
    f.source.resolveVersion({
      brandReference: id(99),
      optionSetReference: id(100),
      optionSetVersionReference: id(101),
    }),
  ).rejects.toBeDefined();
  expect(boundary.create).not.toHaveBeenCalled();
});

it("never reuses a held packet after host finalization", async () => {
  const f = fixture(),
    b = binding();
  await f.run(() => f.source.withBindingAssessment(f.tx, b, async () => undefined));
  await expect(
    f.source.resolveVersion({
      brandReference: id(11),
      optionSetReference: b.optionSetReference,
      optionSetVersionReference: b.optionSetVersionReference,
    }),
  ).rejects.toBeDefined();
});

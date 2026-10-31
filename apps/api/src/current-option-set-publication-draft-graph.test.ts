import { beforeEach, expect, it, vi } from "vitest";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  currentFullOptionSetDraftReviewFields,
  evaluateCatalogOptionSetRuleSatisfiability,
  materializeFullOptionSetCreation,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogOptionSetEditorContent,
  type createPostgresCurrentFullOptionSetDraftStore,
} from "@rms/catalog";
import type { createCurrentPublishedOptionSetGraphSource } from "./current-published-option-set-graph.js";
import { createCurrentOptionSetPublicationDraftGraphSource } from "./current-option-set-publication-draft-graph.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
const owners = vi.hoisted(() => ({
  root: vi.fn(),
  read: vi.fn(),
  published: vi.fn(),
  child: vi.fn(),
  handoff: vi.fn(),
  admit: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  createPostgresCurrentFullOptionSetDraftStore: owners.root,
  createPostgresFullOptionSetSealHandoffStore: owners.handoff,
}));
vi.mock("./current-published-option-set-graph.js", () => ({
  createCurrentPublishedOptionSetGraphSource: owners.published,
}));
const id = (n: number) => "01902421-7981-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
type RootOptions = Parameters<typeof createPostgresCurrentFullOptionSetDraftStore>[0];
type PublishedOptions = Parameters<typeof createCurrentPublishedOptionSetGraphSource>[0];
type Published = Parameters<
  Parameters<ReturnType<typeof createCurrentPublishedOptionSetGraphSource>["withCurrentGraph"]>[1]
>[0];
type Options = Parameters<typeof createCurrentOptionSetPublicationDraftGraphSource>[0];
function full(
  n = 10,
  triggers: readonly { set: number; version: number }[] = [],
  version = n + 100,
) {
  const options = (triggers.length ? triggers : [null]).map((trigger, i) => ({
    stableCode: "CHOICE_" + i,
    lifecycle: "Draft",
    localizedNames: { "en-CA": "Synthetic choice " + i },
    localizedDescriptions: {},
    sortOrder: i,
    defaultEligible: false,
    triggeredOptionSetReference: trigger === null ? null : id(trigger.set),
    conflictOptionCodes: [],
  }));
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_" + n,
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic choices " + n },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: options.length,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: options.length,
        options,
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: options.map((option, i) => ({
          stableCode: option.stableCode,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: triggers[i] ? id(triggers[i].version) : null,
        })),
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(n + 5000),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference: id(2),
      actorReference: id(4),
      allocations: {
        optionSetReference: id(n),
        versionReference: id(version),
        options: options.map((option, i) => ({
          stableCode: option.stableCode,
          optionReference: id(10000 + n * 100 + i),
        })),
      },
    },
  ).content;
}
function rootView(content = full()) {
  const { sourceAggregate, ...additional } = content,
    prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
  return {
    content: prepared.content,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    sourceOperationReference: parseCatalogReference(id(90)),
    sourceSnapshotTuple: {
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      optionSetReference: sourceAggregate.optionSetReference,
      versionReference: sourceAggregate.draft.versionReference,
      aggregateVersion: sourceAggregate.aggregateVersion,
      sourceDigest: prepared.sourceDigest,
      contentDigest: prepared.contentDigest,
      configurationDigest: prepared.configurationDigest,
    },
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated" as const,
  };
}
function published(contents: readonly ReturnType<typeof full>[], root: number): Published {
  const content = contents.find(
    (value) => String(value.sourceAggregate.optionSetReference) === id(root),
  );
  if (!content) throw new Error("missing controlled published fixture root");
  const graph = {
    brandReference: id(2),
    rootOptionSetReference: id(root),
    rootVersionReference: String(content.sourceAggregate.draft.versionReference),
    contents,
  };
  const assessment = evaluateCatalogOptionSetRuleSatisfiability(graph);
  return {
    profile: "CurrentPublishedOptionSetGraphV1",
    graph,
    sourceRecords: contents.map((value) => ({
      optionSetReference: String(value.sourceAggregate.optionSetReference),
      versionReference: String(value.sourceAggregate.draft.versionReference),
      publicationReference: id(
        30000 + Number.parseInt(value.sourceAggregate.optionSetReference.slice(-4), 16),
      ),
      releaseRecordDigest: "sha256:" + "a".repeat(64),
      sealRecordDigest: "sha256:" + "b".repeat(64),
      approvalDisposition: "Approved",
    })),
    graphDigest: assessment.graphDigest,
    rules: {
      status: assessment.status,
      reason: "reason" in assessment ? assessment.reason : null,
      searchNodes: assessment.searchNodes,
    },
    originalObservedAt: at,
    observedAt: at,
    validUntil: until,
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  };
}
interface Controls {
  root: ReturnType<typeof rootView>;
  children: Map<string, Published>;
  badFields: boolean;
  crossTransaction: boolean;
  generation: number;
}
let controls: Controls;
beforeEach(() => {
  vi.clearAllMocks();
  controls = {
    root: rootView(),
    children: new Map(),
    badFields: false,
    crossTransaction: false,
    generation: 1,
  };
  owners.handoff.mockImplementation(() => ({
    admit: owners.admit.mockImplementation(async (original: unknown, receipt: unknown) => {
      void receipt;
      return { original, validUntil: until };
    }),
    revalidate: owners.revalidate.mockImplementation(async () => ({ validUntil: until })),
  }));
  owners.root.mockImplementation((options: RootOptions) => ({
    readCurrentForReview: owners.read.mockImplementation(
      async (request: { optionSetReference: string; expectedAggregateVersion: number }) =>
        options.transactions.run(async (tx) => {
          expect(request.optionSetReference).toBe(
            String(controls.root.content.sourceAggregate.optionSetReference),
          );
          const observedAt = options.clock.now(),
            input = {
              tenantReference: id(1),
              brandReference: id(2),
              actorReference: id(4),
              actorKind: "User" as const,
              permission: "catalog.manage" as const,
              action: "catalog.option_set.read" as const,
              purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
              requiredFields: controls.badFields ? [] : currentFullOptionSetDraftReviewFields,
              optionSetReference: request.optionSetReference,
              content: null,
              observedAt,
            };
          await options.authority.holdUntilTransactionCompletes(
            controls.crossTransaction ? { ...tx } : tx,
            input,
          );
          const evidence = await options.authority.holdUntilTransactionCompletes(tx, {
            ...input,
            content: controls.root.content,
          });
          return { ...controls.root, observedAt, validUntil: evidence.validUntil };
        }),
    ),
  }));
  // Controlled Published source packets and original host guards, not PostgreSQL
  // or real IAM evidence. Actual three-owner SQL has its separate native gate.
  owners.published.mockImplementation((options: PublishedOptions) => ({
    withCurrentGraph: owners.child.mockImplementation(
      async (
        request: { optionSetReference: string; versionReference: string },
        work: (source: Published) => Promise<unknown>,
      ) => {
        const packet = controls.children.get(request.optionSetReference);
        if (!packet) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        if (packet.graph.rootVersionReference !== request.versionReference)
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        const originalGeneration = controls.generation;
        let ready = false,
          calls = 0,
          done = false;
        await options.registerBeforeCommit(
          options.transaction,
          async () => {
            if (!ready || ++calls !== 1 || originalGeneration !== controls.generation)
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            options.clock.now();
            done = true;
          },
          () => {
            if (!done || calls !== 1) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            options.clock.now();
          },
        );
        const result = await work(packet);
        ready = true;
        return result;
      },
    ),
  }));
});
function fixture(originalObservedAt?: string, ownSeal = false, useCombined = false) {
  let clock = at,
    withdrawn = false,
    committed = false;
  const authorize = vi.fn(async (actions: readonly string[]) => {
    void actions;
    if (withdrawn) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const result = await work({ query: async () => ({ rows: [] }) });
      committed = true;
      return result;
    },
  });
  let combinedInvalid = "";
  const legacyCapability = vi.fn(async () => undefined);
  const combined = vi.fn(async (actions: readonly string[]) => {
    if (withdrawn) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return combinedDecisions(actions, combinedInvalid);
  });
  let captured: Options | undefined;
  const run = <T>(
    work: (
      source: ReturnType<typeof createCurrentOptionSetPublicationDraftGraphSource>,
    ) => Promise<T>,
  ) =>
    host.transactions.run(async (tx) => {
      const options: Options = {
        transaction: tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(4),
        sessionReference: id(6),
        clock: { now: () => clock },
        originalValidUntil: until,
        ...(originalObservedAt === undefined ? {} : { originalObservedAt }),
        ...(ownSeal
          ? {
              publicationSeal: {
                operationReference: id(80),
                publicationIntentDigest: "sha256:" + "c".repeat(64),
                occurredAt: at,
              },
            }
          : {}),
        currentAuthorization: {
          authorizeActions: authorize,
          assertCurrent: () => parseCatalogInstant(clock),
          leaseDeadline: () => until,
          async withCurrentStoreScope() {
            throw new Error("controlled Feature fixture");
          },
        },
        capability: {
          holdUntilCommit: legacyCapability,
          ...(useCombined ? { holdUntilCommitWithDecisions: combined } : {}),
          leaseDeadline: () => until,
        },
        registerBeforeCommit: host.registerBeforeCommit,
        events: { generateReference: () => id(7) },
      };
      captured = options;
      return work(createCurrentOptionSetPublicationDraftGraphSource(options));
    });
  return {
    run,
    combined,
    legacyCapability,
    invalidCombined: (value: string) => {
      combinedInvalid = value;
    },
    authorize,
    committed: () => committed,
    withdraw: () => {
      withdrawn = true;
    },
    time: (value: string) => {
      clock = value;
    },
    options: () => {
      if (!captured) throw new Error("fixture not entered");
      return captured;
    },
  };
}
function request() {
  const value = controls.root;
  return {
    optionSetReference: String(value.content.sourceAggregate.optionSetReference),
    versionReference: String(value.content.sourceAggregate.draft.versionReference),
    expectedAggregateVersion: value.content.sourceAggregate.aggregateVersion,
    sourceDigest: value.sourceDigest,
    contentDigest: value.contentDigest,
    configurationDigest: value.configurationDigest,
  };
}
it("returns actual root operation provenance and full Catalog graph identity, never caller operation", async () => {
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (packet) => {
      expect(packet.sourceOperationReference).toBe(id(90));
      expect(packet.sourceSnapshotTuple).toEqual(controls.root.sourceSnapshotTuple);
      expect(packet.graph.contents).toEqual([controls.root.content]);
      expect(packet.graphDigest).toBe(
        evaluateCatalogOptionSetRuleSatisfiability(packet.graph).graphDigest,
      );
      expect(packet.rules.status).toBe("Satisfiable");
      expect(packet.publishValidation).toBe("Incomplete");
      expect(packet.eligibility).toBe("NotEvaluated");
      expect(packet.validUntil).toBe(until);
    }),
  );
  expect(owners.read).toHaveBeenCalledTimes(2);
  expect(owners.published).not.toHaveBeenCalled();
  expect(f.committed()).toBe(true);
  expect(f.authorize).toHaveBeenCalledWith(["catalog.manage", "catalog.option_set.read"]);
});
it("acquires genuine child producers once for shared reachable content and preserves exact pins", async () => {
  controls.root = rootView(
    full(10, [
      { set: 11, version: 111 },
      { set: 12, version: 112 },
    ]),
  );
  const child = full(11, [{ set: 12, version: 112 }]);
  controls.children.set(id(11), published([child, full(12)], 11));
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (packet) => {
      expect(packet.graph.contents).toHaveLength(3);
      expect(packet.sourceRecords).toHaveLength(2);
      expect(packet.rules.status).toBe("Satisfiable");
      expect(packet.graph.contents[0]?.optionDetails[0]?.triggeredOptionSetVersionReference).toBe(
        id(111),
      );
    }),
  );
  expect(owners.published).toHaveBeenCalledTimes(1);
  expect(owners.child).toHaveBeenCalledWith(
    { optionSetReference: id(11), versionReference: id(111) },
    expect.any(Function),
  );
  expect(owners.published.mock.calls[0]?.[0].transaction).toBe(f.options().transaction);
});
it.each([
  "callerOperation",
  "wrongVersion",
  "wrongRoot",
  "wrongDigest",
  "wrongFields",
  "crossTransaction",
  "wrongProvenance",
])("rejects %s without a partial consumer result", async (failure) => {
  const input = request();
  if (failure === "wrongFields") controls.badFields = true;
  if (failure === "crossTransaction") controls.crossTransaction = true;
  if (failure === "wrongProvenance")
    controls.root = {
      ...controls.root,
      sourceSnapshotTuple: {
        ...controls.root.sourceSnapshotTuple,
        tenantReference: parseCatalogReference(id(99)),
      },
    };
  const supplied =
    failure === "callerOperation"
      ? { ...input, sourceOperationReference: id(91) }
      : failure === "wrongVersion"
        ? { ...input, versionReference: id(999) }
        : failure === "wrongRoot"
          ? { ...input, expectedAggregateVersion: 2 }
          : failure === "wrongDigest"
            ? { ...input, sourceDigest: "sha256:" + "c".repeat(64) }
            : input;
  const f = fixture(),
    work = vi.fn(async () => undefined);
  await expect(f.run((source) => source.withCurrentGraph(supplied, work))).rejects.toBeDefined();
  expect(work).not.toHaveBeenCalled();
  expect(f.committed()).toBe(false);
});
it.each(["missingChild", "conflictingPins", "oldRootBackref"])(
  "refuses %s rather than upgrading or dropping graph nodes",
  async (failure) => {
    controls.root = rootView(
      full(
        10,
        failure === "conflictingPins"
          ? [
              { set: 11, version: 111 },
              { set: 11, version: 112 },
            ]
          : [{ set: 11, version: 111 }],
      ),
    );
    if (failure === "oldRootBackref")
      controls.children.set(
        id(11),
        published([full(11, [{ set: 10, version: 999 }]), full(10, [], 999)], 11),
      );
    const f = fixture(),
      work = vi.fn(async () => undefined);
    await expect(
      f.run((source) => source.withCurrentGraph(request(), work)),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(work).not.toHaveBeenCalled();
    expect(f.committed()).toBe(false);
  },
);
it.each([31, 32])(
  "enforces global32 including the Draft root with %i child nodes",
  async (count) => {
    controls.root = rootView(full(10, [{ set: 20, version: 120 }]));
    const children = Array.from({ length: count }, (_, i) =>
      full(20 + i, i === count - 1 ? [] : [{ set: 21 + i, version: 121 + i }]),
    );
    controls.children.set(id(20), published(children, 20));
    const f = fixture(),
      run = f.run((source) =>
        source.withCurrentGraph(request(), async (packet) => {
          expect(packet.graph.contents).toHaveLength(32);
        }),
      );
    if (count === 31) {
      await run;
      expect(f.committed()).toBe(true);
    } else {
      await expect(run).rejects.toBeInstanceOf(CatalogError);
      expect(f.committed()).toBe(false);
    }
  },
);
it.each(["permission", "deadline", "rootProvenance", "publishedHead", "portReplacement"])(
  "refuses late %s before COMMIT",
  async (failure) => {
    controls.root = rootView(full(10, [{ set: 11, version: 111 }]));
    controls.children.set(id(11), published([full(11)], 11));
    const f = fixture();
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          if (failure === "permission") f.withdraw();
          if (failure === "deadline") f.time(until);
          if (failure === "rootProvenance")
            controls.root = {
              ...controls.root,
              sourceOperationReference: parseCatalogReference(id(91)),
            };
          if (failure === "publishedHead") controls.generation++;
          if (failure === "portReplacement")
            f.options().currentAuthorization.authorizeActions = async () => undefined;
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);
it("reports actual Catalog cycles without certifying the complete publication", async () => {
  controls.root = rootView(full(10, [{ set: 11, version: 111 }]));
  controls.children.set(
    id(11),
    published([full(11, [{ set: 12, version: 112 }]), full(12, [{ set: 11, version: 111 }])], 11),
  );
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (packet) => {
      expect(packet.rules).toMatchObject({ status: "Unsatisfiable", reason: "TriggerCycle" });
      expect(packet.referenceEligibility).toBe("NotEvaluated");
    }),
  );
});
it("poisons the original host even when the caller swallows a failed graph", async () => {
  controls.badFields = true;
  const f = fixture();
  await expect(
    f.run(async (source) => {
      await source.withCurrentGraph(request(), async () => undefined).catch(() => undefined);
      return "swallowed";
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.committed()).toBe(false);
});
it("retains separate published components in one original host without dropping either proof", async () => {
  controls.root = rootView(
    full(10, [
      { set: 11, version: 111 },
      { set: 12, version: 112 },
    ]),
  );
  controls.children.set(id(11), published([full(11)], 11));
  controls.children.set(id(12), published([full(12)], 12));
  const f = fixture();
  await f.run((source) =>
    source.withCurrentGraph(request(), async (packet) => {
      expect(packet.graph.contents).toHaveLength(3);
      expect(packet.sourceRecords.map((record) => record.optionSetReference)).toEqual([
        id(11),
        id(12),
      ]);
    }),
  );
  expect(owners.published).toHaveBeenCalledTimes(2);
  expect(f.committed()).toBe(true);
});

it("retains the actual server request origin when factory construction and reads happen later", async () => {
  const f = fixture(at);
  f.time("2026-10-05T12:00:01.000Z");
  await f.run((source) =>
    source.withCurrentGraph(request(), async (packet) => {
      expect(packet.originalObservedAt).toBe(at);
      expect(packet.observedAt).toBe("2026-10-05T12:00:01.000Z");
      expect(packet.validUntil).toBe(until);
    }),
  );
  expect(f.committed()).toBe(true);
});
it.each(["2026-10-05T12:00:01.000Z", "2026-10-05T11:59:59.999Z"])(
  "refuses an origin in the future or an overlong original lease: %s",
  async (origin) => {
    const f = fixture(origin);
    await expect(
      f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(f.committed()).toBe(false);
  },
);

it("hands only the captured original root to the owning exact Seal proof and final revalidation", async () => {
  const f = fixture(at, true),
    original = controls.root,
    receipt = Object.freeze({ controlledReceipt: true });
  await f.run(async (source) => {
    await source.withCurrentGraph(request(), async () => undefined);
    await source.admitOwnSeal(receipt);
    controls.root = rootView(full(10, [], 999));
  });
  expect(f.committed()).toBe(true);
  expect(owners.admit).toHaveBeenCalledWith(original, receipt);
  expect(owners.revalidate).toHaveBeenCalledOnce();
  expect(owners.read).toHaveBeenCalledTimes(1);
});
it.each(["before-read", "twice", "owner-refusal", "final-refusal", "late-IAM", "expiry"])(
  "refuses the controlled Seal handoff on %s without committing",
  async (failure) => {
    const f = fixture(at, true);
    if (failure === "owner-refusal")
      owners.admit.mockImplementation(async () => {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      });
    // Factories capture methods; configure the controlled owner after creation.
    await expect(
      f.run(async (source) => {
        if (failure === "before-read") return source.admitOwnSeal({});
        await source.withCurrentGraph(request(), async () => undefined);
        if (failure === "owner-refusal")
          owners.admit.mockImplementation(async () => {
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          });
        await source.admitOwnSeal({});
        if (failure === "twice") await source.admitOwnSeal({});
        if (failure === "final-refusal")
          owners.revalidate.mockImplementation(async () => {
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          });
        if (failure === "late-IAM") f.withdraw();
        if (failure === "expiry") f.time(until);
      }),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

// Controlled full public Permission decisions; every callback creates a fresh
// packet. Production owning acquisition is exercised by the separate SQL gate.
function combinedDecisions(actions: readonly string[], invalid = "") {
  const values = actions.map((action) => ({
    effect: "Allow" as const,
    reason: "ROLE_PERMISSION" as const,
    source: "RolePermission" as const,
    action: parseBusinessAction(action),
    scopeKind: "Brand" as const,
    policySnapshotReference: parsePolicyReference(id(80)),
    policyVersion: parsePolicyVersion(1),
    audit: {
      effect: "Allow" as const,
      reason: "ROLE_PERMISSION" as const,
      source: "RolePermission" as const,
    },
  }));
  if (invalid === "count") values.pop();
  if (invalid === "order") values.reverse();
  const first = values[0];
  if (first) {
    if (invalid === "deny") Object.assign(first, { effect: "Deny" });
    if (invalid === "scope") Object.assign(first, { scopeKind: "Store" });
    if (invalid === "audit") Object.assign(first.audit, { reason: "EXPLICIT_ALLOW" });
    if (invalid === "version") Object.assign(first, { policyVersion: 0 });
    if (invalid === "extra") Object.assign(first, { callerPass: true });
    if (invalid === "getter")
      Object.defineProperty(first, "action", {
        enumerable: true,
        get() {
          throw Error("Accessor must never be called");
        },
      });
  }
  if (invalid === "mutable") return values;
  for (const value of values) {
    Object.freeze(value.audit);
    Object.freeze(value);
  }
  return Object.freeze(values);
}

it("uses a fresh combined full permission checkpoint through callback and COMMIT without legacy singleton work", async () => {
  const f = fixture(undefined, false, true);
  await f.run((source) =>
    source.withCurrentGraph(request(), async () => {
      expect(f.combined).toHaveBeenCalled();
      expect(f.legacyCapability).not.toHaveBeenCalled();
      expect(f.authorize).not.toHaveBeenCalled();
    }),
  );
  expect(f.committed()).toBe(true);
  expect(f.combined.mock.calls.length).toBeGreaterThan(1);
  expect(f.legacyCapability).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
  for (const [actions] of f.combined.mock.calls) {
    expect(actions).toContain("catalog.manage");
    expect(actions).toContain("catalog.option_set.read");
    expect(Object.isFrozen(actions)).toBe(true);
  }
});
it.each(["count", "order", "deny", "scope", "audit", "version", "extra", "getter", "mutable"])(
  "refuses malformed combined %s before acquiring owner facts",
  async (invalid) => {
    const f = fixture(undefined, false, true);
    f.invalidCombined(invalid);
    await expect(
      f.run((source) => source.withCurrentGraph(request(), async () => undefined)),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
    expect(f.legacyCapability).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  },
);
it.each(["withdrawal", "deny", "expiry", "port"])(
  "rechecks combined %s at final current guards",
  async (change) => {
    const f = fixture(undefined, false, true);
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          if (change === "withdrawal") f.withdraw();
          if (change === "deny") f.invalidCombined("deny");
          if (change === "expiry") f.time(until);
          if (change === "port") {
            const options = f.options();
            if (!options) throw Error("Missing captured options");
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
          }
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

it.each(["add", "remove"])(
  "rejects optional combined port %s after original capture",
  async (change) => {
    const f = fixture(undefined, false, change === "remove");
    await expect(
      f.run((source) =>
        source.withCurrentGraph(request(), async () => {
          const options = f.options();
          if (!options) throw Error("Missing captured options");
          if (change === "remove")
            Reflect.deleteProperty(options.capability, "holdUntilCommitWithDecisions");
          else
            options.capability.holdUntilCommitWithDecisions = async (actions) =>
              combinedDecisions(actions);
        }),
      ),
    ).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);

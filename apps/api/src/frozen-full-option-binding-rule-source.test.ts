import { beforeEach, expect, it, vi } from "vitest";
import {
  createFrozenFullOptionBindingRuleSource,
  createProductPublicationFrozenFullOptionBindingRuleSource,
} from "./frozen-full-option-binding-rule-source.js";
import {
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "@rms/catalog";
import { CatalogError } from "@rms/catalog";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  readerAsync: vi.fn(),
  readerFinal: vi.fn(),
  transactions: [] as unknown[],
  publicationOptions: [] as unknown[],
}));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresProductPublicationFrozenFullOptionSetContentStore: (options: {
    transactions: { run: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    registerBeforeCommit: (
      tx: unknown,
      guard: () => Promise<void>,
      final: () => void,
    ) => Promise<void>;
  }) => {
    mock.publicationOptions.push(options);
    return {
      readPinned: (value: unknown) =>
        options.transactions.run(async (tx) => {
          mock.transactions.push(tx);
          await options.registerBeforeCommit(
            tx,
            async () => {
              await mock.readerAsync();
            },
            () => {
              return mock.readerFinal();
            },
          );
          return mock.read(value);
        }),
    };
  },
  createPostgresFrozenFullOptionSetContentStore: (options: {
    transactions: { run: (callback: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  }) => ({
    readPinned: (value: unknown) =>
      options.transactions.run(async (tx) => {
        mock.transactions.push(tx);
        return mock.read(value);
      }),
  }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-30T12:00:00.000Z";
function fixture(n = 1, count = 2) {
  const set = id(n * 100),
    version = id(n * 100 + 1);
  const source = {
    optionSetReference: set,
    brandReference: id(2),
    internalCode: "SET_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic rule set" },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: Math.max(2, count * 2) as number | null,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 2,
      maximumTotalQuantity: Math.max(2, count * 2) as number | null,
      createdAt: at,
      updatedAt: at,
      options: Array.from({ length: count }, (_, i) => ({
        optionReference: id(n * 100 + 10 + i),
        optionSetReference: set,
        brandReference: id(2),
        stableCode: "OPTION_" + i,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic option" },
        localizedDescriptions: {},
        sortOrder: i,
        defaultEligible: true,
        triggeredOptionSetReference: null as string | null,
        conflictOptionReferences: [] as string[],
        createdAt: at,
        createdByActorReference: id(3),
      })),
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: source.draft.options.map((o) => ({
      optionReference: o.optionReference,
      quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
      media: null,
      pricingRule: null,
      consumption: null,
      triggeredOptionSetVersionReference: null as string | null,
    })),
    conditionalRules: [] as {
      ruleReference: string;
      whenAllSelected: string[];
      requiredOptionReferences: string[];
    }[],
    conflictRules: [] as { ruleReference: string; forbiddenTogether: string[] }[],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  };
  return { source, details };
}
type Fixture = ReturnType<typeof fixture>;
const option = (f: Fixture, i: number) => {
  const o = f.source.draft.options[i];
  if (!o) throw new Error("missing synthetic option");
  return o;
};
const detail = (f: Fixture, i: number) => {
  const d = f.details.optionDetails[i];
  if (!d) throw new Error("missing synthetic detail");
  return d;
};
function trigger(from: Fixture, i: number, to: Fixture) {
  option(from, i).triggeredOptionSetReference = to.source.optionSetReference;
  detail(from, i).triggeredOptionSetVersionReference = to.source.draft.versionReference;
}
const input = (...nodes: Fixture[]) => ({
  brandReference: id(2),
  rootOptionSetReference: id(100),
  rootVersionReference: id(101),
  contents: nodes.map((f) => parseCatalogOptionSetEditorContent(f.source, f.details).content),
});

function binding(f: Fixture, selections: readonly (readonly [number, number])[] = [[0, 1]]) {
  return {
    bindingReference: id(900),
    optionSetReference: f.source.optionSetReference,
    optionSetVersionReference: f.source.draft.versionReference,
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: f.source.draft.options.map((o) => o.optionReference),
    defaultSelections: selections.map(([i, quantity]) => ({
      optionReference: option(f, i).optionReference,
      quantity,
    })),
    minimumSelectionOverride: null as number | null,
    maximumSelectionOverride: null as number | null,
    includedSkuReferences: [] as string[],
    excludedSkuReferences: [] as string[],
    channelCodes: ["POS"],
    storeOverrideAllowed: false,
  };
}

const tenant = id(4),
  actor = id(3),
  plus = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
function stored(f: Fixture) {
  const full = parseCatalogOptionSetEditorContent(f.source, f.details);
  return createCatalogFullOptionSetPublicationMaterialization(f.source, f.details, {
    tenantReference: tenant,
    brandReference: id(2),
    optionSetReference: f.source.optionSetReference,
    versionReference: f.source.draft.versionReference,
    sourceAggregateVersion: 1,
    publicationOperationReference: id(
      Number.parseInt(f.source.optionSetReference.slice(-12), 16) + 40,
    ),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(
      Number.parseInt(f.source.optionSetReference.slice(-12), 16) + 41,
    ),
    sealedAt: plus(1),
    sourceDigest: full.sourceDigest,
    contentDigest: full.contentDigest,
    configurationDigest: full.configurationDigest,
  }).content;
}
const unavailable = (action: Promise<unknown>) =>
  expect(action).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
function harness(...fixtures: Fixture[]) {
  let time = plus(2);
  const contents = new Map(
    fixtures.map((f) => [
      f.source.optionSetReference + ":" + f.source.draft.versionReference,
      stored(f),
    ]),
  );
  mock.read.mockImplementation(
    async (pin: {
      optionSetReference: string;
      versionReference: string;
      expectedRecordDigest: string | null;
    }) => {
      const content = contents.get(pin.optionSetReference + ":" + pin.versionReference);
      if (!content) throw new CatalogError("CATALOG_UNAVAILABLE");
      if (pin.expectedRecordDigest !== null && pin.expectedRecordDigest !== content.digest)
        throw new CatalogError("CATALOG_VERSION_CONFLICT");
      return { content, observedAt: time, validUntil: plus(7), eligibility: "NotEvaluated" };
    },
  );
  const tx = { query: vi.fn() },
    authority = { holdUntilTransactionCompletes: vi.fn() },
    source = createFrozenFullOptionBindingRuleSource({
      tenantReference: tenant,
      brandReference: id(2),
      actorReference: actor,
      clock: { now: () => time },
      authority,
    });
  return {
    source,
    tx,
    contents,
    setTime: (value: string) => {
      time = value;
    },
  };
}
beforeEach(() => {
  mock.read.mockReset();
  mock.transactions.length = 0;
  mock.publicationOptions.length = 0;
  mock.readerAsync.mockReset();
  mock.readerFinal.mockReset();
});
it("derives complete shared/disabled trigger closure only from exact owning records in the same transaction", async () => {
  const f = fixture(),
    child = fixture(2),
    leaf = fixture(3);
  trigger(f, 0, child);
  trigger(f, 1, child);
  trigger(child, 0, leaf);
  option(f, 1).lifecycle = "Inactive";
  const h = harness(f, child, leaf),
    work = vi.fn(async (result) => result);
  const result = await h.source.withPinnedAssessment(h.tx, binding(f), work);
  expect(result).toMatchObject({
    rules: { status: "Satisfiable", reason: null },
    eligibility: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    validUntil: plus(7),
  });
  expect(result.sourceRecords).toHaveLength(3);
  expect(mock.read).toHaveBeenCalledTimes(6);
  expect(work).toHaveBeenCalledTimes(1);
  expect(mock.transactions.every((tx) => tx === h.tx)).toBe(true);
  expect(h.tx.query).not.toHaveBeenCalled();
  expect(mock.read.mock.calls.slice(0, 3).every(([pin]) => pin.expectedRecordDigest === null)).toBe(
    true,
  );
  expect(
    mock.read.mock.calls.slice(3).every(([pin]) => pin.expectedRecordDigest?.startsWith("sha256:")),
  ).toBe(true);
  expect(result).not.toHaveProperty("witness");
  expect(result).not.toHaveProperty("content");
  expect(result).not.toHaveProperty("binding");
  expect(Object.isFrozen(result.sourceRecords)).toBe(true);
  expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
});
it("acquires even an unselected trigger and reports default infeasibility without promoting eligibility", async () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  f.details.conditionalRules = [
    {
      ruleReference: id(800),
      whenAllSelected: [option(f, 0).optionReference],
      requiredOptionReferences: [option(f, 1).optionReference],
    },
  ];
  const h = harness(f, child);
  const result = await h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r);
  expect(result.rules).toMatchObject({ status: "Unsatisfiable", reason: "NoSelection" });
  expect(result.eligibility).toBe("NotEvaluated");
  expect(result.sourceRecords).toHaveLength(2);
});
it("missing pinned frozen content refuses before work instead of using today's Draft", async () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  const h = harness(f),
    work = vi.fn();
  await expect(h.source.withPinnedAssessment(h.tx, binding(f), work)).rejects.toMatchObject({
    code: "CATALOG_UNAVAILABLE",
  });
  expect(work).not.toHaveBeenCalled();
});
it("cycles remain an explicit mechanical refusal", async () => {
  const f = fixture(),
    child = fixture(2);
  trigger(f, 0, child);
  trigger(child, 0, f);
  const h = harness(f, child);
  const result = await h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r);
  expect(result.rules).toMatchObject({ status: "Unsatisfiable", reason: "TriggerCycle" });
});
it("two source versions of one triggered Set remain Indeterminate", async () => {
  const f = fixture(),
    child = fixture(2),
    other = fixture(2);
  other.source.draft.versionReference = id(290);
  trigger(f, 0, child);
  trigger(f, 1, other);
  const h = harness(f, child, other);
  const result = await h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r);
  expect(result.rules).toMatchObject({
    status: "Indeterminate",
    reason: "AmbiguousTriggerVersion",
  });
});
it("rejects a structural graph beyond32 exact records before work", async () => {
  const fixtures = Array.from({ length: 33 }, (_, i) => fixture(i + 1));
  for (let i = 0; i < 32; i++) {
    const from = fixtures[i],
      to = fixtures[i + 1];
    if (!from || !to) throw new Error("missing fixture");
    trigger(from, 0, to);
  }
  const f = fixtures[0];
  if (!f) throw new Error("missing root");
  const h = harness(...fixtures),
    work = vi.fn();
  await unavailable(h.source.withPinnedAssessment(h.tx, binding(f), work));
  expect(work).not.toHaveBeenCalled();
  expect(mock.read).toHaveBeenCalledTimes(32);
});
it("late current authority denial from the owning reacquisition refuses after consumer work", async () => {
  const f = fixture(),
    h = harness(f);
  let worked = false;
  mock.read.mockImplementationOnce(async () => ({
    content: stored(f),
    observedAt: plus(2),
    validUntil: plus(7),
    eligibility: "NotEvaluated",
  }));
  mock.read.mockImplementationOnce(async () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(
    h.source.withPinnedAssessment(h.tx, binding(f), async () => {
      worked = true;
      return "written";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(worked).toBe(true);
});
it.each(["expiry", "backward"])(
  "rejects consumer %s before any renewed owning read",
  async (mode) => {
    const f = fixture(),
      h = harness(f);
    await unavailable(
      h.source.withPinnedAssessment(h.tx, binding(f), async () => {
        h.setTime(mode === "expiry" ? plus(7) : plus(1));
        return "written";
      }),
    );
    expect(mock.read).toHaveBeenCalledTimes(1);
  },
);
it("does not renew the initial30second deadline from later observations", async () => {
  const f = fixture(),
    h = harness(f);
  mock.read.mockImplementationOnce(async () => ({
    content: stored(f),
    observedAt: plus(2),
    validUntil: plus(32),
    eligibility: "NotEvaluated",
  }));
  mock.read.mockImplementationOnce(async () => {
    h.setTime(plus(32));
    return {
      content: stored(f),
      observedAt: plus(32),
      validUntil: plus(62),
      eligibility: "NotEvaluated",
    };
  });
  await unavailable(
    h.source.withPinnedAssessment(h.tx, binding(f), async () => {
      h.setTime(plus(31));
      return "written";
    }),
  );
});
it("a narrower post-work lease refuses instead of returning an overstated assessment deadline", async () => {
  const f = fixture(),
    h = harness(f);
  mock.read.mockImplementationOnce(async () => ({
    content: stored(f),
    observedAt: plus(2),
    validUntil: plus(7),
    eligibility: "NotEvaluated",
  }));
  mock.read.mockImplementationOnce(async () => ({
    content: stored(f),
    observedAt: plus(2),
    validUntil: plus(6),
    eligibility: "NotEvaluated",
  }));
  await unavailable(h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r));
});
it("rechecks exact original content after work even when an owning response incorrectly retains the digest", async () => {
  const f = fixture(),
    h = harness(f),
    original = stored(f);
  const altered = {
    ...original,
    editorContent: {
      ...original.editorContent,
      sourceAggregate: {
        ...original.editorContent.sourceAggregate,
        draft: {
          ...original.editorContent.sourceAggregate.draft,
          localizedNames: { "en-CA": "Changed copy" },
        },
      },
    },
  };
  mock.read.mockResolvedValueOnce({
    content: original,
    observedAt: plus(2),
    validUntil: plus(7),
    eligibility: "NotEvaluated",
  });
  mock.read.mockResolvedValueOnce({
    content: altered,
    observedAt: plus(2),
    validUntil: plus(7),
    eligibility: "NotEvaluated",
  });
  await unavailable(h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r));
});
it.each(["foreign", "future", "ready", "oversized"])(
  "rejects malformed owning observation %s before work",
  async (mode) => {
    const f = fixture(),
      h = harness(f),
      original = stored(f),
      content = {
        ...original,
        supportedContent: {
          ...original.supportedContent,
          tenantReference: mode === "foreign" ? id(999) : original.supportedContent.tenantReference,
        },
      };
    mock.read.mockResolvedValueOnce({
      content,
      observedAt: mode === "future" ? plus(3) : plus(2),
      validUntil: mode === "oversized" ? plus(33) : plus(7),
      eligibility: mode === "ready" ? "Ready" : "NotEvaluated",
    });
    const work = vi.fn();
    await unavailable(h.source.withPinnedAssessment(h.tx, binding(f), work));
    expect(work).not.toHaveBeenCalled();
  },
);
it("rejects supplied graph/extras/getter without reading the owning source", async () => {
  const f = fixture(),
    h = harness(f),
    b = binding(f),
    getter = vi.fn(() => b.optionSetReference);
  const forged = { ...b };
  Object.defineProperty(forged, "optionSetReference", { enumerable: true, get: getter });
  for (const value of [{ binding: b, graph: input(f) }, { ...b, ready: true }, forged])
    await expect(h.source.withPinnedAssessment(h.tx, value, async (r) => r)).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
  expect(getter).not.toHaveBeenCalled();
  expect(mock.read).not.toHaveBeenCalled();
});
it("bounds raw source errors and does not swallow a consumer failure", async () => {
  const f = fixture(),
    h = harness(f);
  mock.read.mockRejectedValueOnce(new Error("private source detail"));
  await unavailable(h.source.withPinnedAssessment(h.tx, binding(f), async (r) => r));
  await unavailable(
    h.source.withPinnedAssessment(h.tx, binding(f), async () => {
      throw new Error("private work detail");
    }),
  );
});

it("uses owning inherited minimum refusal as Unsatisfiable while retaining exact Frozen rechecks", async () => {
  const f = fixture();
  f.source.draft.minimumSelection = 1;
  const b = binding(f, []);
  const { tx } = harness(f);
  const source = createFrozenFullOptionBindingRuleSource({
    tenantReference: tenant,
    brandReference: id(2),
    actorReference: actor,
    clock: { now: () => plus(2) },
    authority: { holdUntilTransactionCompletes: vi.fn() },
    defaultQuantityAssessment: "Prerequisites",
  });
  const result = await source.withPinnedAssessment(tx, b, async (v) => v);
  expect(result.rules).toMatchObject({ status: "Unsatisfiable", reason: "NoSelection" });
  expect(result.eligibility).toBe("NotEvaluated");
  expect(mock.read).toHaveBeenCalledTimes(2);
});

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
type Mode =
  | "Validate"
  | "SubmitReview"
  | "Approve"
  | "Reject"
  | "Publish"
  | "SchedulePublish"
  | "ReschedulePublish"
  | "CancelScheduledPublish"
  | "ActivateScheduled"
  | "Ack";
function publicationCommand(mode: Mode = "Validate") {
  if (mode === "Ack")
    return parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: tenant,
      brandReference: id(2),
      actorReference: actor,
      actorKind: "User",
      operationReference: id(800),
      productReference: id(801),
      versionReference: id(802),
      expectedProductAggregateVersion: 7,
      reportOperationReference: id(803),
      reportDigest: hash("report"),
      warningBindingDigest: hash("warnings"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_WARNING",
      occurredAt: plus(2),
    });
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: tenant,
    brandReference: id(2),
    actorReference: actor,
    actorKind: mode === "ActivateScheduled" ? "System" : "User",
    operationReference: id(800),
    productReference: id(801),
    versionReference: id(802),
    expectedProductAggregateVersion: 7,
    expectedPublicationVersion: 1,
    action: mode,
    contentDigest: hash("product"),
    configurationDigest: hash("configuration"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: [
      "SchedulePublish",
      "ReschedulePublish",
      "CancelScheduledPublish",
      "ActivateScheduled",
    ].includes(mode)
      ? id(804)
      : null,
    replacementVersionReference: null,
    successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(mode)
      ? id(805)
      : null,
    occurredAt: plus(2),
    reasonCode: "SYNTHETIC",
    replacementIntent: { ...intent, digest: hash(intent) },
    replacementIntentDigest: hash(intent),
  });
}

function publicationHarness(mode: Mode = "Validate", ...fixtures: Fixture[]) {
  const h = harness(...fixtures),
    command = publicationCommand(mode),
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  let time = plus(2),
    commits = 0,
    later: undefined | (() => void);
  const options: Parameters<typeof createProductPublicationFrozenFullOptionBindingRuleSource>[0] = {
    command,
    observedAt: plus(2),
    validUntil: plus(7),
    clock: { now: () => time },
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        return { observedAt: input.observedAt, validUntil: plus(7) };
      },
    },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(h.tx);
      if (guards.length >= 64) throw Error("Host guard capacity exceeded");
      guards.push({ guard, final });
    },
  };
  const source = createProductPublicationFrozenFullOptionBindingRuleSource(options);
  return {
    ...h,
    command,
    options,
    source,
    guards,
    setTime(value: string) {
      time = value;
      h.setTime(value);
    },
    later(work: () => void) {
      later = work;
    },
    commits: () => commits,
    async commit(work: () => Promise<unknown>) {
      const result = await work();
      for (const g of guards) await g.guard();
      later?.();
      for (const g of guards) expect(g.final()).toBeUndefined();
      commits++;
      return result;
    },
  };
}
it.each(["Validate", "Publish", "ActivateScheduled", "Ack"] as const)(
  "fixed %s source preserves real command and complete trigger graph without old User authority",
  async (mode) => {
    const f = fixture(),
      child = fixture(2);
    trigger(f, 0, child);
    const h = publicationHarness(mode, f, child),
      work = vi.fn(async (value: unknown) => value);
    const result = await h.commit(() => h.source.withPinnedAssessment(h.tx, binding(f), work));
    expect(work).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        observedAt: plus(2),
        validUntil: plus(7),
        eligibility: "NotEvaluated",
        referenceEligibility: "NotEvaluated",
        publishValidation: "Incomplete",
      }),
    );
    expect(mock.transactions.every((tx) => tx === h.tx)).toBe(true);
    expect(mock.publicationOptions).toHaveLength(1);
    expect(mock.publicationOptions[0]).toEqual(
      expect.objectContaining({ command: h.command, observedAt: plus(2), validUntil: plus(7) }),
    );
    expect(h.commits()).toBe(1);
  },
);
it("fixed source poisons caught graph reentry rather than committing the outer consumer", async () => {
  const f = fixture(),
    h = publicationHarness("Validate", f),
    inner = vi.fn();
  let outer = 0;
  await unavailable(
    h.commit(() =>
      h.source.withPinnedAssessment(h.tx, binding(f), async () => {
        outer++;
        try {
          await h.source.withPinnedAssessment(h.tx, binding(f), inner);
        } catch {
          return "caught";
        }
        return "unexpected";
      }),
    ),
  );
  expect(outer).toBe(1);
  expect(inner).not.toHaveBeenCalled();
  expect(h.commits()).toBe(0);
});
it("fixed source registers a rejecting guard before a caught missing graph", async () => {
  const f = fixture(),
    h = publicationHarness("Validate", f);
  mock.read.mockRejectedValue(new CatalogError("CATALOG_UNAVAILABLE"));
  await unavailable(
    h.commit(async () => {
      try {
        await h.source.withPinnedAssessment(h.tx, binding(f), async () => "wrong");
      } catch {
        return "caught";
      }
      return "wrong";
    }),
  );
  expect(h.commits()).toBe(0);
});
it("fixed source final assertion retains its original five-second deadline after other guards", async () => {
  const f = fixture(),
    h = publicationHarness("ActivateScheduled", f);
  h.later(() => h.setTime(plus(7)));
  await unavailable(
    h.commit(() => h.source.withPinnedAssessment(h.tx, binding(f), async () => "consumer")),
  );
  expect(h.commits()).toBe(0);
});
it("fixed source detects partial clock rollback during the held consumer", async () => {
  const f = fixture(),
    h = publicationHarness("Ack", f);
  h.setTime(plus(4));
  await unavailable(
    h.commit(() =>
      h.source.withPinnedAssessment(h.tx, binding(f), async () => {
        h.setTime(plus(3));
        return "consumer";
      }),
    ),
  );
  expect(h.commits()).toBe(0);
});
it("fixed source refuses query replacement and caught consumer exceptions", async () => {
  const f = fixture(),
    h = publicationHarness("Publish", f);
  await unavailable(
    h.commit(() =>
      h.source.withPinnedAssessment(h.tx, binding(f), async () => {
        h.tx.query = vi.fn();
        return "consumer";
      }),
    ),
  );
  expect(h.commits()).toBe(0);
  const j = publicationHarness("Publish", f);
  await unavailable(
    j.commit(async () => {
      try {
        await j.source.withPinnedAssessment(j.tx, binding(f), async () => {
          throw Error("consumer failure");
        });
      } catch {
        return "caught";
      }
      return "wrong";
    }),
  );
  expect(j.commits()).toBe(0);
});
it("fixed source captures command and configured ports before acquisition", async () => {
  const f = fixture(),
    h = publicationHarness("Ack", f);
  h.options.clock.now = () => {
    throw Error("replaced clock");
  };
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("replaced authority");
  };
  await h.commit(() => h.source.withPinnedAssessment(h.tx, binding(f), async (v) => v));
  expect(mock.publicationOptions[0]).toEqual(expect.objectContaining({ command: h.command }));
  expect(h.commits()).toBe(1);
});
function maximumGraph() {
  const root = fixture(1, 31),
    children = Array.from({ length: 31 }, (_, i) => fixture(i + 2, 1));
  children.forEach((child, index) => trigger(root, index, child));
  return { root, children };
}
it("holds all 32 graph nodes using one real host slot while retaining 64 independent reader guards", async () => {
  const { root, children } = maximumGraph(),
    h = publicationHarness("Publish", root, ...children);
  const result = await h.commit(() =>
    h.source.withPinnedAssessment(h.tx, binding(root), async (v) => v),
  );
  expect(result).toEqual(expect.objectContaining({ sourceRecords: expect.any(Array) }));
  expect(h.guards).toHaveLength(1);
  expect(mock.read).toHaveBeenCalledTimes(64);
  expect(mock.readerAsync).toHaveBeenCalledTimes(64);
  expect(mock.readerFinal).toHaveBeenCalledTimes(64);
  expect(h.commits()).toBe(1);
});
it("runs every child final assertion after global async guards and rejects a late last-child failure", async () => {
  const { root, children } = maximumGraph(),
    h = publicationHarness("ActivateScheduled", root, ...children),
    error = new CatalogError("CATALOG_PERMISSION_DENIED");
  let late = false,
    finals = 0;
  h.later(() => {
    late = true;
  });
  mock.readerFinal.mockImplementation(() => {
    if (++finals === 64 && late) throw error;
  });
  await expect(
    h.commit(() => h.source.withPinnedAssessment(h.tx, binding(root), async (v) => v)),
  ).rejects.toBe(error);
  expect(h.guards).toHaveLength(1);
  expect(mock.readerAsync).toHaveBeenCalledTimes(64);
  expect(mock.readerFinal).toHaveBeenCalledTimes(64);
  expect(h.commits()).toBe(0);
});

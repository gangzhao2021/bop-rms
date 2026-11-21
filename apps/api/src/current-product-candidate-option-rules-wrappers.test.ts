import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createCurrentProductCandidateOptionRuleSource } from "./current-product-candidate-option-rules.js";
const mock = vi.hoisted(() => ({ candidate: vi.fn(), option: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductValidationCandidateSource: () => ({ withCurrentCandidate: mock.candidate }),
}));
vi.mock("./frozen-full-option-binding-rule-source.js", () => ({
  createFrozenFullOptionBindingRuleSource: () => ({ withPinnedAssessment: mock.option }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T10:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString();
function fixture(count = 2) {
  const bindings = Array.from({ length: count }, (_, i) => ({
    bindingReference: id(100 + i),
    optionSetReference: id(200 + i),
    optionSetVersionReference: id(300 + i),
    purpose: "CUSTOMIZATION",
    sortOrder: i,
    enabledOptionReferences: [],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: [],
    storeOverrideAllowed: false,
  }));
  const candidate = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    completeContent: "Present",
    observedAt: at,
    validUntil: plus(30),
    contentDigest: "sha256:" + "a".repeat(64),
    configurationDigest: "sha256:" + "b".repeat(64),
    originalIntentDigest: "sha256:" + "c".repeat(64),
    aggregate: {
      productReference: id(6),
      aggregateVersion: 1,
      draft: {
        versionReference: id(7),
        optionBindings: [...bindings].reverse(),
        editorContent: {
          optionRules: bindings.map((b) => ({
            bindingReference: b.bindingReference,
            versionResolution: "Pinned",
          })),
        },
      },
    },
  };
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(5),
    productReference: id(6),
    versionReference: id(7),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: candidate.contentDigest,
    configurationDigest: candidate.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_WRAPPER",
  };
  candidate.originalIntentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
  const tx = { query: vi.fn() },
    order: string[] = [],
    state = { now: at };
  const sourceFor = (binding: (typeof bindings)[number]) => ({
    profile: "FrozenFullOptionBindingRuleAssessmentV1",
    tenantReference: id(1),
    brandReference: id(2),
    bindingReference: binding.bindingReference,
    bindingDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(binding)),
    rootOptionSetReference: binding.optionSetReference,
    rootVersionReference: binding.optionSetVersionReference,
    graphDigest: "sha256:" + "d".repeat(64),
    digest: "sha256:" + "e".repeat(64),
    sourceRecords: [],
    observedAt: at,
    validUntil: plus(binding.sortOrder === 0 ? 5 : 10),
    rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  mock.candidate.mockImplementation(async (_value, work) => {
    order.push("candidate enter");
    const result: unknown = await work(candidate, tx);
    order.push("candidate exit");
    return result;
  });
  mock.option.mockImplementation(async (actualTx, binding, work) => {
    expect(actualTx).toBe(tx);
    order.push("option enter " + binding.sortOrder);
    const result: unknown = await work(sourceFor(binding));
    order.push("option exit " + binding.sortOrder);
    return result;
  });
  const source = createCurrentProductCandidateOptionRuleSource({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => state.now },
    candidateAuthority: { holdUntilTransactionCompletes: async () => undefined },
    optionAuthority: {
      holdUntilTransactionCompletes: async () => ({ observedAt: at, validUntil: plus(5) }),
    },
  });
  return { bindings, candidate, command, tx, order, state, sourceFor, source };
}
beforeEach(() => {
  mock.candidate.mockReset();
  mock.option.mockReset();
});
it("nests all stored Bindings in sorted order and preserves result identity and original shortest lease", async () => {
  const x = fixture(),
    result = {};
  const answer = await x.source.withCurrentAssessment(x.tx, x.command, async (a) => {
    x.order.push("consumer");
    expect(a.bindingCount).toBe(2);
    expect(a.validUntil).toBe(plus(5));
    expect(a.bindings.map((b) => b.bindingReference)).toEqual(
      x.bindings.map((b) => b.bindingReference),
    );
    expect(a.originalIntentDigest).toBe(x.candidate.originalIntentDigest);
    expect(a.publishValidation).toBe("Incomplete");
    expect(a.eligibility).toBe("NotEvaluated");
    expect(a).not.toHaveProperty("aggregate");
    expect(a.bindings[0]).not.toHaveProperty("sourceRecords");
    expect(Object.isFrozen(a.bindings)).toBe(true);
    return result;
  });
  expect(answer).toBe(result);
  expect(x.order).toEqual([
    "candidate enter",
    "option enter 0",
    "option enter 1",
    "consumer",
    "option exit 1",
    "option exit 0",
    "candidate exit",
  ]);
});
it("empty Bindings are an explicit unevaluated subset", async () => {
  const x = fixture(0);
  const a = await x.source.withCurrentAssessment(x.tx, x.command, async (a) => a);
  expect(a.bindingCount).toBe(0);
  expect(a.bindings).toEqual([]);
  expect(a.validUntil).toBe(plus(30));
  expect(a.publishValidation).toBe("Incomplete");
  expect(mock.option).not.toHaveBeenCalled();
});
for (const mode of [
  "CurrentPublished",
  "missing",
  "too many",
  "incomplete",
  "foreign transaction",
]) {
  it(`refuses unsupported candidate ${mode} before historical Option acquisition`, async () => {
    const x = fixture(mode === "too many" ? 33 : 1),
      work = vi.fn();
    if (mode === "CurrentPublished")
      for (const rule of x.candidate.aggregate.draft.editorContent.optionRules)
        rule.versionResolution = mode;
    if (mode === "missing") x.candidate.aggregate.draft.editorContent.optionRules = [];
    if (mode === "incomplete") x.candidate.completeContent = "Missing";
    if (mode === "foreign transaction")
      mock.candidate.mockImplementation(async (_v, cb) => cb(x.candidate, {}));
    await expect(x.source.withCurrentAssessment(x.tx, x.command, work)).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(mock.option).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
}
for (const mode of [
  "binding",
  "root",
  "scope",
  "renewed lease",
  "future observation",
  "eligibility",
]) {
  it(`refuses mismatched or unsupported owning assessment ${mode}`, async () => {
    const x = fixture(1),
      work = vi.fn();
    mock.option.mockImplementation(async (_tx, binding, cb) => {
      const a = x.sourceFor(binding);
      if (mode === "binding") a.bindingDigest = "sha256:" + "f".repeat(64);
      if (mode === "root") a.rootVersionReference = id(99);
      if (mode === "scope") a.tenantReference = id(99);
      if (mode === "renewed lease") a.validUntil = plus(31);
      if (mode === "future observation") {
        a.observedAt = plus(1);
        a.validUntil = plus(5);
      }
      if (mode === "eligibility") a.eligibility = "Ready";
      return cb(a);
    });
    await expect(x.source.withCurrentAssessment(x.tx, x.command, work)).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(work).not.toHaveBeenCalled();
  });
}
for (const mode of ["consumer", "final candidate"]) {
  it(`keeps the earliest Option deadline after ${mode}`, async () => {
    const x = fixture(1),
      work = vi.fn(async () => {
        if (mode === "consumer") x.state.now = plus(5);
        return {};
      });
    if (mode === "final candidate")
      mock.candidate.mockImplementation(async (_v, cb) => {
        const r: unknown = await cb(x.candidate, x.tx);
        x.state.now = plus(5);
        return r;
      });
    await expect(x.source.withCurrentAssessment(x.tx, x.command, work)).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(work).toHaveBeenCalledOnce();
  });
}
for (const mode of [
  "candidate repeats",
  "option repeats",
  "candidate changes result",
  "option changes result",
]) {
  it(`rejects invalid owning wrapper completion ${mode}`, async () => {
    const x = fixture(1),
      work = vi.fn(async () => ({}));
    if (mode.startsWith("candidate"))
      mock.candidate.mockImplementation(async (_v, cb) => {
        const r: unknown = await cb(x.candidate, x.tx);
        if (mode.endsWith("repeats")) await cb(x.candidate, x.tx);
        return mode.endsWith("result") ? {} : r;
      });
    else
      mock.option.mockImplementation(async (_tx, b, cb) => {
        const r: unknown = await cb(x.sourceFor(b));
        if (mode.endsWith("repeats")) await cb(x.sourceFor(b));
        return mode.endsWith("result") ? {} : r;
      });
    await expect(x.source.withCurrentAssessment(x.tx, x.command, work)).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(work).toHaveBeenCalledOnce();
  });
}

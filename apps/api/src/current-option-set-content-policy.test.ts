import { beforeEach, expect, it, vi } from "vitest";
import {
  parseCatalogOptionSetEditorContent,
  evaluateCatalogOptionSetRuleSatisfiability,
} from "@rms/catalog";
import { createCurrentOptionSetContentPolicySource } from "./current-option-set-content-policy.js";
const state = vi.hoisted(() => ({
  at: "2026-09-30T12:00:00.000Z",
  mode: "Once",
  body: undefined as unknown,
  until: "2026-09-30T12:00:30.000Z",
  observed: "2026-09-30T12:00:00.000Z",
  calls: 0,
}));
vi.mock("./current-option-set-publication-policy.js", () => ({
  // Synthetic holder protocol only. Actual SQL/current acquisition is evidenced separately in51.
  createCurrentOptionSetPublicationPolicySource: (options: {
    tenantReference: string;
    brandReference: string;
  }) => ({
    context: options,
    async withCurrentPolicy(
      _tx: unknown,
      input: { optionSetReference: string; observedAt: string },
      work: (v: unknown) => Promise<unknown>,
    ) {
      state.calls++;
      if (state.mode === "NoCall") return "synthetic";
      if (state.mode === "InitialDenial") throw new Error("synthetic denial");
      const source = {
        profile: "CurrentOptionSetPublicationPolicyV1",
        content: state.body,
        currentPublicationReference: "01902421-0000-7000-8000-000000000006",
        optionSetReference: input.optionSetReference,
        originalObservedAt: input.observedAt,
        observedAt: state.observed,
        validUntil: state.until,
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      };
      const result = await work(
        state.mode === "Ready" ? { ...source, eligibility: "Ready" } : source,
      );
      if (state.mode === "Twice") await work(source);
      if (state.mode === "LateDenial") throw new Error("synthetic late denial");
      if (state.mode === "WrongReturn") return "different synthetic return";
      if (state.mode === "LateExpiry") state.at = state.until;
      return result;
    },
  }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  end = "2026-09-30T12:00:30.000Z";
function fixture() {
  const source = {
    optionSetReference: id(100),
    brandReference: id(2),
    internalCode: "EMPTY_SYNTHETIC",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(101),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      localizedDescriptions: {},
      displayStyle: "Quantity",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: true,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [],
      createdAt: at,
      updatedAt: at,
    },
  };
  const parsed = parseCatalogOptionSetEditorContent(source, {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  });
  const graph = {
    brandReference: id(2),
    rootOptionSetReference: id(100),
    rootVersionReference: id(101),
    contents: [parsed.content],
  };
  const binding = {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(100),
    versionReference: id(101),
    expectedAggregateVersion: 1,
    sourceDigest: parsed.sourceDigest,
    contentDigest: parsed.contentDigest,
    configurationDigest: parsed.configurationDigest,
    graphDigest: evaluateCatalogOptionSetRuleSatisfiability(graph).graphDigest,
    originalIntentDigest: "sha256:" + "a".repeat(64),
    observedAt: at,
    validUntil: end,
    activationAt: "2026-09-30T12:00:10.000Z",
  };
  state.body = {
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(4),
    policyReference: id(5),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User" as const,
    clock: { now: () => state.at },
    authority: {
      holdUntilTransactionCompletes: vi.fn(async () => ({ observedAt: state.at, validUntil: end })),
    },
  };
  return {
    provider: createCurrentOptionSetContentPolicySource(options),
    tx: { query: vi.fn(async () => ({ rows: [] })) },
    input: {
      graph,
      binding,
      policyRequest: {
        optionSetReference: id(100),
        policyReference: id(5),
        policyVersion: 1,
        observedAt: at,
      },
    },
    options,
  };
}
beforeEach(() => {
  Object.assign(state, { at, observed: at, until: end, mode: "Once", calls: 0 });
});
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("binds source provenance and supplied graph while retaining every unassessed prerequisite", async () => {
  const f = fixture(),
    callback = vi.fn(async (v) => v);
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, callback);
  expect(callback).toHaveBeenCalledOnce();
  expect(state.calls).toBe(1);
  expect(r).toMatchObject({
    decision: "PassForAssessedRules",
    originalObservedAt: at,
    observedAt: at,
    validUntil: end,
    currentPolicyPublicationReference: id(6),
    referenceEligibility: "NotEvaluated",
    scopeTopology: "NotEvaluated",
    independentApproval: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
  expect(r.currentAssessmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(r)).toBe(true);
});
it("keeps original clock cap while recording later actual policy observation and earlier lease", async () => {
  const f = fixture();
  state.at = state.observed = "2026-09-30T12:00:05.000Z";
  state.until = "2026-09-30T12:00:20.000Z";
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(r).toMatchObject({
    originalObservedAt: at,
    observedAt: state.observed,
    validUntil: state.until,
  });
  expect(r.activationAt).toBe(f.input.binding.activationAt);
});
it("candidate HardError is reported without readiness and still passes through final source hold", async () => {
  const f = fixture();
  state.body = { ...(state.body as object), requiredLocales: ["fr-CA"] };
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(r.decision).toBe("HardError");
  expect(r.publishValidation).toBe("Incomplete");
  state.mode = "LateDenial";
  await expect(
    f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v),
  ).rejects.toThrowError(refused);
});
it.each(["InitialDenial", "LateDenial", "NoCall", "Twice", "WrongReturn", "LateExpiry", "Ready"])(
  "refuses synthetic holder violation %s and poisons transaction identity",
  async (mode) => {
    const f = fixture();
    state.mode = mode;
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => "synthetic result"),
    ).rejects.toThrowError(refused);
    state.mode = "Once";
    state.at = at;
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => "retry"),
    ).rejects.toThrowError(refused);
    expect(state.calls).toBe(1);
  },
);
it.each(["2026-09-30T12:00:30.001Z", at, "2026-09-30T12:00:31.000Z"])(
  "refuses invalid source lease %s",
  async (until) => {
    const f = fixture();
    state.until = until;
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => 1),
    ).rejects.toThrowError(refused);
  },
);
it("captures clock method, detaches input and refuses late query method replacement", async () => {
  const f = fixture();
  f.options.clock.now = () => "2030-01-01T00:00:00.000Z";
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => {
    f.input.binding.graphDigest = "sha256:" + "b".repeat(64);
    return v;
  });
  expect(r.graphDigest).not.toBe(f.input.binding.graphDigest);
  const fresh = fixture();
  await expect(
    fresh.provider.withCurrentAssessment(fresh.tx, fresh.input, async () => {
      fresh.tx.query = vi.fn(async () => ({ rows: [] }));
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it.each(["2026-09-30T11:59:59.999Z", end])(
  "refuses backward/current expired clock %s after work",
  async (next) => {
    const f = fixture();
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => {
        state.at = next;
        return 1;
      }),
    ).rejects.toThrowError(refused);
  },
);
it("caught recursive failure invalidates the outer callback and further admissions", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentAssessment(f.tx, f.input, async () => {
      await expect(
        f.provider.withCurrentAssessment(f.tx, f.input, async () => 2),
      ).rejects.toThrowError(refused);
      return 1;
    }),
  ).rejects.toThrowError(refused);
  expect(state.calls).toBe(1);
});
it.each(["tenantReference", "brandReference", "optionSetReference"])(
  "refuses foreign %s before acquiring source",
  async (key) => {
    const f = fixture();
    const input = { ...f.input, binding: { ...f.input.binding, [key]: id(999) } };
    await expect(f.provider.withCurrentAssessment(f.tx, input, async () => 1)).rejects.toThrowError(
      refused,
    );
    expect(state.calls).toBe(0);
  },
);
it("refuses stale policy/version, readiness extras and getters without execution", async () => {
  for (const override of [
    { policyReference: id(999) },
    { policyVersion: 2 },
    { observedAt: end },
  ]) {
    const f = fixture();
    await expect(
      f.provider.withCurrentAssessment(
        f.tx,
        { ...f.input, policyRequest: { ...f.input.policyRequest, ...override } },
        async () => 1,
      ),
    ).rejects.toThrowError(refused);
  }
  const before = state.calls;
  const f = fixture(),
    getter = vi.fn(() => f.input.graph),
    input = { ...f.input };
  Object.defineProperty(input, "graph", { get: getter, enumerable: true });
  await expect(f.provider.withCurrentAssessment(f.tx, input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(state.calls).toBe(before);
  const fresh = fixture();
  await expect(
    fresh.provider.withCurrentAssessment(fresh.tx, { ...fresh.input, Ready: true }, async () => 1),
  ).rejects.toThrowError(refused);
});

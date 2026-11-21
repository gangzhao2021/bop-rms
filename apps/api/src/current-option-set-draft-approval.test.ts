import { beforeEach, expect, it, vi } from "vitest";
import {
  createCurrentOptionSetDraftApprovalSource,
  currentOptionSetApprovalFields,
} from "./current-option-set-draft-approval.js";
const state = vi.hoisted(() => ({
  mode: "Once",
  decision: "PassForAssessedRules",
  calls: 0,
  reads: 0,
  publication: "",
  source: "",
  approvalEnd: "",
  approvalMode: "Once",
}));
vi.mock("./current-option-set-draft-policy.js", () => ({
  createCurrentOptionSetDraftPolicySource: () => ({
    async withCurrentAssessment(
      _tx: unknown,
      input: {
        graphRequest: Record<string, unknown>;
        originalIntentDigest: string;
        activationAt: string;
      },
      work: (v: unknown) => Promise<unknown>,
    ) {
      state.calls++;
      if (state.mode === "NoCall") return 1;
      const r = input.graphRequest;
      const value = {
        originalObservedAt: r.observedAt,
        validUntil: r.validUntil,
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
        currentRootEvidence: {
          ...r,
          aggregateVersion: r.expectedAggregateVersion,
          graphDigest: "sha256:" + "d".repeat(64),
        },
        assessment: {
          ...r,
          originalIntentDigest: input.originalIntentDigest,
          graphDigest: "sha256:" + "d".repeat(64),
          policyReference: id(5),
          policyVersion: 1,
          policyContentDigest: "sha256:" + "e".repeat(64),
          currentPolicyPublicationReference: state.publication,
          decision: state.decision,
        },
      };
      const result = await work(value);
      if (state.mode === "Twice") await work(value);
      if (state.mode === "LateDenial") throw Error("synthetic late owner denial");
      return state.mode === "WrongReturn" ? null : result;
    },
  }),
}));
vi.mock("@bop/publishing", async (original) => {
  const real = await original<typeof import("@bop/publishing")>();
  return {
    ...real,
    createPostgresPublishingMutationStore: () => ({
      async resolveCurrentIndependentApproval(input: {
        familyReference: string;
        lifecycleReference: string;
        configurationType: string;
        purposeCode: string;
        snapshotReference: string;
        snapshotDigest: string;
        requiredCheckCodes: readonly string[];
        observedAt: string;
      }) {
        state.reads++;
        if (state.approvalMode === "Refuse") throw Error("synthetic owner refusal");
        return {
          profile: "CurrentIndependentPublishingApprovalV1",
          tenantReference: id(1),
          scope: { kind: "Brand", brandReference: id(2), storeReference: null },
          ...input,
          validationCheckCodes: input.requiredCheckCodes,
          sourceDigest: state.source,
          approvalOperationReference: id(12),
          approvalEvidenceReference: id(13),
          recordedIndependence: "Verified",
          currentValidation: "NotEvaluated",
          referenceEligibility: "NotEvaluated",
          eligibility: "NotEvaluated",
          validUntil: state.approvalEnd,
          ...(state.approvalMode === "Foreign" ? { tenantReference: id(999) } : {}),
        };
      },
    }),
  };
});
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z",
  end = "2026-09-30T12:00:10.000Z",
  d = (s: string) => "sha256:" + s.repeat(64);
function fixture() {
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  let clock = at;
  const authority = {
    holdUntilTransactionCompletes: vi.fn(
      async (
        actualTx: unknown,
        input: { observedAt: string; requiredFields: readonly string[] },
      ) => {
        expect(actualTx).toBe(tx);
        expect(input.requiredFields).toEqual(currentOptionSetApprovalFields);
        return { observedAt: input.observedAt, validUntil: end };
      },
    ),
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(20),
    clock: { now: () => clock },
    readAuthority: {
      holdUntilTransactionCompletes: async () => ({ observedAt: at, validUntil: end }),
    },
    policyAuthority: {
      holdUntilTransactionCompletes: async () => ({ observedAt: at, validUntil: end }),
    },
    approvalAuthority: authority,
  };
  const input = {
    graphRequest: {
      optionSetReference: id(100),
      versionReference: id(101),
      expectedAggregateVersion: 1,
      sourceDigest: d("a"),
      contentDigest: d("b"),
      configurationDigest: d("c"),
      observedAt: at,
      validUntil: end,
    },
    policyRequest: {
      optionSetReference: id(100),
      policyReference: id(5),
      policyVersion: 1,
      observedAt: at,
    },
    originalIntentDigest: d("f"),
    activationAt: "2026-09-30T12:00:05.000Z",
  };
  const source = createCurrentOptionSetDraftApprovalSource(options);
  return {
    tx,
    input,
    source,
    authority,
    options,
    advance: (v: string) => {
      clock = v;
    },
    async envelope() {
      const p = await source.withCurrentReviewBinding(tx, input, async (v) => v);
      return {
        assessmentRequest: input,
        reviewLifecycleReference: id(11),
        expectedReviewBindingDigest: p.reviewBinding.digest,
      };
    },
  };
}
beforeEach(() =>
  Object.assign(state, {
    mode: "Once",
    decision: "PassForAssessedRules",
    calls: 0,
    reads: 0,
    publication: id(6),
    source: d("1"),
    approvalEnd: "2026-09-30T12:00:08.000Z",
    approvalMode: "Once",
  }),
);
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("prepares stable intent and separately holds and rereads exact recorded approval", async () => {
  const f = fixture(),
    envelope = await f.envelope();
  f.advance("2026-09-30T12:00:01.000Z");
  const r = await f.source.withCurrentApproval(f.tx, envelope, async (v) => v);
  expect(r.reviewBinding.digest).toBe(envelope.expectedReviewBindingDigest);
  expect(r.validUntil).toBe(state.approvalEnd);
  expect(r.recordedApproval?.recordedIndependence).toBe("Verified");
  expect(r.currentValidation).toBe("NotEvaluated");
  expect(r.publishValidation).toBe("Incomplete");
  expect(r.eligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(r)).toBe(true);
  expect(state.reads).toBe(2);
  expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(3);
});
it.each(["HardError", "Indeterminate"])(
  "allows preparation but refuses consuming approval after %s",
  async (decision) => {
    const f = fixture();
    state.decision = decision;
    const e = await f.envelope();
    await expect(f.source.withCurrentApproval(f.tx, e, async () => 1)).rejects.toThrowError(
      refused,
    );
    expect(state.reads).toBe(0);
  },
);
it.each(["publication", "intent", "revision", "activation"])(
  "refuses current binding drift %s before approval lookup",
  async (mode) => {
    const f = fixture(),
      e = await f.envelope();
    if (mode === "publication") state.publication = id(999);
    if (mode === "intent") f.input.originalIntentDigest = d("0");
    if (mode === "revision") f.input.graphRequest.expectedAggregateVersion = 2;
    if (mode === "activation") f.input.activationAt = "2026-09-30T12:00:06.000Z";
    await expect(f.source.withCurrentApproval(f.tx, e, async () => 1)).rejects.toThrowError(
      refused,
    );
    expect(state.reads).toBe(0);
  },
);
it.each(["NoCall", "Twice", "WrongReturn", "LateDenial"])(
  "refuses owning protocol %s",
  async (mode) => {
    const f = fixture();
    state.mode = mode;
    await expect(
      f.source.withCurrentReviewBinding(f.tx, f.input, async () => 1),
    ).rejects.toThrowError(refused);
  },
);
it.each(["Refuse", "Foreign"])("refuses current recorded approval %s", async (mode) => {
  const f = fixture(),
    e = await f.envelope();
  state.approvalMode = mode;
  const callback = vi.fn(async () => 1);
  await expect(f.source.withCurrentApproval(f.tx, e, callback)).rejects.toThrowError(refused);
  expect(callback).not.toHaveBeenCalled();
});
it.each(["fields", "window", "expiry", "backward", "head", "query"])(
  "refuses late %s",
  async (mode) => {
    const f = fixture(),
      e = await f.envelope();
    await expect(
      f.source.withCurrentApproval(f.tx, e, async () => {
        if (mode === "fields")
          f.authority.holdUntilTransactionCompletes.mockImplementation(async () => {
            throw Error("synthetic denial");
          });
        if (mode === "window")
          f.authority.holdUntilTransactionCompletes.mockImplementation(async (_tx, input) => ({
            observedAt: input.observedAt,
            validUntil: "2026-09-30T12:00:04.000Z",
          }));
        if (mode === "expiry") f.advance(state.approvalEnd);
        if (mode === "backward") f.advance("2026-09-30T11:59:59.999Z");
        if (mode === "head") state.source = d("2");
        if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
        return 1;
      }),
    ).rejects.toThrowError(refused);
  },
);
it("captures clock and hold method, detaches original intent", async () => {
  const f = fixture(),
    e = await f.envelope();
  f.options.clock.now = () => end;
  f.options.approvalAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("replacement");
  });
  const r = await f.source.withCurrentApproval(f.tx, e, async (v) => {
    f.input.originalIntentDigest = d("0");
    return v;
  });
  expect(r.reviewBinding.originalIntentDigest).toBe(d("f"));
});
it("poisons caught recursion and later attempts in same caller UoW", async () => {
  const f = fixture(),
    e = await f.envelope();
  await expect(
    f.source.withCurrentApproval(f.tx, e, async () => {
      await expect(f.source.withCurrentApproval(f.tx, e, async () => 1)).rejects.toThrowError(
        refused,
      );
      return 1;
    }),
  ).rejects.toThrowError(refused);
  const reads = state.reads;
  await expect(f.source.withCurrentApproval(f.tx, e, async () => 1)).rejects.toThrowError(refused);
  expect(state.reads).toBe(reads);
});
it("refuses injected readiness and getters without evaluating them", async () => {
  const f = fixture(),
    e = await f.envelope(),
    getter = vi.fn(() => e.assessmentRequest);
  Object.defineProperty(e, "assessmentRequest", { get: getter, enumerable: true });
  await expect(f.source.withCurrentApproval(f.tx, e, async () => 1)).rejects.toThrowError(refused);
  expect(getter).not.toHaveBeenCalled();
  const g = fixture(),
    other = await g.envelope();
  await expect(
    g.source.withCurrentApproval(g.tx, { ...other, Ready: true }, async () => 1),
  ).rejects.toThrowError(refused);
});

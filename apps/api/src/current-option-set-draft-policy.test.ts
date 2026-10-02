import { beforeEach, expect, it, vi } from "vitest";
import { parseCatalogOptionSetEditorContent } from "@rms/catalog";
import { createCurrentOptionSetDraftPolicySource } from "./current-option-set-draft-policy.js";
const state = vi.hoisted(() => ({
  body: undefined as unknown,
  policyMode: "Once",
  policyCalls: 0,
  policyBody: undefined as unknown,
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

vi.mock("./current-option-set-publication-policy.js", () => ({
  // Synthetic policy-holder protocol; actual combined PostgreSQL acquisition is checked separately.
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
      state.policyCalls++;
      if (state.policyMode === "InitialDenial") throw new Error("synthetic denial");
      if (state.policyMode === "NoCall") return 1;
      const value = {
        profile: "CurrentOptionSetPublicationPolicyV1",
        content: state.policyBody,
        currentPublicationReference: id(6),
        optionSetReference: input.optionSetReference,
        originalObservedAt: input.observedAt,
        observedAt: state.observed,
        validUntil: end,
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      };
      const result = await work(value);
      if (state.policyMode === "Twice") await work(value);
      if (state.policyMode === "LateDenial") throw new Error("synthetic late denial");
      return state.policyMode === "WrongReturn" ? "synthetic wrong" : result;
    },
  }),
}));
function fixture(trigger = false) {
  const p = content(trigger),
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
  state.policyBody = {
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
    mediaRequirement: "Required",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => clock },
    readAuthority: {
      holdUntilTransactionCompletes: vi.fn(
        async (actualTx: unknown, input: { observedAt: string }) => {
          expect(actualTx).toBe(tx);
          return { observedAt: input.observedAt, validUntil: end };
        },
      ),
    },
    policyAuthority: {
      holdUntilTransactionCompletes: vi.fn(async () => ({ observedAt: at, validUntil: end })),
    },
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
      validUntil: "2026-09-30T12:00:10.000Z",
    },
    policyRequest: {
      optionSetReference: id(100),
      policyReference: id(5),
      policyVersion: 1,
      observedAt: at,
    },
    originalIntentDigest: "sha256:" + "a".repeat(64),
    activationAt: at,
  };
  return {
    provider: createCurrentOptionSetDraftPolicySource(options),
    tx,
    input,
    options,
    advance: (to: string) => {
      clock = to;
    },
  };
}
beforeEach(() => {
  Object.assign(state, { calls: 0, policyCalls: 0, policyMode: "Once", until: end, observed: at });
});
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("binds actual root protocol to current policy and preserves incomplete qualification", async () => {
  const f = fixture();
  const result = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(result.profile).toBe("CurrentOptionSetDraftPolicyAssessmentV1");
  expect(result.validUntil).toBe(f.input.graphRequest.validUntil);
  expect(result.currentRootEvidence.sourceAuthority).toBe("CurrentDraftRootOnly");
  expect(result.assessment.sourceAuthority).toBe("NotEvaluated");
  expect(result.assessment.decision).toBe("HardError");
  expect(result.assessment.originalIntentDigest).toBe(f.input.originalIntentDigest);
  expect(result.assessment.currentPolicyPublicationReference).toBe(id(6));
  expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.currentRootEvidence)).toBe(true);
  expect(state.calls).toBe(2);
  expect(state.policyCalls).toBe(1);
  expect(JSON.stringify(result)).not.toContain("Synthetic");
});
it.each(["InitialDenial", "LateDenial", "NoCall", "Twice", "WrongReturn"])(
  "refuses source protocol %s",
  async (mode) => {
    const f = fixture();
    state.policyMode = mode;
    await expect(
      f.provider.withCurrentAssessment(f.tx, f.input, async () => 1),
    ).rejects.toThrowError(refused);
  },
);
it.each(["2026-09-30T11:59:59.999Z", "2026-09-30T12:00:10.000Z"])(
  "refuses original clock boundary %s",
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
it("refuses caught recursion and poisons subsequent admission", async () => {
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
it("refuses unresolved child before acquiring policy", async () => {
  const f = fixture(true);
  await expect(f.provider.withCurrentAssessment(f.tx, f.input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(state.policyCalls).toBe(0);
});
it("captures clock, detaches intent and rejects late query replacement", async () => {
  const f = fixture();
  f.options.clock.now = () => end;
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => {
    f.input.originalIntentDigest = "sha256:" + "b".repeat(64);
    return v;
  });
  expect(r.assessment.originalIntentDigest).not.toBe(f.input.originalIntentDigest);
  const g = fixture();
  await expect(
    g.provider.withCurrentAssessment(g.tx, g.input, async () => {
      g.tx.query = vi.fn(async () => ({ rows: [] }));
      return 1;
    }),
  ).rejects.toThrowError(refused);
});
it.each(["graph", "binding", "Ready"])("refuses client-supplied %s before source", async (key) => {
  const f = fixture();
  await expect(
    f.provider.withCurrentAssessment(f.tx, { ...f.input, [key]: true }, async () => 1),
  ).rejects.toThrowError(refused);
  expect(state.calls).toBe(0);
});
it("refuses getters without evaluation and mismatched original policy observation", async () => {
  const f = fixture(),
    getter = vi.fn(() => f.input.graphRequest),
    input = { ...f.input };
  Object.defineProperty(input, "graphRequest", { get: getter, enumerable: true });
  await expect(f.provider.withCurrentAssessment(f.tx, input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(getter).not.toHaveBeenCalled();
  const g = fixture();
  await expect(
    g.provider.withCurrentAssessment(
      g.tx,
      { ...g.input, policyRequest: { ...g.input.policyRequest, observedAt: end } },
      async () => 1,
    ),
  ).rejects.toThrowError(refused);
  expect(state.calls).toBe(0);
});
it("successful limited rules still cannot qualify references or publication", async () => {
  const f = fixture();
  state.policyBody = {
    ...(state.policyBody as Record<string, unknown>),
    mediaRequirement: "Optional",
  };
  const r = await f.provider.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(r.assessment.decision).toBe("PassForAssessedRules");
  expect(r.assessment.referenceEligibility).toBe("NotEvaluated");
  expect(r.assessment.independentApproval).toBe("NotEvaluated");
  expect(r.publishValidation).toBe("Incomplete");
});
it("final root field denial remains mandatory after policy completion", async () => {
  const f = fixture();
  await expect(
    f.provider.withCurrentAssessment(f.tx, f.input, async () => {
      f.options.readAuthority.holdUntilTransactionCompletes.mockImplementation(async () => {
        throw new Error("synthetic late read denial");
      });
      return 1;
    }),
  ).rejects.toThrowError(refused);
});

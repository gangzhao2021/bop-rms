import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductPublicationCommand,
  productApprovalReviewFields,
  type createPostgresProductPublicationSourceStore,
} from "@rms/catalog";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
} from "./current-product-publication-policy.js";
import { createMerchantProductApprovalDecisionFacts } from "./merchant-product-approval-decision-facts.js";
type ReviewOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type CapturedReviewOptions = ReviewOptions & {
  reviewAuthority: NonNullable<ReviewOptions["reviewAuthority"]>;
};
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
const mock = vi.hoisted(() => ({
  review: {} as CapturedReviewOptions,
  policy: {} as PolicyOptions,
  run: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  createPostgresProductPublicationSourceStore: (options: unknown) => {
    mock.review = options as CapturedReviewOptions;
    return {};
  },
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentProductPublicationPolicySource: (options: unknown) => {
    mock.policy = options as PolicyOptions;
    return {};
  },
}));
vi.mock("./current-product-approval-decision.js", () => ({
  createCurrentProductApprovalDecisionSource: () => ({
    withCurrentDecision: (...args: unknown[]) => mock.run(...args),
  }),
}));
const id = (n: number) => "01909681-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T08:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
function fixture(validUntil = "2026-10-02T08:00:05.000Z") {
  let clock = at;
  const tx = { query: vi.fn() },
    command = parseProductPublicationCommand({
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      operationReference: id(7),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 3,
      expectedPublicationVersion: 2,
      action: "Approve",
      contentDigest: hash,
      configurationDigest: hash,
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: at,
          localDateTime: "2026-10-02T08:00:00.000",
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    });
  const review = vi.fn(async () => undefined),
    policy = vi.fn(async () => undefined),
    admission = vi.fn(async () => undefined);
  const approval = {
    evidenceReference: id(7),
    requestedByActorReference: id(3),
    approvedByActorReference: id(4),
  };
  const facts = {
    now: at,
    productAggregateVersion: 3,
    contentDigest: hash,
    configurationDigest: hash,
    scopeDigest: hash,
    periodDigest: hash,
    validation: {} as never,
    approval: null,
    reviewReference: id(8),
    replacement: null,
  };
  const remaining = vi.fn(async (_tx, _input, work) => work(facts));
  const configuration = {
    maximumApprovalValiditySeconds: 12,
    reviewAuthority: { holdUntilTransactionCompletes: review },
    policyAuthority: { holdUntilTransactionCompletes: policy },
  };
  const input = { command, aggregate: {} as never, current: null, content: null, observedAt: at };
  const reviewPacket = () =>
    ({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      productReference: id(5),
      purposeCode: "CATALOG_PRODUCT_APPROVAL_DECISION",
      permission: "catalog.manage",
      owningAction: "catalog.product.approve",
      requiredFields: productApprovalReviewFields,
      observedAt: clock,
    }) as const;
  const policyPacket = () =>
    ({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      policyReference: id(9),
      requiredFields: currentProductPolicyFields,
      observedAt: clock,
    }) as const;
  mock.run.mockImplementation(async (actual, _command, work) => {
    await mock.review.reviewAuthority.holdUntilTransactionCompletes(actual, reviewPacket());
    await mock.policy.authority.holdUntilTransactionCompletes(actual, policyPacket());
    const result = await work({ approval, validUntil });
    await mock.policy.authority.holdUntilTransactionCompletes(actual, policyPacket());
    await mock.review.reviewAuthority.holdUntilTransactionCompletes(actual, reviewPacket());
    return result;
  });
  const options = {
    configuration,
    sources: { withHeldCurrentFacts: remaining },
    transaction: tx,
    command,
    clock: { now: () => clock },
    assertAdmission: admission,
  };
  const source = createMerchantProductApprovalDecisionFacts(options);
  return {
    ...source,
    options,
    tx,
    input,
    review,
    policy,
    admission,
    facts,
    approval,
    remaining,
    reviewPacket,
    policyPacket,
    clock: (value: string) => {
      clock = value;
    },
  };
}
beforeEach(() => {
  mock.run.mockReset();
});
it("replaces only null approval with owning decision under both final source holds", async () => {
  const f = fixture(),
    work = vi.fn(async (facts) => facts.approval);
  expect(await f.sources.withHeldCurrentFacts(f.tx, f.input, work)).toBe(f.approval);
  expect(f.review).toHaveBeenCalledTimes(3);
  expect(f.policy).toHaveBeenCalledTimes(3);
  expect(f.remaining).toHaveBeenCalledWith(f.tx, f.input, expect.any(Function));
  expect(work).toHaveBeenCalledOnce();
  expect(f.admission.mock.calls.length).toBeGreaterThan(8);
});
it("captures independent holders and remaining source before configuration rebound", async () => {
  const f = fixture();
  f.options.configuration.reviewAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("rebound");
  });
  f.options.configuration.policyAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("rebound");
  });
  f.options.sources.withHeldCurrentFacts = vi.fn(async () => {
    throw Error("rebound");
  });
  expect(await f.sources.withHeldCurrentFacts(f.tx, f.input, async () => 7)).toBe(7);
});
it.each([0, 86401, undefined, 1.5])("requires explicit bounded duration %s", (duration) => {
  const f = fixture();
  expect(() =>
    createMerchantProductApprovalDecisionFacts({
      ...f.options,
      configuration: {
        ...f.options.configuration,
        maximumApprovalValiditySeconds: duration as number,
      },
    }),
  ).toThrow(CatalogError);
});
it.each(["reviewAuthority", "policyAuthority"] as const)("requires independent %s", (key) => {
  const f = fixture();
  expect(() =>
    createMerchantProductApprovalDecisionFacts({
      ...f.options,
      configuration: { ...f.options.configuration, [key]: {} },
    } as never),
  ).toThrow(CatalogError);
});
it("refuses a supplied approval rather than interpreting it as a current decision", async () => {
  const f = fixture();
  Object.assign(f.facts, { approval: f.approval });
  const work = vi.fn();
  await expect(f.sources.withHeldCurrentFacts(f.tx, f.input, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(work).not.toHaveBeenCalled();
});
it.each(["none", "twice", "result"])("refuses remaining callback %s", async (mode) => {
  const f = fixture();
  f.remaining.mockImplementation(async (_tx, _input, work) => {
    if (mode === "none") return undefined;
    const result = await work(f.facts);
    if (mode === "twice") await work(f.facts);
    return mode === "result" ? {} : result;
  });
  await expect(f.sources.withHeldCurrentFacts(f.tx, f.input, vi.fn())).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it.each(["query", "expiry", "reverse", "native", "field"])(
  "late %s refuses and latches original transaction",
  async (mode) => {
    const f = fixture();
    const work = async () => {
      if (mode === "query") f.tx.query = vi.fn();
      if (mode === "expiry") f.clock("2026-10-02T08:00:05.000Z");
      if (mode === "reverse") f.clock("2026-10-02T07:59:59.999Z");
      if (mode === "native")
        f.admission.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      if (mode === "field")
        f.review.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
      return 7;
    };
    await expect(f.sources.withHeldCurrentFacts(f.tx, f.input, work)).rejects.toHaveProperty(
      "code",
      mode === "native" || mode === "field"
        ? "CATALOG_PERMISSION_DENIED"
        : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    f.clock(at);
    f.admission.mockResolvedValue(undefined);
    await expect(f.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  },
);
it("refuses nested source use without relaxing failure latch", async () => {
  const f = fixture();
  await expect(
    f.sources.withHeldCurrentFacts(f.tx, f.input, async () =>
      f.sources.withHeldCurrentFacts(f.tx, f.input, async () => 1),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it.each(["tenantReference", "actorReference", "productReference", "requiredFields"])(
  "refuses wrong review %s before independent field holder",
  async (key) => {
    const f = fixture();
    await expect(
      mock.review.reviewAuthority.holdUntilTransactionCompletes(f.tx, {
        ...f.reviewPacket(),
        [key]: key === "requiredFields" ? [] : id(99),
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.review).not.toHaveBeenCalled();
  },
);
it("asserts current admission for original receipt without any owning decision/source acquisition", async () => {
  const f = fixture();
  await f.assertCurrent();
  expect(f.admission).toHaveBeenCalledOnce();
  expect(mock.run).not.toHaveBeenCalled();
  expect(f.review).not.toHaveBeenCalled();
  expect(f.policy).not.toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
});

it.each(["review", "policy", "review-nonvoid", "policy-nonvoid", "short-expiry"])(
  "retains %s after owning callback completion until outer COMMIT",
  async (mode) => {
    const f = fixture("2026-10-02T08:00:02.000Z");
    expect(await f.sources.withHeldCurrentFacts(f.tx, f.input, async () => 7)).toBe(7);
    if (mode === "review")
      f.review.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
    if (mode === "policy")
      f.policy.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
    if (mode === "review-nonvoid") f.review.mockResolvedValue({} as never);
    if (mode === "policy-nonvoid") f.policy.mockResolvedValue({} as never);
    if (mode === "short-expiry") f.clock("2026-10-02T08:00:02.000Z");
    await expect(f.assertCurrent()).rejects.toHaveProperty(
      "code",
      mode === "review" || mode === "policy"
        ? "CATALOG_PERMISSION_DENIED"
        : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    f.review.mockResolvedValue(undefined);
    f.policy.mockResolvedValue(undefined);
    f.clock(at);
    await expect(f.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(mock.run).toHaveBeenCalledOnce();
  },
);

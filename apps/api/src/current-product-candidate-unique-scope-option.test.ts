import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createCurrentProductCandidateUniqueScopeSource } from "./current-product-candidate-unique-scope.js";
const mock = vi.hoisted(() => ({
  candidate: vi.fn(),
  scope: vi.fn(),
  option: vi.fn(),
  duplicate: vi.fn(),
  content: vi.fn(),
  scopeOptions: undefined as
    Parameters<typeof createCurrentProductCandidateUniqueScopeSource>[0] | undefined,
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductValidationCandidateSource: () => ({ withCurrentCandidate: mock.candidate }),
}));
vi.mock("./current-product-unique-scope.js", () => ({
  createCurrentProductUniqueScopeSource: (
    options: Parameters<typeof createCurrentProductCandidateUniqueScopeSource>[0],
  ) => {
    mock.scopeOptions = options;
    return { withCurrentAssessment: mock.scope };
  },
}));
vi.mock("./current-product-held-content-policy.js", () => ({
  createCurrentProductHeldContentPolicySource: () => ({ withHeldAssessment: mock.content }),
}));
vi.mock("./current-product-candidate-option-rules.js", () => ({
  createCurrentProductCandidateOptionRuleSource: () => ({
    withHeldCandidateAssessment: mock.option,
    withCurrentAssessment: mock.duplicate,
  }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T11:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString();
function fixture(count = 1, configured = true, contentConfigured = false) {
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: "sha256:" + "a".repeat(64),
    configurationDigest: "sha256:" + "b".repeat(64),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  };
  const candidate = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    completeContent: "Present",
    observedAt: at,
    validUntil: plus(30),
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    originalIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(command)),
    skuPrerequisite: "ActiveMemberPresent",
    variantMappingPrerequisite: "NoExplicitUnmappedCombination",
    optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation",
    internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
    aggregate: {
      productReference: id(5),
      aggregateVersion: 1,
      draft: {
        versionReference: id(6),
        optionBindings: Array.from({ length: count }, () => ({ bindingReference: id(30) })),
      },
    },
  };
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    originalIntentDigest: candidate.originalIntentDigest,
    observedAt: at,
    validUntil: plus(5),
    digest: "sha256:" + "c".repeat(64),
    policyReference: id(8),
    policyVersion: 1,
    policyPublicationReference: id(12),
  };
  const tx = { query: vi.fn() },
    state = { now: at, status: "Unsatisfiable", until: plus(3) },
    order: string[] = [];
  const policy = {
    content: {
      tenantReference: id(1),
      brandReference: id(2),
      policyReference: id(8),
      policyVersion: 1,
    },
    currentPublicationReference: id(12),
    observedAt: at,
    validUntil: plus(5),
  };
  const policyRead = vi.fn(async (_tx, _request, callback) => {
    order.push("policy enter");
    const value = await callback(policy);
    order.push("policy exit");
    return value;
  });
  mock.content.mockImplementation(async (actual, c, bound, held, work) => {
    expect(actual).toBe(tx);
    expect(c).toEqual(command);
    expect(bound).toBe(candidate);
    expect(held).toEqual(policy);
    order.push("content enter");
    const value = await work({ validUntil: plus(2), marker: "synthetic held wrapper" });
    order.push("content exit");
    return value;
  });
  mock.candidate.mockImplementation(async (_command, work) => {
    order.push("candidate enter");
    const answer: unknown = await work(candidate, tx);
    order.push("candidate exit");
    return answer;
  });
  mock.option.mockImplementation(async (actual, _command, bound, work) => {
    expect(actual).toBe(tx);
    expect(bound).toBe(candidate);
    order.push("option enter");
    const answer: unknown = await work({
      bindings: [{ rules: { status: state.status } }],
      validUntil: state.until,
    });
    order.push("option exit");
    return answer;
  });
  mock.scope.mockImplementation(async (actual, _input, work) => {
    expect(actual).toBe(tx);
    order.push("scope enter");
    const answer: unknown = contentConfigured
      ? await mock.scopeOptions?.policySource.withCurrentPolicy(
          actual,
          { policyReference: id(8), policyVersion: 1, observedAt: at },
          async () => work(scope),
        )
      : await work(scope);
    order.push("scope exit");
    return answer;
  });
  const authority = { holdUntilTransactionCompletes: async () => undefined };
  const source = createCurrentProductCandidateUniqueScopeSource({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => state.now },
    candidateAuthority: authority,
    historyAuthority: authority,
    validationAuthority: authority,
    tenantAuthority: {
      withCurrentBrandReferenceRead: async (_input, work) => work(),
      isCurrent: async () => true,
    },
    policySource: contentConfigured ? ({ withCurrentPolicy: policyRead } as never) : ({} as never),
    ...(contentConfigured
      ? {
          contentPolicy: {
            configurationVersionReference: id(9),
            expectedBrandVersion: 1,
            brandAuthority: {
              withCurrentContentRead: async (_r, _f, work) => work(),
              isCurrent: async () => true,
            },
          },
        }
      : {}),
    ...(configured
      ? {
          optionAuthority: {
            holdUntilTransactionCompletes: async () => ({ observedAt: at, validUntil: plus(3) }),
          },
        }
      : {}),
  });
  const input = { command, policyReference: id(8), policyVersion: 1 };
  return { source, tx, state, order, input, candidate, policyRead };
}
beforeEach(() => {
  for (const f of Object.values(mock)) if (typeof f === "function") f.mockReset();
  mock.scopeOptions = undefined;
});
it("joins held Option assessment inside the original actual candidate and shortest lease", async () => {
  const f = fixture(),
    reply = {};
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (proof) => {
    f.order.push("consumer");
    expect(proof.optionRulePrerequisite).toBe("Unsatisfiable");
    expect(proof.validUntil).toBe(plus(3));
    expect(proof.optionSelectionPrerequisite).toBe("NoExplicitDefaultBoundsViolation");
    expect(proof).not.toHaveProperty("bindings");
    return reply;
  });
  expect(result).toBe(reply);
  expect(mock.candidate).toHaveBeenCalledOnce();
  expect(mock.option).toHaveBeenCalledOnce();
  expect(mock.duplicate).not.toHaveBeenCalled();
  expect(f.order).toEqual([
    "candidate enter",
    "option enter",
    "scope enter",
    "consumer",
    "scope exit",
    "option exit",
    "candidate exit",
  ]);
});
it("Satisfiable subset never emits Option Pass or qualification", async () => {
  const f = fixture();
  f.state.status = "Satisfiable";
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (p) => p);
  expect(result.optionRulePrerequisite).toBe("NoMechanicalContradiction");
  expect(result).not.toHaveProperty("optionCheck");
});
it("configured content joins the original Candidate and already-held Policy inside Option and scope barriers", async () => {
  const f = fixture(1, true, true),
    reply = {};
  expect(
    await f.source.withCurrentAssessment(f.tx, f.input, async (proof) => {
      expect(proof.validUntil).toBe(plus(2));
      expect(proof.contentPolicyAssessment).toMatchObject({ marker: "synthetic held wrapper" });
      f.order.push("consumer");
      return reply;
    }),
  ).toBe(reply);
  expect(mock.candidate).toHaveBeenCalledOnce();
  expect(f.policyRead).toHaveBeenCalledOnce();
  expect(mock.content).toHaveBeenCalledOnce();
  expect(mock.duplicate).not.toHaveBeenCalled();
  expect(f.order).toEqual([
    "candidate enter",
    "option enter",
    "scope enter",
    "policy enter",
    "content enter",
    "consumer",
    "content exit",
    "policy exit",
    "scope exit",
    "option exit",
    "candidate exit",
  ]);
});
it("configured content failure refuses instead of falling back to remaining checks", async () => {
  const f = fixture(0, true, true),
    work = vi.fn();
  mock.content.mockRejectedValueOnce(new Error("synthetic missing Brand source"));
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(f.policyRead).toHaveBeenCalledOnce();
});
it("content expiry at outer Candidate return remains unavailable", async () => {
  const f = fixture(1, true, true);
  mock.candidate.mockImplementationOnce(async (_c, work) => {
    const answer = await work(f.candidate, f.tx);
    f.state.now = plus(2);
    return answer;
  });
  await expect(f.source.withCurrentAssessment(f.tx, f.input, async () => null)).rejects.toThrow();
});
it("a Policy wrapper swallowing a repeated callback cannot restore the first successful result", async () => {
  const f = fixture(0, true, true),
    read = f.policyRead.getMockImplementation();
  if (!read) throw Error("missing synthetic reader");
  f.policyRead.mockImplementationOnce(async (tx, request, callback) => {
    const first = await read(tx, request, callback);
    try {
      await read(tx, request, callback);
    } catch {
      /* deliberately swallowed */
    }
    return first;
  });
  await expect(f.source.withCurrentAssessment(f.tx, f.input, async () => null)).rejects.toThrow();
  expect(mock.content).toHaveBeenCalledOnce();
});
it.each(["Indeterminate", "Pass", "Unknown"])(
  "refuses unsupported Option assessment %s before consumer",
  async (status) => {
    const f = fixture();
    f.state.status = status;
    const work = vi.fn();
    await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(mock.scope).not.toHaveBeenCalled();
  },
);
it("nonempty actual candidate cannot omit Option authority", async () => {
  const f = fixture(1, false);
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
  expect(mock.option).not.toHaveBeenCalled();
  expect(mock.scope).not.toHaveBeenCalled();
});
it("only actual empty Bindings can omit Option source", async () => {
  const f = fixture(0, false);
  const r = await f.source.withCurrentAssessment(f.tx, f.input, async (p) => p);
  expect(r.optionRulePrerequisite).toBe("NoMechanicalContradiction");
  expect(mock.option).not.toHaveBeenCalled();
});
it("original Option expiry after tentative consumer rejects", async () => {
  const f = fixture();
  let ran = false;
  await expect(
    f.source.withCurrentAssessment(f.tx, f.input, async () => {
      ran = true;
      f.state.now = plus(3);
      return "tentative";
    }),
  ).rejects.toThrow();
  expect(ran).toBe(true);
});

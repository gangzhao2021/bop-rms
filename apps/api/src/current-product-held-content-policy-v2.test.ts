import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  bindCatalogProductValidationCandidateV2,
  CatalogError,
  deriveCatalogProductPublicationContentIdentity,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  type CatalogProductContentPolicyAssessmentV2,
} from "@rms/catalog";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { createCurrentProductHeldContentPolicySourceV2 } from "./current-product-held-content-policy-v2.js";
const mock = vi.hoisted(() => ({ brand: vi.fn() }));
vi.mock("./current-brand-configuration-content.js", () => ({
  createCurrentBrandConfigurationContentSource: () => ({ withCurrentContent: mock.brand }),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T15:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString(),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old intent"),
      previousScopeDigest: hash([selector, { ...selector, reference: id(21) }]),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    replacementIntent = { ...intentBody, digest: hash(intentBody) },
    c = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
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
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
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
    });
  const candidate = {
    ...bindCatalogProductValidationCandidateV2(c, aggregate, at),
    internalCodeCheck: { code: "InternalCode" as const, outcome: "Pass" as const },
  };
  const policy = {
    content: parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(11),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA", "fr-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: plus(4),
    }),
    currentPublicationReference: id(12),
    observedAt: at,
    validUntil: plus(4),
  };
  const tx = { query: vi.fn() },
    state = {
      now: at,
      until: plus(3),
      requestedUntil: plus(4),
      after: (() => undefined) as () => void,
      repeat: false,
      foreign: false,
      changed: false,
      brandPatch: {} as Record<string, unknown>,
    };
  const configuration = {
      configurationVersionReference: id(9),
      expectedBrandVersion: 1,
      brandAuthority: {
        withCurrentContentRead: async <T>(
          _i: unknown,
          _f: readonly string[],
          work: () => Promise<T>,
        ) => work(),
        isCurrent: async () => true,
      },
    },
    clock = { now: () => state.now };
  mock.brand.mockImplementation(async (request, work) => {
    expect(request.originalIntentDigest).toBe(hash(c));
    expect(request.validUntil).toBe(state.requestedUntil);
    const brand = {
      tenantReference: id(1),
      brandReference: id(2),
      brandVersion: 1,
      configurationVersionReference: id(9),
      contentDigest: hash("brand"),
      currentPublicationReference: id(10),
      supportedLocales: ["en-CA", "fr-CA"],
      originalIntentDigest: request.originalIntentDigest,
      observedAt: request.observedAt,
      validUntil: state.until,
      ...state.brandPatch,
    };
    const result = await work(brand, state.foreign ? {} : tx);
    if (state.repeat)
      try {
        await work(brand, tx);
      } catch {
        /* adversarial wrapper catches callback refusal */
      }
    state.after();
    return state.changed ? {} : result;
  });
  const source = createCurrentProductHeldContentPolicySourceV2(configuration, clock),
    work = vi.fn(async (v: CatalogProductContentPolicyAssessmentV2) => v);
  const run = (value = c, bound = candidate, held = policy) =>
    source.withHeldAssessment(tx, value, bound, held, work);
  return { c, candidate, policy, tx, state, configuration, clock, source, work, run };
}
beforeEach(() => {
  mock.brand.mockReset();
});
it("binds the synthetic held V2 candidate and policy to complete current Brand rule input", async () => {
  const f = fixture(),
    v = await f.run();
  expect(mock.brand).toHaveBeenCalledOnce();
  expect(f.work).toHaveBeenCalledOnce();
  expect(v.validUntil).toBe(plus(3));
  expect(v.profile).toBe("CatalogProductContentPolicyAssessmentV2");
  expect(v.originalIntentDigest).toBe(hash(f.c));
  expect(v.replacementIntentDigest).toBe(f.c.replacementIntentDigest);
  expect(v.decision).toBe("HardError");
  expect(v.checks.find((c) => c.code === "RequiredProductNames")?.outcome).toBe("HardError");
  expect(v.checks.find((c) => c.code === "RequiredMediaPresence")?.outcome).toBe("HardError");
  expect(v.mediaReadiness).toBe("NotEvaluated");
  expect(v.publishValidation).toBe("Incomplete");
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "replacementIntentDigest",
] as const)("foreign candidate %s refuses before Brand read", async (key) => {
  const f = fixture();
  await expect(f.run(f.c, { ...f.candidate, [key]: id(99) })).rejects.toThrow();
  expect(mock.brand).not.toHaveBeenCalled();
});
it("foreign policy, incomplete content or foreign transaction refuses", async () => {
  let f = fixture();
  await expect(
    f.run(f.c, f.candidate, {
      ...f.policy,
      content: { ...f.policy.content, brandReference: id(99) } as never,
    }),
  ).rejects.toThrow();
  f = fixture();
  await expect(f.run(f.c, { ...f.candidate, completeContent: "Unavailable" })).rejects.toThrow();
  f = fixture();
  f.state.foreign = true;
  await expect(f.run()).rejects.toThrow();
  expect(f.work).not.toHaveBeenCalled();
});
it.each(["expiry", "rewind", "query", "repeat", "result"])(
  "late %s refuses and failed transaction cannot be reused",
  async (mode) => {
    const f = fixture();
    if (mode === "repeat") f.state.repeat = true;
    else if (mode === "result") f.state.changed = true;
    else
      f.state.after = () => {
        if (mode === "expiry") f.state.now = plus(3);
        else if (mode === "rewind") f.state.now = new Date(Date.parse(at) - 1).toISOString();
        else f.tx.query = vi.fn();
      };
    await expect(f.run()).rejects.toThrow();
    const count = mock.brand.mock.calls.length;
    f.state.now = at;
    await expect(f.run()).rejects.toThrow();
    expect(mock.brand.mock.calls.length).toBe(count);
  },
);
it("captures server selectors and clock rather than later mutable configuration", async () => {
  const f = fixture();
  f.configuration.configurationVersionReference = id(99);
  f.configuration.expectedBrandVersion = 99;
  f.clock.now = () => plus(30);
  await expect(f.run()).resolves.toMatchObject({
    brandSource: { brandVersion: 1, configurationVersionReference: id(9) },
  });
});
it("exclusive source deadline and command getter refuse without invoking getter", async () => {
  let f = fixture();
  f.state.until = at;
  await expect(f.run()).rejects.toThrow();
  f = fixture();
  const get = vi.fn();
  await expect(
    f.run(Object.defineProperty({ ...f.c }, "action", { get, enumerable: true })),
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
it.each(["profile", "candidate lease", "policy lease", "policy extra", "policy publication"])(
  "malformed held %s refuses before Brand read",
  async (mode) => {
    const f = fixture();
    const candidate =
      mode === "profile"
        ? { ...f.candidate, profile: "Unknown" as never }
        : mode === "candidate lease"
          ? { ...f.candidate, validUntil: plus(31) as never }
          : f.candidate;
    const policy =
      mode === "policy lease"
        ? { ...f.policy, validUntil: plus(31) }
        : mode === "policy extra"
          ? { ...f.policy, extra: true }
          : mode === "policy publication"
            ? { ...f.policy, currentPublicationReference: "invalid" }
            : f.policy;
    await expect(f.run(f.c, candidate, policy)).rejects.toThrow();
    expect(mock.brand).not.toHaveBeenCalled();
  },
);
it.each(["brandVersion", "configurationVersionReference"])(
  "changed current Brand selector %s refuses before consumer",
  async (key) => {
    const f = fixture();
    f.state.brandPatch = { [key]: key === "brandVersion" ? 2 : id(99) };
    await expect(f.run()).rejects.toThrow();
    expect(f.work).not.toHaveBeenCalled();
  },
);
it("refuses V1 commands and a self-consistent retarget against the original held candidate", async () => {
  const f = fixture(),
    legacy = Object.fromEntries(
      Object.entries(f.c).filter(
        ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
      ),
    );
  await expect(f.run(legacy as never)).rejects.toThrow();
  expect(mock.brand).not.toHaveBeenCalled();
  const g = fixture(),
    intentBody = Object.fromEntries(
      Object.entries(g.c.replacementIntent).filter(([key]) => key !== "digest"),
    ),
    changed = { ...intentBody, previousPublicationOperationReference: id(99) },
    replacementIntent = { ...changed, digest: hash(changed) },
    retargeted = parseProductPublicationCommandV2({
      ...g.c,
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
  await expect(g.run(retargeted)).rejects.toThrow();
  expect(mock.brand).not.toHaveBeenCalled();
});
it("rebinds complete aggregate content and rejects forged metadata before Brand reads", async () => {
  for (const patch of [
    { skuPrerequisite: "ActiveMemberPresent" },
    { eligibility: "Pass" },
    {
      aggregate: {
        ...fixture().candidate.aggregate,
        draft: { ...fixture().candidate.aggregate.draft, localizedNames: { "en-CA": "Changed" } },
      },
    },
    { internalCodeCheck: { code: "InternalCode", outcome: "Pass", extra: true } },
  ]) {
    const f = fixture();
    await expect(f.run(f.c, { ...f.candidate, ...patch } as never)).rejects.toThrow();
    expect(mock.brand).not.toHaveBeenCalled();
  }
});
it("does not execute held candidate or policy getters", async () => {
  for (const which of ["candidate", "policy"]) {
    const f = fixture(),
      get = vi.fn();
    const candidate = { ...f.candidate },
      policy = { ...f.policy };
    Object.defineProperty(
      which === "candidate" ? candidate : policy,
      which === "candidate" ? "aggregate" : "content",
      { enumerable: true, get },
    );
    await expect(f.run(f.c, candidate, policy)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(mock.brand).not.toHaveBeenCalled();
  }
});
it("caps standalone acquisition to its original five seconds and does not renew after consumer", async () => {
  const f = fixture();
  f.state.requestedUntil = plus(5);
  f.state.until = plus(20);
  const policy = {
    ...f.policy,
    validUntil: plus(30),
    content: { ...f.policy.content, effectiveUntil: plus(30) },
  };
  f.state.after = () => {
    f.state.now = plus(5);
  };
  await expect(f.run(f.c, f.candidate, policy as never)).rejects.toThrow();
  expect(f.work).toHaveBeenCalledOnce();
  expect(f.work.mock.calls[0]?.[0].validUntil).toBe(plus(5));
});
it("caught reentry poisons the original held transaction", async () => {
  const f = fixture();
  f.work.mockImplementation(async (proof) => {
    await f.run().catch(() => undefined);
    return proof;
  });
  await expect(f.run()).rejects.toThrow();
  expect(f.work).toHaveBeenCalledOnce();
});
it("preserves late owning permission denial after tentative work", async () => {
  const f = fixture();
  f.state.after = () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  };
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.work).toHaveBeenCalledOnce();
});

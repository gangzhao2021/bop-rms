import { beforeEach, expect, it, vi } from "vitest";
import { productPolicyScopeLevels } from "@bop/publishing";
import {
  CatalogError,
  assessCatalogProductDraftContentPolicy,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import { createMerchantProductEditorPolicyContentAuthority as create } from "./merchant-product-editor-policy-content-authority.js";
import type { CurrentBrandConfigurationContent } from "./current-brand-configuration-content.js";
import { remainingProductEditorVariantReferenceChecks } from "./merchant-product-editor-variant-content-authority.js";
const mock = vi.hoisted(() => ({ run: vi.fn(), policySource: vi.fn(), policyRead: vi.fn() }));
vi.mock("./current-product-content-policy.js", () => ({
  createCurrentProductDraftContentPolicySource: () => ({ withCurrentAssessment: mock.run }),
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<typeof import("./current-product-publication-policy.js")>()),
  createCurrentProductPublicationPolicySource: (options: unknown) => {
    mock.policySource(options);
    return { withCurrentPolicy: mock.policyRead };
  },
}));
const id = (n: number) => `019a2447-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-01T00:30:00.000Z";
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type Options = Parameters<typeof create>[0];
type Source = ReturnType<
  typeof import("./current-product-content-policy.js").createCurrentProductDraftContentPolicySource
>;
type AssessmentInput = Parameters<Source["withCurrentAssessment"]>[1];
type Work = Parameters<Source["withCurrentAssessment"]>[2];
function fixture() {
  let clock = at;
  const aggregate = parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "POLICY",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 2,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [],
      optionBindings: [],
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
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const remaining = vi.fn<Options["remainingAuthority"]>(async () => undefined);
  const options: Options = {
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    configurationVersionReference: id(15),
    expectedBrandVersion: 1,
    policyReference: id(16),
    policyVersion: 1,
    brandAuthority: {
      withCurrentContentRead: async (_r, _f, work) => work(),
      isCurrent: async () => true,
    },
    policyAuthority: { holdUntilTransactionCompletes: async () => undefined },
    remainingAuthority: remaining,
    clock: { now: () => clock },
  };
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(10),
    brandReference: id(2),
    familyReference: id(17),
    policyReference: id(16),
    policyVersion: 1,
    scopeOrder: productPolicyScopeLevels,
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  const assess = (input: AssessmentInput) =>
    assessCatalogProductDraftContentPolicy(
      input.aggregate,
      {
        tenantReference: id(10),
        brandReference: id(2),
        brandVersion: 1,
        configurationVersionReference: id(15),
        contentDigest: "sha256:" + "1".repeat(64),
        currentPublicationReference: id(18),
        supportedLocales: ["en-CA"],
        observedAt: input.binding.observedAt,
        validUntil: input.binding.validUntil,
        originalIntentDigest: input.binding.originalIntentDigest,
      },
      policy,
      input.binding,
    );
  mock.run.mockImplementation(async (_tx: unknown, input: AssessmentInput, work: Work) =>
    work(assess(input), id(19)),
  );
  const base = {
    tenantReference: id(10),
    brandReference: id(2),
    storeReference: id(11),
    actorReference: id(3),
    sessionReference: id(12),
    productReference: id(1),
    operationReference: id(13),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.manage" as const,
    purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const,
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    aggregate,
    requiredFields: productEditorContentFields,
  };
  const authority = create(options);
  return {
    options,
    authority,
    tx,
    remaining,
    aggregate,
    policy,
    assess,
    base,
    clock: (value: string) => {
      clock = value;
    },
    read: () => ({ ...base, mode: "Read" as const, requiredReferenceChecks: Object.freeze([]) }),
    write: () => ({
      ...base,
      mode: "DraftWrite" as const,
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
    }),
  };
}
beforeEach(() => {
  mock.run.mockReset();
  mock.policySource.mockReset();
  mock.policyRead.mockReset();
});
it("Read recovery holds complete fields without resolving historical policy eligibility", async () => {
  const f = fixture();
  await f.authority(f.tx, f.read());
  expect(mock.run).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      requiredFields: productEditorContentFields,
      requiredReferenceChecks: [],
    }),
  );
});
it("prospective Draft uses exact server pins/current source and retains all five checks", async () => {
  const f = fixture();
  f.clock(new Date(Date.parse(at) + 100).toISOString());
  await f.authority(f.tx, f.write());
  const [tx, input] = mock.run.mock.calls[0] as [unknown, AssessmentInput];
  expect(tx).toBe(f.tx);
  expect(input.brandRequest).toMatchObject({
    tenantReference: id(10),
    brandReference: id(2),
    actorReference: id(3),
    configurationVersionReference: id(15),
    expectedBrandVersion: 1,
    observedAt: new Date(Date.parse(at) + 100).toISOString(),
    validUntil: f.base.validUntil,
  });
  expect(input.policyRequest).toEqual({
    policyReference: id(16),
    policyVersion: 1,
    observedAt: input.brandRequest.observedAt,
  });
  expect(input.binding.originalIntentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      requiredReferenceChecks: remainingProductEditorVariantReferenceChecks,
      observedAt: at,
      validUntil: f.base.validUntil,
    }),
  );
  expect(remainingProductEditorVariantReferenceChecks).toContain("BrandContentPolicy");
});
it("missing translations and required media do not block Draft save or replace remaining reference checks", async () => {
  const f = fixture();
  f.policy.requiredLocales = ["fr-CA"];
  f.policy.mediaRequirement = "Required";
  await expect(f.authority(f.tx, f.write())).resolves.toBeUndefined();
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("unsupported actual Product locale keys remain a structural hard conflict", async () => {
  const f = fixture(),
    aggregate = parseProductAggregate({
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        localizedNames: { "en-CA": "Synthetic", "de-DE": "Unsupported" },
      },
    });
  await expect(f.authority(f.tx, { ...f.write(), aggregate })).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(f.remaining).not.toHaveBeenCalled();
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
});
it("late source failure cannot be replaced by an earlier business conflict", async () => {
  const f = fixture();
  f.policy.mediaRequirement = "Required";
  mock.run.mockImplementation(async (_tx: unknown, input: AssessmentInput, work: Work) => {
    await work(f.assess(input), id(19));
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it.each(["tenantReference", "brandReference", "actorReference", "productReference"])(
  "foreign %s refuses before source",
  async (key) => {
    const f = fixture();
    await expect(f.authority(f.tx, { ...f.write(), [key]: id(99) })).rejects.toMatchObject(
      unavailable,
    );
    expect(mock.run).not.toHaveBeenCalled();
  },
);
it.each(["permission", "owningAction", "purposeCode", "mode"])(
  "unknown %s refuses",
  async (key) => {
    const f = fixture();
    await expect(
      f.authority(f.tx, { ...f.write(), [key]: "Unknown" } as never),
    ).rejects.toMatchObject(unavailable);
  },
);
it("supplied policy or accessor cannot become current source configuration", async () => {
  const f = fixture(),
    getter = vi.fn(() => f.aggregate);
  await expect(f.authority(f.tx, { ...f.write(), policy: f.policy } as never)).rejects.toThrow();
  const g = fixture();
  await expect(
    g.authority(g.tx, {
      ...g.write(),
      get aggregate() {
        return getter();
      },
    }),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(mock.run).not.toHaveBeenCalled();
});
it.each(["requiredFields", "requiredReferenceChecks"])("partial %s refuses", async (key) => {
  const f = fixture();
  await expect(f.authority(f.tx, { ...f.write(), [key]: [] })).rejects.toMatchObject(unavailable);
});
it.each([-1, 5000])("original clock delta %s cannot renew source admission", async (delta) => {
  const f = fixture();
  f.clock(new Date(Date.parse(at) + delta).toISOString());
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(mock.run).not.toHaveBeenCalled();
});
it("remaining field denial or nonvoid result poisons subsequent same-Tx recovery", async () => {
  const f = fixture();
  f.remaining.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.remaining.mockResolvedValue(undefined);
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
  const g = fixture();
  g.remaining.mockResolvedValue("Allowed" as never);
  await expect(g.authority(g.tx, g.write())).rejects.toMatchObject(unavailable);
});
it("late original expiry refuses after remaining hold even with newer source observation", async () => {
  const f = fixture();
  f.clock(new Date(Date.parse(at) + 1000).toISOString());
  f.remaining.mockImplementation(async () => f.clock(f.base.validUntil));
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});
it.each(["skip", "repeat", "unknown-result", "foreign-assessment", "renewed-deadline"])(
  "%s source cannot admit",
  async (mode) => {
    const f = fixture();
    mock.run.mockImplementation(async (_tx: unknown, input: AssessmentInput, work: Work) => {
      if (mode === "skip") return undefined;
      const assessment = f.assess(input);
      const value = {
        ...assessment,
        ...(mode === "foreign-assessment"
          ? { productReference: parseCatalogReference(id(99)) }
          : {}),
        ...(mode === "renewed-deadline"
          ? {
              validUntil: parseCatalogInstant(
                new Date(Date.parse(f.base.validUntil) + 1).toISOString(),
              ),
            }
          : {}),
      };
      await work(value, id(19));
      if (mode === "repeat") await work(value, id(19));
      return mode === "unknown-result" ? "Allowed" : undefined;
    });
    await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  },
);
it("captures server pins and clock before collaborator rebound", async () => {
  const f = fixture();
  f.options.clock.now = () => f.base.validUntil;
  Object.assign(f.options, { expectedBrandVersion: 99, policyVersion: 99 });
  await expect(f.authority(f.tx, f.write())).resolves.toBeUndefined();
  expect(mock.run.mock.calls[0]?.[1].brandRequest.expectedBrandVersion).toBe(1);
});
it.each(["brandAuthority", "policyAuthority", "remainingAuthority", "clock"])(
  "missing %s configuration refuses",
  (key) => {
    const f = fixture();
    expect(() => create({ ...f.options, [key]: undefined } as never)).toThrow(CatalogError);
  },
);

it("defers a known remaining conflict until owning final holds and latches reuse", async () => {
  const f = fixture();
  f.remaining.mockRejectedValue(new CatalogError("CATALOG_LIFECYCLE_CONFLICT"));
  await expect(f.authority(f.tx, f.write())).rejects.toHaveProperty(
    "code",
    "CATALOG_LIFECYCLE_CONFLICT",
  );
  expect(mock.run).toHaveReturned();
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
});
it.each(["denial", "expiry", "unknown"])(
  "late %s supersedes a remaining conflict",
  async (mode) => {
    const f = fixture();
    f.remaining.mockRejectedValue(new CatalogError("CATALOG_LIFECYCLE_CONFLICT"));
    mock.run.mockImplementation(async (_tx: unknown, input: AssessmentInput, work: Work) => {
      await work(f.assess(input), id(19));
      if (mode === "expiry") {
        f.clock(f.base.validUntil);
        return;
      }
      if (mode === "denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      throw Error("synthetic dependency unavailable");
    });
    await expect(f.authority(f.tx, f.write())).rejects.toHaveProperty(
      "code",
      mode === "denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  },
);

it("surfaces a known remaining permission denial after current source final holds", async () => {
  const f = fixture();
  f.remaining.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.authority(f.tx, f.write())).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  await expect(f.authority(f.tx, f.read())).rejects.toMatchObject(unavailable);
});
it.each(["expiry", "source"])("late %s overrides remaining permission denial", async (mode) => {
  const f = fixture();
  f.remaining.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  mock.run.mockImplementation(async (_tx: unknown, input: AssessmentInput, work: Work) => {
    await work(f.assess(input), id(19));
    if (mode === "expiry") {
      f.clock(f.base.validUntil);
      return;
    }
    throw Error("synthetic final source refusal");
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
});

it("Create keeps explicit original purpose through actual owning content and remaining holder", async () => {
  const f = fixture(),
    input = {
      ...f.write(),
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
      aggregate: parseProductAggregate({ ...f.aggregate, aggregateVersion: 1 }),
    };
  await f.authority(f.tx, input);
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      purposeCode: "CATALOG_PRODUCT_CREATE",
      mode: "DraftWrite",
      aggregate: input.aggregate,
    }),
  );
});
it.each(["Read", "root"])("Create refuses %s without new source admission", async (kind) => {
  const f = fixture(),
    input = {
      ...f.write(),
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
      aggregate: parseProductAggregate({ ...f.aggregate, aggregateVersion: 1 }),
    };
  const invalid =
    kind === "Read"
      ? { ...input, mode: "Read" as const, requiredReferenceChecks: [] }
      : { ...input, aggregate: parseProductAggregate({ ...input.aggregate, aggregateVersion: 2 }) };
  await expect(f.authority(f.tx, invalid)).rejects.toMatchObject(unavailable);
  expect(f.remaining).not.toHaveBeenCalled();
});

function runtimeFixture() {
  const f = fixture();
  const brand = {
    profile: "CurrentBrandConfigurationContentV1" as const,
    tenantReference: id(10),
    brandReference: id(2),
    brandVersion: 1,
    configurationVersionReference: id(15),
    configurationVersion: 1,
    contentDigest: "sha256:" + "1".repeat(64),
    originalPublicationReference: id(18),
    currentPublicationReference: id(18),
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    overrideAllowedFieldCodes: [],
    hardRequirementFieldCodes: [],
    catalogSourceReference: id(20),
    platformTemplateReference: id(21),
    effectiveFrom: at,
    effectiveUntil: null,
    originalIntentDigest: "sha256:" + "2".repeat(64),
    observedAt: at,
    validUntil: f.base.validUntil,
    eligibility: "NotEvaluated" as const,
  };
  const read = vi.fn<NonNullable<Options["runtimeBrandSources"]>["withCurrentBrandContent"]>(
    async (actual, work) => {
      expect(actual).toBe(f.tx);
      return work(brand);
    },
  );
  const hold = vi.fn<Options["policyAuthority"]["holdUntilTransactionCompletes"]>(
    async () => undefined,
  );
  mock.policyRead.mockImplementation(async (actual, request, work) => {
    const configured = mock.policySource.mock.calls.at(-1)?.[0] as Parameters<
      typeof import("./current-product-publication-policy.js").createCurrentProductPublicationPolicySource
    >[0];
    const input = {
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User" as const,
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION" as const,
      policyReference: request.policyReference,
      requiredFields: (await import("./current-product-publication-policy.js"))
        .currentProductPolicyFields,
      observedAt: request.observedAt,
    };
    await configured.authority.holdUntilTransactionCompletes(actual, input);
    const answer = await work({
      content: f.policy,
      currentPublicationReference: id(19),
      observedAt: request.observedAt,
      validUntil: f.base.validUntil,
    });
    await configured.authority.holdUntilTransactionCompletes(actual, input);
    return answer;
  });
  const authority = create({
    ...f.options,
    runtimeBrandSources: {
      async withCurrentBrandContent<T>(
        actual: Parameters<
          NonNullable<Options["runtimeBrandSources"]>["withCurrentBrandContent"]
        >[0],
        work: (packet: CurrentBrandConfigurationContent) => Promise<T>,
      ): Promise<T> {
        let completed: readonly [T] | undefined;
        await read(actual, async (packet) => {
          const answer = await work(packet);
          completed = [answer];
          return answer;
        });
        if (!completed) throw new Error("Missing synthetic held Brand callback");
        return completed[0];
      },
    },
    policyAuthority: { holdUntilTransactionCompletes: hold },
  });
  return { ...f, brand, brandRead: read, hold, authority };
}
it("runtime exact Write reuses owning locked Policy while reholding actual Brand and permissions", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.write());
  Object.assign(f.policy, { effectiveUntil: at });
  mock.policyRead.mockRejectedValue(new Error("No repeated history query"));
  await expect(f.authority(f.tx, f.write())).resolves.toBeUndefined();
  expect(mock.policyRead).toHaveBeenCalledOnce();
  expect(f.brandRead).toHaveBeenCalledTimes(2);
  expect(f.hold).toHaveBeenCalledTimes(4);
  expect(f.remaining).toHaveBeenCalledTimes(2);
  expect(f.brand.observedAt).toBe(at);
  expect(mock.run).not.toHaveBeenCalled();
});
it.each(["aggregate", "operationReference", "brand", "query"])(
  "runtime retained proof refuses changed %s",
  async (field) => {
    const f = runtimeFixture();
    await f.authority(f.tx, f.write());
    const input =
      field === "aggregate"
        ? {
            ...f.write(),
            aggregate: parseProductAggregate({ ...f.aggregate, internalCode: "CHANGED" }),
          }
        : field === "operationReference"
          ? { ...f.write(), operationReference: id(99) }
          : f.write();
    if (field === "brand") f.brand.contentDigest = "sha256:" + "3".repeat(64);
    if (field === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    await expect(f.authority(f.tx, input)).rejects.toMatchObject(unavailable);
    expect(f.remaining).toHaveBeenCalledOnce();
  },
);
it("runtime retained Policy never substitutes an earlier permission grant", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.write());
  f.hold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("runtime retained Policy remains bounded by the original deadline", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.write());
  f.clock(f.base.validUntil);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(f.brandRead).toHaveBeenCalledOnce();
});
it("actual host rejects a foreign transaction instead of reusing its Policy proof", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.write());
  f.brandRead.mockImplementation(async (actual) => {
    if (actual !== f.tx) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    throw new Error("Unexpected original transaction");
  });
  await expect(f.authority({ query: f.tx.query }, f.write())).rejects.toMatchObject(unavailable);
  expect(mock.policyRead).toHaveBeenCalledOnce();
});
it("runtime historical Read does not acquire current Brand or Policy eligibility", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.read());
  expect(mock.policyRead).not.toHaveBeenCalled();
  expect(f.brandRead).not.toHaveBeenCalled();
  expect(f.remaining).toHaveBeenCalledOnce();
});

it("current assessment time does not rewrite original held Brand or Policy observations", async () => {
  const f = runtimeFixture();
  const later = new Date(Date.parse(at) + 100).toISOString();
  const aggregate = parseProductAggregate({
    ...f.aggregate,
    updatedAt: later,
    draft: { ...f.aggregate.draft, updatedAt: later },
  });
  f.clock(later);
  await expect(f.authority(f.tx, { ...f.write(), aggregate })).resolves.toBeUndefined();
  expect(f.brand.observedAt).toBe(at);
  expect(f.brand.originalIntentDigest).toBe("sha256:" + "2".repeat(64));
  expect(mock.policyRead).toHaveBeenCalledWith(
    f.tx,
    { policyReference: id(16), policyVersion: 1, observedAt: at },
    expect.any(Function),
  );
  expect(f.remaining).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({
      aggregate,
      observedAt: at,
      validUntil: f.base.validUntil,
    }),
  );
});

it("late actual Brand permission denial is not cached away", async () => {
  const f = runtimeFixture();
  await f.authority(f.tx, f.write());
  f.brandRead.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.remaining).toHaveBeenCalledOnce();
});
it("a failed final Policy source hold never admits reusable source proof", async () => {
  const f = runtimeFixture();
  f.hold.mockImplementation(async () => {
    if (f.hold.mock.calls.length === 2) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  f.hold.mockResolvedValue(undefined);
  await expect(f.authority(f.tx, f.write())).rejects.toMatchObject(unavailable);
  expect(mock.policyRead).toHaveBeenCalledOnce();
  expect(f.remaining).toHaveBeenCalledOnce();
});

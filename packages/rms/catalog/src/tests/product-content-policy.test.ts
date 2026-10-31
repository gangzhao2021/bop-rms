import { expect, it, vi } from "vitest";
import {
  assessCatalogProductContentPolicy,
  deriveCatalogProductPublicationContentIdentity,
} from "../index.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-30T06:00:00.000Z",
  until = "2026-09-30T06:00:20.000Z",
  digest = "sha256:" + "a".repeat(64);
export function policyFixture() {
  const aggregate = {
    productReference: id(1),
    brandReference: id(2),
    internalCode: "CONTENT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
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
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
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
  };
  const brand = {
    tenantReference: id(6),
    brandReference: id(2),
    brandVersion: 1,
    configurationVersionReference: id(7),
    contentDigest: digest,
    currentPublicationReference: id(8),
    supportedLocales: ["en-CA", "fr-CA"],
    observedAt: at,
    validUntil: until,
    originalIntentDigest: digest,
  };
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(6),
    brandReference: id(2),
    familyReference: id(9),
    policyReference: id(10),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: until,
  };
  const binding = {
    ...deriveCatalogProductPublicationContentIdentity(aggregate),
    tenantReference: id(6),
    productReference: id(1),
    versionReference: id(4),
    expectedAggregateVersion: 1,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: until,
  };
  const { referenceConfiguration, ...minimal } = binding;
  void referenceConfiguration;
  return { aggregate, brand, policy, binding: minimal };
}
const run = (f: ReturnType<typeof policyFixture>) =>
  assessCatalogProductContentPolicy(f.aggregate, f.brand, f.policy, f.binding);
it("assesses exact content without promoting a partial policy pass into publish validation", () => {
  const f = policyFixture(),
    r = run(f);
  expect(r).toMatchObject({
    decision: "PassForAssessedRules",
    publishValidation: "Incomplete",
    sourceAuthority: "NotEvaluated",
    mediaReadiness: "NotEvaluated",
    eligibility: "NotEvaluated",
    warningOverrideAllowed: false,
  });
  for (const key of ["content", "localizedNames", "media", "referenceConfiguration"])
    expect(Object.hasOwn(r, key)).toBe(false);
  f.policy.requiredLocales.push("fr-CA");
  expect(run(f).checks.find((c) => c.code === "RequiredProductNames")?.outcome).toBe("HardError");
});
it("requires media presence without inferring actual processing readiness", () => {
  const f = policyFixture();
  f.policy.mediaRequirement = "Required";
  expect(run(f).checks.find((c) => c.code === "RequiredMediaPresence")?.outcome).toBe("HardError");
});
it("rejects unsupported policy-required locales as a hard constraint", () => {
  const f = policyFixture();
  f.policy.requiredLocales.push("de-DE");
  expect(run(f).decision).toBe("HardError");
});
it.each([
  "tenantReference",
  "productReference",
  "versionReference",
  "expectedAggregateVersion",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "observedAt",
  "validUntil",
])("binds %s and never uses a stale supplied receipt", (field) => {
  const f = policyFixture();
  const patch =
    field === "expectedAggregateVersion"
      ? 2
      : field === "observedAt"
        ? "2026-09-30T05:59:59.999Z"
        : field === "validUntil"
          ? "2026-09-30T06:00:21.000Z"
          : field.endsWith("Digest")
            ? "sha256:" + "b".repeat(64)
            : id(99);
  expect(() =>
    assessCatalogProductContentPolicy(f.aggregate, f.brand, f.policy, {
      ...f.binding,
      [field]: patch,
    }),
  ).toThrow();
});
it("never invokes a supplied body or binding getter", () => {
  const f = policyFixture(),
    getter = vi.fn(() => id(6));
  const binding = Object.defineProperty({ ...f.binding }, "tenantReference", { get: getter });
  expect(() =>
    assessCatalogProductContentPolicy(f.aggregate, f.brand, f.policy, binding),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("keeps legacy missing full content unavailable rather than inventing empty fields", () => {
  const f = policyFixture(),
    { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = { ...f.aggregate, draft },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  expect(
    assessCatalogProductContentPolicy(aggregate, f.brand, f.policy, {
      ...f.binding,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    }).checks.find((c) => c.code === "CompleteContent")?.outcome,
  ).toBe("HardError");
});
it.each(["localizedShortDescriptions", "localizedDescriptions", "preparationNotes"] as const)(
  "checks Brand-supported locale in optional %s",
  (field) => {
    const f = policyFixture();
    const aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        editorContent: {
          ...f.aggregate.draft.editorContent,
          [field]: { "de-DE": "Synthetic unsupported locale" },
        },
      },
    };
    const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
    const r = assessCatalogProductContentPolicy(aggregate, f.brand, f.policy, {
      ...f.binding,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    });
    expect(r.checks.find((c) => c.code === "SupportedLocales")?.outcome).toBe("HardError");
  },
);
it("checks SKU and Media alternative-text locales without accepting a Ready field", () => {
  const f = policyFixture();
  const sku = f.aggregate.draft.skus[0];
  if (!sku) throw new Error("Missing fixture SKU");
  const aggregate = {
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      skus: [{ ...sku, localizedNames: { ...sku.localizedNames, "de-DE": "Synthetic" } }],
      editorContent: {
        ...f.aggregate.draft.editorContent,
        media: [
          {
            mediaReference: id(50),
            assetReference: id(51),
            assetVersionReference: id(52),
            role: "Primary",
            altText: { "de-DE": "Synthetic" },
            sortOrder: 0,
            cropReference: null,
            focusReference: null,
          },
        ],
      },
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const r = assessCatalogProductContentPolicy(aggregate, f.brand, f.policy, {
    ...f.binding,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  });
  expect(r.checks.find((c) => c.code === "SupportedLocales")?.outcome).toBe("HardError");
  expect(r.mediaReadiness).toBe("NotEvaluated");
  expect(() =>
    deriveCatalogProductPublicationContentIdentity({
      ...aggregate,
      draft: {
        ...aggregate.draft,
        editorContent: {
          ...aggregate.draft.editorContent,
          media: aggregate.draft.editorContent.media.map((m) => ({ ...m, Ready: true })),
        },
      },
    }),
  ).toThrow();
});
it("checks Variant dimension and value locales even when no SKU selects them", () => {
  const f = policyFixture();
  const aggregate = {
    ...f.aggregate,
    draft: {
      ...f.aggregate.draft,
      skus: [],
      editorContent: {
        ...f.aggregate.draft.editorContent,
        variantDimensions: [
          {
            dimensionReference: id(40),
            code: "SIZE",
            localizedNames: { "en-CA": "Synthetic", "de-DE": "Synthetic" },
            sortOrder: 0,
            selectionRequirement: "Optional",
            values: [
              {
                valueReference: id(41),
                code: "ONE",
                localizedNames: { "en-CA": "Synthetic", "de-DE": "Synthetic" },
                sortOrder: 0,
                attributeReference: null,
                mediaReference: null,
              },
            ],
          },
        ],
      },
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const r = assessCatalogProductContentPolicy(aggregate, f.brand, f.policy, {
    ...f.binding,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  });
  expect(r.checks.find((c) => c.code === "SupportedLocales")?.outcome).toBe("HardError");
});

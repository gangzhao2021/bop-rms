import { expect, it } from "vitest";
import {
  assessCatalogProductContentPolicy,
  assessCatalogProductDraftContentPolicy,
  deriveCatalogProductPublicationContentIdentity,
} from "../index.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T18:00:00.000Z",
  until = "2026-10-04T18:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function fixture() {
  const aggregate = {
      productReference: id(1),
      brandReference: id(2),
      internalCode: "DRAFT_POLICY",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(3),
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic incomplete Draft" } as Record<string, string>,
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {} as Record<string, string>,
          localizedDescriptions: {},
          preparationNotes: {},
          media: [],
          tagReferences: [],
          attributeValues: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    },
    brand = {
      tenantReference: id(5),
      brandReference: id(2),
      brandVersion: 1,
      configurationVersionReference: id(6),
      contentDigest: digest,
      currentPublicationReference: id(7),
      supportedLocales: ["en-CA", "fr-CA"],
      observedAt: at,
      validUntil: until,
      originalIntentDigest: digest,
    },
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(5),
      brandReference: id(2),
      familyReference: id(8),
      policyReference: id(9),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA", "fr-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: until,
    };
  const bind = () => {
    const { referenceConfiguration, ...identity } =
      deriveCatalogProductPublicationContentIdentity(aggregate);
    void referenceConfiguration;
    return {
      ...identity,
      tenantReference: id(5),
      productReference: id(1),
      versionReference: id(4),
      expectedAggregateVersion: 1,
      originalIntentDigest: digest,
      observedAt: at,
      validUntil: until,
    };
  };
  return {
    aggregate,
    brand,
    policy,
    bind,
    run: () => assessCatalogProductDraftContentPolicy(aggregate, brand, policy, bind()),
  };
}
it("allows incomplete Draft names/media as warnings while the identical Publish candidate remains HardError", () => {
  const f = fixture(),
    draft = f.run(),
    publish = assessCatalogProductContentPolicy(f.aggregate, f.brand, f.policy, f.bind());
  expect(draft.profile).toBe("CatalogProductDraftContentPolicyAssessmentV1");
  expect(draft.decision).toBe("PassForAssessedDraftRules");
  expect(
    draft.checks.filter((check) => check.outcome === "Warning").map((check) => check.code),
  ).toEqual(["RequiredProductNames", "RequiredMediaPresence"]);
  expect(publish.profile).toBe("CatalogProductContentPolicyAssessmentV1");
  expect(publish.decision).toBe("HardError");
  expect(
    publish.checks.filter((check) => check.outcome === "HardError").map((check) => check.code),
  ).toEqual(["RequiredProductNames", "RequiredMediaPresence"]);
  expect(draft).toMatchObject({
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    mediaReadiness: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    brandFieldRequirements: "NotEvaluated",
    eligibility: "NotEvaluated",
    warningOverrideAllowed: false,
  });
});
it.each(["name", "description"])("refuses unsupported %s locale keys in Draft", (kind) => {
  const f = fixture();
  if (kind === "name") f.aggregate.draft.localizedNames["de-DE"] = "Unsupported";
  else f.aggregate.draft.editorContent.localizedShortDescriptions["de-DE"] = "Unsupported";
  expect(f.run().checks.find((check) => check.code === "SupportedLocales")?.outcome).toBe(
    "HardError",
  );
  expect(f.run().decision).toBe("HardError");
});
it("still requires a default-locale name", () => {
  const f = fixture();
  f.aggregate.draft.localizedNames = { "fr-CA": "Nom" };
  expect(() => f.run()).toThrow();
});
it("still requires complete editor content structure", () => {
  const f = fixture(),
    { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = { ...f.aggregate, draft },
    { referenceConfiguration, ...identity } =
      deriveCatalogProductPublicationContentIdentity(aggregate);
  void referenceConfiguration;
  const result = assessCatalogProductDraftContentPolicy(aggregate, f.brand, f.policy, {
    ...f.bind(),
    ...identity,
  });
  expect(result.checks.find((check) => check.code === "CompleteContent")?.outcome).toBe(
    "HardError",
  );
});
it.each([
  "brandReference",
  "productReference",
  "versionReference",
  "originalIntentDigest",
  "validUntil",
  "contentDigest",
])("refuses invalid held %s binding", (field) => {
  const f = fixture(),
    binding = f.bind();
  const bad =
    field === "validUntil" ? "2026-10-04T18:00:06.000Z" : field.endsWith("Digest") ? "bad" : id(99);
  if (field === "brandReference")
    expect(() =>
      assessCatalogProductDraftContentPolicy(
        f.aggregate,
        { ...f.brand, brandReference: bad },
        f.policy,
        binding,
      ),
    ).toThrow();
  else
    expect(() =>
      assessCatalogProductDraftContentPolicy(f.aggregate, f.brand, f.policy, {
        ...binding,
        [field]: bad,
      }),
    ).toThrow();
});
it("keeps observed policy requirements and sources without exposing content or readiness claims", () => {
  const f = fixture();
  f.policy.requiredLocales = ["en-CA"];
  f.policy.mediaRequirement = "Optional";
  const result = f.run();
  expect(result.checks.every((check) => check.outcome === "Pass")).toBe(true);
  for (const key of ["content", "localizedNames", "media", "referenceConfiguration"])
    expect(Object.hasOwn(result, key)).toBe(false);
  expect(result.policyReference).toBe(f.policy.policyReference);
  expect(result.brandSource.configurationVersionReference).toBe(
    f.brand.configurationVersionReference,
  );
});

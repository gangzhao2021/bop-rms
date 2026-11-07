import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  assessCatalogProductContentPolicy,
  assessCatalogProductContentPolicyV2,
  parseCatalogProductContentPolicyBinding,
  parseCatalogProductContentPolicyBindingV2,
} from "../contracts/product-content-policy.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";
const id = (n: number) => "01902436-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T10:00:00.000Z",
  until = "2026-10-03T10:00:20.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const aggregate = {
      productReference: id(5),
      brandReference: id(2),
      internalCode: "CONTENT",
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
    },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old command"),
      previousScopeDigest: hash("old scope"),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    intent = { ...body, digest: hash(body) },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
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
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    }),
    binding = {
      profile: "CatalogProductContentPolicyBindingV2",
      tenantReference: id(1),
      productReference: id(5),
      versionReference: id(6),
      expectedAggregateVersion: 1,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      originalIntentDigest: hash(command),
      replacementIntentDigest: intent.digest,
      observedAt: at,
      validUntil: until,
    },
    brand = {
      tenantReference: id(1),
      brandReference: id(2),
      brandVersion: 1,
      configurationVersionReference: id(10),
      contentDigest: hash("brand"),
      currentPublicationReference: id(11),
      supportedLocales: ["en-CA", "fr-CA"],
      observedAt: at,
      validUntil: until,
      originalIntentDigest: hash(command),
    },
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(12),
      policyReference: id(13),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: until,
    };
  return { aggregate, command, binding, brand, policy };
}
const run = (f: ReturnType<typeof fixture>) =>
  assessCatalogProductContentPolicyV2(f.command, f.aggregate, f.brand, f.policy, f.binding);
it("binds full command/target and frozen content without claiming Media, SKU or all-check eligibility", () => {
  const f = fixture(),
    result = run(f);
  expect(result).toMatchObject({
    profile: "CatalogProductContentPolicyAssessmentV2",
    originalIntentDigest: hash(f.command),
    replacementIntentDigest: f.command.replacementIntentDigest,
    decision: "PassForAssessedRules",
    mediaReadiness: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(Object.isFrozen(result.checks)).toBe(true);
  expect(Object.isFrozen(result.brandSource)).toBe(true);
  const original = result.digest;
  f.brand.supportedLocales.pop();
  expect(result.digest).toBe(original);
});
it.each(["media", "locale"])("records negative %s necessary conditions", (mode) => {
  const f = fixture();
  if (mode === "media") f.policy.mediaRequirement = "Required";
  else f.policy.requiredLocales = ["fr-CA"];
  const result = run(f);
  expect(result.decision).toBe("HardError");
  expect(
    result.checks.find(
      (check) =>
        check.code === (mode === "media" ? "RequiredMediaPresence" : "RequiredProductNames"),
    )?.outcome,
  ).toBe("HardError");
});
it.each([
  "originalIntentDigest",
  "replacementIntentDigest",
  "contentDigest",
  "configurationDigest",
  "tenantReference",
  "productReference",
  "versionReference",
  "expectedAggregateVersion",
])("rejects changed %s", (key) => {
  const f = fixture(),
    binding = {
      ...f.binding,
      [key]: key.endsWith("Digest")
        ? hash("wrong")
        : key === "expectedAggregateVersion"
          ? 2
          : id(99),
    };
  expect(() =>
    assessCatalogProductContentPolicyV2(f.command, f.aggregate, f.brand, f.policy, binding),
  ).toThrow();
});
it("rejects another operation or target even with identical scope/content", () => {
  const f = fixture();
  expect(() =>
    assessCatalogProductContentPolicyV2(
      { ...f.command, operationReference: id(99) },
      f.aggregate,
      f.brand,
      f.policy,
      f.binding,
    ),
  ).toThrow();
  const body = Object.fromEntries(
      Object.entries({ ...f.command.replacementIntent, previousVersionReference: id(99) }).filter(
        ([key]) => key !== "digest",
      ),
    ),
    intent = { ...body, digest: hash(body) };
  expect(() =>
    assessCatalogProductContentPolicyV2(
      { ...f.command, replacementIntent: intent, replacementIntentDigest: intent.digest },
      f.aggregate,
      f.brand,
      f.policy,
      f.binding,
    ),
  ).toThrow();
});
it("retains V1 canonical outcomes and refuses mixed bindings and accessors", () => {
  const f = fixture(),
    legacy = Object.fromEntries(
      Object.entries(f.binding).filter(
        ([key]) => !["profile", "replacementIntentDigest"].includes(key),
      ),
    ),
    old = assessCatalogProductContentPolicy(f.aggregate, f.brand, f.policy, legacy),
    current = run(f),
    expected = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => !["profile", "replacementIntentDigest", "digest"].includes(key),
      ),
    ),
    oldBody = { profile: "CatalogProductContentPolicyAssessmentV1", ...expected };
  expect(old).toEqual({ ...oldBody, digest: hash(oldBody) });
  expect(parseCatalogProductContentPolicyBinding(legacy)).toEqual(legacy);
  expect(() => parseCatalogProductContentPolicyBinding(f.binding)).toThrow();
  expect(() => parseCatalogProductContentPolicyBindingV2(legacy)).toThrow();
  expect(() => run({ ...f, binding: { ...f.binding, profile: "Unknown" } })).toThrow();
  const get = vi.fn();
  expect(() =>
    parseCatalogProductContentPolicyBindingV2(
      Object.defineProperty({ ...f.binding }, "replacementIntentDigest", { get, enumerable: true }),
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("preserves missing content as HardError and refuses time rebasing or wrong Brand", () => {
  const f = fixture(),
    draft = Object.fromEntries(
      Object.entries(f.aggregate.draft).filter(([key]) => key !== "editorContent"),
    ),
    aggregate = { ...f.aggregate, draft },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    c = {
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
    binding = {
      ...f.binding,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      originalIntentDigest: hash(c),
    },
    result = assessCatalogProductContentPolicyV2(
      c,
      aggregate,
      { ...f.brand, originalIntentDigest: hash(c) },
      f.policy,
      binding,
    );
  expect(result.checks.find((check) => check.code === "CompleteContent")?.outcome).toBe(
    "HardError",
  );
  expect(() =>
    assessCatalogProductContentPolicyV2(
      f.command,
      f.aggregate,
      { ...f.brand, brandReference: id(99) },
      f.policy,
      f.binding,
    ),
  ).toThrow();
  expect(() =>
    run({ ...f, binding: { ...f.binding, validUntil: "2026-10-03T10:00:30.001Z" } }),
  ).toThrow();
  expect(() => run({ ...f, brand: { ...f.brand, observedAt: until } })).toThrow();
});

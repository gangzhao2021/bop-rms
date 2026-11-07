import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  bindCatalogProductValidationCandidate,
  bindCatalogProductValidationCandidateV2,
  productValidationCandidateFields,
  productValidationCandidateFieldsV2,
} from "../contracts/product-validation-candidate.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { parseProductPublicationCommandV2 } from "../contracts/product-publication-v2.js";

const id = (n: number) => "01902432-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const without = (value: object, ...keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
function fixture(complete = true) {
  const aggregate = {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_V2",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 8,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: id(40),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic candidate" },
      taxClassificationReference: null,
      skus: [
        {
          skuReference: id(7),
          productReference: id(5),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Active",
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
      ...(complete
        ? {
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
          }
        : {}),
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = {
      level: "Store",
      reference: id(30),
      channelCodes: ["WEB"],
      orderTypeCodes: ["PICKUP"],
    },
    effectivePeriod = {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 4,
      previousIntentDigest: hash("original"),
      previousScopeDigest: hash([selector, { ...selector, reference: id(31) }]),
      previousPeriodDigest: hash(effectivePeriod),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    replacementIntent = { ...intentBody, digest: hash(intentBody) },
    command = {
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
      effectivePeriod,
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_VALIDATE",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    };
  return { aggregate, command, intentBody };
}

it("binds the complete V2 command and frozen current content without granting qualification", () => {
  const f = fixture(),
    result = bindCatalogProductValidationCandidateV2(f.command, f.aggregate, at);
  expect(result).toMatchObject({
    profile: "CatalogProductValidationCandidateV2",
    replacementIntentDigest: f.command.replacementIntentDigest,
    completeContent: "Present",
    skuPrerequisite: "ActiveMemberPresent",
    publicationHead: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    validUntil: "2026-10-02T12:00:30.000Z",
  });
  expect(result.originalIntentDigest).toBe(hash(parseProductPublicationCommandV2(f.command)));
  expect(result.originalIntentDigest).not.toBe(
    hash(without(f.command, "profile", "replacementIntent", "replacementIntentDigest")),
  );
  expect(Object.hasOwn(result, "internalCodeCheck")).toBe(false);
  expect(result.aggregate).not.toBe(f.aggregate);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.aggregate.draft.skus)).toBe(true);
  f.aggregate.draft.localizedNames["en-CA"] = "Changed after binding";
  expect(result.aggregate.draft.localizedNames["en-CA"]).toBe("Synthetic candidate");
  expect(productValidationCandidateFieldsV2).toEqual([
    ...productValidationCandidateFields,
    "replacementIntent",
    "replacementIntentDigest",
  ]);
});
it("retains missing complete content and unresolved mechanical prerequisites", () => {
  const f = fixture(false),
    result = bindCatalogProductValidationCandidateV2(f.command, f.aggregate, at);
  expect(result).toMatchObject({
    completeContent: "Unavailable",
    variantMappingPrerequisite: "Unavailable",
    optionSelectionPrerequisite: "Unavailable",
  });
  expect(Object.hasOwn(result.aggregate.draft, "editorContent")).toBe(false);
});
it("keeps V1 and V2 public binders closed in both directions", () => {
  const f = fixture(),
    legacy = without(f.command, "profile", "replacementIntent", "replacementIntentDigest");
  expect(() => bindCatalogProductValidationCandidate(f.command, f.aggregate, at)).toThrow();
  expect(() => bindCatalogProductValidationCandidateV2(legacy, f.aggregate, at)).toThrow();
  expect(bindCatalogProductValidationCandidate(legacy, f.aggregate, at).profile).toBe(
    "CatalogProductValidationCandidateV1",
  );
});
it("binds another well-formed target as a different intent, without claiming current target proof", () => {
  const f = fixture(),
    changedBody = { ...f.intentBody, previousPublicationOperationReference: id(42) },
    replacementIntent = { ...changedBody, digest: hash(changedBody) },
    command = {
      ...f.command,
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    };
  const a = bindCatalogProductValidationCandidateV2(f.command, f.aggregate, at),
    b = bindCatalogProductValidationCandidateV2(command, f.aggregate, at);
  expect(a.originalIntentDigest).not.toBe(b.originalIntentDigest);
  expect(a.replacementIntentDigest).not.toBe(b.replacementIntentDigest);
  expect(b.publicationHead).toBe("NotEvaluated");
});
it.each([
  { brandReference: id(90) },
  { productReference: id(90) },
  { versionReference: id(90) },
  { expectedProductAggregateVersion: 7 },
  { contentDigest: hash("wrong") },
  { configurationDigest: hash("wrong") },
  { action: "SubmitReview" },
  { actorKind: "System" },
  { occurredAt: "2026-10-02T12:00:00.001Z" },
  { replacementIntentDigest: hash("wrong") },
  { replacementIntent: null },
  { profile: "CatalogProductPublicationCommandV1" },
  { validation: { decision: "Pass" } },
])("refuses mismatched identity, action or full V2 binding %j", (patch) => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationCandidateV2({ ...f.command, ...patch }, f.aggregate, at),
  ).toThrow();
});
it.each(["updatedAt", "draftUpdatedAt", "content"])(
  "refuses current candidate %s drift",
  (field) => {
    const f = fixture();
    if (field === "updatedAt") f.aggregate.updatedAt = "2026-10-02T12:00:00.001Z";
    if (field === "draftUpdatedAt") f.aggregate.draft.updatedAt = "2026-10-02T12:00:00.001Z";
    if (field === "content") f.aggregate.draft.localizedNames["en-CA"] = "Changed";
    expect(() => bindCatalogProductValidationCandidateV2(f.command, f.aggregate, at)).toThrow();
  },
);
it.each(["command", "intent", "aggregate"])(
  "rejects %s accessors without executing them",
  (target) => {
    const f = fixture(),
      getter = vi.fn();
    if (target === "command")
      Object.defineProperty(f.command, "replacementIntentDigest", { get: getter });
    if (target === "intent")
      Object.defineProperty(f.command.replacementIntent, "previousSelectorDigest", { get: getter });
    if (target === "aggregate")
      Object.defineProperty(f.aggregate.draft, "localizedNames", { get: getter });
    expect(() => bindCatalogProductValidationCandidateV2(f.command, f.aggregate, at)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  },
);

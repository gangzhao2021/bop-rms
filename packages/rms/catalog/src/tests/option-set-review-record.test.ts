import { expect, it, vi } from "vitest";
import { createCatalogOptionSetContentReviewBinding } from "../contracts/option-set-review-binding.js";
import {
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "../contracts/option-set-editor-content.js";
import {
  createCatalogOptionSetReviewRecord,
  parseCatalogOptionSetReviewRecord,
  createCatalogOptionSetReleaseRecord,
  parseCatalogOptionSetReleaseRecord,
  parseCatalogOptionSetStoredReviewBinding,
} from "../contracts/option-set-review-record.js";
function requiredValue<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("required synthetic fixture item is missing");
  return value;
}
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-04T00:00:00.000Z",
  fingerprint = "sha256:" + "a".repeat(64);
function fixture() {
  const source = {
    optionSetReference: id(4),
    brandReference: id(2),
    internalCode: "SYNTHETIC_CHOICES",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(5),
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      createdAt: at,
      updatedAt: at,
      options: [
        {
          optionReference: id(6),
          optionSetReference: id(4),
          brandReference: id(2),
          stableCode: "ONE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic one" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
    },
  };
  const details = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        optionReference: id(6),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null,
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
  };
  const prepared = parseCatalogOptionSetEditorContent(source, details);
  const binding = createCatalogOptionSetContentReviewBinding({
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    expectedAggregateVersion: 1,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    graphDigest: fingerprint,
    policyReference: id(7),
    policyVersion: 1,
    policyContentDigest: fingerprint,
    currentPolicyPublicationReference: id(8),
    originalIntentDigest: fingerprint,
    activationAt: at,
  });
  const review = createCatalogOptionSetReviewRecord({
    operationReference: id(10),
    sourceOperationReference: id(9),
    lifecycleReference: id(11),
    actorReference: id(3),
    auditReference: id(12),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    binding,
    content: prepared.content,
  });
  const sealed = createCatalogFullOptionSetPublicationMaterialization(source, details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(13),
    publicationIntentDigest: fingerprint,
    successorDraftVersionReference: id(14),
    sealedAt: at,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  }).content;
  const release = createCatalogOptionSetReleaseRecord({
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    operationReference: id(15),
    reviewOperationReference: review.operationReference,
    reviewRecordDigest: review.digest,
    reviewBindingDigest: binding.digest,
    sealOperationReference: id(13),
    sealRecordDigest: sealed.digest,
    publishingOperationReference: id(16),
    actorReference: id(3),
    auditReference: id(17),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    release: {
      releaseId: id(18),
      familyReference: id(4),
      configurationType: "CATALOG_OPTION_SET",
      purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
      snapshotReference: id(5),
      snapshotDigest: binding.digest,
      scope: { kind: "Brand", brandReference: id(2), storeReference: null },
      sequence: 1,
      sourceLifecycleId: id(11),
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    },
  });
  return { source, details, prepared, binding, review, sealed, release };
}

it("retains original full preimage and content while distinguishing release and content digests", () => {
  const f = fixture();
  expect(parseCatalogOptionSetReviewRecord(f.review)).toEqual(f.review);
  expect(parseCatalogOptionSetReleaseRecord(f.release)).toEqual(f.release);
  expect(f.release.reviewBindingDigest).not.toBe(f.release.sealRecordDigest);
  expect(f.review).not.toHaveProperty("approval");
  expect(f.release).not.toHaveProperty("currentEligibility");
  expect(Object.isFrozen(f.review.binding)).toBe(true);
});
it("rejects a stored binding whose preimage changed, even when its digest is retained", () => {
  const f = fixture();
  expect(() =>
    parseCatalogOptionSetStoredReviewBinding({
      ...f.binding,
      graphDigest: "sha256:" + "b".repeat(64),
    }),
  ).toThrow();
  expect(() =>
    parseCatalogOptionSetReviewRecord({ ...f.review, sourceOperationReference: id(99) }),
  ).toThrow();
});
it.each([
  "sourceDigest",
  "contentDigest",
  "configurationDigest",
  "versionReference",
  "expectedAggregateVersion",
])("rejects review content inconsistent with %s", (key) => {
  const f = fixture(),
    { profile, digest, ...body } = f.binding;
  void profile;
  void digest;
  const value =
    key === "expectedAggregateVersion"
      ? 2
      : key === "versionReference"
        ? id(99)
        : "sha256:" + "b".repeat(64);
  const changed = createCatalogOptionSetContentReviewBinding({ ...body, [key]: value });
  const { profile: recordProfile, digest: recordDigest, ...input } = f.review;
  void recordProfile;
  void recordDigest;
  expect(() => createCatalogOptionSetReviewRecord({ ...input, binding: changed })).toThrow();
});
it.each(["snapshotDigest", "familyReference", "snapshotReference", "purposeCode", "kind"])(
  "refuses release with mismatched %s",
  (key) => {
    const f = fixture(),
      { profile, digest, ...input } = f.release;
    void profile;
    void digest;
    const replacement =
      key === "snapshotDigest"
        ? fingerprint
        : key === "purposeCode"
          ? "UNRELATED"
          : key === "kind"
            ? "Rollback"
            : id(99);
    expect(() =>
      createCatalogOptionSetReleaseRecord({
        ...input,
        release: { ...f.release.release, [key]: replacement },
      }),
    ).toThrow();
  },
);
it("refuses unknown qualification fields and accessors without executing them", () => {
  const f = fixture(),
    getter = vi.fn(() => f.review.binding);
  expect(() => parseCatalogOptionSetReviewRecord({ ...f.review, approval: "Accepted" })).toThrow();
  const value = { ...f.review };
  Object.defineProperty(value, "binding", { enumerable: true, get: getter });
  expect(() => parseCatalogOptionSetReviewRecord(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("retains a legal near-one-MiB Draft plus review header within the larger bounded record budget", () => {
  const f = fixture(),
    locales = ["en-CA", "fr-CA", "en-US", "fr-FR", "es-ES", "de-DE", "it-IT"];
  const options = Array.from({ length: 100 }, (_, index) => ({
    ...requiredValue(f.source.draft.options[0]),
    optionReference: id(400 + index),
    stableCode: "CHOICE_" + index,
    sortOrder: index,
    localizedDescriptions: Object.fromEntries(locales.map((locale) => [locale, "界".repeat(500)])),
  }));
  const source = { ...f.source, draft: { ...f.source.draft, options } };
  const details = {
    ...f.details,
    optionDetails: options.map((option) => ({
      ...requiredValue(f.details.optionDetails[0]),
      optionReference: option.optionReference,
    })),
  };
  const content = { ...details, sourceAggregate: source };
  // PostgreSQL jsonb text uses spaces between members; include that overhead,
  // rather than treating a smaller compact JSON byte count as the SQL budget.
  function sqlJson(value: unknown): string {
    if (Array.isArray(value)) return "[" + value.map(sqlJson).join(", ") + "]";
    if (value !== null && typeof value === "object")
      return (
        "{" +
        Object.entries(value)
          .map(([key, item]) => JSON.stringify(key) + ": " + sqlJson(item))
          .join(", ") +
        "}"
      );
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("unsupported synthetic JSON");
    return serialized;
  }
  const bytes = (value: unknown) => new TextEncoder().encode(sqlJson(value)).byteLength;
  for (const option of options) {
    for (const locale of locales) {
      const excess = bytes(content) - 1_048_000;
      if (excess <= 0) break;
      const text = requiredValue(option.localizedDescriptions[locale]);
      option.localizedDescriptions[locale] = text.slice(
        0,
        Math.max(1, text.length - Math.ceil(excess / 3)),
      );
    }
    if (bytes(content) <= 1_048_000) break;
  }
  const prepared = parseCatalogOptionSetEditorContent(source, details);
  const { profile, digest, ...originalBinding } = f.binding;
  void profile;
  void digest;
  const binding = createCatalogOptionSetContentReviewBinding({
    ...originalBinding,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  });
  const { profile: reviewProfile, digest: reviewDigest, ...originalReview } = f.review;
  void reviewProfile;
  void reviewDigest;
  const review = createCatalogOptionSetReviewRecord({
    ...originalReview,
    binding,
    content: prepared.content,
  });
  expect(bytes(prepared.content)).toBeLessThanOrEqual(1_048_576);
  expect(bytes(review)).toBeGreaterThan(1_048_576);
  expect(bytes(review)).toBeLessThanOrEqual(2_097_152);
  expect(parseCatalogOptionSetReviewRecord(review)).toEqual(review);
});

import { it, expect } from "vitest";
import { parseCatalogOptionSetEditorContent } from "../contracts/option-set-editor-content.js";
import { createCatalogOptionSetContentReviewBinding } from "../contracts/option-set-review-binding.js";
import { createCatalogOptionSetReviewRecord } from "../contracts/option-set-review-record.js";
import {
  prepareCatalogOptionSetRecordedReviewQualification as prepare,
  assertCatalogOptionSetRecordedReviewQualification as assertQualification,
} from "../contracts/option-set-review-qualification.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T00:00:00.000Z",
  later = "2026-10-04T00:01:00.000Z",
  fingerprint = "sha256:" + "a".repeat(64);
function fixture(activationAt = at) {
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
  const original = {
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
    activationAt,
  };
  const record = createCatalogOptionSetReviewRecord({
    operationReference: id(9),
    sourceOperationReference: id(10),
    lifecycleReference: id(11),
    actorReference: id(3),
    auditReference: id(12),
    reasonCode: "AUTHORIZED_OPERATION",
    recordedAt: at,
    binding: createCatalogOptionSetContentReviewBinding(original),
    content: prepared.content,
  });
  const fresh = {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(4),
    versionReference: id(5),
    expectedAggregateVersion: 1,
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
    graphDigest: fingerprint,
    originalIntentDigest: "sha256:" + "b".repeat(64),
    observedAt: later,
    validUntil: "2026-10-04T00:01:05.000Z",
  };
  return { record, fresh, original, content: prepared.content };
}
it("preserves original review identity while deriving only a fresh qualification target", () => {
  const f = fixture(),
    p = prepare(f.record, f.fresh);
  expect(p.reviewBinding).toEqual(f.record.binding);
  expect(p.qualifiedActivationAt).toBe(later);
  expect(p.qualificationBinding.originalIntentDigest).toBe(f.fresh.originalIntentDigest);
  expect(p.reviewBinding.originalIntentDigest).toBe(fingerprint);
  const target = createCatalogOptionSetContentReviewBinding({
    ...f.original,
    originalIntentDigest: f.fresh.originalIntentDigest,
    activationAt: later,
  });
  expect(assertQualification(f.record, p.qualificationBinding, target, id(10), f.content)).toEqual(
    p,
  );
});
it("retains exact scheduled activation rather than retargeting its approval", () => {
  const f = fixture("2026-10-04T01:00:00.000Z");
  expect(prepare(f.record, f.fresh).qualifiedActivationAt).toBe(f.record.binding.activationAt);
});
it("rejects oversized fresh lease and a Review recorded after the new origin", () => {
  const f = fixture();
  expect(() => prepare(f.record, { ...f.fresh, validUntil: "2026-10-04T00:01:05.001Z" })).toThrow();
  const { profile, digest, ...input } = f.record;
  void profile;
  void digest;
  const futureRecord = createCatalogOptionSetReviewRecord({
    ...input,
    recordedAt: "2026-10-04T00:01:00.001Z",
  });
  expect(() => prepare(futureRecord, f.fresh)).toThrow();
});
it.each([
  "sourceDigest",
  "configurationDigest",
  "graphDigest",
  "expectedAggregateVersion",
  "versionReference",
] as const)("rejects changed reviewed %s", (key) => {
  const f = fixture();
  expect(() =>
    prepare(f.record, {
      ...f.fresh,
      [key]:
        key === "expectedAggregateVersion"
          ? 2
          : key === "versionReference"
            ? id(99)
            : "sha256:" + "c".repeat(64),
    }),
  ).toThrow();
});
it("rejects changed current policy/publication and source operation or content", () => {
  const f = fixture(),
    p = prepare(f.record, f.fresh);
  const target = {
    ...f.original,
    originalIntentDigest: f.fresh.originalIntentDigest,
    activationAt: later,
  };
  for (const patch of [
    { policyVersion: 2 },
    { policyContentDigest: "sha256:" + "c".repeat(64) },
    { currentPolicyPublicationReference: id(99) },
  ])
    expect(() =>
      assertQualification(
        f.record,
        p.qualificationBinding,
        createCatalogOptionSetContentReviewBinding({ ...target, ...patch }),
        id(10),
        f.content,
      ),
    ).toThrow();
  expect(() =>
    assertQualification(
      f.record,
      p.qualificationBinding,
      createCatalogOptionSetContentReviewBinding(target),
      id(99),
      f.content,
    ),
  ).toThrow();
  expect(() =>
    assertQualification(
      f.record,
      p.qualificationBinding,
      createCatalogOptionSetContentReviewBinding(target),
      id(10),
      {},
    ),
  ).toThrow();
});

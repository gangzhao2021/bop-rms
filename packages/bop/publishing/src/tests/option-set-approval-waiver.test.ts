import { describe, expect, it, vi } from "vitest";
import {
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingInstant,
} from "../contracts/publishing.js";
import {
  parsePublishingOptionSetReviewPolicy,
  parsePublishingOptionSetApprovalWaiver,
  publishingOptionSetApprovalWaiverDigest,
} from "../contracts/option-set-approval-waiver.js";
import {
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyScopeLevels,
} from "../contracts/option-set-publication-policy.js";
import { createPostgresPublishingMutationStore } from "../infrastructure/persistence/publishing-mutation-store.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = parsePublishingInstant("2026-09-11T10:00:00.000Z"),
  until = parsePublishingInstant("2026-09-11T11:00:00.000Z");
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
function binding() {
  const policyContent = {
    profile: "PublishingOptionSetPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(3),
    policyReference: id(4),
    policyVersion: 1,
    scopeOrder: [...optionSetPolicyScopeLevels],
    approvalPolicy: "NotRequired",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: until,
  };
  const reviewLifecycle = createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(id(10)),
    familyReference: parsePublishingReference(id(11)),
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
    snapshotReference: parsePublishingReference(id(12)),
    snapshotDigest: parsePublishingDigest("sha256:" + "a".repeat(64)),
    scope,
    version: parsePublishingVersion(2),
    state: "InReview",
    validationEvidenceReference: parsePublishingReference(id(13)),
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  });
  const validationEvidence = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(13)),
    snapshotReference: reviewLifecycle.snapshotReference,
    snapshotDigest: reviewLifecycle.snapshotDigest,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: until,
    checkCodes: [parsePublishingCode("REFERENCES_VALID")],
  });
  return {
    profile: "PublishingOptionSetReviewPolicyV1",
    tenantReference: id(1),
    policyContent,
    policyReleaseReference: id(5),
    policyReleaseSequence: 1,
    policySnapshotDigest: publishingOptionSetPublicationPolicyDigest(policyContent),
    reviewOperationReference: id(14),
    reviewLifecycle,
    validationEvidence,
    submittedActorReference: id(15),
    submittedAt: at,
  };
}
describe("immutable original Option Review policy and waiver", () => {
  it("detaches exact policy/review/validation and retains null approval", () => {
    const input = binding();
    const parsed = parsePublishingOptionSetReviewPolicy(input);
    input.policyContent.requiredLocales.push("fr-CA");
    expect(parsed.policyContent.requiredLocales).toEqual(["en-CA"]);
    const waiver = parsePublishingOptionSetApprovalWaiver({
      profile: "PublishingOptionSetApprovalWaiverV1",
      reviewPolicy: parsed,
      recordedAt: at,
    });
    expect(waiver.reviewPolicy.reviewLifecycle.approvalEvidenceReference).toBeNull();
    expect(publishingOptionSetApprovalWaiverDigest(waiver)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it.each(["tenant", "brand", "snapshot", "validation", "approved", "digest"])(
    "rejects mismatched original %s",
    (kind) => {
      const b = binding();
      const change =
        kind === "tenant"
          ? { tenantReference: id(30) }
          : kind === "brand"
            ? { policyContent: { ...b.policyContent, brandReference: id(30) } }
            : kind === "snapshot"
              ? {
                  reviewLifecycle: {
                    ...b.reviewLifecycle,
                    snapshotDigest: "sha256:" + "b".repeat(64),
                  },
                }
              : kind === "validation"
                ? { validationEvidence: { ...b.validationEvidence, result: "Fail" } }
                : kind === "approved"
                  ? {
                      reviewLifecycle: {
                        ...b.reviewLifecycle,
                        state: "Approved",
                        approvalEvidenceReference: id(30),
                      },
                    }
                  : { policySnapshotDigest: "sha256:" + "b".repeat(64) };
      expect(() => parsePublishingOptionSetReviewPolicy({ ...b, ...change })).toThrow();
    },
  );
  it("refuses Required and expired policies without fabricating an Approval", () => {
    const b = binding();
    const policyContent = { ...b.policyContent, approvalPolicy: "Required" };
    const required = {
      ...b,
      policyContent,
      policySnapshotDigest: publishingOptionSetPublicationPolicyDigest(policyContent),
    };
    expect(() =>
      parsePublishingOptionSetApprovalWaiver({
        profile: "PublishingOptionSetApprovalWaiverV1",
        reviewPolicy: required,
        recordedAt: at,
      }),
    ).toThrow();
    expect(() =>
      parsePublishingOptionSetApprovalWaiver({
        profile: "PublishingOptionSetApprovalWaiverV1",
        reviewPolicy: b,
        recordedAt: until,
      }),
    ).toThrow();
  });
  it("refuses open fields and getters without evaluating them", () => {
    const b = binding(),
      get = vi.fn(() => b.policyContent);
    Object.defineProperty(b, "policyContent", { enumerable: true, get });
    expect(() => parsePublishingOptionSetReviewPolicy(b)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(() =>
      parsePublishingOptionSetApprovalWaiver({
        profile: "PublishingOptionSetApprovalWaiverV1",
        reviewPolicy: binding(),
        recordedAt: at,
        approvalEvidence: null,
      }),
    ).toThrow();
  });
  it("requires explicit server family before the new owning preparation queries SQL", async () => {
    const query = vi.fn(),
      store = createPostgresPublishingMutationStore(
        { run: (work) => work({ query }) },
        id(1),
        scope,
      );
    const b = binding();
    await expect(
      store.resolveOptionSetReviewPolicy({
        reviewOperationReference: b.reviewOperationReference,
        reviewLifecycle: b.reviewLifecycle,
        validationEvidence: b.validationEvidence,
        submittedActorReference: b.submittedActorReference,
        submittedAt: at,
      }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects an accessor or caller-extensible configured-family selector", () => {
    const get = vi.fn(() => id(3));
    const options = { optionSetPolicyFamilyReference: id(3) };
    Object.defineProperty(options, "optionSetPolicyFamilyReference", { enumerable: true, get });
    const run = vi.fn();
    expect(() => createPostgresPublishingMutationStore({ run }, id(1), scope, options)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      createPostgresPublishingMutationStore({ run }, id(1), scope, {
        optionSetPolicyFamilyReference: id(3),
        callerSelected: true,
      } as typeof options),
    ).toThrow();
  });
});

it("requires explicit current qualification when the original NotRequired review lease is old", () => {
  const original = binding(),
    recordedAt = parsePublishingInstant("2026-09-11T10:10:00.000Z");
  const reviewPolicy = {
    ...original,
    validationEvidence: {
      ...original.validationEvidence,
      validUntil: parsePublishingInstant("2026-09-11T10:00:05.000Z"),
    },
  };
  const q = {
    profile: "PublishingOptionSetCurrentQualificationV1",
    tenantReference: id(1),
    operationReference: id(30),
    actorReference: id(31),
    scope,
    familyReference: reviewPolicy.reviewLifecycle.familyReference,
    lifecycleReference: reviewPolicy.reviewLifecycle.lifecycleId,
    expectedLifecycleVersion: reviewPolicy.reviewLifecycle.version,
    latestMutationOperationReference: reviewPolicy.reviewOperationReference,
    snapshotReference: reviewPolicy.reviewLifecycle.snapshotReference,
    snapshotDigest: reviewPolicy.reviewLifecycle.snapshotDigest,
    reviewOperationReference: reviewPolicy.reviewOperationReference,
    validationEvidenceReference: reviewPolicy.validationEvidence.evidenceReference,
    approvalOperationReference: null,
    approvalEvidenceReference: null,
    policyReference: reviewPolicy.policyContent.policyReference,
    policyVersion: reviewPolicy.policyContent.policyVersion,
    policyContentDigest: reviewPolicy.policySnapshotDigest,
    policyPublicationReference: reviewPolicy.policyReleaseReference,
    qualificationEvidenceReference: id(32),
    qualificationReportDigest: "sha256:" + "b".repeat(64),
    result: "Pass",
    originalObservedAt: recordedAt,
    checkedAt: recordedAt,
    validUntil: "2026-09-11T10:10:05.000Z",
    checkCodes: [
      "CURRENT_REFERENCES",
      "PUBLISHING_POLICY",
      "RULE_SATISFIABILITY",
      "SCOPE_TOPOLOGY",
    ],
    sourceAssessmentDigests: ["sha256:" + "c".repeat(64)],
  };
  const value = { profile: "PublishingOptionSetApprovalWaiverV1", reviewPolicy, recordedAt };
  expect(() => parsePublishingOptionSetApprovalWaiver(value)).toThrow();
  const parsed = parsePublishingOptionSetApprovalWaiver({ ...value, currentQualification: q });
  expect(parsed.reviewPolicy.validationEvidence.validUntil).toBe("2026-09-11T10:00:05.000Z");
  expect(parsed.currentQualification?.validUntil).toBe("2026-09-11T10:10:05.000Z");
  expect(() =>
    parsePublishingOptionSetApprovalWaiver({
      ...value,
      currentQualification: { ...q, policyPublicationReference: id(99) },
    }),
  ).toThrow();
  expect(() =>
    parsePublishingOptionSetApprovalWaiver({
      ...value,
      currentQualification: { ...q, validUntil: recordedAt },
    }),
  ).toThrow();
});

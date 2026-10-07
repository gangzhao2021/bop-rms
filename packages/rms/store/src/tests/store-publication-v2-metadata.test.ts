import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const sources = vi.hoisted(() => ({
  release: vi.fn(),
  independent: vi.fn(),
  liveGate: vi.fn(),
  candidate: vi.fn(),
  currentIndependent: vi.fn(),
}));
// Controlled public-owner boundaries test Store's binding checks only; these
// packets are not native Publishing/Live Gate or independent-review evidence.
vi.mock("@bop/publishing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({
    resolveCurrentRelease: sources.release,
    resolveCurrentReleaseIndependentApproval: sources.independent,
    resolvePublicationCandidate: sources.candidate,
    resolveCurrentIndependentApproval: sources.currentIndependent,
  }),
  createPostgresCurrentLiveGateSource: () => sources.liveGate,
}));
import {
  createPublishingScope,
  createPublishingReleaseRecord,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingVersion,
  parseReleaseSequence,
} from "@bop/publishing";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import { createStoreConfigurationPublicationHash } from "../contracts/store-configuration-publication-content.js";
import {
  createPostgresStorePublicationAuthorization,
  createPostgresStoreV2ApprovalAuthorization,
} from "../infrastructure/current-publication-proof.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
function configuration(modern = true) {
  const plain = {
    configurationReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "17:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  return createStoreConfigurationVersion({
    ...plain,
    ...(modern
      ? {
          setupBasis: {
            profile: "StoreSetupConfigurationBasisV2",
            tenantReference: id(16),
            setupDraftReference: id(15),
            sourceRevision: 1,
            sourceSnapshotDigest: `sha256:${"a".repeat(64)}`,
            feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
              chargeType,
              state: "Disabled",
            })),
          },
        }
      : {}),
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonical(Object.getOwnPropertyDescriptor(value, key)?.value),
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const references = () => ({
  canonicalize: canonical,
  hashIntent: (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

function packet(value: ReturnType<typeof configuration>) {
  const scope = createPublishingScope({
      kind: "Store",
      brandReference: parsePublishingReference(id(2)),
      storeReference: parsePublishingReference(id(3)),
    }),
    digest = createStoreConfigurationPublicationHash(references())(value);
  const release = createPublishingReleaseRecord({
    releaseId: parsePublishingReference(id(13)),
    familyReference: parsePublishingReference(id(20)),
    configurationType: parsePublishingCode("STORE_CONFIGURATION"),
    purposeCode: parsePublishingCode("STORE_CONFIGURATION"),
    snapshotReference: parsePublishingReference(id(1)),
    snapshotDigest: parsePublishingDigest(digest),
    scope,
    sequence: parseReleaseSequence(1),
    sourceLifecycleId: parsePublishingReference(id(21)),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: parsePublishingInstant(at),
  });
  const validationEvidence = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(22)),
    snapshotReference: parsePublishingReference(id(1)),
    snapshotDigest: parsePublishingDigest(digest),
    scope,
    result: "Pass",
    checkedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant("2026-10-06T10:00:00.000Z"),
    checkCodes: [parsePublishingCode("STORE_CONTENT")],
  });
  const approvalEvidence = createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(id(12)),
    reviewLifecycleId: parsePublishingReference(id(21)),
    reviewVersion: parsePublishingVersion(2),
    snapshotReference: parsePublishingReference(id(1)),
    snapshotDigest: parsePublishingDigest(digest),
    scope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(id(11)),
    approvedAt: parsePublishingInstant(at),
    validUntil: parsePublishingInstant("2026-10-06T10:00:00.000Z"),
  });
  const lifecycle = createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(id(21)),
    familyReference: parsePublishingReference(id(20)),
    configurationType: parsePublishingCode("STORE_CONFIGURATION"),
    purposeCode: parsePublishingCode("STORE_CONFIGURATION"),
    snapshotReference: parsePublishingReference(id(1)),
    snapshotDigest: parsePublishingDigest(digest),
    scope,
    version: parsePublishingVersion(4),
    state: "Published",
    validationEvidenceReference: parsePublishingReference(id(22)),
    approvalEvidenceReference: parsePublishingReference(id(12)),
    createdAt: parsePublishingInstant(at),
    changedAt: parsePublishingInstant(at),
  });
  return {
    release,
    lifecycle,
    validationEvidence,
    approvalEvidence,
    auditReference: parsePublishingReference(id(23)),
    observedAt: parsePublishingInstant(at),
  };
}
function authority(allowed = true, reviewInventory = true) {
  return createPostgresStorePublicationAuthorization({
    tenantReference: id(16),
    brandReference: id(2),
    storeReference: id(3),
    publishingFamilyReference: id(20),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: ["STORE_READY"],
    ...(reviewInventory ? { requiredValidationCheckCodes: ["STORE_CONTENT"] } : {}),
    hashContent: createStoreConfigurationPublicationHash(references()),
    authorize: async () => allowed,
  });
}
describe("Store V2 publication metadata guard", () => {
  beforeEach(() => {
    sources.release.mockReset();
    sources.independent.mockReset();
    sources.liveGate.mockReset();
    sources.liveGate.mockResolvedValue(undefined);
  });
  it("preserves the legacy current release and actual Live Gate path", async () => {
    const value = configuration(false);
    sources.release.mockResolvedValue(packet(value));
    await expect(authority()({ query: vi.fn() }, value, at)).resolves.toMatchObject({
      configuration: value,
    });
    expect(sources.liveGate).toHaveBeenCalledOnce();
  });
  it("does not acquire public sources when current permission is denied", async () => {
    await expect(authority(false)({ query: vi.fn() }, configuration(), at)).rejects.toThrow(
      "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
    );
    expect(sources.release).not.toHaveBeenCalled();
  });
  it("rejects V2 release time drift even when the semantic digest is unchanged", async () => {
    const value = configuration();
    sources.release.mockResolvedValue(packet(value));
    await expect(
      authority()(
        { query: vi.fn() },
        createStoreConfigurationVersion({ ...value, updatedAt: "2026-10-05T10:00:01.000Z" }),
        "2026-10-05T10:00:02.000Z",
      ),
    ).rejects.toThrow("STORE_CURRENT_PUBLICATION_UNAVAILABLE");
    expect(sources.liveGate).not.toHaveBeenCalled();
  });
  it("rejects actual Tenant drift and author-as-approver metadata", async () => {
    const value = configuration(),
      current = packet(value);
    sources.release.mockResolvedValue(current);
    await expect(
      authority()(
        { query: vi.fn() },
        createStoreConfigurationVersion({
          ...value,
          setupBasis: { ...value.setupBasis, tenantReference: id(99) },
        }),
        at,
      ),
    ).rejects.toThrow("STORE_CURRENT_PUBLICATION_UNAVAILABLE");
    sources.release.mockResolvedValue({
      ...current,
      approvalEvidence: {
        ...current.approvalEvidence,
        approvedActorReference: value.authoredByReference,
      },
    });
    await expect(authority()({ query: vi.fn() }, value, at)).rejects.toThrow(
      "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
    );
  });
  it("rejects missing recorded release-linked independent history", async () => {
    const value = configuration();
    sources.release.mockResolvedValue(packet(value));
    sources.independent.mockRejectedValue(new Error("controlled missing original history"));
    await expect(authority()({ query: vi.fn() }, value, at)).rejects.toThrow(
      "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
    );
    expect(sources.release).toHaveBeenCalledOnce();
    expect(sources.liveGate).not.toHaveBeenCalled();
  });
  it("continues refusing legacy publication when its current Live Gate fails", async () => {
    const value = configuration(false);
    sources.release.mockResolvedValue(packet(value));
    sources.liveGate.mockRejectedValue(new Error("controlled unavailable"));
    await expect(authority()({ query: vi.fn() }, value, at)).rejects.toThrow(
      "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
    );
  });
});

function independent(current: ReturnType<typeof packet>) {
  return {
    profile: "RecordedReleasedIndependentPublishingApprovalV1",
    tenantReference: parsePublishingReference(id(16)),
    scope: current.release.scope,
    familyReference: current.release.familyReference,
    lifecycleReference: current.release.sourceLifecycleId,
    configurationType: current.release.configurationType,
    purposeCode: current.release.purposeCode,
    snapshotReference: current.release.snapshotReference,
    snapshotDigest: current.release.snapshotDigest,
    currentRelease: current,
    approvedLifecycleVersion: parsePublishingVersion(3),
    reviewVersion: parsePublishingVersion(2),
    draftOperationReference: parsePublishingReference(id(30)),
    reviewOperationReference: parsePublishingReference(id(31)),
    approvalOperationReference: parsePublishingReference(id(32)),
    authoredByActorReference: parsePublishingReference(id(10)),
    requestedByActorReference: parsePublishingReference(id(33)),
    approvedByActorReference: current.approvalEvidence.approvedActorReference,
    validationEvidenceReference: current.validationEvidence.evidenceReference,
    approvalEvidenceReference: current.approvalEvidence.evidenceReference,
    validationCheckCodes: current.validationEvidence.checkCodes,
    observedAt: current.observedAt,
    sourceDigest: parsePublishingDigest(`sha256:${"c".repeat(64)}`),
    digest: parsePublishingDigest(`sha256:${"d".repeat(64)}`),
    recordedIndependence: "Verified",
    currentValidation: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  };
}
it("binds V2 to the real independent-source boundary and retains Live Gate", async () => {
  sources.release.mockReset();
  sources.independent.mockReset();
  sources.liveGate.mockReset();
  sources.liveGate.mockResolvedValue(undefined);
  const value = configuration(),
    current = packet(value);
  sources.release.mockResolvedValue(current);
  sources.independent.mockResolvedValue(independent(current));
  await expect(authority()({ query: vi.fn() }, value, at)).resolves.toMatchObject({
    configuration: value,
  });
  expect(sources.independent).toHaveBeenCalledWith(
    expect.objectContaining({
      requiredCheckCodes: ["STORE_CONTENT"],
      snapshotDigest: current.release.snapshotDigest,
      lifecycleReference: current.release.sourceLifecycleId,
    }),
  );
  expect(sources.liveGate).toHaveBeenCalledOnce();
});
it("refuses current release drift and a submitter who also approved", async () => {
  sources.release.mockReset();
  sources.independent.mockReset();
  sources.liveGate.mockReset();
  const value = configuration(),
    current = packet(value),
    record = independent(current);
  sources.release.mockResolvedValue(current);
  sources.independent.mockResolvedValue({
    ...record,
    requestedByActorReference: record.approvedByActorReference,
  });
  await expect(authority()({ query: vi.fn() }, value, at)).rejects.toThrow(
    "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
  );
  sources.independent.mockResolvedValue({
    ...record,
    currentRelease: { ...current, auditReference: parsePublishingReference(id(99)) },
  });
  await expect(authority()({ query: vi.fn() }, value, at)).rejects.toThrow(
    "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
  );
  expect(sources.liveGate).not.toHaveBeenCalled();
});

it("does not renew or require today's historical approval period for the released content", async () => {
  sources.release.mockReset();
  sources.independent.mockReset();
  sources.liveGate.mockReset();
  sources.liveGate.mockResolvedValue(undefined);
  const value = configuration(),
    later = parsePublishingInstant("2026-10-07T10:00:00.000Z"),
    current = { ...packet(value), observedAt: later };
  sources.release.mockResolvedValue(current);
  sources.independent.mockResolvedValue(independent(current));
  await expect(authority()({ query: vi.fn() }, value, later)).resolves.toMatchObject({
    observedAt: later,
  });
  expect(sources.liveGate).toHaveBeenCalledOnce();
});

it("requires explicit V2 review checks without substituting Live Gate checks or changing V1", async () => {
  sources.release.mockReset();
  sources.independent.mockReset();
  sources.liveGate.mockReset();
  sources.liveGate.mockResolvedValue(undefined);
  const value = configuration();
  sources.release.mockResolvedValue(packet(value));
  await expect(authority(true, false)({ query: vi.fn() }, value, at)).rejects.toThrow(
    "STORE_CURRENT_PUBLICATION_UNAVAILABLE",
  );
  expect(sources.independent).not.toHaveBeenCalled();
  const legacy = configuration(false);
  sources.release.mockResolvedValue(packet(legacy));
  await expect(authority(true, false)({ query: vi.fn() }, legacy, at)).resolves.toMatchObject({
    configuration: legacy,
  });
});

function approvedFixture() {
  const value = createStoreConfigurationVersion({
      ...configuration(),
      lifecycle: "Approved",
      publicationReference: null,
      liveGateEvidenceReference: null,
    }),
    base = packet(value),
    approvalEvidence = createPublishingApprovalEvidence({
      ...base.approvalEvidence,
      reviewLifecycleId: parsePublishingReference(value.configurationReference),
    }),
    lifecycle = createPublishingLifecycleRecord({
      ...base.lifecycle,
      lifecycleId: parsePublishingReference(value.configurationReference),
      version: parsePublishingVersion(3),
      state: "Approved",
    }),
    current = {
      lifecycle,
      validationEvidence: base.validationEvidence,
      approvalEvidence,
      previousRelease: null,
    };
  const recorded = {
    profile: "CurrentIndependentPublishingApprovalV1",
    tenantReference: parsePublishingReference(id(16)),
    scope: lifecycle.scope,
    familyReference: lifecycle.familyReference,
    lifecycleReference: lifecycle.lifecycleId,
    configurationType: lifecycle.configurationType,
    purposeCode: lifecycle.purposeCode,
    snapshotReference: lifecycle.snapshotReference,
    snapshotDigest: lifecycle.snapshotDigest,
    approvedLifecycleVersion: lifecycle.version,
    reviewVersion: approvalEvidence.reviewVersion,
    draftOperationReference: parsePublishingReference(id(30)),
    reviewOperationReference: parsePublishingReference(id(31)),
    approvalOperationReference: parsePublishingReference(id(32)),
    requestedByActorReference: parsePublishingReference(id(33)),
    approvedByActorReference: approvalEvidence.approvedActorReference,
    validationEvidenceReference: base.validationEvidence.evidenceReference,
    approvalEvidenceReference: approvalEvidence.evidenceReference,
    validationCheckCodes: base.validationEvidence.checkCodes,
    observedAt: base.observedAt,
    validUntil: approvalEvidence.validUntil,
    sourceDigest: parsePublishingDigest(`sha256:${"c".repeat(64)}`),
    digest: parsePublishingDigest(`sha256:${"d".repeat(64)}`),
    recordedIndependence: "Verified",
    currentValidation: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  };
  sources.candidate.mockResolvedValue(current);
  sources.currentIndependent.mockResolvedValue(recorded);
  return { value, current, recorded };
}
function approvedAuthority(
  authorize: () => Promise<boolean> = async () => true,
  reviewInventory = true,
) {
  return createPostgresStoreV2ApprovalAuthorization({
    tenantReference: id(16),
    brandReference: id(2),
    storeReference: id(3),
    publishingFamilyReference: id(20),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    hashContent: createStoreConfigurationPublicationHash(references()),
    authorize,
    ...(reviewInventory ? { requiredValidationCheckCodes: ["STORE_CONTENT"] } : {}),
  });
}
describe("Store V2 current independent approval authority", () => {
  beforeEach(() => {
    sources.candidate.mockReset();
    sources.currentIndependent.mockReset();
  });
  it("directly binds actual Approved evidence and independent history without a future Published snapshot", async () => {
    const h = approvedFixture();
    await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).resolves.toMatchObject({
      configuration: h.value,
      approvalEvidence: h.current.approvalEvidence,
    });
    expect(sources.candidate).toHaveBeenCalledOnce();
    expect(sources.currentIndependent).toHaveBeenCalledWith({
      familyReference: id(20),
      lifecycleReference: id(1),
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      observedAt: at,
      snapshotReference: id(1),
      snapshotDigest: h.current.lifecycle.snapshotDigest,
      requiredCheckCodes: ["STORE_CONTENT"],
    });
    expect(h.value.publicationReference).toBeNull();
    expect(h.value.liveGateEvidenceReference).toBeNull();
  });
  it("refuses every counterfeit independent header and evidence pin", async () => {
    const h = approvedFixture(),
      reject = () =>
        expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
          "STORE_CURRENT_APPROVAL_UNAVAILABLE",
        );
    for (const patch of [
      { tenantReference: id(90) },
      {
        scope: createPublishingScope({
          kind: "Store",
          brandReference: parsePublishingReference(id(90)),
          storeReference: parsePublishingReference(id(3)),
        }),
      },
      { familyReference: id(90) },
      { lifecycleReference: id(90) },
      { configurationType: "OTHER_CONFIGURATION" },
      { purposeCode: "OTHER_PURPOSE" },
      { snapshotReference: id(90) },
      { snapshotDigest: `sha256:${"e".repeat(64)}` },
      { observedAt: "2026-10-05T10:00:01.000Z" },
      { approvedLifecycleVersion: 4 },
      { reviewVersion: 1 },
      { approvalEvidenceReference: id(90) },
      { validationEvidenceReference: id(90) },
      { approvedByActorReference: id(90) },
      { recordedIndependence: "NotEvaluated" },
      { validationCheckCodes: ["UNRELATED_CHECK"] },
    ]) {
      sources.currentIndependent.mockResolvedValue({ ...h.recorded, ...patch });
      await reject();
    }
  });
  it("refuses changed actual Core head scope, hash, lifecycle and time", async () => {
    const h = approvedFixture();
    for (const patch of [
      { state: "InReview" as const, approvalEvidenceReference: null },
      { familyReference: parsePublishingReference(id(90)) },
      {
        scope: createPublishingScope({
          kind: "Store",
          brandReference: parsePublishingReference(id(2)),
          storeReference: parsePublishingReference(id(90)),
        }),
      },
      { snapshotDigest: parsePublishingDigest(`sha256:${"e".repeat(64)}`) },
      { changedAt: parsePublishingInstant("2026-10-05T10:00:01.000Z") },
    ]) {
      sources.candidate.mockResolvedValue({
        ...h.current,
        lifecycle: createPublishingLifecycleRecord({ ...h.current.lifecycle, ...patch }),
      });
      await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
        "STORE_CURRENT_APPROVAL_UNAVAILABLE",
      );
    }
  });
  it("refuses actual approval Actor/evidence drift and original Submitter self-approval", async () => {
    const h = approvedFixture();
    // A structurally self-approved configuration is refused by the owning parser
    // before any current authority source is requested.
    expect(() =>
      createStoreConfigurationVersion({
        ...h.value,
        authoredByReference: h.value.approvedByReference,
      }),
    ).toThrow();
    expect(sources.candidate).not.toHaveBeenCalled();
    sources.candidate.mockResolvedValue({
      ...h.current,
      approvalEvidence: createPublishingApprovalEvidence({
        ...h.current.approvalEvidence,
        approvedActorReference: parsePublishingReference(id(10)),
      }),
    });
    await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
    sources.candidate.mockResolvedValue(h.current);
    sources.currentIndependent.mockResolvedValue({
      ...h.recorded,
      requestedByActorReference: h.recorded.approvedByActorReference,
    });
    await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
  });
  it("refuses evidence times before configuration creation, mismatch, and unclamped approval deadline", async () => {
    const h = approvedFixture();
    for (const approvalEvidence of [
      createPublishingApprovalEvidence({
        ...h.current.approvalEvidence,
        approvedAt: parsePublishingInstant("2026-10-05T09:59:59.000Z"),
      }),
      createPublishingApprovalEvidence({
        ...h.current.approvalEvidence,
        validUntil: parsePublishingInstant("2026-10-07T10:00:00.000Z"),
      }),
      createPublishingApprovalEvidence({
        ...h.current.approvalEvidence,
        evidenceReference: parsePublishingReference(id(90)),
      }),
    ]) {
      sources.candidate.mockResolvedValue({ ...h.current, approvalEvidence });
      await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
        "STORE_CURRENT_APPROVAL_UNAVAILABLE",
      );
    }
    sources.candidate.mockResolvedValue({
      ...h.current,
      validationEvidence: createPublishingValidationEvidence({
        ...h.current.validationEvidence,
        checkedAt: parsePublishingInstant("2026-10-05T09:59:59.000Z"),
      }),
    });
    await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
  });
  it("refuses absent inventory or basis and incomplete independent history", async () => {
    const h = approvedFixture();
    await expect(
      approvedAuthority(async () => true, false)({ query: vi.fn() }, h.value, at),
    ).rejects.toThrow("STORE_CURRENT_APPROVAL_UNAVAILABLE");
    expect(sources.candidate).not.toHaveBeenCalled();
    const legacy = createStoreConfigurationVersion({
      ...configuration(false),
      lifecycle: "Approved",
      publicationReference: null,
      liveGateEvidenceReference: null,
    });
    await expect(approvedAuthority()({ query: vi.fn() }, legacy, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
    sources.currentIndependent.mockRejectedValue(
      new Error("controlled unavailable original chain"),
    );
    await expect(approvedAuthority()({ query: vi.fn() }, h.value, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
  });
  it("rechecks actual current authority after both sources and refuses late withdrawal", async () => {
    const h = approvedFixture(),
      authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(approvedAuthority(authorize)({ query: vi.fn() }, h.value, at)).rejects.toThrow(
      "STORE_CURRENT_APPROVAL_UNAVAILABLE",
    );
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(sources.candidate).toHaveBeenCalledOnce();
    expect(sources.currentIndependent).toHaveBeenCalledOnce();
  });
});

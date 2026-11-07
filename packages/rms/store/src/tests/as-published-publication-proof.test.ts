import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const sources = vi.hoisted(() => ({
  current: vi.fn(),
  published: vi.fn(),
  currentIndependent: vi.fn(),
  publishedIndependent: vi.fn(),
  liveGate: vi.fn(),
  content: vi.fn(),
}));
// Controlled public-owner boundaries test Store's binding checks only; these packets
// are not native Publishing/Live Gate evidence (see the database acceptance suite).
vi.mock("@bop/publishing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: () => ({
    resolveCurrentRelease: sources.current,
    resolvePublishedRelease: sources.published,
    resolveCurrentReleaseRecordedApproval: sources.currentIndependent,
    resolvePublishedReleaseRecordedApproval: sources.publishedIndependent,
  }),
  createPostgresCurrentLiveGateSource: () => sources.liveGate,
}));
vi.mock("../infrastructure/persistence/publication-content-source.js", () => ({
  createPostgresStorePublicationContentSource: () => sources.content,
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
  type PublishingScope,
} from "@bop/publishing";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import { createStoreConfigurationPublicationHash } from "../contracts/store-configuration-publication-content.js";
import {
  createPostgresAsPublishedStorePublicationProof,
  createPostgresCurrentStorePublicationProof,
} from "../infrastructure/current-publication-proof.js";

const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const v1At = "2026-09-20T10:00:00.000Z";
const v2At = "2026-10-11T10:00:00.000Z";
const observedAt = "2026-10-12T10:00:00.000Z";
const scope = createPublishingScope({
  kind: "Store",
  brandReference: parsePublishingReference(id(2)),
  storeReference: parsePublishingReference(id(3)),
});
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
const hashContent = createStoreConfigurationPublicationHash(references());
/** v1: configuration id(1), release id(13); v2: configuration id(41), release id(53). */
function configuration(version: 1 | 2, modern = false) {
  const offset = version === 1 ? 0 : 40;
  const at = version === 1 ? v1At : v2At;
  return createStoreConfigurationVersion({
    configurationReference: id(1 + offset),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: version,
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
      intervals: [
        {
          startLocalTime: version === 1 ? "09:00:00" : "10:00:00",
          endLocalTime: "17:00:00",
          endsNextDay: false,
          serviceModes: ["DineIn", "Pickup"],
          orderCutoffSeconds: 0,
          leadTimeSeconds: 0,
        },
      ],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: version === 1 ? null : id(1),
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12 + offset),
    publicationReference: id(13 + offset),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
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
type Configuration = ReturnType<typeof configuration>;
function packet(
  value: Configuration,
  changes: { digest?: string; scope?: PublishingScope; createdAt?: string } = {},
) {
  const version = value.configurationVersion;
  const at = changes.createdAt ?? value.updatedAt;
  const digest = parsePublishingDigest(changes.digest ?? hashContent(value));
  const releaseScope = changes.scope ?? scope;
  const lifecycleId = parsePublishingReference(id(21 + version * 100));
  const snapshotReference = parsePublishingReference(value.configurationReference);
  return {
    release: createPublishingReleaseRecord({
      releaseId: parsePublishingReference(String(value.publicationReference)),
      familyReference: parsePublishingReference(id(20)),
      configurationType: parsePublishingCode("STORE_CONFIGURATION"),
      purposeCode: parsePublishingCode("STORE_CONFIGURATION"),
      snapshotReference,
      snapshotDigest: digest,
      scope: releaseScope,
      sequence: parseReleaseSequence(version),
      sourceLifecycleId: lifecycleId,
      kind: "Publish",
      previousReleaseId: version === 1 ? null : parsePublishingReference(id(13)),
      createdAt: parsePublishingInstant(at),
    }),
    lifecycle: createPublishingLifecycleRecord({
      lifecycleId,
      familyReference: parsePublishingReference(id(20)),
      configurationType: parsePublishingCode("STORE_CONFIGURATION"),
      purposeCode: parsePublishingCode("STORE_CONFIGURATION"),
      snapshotReference,
      snapshotDigest: digest,
      scope: releaseScope,
      version: parsePublishingVersion(4),
      state: "Published",
      validationEvidenceReference: parsePublishingReference(id(22 + version * 100)),
      approvalEvidenceReference: parsePublishingReference(String(value.approvalEvidenceReference)),
      createdAt: parsePublishingInstant(value.createdAt),
      changedAt: parsePublishingInstant(at),
    }),
    validationEvidence: createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(22 + version * 100)),
      snapshotReference,
      snapshotDigest: digest,
      scope: releaseScope,
      result: "Pass",
      checkedAt: parsePublishingInstant(value.createdAt),
      validUntil: parsePublishingInstant(new Date(Date.parse(at) + 86_400_000).toISOString()),
      checkCodes: [parsePublishingCode("STORE_CONTENT")],
    }),
    approvalEvidence: createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(String(value.approvalEvidenceReference)),
      reviewLifecycleId: lifecycleId,
      reviewVersion: parsePublishingVersion(2),
      snapshotReference,
      snapshotDigest: digest,
      scope: releaseScope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(id(11)),
      approvedAt: parsePublishingInstant(value.createdAt),
      validUntil: parsePublishingInstant(new Date(Date.parse(at) + 86_400_000).toISOString()),
    }),
    auditReference: parsePublishingReference(id(23 + version * 100)),
    observedAt: parsePublishingInstant(observedAt),
  };
}
function independent(current: ReturnType<typeof packet>) {
  return {
    profile: "RecordedReleasedPublishingApprovalV1",
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
function content(value: Configuration) {
  sources.content.mockResolvedValue({
    configuration: value,
    contentDigest: hashContent(value),
    familyReference: id(20),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    businessDayStartSource: "PlatformDefault",
    recordedAt: value.createdAt,
  });
}
const options = (value: Configuration) => ({
  tenantReference: id(16),
  brandReference: id(2),
  storeReference: id(3),
  configurationReference: value.configurationReference,
  configurationType: "STORE_CONFIGURATION",
  purposeCode: "STORE_CONFIGURATION",
  requiredLiveGateRequirementCodes: ["STORE_READY"],
  requiredValidationCheckCodes: ["STORE_CONTENT"],
  setupSnapshotReferences: references(),
  hashContent,
  authorize: async () => true,
});
const tx = () => ({ query: vi.fn() });

describe("historical (as-published) Store publication proof", () => {
  const v1 = configuration(1),
    v2 = configuration(2);
  beforeEach(() => {
    for (const source of Object.values(sources)) source.mockReset();
    sources.liveGate.mockResolvedValue(undefined);
    // v2 superseded v1: the family's newest release published v2.
    sources.current.mockResolvedValue(packet(v2));
  });

  it("current proof still refuses a superseded configuration", async () => {
    content(v1);
    await expect(
      createPostgresCurrentStorePublicationProof(options(v1))(tx(), observedAt),
    ).rejects.toThrow("STORE_CURRENT_PUBLICATION_UNAVAILABLE");
    expect(sources.published).not.toHaveBeenCalled();
  });
  it("current proof keeps accepting the current configuration", async () => {
    content(v2);
    await expect(
      createPostgresCurrentStorePublicationProof(options(v2))(tx(), observedAt),
    ).resolves.toMatchObject({ configuration: v2, contentDigest: hashContent(v2) });
    expect(sources.published).not.toHaveBeenCalled();
  });
  it("accepts a superseded configuration against the release that published it", async () => {
    content(v1);
    sources.published.mockResolvedValue(packet(v1));
    const proof = await createPostgresAsPublishedStorePublicationProof(options(v1))(
      tx(),
      observedAt,
    );
    expect(proof.configuration).toBe(v1);
    expect(proof.contentDigest).toBe(hashContent(v1));
    expect(proof.release.releaseId).toBe(id(13));
    expect(proof.businessDayStartSource).toBe("PlatformDefault");
    expect(sources.current).not.toHaveBeenCalled();
    expect(sources.published).toHaveBeenCalledWith({
      familyReference: id(20),
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      snapshotReference: id(1),
      publicationReference: id(13),
      observedAt,
    });
    expect(sources.liveGate).toHaveBeenCalledOnce();
  });
  it.each<[string, () => unknown]>([
    ["a tampered release digest", () => packet(v1, { digest: `sha256:${"e".repeat(64)}` })],
    [
      "a foreign Store scope",
      () =>
        packet(v1, {
          scope: createPublishingScope({
            kind: "Store",
            brandReference: parsePublishingReference(id(2)),
            storeReference: parsePublishingReference(id(99)),
          }),
        }),
    ],
    [
      "a release created after observedAt",
      () => packet(v1, { createdAt: "2026-10-13T00:00:00.000Z" }),
    ],
    ["the release of a different configuration", () => packet(v2)],
  ])("refuses %s", async (_label, release) => {
    content(v1);
    sources.published.mockResolvedValue(release());
    await expect(
      createPostgresAsPublishedStorePublicationProof(options(v1))(tx(), observedAt),
    ).rejects.toThrow("STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE");
    expect(sources.liveGate).not.toHaveBeenCalled();
  });
  it("refuses a configuration never released by Publishing", async () => {
    content(v1);
    sources.published.mockRejectedValue(new Error("controlled owner refusal"));
    await expect(
      createPostgresAsPublishedStorePublicationProof(options(v1))(tx(), observedAt),
    ).rejects.toThrow("STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE");
  });
  it("still requires the Live Gate and authorization", async () => {
    content(v1);
    sources.published.mockResolvedValue(packet(v1));
    sources.liveGate.mockRejectedValue(new Error("controlled unavailable"));
    await expect(
      createPostgresAsPublishedStorePublicationProof(options(v1))(tx(), observedAt),
    ).rejects.toThrow("STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE");
    sources.liveGate.mockResolvedValue(undefined);
    await expect(
      createPostgresAsPublishedStorePublicationProof({
        ...options(v1),
        authorize: async () => false,
      })(tx(), observedAt),
    ).rejects.toThrow("STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE");
  });
  it("binds V2 configurations to the independent review behind the as-published release", async () => {
    const modern = configuration(1, true),
      released = packet(modern);
    content(modern);
    sources.published.mockResolvedValue(released);
    sources.publishedIndependent.mockResolvedValue({
      ...independent(released),
      observedAt: parsePublishingInstant(observedAt),
    });
    await expect(
      createPostgresAsPublishedStorePublicationProof(options(modern))(tx(), observedAt),
    ).resolves.toMatchObject({ configuration: modern });
    expect(sources.currentIndependent).not.toHaveBeenCalled();
    expect(sources.publishedIndependent).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationReference: id(13),
        snapshotReference: id(1),
        requiredCheckCodes: ["STORE_CONTENT"],
      }),
    );
    sources.publishedIndependent.mockResolvedValue({
      ...independent(released),
      observedAt: parsePublishingInstant(observedAt),
      currentRelease: packet(v2),
    });
    await expect(
      createPostgresAsPublishedStorePublicationProof(options(modern))(tx(), observedAt),
    ).rejects.toThrow("STORE_AS_PUBLISHED_PUBLICATION_UNAVAILABLE");
  });
});

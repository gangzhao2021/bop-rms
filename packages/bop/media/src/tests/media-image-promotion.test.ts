import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
  parseMediaReferenceId,
} from "../contracts/media.js";
import {
  createMediaImagePromotionPlan,
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionPlan,
  parseMediaImagePromotionResult,
  type MediaImagePromotionPlan,
} from "../infrastructure/processing/media-image-promotion.js";

const id = (n: number) => "019a2421-0019-7000-8000-" + n.toString(16).padStart(12, "0");
const checksum = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const invalid = expect.objectContaining({ code: "MEDIA_INPUT_INVALID" });
function fixture() {
  // Synthetic immutable metadata only: these tests do not prove S3 writes,
  // scanner authority, decoding or current System admission.
  const scope = createMediaScope({
    kind: "Store",
    brandReference: id(2),
    storeReference: id(3),
  } as Parameters<typeof createMediaScope>[0]);
  const base = {
    operationReference: id(4),
    tenantReference: id(1),
    scope,
    assetReference: id(5),
    sourceAssetVersionReference: id(6),
    targetAssetVersionReference: id(7),
    expectedAssetVersion: 1,
    sourceBindingDigest: checksum(1),
    destination: {
      accountId: "111122223333",
      bucket: "synthetic-clean-images",
      cleanPrefix: "clean/images/",
      kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
  } satisfies Omit<MediaImagePromotionPlan, "profile" | "original" | "renditions">;
  const plan = createMediaImagePromotionPlan(base);
  const session = createUploadSession({
    uploadSessionId: id(8),
    grantReference: id(9),
    actorReference: id(10),
    purpose: "PRODUCT_IMAGE",
    scope,
    mediaKind: "Image",
    declaredContentType: "image/png",
    declaredByteSize: 1234,
    ownerType: "PRODUCT",
    ownerReference: id(11),
    classification: "Public",
    state: "Finalized",
    version: 2,
    createdAt: "2026-10-03T12:00:00.000Z",
    expiresAt: "2026-10-03T12:15:00.000Z",
  } as Parameters<typeof createUploadSession>[0]);
  const asset = createMediaAsset({
    assetId: base.assetReference,
    purpose: session.purpose,
    scope,
    mediaKind: "Image",
    ownerType: session.ownerType,
    ownerReference: session.ownerReference,
    classification: session.classification,
    currentVersionReference: null,
    version: 1,
  } as Parameters<typeof createMediaAsset>[0]);
  const assetVersion = createMediaAssetVersion({
    assetVersionId: base.sourceAssetVersionReference,
    assetId: asset.assetId,
    version: 1,
    objectEvidenceReference: id(12),
    providerObjectVersion: id(13),
    byteSize: session.declaredByteSize,
    checksum: checksum(2),
    contentType: session.declaredContentType,
    checkState: "Quarantined",
    readinessState: "Pending",
    createdAt: "2026-10-03T12:00:01.000Z",
  } as Parameters<typeof createMediaAssetVersion>[0]);
  const object = {
    bucket: "synthetic-quarantine-images",
    key: "quarantine/" + "a".repeat(64),
    versionId: "opaque/actual+S3.version",
    etag: "opaque-etag-2",
    objectEvidenceReference: assetVersion.objectEvidenceReference,
    providerObjectVersion: assetVersion.providerObjectVersion,
  };
  const scanEvent = {
    version: "0",
    id: "guardduty-event-1",
    source: "aws.guardduty",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    account: base.destination.accountId,
    region: "ca-central-1",
    time: "2026-10-03T12:01:00Z",
    resources: ["arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123"],
    detail: {
      schemaVersion: "1.0",
      scanStatus: "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: {
        bucketName: object.bucket,
        objectKey: object.key,
        eTag: object.etag,
        versionId: object.versionId,
        s3Throttled: true,
      },
      scanResultDetails: {
        scanResultStatus: "NO_THREATS_FOUND",
        threats: null,
        statusReasons: null,
      },
    },
  };
  const source = {
    tenantReference: base.tenantReference,
    session,
    asset,
    assetVersion,
    object,
    scanEvent,
  };
  const result = {
    profile: "PUBLIC_IMAGE_RESULT_V1",
    operationReference: plan.operationReference,
    planDigest: mediaImagePromotionPlanDigest(plan),
    sourceEvidence: {
      ...object,
      tenantReference: base.tenantReference,
      scope,
      uploadSessionReference: session.uploadSessionId,
      assetReference: asset.assetId,
      assetVersionReference: assetVersion.assetVersionId,
      byteSize: assetVersion.byteSize,
      checksum: assetVersion.checksum,
      kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    scanEvidence: {
      eventId: scanEvent.id,
      eventTime: scanEvent.time,
      accountId: scanEvent.account,
      region: scanEvent.region,
      protectionPlanArn: scanEvent.resources[0],
      result: "NO_THREATS_FOUND",
      s3Throttled: true,
    },
    original: {
      ...plan.original,
      bucket: plan.destination.bucket,
      versionId: "copy/version.1",
      etag: "opaque-copy-etag",
      contentType: assetVersion.contentType,
      byteSize: assetVersion.byteSize,
      checksum: assetVersion.checksum,
    },
    renditions: plan.renditions.map((p, index) => ({
      ...p,
      bucket: plan.destination.bucket,
      versionId: "rendition/version." + index,
      etag: "opaque-rendition-" + index,
      height: Math.round(p.width * 0.731),
      byteSize: 2000 + index,
      checksum: checksum(index + 3),
    })),
    completedAt: "2026-10-03T12:02:00.000Z",
  };
  return { base, plan, source, result };
}

describe("private immutable image promotion plan", () => {
  it("allocates seven random opaque keys and fourteen unique logical references in canonical encoding order", () => {
    const { base, plan } = fixture(),
      other = createMediaImagePromotionPlan(base);
    const objects = [plan.original, ...plan.renditions];
    expect(objects).toHaveLength(7);
    expect(new Set(objects.map((o) => o.key)).size).toBe(7);
    expect(
      new Set(objects.flatMap((o) => [o.objectEvidenceReference, o.providerObjectVersion])).size,
    ).toBe(14);
    for (const object of objects) {
      expect(object.key).toMatch(/^clean\/images\/[a-f0-9]{64}$/u);
      expect(object.objectEvidenceReference).toMatch(/^[a-f0-9-]{14}7[a-f0-9-]{21}$/u);
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(plan.renditions.map((r) => [r.width, r.contentType])).toEqual([
      [320, "image/jpeg"],
      [320, "image/webp"],
      [640, "image/jpeg"],
      [640, "image/webp"],
      [1280, "image/jpeg"],
      [1280, "image/webp"],
    ]);
    expect(other.original.key).not.toBe(plan.original.key);
    expect(mediaImagePromotionPlanDigest(plan)).toBe(
      "sha256:" + sha256Hex(canonicalizeRfc8785(plan)),
    );
    expect(parseMediaImagePromotionPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(Object.isFrozen(plan.renditions)).toBe(true);
  });

  it("captures input without mutation, accessors or caller-supplied target objects", () => {
    const f = fixture(),
      getter = vi.fn(() => id(4));
    const mutable = structuredClone(f.base),
      plan = createMediaImagePromotionPlan(mutable);
    mutable.destination.cleanPrefix = "changed/";
    expect(plan.destination.cleanPrefix).toBe("clean/images/");
    const malformed = Object.defineProperty({ ...f.base }, "operationReference", {
      enumerable: true,
      get: getter,
    });
    expect(() => createMediaImagePromotionPlan(malformed)).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
    const attemptedOverride = { ...f.base, original: f.plan.original };
    expect(() => createMediaImagePromotionPlan(attemptedOverride)).toThrow(invalid);
  });

  it.each([
    [
      "same source and target",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        targetAssetVersionReference: p.sourceAssetVersionReference,
      }),
    ],
    ["wrong profile", (p: MediaImagePromotionPlan) => ({ ...p, profile: "PUBLIC_IMAGE_V2" })],
    [
      "cross-account KMS",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        destination: { ...p.destination, accountId: "999988887777" },
      }),
    ],
    [
      "foreign region KMS",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        destination: {
          ...p.destination,
          kmsKeyArn: p.destination.kmsKeyArn.replace("ca-central-1", "us-east-1"),
        },
      }),
    ],
    [
      "path traversal",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        destination: { ...p.destination, cleanPrefix: "../clean/" },
      }),
    ],
    [
      "duplicate key",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        original: { ...p.original, key: p.renditions[0]?.key },
      }),
    ],
    [
      "cross-kind logical reference collision",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        original: {
          ...p.original,
          providerObjectVersion: p.renditions[0]?.objectEvidenceReference,
        },
      }),
    ],
    [
      "missing output",
      (p: MediaImagePromotionPlan) => ({ ...p, renditions: p.renditions.slice(1) }),
    ],
    [
      "reordered output",
      (p: MediaImagePromotionPlan) => ({ ...p, renditions: [...p.renditions].reverse() }),
    ],
    [
      "free URL",
      (p: MediaImagePromotionPlan) => ({
        ...p,
        original: { ...p.original, key: "https://example.invalid/a.png" },
      }),
    ],
  ])("refuses %s", (_, change) => {
    expect(() => parseMediaImagePromotionPlan(change(fixture().plan))).toThrow(invalid);
  });
});

describe("private image promotion result linkage", () => {
  it("binds full source evidence and six actual-version outputs, allowing a distinct source KMS key and rounded heights", () => {
    const f = fixture(),
      result = parseMediaImagePromotionResult(f.result, f.plan, f.source);
    expect(result).toEqual(f.result);
    expect(result.scanEvidence.s3Throttled).toBe(true);
    expect(result.sourceEvidence.kmsKeyArn).not.toBe(f.plan.destination.kmsKeyArn);
    expect(result.renditions[4]).toMatchObject({ width: 1280, contentType: "image/jpeg" });
    expect(Object.isFrozen(result.sourceEvidence.scope)).toBe(true);
    expect(Object.isFrozen(result.renditions[0])).toBe(true);
  });

  it("does not confuse immutable upload root with later completion CAS or impose a present-time human lease", () => {
    const f = fixture(),
      plan = parseMediaImagePromotionPlan({ ...f.plan, expectedAssetVersion: 4 });
    expect(
      parseMediaImagePromotionResult(
        {
          ...f.result,
          planDigest: mediaImagePromotionPlanDigest(plan),
          completedAt: "2027-01-01T00:00:00.000Z",
        },
        plan,
        f.source,
      ).completedAt,
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(() => parseMediaImagePromotionResult(f.result, plan, f.source)).toThrow(invalid);
  });

  it("allows a ten MiB private original plus thirty MiB of bounded derivatives", () => {
    const f = fixture(),
      size = 10 * 1024 * 1024;
    const source = {
      ...f.source,
      session: { ...f.source.session, declaredByteSize: size },
      assetVersion: { ...f.source.assetVersion, byteSize: size },
    };
    const result = {
      ...f.result,
      sourceEvidence: { ...f.result.sourceEvidence, byteSize: size },
      original: { ...f.result.original, byteSize: size },
      renditions: f.result.renditions.map((r) => ({ ...r, byteSize: 5 * 1024 * 1024 })),
    };
    expect(parseMediaImagePromotionResult(result, f.plan, source).renditions).toHaveLength(6);
    expect(() =>
      parseMediaImagePromotionResult(
        {
          ...result,
          renditions: result.renditions.map((r, i) => ({
            ...r,
            byteSize: r.byteSize + (i === 0 ? 1 : 0),
          })),
        },
        f.plan,
        source,
      ),
    ).toThrow(invalid);
  });

  it.each([
    "tenantReference",
    "assetReference",
    "assetVersionReference",
    "uploadSessionReference",
    "objectEvidenceReference",
    "providerObjectVersion",
  ] as const)("refuses source evidence transplanted via %s", (field) => {
    const f = fixture();
    expect(() =>
      parseMediaImagePromotionResult(
        { ...f.result, sourceEvidence: { ...f.result.sourceEvidence, [field]: id(900) } },
        f.plan,
        f.source,
      ),
    ).toThrow(invalid);
  });

  it("rejects foreign scope and incorrect source lineage before accepting a claimed clean result", () => {
    const f = fixture();
    expect(() =>
      parseMediaImagePromotionResult(f.result, f.plan, { ...f.source, tenantReference: id(999) }),
    ).toThrow(invalid);
    expect(() =>
      parseMediaImagePromotionResult(f.result, f.plan, {
        ...f.source,
        asset: {
          ...f.source.asset,
          scope: createMediaScope({ ...f.source.asset.scope, kind: "Brand", storeReference: null }),
        },
      }),
    ).toThrow(invalid);
    expect(() =>
      parseMediaImagePromotionResult(f.result, f.plan, {
        ...f.source,
        session: {
          ...f.source.session,
          ownerReference: parseMediaReferenceId(f.source.asset.assetId),
        },
      }),
    ).toThrow(invalid);
    expect(() =>
      parseMediaImagePromotionResult(f.result, f.plan, {
        ...f.source,
        assetVersion: { ...f.source.assetVersion, checkState: "Clean", readinessState: "Ready" },
      }),
    ).toThrow(invalid);
  });

  it.each(["versionId", "etag", "key"] as const)(
    "refuses a scan event for another object %s",
    (field) => {
      const f = fixture(),
        names = { versionId: "versionId", etag: "eTag", key: "objectKey" };
      const source = {
        ...f.source,
        scanEvent: {
          ...f.source.scanEvent,
          detail: {
            ...f.source.scanEvent.detail,
            s3ObjectDetails: {
              ...f.source.scanEvent.detail.s3ObjectDetails,
              [names[field]]: "different-object",
            },
          },
        },
      };
      expect(() => parseMediaImagePromotionResult(f.result, f.plan, source)).toThrow(invalid);
    },
  );

  it("does not promote a supplied clean boolean, foreign scan authority tuple or altered event evidence", () => {
    const f = fixture();
    for (const scanEvent of [
      { clean: true },
      { ...f.source.scanEvent, account: "999988887777" },
      { ...f.source.scanEvent, resources: [] },
      { ...f.source.scanEvent, detail: { ...f.source.scanEvent.detail, scanStatus: "FAILED" } },
      {
        ...f.source.scanEvent,
        detail: {
          ...f.source.scanEvent.detail,
          scanResultDetails: {
            scanResultStatus: "THREATS_FOUND",
            threats: null,
            statusReasons: null,
          },
        },
      },
    ])
      expect(() =>
        parseMediaImagePromotionResult(f.result, f.plan, { ...f.source, scanEvent }),
      ).toThrow(invalid);
    expect(() =>
      parseMediaImagePromotionResult(
        { ...f.result, scanEvidence: { ...f.result.scanEvidence, eventId: "another-event" } },
        f.plan,
        f.source,
      ),
    ).toThrow(invalid);
  });

  it.each([
    ["source bytes changed", { checksum: checksum(999) }],
    ["source content type changed", { contentType: "image/jpeg" }],
    ["source size changed", { byteSize: 12 }],
    ["unversioned output", { versionId: "null" }],
    ["quoted ETag", { etag: '"opaque"' }],
    ["foreign bucket", { bucket: "foreign-clean-images" }],
    ["unknown field", { url: "https://example.invalid/original.png" }],
  ])("rejects %s", (_, changed) => {
    const f = fixture();
    expect(() =>
      parseMediaImagePromotionResult(
        { ...f.result, original: { ...f.result.original, ...changed } },
        f.plan,
        f.source,
      ),
    ).toThrow(invalid);
  });

  it("rejects output format/tuple substitution, missing outputs and inconsistent same-width dimensions", () => {
    const f = fixture();
    for (const renditions of [
      f.result.renditions.slice(1),
      [...f.result.renditions].reverse(),
      f.result.renditions.map((r, i) => (i === 1 ? { ...r, height: r.height + 1 } : r)),
      f.result.renditions.map((r) => ({ ...r, height: 16384 })),
      f.result.renditions.map((r, i) =>
        i === 0 ? { ...r, objectEvidenceReference: f.plan.original.objectEvidenceReference } : r,
      ),
      f.result.renditions.map((r, i) => (i === 0 ? { ...r, byteSize: 10 * 1024 * 1024 + 1 } : r)),
      f.result.renditions.map((r, i) =>
        i === 0 ? { ...r, checksum: "sha256:not-a-checksum" } : r,
      ),
    ])
      expect(() =>
        parseMediaImagePromotionResult({ ...f.result, renditions }, f.plan, f.source),
      ).toThrow(invalid);
  });

  it("refuses completion before actual scan or source creation and never executes accessors", () => {
    const f = fixture(),
      getter = vi.fn(() => f.result.original);
    expect(() =>
      parseMediaImagePromotionResult(
        { ...f.result, completedAt: "2026-10-03T12:00:30.000Z" },
        f.plan,
        f.source,
      ),
    ).toThrow(invalid);
    const malformed = Object.defineProperty({ ...f.result }, "original", {
      enumerable: true,
      get: getter,
    });
    expect(() => parseMediaImagePromotionResult(malformed, f.plan, f.source)).toThrow(invalid);
    expect(getter).not.toHaveBeenCalled();
  });
});

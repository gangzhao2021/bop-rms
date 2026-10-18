import { expect, it, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingInstant,
  parseReleaseSequence,
} from "../contracts/publishing.js";
import {
  createPostgresPublishingMutationStore,
  publishingRecordedMutationDigest,
} from "../infrastructure/persistence/publishing-mutation-store.js";
import type { CommitPublishingMutationInput } from "../application/ports/publishing-ports.js";
const id = (n: number) => `018f9f35-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = parsePublishingInstant("2026-10-05T00:00:00.000Z"),
  until = parsePublishingInstant("2026-10-05T00:01:00.000Z");
function fixture() {
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: id(2),
    storeReference: null,
  });
  const draft = createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(id(5)),
    familyReference: parsePublishingReference(id(6)),
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
    snapshotReference: parsePublishingReference(id(8)),
    snapshotDigest: parsePublishingDigest(`sha256:${"a".repeat(64)}`),
    scope,
    version: parsePublishingVersion(1),
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  });
  const validation = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(20)),
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: until,
    checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
  });
  const review = createPublishingLifecycleRecord({
    ...draft,
    version: parsePublishingVersion(2),
    state: "InReview",
    validationEvidenceReference: validation.evidenceReference,
  });
  const approval = createPublishingApprovalEvidence({
    evidenceReference: parsePublishingReference(id(21)),
    reviewLifecycleId: review.lifecycleId,
    reviewVersion: review.version,
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope,
    decision: "Accepted",
    approvedActorReference: parsePublishingReference(id(99)),
    approvedAt: at,
    validUntil: until,
  });
  const approved = createPublishingLifecycleRecord({
    ...review,
    version: parsePublishingVersion(3),
    state: "Approved",
    approvalEvidenceReference: approval.evidenceReference,
  });
  const published = createPublishingLifecycleRecord({
    ...approved,
    version: parsePublishingVersion(4),
    state: "Published",
  });
  const release = createPublishingReleaseRecord({
    releaseId: parsePublishingReference(id(22)),
    familyReference: draft.familyReference,
    configurationType: draft.configurationType,
    purposeCode: draft.purposeCode,
    snapshotReference: draft.snapshotReference,
    snapshotDigest: draft.snapshotDigest,
    scope,
    sequence: parseReleaseSequence(1),
    sourceLifecycleId: draft.lifecycleId,
    kind: "Publish",
    previousReleaseId: null,
    createdAt: at,
  });
  const audit = (action: string, operation: number) =>
    validateAuditRecord({
      auditId: id(operation + 100),
      brandId: id(2),
      actor: { type: "User", reference: id(4) },
      actionCode: action,
      targetType: "PublishingLifecycle",
      targetId: id(5),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(operation),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_SECURITY",
      retentionPolicyVersion: 1,
    });
  const base = {
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: null,
  };
  const create: CommitPublishingMutationInput = {
    ...base,
    operation: "CreateDraft",
    expectedVersion: parsePublishingVersion(1),
    idempotencyKey: parsePublishingReference(id(7)),
    current: null,
    next: draft,
    audit: audit("PUBLISHING_DRAFT_CREATED", 7),
  };
  const publish: CommitPublishingMutationInput = {
    ...base,
    operation: "Publish",
    expectedVersion: approved.version,
    idempotencyKey: parsePublishingReference(id(23)),
    current: approved,
    next: published,
    release,
    validationEvidence: validation,
    approvalEvidence: approval,
    audit: audit("PUBLISHING_RELEASE_PUBLISHED", 23),
  };
  const archive: CommitPublishingMutationInput = {
    ...base,
    operation: "Archive",
    expectedVersion: published.version,
    idempotencyKey: parsePublishingReference(id(24)),
    current: published,
    next: createPublishingLifecycleRecord({
      ...published,
      state: "Archived",
      version: parsePublishingVersion(5),
    }),
    audit: audit("PUBLISHING_RELEASE_ARCHIVED", 24),
  };
  const row = (m: CommitPublishingMutationInput) => ({
    tenant_id: id(1),
    brand_id: id(2),
    store_id: null,
    family_id: id(6),
    lifecycle_id: m.next.lifecycleId,
    lifecycle_version: String(m.next.version),
    operation_id: m.idempotencyKey,
    operation_code: m.operation,
    actor_id: id(4),
    audit_id: m.audit.auditId,
    intent_hash: publishingRecordedMutationDigest(m),
    release_id: m.release?.releaseId ?? null,
    release_sequence: m.release === null ? null : String(m.release.sequence),
    changed_at: m.next.changedAt,
    mutation_json: m,
  });
  let family: unknown[] = [],
    releases: unknown[] = [],
    latest: unknown[] = [];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT tenant_id")
      ? sql.includes("AND release_id IS NOT NULL")
        ? releases
        : family
      : sql.startsWith("SELECT mutation_json")
        ? sql.includes("release_id IS NOT NULL")
          ? releases
          : latest
        : [],
  }));
  const tx = { query };
  const source = createPostgresPublishingMutationStore(
    { run: async (work) => work(tx) },
    id(1),
    scope,
  );
  const input = { familyReference: id(6), observedAt: at };
  return {
    source,
    input,
    tx,
    query,
    create,
    publish,
    archive,
    row,
    seed: (f: unknown[], r: unknown[], l: unknown[] = f) => {
      family = f;
      releases = r;
      latest = l;
    },
  };
}
it("confirms real release absence with and without a recorded ordinary Draft", async () => {
  const f = fixture();
  expect(await f.source.resolveCurrentOptionSetPublicationStatus(f.input)).toMatchObject({
    outcome: "Absent",
    latestRecordedLifecycle: null,
    lastReleaseReference: null,
  });
  f.seed([f.row(f.create)], []);
  expect(await f.source.resolveCurrentOptionSetPublicationStatus(f.input)).toMatchObject({
    outcome: "Absent",
    latestRecordedLifecycle: { state: "Draft" },
    lastReleaseReference: null,
  });
  expect(f.query.mock.calls.some(([sql]) => sql.includes("IN SHARE MODE"))).toBe(true);
});
it("returns the complete original Approved publication proof through the existing current resolver", async () => {
  const f = fixture();
  f.seed([f.row(f.publish)], [f.row(f.publish)]);
  const status = await f.source.resolveCurrentOptionSetPublicationStatus(f.input);
  expect(status.outcome).toBe("Published");
  if (status.outcome !== "Published") throw Error("Expected actual published proof");
  expect(status.proof.approvalDisposition).toBe("Approved");
  expect(status.proof.release.releaseId).toBe(id(22));
});
it("reports a genuinely archived release as not currently Published while preserving the old failure contract", async () => {
  const f = fixture();
  f.seed([f.row(f.archive)], [f.row(f.publish)]);
  expect(await f.source.resolveCurrentOptionSetPublicationStatus(f.input)).toMatchObject({
    outcome: "NotCurrentlyPublished",
    lifecycle: { state: "Archived" },
    lastReleaseReference: id(22),
  });
  await expect(f.source.resolveCurrentOptionSetRelease(f.input)).rejects.toThrow();
});
it.each(["scope", "digest", "future", "governance", "tuple"])(
  "never converts %s source contradictions to absence",
  async (change) => {
    const f = fixture();
    const row = f.row(f.create);
    if (change === "scope") row.brand_id = id(90);
    if (change === "digest") row.intent_hash = parsePublishingDigest(`sha256:${"b".repeat(64)}`);
    if (change === "future") row.changed_at = parsePublishingInstant("2026-10-05T00:00:01.000Z");
    if (change === "tuple") row.operation_id = parsePublishingReference(id(90));
    if (change === "governance") {
      const m = {
        ...f.create,
        next: createPublishingLifecycleRecord({
          ...f.create.next,
          configurationType: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
          purposeCode: parsePublishingCode("OPTION_SET_PUBLICATION_POLICY"),
        }),
      };
      f.seed([f.row(m)], []);
    } else f.seed([row], []);
    await expect(f.source.resolveCurrentOptionSetPublicationStatus(f.input)).rejects.toThrow();
  },
);
it("keeps dependency errors and missing source lifecycle fail closed", async () => {
  const f = fixture();
  f.tx.query.mockRejectedValueOnce(Error("controlled dependency failure"));
  await expect(f.source.resolveCurrentOptionSetPublicationStatus(f.input)).rejects.toThrow();
  const missing = fixture();
  missing.seed([missing.row(missing.publish)], [missing.row(missing.publish)], []);
  await expect(
    missing.source.resolveCurrentOptionSetPublicationStatus(missing.input),
  ).rejects.toThrow();
});
it("rejects caller policy fields and invalid current observation", async () => {
  const f = fixture();
  await expect(
    f.source.resolveCurrentOptionSetPublicationStatus(
      Object.assign({}, f.input, { policyFamilyReference: id(30) }),
    ),
  ).rejects.toThrow();
  await expect(
    f.source.resolveCurrentOptionSetPublicationStatus({ ...f.input, observedAt: "bad" }),
  ).rejects.toThrow();
});
it("does not accept an archived classification when the original release tuple is corrupt", async () => {
  const f = fixture();
  f.seed([f.row(f.archive)], [{ ...f.row(f.publish), release_sequence: "2" }]);
  await expect(f.source.resolveCurrentOptionSetPublicationStatus(f.input)).rejects.toThrow();
});
it("rejects bounded source row accessors without executing them", async () => {
  const f = fixture();
  let read = 0;
  const row = f.row(f.create);
  Object.defineProperty(row, "intent_hash", {
    enumerable: true,
    get() {
      read++;
      return "unknown";
    },
  });
  f.seed([row], []);
  await expect(f.source.resolveCurrentOptionSetPublicationStatus(f.input)).rejects.toThrow();
  expect(read).toBe(0);
});

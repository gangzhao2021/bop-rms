import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
import { createPostgresReceiptTemplatePublicationProof } from "../../rms/printing-device/src/index.ts";
/** Synthetic validation/approver facts, real Publishing lifecycle, Release and Audit writes. */
export async function prepareReceiptTemplatePublication({
  admin,
  role,
  scope,
  version,
  digest,
  tenantReference,
}) {
  const id = (n) => "0190ed15-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const at = version.publishedAt,
    tenant = tenantReference ?? id(90),
    family = id(70);
  const publishingScope = { kind: "Store", ...scope };
  const runner = {
    run: async (work) => {
      await admin.query("BEGIN");
      try {
        const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
  const owner = createPostgresPublishingMutationStore(runner, tenant, publishingScope);
  const base = {
    lifecycleId: id(71),
    familyReference: family,
    configurationType: "RECEIPT_TEMPLATE",
    purposeCode: "RECEIPT_ISSUANCE",
    snapshotReference: version.versionReference,
    snapshotDigest: digest,
    scope: publishingScope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const mutation = (operation, current, next, n, extra = {}) => ({
    operation,
    expectedVersion: current?.version ?? 1,
    idempotencyKey: id(n),
    current,
    next,
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    validationEvidence: null,
    approvalEvidence: null,
    audit: {
      auditId: id(n + 1),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: id(91) },
      actionCode: {
        CreateDraft: "PUBLISHING_DRAFT_CREATED",
        SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
        Approve: "PUBLISHING_REVIEW_APPROVED",
        Publish: "PUBLISHING_RELEASE_PUBLISHED",
        Archive: "PUBLISHING_RELEASE_ARCHIVED",
      }[operation],
      targetType: "PublishingLifecycle",
      targetId: next.lifecycleId,
      reasonCode: "SYNTHETIC_TEMPLATE_PUBLICATION",
      correlationId: id(n),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
    ...extra,
  });
  await owner.commit(mutation("CreateDraft", null, base, 200));
  const validation = {
    evidenceReference: id(72),
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope: publishingScope,
    result: "Pass",
    checkedAt: at,
    validUntil: new Date(Date.parse(at) + 3600000).toISOString(),
    checkCodes: ["SYNTHETIC_TEMPLATE_ARTIFACTS"],
  };
  const review = { ...base, version: 2, state: "InReview", validationEvidenceReference: id(72) };
  await owner.commit(
    mutation("SubmitReview", base, review, 210, { validationEvidence: validation }),
  );
  const approval = {
    evidenceReference: id(73),
    reviewLifecycleId: base.lifecycleId,
    reviewVersion: 2,
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope: publishingScope,
    decision: "Accepted",
    approvedActorReference: id(91),
    approvedAt: at,
    validUntil: validation.validUntil,
  };
  const approved = { ...review, version: 3, state: "Approved", approvalEvidenceReference: id(73) };
  await owner.commit(mutation("Approve", review, approved, 220, { approvalEvidence: approval }));
  const published = { ...approved, version: 4, state: "Published" };
  const publication = mutation("Publish", approved, published, 230, {
    validationEvidence: validation,
    approvalEvidence: approval,
    release: {
      releaseId: version.publicationReference,
      familyReference: family,
      configurationType: base.configurationType,
      purposeCode: base.purposeCode,
      snapshotReference: base.snapshotReference,
      snapshotDigest: digest,
      scope: publishingScope,
      sequence: 1,
      sourceLifecycleId: base.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    },
  });
  await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
  );
  const proofOptions = {
    tenantReference: tenant,
    ...scope,
    familyReference: family,
    configurationType: base.configurationType,
    purposeCode: base.purposeCode,
    authorize: async () => true,
  };
  return {
    proofOptions,
    publish: () => owner.commit(publication),
    proof: createPostgresReceiptTemplatePublicationProof({
      tenantReference: tenant,
      ...scope,
      familyReference: family,
      configurationType: base.configurationType,
      purposeCode: base.purposeCode,
      authorize: async () => true,
    }),
    archive: (tx) =>
      createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        publishingScope,
      ).commit(
        mutation("Archive", published, { ...published, version: 5, state: "Archived" }, 240),
      ),
  };
}

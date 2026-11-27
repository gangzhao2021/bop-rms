import { tenantBrandConfigurationContentDigest } from "../../bop/tenant/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
/** Synthetic validation/approver facts, real Publishing lifecycle, Release and Audit writes. */
export async function prepareBrandRecipeOverridePublication({
  admin,
  role,
  configuration,
  lifecycleReference,
  familyReference,
  operationBase,
  id,
  previousRelease = null,
  tenantReference,
}) {
  const c = configuration,
    at = c.updatedAt,
    tenant = tenantReference,
    family = familyReference,
    digest = tenantBrandConfigurationContentDigest(c);
  const publishingScope = { kind: "Brand", brandReference: c.brandReference, storeReference: null };
  // Synthetic immutable Tenant metadata only; no ordinary configuration writer is claimed.
  await admin.query(
    `INSERT INTO bop_tenant.brand_configuration_version(
    configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,
    media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,
    hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,
    authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      c.configurationVersionReference,
      c.brandReference,
      c.configurationVersion,
      c.lifecycle,
      c.defaultLocale,
      c.supportedLocales,
      c.mediaThemeReference,
      c.catalogSourceReference,
      c.platformTemplateReference,
      c.overrideAllowedFieldCodes,
      c.hardRequirementFieldCodes,
      c.effectiveFrom,
      c.effectiveUntil,
      c.supersedesVersionReference,
      c.reasonCode,
      c.authoredByReference,
      c.approvedByReference,
      c.approvalEvidenceReference,
      c.publicationReference,
      c.createdAt,
      c.updatedAt,
      c.dataClassification,
    ],
  );
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
    lifecycleId: lifecycleReference,
    familyReference: family,
    configurationType: "BRAND_CONFIGURATION",
    purposeCode: "BRAND_CONFIGURATION",
    snapshotReference: c.configurationVersionReference,
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
      brandId: c.brandReference,
      actor: {
        type: "User",
        reference:
          operation === "CreateDraft" || operation === "SubmitReview"
            ? c.authoredByReference
            : c.approvedByReference,
      },
      actionCode: {
        CreateDraft: "PUBLISHING_DRAFT_CREATED",
        SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
        Approve: "PUBLISHING_REVIEW_APPROVED",
        Publish: "PUBLISHING_RELEASE_PUBLISHED",
        Archive: "PUBLISHING_RELEASE_ARCHIVED",
      }[operation],
      targetType: "PublishingLifecycle",
      targetId: next.lifecycleId,
      reasonCode: "SYNTHETIC_RECIPE_POLICY_PUBLICATION",
      correlationId: id(n),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
    ...extra,
  });
  await owner.commit(mutation("CreateDraft", null, base, operationBase + 200));
  const validation = {
    evidenceReference: id(operationBase + 72),
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope: publishingScope,
    result: "Pass",
    checkedAt: at,
    validUntil: new Date(Date.parse(at) + 3600000).toISOString(),
    checkCodes: ["SYNTHETIC_RECIPE_POLICY_ARTIFACTS"],
  };
  const review = {
    ...base,
    version: 2,
    state: "InReview",
    validationEvidenceReference: id(operationBase + 72),
  };
  await owner.commit(
    mutation("SubmitReview", base, review, operationBase + 210, { validationEvidence: validation }),
  );
  const approval = {
    evidenceReference: c.approvalEvidenceReference,
    reviewLifecycleId: base.lifecycleId,
    reviewVersion: 2,
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope: publishingScope,
    decision: "Accepted",
    approvedActorReference: c.approvedByReference,
    approvedAt: at,
    validUntil: validation.validUntil,
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: c.approvalEvidenceReference,
  };
  await owner.commit(
    mutation("Approve", review, approved, operationBase + 220, { approvalEvidence: approval }),
  );
  const published = { ...approved, version: 4, state: "Published" };
  const publication = mutation("Publish", approved, published, operationBase + 230, {
    supersededReleaseId: previousRelease?.releaseId ?? null,
    validationEvidence: validation,
    approvalEvidence: approval,
    release: {
      releaseId: c.publicationReference,
      familyReference: family,
      configurationType: base.configurationType,
      purposeCode: base.purposeCode,
      snapshotReference: base.snapshotReference,
      snapshotDigest: digest,
      scope: publishingScope,
      sequence: previousRelease ? previousRelease.sequence + 1 : 1,
      sourceLifecycleId: base.lifecycleId,
      kind: "Publish",
      previousReleaseId: previousRelease?.releaseId ?? null,
      createdAt: at,
    },
  });
  await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
  );
  await owner.commit(publication);
  return {
    tenantReference: tenant,
    lifecycle: published,
    release: publication.release,
    archive: (tx) =>
      createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        publishingScope,
      ).commit(
        mutation(
          "Archive",
          published,
          { ...published, version: 5, state: "Archived" },
          operationBase + 240,
        ),
      ),
  };
}

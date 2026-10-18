import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPostgresStoreApprovalAuthorization } from "../../rms/store/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";
/** Synthetic Store facts; actual Publishing writer and Audit persistence. */
export async function seedStorePublication(
  admin,
  id,
  configuration,
  digest,
  onApproved,
  approveMutation,
  validUntil = "2026-08-17T14:00:00.000Z",
) {
  const at = configuration.createdAt;
  const scope = {
    kind: "Store",
    brandReference: configuration.brandReference,
    storeReference: configuration.storeReference,
  };
  const base = {
    lifecycleId: id(71),
    familyReference: id(70),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: configuration.configurationReference,
    snapshotDigest: digest,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const store = createPostgresPublishingMutationStore(
    {
      async run(work) {
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
    },
    id(90),
    scope,
  );
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
      actor: { type: "User", reference: configuration.approvedByReference },
      actionCode: {
        CreateDraft: "PUBLISHING_DRAFT_CREATED",
        SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
        Approve: "PUBLISHING_REVIEW_APPROVED",
        Publish: "PUBLISHING_RELEASE_PUBLISHED",
      }[operation],
      targetType: "PublishingLifecycle",
      targetId: next.lifecycleId,
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(n),
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
    ...extra,
  });
  const lifecycleQuery = {
    familyReference: base.familyReference,
    lifecycleReference: base.lifecycleId,
    configurationType: base.configurationType,
    purposeCode: base.purposeCode,
    observedAt: at,
  };
  assert.equal(await store.resolveCurrentLifecycleMutation(lifecycleQuery), null);
  await store.commit(mutation("CreateDraft", null, base, 200));
  assert.equal((await store.resolveCurrentLifecycleMutation(lifecycleQuery)).next.state, "Draft");
  const validation = {
    evidenceReference: id(72),
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil,
    checkCodes: ["SCHEMA_VALID"],
  };
  const review = { ...base, version: 2, state: "InReview", validationEvidenceReference: id(72) };
  await store.commit(
    mutation("SubmitReview", base, review, 210, { validationEvidence: validation }),
  );
  const currentReview = await store.resolveCurrentLifecycleMutation(lifecycleQuery);
  assert.deepEqual(currentReview.validationEvidence, validation);
  assert.equal(currentReview.next.state, "InReview");
  await assert.rejects(
    store.resolveCurrentLifecycleMutation({ ...lifecycleQuery, purposeCode: "OTHER" }),
  );
  await assert.rejects(
    store.resolveCurrentLifecycleMutation({
      ...lifecycleQuery,
      observedAt: new Date(Date.parse(at) - 1).toISOString(),
    }),
  );
  const approval = {
    evidenceReference: configuration.approvalEvidenceReference,
    reviewLifecycleId: base.lifecycleId,
    reviewVersion: 2,
    snapshotReference: base.snapshotReference,
    snapshotDigest: digest,
    scope,
    decision: "Accepted",
    approvedActorReference: configuration.approvedByReference,
    approvedAt: at,
    validUntil: validation.validUntil,
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: approval.evidenceReference,
  };
  const approvalMutation = mutation("Approve", review, approved, 220, {
    approvalEvidence: approval,
  });
  if (approveMutation) await approveMutation(approvalMutation);
  else await store.commit(approvalMutation);

  const approvalQuery = {
    familyReference: base.familyReference,
    lifecycleReference: base.lifecycleId,
    configurationType: base.configurationType,
    purposeCode: base.purposeCode,
    observedAt: at,
  };
  const retainedApproval = await store.resolveCurrentLifecycleMutation(lifecycleQuery);
  assert.equal(retainedApproval.idempotencyKey, approvalMutation.idempotencyKey);
  assert.equal(retainedApproval.audit.auditId, approvalMutation.audit.auditId);
  assert.equal(retainedApproval.current.state, "InReview");
  assert.equal(retainedApproval.next.state, "Approved");
  const currentApproval = await store.resolveCurrentApproval(approvalQuery);
  assert.deepEqual(currentApproval.approvalEvidence, approval);
  await assert.rejects(store.resolveCurrentApproval({ ...approvalQuery, purposeCode: "OTHER" }));
  await assert.rejects(
    store.resolveCurrentApproval({ ...approvalQuery, observedAt: approval.validUntil }),
  );
  const authorizeApproval = createPostgresStoreApprovalAuthorization({
    tenantReference: id(90),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    publishingFamilyReference: base.familyReference,
    configurationType: base.configurationType,
    purposeCode: base.purposeCode,
    hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
    authorize: async () => true,
  });
  const approvalInput = {
    configuration: {
      ...configuration,
      lifecycle: "Approved",
      publicationReference: null,
      liveGateEvidenceReference: null,
    },
    reviewedPublication: configuration,
    lifecycleReference: base.lifecycleId,
  };
  // Keep the owner read fences in an actual transaction.
  await admin.query("BEGIN");
  try {
    const tx = { query: (sql, values) => admin.query(sql, [...values]) };
    const bound = await authorizeApproval(tx, approvalInput, configuration.updatedAt);
    assert.equal(bound.contentDigest, digest);
    await assert.rejects(
      authorizeApproval(
        tx,
        {
          ...approvalInput,
          configuration: { ...approvalInput.configuration, reasonCode: "CHANGED" },
        },
        configuration.updatedAt,
      ),
      /STORE_CURRENT_APPROVAL_UNAVAILABLE/,
    );
    await assert.rejects(
      authorizeApproval(
        tx,
        {
          ...approvalInput,
          configuration: { ...approvalInput.configuration, approvalEvidenceReference: id(999) },
        },
        configuration.updatedAt,
      ),
      /STORE_CURRENT_APPROVAL_UNAVAILABLE/,
    );
    await assert.rejects(
      authorizeApproval(
        tx,
        {
          ...approvalInput,
          reviewedPublication: { ...configuration, businessDayStartLocalTime: "06:00:00" },
        },
        configuration.updatedAt,
      ),
      /STORE_CURRENT_APPROVAL_UNAVAILABLE/,
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  await onApproved?.();
  const published = { ...approved, version: 4, state: "Published" };
  await store.commit(
    mutation("Publish", approved, published, 230, {
      validationEvidence: validation,
      approvalEvidence: approval,
      release: {
        releaseId: configuration.publicationReference,
        familyReference: base.familyReference,
        configurationType: base.configurationType,
        purposeCode: base.purposeCode,
        snapshotReference: base.snapshotReference,
        snapshotDigest: digest,
        scope,
        sequence: 1,
        sourceLifecycleId: base.lifecycleId,
        kind: "Publish",
        previousReleaseId: null,
        createdAt: at,
      },
    }),
  );
  await assert.rejects(store.resolveCurrentApproval(approvalQuery));
  assert.equal(
    (await store.resolveCurrentLifecycleMutation(lifecycleQuery)).next.state,
    "Published",
  );
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-STORE-LIVE-GATE',$2,$3,$4,1,'Production','Approved',$5,$6,$5,$7,$8,$8,'ConfigurationMetadata')",
    [
      id(80),
      id(90),
      scope.brandReference,
      scope.storeReference,
      configuration.approvedByReference,
      configuration.authoredByReference,
      configuration.liveGateEvidenceReference,
      at,
    ],
  );
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,1,'SYNTHETIC_TEST','SYNTHETIC_STORE_READY',$5,true,'Accepted',$6,1,$7,NULL,'ConfigurationMetadata')",
    [
      id(82),
      scope.brandReference,
      scope.storeReference,
      id(80),
      configuration.approvedByReference,
      id(83),
      validUntil,
    ],
  );
}

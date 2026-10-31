import { exerciseCurrentUniqueScopeHttp } from "./product-current-unique-scope-http.mjs";
import { exerciseCompletePublicationHttp } from "./product-complete-publication-http.mjs";
import { exerciseCurrentApprovalPublicationHttp } from "./product-current-approval-publication-http.mjs";
import { exerciseCurrentScopePolicyHttp } from "./product-current-scope-policy-http.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMerchantProductPublicationCommand } from "../../../apps/api/src/merchant-product-publication-command.ts";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { withProductPublicationHttp } from "../../../apps/api/test-support/product-publication-http.mjs";
import { createPublicationNativeHttpClient } from "./product-publication-client-http.mjs";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import {
  createPostgresPublishingMutationStore,
  publishingProductPublicationPolicyDigest,
  productPolicyScopeLevels,
} from "../../bop/publishing/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  deriveCatalogProductPublicationContentIdentity,
  parseProductAggregate,
  productPublicationCheckCodes,
  productApprovalReviewFields,
} from "../../rms/catalog/src/index.ts";
import { currentProductPolicyFields } from "../../../apps/api/src/current-product-publication-policy.ts";

// Actual owning review/current policy/decision/native IAM/encrypted sessions/BFF HTTP/SQL.
// Product baseline, complete validation/topology/phase/write/source fields and policy governance are synthetic.
export async function exerciseCurrentApprovalDecisionHttp({
  admin,
  role,
  id,
  transactions,
  originalAggregate,
}) {
  assert.match(role, /^wp2421_approval_[a-f0-9]+$/);
  const at = new Date().toISOString(),
    until = new Date(Date.parse(at) + 3600000).toISOString(),
    from = new Date(Date.parse(at) - 60000).toISOString(),
    publicationScope = { kind: "Brand", brandReference: id(2), storeReference: null },
    publisher = createPostgresPublishingMutationStore(transactions, id(1), publicationScope),
    hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
  let clock = at,
    mode = "normal",
    reviewAllowed = true,
    policyAllowed = true,
    reviewHolds = 0,
    policyHolds = 0,
    remainingCalls = 0,
    tentative = false;
  let commitInjected = false;
  const product = id(101005),
    version = id(101006);
  const aggregate = parseProductAggregate({
    ...originalAggregate,
    productReference: product,
    internalCode: "SYNTHETIC_NATIVE_APPROVAL",
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
    draft: { ...originalAggregate.draft, versionReference: version, createdAt: at, updatedAt: at },
  });
  await admin.query(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_NATIVE_APPROVAL','PreparedFood','Active',1,$3,$4,$3)",
    [product, id(2), at, id(3)],
  );
  await admin.query(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
    [version, product, id(2), aggregate.draft.localizedNames, at],
  );
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(101900),
    policyReference: id(101919),
    policyVersion: 1,
    scopeOrder: productPolicyScopeLevels,
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  };
  async function publish({ base, type, snapshot, digest, family, releaseId, approvalId, body }) {
    const draft = {
      lifecycleId: id(base),
      familyReference: family,
      configurationType: type,
      purposeCode: type,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    };
    const validation = {
      evidenceReference: id(base + 10),
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      result: "Pass",
      checkedAt: at,
      validUntil: until,
      checkCodes: ["SCHEMA_VALID"],
    };
    const review = {
      ...draft,
      version: 2,
      state: "InReview",
      validationEvidenceReference: validation.evidenceReference,
    };
    const approval = {
      evidenceReference: approvalId,
      reviewLifecycleId: draft.lifecycleId,
      reviewVersion: 2,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      decision: "Accepted",
      approvedActorReference: id(4),
      approvedAt: at,
      validUntil: until,
    };
    const approved = {
      ...review,
      version: 3,
      state: "Approved",
      approvalEvidenceReference: approvalId,
    };
    const published = { ...approved, version: 4, state: "Published" };
    const release = {
      releaseId,
      familyReference: family,
      configurationType: type,
      purposeCode: type,
      snapshotReference: snapshot,
      snapshotDigest: digest,
      scope: publicationScope,
      sequence: 1,
      sourceLifecycleId: draft.lifecycleId,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: at,
    };
    const mutation = (operation, current, next, offset, extra = {}) => ({
      operation,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(base + offset),
      current,
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: id(base + offset + 1),
        brandId: id(2),
        actor: {
          type: "User",
          reference: operation === "CreateDraft" || operation === "SubmitReview" ? id(3) : id(4),
        },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
        }[operation],
        targetType: "PublishingLifecycle",
        targetId: next.lifecycleId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(base + offset),
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
        retentionPolicyVersion: 1,
      },
      ...extra,
    });
    await publisher.commit(
      mutation("CreateDraft", null, draft, 1, body ? { productPolicyContent: body } : {}),
    );
    await publisher.commit(
      mutation("SubmitReview", draft, review, 3, { validationEvidence: validation }),
    );
    await publisher.commit(
      mutation("Approve", review, approved, 5, { approvalEvidence: approval }),
    );
    await publisher.commit(
      mutation("Publish", approved, published, 7, {
        validationEvidence: validation,
        approvalEvidence: approval,
        release,
      }),
    );
  }

  await publish({
    base: 101930,
    type: "PRODUCT_PUBLICATION_POLICY",
    snapshot: policy.policyReference,
    digest: publishingProductPublicationPolicyDigest(policy),
    family: policy.familyReference,
    releaseId: id(101920),
    approvalId: id(101921),
    body: policy,
  });
  const sessions = [];
  for (const [index, actor] of [3, 4].entries()) {
    const referencePrefix = index === 0 ? "01909701" : "01909702",
      sessionReferencePrefix = index === 0 ? "01909703" : "01909704",
      base = 101100 + index * 100;
    const session = await seedMerchantAcceptanceSession({
      admin,
      runner: transactions,
      role,
      scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(101020) },
      actor: id(actor),
      at,
      referencePrefix,
      sessionReferencePrefix,
    });
    sessions.push(session);
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
      [id(base), id(2), "synthetic_native_approval_" + index, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
      [
        id(base + 1),
        id(base),
        referencePrefix + "-0000-7000-8000-000000000001",
        id(actor),
        id(2),
        from,
        until,
      ],
    );
    for (const [j, action] of [
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.product.validate",
      "catalog.product.submit",
      "catalog.product.approve",
    ].entries()) {
      let permission = (
        await admin.query(
          "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
          [action],
        )
      ).rows[0]?.permission_id;
      if (!permission) {
        permission = id(base + 10 + j);
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
          [permission, action, from],
        );
      }
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [id(base + 20 + j), id(base), permission, id(2), from, until],
      );
    }
  }
  const fineGrant = id(101225),
    now = () => clock;
  const command = (action, root, pub, n) => ({
    operationReference: id(n),
    productReference: product,
    versionReference: version,
    expectedProductAggregateVersion: root,
    expectedPublicationVersion: pub,
    action,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_NATIVE_APPROVAL",
  });
  const sources = {
    async withHeldCurrentFacts(tx, input, work) {
      remainingCalls++;
      const c = input.command;
      const facts = {
        now: clock,
        productAggregateVersion: c.expectedProductAggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        validation: {
          evidenceReference: id(101018),
          productAggregateVersion: c.expectedProductAggregateVersion,
          contentDigest: c.contentDigest,
          configurationDigest: c.configurationDigest,
          scopeDigest: hash(c.scopeSet),
          periodDigest: hash(c.effectivePeriod),
          policyReference: policy.policyReference,
          policyVersion: 1,
          approvalPolicy: "Required",
          checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
          warningAcknowledgement: null,
          checkedAt: clock,
          validUntil: until,
        },
        approval: null,
        reviewReference: id(101019),
        replacement: null,
      };
      const result = await work(facts);
      if (c.action === "Approve") {
        assert.equal(
          (
            await tx.query(
              "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
              [product],
            )
          ).rows[0].aggregate_version,
          4,
        );
        tentative = true;
        if (mode === "late-grant")
          await tx.query(
            "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
            [fineGrant],
          );
        if (mode === "late-review") reviewAllowed = false;
        if (mode === "late-policy") policyAllowed = false;
        if (mode === "late-expiry") clock = new Date(Date.parse(at) + 5000).toISOString();
      }
      return result;
    },
  };
  const configuration = {
    maximumApprovalValiditySeconds: 12,
    reviewAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        reviewHolds++;
        assert.deepEqual(input.requiredFields, productApprovalReviewFields);
        assert.equal(input.purposeCode, "CATALOG_PRODUCT_APPROVAL_DECISION");
        if (!reviewAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (commitInjected && mode === "commit-review-nonvoid") return {};
      },
    },
    policyAuthority: {
      async holdUntilTransactionCompletes(_tx, input) {
        policyHolds++;
        assert.deepEqual(input.requiredFields, currentProductPolicyFields);
        assert.equal(input.policyReference, policy.policyReference);
        if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (commitInjected && mode === "commit-policy-nonvoid") return {};
      },
    },
  };
  const handlers = sessions.map((session) => {
    const merchant = { ...session.persistence, now };
    return createMerchantProductPublicationCommand({
      merchant,
      authentication: createPersistentMerchantBffService(merchant),
      auditReference: (operation) => id(parseInt(operation.slice(-12), 16) + 5000),
      authority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.command.actorKind, "User");
          assert.equal(input.requiredScope, "FullBrandScope");
        },
      },
      sources,
      approvalDecision: configuration,
    });
  });
  // Separate two-second decision ceiling. Inject only in final outer write
  // authority, after the actual owning review/policy callback has completed.
  const commitHandlers = sessions.map((session) => {
    const merchant = { ...session.persistence, now };
    return createMerchantProductPublicationCommand({
      merchant,
      authentication: createPersistentMerchantBffService(merchant),
      auditReference: (operation) => id(parseInt(operation.slice(-12), 16) + 5000),
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(input.command.actorKind, "User");
          assert.equal(input.requiredScope, "FullBrandScope");
          if (
            input.command.action === "Approve" &&
            tentative &&
            reviewHolds >= 2 &&
            policyHolds >= 2 &&
            mode.startsWith("commit-")
          ) {
            assert.equal(
              (
                await tx.query(
                  "SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1",
                  [product],
                )
              ).rows[0].aggregate_version,
              4,
            );
            commitInjected = true;
            if (mode === "commit-review") reviewAllowed = false;
            if (mode === "commit-policy") policyAllowed = false;
            if (mode === "commit-short-expiry")
              clock = new Date(Date.parse(at) + 2000).toISOString();
          }
        },
      },
      sources,
      approvalDecision: { ...configuration, maximumApprovalValiditySeconds: 2 },
    });
  });
  // Captured server collaborators cannot change after normal handler creation.
  configuration.reviewAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_REVIEW");
  };
  configuration.policyAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("SYNTHETIC_REBOUND_POLICY");
  };
  const scope = { brandReference: id(2), storeReference: id(101020) };
  const tables = (
    await admin.query(
      "SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema=ANY($1::text[]) ORDER BY table_schema,table_name",
      [
        [
          "rms_catalog",
          "bop_publishing",
          "bop_tenant",
          "bop_permission",
          "platform_audit",
          "platform_eventing",
        ],
      ],
    )
  ).rows;
  const state = async () => {
    const result = {};
    for (const { table_schema: s, table_name: t } of tables) {
      assert.match(s, /^[a-z_]+$/);
      assert.match(t, /^[a-z_]+$/);
      const rows = (
        await admin.query(
          'SELECT to_jsonb(t) value FROM "' + s + '"."' + t + '" t ORDER BY to_jsonb(t)::text',
        )
      ).rows;
      result[s + "." + t] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return result;
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT count(*)::int FROM rms_catalog.product_approval_receipt WHERE product_id=$1) receipts,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
        [product],
      )
    ).rows[0];
  const approve = command("Approve", 3, 2, 101012);
  await withProductPublicationHttp(handlers[0], sessions[0], scope, async (post) => {
    assert.equal((await post(command("Validate", 1, 0, 101010))).status, 200);
    assert.equal((await post(command("SubmitReview", 2, 1, 101011))).status, 200);
    const before = await state();
    assert.equal((await post(approve)).status, 503);
    assert.deepEqual(await state(), before);
  });
  await withProductPublicationHttp(handlers[1], sessions[1], scope, async (post) => {
    let before = await state();
    reviewAllowed = false;
    assert.equal((await post(approve)).status, 403);
    assert.deepEqual(await state(), before);
    reviewAllowed = true;
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [fineGrant],
    );
    before = await state();
    assert.equal((await post(approve)).status, 403);
    assert.deepEqual(await state(), before);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [fineGrant],
    );
    for (const [probe, status] of [
      ["late-grant", 403],
      ["late-review", 403],
      ["late-policy", 403],
      ["late-expiry", 503],
    ]) {
      mode = probe;
      clock = at;
      reviewAllowed = true;
      policyAllowed = true;
      tentative = false;
      before = await state();
      assert.equal((await post(approve)).status, status, probe);
      assert.equal(tentative, true);
      assert.deepEqual(await state(), before);
    }
    await withProductPublicationHttp(commitHandlers[1], sessions[1], scope, async (commitPost) => {
      for (const [probe, status] of [
        ["commit-review", 403],
        ["commit-policy", 403],
        ["commit-review-nonvoid", 503],
        ["commit-policy-nonvoid", 503],
        ["commit-short-expiry", 503],
      ]) {
        mode = probe;
        clock = at;
        reviewAllowed = policyAllowed = true;
        tentative = commitInjected = false;
        reviewHolds = policyHolds = 0;
        before = await state();
        assert.equal((await commitPost(approve)).status, status, probe);
        assert.equal(commitInjected, true, probe);
        assert.deepEqual(await state(), before, probe);
      }
    });
    commitInjected = false;
    mode = "normal";
    clock = at;
    reviewAllowed = true;
    policyAllowed = true;
    const initial = await counts(),
      pending = createPublicationNativeHttpClient({
        post,
        command: approve,
        scope,
        csrf: sessions[1].csrf,
      });
    const lost = await pending({ loseNextResponse: true });
    assert.equal(lost.nativeReply.status, 200);
    assert.equal(lost.error.code, "OutcomeUnknown");
    const after = await counts();
    assert.equal(after.root, 4);
    for (const k of ["operations", "snapshots", "commits", "receipts", "audit", "outbox"])
      assert.equal(after[k], initial[k] + 1);
    const receipt = (
      await admin.query(
        "SELECT snapshot_json FROM rms_catalog.product_approval_receipt WHERE operation_id=$1",
        [approve.operationReference],
      )
    ).rows[0].snapshot_json;
    assert.equal(receipt.approval.evidenceReference, approve.operationReference);
    assert.equal(receipt.approval.requestedByActorReference, id(3));
    assert.equal(receipt.approval.approvedByActorReference, id(4));
    assert.equal(receipt.approval.approvedAt, at);
    assert.equal(receipt.approval.validUntil, new Date(Date.parse(at) + 12000).toISOString());
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [fineGrant],
    );
    before = await state();
    const denied = await pending();
    assert.equal(denied.nativeReply.status, 403);
    assert.equal(denied.error.code, "OutcomeUnknown");
    assert.deepEqual(await state(), before);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',version=version+1 WHERE grant_id=$1",
      [fineGrant],
    );
    clock = new Date(Date.parse(at) + 60000).toISOString();
    reviewHolds = policyHolds = remainingCalls = 0;
    reviewAllowed = policyAllowed = false;
    before = await state();
    const replay = await pending();
    assert.equal(replay.receipt.status, "Replayed");
    assert.equal(replay.receipt.aggregateVersion, 4);
    assert.equal(reviewHolds + policyHolds + remainingCalls, 0);
    assert.deepEqual(await state(), before);
  });
  await exerciseCurrentScopePolicyHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    product,
    at,
    from,
    until,
    policy,
    command,
    state,
    counts,
  });
  await exerciseCurrentApprovalPublicationHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    publish,
    state,
  });
  await exerciseCompletePublicationHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
  });
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
  });
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 108000,
    variantCase: true,
  });
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 109000,
    variantCase: true,
    selectionCase: true,
  });
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 110000,
    variantCase: true,
    selectionCase: true,
    inheritedCase: true,
  });
  // Independent current owning policy; immutable governance facts remain synthetic.
  const contentPolicy = {
    ...policy,
    familyReference: id(111900),
    policyReference: id(111919),
    requiredLocales: ["en-CA", "fr-CA"],
    mediaRequirement: "Required",
  };
  await publish({
    base: 111930,
    type: "PRODUCT_PUBLICATION_POLICY",
    snapshot: contentPolicy.policyReference,
    digest: publishingProductPublicationPolicyDigest(contentPolicy),
    family: contentPolicy.familyReference,
    releaseId: id(111920),
    approvalId: id(111921),
    body: contentPolicy,
  });
  const brandContent = await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy: contentPolicy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 111000,
    variantCase: true,
    contentCase: true,
  });
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy: contentPolicy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 112000,
    variantCase: true,
    contentCase: true,
    expiryCase: true,
    previousBrand: brandContent,
  });
  // Isolate the existing half-open publication time rule in ordinary Validate.
  // Remaining full checks are synthetic; current owner acquisition and persistence are actual.
  await exerciseCurrentUniqueScopeHttp({
    admin,
    role,
    id,
    sessions,
    scope,
    policy,
    originalAggregate,
    at,
    from,
    until,
    state,
    base: 113000,
    variantCase: true,
    elapsedPeriodCase: true,
  });
}

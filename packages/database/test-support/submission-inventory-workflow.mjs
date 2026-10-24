import {
  createPostgresWorkflowDefinitionStore,
  parseWorkflowDefinitionVersion,
  createWorkflowPublicationSnapshot,
} from "../../bop/workflow/src/index.ts";
import { createPostgresPublishingMutationStore } from "../../bop/publishing/src/index.ts";

/** Synthetic isolated-database configuration, never a real Store approval. */
export async function seedSubmissionInventoryWorkflow({
  runner,
  scope,
  actorReference,
  at,
  orderType,
}) {
  const id = (n) =>
    n === 1
      ? scope.tenantReference
      : n === 2
        ? scope.brandReference
        : n === 5
          ? actorReference
          : "01909996-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const draft = parseWorkflowDefinitionVersion({
    schemaVersion: 1,
    workflowReference: id(3),
    versionReference: id(4),
    versionNumber: 1,
    ...scope,
    storeReference: null,
    purposeCode: "OrderFulfillment",
    applicabilityCode: orderType,
    lifecycle: "Draft",
    baseVersionReference: null,
    overrideAuthorizationReference: null,
    effectiveFrom: at,
    effectiveUntil: null,
    publicationReference: null,
    approvalEvidenceReference: null,
    authoredByReference: id(5),
    createdAt: at,
    transitions: [
      ...["Accepted", "InProgress", "Ready"].map((phase, index) => ({
        transitionReference: id(30 + index),
        currentState: phase,
        action: "Accept",
        nextState: "Accepted",
        permissionCode: "order.accept",
        ruleReferences: [],
        effects: [],
      })),
      // Accepted multibatch policy: another batch can pay while earlier items progress.
      ...["Accepted", "InProgress", "Ready"].map((phase, index) => ({
        transitionReference: id(20 + index),
        currentState: phase,
        action: "CreatePaymentIntent",
        nextState: phase,
        permissionCode: "synthetic.payment.create",
        ruleReferences: [id(9)],
        effects: [{ ownerModule: "payment", commandCode: "CreatePaymentIntent" }],
      })),
      {
        transitionReference: id(12),
        currentState: "Accepted",
        action: "FulfillOrder",
        nextState: "Fulfilled",
        permissionCode: "order.fulfill",
        ruleReferences: [],
        effects: [],
      },
      {
        transitionReference: id(10),
        currentState: "Submitted",
        action: "Accept",
        nextState: "Accepted",
        permissionCode: "order.accept",
        ruleReferences: [],
        effects: [],
      },
      {
        transitionReference: id(11),
        currentState: "Accepted",
        action: "ReleasePaidOrder",
        nextState: "Accepted",
        permissionCode: "order.release",
        ruleReferences: [id(9)],
        effects: [],
      },
      {
        transitionReference: id(6),
        currentState: "CartReady",
        action: "SubmitOrder",
        nextState: "Submitted",
        permissionCode: "order.submit",
        ruleReferences: [id(7)],
        effects: [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
      },
      {
        transitionReference: id(8),
        currentState: "Submitted",
        action: "CreatePaymentIntent",
        nextState: "Submitted",
        permissionCode: "synthetic.payment.create",
        ruleReferences: [id(9)],
        effects: [{ ownerModule: "payment", commandCode: "CreatePaymentIntent" }],
      },
    ],
  });
  function write(definition, n) {
    return {
      definition,
      operationReference: id(n),
      audit: {
        auditId: id(n + 1),
        brandId: id(2),
        ...(definition.storeReference === null ? {} : { storeId: definition.storeReference }),
        actor: { type: "User", reference: id(5) },
        actionCode: "WORKFLOW_DEFINITION_" + definition.lifecycle.toUpperCase(),
        targetType: "WorkflowDefinitionVersion",
        targetId: definition.versionReference,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(n),
        occurredAt: definition.createdAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      },
    };
  }
  const store = createPostgresWorkflowDefinitionStore(runner(), { ...scope, storeReference: null });
  const syntheticGate = async () => true;
  const actualDraft = parseWorkflowDefinitionVersion({
    ...draft,
    workflowReference: id(500),
    versionReference: id(501),
    purposeCode: "SubmissionInventoryFixture",
  });
  await store.commit(write(actualDraft, 510), syntheticGate);
  const snapshot = createWorkflowPublicationSnapshot(actualDraft);
  const publisher = createPostgresPublishingMutationStore(runner(), id(1), snapshot.scope);
  const initial = {
    lifecycleId: id(550),
    familyReference: snapshot.familyReference,
    configurationType: snapshot.configurationType,
    purposeCode: snapshot.purposeCode,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  function publicationMutation(operation, current, next, n, extra = {}) {
    return {
      operation,
      current,
      next,
      expectedVersion: current?.version ?? 1,
      idempotencyKey: id(n),
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: null,
      approvalEvidence: null,
      audit: {
        auditId: id(n + 1),
        brandId: id(2),
        actor: { type: "User", reference: id(5) },
        actionCode: {
          CreateDraft: "PUBLISHING_DRAFT_CREATED",
          SubmitReview: "PUBLISHING_REVIEW_SUBMITTED",
          Approve: "PUBLISHING_REVIEW_APPROVED",
          Publish: "PUBLISHING_RELEASE_PUBLISHED",
          Archive: "PUBLISHING_RELEASE_ARCHIVED",
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
    };
  }
  const validation = {
    evidenceReference: id(560),
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    result: "Pass",
    checkedAt: at,
    validUntil: new Date(Date.parse(at) + 3600000).toISOString(),
    checkCodes: ["SCHEMA_VALID"],
  };
  const review = {
    ...initial,
    version: 2,
    state: "InReview",
    validationEvidenceReference: id(560),
  };
  const approval = {
    evidenceReference: id(561),
    reviewLifecycleId: id(550),
    reviewVersion: 2,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    decision: "Accepted",
    approvedActorReference: id(5),
    approvedAt: at,
    validUntil: validation.validUntil,
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: id(561),
  };
  const publicationLifecycle = { ...approved, version: 4, state: "Published" };
  const release = {
    releaseId: id(562),
    familyReference: snapshot.familyReference,
    configurationType: snapshot.configurationType,
    purposeCode: snapshot.purposeCode,
    snapshotReference: snapshot.snapshotReference,
    snapshotDigest: snapshot.snapshotDigest,
    scope: snapshot.scope,
    sequence: 1,
    sourceLifecycleId: id(550),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: at,
  };
  await publisher.commit(publicationMutation("CreateDraft", null, initial, 600));
  await publisher.commit(
    publicationMutation("SubmitReview", initial, review, 602, {
      validationEvidence: validation,
    }),
  );
  await publisher.commit(
    publicationMutation("Approve", review, approved, 604, { approvalEvidence: approval }),
  );
  await publisher.commit(
    publicationMutation("Publish", approved, publicationLifecycle, 606, {
      validationEvidence: validation,
      approvalEvidence: approval,
      release,
    }),
  );
  const actualPublished = parseWorkflowDefinitionVersion({
    ...actualDraft,
    versionReference: id(502),
    versionNumber: 2,
    lifecycle: "Published",
    publicationReference: id(562),
    approvalEvidenceReference: id(561),
  });
  await store.commit(write(actualPublished, 520), syntheticGate);
  return {
    payment: {
      fulfillmentTransitionReference: id(12),
      acceptanceTransitionReference: id(10),
      releaseTransitionReference: id(11),
      workflowVersionReference: actualPublished.versionReference,
      purposeCode: actualDraft.purposeCode,
      action: "CreatePaymentIntent",
      permissionCode: "synthetic.payment.create",
      paymentCommandCode: "CreatePaymentIntent",
      intactReservationRuleReference: id(9),
    },
    purposeCode: actualDraft.purposeCode,
    applicabilityCode: orderType,
    currentState: "CartReady",
    action: "SubmitOrder",
    reserveCommandCode: "ReserveInventory",
    deferredActionCode: null,
    gates: {
      authorizeResource: async (_tx, request) =>
        request.actorReference === actorReference &&
        request.tenantReference === scope.tenantReference &&
        request.brandReference === scope.brandReference &&
        request.storeReference === scope.storeReference,
      authorizeAction: async () => true,
      evaluateRule: async () => true,
      authorizeOverride: async () => false,
    },
  };
}

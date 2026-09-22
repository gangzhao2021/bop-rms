import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
  type ExecutePublishingMutationInput,
  type PublishingAuthorizationPort,
  type PublishingLifecycleRecord,
} from "@bop/publishing";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  type StoreConfigurationVersion,
} from "../contracts/store-configuration-administration.js";
import { createPostgresStoreReviewSnapshotStore } from "./persistence/review-snapshot-store.js";
type SnapshotOptions = Parameters<typeof createPostgresStoreReviewSnapshotStore>[0];
type Tx = Parameters<SnapshotOptions["authorize"]>[0];
const fail = (): never => {
  throw new Error("STORE_APPROVAL_PREPARATION_UNAVAILABLE");
};
/** Must run in the same outer transaction as atomic Approve. Validation facts and
 * validity policy are trusted runtime dependencies; no default approval lifetime.
 */
export function createPersistentStoreApprovalPreparation(
  options: SnapshotOptions & {
    tenantReference: string;
    nextReference(): string;
    publishingAuthorization(tx: Tx): PublishingAuthorizationPort;
    validate(
      tx: Tx,
      configuration: StoreConfigurationVersion,
      at: string,
    ): Promise<{
      validUntil: string;
      checkCodes: readonly string[];
      liveGateEvidenceReference: string;
    }>;
  },
) {
  const snapshots = createPostgresStoreReviewSnapshotStore(options);
  return async (
    tx: Tx,
    candidateInput: StoreConfigurationVersion,
    tenantContext: ExecutePublishingMutationInput["tenantContext"],
    now: string,
  ) => {
    const at = parseCanonicalInstant(now);
    const candidate = createStoreConfigurationVersion(candidateInput);
    if (
      candidate.lifecycle !== "Approved" ||
      candidate.updatedAt > at ||
      String(tenantContext.actor.actorReference) !== candidate.approvedByReference ||
      tenantContext.brand.brandReference !== candidate.brandReference ||
      tenantContext.store?.storeReference !== candidate.storeReference
    )
      return fail();
    const scope = createPublishingScope({
      kind: "Store",
      brandReference: candidate.brandReference,
      storeReference: candidate.storeReference,
    });
    const publishing = createPostgresPublishingMutationStore(
      { run: async (work) => work(tx) },
      options.tenantReference,
      scope,
    );
    const retained = await snapshots.read(tx, candidate, at);
    if (retained) {
      const reviewed = retained.reviewedPublication;
      const projected = createStoreConfigurationVersion({
        ...candidate,
        lifecycle: "Published",
        publicationReference: reviewed.publicationReference,
        liveGateEvidenceReference: reviewed.liveGateEvidenceReference,
        updatedAt: reviewed.updatedAt,
      });
      if (options.hashContent(projected) !== options.hashContent(reviewed)) return fail();
      const configuration = createStoreConfigurationVersion({
        ...candidate,
        updatedAt: reviewed.updatedAt,
      });
      const head = await publishing.resolveCurrentLifecycleMutation({
        familyReference: parsePublishingReference(options.publishingFamilyReference),
        lifecycleReference: retained.lifecycleReference,
        configurationType: parsePublishingCode(options.configurationType),
        purposeCode: parsePublishingCode(options.purposeCode),
        observedAt: at,
      });
      if (!head) return fail();
      if (head.next.state === "Published" || head.next.state === "Archived")
        return Object.freeze({ kind: "Replay" as const, configuration });
      if (
        head.operation !== "Approve" ||
        head.next.state !== "Approved" ||
        head.current === null ||
        head.approvalEvidence === null
      )
        return fail();
      return Object.freeze({
        kind: "Approve" as const,
        configuration,
        snapshot: retained,
        publishingApproval: {
          operation: "Approve" as const,
          expectedVersion: head.expectedVersion,
          current: head.current,
          next: head.next,
          approvalEvidence: head.approvalEvidence,
          idempotencyKey: head.idempotencyKey,
          auditId: parsePublishingReference(head.audit.auditId),
          correlationId: parsePublishingReference(head.audit.correlationId),
          occurredAt: head.audit.occurredAt,
          sourceChannel: parsePublishingCode(head.audit.sourceChannel),
        },
      });
    }
    const configuration = createStoreConfigurationVersion({ ...candidate, updatedAt: at });
    const validation = await options.validate(tx, configuration, at);
    const validUntil = parsePublishingInstant(validation.validUntil);
    if (validUntil <= at) return fail();
    const nextId = () => parsePublishingReference(options.nextReference());
    const reviewedPublication = createStoreConfigurationVersion({
      ...configuration,
      lifecycle: "Published",
      publicationReference: nextId(),
      liveGateEvidenceReference: parsePublishingReference(validation.liveGateEvidenceReference),
    });
    const snapshot = Object.freeze({
      reviewedPublication,
      lifecycleReference: nextId(),
      actorReference: String(configuration.approvedByReference),
      auditReference: nextId(),
    });
    await snapshots.save(tx, snapshot, at);
    const draft = createPublishingLifecycleRecord({
      lifecycleId: snapshot.lifecycleReference,
      familyReference: parsePublishingReference(options.publishingFamilyReference),
      configurationType: parsePublishingCode(options.configurationType),
      purposeCode: parsePublishingCode(options.purposeCode),
      snapshotReference: parsePublishingReference(configuration.configurationReference),
      snapshotDigest: parsePublishingDigest(options.hashContent(reviewedPublication)),
      scope,
      version: parsePublishingVersion(1),
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: at,
      changedAt: at,
    });
    const envelope = (
      operation: ExecutePublishingMutationInput["operation"],
      current: PublishingLifecycleRecord | null,
      next: PublishingLifecycleRecord,
    ) => ({
      operation,
      current,
      next,
      expectedVersion: parsePublishingVersion(current?.version ?? 1),
      idempotencyKey: nextId(),
      auditId: nextId(),
      correlationId: nextId(),
      occurredAt: at,
      sourceChannel: parsePublishingCode("MERCHANT_WEB"),
    });
    const ports = { authorization: options.publishingAuthorization(tx), unitOfWork: publishing };
    await executePublishingMutation(
      { ...envelope("CreateDraft", null, draft), tenantContext },
      ports,
    );
    const evidence = createPublishingValidationEvidence({
      evidenceReference: nextId(),
      snapshotReference: draft.snapshotReference,
      snapshotDigest: draft.snapshotDigest,
      scope,
      result: "Pass",
      checkedAt: at,
      validUntil,
      checkCodes: validation.checkCodes.map(parsePublishingCode),
    });
    const review = createPublishingLifecycleRecord({
      ...draft,
      version: parsePublishingVersion(2),
      state: "InReview",
      validationEvidenceReference: evidence.evidenceReference,
    });
    await executePublishingMutation(
      {
        ...envelope("SubmitReview", draft, review),
        tenantContext,
        validationEvidence: evidence,
      },
      ports,
    );
    const approvalEvidence = createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(configuration.approvalEvidenceReference),
      reviewLifecycleId: review.lifecycleId,
      reviewVersion: review.version,
      snapshotReference: review.snapshotReference,
      snapshotDigest: review.snapshotDigest,
      scope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(configuration.approvedByReference),
      approvedAt: at,
      validUntil,
    });
    const approved = createPublishingLifecycleRecord({
      ...review,
      version: parsePublishingVersion(3),
      state: "Approved",
      approvalEvidenceReference: approvalEvidence.evidenceReference,
    });
    return Object.freeze({
      kind: "Approve" as const,
      configuration,
      snapshot,
      publishingApproval: { ...envelope("Approve", review, approved), approvalEvidence },
    });
  };
}

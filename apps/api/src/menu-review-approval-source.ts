import {
  createPostgresPublishingMutationStore,
  createPublishingApprovalEvidence,
  createPublishingLifecycleRecord,
  createPublishingScope,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
} from "@bop/publishing";
import { parseBrandReference } from "@bop/tenant";
import { CatalogError, type ProductLifecycleTransaction } from "@rms/catalog";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};

/** Explicit authorized approval; caller revalidates reviewed dependencies and
 * retains the transaction through Catalog's matching approval transition. */
export function createMenuReviewApprovalSource(options: {
  tenantReference: string;
  brandReference: string;
  reference(purpose: "Approval" | "Audit", operationReference: string): string;
  validUntil(input: { approvedAt: string; validationValidUntil: string }): string;
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const scope = createPublishingScope({
    kind: "Brand",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: null,
  });
  return Object.freeze({
    async approve(
      tx: ProductLifecycleTransaction,
      input: {
        actorReference: string;
        menuReference: string;
        menuVersionReference: string;
        lifecycleReference: string;
        snapshotDigest: string;
        operationReference: string;
        expectedVersion: number;
        observedAt: string;
      },
    ) {
      try {
        const actor = parsePublishingReference(input.actorReference);
        const menu = parsePublishingReference(input.menuReference);
        const version = parsePublishingReference(input.menuVersionReference);
        const lifecycle = parsePublishingReference(input.lifecycleReference);
        const digest = parsePublishingDigest(input.snapshotDigest);
        const operation = parsePublishingReference(input.operationReference);
        const at = parsePublishingInstant(input.observedAt);
        if (input.expectedVersion !== 2) return fail("CATALOG_VERSION_CONFLICT");
        const approvalId = parsePublishingReference(options.reference("Approval", operation));
        const auditId = parsePublishingReference(options.reference("Audit", operation));
        if (new Set([operation, approvalId, auditId]).size !== 3)
          return fail("CATALOG_INPUT_INVALID");
        const allowed = async () => {
          if (!(await options.authorize(tx))) return fail("CATALOG_PERMISSION_DENIED");
        };
        await allowed();
        const owner = createPostgresPublishingMutationStore(
          { run: (work) => work(tx) },
          tenant,
          scope,
        );
        const query = {
          familyReference: menu,
          lifecycleReference: lifecycle,
          configurationType: "MENU",
          purposeCode: "CUSTOMER_ORDERING",
          observedAt: at,
        };
        const prior = await owner.resolveOperation({ ...query, operationReference: operation });
        if (prior) {
          if (
            prior.operation !== "Approve" ||
            prior.next.snapshotReference !== version ||
            prior.next.snapshotDigest !== digest ||
            prior.expectedVersion !== input.expectedVersion ||
            prior.approvalEvidence?.approvedActorReference !== actor ||
            prior.approvalEvidence.evidenceReference !== approvalId ||
            prior.audit.auditId !== auditId
          )
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          await allowed();
          return prior.next;
        }
        const head = await owner.resolveCurrentLifecycleMutation(query);
        if (
          !head ||
          head.operation !== "SubmitReview" ||
          head.next.state !== "InReview" ||
          head.next.version !== input.expectedVersion ||
          head.next.snapshotReference !== version ||
          head.next.snapshotDigest !== digest ||
          !head.validationEvidence
        )
          return fail("CATALOG_VERSION_CONFLICT");
        const validation = head.validationEvidence;
        if (
          validation.checkedAt > at ||
          validation.validUntil <= at ||
          validation.evidenceReference !== head.next.validationEvidenceReference ||
          validation.snapshotReference !== version ||
          validation.snapshotDigest !== digest
        )
          return fail();
        const validUntil = parsePublishingInstant(
          options.validUntil({
            approvedAt: at,
            validationValidUntil: validation.validUntil,
          }),
        );
        if (validUntil <= at || validUntil > validation.validUntil) return fail();
        const approval = createPublishingApprovalEvidence({
          evidenceReference: approvalId,
          reviewLifecycleId: lifecycle,
          reviewVersion: head.next.version,
          snapshotReference: version,
          snapshotDigest: digest,
          scope,
          decision: "Accepted",
          approvedActorReference: actor,
          approvedAt: at,
          validUntil,
        });
        const next = createPublishingLifecycleRecord({
          ...head.next,
          state: "Approved",
          version: parsePublishingVersion(3),
          approvalEvidenceReference: approvalId,
          changedAt: at,
        });
        await allowed();
        await owner.commit({
          operation: "Approve",
          current: head.next,
          next,
          expectedVersion: head.next.version,
          idempotencyKey: operation,
          release: null,
          supersededReleaseId: null,
          rollbackTargetReleaseId: null,
          validationEvidence: null,
          approvalEvidence: approval,
          audit: {
            auditId,
            brandId: options.brandReference,
            actor: { type: "User", reference: actor },
            actionCode: "PUBLISHING_REVIEW_APPROVED",
            targetType: "PublishingLifecycle",
            targetId: lifecycle,
            correlationId: operation,
            occurredAt: at,
            reasonCode: "AUTHORIZED_OPERATION",
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
            retentionPolicyVersion: 1,
          },
        });
        await allowed();
        return next;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}

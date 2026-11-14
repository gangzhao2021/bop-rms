import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  parsePublishingReference,
  parsePublishingVersion,
  parseReleaseSequence,
  parsePublishingCode,
  type PublishingAuthorizationPort,
  type ExecutePublishingMutationInput,
} from "@bop/publishing";
import { parseCanonicalInstant } from "@bop/tenant";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import type { StoreConfigurationAdministrationInput } from "../application/store-configuration-administration-service.js";
import { createPersistentStoreConfigurationAdministration } from "./configuration-administration.js";
import { createPostgresStoreReviewSnapshotStore } from "./persistence/review-snapshot-store.js";
type Administration = Parameters<typeof createPersistentStoreConfigurationAdministration>[0];
type Tx = Parameters<Administration["ports"]>[0];
type SnapshotOptions = Parameters<typeof createPostgresStoreReviewSnapshotStore>[0];
const fail = (): never => {
  throw new Error("STORE_PUBLICATION_PREPARATION_UNAVAILABLE");
};
/** Publish exact reviewed content and Store snapshots/Audit atomically. Never
 * replace Live Gate with Publishing success. Replay only through Store owner.
 */
export function createPersistentStoreConfigurationPublication(options: {
  administration: Omit<Administration, "approvalSnapshot">;
  snapshotAudit: SnapshotOptions["appendAudit"];
  publishingAuthorization(tx: Tx): PublishingAuthorizationPort;
}) {
  const configured = options.administration;
  return (
    input: StoreConfigurationAdministrationInput,
    tenantContext: ExecutePublishingMutationInput["tenantContext"],
  ) =>
    configured.run(async (tx) => {
      const at = parseCanonicalInstant(configured.now());
      const candidate = createStoreConfigurationVersion(input.configuration);
      if (!["Approved", "Published"].includes(candidate.lifecycle)) return fail();
      const snapshots = createPostgresStoreReviewSnapshotStore({
        ...configured.publication,
        brandReference: configured.brandReference,
        storeReference: configured.storeReference,
        appendAudit: options.snapshotAudit,
      });
      const retained = await snapshots.read(tx, candidate, at);
      if (!retained) return fail();
      const configuration = retained.reviewedPublication;
      const projected = createStoreConfigurationVersion({
        ...candidate,
        lifecycle: "Published",
        publicationReference: configuration.publicationReference,
        liveGateEvidenceReference: configuration.liveGateEvidenceReference,
      });
      if (
        configured.publication.hashContent(projected) !==
          configured.publication.hashContent(configuration) ||
        (candidate.lifecycle === "Published" &&
          (candidate.publicationReference !== configuration.publicationReference ||
            candidate.liveGateEvidenceReference !== configuration.liveGateEvidenceReference))
      )
        return fail();
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        configured.publication.tenantReference,
        createPublishingScope({
          kind: "Store",
          brandReference: candidate.brandReference,
          storeReference: candidate.storeReference,
        }),
      );
      const query = {
        familyReference: configured.publication.publishingFamilyReference,
        lifecycleReference: retained.lifecycleReference,
        configurationType: configured.publication.configurationType,
        purposeCode: configured.publication.purposeCode,
        observedAt: at,
      };
      const head = await publishing.resolveCurrentLifecycleMutation(query);
      if (!head) return fail();
      if (head.next.state !== "Published" && head.next.state !== "Archived") {
        const approval = await publishing.resolvePublicationCandidate(query);
        const release = createPublishingReleaseRecord({
          releaseId: parsePublishingReference(configuration.publicationReference),
          familyReference: approval.lifecycle.familyReference,
          configurationType: approval.lifecycle.configurationType,
          purposeCode: approval.lifecycle.purposeCode,
          snapshotReference: approval.lifecycle.snapshotReference,
          snapshotDigest: approval.lifecycle.snapshotDigest,
          scope: approval.lifecycle.scope,
          sequence: parseReleaseSequence((approval.previousRelease?.sequence ?? 0) + 1),
          sourceLifecycleId: approval.lifecycle.lifecycleId,
          kind: "Publish",
          previousReleaseId: approval.previousRelease?.releaseId ?? null,
          createdAt: at,
        });
        await executePublishingMutation(
          {
            tenantContext,
            operation: "Publish",
            current: approval.lifecycle,
            next: createPublishingLifecycleRecord({
              ...approval.lifecycle,
              state: "Published",
              version: parsePublishingVersion(approval.lifecycle.version + 1),
              changedAt: at,
            }),
            expectedVersion: approval.lifecycle.version,
            validationEvidence: approval.validationEvidence,
            approvalEvidence: approval.approvalEvidence,
            release,
            ...(approval.previousRelease ? { previousRelease: approval.previousRelease } : {}),
            idempotencyKey: parsePublishingReference(input.operationReference),
            auditId: parsePublishingReference(configured.nextReference()),
            correlationId: parsePublishingReference(input.operationReference),
            occurredAt: at,
            sourceChannel: parsePublishingCode("MERCHANT_WEB"),
          },
          { authorization: options.publishingAuthorization(tx), unitOfWork: publishing },
        );
      }
      return createPersistentStoreConfigurationAdministration({
        ...configured,
        run: async (work) => work(tx),
        now: () => at,
        approvalSnapshot: snapshots.read,
      }).publish({ ...input, configuration, occurredAt: at });
    });
}

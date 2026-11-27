import {
  executePublishingMutation,
  createPostgresPublishingMutationStore,
  createPublishingScope,
  type ExecutePublishingMutationInput,
  type PublishingAuthorizationPort,
} from "@bop/publishing";
import { parseCanonicalInstant, parseBrandReference, parseStoreReference } from "@bop/tenant";
import { createPersistentStoreConfigurationAdministration } from "./configuration-administration.js";
import { createPostgresStoreReviewSnapshotStore } from "./persistence/review-snapshot-store.js";

type Administration = Parameters<typeof createPersistentStoreConfigurationAdministration>[0];
type SnapshotOptions = Parameters<typeof createPostgresStoreReviewSnapshotStore>[0];
type SnapshotInput = Parameters<
  ReturnType<typeof createPostgresStoreReviewSnapshotStore>["save"]
>[1];
type Transaction = Parameters<Administration["ports"]>[0];

/** Approval command composition. All three owners participate in the caller's
 * transaction; failure must propagate to its rollback. Inputs are server-built,
 * not a transport contract. Publishing authorization must resolve current policy.
 */
export function createPersistentStoreConfigurationReview(options: {
  administration: Omit<Administration, "approvalSnapshot">;
  snapshotAudit: SnapshotOptions["appendAudit"];
  publishingAuthorization(tx: Transaction): PublishingAuthorizationPort;
}) {
  const configured = options.administration;
  return async (input: {
    storeCommand: unknown;
    snapshot: SnapshotInput;
    publishingApproval: ExecutePublishingMutationInput;
  }) =>
    configured.run(async (tx) => {
      const at = parseCanonicalInstant(configured.now());
      if (input.publishingApproval.operation !== "Approve")
        throw new Error("STORE_REVIEW_APPROVAL_INVALID");
      const snapshotStore = createPostgresStoreReviewSnapshotStore({
        ...configured.publication,
        brandReference: configured.brandReference,
        storeReference: configured.storeReference,
        appendAudit: options.snapshotAudit,
      });
      const next = input.publishingApproval.next;
      const reviewed = input.snapshot.reviewedPublication;
      if (
        String(next.lifecycleId) !== input.snapshot.lifecycleReference ||
        String(next.familyReference) !== configured.publication.publishingFamilyReference ||
        next.configurationType !== configured.publication.configurationType ||
        next.purposeCode !== configured.publication.purposeCode ||
        String(next.snapshotReference) !== reviewed.configurationReference ||
        String(next.snapshotDigest) !== configured.publication.hashContent(reviewed) ||
        String(input.publishingApproval.tenantContext.actor.actorReference) !==
          input.snapshot.actorReference ||
        input.snapshot.actorReference !== reviewed.approvedByReference
      )
        throw new Error("STORE_REVIEW_APPROVAL_INVALID");
      await snapshotStore.save(tx, input.snapshot, at);
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        configured.publication.tenantReference,
        createPublishingScope({
          kind: "Store",
          brandReference: parseBrandReference(configured.brandReference),
          storeReference: parseStoreReference(configured.storeReference),
        }),
      );
      await executePublishingMutation(input.publishingApproval, {
        authorization: options.publishingAuthorization(tx),
        unitOfWork: publishing,
      });
      return createPersistentStoreConfigurationAdministration({
        ...configured,
        run: async (work) => work(tx),
        now: () => at,
        approvalSnapshot: snapshotStore.read,
      }).approve(input.storeCommand);
    });
}

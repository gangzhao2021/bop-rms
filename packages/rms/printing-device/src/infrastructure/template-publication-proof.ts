import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
} from "@bop/publishing";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateVersion,
} from "../contracts/digital-receipt-template.js";
import type { ReceiptTemplateTransaction } from "./persistence/digital-receipt-template-store.js";

const fail = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
};
/** Actual current Publishing proof. The publisher separately validates the referenced
 * layout/compliance artifacts; a successful Release lookup does not invent those facts.
 * Caller holds this transaction through template materialization or receipt issuance.
 */
export function createPostgresReceiptTemplatePublicationProof(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  familyReference: string;
  configurationType: string;
  purposeCode: string;
  authorize(tx: ReceiptTemplateTransaction, observedAt: string): Promise<boolean>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: parseStoreReference(options.storeReference),
  });
  const family = parsePublishingReference(options.familyReference);
  const configurationType = parsePublishingCode(options.configurationType);
  const purposeCode = parsePublishingCode(options.purposeCode);
  return async (tx: ReceiptTemplateTransaction, value: unknown, observedAt: string) => {
    try {
      const at = parseCanonicalInstant(observedAt);
      if ((await options.authorize(tx, at)) !== true) return fail();
      const version = parseDigitalReceiptTemplateVersion(value);
      if (
        String(version.brandReference) !== String(scope.brandReference) ||
        String(version.storeReference) !== String(scope.storeReference) ||
        version.publishedAt > at
      )
        return fail();
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        scope,
      );
      const current = await publishing.resolveCurrentRelease({
        familyReference: family,
        configurationType,
        purposeCode,
        observedAt: at,
      });
      if ((await options.authorize(tx, at)) !== true) return fail();
      const { release, approvalEvidence: approval, validationEvidence: validation } = current;
      if (String(release.releaseId) !== String(version.publicationReference)) return null;
      const digest =
        "sha256:" + sha256Hex(canonicalizeRfc8785(JSON.parse(JSON.stringify(version))));
      const sameScope = (candidate: typeof scope) =>
        candidate.kind === "Store" &&
        candidate.brandReference === scope.brandReference &&
        candidate.storeReference === scope.storeReference;
      if (
        String(release.snapshotReference) !== String(version.versionReference) ||
        release.snapshotDigest !== digest ||
        release.createdAt !== version.publishedAt ||
        !sameScope(release.scope) ||
        approval.reviewLifecycleId !== release.sourceLifecycleId ||
        approval.snapshotReference !== release.snapshotReference ||
        approval.snapshotDigest !== digest ||
        !sameScope(approval.scope) ||
        approval.approvedAt > release.createdAt ||
        approval.validUntil <= release.createdAt ||
        validation.snapshotReference !== release.snapshotReference ||
        validation.snapshotDigest !== digest ||
        !sameScope(validation.scope) ||
        validation.checkedAt > release.createdAt ||
        validation.validUntil <= release.createdAt
      )
        return fail();
      return Object.freeze({ version, contentDigest: digest, release, observedAt: at });
    } catch {
      return fail();
    }
  };
}

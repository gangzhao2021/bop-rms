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

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the receipt template the Store uses today when it was
 * published by the installer (a version without an authored submission, whose release digest is
 * the full version envelope). Its Publishing family is learnt from the Publishing owner's public
 * read of that exact release (resolveCurrentReleaseForReference), then the version is proved with
 * the proof above. Only for versions without an authored submission (the caller decides that);
 * a release that is not the family's current one, or not found, proves nothing (null).
 */
export function createPostgresInstalledReceiptTemplatePublicationProof(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
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
  const configurationType = parsePublishingCode(options.configurationType);
  const purposeCode = parsePublishingCode(options.purposeCode);
  const authorize = options.authorize;
  if (typeof authorize !== "function") return fail();
  return async (tx: ReceiptTemplateTransaction, value: unknown, observedAt: string) => {
    let familyReference: string;
    try {
      const at = parseCanonicalInstant(observedAt);
      if ((await authorize.call(options, tx, at)) !== true) return fail();
      const version = parseDigitalReceiptTemplateVersion(value);
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        scope,
      );
      let recorded: Awaited<ReturnType<typeof publishing.resolveCurrentReleaseForReference>>;
      try {
        recorded = await publishing.resolveCurrentReleaseForReference({
          publicationReference: String(version.publicationReference),
          configurationType,
          purposeCode,
          observedAt: at,
        });
      } catch {
        // Not (or no longer) the current release of its family: this version is not in use.
        return null;
      }
      const release = recorded.recorded.release;
      if (
        String(release.releaseId) !== String(version.publicationReference) ||
        String(release.snapshotReference) !== String(version.versionReference) ||
        String(recorded.current.release.releaseId) !== String(release.releaseId)
      )
        return null;
      familyReference = String(release.familyReference);
    } catch {
      return fail();
    }
    const proof = createPostgresReceiptTemplatePublicationProof({
      tenantReference: tenant,
      brandReference: String(scope.brandReference),
      storeReference: String(scope.storeReference),
      familyReference,
      configurationType,
      purposeCode,
      authorize: (tx2, at2) => authorize.call(options, tx2, at2),
    });
    const packet = await proof(tx, value, observedAt);
    return packet === null ? null : Object.freeze({ ...packet, familyReference });
  };
}

/**
 * WP-2423 (DEC-STORE-SETUP-PUBLICATION 已知遗留, fixed 2026-10-16): the receipt template this Store
 * started with — the earliest-published template none of whose versions has an authored
 * submission (published by the installer, e.g. its first receipt template). Returns its template
 * reference, or null when the Store has none. This only finds the template; whether it can be used
 * today is proved by the caller with the installed publication proof above (its exact current
 * Publishing release). Read under the caller's held Store scope (row security applies).
 */
export async function readInstalledReceiptTemplateReference(
  tx: ReceiptTemplateTransaction,
  input: { readonly brandReference: string; readonly storeReference: string },
): Promise<string | null> {
  const brand = String(parseBrandReference(input.brandReference)),
    store = String(parseStoreReference(input.storeReference));
  const result = await tx.query(
    "SELECT v.template_id::text AS template_id FROM rms_device.digital_receipt_template_version v WHERE v.brand_id=$1 AND v.store_id=$2 AND NOT EXISTS (SELECT 1 FROM rms_device.digital_receipt_template_submission s WHERE s.brand_id=v.brand_id AND s.store_id=v.store_id AND s.template_id=v.template_id) GROUP BY v.template_id ORDER BY min(v.published_at),v.template_id LIMIT 1",
    [brand, store],
  );
  if (result.rows.length === 0) return null;
  const value = result.rows[0]?.template_id;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
}

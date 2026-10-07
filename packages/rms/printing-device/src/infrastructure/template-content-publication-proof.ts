import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  createPublishingApprovalEvidence,
  createPublishingValidationEvidence,
  createPublishingReleaseRecord,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingVersion,
} from "@bop/publishing";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";
import { parseDeviceReference } from "../contracts/device-management.js";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateVersion,
} from "../contracts/digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateContent,
  assertDigitalReceiptTemplateContentEnvelope,
} from "../contracts/digital-receipt-template-content.js";
import type { ReceiptTemplateTransaction } from "./persistence/digital-receipt-template-store.js";

const fail = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
};
function authored(value: unknown) {
  const keys = [
    "profile",
    "content",
    "authoredByReference",
    "submittedByReference",
    "familyReference",
    "reviewLifecycleReference",
    "reviewVersion",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const values = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return descriptor.value as unknown;
  });
  if (values[0] !== "DigitalReceiptTemplateAuthoredContentV2") return fail();
  return Object.freeze({
    content: parseDigitalReceiptTemplateContent(values[1]),
    authoredByReference: parseDeviceReference(values[2]),
    submittedByReference: parseDeviceReference(values[3]),
    familyReference: parsePublishingReference(values[4]),
    reviewLifecycleReference: parsePublishingReference(values[5]),
    reviewVersion: parsePublishingVersion(values[6]),
  });
}

/** Authored V2 content is approved before a real release ID/time exists. The
 * immutable owner source and Publishing source must retain their guards through
 * the caller transaction. This does not prove layout or professional compliance.
 * Legacy full-envelope digests remain governed by the separate legacy reader.
 */
export function createPostgresReceiptTemplateContentPublicationProof(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  familyReference: string;
  configurationType: string;
  purposeCode: string;
  authorize(tx: ReceiptTemplateTransaction, observedAt: string): Promise<boolean>;
  readAuthoredContent(
    tx: ReceiptTemplateTransaction,
    input: Readonly<{
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      templateReference: string;
      versionReference: string;
      observedAt: string;
    }>,
  ): Promise<unknown>;
}) {
  const tenant = parsePublishingReference(options.tenantReference);
  const brand = parseBrandReference(options.brandReference),
    store = parseStoreReference(options.storeReference);
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: brand,
    storeReference: store,
  });
  const family = parsePublishingReference(options.familyReference),
    configurationType = parsePublishingCode(options.configurationType),
    purposeCode = parsePublishingCode(options.purposeCode);
  const authorize = options.authorize,
    readAuthoredContent = options.readAuthoredContent;
  if (typeof authorize !== "function" || typeof readAuthoredContent !== "function") return fail();
  const capture = () => {
    if (
      options.authorize !== authorize ||
      options.readAuthoredContent !== readAuthoredContent ||
      options.tenantReference !== tenant ||
      options.brandReference !== scope.brandReference ||
      options.storeReference !== scope.storeReference ||
      options.familyReference !== family ||
      options.configurationType !== configurationType ||
      options.purposeCode !== purposeCode
    )
      return fail();
  };
  const admit = async (tx: ReceiptTemplateTransaction, at: string) => {
    capture();
    if ((await authorize.call(options, tx, at)) !== true) return fail();
    capture();
  };
  return async (tx: ReceiptTemplateTransaction, value: unknown, observedAt: string) => {
    try {
      const at = parseCanonicalInstant(observedAt);
      await admit(tx, at);
      const version = parseDigitalReceiptTemplateVersion(value);
      if (
        String(version.brandReference) !== String(brand) ||
        String(version.storeReference) !== String(store) ||
        version.publishedAt > at
      )
        return fail();
      const owner = authored(
        await readAuthoredContent.call(
          options,
          tx,
          Object.freeze({
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            templateReference: version.templateReference,
            versionReference: version.versionReference,
            observedAt: at,
          }),
        ),
      );
      capture();
      const content = owner.content;
      if (
        String(content.tenantReference) !== String(tenant) ||
        String(content.brandReference) !== String(brand) ||
        String(content.storeReference) !== String(store) ||
        owner.familyReference !== family
      )
        return fail();
      assertDigitalReceiptTemplateContentEnvelope(content, version);
      await admit(tx, at);
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
      const release = createPublishingReleaseRecord(current.release),
        approval = createPublishingApprovalEvidence(current.approvalEvidence),
        validation = createPublishingValidationEvidence(current.validationEvidence);
      await admit(tx, at);
      if (String(release.releaseId) !== String(version.publicationReference)) return null;
      const digest =
        "sha256:" + sha256Hex(canonicalizeRfc8785(JSON.parse(JSON.stringify(content))));
      const sameScope = (candidate: typeof scope) =>
        candidate.kind === "Store" &&
        candidate.brandReference === scope.brandReference &&
        candidate.storeReference === scope.storeReference;
      if (
        release.familyReference !== family ||
        release.configurationType !== configurationType ||
        release.purposeCode !== purposeCode ||
        String(release.snapshotReference) !== String(version.versionReference) ||
        release.snapshotDigest !== digest ||
        release.createdAt !== version.publishedAt ||
        !sameScope(release.scope) ||
        approval.reviewLifecycleId !== release.sourceLifecycleId ||
        approval.reviewLifecycleId !== owner.reviewLifecycleReference ||
        approval.reviewVersion !== owner.reviewVersion ||
        approval.snapshotReference !== release.snapshotReference ||
        approval.snapshotDigest !== digest ||
        !sameScope(approval.scope) ||
        String(approval.approvedActorReference) === String(owner.authoredByReference) ||
        String(approval.approvedActorReference) === String(owner.submittedByReference) ||
        approval.approvedAt > release.createdAt ||
        approval.validUntil <= release.createdAt ||
        validation.snapshotReference !== release.snapshotReference ||
        validation.snapshotDigest !== digest ||
        !sameScope(validation.scope) ||
        validation.checkedAt > release.createdAt ||
        validation.validUntil <= release.createdAt
      )
        return fail();
      return Object.freeze({ version, content, contentDigest: digest, release, observedAt: at });
    } catch {
      return fail();
    }
  };
}

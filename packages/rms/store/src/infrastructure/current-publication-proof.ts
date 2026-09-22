import {
  createPostgresPublishingMutationStore,
  createPostgresCurrentLiveGateSource,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
} from "@bop/publishing";
import { parseCanonicalInstant, parseBrandReference, parseStoreReference } from "@bop/tenant";
import { createPostgresStorePublicationContentSource } from "./persistence/publication-content-source.js";
import {
  createStoreConfigurationVersion,
  validateStoreConfigurationForPublication,
  type StoreConfigurationVersion,
} from "../contracts/store-configuration-administration.js";
type ContentOptions = Parameters<typeof createPostgresStorePublicationContentSource>[0];
type Transaction = Parameters<ReturnType<typeof createPostgresStorePublicationContentSource>>[0];

type AuthorityOptions = Omit<ContentOptions, "configurationReference"> & {
  readonly tenantReference: string;
  readonly configurationType: string;
  readonly purposeCode: string;
  readonly requiredLiveGateRequirementCodes: readonly string[];
};
/** Current public-owner authority for a candidate before Store snapshot insertion.
 * Caller keeps this transaction and its authorization fences through materialization
 * and Audit. Does not require or read a preexisting Store snapshot.
 */
export function createPostgresStorePublicationAuthorization(
  options: AuthorityOptions & { readonly publishingFamilyReference: string },
) {
  const tenant = parsePublishingReference(options.tenantReference);
  const configurationType = parsePublishingCode(options.configurationType);
  const purposeCode = parsePublishingCode(options.purposeCode);
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: parseStoreReference(options.storeReference),
  });
  return async (tx: Transaction, configurationInput: StoreConfigurationVersion, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      const configuration = createStoreConfigurationVersion(configurationInput);
      validateStoreConfigurationForPublication(configuration);
      const contentDigest = options.hashContent(configuration);
      if (
        configuration.lifecycle !== "Published" ||
        configuration.brandReference !== scope.brandReference ||
        configuration.storeReference !== scope.storeReference ||
        configuration.createdAt > at ||
        configuration.updatedAt > at ||
        !/^sha256:[0-9a-f]{64}$/u.test(contentDigest)
      )
        throw new Error();
      const publishing = createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        scope,
      );
      const current = await publishing.resolveCurrentRelease({
        familyReference: parsePublishingReference(options.publishingFamilyReference),
        configurationType,
        purposeCode,
        observedAt: at,
      });
      const { release, approvalEvidence: approval, validationEvidence: validation } = current;
      const sameScope = (value: typeof scope) =>
        value.kind === "Store" &&
        value.brandReference === scope.brandReference &&
        value.storeReference === scope.storeReference;
      if (
        String(release.releaseId) !== configuration.publicationReference ||
        String(release.snapshotReference) !== configuration.configurationReference ||
        String(release.snapshotDigest) !== contentDigest ||
        !sameScope(release.scope) ||
        String(approval.evidenceReference) !== configuration.approvalEvidenceReference ||
        String(approval.approvedActorReference) !== configuration.approvedByReference ||
        approval.reviewLifecycleId !== release.sourceLifecycleId ||
        approval.snapshotReference !== release.snapshotReference ||
        approval.snapshotDigest !== release.snapshotDigest ||
        !sameScope(approval.scope) ||
        approval.approvedAt > release.createdAt ||
        approval.validUntil <= release.createdAt ||
        validation.snapshotReference !== release.snapshotReference ||
        validation.snapshotDigest !== release.snapshotDigest ||
        !sameScope(validation.scope) ||
        validation.checkedAt > release.createdAt ||
        validation.validUntil <= release.createdAt ||
        release.createdAt > at
      )
        throw new Error();
      await createPostgresCurrentLiveGateSource({
        tenantReference: tenant,
        brandReference: scope.brandReference,
        storeReference: options.storeReference,
        decisionEvidenceReference: configuration.liveGateEvidenceReference ?? "",
        requiredRequirementCodes: options.requiredLiveGateRequirementCodes,
        authorize: options.authorize,
      })(tx, at);
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      return Object.freeze({ configuration, contentDigest, release, observedAt: at });
    } catch {
      throw new Error("STORE_CURRENT_PUBLICATION_UNAVAILABLE");
    }
  };
}

/** Tenant/Brand association and purpose authorization must be fenced by authorize.
 * Live Gate remains independent from Publishing success.
 */
export function createPostgresCurrentStorePublicationProof(
  options: AuthorityOptions & { readonly configurationReference: string },
) {
  const readContent = createPostgresStorePublicationContentSource(options);
  return async (tx: Transaction, now: string) => {
    try {
      const at = parseCanonicalInstant(now);
      const binding = await readContent(tx, at);
      if (
        binding.configurationType !== options.configurationType ||
        binding.purposeCode !== options.purposeCode
      )
        throw new Error();
      const authority = await createPostgresStorePublicationAuthorization({
        ...options,
        publishingFamilyReference: binding.familyReference,
      })(tx, binding.configuration, at);
      if (authority.contentDigest !== binding.contentDigest) throw new Error();
      return Object.freeze({ ...binding, release: authority.release, observedAt: at });
    } catch {
      throw new Error("STORE_CURRENT_PUBLICATION_UNAVAILABLE");
    }
  };
}

/** Bind an Approved Store candidate to the exact planned Published snapshot reviewed
 * by Publishing. The trusted caller supplies that snapshot, retains this transaction,
 * and still obtains current release/Live Gate authority before publication.
 */
export function createPostgresStoreApprovalAuthorization(
  options: Omit<AuthorityOptions, "requiredLiveGateRequirementCodes"> & {
    readonly publishingFamilyReference: string;
  },
) {
  const tenant = parsePublishingReference(options.tenantReference);
  const family = parsePublishingReference(options.publishingFamilyReference);
  const configurationType = parsePublishingCode(options.configurationType);
  const purposeCode = parsePublishingCode(options.purposeCode);
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: parseStoreReference(options.storeReference),
  });
  return async (
    tx: Transaction,
    input: {
      readonly configuration: StoreConfigurationVersion;
      readonly reviewedPublication: StoreConfigurationVersion;
      readonly lifecycleReference: string;
    },
    now: string,
  ) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      const candidate = createStoreConfigurationVersion(input.configuration);
      const reviewed = createStoreConfigurationVersion(input.reviewedPublication);
      validateStoreConfigurationForPublication(reviewed);
      // Only publication metadata may differ from the Approved candidate.
      const projected = createStoreConfigurationVersion({
        ...candidate,
        lifecycle: "Published",
        publicationReference: reviewed.publicationReference,
        liveGateEvidenceReference: reviewed.liveGateEvidenceReference,
        updatedAt: reviewed.updatedAt,
      });
      const digest = options.hashContent(reviewed);
      if (
        candidate.lifecycle !== "Approved" ||
        candidate.brandReference !== scope.brandReference ||
        candidate.storeReference !== scope.storeReference ||
        candidate.updatedAt > at ||
        reviewed.updatedAt < candidate.updatedAt ||
        reviewed.updatedAt > at ||
        !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
        options.hashContent(projected) !== digest
      )
        throw new Error();
      const current = await createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        scope,
      ).resolveCurrentApproval({
        familyReference: family,
        lifecycleReference: parsePublishingReference(input.lifecycleReference),
        configurationType,
        purposeCode,
        observedAt: at,
      });
      const approval = current.approvalEvidence;
      if (
        String(approval.snapshotReference) !== candidate.configurationReference ||
        String(approval.snapshotDigest) !== digest ||
        String(approval.evidenceReference) !== candidate.approvalEvidenceReference ||
        String(approval.approvedActorReference) !== candidate.approvedByReference ||
        approval.approvedAt > candidate.updatedAt
      )
        throw new Error();
      if ((await options.authorize(tx, at)) !== true) throw new Error();
      return Object.freeze({
        configuration: candidate,
        reviewedPublication: reviewed,
        contentDigest: digest,
        approvalEvidence: approval,
        observedAt: at,
      });
    } catch {
      throw new Error("STORE_CURRENT_APPROVAL_UNAVAILABLE");
    }
  };
}

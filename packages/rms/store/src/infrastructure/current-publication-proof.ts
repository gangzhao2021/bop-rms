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
  /** Fixed server validation inventory; mandatory only for the V2 path. */
  readonly requiredValidationCheckCodes?: readonly string[];
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
      if (configuration.setupBasis !== undefined) {
        // V2's semantic digest deliberately excludes these mutable lifecycle facts.
        // Verify them against the actual release/evidence instead of the digest.
        if (
          configuration.setupBasis.tenantReference !== tenant ||
          String(configuration.authoredByReference) === String(approval.approvedActorReference) ||
          current.lifecycle.state !== "Published" ||
          current.lifecycle.lifecycleId !== release.sourceLifecycleId ||
          current.lifecycle.snapshotReference !== release.snapshotReference ||
          current.lifecycle.snapshotDigest !== contentDigest ||
          current.lifecycle.validationEvidenceReference !== validation.evidenceReference ||
          current.lifecycle.approvalEvidenceReference !== approval.evidenceReference ||
          current.lifecycle.familyReference !== release.familyReference ||
          current.lifecycle.configurationType !== configurationType ||
          current.lifecycle.purposeCode !== purposeCode ||
          !sameScope(current.lifecycle.scope) ||
          current.lifecycle.changedAt !== release.createdAt ||
          String(release.createdAt) !== String(configuration.updatedAt) ||
          String(approval.approvedAt) < String(configuration.createdAt) ||
          String(validation.checkedAt) < String(configuration.createdAt)
        )
          throw new Error();
        const reviewCodes = () => {
          const descriptor = Object.getOwnPropertyDescriptor(
            options,
            "requiredValidationCheckCodes",
          );
          const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
          if (
            !descriptor?.enumerable ||
            !Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Array.prototype ||
            value.length < 1 ||
            value.length > 32 ||
            Reflect.ownKeys(value).length !== value.length + 1
          )
            throw new Error();
          const codes = Array.from({ length: value.length }, (_, index) => {
            const item = Object.getOwnPropertyDescriptor(value, String(index));
            if (!item?.enumerable || !("value" in item)) throw new Error();
            return parsePublishingCode(item.value);
          }).sort();
          if (new Set(codes).size !== codes.length) throw new Error();
          return codes;
        };
        const requiredCheckCodes = reviewCodes();
        const ordered = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(ordered)
            : value !== null && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .sort(([left], [right]) => left.localeCompare(right, "en"))
                    .map(([key, item]) => [key, ordered(item)]),
                )
              : value;
        const original = await publishing.resolveCurrentReleaseIndependentApproval({
          familyReference: release.familyReference,
          lifecycleReference: release.sourceLifecycleId,
          configurationType,
          purposeCode,
          snapshotReference: release.snapshotReference,
          snapshotDigest: contentDigest,
          requiredCheckCodes,
          observedAt: at,
        });
        if (
          original.tenantReference !== tenant ||
          !sameScope(original.scope) ||
          original.familyReference !== release.familyReference ||
          original.lifecycleReference !== release.sourceLifecycleId ||
          original.configurationType !== configurationType ||
          original.purposeCode !== purposeCode ||
          String(original.snapshotReference) !== String(configuration.configurationReference) ||
          original.snapshotDigest !== contentDigest ||
          String(original.observedAt) !== String(at) ||
          String(original.approvedByActorReference) !== String(configuration.approvedByReference) ||
          original.requestedByActorReference === original.approvedByActorReference ||
          original.authoredByActorReference === original.approvedByActorReference ||
          String(configuration.authoredByReference) === original.approvedByActorReference ||
          String(original.approvalEvidenceReference) !==
            String(configuration.approvalEvidenceReference) ||
          original.validationEvidenceReference !== validation.evidenceReference ||
          original.reviewVersion !== approval.reviewVersion ||
          original.approvedLifecycleVersion !== original.reviewVersion + 1 ||
          current.lifecycle.version !== original.approvedLifecycleVersion + 1 ||
          original.recordedIndependence !== "Verified" ||
          JSON.stringify(original.validationCheckCodes) !== JSON.stringify(requiredCheckCodes) ||
          JSON.stringify(reviewCodes()) !== JSON.stringify(requiredCheckCodes) ||
          JSON.stringify(ordered(original.currentRelease)) !== JSON.stringify(ordered(current))
        )
          throw new Error();
      }
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

/** V2 approval binds semantic content to the real current independent review. It
 * does not need a future Published envelope or the legacy review-snapshot table. */
export function createPostgresStoreV2ApprovalAuthorization(
  options: Omit<AuthorityOptions, "requiredLiveGateRequirementCodes"> & {
    readonly publishingFamilyReference: string;
  },
) {
  const authorize = options.authorize,
    hashContent = options.hashContent;
  const tenant = parsePublishingReference(options.tenantReference),
    family = parsePublishingReference(options.publishingFamilyReference),
    configurationType = parsePublishingCode(options.configurationType),
    purposeCode = parsePublishingCode(options.purposeCode),
    scope = createPublishingScope({
      kind: "Store",
      brandReference: parseBrandReference(options.brandReference),
      storeReference: parseStoreReference(options.storeReference),
    });
  return async (tx: Transaction, value: StoreConfigurationVersion, now: string) => {
    try {
      const at = parseCanonicalInstant(now),
        candidate = createStoreConfigurationVersion(value);
      if (
        options.authorize !== authorize ||
        options.hashContent !== hashContent ||
        (await authorize(tx, at)) !== true
      )
        throw new Error();
      const raw = Object.getOwnPropertyDescriptor(options, "requiredValidationCheckCodes");
      if (
        !raw?.enumerable ||
        !("value" in raw) ||
        !Array.isArray(raw.value) ||
        raw.value.length < 1 ||
        raw.value.length > 32 ||
        Reflect.ownKeys(raw.value).length !== raw.value.length + 1
      )
        throw new Error();
      const codes = Array.from({ length: raw.value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(raw.value, String(i));
        if (!d?.enumerable || !("value" in d)) throw new Error();
        return parsePublishingCode(d.value);
      }).sort();
      const digest = options.hashContent(candidate);
      if (
        String(candidate.setupBasis?.tenantReference) !== String(tenant) ||
        candidate.lifecycle !== "Approved" ||
        candidate.brandReference !== scope.brandReference ||
        candidate.storeReference !== scope.storeReference ||
        candidate.updatedAt > at ||
        candidate.approvedByReference === candidate.authoredByReference ||
        new Set(codes).size !== codes.length ||
        !/^sha256:[0-9a-f]{64}$/u.test(digest)
      )
        throw new Error();
      const owner = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          tenant,
          scope,
        ),
        query = {
          familyReference: family,
          lifecycleReference: parsePublishingReference(candidate.configurationReference),
          configurationType,
          purposeCode,
          observedAt: at,
        },
        current = await owner.resolvePublicationCandidate(query),
        independent = await owner.resolveCurrentIndependentApproval({
          ...query,
          snapshotReference: candidate.configurationReference,
          snapshotDigest: digest,
          requiredCheckCodes: codes,
        }),
        approval = current.approvalEvidence,
        validation = current.validationEvidence,
        head = current.lifecycle;
      if (
        independent.profile !== "CurrentIndependentPublishingApprovalV1" ||
        independent.scope.kind !== scope.kind ||
        independent.scope.brandReference !== scope.brandReference ||
        independent.scope.storeReference !== scope.storeReference ||
        independent.familyReference !== family ||
        independent.lifecycleReference !== head.lifecycleId ||
        independent.configurationType !== configurationType ||
        independent.purposeCode !== purposeCode ||
        String(independent.snapshotReference) !== String(candidate.configurationReference) ||
        String(independent.observedAt) !== String(at) ||
        String(validation.checkedAt) < String(candidate.createdAt) ||
        String(approval.approvedAt) < String(candidate.createdAt) ||
        head.familyReference !== family ||
        head.configurationType !== configurationType ||
        head.purposeCode !== purposeCode ||
        head.scope.kind !== scope.kind ||
        head.scope.brandReference !== scope.brandReference ||
        head.scope.storeReference !== scope.storeReference ||
        head.state !== "Approved" ||
        String(head.snapshotReference) !== String(candidate.configurationReference) ||
        head.snapshotDigest !== digest ||
        String(head.lifecycleId) !== String(candidate.configurationReference) ||
        head.approvalEvidenceReference !== approval.evidenceReference ||
        head.validationEvidenceReference !== validation.evidenceReference ||
        String(head.changedAt) !== String(candidate.updatedAt) ||
        String(approval.approvedAt) !== String(candidate.updatedAt) ||
        String(approval.approvedActorReference) !== String(candidate.approvedByReference) ||
        String(approval.evidenceReference) !== String(candidate.approvalEvidenceReference) ||
        approval.reviewLifecycleId !== head.lifecycleId ||
        approval.reviewVersion + 1 !== head.version ||
        approval.validUntil > validation.validUntil ||
        independent.tenantReference !== tenant ||
        independent.approvedLifecycleVersion !== head.version ||
        independent.reviewVersion !== approval.reviewVersion ||
        independent.approvalEvidenceReference !== approval.evidenceReference ||
        independent.validationEvidenceReference !== validation.evidenceReference ||
        independent.approvedByActorReference !== approval.approvedActorReference ||
        independent.requestedByActorReference === approval.approvedActorReference ||
        independent.recordedIndependence !== "Verified" ||
        independent.snapshotDigest !== digest ||
        JSON.stringify(independent.validationCheckCodes) !== JSON.stringify(codes)
      )
        throw new Error();
      if (
        options.authorize !== authorize ||
        options.hashContent !== hashContent ||
        (await authorize(tx, at)) !== true ||
        options.hashContent(candidate) !== digest
      )
        throw new Error();
      const endCodes = Object.getOwnPropertyDescriptor(options, "requiredValidationCheckCodes");
      if (
        !endCodes ||
        !("value" in endCodes) ||
        endCodes.value !== raw.value ||
        JSON.stringify(
          Array.from({ length: raw.value.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(raw.value, String(i));
            if (!d?.enumerable || !("value" in d)) throw new Error();
            return parsePublishingCode(d.value);
          }).sort(),
        ) !== JSON.stringify(codes)
      )
        throw new Error();
      return Object.freeze({
        configuration: candidate,
        contentDigest: digest,
        approvalEvidence: approval,
        observedAt: at,
      });
    } catch {
      throw new Error("STORE_CURRENT_APPROVAL_UNAVAILABLE");
    }
  };
}

import { validatePublicStoreProfileEffectiveBinding } from "../application/public-store-profile-service.js";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingReleaseRecord,
  parsePublishingReference,
} from "@bop/publishing";
import { parseCanonicalInstant, parseBrandReference, parseStoreReference } from "@bop/tenant";
import {
  parsePublicStoreProfileCandidateShape,
  type PublicStoreProfileCandidate,
} from "../contracts/public-store-profile.js";
type StoreOptions = Parameters<
  typeof import("./persistence/public-store-profile-store.js").createPostgresPublicStoreProfileStore
>[0];
type Transaction = Parameters<StoreOptions["verifyCurrent"]>[0];
export type PublicStoreProfileContent = Omit<
  PublicStoreProfileCandidate,
  "contentDigest" | "publishingLifecycle" | "publishingRelease" | "effectiveVersion"
>;
/** These exact fields are the publication content. Current authority metadata
 * is independently verified and cannot authenticate changed display content. */
export function publicStoreProfileContent(
  value: PublicStoreProfileCandidate,
): PublicStoreProfileContent {
  const profile = parsePublicStoreProfileCandidateShape(value);
  return {
    profileReference: profile.profileReference,
    profileVersion: profile.profileVersion,
    brandReference: profile.brandReference,
    storeReference: profile.storeReference,
    classification: profile.classification,
    defaultLocale: profile.defaultLocale,
    supportedLocales: profile.supportedLocales,
    localizedFields: profile.localizedFields,
    currencyCode: profile.currencyCode,
    timeZone: profile.timeZone,
    address: profile.address,
    businessPhone: profile.businessPhone,
    website: profile.website,
    logo: profile.logo,
  };
}
/** No SQL outside public owners. All authority callbacks must retain their
 * current-source fences in this same transaction until the caller completes. */
export function createPostgresPublicStoreProfileAuthority(options: {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  authorize: StoreOptions["authorize"];
  hashContent(content: PublicStoreProfileContent): string;
  verifyEffective(
    tx: Transaction,
    profile: PublicStoreProfileCandidate,
    at: string,
  ): Promise<boolean>;
  verifyMedia(tx: Transaction, profile: PublicStoreProfileCandidate, at: string): Promise<boolean>;
}): StoreOptions["verifyCurrent"] {
  const tenant = parsePublishingReference(options.tenantReference);
  const scope = createPublishingScope({
    kind: "Store",
    brandReference: parseBrandReference(options.brandReference),
    storeReference: parseStoreReference(options.storeReference),
  });
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  return async (tx, value, now) => {
    try {
      const at = parseCanonicalInstant(now);
      if ((await options.authorize(tx, at)) !== true) return false;
      const profile = parsePublicStoreProfileCandidateShape(value);
      if (
        profile.brandReference !== scope.brandReference ||
        profile.storeReference !== scope.storeReference
      )
        return false;
      const lifecycle = createPublishingLifecycleRecord(profile.publishingLifecycle);
      const release = createPublishingReleaseRecord(profile.publishingRelease);
      const digest = options.hashContent(publicStoreProfileContent(profile));
      if (
        lifecycle.state !== "Published" ||
        lifecycle.configurationType !== "STORE_PROFILE" ||
        lifecycle.purposeCode !== "CUSTOMER_ENTRY" ||
        !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
        digest !== profile.contentDigest ||
        lifecycle.snapshotDigest !== digest ||
        release.snapshotDigest !== digest ||
        String(lifecycle.snapshotReference) !== profile.profileReference ||
        String(release.snapshotReference) !== profile.profileReference
      )
        return false;
      const current = await createPostgresPublishingMutationStore(
        { run: async (work) => work(tx) },
        tenant,
        scope,
      ).resolveCurrentRelease({
        familyReference: lifecycle.familyReference,
        configurationType: "STORE_PROFILE",
        purposeCode: "CUSTOMER_ENTRY",
        observedAt: at,
      });
      if (
        !equal(createPublishingLifecycleRecord(current.lifecycle), lifecycle) ||
        !equal(createPublishingReleaseRecord(current.release), release)
      )
        return false;
      const boundProfile = validatePublicStoreProfileEffectiveBinding(
        profile,
        {
          brandReference: profile.brandReference,
          storeReference: profile.storeReference,
        },
        at,
      );
      if ((await options.verifyEffective(tx, boundProfile, at)) !== true) return false;
      if (profile.logo !== null && (await options.verifyMedia(tx, profile, at)) !== true)
        return false;
      return (await options.authorize(tx, at)) === true;
    } catch {
      return false;
    }
  };
}

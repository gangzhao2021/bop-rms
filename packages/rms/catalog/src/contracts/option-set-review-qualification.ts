import { canonicalizeRfc8785 } from "@bop/audit";
import { CatalogError } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseCatalogOptionSetReviewRecord,
  parseCatalogOptionSetStoredReviewBinding,
} from "./option-set-review-record.js";
import { parseCatalogOptionSetContentPolicyBinding } from "./option-set-content-policy.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Pure timing and exact reviewed-target comparison. Neither argument proves
 * acquisition, current authorization, policy authority or publication eligibility. */
export function prepareCatalogOptionSetRecordedReviewQualification(
  recordValue: unknown,
  freshValue: unknown,
) {
  const record = parseCatalogOptionSetReviewRecord(recordValue),
    value = copyCategoryPersistenceValue(freshValue);
  const keys = [
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "originalIntentDigest",
    "observedAt",
    "validUntil",
  ] as const;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    return fail();
  const fresh = value as Record<string, unknown>;
  const candidate = parseCatalogOptionSetContentPolicyBinding({
    ...fresh,
    activationAt: fresh.observedAt,
  });
  const identityKeys = [
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
  ] as const;
  if (
    Date.parse(candidate.validUntil) - Date.parse(candidate.observedAt) > 5000 ||
    record.recordedAt > candidate.observedAt ||
    identityKeys.some((k) => !same(candidate[k], record.binding[k]))
  )
    return fail();
  const qualifiedActivationAt =
    record.binding.activationAt < candidate.observedAt
      ? candidate.observedAt
      : record.binding.activationAt;
  const qualificationBinding = parseCatalogOptionSetContentPolicyBinding({
    ...candidate,
    activationAt: qualifiedActivationAt,
  });
  return Object.freeze({
    recordedReview: record,
    reviewBinding: record.binding,
    qualificationBinding,
    qualifiedActivationAt,
  });
}
/** The current held draft/source and policy must still target precisely the
 * immutable original Review. The fresh action intent and assessment time differ. */
export function assertCatalogOptionSetRecordedReviewQualification(
  recordValue: unknown,
  qualificationValue: unknown,
  currentTargetValue: unknown,
  sourceOperationReference: string,
  contentValue: unknown,
) {
  const record = parseCatalogOptionSetReviewRecord(recordValue),
    qualification = parseCatalogOptionSetContentPolicyBinding(qualificationValue),
    current = parseCatalogOptionSetStoredReviewBinding(currentTargetValue);
  const { activationAt: ignoredActivation, ...fresh } = qualification;
  void ignoredActivation;
  const prepared = prepareCatalogOptionSetRecordedReviewQualification(record, fresh);
  if (
    !same(prepared.qualificationBinding, qualification) ||
    sourceOperationReference !== record.sourceOperationReference ||
    !same(contentValue, record.content) ||
    current.activationAt !== prepared.qualifiedActivationAt ||
    current.originalIntentDigest !== qualification.originalIntentDigest
  )
    return fail();
  const keys = [
    "profile",
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "policyReference",
    "policyVersion",
    "policyContentDigest",
    "currentPolicyPublicationReference",
  ] as const;
  if (keys.some((key) => !same(current[key], record.binding[key]))) return fail();
  return prepared;
}

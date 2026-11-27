import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseOptionSetAggregate, type OptionSetAggregate } from "./option-set.js";
import { planOptionSetPublicationSuccessor } from "../domain/option-set-publication-successor.js";

export interface CatalogOptionSetPublicationContent {
  readonly profile: "CatalogSupportedOptionSetDraftContentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly sourceAggregateVersion: number;
  readonly publicationOperationReference: string;
  readonly publicationIntentDigest: string;
  readonly successorDraftVersionReference: string;
  readonly sealedAt: string;
  readonly sourceDigest: string;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly sourceAggregate: OptionSetAggregate;
  readonly eligibility: "NotEvaluated";
  readonly digest: string;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key)))
    return fail();
  return r;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) return fail();
  return value;
}
function source(value: unknown, allowFinalDraftRevision = false): OptionSetAggregate {
  const parsed = parseOptionSetAggregate(copyCategoryPersistenceValue(value));
  if (
    parsed.lifecycle !== "Draft" ||
    parsed.aggregateVersion > 2147483647 ||
    (!allowFinalDraftRevision && parsed.aggregateVersion === 2147483647) ||
    parsed.draft.options.length > 100 ||
    new Set(parsed.draft.options.map((option) => option.optionReference)).size !==
      parsed.draft.options.length ||
    parsed.draft.createdAt < parsed.createdAt ||
    parsed.draft.updatedAt > parsed.updatedAt ||
    parsed.draft.options.some(
      (option) => option.createdAt < parsed.createdAt || option.createdAt > parsed.updatedAt,
    )
  )
    return fail();
  return parsed;
}
/** Supported Draft identity only; current source and publication validation are
 * separately required. No missing full Option fields or authority are synthesized. */
export function deriveCatalogOptionSetPublicationContentIdentity(sourceValue: unknown) {
  return supportedIdentity(source(sourceValue));
}
/** Read/preparation may retain the final valid Draft revision. Publication keeps
 * its separate exhaustion guard and cannot produce a revision beyond int32. */
export function deriveCatalogOptionSetSupportedContentIdentity(sourceValue: unknown) {
  return supportedIdentity(source(sourceValue, true));
}
function supportedIdentity(aggregate: OptionSetAggregate) {
  const draft = aggregate.draft;
  const configuration = Object.freeze({
    versionReference: draft.versionReference,
    displayStyle: draft.displayStyle,
    minimumSelection: draft.minimumSelection,
    maximumSelection: draft.maximumSelection,
    allowRepeatedOption: draft.allowRepeatedOption,
    perOptionMaximumQuantity: draft.perOptionMaximumQuantity,
    maximumTotalQuantity: draft.maximumTotalQuantity,
    options: draft.options.map((option) => ({
      optionReference: option.optionReference,
      stableCode: option.stableCode,
      lifecycle: option.lifecycle,
      sortOrder: option.sortOrder,
      defaultEligible: option.defaultEligible,
      triggeredOptionSetReference: option.triggeredOptionSetReference,
      conflictOptionReferences: option.conflictOptionReferences,
    })),
  });
  return Object.freeze({
    sourceDigest: hash(aggregate),
    contentDigest: hash(draft),
    configurationDigest: hash(configuration),
  });
}

/** Immutable stored-content recovery. It verifies provenance and every supported
 * field, but a valid shape does not prove a committed operation or current eligibility. */
function parseContent(
  value: unknown,
  verifyRecordDigest: boolean,
): CatalogOptionSetPublicationContent {
  const r = closed(copyCategoryPersistenceValue(value), [
      "profile",
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "versionReference",
      "sourceAggregateVersion",
      "publicationOperationReference",
      "publicationIntentDigest",
      "successorDraftVersionReference",
      "sealedAt",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "sourceAggregate",
      "eligibility",
      "digest",
    ]),
    aggregate = source(r.sourceAggregate),
    identity = deriveCatalogOptionSetPublicationContentIdentity(aggregate),
    sealedAt = parseCatalogInstant(r.sealedAt),
    tenantReference = parseCatalogReference(r.tenantReference),
    brandReference = parseCatalogReference(r.brandReference),
    optionSetReference = parseCatalogReference(r.optionSetReference),
    versionReference = parseCatalogReference(r.versionReference),
    successorDraftVersionReference = parseCatalogReference(r.successorDraftVersionReference);
  if (
    r.profile !== "CatalogSupportedOptionSetDraftContentV1" ||
    r.eligibility !== "NotEvaluated" ||
    brandReference !== aggregate.brandReference ||
    optionSetReference !== aggregate.optionSetReference ||
    versionReference !== aggregate.draft.versionReference ||
    r.sourceAggregateVersion !== aggregate.aggregateVersion ||
    sealedAt < aggregate.updatedAt ||
    r.sourceDigest !== identity.sourceDigest ||
    r.contentDigest !== identity.contentDigest ||
    r.configurationDigest !== identity.configurationDigest
  )
    return fail();
  const content = Object.freeze({
    profile: "CatalogSupportedOptionSetDraftContentV1" as const,
    tenantReference,
    brandReference,
    optionSetReference,
    versionReference,
    sourceAggregateVersion: aggregate.aggregateVersion,
    publicationOperationReference: parseCatalogReference(r.publicationOperationReference),
    publicationIntentDigest: digest(r.publicationIntentDigest),
    successorDraftVersionReference,
    sealedAt,
    ...identity,
    sourceAggregate: aggregate,
    eligibility: "NotEvaluated" as const,
  });
  planOptionSetPublicationSuccessor(aggregate, content);
  const recordDigest = hash(content);
  if (verifyRecordDigest && r.digest !== recordDigest) return fail();
  return Object.freeze({ ...content, digest: recordDigest });
}

export function parseCatalogOptionSetPublicationContent(
  value: unknown,
): CatalogOptionSetPublicationContent {
  return parseContent(value, true);
}

/** Owning preparation only, after held current validation/authority. Persist both
 * results in one CAS/Audit/Outbox transaction; this function commits nothing. */
export function createCatalogOptionSetPublicationMaterialization(
  sourceValue: unknown,
  transitionValue: unknown,
): Readonly<{
  content: CatalogOptionSetPublicationContent;
  successor: OptionSetAggregate;
}> {
  const aggregate = source(sourceValue),
    r = closed(copyCategoryPersistenceValue(transitionValue), [
      "tenantReference",
      "brandReference",
      "optionSetReference",
      "versionReference",
      "sourceAggregateVersion",
      "publicationOperationReference",
      "publicationIntentDigest",
      "successorDraftVersionReference",
      "sealedAt",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
    ]);
  const content = parseContent(
    {
      ...r,
      profile: "CatalogSupportedOptionSetDraftContentV1",
      sourceAggregate: aggregate,
      eligibility: "NotEvaluated",
      digest: null,
    },
    false,
  );
  const successor = parseOptionSetAggregate(planOptionSetPublicationSuccessor(aggregate, content));
  return Object.freeze({ content, successor });
}

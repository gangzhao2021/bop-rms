import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import {
  parseProductPublicationVersion,
  productPublicationActions,
  type ProductPublicationAction,
  type ProductPublicationVersion,
} from "./product-publication.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationVersionV2,
} from "./product-publication-v2.js";
import {
  parseCatalogProductScopeReplacementIntent,
  type CatalogProductScopeReplacementIntent,
} from "./product-scope-replacement-intent.js";

export interface CatalogProductExactStoreSelectorRetirement {
  readonly profile: "CatalogProductExactStoreSelectorRetirementV1";
  readonly replacementIntent: CatalogProductScopeReplacementIntent;
  readonly previousPublicationDigest: string;
  readonly retiredAt: string;
  readonly digest: string;
}
export interface CatalogProductScopeRetirementHeader {
  readonly profile: "CatalogProductScopeRetirementHeaderV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly versionReference: string;
  readonly publicationVersion: number;
  readonly publicationAction: ProductPublicationAction;
  readonly sourceAggregateVersion: number;
  readonly resultAggregateVersion: number;
  readonly publicationIntentDigest: string;
  readonly publicationSnapshotDigest: string;
  readonly observedSourceRevision: string;
  readonly observedSourceHeadDigest: string;
  readonly recordedAt: string;
  readonly retirements: readonly CatalogProductExactStoreSelectorRetirement[];
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
    return fail();
  return value as number;
}
function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
function action(value: unknown): ProductPublicationAction {
  if (
    !productPublicationActions.includes(value as ProductPublicationAction) ||
    value === "Supersede"
  )
    return fail();
  return value as ProductPublicationAction;
}
const publishes = (value: ProductPublicationAction) =>
  value === "Publish" || value === "ActivateScheduled";
function retirement(value: unknown): CatalogProductExactStoreSelectorRetirement {
  const r = record(value, [
    "profile",
    "replacementIntent",
    "previousPublicationDigest",
    "retiredAt",
    "digest",
  ]);
  if (r.profile !== "CatalogProductExactStoreSelectorRetirementV1") return fail();
  const body = {
    profile: "CatalogProductExactStoreSelectorRetirementV1" as const,
    replacementIntent: parseCatalogProductScopeReplacementIntent(r.replacementIntent),
    previousPublicationDigest: digest(r.previousPublicationDigest),
    retiredAt: parseCatalogInstant(r.retiredAt),
  };
  if (digest(r.digest) !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
/** Closed immutable record only. Publishing permits zero or one row here; the
 * complete publication binder must prove the intent-specific cardinality. */
export function parseCatalogProductScopeRetirementHeader(
  value: unknown,
): CatalogProductScopeRetirementHeader {
  const r = record(copyCategoryPersistenceValue(value), [
    "profile",
    "tenantReference",
    "brandReference",
    "productReference",
    "operationReference",
    "versionReference",
    "publicationVersion",
    "publicationAction",
    "sourceAggregateVersion",
    "resultAggregateVersion",
    "publicationIntentDigest",
    "publicationSnapshotDigest",
    "observedSourceRevision",
    "observedSourceHeadDigest",
    "recordedAt",
    "retirements",
    "digest",
  ]);
  if (
    r.profile !== "CatalogProductScopeRetirementHeaderV1" ||
    !Array.isArray(r.retirements) ||
    r.retirements.length > 1
  )
    return fail();
  const publicationAction = action(r.publicationAction),
    sourceAggregateVersion = integer(r.sourceAggregateVersion),
    resultAggregateVersion = integer(r.resultAggregateVersion),
    recordedAt = parseCatalogInstant(r.recordedAt),
    retirements = Object.freeze(r.retirements.map(retirement));
  if (
    resultAggregateVersion !== sourceAggregateVersion + 1 ||
    (!publishes(publicationAction) && retirements.length !== 0) ||
    retirements.some((row) => row.retiredAt !== recordedAt)
  )
    return fail();
  const body = {
    profile: "CatalogProductScopeRetirementHeaderV1" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    productReference: parseCatalogReference(r.productReference),
    operationReference: parseCatalogReference(r.operationReference),
    versionReference: parseCatalogReference(r.versionReference),
    publicationVersion: integer(r.publicationVersion),
    publicationAction,
    sourceAggregateVersion,
    resultAggregateVersion,
    publicationIntentDigest: digest(r.publicationIntentDigest),
    publicationSnapshotDigest: digest(r.publicationSnapshotDigest),
    observedSourceRevision: revision(r.observedSourceRevision),
    observedSourceHeadDigest: digest(r.observedSourceHeadDigest),
    recordedAt,
    retirements,
  };
  if (digest(r.digest) !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
function active(publication: Omit<ProductPublicationVersion, "validationDecision">, at: string) {
  return (
    publication.state === "Published" &&
    publication.publishedAt !== null &&
    publication.publishedAt <= at &&
    publication.effectivePeriod.effectiveFrom.instant <= at &&
    (publication.effectivePeriod.effectiveUntil === null ||
      at < publication.effectivePeriod.effectiveUntil.instant)
  );
}
function publishedTuple(
  previousValue: unknown,
  incoming: ProductPublicationVersionV2,
): ProductPublicationVersion | ProductPublicationVersionV2 {
  const safe = copyCategoryPersistenceValue(previousValue);
  const previous =
    safe && typeof safe === "object" && !Array.isArray(safe) && Object.hasOwn(safe, "profile")
      ? parseProductPublicationVersionV2(safe)
      : parseProductPublicationVersion(safe);
  const intent = incoming.replacementIntent;
  if (intent.mode !== "PermanentSelectorRetirement") return fail();
  const selector = previous.scopeSet[intent.previousSelectorIndex];
  if (
    !equal(previousValue, previous) ||
    !active(previous, incoming.occurredAt) ||
    !active(incoming, incoming.occurredAt) ||
    incoming.publishedAt !== incoming.occurredAt ||
    previous.tenantReference !== incoming.tenantReference ||
    previous.brandReference !== incoming.brandReference ||
    previous.productReference !== incoming.productReference ||
    previous.productAggregateVersion >= incoming.productAggregateVersion ||
    previous.occurredAt > incoming.occurredAt ||
    previous.versionReference !== intent.previousVersionReference ||
    previous.operationReference !== intent.previousPublicationOperationReference ||
    previous.publicationVersion !== intent.expectedPreviousPublicationVersion ||
    previous.intentDigest !== intent.previousIntentDigest ||
    previous.scopeDigest !== intent.previousScopeDigest ||
    previous.periodDigest !== intent.previousPeriodDigest ||
    previous.scopeSet.length < 1 ||
    previous.scopeSet.some((scope) => scope.level !== "Store") ||
    new Set(previous.scopeSet.map((scope) => scope.reference)).size !== previous.scopeSet.length ||
    !selector ||
    hash(selector) !== intent.previousSelectorDigest ||
    !equal(selector, incoming.scopeSet[0])
  )
    return fail();
  return previous;
}
function inputs(value: unknown) {
  const r = record(value, ["publicationAction", "publication", "previousPublication"]),
    publicationAction = action(r.publicationAction),
    publication = parseProductPublicationVersionV2(r.publication);
  const states: Record<
    Exclude<ProductPublicationAction, "Supersede">,
    ProductPublicationVersion["state"]
  > = {
    Validate: "Draft",
    SubmitReview: "InReview",
    Approve: "Approved",
    Reject: "Draft",
    SchedulePublish: "Scheduled",
    ReschedulePublish: "Scheduled",
    CancelScheduledPublish: "Draft",
    Publish: "Published",
    ActivateScheduled: "Published",
  };
  if (
    !equal(r.publication, publication) ||
    publication.state !==
      states[publicationAction as Exclude<ProductPublicationAction, "Supersede">] ||
    publication.actorKind !== (publicationAction === "ActivateScheduled" ? "System" : "User") ||
    (publicationAction === "ActivateScheduled" && publication.scheduleReference === null)
  )
    return fail();
  if (
    publishes(publicationAction) &&
    (!active(publication, publication.occurredAt) ||
      publication.publishedAt !== publication.occurredAt)
  )
    return fail();
  const replaces =
    publishes(publicationAction) &&
    publication.replacementIntent.mode === "PermanentSelectorRetirement";
  const previousPublication = replaces ? publishedTuple(r.previousPublication, publication) : null;
  if (!replaces && r.previousPublication !== null) return fail();
  return { publicationAction, publication, previousPublication };
}
export function buildCatalogProductScopeRetirementHeader(
  value: unknown,
): CatalogProductScopeRetirementHeader {
  const r = record(copyCategoryPersistenceValue(value), [
      "publicationAction",
      "publication",
      "previousPublication",
      "observedSourceRevision",
      "observedSourceHeadDigest",
    ]),
    {
      publicationAction,
      publication: p,
      previousPublication,
    } = inputs({
      publicationAction: r.publicationAction,
      publication: r.publication,
      previousPublication: r.previousPublication,
    });
  const row =
    previousPublication === null || p.replacementIntent.mode === "None"
      ? null
      : {
          profile: "CatalogProductExactStoreSelectorRetirementV1" as const,
          replacementIntent: p.replacementIntent,
          previousPublicationDigest: hash(previousPublication),
          retiredAt: p.occurredAt,
        };
  const body = {
    profile: "CatalogProductScopeRetirementHeaderV1" as const,
    tenantReference: p.tenantReference,
    brandReference: p.brandReference,
    productReference: p.productReference,
    operationReference: p.operationReference,
    versionReference: p.versionReference,
    publicationVersion: p.publicationVersion,
    publicationAction,
    sourceAggregateVersion: p.productAggregateVersion,
    resultAggregateVersion: p.productAggregateVersion + 1,
    publicationIntentDigest: p.intentDigest,
    publicationSnapshotDigest: hash(p),
    observedSourceRevision: revision(r.observedSourceRevision),
    observedSourceHeadDigest: digest(r.observedSourceHeadDigest),
    recordedAt: p.occurredAt,
    retirements: row === null ? [] : [{ ...row, digest: hash(row) }],
  };
  return parseCatalogProductScopeRetirementHeader({ ...body, digest: hash(body) });
}
/** Bind the actual immutable result and original canonical V1/V2 target, without manufacturing a command. */
export function bindCatalogProductScopeRetirementHeader(
  headerValue: unknown,
  value: unknown,
): CatalogProductScopeRetirementHeader {
  const header = parseCatalogProductScopeRetirementHeader(headerValue),
    r = record(copyCategoryPersistenceValue(value), [
      "publicationAction",
      "publication",
      "previousPublication",
    ]),
    rebuilt = buildCatalogProductScopeRetirementHeader({
      ...r,
      observedSourceRevision: header.observedSourceRevision,
      observedSourceHeadDigest: header.observedSourceHeadDigest,
    });
  if (!equal(header, rebuilt)) return fail();
  return header;
}

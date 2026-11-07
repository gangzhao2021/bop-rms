import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogHash, parseCatalogInstant } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationCommandV2,
  type ProductPublicationCommandV2,
} from "./product-publication-v2.js";
import { bindCatalogProductPublicationValidationContextV2 } from "./product-publication-validation-context-v2.js";

export interface CatalogProductPublicationReferenceRequestV2 {
  readonly profile: "CatalogProductPublicationReferenceRequestV2";
  readonly command: ProductPublicationCommandV2;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly currentPublicationDigest: string | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    // Context repeats the immutable Draft beside its aggregate; each owning
    // input retains its original parser budget, not a duplicated shared budget.
    r[field] = copyCategoryPersistenceValue(descriptor.value);
  }
  return r;
}
/** This parser binds the complete publication intent, not a made-up lifecycle
 * transition. A parsed request is data; current owner acquisition is separate. */
export function parseCatalogProductPublicationReferenceRequestV2(
  value: unknown,
): CatalogProductPublicationReferenceRequestV2 {
  try {
    const r = exact(value, [
        "profile",
        "command",
        "originalIntentDigest",
        "replacementIntentDigest",
        "aggregateSnapshotDigest",
        "currentPublicationDigest",
        "observedAt",
        "validUntil",
      ]),
      command = parseProductPublicationCommandV2(r.command),
      originalIntentDigest = digest(r.originalIntentDigest),
      replacementIntentDigest = digest(r.replacementIntentDigest),
      aggregateSnapshotDigest = digest(r.aggregateSnapshotDigest),
      currentPublicationDigest =
        r.currentPublicationDigest === null ? null : digest(r.currentPublicationDigest),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductPublicationReferenceRequestV2" ||
      canonicalizeRfc8785(r.command) !== canonicalizeRfc8785(command) ||
      originalIntentDigest !== hash(command) ||
      replacementIntentDigest !== command.replacementIntentDigest ||
      command.occurredAt > observedAt ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      (currentPublicationDigest === null
        ? command.action !== "Validate" || command.expectedPublicationVersion !== 0
        : command.expectedPublicationVersion < 1)
    )
      return fail();
    return Object.freeze({
      profile: "CatalogProductPublicationReferenceRequestV2",
      command,
      originalIntentDigest,
      replacementIntentDigest,
      aggregateSnapshotDigest,
      currentPublicationDigest,
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Rebind an already-produced action-neutral context before deriving source
 * requests. No caller-supplied derived flag, hash or changed action is accepted. */
export function buildCatalogProductPublicationReferenceRequestV2(
  contextValue: unknown,
  originalValidUntil: string,
): CatalogProductPublicationReferenceRequestV2 {
  try {
    const r = exact(contextValue, [
        "profile",
        "command",
        "aggregate",
        "current",
        "content",
        "sourceDraft",
        "originalIntentDigest",
        "replacementIntentDigest",
        "currentPublicationDigest",
        "contentDigest",
        "configurationDigest",
        "scopeDigest",
        "periodDigest",
        "observedAt",
        "completeContent",
        "sourceAuthority",
        "referenceEligibility",
        "publishValidation",
        "eligibility",
      ]),
      context = bindCatalogProductPublicationValidationContextV2({
        command: r.command,
        aggregate: r.aggregate,
        current: r.current,
        content: r.content,
        observedAt: r.observedAt,
      });
    if (canonicalizeRfc8785(r) !== canonicalizeRfc8785(context)) return fail();
    return parseCatalogProductPublicationReferenceRequestV2({
      profile: "CatalogProductPublicationReferenceRequestV2",
      command: context.command,
      originalIntentDigest: context.originalIntentDigest,
      replacementIntentDigest: context.replacementIntentDigest,
      aggregateSnapshotDigest: hash(context.aggregate),
      currentPublicationDigest: context.currentPublicationDigest,
      observedAt: context.observedAt,
      validUntil: originalValidUntil,
    });
  } catch {
    return fail();
  }
}
export function bindCatalogProductPublicationReferenceRequestV2(
  value: unknown,
  contextValue: unknown,
): CatalogProductPublicationReferenceRequestV2 {
  const request = parseCatalogProductPublicationReferenceRequestV2(value),
    bound = buildCatalogProductPublicationReferenceRequestV2(contextValue, request.validUntil);
  if (canonicalizeRfc8785(request) !== canonicalizeRfc8785(bound)) return fail();
  return bound;
}

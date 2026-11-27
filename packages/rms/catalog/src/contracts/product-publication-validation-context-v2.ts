import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseProductAggregate } from "./product.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
} from "./product-publication-v2.js";

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Binds the actual writer observation without changing the action or granting a
 * current source, permission, lease, validation result or lifecycle transition.
 * The owning writer and planner still enforce action admission and receipt rules.
 * Supersede is closed by the V2 command parser; no successor Draft can stand in
 * for frozen publication content. Existing Validate-only sources stay separate. */
export function bindCatalogProductPublicationValidationContextV2(value: unknown) {
  const safe = copyCategoryPersistenceValue(value),
    keys = ["command", "aggregate", "current", "content", "observedAt"];
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return fail();
  const r = safe as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key)))
    return fail();
  const command = parseProductPublicationCommandV2(r.command),
    aggregate = parseProductAggregate(r.aggregate),
    current = r.current === null ? null : parseProductPublicationVersionV2(r.current),
    observedAt = parseCatalogInstant(r.observedAt),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    scopeDigest = hash(command.scopeSet),
    periodDigest = hash(command.effectivePeriod);
  if (
    r.content !== null ||
    command.occurredAt > observedAt ||
    aggregate.updatedAt > observedAt ||
    aggregate.draft.updatedAt > observedAt ||
    (command.action !== "ActivateScheduled" && command.occurredAt < aggregate.updatedAt) ||
    aggregate.brandReference !== command.brandReference ||
    aggregate.productReference !== command.productReference ||
    aggregate.aggregateVersion !== command.expectedProductAggregateVersion ||
    aggregate.draft.versionReference !== command.versionReference ||
    identity.contentDigest !== command.contentDigest ||
    identity.configurationDigest !== command.configurationDigest
  )
    return fail();
  if (current === null) {
    if (command.action !== "Validate" || command.expectedPublicationVersion !== 0) return fail();
  } else if (
    current.tenantReference !== command.tenantReference ||
    current.brandReference !== command.brandReference ||
    current.productReference !== command.productReference ||
    current.versionReference !== command.versionReference ||
    current.publicationVersion !== command.expectedPublicationVersion ||
    // Recorded revisions carry the pre-commit root, so their committed root is +1.
    current.productAggregateVersion >= aggregate.aggregateVersion ||
    current.occurredAt > command.occurredAt ||
    current.occurredAt > observedAt ||
    (command.action !== "Validate" &&
      (current.contentDigest !== command.contentDigest ||
        current.configurationDigest !== command.configurationDigest ||
        current.scopeDigest !== scopeDigest ||
        current.replacementIntentDigest !== command.replacementIntentDigest ||
        (command.action !== "ReschedulePublish" && current.periodDigest !== periodDigest)))
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductPublicationValidationContextV2" as const,
    command,
    aggregate,
    current,
    content: null,
    sourceDraft: aggregate.draft,
    originalIntentDigest: hash(command),
    replacementIntentDigest: command.replacementIntentDigest,
    currentPublicationDigest: current === null ? null : hash(current),
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeDigest,
    periodDigest,
    observedAt,
    completeContent:
      aggregate.draft.editorContent === undefined ? ("Unavailable" as const) : ("Present" as const),
    sourceAuthority: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  });
}

export type CatalogProductPublicationValidationContextV2 = ReturnType<
  typeof bindCatalogProductPublicationValidationContextV2
>;

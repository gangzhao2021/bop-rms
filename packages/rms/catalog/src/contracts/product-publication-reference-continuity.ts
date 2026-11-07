import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError, parseCatalogInstant } from "./product.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseProductPublicationVersionV2,
} from "./product-publication-v2.js";
import {
  bindCatalogProductPublicationValidationReportToPublication,
  parseCatalogProductPublicationValidationDetails,
} from "./product-publication-validation-report.js";

export const productPublicationReferenceBaselineActions = Object.freeze([
  "SubmitReview",
  "Approve",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "ActivateScheduled",
] as const);
const fail = (code: ConstructorParameters<typeof CatalogError>[0]): never => {
  throw new CatalogError(code);
};
const conflict = (): never => fail("CATALOG_LIFECYCLE_CONFLICT");
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/** A continuity check over actual held evidence, not a qualification producer.
 * Historical source leases remain historical. Only the current sources supply
 * the returned deadline; neither a new approval nor human consent resets refs. */
export function assertCatalogProductPublicationReferenceContinuity(value: unknown): string {
  const keys = ["command", "current", "report", "validation", "details", "observedAt", "now"];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail("CATALOG_INPUT_INVALID");
  // Independently parse bounded report/details; do not double their traversal
  // budgets by copying a wrapper containing both complete reference reports.
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail("CATALOG_INPUT_INVALID");
    r[key] = descriptor.value;
  }
  const command = parseProductPublicationCommandV2(r.command);
  if (!productPublicationReferenceBaselineActions.some((action) => action === command.action))
    return fail("CATALOG_INPUT_INVALID");
  if (r.current === null || r.report === null || r.details === null) return conflict();
  const current = parseProductPublicationVersionV2(r.current),
    report = bindCatalogProductPublicationValidationReportToPublication(r.report, current),
    details = parseCatalogProductPublicationValidationDetails(r.details),
    validation = parseProductPublicationValidationV2(r.validation),
    observedAt = parseCatalogInstant(r.observedAt),
    now = parseCatalogInstant(r.now);
  if (report.details.coverage !== "Complete" || details.coverage !== "Complete") return conflict();
  if (
    current.tenantReference !== command.tenantReference ||
    current.brandReference !== command.brandReference ||
    current.productReference !== command.productReference ||
    current.versionReference !== command.versionReference ||
    current.publicationVersion !== command.expectedPublicationVersion ||
    current.productAggregateVersion >= command.expectedProductAggregateVersion ||
    current.contentDigest !== command.contentDigest ||
    current.configurationDigest !== command.configurationDigest ||
    current.scopeDigest !== hash(command.scopeSet) ||
    current.replacementIntentDigest !== command.replacementIntentDigest ||
    (command.action !== "ReschedulePublish" &&
      current.periodDigest !== hash(command.effectivePeriod)) ||
    (command.action === "SubmitReview" &&
      (report.publicationAction !== "Validate" || current.validationDecision === "HardError"))
  )
    return conflict();
  if (
    validation.productAggregateVersion !== command.expectedProductAggregateVersion ||
    validation.contentDigest !== command.contentDigest ||
    validation.configurationDigest !== command.configurationDigest ||
    validation.scopeDigest !== hash(command.scopeSet) ||
    validation.periodDigest !== hash(command.effectivePeriod) ||
    validation.replacementIntentDigest !== command.replacementIntentDigest
  )
    return conflict();
  const originalDeadline = new Date(Date.parse(observedAt) + 5000).toISOString();
  if (
    now < observedAt ||
    current.occurredAt > observedAt ||
    validation.checkedAt > observedAt ||
    validation.validUntil <= now ||
    now >= originalDeadline ||
    details.sources.some(
      (source) =>
        source.observedAt < validation.checkedAt ||
        source.observedAt > now ||
        source.validUntil <= now ||
        source.validUntil < validation.validUntil,
    )
  )
    return fail("CATALOG_DEPENDENCY_UNAVAILABLE");
  const baseline = new Map(
    report.details.sources.map((source) => [source.sourceCode, source.relevantReferenceDigest]),
  );
  if (
    baseline.size !== details.sources.length ||
    details.sources.some(
      (source) => baseline.get(source.sourceCode) !== source.relevantReferenceDigest,
    )
  )
    return conflict();
  return (
    [
      originalDeadline,
      validation.validUntil,
      ...details.sources.map((source) => source.validUntil),
    ].sort()[0] ?? fail("CATALOG_DEPENDENCY_UNAVAILABLE")
  );
}

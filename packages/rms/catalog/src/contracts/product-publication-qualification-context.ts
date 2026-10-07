import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductAggregate,
  type ProductAggregate,
} from "./product.js";
import { bindCatalogProductPublicationValidationContextV2 } from "./product-publication-validation-context-v2.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  type CatalogProductPublicationContent,
} from "./product-publication-content.js";
import {
  parseProductPublicationVersionV2,
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
} from "./product-publication-v2.js";
import {
  parseCatalogProductPublicationValidationReport,
  type CatalogProductPublicationValidationReport,
} from "./product-publication-validation-report.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type CatalogProductPublicationWarningAcknowledgementCommand,
} from "./product-publication-warning-acknowledgement.js";

export interface CatalogProductPublicationQualificationInput {
  readonly command: ProductPublicationCommandV2;
  readonly aggregate: ProductAggregate;
  readonly current: ProductPublicationVersionV2 | null;
  readonly content: CatalogProductPublicationContent | null;
  readonly observedAt: string;
}
export interface CatalogProductWarningAcknowledgementQualificationInput {
  readonly command: CatalogProductPublicationWarningAcknowledgementCommand;
  readonly aggregate: ProductAggregate;
  readonly current: ProductPublicationVersionV2;
  readonly report: CatalogProductPublicationValidationReport;
  readonly observedAt: string;
  readonly validUntil: string;
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function readClosedRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const ownKeys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    record[key] = descriptor.value;
  }
  return Object.freeze(record);
}
function originalDeadline(observedAt: string, value: unknown) {
  const validUntil = parseCatalogInstant(value);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  return validUntil;
}
function recordedPolicy(current: ProductPublicationVersionV2 | null) {
  return current === null
    ? null
    : Object.freeze({
        policyReference: current.policyReference,
        policyVersion: current.policyVersion,
      });
}

/** Owning structural binding only. The actual writer callback and owning
 * source holders, not this object or its hashes, provide current authority. */
export function bindCatalogProductPublicationQualificationContext(
  input: CatalogProductPublicationQualificationInput,
  originalValidUntil: string,
) {
  try {
    const context = bindCatalogProductPublicationValidationContextV2(input),
      { command, aggregate, current } = context,
      validUntil = originalDeadline(context.observedAt, originalValidUntil);
    return Object.freeze({
      kind: "Publication" as const,
      command,
      aggregate,
      current,
      report: null,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      actorKind: command.actorKind,
      productReference: command.productReference,
      versionReference: command.versionReference,
      aggregateVersion: aggregate.aggregateVersion,
      contentDigest: context.contentDigest,
      configurationDigest: context.configurationDigest,
      scopeSet: command.scopeSet,
      scopeDigest: context.scopeDigest,
      effectivePeriod: command.effectivePeriod,
      periodDigest: context.periodDigest,
      replacementIntent: command.replacementIntent,
      replacementIntentDigest: context.replacementIntentDigest,
      recordedPolicy: recordedPolicy(current),
      originalIntentDigest: context.originalIntentDigest,
      aggregateSnapshotDigest: hash(aggregate),
      currentPublicationDigest: context.currentPublicationDigest,
      observedAt: context.observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}

/** Bind the distinct Ack intent to its delivered original report and the actual
 * writer-supplied Draft/head. Historical report leases are not human deadlines.
 * This function performs no read, policy selection, admission or clock renewal. */
export function bindCatalogProductWarningAcknowledgementQualificationContext(
  input: CatalogProductWarningAcknowledgementQualificationInput,
) {
  try {
    // Keep the independently bounded full report out of the generic aggregate
    // copy budget; its owning parser validates and detaches the complete value.
    const r = readClosedRecord(input, [
        "command",
        "aggregate",
        "current",
        "report",
        "observedAt",
        "validUntil",
      ]),
      command = parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
      aggregate = parseProductAggregate(copyCategoryPersistenceValue(r.aggregate)),
      current = parseProductPublicationVersionV2(r.current),
      report = parseCatalogProductPublicationValidationReport(r.report),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = originalDeadline(observedAt, r.validUntil),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      binding = Object.freeze({
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        productReference: command.productReference,
        versionReference: command.versionReference,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeDigest: hash(current.scopeSet),
        periodDigest: hash(current.effectivePeriod),
        replacementIntentDigest: current.replacementIntentDigest,
        policyReference: current.policyReference,
        policyVersion: current.policyVersion,
      });
    if (
      command.occurredAt > observedAt ||
      aggregate.updatedAt > observedAt ||
      aggregate.draft.updatedAt > observedAt ||
      aggregate.brandReference !== command.brandReference ||
      aggregate.productReference !== command.productReference ||
      aggregate.aggregateVersion !== command.expectedProductAggregateVersion ||
      aggregate.draft.versionReference !== command.versionReference ||
      aggregate.draft.editorContent === undefined ||
      current.tenantReference !== command.tenantReference ||
      current.brandReference !== command.brandReference ||
      current.productReference !== command.productReference ||
      current.versionReference !== command.versionReference ||
      current.productAggregateVersion >= aggregate.aggregateVersion ||
      current.occurredAt > observedAt ||
      current.contentDigest !== identity.contentDigest ||
      current.configurationDigest !== identity.configurationDigest ||
      report.operationReference !== command.reportOperationReference ||
      report.digest !== command.reportDigest ||
      report.warningBindingDigest !== command.warningBindingDigest ||
      report.details.coverage !== "Complete" ||
      report.validation.checks.some((check) => check.outcome === "HardError") ||
      !equal(
        report.validation.checks
          .filter((check) => check.outcome === "Warning")
          .map((check) => check.code)
          .sort(),
        command.warningCodes,
      ) ||
      !equal(report.binding, binding) ||
      report.resultAggregateVersion > aggregate.aggregateVersion ||
      report.publicationVersion > current.publicationVersion ||
      report.recordedAt > observedAt ||
      (report.publicationVersion === current.publicationVersion &&
        (report.operationReference !== current.operationReference ||
          report.publicationSnapshotDigest !== hash(current)))
    )
      return fail();
    return Object.freeze({
      kind: "WarningAcknowledgement" as const,
      command,
      aggregate,
      current,
      report,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      actorKind: command.actorKind,
      productReference: command.productReference,
      versionReference: command.versionReference,
      aggregateVersion: aggregate.aggregateVersion,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: current.scopeSet,
      scopeDigest: binding.scopeDigest,
      effectivePeriod: current.effectivePeriod,
      periodDigest: binding.periodDigest,
      replacementIntent: current.replacementIntent,
      replacementIntentDigest: current.replacementIntentDigest,
      recordedPolicy: Object.freeze({
        policyReference: current.policyReference,
        policyVersion: current.policyVersion,
      }),
      originalIntentDigest: hash(command),
      aggregateSnapshotDigest: hash(aggregate),
      currentPublicationDigest: hash(current),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
export type CatalogProductPublicationQualificationContext = ReturnType<
  typeof bindCatalogProductPublicationQualificationContext
>;
export type CatalogProductWarningAcknowledgementQualificationContext = ReturnType<
  typeof bindCatalogProductWarningAcknowledgementQualificationContext
>;
export type CatalogProductQualificationContext =
  | CatalogProductPublicationQualificationContext
  | CatalogProductWarningAcknowledgementQualificationContext;

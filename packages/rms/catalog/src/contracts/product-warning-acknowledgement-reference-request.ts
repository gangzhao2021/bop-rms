import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseProductPublicationVersionV2 } from "./product-publication-v2.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import { bindCatalogProductWarningAcknowledgementQualificationContext } from "./product-publication-qualification-context.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type CatalogProductPublicationWarningAcknowledgementCommand,
} from "./product-publication-warning-acknowledgement.js";

export const productWarningAcknowledgementReferenceRequestFields = Object.freeze([
  "command",
  "originalIntentDigest",
  "replacementIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "publicationVersion",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "policyReference",
  "policyVersion",
  "observedAt",
  "validUntil",
] as const);
export interface CatalogProductWarningAcknowledgementReferenceRequest {
  readonly profile: "CatalogProductWarningAcknowledgementReferenceRequestV1";
  readonly command: CatalogProductPublicationWarningAcknowledgementCommand;
  readonly originalIntentDigest: string;
  readonly replacementIntentDigest: string;
  readonly aggregateSnapshotDigest: string;
  readonly currentPublicationDigest: string;
  readonly publicationVersion: number;
  readonly contentDigest: string;
  readonly configurationDigest: string;
  readonly scopeDigest: string;
  readonly periodDigest: string;
  readonly policyReference: string;
  readonly policyVersion: number;
  readonly observedAt: string;
  readonly validUntil: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function digest(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    return fail();
  return value;
}
/** Closed data binding, not evidence that the report or any current reference
 * was acquired. The Ack writer holds the actual report separately. */
export function parseCatalogProductWarningAcknowledgementReferenceRequest(
  value: unknown,
): CatalogProductWarningAcknowledgementReferenceRequest {
  try {
    const r = exact(copyCategoryPersistenceValue(value), [
        "profile",
        ...productWarningAcknowledgementReferenceRequestFields,
      ]),
      command = parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
      observedAt = parseCatalogInstant(r.observedAt),
      validUntil = parseCatalogInstant(r.validUntil);
    if (
      r.profile !== "CatalogProductWarningAcknowledgementReferenceRequestV1" ||
      !equal(command, r.command) ||
      command.occurredAt > observedAt ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      r.originalIntentDigest !== hash(command)
    )
      return fail();
    // Reuse the owning report binding parser by the builder/current binder;
    // this compact request carries only canonical digests and the exact policy ID.
    return Object.freeze({
      profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
      command,
      originalIntentDigest: digest(r.originalIntentDigest),
      replacementIntentDigest: digest(r.replacementIntentDigest),
      aggregateSnapshotDigest: digest(r.aggregateSnapshotDigest),
      currentPublicationDigest: digest(r.currentPublicationDigest),
      publicationVersion: version(r.publicationVersion),
      contentDigest: digest(r.contentDigest),
      configurationDigest: digest(r.configurationDigest),
      scopeDigest: digest(r.scopeDigest),
      periodDigest: digest(r.periodDigest),
      policyReference: parseCatalogReference(r.policyReference),
      policyVersion: version(r.policyVersion),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Rebind the compact request to the actual owning locked root/head. It does not
 * reacquire the displayed immutable report or reset its human acknowledgement. */
export function bindCatalogProductWarningAcknowledgementReferenceRequestToCurrent(
  value: unknown,
  aggregateValue: unknown,
  publicationValue: unknown,
): CatalogProductWarningAcknowledgementReferenceRequest {
  try {
    const request = parseCatalogProductWarningAcknowledgementReferenceRequest(value),
      c = request.command,
      aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue)),
      current = parseProductPublicationVersionV2(publicationValue),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate);
    if (
      aggregate.draft.editorContent === undefined ||
      aggregate.productReference !== c.productReference ||
      aggregate.brandReference !== c.brandReference ||
      aggregate.draft.versionReference !== c.versionReference ||
      aggregate.aggregateVersion !== c.expectedProductAggregateVersion ||
      aggregate.updatedAt > request.observedAt ||
      aggregate.draft.updatedAt > request.observedAt ||
      hash(aggregate) !== request.aggregateSnapshotDigest ||
      hash(current) !== request.currentPublicationDigest ||
      current.tenantReference !== c.tenantReference ||
      current.brandReference !== c.brandReference ||
      current.productReference !== c.productReference ||
      current.versionReference !== c.versionReference ||
      current.productAggregateVersion >= aggregate.aggregateVersion ||
      current.occurredAt > request.observedAt ||
      current.publicationVersion !== request.publicationVersion ||
      current.contentDigest !== identity.contentDigest ||
      current.configurationDigest !== identity.configurationDigest ||
      request.contentDigest !== identity.contentDigest ||
      request.configurationDigest !== identity.configurationDigest ||
      request.scopeDigest !== current.scopeDigest ||
      request.scopeDigest !== hash(current.scopeSet) ||
      request.periodDigest !== current.periodDigest ||
      request.periodDigest !== hash(current.effectivePeriod) ||
      request.replacementIntentDigest !== current.replacementIntentDigest ||
      request.policyReference !== current.policyReference ||
      request.policyVersion !== current.policyVersion
    )
      return fail();
    return request;
  } catch {
    return fail();
  }
}
/** Actual Ack writer input, retaining the original report's own independent
 * budget. Historical report expiry is not the new current observation's lease. */
export function buildCatalogProductWarningAcknowledgementReferenceRequest(
  value: unknown,
): CatalogProductWarningAcknowledgementReferenceRequest {
  try {
    const context = bindCatalogProductWarningAcknowledgementQualificationContext(
      value as Parameters<typeof bindCatalogProductWarningAcknowledgementQualificationContext>[0],
    );
    return bindCatalogProductWarningAcknowledgementReferenceRequestToCurrent(
      {
        profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
        command: context.command,
        originalIntentDigest: context.originalIntentDigest,
        aggregateSnapshotDigest: context.aggregateSnapshotDigest,
        currentPublicationDigest: context.currentPublicationDigest,
        publicationVersion: context.current.publicationVersion,
        contentDigest: context.contentDigest,
        configurationDigest: context.configurationDigest,
        scopeDigest: context.scopeDigest,
        periodDigest: context.periodDigest,
        replacementIntentDigest: context.replacementIntentDigest,
        policyReference: context.current.policyReference,
        policyVersion: context.current.policyVersion,
        observedAt: context.observedAt,
        validUntil: context.validUntil,
      },
      context.aggregate,
      context.current,
    );
  } catch {
    return fail();
  }
}

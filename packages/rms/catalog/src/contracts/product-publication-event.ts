import type { DomainEventEnvelope } from "@bop/eventing";
import {
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { CatalogError, parseCatalogReference, parseProductAggregate } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationVersion,
  productPublicationActions,
  type ProductPublicationAction,
} from "./product-publication.js";
import { parseProductPublicationVersionV2 } from "./product-publication-v2.js";
export const catalogProductPublicationEventTypes = Object.freeze({
  Validate: "ProductValidationCompleted",
  SubmitReview: "ProductReviewSubmitted",
  Approve: "ProductVersionApproved",
  Reject: "ProductVersionRejected",
  Publish: "ProductVersionPublished",
  SchedulePublish: "ProductVersionPublishScheduled",
  ReschedulePublish: "ProductVersionPublishRescheduled",
  CancelScheduledPublish: "ProductVersionPublishScheduleCancelled",
  ActivateScheduled: "ProductVersionPublished",
  Supersede: "ProductVersionSuperseded",
} as const);
export function catalogProductPublicationAuditAction(action: ProductPublicationAction): string {
  if (!productPublicationActions.includes(action)) throw new CatalogError("CATALOG_INPUT_INVALID");
  return "CATALOG_PRODUCT_VERSION_" + action.toUpperCase();
}
/** Caller holds real source/permission leases. Construction is identity/shape
 * validation, never authorization or generation of approval facts. */
export function buildCatalogProductPublicationEvent(
  publicationValue: unknown,
  aggregateValue: unknown,
  action: ProductPublicationAction,
  auditValue: unknown,
  sourceRevision: string,
): { readonly envelope: DomainEventEnvelope; readonly audit: AppendAuditRecordInput } {
  return buildPublicationEvent(
    publicationValue,
    aggregateValue,
    action,
    auditValue,
    sourceRevision,
    parseProductPublicationVersion,
  );
}
/** The existing event schema reports the common publication transition only.
 * Retirement facts remain in their owning V2 source and immutable header. */
export function buildCatalogProductPublicationEventV2(
  publicationValue: unknown,
  aggregateValue: unknown,
  action: ProductPublicationAction,
  auditValue: unknown,
  sourceRevision: string,
): { readonly envelope: DomainEventEnvelope; readonly audit: AppendAuditRecordInput } {
  return buildPublicationEvent(
    publicationValue,
    aggregateValue,
    action,
    auditValue,
    sourceRevision,
    parseProductPublicationVersionV2,
  );
}
function buildPublicationEvent(
  publicationValue: unknown,
  aggregateValue: unknown,
  action: ProductPublicationAction,
  auditValue: unknown,
  sourceRevision: string,
  parsePublication: typeof parseProductPublicationVersion | typeof parseProductPublicationVersionV2,
): { readonly envelope: DomainEventEnvelope; readonly audit: AppendAuditRecordInput } {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const p = parsePublication(publicationValue),
    aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue));
  let audit: AppendAuditRecordInput;
  try {
    audit = validateAuditRecord(copyCategoryPersistenceValue(auditValue));
  } catch {
    return fail();
  }
  const expectedState = {
    Validate: "Draft",
    SubmitReview: "InReview",
    Approve: "Approved",
    Reject: "Draft",
    Publish: "Published",
    SchedulePublish: "Scheduled",
    ReschedulePublish: "Scheduled",
    CancelScheduledPublish: "Draft",
    ActivateScheduled: "Published",
    Supersede: "Superseded",
  } as const;
  if (
    !productPublicationActions.includes(action) ||
    p.state !== expectedState[action] ||
    (p.actorKind === "System") !== (action === "ActivateScheduled" || action === "Supersede") ||
    aggregate.brandReference !== p.brandReference ||
    aggregate.productReference !== p.productReference ||
    aggregate.aggregateVersion !== p.productAggregateVersion + 1 ||
    aggregate.updatedAt !== p.occurredAt ||
    (p.state !== "Published" &&
      p.state !== "Superseded" &&
      aggregate.draft.versionReference !== p.versionReference) ||
    (p.state === "Published" &&
      aggregate.draft.versionReference !== p.successorDraftVersionReference) ||
    audit.brandId !== p.brandReference ||
    audit.storeId !== undefined ||
    audit.targetType !== "Product" ||
    audit.targetId !== p.productReference ||
    audit.occurredAt !== p.occurredAt ||
    audit.reasonCode !== p.reasonCode ||
    audit.actionCode !== catalogProductPublicationAuditAction(action) ||
    audit.beforeSummary !== undefined ||
    audit.afterSummary !== undefined ||
    audit.correctsAuditId !== undefined ||
    (p.actorKind === "System"
      ? audit.actor.type !== "System"
      : audit.actor.type !== "User" || audit.actor.reference !== p.actorReference) ||
    !/^[1-9][0-9]{0,18}$/.test(sourceRevision) ||
    BigInt(sourceRevision) > 9223372036854775807n
  )
    return fail();
  const digest = sha256Hex(
      "CatalogProductPublicationSourceEvent:v1:" + p.brandReference + ":" + p.operationReference,
    ),
    eventId = parseCatalogReference(
      p.operationReference.slice(0, 14) +
        "7" +
        digest.slice(0, 3) +
        "-8" +
        digest.slice(3, 6) +
        "-" +
        digest.slice(6, 18),
    );
  const snapshotDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate));
  const envelope: DomainEventEnvelope = Object.freeze({
    eventId,
    eventType: catalogProductPublicationEventTypes[action],
    schemaVersion: 1,
    occurredAt: p.occurredAt,
    producerModule: "@rms/catalog",
    tenantId: p.brandReference,
    aggregateType: "Product",
    aggregateId: p.productReference,
    aggregateVersion: BigInt(aggregate.aggregateVersion),
    correlationId: audit.correlationId,
    actor:
      p.actorKind === "System"
        ? Object.freeze({ type: "System" as const })
        : Object.freeze({ type: "Actor" as const, actorId: p.actorReference }),
    payload: Object.freeze({
      tenantReference: p.tenantReference,
      productReference: p.productReference,
      productVersionReference: p.versionReference,
      resultDraftVersionReference: aggregate.draft.versionReference,
      aggregateVersion: String(aggregate.aggregateVersion),
      lifecycle: aggregate.lifecycle,
      changedSkuReference: null,
      sourceRevision,
      operationReference: p.operationReference,
      snapshotDigest,
      publicationVersion: p.publicationVersion,
      publicationState: p.state,
      action,
      scopeDigest: p.scopeDigest,
      periodDigest: p.periodDigest,
      contentDigest: p.contentDigest,
      configurationDigest: p.configurationDigest,
      scheduleReference: p.scheduleReference,
      scheduleVersion: p.scheduleVersion,
      successorDraftVersionReference: p.successorDraftVersionReference,
      supersededByVersionReference: p.supersededByVersionReference,
    }),
    redactionClassification: "indirect_identifier",
    replayMetadata: Object.freeze({
      operationReference: p.operationReference,
      sourceRevision,
      publicationVersion: p.publicationVersion,
    }),
  });
  const enriched = validateAuditRecord({
    ...audit,
    afterSummary: {
      versionReference: p.versionReference,
      publicationVersion: p.publicationVersion,
      state: p.state,
      scopeDigest: p.scopeDigest,
      periodDigest: p.periodDigest,
      contentDigest: p.contentDigest,
    },
  });
  return Object.freeze({ envelope, audit: enriched });
}

import type { DomainEventEnvelope } from "@bop/eventing";
import { sha256Hex, validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { CatalogError, parseCatalogReference } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseCatalogProductPublicationWarningAcknowledgementReceipt,
} from "./product-publication-warning-acknowledgement.js";

export function catalogProductPublicationWarningAcknowledgementEventId(
  commandValue: unknown,
): string {
  const command = parseCatalogProductPublicationWarningAcknowledgementCommand(commandValue);
  const digest = sha256Hex(
    "CatalogProductPublicationWarningAcknowledgementEvent:v1:" +
      command.brandReference +
      ":" +
      command.operationReference,
  );
  return parseCatalogReference(
    command.operationReference.slice(0, 14) +
      "7" +
      digest.slice(0, 3) +
      "-8" +
      digest.slice(3, 6) +
      "-" +
      digest.slice(6, 18),
  );
}

/** An immutable acknowledgement has its own event stream. It is not a Product
 * revision, a validation result, or authorization to publish. */
export function buildCatalogProductPublicationWarningAcknowledgementEvent(
  receiptValue: unknown,
  auditValue: unknown,
): { readonly envelope: DomainEventEnvelope; readonly audit: AppendAuditRecordInput } {
  const receipt = parseCatalogProductPublicationWarningAcknowledgementReceipt(receiptValue);
  const command = receipt.command;
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  let audit: AppendAuditRecordInput;
  try {
    audit = validateAuditRecord(copyCategoryPersistenceValue(auditValue));
  } catch {
    return fail();
  }
  if (
    audit.brandId !== command.brandReference ||
    audit.storeId !== undefined ||
    audit.actor.type !== "User" ||
    audit.actor.reference !== command.actorReference ||
    audit.targetType !== "Product" ||
    audit.targetId !== command.productReference ||
    audit.occurredAt !== receipt.recordedAt ||
    audit.reasonCode !== command.reasonCode ||
    audit.actionCode !== "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED" ||
    audit.beforeSummary !== undefined ||
    audit.afterSummary !== undefined ||
    audit.correctsAuditId !== undefined
  )
    return fail();
  const payload = Object.freeze({
    tenantReference: command.tenantReference,
    productReference: command.productReference,
    productVersionReference: command.versionReference,
    operationReference: command.operationReference,
    productAggregateVersion: command.expectedProductAggregateVersion,
    reportOperationReference: command.reportOperationReference,
    reportDigest: command.reportDigest,
    warningBindingDigest: command.warningBindingDigest,
    receiptDigest: receipt.digest,
    warningCodes: command.warningCodes,
  });
  const envelope: DomainEventEnvelope = Object.freeze({
    eventId: catalogProductPublicationWarningAcknowledgementEventId(command),
    eventType: "ProductPublicationWarningsAcknowledged",
    schemaVersion: 1,
    occurredAt: receipt.recordedAt,
    producerModule: "@rms/catalog",
    tenantId: command.brandReference,
    aggregateType: "ProductPublicationWarningAcknowledgement",
    aggregateId: command.operationReference,
    aggregateVersion: 1n,
    correlationId: audit.correlationId,
    actor: Object.freeze({ type: "Actor" as const, actorId: command.actorReference }),
    payload,
    redactionClassification: "indirect_identifier",
    replayMetadata: Object.freeze({
      operationReference: command.operationReference,
      receiptDigest: receipt.digest,
    }),
  });
  const enriched = validateAuditRecord({
    ...audit,
    afterSummary: {
      versionReference: command.versionReference,
      reportOperationReference: command.reportOperationReference,
      reportDigest: command.reportDigest,
      warningBindingDigest: command.warningBindingDigest,
      receiptDigest: receipt.digest,
      warningCodes: command.warningCodes,
    },
  });
  return Object.freeze({ envelope, audit: enriched });
}

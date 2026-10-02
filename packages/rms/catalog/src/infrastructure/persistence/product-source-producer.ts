import { buildCatalogProductPublicationEvent } from "../../contracts/product-publication-event.js";
import {
  parseProductPublicationVersion,
  type ProductPublicationAction,
} from "../../contracts/product-publication.js";
import { parseProductAggregate } from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction, type DomainEventEnvelope } from "@bop/eventing";
import {
  CatalogError,
  parseCatalogReference,
  type ProductAggregate,
} from "../../contracts/product.js";
import type { CatalogOperationRecord } from "../../application/ports/product-ports.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Acquired before operation/code/Product locks and retained by the caller through COMMIT.
 * This fence also lets a later projection bootstrap read a coherent Brand source. */
export async function holdProductSourceBarrier(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  brand: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "CatalogProductSource:" + brand,
  ]);
}

/** Canonical complete envelope proof, including Actor/correlation and optional-field absence. */
export function productSourceEventDigest(envelope: DomainEventEnvelope): string {
  return (
    "sha256:" +
    sha256Hex(
      canonicalizeRfc8785({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        schemaVersion: envelope.schemaVersion,
        occurredAt: envelope.occurredAt,
        producerModule: envelope.producerModule,
        brandReference: envelope.tenantId,
        storeReference: envelope.storeId ?? null,
        aggregateType: envelope.aggregateType,
        aggregateId: envelope.aggregateId,
        aggregateVersion: String(envelope.aggregateVersion),
        correlationId: envelope.correlationId,
        causationId: envelope.causationId ?? null,
        actor: envelope.actor,
        payload: envelope.payload,
        redactionClassification: envelope.redactionClassification,
        replayMetadata: envelope.replayMetadata,
      }),
    )
  );
}

/** Appends source commit facts inside the writer's savepoint. Never called on replay. */
export async function appendProductSourceCommit(
  tx: ProductLifecycleTransaction,
  record: CatalogOperationRecord,
  audit: AppendAuditRecordInput,
  previous: ProductAggregate | null,
): Promise<void> {
  const aggregate = record.aggregate;
  if (audit.actor.type === "System" || audit.brandId !== aggregate.brandReference) return fail();
  let eventType: string;
  let changedSkuReference: string | null = null;
  if (record.action === "Create") eventType = "ProductCreated";
  else if (record.action === "ReplaceDraft") eventType = "ProductDraftUpdated";
  else {
    if (!previous) return fail();
    if (previous.lifecycle === aggregate.lifecycle) {
      const changed = aggregate.draft.skus.filter(
        (sku) =>
          previous.draft.skus.find((old) => old.skuReference === sku.skuReference)?.lifecycle !==
          sku.lifecycle,
      );
      if (changed.length !== 1 || !changed[0]) return fail();
      changedSkuReference = changed[0].skuReference;
      eventType = "ProductDraftUpdated";
    } else if (previous.lifecycle === "Archived") eventType = "ProductRestored";
    else if (aggregate.lifecycle === "Active")
      eventType = previous.lifecycle === "Suspended" ? "ProductResumed" : "ProductActivated";
    else if (aggregate.lifecycle === "Suspended") eventType = "ProductSuspended";
    else if (aggregate.lifecycle === "Discontinued") eventType = "ProductDiscontinued";
    else if (aggregate.lifecycle === "Archived") eventType = "ProductArchived";
    else return fail();
  }
  const next = await tx.query<{ revision: string }>(
    "INSERT INTO rms_catalog.product_source_head(brand_id,source_revision) VALUES($1,1) ON CONFLICT(brand_id) DO UPDATE SET source_revision=rms_catalog.product_source_head.source_revision+1 WHERE rms_catalog.product_source_head.source_revision<9223372036854775807 RETURNING source_revision::text revision",
    [aggregate.brandReference],
  );
  const revision = next.rows[0]?.revision;
  if (
    next.rowCount !== 1 ||
    next.rows.length !== 1 ||
    typeof revision !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(revision) ||
    BigInt(revision) > 9223372036854775807n
  )
    return fail();
  const digest = sha256Hex(
    "CatalogProductSourceEvent:v1:" + aggregate.brandReference + ":" + record.operationReference,
  );
  const eventId = parseCatalogReference(
    record.operationReference.slice(0, 14) +
      "7" +
      digest.slice(0, 3) +
      "-8" +
      digest.slice(3, 6) +
      "-" +
      digest.slice(6, 18),
  );
  const snapshotDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate));
  const envelope: DomainEventEnvelope = {
    eventId,
    eventType,
    schemaVersion: 1,
    occurredAt: aggregate.updatedAt,
    producerModule: "@rms/catalog",
    // Eventing's historical tenantId field is persisted as brand_id by its public append contract.
    tenantId: aggregate.brandReference,
    aggregateType: "Product",
    aggregateId: aggregate.productReference,
    aggregateVersion: BigInt(aggregate.aggregateVersion),
    correlationId: audit.correlationId,
    actor: { type: "Actor", actorId: audit.actor.reference },
    payload: {
      productReference: aggregate.productReference,
      productVersionReference: aggregate.draft.versionReference,
      aggregateVersion: String(aggregate.aggregateVersion),
      lifecycle: aggregate.lifecycle,
      changedSkuReference,
      sourceRevision: revision,
      operationReference: record.operationReference,
      snapshotDigest,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { operationReference: record.operationReference, sourceRevision: revision },
  };
  const receipt = await tx.query(
    "INSERT INTO rms_catalog.product_source_commit(operation_id,brand_id,source_revision,product_id,result_aggregate_version,event_id,event_type,snapshot_digest,occurred_at,actor_id,correlation_id,event_digest) SELECT operation_id,brand_id,$3,product_id,result_aggregate_version,$6,$7,$8,occurred_at,$10,$11,$12 FROM rms_catalog.product_operation_record WHERE operation_id=$1 AND brand_id=$2 AND product_id=$4 AND result_aggregate_version=$5 AND occurred_at=$9",
    [
      record.operationReference,
      aggregate.brandReference,
      revision,
      aggregate.productReference,
      aggregate.aggregateVersion,
      eventId,
      eventType,
      snapshotDigest,
      aggregate.updatedAt,
      audit.actor.reference,
      audit.correlationId,
      productSourceEventDigest(envelope),
    ],
  );
  if (receipt.rowCount !== 1) return fail();
  await appendEventInTransaction(
    {
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        if (
          result.rowCount !== null &&
          (!Number.isSafeInteger(result.rowCount) || (result.rowCount ?? -1) < 0)
        )
          return fail();
        return { rowCount: result.rowCount ?? null };
      },
    },
    envelope,
  );
}

/** Actual owning append artifacts. Root/publication/content changes and these
 * appends belong to the same UoW; caller must roll back the UoW on any failure.
 * Not invoked on committed replay. Public Audit/Event APIs own their tables. */
export async function appendProductPublicationCommitArtifacts(
  tx: ProductLifecycleTransaction,
  publicationValue: unknown,
  aggregateValue: unknown,
  action: ProductPublicationAction,
  auditValue: unknown,
): Promise<void> {
  const p = parseProductPublicationVersion(publicationValue),
    aggregate = parseProductAggregate(copyCategoryPersistenceValue(aggregateValue));
  // Validate complete identity before even allocating a source generation.
  buildCatalogProductPublicationEvent(p, aggregate, action, auditValue, "1");
  const next = await tx.query<{ revision: string }>(
    "INSERT INTO rms_catalog.product_source_head(brand_id,source_revision) VALUES($1,1) ON CONFLICT(brand_id) DO UPDATE SET source_revision=rms_catalog.product_source_head.source_revision+1 WHERE rms_catalog.product_source_head.source_revision<9223372036854775807 RETURNING source_revision::text revision",
    [p.brandReference],
  );
  if (next.rowCount !== 1 || next.rows.length !== 1 || typeof next.rows[0]?.revision !== "string")
    return fail();
  const artifacts = buildCatalogProductPublicationEvent(
      p,
      aggregate,
      action,
      auditValue,
      next.rows[0].revision,
    ),
    envelope = artifacts.envelope;
  const receipt = await tx.query(
    "INSERT INTO rms_catalog.product_source_commit(operation_id,brand_id,source_revision,product_id,result_aggregate_version,event_id,event_type,snapshot_digest,occurred_at,actor_id,correlation_id,event_digest) SELECT operation_id,brand_id,$3,product_id,result_aggregate_version,$6,$7,$8,occurred_at,$10,$11,$12 FROM rms_catalog.product_operation_record WHERE operation_id=$1 AND brand_id=$2 AND product_id=$4 AND result_aggregate_version=$5 AND occurred_at=$9 AND action_code='ProductPublication' AND intent_digest=$13",
    [
      p.operationReference,
      p.brandReference,
      next.rows[0].revision,
      p.productReference,
      aggregate.aggregateVersion,
      envelope.eventId,
      envelope.eventType,
      envelope.payload.snapshotDigest,
      p.occurredAt,
      p.actorReference,
      envelope.correlationId,
      productSourceEventDigest(envelope),
      p.intentDigest,
    ],
  );
  if (receipt.rowCount !== 1) return fail();
  await appendAuditRecordInTransaction(tx, artifacts.audit);
  await appendEventInTransaction(
    {
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        if (result.rowCount !== 1) return fail();
        return { rowCount: 1 };
      },
    },
    envelope,
  );
}

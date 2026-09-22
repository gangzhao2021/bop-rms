import type { ConsumerTransaction } from "@bop/eventing";
import type { OrderStatusSourceSnapshot } from "../../domain/order-status-projection.js";
import { createHash } from "node:crypto";
import type { OrderSubmittedEventConsumerPorts } from "../../application/ports/order-submitted-event-ports.js";
import { parseOrderSubmittedEnvelope } from "../../application/order-submitted-event.js";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { resolveOrderRevisionChain } from "../../domain/order-revision-chain.js";
import {
  decodeAdditionalDiningBatchSnapshot,
  encodeAdditionalDiningBatchSnapshot,
} from "../../domain/additional-dining-batch-codec.js";
import {
  parseOrderStatusSourceSnapshot,
  OrderStatusProjectionError,
} from "../../domain/order-status-projection.js";
import { readOrderCreationHistory } from "./order-creation-query-store.js";
const fail = (): never => {
  throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
};
const instant = (value: unknown) =>
  parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
/** Scoped owner history for the supported initial/acceptance/additional window.
 * Does not infer paid, released or fulfilled state from submission events.
 */
export function createPostgresOrderSubmittedHistorySource(options: {
  brandReference: string;
  storeReference: string;
  quoteVersion: 1 | 2;
  locale: string;
  authorize: OrderSubmittedEventConsumerPorts["authorization"]["authorize"];
}): OrderSubmittedEventConsumerPorts["source"]["loadExact"] {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  return async (input) => {
    try {
      const event = parseOrderSubmittedEnvelope(input.envelope);
      const tx = input.transaction;
      if (
        event.tenantId !== brand ||
        event.storeId !== store ||
        input.brandReference !== brand ||
        input.storeReference !== store ||
        input.orderReference !== event.aggregateId ||
        input.sourceVersion !== Number(event.aggregateVersion) ||
        input.sourceCheckpoint !== event.eventId ||
        input.sourceDigest !== event.payload.sourceSnapshotDigest ||
        event.payload.batchSequence < 2 ||
        !(await options.authorize(tx, event))
      )
        return fail();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" + brand + ":" + store + ":" + event.aggregateId,
      ]);
      const found = await tx.query(
        "SELECT r.revision_id,r.version,r.expected_version,r.previous_revision_id,r.initial_submission_id,r.kind,r.occurred_at," +
          "EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.acceptance_id=r.revision_id AND a.expected_order_version=r.expected_version AND a.accepted_order_version=r.version AND a.accepted_at=r.occurred_at) AS acceptance_bound " +
          "FROM rms_ordering.order_revision r WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=$3 AND r.version<=$4 ORDER BY r.version LIMIT 10002",
        [brand, store, event.aggregateId, input.sourceVersion],
      );
      if (found.rows.length === 0) return null;
      const root = found.rows[0];
      if (
        !root ||
        root.kind !== "Initial" ||
        root.version !== 1 ||
        root.revision_id !== root.initial_submission_id ||
        root.expected_version !== 0 ||
        root.previous_revision_id !== null
      )
        return fail();
      const revisions = found.rows.slice(1).map((row) => ({
        brandReference: brand,
        storeReference: store,
        orderReference: event.aggregateId,
        revisionReference: row.revision_id,
        previousRevisionReference: row.previous_revision_id,
        expectedVersion: row.expected_version,
        version: row.version,
        occurredAt: instant(row.occurred_at),
        kind: row.kind,
      }));
      const chain = resolveOrderRevisionChain({
        brandReference: brand,
        storeReference: store,
        orderReference: event.aggregateId,
        initialSubmissionReference: root.initial_submission_id,
        createdAt: instant(root.occurred_at),
        revisions,
      });
      if (chain.version < input.sourceVersion) return null;
      if (
        chain.version !== input.sourceVersion ||
        chain.checkpoint !== event.payload.submissionReference ||
        chain.occurredAt !== event.occurredAt ||
        revisions.at(-1)?.kind !== "AdditionalBatch"
      )
        return fail();
      const original = await readOrderCreationHistory(
        tx,
        {
          brandReference: brand,
          storeReference: store,
        },
        parseOrderingReference(root.initial_submission_id),
        options.quoteVersion,
      );
      if (!original) return null;
      if (
        original.order.orderReference !== event.aggregateId ||
        original.order.orderType !== "DineIn" ||
        original.createdAt !== instant(root.occurred_at)
      )
        return fail();
      const records = await tx.query(
        "SELECT snapshot_json::text AS snapshot FROM rms_ordering.additional_dining_batch_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND batch_sequence<=$4 ORDER BY batch_sequence LIMIT 21",
        [brand, store, event.aggregateId, event.payload.batchSequence],
      );
      const additional = records.rows.map((row) =>
        decodeAdditionalDiningBatchSnapshot(row.snapshot),
      );
      if (additional.length !== event.payload.batchSequence - 1) return fail();
      let batchIndex = 0;
      for (let index = 0; index < revisions.length; index++) {
        const revision = revisions[index];
        if (!revision) return fail();
        if (revision.kind === "Acceptance") {
          if (found.rows[index + 1]?.acceptance_bound !== true) return fail();
          continue;
        }
        if (revision.kind !== "AdditionalBatch") return fail();
        const saved = additional[batchIndex++];
        if (
          !saved ||
          saved.expectedOrderVersion !== revision.expectedVersion ||
          saved.batchSequence !== batchIndex + 1 ||
          saved.batch.submissionReference !== revision.revisionReference ||
          saved.batch.submittedAt !== revision.occurredAt ||
          saved.brandReference !== brand ||
          saved.storeReference !== store ||
          saved.orderReference !== event.aggregateId ||
          saved.diningSessionReference !== original.order.diningSessionReference ||
          saved.originalOrderCreatedAt !== original.createdAt
        )
          return fail();
      }
      const last = additional.at(-1);
      if (
        batchIndex !== additional.length ||
        !last ||
        last.batch.orderBatchReference !== event.payload.orderBatchReference ||
        last.items.length !== event.payload.itemCount ||
        "sha256:" +
          createHash("sha256").update(encodeAdditionalDiningBatchSnapshot(last)).digest("hex") !==
          event.payload.sourceSnapshotDigest
      )
        return fail();
      const batches = original.order.batches.map((batch) => ({
        orderBatchReference: batch.orderBatchReference,
        submittedAt: batch.submittedAt,
        items: original.items.filter(
          (item) => item.orderBatchReference === batch.orderBatchReference,
        ),
      }));
      batches.push(
        ...additional.map((saved) => ({
          orderBatchReference: saved.batch.orderBatchReference,
          submittedAt: saved.batch.submittedAt,
          items: [...saved.items],
        })),
      );
      const result = parseOrderStatusSourceSnapshot({
        sourceVersion: input.sourceVersion,
        sourceCheckpoint: event.eventId,
        sourceDigest: event.payload.sourceSnapshotDigest,
        orderReference: event.aggregateId,
        brandReference: brand,
        storeReference: store,
        guestSessionReference: original.guestSessionReference,
        submissionReference: original.submissionReference,
        businessDate: original.orderNumberAllocation.businessDate,
        orderNumber: original.orderNumberAllocation.orderNumber,
        orderType: "DineIn",
        sourceChannel: original.order.sourceChannel,
        // This exact reader rejects revisions outside Initial/Acceptance/AdditionalBatch.
        // Each Acceptance above is bound to its persisted owner record; adding an
        // unpaid Batch must not erase that accepted progress (DEC-PILOT-BATCH-PHASE-01).
        canonicalPhase: revisions.some((revision) => revision.kind === "Acceptance")
          ? "Accepted"
          : "Submitted",
        closureStatus: "Open",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfillmentReference: null,
        fulfillmentCompletionEventReference: null,
        fulfillmentCompletedAt: null,
        eta: null,
        submittedAt: original.createdAt,
        batches: batches.map((batch) => ({
          ...batch,
          items: batch.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            displayName: item.catalog.localizedNames[options.locale],
            quantity: item.quantity,
            lineTotal: item.pricing.total,
          })),
        })),
      });
      if (!(await options.authorize(tx, event))) return fail();
      return result;
    } catch {
      return fail();
    }
  };
}

/** Called only inside the projection store disposition fence after exact history
 * reconstruction. External freshness/authorization validation remains required.
 */
export async function isCurrentSubmittedOrderRevision(
  transaction: ConsumerTransaction,
  source: OrderStatusSourceSnapshot,
  allowNewerRevision = false,
): Promise<boolean> {
  const found = await transaction.query(
    "SELECT r.version,r.kind,a.snapshot_json::text AS snapshot " +
      "FROM rms_ordering.order_revision r LEFT JOIN rms_ordering.additional_dining_batch_record a " +
      "ON a.submission_id=r.revision_id AND a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id " +
      "WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=$3 ORDER BY r.version DESC LIMIT 1",
    [source.brandReference, source.storeReference, source.orderReference],
  );
  const row = found.rows[0];
  if (allowNewerRevision) {
    return (
      found.rows.length === 1 &&
      row !== undefined &&
      typeof row.version === "number" &&
      Number.isSafeInteger(row.version) &&
      row.version > source.sourceVersion
    );
  }
  if (
    found.rows.length !== 1 ||
    !row ||
    row.version !== source.sourceVersion ||
    row.kind !== "AdditionalBatch" ||
    row.snapshot == null
  )
    return false;
  const saved = decodeAdditionalDiningBatchSnapshot(row.snapshot);
  return (
    saved.brandReference === source.brandReference &&
    saved.storeReference === source.storeReference &&
    saved.orderReference === source.orderReference &&
    saved.expectedOrderVersion + 1 === source.sourceVersion &&
    "sha256:" +
      createHash("sha256").update(encodeAdditionalDiningBatchSnapshot(saved)).digest("hex") ===
      source.sourceDigest
  );
}

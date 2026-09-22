import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { resolveOrderRevisionChain } from "../../domain/order-revision-chain.js";
const fail = (): never => {
  throw new Error("ORDER_REVISION_POSITION_UNAVAILABLE");
};
interface Query {
  orderReference: string;
  observedAt: string;
}
/** Complete revision facts, not derived Kitchen/fulfillment/closure status.
 * Caller retains transaction; parent + disposition fences serialize owner writes. */
export function createPostgresOrderRevisionPosition(options: {
  brandReference: string;
  storeReference: string;
  authorize(tx: ConsumerTransaction, query: Query): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return async (tx: ConsumerTransaction, input: Query) => {
    try {
      const query = {
        orderReference: parseOrderingReference(input.orderReference),
        observedAt: parseOrderingInstant(input.observedAt),
      };
      if ((await options.authorize(tx, query)) !== true) return fail();
      const scope = {
        brandReference: brand,
        storeReference: store,
        orderReference: query.orderReference,
      };
      const values = [brand, store, query.orderReference];
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" + values.join(":"),
      ]);
      const header = await tx.query(
        "SELECT order_id::text,created_at FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
        values,
      );
      const parent = header.rows[0];
      if (header.rows.length !== 1 || parent?.order_id !== query.orderReference) return fail();
      const at = (value: unknown) =>
        parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
      const createdAt = at(parent.created_at);
      if (createdAt > query.observedAt) return fail();
      const batches = await tx.query(
        "SELECT order_batch_id::text FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY order_batch_id LIMIT 10002",
        values,
      );
      if (batches.rows.length < 1 || batches.rows.length > 10001) return fail();
      const batchReferences = batches.rows.map((row) => parseOrderingReference(row.order_batch_id));
      if (new Set(batchReferences).size !== batchReferences.length) return fail();
      const rows = (
        await tx.query(
          "SELECT r.revision_id,r.version,r.expected_version,r.previous_revision_id,r.initial_submission_id,r.kind,r.occurred_at," +
            "CASE r.kind WHEN 'Initial' THEN EXISTS (SELECT 1 FROM rms_ordering.order_submission_record s JOIN rms_ordering.order_batch b ON b.submission_id=s.submission_id AND b.brand_id=s.brand_id AND b.store_id=s.store_id AND b.order_id=s.order_id WHERE s.brand_id=r.brand_id AND s.store_id=r.store_id AND s.order_id=r.order_id AND s.submission_id=r.revision_id AND s.submission_kind='Initial' AND b.submitted_at=r.occurred_at) " +
            "WHEN 'Acceptance' THEN EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.acceptance_id=r.revision_id AND a.expected_order_version=r.expected_version AND a.accepted_order_version=r.version AND a.accepted_at=r.occurred_at) " +
            "WHEN 'AdditionalBatch' THEN EXISTS (SELECT 1 FROM rms_ordering.additional_dining_batch_record a JOIN rms_ordering.order_batch b ON b.order_batch_id=a.order_batch_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.order_id=a.order_id AND b.submission_id=a.submission_id WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.submission_id=r.revision_id AND b.submitted_at=r.occurred_at AND a.batch_sequence=(SELECT count(*)+1 FROM rms_ordering.order_revision p WHERE p.brand_id=r.brand_id AND p.store_id=r.store_id AND p.order_id=r.order_id AND p.kind='AdditionalBatch' AND p.version<=r.version)) " +
            "WHEN 'BatchCancellation' THEN EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id AND c.expected_source_checkpoint=r.previous_revision_id AND c.expected_order_version=r.expected_version AND c.cancelled_order_version=r.version AND c.cancelled_at=r.occurred_at) " +
            "WHEN 'Termination' THEN EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=r.brand_id AND t.store_id=r.store_id AND t.order_id=r.order_id AND t.termination_id=r.revision_id AND t.expected_order_version=r.expected_version AND t.terminated_order_version=r.version AND t.expected_source_checkpoint=r.previous_revision_id AND t.terminated_at=r.occurred_at) " +
            "WHEN 'Fulfillment' THEN EXISTS (SELECT 1 FROM rms_ordering.order_fulfillment_completion_record f WHERE f.brand_id=r.brand_id AND f.store_id=r.store_id AND f.order_id=r.order_id AND f.completion_id=r.revision_id AND f.expected_order_version=r.expected_version AND f.fulfilled_order_version=r.version AND f.expected_source_checkpoint=r.previous_revision_id AND f.recorded_at=r.occurred_at) ELSE false END AS operation_bound " +
            "FROM rms_ordering.order_revision r WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=$3 ORDER BY r.version LIMIT 10002",
          values,
        )
      ).rows;
      const root = rows[0];
      if (
        !root ||
        rows.length > 10001 ||
        root.kind !== "Initial" ||
        root.version !== 1 ||
        root.expected_version !== 0 ||
        root.revision_id !== root.initial_submission_id ||
        root.previous_revision_id !== null ||
        at(root.occurred_at) !== createdAt ||
        rows.some((row) => row.operation_bound !== true) ||
        rows.filter((row) => row.kind === "AdditionalBatch").length + 1 !== batchReferences.length
      )
        return fail();
      if (rows.slice(0, -1).some((row) => row.kind === "Termination" || row.kind === "Fulfillment"))
        return fail();
      const revisions = rows.slice(1).map((row) => ({
        ...scope,
        revisionReference: row.revision_id,
        previousRevisionReference: row.previous_revision_id,
        expectedVersion: row.expected_version,
        version: row.version,
        occurredAt: at(row.occurred_at),
        kind: row.kind,
      }));
      const chain = resolveOrderRevisionChain({
        ...scope,
        initialSubmissionReference: root.initial_submission_id,
        createdAt,
        revisions,
      });
      if (chain.occurredAt > query.observedAt || (await options.authorize(tx, query)) !== true)
        return fail();
      const terminal = rows[rows.length - 1];
      return Object.freeze({
        ...scope,
        observedAt: query.observedAt,
        version: chain.version,
        checkpoint: chain.checkpoint,
        occurredAt: chain.occurredAt,
        initialAcceptanceRecorded: rows.some((row) => row.kind === "Acceptance"),
        terminalOperation:
          terminal?.kind === "Termination"
            ? ("Termination" as const)
            : terminal?.kind === "Fulfillment"
              ? ("Fulfillment" as const)
              : null,
        batchReferences: Object.freeze(batchReferences),
        snapshotDigest:
          "sha256:" +
          createHash("sha256")
            .update(
              JSON.stringify([
                scope,
                createdAt,
                batchReferences,
                root.initial_submission_id,
                revisions,
              ]),
            )
            .digest("hex"),
      });
    } catch {
      return fail();
    }
  };
}

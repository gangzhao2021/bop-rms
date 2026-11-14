import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { resolveOrderRevisionChain } from "../../domain/order-revision-chain.js";
import {
  isTerminalOrderRevisionKind,
  persistedOrderRevisionKindPolicy,
  type TerminalOrderRevisionKind,
} from "../../domain/order-revision-kind.js";
import { orderRevisionOperationBoundSql } from "./order-revision-binding.js";
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
      // WP-2423 lock order: fence before the guest authorization's Dining row reads.
      if ((await options.authorize(tx, query)) !== true) return fail();
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
            orderRevisionOperationBoundSql() +
            "FROM rms_ordering.order_revision r WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=$3 ORDER BY r.version LIMIT 10002",
          values,
        )
      ).rows;
      const root = rows[0];
      if (
        !root ||
        rows.length > 10001 ||
        persistedOrderRevisionKindPolicy(root.kind)?.root !== true ||
        root.version !== 1 ||
        root.expected_version !== 0 ||
        root.revision_id !== root.initial_submission_id ||
        root.previous_revision_id !== null ||
        at(root.occurred_at) !== createdAt ||
        rows.some((row) => row.operation_bound !== true) ||
        rows.filter(
          (row) => persistedOrderRevisionKindPolicy(row.kind)?.addsAdditionalBatch === true,
        ).length +
          1 !==
          batchReferences.length
      )
        return fail();
      if (rows.slice(0, -1).some((row) => isTerminalOrderRevisionKind(row.kind))) return fail();
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
        initialAcceptanceRecorded: rows.some(
          (row) => persistedOrderRevisionKindPolicy(row.kind)?.recordsAcceptance === true,
        ),
        terminalOperation: isTerminalOrderRevisionKind(terminal?.kind)
          ? (terminal.kind as TerminalOrderRevisionKind)
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

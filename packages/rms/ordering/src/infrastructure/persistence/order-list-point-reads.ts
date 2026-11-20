import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  orderAcceptanceByBatchStatement,
  orderAcceptanceSelection,
} from "./order-acceptance-store.js";
import {
  orderCreationHistoryStatement,
  orderCreationInitialStatement,
} from "./order-creation-query-store.js";
import { orderInitialPointStatements } from "./order-termination-store.js";
import {
  createSnapshotPointReads,
  pointReadReference,
  type SnapshotPointRead,
} from "./snapshot-point-reads.js";

/** One listed Order: what its readers read it by. */
export interface OrderListPointReadOrder {
  readonly orderReference: string;
  readonly initialBatchReference: string;
  readonly initialSubmissionReference: string;
}

const batchLimit = 10_001;

/**
 * A point read of this Store's rows keyed by values[2] (and values[3] when `twoKeys`), its batch
 * form reading every listed key's rows in one statement.
 */
function storePointRead(
  scope: { readonly brand: string; readonly store: string },
  read: {
    readonly statement: string;
    readonly batchStatement: string;
    readonly keyColumns: readonly string[];
    readonly limit: number | null;
    readonly repeated?: boolean;
    /** The batch's $3: the distinct first parts of the keys. */
    readonly twoKeys?: boolean;
  },
): SnapshotPointRead {
  const width = read.twoKeys === true ? 4 : 3;
  return Object.freeze({
    statement: read.statement,
    batchStatement: read.batchStatement,
    keyColumns: read.keyColumns,
    limit: read.limit,
    maximumRows: batchLimit,
    ...(read.repeated === true ? { repeated: true } : {}),
    key(values: readonly unknown[]) {
      if (values.length !== width || values[0] !== scope.brand || values[1] !== scope.store)
        return null;
      const parts = values.slice(2).map(pointReadReference);
      return parts.every((part) => part !== null) ? parts.join("|") : null;
    },
    batchValues: (keys: readonly string[]) => [
      scope.brand,
      scope.store,
      [...new Set(keys.map((key) => key.split("|")[0]))],
    ],
  });
}

/**
 * Batch 37 (v15 b36): Ordering's point reads of each listed Order on the merchant Orders list —
 * its initial Batch's acceptance, its creation history (read twice: for its Quote version and its
 * current state), its initial window (submission, acceptance, staff item cancellations,
 * termination) and its pickup completion — answered for every listed Order from one read each in
 * the list's read-only snapshot (snapshot-point-reads.ts). The readers and their checks are
 * unchanged; anything else they read runs as before.
 */
export function createOrderListPointReads(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orders: readonly OrderListPointReadOrder[],
): ConsumerTransaction {
  const fixed = {
    brand: parseOrderingReference(scope.brandReference),
    store: parseOrderingReference(scope.storeReference),
  };
  const byOrder = async () => orders.map((order) => order.orderReference);
  const byBatch = async () =>
    orders.map((order) => order.orderReference + "|" + order.initialBatchReference);
  const bySubmission = async () => orders.map((order) => order.initialSubmissionReference);
  const history = orderCreationHistoryStatement;
  const historyTail = " AND s.submission_id=$3 AND s.submission_kind='Initial' LIMIT 2";
  if (!history.startsWith("SELECT jsonb_build_object(") || !history.endsWith(historyTail))
    return transaction;
  const statements = orderInitialPointStatements;
  const byOrderOf = (
    statement: string,
    from: string,
    orderBy: string,
    limit: number | null,
    keyExpression = "order_id",
  ) =>
    storePointRead(fixed, {
      statement,
      batchStatement:
        "SELECT " +
        keyExpression +
        "::text AS prefetch_order," +
        statement.slice("SELECT ".length, statement.indexOf(" FROM ")) +
        from +
        " ORDER BY " +
        orderBy +
        " LIMIT " +
        batchLimit,
      keyColumns: ["prefetch_order"],
      limit,
    });
  return createSnapshotPointReads(transaction, [
    {
      keys: byBatch,
      read: storePointRead(fixed, {
        statement: orderAcceptanceByBatchStatement,
        batchStatement:
          "SELECT order_id::text AS prefetch_order,order_batch_id::text AS prefetch_batch," +
          orderAcceptanceSelection +
          " FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 " +
          "AND order_id=ANY($3::uuid[]) ORDER BY order_id,order_batch_id LIMIT " +
          batchLimit,
        keyColumns: ["prefetch_order", "prefetch_batch"],
        limit: 2,
        twoKeys: true,
      }),
    },
    {
      keys: bySubmission,
      read: storePointRead(fixed, {
        statement: history,
        batchStatement:
          "SELECT s.submission_id::text AS prefetch_order," +
          history.slice("SELECT ".length, history.length - historyTail.length) +
          " AND s.submission_id=ANY($3::uuid[]) AND s.submission_kind='Initial' ORDER BY s.submission_id LIMIT " +
          batchLimit,
        keyColumns: ["prefetch_order"],
        limit: 2,
        repeated: true,
      }),
    },
    {
      keys: bySubmission,
      read: storePointRead(fixed, {
        statement: orderCreationInitialStatement,
        batchStatement:
          "SELECT s.submission_id::text AS prefetch_order,h.order_id AS reference FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_submission_record s ON s.order_id=h.order_id AND s.brand_id=h.brand_id AND s.store_id=h.store_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND s.submission_id=ANY($3::uuid[]) AND s.submission_kind='Initial' " +
          "ORDER BY s.submission_id LIMIT " +
          batchLimit,
        keyColumns: ["prefetch_order"],
        limit: null,
      }),
    },
    {
      keys: byBatch,
      read: storePointRead(fixed, {
        statement: statements.original,
        batchStatement:
          "SELECT h.order_id::text AS prefetch_order,b.order_batch_id::text AS prefetch_batch," +
          "h.aggregate_version,h.canonical_phase,b.submission_id,b.submitted_at FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=ANY($3::uuid[]) " +
          "ORDER BY h.order_id,b.order_batch_id LIMIT " +
          batchLimit,
        keyColumns: ["prefetch_order", "prefetch_batch"],
        limit: null,
        twoKeys: true,
      }),
    },
    {
      keys: byOrder,
      read: byOrderOf(
        statements.accepted,
        " FROM rms_ordering.order_acceptance_record WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        "order_id",
        2,
      ),
    },
    {
      keys: byOrder,
      read: byOrderOf(
        statements.itemCancellations,
        " FROM rms_ordering.order_item_staff_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        "order_id,cancelled_order_version",
        101,
      ),
    },
    {
      keys: byOrder,
      read: byOrderOf(
        statements.terminal,
        " FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        "order_id",
        2,
      ),
    },
    {
      keys: byOrder,
      read: byOrderOf(
        statements.completion,
        " FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        "order_id",
        2,
      ),
    },
    {
      keys: byOrder,
      read: byOrderOf(
        statements.orderType,
        " FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[])",
        "order_id",
        null,
      ),
    },
  ]);
}

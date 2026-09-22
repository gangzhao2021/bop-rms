import { parseOrderBatchCheckoutCancellation } from "../../domain/order-batch-checkout-cancellation.js";
import { createPostgresDiningOrderPreparationSource } from "./order-termination-store.js";
import { createPostgresOrderAcceptanceReader } from "./order-acceptance-store.js";
import { parseOrderingReference } from "../../domain/cart.js";

type Options = Parameters<typeof createPostgresDiningOrderPreparationSource>[0];
type Input = Parameters<
  ReturnType<typeof createPostgresDiningOrderPreparationSource>["resolveCurrent"]
>[0];

/** Complete immutable item membership and per-Batch acceptance under the Order fence.
 * Kitchen progress and serving remain separate owner facts, never inferred here.
 */
export function createPostgresDiningOrderItemStateReader(options: Options) {
  const current = createPostgresDiningOrderPreparationSource(options);
  return Object.freeze({
    async load(input: Input) {
      const state = await current.resolveCurrent(input);
      if (!state) return null;
      const rows = await input.transaction.query(
        "SELECT i.order_item_id,i.order_batch_id,i.quantity,s.submission_kind,a.batch_sequence FROM rms_ordering.order_batch b " +
          "JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id " +
          "LEFT JOIN rms_ordering.additional_dining_batch_record a ON a.brand_id=b.brand_id AND a.store_id=b.store_id AND a.order_id=b.order_id AND a.order_batch_id=b.order_batch_id AND a.submission_id=b.submission_id " +
          "LEFT JOIN rms_ordering.order_item i ON i.brand_id=b.brand_id AND i.store_id=b.store_id AND i.order_id=b.order_id AND i.order_batch_id=b.order_batch_id " +
          "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 ORDER BY b.order_batch_id,i.order_item_id LIMIT 10001",
        [state.brandReference, state.storeReference, state.orderReference],
      );
      if (!rows.rows.length || rows.rows.length > 10000)
        throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
      const seen = new Set<string>();
      const batches = new Map<string, string[]>();
      const sequences = new Map<string, number>();
      const quantities = new Map<string, number>();
      for (const row of rows.rows) {
        const item = parseOrderingReference(row.order_item_id);
        const batch = parseOrderingReference(row.order_batch_id);
        if (
          seen.has(item) ||
          typeof row.quantity !== "number" ||
          !Number.isSafeInteger(row.quantity) ||
          row.quantity < 1 ||
          row.quantity > 999
        )
          throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
        const sequence =
          row.submission_kind === "Initial" && row.batch_sequence === null
            ? 1
            : row.submission_kind === "Additional"
              ? row.batch_sequence
              : null;
        if (
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          sequence < (row.submission_kind === "Additional" ? 2 : 1) ||
          (sequences.has(batch) && sequences.get(batch) !== sequence)
        )
          throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
        sequences.set(batch, sequence);
        quantities.set(item, row.quantity);
        seen.add(item);
        const items = batches.get(batch) ?? [];
        items.push(item);
        batches.set(batch, items);
      }
      const cancelled = await input.transaction.query(
        'SELECT cancellation_id AS "cancellationReference",operation_id AS "operationReference",tenant_id AS "tenantReference",brand_id AS "brandReference",store_id AS "storeReference",order_id AS "orderReference",order_batch_id AS "orderBatchReference",submission_id AS "submissionReference",payment_operation_id AS "paymentOperationReference",expiry_record_id AS "expiryRecordReference",expiry_evidence_digest AS "expiryEvidenceDigest",expected_order_version AS "expectedOrderVersion",cancelled_order_version AS "cancelledOrderVersion",expected_source_checkpoint AS "expectedSourceCheckpoint",workflow_version_id AS "workflowVersionReference",transition_id AS "transitionReference",order_item_ids AS "orderItemReferences",cancelled_at AS "cancelledAt",phase AS "phase",reason_code AS "reasonCode" FROM rms_ordering.order_batch_checkout_cancellation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY cancelled_order_version LIMIT 10001',
        [state.brandReference, state.storeReference, state.orderReference],
      );
      if (cancelled.rows.length > batches.size) throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
      const cancellations = new Map<
        string,
        ReturnType<typeof parseOrderBatchCheckoutCancellation>
      >();
      for (const row of cancelled.rows) {
        const record = parseOrderBatchCheckoutCancellation({
          ...row,
          cancelledAt:
            row.cancelledAt instanceof Date ? row.cancelledAt.toISOString() : row.cancelledAt,
        });
        const members = batches.get(record.orderBatchReference);
        if (
          record.brandReference !== state.brandReference ||
          record.storeReference !== state.storeReference ||
          record.orderReference !== state.orderReference ||
          record.cancelledOrderVersion > state.orderVersion ||
          record.cancelledAt > input.observedAt ||
          cancellations.has(record.orderBatchReference) ||
          !members ||
          members.length !== record.orderItemReferences.length ||
          members.some((member, index) => member !== record.orderItemReferences[index])
        )
          throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
        cancellations.set(record.orderBatchReference, record);
      }
      const acceptanceReader = createPostgresOrderAcceptanceReader({
        brandReference: state.brandReference,
        storeReference: state.storeReference,
        authorize: (tx) => options.authorize(tx, input),
      });
      if (
        new Set(sequences.values()).size !== sequences.size ||
        ![...sequences.values()].includes(1)
      )
        throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
      const batchStates = [];
      const items = [];
      for (const [orderBatchReference, members] of batches) {
        const acceptance = await acceptanceReader.loadByBatch({
          transaction: input.transaction,
          orderReference: state.orderReference,
          orderBatchReference,
        });
        const cancellation = cancellations.get(orderBatchReference) ?? null;
        if (acceptance && cancellation) throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
        if (
          acceptance &&
          (acceptance.acceptedOrderVersion > state.orderVersion ||
            acceptance.acceptedAt > input.observedAt)
        )
          throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
        batchStates.push(
          Object.freeze({
            orderBatchReference,
            sequence: sequences.get(orderBatchReference) as number,
            acceptance,
            cancellation,
          }),
        );
        for (const orderItemReference of members) {
          const orderedQuantity = quantities.get(orderItemReference);
          if (orderedQuantity === undefined) throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
          items.push(
            Object.freeze({
              orderItemReference,
              orderBatchReference,
              acceptance,
              cancellation,
              orderedQuantity,
            }),
          );
        }
      }
      if ((await options.authorize(input.transaction, input)) !== true)
        throw new Error("ORDER_ITEM_STATE_UNAVAILABLE");
      return Object.freeze({
        ...state,
        items: Object.freeze(items),
        batches: Object.freeze(batchStates.sort((a, b) => a.sequence - b.sequence)),
      });
    },
  });
}

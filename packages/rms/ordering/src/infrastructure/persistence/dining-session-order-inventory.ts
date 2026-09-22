import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
interface Query {
  readonly diningSessionReference: string;
  readonly observedAt: string;
}
/** Caller retains the Dining admission fence before invoking this source and until
 * its outer transaction ends. Parent locks fence batch additions; this inventory
 * conveys no execution or financial finality and cannot authorize closing itself. */
export function createPostgresDiningSessionOrderInventory(options: {
  brandReference: string;
  storeReference: string;
  authorizeAndFence(transaction: ConsumerTransaction, query: Query): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  const fail = (): never => {
    throw new Error("DINING_ORDER_INVENTORY_UNAVAILABLE");
  };
  return Object.freeze({
    async load(tx: ConsumerTransaction, input: Query) {
      try {
        const query = Object.freeze({
          diningSessionReference: parseOrderingReference(input.diningSessionReference),
          observedAt: parseOrderingInstant(input.observedAt),
        });
        if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const parents = await tx.query<{ order_id: string; created_at: Date }>(
          "SELECT order_id::text,created_at FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3 AND order_type='DineIn' ORDER BY order_id LIMIT 1001 FOR UPDATE",
          [brand, store, query.diningSessionReference],
        );
        if (parents.rows.length > 1000) return fail();
        const seen = new Set<string>();
        const orders = [];
        for (const parent of parents.rows) {
          const orderReference = parseOrderingReference(parent.order_id);
          if (
            seen.has(orderReference) ||
            !(parent.created_at instanceof Date) ||
            !Number.isFinite(parent.created_at.getTime()) ||
            parent.created_at.toISOString() > query.observedAt
          )
            return fail();
          seen.add(orderReference);
          const found = await tx.query<{
            order_batch_id: string;
            submission_id: string;
            quote_id: string;
            submitted_at: Date;
            submission_kind: string | null;
            bound: boolean;
          }>(
            `SELECT b.order_batch_id::text,b.submission_id::text,b.quote_id::text,b.submitted_at,s.submission_kind,
      (s.submission_id IS NOT NULL AND s.source_cart_id=b.source_cart_id AND s.source_cart_version=b.source_cart_version AND s.quote_id=b.quote_id AND s.created_at=b.submitted_at) AS bound
      FROM rms_ordering.order_batch b LEFT JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id
      WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 ORDER BY b.submitted_at,b.order_batch_id LIMIT 1001`,
            [brand, store, orderReference],
          );
          if (found.rows.length === 0 || found.rows.length > 1000) return fail();
          const batches = found.rows.map((row) => {
            if (
              row.bound !== true ||
              !["Initial", "Additional"].includes(row.submission_kind ?? "") ||
              !(row.submitted_at instanceof Date) ||
              !Number.isFinite(row.submitted_at.getTime()) ||
              row.submitted_at.toISOString() > query.observedAt ||
              row.submitted_at < parent.created_at
            )
              return fail();
            return Object.freeze({
              orderBatchReference: parseOrderingReference(row.order_batch_id),
              submissionReference: parseOrderingReference(row.submission_id),
              quoteReference: parseOrderingReference(row.quote_id),
              kind: row.submission_kind as "Initial" | "Additional",
              submittedAt: parseOrderingInstant(row.submitted_at.toISOString()),
            });
          });
          if (
            batches.filter((batch) => batch.kind === "Initial").length !== 1 ||
            batches[0]?.kind !== "Initial" ||
            new Set(batches.map((batch) => batch.orderBatchReference)).size !== batches.length ||
            new Set(batches.map((batch) => batch.submissionReference)).size !== batches.length
          )
            return fail();
          orders.push(Object.freeze({ orderReference, batches: Object.freeze(batches) }));
        }
        if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        return Object.freeze({
          ...query,
          brandReference: brand,
          storeReference: store,
          orders: Object.freeze(orders),
        });
      } catch {
        return fail();
      }
    },
  });
}

/** Stable amendment position only; caller retains current Order/closure authority.
 * Order and amendment parent UPDATE locks fence their FK-bound inserts. Applied price
 * changes must still enter balance reconciliation; zero pending is not closure. */
export function createPostgresOrderAmendmentPosition(options: {
  brandReference: string;
  storeReference: string;
  authorizeAndFence(
    tx: ConsumerTransaction,
    query: { orderReference: string; observedAt: string },
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  const fail = (): never => {
    throw new Error("ORDER_AMENDMENT_POSITION_UNAVAILABLE");
  };
  return Object.freeze({
    async load(tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) {
      try {
        const query = Object.freeze({
          orderReference: parseOrderingReference(input.orderReference),
          observedAt: parseOrderingInstant(input.observedAt),
        });
        if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const parent = await tx.query<{ order_id: string; created_at: Date }>(
          "SELECT order_id::text,created_at FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
          [brand, store, query.orderReference],
        );
        const header = parent.rows[0];
        if (
          parent.rows.length !== 1 ||
          header?.order_id !== query.orderReference ||
          !(header.created_at instanceof Date) ||
          !Number.isFinite(header.created_at.getTime()) ||
          header.created_at.toISOString() > query.observedAt
        )
          return fail();
        const locked = await tx.query<{ amendment_id: string }>(
          "SELECT amendment_id::text FROM rms_ordering.order_amendment WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY amendment_id LIMIT 1001 FOR UPDATE",
          [brand, store, query.orderReference],
        );
        if (locked.rows.length > 1000) return fail();
        const lockedReferences = locked.rows.map((row) => parseOrderingReference(row.amendment_id));
        if (new Set(lockedReferences).size !== lockedReferences.length) return fail();
        const result = await tx.query<{
          amendment_id: string;
          quote_id: string;
          delta_minor: string;
          currency_code: string;
          original_total_minor: string;
          revised_total_minor: string;
          requested_at: Date;
          status: string | null;
          version: number | null;
          occurred_at: Date | null;
          history_count: string;
          minimum_version: number | null;
          future_history: boolean;
        }>(
          `SELECT a.amendment_id::text,a.quote_id::text,a.delta_minor::text,a.currency_code,a.original_total_minor::text,a.revised_total_minor::text,a.requested_at,s.status,s.aggregate_version AS version,s.occurred_at,
     (SELECT count(*)::text FROM rms_ordering.order_amendment_state_record h WHERE h.amendment_id=a.amendment_id AND h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id) AS history_count,
     (SELECT min(aggregate_version) FROM rms_ordering.order_amendment_state_record h WHERE h.amendment_id=a.amendment_id AND h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id) AS minimum_version,
     EXISTS(SELECT 1 FROM rms_ordering.order_amendment_state_record h WHERE h.amendment_id=a.amendment_id AND h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id AND (h.occurred_at>$4::timestamptz OR h.occurred_at<a.requested_at)) AS future_history
     FROM rms_ordering.order_amendment a LEFT JOIN LATERAL(SELECT status,aggregate_version,occurred_at FROM rms_ordering.order_amendment_state_record h WHERE h.amendment_id=a.amendment_id AND h.brand_id=a.brand_id AND h.store_id=a.store_id AND h.order_id=a.order_id ORDER BY aggregate_version DESC LIMIT 1)s ON true
     WHERE a.brand_id=$1 AND a.store_id=$2 AND a.order_id=$3 ORDER BY a.amendment_id LIMIT 1001`,
          [brand, store, query.orderReference, query.observedAt],
        );
        if (
          result.rows.length !== lockedReferences.length ||
          result.rows.some((row, index) => row.amendment_id !== lockedReferences[index])
        )
          return fail();
        const seen = new Set<string>();
        let appliedDeltaMinor = 0n;
        const amendments = result.rows.map((row) => {
          const reference = parseOrderingReference(row.amendment_id);
          if (
            seen.has(reference) ||
            !Number.isSafeInteger(row.version) ||
            (row.version ?? 0) < 1 ||
            row.minimum_version !== 1 ||
            String(row.version) !== row.history_count ||
            row.future_history !== false ||
            !(row.requested_at instanceof Date) ||
            !Number.isFinite(row.requested_at.getTime()) ||
            row.requested_at.toISOString() > query.observedAt ||
            !(row.occurred_at instanceof Date) ||
            !Number.isFinite(row.occurred_at.getTime()) ||
            row.occurred_at < row.requested_at ||
            row.occurred_at.toISOString() > query.observedAt ||
            !["PendingKitchen", "PendingApproval", "Applied", "Rejected", "Aborted"].includes(
              row.status ?? "",
            ) ||
            !/^-?(?:0|[1-9][0-9]*)$/u.test(row.delta_minor)
          )
            return fail();
          if (
            row.currency_code !== "CAD" ||
            !/^(?:0|[1-9][0-9]*)$/u.test(row.original_total_minor) ||
            !/^(?:0|[1-9][0-9]*)$/u.test(row.revised_total_minor)
          )
            return fail();
          const original = BigInt(row.original_total_minor),
            revised = BigInt(row.revised_total_minor);
          const delta = BigInt(row.delta_minor);
          if (
            revised - original !== delta ||
            original > 9223372036854775807n ||
            revised > 9223372036854775807n
          )
            return fail();
          if (delta < -9223372036854775807n || delta > 9223372036854775807n) return fail();
          if (row.status === "Applied") appliedDeltaMinor += delta;
          seen.add(reference);
          return Object.freeze({
            amendmentReference: reference,
            quoteReference: parseOrderingReference(row.quote_id),
            deltaMinor: row.delta_minor,
            currencyCode: "CAD" as const,
            originalTotalMinor: row.original_total_minor,
            revisedTotalMinor: row.revised_total_minor,
            version: row.version as number,
            status: row.status as
              "PendingKitchen" | "PendingApproval" | "Applied" | "Rejected" | "Aborted",
            stateRecordedAt: row.occurred_at.toISOString(),
          });
        });
        if ((await options.authorizeAndFence(tx, query)) !== true) return fail();
        return Object.freeze({
          ...query,
          brandReference: brand,
          storeReference: store,
          amendments: Object.freeze(amendments),
          appliedDeltaMinor,
          pendingCount: amendments.filter(
            (a) => a.status === "PendingKitchen" || a.status === "PendingApproval",
          ).length,
        });
      } catch {
        return fail();
      }
    },
  });
}

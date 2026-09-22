import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  parseOrderStatusProjection,
  OrderStatusProjectionError,
  type OrderStatusProjection,
} from "../../domain/order-status-projection.js";
import {
  encodeOrderStatusSnapshot,
  decodeOrderStatusSnapshot,
} from "../../application/order-status-snapshot-codec.js";

type Scope = Readonly<{ brandReference: string; storeReference: string; orderReference: string }>;
function fail(conflict = false): never {
  throw new OrderStatusProjectionError(
    conflict ? "ORDER_STATUS_VERSION_CONFLICT" : "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
  );
}
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));

/** Internal transactions stay with the caller; only Ordering owns these derived generations. */
export function createPostgresOrderStatusProjectionStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    scope: Scope & { access: "Load" | "Replace" },
  ): Promise<boolean>;
  validateCurrentSource(
    transaction: ConsumerTransaction,
    projection: OrderStatusProjection,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  async function fence(tx: ConsumerTransaction, scope: Scope, access: "Load" | "Replace") {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    if ((await options.authorize(tx, { ...scope, access })) !== true)
      throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + scope.orderReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingStatusProjection:" + brand + ":" + store + ":" + scope.orderReference,
    ]);
  }
  async function current(tx: ConsumerTransaction, scope: Scope) {
    const result = await tx.query(
      "SELECT g.generation_id,g.brand_id,g.store_id,g.order_id,g.projection_name,g.projection_version," +
        "g.source_version,g.source_checkpoint,g.projected_at,g.freshness_status,g.customer_guest_session_id," +
        "g.order_number,g.submitted_at,g.projection_snapshot_json::text AS snapshot " +
        "FROM rms_ordering.order_status_projection p JOIN rms_ordering.order_status_projection_generation g " +
        "ON g.generation_id=p.generation_id AND g.order_id=p.order_id AND g.brand_id=p.brand_id AND g.store_id=p.store_id " +
        "AND g.source_version=p.source_version AND g.source_checkpoint=p.source_checkpoint " +
        "WHERE p.brand_id=$1 AND p.store_id=$2 AND p.order_id=$3 LIMIT 2",
      [brand, store, scope.orderReference],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return fail();
    const row = result.rows[0];
    if (!row) return fail();
    const snapshot = decodeOrderStatusSnapshot(row.snapshot);
    if (
      row.brand_id !== brand ||
      row.store_id !== store ||
      row.order_id !== scope.orderReference ||
      snapshot.brandReference !== brand ||
      snapshot.storeReference !== store ||
      snapshot.orderReference !== scope.orderReference ||
      snapshot.sourceVersion !== row.source_version ||
      snapshot.sourceCheckpoint !== row.source_checkpoint ||
      snapshot.guestSessionReference !== row.customer_guest_session_id ||
      snapshot.orderNumber !== row.order_number ||
      snapshot.submittedAt !== iso(row.submitted_at)
    )
      return fail();
    return parseOrderStatusProjection({
      projectionName: row.projection_name,
      projectionVersion: row.projection_version,
      generationReference: row.generation_id,
      projectedAt: iso(row.projected_at),
      freshnessStatus: row.freshness_status,
      snapshot,
    });
  }
  return Object.freeze({
    async load(input: { transaction: ConsumerTransaction; orderReference: string }) {
      const scope = {
        brandReference: brand,
        storeReference: store,
        orderReference: parseOrderingReference(input.orderReference),
      };
      await fence(input.transaction, scope, "Load");
      return current(input.transaction, scope);
    },
    async replace(input: { transaction: ConsumerTransaction; projection: unknown }) {
      const projection = parseOrderStatusProjection(input.projection),
        snapshot = projection.snapshot,
        tx = input.transaction;
      if (snapshot.brandReference !== brand || snapshot.storeReference !== store) return fail();
      const scope = {
        brandReference: brand,
        storeReference: store,
        orderReference: snapshot.orderReference,
      };
      await fence(tx, scope, "Replace");
      const prior = await current(tx, scope);
      if (prior && prior.snapshot.sourceVersion >= snapshot.sourceVersion) {
        if (json(prior) === json(projection)) return prior;
        return fail(true);
      }
      if (
        prior &&
        (projection.projectedAt < prior.projectedAt ||
          snapshot.guestSessionReference !== prior.snapshot.guestSessionReference ||
          snapshot.submissionReference !== prior.snapshot.submissionReference ||
          snapshot.orderNumber !== prior.snapshot.orderNumber ||
          snapshot.submittedAt !== prior.snapshot.submittedAt)
      )
        return fail(true);
      if ((await options.validateCurrentSource(tx, projection)) !== true) return fail();
      await tx.query("SAVEPOINT ordering_status_projection", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_status_projection_generation " +
            "(generation_id,brand_id,store_id,order_id,projection_name,projection_version,source_version,source_checkpoint," +
            "projected_at,freshness_status,customer_guest_session_id,order_number,submitted_at,projection_snapshot_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            projection.generationReference,
            brand,
            store,
            snapshot.orderReference,
            projection.projectionName,
            projection.projectionVersion,
            snapshot.sourceVersion,
            snapshot.sourceCheckpoint,
            projection.projectedAt,
            projection.freshnessStatus,
            snapshot.guestSessionReference,
            snapshot.orderNumber,
            snapshot.submittedAt,
            encodeOrderStatusSnapshot(snapshot),
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        const advanced = await tx.query(
          "INSERT INTO rms_ordering.order_status_projection (order_id,brand_id,store_id,generation_id,source_version,source_checkpoint,projected_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id) DO UPDATE SET generation_id=EXCLUDED.generation_id," +
            "source_version=EXCLUDED.source_version,source_checkpoint=EXCLUDED.source_checkpoint,projected_at=EXCLUDED.projected_at " +
            "WHERE rms_ordering.order_status_projection.brand_id=EXCLUDED.brand_id AND rms_ordering.order_status_projection.store_id=EXCLUDED.store_id " +
            "AND rms_ordering.order_status_projection.source_version<EXCLUDED.source_version",
          [
            snapshot.orderReference,
            brand,
            store,
            projection.generationReference,
            snapshot.sourceVersion,
            snapshot.sourceCheckpoint,
            projection.projectedAt,
          ],
        );
        if (advanced.rowCount !== 1) return fail(true);
        await tx.query("RELEASE SAVEPOINT ordering_status_projection", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_status_projection", []);
        await tx.query("RELEASE SAVEPOINT ordering_status_projection", []);
        return fail();
      }
      return projection;
    },
  });
}

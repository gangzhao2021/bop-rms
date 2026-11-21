import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingReference } from "../../domain/cart.js";
import {
  parseCheckoutDetailsSnapshot,
  type CheckoutDetailsSnapshot,
} from "../../domain/checkout-details.js";
import type { CartQueryTransaction, CartQueryTransactionRunner } from "./cart-query-store.js";
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function conflict(): never {
  throw new CartError("CART_VERSION_CONFLICT");
}
function rows(value: unknown): Record<string, unknown>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    return fail();
  return value.rows as Record<string, unknown>[];
}
function decode(value: unknown): CheckoutDetailsSnapshot {
  const row = readClosedRecord(value, ["snapshot_json", "recorded_at"], "ACTOR_SHAPE_INVALID");
  const parsed = parseCheckoutDetailsSnapshot(row.snapshot_json);
  if (row.recorded_at !== parsed.recordedAt) return fail();
  return parsed;
}
const columns = `snapshot_json,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at`;
/** Internal repository capability. The application must authorize current Guest/CSRF and policy. */
export function createPostgresCheckoutDetailsStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const raw = readClosedRecord(scope, ["brandReference", "storeReference"], "ACTOR_SHAPE_INVALID");
  const brand = parseOrderingReference(raw.brandReference),
    store = parseOrderingReference(raw.storeReference);
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>): Promise<T> {
    return runner.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      return action(tx);
    });
  }
  async function resolve(tx: CartQueryTransaction, operation: string, guest: string) {
    const result = rows(
      await tx.query(
        "SELECT " +
          columns +
          " FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 AND guest_session_id=$4",
        [brand, store, operation, guest],
      ),
    );
    if (result.length > 1) return fail();
    if (result.length === 0) return null;
    const snapshot = decode(result[0]);
    if (
      snapshot.brandReference !== brand ||
      snapshot.storeReference !== store ||
      snapshot.guestSessionReference !== guest
    )
      return fail();
    return snapshot;
  }
  return Object.freeze({
    /** Current selection only; original Order recovery must use its immutable linked revision. */
    async loadLatest(cartReference: string, guestSessionReference: string) {
      try {
        const cart = parseOrderingReference(cartReference);
        const guest = parseOrderingReference(guestSessionReference);
        return await run(async (tx) => {
          const result = rows(
            await tx.query(
              "SELECT " +
                columns +
                " FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND guest_session_id=$4 ORDER BY details_version DESC LIMIT 1",
              [brand, store, cart, guest],
            ),
          );
          if (result.length > 1) return fail();
          if (result.length === 0) return null;
          const snapshot = decode(result[0]);
          if (
            snapshot.brandReference !== brand ||
            snapshot.storeReference !== store ||
            snapshot.cartReference !== cart ||
            snapshot.guestSessionReference !== guest
          )
            return fail();
          return snapshot;
        });
      } catch {
        return fail();
      }
    },
    async resolveOperation(operationReference: string, guestSessionReference: string) {
      try {
        return await run((tx) =>
          resolve(
            tx,
            parseOrderingReference(operationReference),
            parseOrderingReference(guestSessionReference),
          ),
        );
      } catch {
        return fail();
      }
    },
    async save(
      input: Readonly<{
        operationReference: string;
        expectedVersion: number;
        snapshot: CheckoutDetailsSnapshot;
        audit: unknown;
      }>,
    ) {
      try {
        const rawInput = readClosedRecord(
          input,
          ["operationReference", "expectedVersion", "snapshot", "audit"],
          "ACTOR_SHAPE_INVALID",
        );
        const next = parseCheckoutDetailsSnapshot(rawInput.snapshot);
        const operation = parseOrderingReference(rawInput.operationReference);
        if (
          next.brandReference !== brand ||
          next.storeReference !== store ||
          rawInput.expectedVersion !== next.detailsVersion - 1
        )
          return conflict();
        const auditRaw = readClosedRecord(
          rawInput.audit,
          [
            "auditId",
            "brandId",
            "storeId",
            "actor",
            "actionCode",
            "reasonCode",
            "targetType",
            "targetId",
            "occurredAt",
            "correlationId",
            "sourceChannel",
            "dataClassification",
            "retentionPolicyCode",
            "retentionPolicyVersion",
          ],
          "ACTOR_SHAPE_INVALID",
        );
        const actor = readClosedRecord(auditRaw.actor, ["type"], "ACTOR_SHAPE_INVALID");
        const audit = validateAuditRecord(
          { ...auditRaw, actor: { ...actor } },
          Date.parse(next.recordedAt),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_CHECKOUT_DETAILS_SAVE" ||
          audit.reasonCode !== "AUTHORIZED_CHECKOUT_UPDATE" ||
          audit.targetType !== "CheckoutDetails" ||
          audit.targetId !== next.detailsReference ||
          audit.occurredAt !== next.recordedAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        return await run(async (tx) => {
          const locked = rows(
            await tx.query(
              "SELECT cart_id,aggregate_version,order_type,lifecycle_status FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
              [brand, store, next.cartReference],
            ),
          );
          if (locked.length !== 1) return fail();
          const prior = await resolve(tx, operation, next.guestSessionReference);
          if (prior !== null) {
            if (
              JSON.stringify({ ...prior, recordedAt: next.recordedAt }) !== JSON.stringify(next) ||
              next.recordedAt < prior.recordedAt
            )
              throw new CartError("CART_IDEMPOTENCY_CONFLICT");
            return Object.freeze({ status: "AlreadySaved" as const, snapshot: prior });
          }
          const currentCart = locked[0];
          if (
            Number(currentCart?.aggregate_version) !== next.cartVersion ||
            currentCart?.order_type !== next.orderType ||
            currentCart?.lifecycle_status !== "Active"
          )
            return conflict();
          const latestRows = rows(
            await tx.query(
              "SELECT " +
                columns +
                " FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND guest_session_id=$4 ORDER BY details_version DESC LIMIT 1",
              [brand, store, next.cartReference, next.guestSessionReference],
            ),
          );
          const latest = latestRows.length === 0 ? null : decode(latestRows[0]);
          if (
            (latest?.detailsVersion ?? 0) !== rawInput.expectedVersion ||
            (latest !== null &&
              (latest.detailsReference !== next.detailsReference ||
                latest.recordedAt > next.recordedAt))
          )
            return conflict();
          const inserted = rows(
            await tx.query(
              `INSERT INTO rms_ordering.checkout_details_record
            (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING details_id`,
              [
                brand,
                store,
                next.detailsReference,
                next.detailsVersion,
                operation,
                next.guestSessionReference,
                next.cartReference,
                JSON.stringify(next),
                next.recordedAt,
              ],
            ),
          );
          if (inserted.length !== 1 || inserted[0]?.details_id !== next.detailsReference)
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Saved" as const, snapshot: next });
        });
      } catch (error) {
        if (
          error instanceof CartError &&
          ["CART_VERSION_CONFLICT", "CART_IDEMPOTENCY_CONFLICT"].includes(error.code)
        )
          throw error;
        return fail();
      }
    },
  });
}

import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import type {
  CartLifecycleCommandPorts,
  CartLifecycleOperationRecord,
} from "../../application/ports/cart-lifecycle-command-ports.js";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { expireCartLifecycle, terminateCartLifecycle } from "../../domain/cart-lifecycle.js";
import {
  decodeCartAggregateRow,
  type CustomerCartDatabaseRunner,
  type CustomerCartDatabaseTransaction,
} from "./customer-cart-store.js";

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  const result = object(value).rows;
  if (!Array.isArray(result)) return unavailable();
  return result.map(object);
}
function instant(value: unknown) {
  if (typeof value !== "string") return unavailable();
  return parseOrderingInstant(new Date(value).toISOString());
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function normalize(
  record: CartLifecycleOperationRecord,
  brand: string,
  store: string,
): CartLifecycleOperationRecord {
  const result = parseCartAggregate(record.result);
  const occurredAt = parseOrderingInstant(record.occurredAt);
  const expiresAt = parseOrderingInstant(record.expiresAt);
  const guestSessionReference =
    record.guestSessionReference === null
      ? null
      : parseOrderingReference(record.guestSessionReference);
  if (
    !["Abandon", "Expire"].includes(record.action) ||
    result.brandReference !== brand ||
    result.storeReference !== store ||
    result.cartReference !== parseOrderingReference(record.cartReference) ||
    result.aggregateVersion < 2 ||
    result.updatedAt !== occurredAt ||
    Date.parse(expiresAt) - Date.parse(occurredAt) !== 86_400_000 ||
    result.lifecycle?.status !== (record.action === "Abandon" ? "Abandoned" : "Expired") ||
    result.lifecycle.terminalAt !== occurredAt ||
    (record.action === "Abandon") !== (guestSessionReference !== null) ||
    (record.action === "Abandon" &&
      result.orderType === "Pickup" &&
      guestSessionReference !== result.createdByActorReference)
  )
    return unavailable();
  return Object.freeze({
    action: record.action,
    operationReference: parseOrderingReference(record.operationReference),
    operationIntentHash: parseOrderingHash(record.operationIntentHash),
    guestSessionReference,
    cartReference: result.cartReference,
    result,
    occurredAt,
    expiresAt,
  });
}
function audit(input: AppendAuditRecordInput, record: CartLifecycleOperationRecord) {
  const value = validateAuditRecord(input, Date.parse(record.occurredAt));
  if (
    value.brandId !== record.result.brandReference ||
    value.storeId !== record.result.storeReference ||
    value.targetId !== record.cartReference ||
    value.targetType !== "OrderingCart" ||
    value.actor.type !== "System" ||
    value.actionCode !== `ORDERING_CART_${record.action.toUpperCase()}` ||
    value.occurredAt !== record.occurredAt ||
    value.reasonCode !==
      (record.action === "Abandon" ? "AUTHORIZED_CART_ABANDONMENT" : "CART_DEADLINE_REACHED") ||
    value.sourceChannel !== (record.action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM") ||
    value.dataClassification !== "Restricted" ||
    value.beforeSummary !== undefined ||
    value.afterSummary !== undefined
  )
    return unavailable();
}
function transition(current: CartAggregate, record: CartLifecycleOperationRecord) {
  if (Date.parse(record.occurredAt) < Date.parse(current.updatedAt)) return unavailable();
  const lifecycle =
    record.action === "Abandon"
      ? terminateCartLifecycle(current.lifecycle, {
          status: "Abandoned",
          terminalAt: record.occurredAt,
        })
      : expireCartLifecycle(current.lifecycle, record.occurredAt);
  const expected = parseCartAggregate({
    ...current,
    aggregateVersion: current.aggregateVersion + 1,
    updatedAt: record.occurredAt,
    lifecycle,
  });
  if (!same(expected, record.result)) return unavailable();
}

/** Optional Ordering persistence; authorized application commands supply policy and actor evidence. */
export function createPostgresCartLifecycleStore(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly runner: CustomerCartDatabaseRunner;
}): CartLifecycleCommandPorts["repository"] {
  const brand = parseOrderingReference(input.brandReference);
  const store = parseOrderingReference(input.storeReference);
  async function run<T>(action: (tx: CustomerCartDatabaseTransaction) => Promise<T>): Promise<T> {
    try {
      return await input.runner.run(action);
    } catch (error) {
      if (
        error instanceof CartError &&
        [
          "CART_VERSION_CONFLICT",
          "CART_IDEMPOTENCY_CONFLICT",
          "CART_EXPIRATION_NOT_DUE",
          "CART_EXPIRED",
          "CART_ABANDONED",
          "CART_LIFECYCLE_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      return unavailable();
    }
  }
  async function load(tx: CustomerCartDatabaseTransaction, cartReference: string) {
    parseOrderingReference(cartReference);
    const result = rows(
      await tx.query(
        `SELECT to_jsonb(c) AS cart FROM rms_ordering.cart c
      WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 FOR UPDATE`,
        [brand, store, cartReference],
      ),
    );
    if (result.length === 0) return null;
    if (result.length !== 1) return unavailable();
    // The Cart lock must precede the line snapshot, including for standalone loads.
    const lines = rows(
      await tx.query(
        `SELECT to_jsonb(l) AS line FROM rms_ordering.cart_line l
      WHERE brand_id = $1 AND store_id = $2 AND cart_id = $3 ORDER BY added_at, cart_line_id LIMIT 101`,
        [brand, store, cartReference],
      ),
    );
    const cart = decodeCartAggregateRow({ ...result[0], lines: lines.map((line) => line.line) });
    if (
      cart.brandReference !== brand ||
      cart.storeReference !== store ||
      cart.cartReference !== cartReference
    )
      return unavailable();
    return cart;
  }
  async function resolve(tx: CustomerCartDatabaseTransaction, operationReference: string) {
    parseOrderingReference(operationReference);
    const result = rows(
      await tx.query(
        `SELECT to_jsonb(r) AS record FROM rms_ordering.cart_lifecycle_operation_record r WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`,
        [brand, store, operationReference],
      ),
    );
    if (result.length === 0) return null;
    if (result.length !== 1) return unavailable();
    const row = object(result[0]?.record);
    const record = normalize(
      {
        action: row.action_code as CartLifecycleOperationRecord["action"],
        operationReference: parseOrderingReference(row.operation_id),
        operationIntentHash: parseOrderingHash(row.intent_digest),
        guestSessionReference:
          row.guest_session_id === null ? null : parseOrderingReference(row.guest_session_id),
        cartReference: parseOrderingReference(row.cart_id),
        result: parseCartAggregate(row.result_cart_snapshot_json),
        occurredAt: instant(row.occurred_at),
        expiresAt: instant(row.expires_at),
      },
      brand,
      store,
    );
    if (
      row.brand_id !== brand ||
      row.store_id !== store ||
      record.operationReference !== operationReference ||
      row.result_aggregate_version !== record.result.aggregateVersion
    )
      return unavailable();
    return record;
  }
  return Object.freeze({
    load: (reference) => run((tx) => load(tx, reference)),
    resolveOperation: (reference) => run((tx) => resolve(tx, reference)),
    commit: (command) =>
      run(async (tx) => {
        const record = normalize(command.record, brand, store);
        const next = record.result;
        audit(command.audit, record);
        if (
          !Number.isSafeInteger(command.expectedAggregateVersion) ||
          command.expectedAggregateVersion < 1 ||
          next.aggregateVersion !== command.expectedAggregateVersion + 1
        )
          return unavailable();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify([
            "ordering-cart-lifecycle-operation",
            brand,
            store,
            record.operationReference,
          ]),
        ]);
        const prior = await resolve(tx, record.operationReference);
        if (prior !== null) {
          if (!same(prior, record)) throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        const current = await load(tx, record.cartReference);
        if (current === null) return unavailable();
        if (current.aggregateVersion !== command.expectedAggregateVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        transition(current, record);
        const changed = object(
          await tx.query(
            `UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5, lifecycle_status=$6, terminal_at=$5, terminal_reason=$7 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$8`,
            [
              brand,
              store,
              record.cartReference,
              next.aggregateVersion,
              next.updatedAt,
              next.lifecycle?.status,
              next.lifecycle?.terminalReason,
              command.expectedAggregateVersion,
            ],
          ),
        );
        if (changed.rowCount !== 1) throw new CartError("CART_VERSION_CONFLICT");
        const inserted = object(
          await tx.query(
            `INSERT INTO rms_ordering.cart_lifecycle_operation_record (brand_id,store_id,operation_id,cart_id,guest_session_id,action_code,intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
            [
              brand,
              store,
              record.operationReference,
              record.cartReference,
              record.guestSessionReference,
              record.action,
              record.operationIntentHash,
              next.aggregateVersion,
              JSON.stringify(next),
              record.occurredAt,
              record.expiresAt,
            ],
          ),
        );
        if (inserted.rowCount !== 1) return unavailable();
        await appendAuditRecordInTransaction(tx, command.audit);
        return record;
      }),
  });
}

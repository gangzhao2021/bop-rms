import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
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
  createPostgresCartQueryStore,
  type CartQueryTransaction,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";

type Commit = Parameters<CartLifecycleCommandPorts["repository"]["commit"]>[0];
export interface CartLifecycleStore {
  resolveOperation(reference: string): Promise<CartLifecycleOperationRecord | null>;
  commit(input: Commit): Promise<CartLifecycleOperationRecord>;
}
function fail(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, fields: readonly string[]) {
  return readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
}
function rows(value: unknown): unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    fail();
  return value.rows;
}
function canonical(value: CartAggregate) {
  return JSON.stringify({
    ...value,
    items: [...value.items].sort((a, b) => a.cartItemReference.localeCompare(b.cartItemReference)),
  });
}
function record(value: unknown): CartLifecycleOperationRecord {
  const raw = closed(value, [
    "action",
    "operationReference",
    "operationIntentHash",
    "guestSessionReference",
    "cartReference",
    "result",
    "occurredAt",
    "expiresAt",
  ]);
  const result = parseCartAggregate(raw.result);
  const cartReference = parseOrderingReference(raw.cartReference);
  const occurredAt = parseOrderingInstant(raw.occurredAt);
  const expiresAt = parseOrderingInstant(raw.expiresAt);
  const guestSessionReference =
    raw.guestSessionReference === null ? null : parseOrderingReference(raw.guestSessionReference);
  if (
    (raw.action !== "Abandon" && raw.action !== "Expire") ||
    (raw.action === "Abandon") !== (guestSessionReference !== null) ||
    result.cartReference !== cartReference ||
    result.aggregateVersion < 2 ||
    result.updatedAt !== occurredAt ||
    result.lifecycle === null ||
    result.lifecycle.terminalAt !== occurredAt ||
    result.lifecycle.status !== (raw.action === "Abandon" ? "Abandoned" : "Expired") ||
    Date.parse(expiresAt) - Date.parse(occurredAt) !== 86_400_000 ||
    (raw.action === "Abandon" &&
      result.orderType === "Pickup" &&
      result.createdByActorReference !== guestSessionReference)
  )
    fail();
  return Object.freeze({
    action: raw.action,
    operationReference: parseOrderingReference(raw.operationReference),
    operationIntentHash: parseOrderingHash(raw.operationIntentHash),
    guestSessionReference,
    cartReference,
    result,
    occurredAt,
    expiresAt,
  });
}
const select = `SELECT jsonb_build_object('action',action_code,'operationReference',operation_id,
 'operationIntentHash',intent_digest,'guestSessionReference',guest_session_id,'cartReference',cart_id,
 'result',result_cart_snapshot_json,
 'occurredAt',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'expiresAt',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS record,
 brand_id AS "brandReference",store_id AS "storeReference",result_aggregate_version AS version
 FROM rms_ordering.cart_lifecycle_operation_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`;

// Infrastructure only. The service must authorize the current Session/Participant or expiry job first.
// The runner owns commit/rollback, bounded locks and connection/context cleanup; no nested transaction.
export function createPostgresCartLifecycleStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  references: CartLifecycleCommandPorts["references"],
): CartLifecycleStore {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  const inScope = (cart: CartAggregate) => {
    if (cart.brandReference !== brand || cart.storeReference !== store) fail();
  };
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>): Promise<T> {
    return runner.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
        [brand, store],
      );
      return action(tx);
    });
  }
  async function resolve(tx: CartQueryTransaction, reference: string) {
    const result = rows(await tx.query(select, [brand, store, reference]));
    if (result.length === 0) return null;
    if (result.length !== 1) fail();
    const raw = closed(result[0], ["record", "brandReference", "storeReference", "version"]);
    const parsed = record(raw.record);
    inScope(parsed.result);
    if (
      raw.brandReference !== brand ||
      raw.storeReference !== store ||
      parsed.operationReference !== reference ||
      parsed.result.aggregateVersion !== raw.version
    )
      fail();
    return parsed;
  }
  return Object.freeze({
    async resolveOperation(referenceValue: string) {
      try {
        const reference = parseOrderingReference(referenceValue);
        return await run((tx) => resolve(tx, reference));
      } catch {
        return fail();
      }
    },
    async commit(value: Commit) {
      try {
        const input = closed(value, ["record", "expectedAggregateVersion", "audit"]);
        const next = record(input.record);
        const version = input.expectedAggregateVersion;
        if (
          typeof version !== "number" ||
          !Number.isSafeInteger(version) ||
          version < 1 ||
          next.result.aggregateVersion !== version + 1
        )
          fail();
        inScope(next.result);
        const intentAt = (observedAt: string) =>
          parseOrderingHash(
            references.hashIntent(
              `${next.action}:${JSON.stringify({
                cartReference: next.cartReference,
                expectedAggregateVersion: version,
                operationReference: next.operationReference,
                observedAt,
              })}`,
            ),
          );
        if (!references.equals(next.operationIntentHash, intentAt(next.occurredAt))) fail();
        const audit = validateAuditRecord(input.audit, Date.parse(next.occurredAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== `ORDERING_CART_${next.action.toUpperCase()}` ||
          audit.targetType !== "OrderingCart" ||
          audit.targetId !== next.cartReference ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined ||
          audit.reasonCode !==
            (next.action === "Abandon" ? "AUTHORIZED_CART_ABANDONMENT" : "CART_DEADLINE_REACHED") ||
          audit.occurredAt !== next.occurredAt ||
          audit.sourceChannel !== (next.action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM") ||
          audit.dataClassification !== "Restricted"
        )
          fail();
        return await run(async (tx) => {
          if (
            rows(
              await tx.query(
                "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
                [brand, store, next.cartReference],
              ),
            ).length !== 1
          )
            fail();
          const prior = await resolve(tx, next.operationReference);
          if (prior !== null) {
            if (
              prior.action !== next.action ||
              prior.cartReference !== next.cartReference ||
              prior.guestSessionReference !== next.guestSessionReference ||
              prior.result.aggregateVersion !== next.result.aggregateVersion ||
              Date.parse(next.occurredAt) >= Date.parse(prior.expiresAt) ||
              !references.equals(prior.operationIntentHash, intentAt(prior.occurredAt))
            )
              throw new CartError("CART_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          const reader = createPostgresCartQueryStore(
            {
              run: async <T>(action: (borrowed: CartQueryTransaction) => Promise<T>) => action(tx),
            },
            { brandReference: brand, storeReference: store },
          );
          const current = await reader.load(next.cartReference);
          if (current === null) fail();
          if (current.aggregateVersion !== version) throw new CartError("CART_VERSION_CONFLICT");
          if (Date.parse(next.occurredAt) < Date.parse(current.updatedAt)) fail();
          const lifecycle =
            next.action === "Abandon"
              ? terminateCartLifecycle(current.lifecycle, {
                  status: "Abandoned",
                  terminalAt: next.occurredAt,
                })
              : expireCartLifecycle(current.lifecycle, next.occurredAt);
          const expected = parseCartAggregate({
            ...current,
            aggregateVersion: version + 1,
            updatedAt: next.occurredAt,
            lifecycle,
          });
          if (canonical(expected) !== canonical(next.result)) fail();
          const updated = await tx.query(
            `UPDATE rms_ordering.cart SET aggregate_version=$4,updated_at=$5,lifecycle_status=$6,terminal_at=$5,terminal_reason=$7
            WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$8`,
            [
              brand,
              store,
              next.cartReference,
              next.result.aggregateVersion,
              next.occurredAt,
              lifecycle.status,
              lifecycle.terminalReason,
              version,
            ],
          );
          if (
            updated === null ||
            typeof updated !== "object" ||
            !("rowCount" in updated) ||
            updated.rowCount !== 1
          )
            fail();
          const persisted = await reader.load(next.cartReference);
          if (persisted === null || canonical(persisted) !== canonical(next.result)) fail();
          if (
            rows(
              await tx.query(
                `INSERT INTO rms_ordering.cart_lifecycle_operation_record
            (operation_id,brand_id,store_id,cart_id,guest_session_id,action_code,intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING operation_id`,
                [
                  next.operationReference,
                  brand,
                  store,
                  next.cartReference,
                  next.guestSessionReference,
                  next.action,
                  next.operationIntentHash,
                  next.result.aggregateVersion,
                  JSON.stringify(next.result),
                  next.occurredAt,
                  next.expiresAt,
                ],
              ),
            ).length !== 1
          )
            fail();
          await appendAuditRecordInTransaction(tx, audit);
          return next;
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

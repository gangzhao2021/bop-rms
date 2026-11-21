import type { CartItemOperationRecord } from "../../application/ports/cart-item-command-ports.js";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
} from "../../domain/cart.js";
import type { CartQueryTransactionRunner } from "./cart-query-store.js";

export interface CartItemOperationStore {
  resolveOperation(operationReference: string): Promise<CartItemOperationRecord | null>;
}

const select = `SELECT operation_id AS "operationReference", brand_id AS "brandReference",
  store_id AS "storeReference", cart_id AS "cartReference", cart_line_id AS "cartItemReference",
  guest_session_id AS "guestSessionReference", action_code AS "action",
  intent_digest AS "operationIntentHash", result_aggregate_version AS "aggregateVersion",
  result_cart_snapshot_json AS "result",
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
FROM rms_ordering.cart_operation_record
WHERE brand_id = $1 AND store_id = $2 AND operation_id = $3`;

// Infrastructure only. Authorization, current Session scope and replay expiry remain caller duties.
// Snapshots contain restricted notes; never serialize the record as an unrestricted API response.
export function createPostgresCartItemOperationStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
): CartItemOperationStore {
  return createScopedOperationStore(runner, scope);
}

/** Bound application recovery; rejects mismatched immutable headers before reading notes. */
export function createPostgresBoundCartItemOperationStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{
    brandReference: string;
    storeReference: string;
    cartReference: string;
    guestSessionReference: string;
  }>,
): CartItemOperationStore {
  return createScopedOperationStore(
    runner,
    scope,
    Object.freeze({
      cartReference: parseOrderingReference(scope.cartReference),
      guestSessionReference: parseOrderingReference(scope.guestSessionReference),
    }),
  );
}

function createScopedOperationStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  binding?: Readonly<{ cartReference: string; guestSessionReference: string }>,
): CartItemOperationStore {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async resolveOperation(operationReference: string) {
      const reference = parseOrderingReference(operationReference);
      try {
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          if (binding !== undefined) {
            const header = await transaction.query(
              'SELECT cart_id AS "cartReference", guest_session_id AS "guestSessionReference" FROM rms_ordering.cart_operation_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3',
              [brand, store, reference],
            );
            if (
              header === null ||
              typeof header !== "object" ||
              !("rows" in header) ||
              !Array.isArray(header.rows) ||
              header.rows.length > 1
            )
              throw new Error("invalid header");
            if (header.rows.length === 0) return null;
            const row = header.rows[0];
            if (row === null || typeof row !== "object" || Array.isArray(row))
              throw new Error("invalid header");
            const fields = Object.getOwnPropertyDescriptors(row);
            if (
              Reflect.ownKeys(row).length !== 2 ||
              !fields.cartReference?.enumerable ||
              !("value" in fields.cartReference) ||
              !fields.guestSessionReference?.enumerable ||
              !("value" in fields.guestSessionReference)
            )
              throw new Error("invalid header");
            const cart = parseOrderingReference(fields.cartReference.value);
            const guest = parseOrderingReference(fields.guestSessionReference.value);
            if (cart !== binding.cartReference || guest !== binding.guestSessionReference)
              throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          }
          const response = await transaction.query(
            binding === undefined ? select : `${select} AND cart_id = $4 AND guest_session_id = $5`,
            binding === undefined
              ? [brand, store, reference]
              : [brand, store, reference, binding.cartReference, binding.guestSessionReference],
          );
          if (
            response === null ||
            typeof response !== "object" ||
            !("rows" in response) ||
            !Array.isArray(response.rows) ||
            response.rows.length > 1
          )
            throw new Error("invalid result");
          if (response.rows.length === 0) {
            if (binding !== undefined) throw new Error("missing immutable operation");
            return null;
          }
          const row: unknown = response.rows[0];
          if (
            row === null ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            Object.getPrototypeOf(row) !== Object.prototype
          )
            throw new Error("invalid row");
          const fields = [
            "operationReference",
            "brandReference",
            "storeReference",
            "cartReference",
            "cartItemReference",
            "guestSessionReference",
            "action",
            "operationIntentHash",
            "aggregateVersion",
            "result",
            "occurredAt",
            "expiresAt",
          ];
          const descriptors = Object.getOwnPropertyDescriptors(row);
          if (
            Reflect.ownKeys(row).length !== fields.length ||
            fields.some((field) => {
              const descriptor = descriptors[field];
              return (
                descriptor === undefined ||
                !Object.hasOwn(descriptor, "value") ||
                !descriptor.enumerable
              );
            })
          )
            throw new Error("invalid row");
          const raw = row as Record<string, unknown>;
          const result = parseCartAggregate(raw.result);
          const cartReference = parseOrderingReference(raw.cartReference);
          const cartItemReference = parseOrderingReference(raw.cartItemReference);
          const guestSessionReference = parseOrderingReference(raw.guestSessionReference);
          const occurredAt = parseOrderingInstant(raw.occurredAt);
          const expiresAt = parseOrderingInstant(raw.expiresAt);
          if (
            raw.operationReference !== reference ||
            raw.brandReference !== brand ||
            raw.storeReference !== store ||
            (binding !== undefined &&
              (cartReference !== binding.cartReference ||
                guestSessionReference !== binding.guestSessionReference)) ||
            result.brandReference !== brand ||
            result.storeReference !== store ||
            result.cartReference !== cartReference ||
            result.aggregateVersion !== raw.aggregateVersion ||
            result.updatedAt !== occurredAt ||
            (result.orderType === "Pickup" &&
              result.createdByActorReference !== guestSessionReference) ||
            (raw.action === "Add" &&
              result.items.find((item) => item.cartItemReference === cartItemReference)
                ?.addedByActorReference !== guestSessionReference) ||
            Date.parse(expiresAt) - Date.parse(occurredAt) !== 86_400_000 ||
            (raw.action !== "Add" && raw.action !== "Update" && raw.action !== "Remove") ||
            result.items.some((item) => item.cartItemReference === cartItemReference) !==
              (raw.action !== "Remove")
          )
            throw new Error("inconsistent record");
          return Object.freeze({
            action: raw.action,
            operationReference: reference,
            operationIntentHash: parseOrderingHash(raw.operationIntentHash),
            guestSessionReference,
            cartReference,
            cartItemReference,
            result,
            occurredAt,
            expiresAt,
          });
        });
      } catch (error) {
        if (
          binding !== undefined &&
          error instanceof CartError &&
          error.code === "CART_IDEMPOTENCY_CONFLICT"
        )
          throw new CartError("CART_IDEMPOTENCY_CONFLICT");
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

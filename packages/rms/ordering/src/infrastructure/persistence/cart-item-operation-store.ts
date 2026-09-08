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
          const response = await transaction.query(select, [brand, store, reference]);
          if (
            response === null ||
            typeof response !== "object" ||
            !("rows" in response) ||
            !Array.isArray(response.rows) ||
            response.rows.length > 1
          )
            throw new Error("invalid result");
          if (response.rows.length === 0) return null;
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
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

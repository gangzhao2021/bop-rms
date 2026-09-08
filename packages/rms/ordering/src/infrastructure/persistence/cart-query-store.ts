import {
  CartError,
  parseCartAggregate,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";

export interface CartQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

export interface CartQueryTransactionRunner {
  // Standalone readers own a bounded read-only transaction and release connection/context.
  // An owner-local writer may lend its existing transaction for these read operations;
  // the outer writer runner then owns commit, rollback and connection/context cleanup.
  run<T>(action: (transaction: CartQueryTransaction) => Promise<T>): Promise<T>;
}

export interface CartQueryStore {
  load(cartReference: string): Promise<CartAggregate | null>;
}

const select = `SELECT jsonb_build_object(
  'cartReference', c.cart_id, 'brandReference', c.brand_id, 'storeReference', c.store_id,
  'orderType', c.order_type, 'sourceChannel', c.source_channel,
  'diningSessionReference', c.dining_session_id, 'createdByActorReference', c.created_by_actor_id,
  'aggregateVersion', c.aggregate_version,
  'createdAt', to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt', to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lifecycle', CASE WHEN c.lifecycle_status = 'Legacy' THEN NULL ELSE jsonb_build_object(
    'status', c.lifecycle_status, 'policyVersionReference', c.lifecycle_policy_version_id,
    'policyDigest', c.lifecycle_policy_digest, 'idleTimeoutSeconds', c.idle_timeout_seconds,
    'absoluteTimeoutSeconds', c.absolute_timeout_seconds,
    'idleExpiresAt', to_char(c.idle_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'absoluteExpiresAt', to_char(c.absolute_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'terminalAt', to_char(c.terminal_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'terminalReason', c.terminal_reason
  ) END,
  'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'cartItemReference', l.cart_line_id, 'cartReference', l.cart_id,
    'sellableReference', l.sellable_id, 'quantity', l.quantity,
    'optionSelections', l.option_selections_json, 'customerNote', l.customer_note,
    'catalogSelectionEvidence', l.catalog_selection_evidence_json,
    'addedByActorReference', l.added_by_actor_id,
    'addedByParticipantReference', l.added_by_participant_id,
    'addedAt', to_char(l.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY l.added_at, l.cart_line_id)
    FROM rms_ordering.cart_line l
    WHERE l.cart_id = c.cart_id AND l.brand_id = $1 AND l.store_id = $2), '[]'::jsonb)
) AS cart
FROM rms_ordering.cart c
WHERE c.brand_id = $1 AND c.store_id = $2 AND c.cart_id = $3`;

// Infrastructure only: the caller must establish application authorization and exact Cart binding.
// Never expose this internal aggregate (including restricted notes) as an HTTP response.
export function createPostgresCartQueryStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
): CartQueryStore {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async load(cartReference: string) {
      const reference = parseOrderingReference(cartReference);
      try {
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          const result = await transaction.query(select, [brand, store, reference]);
          if (
            result === null ||
            typeof result !== "object" ||
            !("rows" in result) ||
            !Array.isArray(result.rows) ||
            result.rows.length > 1
          )
            throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
          if (result.rows.length === 0) return null;
          const cart = parseCartAggregate(result.rows[0]?.cart);
          if (
            cart.cartReference !== reference ||
            cart.brandReference !== brand ||
            cart.storeReference !== store
          )
            throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
          return cart;
        });
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

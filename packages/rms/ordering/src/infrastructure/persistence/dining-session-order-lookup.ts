import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

interface Query {
  readonly diningSessionReference: string;
  readonly guestSessionReference: string;
  readonly observedAt: string;
}

/** Identity lookup only. Callers must reacquire current parent/Host/closure/version
 * fences before appending a batch. Closed history must not become a new Order.
 */
export function createPostgresDiningSessionOrderLookup(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, query: Query): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const unavailable = (): never => {
    throw new Error("DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE");
  };
  return Object.freeze({
    async load(transaction: ConsumerTransaction, input: Query): Promise<string | null> {
      try {
        const query = Object.freeze({
          diningSessionReference: parseOrderingReference(input.diningSessionReference),
          guestSessionReference: parseOrderingReference(input.guestSessionReference),
          observedAt: parseOrderingInstant(input.observedAt),
        });
        if (!(await options.authorize(transaction, query))) return unavailable();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const result = await transaction.query(
          "SELECT order_id::text FROM rms_ordering.order_header " +
            "WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3 " +
            "AND order_type='DineIn' AND created_at <= $4::timestamptz " +
            "ORDER BY order_id LIMIT 2",
          [brand, store, query.diningSessionReference, query.observedAt],
        );
        if (!(await options.authorize(transaction, query))) return unavailable();
        if (result.rows.length > 1) return unavailable();
        return result.rows.length === 0
          ? null
          : String(parseOrderingReference(result.rows[0]?.order_id));
      } catch {
        return unavailable();
      }
    },
  });
}

/**
 * WP-2423 D4: the Order of each given dining session of the Store (one Order per session), so the
 * Tables page can check a table's rounds before its session is closed. A session with no Order yet
 * (or, against the one-Order rule, more than one) is left out. Caller authorizes and owns the
 * transaction.
 */
export async function listStoreDiningSessionOrders(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (diningSessionReferences.length === 0) return new Map();
  if (diningSessionReferences.length > 100)
    throw new Error("DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE");
  const sessions = diningSessionReferences.map((reference) => parseOrderingReference(reference));
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const rows = (
    await transaction.query(
      "SELECT dining_session_id::text session_id,order_id::text order_id FROM rms_ordering.order_header " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_type='DineIn' AND dining_session_id=ANY($3::uuid[])",
      [brand, store, sessions],
    )
  ).rows as readonly Record<string, unknown>[];
  const found = new Map<string, string[]>();
  for (const row of rows) {
    const session = parseOrderingReference(row.session_id);
    found.set(session, [...(found.get(session) ?? []), parseOrderingReference(row.order_id)]);
  }
  return new Map(
    [...found].flatMap(([session, orders]) =>
      orders.length === 1 && orders[0] !== undefined ? [[session, orders[0]] as const] : [],
    ),
  );
}

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

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: when each session's guests last ordered or changed a cart,
 * and whether a live cart holds something now. One read for a page of tables. Caller authorizes and
 * owns the transaction.
 */
export async function listStoreDiningSessionOrderActivity(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReferences: readonly string[],
  observedAtInput: string,
): Promise<
  ReadonlyMap<
    string,
    {
      readonly lastRoundAt: string | null;
      readonly lastCartChangeAt: string | null;
      readonly cartHasItems: boolean;
    }
  >
> {
  const found = new Map<
    string,
    {
      readonly lastRoundAt: string | null;
      readonly lastCartChangeAt: string | null;
      readonly cartHasItems: boolean;
    }
  >();
  if (diningSessionReferences.length === 0) return found;
  if (diningSessionReferences.length > 100)
    throw new Error("DINING_SESSION_ORDER_LOOKUP_UNAVAILABLE");
  const sessions = diningSessionReferences.map((reference) => parseOrderingReference(reference));
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  const observedAt = parseOrderingInstant(observedAtInput);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  const instant = (column: string) =>
    `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const rows = (
    await transaction.query(
      `SELECT s.session_id::text session_id,
 (SELECT ${instant("max(b.submitted_at)")} FROM rms_ordering.order_header h JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.brand_id=h.brand_id AND b.store_id=h.store_id WHERE h.brand_id=$1 AND h.store_id=$2 AND h.dining_session_id=s.session_id) last_round,
 (SELECT ${instant("max(c.updated_at)")} FROM rms_ordering.cart c WHERE c.brand_id=$1 AND c.store_id=$2 AND c.dining_session_id=s.session_id) last_cart,
 EXISTS (SELECT 1 FROM rms_ordering.cart c JOIN rms_ordering.cart_line l ON l.cart_id=c.cart_id AND l.brand_id=c.brand_id AND l.store_id=c.store_id WHERE c.brand_id=$1 AND c.store_id=$2 AND c.dining_session_id=s.session_id AND c.lifecycle_status='Active' AND c.idle_expires_at>$4::timestamptz AND c.absolute_expires_at>$4::timestamptz) cart_has_items
 FROM unnest($3::uuid[]) s(session_id)`,
      [brand, store, sessions, observedAt],
    )
  ).rows as readonly Record<string, unknown>[];
  for (const row of rows)
    found.set(
      parseOrderingReference(row.session_id),
      Object.freeze({
        lastRoundAt: row.last_round === null ? null : parseOrderingInstant(row.last_round),
        lastCartChangeAt: row.last_cart === null ? null : parseOrderingInstant(row.last_cart),
        cartHasItems: row.cart_has_items === true,
      }),
    );
  return found;
}

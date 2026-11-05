import type { ConsumerTransaction } from "@bop/eventing";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: when a kitchen board was last read at this Store. Written only
 * after a successful board read, at most once a minute. An instant only: no person, device or
 * request detail. Paid orders go straight to the kitchen only while a board is open.
 */
export const kitchenScreenPresenceWriteIntervalMs = 60_000;

interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function scoped(scope: Scope) {
  if (!reference.test(scope.brandReference) || !reference.test(scope.storeReference))
    throw new Error("KITCHEN_SCREEN_PRESENCE_UNAVAILABLE");
  return scope;
}
function parseInstant(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string" || new Date(Date.parse(text)).toISOString() !== text)
    throw new Error("KITCHEN_SCREEN_PRESENCE_UNAVAILABLE");
  return text;
}
const setScope = (tx: ConsumerTransaction, scope: Scope) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);

/** Caller authenticates staff for this Store and owns the transaction. A clock behind never rewinds. */
export async function recordKitchenScreenPresence(
  tx: ConsumerTransaction,
  scopeValue: Scope,
  observedAt: string,
): Promise<void> {
  const scope = scoped(scopeValue);
  await setScope(tx, scope);
  await tx.query(
    "INSERT INTO rms_kitchen.kitchen_screen_presence (brand_id,store_id,last_seen_at) VALUES ($1,$2,$3) " +
      "ON CONFLICT (brand_id,store_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at " +
      "WHERE rms_kitchen.kitchen_screen_presence.last_seen_at<EXCLUDED.last_seen_at",
    [scope.brandReference, scope.storeReference, parseInstant(observedAt)],
  );
}

/** Null: no board has been read at this Store. */
export async function loadKitchenScreenSeenAt(
  tx: ConsumerTransaction,
  scopeValue: Scope,
): Promise<string | null> {
  const scope = scoped(scopeValue);
  await setScope(tx, scope);
  const row = (
    await tx.query(
      "SELECT last_seen_at FROM rms_kitchen.kitchen_screen_presence WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0] as { last_seen_at: unknown } | undefined;
  return row === undefined ? null : parseInstant(row.last_seen_at);
}

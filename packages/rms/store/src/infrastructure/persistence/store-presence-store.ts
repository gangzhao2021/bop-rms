/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): the Store's staff presence. Signed-in staff screens
 * report activity; the Store is online while the latest activity is at most five minutes old.
 * Each continuous online period is one row, extended at most once a minute, so writes stay bounded
 * however often screens poll. Only instants are stored — no person, device or request detail.
 */
export const storePresenceOfflineAfterMilliseconds = 5 * 60_000;
export const storePresenceWriteIntervalMilliseconds = 60_000;

export class StorePresenceError extends Error {
  constructor(readonly code: "STORE_PRESENCE_UNAVAILABLE") {
    super(code);
    this.name = "StorePresenceError";
  }
}

interface Transaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const unavailable = (): never => {
  throw new StorePresenceError("STORE_PRESENCE_UNAVAILABLE");
};
function parseScope(scope: Scope): Scope {
  if (!reference.test(scope.brandReference) || !reference.test(scope.storeReference))
    return unavailable();
  return Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
}
function parseInstant(value: unknown): string {
  if (typeof value !== "string") return unavailable();
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) return unavailable();
  return value;
}
const shift = (value: string, milliseconds: number) =>
  new Date(Date.parse(value) + milliseconds).toISOString();
const asInstant = (column: string) =>
  "to_char(" + column + " AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
async function setScope(tx: Transaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}

/**
 * Records that the Store's staff are active at `observedAt`. Writes only when the live period is
 * at least a minute old, or starts a new period after an offline gap. Caller authenticates staff
 * for this Store and owns the transaction.
 */
export async function recordStorePresence(
  tx: Transaction,
  scopeValue: Scope,
  input: { observedAt: string; newPeriodReference(): string },
): Promise<"Unchanged" | "Extended" | "Started"> {
  const scope = parseScope(scopeValue);
  const at = parseInstant(input.observedAt);
  await setScope(tx, scope);
  const live = async () =>
    (
      await tx.query<{ session_id: string; last_seen_at: string }>(
        "SELECT session_id::text session_id," +
          asInstant("last_seen_at") +
          " last_seen_at FROM rms_store.store_presence_session WHERE brand_id=$1 AND store_id=$2 AND last_seen_at>=$3::timestamptz ORDER BY started_at DESC LIMIT 1",
        [
          scope.brandReference,
          scope.storeReference,
          shift(at, -storePresenceOfflineAfterMilliseconds),
        ],
      )
    ).rows[0];
  let current = await live();
  if (current !== undefined) {
    if (Date.parse(current.last_seen_at) > Date.parse(at) - storePresenceWriteIntervalMilliseconds)
      return "Unchanged";
    const extended = await tx.query(
      "UPDATE rms_store.store_presence_session SET last_seen_at=$4::timestamptz WHERE brand_id=$1 AND store_id=$2 AND session_id=$3 AND last_seen_at<=$5::timestamptz AND last_seen_at>=$6::timestamptz",
      [
        scope.brandReference,
        scope.storeReference,
        current.session_id,
        at,
        shift(at, -storePresenceWriteIntervalMilliseconds),
        shift(at, -storePresenceOfflineAfterMilliseconds),
      ],
    );
    // Another request extended it first; that is the same fact.
    return extended.rowCount === 1 ? "Extended" : "Unchanged";
  }
  // A new period after a gap: serialize with concurrent first requests of the same Store.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StorePresence:" + scope.brandReference + ":" + scope.storeReference,
  ]);
  current = await live();
  if (current !== undefined) return "Unchanged";
  const later = await tx.query<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM rms_store.store_presence_session WHERE brand_id=$1 AND store_id=$2 AND started_at>=$3::timestamptz) found",
    [scope.brandReference, scope.storeReference, at],
  );
  // A clock behind the recorded history never rewrites it.
  if (later.rows[0]?.found === true) return "Unchanged";
  const period = input.newPeriodReference();
  if (!reference.test(period)) return unavailable();
  const inserted = await tx.query(
    "INSERT INTO rms_store.store_presence_session (brand_id,store_id,session_id,started_at,last_seen_at) VALUES ($1,$2,$3,$4,$4)",
    [scope.brandReference, scope.storeReference, period, at],
  );
  if (inserted.rowCount !== 1) return unavailable();
  return "Started";
}

export type StorePresence = Readonly<{
  /** Whether staff were active within five minutes before `at`. */
  online: boolean;
  /** Start of the online period covering `at` (null when offline). */
  onlineSince: string | null;
  /** Latest staff activity at or before `at` (null: never). */
  lastSeenAt: string | null;
  /** When the Store went offline (its last activity), if it is offline at `at` and was ever seen. */
  offlineSince: string | null;
}>;

/** Public read of the Store's presence at an instant (now or in the past). */
export async function loadStorePresence(
  tx: Transaction,
  scopeValue: Scope,
  atValue: string,
): Promise<StorePresence> {
  const scope = parseScope(scopeValue);
  const at = parseInstant(atValue);
  await setScope(tx, scope);
  const row = (
    await tx.query<{ started_at: string; last_seen_at: string }>(
      "SELECT " +
        asInstant("started_at") +
        " started_at," +
        asInstant("LEAST(last_seen_at,$3::timestamptz)") +
        " last_seen_at FROM rms_store.store_presence_session WHERE brand_id=$1 AND store_id=$2 AND started_at<=$3::timestamptz ORDER BY started_at DESC LIMIT 1",
      [scope.brandReference, scope.storeReference, at],
    )
  ).rows[0];
  if (row === undefined)
    return Object.freeze({
      online: false,
      onlineSince: null,
      lastSeenAt: null,
      offlineSince: null,
    });
  const lastSeenAt = parseInstant(row.last_seen_at);
  const online = Date.parse(lastSeenAt) >= Date.parse(at) - storePresenceOfflineAfterMilliseconds;
  return Object.freeze({
    online,
    onlineSince: online ? parseInstant(row.started_at) : null,
    lastSeenAt,
    offlineSince: online ? null : lastSeenAt,
  });
}

/** First time staff came online strictly after `after` (null: not since). */
export async function loadStoreBackOnlineAfter(
  tx: Transaction,
  scopeValue: Scope,
  afterValue: string,
): Promise<string | null> {
  const scope = parseScope(scopeValue);
  const after = parseInstant(afterValue);
  await setScope(tx, scope);
  const row = (
    await tx.query<{ started_at: string }>(
      "SELECT " +
        asInstant("started_at") +
        " started_at FROM rms_store.store_presence_session WHERE brand_id=$1 AND store_id=$2 AND started_at>$3::timestamptz ORDER BY started_at LIMIT 1",
      [scope.brandReference, scope.storeReference, after],
    )
  ).rows[0];
  return row === undefined ? null : parseInstant(row.started_at);
}

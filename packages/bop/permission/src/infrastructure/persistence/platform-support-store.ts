/**
 * WP-2423 取舍 15 (Owner 2026-10-28): platform support staff. They are not a Store role: this is
 * their own permission set, and the Owner's say over whether they may change the Store's settings.
 * Every read and write is in the caller's transaction, scoped to one Store by this module.
 */
export interface PlatformSupportTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export type PlatformSupportAction =
  | "platform.support.view"
  | "platform.support.change"
  // WP-2423 item 13 ② (Owner 2026-11-05): pause and resume a merchant's new guests.
  | "platform.merchant.pause";
export interface PlatformSupportPerson {
  readonly actorReference: string;
  readonly displayName: string;
  readonly actions: readonly PlatformSupportAction[];
  readonly validUntil: string;
}
export type StoreSupportPermissionMode = "Off" | "Standing" | "Limited";
export interface StoreSupportPermission {
  readonly version: number;
  /** What the Owner chose last. */
  readonly mode: StoreSupportPermissionMode;
  readonly allowedUntil: string | null;
  /** Whether support may change settings at `at`; a Limited time past its end is simply no. */
  readonly changesAllowed: boolean;
}
export type StoreSupportAccessKind = "Viewed" | "Changed" | "Refused";
export interface StoreSupportScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export class StoreSupportPermissionError extends Error {
  constructor(readonly code: "Changed" | "Invalid") {
    super("store support permission " + code);
    this.name = "StoreSupportPermissionError";
  }
}
const instant = (value: unknown) => new Date(value as string | Date).toISOString();
const scoped = (tx: PlatformSupportTransaction, scope: StoreSupportScope) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);

/** The person's current record, when they are support now and hold any action. */
export async function readActivePlatformSupportPerson(
  tx: PlatformSupportTransaction,
  actorReference: string,
  at: string,
): Promise<PlatformSupportPerson | null> {
  const row = (
    await tx.query(
      "SELECT display_name,lifecycle,actions,effective_until FROM bop_permission.platform_support_person WHERE actor_id=$1 ORDER BY version DESC LIMIT 1",
      [actorReference],
    )
  )?.rows?.[0];
  if (row === undefined || row.lifecycle !== "Active") return null;
  const validUntil = instant(row.effective_until);
  if (validUntil <= instant(at)) return null;
  return Object.freeze({
    actorReference,
    displayName: String(row.display_name),
    actions: Object.freeze([...(row.actions as PlatformSupportAction[])]),
    validUntil,
  });
}

export async function readStoreSupportPermission(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  at: string,
): Promise<StoreSupportPermission> {
  await scoped(tx, scope);
  const row = (
    await tx.query(
      "SELECT version,mode,allowed_until FROM bop_permission.store_support_permission WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0];
  if (row === undefined)
    return Object.freeze({ version: 0, mode: "Off", allowedUntil: null, changesAllowed: false });
  const allowedUntil = row.allowed_until === null ? null : instant(row.allowed_until);
  const mode = row.mode as StoreSupportPermissionMode;
  return Object.freeze({
    version: Number(row.version),
    mode,
    allowedUntil,
    changesAllowed:
      mode === "Standing" ||
      (mode === "Limited" && allowedUntil !== null && allowedUntil > instant(at)),
  });
}

/** The Owner's choice as the next version. The same operation again returns what it recorded. */
export async function changeStoreSupportPermission(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  input: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly mode: StoreSupportPermissionMode;
    readonly allowedUntil: string | null;
    readonly actorReference: string;
    readonly occurredAt: string;
  },
): Promise<StoreSupportPermission> {
  await scoped(tx, scope);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StoreSupportPermission:" + scope.brandReference + ":" + scope.storeReference,
  ]);
  const prior = await tx.query(
    "SELECT 1 FROM bop_permission.store_support_permission WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
    [scope.brandReference, scope.storeReference, input.operationReference],
  );
  if (prior.rows.length === 1) return readStoreSupportPermission(tx, scope, input.occurredAt);
  const current = await readStoreSupportPermission(tx, scope, input.occurredAt);
  if (current.version !== input.expectedVersion) throw new StoreSupportPermissionError("Changed");
  if ((input.mode === "Limited") !== (input.allowedUntil !== null))
    throw new StoreSupportPermissionError("Invalid");
  await tx.query(
    "INSERT INTO bop_permission.store_support_permission (brand_id,store_id,version,operation_id,mode,allowed_until,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      scope.brandReference,
      scope.storeReference,
      current.version + 1,
      input.operationReference,
      input.mode,
      input.allowedUntil,
      input.actorReference,
      input.occurredAt,
    ],
  );
  return readStoreSupportPermission(tx, scope, input.occurredAt);
}

export async function recordStoreSupportAccess(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  input: {
    readonly logReference: string;
    readonly supportActorReference: string;
    readonly kind: StoreSupportAccessKind;
    readonly subjectCode: string;
    readonly occurredAt: string;
  },
): Promise<void> {
  await scoped(tx, scope);
  await tx.query(
    "INSERT INTO bop_permission.store_support_access_log (log_id,brand_id,store_id,support_actor_id,kind,subject_code,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      input.logReference,
      scope.brandReference,
      scope.storeReference,
      input.supportActorReference,
      input.kind,
      input.subjectCode,
      input.occurredAt,
    ],
  );
}

/** One record of the Store's support log, as the Owner reads it. */
export interface StoreSupportAccessEntry {
  readonly occurredAt: string;
  readonly supportName: string;
  readonly kind: StoreSupportAccessKind;
  readonly subjectCode: string;
}
/**
 * Where the next page of the log starts: records at or before `before` (an instant to the
 * microsecond), after skipping the `skip` records at exactly that instant already shown. The log
 * is append-only, so a page once read stays the same.
 */
export interface StoreSupportAccessCursor {
  readonly before: string;
  readonly skip: number;
}
const logCursorText = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
    throw new Error("PLATFORM_SUPPORT_UNAVAILABLE");
  return value;
};
/** A cursor as it came back from the Owner's screen; null when it is not one. */
export function parseStoreSupportAccessCursor(before: unknown, skip: unknown) {
  if (
    typeof before !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(before) ||
    !Number.isFinite(Date.parse(before)) ||
    typeof skip !== "number" ||
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    skip > 100_000
  )
    return null;
  return Object.freeze({ before, skip }) as StoreSupportAccessCursor;
}
const entryOf = (row: Record<string, unknown>): StoreSupportAccessEntry =>
  Object.freeze({
    occurredAt: instant(row.occurred_at),
    supportName: typeof row.support_name === "string" ? row.support_name : "Platform support",
    kind: row.kind as StoreSupportAccessKind,
    subjectCode: String(row.subject_code),
  });
const logColumns = `l.occurred_at,l.kind,l.subject_code,
       to_char(l.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
       (SELECT p.display_name FROM bop_permission.platform_support_person p
         WHERE p.actor_id=l.support_actor_id ORDER BY p.version DESC LIMIT 1) AS support_name`;

/** The Store's log, newest first, with who it was by the name support works under. */
export async function listStoreSupportAccess(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  limit = 100,
): Promise<readonly StoreSupportAccessEntry[]> {
  return (await pageStoreSupportAccess(tx, scope, { limit, after: null })).entries;
}

/**
 * b18 (Owner 2026-11-14: "show all" must reach every record): one page of the Store's log, newest
 * first, and where the next page starts (null once the oldest record is on this page).
 */
export async function pageStoreSupportAccess(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  input: { readonly limit: number; readonly after: StoreSupportAccessCursor | null },
): Promise<{
  readonly entries: readonly StoreSupportAccessEntry[];
  readonly next: StoreSupportAccessCursor | null;
}> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)
    throw new Error("PLATFORM_SUPPORT_INPUT_INVALID");
  await scoped(tx, scope);
  const { rows } = await tx.query(
    `SELECT ${logColumns}
     FROM bop_permission.store_support_access_log l
     WHERE l.brand_id=$1 AND l.store_id=$2 AND ($3::timestamptz IS NULL OR l.occurred_at<=$3::timestamptz)
     ORDER BY l.occurred_at DESC,l.log_id DESC OFFSET $4 LIMIT $5`,
    [
      scope.brandReference,
      scope.storeReference,
      input.after?.before ?? null,
      input.after?.skip ?? 0,
      input.limit + 1,
    ],
  );
  const shown = rows.slice(0, input.limit);
  const entries = Object.freeze(shown.map(entryOf));
  if (rows.length <= input.limit || shown.length === 0)
    return Object.freeze({ entries, next: null });
  const last = logCursorText(shown[shown.length - 1]?.cursor_at);
  // Records at exactly the last instant shown so far: on this page, and on the pages before it.
  const atLast =
    shown.filter((row) => row.cursor_at === last).length +
    (input.after !== null && input.after.before === last ? input.after.skip : 0);
  return Object.freeze({ entries, next: Object.freeze({ before: last, skip: atLast }) });
}

/**
 * b18: what the Owner is told about the whole log, never only the page read: how many records it
 * holds, how many were looks and the last one, and every change or refused attempt (newest first,
 * up to `actedLimit`, with how many there are in all).
 */
export async function summarizeStoreSupportAccess(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  actedLimit = 50,
): Promise<{
  readonly total: number;
  readonly looks: number;
  readonly lastLookAt: string | null;
  readonly actedCount: number;
  readonly acted: readonly StoreSupportAccessEntry[];
}> {
  await scoped(tx, scope);
  const { rows: counts } = await tx.query(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE kind='Viewed')::int AS looks,
       max(occurred_at) FILTER (WHERE kind='Viewed') AS last_look
     FROM bop_permission.store_support_access_log WHERE brand_id=$1 AND store_id=$2`,
    [scope.brandReference, scope.storeReference],
  );
  const count = counts[0] ?? {};
  const total = Number(count.total ?? 0),
    looks = Number(count.looks ?? 0);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(looks) || looks > total)
    throw new Error("PLATFORM_SUPPORT_UNAVAILABLE");
  const { rows } = await tx.query(
    `SELECT ${logColumns}
     FROM bop_permission.store_support_access_log l
     WHERE l.brand_id=$1 AND l.store_id=$2 AND l.kind<>'Viewed'
     ORDER BY l.occurred_at DESC,l.log_id DESC LIMIT $3`,
    [scope.brandReference, scope.storeReference, actedLimit],
  );
  return Object.freeze({
    total,
    looks,
    lastLookAt:
      count.last_look === null || count.last_look === undefined ? null : instant(count.last_look),
    actedCount: total - looks,
    acted: Object.freeze(rows.map(entryOf)),
  });
}

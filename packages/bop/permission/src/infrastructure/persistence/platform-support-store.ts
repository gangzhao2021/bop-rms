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
export type PlatformSupportAction = "platform.support.view" | "platform.support.change";
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

/** The Store's log, newest first, with who it was by the name support works under. */
export async function listStoreSupportAccess(
  tx: PlatformSupportTransaction,
  scope: StoreSupportScope,
  limit = 100,
): Promise<
  readonly {
    readonly occurredAt: string;
    readonly supportName: string;
    readonly kind: StoreSupportAccessKind;
    readonly subjectCode: string;
  }[]
> {
  await scoped(tx, scope);
  const { rows } = await tx.query(
    `SELECT l.occurred_at,l.kind,l.subject_code,
       (SELECT p.display_name FROM bop_permission.platform_support_person p
         WHERE p.actor_id=l.support_actor_id ORDER BY p.version DESC LIMIT 1) AS support_name
     FROM bop_permission.store_support_access_log l
     WHERE l.brand_id=$1 AND l.store_id=$2 ORDER BY l.occurred_at DESC,l.log_id DESC LIMIT $3`,
    [scope.brandReference, scope.storeReference, limit],
  );
  return rows.map((row) =>
    Object.freeze({
      occurredAt: instant(row.occurred_at),
      supportName: typeof row.support_name === "string" ? row.support_name : "Platform support",
      kind: row.kind as StoreSupportAccessKind,
      subjectCode: String(row.subject_code),
    }),
  );
}

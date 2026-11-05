import { parseCanonicalInstant } from "../../domain/brand-store.js";

/**
 * WP-2423 item 13 ② (Owner 2026-11-05): whether a merchant takes new guests. The platform pauses a
 * Brand (no new visit starts at any of its Stores) and resumes it; guests already in a visit and
 * staff are not affected, so open orders are finished, paid and refunded. Append-only records,
 * the current state the highest version; a Brand never paused takes new guests.
 */
export interface BrandGuestIntakeTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export type BrandGuestIntakeState = "Open" | "Paused";
export interface BrandGuestIntake {
  readonly version: number;
  readonly state: BrandGuestIntakeState;
  /** When the current state was recorded; null for a Brand never paused. */
  readonly since: string | null;
  readonly reason: string | null;
}
export class BrandGuestIntakeError extends Error {
  constructor(readonly code: "Invalid" | "Changed" | "Unavailable") {
    super("brand guest intake " + code);
    this.name = "BrandGuestIntakeError";
  }
}
const fail = (code: BrandGuestIntakeError["code"]): never => {
  throw new BrandGuestIntakeError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const instant = (value: unknown): string =>
  parseCanonicalInstant(value instanceof Date ? value.toISOString() : value);
const rowsOf = (value: unknown): readonly Record<string, unknown>[] => {
  const rows = (value as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : fail("Unavailable");
};

/** Runs `work` with only the Brand GUC set to this Brand, and puts the caller's back after. */
async function inBrand<T>(
  tx: BrandGuestIntakeTransaction,
  brandReference: string,
  work: () => Promise<T>,
): Promise<T> {
  const prior = rowsOf(
    await tx.query("SELECT current_setting('bop.brand_id',true) brand", []),
  )[0] as { brand: string | null } | undefined;
  await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brandReference]);
  try {
    return await work();
  } finally {
    await tx.query("SELECT set_config('bop.brand_id',$1,true)", [prior?.brand ?? ""]);
  }
}

const parse = (row: Record<string, unknown> | undefined): BrandGuestIntake => {
  if (row === undefined)
    return Object.freeze({ version: 0, state: "Open", since: null, reason: null });
  const version = Number(row.version);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (row.state !== "Open" && row.state !== "Paused")
  )
    return fail("Unavailable");
  return Object.freeze({
    version,
    state: row.state,
    since: instant(row.recorded_at),
    reason: String(row.reason),
  });
};

/** The merchant's current state, in the caller's transaction. */
export async function readBrandGuestIntake(
  tx: BrandGuestIntakeTransaction,
  brandReference: string,
): Promise<BrandGuestIntake> {
  const brand = reference(brandReference);
  return inBrand(tx, brand, async () =>
    parse(
      rowsOf(
        await tx.query(
          "SELECT version::text AS version,state,reason,recorded_at FROM bop_tenant.brand_guest_intake WHERE brand_id=$1 ORDER BY brand_guest_intake.version DESC LIMIT 1",
          [brand],
        ),
      )[0],
    ),
  );
}

/**
 * Pauses or resumes, against the version the person saw. The same operation again returns what it
 * recorded; a different change since, or asking for the state already in force, is Changed.
 */
export async function recordBrandGuestIntake(
  tx: BrandGuestIntakeTransaction,
  input: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly expectedVersion: number;
    readonly operationReference: string;
    readonly state: BrandGuestIntakeState;
    readonly reason: string;
    readonly actorReference: string;
    readonly recordedAt: string;
  },
): Promise<BrandGuestIntake> {
  const brand = reference(input.brandReference);
  const tenant = reference(input.tenantReference);
  const operation = reference(input.operationReference);
  const actor = reference(input.actorReference);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (
    (input.state !== "Open" && input.state !== "Paused") ||
    reason.length < 1 ||
    reason.length > 300 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    return fail("Invalid");
  const at = instant(input.recordedAt);
  return inBrand(tx, brand, async () => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "BrandGuestIntake:" + brand,
    ]);
    const replay = rowsOf(
      await tx.query(
        "SELECT version::text AS version,state,reason,recorded_at,actor_id::text AS actor FROM bop_tenant.brand_guest_intake WHERE brand_id=$1 AND operation_id=$2",
        [brand, operation],
      ),
    )[0];
    if (replay !== undefined) {
      if (replay.state !== input.state || replay.reason !== reason || replay.actor !== actor)
        return fail("Changed");
      return parse(replay);
    }
    const current = parse(
      rowsOf(
        await tx.query(
          "SELECT version::text AS version,state,reason,recorded_at FROM bop_tenant.brand_guest_intake WHERE brand_id=$1 ORDER BY brand_guest_intake.version DESC LIMIT 1",
          [brand],
        ),
      )[0],
    );
    if (current.version !== input.expectedVersion || current.state === input.state)
      return fail("Changed");
    if (current.since !== null && Date.parse(at) < Date.parse(current.since))
      return fail("Changed");
    await tx.query(
      "INSERT INTO bop_tenant.brand_guest_intake (tenant_id,brand_id,version,state,reason,actor_id,recorded_at,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [tenant, brand, current.version + 1, input.state, reason, actor, at, operation],
    );
    return Object.freeze({ version: current.version + 1, state: input.state, since: at, reason });
  });
}

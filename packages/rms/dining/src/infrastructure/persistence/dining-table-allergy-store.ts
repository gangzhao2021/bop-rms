import { DiningSessionError, parseDiningReference } from "../../domain/dining-session.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M171, Owner decision 17; 2000_473): the allergens staff
 * marked for an open table, so every kitchen ticket of that table shows them in red. Codes only
 * (the Brand's allergen list), tied to the Dining Session, never to a guest. The latest mark of a
 * Session is its current set; an empty set clears it. Read only while the Session is open.
 * Each save names the set its screen was based on; a save made from an older set is refused with
 * the set the table holds now, so one server never silently drops another server's allergen.
 *
 * Health-adjacent: callers never log, export or print these codes outside the kitchen ticket and
 * the table panel. Called inside an authorized merchant transaction; it sets the Store context
 * it reads under.
 */
interface AllergyTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}

export const diningTableAllergyMaximum = 14;
const code = /^[A-Z][A-Z0-9_-]{1,39}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class DiningTableAllergyError extends Error {
  constructor(
    readonly code:
      | "DINING_TABLE_ALLERGY_INVALID"
      /** The table is not open (closed, or never started). */
      | "DINING_TABLE_ALLERGY_NOT_OPEN"
      /** The operation was already used for another mark. */
      | "DINING_TABLE_ALLERGY_CONFLICT",
  ) {
    super(code);
    this.name = "DiningTableAllergyError";
  }
}
const invalid = (): never => {
  throw new DiningTableAllergyError("DINING_TABLE_ALLERGY_INVALID");
};
const ref = (value: unknown): string => {
  try {
    return String(parseDiningReference(value));
  } catch {
    return invalid();
  }
};

/** Codes as recorded: unique, sorted, at most 14, each an allergen-list code. */
export function parseDiningTableAllergyCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > diningTableAllergyMaximum) return invalid();
  const codes = value.map((entry: unknown) =>
    typeof entry === "string" && code.test(entry) ? entry : invalid(),
  );
  if (new Set(codes).size !== codes.length) return invalid();
  return Object.freeze([...codes].sort());
}

async function inStore<T>(
  tx: AllergyTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  work: (brand: string, store: string) => Promise<T>,
): Promise<T> {
  const brand = ref(scope.brandReference);
  const store = ref(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return work(brand, store);
}

/**
 * Records the table's allergens now (idempotent by operation), only when the table still holds
 * the set the screen was based on; otherwise answers `Changed` with the current set and records
 * nothing. Saves of one table are serialized, so two saves from the same screen state never
 * both apply.
 */
export async function setDiningTableAllergies(
  tx: AllergyTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: {
    readonly markReference: string;
    readonly diningSessionReference: string;
    readonly allergenCodes: readonly string[];
    /** The set the staff member's screen showed when they changed it. */
    readonly basedOnAllergenCodes: readonly string[];
    readonly actorReference: string;
    readonly operationReference: string;
    readonly recordedAt: string;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied" | "Changed";
  readonly codes: readonly string[];
}> {
  const codes = parseDiningTableAllergyCodes(input.allergenCodes);
  const basedOn = parseDiningTableAllergyCodes(input.basedOnAllergenCodes);
  if (typeof input.recordedAt !== "string" || !instant.test(input.recordedAt)) return invalid();
  const row = [
    ref(scope.tenantReference),
    ref(input.markReference),
    ref(input.diningSessionReference),
    codes,
    ref(input.actorReference),
    ref(input.operationReference),
    input.recordedAt,
  ];
  return inStore(tx, scope, async (brand, store) => {
    // One save of a table at a time: the second waits and then reads the first's mark.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "rms_dining.dining_table_allergy_mark:" + store + ":" + String(row[2]),
    ]);
    const open = await tx.query<{ open: boolean }>(
      "SELECT phase IN ('Active','Closing') open FROM rms_dining.dining_session WHERE brand_id=$1 AND store_id=$2 AND session_id=$3 FOR SHARE",
      [brand, store, row[2]],
    );
    const prior = async () =>
      (
        await tx.query<{ session: string; codes: string[] }>(
          "SELECT session_id::text session,allergen_codes codes FROM rms_dining.dining_table_allergy_mark WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
          [brand, store, row[5]],
        )
      ).rows[0];
    const retried = await prior();
    if (retried !== undefined) {
      if (
        retried.session !== row[2] ||
        JSON.stringify([...retried.codes].sort()) !== JSON.stringify(codes)
      )
        throw new DiningTableAllergyError("DINING_TABLE_ALLERGY_CONFLICT");
      return { status: "AlreadyApplied" as const, codes };
    }
    if (open.rows[0]?.open !== true)
      throw new DiningTableAllergyError("DINING_TABLE_ALLERGY_NOT_OPEN");
    const latest = (
      await tx.query<{ codes: unknown }>(
        `SELECT allergen_codes codes FROM rms_dining.dining_table_allergy_mark
         WHERE brand_id=$1 AND store_id=$2 AND session_id=$3
         ORDER BY recorded_at DESC,mark_id DESC LIMIT 1`,
        [brand, store, row[2]],
      )
    ).rows[0];
    const now = latest === undefined ? [] : parseDiningTableAllergyCodes(latest.codes);
    if (JSON.stringify(now) !== JSON.stringify(basedOn))
      return { status: "Changed" as const, codes: now };
    await tx.query(
      `INSERT INTO rms_dining.dining_table_allergy_mark(tenant_id,brand_id,store_id,mark_id,session_id,allergen_codes,actor_id,operation_id,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9)`,
      [row[0], brand, store, row[1], row[2], row[3], row[4], row[5], row[6]],
    );
    return { status: "Applied" as const, codes };
  });
}

/**
 * The current allergens of each open table Session asked about (at most 200). Sessions with none,
 * cleared, or no longer open are absent.
 */
/**
 * v15 b11: the tables still seated (their dining session is Active or Closing) among these
 * sessions. A round a table sent before the business day turned is still that table's work while
 * the guests are there (late-night service), so the kitchen keeps it on the board.
 */
export async function listSeatedDiningSessions(
  tx: AllergyTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (diningSessionReferences.length === 0) return new Set();
  if (diningSessionReferences.length > 200) return invalid();
  const sessions = [...new Set(diningSessionReferences.map(ref))];
  return inStore(tx, scope, async (brand, store) => {
    const { rows } = await tx.query<{ session: string }>(
      `SELECT at_table.session_id::text session FROM rms_dining.dining_session at_table
       WHERE at_table.brand_id=$1 AND at_table.store_id=$2 AND at_table.session_id=ANY($3::uuid[])
       AND at_table.phase IN ('Active','Closing')`,
      [brand, store, sessions],
    );
    const found = new Set<string>();
    for (const row of rows) {
      if (!sessions.includes(row.session))
        throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
      found.add(row.session);
    }
    return found;
  });
}

export async function listOpenDiningTableAllergies(
  tx: AllergyTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReferences: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (diningSessionReferences.length === 0) return new Map();
  if (diningSessionReferences.length > 200) return invalid();
  const sessions = [...new Set(diningSessionReferences.map(ref))];
  return inStore(tx, scope, async (brand, store) => {
    const { rows } = await tx.query<{ session: string; codes: unknown }>(
      `SELECT DISTINCT ON (m.session_id) m.session_id::text session,m.allergen_codes codes
       FROM rms_dining.dining_table_allergy_mark m
       JOIN rms_dining.dining_session s ON s.brand_id=m.brand_id AND s.store_id=m.store_id AND s.session_id=m.session_id
       WHERE m.brand_id=$1 AND m.store_id=$2 AND m.session_id=ANY($3::uuid[]) AND s.phase IN ('Active','Closing')
       ORDER BY m.session_id,m.recorded_at DESC,m.mark_id DESC`,
      [brand, store, sessions],
    );
    const found = new Map<string, readonly string[]>();
    for (const row of rows) {
      if (!sessions.includes(row.session))
        throw new DiningSessionError("DINING_SESSION_DEPENDENCY_UNAVAILABLE");
      const codes = parseDiningTableAllergyCodes(row.codes);
      if (codes.length > 0) found.set(row.session, codes);
    }
    return found;
  });
}

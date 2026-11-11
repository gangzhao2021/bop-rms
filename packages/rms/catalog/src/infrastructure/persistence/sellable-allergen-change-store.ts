import type {
  SellableAllergenChange,
  SellableAllergenChoiceChange,
  SellableAllergenNow,
} from "../../domain/sellable-allergen-change.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M77, M167; 2000_471): a dish's allergens as resolved right
 * after a recipe change, and the changes readers apply on top of a listed menu version.
 *
 * Read and written in the caller's transaction under the Catalog's Brand context (Catalog rows are
 * read with no Store selected); the caller's context is restored afterwards. A read is one
 * statement for every dish asked about (at most 200), bounded by the dishes on one menu.
 */
interface ChangeTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{1,63}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class SellableAllergenChangeError extends Error {
  constructor(
    readonly code:
      | "SELLABLE_ALLERGEN_CHANGE_INVALID"
      /** The operation was already used for another change. */
      | "SELLABLE_ALLERGEN_CHANGE_CONFLICT",
  ) {
    super(code);
    this.name = "SellableAllergenChangeError";
  }
}
const invalid = (): never => {
  throw new SellableAllergenChangeError("SELLABLE_ALLERGEN_CHANGE_INVALID");
};
const reference = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : invalid();

async function inBrandScope<T>(
  tx: ChangeTransaction,
  brand: string,
  work: () => Promise<T>,
): Promise<T> {
  const before = (
    await tx.query<{ brand: string | null; store: string | null }>(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )
  ).rows[0];
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brand,
  ]);
  const value = await work();
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    before?.brand ?? "",
    before?.store ?? "",
  ]);
  return value;
}

function allergensOf(value: unknown): readonly SellableAllergenNow[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > 64) return invalid();
  return Object.freeze(
    value.map((raw: unknown) => {
      const entry = raw as Record<string, unknown> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.code !== "string" ||
        !code.test(entry.code) ||
        (entry.classification !== "Contains" && entry.classification !== "CrossContactPossible") ||
        entry.localizedNames === null ||
        typeof entry.localizedNames !== "object" ||
        Object.values(entry.localizedNames as object).some((name) => typeof name !== "string")
      )
        return invalid();
      return Object.freeze({
        allergenReference: reference(entry.allergenReference),
        code: entry.code,
        localizedNames: Object.freeze({ ...(entry.localizedNames as Record<string, string>) }),
        classification: entry.classification,
      });
    }),
  );
}

/** A choice's key: the last 12 characters of its option reference (as its stand-in is named). */
const optionKey = /^[0-9a-f]{12}$/u;
function choicesOf(value: unknown): SellableAllergenChoiceChange | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.options === null ||
    typeof raw.options !== "object" ||
    Array.isArray(raw.options)
  )
    return invalid();
  const entries = Object.entries(raw.options as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([key]) => !optionKey.test(key))) return invalid();
  return Object.freeze({
    dish: allergensOf(raw.dish) ?? invalid(),
    options: Object.freeze(
      Object.fromEntries(entries.map(([key, list]) => [key, allergensOf(list) ?? invalid()])),
    ),
  });
}

/**
 * Records one change (idempotent by operation: the same operation answers the change it
 * recorded; another change under it is refused).
 */
export async function recordSellableAllergenChange(
  tx: ChangeTransaction,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  input: {
    readonly changeReference: string;
    readonly operationReference: string;
    readonly skuReference: string;
    readonly storeReference: string | null;
    readonly cause: SellableAllergenChange["cause"];
    readonly allergens: readonly SellableAllergenNow[] | null;
    /** WP-2423 (b7): the dish's own and what each answered choice adds (staff answers only). */
    readonly choices?: SellableAllergenChoiceChange;
    readonly actorReference: string;
    readonly recordedAt: string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied" }> {
  const brand = reference(scope.brandReference);
  const allergens = allergensOf(input.allergens);
  const choices = choicesOf(input.choices);
  if (
    !["RecipeBound", "RecipeEnded", "StaffDeclared"].includes(input.cause) ||
    !instant.test(input.recordedAt) ||
    (choices !== undefined && (input.cause !== "StaffDeclared" || allergens === null))
  )
    return invalid();
  const row = [
    reference(input.changeReference),
    reference(scope.tenantReference),
    brand,
    input.storeReference === null ? null : reference(input.storeReference),
    reference(input.skuReference),
    input.cause,
    allergens === null ? null : JSON.stringify(allergens),
    reference(input.actorReference),
    reference(input.operationReference),
    input.recordedAt,
    choices === undefined ? null : JSON.stringify(choices),
  ];
  return inBrandScope(tx, brand, async () => {
    const inserted = await tx.query(
      `INSERT INTO rms_catalog.sellable_allergen_change(change_id,tenant_id,brand_id,store_id,sku_id,cause,allergens_json,actor_id,operation_id,recorded_at,choices_json)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) ON CONFLICT (brand_id,operation_id) DO NOTHING`,
      row,
    );
    if ((inserted.rowCount ?? 0) === 1) return { status: "Applied" as const };
    const prior = (
      await tx.query<{ sku: string; store: string | null; cause: string }>(
        "SELECT sku_id::text sku,store_id::text store,cause FROM rms_catalog.sellable_allergen_change WHERE brand_id=$1 AND operation_id=$2",
        [brand, row[8]],
      )
    ).rows[0];
    if (
      prior === undefined ||
      prior.sku !== row[4] ||
      prior.store !== row[3] ||
      prior.cause !== row[5]
    )
      throw new SellableAllergenChangeError("SELLABLE_ALLERGEN_CHANGE_CONFLICT");
    return { status: "AlreadyApplied" as const };
  });
}

/**
 * Per dish, the latest change at this Store (its own, or the Brand's unless this Store's own
 * recipe was in effect when the Brand's was changed: a Store using its own recipe keeps it),
 * recorded after that menu
 * version was first reviewed (its allergens resolved for listing) — the changes guests and the
 * kitchen read on top of what was listed. A menu listed again is a new version with its own
 * review, so older changes no longer apply to it. Taking the version's first review never leaves
 * a later change out; at worst a change the listed list already holds is read again, which adds
 * nothing. Dishes with no such change are absent.
 */
export async function listSellableAllergenChangesSince(
  tx: ChangeTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  keys: readonly { readonly menuVersionReference: string; readonly skuReference: string }[],
): Promise<ReadonlyMap<string, SellableAllergenChange>> {
  if (keys.length === 0) return new Map();
  if (keys.length > 200) return invalid();
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const versions = keys.map((key) => reference(key.menuVersionReference));
  const skus = keys.map((key) => reference(key.skuReference));
  return inBrandScope(tx, brand, async () => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (k.version,k.sku) k.version::text version,k.sku::text sku,c.store_id::text store,c.cause,
         c.allergens_json allergens,c.choices_json choices,to_char(c.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at
       FROM unnest($3::uuid[],$4::uuid[]) k(version,sku)
       JOIN rms_catalog.sellable_allergen_change c ON c.brand_id=$1 AND c.sku_id=k.sku AND (c.store_id IS NULL OR c.store_id=$2)
       WHERE c.recorded_at > COALESCE((SELECT min((r.snapshot_json->>'createdAt')::timestamptz) FROM rms_catalog.menu_review_content r
                                       WHERE r.brand_id=$1 AND r.menu_version_id=k.version),'-infinity'::timestamptz)
         -- A Brand-wide change does not reach a Store whose own recipe was in effect then (this
         -- Store's latest own change before it bound a Store recipe).
         AND NOT (c.store_id IS NULL AND (
           SELECT o.cause FROM rms_catalog.sellable_allergen_change o
           WHERE o.brand_id=$1 AND o.sku_id=k.sku AND o.store_id=$2 AND o.recorded_at < c.recorded_at
           ORDER BY o.recorded_at DESC,o.change_id DESC LIMIT 1) IS NOT DISTINCT FROM 'RecipeBound')
       ORDER BY k.version,k.sku,c.recorded_at DESC,c.change_id DESC`,
      [brand, store, versions, skus],
    );
    const found = new Map<string, SellableAllergenChange>();
    for (const row of rows)
      found.set(
        String(row.version) + ":" + String(row.sku),
        Object.freeze({
          skuReference: String(row.sku),
          storeReference: row.store === null ? null : String(row.store),
          cause:
            row.cause === "RecipeEnded" || row.cause === "StaffDeclared"
              ? row.cause
              : "RecipeBound",
          allergens: allergensOf(row.allergens),
          ...((choices) => (choices === undefined ? {} : { choices }))(choicesOf(row.choices)),
          recordedAt: String(row.recorded_at),
        }),
      );
    return found;
  });
}
/** The key `listSellableAllergenChangesSince` answers under. */
export const sellableAllergenChangeKey = (menuVersionReference: string, skuReference: string) =>
  menuVersionReference + ":" + skuReference;

import { appendAuditRecordInTransaction, type JsonObject } from "@bop/audit";
import { resolveStoreAvailability } from "../../domain/availability.js";
import {
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "../../contracts/product.js";
import { listStoreAvailabilityRules } from "./availability-rule-store.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M22, M24; 2000_470): which of a dish's choices a Store
 * cannot sell right now, and the Store's own "sold out" for one choice or extra.
 *
 * One answer for every Sale read — the guest menu, add to cart, the cart's marks, the quote,
 * checkout and the staff round — so the menu and the cart never disagree:
 * - `SoldOut`: the Store marked the choice sold out (pearls, an add-on), or the choice stands for
 *   a combo's dish that the Store marked sold out;
 * - `NotOffered`: the choice stands for a combo's dish this Store does not offer now (hidden).
 *
 * Read in the caller's transaction, in two statements whatever the number of choices, under the
 * Catalog's Brand context (Catalog rows are read with no Store selected); the caller's context is
 * restored afterwards. The cost is set by the choices asked about (one dish's groups, or the
 * choices of a published menu), never by guests or history. A combo choice's dish is resolved from
 * the Store's availability rules only — its sold-out mark and whether it is offered here. Its stock
 * is not read once per choice: the combo is checked against stock for the exact choices when it is
 * added, quoted and checked out (the chosen dish's option recipe), so a short choice is still
 * refused there. A failed read fails the caller's read as a whole (the guest is asked to try
 * again), never offering a choice nobody could check.
 */
export type OptionOffNow = "SoldOut" | "NotOffered";
interface SoldOutTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class StoreOptionSoldOutError extends Error {
  constructor(
    readonly code:
      | "STORE_OPTION_SOLD_OUT_INPUT_INVALID"
      /** Another change of the same choice came first, or the operation was reused for another. */
      | "STORE_OPTION_SOLD_OUT_CHANGED"
      | "STORE_OPTION_SOLD_OUT_UNAVAILABLE",
  ) {
    super(code);
    this.name = "StoreOptionSoldOutError";
  }
}
const reference = (value: unknown): string => {
  if (typeof value !== "string" || !uuid.test(value))
    throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_INPUT_INVALID");
  return value;
};
const iso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(String(value)).toISOString();

/** Runs `work` with the Brand selected and no Store (Catalog RLS); restores the caller's. */
async function inBrandScope<T>(
  tx: SoldOutTransaction,
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

/** One choice's current answer at the Store (null: never marked here). */
export interface StoreOptionSoldOutMark {
  readonly optionReference: string;
  readonly version: number;
  readonly soldOut: boolean;
  /** Null while sold out until further notice. */
  readonly soldOutUntil: string | null;
  /** In effect at the instant asked about (an elapsed "today" mark is not). */
  readonly inEffect: boolean;
}
const latestMarks = `SELECT DISTINCT ON (option_id) option_id::text AS option,version,sold_out,sold_out_until
  FROM rms_catalog.store_option_sold_out
 WHERE brand_id=$1 AND store_id=$2 AND option_id=ANY($3::uuid[]) AND occurred_at <= $4::timestamptz
 ORDER BY option_id,version DESC`;
const markOf = (row: Record<string, unknown>, at: string): StoreOptionSoldOutMark => {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1 || typeof row.sold_out !== "boolean")
    throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_UNAVAILABLE");
  const until = iso(row.sold_out_until);
  return Object.freeze({
    optionReference: String(row.option),
    version,
    soldOut: row.sold_out,
    soldOutUntil: until,
    inEffect: row.sold_out && (until === null || Date.parse(at) < Date.parse(until)),
  });
};

/** The Store's current answer for each choice asked about that was ever marked here. */
export async function listStoreOptionSoldOutMarks(
  tx: SoldOutTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  optionReferences: readonly string[],
  at: string,
): Promise<ReadonlyMap<string, StoreOptionSoldOutMark>> {
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const wanted = [...new Set(optionReferences.map(reference))];
  if (!instant.test(at)) throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_INPUT_INVALID");
  if (wanted.length === 0) return new Map();
  return inBrandScope(tx, brand, async () => {
    const { rows } = await tx.query<Record<string, unknown>>(latestMarks, [
      brand,
      store,
      wanted,
      at,
    ]);
    return new Map(rows.map((row) => [String(row.option), markOf(row, at)]));
  });
}

/**
 * The choices asked about that the Store cannot sell at `at` for this channel and order type:
 * marked sold out here, or standing for a combo dish sold out or not offered here.
 */
export async function listOptionsOffNow(
  tx: SoldOutTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly channelCode: string;
    readonly orderTypeCode: string;
    readonly observedAt: string;
    readonly optionReferences: readonly string[];
  },
): Promise<ReadonlyMap<string, OptionOffNow>> {
  const brand = reference(input.brandReference);
  const store = reference(input.storeReference);
  const at = String(parseCatalogInstant(input.observedAt));
  const wanted = [...new Set(input.optionReferences.map(reference))];
  const result = new Map<string, OptionOffNow>();
  if (wanted.length === 0) return result;
  return inBrandScope(tx, brand, async () => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `WITH marks AS (${latestMarks})
       SELECT w.option::text AS option,m.version,m.sold_out,m.sold_out_until,c.dish_sku_id::text AS dish
         FROM unnest($3::uuid[]) AS w(option)
         LEFT JOIN marks m ON m.option=w.option::text
         LEFT JOIN rms_catalog.bundle_combo_choice c ON c.brand_id=$1 AND c.option_id=w.option`,
      [brand, store, wanted, at],
    );
    const dishes = new Map<string, string[]>();
    for (const row of rows) {
      const option = String(row.option);
      if (row.version !== null && row.version !== undefined && markOf(row, at).inEffect)
        result.set(option, "SoldOut");
      if (typeof row.dish === "string")
        dishes.set(row.dish, [...(dishes.get(row.dish) ?? []), option]);
    }
    if (dishes.size > 0) {
      const rules = await listStoreAvailabilityRules(tx as never, {
        brandReference: brand,
        storeReference: store,
      });
      for (const [dish, options] of dishes) {
        const own = rules.filter((rule) => rule.sellableReference === dish);
        const resolved = resolveStoreAvailability({
          brandReference: parseCatalogReference(brand),
          storeReference: parseCatalogReference(store),
          sellableReference: parseCatalogReference(dish),
          channelCode: parseCatalogCode(input.channelCode),
          orderTypeCode: parseCatalogCode(input.orderTypeCode),
          at: parseCatalogInstant(at),
          rules: own,
          safetyEvidence: [],
        });
        if (resolved.status === "Available") continue;
        const soldOut =
          resolved.status === "Unavailable" &&
          own.some(
            (rule) =>
              rule.ruleReference === resolved.ruleReference && rule.reasonCode === "SOLD_OUT",
          );
        for (const option of options)
          if (soldOut || !result.has(option))
            result.set(option, soldOut ? "SoldOut" : "NotOffered");
      }
    }
    return result;
  });
}

/**
 * The Store marks one choice sold out (until `soldOutUntil`, or until further notice when null) or
 * brings it back (`soldOut: false`): the choice's next version at this Store, with who and when,
 * against the version staff saw (0: never marked). The same operation again returns what it
 * recorded. The caller authorizes and owns the transaction.
 *
 * Each change is also an Audit record in the Store's scope, in the same transaction, as a dish's
 * sold-out mark is (`CATALOG_OPTION_SOLD_OUT` / `CATALOG_OPTION_BACK_ON`): the owner sees who took
 * pearls off and put them back. The summary the caller gives names the choice and the authority,
 * never personal data.
 */
export async function changeStoreOptionSoldOut(
  tx: SoldOutTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: {
    readonly optionReference: string;
    readonly operationReference: string;
    readonly soldOut: boolean;
    readonly soldOutUntil: string | null;
    readonly actorReference: string;
    readonly observedAt: string;
    /** The Audit record's id (derived from the operation) and its non-personal summary. */
    readonly audit: {
      readonly auditReference: string;
      readonly summary: JsonObject;
    };
  },
): Promise<StoreOptionSoldOutMark> {
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const option = reference(input.optionReference);
  const operation = reference(input.operationReference);
  if (
    typeof input.soldOut !== "boolean" ||
    !instant.test(input.observedAt) ||
    (input.soldOutUntil !== null &&
      (!instant.test(input.soldOutUntil) ||
        Date.parse(input.soldOutUntil) <= Date.parse(input.observedAt))) ||
    (!input.soldOut && input.soldOutUntil !== null)
  )
    throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_INPUT_INVALID");
  return inBrandScope(tx, brand, async () => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `StoreOptionSoldOut:${brand}:${store}:${option}`,
    ]);
    const prior = (
      await tx.query<Record<string, unknown>>(
        "SELECT option_id::text AS option,version,sold_out,sold_out_until FROM rms_catalog.store_option_sold_out WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [brand, store, operation],
      )
    ).rows[0];
    if (prior !== undefined) {
      if (
        prior.option !== option ||
        prior.sold_out !== input.soldOut ||
        iso(prior.sold_out_until) !== input.soldOutUntil
      )
        throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_CHANGED");
      return markOf(prior, input.observedAt);
    }
    const known = await tx.query(
      "SELECT 1 FROM rms_catalog.option WHERE brand_id=$1 AND option_id=$2 AND lifecycle='Active'",
      [brand, option],
    );
    if (known.rows.length !== 1)
      throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_INPUT_INVALID");
    // The next version follows every mark recorded here, whatever its instant: a mark another
    // API instance recorded a moment "later" by its clock must not make this one collide (and
    // read as a conflict on every retry). Which mark is in effect stays bounded by time.
    const latest = Number(
      (
        await tx.query<{ version: unknown }>(
          "SELECT COALESCE(max(version),0) AS version FROM rms_catalog.store_option_sold_out WHERE brand_id=$1 AND store_id=$2 AND option_id=$3",
          [brand, store, option],
        )
      ).rows[0]?.version ?? Number.NaN,
    );
    if (!Number.isSafeInteger(latest) || latest < 0)
      throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_UNAVAILABLE");
    const version = latest + 1;
    await tx.query(
      "INSERT INTO rms_catalog.store_option_sold_out (tenant_id,brand_id,store_id,option_id,version,operation_id,sold_out,sold_out_until,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        reference(scope.tenantReference),
        brand,
        store,
        option,
        version,
        operation,
        input.soldOut,
        input.soldOutUntil,
        reference(input.actorReference),
        input.observedAt,
      ],
    );
    // The Audit record is kept in the Store's scope; the mark stays Catalog Brand configuration.
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [store]);
    await appendAuditRecordInTransaction(tx, {
      auditId: reference(input.audit.auditReference),
      brandId: brand,
      storeId: store,
      actor: { type: "User", reference: reference(input.actorReference) },
      actionCode: input.soldOut ? "CATALOG_OPTION_SOLD_OUT" : "CATALOG_OPTION_BACK_ON",
      targetType: "CatalogStoreOptionSoldOut",
      targetId: option,
      afterSummary: {
        ...input.audit.summary,
        optionReference: option,
        storeReference: store,
        version,
        soldOutUntil: input.soldOutUntil,
      },
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: operation,
      occurredAt: input.observedAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    await tx.query("SELECT set_config('bop.store_id','',true)", []);
    return markOf(
      {
        option,
        version,
        sold_out: input.soldOut,
        sold_out_until: input.soldOutUntil,
      },
      input.observedAt,
    );
  });
}

/** One choice or extra a dish on sale offers, for the Store's sold-out list. */
export interface StoreChoiceOption {
  readonly optionReference: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  /** The dishes (current versions, on sale at the Brand) whose choices include it. */
  readonly dishNames: readonly Readonly<Record<string, string>>[];
}
/**
 * WP-2423 (M24): the Brand's choices and extras offered by at least one dish on sale, with the
 * dishes that offer each. A combo's choices that stand for a dish are left out: they follow that
 * dish's own sold-out mark. Bounded (`limit`, at most 1000), names first.
 */
export async function listStoreChoiceOptions(
  tx: SoldOutTransaction,
  scope: { readonly brandReference: string },
  limit = 500,
): Promise<readonly StoreChoiceOption[]> {
  const brand = reference(scope.brandReference);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new StoreOptionSoldOutError("STORE_OPTION_SOLD_OUT_INPUT_INVALID");
  return inBrandScope(tx, brand, async () => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT q.option,q.names,q.dishes FROM (SELECT o.option_id AS option_id,o.option_id::text AS option,o.localized_names_json AS names,
        COALESCE((SELECT jsonb_agg(DISTINCT pv.localized_names_json)
           FROM rms_catalog.product_option_binding_option x
           JOIN rms_catalog.product_option_binding b ON b.binding_id=x.binding_id AND b.product_id=x.product_id AND b.brand_id=x.brand_id
           JOIN rms_catalog.product_version pv ON pv.product_version_id=b.product_version_id AND pv.product_id=b.product_id AND pv.brand_id=b.brand_id
           JOIN rms_catalog.product p ON p.product_id=b.product_id AND p.brand_id=b.brand_id AND p.lifecycle='Active'
          WHERE x.brand_id=o.brand_id AND x.option_id=o.option_id
            AND EXISTS (SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=b.brand_id AND s.product_id=b.product_id
                         AND s.product_version_id=b.product_version_id AND s.lifecycle='Active')),'[]'::jsonb) AS dishes
         FROM rms_catalog.option o
        WHERE o.brand_id=$1 AND o.lifecycle='Active'
          AND NOT EXISTS (SELECT 1 FROM rms_catalog.bundle_combo_choice c WHERE c.brand_id=o.brand_id AND c.option_id=o.option_id)) q
        WHERE q.dishes <> '[]'::jsonb
        ORDER BY q.names::text,q.option_id
        LIMIT $2`,
      [brand, limit],
    );
    return rows.map((row) =>
      Object.freeze({
        optionReference: String(row.option),
        localizedNames: (row.names ?? {}) as Readonly<Record<string, string>>,
        dishNames: Object.freeze(
          (Array.isArray(row.dishes) ? row.dishes : []) as Readonly<Record<string, string>>[],
        ),
      }),
    );
  });
}

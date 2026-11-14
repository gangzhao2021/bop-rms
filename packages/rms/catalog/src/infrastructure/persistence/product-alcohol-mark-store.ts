/**
 * WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): dishes that contain alcohol (2000_152). The owner
 * marks a dish on the menu and the mark applies at once, without listing the menu again. Caller
 * authorizes and owns the transaction.
 */
interface AlcoholMarkTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export class ProductAlcoholMarkError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_ALCOHOL_MARK_INPUT_INVALID"
      /** Another change of the mark came first, or the operation was reused for another. */
      | "PRODUCT_ALCOHOL_MARK_CHANGED"
      | "PRODUCT_ALCOHOL_MARK_UNAVAILABLE",
  ) {
    super(code);
    this.name = "ProductAlcoholMarkError";
  }
}
const reference = (value: string): string => {
  if (!uuid.test(value)) throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_INPUT_INVALID");
  return value;
};
/**
 * Runs `work` in the Brand's scope. Products and sizes are read with no Store selected (their RLS
 * refuses them otherwise, showing nothing rather than an error), while the callers here work for a
 * Store: its context is put back afterwards.
 */
const inBrandScope = async <T>(
  tx: AlcoholMarkTransaction,
  brandReference: string,
  work: (brand: string) => Promise<T>,
): Promise<T> => {
  const brand = reference(brandReference);
  const before = (
    await tx.query<{ brand: string | null; store: string | null }>(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )
  ).rows[0];
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brand,
  ]);
  const value = await work(brand);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    before?.brand ?? "",
    before?.store ?? "",
  ]);
  return value;
};

/** The dishes asked about that have a mark, with each mark's version (absent: never marked). */
export async function loadProductAlcoholMarks(
  tx: AlcoholMarkTransaction,
  scope: { readonly brandReference: string },
  productReferences: readonly string[],
): Promise<ReadonlyMap<string, { readonly containsAlcohol: boolean; readonly version: number }>> {
  return inBrandScope(tx, scope.brandReference, async (brand) => {
    const { rows } = await tx.query<Record<string, unknown>>(
      "SELECT DISTINCT ON (product_id) product_id::text AS product,version,contains_alcohol FROM rms_catalog.product_alcohol_mark WHERE brand_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id,version DESC",
      [brand, productReferences.map(reference)],
    );
    const found = new Map<string, { containsAlcohol: boolean; version: number }>();
    for (const row of rows) {
      const version = Number(row.version);
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        typeof row.contains_alcohol !== "boolean"
      )
        throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_UNAVAILABLE");
      found.set(
        String(row.product),
        Object.freeze({ containsAlcohol: row.contains_alcohol, version }),
      );
    }
    return found;
  });
}

/** Of the sizes (SKUs) asked about, those whose dish contains alcohol now. */
export async function listAlcoholSkus(
  tx: AlcoholMarkTransaction,
  scope: { readonly brandReference: string },
  skuReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  return inBrandScope(tx, scope.brandReference, async (brand) => {
    const { rows } = await tx.query<Record<string, unknown>>(
      "SELECT s.sku_id::text AS sku FROM rms_catalog.sku s JOIN LATERAL (SELECT m.contains_alcohol FROM rms_catalog.product_alcohol_mark m WHERE m.brand_id=s.brand_id AND m.product_id=s.product_id ORDER BY m.version DESC LIMIT 1) latest ON latest.contains_alcohol WHERE s.brand_id=$1 AND s.sku_id=ANY($2::uuid[])",
      [brand, skuReferences.map(reference)],
    );
    return new Set(rows.map((row) => String(row.sku)));
  });
}

/**
 * The owner marks a dish (or clears the mark): the dish's next version, with who and when, against
 * the version they saw (0: never marked). The same operation again returns what it recorded.
 */
export async function changeProductAlcoholMark(
  tx: AlcoholMarkTransaction,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  input: {
    readonly productReference: string;
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly containsAlcohol: boolean;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<{ readonly containsAlcohol: boolean; readonly version: number }> {
  const product = reference(input.productReference);
  const operation = reference(input.operationReference);
  if (
    typeof input.containsAlcohol !== "boolean" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    !instant.test(input.observedAt)
  )
    throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_INPUT_INVALID");
  return inBrandScope(tx, scope.brandReference, async (brand) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ProductAlcoholMark:${brand}:${product}`,
    ]);
    const prior = (
      await tx.query<Record<string, unknown>>(
        "SELECT product_id::text AS product,version,contains_alcohol FROM rms_catalog.product_alcohol_mark WHERE brand_id=$1 AND operation_id=$2",
        [brand, operation],
      )
    ).rows[0];
    if (prior !== undefined) {
      if (prior.product !== product || prior.contains_alcohol !== input.containsAlcohol)
        throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_CHANGED");
      return Object.freeze({
        containsAlcohol: input.containsAlcohol,
        version: Number(prior.version),
      });
    }
    const current = (await loadProductAlcoholMarks(tx, scope, [product])).get(product);
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_CHANGED");
    const known = await tx.query(
      "SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2",
      [brand, product],
    );
    if (known.rows.length !== 1)
      throw new ProductAlcoholMarkError("PRODUCT_ALCOHOL_MARK_INPUT_INVALID");
    const version = input.expectedVersion + 1;
    await tx.query(
      "INSERT INTO rms_catalog.product_alcohol_mark (tenant_id,brand_id,product_id,version,operation_id,contains_alcohol,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        reference(scope.tenantReference),
        brand,
        product,
        version,
        operation,
        input.containsAlcohol,
        reference(input.actorReference),
        input.observedAt,
      ],
    );
    return Object.freeze({ containsAlcohol: input.containsAlcohol, version });
  });
}

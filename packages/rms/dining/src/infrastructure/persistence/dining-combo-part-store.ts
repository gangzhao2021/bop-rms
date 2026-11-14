/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): each dish
 * chosen in a combo is served on its own (2000_117). The combo's order line keeps its own service
 * records; these say which of its chosen dishes are served. Caller authorizes, checks the dish is
 * one the line has, and owns the transaction with the Brand and Store scope set.
 */
interface ComboPartTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: string): string => {
  if (!uuid.test(value)) throw new Error("DINING_COMBO_PART_INPUT_INVALID");
  return value;
};
interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}

/** The chosen dishes of these order lines already served. */
export async function listDiningComboPartsServed(
  tx: ComboPartTransaction,
  scope: Scope,
  input: { readonly orderItemReferences: readonly string[] },
): Promise<readonly { readonly orderItemReference: string; readonly optionReference: string }[]> {
  if (input.orderItemReferences.length === 0) return [];
  const { rows } = await tx.query<Record<string, string>>(
    `SELECT order_item_id::text order_item,option_id::text option FROM rms_dining.dining_combo_part_served
      WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND order_item_id=ANY($4::uuid[])
      ORDER BY served_at,option_id`,
    [
      reference(scope.tenantReference),
      reference(scope.brandReference),
      reference(scope.storeReference),
      input.orderItemReferences.map(reference),
    ],
  );
  return rows.map((row) =>
    Object.freeze({
      orderItemReference: String(row.order_item),
      optionReference: String(row.option),
    }),
  );
}

/** Marks one chosen dish of a combo served at the table (once; a retry is a no-op). */
export async function recordDiningComboPartServed(
  tx: ComboPartTransaction,
  scope: Scope,
  input: {
    readonly diningSessionReference: string;
    readonly orderItemReference: string;
    readonly optionReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly servedAt: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO rms_dining.dining_combo_part_served(tenant_id,brand_id,store_id,session_id,order_item_id,option_id,operation_id,actor_id,served_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,brand_id,store_id,order_item_id,option_id) DO NOTHING`,
    [
      reference(scope.tenantReference),
      reference(scope.brandReference),
      reference(scope.storeReference),
      reference(input.diningSessionReference),
      reference(input.orderItemReference),
      reference(input.optionReference),
      reference(input.operationReference),
      reference(input.actorReference),
      input.servedAt,
    ],
  );
}

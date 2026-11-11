/**
 * WP-2423 sold-out-and-allergen-safety (M178; 2000_476): what a Store's kitchen says about
 * cross-contact — the allergens it handles (the Brand's allergen-list codes) and the equipment it
 * shares — shown to guests above every dish's own allergens. Ticks only, versioned: the latest
 * record is current. Read and written in the caller's transaction; it selects the Store itself.
 */
interface StatementTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}
export const kitchenSharedEquipment = [
  "Woks",
  "FryerOil",
  "Grill",
  "Utensils",
  "PrepSurfaces",
  "Steamers",
] as const;
export type KitchenSharedEquipment = (typeof kitchenSharedEquipment)[number];
export interface StoreKitchenStatement {
  readonly handledAllergenCodes: readonly string[];
  readonly sharedEquipment: readonly KitchenSharedEquipment[];
  readonly recordedAt: string;
}
export class StoreKitchenStatementError extends Error {
  constructor(
    readonly code:
      | "STORE_KITCHEN_STATEMENT_INVALID"
      /** The operation was already used for another statement. */
      | "STORE_KITCHEN_STATEMENT_CONFLICT",
  ) {
    super(code);
    this.name = "StoreKitchenStatementError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const invalid = (): never => {
  throw new StoreKitchenStatementError("STORE_KITCHEN_STATEMENT_INVALID");
};
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : invalid();

/** The statement's ticks, as recorded: unique and sorted, codes in list form. */
export function parseStoreKitchenStatement(input: {
  readonly handledAllergenCodes: unknown;
  readonly sharedEquipment: unknown;
}): Omit<StoreKitchenStatement, "recordedAt"> {
  const codes = input.handledAllergenCodes;
  const equipment = input.sharedEquipment;
  if (!Array.isArray(codes) || codes.length > 30 || !Array.isArray(equipment)) return invalid();
  const handled = codes.map((code: unknown) =>
    typeof code === "string" && /^[A-Z][A-Z0-9_-]{1,39}$/u.test(code) ? code : invalid(),
  );
  const shared = equipment.map((item: unknown) =>
    (kitchenSharedEquipment as readonly unknown[]).includes(item)
      ? (item as KitchenSharedEquipment)
      : invalid(),
  );
  if (new Set(handled).size !== handled.length || new Set(shared).size !== shared.length)
    return invalid();
  return Object.freeze({
    handledAllergenCodes: Object.freeze([...handled].sort()),
    sharedEquipment: Object.freeze(kitchenSharedEquipment.filter((item) => shared.includes(item))),
  });
}

const selectStore = (
  tx: StatementTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    ref(scope.brandReference),
    ref(scope.storeReference),
  ]);

/** The Store's current statement, or null when none was set. */
export async function loadStoreKitchenStatement(
  tx: StatementTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<StoreKitchenStatement | null> {
  await selectStore(tx, scope);
  const row = (
    await tx.query<{ codes: unknown; equipment: unknown; recorded_at: string }>(
      `SELECT handled_allergen_codes codes,shared_equipment equipment,
         to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at
       FROM rms_store.store_kitchen_allergen_statement WHERE brand_id=$1 AND store_id=$2
       ORDER BY recorded_at DESC,statement_id DESC LIMIT 1`,
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    ...parseStoreKitchenStatement({
      handledAllergenCodes: row.codes,
      sharedEquipment: row.equipment,
    }),
    recordedAt: row.recorded_at,
  });
}

/** Records the Store's statement now (idempotent by operation). */
export async function recordStoreKitchenStatement(
  tx: StatementTransaction,
  scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  },
  input: {
    readonly statementReference: string;
    readonly handledAllergenCodes: readonly string[];
    readonly sharedEquipment: readonly string[];
    readonly actorReference: string;
    readonly operationReference: string;
    readonly recordedAt: string;
  },
): Promise<{ readonly status: "Applied" | "AlreadyApplied" }> {
  const ticks = parseStoreKitchenStatement(input);
  if (!instant.test(input.recordedAt)) return invalid();
  await selectStore(tx, scope);
  const prior = (
    await tx.query<{ codes: string[]; equipment: string[] }>(
      "SELECT handled_allergen_codes codes,shared_equipment equipment FROM rms_store.store_kitchen_allergen_statement WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [scope.brandReference, scope.storeReference, ref(input.operationReference)],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (
      JSON.stringify([...prior.codes].sort()) !== JSON.stringify(ticks.handledAllergenCodes) ||
      JSON.stringify(kitchenSharedEquipment.filter((item) => prior.equipment.includes(item))) !==
        JSON.stringify(ticks.sharedEquipment)
    )
      throw new StoreKitchenStatementError("STORE_KITCHEN_STATEMENT_CONFLICT");
    return { status: "AlreadyApplied" };
  }
  await tx.query(
    `INSERT INTO rms_store.store_kitchen_allergen_statement(tenant_id,brand_id,store_id,statement_id,handled_allergen_codes,shared_equipment,actor_id,operation_id,recorded_at)
     VALUES($1,$2,$3,$4,$5::text[],$6::text[],$7,$8,$9)`,
    [
      ref(scope.tenantReference),
      scope.brandReference,
      scope.storeReference,
      ref(input.statementReference),
      ticks.handledAllergenCodes,
      ticks.sharedEquipment,
      ref(input.actorReference),
      input.operationReference,
      input.recordedAt,
    ],
  );
  return { status: "Applied" };
}

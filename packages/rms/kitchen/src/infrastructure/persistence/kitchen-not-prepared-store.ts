/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): dishes
 * the kitchen does not prepare (2000_123). The owner marks a dish on the menu (a bottled drink, the
 * per-head tea); it never reaches the kitchen board and counts as served once ordered. What the
 * kitchen decided for a round is fixed when the round reaches it, so a later change of the mark
 * never moves work already issued. Caller authorizes and owns the transaction.
 */
interface NotPreparedTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const reference = (value: string): string => {
  if (!uuid.test(value)) throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_INPUT_INVALID");
  return value;
};
const at = (value: string): string => {
  if (!instant.test(value) || !Number.isFinite(Date.parse(value)))
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_INPUT_INVALID");
  return value;
};
export class KitchenNotPreparedError extends Error {
  constructor(
    readonly code:
      | "KITCHEN_NOT_PREPARED_INPUT_INVALID"
      /** Another change of the mark came first, or the operation was reused for another. */
      | "KITCHEN_NOT_PREPARED_CHANGED"
      | "KITCHEN_NOT_PREPARED_UNAVAILABLE",
  ) {
    super(code);
    this.name = "KitchenNotPreparedError";
  }
}
type Scope = { readonly brandReference: string; readonly storeReference: string };
const context = async (tx: NotPreparedTransaction, scope: Scope) => {
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  return { brand, store };
};

/** The dishes (products) marked as not prepared by the kitchen now, with each mark's version. */
export async function loadKitchenNotPreparedProducts(
  tx: NotPreparedTransaction,
  scope: Scope,
  productReferences: readonly string[] | null = null,
): Promise<ReadonlyMap<string, { readonly notPrepared: boolean; readonly version: number }>> {
  const { brand, store } = await context(tx, scope);
  const products = productReferences === null ? null : productReferences.map(reference);
  const { rows } = await tx.query<Record<string, unknown>>(
    "SELECT DISTINCT ON (product_id) product_id::text AS product,version,not_prepared FROM rms_kitchen.kitchen_not_prepared_product WHERE brand_id=$1 AND store_id=$2 AND ($3::uuid[] IS NULL OR product_id=ANY($3::uuid[])) ORDER BY product_id,version DESC",
    [brand, store, products],
  );
  const found = new Map<string, { notPrepared: boolean; version: number }>();
  for (const row of rows) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1 || typeof row.not_prepared !== "boolean")
      throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_UNAVAILABLE");
    found.set(String(row.product), Object.freeze({ notPrepared: row.not_prepared, version }));
  }
  return found;
}

/**
 * The owner marks a dish (or clears the mark): the dish's next version, with who and when, against
 * the version they saw (0: never marked). The same operation again returns what it recorded.
 */
export async function changeKitchenNotPreparedProduct(
  tx: NotPreparedTransaction,
  scope: Scope & { readonly tenantReference: string },
  input: {
    readonly productReference: string;
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly notPrepared: boolean;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): Promise<{ readonly notPrepared: boolean; readonly version: number }> {
  const { brand, store } = await context(tx, scope);
  const product = reference(input.productReference);
  const operation = reference(input.operationReference);
  if (
    typeof input.notPrepared !== "boolean" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_INPUT_INVALID");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `KitchenNotPrepared:${brand}:${store}:${product}`,
  ]);
  const prior = (
    await tx.query<Record<string, unknown>>(
      "SELECT product_id::text AS product,not_prepared,version FROM rms_kitchen.kitchen_not_prepared_product WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (String(prior.product) !== product || prior.not_prepared !== input.notPrepared)
      throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_CHANGED");
    return Object.freeze({ notPrepared: input.notPrepared, version: Number(prior.version) });
  }
  const current = (await loadKitchenNotPreparedProducts(tx, scope, [product])).get(product);
  if ((current?.version ?? 0) !== input.expectedVersion)
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_CHANGED");
  if ((current?.notPrepared ?? false) === input.notPrepared)
    return current ?? Object.freeze({ notPrepared: false, version: 0 });
  const version = (current?.version ?? 0) + 1;
  const inserted = await tx.query(
    "INSERT INTO rms_kitchen.kitchen_not_prepared_product (tenant_id,brand_id,store_id,product_id,version,operation_id,not_prepared,actor_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      reference(scope.tenantReference),
      brand,
      store,
      product,
      version,
      operation,
      input.notPrepared,
      reference(input.actorReference),
      at(input.observedAt),
    ],
  );
  if (inserted.rowCount !== 1)
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_UNAVAILABLE");
  return Object.freeze({ notPrepared: input.notPrepared, version });
}

export interface KitchenBatchPreparationDecision {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly sourceEventReference: string;
  readonly confirmationReference: string;
  /** The round's lines the kitchen does not prepare (empty: all go to the kitchen). */
  readonly notPreparedOrderItemReferences: readonly string[];
  readonly allNotPrepared: boolean;
  /** The intake receipt of a round that made no ticket. */
  readonly intakeReceipt: unknown;
  readonly decidedAt: string;
}
const decisionOf = (row: Record<string, unknown>): KitchenBatchPreparationDecision => {
  const items = row.items;
  if (!Array.isArray(items) || typeof row.all_not_prepared !== "boolean")
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_UNAVAILABLE");
  return Object.freeze({
    orderReference: String(row.order_id),
    orderBatchReference: String(row.order_batch_id),
    sourceEventReference: String(row.source_event_id),
    confirmationReference: String(row.confirmation_id),
    notPreparedOrderItemReferences: Object.freeze(items.map(String)),
    allNotPrepared: row.all_not_prepared,
    intakeReceipt: row.intake_receipt ?? null,
    decidedAt: String(row.decided_at),
  });
};
const decisionColumns =
  "order_id::text AS order_id,order_batch_id::text AS order_batch_id,source_event_id::text AS source_event_id,confirmation_id::text AS confirmation_id,not_prepared_order_item_ids::text[] AS items,all_not_prepared,intake_receipt,to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS decided_at";

/** What the kitchen decided for this round when it reached it (null: not yet). */
export async function loadKitchenBatchPreparationDecision(
  tx: NotPreparedTransaction,
  scope: Scope,
  orderBatchReference: string,
): Promise<KitchenBatchPreparationDecision | null> {
  const { brand, store } = await context(tx, scope);
  const row = (
    await tx.query<Record<string, unknown>>(
      `SELECT ${decisionColumns} FROM rms_kitchen.kitchen_batch_preparation_decision WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3`,
      [brand, store, reference(orderBatchReference)],
    )
  ).rows[0];
  return row === undefined ? null : decisionOf(row);
}

/** Whether the kitchen holds work (a ticket) for this round. */
export async function kitchenBatchHasTicket(
  tx: NotPreparedTransaction,
  scope: Scope,
  orderBatchReference: string,
): Promise<boolean> {
  const { brand, store } = await context(tx, scope);
  const { rows } = await tx.query(
    "SELECT 1 FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3 LIMIT 1",
    [brand, store, reference(orderBatchReference)],
  );
  return rows.length > 0;
}

/**
 * Kitchen's public read for an Order: the order items the kitchen did not prepare (decided when
 * each round reached it). Dining counts them as served once ordered.
 */
export async function listKitchenNotPreparedOrderItems(
  tx: NotPreparedTransaction,
  scope: Scope,
  orderReference: string,
): Promise<ReadonlySet<string>> {
  const { brand, store } = await context(tx, scope);
  const { rows } = await tx.query<Record<string, unknown>>(
    "SELECT unnest(not_prepared_order_item_ids)::text AS item FROM rms_kitchen.kitchen_batch_preparation_decision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
    [brand, store, reference(orderReference)],
  );
  return new Set(rows.map((row) => String(row.item)));
}

/** The kitchen fixes what it does for a round as the round reaches it (once per round). */
export async function recordKitchenBatchPreparationDecision(
  tx: NotPreparedTransaction,
  scope: Scope,
  decision: Omit<KitchenBatchPreparationDecision, "decidedAt"> & { readonly decidedAt: string },
): Promise<KitchenBatchPreparationDecision> {
  const { brand, store } = await context(tx, scope);
  const existing = await loadKitchenBatchPreparationDecision(
    tx,
    scope,
    decision.orderBatchReference,
  );
  if (existing !== null) {
    if (
      existing.sourceEventReference !== decision.sourceEventReference ||
      JSON.stringify([...existing.notPreparedOrderItemReferences].sort()) !==
        JSON.stringify([...decision.notPreparedOrderItemReferences].sort())
    )
      throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_CHANGED");
    return existing;
  }
  const inserted = await tx.query(
    "INSERT INTO rms_kitchen.kitchen_batch_preparation_decision (brand_id,store_id,order_id,order_batch_id,source_event_id,confirmation_id,not_prepared_order_item_ids,all_not_prepared,intake_receipt,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9::jsonb,$10)",
    [
      brand,
      store,
      reference(decision.orderReference),
      reference(decision.orderBatchReference),
      reference(decision.sourceEventReference),
      reference(decision.confirmationReference),
      decision.notPreparedOrderItemReferences.map(reference),
      decision.allNotPrepared,
      decision.intakeReceipt === null ? null : JSON.stringify(decision.intakeReceipt),
      at(decision.decidedAt),
    ],
  );
  if (inserted.rowCount !== 1)
    throw new KitchenNotPreparedError("KITCHEN_NOT_PREPARED_UNAVAILABLE");
  return (await loadKitchenBatchPreparationDecision(
    tx,
    scope,
    decision.orderBatchReference,
  )) as KitchenBatchPreparationDecision;
}

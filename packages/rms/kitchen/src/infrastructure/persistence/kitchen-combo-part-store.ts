/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): each dish
 * chosen in a combo is marked done on its own (2000_116). The combo's work item keeps its own
 * lifecycle; these records say which of its chosen dishes are done. Caller authorizes and owns the
 * transaction with the Brand and Store scope set.
 */
interface ComboPartTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: string): string => {
  if (!uuid.test(value)) throw new Error("KITCHEN_COMBO_PART_INPUT_INVALID");
  return value;
};

/** The chosen dishes marked done, by work item and by the order item it makes. */
export async function listKitchenComboPartsDone(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly orderItemReferences: readonly string[] },
): Promise<
  readonly {
    readonly workItemReference: string;
    readonly orderItemReference: string;
    readonly optionReference: string;
    readonly doneAt: string;
  }[]
> {
  if (input.orderItemReferences.length === 0) return [];
  const { rows } = await tx.query<Record<string, string>>(
    `SELECT d.kitchen_work_item_id::text work_item,w.order_item_id::text order_item,d.option_id::text option,
       to_char(d.done_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') done_at
       FROM rms_kitchen.kitchen_combo_part_done d
       JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_work_item_id=d.kitchen_work_item_id
        AND w.brand_id=d.brand_id AND w.store_id=d.store_id
      WHERE d.brand_id=$1 AND d.store_id=$2 AND w.order_item_id=ANY($3::uuid[])
      ORDER BY d.done_at,d.option_id`,
    [
      reference(scope.brandReference),
      reference(scope.storeReference),
      input.orderItemReferences.map(reference),
    ],
  );
  return rows.map((row) =>
    Object.freeze({
      workItemReference: String(row.work_item),
      orderItemReference: String(row.order_item),
      optionReference: String(row.option),
      doneAt: String(row.done_at),
    }),
  );
}

/** One chosen dish of a combo as the kitchen takes it. */
export interface KitchenComboDish {
  readonly optionReference: string;
  readonly productReference: string;
  /**
   * The dish was marked "not prepared by the kitchen" when its work reached the kitchen (a bottled
   * drink): it is never a kitchen step, never holds up its combo, and the server may hand it over.
   * DEC-STORE-FEATURES decision 2: a later change of the mark never moves work already issued.
   */
  readonly notPrepared: boolean;
  /** When the kitchen marked it done; null: not yet. */
  readonly doneAt: string | null;
}

/**
 * DEC-KITCHEN-ONE-TAP / combos by section: the one place that says what a combo's chosen dishes are
 * for the kitchen, read by the board, the table panel, the part-served command and the kitchen step,
 * so they cannot disagree. `productOfOption` is the Catalog's combo record for the options asked
 * about (a line's other options are not dishes). The mark is read as of the work item's creation; a
 * line the kitchen decided not to prepare at all has every dish not prepared, and a round the kitchen
 * has not reached yet has none.
 */
export async function listKitchenComboDishes(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly items: readonly {
      readonly orderItemReference: string;
      readonly optionReferences: readonly string[];
    }[];
    readonly productOfOption: ReadonlyMap<string, string>;
  },
): Promise<ReadonlyMap<string, readonly KitchenComboDish[]>> {
  const combos = input.items.filter((item) =>
    item.optionReferences.some((option) => input.productOfOption.has(option)),
  );
  if (combos.length === 0) return new Map();
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const lines = combos.map((item) => reference(item.orderItemReference));
  const products = [
    ...new Set(
      combos.flatMap((item) =>
        item.optionReferences.flatMap((option) => {
          const product = input.productOfOption.get(option);
          return product === undefined ? [] : [reference(product)];
        }),
      ),
    ),
  ];
  const marks = await tx.query<{ line: string; product: string; not_prepared: boolean | null }>(
    `SELECT w.order_item_id::text AS line,m.product::text AS product,
       (SELECT n.not_prepared FROM rms_kitchen.kitchen_not_prepared_product n
         WHERE n.brand_id=w.brand_id AND n.store_id=w.store_id AND n.product_id=m.product AND n.occurred_at<=w.created_at
         ORDER BY n.version DESC LIMIT 1) AS not_prepared
       FROM rms_kitchen.kitchen_work_item w CROSS JOIN unnest($3::uuid[]) AS m(product)
      WHERE w.brand_id=$1 AND w.store_id=$2 AND w.order_item_id=ANY($4::uuid[])`,
    [brand, store, products, lines],
  );
  const hasWork = new Set(marks.rows.map((row) => row.line));
  const marked = new Set(
    marks.rows
      .filter((row) => row.not_prepared === true)
      .map((row) => row.line + ":" + row.product),
  );
  const withoutWork = lines.filter((line) => !hasWork.has(line));
  const wholeLineNotPrepared = new Set(
    withoutWork.length === 0
      ? []
      : (
          await tx.query<{ line: string }>(
            `SELECT line::text AS line FROM rms_kitchen.kitchen_batch_preparation_decision d,
               unnest(d.not_prepared_order_item_ids) AS line
              WHERE d.brand_id=$1 AND d.store_id=$2 AND line=ANY($3::uuid[])`,
            [brand, store, withoutWork],
          )
        ).rows.map((row) => row.line),
  );
  const done = new Map(
    (await listKitchenComboPartsDone(tx, scope, { orderItemReferences: lines })).map((row) => [
      row.orderItemReference + ":" + row.optionReference,
      row.doneAt,
    ]),
  );
  return new Map(
    combos.map((item) => [
      item.orderItemReference,
      Object.freeze(
        item.optionReferences.flatMap((option) => {
          const product = input.productOfOption.get(option);
          if (product === undefined) return [];
          return [
            Object.freeze({
              optionReference: option,
              productReference: product,
              notPrepared:
                wholeLineNotPrepared.has(item.orderItemReference) ||
                marked.has(item.orderItemReference + ":" + product),
              doneAt: done.get(item.orderItemReference + ":" + option) ?? null,
            }),
          ];
        }),
      ),
    ]),
  );
}

/**
 * Marks one chosen dish of a combo done (once; a retry of the same operation is a no-op). The
 * database refuses a dish the work item does not have, or a cancelled work item.
 */
export async function recordKitchenComboPartDone(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly workItemReference: string;
    readonly optionReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly doneAt: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO rms_kitchen.kitchen_combo_part_done(brand_id,store_id,kitchen_work_item_id,option_id,operation_id,actor_id,done_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (brand_id,store_id,kitchen_work_item_id,option_id) DO NOTHING`,
    [
      reference(scope.brandReference),
      reference(scope.storeReference),
      reference(input.workItemReference),
      reference(input.optionReference),
      reference(input.operationReference),
      reference(input.actorReference),
      input.doneAt,
    ],
  );
}

/** A work item's order line, its chosen options and its status (null when not at this store). */
export async function loadKitchenWorkItemChoices(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  workItemReference: string,
): Promise<{
  readonly orderItemReference: string;
  readonly optionReferences: readonly string[];
  readonly status: string;
} | null> {
  const { rows } = await tx.query<{ order_item: string; options: unknown; status: string }>(
    `SELECT order_item_id::text order_item,selected_options_json options,status
       FROM rms_kitchen.kitchen_work_item WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
    [
      reference(scope.brandReference),
      reference(scope.storeReference),
      reference(workItemReference),
    ],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    orderItemReference: String(row.order_item),
    optionReferences: Object.freeze(
      (Array.isArray(row.options) ? row.options : []).map((o: { optionReference?: unknown }) =>
        String(o.optionReference),
      ),
    ),
    status: String(row.status),
  });
}

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner decision 4): how often each work item of these order
 * items was chased by a server, and when last (2000_120).
 */
export async function listKitchenWorkChases(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly orderItemReferences: readonly string[] },
): Promise<
  readonly {
    readonly workItemReference: string;
    readonly orderItemReference: string;
    readonly count: number;
    readonly lastChasedAt: string;
  }[]
> {
  if (input.orderItemReferences.length === 0) return [];
  const { rows } = await tx.query<Record<string, string | number>>(
    `SELECT c.kitchen_work_item_id::text work_item,w.order_item_id::text order_item,count(*)::int n,
       to_char(max(c.chased_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') last_at
       FROM rms_kitchen.kitchen_work_chase c
       JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_work_item_id=c.kitchen_work_item_id
        AND w.brand_id=c.brand_id AND w.store_id=c.store_id
      WHERE c.brand_id=$1 AND c.store_id=$2 AND w.order_item_id=ANY($3::uuid[])
      GROUP BY c.kitchen_work_item_id,w.order_item_id ORDER BY 2,1`,
    [
      reference(scope.brandReference),
      reference(scope.storeReference),
      input.orderItemReferences.map(reference),
    ],
  );
  return rows.map((row) =>
    Object.freeze({
      workItemReference: String(row.work_item),
      orderItemReference: String(row.order_item),
      count: Number(row.n),
      lastChasedAt: String(row.last_at),
    }),
  );
}

/** The work items still being made for an order item (oldest first), with their round. */
export async function listKitchenWorkItemsToMake(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderItemReference: string,
): Promise<
  readonly { readonly workItemReference: string; readonly orderBatchReference: string }[]
> {
  const { rows } = await tx.query<Record<string, string>>(
    `SELECT kitchen_work_item_id::text work_item,order_batch_id::text batch FROM rms_kitchen.kitchen_work_item
      WHERE brand_id=$1 AND store_id=$2 AND order_item_id=$3 AND status IN ('Queued','Held','In Progress')
      ORDER BY created_at,kitchen_work_item_id`,
    [
      reference(scope.brandReference),
      reference(scope.storeReference),
      reference(orderItemReference),
    ],
  );
  return rows.map((row) =>
    Object.freeze({
      workItemReference: String(row.work_item),
      orderBatchReference: String(row.batch),
    }),
  );
}

/** A chase was refused: the round was chased in the last 5 minutes (when it may be again). */
export class KitchenChaseTooSoonError extends Error {
  constructor(readonly retryAt: string) {
    super("KITCHEN_CHASE_TOO_SOON");
    this.name = "KitchenChaseTooSoonError";
  }
}

/**
 * Records one chase of a work item (the same chase again is a no-op). A round is chased at most
 * once in any 5 minutes: the database refuses sooner, and this tells when it may be chased again.
 */
export async function recordKitchenWorkChase(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly chaseReference: string;
    readonly workItemReference: string;
    readonly orderBatchReference: string;
    readonly actorReference: string;
    readonly chasedAt: string;
  },
): Promise<{ readonly recorded: boolean }> {
  const brand = reference(scope.brandReference),
    store = reference(scope.storeReference);
  const prior = await tx.query(
    "SELECT 1 FROM rms_kitchen.kitchen_work_chase WHERE brand_id=$1 AND store_id=$2 AND chase_id=$3",
    [brand, store, reference(input.chaseReference)],
  );
  if (prior.rows.length > 0) return { recorded: false };
  const recent = await tx.query<{ until: string }>(
    `SELECT to_char((max(chased_at)+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') until
       FROM rms_kitchen.kitchen_work_chase
      WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3 AND chased_at > $4::timestamptz - interval '5 minutes'
      HAVING count(*) > 0`,
    [brand, store, reference(input.orderBatchReference), input.chasedAt],
  );
  const until = recent.rows[0]?.until;
  if (until !== undefined) throw new KitchenChaseTooSoonError(String(until));
  await tx.query(
    `INSERT INTO rms_kitchen.kitchen_work_chase(brand_id,store_id,chase_id,kitchen_work_item_id,order_batch_id,actor_id,chased_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      brand,
      store,
      reference(input.chaseReference),
      reference(input.workItemReference),
      reference(input.orderBatchReference),
      reference(input.actorReference),
      input.chasedAt,
    ],
  );
  return { recorded: true };
}

/** Whether this chase (its operation) was already recorded. */
export async function kitchenWorkChaseRecorded(
  tx: ComboPartTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  chaseReference: string,
): Promise<boolean> {
  const { rows } = await tx.query(
    "SELECT 1 FROM rms_kitchen.kitchen_work_chase WHERE brand_id=$1 AND store_id=$2 AND chase_id=$3",
    [reference(scope.brandReference), reference(scope.storeReference), reference(chaseReference)],
  );
  return rows.length > 0;
}

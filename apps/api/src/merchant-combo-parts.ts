import { listBrandSkuChoices, listBundleComboRecords } from "@rms/catalog";
import { listDiningComboPartsServed, recordDiningComboPartServed } from "@rms/dining";
import { listKitchenComboPartsDone, recordKitchenComboPartDone } from "@rms/kitchen";
import { chineseOf } from "./merchant-chinese-text.js";

/**
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (coordinator 2026-10-28 decision 3): each dish
 * chosen in a combo is its own line under the combo — Chinese name first — marked done in the
 * kitchen and served at the table on its own. The combo stays one kitchen work item and one order
 * line, so its lifecycle, ready, serving, stock, payment and report steps are unchanged; when every
 * dish is done (served), the board (serving page) finishes (serves) the combo with the existing
 * command. Which dish a choice stands for is the Catalog's combo record (2000_115).
 */
export interface ComboPart {
  readonly optionReference: string;
  /** The dish's Chinese name ("" when it has none) and its name in the page language. */
  readonly nameZh: string;
  readonly name: string;
  readonly done: boolean;
  readonly served: boolean;
}
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}
interface Scope {
  readonly tenantReference?: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
const restoreStore = (tx: Tx, scope: Scope) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);

/**
 * The combo parts of these order lines (lines that are not combos are left out): the chosen
 * dishes in the order chosen, each with whether the kitchen marked it done and (with a tenant)
 * whether it was served.
 */
export async function comboPartsByOrderItem(
  tx: Tx,
  scope: Scope,
  locale: string,
  items: readonly {
    readonly orderItemReference: string;
    readonly optionReferences: readonly string[];
  }[],
): Promise<ReadonlyMap<string, readonly ComboPart[]>> {
  const records = await listBundleComboRecords(tx as never, scope);
  const dishOf = new Map(records.choices.map((c) => [c.optionReference, c.dishSkuReference]));
  const combos = items.filter(
    (item) => item.optionReferences.length > 0 && item.optionReferences.some((o) => dishOf.has(o)),
  );
  if (combos.length === 0) {
    await restoreStore(tx, scope);
    return new Map();
  }
  const skus = new Map(
    (await listBrandSkuChoices(tx as never, scope)).map((sku) => [sku.skuReference, sku]),
  );
  await restoreStore(tx, scope);
  const orderItems = combos.map((item) => item.orderItemReference);
  const done = new Set(
    (await listKitchenComboPartsDone(tx as never, scope, { orderItemReferences: orderItems })).map(
      (row) => row.orderItemReference + ":" + row.optionReference,
    ),
  );
  const served = new Set(
    scope.tenantReference === undefined
      ? []
      : (
          await listDiningComboPartsServed(
            tx as never,
            { ...scope, tenantReference: scope.tenantReference },
            { orderItemReferences: orderItems },
          )
        ).map((row) => row.orderItemReference + ":" + row.optionReference),
  );
  // A combo whose dishes cannot be named is left out (shown and served as one line).
  return new Map(
    combos.flatMap((item) => {
      const parts = Object.freeze(
        item.optionReferences.flatMap((option) => {
          const sku = skus.get(dishOf.get(option) ?? "");
          if (sku === undefined) return [];
          const names = sku.productLocalizedNames;
          const key = item.orderItemReference + ":" + option;
          return [
            Object.freeze({
              optionReference: option,
              nameZh: chineseOf(names),
              name: names[locale] ?? names["en-CA"] ?? Object.values(names)[0] ?? sku.skuCode,
              done: done.has(key),
              served: served.has(key),
            }),
          ];
        }),
      );
      return parts.length === 0 ? [] : [[item.orderItemReference, parts] as const];
    }),
  );
}

/** A combo's dish marked done in the kitchen; true when every dish of the combo is done now. */
export async function markKitchenComboPartDone(
  tx: Tx,
  scope: Scope,
  input: {
    readonly workItemReference: string;
    readonly orderItemReference: string;
    readonly optionReferences: readonly string[];
    readonly optionReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly locale: string;
  },
): Promise<{ readonly allDone: boolean }> {
  const before = (
    await comboPartsByOrderItem(tx, scope, input.locale, [
      { orderItemReference: input.orderItemReference, optionReferences: input.optionReferences },
    ])
  ).get(input.orderItemReference);
  if (before === undefined || !before.some((p) => p.optionReference === input.optionReference))
    throw new Error("KITCHEN_COMBO_PART_NOT_FOUND");
  await recordKitchenComboPartDone(tx as never, scope, {
    workItemReference: input.workItemReference,
    optionReference: input.optionReference,
    operationReference: input.operationReference,
    actorReference: input.actorReference,
    doneAt: input.at,
  });
  return {
    allDone: before.every((p) => p.done || p.optionReference === input.optionReference),
  };
}

/** A combo's dish served at the table; true when every dish of the combo is served now. */
export async function markDiningComboPartServed(
  tx: Tx,
  scope: Required<Scope>,
  input: {
    readonly diningSessionReference: string;
    readonly orderItemReference: string;
    readonly optionReferences: readonly string[];
    readonly optionReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly at: string;
    readonly locale: string;
  },
): Promise<{ readonly allServed: boolean }> {
  const before = (
    await comboPartsByOrderItem(tx, scope, input.locale, [
      { orderItemReference: input.orderItemReference, optionReferences: input.optionReferences },
    ])
  ).get(input.orderItemReference);
  const part = before?.find((p) => p.optionReference === input.optionReference);
  if (before === undefined || part === undefined) throw new Error("DINING_COMBO_PART_NOT_FOUND");
  // A dish is served once the kitchen made it.
  if (!part.done) throw new Error("DINING_COMBO_PART_NOT_READY");
  await recordDiningComboPartServed(tx as never, scope, {
    diningSessionReference: input.diningSessionReference,
    orderItemReference: input.orderItemReference,
    optionReference: input.optionReference,
    operationReference: input.operationReference,
    actorReference: input.actorReference,
    servedAt: input.at,
  });
  return {
    allServed: before.every((p) => p.served || p.optionReference === input.optionReference),
  };
}

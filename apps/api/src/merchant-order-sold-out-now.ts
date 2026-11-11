import { listOptionsOffNow, listStoreAvailabilityRules } from "@rms/catalog";
import { itemAvailability } from "./merchant-availability.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M23): a guest paid before a dish (or a choice in it) sold
 * out or came off the menu here. Payment never refuses a paid order for that (it would be an
 * automatic refund); staff are told on Orders before they accept, and decide: offer a swap, or
 * reject that dish with a refund. Nothing is refunded or cancelled here.
 *
 * Read in the queue's own transaction from the Store's availability rules and choice marks (the
 * same facts Item availability shows); stock is not re-read (the kitchen sees what is there).
 */
export type LineUnavailableNow = "SoldOut" | "Hidden" | "ChoiceSoldOut";

interface Tx {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

export async function orderLinesUnavailableNow(
  tx: unknown,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly orderType: "Pickup" | "DineIn";
    readonly at: string;
    readonly lines: readonly {
      readonly orderItemReference: string;
      readonly sellableReference: string;
      readonly options: readonly { readonly optionReference: string }[];
    }[];
  },
): Promise<ReadonlyMap<string, LineUnavailableNow>> {
  const found = new Map<string, LineUnavailableNow>();
  if (input.lines.length === 0) return found;
  const t = tx as Tx;
  const before = (
    (await t.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )) as { rows: { brand: string | null; store: string | null }[] }
  ).rows[0];
  const rules = await listStoreAvailabilityRules(tx as never, scope);
  const offNow = await listOptionsOffNow(tx as never, {
    ...scope,
    channelCode: "CUSTOMER_PWA",
    orderTypeCode: input.orderType === "DineIn" ? "DINE_IN" : "PICKUP",
    observedAt: input.at,
    optionReferences: input.lines.flatMap((line) =>
      line.options.map((option) => option.optionReference),
    ),
  });
  await t.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    before?.brand ?? "",
    before?.store ?? "",
  ]);
  for (const line of input.lines) {
    const dish = itemAvailability(rules, scope, line.sellableReference, input.at).status;
    if (dish === "SoldOut") found.set(line.orderItemReference, "SoldOut");
    else if (dish === "Unavailable" || dish === "NotOffered")
      found.set(line.orderItemReference, "Hidden");
    else if (line.options.some((option) => offNow.has(option.optionReference)))
      found.set(line.orderItemReference, "ChoiceSoldOut");
  }
  return found;
}

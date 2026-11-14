import { listAlcoholSkus } from "@rms/catalog";
import { loadStoreFeatureSetting, resolveStoreOperatingLocalFields } from "@rms/store";
import { parseCanonicalInstant } from "@bop/tenant";

interface QueryTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount: number | null }>;
}
/**
 * WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"), Ontario rules as the AGCO publishes them: alcohol
 * is served from 9:00 to 2:00 the next morning. Dine-in only for now: takeout needs the licence to
 * allow it, food in the same order and the guest's name and address kept for a year, none of which
 * the pickup path has. A Store's own licence may be narrower; that is on the Store's licence, and
 * another province needs its own rule before a Store there turns this on.
 */
const salesOpenAt = "09:00";
const salesCloseAt = "02:00";
export function withinAlcoholHours(localTime: string): boolean {
  const time = localTime.slice(0, 5);
  return time >= salesOpenAt || time < salesCloseAt;
}
/** WP-2423 (M93, Owner decision 18): last call starts 30 minutes before the 2:00 cutoff. */
const lastCallFrom = "01:30";
export function alcoholLastCall(localTime: string): boolean {
  const time = localTime.slice(0, 5);
  return time >= lastCallFrom && time < salesCloseAt;
}
export interface AlcoholSale {
  /** The sizes asked about whose dish contains alcohol. */
  readonly skus: ReadonlySet<string>;
  readonly offered: boolean;
  readonly withinHours: boolean;
  /** WP-2423 (M93): within the last 30 minutes before the cutoff (absent: not). */
  readonly lastCall?: true;
}

/** Reads the Store's switch and clock only when one of the sizes asked about contains alcohol. */
export async function readAlcoholSale(
  tx: unknown,
  scope: { readonly brandReference: string; readonly storeReference: string },
  at: string,
  skuReferences: readonly string[],
): Promise<AlcoholSale> {
  const query = tx as QueryTransaction;
  const skus = await listAlcoholSkus(query, scope, skuReferences);
  if (skus.size === 0) return { skus, offered: false, withinHours: false };
  const setting = await loadStoreFeatureSetting(
    tx as Parameters<typeof loadStoreFeatureSetting>[0],
    scope,
  );
  const zone = (
    await query.query<{ time_zone: string }>(
      "SELECT time_zone FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' ORDER BY configuration_version DESC LIMIT 1",
      [scope.brandReference, scope.storeReference],
    )
  ).rows[0]?.time_zone;
  // A Store whose clock can't be read sells no alcohol.
  if (zone === undefined) return { skus, offered: setting.alcohol, withinHours: false };
  const local = resolveStoreOperatingLocalFields(parseCanonicalInstant(at), zone);
  return {
    skus,
    offered: setting.alcohol,
    withinHours: withinAlcoholHours(String(local.localTime)),
    ...(alcoholLastCall(String(local.localTime)) ? { lastCall: true as const } : {}),
  };
}

/** Off the menu where it can't be sold at all; shown but not orderable outside the hours. */
export function alcoholMenuFact<
  F extends { readonly availability: "Available" | "SoldOut" | "NotOffered" },
>(
  fact: F,
  sale: AlcoholSale,
  orderType: "Pickup" | "DineIn" | undefined,
): F & { readonly alcohol?: "OnSale" | "LastCall" | "OutsideHours" } {
  if (!sale.offered || orderType !== "DineIn") return { ...fact, availability: "NotOffered" };
  if (!sale.withinHours) {
    return {
      ...fact,
      availability: fact.availability === "NotOffered" ? "NotOffered" : "SoldOut",
      alcohol: "OutsideHours",
    };
  }
  // WP-2423 (M93): still orderable, and guests are told orders close at 2:00.
  return { ...fact, alcohol: sale.lastCall === true ? "LastCall" : "OnSale" };
}

/** Whether this size can be ordered now; true for anything that contains no alcohol. */
export async function alcoholMaySell(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each caller's own transaction type
  runner: { run<T>(work: (tx: any) => Promise<T>): Promise<T> },
  scope: { readonly brandReference: unknown; readonly storeReference: unknown },
  input: {
    readonly sellableReference: string;
    readonly orderType: "Pickup" | "DineIn";
    readonly at: string;
  },
): Promise<boolean> {
  const sale = await runner.run((tx) =>
    readAlcoholSale(
      tx,
      {
        brandReference: String(scope.brandReference),
        storeReference: String(scope.storeReference),
      },
      input.at,
      [input.sellableReference],
    ),
  );
  if (!sale.skus.has(input.sellableReference)) return true;
  return sale.offered && sale.withinHours && input.orderType === "DineIn";
}

import type { TableBill } from "./table-checkout-client.js";

/**
 * Owner 2026-11-03 (operating continuity): each open table's last bill, kept on this device so
 * staff can still see what a table owes while the connection is down, also after the page was
 * reloaded (public/operations/offline.js reads the same value; keep its shape). Dish names and
 * amounts only: never a guest, a card or a reference. Reading only: nothing is queued (IDR-0039).
 */
export const LAST_BILLS_KEY = "bop.tables.lastBills.v1";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface LastTableBill {
  readonly label: string;
  readonly owedMinor: string;
  readonly settled: boolean;
  readonly rounds: readonly {
    readonly number: number;
    readonly totalMinor: string;
    readonly items: readonly { readonly name: string; readonly subtotalMinor: string }[];
  }[];
}
export interface LastBills {
  readonly savedAt: string;
  readonly tables: readonly LastTableBill[];
}

export function lastTableBill(label: string, bill: TableBill): LastTableBill {
  return Object.freeze({
    label,
    owedMinor: bill.owed.totalMinor,
    settled: bill.settlement !== null,
    rounds: bill.rounds.map((round) => ({
      number: round.roundNumber,
      totalMinor: round.totalMinor,
      items: round.items.map((item) => ({
        name: item.displayName,
        subtotalMinor: item.subtotalMinor,
      })),
    })),
  });
}

export function saveLastBills(tables: readonly LastTableBill[], now = new Date()): void {
  try {
    if (tables.length === 0) globalThis.localStorage?.removeItem(LAST_BILLS_KEY);
    else
      globalThis.localStorage?.setItem(
        LAST_BILLS_KEY,
        JSON.stringify({ savedAt: now.toISOString(), tables }),
      );
  } catch {
    /* Storage full or blocked: the page still works, only this fallback is missing. */
  }
}

export function clearLastBills(): void {
  try {
    globalThis.localStorage?.removeItem(LAST_BILLS_KEY);
  } catch {
    /* Nothing to clear. */
  }
}

/** The saved bills, unless too old to trust (a table from last night is not tonight's bill). */
export function loadLastBills(now = Date.now()): LastBills | null {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem(LAST_BILLS_KEY) ?? "null",
    ) as LastBills | null;
    if (
      value === null ||
      typeof value.savedAt !== "string" ||
      !Array.isArray(value.tables) ||
      !(now - Date.parse(value.savedAt) <= MAX_AGE_MS)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

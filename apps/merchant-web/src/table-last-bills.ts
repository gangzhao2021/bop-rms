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
  /**
   * DEC-TAX-WHOLE-RECEIPT: a separate tax rounding line, only in a value an older page saved (its
   * rounds as ordered). b15: saved as "0" — each round holds its share, as the bill charges it.
   */
  readonly taxRoundingMinor?: string;
  readonly settled: boolean;
  readonly rounds: readonly {
    readonly number: number;
    readonly totalMinor: string;
    readonly items: readonly { readonly name: string; readonly subtotalMinor: string }[];
  }[];
}
export interface LastBills {
  readonly savedAt: string;
  /**
   * b13: the Store these bills belong to. A table label ("1", "A1") repeats across Stores, so a
   * bill is only said for the Store it was read in (absent in a value saved by an older page).
   */
  readonly storeReference?: string;
  readonly storeLabel?: string;
  readonly tables: readonly LastTableBill[];
}
export interface LastBillsStore {
  readonly storeReference: string;
  readonly storeLabel: string;
}

export function lastTableBill(label: string, bill: TableBill): LastTableBill {
  return Object.freeze({
    label,
    owedMinor: bill.owed.totalMinor,
    // v15 b15 (DEC-TAX-WHOLE-RECEIPT): one tax figure — each round as the bill charges it, its
    // share of the tax rounding in it, so the rounds add up to what is owed with no rounding line.
    taxRoundingMinor: "0",
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

export function saveLastBills(
  tables: readonly LastTableBill[],
  now = new Date(),
  store: LastBillsStore | null = null,
): void {
  try {
    if (tables.length === 0) globalThis.localStorage?.removeItem(LAST_BILLS_KEY);
    else
      globalThis.localStorage?.setItem(
        LAST_BILLS_KEY,
        JSON.stringify({
          savedAt: now.toISOString(),
          ...(store === null
            ? {}
            : { storeReference: store.storeReference, storeLabel: store.storeLabel }),
          tables,
        }),
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

/**
 * The saved bills, unless too old to trust (a table from last night is not tonight's bill). With
 * `storeReference`, only bills read in that Store: another Store's table "1" is not this one's.
 */
export function loadLastBills(
  now = Date.now(),
  storeReference: string | null = null,
): LastBills | null {
  try {
    const value = JSON.parse(
      globalThis.localStorage?.getItem(LAST_BILLS_KEY) ?? "null",
    ) as LastBills | null;
    if (
      value === null ||
      typeof value.savedAt !== "string" ||
      !Array.isArray(value.tables) ||
      !(now - Date.parse(value.savedAt) <= MAX_AGE_MS) ||
      (storeReference !== null && value.storeReference !== storeReference)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

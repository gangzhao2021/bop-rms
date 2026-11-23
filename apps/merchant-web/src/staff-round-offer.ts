import { t, saidTable } from "./i18n/i18n.js";
import type { StaffDiningTable } from "./dining-session-client.js";

/**
 * Batch 55 (v15 b54 live, guest-bill-closed-by-staff): whether staff can take a round for a table
 * now, by the rule the staff round's send checks (POST /merchant/dining/staff-rounds): the table is
 * published and available (not closed or being cleaned), it has a table QR code, and its party is
 * not checking out (a session in its Closing phase takes no new round, paid or not: the server
 * refuses it with table_unavailable). The Tables panel offers "Take order for table" by it, and
 * the order entry screen checks it when opened and when a send is refused, so a paid table is
 * never offered a round that is refused only on Send.
 *
 * `settled` says which next step fits a table checking out: its bill is paid (or owes nothing),
 * as the Tables page reads it (`tableSettled`).
 */
export type StaffRoundOffer = "Offered" | "Unavailable" | "NoCode" | "CheckingOut" | "Paid";

export function staffRoundOffer(
  table: Pick<
    StaffDiningTable,
    "lifecycle" | "operationalState" | "qrCodeValidUntil" | "currentDiningSessionReference"
  > & { readonly session?: { readonly phase: string } | null | undefined },
  settled: boolean,
): StaffRoundOffer {
  if (table.lifecycle !== "Published" || table.operationalState !== "Available")
    return "Unavailable";
  if (table.qrCodeValidUntil === null) return "NoCode";
  if (table.currentDiningSessionReference !== null && table.session?.phase === "Closing")
    return settled ? "Paid" : "CheckingOut";
  return "Offered";
}

/**
 * Why no round can be added to a table checking out, and what staff do next, with the steps the
 * Tables page has: Cancel checkout (only before anyone pays), or once paid Close the table and
 * Cleaned, after which the guests' next order starts a new bill.
 */
export function staffRoundRefusedText(offer: "CheckingOut" | "Paid", tableLabel: string): string {
  const table = saidTable(tableLabel);
  return offer === "Paid"
    ? t(
        "Table {table}'s bill is paid, so no more rounds can be added to it. If the guests want to order more, close the table and press Cleaned, then take their order: it starts a new bill.",
        { table },
      )
    : t(
        "Table {table} is checking out, so no round can be added to its bill. If the guests want to order more, press Cancel checkout on the table before anyone pays. Once someone has paid, finish the checkout, close the table and press Cleaned, then take their order as a new bill.",
        { table },
      );
}

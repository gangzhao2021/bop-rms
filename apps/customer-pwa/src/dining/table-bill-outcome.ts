import type { DiningSessionView } from "./dining-session-client.js";

/**
 * Batch 55 (v15 b54 live, guest-bill-closed-by-staff): how a table's bill ended, read once from the
 * guest table read, so every guest page that says it (Menu, dish pages, Cart, Your table's round
 * cards and Table total) says the same thing. Before this, Menu and Cart counted any bill owing
 * nothing as paid, so a bill staff closed after the guests left (order 59: nothing paid at all)
 * read "Your table’s bill is paid" / 这桌已结清 with "See the receipt".
 *
 * - Owing: the table still owes something (or has not ordered).
 * - Paid: the table paid all it owes.
 * - ClosedByStaff: staff closed the bill when the guests left; what was paid stays paid and the
 *   rest is not charged. `paid` says how much of it was paid, never as paid in full.
 */
export type TableBillOutcome =
  | { readonly kind: "Owing" }
  | { readonly kind: "Paid" }
  | { readonly kind: "ClosedByStaff"; readonly paid: ClosedBillPaid };

/**
 * What was paid on a bill staff closed: nothing; some dishes (guests paying by dish); some of
 * staff's equal parts (not tied to any round); or a payment on the whole bill.
 */
export type ClosedBillPaid =
  | { readonly kind: "Nothing" }
  | { readonly kind: "ByDish"; readonly payments: number }
  | { readonly kind: "Parts"; readonly paid: number; readonly count: number }
  | { readonly kind: "Some" };

export function tableBillOutcome(view: DiningSessionView): TableBillOutcome {
  const summary = view.summary;
  if (summary === null || view.rounds.length === 0) return { kind: "Owing" };
  if (summary.closedByStaff === true) {
    const parts = summary.splitParts;
    return {
      kind: "ClosedByStaff",
      paid: /^0+$/u.test(summary.paid.amountMinor)
        ? { kind: "Nothing" }
        : parts !== undefined && parts.paid > 0 && parts.count === null
          ? { kind: "ByDish", payments: parts.paid }
          : parts !== undefined && parts.paid > 0 && parts.count !== null
            ? { kind: "Parts", paid: parts.paid, count: parts.count }
            : { kind: "Some" },
    };
  }
  return /^0+$/u.test(summary.due.amountMinor) ? { kind: "Paid" } : { kind: "Owing" };
}

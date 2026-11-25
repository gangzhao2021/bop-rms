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
 * - ClosedByStaff: staff closed the bill when the guests left; what was paid stays paid (less
 *   what staff gave back) and the rest is not charged. `paid` says how much of it was paid,
 *   never as paid in full.
 */
export type TableBillOutcome =
  | { readonly kind: "Owing" }
  /**
   * Batch 61 (v15 b60 live, CRT60 B/C): `refunded`, staff since gave back some (or all) of a
   * payment of the paid bill; the payer's own receipt says what (absent: nothing went back).
   */
  | { readonly kind: "Paid"; readonly refunded?: true }
  | { readonly kind: "ClosedByStaff"; readonly paid: ClosedBillPaid };

/**
 * What was paid on a bill staff closed: nothing; some dishes (guests paying by dish); some of
 * staff's equal parts (not tied to any round); or a payment on the whole bill. Batch 59 (v15 b58
 * live, L58R B): a part (or payment) staff gave back in full is not paid: `payments` and `paid`
 * count only what stays paid, `refunded` the parts given back in full, and "Refunded" is a bill
 * where all that was paid went back (never "what was paid stays paid" or "paid 1 of 2").
 * Batch 61 (v15 b60 live, CRT60 D): `someRefunded`, some stays paid but staff gave back part of
 * what was paid (one payment in part, or one of several): never said to "stay paid" then.
 */
export type ClosedBillPaid =
  | { readonly kind: "Nothing" }
  | { readonly kind: "ByDish"; readonly payments: number; readonly someRefunded?: true }
  | {
      readonly kind: "Parts";
      readonly paid: number;
      readonly count: number;
      /** Batch 59: parts paid and then given back in full (absent: none). */
      readonly refunded?: number;
      readonly someRefunded?: true;
    }
  | { readonly kind: "Some"; readonly someRefunded?: true }
  | {
      readonly kind: "Refunded";
      /** Staff's equal parts: how many were paid and then given back, of how many. */
      readonly parts: { readonly refunded: number; readonly count: number } | null;
    };

export function tableBillOutcome(view: DiningSessionView): TableBillOutcome {
  const summary = view.summary;
  if (summary === null || view.rounds.length === 0) return { kind: "Owing" };
  if (summary.closedByStaff === true) {
    const parts = summary.splitParts;
    const refunded = parts?.refunded ?? 0;
    const kept = parts === undefined ? 0 : parts.paid - refunded;
    const allBack =
      summary.paidAfterRefunds !== undefined && /^0+$/u.test(summary.paidAfterRefunds.amountMinor);
    // Batch 61: the read says what the table paid after refunds once staff gave any of it back.
    const someRefunded =
      summary.paidAfterRefunds !== undefined ? { someRefunded: true as const } : {};
    return {
      kind: "ClosedByStaff",
      paid: /^0+$/u.test(summary.paid.amountMinor)
        ? { kind: "Nothing" }
        : allBack || (parts !== undefined && parts.paid > 0 && kept <= 0)
          ? {
              kind: "Refunded",
              parts:
                parts !== undefined && parts.count !== null && refunded > 0
                  ? { refunded, count: parts.count }
                  : null,
            }
          : parts !== undefined && parts.paid > 0 && parts.count === null
            ? { kind: "ByDish", payments: kept, ...someRefunded }
            : parts !== undefined && parts.paid > 0 && parts.count !== null
              ? {
                  kind: "Parts",
                  paid: kept,
                  count: parts.count,
                  ...(refunded > 0 ? { refunded } : {}),
                  ...someRefunded,
                }
              : { kind: "Some", ...someRefunded },
    };
  }
  return /^0+$/u.test(summary.due.amountMinor)
    ? summary.paidAfterRefunds !== undefined
      ? { kind: "Paid", refunded: true }
      : { kind: "Paid" }
    : { kind: "Owing" };
}

/**
 * Batch 56 (v15 b55 live, guest-closed-bill-menu-cart): staff's equal parts on a bill still open
 * (how many are paid, of how many). A part is a share of the whole bill and pays no round, but the
 * read ties part 1 to round 1 (order 80: round 1 "Paid", round 2 "On the table's bill" after
 * part 1 of 2 was paid), so round cards say what the parts did instead. Null: no equal parts, none
 * paid yet, or staff closed the bill (tableBillOutcome says that).
 */
export function openBillParts(view: DiningSessionView): OpenBillParts | null {
  const parts = view.summary?.splitParts;
  if (view.summary?.closedByStaff === true || parts === undefined) return null;
  // Batch 59: a part staff gave back in full is not paid (`paid` counts what stays paid).
  const refunded = parts.refunded ?? 0;
  return parts.count !== null && parts.paid > 0
    ? { paid: parts.paid - refunded, count: parts.count, ...(refunded > 0 ? { refunded } : {}) }
    : null;
}
export interface OpenBillParts {
  readonly paid: number;
  readonly count: number;
  /** Batch 59: parts paid and then given back in full (not in `paid`; absent: none). */
  readonly refunded?: number;
}

import { Link } from "react-router";
import type { TableCheckout } from "../dining/table-checkout-state.js";
import { t } from "../i18n/i18n.js";

/** Not read yet: the table is checking out, and whether it is paid is not known. */
export const unreadTableCheckout: TableCheckout = Object.freeze({
  paid: null,
  payLater: null,
  closedByStaff: null,
});

/**
 * Batch 48: what a seated guest reads instead of + and Add to cart while the table checks out.
 * Staff can still reopen a table nobody has paid for yet (Cancel checkout), so the guest is sent to
 * staff to add more; a paid table's receipt is on Your table. Batch 55 (v15 b54 live): a bill staff
 * closed when the guests left is never "paid": it says what Your table says (what was paid stays
 * paid, the rest is not charged), and links to the bill, as such a bill has no receipt.
 */
export function tableCheckoutText(checkout: TableCheckout): {
  /** Cart's heading and line; Menu and dish pages say both as one line. */
  readonly heading: string;
  readonly line: string;
  readonly whole: string;
  readonly link: string;
} {
  if (checkout.closedByStaff !== null)
    return checkout.closedByStaff.kind === "Nothing"
      ? {
          heading: t("Staff closed your table’s bill"),
          line: t("Nothing was charged. To order anything else, ask staff."),
          whole: t(
            "Staff closed your table’s bill; nothing was charged. To order anything else, ask staff.",
          ),
          link: t("See the bill"),
        }
      : {
          heading: t("Staff closed your table’s bill"),
          line: t(
            "What was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
          ),
          whole: t(
            "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you. To order anything else, ask staff.",
          ),
          link: t("See the bill"),
        };
  return checkout.paid === true
    ? {
        heading: t("Your table’s bill is paid"),
        line: t("To order anything else, ask staff."),
        whole: t("Your table’s bill is paid. To order anything else, ask staff."),
        link: checkout.payLater === true ? t("See the receipt") : t("See the bill"),
      }
    : {
        heading: t("Your table is paying the bill"),
        line: t("Ask staff if you want to add more."),
        whole: t("Your table is paying the bill. Ask staff if you want to add more."),
        link: t("See the bill"),
      };
}

export function TableCheckoutNotice({ checkout }: { readonly checkout: TableCheckout }) {
  const text = tableCheckoutText(checkout);
  return (
    <>
      <p className="menu-closed-notice__line">{text.whole}</p>
      <Link to="/dine-in/session">{text.link}</Link>
    </>
  );
}

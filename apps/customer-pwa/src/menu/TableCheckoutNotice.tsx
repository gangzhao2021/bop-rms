import { Link } from "react-router";
import type { TableCheckout } from "../dining/table-checkout-state.js";
import { t } from "../i18n/i18n.js";

/**
 * Batch 48: what a seated guest reads instead of + and Add to cart while the table checks out.
 * Staff can still reopen a table nobody has paid for yet (Cancel checkout), so the guest is sent to
 * staff to add more; a paid table's receipt is on Your table.
 */
export function tableCheckoutText(checkout: TableCheckout): {
  /** Cart's heading and line; Menu and dish pages say both as one line. */
  readonly heading: string;
  readonly line: string;
  readonly whole: string;
  readonly link: string;
} {
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

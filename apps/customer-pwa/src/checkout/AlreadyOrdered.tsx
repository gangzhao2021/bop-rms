import { Link } from "react-router";
import { t } from "../i18n/i18n.js";
import type { CartPlacedOrder } from "../cart/types.js";

/**
 * WP-2423 M03: the pickup cart is empty because its dishes were ordered (order N). Back from the
 * paid page, a bookmarked checkout or a second tab lands here: the guest opens that order (paid or
 * not, and when it's ready), never a checkout that could charge the same dishes twice.
 */
export function AlreadyOrdered({ placedOrder }: { readonly placedOrder: CartPlacedOrder }) {
  return (
    <section className="cart-state already-ordered" aria-labelledby="already-ordered-heading">
      <h2 id="already-ordered-heading">{t("Already ordered")}</h2>
      <p>
        {t(
          "These dishes are in order {number}. Open it to see whether it’s paid and when it’s ready. To order something else, add dishes from the menu.",
          { number: placedOrder.orderNumber },
        )}
      </p>
      <div className="cart-state__actions">
        <Link className="cart-primary-link" to={"/orders/" + placedOrder.orderReference}>
          {t("View order status")}
        </Link>
        <Link to="/menu">{t("Back to menu")}</Link>
      </div>
    </section>
  );
}

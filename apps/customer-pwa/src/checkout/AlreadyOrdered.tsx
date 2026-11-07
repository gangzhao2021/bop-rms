import { Link } from "react-router";
import { t } from "../i18n/i18n.js";
import type { CartPlacedOrder } from "../cart/types.js";
import { RestoreDishesPanel } from "../payment/RestoreDishesPanel.js";

/**
 * WP-2423 M03: the guest's pickup dishes are already in an order (order N). Back from the paid
 * page, a bookmarked checkout or a second tab lands here: the guest opens that order (paid or not,
 * and when it's ready), never a checkout that could charge the same dishes twice.
 *
 * - The cart is empty after the order: "Already ordered", or, when that order closed and won't be
 *   made, "Order closed" with its dishes one tap from the cart again.
 * - `dishesInCart`: the cart still holds dishes that are already in that order (a cart filled
 *   before pickup carts were emptied on ordering). Their checkout is refused, so the guest is told
 *   why and what to do instead of tapping checkout and looping back.
 */
export function AlreadyOrdered({
  placedOrder,
  dishesInCart = false,
  cartLink = false,
  onRestored,
}: {
  /** Null when the server refused a checkout of these dishes without naming the order. */
  readonly placedOrder: CartPlacedOrder | null;
  readonly dishesInCart?: boolean;
  /** Offer the way to the cart (on pages other than the cart itself). */
  readonly cartLink?: boolean;
  /** Called after the dishes were put back, so the page can show the cart again. */
  readonly onRestored?: () => void;
}) {
  if (placedOrder === null)
    return (
      <section className="cart-state already-ordered" role="alert">
        <h2>{t("Already ordered")}</h2>
        <p>{t("These dishes were already ordered. Nothing new was charged.")}</p>
        <div className="cart-state__actions">
          <Link className="cart-primary-link" to="/menu">
            {t("Back to menu")}
          </Link>
        </div>
      </section>
    );
  const notMade = placedOrder.notMade === true;
  // The one primary action: putting the dishes back when the order won't be made, else the order.
  const restore = notMade && !dishesInCart;
  const orderLink = (
    <Link
      className={restore ? undefined : "cart-primary-link"}
      to={"/orders/" + placedOrder.orderReference}
    >
      {t("View order status")}
    </Link>
  );
  return (
    <section
      className="cart-state already-ordered"
      aria-labelledby="already-ordered-heading"
      role={dishesInCart ? "status" : undefined}
    >
      <h2 id="already-ordered-heading">{notMade ? t("Order closed") : t("Already ordered")}</h2>
      <p>
        {dishesInCart
          ? notMade
            ? t(
                "Order {number} was closed and won’t be made. To order these dishes again, remove them from your cart and add them again from the menu.",
                { number: placedOrder.orderNumber },
              )
            : t(
                "The dishes in your cart are already in order {number}, so they can’t be checked out again. Open the order to see whether it’s paid and when it’s ready. To order something else, remove these dishes first.",
                { number: placedOrder.orderNumber },
              )
          : notMade
            ? t("Order {number} was closed and won’t be made. Open it to see its payment.", {
                number: placedOrder.orderNumber,
              })
            : t(
                "These dishes are in order {number}. Open it to see whether it’s paid and when it’s ready. To order something else, add dishes from the menu.",
                { number: placedOrder.orderNumber },
              )}
      </p>
      {restore ? (
        <RestoreDishesPanel
          orderReference={placedOrder.orderReference}
          {...(onRestored === undefined ? {} : { onRestored })}
        />
      ) : null}
      <div className="cart-state__actions">
        {orderLink}
        {dishesInCart ? (
          cartLink ? (
            <Link to="/cart">{t("Go to your cart")}</Link>
          ) : null
        ) : (
          <Link to="/menu">{t("Back to menu")}</Link>
        )}
      </div>
    </section>
  );
}

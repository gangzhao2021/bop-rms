import { useState } from "react";
import { Link } from "react-router";
import { v7 as uuidv7 } from "uuid";
import { t } from "../i18n/i18n.js";
import { createBrowserCustomerCartClient, type CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError } from "../cart/types.js";

type RestoreState =
  | { readonly status: "idle" | "working" }
  | { readonly status: "done"; readonly unavailable: number }
  | { readonly status: "refused" | "failed" };

/**
 * WP-2423 M03: a pickup order's dishes left the cart when the order was placed (so they can never
 * be paid twice). When that order wasn't paid in time, the guest puts them back with one tap
 * instead of choosing everything again; dishes the store can't sell now are left out and counted.
 * Nothing here orders or charges.
 */
export function RestoreDishesPanel({
  orderReference,
  client,
}: {
  readonly orderReference: string;
  readonly client?: CustomerCartClient;
}) {
  const [cart] = useState(() => client ?? createBrowserCustomerCartClient());
  // One operation for this panel, so a double tap or a retry is the same request.
  const [operationReference] = useState(() => uuidv7());
  const [state, setState] = useState<RestoreState>({ status: "idle" });
  const restore = async () => {
    if (cart.restoreOrder === undefined) return;
    setState({ status: "working" });
    try {
      const result = await cart.restoreOrder({ orderReference, operationReference });
      setState({ status: "done", unavailable: result.unavailable });
    } catch (error) {
      setState({
        status:
          error instanceof CartClientError && error.code === "cart_restore_not_available"
            ? "refused"
            : "failed",
      });
    }
  };
  if (state.status === "done")
    return (
      <div className="restore-dishes" role="status">
        <p>{t("Your dishes are back in your cart.")}</p>
        {state.unavailable > 0 ? (
          <p>
            {state.unavailable === 1
              ? t("1 dish can’t be ordered right now, so it wasn’t put back.")
              : t("{count} dishes can’t be ordered right now, so they weren’t put back.", {
                  count: state.unavailable,
                })}
          </p>
        ) : null}
        <Link className="cart-primary-link" to="/cart">
          {t("Go to your cart")}
        </Link>
      </div>
    );
  return (
    <div className="restore-dishes">
      <p>
        {t(
          "Your cart is empty now. Put these dishes back to order them again, or choose from the menu.",
        )}
      </p>
      {state.status === "refused" ? (
        <p role="alert">
          {t("These dishes can’t be put back right now. Check the order’s status first.")}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <p role="alert">
          {t("The dishes couldn’t be put back. Check your connection and try again.")}
        </p>
      ) : null}
      <button
        type="button"
        className="cart-primary-link"
        disabled={state.status === "working" || cart.restoreOrder === undefined}
        onClick={() => void restore()}
      >
        {state.status === "working"
          ? t("Putting dishes back…")
          : t("Put these dishes back in my cart")}
      </button>
    </div>
  );
}

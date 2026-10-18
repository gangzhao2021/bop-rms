import { checkoutInProgressMessage } from "../cart/types.js";
import { checkoutText } from "../journey/messages.js";
import type { CheckoutSessionState } from "./session-controller.js";

/**
 * What the payment step tells the guest about the checkout session. Losing the connection is
 * never a refusal: the checkout and cart are kept, and the page-level offline notice already says
 * so (`pageOffline`), so nothing more is added. Only a server refusal (or a revoked session) asks
 * the guest to review the cart and rescan. Item refusals have their own message.
 */
export function checkoutSessionAlert(
  state: CheckoutSessionState,
  pageOffline: boolean,
): string | null {
  switch (state.status) {
    case "idle":
    case "pending":
    case "ready":
    case "item_short":
    case "item_unavailable":
      return null;
    case "offline":
      return pageOffline ? null : checkoutText.offline;
    case "store_closed":
      return checkoutText.storeClosed;
    case "checkout_in_progress":
      return checkoutInProgressMessage(state.retryAfterSeconds);
    case "unknown":
      return state.canRetry ? checkoutText.checkoutUnconfirmed : checkoutText.checkoutRefused;
    case "denied":
    case "conflict":
    case "invalid":
      return checkoutText.checkoutRefused;
  }
}

import { checkoutInProgressMessage } from "../cart/types.js";
import { checkoutText } from "../journey/messages.js";
import { wasCheckoutCardOffered } from "../session/customer-transaction-context.js";
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
    case "requote_required":
      return null;
    case "offline":
      return pageOffline ? null : checkoutText.offline;
    case "store_closed":
      return checkoutText.storeClosed;
    case "checkout_in_progress":
      return checkoutInProgressMessage(state.retryAfterSeconds);
    case "unknown":
      // WP-2423 item 2: after a card was offered in this tab an earlier checkout may be confirming,
      // so a failure here says nothing about money.
      return !state.canRetry
        ? checkoutText.checkoutRefused
        : wasCheckoutCardOffered()
          ? checkoutText.checkoutUnconfirmedAfterCard
          : checkoutText.checkoutUnconfirmed;
    case "conflict":
      // WP-2423 item 6: the cart or its quote moved on: it's the cart that needs looking at.
      return checkoutText.checkoutCartChanged;
    case "denied":
    case "invalid":
      return checkoutText.checkoutRefused;
  }
}

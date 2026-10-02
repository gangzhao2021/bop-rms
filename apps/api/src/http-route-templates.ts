import { customerSessionBootstrapRoute } from "./customer-session-bootstrap.js";
import { customerPickupCodeRoute } from "./customer-pickup-code.js";
import { customerReceiptRoute } from "./customer-receipt.js";
import { customerOrderStatusRoute } from "./customer-order-status.js";
import { customerPaymentResultRoute } from "./customer-payment-result.js";
import { customerPaymentHandoffRoute } from "./customer-payment-handoff.js";
import { customerPaymentIntentRoute } from "./customer-payment-intent.js";
import {
  customerCheckoutSessionRoute,
  customerCheckoutSessionReadRoute,
} from "./customer-checkout-session.js";
import {
  customerCheckoutDetailsRoute,
  customerCheckoutDetailsCurrentRoute,
  customerCheckoutPolicyRoute,
} from "./customer-checkout-details.js";
import { customerOrderSubmissionRoute } from "./customer-order-submission.js";
import { customerDiningJoinRoute } from "./customer-dining-join.js";
import { customerDiningBindingRoutes } from "./customer-dining-binding.js";
import { customerCartBindingRoutes } from "./customer-cart-binding.js";
import { customerCartRoutes } from "./customer-cart.js";
import { merchantCatalogRoutes } from "./merchant-catalog.js";

export const apiRouteTemplates = Object.freeze([
  customerSessionBootstrapRoute,
  customerPickupCodeRoute,
  customerReceiptRoute,
  customerPaymentIntentRoute,
  customerPaymentHandoffRoute,
  customerPaymentResultRoute,
  "/__acceptance/request-command-event",
  "/bff/customer/entry",
  ...Object.values(customerCartBindingRoutes),
  customerDiningJoinRoute,
  ...Object.values(customerDiningBindingRoutes),
  customerCartRoutes.current,
  "/bff/realtime",
  "/api/v1/public/stores/:store_public_id/menu",
  customerCartRoutes.create,
  customerCartRoutes.replacement,
  customerCartRoutes.read,
  customerCartRoutes.addItem,
  customerCartRoutes.updateItem,
  "/api/v1/carts/:cart_id/quote",
  customerCheckoutSessionReadRoute,
  customerCheckoutSessionRoute,
  customerOrderSubmissionRoute,
  customerOrderStatusRoute,
  customerCheckoutDetailsRoute,
  customerCheckoutDetailsCurrentRoute,
  customerCheckoutPolicyRoute,
  ...Object.values(merchantCatalogRoutes),
  "/merchant/login",
  "/merchant/callback",
  "/merchant/session",
  "/merchant/dining/item-service",
  "/merchant/dining/serve",
  "/merchant/dining/order-progress",
  "/merchant/dining/tables",
  "/merchant/dining/tables/availability",
  "/merchant/dining/sessions/start",
  "/merchant/dining/sessions/host-transfer",
  "/merchant/dining/sessions/host-selection",
  "/merchant/dining/sessions/join-state",
  "/merchant/dining/sessions/regenerate",
  "/merchant/orders/accept",
  "/merchant/payments/refunds/context",
  "/merchant/payments/refunds/status",
  "/merchant/payments/refunds/items",
  "/merchant/payments/refunds/preview",
  "/merchant/payments/refunds/request",
  "/merchant/payments/refunds/prepare",
  "/merchant/pricing/price-books",
  "/merchant/catalog/products/lifecycle",
  "/merchant/catalog/products",
  "/merchant/catalog/menus/draft",
  "/merchant/catalog/menus/publication",
  "/merchant/orders",
  "/merchant/store-context",
  "/merchant/logout",
  "/health",
  "/ready",
  "unmatched",
] as const);

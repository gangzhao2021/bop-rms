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
import { merchantBrandAdministrationRoutes } from "./merchant-brand-administration-http.js";
import { platformAuthenticationRoutes } from "./platform-authentication-http.js";
import { platformTemplateAdministrationRoutes } from "./platform-template-administration-http.js";
import { merchantBrandApplicationRoutes } from "./merchant-brand-application.js";

export const apiRouteTemplates = Object.freeze([
  ...merchantBrandApplicationRoutes,
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
  ...merchantBrandAdministrationRoutes,
  ...platformAuthenticationRoutes,
  ...platformTemplateAdministrationRoutes,
  "/merchant/login",
  "/merchant/callback",
  "/merchant/session",
  "/merchant/store-configuration/ordinary",
  "/merchant/store-configuration/ordinary-command",
  "/merchant/store-configuration/ordinary-state",
  "/merchant/store-configuration/ordinary-history",
  "/merchant/store-setup",
  "/merchant/store-setup/fee-context-classifications",
  "/merchant/organization/brands/topology/draft/workspace",
  "/merchant/organization/brands/topology/draft/save",
  "/merchant/organization/brands/topology/draft/resolve",
  "/merchant/tax-config/authoring/scope",
  "/merchant/tax-config/authoring/classifications",
  "/merchant/tax-config/authoring/simulate",
  "/merchant/tax-config/authoring/current",
  "/merchant/tax-config/authoring/roster",
  "/merchant/tax-config/authoring/commands",
  "/merchant/tax-config/authoring/resolve-original",
  "/merchant/tax-config/authoring/tax-registrant",
  "/merchant/tax-config/authoring/candidates/current",
  "/merchant/tax-config/authoring/candidates/roster",
  "/merchant/tax-config/authoring/candidates/commands",
  "/merchant/tax-config/authoring/candidates/resolve-original",
  "/merchant/tax-config/authoring/materials/compare",
  "/merchant/tax-config/authoring/materials/current",
  "/merchant/tax-config/authoring/materials/version",
  "/merchant/tax-config/authoring/materials/roster",
  "/merchant/tax-config/authoring/materials/commands",
  "/merchant/tax-config/authoring/materials/resolve-original",
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
  "/merchant/orders/detail",
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

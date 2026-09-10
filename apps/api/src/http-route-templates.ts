import { customerDiningBindingRoutes } from "./customer-dining-binding.js";
import { customerCartBindingRoutes } from "./customer-cart-binding.js";
import { customerCartRoutes } from "./customer-cart.js";
import { merchantCatalogRoutes } from "./merchant-catalog.js";

export const apiRouteTemplates = Object.freeze([
  "/__acceptance/request-command-event",
  "/bff/customer/entry",
  ...Object.values(customerCartBindingRoutes),
  ...Object.values(customerDiningBindingRoutes),
  customerCartRoutes.current,
  "/bff/realtime",
  "/api/v1/public/stores/:store_public_id/menu",
  customerCartRoutes.create,
  customerCartRoutes.read,
  customerCartRoutes.addItem,
  customerCartRoutes.updateItem,
  "/api/v1/carts/:cart_id/quote",
  ...Object.values(merchantCatalogRoutes),
  "/merchant/login",
  "/merchant/callback",
  "/merchant/session",
  "/merchant/store-context",
  "/merchant/logout",
  "/health",
  "/ready",
  "unmatched",
] as const);

/**
 * The addresses the pilot's HTTPS entry answers with the merchant app; every other address gets the
 * customer app. A merchant screen (apps/merchant-web/src/pilot-routes.ts) must be under one of these
 * or a staff member sees the customer app's "Page not found" (v15 2026-11-02: platform support).
 */
export const pilotMerchantAppPaths = Object.freeze([
  "/app",
  "/app/{*path}",
  "/operations/{*path}",
  "/platform/{*path}",
]);

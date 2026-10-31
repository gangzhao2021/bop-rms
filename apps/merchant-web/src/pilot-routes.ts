import { matchPath } from "react-router";

/**
 * v15 aa3d9fac D3 (pilot rule "no reachable stubs"): every route the merchant app registers, and
 * whether the signed-in workspace serves it from real sources. Screens still waiting for their
 * sources (layout reviews that only ever say "unavailable") stay in the local demo for design
 * review; in the workspace a typed or bookmarked address for one of them goes to the nearest
 * working screen, like any unknown address. `App.test.tsx` keeps this list equal to the routes in
 * `App.tsx`, so a new screen has to be classified here before it can ship.
 */
export interface MerchantRoute {
  /** The route pattern as registered in `App.tsx`. */
  readonly path: string;
  /** An address that matches the pattern (synthetic references), for the browser check. */
  readonly sample: string;
  /** Where the workspace sends this address while the screen has no real sources. */
  readonly hiddenTo?: string;
  /**
   * A working screen this deployment serves only when the session's navigation lists it (the
   * server composes its sources); otherwise the address goes to `to`.
   */
  readonly listed?: { readonly screenId: string; readonly to: string };
}

const ref = "01909985-0000-7000-8000-000000000042";
const home = "/app";
const reports = "/app/reports/operations";

function route(path: string, hiddenTo?: string): MerchantRoute {
  const sample = path.replace(/:[A-Za-z]+/gu, ref);
  return hiddenTo === undefined ? { path, sample } : { path, sample, hiddenTo };
}

function listedRoute(path: string, screenId: string, to: string): MerchantRoute {
  return { ...route(path), listed: { screenId, to } };
}

export const merchantRoutes: readonly MerchantRoute[] = Object.freeze([
  // Working screens (real sources in the workspace).
  route("/app"),
  route("/app/tasks"),
  route("/app/organization/stores/:id/setup"),
  route("/app/organization/stores/:id/service"),
  route("/app/organization/users"),
  route("/app/organization/users/:id"),
  route("/app/organization/roles"),
  route("/app/organization/roles/:id"),
  route("/app/organization/sessions"),
  // v15 9b2b3f21 B4: the Brand and Platform consoles have their own sign-in and sources, which a
  // Store workspace composes only where its navigation lists them (the pilot lists neither: the
  // Brand pages said "Brand access could not be confirmed" without loading anything). There the
  // address goes Home; a Brand or Platform deployment that lists the screen keeps it.
  listedRoute("/app/organization/brands", "ORG-BRAND-LIST", home),
  listedRoute("/app/organization/brands/:id", "ORG-BRAND-DETAIL", home),
  listedRoute("/platform/tenants", "PLT-TENANT-LIST", home),
  route("/app/commerce/option-sets"),
  route("/app/commerce/option-sets/:optionSetId"),
  route("/app/commerce/products"),
  route("/app/commerce/products/new"),
  route("/app/commerce/products/:id/edit"),
  route("/app/commerce/menus"),
  route("/app/commerce/menus/:id"),
  route("/app/commerce/availability"),
  route("/app/commerce/tax-review"),
  route("/app/commerce/tax-classifications"),
  listedRoute("/app/commerce/option-recipes", "RECIPE-OPTION-LIST", home),
  route("/app/commerce/option-prices"),
  route("/app/commerce/pricing"),
  route("/app/commerce/pricing/:id"),
  // The Brand tax configuration workbench: its sources are composed only where the session
  // lists TAX-CONFIG (the pilot does not; Stores review tax in Tax review).
  listedRoute("/app/commerce/tax", "TAX-CONFIG", "/app/commerce/tax-review"),
  listedRoute("/app/commerce/recipes", "RECIPE-LIST", home),
  listedRoute("/app/commerce/recipes/:id/edit", "RECIPE-LIST", home),
  route("/app/compliance/allergens"),
  route("/app/compliance/allergens/:id"),
  listedRoute("/app/supply/opening-count", "INV-OPENING-COUNT", home),
  listedRoute("/app/supply/opening-count/:id", "INV-OPENING-COUNT", home),
  listedRoute("/app/supply/locations", "INV-LOCATION-LIST", home),
  listedRoute("/app/supply/items", "INV-ITEM-LIST", home),
  listedRoute("/app/supply/items/new", "INV-ITEM-LIST", home),
  listedRoute("/app/supply/items/:id/edit", "INV-ITEM-LIST", home),
  listedRoute("/app/supply/items/:id", "INV-ITEM-LIST", home),
  route("/app/reports/operations"),
  route("/app/operations/tables"),
  route("/app/operations/payments/:id"),
  route("/app/operations/payments/:id/refund"),
  route("/app/operations/payment-reconciliation"),
  route("/app/approvals"),
  route("/operations/orders"),
  route("/operations/orders/:id"),
  // A module the Store turned off (DEC-STORE-FEATURES) is not listed; its address goes to Tables.
  listedRoute("/operations/order-entry", "OPS-ORDER-ENTRY", "/operations/dining"),
  route("/operations/order-exceptions"),
  route("/operations/kitchen"),
  route("/operations/kitchen/work-items/:id"),
  route("/operations/dining"),
  // WP-2423 item 8 ⑦ (v15 finding v): listed while guests' pickup, counter ordering or pickups
  // still to hand over need it; otherwise the address goes to Tables.
  listedRoute("/operations/pickup", "FUL-PICKUP-QUEUE", "/operations/dining"),
  listedRoute("/operations/inventory/counts", "INV-COUNT-LIST", home),
  listedRoute("/operations/inventory/counts/:id", "INV-COUNT-LIST", home),
  listedRoute("/operations/inventory/waste", "INV-WASTE-RECORD", home),
  listedRoute("/operations/inventory/waste/new", "INV-WASTE-RECORD", home),
  listedRoute("/operations/inventory/waste/:id", "INV-WASTE-RECORD", home),
  listedRoute("/operations/receiving", "INV-RECEIPT-LIST", home),
  listedRoute("/operations/receiving/new", "INV-RECEIPT-LIST", home),
  listedRoute("/operations/receiving/:id", "INV-RECEIPT-LIST", home),
  route("/operations/switch-staff"),
  route("/operations/sign-in"),
  route("/app/identity/step-up-complete"),
  // Layout reviews without sources: local demo only.
  // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: the Stores page (switch, and open a Store).
  listedRoute("/app/organization/stores", "ORG-STORE-LIST", home),
  route("/app/organization/stores/:id", home),
  route("/app/organization/stores/:id/live-gate", home),
  // The Store capability page has no source in the pilot (its read answers 503) and no link.
  // WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the Store features page, for the owner.
  listedRoute("/app/organization/stores/:id/capabilities", "STORE-CAPABILITY", home),
  route("/app/organization/features", home),
  route("/app/organization/entities", home),
  route("/app/organization/entities/:id", home),
  route("/platform/live-gates", home),
  route("/platform/tenants/:id", home),
  route("/platform/support-cases", home),
  route("/app/exports", home),
  route("/app/commerce/bundles", home),
  route("/app/commerce/bundles/:id/edit", home),
  route("/app/commerce/promotions", home),
  route("/app/commerce/promotions/:id/edit", home),
  route("/app/reports", reports),
  route("/app/reports/:id/edit", reports),
  route("/app/reports/runs", reports),
  route("/app/reports/pipelines", reports),
  route("/app/reports/data-quality", reports),
  route("/app/reports/reconciliation", reports),
  route("/app/reports/metrics", reports),
  route("/app/reports/metrics/:id", reports),
  route("/app/compliance", home),
  route("/app/compliance/cases", home),
  route("/app/compliance/cases/:id", home),
  route("/app/compliance/inspections", home),
  route("/app/compliance/actions", home),
  route("/app/compliance/qualifications", home),
  route("/app/compliance/incidents/:id", home),
  route("/app/compliance/traceability", home),
  route("/app/compliance/recalls/:id", home),
  route("/app/compliance/policies", home),
  route("/app/compliance/policies/:id", home),
  route("/app/compliance/privacy-requests", home),
  route("/operations/compliance/temperature", home),
  route("/operations/compliance/cleaning", home),
  route("/app/integrations/devices", home),
  route("/app/integrations/devices/:id", home),
  route("/app/integrations/providers", home),
  route("/app/integrations/providers/:id", home),
  route("/app/integrations/api-clients", home),
  route("/app/integrations/kds-profiles", home),
  route("/app/customers", home),
  route("/app/customers/:id", home),
  route("/app/customers/loyalty-programs", home),
  route("/app/customers/loyalty-programs/:id", home),
  route("/app/customers/loyalty-accounts/:id", home),
  route("/app/customers/loyalty-exceptions", home),
  route("/app/customers/consents/:customerId", home),
  route("/app/customers/communications", home),
  route("/app/customers/templates", home),
  route("/app/customers/templates/:id", home),
  route("/app/customers/merge-reviews/:reviewId", home),
  route("/app/supply/items/:id/movements", "/app/supply/items"),
  route("/app/supply/movements", home),
  route("/app/supply/movements/:id", home),
  route("/app/supply/replenishment", home),
  route("/app/supply/requisitions", home),
  route("/app/supply/requisitions/:id", home),
  route("/app/supply/purchase-orders", home),
  route("/app/supply/purchase-orders/:id/edit", home),
  route("/app/supply/purchase-orders/:id", home),
  route("/app/supply/discrepancies", home),
  route("/app/supply/performance", home),
  route("/app/supply/suppliers", home),
  route("/app/supply/suppliers/:id", home),
  route("/app/supply/offerings", home),
  route("/app/supply/offerings/:id", home),
  route("/app/operations/reservation-capacity", home),
  route("/operations/inventory", "/operations/inventory/counts"),
  route("/operations/inventory/transfers", "/operations/inventory/counts"),
  route("/operations/inventory/transfers/:id", "/operations/inventory/counts"),
  route("/operations/inventory/lots", "/operations/inventory/counts"),
  route("/operations/delivery", "/operations/orders"),
  route("/operations/delivery/:id", "/operations/orders"),
  route("/operations/delivery/exceptions", "/operations/orders"),
  route("/operations/orders/:id/amend", "/operations/orders"),
  route("/operations/production-batches", "/operations/kitchen"),
  // Not a screen: the kitchen display sign-in returns here and goes on to the kitchen board.
  route("/operations/kitchen/start", "/operations/kitchen"),
  route("/operations/reservations", "/operations/dining"),
  route("/operations/reservations/calendar", "/operations/dining"),
  route("/operations/reservations/:id", "/operations/dining"),
  route("/operations/waitlist", "/operations/dining"),
]);

/**
 * Where the signed-in workspace sends `pathname` instead of a screen without sources, or null
 * when the address is a working screen (or unknown, which the catch-all route handles).
 * `screens` is the session's navigation (null while there is no session: the screen then shows
 * its own loading or sign-in state).
 */
export function pilotHiddenRedirect(
  pathname: string,
  screens: readonly string[] | null = null,
): string | null {
  // A working screen wins over a hidden pattern that would also match its address.
  const working = merchantRoutes.find(
    (entry) => !entry.hiddenTo && matchPath(entry.path, pathname),
  );
  if (working)
    return working.listed && screens !== null && !screens.includes(working.listed.screenId)
      ? working.listed.to
      : null;
  for (const entry of merchantRoutes)
    if (entry.hiddenTo && matchPath(entry.path, pathname)) return entry.hiddenTo;
  return null;
}

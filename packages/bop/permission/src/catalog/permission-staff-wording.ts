import { storePermissionCatalog } from "./store-permission-catalog.js";

/**
 * WP-2423 role presets (Owner request 2026-11-06): how staff read the permission catalog on the
 * role pages. Not part of the catalog digest: wording changes never bump the catalog version.
 * Labels are the catalog descriptions; groups and warnings are in plain words (the merchant app
 * translates every one).
 */
export const permissionGroupLabels: Readonly<Record<string, string>> = Object.freeze({
  merchant: "Signing in to the back office",
  organization: "Store, staff and support access",
  identity: "Roles and shared tablets",
  feature: "Store features",
  effective: "What guests see",
  catalog: "Menu and dishes",
  pricing: "Prices, promotions and tax",
  recipe: "Recipes",
  inventory: "Stock",
  ordering: "Orders and bills",
  kitchen: "Kitchen",
  fulfillment: "Pickup and hand-over",
  dining: "Tables",
  payment: "Payments and refunds",
  loyalty: "Points",
  operations: "Problems with orders and payments",
  reporting: "Reports",
  task: "Tasks",
  workflow: "Approval steps",
  publishing: "Publishing and going live",
  integration: "Connected services",
  media: "Photos",
  audit: "Activity records",
});

/**
 * The six things the Owner named as dangerous, in the order a role summary lists them first.
 */
export const ownerNamedRiskOrder: readonly string[] = Object.freeze([
  "payment.refund.approve",
  "ordering.order.write_off",
  "ordering.order.comp",
  "identity.role.approve",
  "payment.settlement.read",
  "organization.support_access.manage",
]);
const namedWarnings: Readonly<Record<string, string>> = Object.freeze({
  "payment.refund.approve": "Can approve refunds. Money leaves your business.",
  "ordering.order.write_off": "Can record that a table left without paying.",
  "ordering.order.comp":
    "Can take money off a bill (comp or discount). Each one is recorded under their name.",
  "identity.role.approve":
    "Can approve roles for other staff, including what they may do with money.",
  "payment.settlement.read": "Sees the day's takings, refunds and card terminal totals.",
  "organization.support_access.manage": "Can let BOP support change your settings.",
});
const genericWarning =
  "Give this only to someone you trust with it: it changes money, records or what guests see. Each use is recorded under their name.";

/** Every catalog High code, plus the settlement read the Owner named (still Medium risk). */
export const flaggedPermissionCodes: ReadonlySet<string> = new Set([
  ...storePermissionCatalog()
    .filter((entry) => entry.risk === "High")
    .map((entry) => entry.code),
  "payment.settlement.read",
]);

/** The plain warning shown under a ticked flagged permission, or null when it has none. */
export function permissionWarning(code: string): string | null {
  if (!flaggedPermissionCodes.has(code)) return null;
  return namedWarnings[code] ?? genericWarning;
}
export function permissionGroupLabel(module: string): string {
  return permissionGroupLabels[module] ?? "Other";
}
/** Flagged codes first (the Owner's six in their order), then the rest as given. */
export function orderByRisk(codes: readonly string[]): readonly string[] {
  const named = ownerNamedRiskOrder.filter((code) => codes.includes(code));
  const flagged = codes.filter(
    (code) => flaggedPermissionCodes.has(code) && !ownerNamedRiskOrder.includes(code),
  );
  const rest = codes.filter((code) => !flaggedPermissionCodes.has(code));
  return Object.freeze([...named, ...flagged, ...rest]);
}
/** Where a permission comes in a "this role can" list: the Owner's six in order, other flagged
 * ones next (6), anything else not listed there (null). */
export function permissionRiskRank(code: string): number | null {
  const named = ownerNamedRiskOrder.indexOf(code);
  if (named >= 0) return named;
  return flaggedPermissionCodes.has(code) ? ownerNamedRiskOrder.length : null;
}

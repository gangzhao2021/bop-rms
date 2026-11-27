import type { Page } from "@playwright/test";

/**
 * Batch 63 (merchant shell and Orders, design review of v15 batch 62): an owner's workspace at a
 * TEST store, every page the pilot lists, answered by synthetic HTTP interception (TEST-only data).
 */
export const id = (n: number) => "0190b163-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const headers = { "cache-control": "no-store" };
export const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main (TEST)",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
export const sizes = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;
export type Language = "en" | "zh-Hans";

const here = scope.storeReference;
export const navigation = [
  ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
  ["APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"],
  ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
  ["OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry", "ordering.order.create_staff"],
  ["KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"],
  ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"],
  ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
  [
    "OPS-ORDER-EXCEPTION",
    "Exceptions",
    "/operations/order-exceptions",
    "operations.order-exception.manage",
  ],
  [
    "PAY-RECONCILIATION",
    "Settlement",
    "/app/operations/payment-reconciliation",
    "payment.settlement.read",
  ],
  ["CAT-PRODUCT-LIST", "Products", "/app/commerce/products", "catalog.manage"],
  ["CAT-MENU-LIST", "Menus", "/app/commerce/menus", "catalog.menu.read"],
  ["LOY-PROGRAM-LIST", "Points", "/app/customers/loyalty-programs", "loyalty.member.read"],
  ["RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations", "reporting.sales.read"],
  ["CMP-ALLERGEN-REVIEW", "Allergens", "/app/compliance/allergens", "catalog.allergen.read"],
  [
    "STORE-SETUP",
    "Store setup",
    "/app/organization/stores/" + here + "/setup",
    "organization.manage",
  ],
  ["IAM-USER-LIST", "Staff", "/app/organization/users", "organization.staff.read"],
  ["IAM-ROLE-LIST", "Roles", "/app/organization/roles", "identity.role.read"],
].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

export const session = (businessDate = "2026-11-24") => ({
  authenticated: true,
  csrf: "a".repeat(43),
  workspace: {
    screenId: "HOME-OVERVIEW",
    selectedScope: scope,
    authorizedStores: [scope],
    businessDate,
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation,
  },
});

export async function inLanguage(page: Page, language: Language) {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
}

/**
 * Every read the frame makes on its own answers (nothing waiting), and anything else is refused as
 * an outage, so only the page under test shows its data.
 */
export async function quietFrame(page: Page, observedAt = new Date().toISOString()) {
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session() }));
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: { observedAt, canApprove: true, canSend: true, soleOperator: null, entries: [] },
    }),
  );
  await page.route("**/merchant/organization/roles/waiting", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: observedAt, changes: [] },
    }),
  );
  await page.route("**/merchant/organization/staff/role-requests", (route) =>
    route.fulfill({
      headers,
      json: { screenId: "APPROVAL-INBOX", sourceAsOf: observedAt, requests: [] },
    }),
  );
}

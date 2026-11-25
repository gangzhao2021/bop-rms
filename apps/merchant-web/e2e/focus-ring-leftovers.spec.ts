import { expect, test, type Page } from "@playwright/test";
import { pageRingOverhangs, ringsFrom, whole, type RingOverhang } from "./focus-ring-clip";

/**
 * Batch 61 (v15 batch 60 live, table-panel-focus-ring): two focus rings were still cut on the
 * pilot's own working screens.
 *
 * (a) At 1024x768 and 1440x900 the side navigation is its own scroll box. Tab scrolled only the
 * button's box into view, so the first group that had to scroll in (CUSTOMERS / 顾客 at 1024,
 * COMPLIANCE / 合规 at 1440) ended at the window's bottom and lost the bottom of its ring (6.09 px).
 * (b) On order entry (counter and table) the category row scrolls sideways with no room around
 * its buttons, so their rings lost top and bottom (and left for the first: only a right-hand bar).
 *
 * The navigation is the pilot Owner's whole list (tooling/environment/pilot-merchant-workspace.mjs
 * with Table QR codes, as v15 serves owner-merchant-2), and the menu has TM2's three sections.
 */
const id = (n: number) => "01909961-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "f".repeat(43);
const store = id(99);
const tableReference = id(0x1000 + 1);
const shots = process.env.B61_SHOTS ?? "test-results-b61/shots";
type Language = "en" | "zh-Hans";

const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Main - not production",
  storeReference: store,
  timeZone: "America/Toronto",
};

const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});

/** The pilot Owner's navigation, in the order the pilot lists it. */
const ownerNavigation = [
  nav(
    "STORE-SETUP",
    "Store setup",
    `/app/organization/stores/${store}/setup`,
    "organization.manage",
  ),
  nav("ORG-STORE-LIST", "Stores", "/app/organization/stores", "organization.store.read"),
  nav(
    "STORE-CAPABILITY",
    "Store features",
    `/app/organization/stores/${store}/capabilities`,
    "organization.manage",
  ),
  nav("CAT-PRODUCT-LIST", "Products", "/app/commerce/products", "catalog.manage"),
  nav("OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"),
  nav("OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry", "ordering.order.create_staff"),
  nav("KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"),
  nav("FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"),
  nav("DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"),
  nav("DIN-TABLE-LIST", "Table QR codes", "/app/operations/tables", "dining.table.qr.manage"),
  nav(
    "PAY-RECONCILIATION",
    "Settlement",
    "/app/operations/payment-reconciliation",
    "payment.settlement.read",
  ),
  nav(
    "OPS-ORDER-EXCEPTION",
    "Exceptions",
    "/operations/order-exceptions",
    "operations.order-exception.manage",
  ),
  nav("LOY-PROGRAM-LIST", "Points", "/app/customers/loyalty-programs", "loyalty.member.read"),
  nav("RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations", "reporting.sales.read"),
  nav("INV-ITEM-LIST", "Inventory items", "/app/supply/items", "inventory.item.read"),
  nav("INV-LOCATION-LIST", "Stock locations", "/app/supply/locations", "inventory.location.read"),
  nav("INV-RECEIPT-LIST", "Receiving", "/operations/receiving", "inventory.receipt.read"),
  nav("RECIPE-LIST", "Recipes", "/app/commerce/recipes", "recipe.read"),
  nav("RECIPE-OPTION-LIST", "Option recipes", "/app/commerce/option-recipes", "recipe.read"),
  nav("CAT-MENU-LIST", "Menus", "/app/commerce/menus", "catalog.menu.read"),
  nav("CAT-OPTIONSET-LIST", "Options", "/app/commerce/option-sets", "catalog.option_set.read"),
  nav("APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"),
  nav(
    "STORE-HOURS-SERVICE",
    "Hours & ordering",
    `/app/organization/stores/${store}/service`,
    "store.service.read",
  ),
  nav("CAT-AVAILABILITY", "Item availability", "/app/commerce/availability", "catalog.sku.read"),
  nav("PRICE-BOOK-LIST", "Prices", "/app/commerce/pricing", "pricing.price_book.read"),
  nav(
    "PRICE-OPTION-LIST",
    "Option prices",
    "/app/commerce/option-prices",
    "pricing.price_book.read",
  ),
  nav("TAX-STORE-REVIEW", "Tax review", "/app/commerce/tax-review", "pricing.tax_config.read"),
  nav(
    "CAT-TAX-CLASSIFICATION-LIST",
    "Tax classifications",
    "/app/commerce/tax-classifications",
    "catalog.tax-classification.manage",
  ),
  nav("CMP-ALLERGEN-REVIEW", "Allergens", "/app/compliance/allergens", "catalog.allergen.read"),
  nav("INV-COUNT-LIST", "Stock counts", "/operations/inventory/counts", "inventory.count.read"),
  nav("INV-WASTE-RECORD", "Waste", "/operations/inventory/waste", "inventory.waste.record"),
  nav("INV-OPENING-COUNT", "Opening count", "/app/supply/opening-count", "inventory.count.read"),
  nav("IAM-USER-LIST", "Staff", "/app/organization/users", "organization.staff.read"),
  nav("IAM-ROLE-LIST", "Roles", "/app/organization/roles", "identity.role.read"),
  nav(
    "IAM-SESSION-LIST",
    "Shared tablets & PINs",
    "/app/organization/sessions",
    "identity.store_device.manage",
  ),
];

const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const dish = (n: number, name: string, amount: string) => ({
  sellableReference: id(n),
  productVersionReference: id(n + 1),
  name,
  presentationRole: "Standard",
  pinned: false,
  availability: "Available",
  optionRules: [],
  allergenDisclosure: {},
  displayPrice: price(amount),
  taxDisplayContext: {},
});

/** TM2's dine-in menu: three sections, named in the language staff read it in. */
const menu = (language: Language) => {
  const zh = language === "zh-Hans";
  return {
    screenId: "OPS-ORDER-ENTRY",
    menu: {
      status: "Found",
      schemaVersion: 1,
      projection: {},
      scope: {},
      menu: {
        menuReference: id(1),
        menuVersionReference: id(2),
        releaseReference: id(3),
        locale: zh ? "zh-CN" : "en-CA",
        name: "Dine-in menu",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        effectiveUntil: null,
        sections: [
          {
            sectionReference: id(10),
            name: zh ? "面食" : "Noodles (TEST)",
            sellables: [
              dish(20, zh ? "牛肉面 (TEST)" : "Beef noodles (TEST)", "12.50"),
              dish(22, zh ? "炸酱面 (TEST)" : "Zhajiang noodles (TEST)", "11.00"),
            ],
          },
          {
            sectionReference: id(11),
            name: zh ? "小菜" : "Sides",
            sellables: [dish(24, zh ? "拍黄瓜 (TEST)" : "Smashed cucumber (TEST)", "6.00")],
          },
          {
            sectionReference: id(12),
            name: zh ? "饮品" : "Drinks",
            sellables: [dish(26, zh ? "豆浆 (TEST)" : "Soy milk (TEST)", "3.50")],
          },
        ],
      },
    },
  };
};

const table = (n: number) => ({
  tableReference: id(0x1000 + n),
  stableLabel: n === 1 ? "L61F A (TEST)" : `T${String(n)}`,
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  blockReasonCode: null,
  aggregateVersion: 2,
  currentDiningSessionReference: n <= 3 ? id(0x2000 + n) : null,
  elapsedMinutes: n <= 3 ? 12 : null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  paymentTiming: "PayLater",
  staffCall: null,
  ...(n <= 3
    ? {
        session: {
          phase: "Active",
          version: 2,
          orderReference: id(0x3000 + n),
          paymentStarted: false,
          mergedTables: [],
        },
      }
    : {}),
  staffRoundsAwaitingPayment: [],
  guestRoundsAwaitingPayment: [],
  roundsAwaitingAcceptance: [],
});

async function signIn(page: Page, language: Language) {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-24",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: ownerNavigation,
        },
      },
    }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        items: Array.from({ length: 24 }, (_, n) => table(n + 1)),
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/counter/menu**", (route) =>
    route.fulfill({ headers, json: menu(language) }),
  );
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
}

const words = {
  en: { workspace: "Workspace", categories: "Menu categories", first: "Noodles (TEST)" },
  "zh-Hans": { workspace: "工作台", categories: "菜单分类", first: "面食" },
} as const;

const cut = (ring: RingOverhang) => ring.top + ring.right + ring.bottom + ring.left > 0;

const desktop = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;
const pages = [
  { name: "tables", path: "/operations/dining", ready: "table-list" },
  { name: "counter", path: "/operations/order-entry", ready: "categories" },
] as const;

for (const language of ["en", "zh-Hans"] as const) {
  const said = words[language];

  for (const { width, height } of desktop)
    for (const screen of pages)
      /** (a) Every stop of the side navigation, the groups that must scroll in included. */
      test(`@production every side-navigation focus ring is whole on ${screen.name} at ${width}x${height} (${language})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await signIn(page, language);
        await page.goto(screen.path);
        if (screen.ready === "categories")
          await expect(page.getByRole("navigation", { name: said.categories })).toBeVisible();
        else await expect(page.locator(".table-list")).toBeVisible();
        const sidebar = page.getByRole("navigation", { name: said.workspace });
        // The navigation is taller than the window, so Tab has to scroll it.
        expect(
          await sidebar.evaluate((element) => element.scrollHeight > element.clientHeight + 40),
        ).toBe(true);
        const rings = await ringsFrom(page, sidebar, sidebar.getByRole("link").first());
        expect(rings.length).toBeGreaterThan(10);
        for (const ring of rings) {
          expect(ring.ring, ring.name).toBe(true);
          expect(ring, `side navigation: ${ring.name}`).toEqual(whole(ring));
        }
        // Every stop of the whole page, as the live sweep Tabbed it.
        const all = await pageRingOverhangs(page);
        expect(all.length).toBeGreaterThan(rings.length);
        expect(all.filter(cut)).toEqual([]);
      });

  for (const width of [390, 1024, 1440] as const) {
    const height = width === 390 ? 844 : 900;
    for (const mode of ["counter", "table"] as const)
      /** (b) The category row's buttons, the first (flush left) included. */
      test(`@production every category focus ring on ${mode} order entry is whole at ${width} (${language})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await signIn(page, language);
        await page.goto(
          mode === "table"
            ? `/operations/order-entry?table=${tableReference}`
            : "/operations/order-entry",
        );
        const row = page.getByRole("navigation", { name: said.categories });
        await expect(row.getByRole("button")).toHaveCount(3);
        const rings = await ringsFrom(
          page,
          row,
          row.getByRole("button", { name: said.first, exact: true }),
        );
        expect(rings).toHaveLength(3);
        for (const ring of rings) {
          expect(ring.ring, ring.name).toBe(true);
          expect(ring, `categories: ${ring.name}`).toEqual(whole(ring));
        }
        await page.screenshot({ path: `${shots}/categories-${mode}-${language}-${width}.png` });
        // Every stop of the page (search, dishes, the order panel, the navigation).
        const all = await pageRingOverhangs(page);
        expect(all.filter(cut)).toEqual([]);
      });
  }
}

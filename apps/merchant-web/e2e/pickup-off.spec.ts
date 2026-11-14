import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 item 8 ⑦ (v15 finding v): with guests' pickup and counter ordering off, the Pickup page
 * stays listed while pickup orders are still to hand over and says pickup is off; once none wait,
 * it is not listed and opening its address goes to Tables. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190a7f3-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};
const nav = (pickupListed: boolean) => [
  {
    screenId: "DIN-FLOOR-BOARD",
    label: "Tables",
    href: "/operations/dining",
    permission: "dining.operate",
  },
  ...(pickupListed
    ? [
        {
          screenId: "FUL-PICKUP-QUEUE",
          label: "Pickup",
          href: "/operations/pickup",
          permission: "fulfillment.operate",
        },
      ]
    : []),
];
async function session(page: Page, pickupListed: boolean) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-29",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: nav(pickupListed),
        },
      },
    }),
  );
}
const waitingItem = (n: number) => ({
  fulfillmentReference: id(200 + n),
  orderReference: id(300 + n),
  phase: "Ready",
  aggregateVersion: "2",
  readyAt: "2026-10-29T14:50:00.000Z",
  publicOrderReference: String.fromCharCode(65 + n).repeat(22),
  proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-10-29T16:00:00.000Z" },
  items: [
    {
      fulfillmentItemReference: id(400 + n),
      orderedQuantity: 1,
      readyQuantity: 1,
      handedOverQuantity: 0,
    },
  ],
});

test("@production with pickup off, Pickup stays while orders wait and says so; then it goes", async ({
  page,
}) => {
  await session(page, true);
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: store,
        observedAt: "2026-10-29T15:00:00.000Z",
        nextAfterFulfillmentReference: null,
        guestPickupOff: true,
        items: [waitingItem(1), waitingItem(2)],
      },
    }),
  );
  await page.goto("/operations/pickup");
  await expect(
    page.getByText("Pickup is turned off for guests. 2 orders are still to hand over."),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page }).include(".pickup-queue__off").analyze();
  expect(axe.violations).toEqual([]);

  // None waiting any more: the server no longer lists Pickup; its address goes to Tables.
  await page.unroute("**/merchant/session");
  await session(page, false);
  await page.goto("/operations/pickup");
  await expect(page).toHaveURL(/\/operations\/dining$/u);
});

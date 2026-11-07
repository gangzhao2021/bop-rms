import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 shared-table-checkout (c) (sim M36): on the table page staff see what guests put in the
 * table's shared cart and haven't ordered, which phone added each dish and whether that phone left,
 * and take a dish out with a reason. A change the store couldn't confirm is sent again with the
 * same reference; while a guest is paying nothing can be taken out. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "b".repeat(43);

async function openTable(page: Page) {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
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
          businessDate: "2026-11-06",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: false,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T6",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 40,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayFirst",
            session: { phase: "Active", version: 3, orderReference: null },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  const joined = new Date(Date.now() - 30 * 60_000);
  joined.setUTCMilliseconds(0);
  await page.route("**/merchant/dining/sessions/qr-join", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        paused: false,
        phones: [
          {
            participantReference: id(11),
            phoneNumber: 1,
            joinedAt: joined.toISOString(),
            left: false,
            removed: false,
          },
          {
            participantReference: id(12),
            phoneNumber: 2,
            joinedAt: joined.toISOString(),
            left: true,
            removed: true,
          },
        ],
        rounds: [],
      },
    }),
  );
}

const line = (n: number, names: Record<string, string>, change: Record<string, unknown> = {}) => ({
  cartItemReference: id(n),
  names,
  quantity: 1,
  withOptions: false,
  phoneNumber: 1,
  phoneLeft: false,
  ...change,
});

test("@production staff see a table's unsent cart and take a dish out with a reason", async ({
  page,
}) => {
  await openTable(page);
  const cart = {
    cartReference: id(3),
    cartVersion: 7,
    guestPaying: false,
    lines: [
      line(21, { "en-CA": "Mapo tofu", "zh-Hans-CA": "麻婆豆腐" }),
      line(22, { "en-CA": "Pork dumplings" }, { quantity: 2, phoneNumber: 2, phoneLeft: true }),
      line(23, {}, { phoneNumber: null, withOptions: true }),
    ],
  };
  const sent: Record<string, unknown>[] = [];
  let answerRemoveWith503 = true;
  await page.route("**/merchant/dining/sessions/table-cart", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (body.action === "Remove") {
      if (answerRemoveWith503) {
        answerRemoveWith503 = false;
        return route.fulfill({
          status: 503,
          headers,
          json: { error: "dining_table_cart_unavailable" },
        });
      }
      cart.lines = cart.lines.filter((entry) => entry.cartItemReference !== body.cartItemReference);
      cart.cartVersion += 1;
    }
    return route.fulfill({ headers, json: { cart } });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  await page.locator("details.table-panel__manage").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  const panel = page.getByRole("region", { name: "In the cart (not ordered yet)" });
  await expect(panel).toContainText("Mapo tofu × 1 · Phone 1");
  await expect(panel).toContainText("Pork dumplings × 2 · Phone 2 · left");
  await expect(panel).toContainText("A dish no longer on the menu × 1 · with options · Staff");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: `test-results/table-cart-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".table-cart").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page, ["Mark unavailable"]);

  // Each dish has its own remove; the reason is asked before anything is sent.
  await expect(panel.getByRole("button", { name: "Remove from cart" })).toHaveCount(3);
  await panel
    .getByRole("listitem")
    .filter({ hasText: "Pork dumplings" })
    .getByRole("button", { name: "Remove from cart" })
    .click();
  await expect(panel).toContainText("Why remove Pork dumplings?");
  await panel.screenshot({ path: "test-results/table-cart-reason-1440.png" });
  expect(sent.filter((body) => body.action === "Remove")).toEqual([]);
  await panel.getByRole("button", { name: "Guest left" }).click();
  // The store didn't confirm: staff are told it is never recorded twice and press again.
  await expect(panel.getByRole("alert")).toContainText(
    "We couldn't confirm the result. Press the button again: it is never recorded twice.",
  );
  await panel.getByRole("button", { name: "Guest left" }).click();
  await expect(panel).not.toContainText("Pork dumplings");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel).toContainText("Mapo tofu × 1 · Phone 1");

  const removes = sent.filter((body) => body.action === "Remove");
  expect(removes).toHaveLength(2);
  expect(removes[0]).toMatchObject({
    diningSessionReference: id(2),
    cartReference: id(3),
    cartItemReference: id(22),
    expectedCartVersion: 7,
    reason: "GuestLeft",
  });
  // The retry is the same removal: same reference, same version.
  expect(removes[1]).toEqual(removes[0]);
});

test("@production while a guest is paying, staff can't take dishes out and are told why", async ({
  page,
}) => {
  await openTable(page);
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/sessions/table-cart", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    return route.fulfill({
      headers,
      json: {
        cart: {
          cartReference: id(3),
          cartVersion: 4,
          guestPaying: true,
          lines: [line(21, { "en-CA": "Mapo tofu" })],
        },
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  await page.locator("details.table-panel__manage").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  const panel = page.getByRole("region", { name: "In the cart (not ordered yet)" });
  await expect(panel.getByRole("note")).toHaveText("A guest is paying for these dishes now.");
  await expect(panel.getByRole("button", { name: "Remove from cart" })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: "test-results/table-cart-paying-390.png" });
  expect(sent.every((body) => body.action === "Read")).toBe(true);
});

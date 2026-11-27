import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 51 (v15 b50 live, guest-pay-label-and-cart-cadence left open): at a table sharing one
// Cart, guest E's Cart (zh and en) showed −, + and 删除 / Remove on the dish guest D added, as
// outlined boxes next to "only they can change this item". The Store refuses anyone's change to a
// dish another guest added who is still at the table (it may only be removed by anyone once it
// can't be sold, or once its phone has left), so those controls were never E's to use: E now sees
// the dish's quantity and no controls; D, who added it, keeps them. The table's one cart: any
// guest may still place the order. Synthetic HTTP interception on the production PWA, in the
// shapes v15 answered (TM2, G50 Cad: one unsent "Beef noodles (TEST)" added on D's phone).
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a52-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const dish = "Beef noodles (TEST)";
const height = 844;
const sentAt = new Date(Date.now() - 1_800_000).toISOString();

type Guest = "D" | "E";

async function stubTable(page: Page, guest: Guest, changes: string[]) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: (guest === "D" ? "d" : "e").repeat(43),
        menuContext: {
          publicStoreReference: id(4),
          channel: "DineIn",
          locale: "en-CA",
          ...tm2,
        },
        visit: { publicTableReference: id(5), joined: true },
      }),
    ),
  );
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, messages: [] })),
  );
  // One table Cart; the dish carries OTHER_PARTICIPANT_ITEM on every phone but the one that added it.
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 3,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: tm2.brandDisplayName, storeName: tm2.storeDisplayName },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: dish,
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
              warnings: guest === "D" ? [] : ["OTHER_PARTICIPANT_ITEM"],
            },
          ],
          quote: null,
          warnings: [],
        },
      }),
    ),
  );
  // Any change sent is recorded (the test expects none from E); the price check is busy.
  await page.route("**/api/v1/carts**", (route) => {
    if (route.request().method() !== "GET" && !route.request().url().includes("/quote"))
      changes.push(`${guest} ${route.request().method()}`);
    return route.fulfill(json(503, {}));
  });
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        payment: {
          tableLabel: "G50 Cad (TEST)",
          checkingOut: false,
          rounds: [],
          owed: { subtotalMinor: "1250", taxMinor: "163", totalMinor: "1413" },
          consistent: true,
          tips: { enabled: false, tierPercents: [10, 15, 18] },
          state: "NotPaid",
          attempt: null,
          split: null,
          receipt: null,
        },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        staffCall: { open: null, recentlyClosed: null, nextCallAt: null },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: false } })),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        session: {
          tableLabel: "G50 Cad (TEST)",
          orderNumber: "53",
          checkedAt: sentAt,
          paymentTiming: "PayLater",
          rounds: [
            {
              roundNumber: 1,
              orderedBy: guest === "D" ? "You" : "AnotherGuest",
              submittedAt: sentAt,
              status: "Served",
              payment: "OnTableBill",
              cancelsAt: null,
              storeCancellationReason: null,
              items: [
                {
                  displayName: dish,
                  quantity: 1,
                  servedQuantity: 1,
                  cancelled: false,
                  lineTotal: { amountMinor: "1413", currencyCode: "CAD" },
                },
              ],
              itemsTotal: { amountMinor: "1413", currencyCode: "CAD" },
            },
          ],
          summary: {
            paid: { amountMinor: "0", currencyCode: "CAD" },
            refunded: { amountMinor: "0", currencyCode: "CAD" },
            refundPending: { amountMinor: "0", currencyCode: "CAD" },
            due: { amountMinor: "1413", currencyCode: "CAD" },
          },
        },
      }),
    ),
  );
}

async function openCart(
  browser: Browser,
  guest: Guest,
  zh: boolean,
  width: number,
  changes: string[],
) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: width < 768,
    isMobile: width < 768,
    serviceWorkers: "block",
  });
  await routeStorefrontReads(context);
  const page = await context.newPage();
  await stubTable(page, guest, changes);
  await page.goto("/cart");
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if (zh && (await toZh.count()) > 0) await toZh.click();
  const line = page
    .getByRole("main")
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: dish }) });
  await expect(line).toBeVisible();
  await page.waitForLoadState("networkidle");
  return { page, line, close: () => context.close() };
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test(`@production CUST-CART a dish another guest added shows no controls this guest can't use (${zh ? "zh-Hans" : "en"} ${width})`, async ({
      browser,
    }) => {
      const changes: string[] = [];
      const words = {
        theirs: zh
          ? "由同桌其他客人添加，只有对方可以修改这件商品。"
          : "Added by another guest. Only they can change this item.",
        quantity: zh ? "数量" : "Quantity",
        remove: zh ? "删除" : "Remove",
        place: zh ? "下单" : "Place order",
        quantityOf: zh ? `${dish} 的数量` : `${dish} quantity`,
      };
      // Guest E (this test's language) did not add the dish.
      const e = await openCart(browser, "E", zh, width, changes);
      await expect(e.line.getByText(words.theirs, { exact: true })).toBeVisible();
      await expect(e.line.getByRole("button")).toHaveCount(0);
      await expect(e.line.getByText("−", { exact: true })).toHaveCount(0);
      await expect(e.line.getByText(words.remove, { exact: true })).toHaveCount(0);
      await expect(e.line.getByText(words.quantity, { exact: true })).toBeVisible();
      await expect(e.line.getByRole("status", { name: words.quantityOf })).toHaveText("1");
      // The table's one cart: E may still place the order with D's dish in it.
      await expect(e.page.getByRole("button", { name: words.place, exact: true })).toBeEnabled();
      // Inside the gutter, with room for wider (Linux) fonts; nothing runs off the page.
      const box = await e.line.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
      expect(
        await e.page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await expectNoInternalText(e.page);
      await e.page.screenshot({
        path: `test-results/b51-cart-others-dish-${zh ? "zh" : "en"}-${width}.png`,
      });
      await e.close();

      // Guest D, who added it, still changes it in the same language.
      const d = await openCart(browser, "D", zh, width, changes);
      await expect(d.line.getByText(words.theirs, { exact: true })).toHaveCount(0);
      await expect(d.line.getByRole("button", { name: /^(Increase|增加)/u })).toBeEnabled();
      await expect(d.line.getByRole("button", { name: /^(Remove|删除)/u })).toBeEnabled();
      await d.close();
      expect(changes).toEqual([]);
    });

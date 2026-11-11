import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads, syntheticStoreProfile } from "./storefront-reads";

// v15 batch 5 (guest-entry-multi-store): one phone moving between the Stores of one installation.
// Synthetic answers on the production PWA, served under the customer Content-Security-Policy; the
// server side (the kept visit, its routing, the policy header) is covered by the API and tooling
// tests.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const TM2 = id(0xb2);
const DEMO = id(0xd1);
const TABLE = id(0x71);
const json = { "content-type": "application/json", "cache-control": "no-store" };
const code = (publicStoreReference: string, publicTableReference: string | null) =>
  "h." +
  Buffer.from(JSON.stringify({ publicStoreReference, publicTableReference })).toString(
    "base64url",
  ) +
  "." +
  Buffer.alloc(64, 7).toString("base64url");
const names: Record<string, string> = { [TM2]: "Test Merchant 2", [DEMO]: "DEMO Café" };
const pickupCode: Record<string, string> = { [TM2]: code(TM2, null), [DEMO]: code(DEMO, null) };
const storeOfCode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    publicStoreReference: string;
    publicTableReference: string | null;
  };
const menuContext = (store: string) => ({
  publicStoreReference: store,
  channel: "Pickup",
  locale: "en-CA",
  brandDisplayName: names[store],
  storeDisplayName: names[store],
});
const order = (n: number) => ({
  orderReference: id(0xc00 + n),
  orderNumber: String(n),
  orderType: "Pickup",
});
const established = (store: string, table: string | null, resumed = false) => ({
  schemaVersion: 2,
  status: "Established",
  ...(resumed ? { resumed: true } : {}),
  brandDisplayName: names[store],
  storeDisplayName: names[store],
  publicStoreReference: store,
  publicTableReference: table,
  channel: table === null ? "Pickup" : "DineIn",
  operatingState: "Open",
  availableServiceModes: ["Pickup", "DineIn"],
  locale: "en-CA",
  contextExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...(table === null ? {} : { tableOpen: true }),
  csrfToken: "N".repeat(43),
});

interface Phone {
  /** The visit this phone's cookie names now (null: none), and its latest order. */
  visit: { store: string; order?: ReturnType<typeof order> } | null;
  /** Visits kept on the phone besides it. */
  kept: { store: string; order?: ReturnType<typeof order> }[];
  entries: { qrToken?: unknown }[];
}

/** An installation of two merchants, and a phone whose visits move between them as the server does. */
async function installation(page: Page, phone: Phone) {
  await page.route("**/bff/customer/payment-configuration", (route) =>
    route.fulfill({
      headers: json,
      body: JSON.stringify({
        schemaVersion: 1,
        mode: "stripe",
        publishableKey: "pk_test_SyntheticBrowserOnly",
        returnUrl: "https://synthetic-return.invalid/return",
        wallets: false,
        internalTestEntry: true,
      }),
    }),
  );
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    phone.visit === null
      ? route.fulfill({ status: 204, headers: { "cache-control": "no-store" } })
      : route.fulfill({
          headers: json,
          body: JSON.stringify({
            schemaVersion: 1,
            csrfToken: "K".repeat(43),
            menuContext: menuContext(phone.visit.store),
            ...(phone.visit.order ? { currentOrder: phone.visit.order } : {}),
          }),
        }),
  );
  await page.route("**/bff/customer/pickup-entry*", (route) => {
    const store = new URL(route.request().url()).searchParams.get("store") ?? "";
    return route.fulfill({
      headers: json,
      body: JSON.stringify({ schemaVersion: 1, qrToken: pickupCode[store] }),
    });
  });
  // TM2 publishes no phone; DEMO does.
  await page.route("**/api/v1/customer/store*", (route) =>
    route.fulfill({
      headers: json,
      body: JSON.stringify({
        ...syntheticStoreProfile,
        store: {
          ...syntheticStoreProfile.store,
          storeDisplayName: names[phone.visit?.store ?? DEMO],
          phone: phone.visit?.store === TM2 ? null : syntheticStoreProfile.store.phone,
        },
      }),
    }),
  );
  await page.route("**/bff/customer/entry", (route) => {
    const body = JSON.parse(route.request().postData() ?? "null") as { qrToken?: string };
    phone.entries.push(body);
    const place = storeOfCode(String(body.qrToken));
    // The server goes on with a pickup visit this phone keeps at that Store.
    const kept = phone.kept.find((visit) => visit.store === place.publicStoreReference);
    if (place.publicTableReference === null && kept !== undefined) {
      phone.kept = [
        ...phone.kept.filter((visit) => visit !== kept),
        ...(phone.visit ? [phone.visit] : []),
      ];
      phone.visit = kept;
      return route.fulfill({
        status: 200,
        headers: json,
        body: JSON.stringify(established(kept.store, null, true)),
      });
    }
    if (phone.visit !== null) phone.kept = [...phone.kept, phone.visit];
    phone.visit = { store: place.publicStoreReference };
    return route.fulfill({
      status: 201,
      headers: json,
      body: JSON.stringify(established(place.publicStoreReference, place.publicTableReference)),
    });
  });
}

/** Content-Security-Policy violations the page reports (the production build runs under it). */
function watchPolicy(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (/Content Security Policy/iu.test(message.text())) violations.push(message.text());
  });
  return violations;
}
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

for (const width of [390, 1024, 1440])
  test.describe(`@production one phone at several Stores (${width}px)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("another Store's pickup code opens that Store, and the first Store's code brings the paid order back", async ({
      page,
    }) => {
      const violations = watchPolicy(page);
      const phone: Phone = { visit: { store: TM2, order: order(13) }, kept: [], entries: [] };
      await installation(page, phone);
      // Paid at Test Merchant 2, then DEMO Store's pickup link.
      const first = await page.goto(`/#pickup=${DEMO}`);
      expect(first?.headers()["content-security-policy"]).toContain("script-src 'self'");
      const main = page.getByRole("main");
      await expect(main).toContainText("Pickup from DEMO Café is selected.");
      await expect(main.getByText("Your order 13")).toHaveCount(0);
      await expect(page.getByRole("note")).toContainText(
        "Your order at Test Merchant 2 is kept on this phone. Scan Test Merchant 2’s pickup QR code again to go back to it.",
      );
      await noHorizontalOverflow(page);
      await expectNoInternalText(page);
      await page.screenshot({ path: `test-results/b3-other-store-${width}.png`, fullPage: true });
      // Test Merchant 2's code again, in a fresh load: its kept visit and order 13 come back.
      await page.goto("about:blank");
      await page.goto(`/#pickup=${TM2}`);
      await expect(main.getByRole("heading", { name: "Your order 13" })).toBeVisible();
      await expect(main.getByRole("link", { name: "View order 13" })).toBeVisible();
      await expect(main.getByText("Ready to order")).toHaveCount(0);
      await noHorizontalOverflow(page);
      await page.screenshot({ path: `test-results/b3-back-${width}.png`, fullPage: true });
      await main.getByRole("button", { name: "Order more" }).click();
      await expect(page).toHaveURL(/\/menu$/u);
      expect(phone.entries.map((entry) => storeOfCode(String(entry.qrToken)))).toEqual([
        { publicStoreReference: DEMO, publicTableReference: null },
        { publicStoreReference: TM2, publicTableReference: null },
      ]);
      await page.getByRole("button", { name: "切换到中文" }).click();
      expect(violations).toEqual([]);
    });

    test("a phone that collected a pickup order opens the table it scans, with the order kept", async ({
      page,
    }) => {
      const violations = watchPolicy(page);
      const phone: Phone = { visit: { store: TM2, order: order(20) }, kept: [], entries: [] };
      await installation(page, phone);
      await page.goto(`/#qr=${code(TM2, TABLE)}`);
      const main = page.getByRole("main");
      await expect(main.getByText("Your order 20")).toHaveCount(0);
      await expect(main).not.toContainText("Pickup from Test Merchant 2 is selected.");
      await expect(page.getByRole("note")).toContainText(
        "Your order at Test Merchant 2 is kept on this phone.",
      );
      expect(phone.entries).toHaveLength(1);
      await noHorizontalOverflow(page);
      await expectNoInternalText(page);
      await page.screenshot({
        path: `test-results/pickup-then-table-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "切换到中文" }).click();
      await expect(page.getByRole("note")).toContainText("Test Merchant 2");
      expect(violations).toEqual([]);
    });

    test("another Store's link opened in the same tab opens that Store; help says call only with a phone", async ({
      page,
    }) => {
      const violations = watchPolicy(page);
      const phone: Phone = { visit: null, kept: [], entries: [] };
      await installation(page, phone);
      await page.goto(`/#pickup=${DEMO}`);
      const main = page.getByRole("main");
      await expect(main).toContainText("Pickup from DEMO Café is selected.");
      const help = page.locator(".entry-help");
      await expect(help).toContainText("call them or ask at the counter before you order");
      // Same tab, only the fragment changes (no about:blank in between).
      await page.goto(`/#pickup=${TM2}`);
      await expect(main).toContainText("Pickup from Test Merchant 2 is selected.");
      await expect(main).not.toContainText("DEMO Café");
      // Test Merchant 2 publishes no phone: its card shows no number, so nobody is told to call.
      await expect(page.getByRole("link", { name: /^Call / })).toHaveCount(0);
      await expect(help).toContainText(
        "To tell the store about an allergy, ask at the counter before you order.",
      );
      await expect(help).not.toContainText("call them");
      await noHorizontalOverflow(page);
      await expectNoInternalText(page);
      await page.screenshot({ path: `test-results/same-tab-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "切换到中文" }).click();
      await expect(help).toContainText("如有过敏，请在下单前到柜台告诉店员。");
      expect(violations).toEqual([]);
    });

    test("the cart of a guest only looking at a closed Store's menu says it's closed, not that it failed", async ({
      page,
    }) => {
      const violations = watchPolicy(page);
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 409,
          headers: json,
          body: JSON.stringify({
            schemaVersion: 1,
            code: "entry_not_accepting",
            messageKey: "customer.entry.not_accepting",
            recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
            store: {
              storeDisplayName: "Lane Dessert",
              operatingState: "Closed",
              todayHours: [],
              todayKind: null,
              nextOpening: { localDate: "2026-12-22", startLocalTime: "12:00:00" },
              localDate: "2026-12-22",
              browse: {
                brandDisplayName: "Lane Brand",
                publicStoreReference: id(0xe1),
                locale: "en-CA",
                channel: "Pickup",
              },
            },
          }),
        }),
      );
      // No Store has a visit for this phone.
      await page.route("**/bff/customer/cart*", (route) =>
        route.fulfill({
          status: 404,
          headers: json,
          body: JSON.stringify({ code: "CUSTOMER_STORE_NOT_FOUND" }),
        }),
      );
      await page.goto("/#qr=aaa.bbb.ccc");
      await page.getByRole("button", { name: "Look at the menu first" }).click();
      await expect(page).toHaveURL(/\/menu$/u);
      // Back to the cart from inside the app (the back button, a saved link in the app).
      await page.evaluate(() => {
        window.history.pushState({}, "", "/cart");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "Lane Dessert isn’t taking orders right now" }),
      ).toBeVisible();
      await expect(main).toContainText("Closed now · opens today at 12:00 p.m.");
      await expect(main.getByRole("link", { name: "Back to menu" })).toBeVisible();
      await expect(main).not.toContainText("couldn’t load your cart");
      await expect(main).not.toContainText("Couldn’t update your cart");
      await noHorizontalOverflow(page);
      await expectNoInternalText(page);
      await page.screenshot({ path: `test-results/closed-cart-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "切换到中文" }).click();
      await expect(main).toContainText("Lane Dessert现在不接单");
      await page.getByRole("button", { name: "Switch to English" }).click();
      // Reloaded at /cart (a bookmark): no visit at any Store, so no cart, and no failure.
      await page.goto("/cart");
      await expect(main.getByRole("heading", { name: "Your cart is empty" })).toBeVisible();
      await expect(main).not.toContainText("couldn’t load your cart");
      await expect(main).not.toContainText("Your cart is kept");
      await noHorizontalOverflow(page);
      expect(violations).toEqual([]);
    });
  });

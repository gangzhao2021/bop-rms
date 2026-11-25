import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  v15PickupOrderReference,
  v15PickupStatusBody,
} from "../src/order-status/v15-pickup-status.fixture";
import { cartLine, id, json, stubTableGuest } from "./guest-v3-fixtures";
import { smallTargets } from "./guest-v3-measure";
import { receipt } from "./receipt-fixture";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 64 (v15 batch 63 live check, customer-v3-type-controls), on the production PWA with
// synthetic HTTP answers in the shapes v15 sent. Measured at 390, 1024 and 1440 in English and
// Chinese with the machine's fonts (DejaVu on Linux CI):
//  - F11: an open table scanned straight away said "Join this table" with no table name.
//  - F08: zh 导航 (Directions) and the offline cart's 重试 were 32 × 44; the offers box row was
//    600 × 24 at 1024/1440.
//  - F09: the Privacy notice was a black underlined 18 px-high link beside accent links; it is
//    now accent and 44 px, and keeps its underline inside the sentence (axe link-in-text-block).
//  - The pickup status links ran together: "View receipt and supportBack to menu".
//  - Not reachable live: the moved-table words (您已换桌…) and the paused-ordering amber dot.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const accent = "rgb(31, 99, 224)";
const amber = "rgb(138, 90, 0)";
const noStore = { "cache-control": "no-store" };

const look = (target: Locator) =>
  target.evaluate((element) => {
    const css = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      color: css.color,
      underline: css.textDecorationLine,
      weight: css.fontWeight,
      width: box.width,
      height: box.height,
    };
  });

async function chooseChinese(page: Page) {
  // The choice is kept on this phone: only the first page needs the tap.
  const button = page.getByRole("button", { name: /^(切换到中文|Switch to English)$/u }).first();
  await button.waitFor();
  const toZh = page.getByRole("button", { name: "切换到中文" });
  if ((await toZh.count()) > 0) await toZh.click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
}

const entryAnswer = {
  schemaVersion: 2,
  status: "Established",
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
  publicStoreReference: id(6),
  publicTableReference: id(7),
  channel: "DineIn",
  operatingState: "Open",
  availableServiceModes: ["DineIn"],
  locale: "en-CA",
  csrfToken: "g".repeat(43),
};

function paused(channel: "DineIn" | "Pickup") {
  return {
    schemaVersion: 1,
    code: "entry_not_accepting",
    messageKey: "customer.entry.not_accepting",
    recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
    store: {
      storeDisplayName: "半糖奶茶 Half Sugar Tea (TEST)",
      operatingState: "TemporarilyClosed",
      todayHours: [],
      todayKind: null,
      nextOpening: null,
      localDate: null,
      browse: {
        brandDisplayName: "Synthetic Brand",
        publicStoreReference: id(6),
        locale: "en-CA",
        channel,
      },
    },
  };
}

/** The member offer as the receipt reads it: not signed in, so the join form and its box show. */
async function offerMembership(page: Page) {
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "c".repeat(43),
        menuContext: {
          publicStoreReference: id(6),
          channel: "Pickup",
          locale: "en-CA",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Receipt Store",
        },
      }),
    ),
  );
  await page.route("**/bff/customer/member", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        offered: true,
        signedIn: false,
        messagesAvailable: true,
        rule: {
          earnPointsPerDollar: 3,
          redeemPointsPerDollar: 100,
          minimumRedemptionPoints: 300,
          redemptionIncrementPoints: 100,
          rewards: [],
        },
        claim: { until: "2026-11-03T18:00:00.000Z", parts: [{ partNumber: null, points: 45 }] },
      }),
    ),
  );
}

/** A pickup guest's order page, with the Store's privacy notice on its contact details. */
async function openPickupStatus(page: Page) {
  const body = v15PickupStatusBody("ready") as unknown as {
    status: { sources: Record<string, unknown> };
  };
  body.status.sources.privacyNoticeUrl = "https://example.test/privacy";
  await page.route(/\/api\/v1\/orders\/[^/]+\/status(?:\?.*)?$/u, (route) =>
    route.fulfill({ json: body }),
  );
  await page.route(/\/api\/v1\/orders\/[^/]+\/pickup-code(?:\?.*)?$/u, (route) =>
    route.fulfill({ status: 503, headers: noStore, json: {} }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: noStore,
      json: {
        ...entryAnswer,
        storeDisplayName: "Synthetic Status Store",
        publicTableReference: null,
        channel: "Pickup",
        availableServiceModes: ["Pickup"],
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.locator(".bop-shell__header h1")).toHaveText("Synthetic Status Store");
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/orders/${v15PickupOrderReference}`);
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production batch 64 customer leftovers (${zh ? "zh-Hans" : "en"} ${String(width)})`, () => {
      test.use({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: width < 1440,
        isMobile: width < 768,
        locale: zh ? "zh-CN" : "en-CA",
      });
      const shot = (name: string) =>
        `test-results/b64-${name}-${zh ? "zh" : "en"}-${String(width)}.png`;

      test("F11: an open table scanned straight away is named on its join page", async ({
        page,
      }) => {
        await page.route("**/bff/customer/entry", (route) =>
          route.fulfill({
            status: 201,
            headers: noStore,
            json: {
              ...entryAnswer,
              tableOpen: true,
              table: { label: "V63 A (TEST)" },
              contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
          }),
        );
        await page.goto("/#qr=aaa.bbb.ccc");
        await expect(page.locator("#entry-heading")).toHaveText(
          zh ? "加入 V63 A (TEST)" : "Join V63 A (TEST)",
        );
        await expect(
          page.getByText(zh ? "不是您的桌？请告诉店员。" : "Not your table? Tell staff."),
        ).toBeVisible();
        // F08: the store card's links (导航 is two characters) are 44 × 44 taps.
        await expect(page.locator(".store-identity__links a").first()).toBeVisible();
        expect(await smallTargets(page, ".store-identity__links a")).toEqual([]);
        await page.screenshot({ path: shot("join-direct"), fullPage: true });
      });

      test("F08: Directions on the menu and Try again on the offline cart are 44 × 44", async ({
        page,
        context,
      }) => {
        await stubTableGuest(page, { cartItems: [cartLine(id(20))] });
        await page.goto("/menu");
        if (zh) await chooseChinese(page);
        const directions = page.locator(".store-identity__links a").first();
        await expect(directions).toHaveText(zh ? /^导航/u : /^Directions/u);
        expect(await smallTargets(page, ".store-identity__links a")).toEqual([]);
        await page.goto("/cart");
        await expect(page.getByRole("main").locator(".cart-item").first()).toBeVisible();
        await context.setOffline(true);
        const again = page.locator(".cart-offline button");
        await expect(again).toHaveText(zh ? "重试" : "Try again");
        expect(await smallTargets(page, ".cart-offline button")).toEqual([]);
        expect((await look(again)).color).toBe(accent);
        await page.screenshot({ path: shot("cart-offline") });
        await context.setOffline(false);
      });

      test("F08/F09: on the receipt the offers box is a 44 px row and Privacy notice is accent words", async ({
        page,
      }) => {
        await offerMembership(page);
        const answer = receipt(true);
        await page.route(/\/api\/v1\/orders\/[^/]+\/receipt(?:\?.*)?$/u, (route) =>
          route.fulfill(json(200, answer)),
        );
        await page.goto(`/orders/${answer.receipt.orderReference}/receipt`);
        if (zh) await chooseChinese(page);
        const consent = page.locator(".member-form__consent");
        await expect(consent).toBeVisible();
        expect((await look(consent)).height).toBeGreaterThanOrEqual(44);
        // The box is inside its row, beside its words (a wrapped line keeps it in the row).
        const inside = await consent.evaluate((label) => {
          const row = label.getBoundingClientRect();
          const box = label.querySelector("input")?.getBoundingClientRect();
          return box !== undefined && box.top >= row.top - 0.5 && box.bottom <= row.bottom + 0.5;
        });
        expect(inside).toBe(true);
        const privacy = page.locator(".privacy-notice-link");
        await expect(privacy).toContainText(zh ? "隐私声明" : "Privacy notice");
        const privacyLook = await look(privacy);
        // Inside a sentence the link keeps its underline, so it is told apart without colour (axe
        // link-in-text-block, WCAG 1.4.1).
        expect(privacyLook).toMatchObject({ color: accent, underline: "underline", weight: "400" });
        expect(privacyLook.width).toBeGreaterThanOrEqual(44);
        expect(privacyLook.height).toBeGreaterThanOrEqual(44);
        // F09: "Not now" is a secondary action too: accent words on a 44 px tap, from the edge.
        const notNow = page.locator(".member-panel__skip");
        const notNowLook = await look(notNow);
        expect(notNowLook).toMatchObject({ color: accent, weight: "400" });
        expect(notNowLook.height).toBeGreaterThanOrEqual(44);
        const edges = await notNow.evaluate((button) => [
          button.getBoundingClientRect().left,
          button.closest(".member-panel")?.getBoundingClientRect().left ?? -1,
        ]);
        expect(Math.abs((edges[0] ?? 0) - (edges[1] ?? 0))).toBeLessThanOrEqual(1);
        await page.screenshot({ path: shot("receipt-offers"), fullPage: true });
      });

      test("the order page's links stand apart, and Privacy notice is accent words", async ({
        page,
      }) => {
        await openPickupStatus(page);
        const main = page.getByRole("main");
        const receiptLink = main.locator(".order-status__receipt");
        const back = main.locator(".order-status__back");
        await expect(back).toBeVisible();
        const [first, second] = await Promise.all([receiptLink.boundingBox(), back.boundingBox()]);
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        // Side by side with a 24 px gap, or one under the other (narrow Linux fonts may wrap).
        const sameLine = Math.abs((first?.y ?? 0) - (second?.y ?? 0)) < 1;
        if (sameLine)
          expect((second?.x ?? 0) - ((first?.x ?? 0) + (first?.width ?? 0))).toBeGreaterThanOrEqual(
            23,
          );
        else expect(second?.y ?? 0).toBeGreaterThanOrEqual((first?.y ?? 0) + (first?.height ?? 0));
        const text = await main.innerText();
        expect(text).not.toContain(zh ? "帮助返回菜单" : "supportBack to menu");
        const privacy = main.locator(".privacy-notice-link");
        const privacyLook = await look(privacy);
        // Inside a sentence the link keeps its underline, so it is told apart without colour (axe
        // link-in-text-block, WCAG 1.4.1).
        expect(privacyLook).toMatchObject({ color: accent, underline: "underline", weight: "400" });
        expect(privacyLook.width).toBeGreaterThanOrEqual(44);
        expect(privacyLook.height).toBeGreaterThanOrEqual(44);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        await page.screenshot({ path: shot("pickup-status-links"), fullPage: true });
      });

      test("moved table: making a code says the party moved, in the guest's words", async ({
        page,
      }) => {
        await stubTableGuest(page);
        await page.route("**/api/v1/dine-in/invitation", (route) =>
          route.request().method() === "GET"
            ? route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: true } }))
            : route.fulfill(
                json(409, {
                  schemaVersion: 1,
                  error: {
                    code: "dining_invitation_table_changed",
                    messageKey: "customer.dining.invitation_table_changed",
                  },
                }),
              ),
        );
        await page.goto("/dine-in/session");
        if (zh) await chooseChinese(page);
        await page.getByRole("button", { name: zh ? "生成代码" : "Make a code" }).click();
        await expect(page.getByRole("main")).toContainText(
          zh
            ? "您已换桌，请向店员索取新桌的入桌码。"
            : "Your table was changed. Ask a staff member for a join code for your new table.",
        );
        await expect(page.getByRole("main")).not.toContainText("本桌已更换");
        await page.screenshot({ path: shot("moved-table") });
      });

      test("the join code's time closes in the guest's own punctuation", async ({ page }) => {
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        await stubTableGuest(page);
        await page.route("**/api/v1/dine-in/invitation", (route) =>
          route.request().method() === "GET"
            ? route.fulfill(json(200, { schemaVersion: 1, invitation: { canInvite: true } }))
            : route.fulfill(
                json(201, {
                  schemaVersion: 1,
                  invitation: { status: "Issued", code: "482913", expiresAt },
                }),
              ),
        );
        await page.goto("/dine-in/session");
        if (zh) await chooseChinese(page);
        await page.getByRole("button", { name: zh ? "生成代码" : "Make a code" }).click();
        const line = page
          .locator(".dining-invitation p")
          .filter({ hasText: zh ? "15 分钟内有效" : "15 minutes" });
        if (zh) await expect(line).toHaveText(/（至 \d{1,2}:\d{2}）。$/u);
        else await expect(line).toHaveText(/\(until \d{1,2}:\d{2}[^)]*\)\.$/u);
      });

      test("a short pause is an amber dot at the start and on the menu, not the closed red one", async ({
        page,
      }) => {
        await page.route("**/bff/customer/entry", (route) =>
          route.fulfill({ status: 409, headers: noStore, json: paused("Pickup") }),
        );
        await page.goto("/#qr=aaa.bbb.ccc");
        const title = page.locator("#entry-heading");
        await expect(title).toHaveText(zh ? "点单已暂停" : "Ordering is paused");
        expect(
          await title.evaluate((element) => getComputedStyle(element, "::before").backgroundColor),
        ).toBe(amber);
        await page.screenshot({ path: shot("paused-entry") });
        await page
          .getByRole("button", { name: zh ? "先看看菜单" : "Look at the menu first" })
          .click();
        await expect(page).toHaveURL(/\/menu$/u);
        const line = page.locator(".menu-closed-notice__line").first();
        await expect(line).toBeVisible();
        expect(
          await line.evaluate((element) => getComputedStyle(element, "::before").backgroundColor),
        ).toBe(amber);
        await page.screenshot({ path: shot("paused-menu") });
      });
    });

// F09: "Have points?" comes after the payment choices (what is paid, the tip), not before them.
for (const width of [390, 1024, 1440])
  test.describe(`@production batch 64 Have points placement (${String(width)})`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 1440, isMobile: width < 768 });
    test("F09: Have points? sits under the tip and above Pay", async ({ page }) => {
      await stubTableGuest(page);
      await page.route("**/bff/customer/member", (route) =>
        route.fulfill(
          json(200, { schemaVersion: 1, offered: true, signedIn: false, messagesAvailable: true }),
        ),
      );
      await page.route("**/api/v1/dine-in/table-payment**", (route) =>
        route.fulfill(
          json(200, {
            schemaVersion: 1,
            payment: {
              tableLabel: "G48 C (TEST)",
              checkingOut: true,
              rounds: [
                {
                  roundNumber: 1,
                  items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "2500" }],
                  totalMinor: "2825",
                },
              ],
              owed: { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
              consistent: true,
              tips: { enabled: true, tierPercents: [10, 15, 18] },
              state: "NotPaid",
              attempt: null,
              receipt: null,
              split: null,
            },
          }),
        ),
      );
      await page.goto("/dine-in/session");
      const points = page.getByRole("button", { name: "Have points? Sign in to use them" });
      await expect(points).toBeVisible();
      const tip = page.locator(".dining-session__tip");
      const pay = page.locator(".dining-session__pay-button");
      const [tipBox, pointsBox, payBox] = await Promise.all([
        tip.boundingBox(),
        points.boundingBox(),
        pay.boundingBox(),
      ]);
      expect(pointsBox?.y ?? 0).toBeGreaterThanOrEqual((tipBox?.y ?? 0) + (tipBox?.height ?? 0));
      expect(payBox?.y ?? 0).toBeGreaterThanOrEqual((pointsBox?.y ?? 0) + (pointsBox?.height ?? 0));
      expect((await look(points)).color).toBe(accent);
      expect(pointsBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `test-results/b64-have-points-${String(width)}.png` });
    });
  });

import { expect, test, type Page } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";
import { cartLine, dish, id, stubTableGuest } from "./guest-v3-fixtures";
import { offScaleText, smallTargets } from "./guest-v3-measure";

// Batch 63 (v15 batch 62 page review, F07–F14) on the production PWA, with synthetic HTTP answers
// in the shapes v15 sent (TM2 table guest). Measured at 390, 1024 and 1440 with the fonts of the
// machine (DejaVu on Linux CI): edges within 1 px, centres within 3 px.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

const accent = "rgb(31, 99, 224)";
const dark = "rgb(23, 23, 23)";
const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
      };
    });
const style = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const css = getComputedStyle(element);
      return {
        color: css.color,
        background: css.backgroundColor,
        border: css.borderTopWidth,
        borderBottom: css.borderBottomWidth,
        size: css.fontSize,
        weight: css.fontWeight,
        position: css.position,
        lineHeight: Number.parseFloat(css.lineHeight),
        opacity: css.opacity,
      };
    });

async function chooseChinese(page: Page) {
  // The choice is kept on this phone: only the first page needs the tap.
  const button = page.getByRole("button", { name: "切换到中文" });
  if ((await button.count()) > 0) await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
}

for (const width of [390, 1024, 1440])
  test.describe(`@production batch 63 table guest at ${String(width)}`, () => {
    test.use({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: width < 1440,
      isMobile: width < 768,
    });

    for (const zh of [false, true])
      test(`F07/F08: menu, dish, cart and Your table use the v3 type and 44 px taps (${zh ? "zh-Hans" : "en"})`, async ({
        page,
      }) => {
        await stubTableGuest(page, { cartItems: [cartLine(id(20))] });
        const found: string[] = [];
        for (const [path, ready] of [
          ["/menu", dish],
          [`/menu/items/${id(3)}`, dish],
          ["/cart", dish],
          ["/dine-in/session", dish],
        ] as const) {
          await page.goto(path);
          if (zh) await chooseChinese(page);
          await expect(page.getByRole("main").getByText(ready).first()).toBeVisible();
          await page.waitForLoadState("networkidle");
          found.push(...(await offScaleText(page)).map((line) => `${path} ${line}`));
          found.push(
            ...(
              await smallTargets(
                page,
                ".language-switch, .bop-shell__nav > a, .menu-sections a, .configure-stepper button, .cart-item__actions button, .menu-card__quick-add",
              )
            ).map((line) => `${path} ${line}`),
          );
        }
        expect(found).toEqual([]);
        // The language switch is accent words at the top right: no box.
        const language = await style(page, ".language-switch");
        expect(language.border).toBe("0px");
        expect(language.color).toBe(accent);
      });

    test("F14: the dish page starts on the header's edge, and the + sits on the price line", async ({
      page,
    }) => {
      await stubTableGuest(page);
      await page.goto(`/menu/items/${id(3)}`);
      await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
      const header = await rect(page, ".bop-shell__header h1");
      const back = await rect(page, ".sellable-detail__back");
      expect(Math.abs(back.left - header.left)).toBeLessThanOrEqual(1);
      // The allergen line every dish carries, in plain words.
      await expect(
        page.getByText("No allergens listed. Ask staff if you have an allergy.", { exact: true }),
      ).toBeVisible();
      await page.goto("/menu");
      const card = page.locator(".menu-card", { hasText: dish });
      await expect(card).toBeVisible();
      await expect(card.locator(".menu-card__allergens")).toHaveText(
        "No allergens listed. Ask staff if you have an allergy.",
      );
      const plus = await rect(page, ".menu-card__quick-add");
      const price = await rect(page, ".menu-card__price");
      const row = await rect(page, ".menu-card");
      expect(
        Math.abs((plus.top + plus.bottom) / 2 - (price.top + price.bottom) / 2),
      ).toBeLessThanOrEqual(3);
      expect(Math.abs(plus.right - row.right)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `test-results/b63-menu-${String(width)}.png` });
    });

    test("F14: what + did is a dot and dark words in the cart bar or panel, never a black block", async ({
      page,
    }) => {
      await stubTableGuest(page, { cartItems: [cartLine(id(20))] });
      await page.goto("/menu");
      await page.getByRole("button", { name: `Add ${dish} to your cart` }).click();
      const notice = page.locator(".menu-added-toast");
      await expect(notice).toHaveText("Added to your cart.");
      const look = await style(page, ".menu-added-toast");
      expect(look.background).toBe("rgba(0, 0, 0, 0)");
      expect(look.color).toBe(dark);
      expect(look.size).toBe("14px");
      // Inside the bar on a phone; in the cart panel beside the menu on a wide screen.
      const holder = width < 1024 ? ".menu-cart-bar" : ".menu-cart-panel";
      await expect(page.locator(`${holder} .menu-added-toast`)).toBeVisible();
      const dot = await notice.evaluate(
        (element) => getComputedStyle(element, "::before").backgroundColor,
      );
      expect(dot).not.toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: `test-results/b63-added-${String(width)}.png` });
    });

    test("F12/F14: Your table has no order eyebrow and its actions start on the page's edge", async ({
      page,
    }) => {
      await stubTableGuest(page);
      await page.goto("/dine-in/session");
      const main = page.getByRole("main");
      await expect(main.getByText(dish).first()).toBeVisible();
      await expect(main.locator(".bop-eyebrow")).toHaveCount(0);
      await expect(main.getByText("Order 31", { exact: true })).toHaveCount(0);
      const edge = (await rect(page, "#page-heading")).left;
      const refresh = await rect(page, ".order-status__actions button");
      const content = await rect(page, ".order-status__actions");
      expect(Math.abs(refresh.left - edge)).toBeLessThanOrEqual(1);
      expect(refresh.width).toBeLessThan(content.width / 2);
      const look = await style(page, ".order-status__actions button");
      expect(look.border).toBe("0px");
      expect(look.color).toBe(accent);
      // Fully served: "Served", never "Served 2 of 2"; the round already says Served.
      await expect(main.getByText(/Served 2 of 2/u)).toHaveCount(0);
      // CDI-4: what the table owes is as strong as a round's total; its labels are 14 px.
      const due = await style(page, ".dining-session__due dt");
      expect(due.size).toBe("16px");
      expect(due.weight).toBe("600");
      await page.screenshot({
        path: `test-results/b63-table-${String(width)}.png`,
        fullPage: true,
      });
    });

    test("F12: the round just placed is said by its number, and only until the next read", async ({
      page,
    }) => {
      // Round 1 is in the kitchen (queued), as the cart's one-tap place leaves it.
      await stubTableGuest(page, {
        session: (base) => ({
          ...base,
          rounds: (base.rounds as Record<string, unknown>[]).map((round) => ({
            ...round,
            status: "Queued",
            items: (round.items as Record<string, unknown>[]).map((item) => ({
              ...item,
              servedQuantity: 0,
              progress: "Waiting",
            })),
          })),
        }),
      });
      await page.goto("/menu");
      await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
      // As the cart does after placing a round: to Your table, saying it was placed.
      await page.evaluate(() => {
        history.pushState(
          { usr: { placed: "Sent" }, key: "placed", idx: 1 },
          "",
          "/dine-in/session",
        );
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      });
      const main = page.getByRole("main");
      const placed = main.locator(".dining-session__placed");
      await expect(placed).toHaveText("Round 1 sent to the kitchen");
      // The round says "Sent to the kitchen"; its dish doesn't repeat "Waiting" under it.
      await expect(main.locator(".order-status__item-progress")).toHaveCount(0);
      await main.getByRole("button", { name: "Refresh now" }).click();
      await expect(placed).toHaveCount(0);
    });

    test("F14: switching language keeps the guest's place on the menu", async ({ page }) => {
      await page.setViewportSize({ width, height: 420 });
      await stubTableGuest(page);
      await page.goto("/menu");
      await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const target = await page.evaluate(() => {
        const most = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, Math.min(300, most));
        return window.scrollY;
      });
      expect(target).toBeGreaterThan(100);
      // A tap on the switch where it is (Playwright's click would first scroll the header back
      // into view). Without the fix the page jumped to 87 as the menu read its names again.
      await page.locator(".language-switch").dispatchEvent("click");
      await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - target)).toBeLessThanOrEqual(2);
    });

    test("F10: offline, the cart says it once in plain words and keeps its next step in place", async ({
      page,
      context,
    }) => {
      await stubTableGuest(page, { cartItems: [cartLine(id(20))] });
      await page.goto("/cart");
      const main = page.getByRole("main");
      await expect(main.getByRole("button", { name: "Place order" })).toBeEnabled();
      await context.setOffline(true);
      const banner = page.locator(".connectivity-banner");
      await expect(banner).toHaveText(
        "No connection. Your cart is kept on this phone. To order now, ask a staff member.",
      );
      expect((await style(page, ".connectivity-banner")).borderBottom).toBe("0px");
      // One message: nothing in the page repeats it, and nothing says "checkout" or "replay".
      await expect(main.getByText(/offline|replay|checkout/iu)).toHaveCount(0);
      const place = main.getByRole("button", { name: "Place order" });
      await expect(place).toBeVisible();
      await expect(place).toBeDisabled();
      const placeLook = await style(page, ".cart-checkout-link");
      expect(placeLook.background).toBe(accent);
      expect(Number(placeLook.opacity)).toBeLessThan(1);
      const again = await style(page, ".cart-offline button");
      expect(again.color).toBe(accent);
      expect(again.border).toBe("0px");
      // A stepper that can't be used is the same shape, grey, with no box.
      const stepper = await style(page, ".cart-item__actions button:disabled");
      expect(stepper.border).toBe("0px");
      await page.screenshot({ path: `test-results/b63-cart-offline-${String(width)}.png` });
      await context.setOffline(false);
    });
  });

const entryContext = {
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

for (const width of [390, 1024])
  for (const zh of [false, true])
    test.describe(`@production batch 63 start page (${zh ? "zh-Hans" : "en"} ${String(width)})`, () => {
      test.use({ viewport: { width, height: 844 }, locale: zh ? "zh-CN" : "en-CA" });

      test("F11: the join is one title, the store only in the header, and Not your table", async ({
        page,
      }) => {
        await page.route("**/bff/customer/entry", (route) =>
          route.fulfill({
            status: 201,
            headers: { "cache-control": "no-store" },
            json: {
              ...entryContext,
              contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
          }),
        );
        await page.goto("/#qr=aaa.bbb.ccc");
        const title = page.locator("#entry-heading");
        await expect(title).toHaveText(zh ? "加入这一桌" : "Join this table");
        await expect(
          page.getByText(zh ? "不是您的桌？请告诉店员。" : "Not your table? Tell staff."),
        ).toBeVisible();
        await expect(page.getByRole("main")).not.toContainText(zh ? "欢迎" : "Welcome to");
        const look = await style(page, "#entry-heading");
        expect(look.size).toBe("28px");
        expect(look.weight).toBe("600");
        // One visible title before "Need help?": the panel's own heading is for screen readers.
        const visible = await page
          .locator("main h2")
          .evaluateAll((headings) =>
            headings
              .filter((heading) => heading.getBoundingClientRect().width > 1)
              .map((heading) => heading.textContent),
          );
        expect(visible.slice(0, -1)).toEqual([zh ? "加入这一桌" : "Join this table"]);
        expect(await offScaleText(page)).toEqual([]);
        await page.screenshot({
          path: `test-results/b63-join-${zh ? "zh" : "en"}-${String(width)}.png`,
        });
      });

      test("F11: a closed store is a red dot and dark Closed now, then one hours line", async ({
        page,
      }) => {
        await page.route("**/bff/customer/entry", (route) =>
          route.fulfill({
            status: 409,
            headers: { "cache-control": "no-store" },
            json: {
              schemaVersion: 1,
              code: "entry_not_accepting",
              messageKey: "customer.entry.not_accepting",
              recovery: { action: "TryLaterOrAskStaff", storeSelection: "Hidden" },
              store: {
                storeDisplayName: "半糖奶茶 Half Sugar Tea (TEST)",
                operatingState: "Closed",
                todayHours: [
                  { startLocalTime: "11:00:00", endLocalTime: "23:00:00", endsNextDay: false },
                ],
                todayKind: null,
                nextOpening: { localDate: "2026-11-25", startLocalTime: "11:00:00" },
                localDate: "2026-11-25",
              },
            },
          }),
        );
        await page.goto("/#qr=aaa.bbb.ccc");
        const title = page.locator("#entry-heading");
        await expect(title).toHaveText(zh ? "现在已打烊" : "Closed now");
        await expect(page.locator(".bop-shell__header h1")).toHaveText(
          "半糖奶茶 Half Sugar Tea (TEST)",
        );
        const look = await style(page, "#entry-heading");
        expect(look.color).toBe(dark);
        expect(look.size).toBe("28px");
        const dot = await title.evaluate(
          (element) => getComputedStyle(element, "::before").backgroundColor,
        );
        expect(dot).toBe("rgb(214, 110, 106)");
        await expect(page.locator(".entry-state__next")).toHaveCount(1);
        await expect(page.getByRole("main")).not.toContainText(
          zh ? "现在不接单" : "isn’t taking orders",
        );
        await page.screenshot({
          path: `test-results/b63-closed-${zh ? "zh" : "en"}-${String(width)}.png`,
        });
      });
    });

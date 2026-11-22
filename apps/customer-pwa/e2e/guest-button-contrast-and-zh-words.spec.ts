import { expect, test, type Page } from "@playwright/test";
import { routeStorefrontReads, syntheticStoreProfile } from "./storefront-reads";

// Batch 49 (v15 b48 live):
// (1) guest-menu-during-checkout new finding 2: on /menu/search the Search button computed
//     rgb(255,255,255) on rgb(255,255,255), an empty box next to the field, because the shared
//     white-control rule outranked the submit rule. Every control on the main guest pages now
//     reads at WCAG AA (4.5:1, 3:1 for large text), checked from computed colours.
// Synthetic HTTP interception on the production PWA, in the shapes v15 answered (TM2 table guest,
// Lane Dessert and Half Sugar Tea pickup guests).
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a49-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const dish = "Beef noodles (TEST)";
const tableLabel = "G48 C (TEST)";
const json = (status: number, body: unknown) => ({
  status,
  headers: { "cache-control": "no-store", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

function menu(locale: string) {
  const at = new Date().toISOString();
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: id(40),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: publicStore,
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
      effectiveAt: at,
    },
    menu: {
      menuReference: id(41),
      menuVersionReference: id(42),
      releaseReference: id(43),
      locale,
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(44),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(3),
              productVersionReference: id(45),
              name: dish,
              description: null,
              photo: null,
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {
                registryVersionReference: id(46),
                items: [],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: { status: "Available", amount: "12.50", currency: "CAD", reason: null },
              taxDisplayContext: {
                status: "Unavailable",
                taxInclusive: null,
                reason: "FINAL_QUOTE_REQUIRED",
              },
            },
          ],
        },
      ],
    },
  };
}

/** A seated TM2 guest at an open pay-later table with one served round and an empty cart. */
async function stubTableGuest(page: Page) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        csrfToken: "d".repeat(43),
        menuContext: {
          publicStoreReference: publicStore,
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
  await page.route(`**/api/v1/public/stores/${publicStore}/menu**`, (route) =>
    route.fulfill(
      json(200, menu(new URL(route.request().url()).searchParams.get("locale") ?? "en-CA")),
    ),
  );
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 2,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: tm2.brandDisplayName, storeName: tm2.storeDisplayName },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [],
          quote: null,
          warnings: [],
        },
      }),
    ),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        session: {
          tableLabel,
          orderNumber: "31",
          checkedAt: new Date().toISOString(),
          paymentTiming: "PayLater",
          rounds: [
            {
              roundNumber: 1,
              orderedBy: "You",
              submittedAt: new Date(Date.now() - 1_800_000).toISOString(),
              status: "Served",
              payment: "OnTableBill",
              cancelsAt: null,
              storeCancellationReason: null,
              items: [
                {
                  displayName: dish,
                  quantity: 2,
                  servedQuantity: 2,
                  cancelled: false,
                  lineTotal: money("2500"),
                },
              ],
              itemsTotal: money("2500"),
            },
          ],
          summary: {
            paid: money("0"),
            refunded: money("0"),
            refundPending: money("0"),
            due: money("2825"),
          },
        },
      }),
    ),
  );
}

/** A pickup guest arriving by the Store's QR code, as at Lane Dessert and Half Sugar Tea. */
async function enterPickup(page: Page, storeDisplayName: string) {
  await page.route("**/api/v1/customer/store", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "private, max-age=30" },
      json: {
        ...syntheticStoreProfile,
        store: { ...syntheticStoreProfile.store, storeDisplayName },
      },
    }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName,
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "h".repeat(43),
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
}

/**
 * Every enabled control and link on the page whose words fall below WCAG AA against what is
 * behind them: 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold). Colours are the computed
 * ones; a see-through background is laid over the first solid one behind it.
 */
async function lowContrastControls(page: Page) {
  // Colours are read once a control's fill has finished changing (Search fades in as it enables).
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))),
  );
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const parts = value.match(/[\d.]+/gu)?.map(Number) ?? [0, 0, 0, 0];
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length > 3 ? (parts[3] ?? 1) : 1];
    };
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ];
    const behind = (element: Element | null): Rgba => {
      if (element === null) return [255, 255, 255, 1];
      const colour = parse(getComputedStyle(element).backgroundColor);
      if (colour[3] >= 1) return colour;
      const under = behind(element.parentElement);
      return colour[3] === 0 ? under : over(colour, under);
    };
    const luminance = ([r, g, b]: Rgba) => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      "button, a[href], [role='button'], [role='link']",
    )) {
      if (element.matches(":disabled, [aria-disabled='true']")) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const words = (element.innerText ?? "").trim();
      if (words === "") continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const background = behind(element);
      const text = over(parse(style.color), background);
      const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
      const ratio = ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        found.push(
          `${element.tagName.toLowerCase()}.${element.className || "-"} "${words.slice(0, 40)}" ${style.color} on rgb(${background.slice(0, 3).map(Math.round).join(",")}) ${ratio.toFixed(2)}:1`,
        );
    }
    return found;
  });
}

async function chooseChinese(page: Page) {
  const button = page.getByRole("button", { name: "切换到中文" });
  if ((await button.count()) > 0) await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", /^zh/u);
}

for (const width of [390, 1440])
  for (const zh of [false, true])
    test.describe(`@production batch 49 guest controls and Chinese words (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({
        viewport: { width, height: 844 },
        hasTouch: width < 768,
        isMobile: width < 768,
        locale: zh ? "zh-CN" : "en-CA",
      });

      test("the Search button reads clearly, keeps its focus ring and 44 px target", async ({
        page,
      }) => {
        await stubTableGuest(page);
        await page.goto("/menu/search");
        if (zh) await chooseChinese(page);
        const search = page.getByRole("search");
        await expect(search).toBeVisible();
        const submit = search.locator("button[type='submit']");
        const colours = () =>
          submit.evaluate((element) => {
            const style = getComputedStyle(element);
            return { color: style.color, background: style.backgroundColor };
          });
        // With nothing typed it is plainly unavailable: grey words, still readable.
        await expect(submit).toBeDisabled();
        const idle = await colours();
        expect(idle.color).not.toBe(idle.background);
        await page.getByLabel(zh ? "搜索菜单" : "Search the menu").fill("Beef");
        await expect(submit).toBeEnabled();
        await expect(submit).toHaveText(zh ? "搜索" : "Search");
        expect(await lowContrastControls(page)).toEqual([]);
        // Filled like the other primary actions (Add to cart, Place order): light words on dark.
        const look = await colours();
        expect(look.color).not.toBe(look.background);
        expect(look.background).not.toBe("rgb(255, 255, 255)");
        expect((await submit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        await submit.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await submit.evaluate((element) => {
          const style = getComputedStyle(element);
          return element.matches(":focus-visible") && style.outlineStyle !== "none"
            ? Number.parseFloat(style.outlineWidth)
            : 0;
        });
        expect(ring).toBeGreaterThanOrEqual(2);
        await submit.click();
        await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
        expect(await lowContrastControls(page)).toEqual([]);
        await page.screenshot({
          path: `test-results/b49-search-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
      });

      test("every control on the main guest pages reads at WCAG AA", async ({ page }) => {
        const low: string[] = [];
        await stubTableGuest(page);
        for (const [path, ready] of [
          ["/menu", dish],
          [`/menu/items/${id(3)}`, dish],
          ["/cart", zh ? "购物车" : "Cart"],
          ["/dine-in/session", dish],
        ] as const) {
          await page.goto(path);
          if (zh) await chooseChinese(page);
          await expect(page.getByRole("main").getByText(ready).first()).toBeVisible();
          await page.waitForLoadState("networkidle");
          low.push(...(await lowContrastControls(page)).map((line) => `${path}: ${line}`));
        }
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await routeStorefrontReads(page);
        await enterPickup(page, "巷口糖水 Lane Dessert (TEST)");
        if (zh) await chooseChinese(page);
        await expect(page.locator(".entry-context").first()).toBeVisible();
        low.push(...(await lowContrastControls(page)).map((line) => `entry: ${line}`));
        expect(low).toEqual([]);
      });
    });

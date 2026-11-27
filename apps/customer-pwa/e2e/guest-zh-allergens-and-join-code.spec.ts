import { expect, test, type Page } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

test.beforeEach(({ context }) => routeStorefrontReads(context));
// Codes are typed on screen; keep no traces or failure screenshots.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

const ref = (n: number) => `018f7647-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const noStore = { "cache-control": "no-store" };
const widths = [
  [390, 844],
  [1440, 900],
] as const;
const chinese = (page: Page) =>
  page.addInitScript(() => localStorage.setItem("bop.customer.language", "zh-Hans"));
const noOverflow = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);

/**
 * WP-2423 batch 47 (v15 batch 46 live, TM2 menu): a dish's allergen line is a Chinese phrase
 * joined to a Chinese list, so it reads "含有花生、芝麻、大豆、小麦和黑小麦" and "可能含有芝麻", not
 * "含有 花生、…" as live. The allergens come as the Store's registry sends them (English names and
 * codes), named in Chinese on the guest's phone.
 */
function tm2Menu(locale: string) {
  const at = "2026-11-22T12:00:00.000Z";
  const allergen = (n: number, code: string, name: string, classification: string) => ({
    allergenReference: ref(60 + n),
    code,
    name,
    classification,
  });
  const dish = (n: number, name: string, items: unknown[], amount: string) => ({
    sellableReference: ref(n),
    productVersionReference: ref(n + 1),
    name,
    description: null,
    photo: null,
    presentationRole: "Standard",
    pinned: false,
    availability: "Available",
    optionRules: [],
    allergenDisclosure: {
      registryVersionReference: ref(59),
      items,
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
    },
    displayPrice: { status: "Available", amount, currency: "CAD", reason: null },
    taxDisplayContext: {
      status: "Unavailable",
      taxInclusive: null,
      reason: "FINAL_QUOTE_REQUIRED",
    },
  });
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: ref(2),
      sourceAggregateVersion: 1,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: ref(1),
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "PICKUP",
      effectiveAt: at,
    },
    menu: {
      menuReference: ref(3),
      menuVersionReference: ref(4),
      releaseReference: ref(5),
      locale,
      name: "Synthetic menu",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: ref(6),
          name: "Noodles",
          sellables: [
            dish(
              10,
              "Dan dan noodles",
              [
                allergen(1, "PEANUT", "Peanuts", "Contains"),
                allergen(2, "SESAME", "Sesame", "Contains"),
                allergen(3, "SOY", "Soy", "Contains"),
                allergen(4, "WHEAT_TRITICALE", "Wheat and triticale", "Contains"),
              ],
              "13.50",
            ),
            dish(
              20,
              "Smashed cucumber",
              [allergen(2, "SESAME", "Sesame", "CrossContactPossible")],
              "6.25",
            ),
          ],
        },
      ],
    },
  };
}

async function menuRoutes(page: Page) {
  await page.context().route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      status: 200,
      headers: noStore,
      json: {
        schemaVersion: 1,
        csrfToken: "a".repeat(43),
        menuContext: {
          publicStoreReference: ref(1),
          channel: "Pickup",
          locale: "en-CA",
          brandDisplayName: "Synthetic brand",
          storeDisplayName: "Synthetic Store",
        },
      },
    }),
  );
  await page.context().route(`**/api/v1/public/stores/${ref(1)}/menu**`, (route) =>
    // The menu in the locale the phone asked for, as the server answers it.
    route.fulfill({
      status: 200,
      headers: noStore,
      json: tm2Menu(new URL(route.request().url()).searchParams.get("locale") ?? "en-CA"),
    }),
  );
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of widths)
    test(`@production WP-2423 batch 47: a dish's allergen line reads as one phrase (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      if (zh) await chinese(page);
      await page.setViewportSize({ width, height });
      await menuRoutes(page);
      await page.goto("/menu");
      const main = page.getByRole("main");
      const contains = zh
        ? "含有花生、芝麻、大豆、小麦和黑小麦"
        : "Contains peanuts, sesame, soy, wheat and triticale";
      const may = zh ? "可能含有芝麻" : "May contain sesame";
      await expect(main.getByText(contains, { exact: true })).toBeVisible();
      await expect(main.getByText(may, { exact: true })).toBeVisible();
      if (zh) await expect(main).not.toContainText(/含有 /u);
      for (const text of [contains, may]) {
        // The words themselves, not their block, keep the page's side margins.
        const [left, right] = await main.getByText(text, { exact: true }).evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          return [box.left, box.right];
        });
        expect(left).toBeGreaterThanOrEqual(15);
        expect(right).toBeLessThanOrEqual(width - 15);
      }
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/b47-allergen-line-${language}-${width}.png`,
        fullPage: true,
      });
    });

/**
 * WP-2423 batch 47 (v15 batch 46 live, join-code-unique): a guest typing a code staff replaced, or
 * a wrong one, was told "这个代码无效。请检查后重试…" ("Check it and try again"), though every other
 * guest and staff text calls it 入桌码 and the code can never work again. Both get one answer (the
 * server does not say which it was): ask staff, or the person who joined first, for the table's
 * current join code.
 */
for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of widths)
    test(`@production WP-2423 batch 47: a replaced or wrong join code is told to ask for the table's current code (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      if (zh) await chinese(page);
      await page.setViewportSize({ width, height });
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await page.route("**/bff/customer/entry", (route) =>
        route.fulfill({
          status: 201,
          headers: noStore,
          json: {
            schemaVersion: 2,
            status: "Established",
            brandDisplayName: "Synthetic Brand",
            storeDisplayName: "Synthetic Dining Store",
            publicStoreReference: ref(6),
            publicTableReference: ref(7),
            channel: "DineIn",
            operatingState: "Open",
            availableServiceModes: ["DineIn"],
            locale: "en-CA",
            contextExpiresAt: expiresAt,
            csrfToken: "g".repeat(43),
          },
        }),
      );
      const tried: string[] = [];
      // As the server answers both a code staff replaced and one that never existed.
      await page.route("**/bff/customer/dining/join", (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}") as { joinCredential?: string };
        tried.push(body.joinCredential ?? "");
        return route.fulfill({
          status: 409,
          headers: noStore,
          json: {
            error: {
              code: "dining_join_code_not_accepted",
              messageKey: "customer.dining.join_code_not_accepted",
            },
          },
        });
      });
      await page.goto("/#qr=aaa.bbb.ccc");
      await page.getByRole("button", { name: zh ? "我有入桌码" : "I have a join code" }).click();
      const field = page.getByLabel(zh ? "入桌码或邀请码" : "Join code or invitation", {
        exact: true,
      });
      const join = page.getByRole("button", {
        name: zh ? "用入桌码加入" : "Join with this code",
        exact: true,
      });
      const answer = zh
        ? "这个入桌码现在不能加入这一桌。请向店员或同桌先加入的人要这桌现在的入桌码。"
        : "That join code doesn’t work for this table now. Ask staff, or the person who joined your table first, for the table’s current join code.";
      const alerts: string[] = [];
      for (const code of ["482913", "000000"]) {
        await field.fill(code);
        await join.click();
        const alert = page.getByRole("alert");
        await expect(alert).toHaveText(answer);
        alerts.push(await alert.innerText());
      }
      // The same words for the replaced code and the wrong one, and never "check it and retry".
      expect(alerts[0]).toBe(alerts[1]);
      expect(tried).toEqual(["482913", "000000"]);
      await expect(
        page.getByText(zh ? /代码无效|检查后重试/u : /Check it and try again/u),
      ).toHaveCount(0);
      if (zh) await expect(page.getByRole("main")).not.toContainText("代码");
      const [left, right] = await page.getByRole("alert").evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        return [box.left, box.right];
      });
      expect(left).toBeGreaterThanOrEqual(15);
      expect(right).toBeLessThanOrEqual(width - 15);
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/b47-join-code-refusal-${language}-${width}.png`,
        fullPage: true,
      });
    });

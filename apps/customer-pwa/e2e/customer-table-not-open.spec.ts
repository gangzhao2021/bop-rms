import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Coordinator 2026-10-30: a phone scanning a table no party is seated at (free, or waiting for
// cleaning) is told so before joining, can browse the menu, and adding a dish says it can order
// once staff seat it, never "session expired". Synthetic owner answers on the production PWA; the
// server side (the table state read under the pilot API role) is proven by the database
// acceptance test (public store profile: dining entry).
test.beforeEach(({ context }) => routeStorefrontReads(context));
const cartWrites: string[] = [];
const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function scanNotOpenTable(
  page: Page,
  entries: string[] = [],
  tableLabel?: string,
  /** Batch 42: staff open the table once this says so (the waiting checks and the entry follow). */
  isOpen?: () => boolean,
) {
  const at = new Date().toISOString();
  if (isOpen !== undefined)
    await page.route("**/bff/customer/entry/table-wait", (route) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { schemaVersion: 1, status: isOpen() ? "Changed" : "Waiting" },
      }),
    );
  // No party is seated: the scan starts no visit (no cookie) and gives the menu's public context.
  await page.route("**/bff/customer/entry", (route) => {
    entries.push(route.request().url());
    if (isOpen?.() === true)
      return route.fulfill({
        status: 201,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 2,
          status: "Established",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Noodle Bar",
          publicStoreReference: id(4),
          publicTableReference: id(0x71),
          channel: "DineIn",
          operatingState: "Open",
          availableServiceModes: ["DineIn"],
          locale: "en-CA",
          contextExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          csrfToken: "N".repeat(43),
        },
      });
    return route.fulfill({
      status: 409,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        code: "entry_table_not_open",
        messageKey: "customer.entry.table_not_open",
        recovery: { action: "AskStaff", storeSelection: "Hidden" },
        store: {
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: "Synthetic Noodle Bar",
          publicStoreReference: id(4),
          locale: "en-CA",
        },
        ...(tableLabel === undefined ? {} : { table: { label: tableLabel } }),
      },
    });
  });
  // The menu in the language asked for (batch 44: a guest who switched to 中文 reads it too).
  await page.route("**/api/v1/public/stores/*/menu?*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        status: "Found",
        schemaVersion: 1,
        projection: {
          name: "catalog_published_menu_v1",
          version: 1,
          asOfUtc: at,
          sourceCheckpoint: id(6),
          sourceAggregateVersion: 1,
          freshnessStatus: "Fresh",
          freshnessTargetMilliseconds: 5000,
          stale: false,
          partial: true,
        },
        scope: {
          publicStoreReference: id(4),
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "DINE_IN",
          effectiveAt: at,
        },
        menu: {
          menuReference: id(7),
          menuVersionReference: id(8),
          releaseReference: id(9),
          locale: new URL(route.request().url()).searchParams.get("locale") ?? "en-CA",
          name: "Synthetic menu",
          effectiveFrom: at,
          effectiveUntil: null,
          sections: [
            {
              sectionReference: id(10),
              name: "Drinks",
              sellables: [
                {
                  sellableReference: id(3),
                  productVersionReference: id(11),
                  name: "Synthetic tea",
                  description: null,
                  photo: null,
                  presentationRole: "Standard",
                  pinned: false,
                  availability: "Available",
                  optionRules: [],
                  allergenDisclosure: {
                    registryVersionReference: id(12),
                    items: [],
                    allergenFreeClaim: false,
                    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                  },
                  displayPrice: {
                    status: "Available",
                    amount: "4.50",
                    currency: "CAD",
                    reason: null,
                  },
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
      },
    }),
  );
  // The scan started no visit, so the Store answers the cart read as it answers any phone without
  // a guest cookie (customer-cart.ts: 401 cart_session_expired).
  await page.route("**/bff/customer/cart", (route) =>
    route.fulfill({
      status: 401,
      headers: { "cache-control": "no-store" },
      json: { error: { code: "cart_session_expired" } },
    }),
  );
  // Without a visit nothing is sent to a cart; the page says why (recorded to prove it).
  await page.route("**/api/v1/carts**", (route) => {
    cartWrites.push(route.request().method());
    return route.abort();
  });
  await page.goto("/#qr=aaa.bbb.ccc");
}

test.describe("@production CUST-ENTRY table not open", () => {
  test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

  test("says the table isn't open yet, keeps the menu, and explains ordering waits for seating", async ({
    page,
  }) => {
    await scanNotOpenTable(page);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: /^This table at .+ isn’t open yet$/u }),
    ).toBeVisible();
    // M02: the page continues by itself once staff open the table (entry-stays-at-store.spec).
    await expect(main).toContainText(
      "Ask staff to seat you. This page goes on by itself a few seconds after staff open the table.",
    );
    await expect(main).not.toContainText("Ready to order");
    await expect(main).not.toContainText("is confirmed for dine-in");
    await expect(main.getByRole("button", { name: "Join this table" })).toHaveCount(0);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-table-not-open-390.png", fullPage: true });

    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(main.getByRole("heading", { name: "这桌还没开台" })).toBeVisible();
    await expect(main).toContainText("请让店员带位。店员开台后几秒内，这里会自动继续。");
    await page.screenshot({
      path: "test-results/customer-table-not-open-zh-390.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "English" }).click();

    // Browsing the menu works; adding a dish explains why it can't be ordered yet.
    await main.getByRole("button", { name: "Look at the menu first" }).click();
    await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    // Batch 42: the start page waits for staff, so the guest isn't asked to scan again.
    await expect(page.getByRole("alert")).toContainText(
      "This table isn’t open yet. You can order once staff open it.",
    );
    await expect(page.getByText("Session expired")).toHaveCount(0);
    expect(cartWrites).toEqual([]);
    await expect(page.getByText("Scan the location QR code again")).toHaveCount(0);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-not-seated-add-390.png", fullPage: true });
  });

  // WP-2423 guest-table-open-and-busy-reads: a code card left on the wrong table shows at once.
  for (const width of [390, 1024, 1440])
    test(`names the table the code is for, and what to do if it isn't the guest's own (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await scanNotOpenTable(page, [], "PH 1 (TEST)");
      const main = page.getByRole("main");
      await expect(
        main.getByRole("heading", { name: "PH 1 (TEST) at Synthetic Noodle Bar isn’t open yet" }),
      ).toBeVisible();
      await expect(main).toContainText(
        "Not sitting at PH 1 (TEST)? Tell staff, so they can give you the code for your table.",
      );
      await expectNoInternalText(page);
      await page.screenshot({
        path: `test-results/customer-table-not-open-named-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "切换到中文" }).click();
      await expect(
        main.getByRole("heading", { name: "Synthetic Noodle Bar 的 PH 1 (TEST) 还没开台" }),
      ).toBeVisible();
      await expect(main).toContainText("您坐的不是 PH 1 (TEST)？请告诉店员，换成您这桌的二维码。");
      await page.screenshot({
        path: `test-results/customer-table-not-open-named-zh-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "English" }).click();
    });

  // Batch 41 (v15 b40 live, a-wait-*.png): after scanning the table's code the header read "Start
  // your order / Scan the location QR code to begin" above "isn't open yet". The header is the
  // Store's, as on every other table page, and the waiting heading is the page's own.
  for (const width of [390, 1440])
    test(`a guest waiting for staff to open the table sees the Store's header, not "scan" (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await scanNotOpenTable(page, [], "L40J B (TEST)");
      const banner = page.getByRole("banner");
      const main = page.getByRole("main");
      const check = async (language: "en" | "zh-Hans") => {
        const zh = language === "zh-Hans";
        await expect(
          main.getByRole("heading", {
            name: zh
              ? "Synthetic Noodle Bar 的 L40J B (TEST) 还没开台"
              : "L40J B (TEST) at Synthetic Noodle Bar isn’t open yet",
          }),
        ).toBeVisible();
        await expect(banner.getByRole("heading", { level: 1 })).toHaveText("Synthetic Noodle Bar");
        await expect(banner).toContainText(
          zh ? "Synthetic Brand · 堂食" : "Synthetic Brand · Dine in",
        );
        await expect(
          page.getByText(zh ? "扫描门店二维码开始点单" : "Scan the location QR code to begin"),
        ).toHaveCount(0);
        await expect(
          page.getByText(zh ? "开始点单" : "Start your order", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("navigation").getByRole("link", { name: zh ? "本桌" : "Your table" }),
        ).toBeVisible();
        // Linux CI fonts (DejaVu) are wider than macOS's: the header must still fit the phone.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/customer-table-waiting-header-${language}-${width}.png`,
          fullPage: true,
        });
      };
      await check("en");
      await page.getByRole("button", { name: "切换到中文" }).click();
      await check("zh-Hans");
      await page.getByRole("button", { name: "English" }).click();
    });

  // Batch 42 (v15 b41 live, a-yourtable-before-open-en-390.png): on a table staff had not opened,
  // the "Your table" tab told the guest to ask for a join code nobody hands out. Every tab says the
  // table isn't open yet and staff open it, offers the way back to the waiting page, and the table
  // page goes on by itself once staff open the table.
  for (const width of [390, 1440])
    test(`every tab of a table not open yet says staff open it, and goes on once they do (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      let open = false;
      const entries: string[] = [];
      await scanNotOpenTable(page, entries, "L42 A (TEST)", () => open);
      const main = page.getByRole("main");
      const nav = page.getByRole("navigation", { name: /^(Customer journey|点单步骤)$/u });
      const fits = async () => {
        // Linux CI fonts (DejaVu) are wider than macOS's: nothing scrolls sideways.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      };
      // The way back is on the first screen, with room to spare for Linux CI's wider DejaVu fonts
      // (batch 40 CI: about 40 px).
      const backOnFirstScreen = async (name: string) => {
        const box = await main.getByRole("link", { name }).boundingBox();
        expect(box).not.toBeNull();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900 - 40);
        // Batch 63 (F14): on the page's own edges (the card's 15 px inset is gone): it ends at
        // the page gutter (4vw at 390, at least 15 px).
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
      };
      const check = async (language: "en" | "zh-Hans") => {
        const zh = language === "zh-Hans";
        const heading = zh
          ? "Synthetic Noodle Bar 的 L42 A (TEST) 还没开台"
          : "L42 A (TEST) at Synthetic Noodle Bar isn’t open yet";
        const waits = zh
          ? "请让店员带位。店员开台后几秒内，这里会自动继续。"
          : "Ask staff to seat you. This page goes on by itself a few seconds after staff open the table.";
        const back = zh ? "回到等候开台页" : "Back to the waiting page";
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        // The shared frame speaks the guest's language too (its skip link was English in zh).
        await expect(page.locator('a[href="#main-content"]')).toHaveText(
          zh ? "跳到主要内容" : "Skip to main content",
        );

        // Your table: the waiting page's words, never a join code.
        await nav.getByRole("link", { name: zh ? "本桌" : "Your table" }).click();
        await expect(page).toHaveURL(/\/dine-in\/session$/u);
        await expect(
          main.getByRole("heading", {
            level: 2,
            name: zh ? "本桌" : "Your table",
            exact: true,
          }),
        ).toBeVisible();
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        await expect(main).toContainText(waits);
        await expect(main).not.toContainText(zh ? "入桌码" : "join code");
        await expect(main).not.toContainText(zh ? "请先加入本桌" : "Join your table first");
        await expect(main.getByRole("link", { name: back })).toBeVisible();
        await backOnFirstScreen(back);
        await fits();
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b42-yourtable-before-open-${language}-${width}.png`,
          fullPage: true,
        });

        // Cart: the same, and nothing is sent to a cart.
        await nav.getByRole("link", { name: zh ? "购物车" : "Cart" }).click();
        await expect(page).toHaveURL(/\/cart$/u);
        await expect(
          main.getByRole("heading", {
            level: 2,
            name: zh ? "您的购物车" : "Your cart",
            exact: true,
          }),
        ).toBeVisible();
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        await expect(main).toContainText(waits);
        await expect(main).not.toContainText(zh ? "再扫" : "scan again");
        await expect(main.getByRole("link", { name: back })).toBeVisible();
        await backOnFirstScreen(back);
        await fits();
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b42-cart-before-open-${language}-${width}.png`,
          fullPage: true,
        });

        // Back to the waiting page from here too.
        await main.getByRole("link", { name: back }).click();
        await expect(page).toHaveURL(/\/$/u);
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        if (zh) return;
        // Menu (this synthetic menu is English only): the guest looks around; adding a dish says
        // the same and offers the way back.
        await main.getByRole("button", { name: "Look at the menu first" }).click();
        await page.getByRole("link", { name: "View Synthetic tea", exact: true }).click();
        await page.getByRole("button", { name: "Add to cart", exact: true }).click();
        const alert = page.getByRole("alert");
        await expect(alert).toContainText(
          "This table isn’t open yet. You can order once staff open it.",
        );
        await expect(alert).not.toContainText("scan again");
        await fits();
        await page.screenshot({
          path: `test-results/b42-menu-add-before-open-${language}-${width}.png`,
          fullPage: true,
        });
        await alert.getByRole("link", { name: back }).click();
        await expect(page).toHaveURL(/\/$/u);
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
      };
      await check("en");
      await page.getByRole("button", { name: "切换到中文" }).click();
      await check("zh-Hans");
      expect(cartWrites).toEqual([]);

      // Staff open the table while the guest is on "Your table": the page goes on by itself.
      await nav.getByRole("link", { name: "本桌" }).click();
      await expect(main).toContainText("店员开台后几秒内，这里会自动继续。");
      open = true;
      // The table page checks every 3 s (the start page's schedule), so it goes on within that.
      await expect(page).toHaveURL(/\/$/u, { timeout: 10_000 });
      // Batch 63 (F11): the join names the table the guest waited at.
      await expect(main.locator("#entry-heading")).toHaveText("加入 L42 A (TEST)");
      await expect(main).not.toContainText("还没开台");
      await page.getByRole("button", { name: "English" }).click();
    });

  // Batch 43 (v15 b42 verify, v-reload-yourtable-en-390.png / v-reload-cart-zh-390.png): a reload
  // (or iOS discarding the tab in the background) on Your table or Cart while the table wasn't open
  // lost the wait: Your table asked for a join code with "Go to the start", the header said "Scan
  // the location QR code to begin", Cart was empty, and neither moved on when staff opened the
  // table. The wait (no code or token) is kept in this tab, and checks with the scan's cookie.
  for (const width of [390, 1440])
    test(`a reload on Your table or Cart keeps waiting for staff, and goes on once they open it (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      let open = false;
      const entries: string[] = [];
      const waits: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/bff/customer/entry/table-wait"))
          waits.push(request.postData() ?? "");
      });
      await scanNotOpenTable(page, entries, "L43 A (TEST)", () => open);
      const main = page.getByRole("main");
      const banner = page.getByRole("banner");
      const nav = page.getByRole("navigation", { name: /^(Customer journey|点单步骤)$/u });
      const check = async (language: "en" | "zh-Hans", tab: "table" | "cart") => {
        const zh = language === "zh-Hans";
        const heading = zh
          ? "Synthetic Noodle Bar 的 L43 A (TEST) 还没开台"
          : "L43 A (TEST) at Synthetic Noodle Bar isn’t open yet";
        const back = zh ? "回到等候开台页" : "Back to the waiting page";
        await nav
          .getByRole("link", {
            name: tab === "table" ? (zh ? "本桌" : "Your table") : zh ? "购物车" : "Cart",
          })
          .click();
        await expect(page).toHaveURL(tab === "table" ? /\/dine-in\/session$/u : /\/cart$/u);
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        await page.reload();
        await expect(main.getByRole("heading", { name: heading })).toBeVisible();
        await expect(main).toContainText(
          zh
            ? "请让店员带位。店员开台后几秒内，这里会自动继续。"
            : "Ask staff to seat you. This page goes on by itself a few seconds after staff open the table.",
        );
        // The Store's header, as before the reload.
        await expect(banner.getByRole("heading", { level: 1 })).toHaveText("Synthetic Noodle Bar");
        await expect(banner).toContainText(
          zh ? "Synthetic Brand · 堂食" : "Synthetic Brand · Dine in",
        );
        await expect(
          page.getByText(zh ? "扫描门店二维码开始点单" : "Scan the location QR code to begin"),
        ).toHaveCount(0);
        await expect(main).not.toContainText(zh ? "入桌码" : "join code");
        await expect(main).not.toContainText(zh ? "请先加入本桌" : "Join your table first");
        await expect(main).not.toContainText(zh ? "购物车是空的" : "Your cart is empty");
        await expect(main).not.toContainText(zh ? "再扫" : "scan again");
        await expect(
          main.getByRole("link", { name: zh ? "回到首页" : "Go to the start" }),
        ).toHaveCount(0);
        const link = main.getByRole("link", { name: back });
        await expect(link).toBeVisible();
        // On the first screen with room for Linux CI's wider DejaVu fonts (batch 40 CI: ~40 px).
        const box = await link.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900 - 40);
        // Batch 63 (F14): on the page's own edges (the card's 15 px inset is gone): it ends at
        // the page gutter (4vw at 390, at least 15 px).
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b43-reload-${tab}-${language}-${width}.png`,
          fullPage: true,
        });
      };
      // Nothing secret is kept in the tab: not the table's code, nor any visit token.
      const stored = () =>
        page.evaluate(() =>
          JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }),
        );
      await expect(
        main.getByRole("heading", { name: "L43 A (TEST) at Synthetic Noodle Bar isn’t open yet" }),
      ).toBeVisible();
      await check("en", "table");
      await check("en", "cart");
      await page.getByRole("button", { name: "切换到中文" }).click();
      await check("zh-Hans", "table");
      await check("zh-Hans", "cart");
      expect(await stored()).not.toContain("aaa.bbb.ccc");
      expect(cartWrites).toEqual([]);
      waits.length = 0;

      // Staff open the table while the reloaded page waits: it goes on to the join by itself.
      if (width === 390) {
        await nav.getByRole("link", { name: "本桌" }).click();
        await page.reload();
        await expect(main).toContainText("店员开台后几秒内，这里会自动继续。");
      }
      open = true;
      await expect(page).toHaveURL(/\/$/u, { timeout: 10_000 });
      // Batch 63 (F11): the join names the table the guest waited at.
      await expect(main.locator("#entry-heading")).toHaveText("加入 L43 A (TEST)");
      await expect(main).not.toContainText("还没开台");
      // After a reload the check asks about this browser's waiting scan (its cookie), not a code.
      expect(waits.length).toBeGreaterThan(0);
      for (const body of waits) expect(body).toBe('{"resume":true}');
      expect(await stored()).not.toContain("N".repeat(43));
      expect(await stored()).not.toContain("L43 A (TEST)");

      // Joined: a reload keeps the Store's header (the visit gives it back), never the old wait.
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            csrfToken: "N".repeat(43),
            menuContext: {
              publicStoreReference: id(4),
              channel: "DineIn",
              locale: "en-CA",
              brandDisplayName: "Synthetic Brand",
              storeDisplayName: "Synthetic Noodle Bar",
            },
            visit: { publicTableReference: id(0x71), joined: true },
          },
        }),
      );
      await page.goto("/dine-in/session");
      await expect(banner.getByRole("heading", { level: 1 })).toHaveText("Synthetic Noodle Bar");
      await expect(banner).toContainText("Synthetic Brand · 堂食");
      await expect(main).not.toContainText("还没开台");
      await expect(main).not.toContainText("入桌码");
      await page.screenshot({
        path: `test-results/b43-reload-joined-zh-${width}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "English" }).click();
    });

  test("a guest whose table was just settled scans it again: thanked with the receipt, before and after", async ({
    page,
  }) => {
    // The scan starts no visit, so the ended visit (its cookie) stays: the restore says the
    // table was settled, the receipt is read with that visit's value, and a reload of the table
    // page still shows them.
    const order: string[] = [];
    await page.route("**/api/v1/customer/session/csrf", (route) => {
      order.push("restore");
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { schemaVersion: 1, settledTable: { tableLabel: "12", csrfToken: "e".repeat(43) } },
      });
    });
    await page.route("**/api/v1/dine-in/table-payment", (route) => {
      order.push("receipt");
      expect(route.request().headers()["x-csrf-token"]).toBe("e".repeat(43));
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          receipt: {
            tableLabel: "12",
            rounds: [
              {
                roundNumber: 1,
                fromTableLabel: null,
                items: [{ displayName: "Milk tea", subtotalMinor: "450", reduced: null }],
              },
            ],
            subtotalMinor: "450",
            taxMinor: "59",
            ordersTotalMinor: "509",
            tipMinor: "0",
            roundingMinor: "1",
            paidMinor: "510",
            split: false,
            payments: [{ partNumber: null, method: "Cash", totalMinor: "510" }],
          },
        },
      });
    });
    const entries: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/bff/customer/entry")) order.push("entry");
    });
    await scanNotOpenTable(page, entries);
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Thank you for dining with us." }),
    ).toBeVisible();
    await expect(main).toContainText("Your meal at table 12 has ended.");
    const receipt = main.getByRole("region", { name: "Receipt" });
    await expect(receipt).toContainText("Total paid$5.10");
    await expect(receipt).toContainText("Paid byCash");
    await expect(main).toContainText("New party? Ask staff to seat you, then scan again.");
    await expect(main).not.toContainText(/This table at .+ isn’t open yet/u);
    expect(order).toEqual(["restore", "entry", "receipt"]);
    await expectNoInternalText(page);
    await page.screenshot({ path: "test-results/customer-settled-rescan-390.png", fullPage: true });

    // After the scan, the table page (a fresh load) still thanks them with the receipt.
    await page.goto("/dine-in/session");
    await expect(
      main.getByRole("heading", { name: "Thank you for dining with us." }),
    ).toBeVisible();
    await expect(main.getByRole("region", { name: "Receipt" })).toContainText("Total paid$5.10");
    await expect(main).not.toContainText("Join your table first");
    expect(entries).toHaveLength(1);
  });

  // Batch 44 (v15 b43 verify, v-VQ-add-after-open-noreload-en-390.png): a guest waiting on a
  // dish page while the table wasn't open. Staff opened it, and Add still said "This table isn't
  // open yet" and sent nothing (the wait kept on the phone was never asked again); the menu never
  // moved on either. Add now asks first, and goes to the join, saying the dish wasn't added yet.
  for (const width of [390, 1440])
    for (const reload of [false, true])
      test(`Add on a dish asks again once staff open the table, and goes to the join (${width}${reload ? ", after a reload" : ""})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        let open = false;
        await scanNotOpenTable(page, [], "L44 A (TEST)", () => open);
        const main = page.getByRole("main");
        const zh = width === 1440;
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        await expect(
          main.getByRole("heading", {
            name: zh
              ? "Synthetic Noodle Bar 的 L44 A (TEST) 还没开台"
              : "L44 A (TEST) at Synthetic Noodle Bar isn’t open yet",
          }),
        ).toBeVisible();
        await main
          .getByRole("button", { name: zh ? "先看看菜单" : "Look at the menu first" })
          .click();
        await page
          .getByRole("link", {
            name: zh ? "查看 Synthetic tea" : "View Synthetic tea",
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/\/menu\/items\//u);
        if (reload) await page.reload();
        const add = page.getByRole("button", {
          name: zh ? "加入购物车" : "Add to cart",
          exact: true,
        });
        await add.click();
        await expect(page.getByRole("alert")).toContainText(
          zh
            ? "这桌还没开台。店员开台后就可以点单。"
            : "This table isn’t open yet. You can order once staff open it.",
        );
        // Staff open the table; the guest taps Add again at once (before the page's own check).
        open = true;
        await add.click();
        await expect(page).toHaveURL(/\/$/u, { timeout: 2_500 });
        // Batch 63 (F11): the join names the table the guest waited at.
        await expect(main.locator("#entry-heading")).toHaveText(
          zh ? "加入 L44 A (TEST)" : "Join L44 A (TEST)",
        );
        await expect(main.getByRole("status").filter({ hasText: "Synthetic tea" })).toHaveText(
          zh
            ? // Batch 45 (v15 b44 live): no Latin space after the dish name, as the other
              // "not added" notice writes it ("{name}还没加入购物车").
              "Synthetic tea 还没加进购物车。请先加入这一桌，再重新加一次。"
            : "Synthetic tea wasn’t added yet. Join this table, then add it again.",
        );
        await expect(main).not.toContainText(zh ? "还没开台" : "isn’t open yet");
        const join = main.getByRole("button", { name: zh ? "加入这一桌" : "Join this table" });
        await expect(join).toBeVisible();
        // On the first screen with room for Linux CI's wider DejaVu fonts (batch 40 CI: ~40 px).
        const box = await join.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900 - 40);
        // Batch 63 (F14): on the page's own edges (the card's 15 px inset is gone): it ends at
        // the page gutter (4vw at 390, at least 15 px).
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b44-add-after-open-${zh ? "zh" : "en"}-${width}${reload ? "-reload" : ""}.png`,
          fullPage: true,
        });
        expect(cartWrites).toEqual([]);
        if (zh) await page.getByRole("button", { name: "English" }).click();
      });

  // Batch 44: the menu (and a dish page) goes on by itself once staff open the table, as Your
  // table and Cart do; and the waiting Cart offers no "Refresh cart" (nothing to refresh).
  for (const width of [390, 1440])
    for (const reload of [false, true])
      test(`the menu goes on by itself once staff open the table; the waiting Cart has no refresh (${width}${reload ? ", after a reload" : ""})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        let open = false;
        await scanNotOpenTable(page, [], "L44 B (TEST)", () => open);
        const main = page.getByRole("main");
        const nav = page.getByRole("navigation", { name: /^(Customer journey|点单步骤)$/u });
        const zh = width === 390;
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        const back = zh ? "回到等候开台页" : "Back to the waiting page";
        // Cart while waiting: the wait and the way back, nothing to refresh.
        await nav.getByRole("link", { name: zh ? "购物车" : "Cart" }).click();
        await expect(page).toHaveURL(/\/cart$/u);
        if (reload) await page.reload();
        await expect(main.getByRole("link", { name: back })).toBeVisible();
        await expect(
          main.getByRole("button", { name: zh ? "刷新购物车" : "Refresh cart" }),
        ).toHaveCount(0);
        await expect(
          main.getByRole("link", { name: zh ? "返回菜单" : "Return to menu" }),
        ).toBeVisible();
        await page.screenshot({
          path: `test-results/b44-cart-waiting-${zh ? "zh" : "en"}-${width}${reload ? "-reload" : ""}.png`,
          fullPage: true,
        });
        // The menu, waiting: staff open the table and it goes on to the join by itself.
        await nav.getByRole("link", { name: zh ? "菜单" : "Menu" }).click();
        await expect(page).toHaveURL(/\/menu$/u);
        if (reload) await page.reload();
        await expect(
          page.getByRole("link", {
            name: zh ? "查看 Synthetic tea" : "View Synthetic tea",
            exact: true,
          }),
        ).toBeVisible();
        open = true;
        await expect(page).toHaveURL(/\/$/u, { timeout: 10_000 });
        // Batch 63 (F11): the join names the table the guest waited at.
        await expect(main.locator("#entry-heading")).toHaveText(
          zh ? "加入 L44 B (TEST)" : "Join L44 B (TEST)",
        );
        await expect(
          main.getByRole("button", { name: zh ? "加入这一桌" : "Join this table" }),
        ).toBeVisible();
        await expect(main).not.toContainText(zh ? "还没开台" : "isn’t open yet");
        expect(cartWrites).toEqual([]);
        if (zh) await page.getByRole("button", { name: "English" }).click();
      });

  // Batch 44 (v15 b43 live, h-ended-reload-header-en-390.png): after the table was paid, closed
  // and cleaned, a reload of Your table showed the header "Order / Scan the location QR code to
  // begin" over the ended meal, and told a new party only to scan. The Store's header is kept (the
  // restore names it) and the words match the start page's.
  for (const width of [390, 1440])
    test(`the ended meal's table page keeps the Store's header after a reload (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            settledTable: {
              tableLabel: "L44W A (TEST)",
              csrfToken: "e".repeat(43),
              store: {
                brandDisplayName: "Synthetic Brand",
                storeDisplayName: "Synthetic Noodle Bar",
              },
            },
          },
        }),
      );
      await page.route("**/api/v1/dine-in/table-payment", (route) =>
        route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            receipt: {
              tableLabel: "L44W A (TEST)",
              rounds: [
                {
                  roundNumber: 1,
                  fromTableLabel: null,
                  items: [
                    { displayName: "Beef noodles (TEST)", subtotalMinor: "1250", reduced: null },
                  ],
                },
              ],
              subtotalMinor: "1250",
              taxMinor: "163",
              ordersTotalMinor: "1413",
              tipMinor: "0",
              roundingMinor: "0",
              paidMinor: "1413",
              split: false,
              payments: [{ partNumber: null, method: "Online", totalMinor: "1413" }],
            },
          },
        }),
      );
      const main = page.getByRole("main");
      const banner = page.getByRole("banner");
      for (const zh of [false, true]) {
        await page.goto("/dine-in/session");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        await expect(
          main.getByRole("heading", { name: zh ? "谢谢光临" : "Thank you for dining with us." }),
        ).toBeVisible();
        await expect(main.getByRole("region", { name: zh ? "收据" : "Receipt" })).toContainText(
          "$14.13",
        );
        await expect(banner.getByRole("heading", { level: 1 })).toHaveText("Synthetic Noodle Bar");
        await expect(banner).toContainText(
          zh ? "Synthetic Brand · 堂食" : "Synthetic Brand · Dine in",
        );
        await expect(
          page.getByText(zh ? "扫描门店二维码开始点单" : "Scan the location QR code to begin"),
        ).toHaveCount(0);
        await expect(main).toContainText(
          zh
            ? "新的一桌？请让店员带位，开台后再扫一次码。"
            : "New party? Ask staff to seat you, then scan again.",
        );
        await page.reload();
        await expect(banner.getByRole("heading", { level: 1 })).toHaveText("Synthetic Noodle Bar");
        await expect(
          main.getByRole("heading", { name: zh ? "谢谢光临" : "Thank you for dining with us." }),
        ).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b44-ended-reload-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
        if (zh) await page.getByRole("button", { name: "English" }).click();
      }
    });

  // Batch 45 (v15 b44 live, guest-menu-wait-recheck v-d-V1-390-ended-reload.png): guests joined a
  // table, added a dish and removed it; staff pressed Close and Cleaned with nothing ordered. A
  // reload of Your table showed "Order / Scan the location QR code to begin" and "Join your table
  // first. Ask a staff member … for your table's join code". The restore now says the visit
  // ended with nothing ordered (and names the Store); a moved or merged party's page keeps the
  // Store's header too.
  const tm2 = {
    brandDisplayName: "Test Merchant 2 - not production",
    storeDisplayName: "Test Merchant 2 Main - not production",
  };
  for (const width of [390, 1440])
    for (const zh of [false, true])
      test(`a table closed with nothing ordered says the visit ended, after a reload (${zh ? "zh-Hans" : "en"} ${width})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const writes: string[] = [];
        page.on("request", (request) => {
          if (request.method() !== "GET") writes.push(new URL(request.url()).pathname);
        });
        await page.route("**/api/v1/customer/session/csrf", (route) =>
          route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, emptyTable: { tableLabel: "V44 A (TEST)", store: tm2 } },
          }),
        );
        const main = page.getByRole("main");
        const banner = page.getByRole("banner");
        await page.goto("/dine-in/session");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        for (const reload of [false, true]) {
          if (reload) await page.reload();
          const card = main.getByRole("status").filter({
            has: page.getByRole("heading", {
              name: zh ? "这桌的用餐已结束" : "This table’s visit has ended",
            }),
          });
          await expect(card).toBeVisible();
          await expect(card).toContainText(
            zh
              ? "V44 A (TEST) 没有点单，所以没有扣款。"
              : "Nothing was ordered at V44 A (TEST), so nothing was charged.",
          );
          await expect(card).toContainText(
            zh
              ? "新的一桌？请让店员带位，开台后再扫一次码。"
              : "New party? Ask staff to seat you, then scan again.",
          );
          await expect(banner.getByRole("heading", { level: 1 })).toHaveText(tm2.storeDisplayName);
          await expect(banner).toContainText(
            `${tm2.brandDisplayName} · ${zh ? "堂食" : "Dine in"}`,
          );
          await expect(
            page.getByText(zh ? "扫描门店二维码开始点单" : "Scan the location QR code to begin"),
          ).toHaveCount(0);
          await expect(main).not.toContainText(zh ? "入桌码" : "join code");
          await expect(main).not.toContainText(zh ? "请先加入本桌" : "Join your table first");
          await expect(main.getByRole("region", { name: zh ? "收据" : "Receipt" })).toHaveCount(0);
          // Laid out inside the phone with room to spare (Linux fonts run wider: about 40 px).
          const box = await card.boundingBox();
          expect(box).not.toBeNull();
          // Inside the 16 px gutter (a fraction of a pixel of rounding allowed).
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          const tight = await card.evaluate((element) =>
            [...element.querySelectorAll("h2, p")].some(
              (line) => line.scrollWidth > line.clientWidth,
            ),
          );
          expect(tight).toBe(false);
          await expectNoInternalText(page);
          await page.screenshot({
            path: `test-results/b45-empty-close-${zh ? "zh" : "en"}-${width}${reload ? "-reload" : ""}.png`,
            fullPage: true,
          });
        }
        // Nothing to order, pay or join with: the page wrote nothing.
        expect(writes).toEqual([]);
      });

  for (const width of [390, 1440])
    test(`a moved or merged party's table page keeps the Store's header (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      let merged = true;
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({
          status: 200,
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            movedTable: {
              tableLabel: "V44 B (TEST)",
              ...(merged ? { merged: true } : {}),
              store: tm2,
            },
          },
        }),
      );
      const main = page.getByRole("main");
      const banner = page.getByRole("banner");
      for (const zh of [false, true]) {
        merged = !zh;
        await page.goto("/dine-in/session");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        await page.reload();
        // Batch 46: a calm status, not an alert (nothing went wrong).
        await expect(main.getByRole("status").filter({ hasText: "V44 B (TEST)" })).toBeVisible();
        await expect(main.getByRole("alert")).toHaveCount(0);
        await expect(main).not.toContainText(zh ? "入桌码" : "join code");
        await expect(banner.getByRole("heading", { level: 1 })).toHaveText(tm2.storeDisplayName);
        await expect(banner).toContainText(`${tm2.brandDisplayName} · ${zh ? "堂食" : "Dine in"}`);
        await expect(
          page.getByText(zh ? "扫描门店二维码开始点单" : "Scan the location QR code to begin"),
        ).toHaveCount(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b45-moved-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });
        if (zh) await page.getByRole("button", { name: "English" }).click();
      }
    });
});

// Batch 46 (v15 b45 live, v-cart-after-close-G1-390.png and b-merged-G4-390.png): after staff
// closed a table where nothing was ordered, Your table showed the ended card with the Store, but
// Cart and Menu on the same phone fell back to "Order / Scan the location QR code to begin", a
// red-dot "Your visit on this phone has ended", a "Refresh cart" that cannot help, and "Your
// session ended". Every tab now gives the same calm answer with the Store's header. A merged
// party that ordered nothing is not told "everything your table ordered is on that table's bill"
// under a subtitle with no list, and a Chinese sentence spaces a Latin table name alike.
test.describe("@production CUST-DINE-IN after the table's visit ended", () => {
  test.use({ serviceWorkers: "block" });
  const tm2 = {
    brandDisplayName: "Test Merchant 2 - not production",
    storeDisplayName: "Test Merchant 2 Main - not production",
  };
  const tabs = [
    { path: "/menu", en: "Menu", zh: "菜单" },
    { path: `/menu/items/${id(3)}`, en: "Menu", zh: "菜单" },
    { path: "/cart", en: "Your cart", zh: "您的购物车" },
    { path: "/dine-in/session", en: "Your table", zh: "本桌" },
  ];
  async function expectCalmCard(page: Page, heading: string, width: number) {
    const main = page.getByRole("main");
    const card = main
      .getByRole("status")
      .filter({ has: page.getByRole("heading", { name: heading }) });
    await expect(card).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    // Inside the 16 px gutter, and on the first screen with room to spare (Linux fonts run wider).
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const tight = await card.evaluate((element) =>
      [...element.querySelectorAll("h2, p, a")].some((line) => line.scrollWidth > line.clientWidth),
    );
    expect(tight).toBe(false);
    await expectNoInternalText(page);
    return card;
  }
  async function expectStoreHeader(page: Page, zh: boolean) {
    const banner = page.getByRole("banner");
    await expect(banner.getByRole("heading", { level: 1 })).toHaveText(tm2.storeDisplayName);
    await expect(banner).toContainText(`${tm2.brandDisplayName} · ${zh ? "堂食" : "Dine in"}`);
    for (const wrong of zh
      ? ["扫描门店二维码", "您在这部手机上的用餐已结束", "刷新购物车", "会话", "入桌码"]
      : [
          "Scan the location QR code",
          "Your visit on this phone has ended",
          "Refresh cart",
          "session",
          "join code",
        ])
      await expect(page.getByText(wrong)).toHaveCount(0);
  }

  for (const width of [390, 1440])
    for (const zh of [false, true])
      test(`every tab after a table closed with nothing ordered says the visit ended (${zh ? "zh-Hans" : "en"} ${width})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        const asked: string[] = [];
        page.on("request", (request) => {
          const path = new URL(request.url()).pathname;
          if (
            request.method() !== "GET" ||
            /^\/(api|bff)\/.*\/(cart|carts|entry|dine-in)(\/|$)/u.test(path)
          )
            asked.push(`${request.method()} ${path}`);
        });
        await page.route("**/api/v1/customer/session/csrf", (route) =>
          route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, emptyTable: { tableLabel: "E45 A (TEST)", store: tm2 } },
          }),
        );
        await page.goto("/dine-in/session");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        for (const tab of tabs)
          for (const reload of [false, true]) {
            if (reload) await page.reload();
            else await page.goto(tab.path);
            await expect(
              page
                .getByRole("main")
                .getByRole("heading", { name: zh ? tab.zh : tab.en, exact: true }),
            ).toBeVisible();
            const card = await expectCalmCard(
              page,
              zh ? "这桌的用餐已结束" : "This table’s visit has ended",
              width,
            );
            await expect(card).toContainText(
              zh
                ? "E45 A (TEST) 没有点单，所以没有扣款。"
                : "Nothing was ordered at E45 A (TEST), so nothing was charged.",
            );
            await expect(card).toContainText(
              zh
                ? "新的一桌？请让店员带位，开台后再扫一次码。"
                : "New party? Ask staff to seat you, then scan again.",
            );
            // Nothing that cannot help: no buttons at all on the card.
            await expect(card.getByRole("button")).toHaveCount(0);
            await expectStoreHeader(page, zh);
            await page.screenshot({
              path: `test-results/b46-empty-${tab.path.split("/")[1]}-${zh ? "zh" : "en"}-${width}${reload ? "-reload" : ""}.png`,
              fullPage: true,
            });
          }
        // Nothing was read or written for a cart, a join or a visit the phone no longer has.
        expect(asked).toEqual([]);
      });

  for (const width of [390, 1440])
    for (const zh of [false, true])
      test(`a merged party that ordered nothing reads where to go, with one spacing rule (${zh ? "zh-Hans" : "en"} ${width})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.route("**/api/v1/customer/session/csrf", (route) =>
          route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: {
              schemaVersion: 1,
              movedTable: {
                tableLabel: "E45 A (TEST)",
                merged: true,
                nothingOrdered: true,
                store: tm2,
              },
            },
          }),
        );
        await page.goto("/dine-in/session");
        if (zh) await page.getByRole("button", { name: "切换到中文" }).click();
        for (const path of ["/dine-in/session", "/cart", "/menu"]) {
          await page.goto(path);
          const card = await expectCalmCard(
            page,
            zh ? "您这桌已并到 E45 A (TEST)" : "Your table was merged into E45 A (TEST)",
            width,
          );
          await expect(card).toHaveText(
            zh
              ? "您这桌已并到 E45 A (TEST)店员已把您并到 E45 A (TEST)。请扫 E45 A (TEST) 的桌台二维码继续点餐和一起付款。"
              : "Your table was merged into E45 A (TEST)Staff joined your party to E45 A (TEST). Scan the code on E45 A (TEST) to keep ordering and paying together.",
          );
          const main = page.getByRole("main");
          // No subtitle over a list that isn't there, and no bill line when nothing was ordered.
          await expect(main).not.toContainText(
            zh ? "您和同桌其他客人在这桌点的所有东西" : "Everything ordered at this table",
          );
          await expect(main).not.toContainText(zh ? "账单上" : "on that table's bill");
          await expectStoreHeader(page, zh);
          await page.screenshot({
            path: `test-results/b46-merged-${path.split("/")[1]}-${zh ? "zh" : "en"}-${width}.png`,
            fullPage: true,
          });
        }
      });
});

import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 47 (v15 b46 live, guest-after-close-pages newFindings[0] and verdict.extraFindings[0]):
// a guest who left Menu, a dish page or Cart open while staff closed and cleaned the table saw
// no change. The menu kept its + buttons, a background GET /api/v1/customer/store answered 401
// silently, Add to cart then said "Your Store session expired. Scan the location QR code again."
// with Return to entry, and an open zh Cart said 您在这部手机上的用餐已结束 / 刷新购物车 with
// role=alert. Every open tab now notices the ended table within one table read (15 s, as Your
// table) or at the guest's next action, and shows the same calm card a reload shows.
// Synthetic HTTP interception on the production PWA, in the shapes v15 answered.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a47-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const dish = "Beef noodles (TEST)";

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

/** How the restore read answers once staff have ended the table's visit (v15 shapes). */
type Ending =
  | { readonly kind: "empty"; readonly table: string }
  | { readonly kind: "merged"; readonly table: string };

interface Table {
  /** Staff have closed (or merged) the table: every read and write answers as v15 did. */
  ended: Ending | null;
  /** How the cart read was refused after the close (en: 401, zh: the table closed). */
  cartRefusal: "expired" | "participant-ended";
  readonly asked: string[];
}

async function stubTable(page: Page, table: Table) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const expired = json(401, { error: { code: "cart_session_expired" } });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/(api|bff)\//u.test(path)) table.asked.push(`${request.method()} ${path}`);
  });
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill(
      table.ended === null
        ? json(200, {
            schemaVersion: 1,
            csrfToken: "d".repeat(43),
            menuContext: {
              publicStoreReference: publicStore,
              channel: "DineIn",
              locale: "en-CA",
              ...tm2,
            },
            visit: { publicTableReference: id(5), joined: true },
          })
        : table.ended.kind === "empty"
          ? json(200, {
              schemaVersion: 1,
              emptyTable: { tableLabel: table.ended.table, store: tm2 },
            })
          : json(200, {
              schemaVersion: 1,
              movedTable: { tableLabel: table.ended.table, merged: true, store: tm2 },
            }),
    ),
  );
  // v15: the Store's identity read answered 401, silently, once the visit ended.
  await page.route("**/api/v1/customer/store", (route) =>
    table.ended === null ? route.fallback() : route.fulfill(json(401, { code: "UNAUTHORIZED" })),
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
      table.ended === null
        ? json(200, {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 2,
              orderType: "DineIn",
              serviceMode: "DineIn",
              context: { brandName: tm2.brandDisplayName, storeName: tm2.storeDisplayName },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [],
              quote: null,
              warnings: [],
            },
          })
        : table.cartRefusal === "expired"
          ? expired
          : json(409, { error: { code: "cart_participant_ended", reason: "TableClosed" } }),
    ),
  );
  await page.route("**/api/v1/carts/*/items", (route) =>
    route.fulfill(table.ended === null ? json(503, {}) : expired),
  );
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill(
      table.ended === null
        ? json(200, {
            schemaVersion: 1,
            session: {
              tableLabel: "E47 N (TEST)",
              orderNumber: null,
              checkedAt: new Date().toISOString(),
              paymentTiming: "PayFirst",
              rounds: [],
              summary: null,
            },
          })
        : json(401, { error: { code: "UNAUTHORIZED" } }),
    ),
  );
}

async function expectCalmCard(page: Page, heading: string, width: number) {
  const main = page.getByRole("main");
  const card = main
    .getByRole("status")
    .filter({ has: page.getByRole("heading", { name: heading }) });
  await expect(card).toBeVisible();
  await expect(main.getByRole("alert")).toHaveCount(0);
  // Nothing to order with after the close.
  await expect(page.getByRole("button", { name: /^Add |加入|^\+/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add to cart|加入购物车/u })).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveCount(0);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  // Inside the 16 px gutter, and on the first screen with room to spare (Linux fonts run wider).
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  expect(
    await card.evaluate((element) =>
      [...element.querySelectorAll("h2, p, a")].some((line) => line.scrollWidth > line.clientWidth),
    ),
  ).toBe(false);
  await expectNoInternalText(page);
  return card;
}

async function expectStoreHeaderAndNoOldWords(page: Page, zh: boolean) {
  const banner = page.getByRole("banner");
  await expect(banner.getByRole("heading", { level: 1 })).toHaveText(tm2.storeDisplayName);
  for (const wrong of zh
    ? ["扫描门店二维码", "您在这部手机上的用餐已结束", "刷新购物车", "会话", "返回入口"]
    : [
        "Your Store session expired",
        "Scan the location QR code",
        "Your visit on this phone has ended",
        "Refresh cart",
        "Return to entry",
      ])
    await expect(page.getByText(wrong)).toHaveCount(0);
}

async function open(page: Page, path: string, zh: boolean) {
  await page.goto(path);
  if (zh && (await page.getByRole("button", { name: "切换到中文" }).count()) > 0)
    await page.getByRole("button", { name: "切换到中文" }).click();
  // Batch 48: a seated tab also reads the cart when it opens; staff close the table after the
  // page has finished loading (a refusal mid-load is covered by the + and Add to cart taps).
  await page.waitForLoadState("networkidle");
}

for (const width of [390, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN a tab left open while staff end the table (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });

      test("Menu, a dish page and Cart left open during an empty close show the ended card", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        const table: Table = {
          ended: null,
          cartRefusal: zh ? "participant-ended" : "expired",
          asked: [],
        };
        await page.clock.install();
        await stubTable(page, table);
        const ended = { kind: "empty", table: "E47 N (TEST)" } as const;
        const heading = zh ? "这桌的用餐已结束" : "This table’s visit has ended";
        const nothingCharged = zh
          ? "E47 N (TEST) 没有点单，所以没有扣款。"
          : "Nothing was ordered at E47 N (TEST), so nothing was charged.";

        // 1. Menu left open: the next table read (15 s, as Your table) shows the card.
        const plus = page.getByRole("button", { name: /Beef noodles \(TEST\)/u });
        await open(page, "/menu", zh);
        await expect(plus).toBeEnabled();
        table.ended = ended;
        await page.clock.fastForward(16_000);
        let card = await expectCalmCard(page, heading, width);
        await expect(card).toContainText(nothingCharged);
        await expect(page.getByRole("main").getByText(dish)).toHaveCount(0);
        await expectStoreHeaderAndNoOldWords(page, zh);
        await page.screenshot({
          path: `test-results/b47-menu-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });

        // 1b. Menu left open and + tapped before that read: the refused add shows the card.
        table.ended = null;
        await open(page, "/menu", zh);
        await expect(plus).toBeEnabled();
        table.ended = ended;
        await plus.click();
        card = await expectCalmCard(page, heading, width);
        await expect(card).toContainText(nothingCharged);
        await expectStoreHeaderAndNoOldWords(page, zh);

        // 2. A dish page left open: Add to cart (refused 401) shows the card, not "session expired".
        table.ended = null;
        await open(page, `/menu/items/${id(3)}`, zh);
        const addToCart = page.getByRole("button", { name: zh ? "加入购物车" : "Add to cart" });
        await expect(addToCart).toBeEnabled();
        table.ended = ended;
        await addToCart.click();
        card = await expectCalmCard(page, heading, width);
        await expect(card).toContainText(nothingCharged);
        await expectStoreHeaderAndNoOldWords(page, zh);
        await page.screenshot({
          path: `test-results/b47-dish-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });

        // 3. Cart left open: the next table read shows the card (no alert, no Refresh cart).
        table.ended = null;
        await open(page, "/cart", zh);
        await expect(
          page
            .getByRole("main")
            .getByRole("heading", { name: zh ? "您的购物车" : "Your cart", exact: true }),
        ).toBeVisible();
        table.ended = ended;
        await page.clock.fastForward(16_000);
        card = await expectCalmCard(page, heading, width);
        await expect(card).toContainText(nothingCharged);
        await expectStoreHeaderAndNoOldWords(page, zh);
        await page.screenshot({
          path: `test-results/b47-cart-${zh ? "zh" : "en"}-${width}.png`,
          fullPage: true,
        });

        // 4. Search left open: the same.
        table.ended = null;
        await open(page, "/menu/search", zh);
        await expect(page.getByRole("search")).toBeVisible();
        table.ended = ended;
        await page.clock.fastForward(16_000);
        await expectCalmCard(page, heading, width);

        // No new cart was started and nothing was sent for the table after the close.
        expect(
          table.asked.filter(
            (line) =>
              line === "POST /api/v1/carts" || / \/api\/v1\/dine-in\/(?!session)/u.test(line),
          ),
        ).toEqual([]);
      });

      test("Menu and Cart left open while staff merge the table show the merged card", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const table: Table = { ended: null, cartRefusal: "participant-ended", asked: [] };
        await page.clock.install();
        await stubTable(page, table);
        const ended = { kind: "merged", table: "E47 A (TEST)" } as const;
        const heading = zh
          ? "您这桌已并到 E47 A (TEST)"
          : "Your table was merged into E47 A (TEST)";
        for (const path of ["/menu", "/cart"]) {
          table.ended = null;
          await open(page, path, zh);
          await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible();
          table.ended = ended;
          await page.clock.fastForward(16_000);
          const card = await expectCalmCard(page, heading, width);
          // This party ordered: its orders are on that table's bill.
          await expect(card).toContainText(
            zh
              ? "店员已把您并到 E47 A (TEST)，您点过的菜都在那桌的账单上。"
              : "Staff joined your party to E47 A (TEST). Everything your table ordered is on that table's bill.",
          );
          await expectStoreHeaderAndNoOldWords(page, zh);
          await page.screenshot({
            path: `test-results/b47-merged-${path.split("/")[1]}-${zh ? "zh" : "en"}-${width}.png`,
            fullPage: true,
          });
        }
      });

      // b46 live item 4 (partly) and leftOpen: a moved party that ordered nothing, whose phone
      // lost its place at the table, restores the movedTable answer (v15 shape). It is told where
      // to go, and never that its orders and bill moved with it.
      test("a moved party that ordered nothing reads no 'moved with you' bill sentence", async ({
        page,
      }) => {
        await page.route("**/api/v1/customer/session/csrf", (route) =>
          route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: {
              schemaVersion: 1,
              movedTable: { tableLabel: "E47 W (TEST)", nothingOrdered: true, store: tm2 },
            },
          }),
        );
        await open(page, "/dine-in/session", zh);
        for (const path of ["/dine-in/session", "/menu", "/cart"]) {
          await page.goto(path);
          const card = await expectCalmCard(
            page,
            zh ? "您这桌已换到 E47 W (TEST)" : "Your table moved to E47 W (TEST)",
            width,
          );
          await expect(card).toContainText(
            zh
              ? "店员已把您这桌换到 E47 W (TEST)。请扫 E47 W (TEST) 的桌台二维码，继续一起点单和付款。"
              : "Staff moved your party to E47 W (TEST). Scan the code on E47 W (TEST) to keep ordering and paying together.",
          );
          const main = page.getByRole("main");
          await expect(main).not.toContainText(zh ? "一起转过去" : "moved with you");
          await expect(main).not.toContainText(zh ? "账单" : "bill");
          await expectStoreHeaderAndNoOldWords(page, zh);
          await page.screenshot({
            path: `test-results/b47-moved-empty-${path.split("/")[1]}-${zh ? "zh" : "en"}-${width}.png`,
            fullPage: true,
          });
        }
      });
    });

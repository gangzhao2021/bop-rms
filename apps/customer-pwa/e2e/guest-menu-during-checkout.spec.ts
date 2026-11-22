import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 48 (v15 b47 live, guest-open-page-after-close leftOpen (d) and verdict notes): a joined
// guest's Menu still showed + (and a dish page Add to cart) while the table was checking out or
// paid in full and not closed yet, and every tap ended in a refusal; an open Cart said 这桌正在结账
// as a failure with 刷新购物车. Dining admits no new round once checkout starts, so the Store
// refuses the cart read and every cart change (409 cart_table_checking_out) in each phase:
// checkout started, partly paid, paid in full. The guest now sees no + and no Add to cart, one calm
// line, and the way to the bill or, once paid, the receipt; Cancel checkout gives + back.
// Synthetic HTTP interception on the production PWA, in the shapes v15 answered.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a48-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const dish = "Beef noodles (TEST)";
const tableLabel = "G48 P (TEST)";

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

/** The table's phase as staff and guests moved it (v15: one round of $14.13, pay at the end). */
type Phase = "open" | "checkout-started" | "part-paid" | "paid";
interface Table {
  phase: Phase;
  readonly asked: string[];
  /** The cart answer comes this late (in real use it reads participation, selection, catalog). */
  readonly cartDelayMs?: number;
}

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

async function stubTable(page: Page, table: Table) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const json = (status: number, body: unknown) => ({
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/(api|bff)\//u.test(path)) table.asked.push(`${request.method()} ${path}`);
  });
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
  // v15: from Start checkout until the table is closed, the cart read and every cart change
  // answer 409 cart_table_checking_out (Dining's participation check for a Closing session).
  const checkingOut = json(409, {
    schemaVersion: 1,
    error: { code: "cart_table_checking_out", messageKey: "customer.cart.table_checking_out" },
  });
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, async (route) => {
    if (table.cartDelayMs !== undefined) await new Promise((r) => setTimeout(r, table.cartDelayMs));
    return route.fulfill(
      table.phase === "open"
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
        : checkingOut,
    );
  });
  await page.route("**/api/v1/carts**", (route) =>
    route.fulfill(table.phase === "open" ? json(503, {}) : checkingOut),
  );
  await page.route("**/api/v1/dine-in/session**", (route) => {
    const paid = table.phase === "paid" ? "1413" : table.phase === "part-paid" ? "707" : "0";
    const due = table.phase === "paid" ? "0" : table.phase === "part-paid" ? "706" : "1413";
    return route.fulfill(
      json(200, {
        schemaVersion: 1,
        session: {
          tableLabel,
          orderNumber: "21",
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
                  quantity: 1,
                  servedQuantity: 1,
                  cancelled: false,
                  lineTotal: money("1250"),
                },
              ],
              itemsTotal: money("1250"),
            },
          ],
          summary: {
            paid: money(paid),
            refunded: money("0"),
            refundPending: money("0"),
            due: money(due),
            ...(table.phase === "part-paid" ? { splitParts: { count: 2, paid: 1 } } : {}),
          },
        },
      }),
    );
  });
}

function words(zh: boolean, paid: boolean) {
  return paid
    ? {
        line: zh
          ? "这桌已结清。如需再点，请找店员。"
          : "Your table’s bill is paid. To order anything else, ask staff.",
        heading: zh ? "这桌已结清" : "Your table’s bill is paid",
        short: zh ? "如需再点，请找店员。" : "To order anything else, ask staff.",
        link: zh ? "查看收据" : "See the receipt",
      }
    : {
        line: zh
          ? "这桌正在结账。如需加点，请找店员。"
          : "Your table is paying the bill. Ask staff if you want to add more.",
        heading: zh ? "这桌正在结账" : "Your table is paying the bill",
        short: zh ? "如需加点，请找店员。" : "Ask staff if you want to add more.",
        link: zh ? "查看账单" : "See the bill",
      };
}

/** Nothing on screen offers to add a dish, nothing is an alert, and the layout has room to spare. */
async function expectNothingToAdd(page: Page) {
  const main = page.getByRole("main");
  await expect(page.getByRole("button", { name: /^Add |加入|^\+/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add to cart|加入购物车/u })).toHaveCount(0);
  await expect(main.getByRole("alert")).toHaveCount(0);
  for (const wrong of ["Refresh cart", "刷新购物车", "New dishes can’t be sent", "不能再送新菜"])
    await expect(page.getByText(wrong)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await expectNoInternalText(page);
}

/** The calm line, with its link, on the first screen and inside the gutter (Linux fonts run wider). */
async function expectCalmLine(page: Page, zh: boolean, paid: boolean, width: number) {
  const text = words(zh, paid);
  const notice = page.getByRole("main").getByRole("status").filter({ hasText: text.line });
  await expect(notice).toBeVisible();
  const link = notice.getByRole("link", { name: text.link });
  await expect(link).toHaveAttribute("href", "/dine-in/session");
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
  expect(
    await notice.evaluate((element) =>
      [...element.querySelectorAll("p, a")].some((line) => line.scrollWidth > line.clientWidth),
    ),
  ).toBe(false);
  await expectNothingToAdd(page);
}

async function open(page: Page, path: string, zh: boolean) {
  await page.goto(path);
  if (zh && (await page.getByRole("button", { name: "切换到中文" }).count()) > 0)
    await page.getByRole("button", { name: "切换到中文" }).click();
}

for (const width of [390, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN a seated guest while the table checks out (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });

      test("Menu, a dish page, search and Cart offer nothing to add in each checkout phase", async ({
        page,
      }) => {
        test.setTimeout(90_000);
        const table: Table = { phase: "checkout-started", asked: [] };
        await stubTable(page, table);
        for (const phase of ["checkout-started", "part-paid", "paid"] as const) {
          table.phase = phase;
          const paid = phase === "paid";
          const text = words(zh, paid);
          const tag = `${phase}-${zh ? "zh" : "en"}-${width}`;

          await open(page, "/menu", zh);
          await expectCalmLine(page, zh, paid, width);
          // The menu is still there to read, with its prices.
          await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
          await page.screenshot({ path: `test-results/b48-menu-${tag}.png`, fullPage: true });

          await open(page, `/menu/items/${id(3)}`, zh);
          await expect(
            page.getByRole("main").getByRole("heading", { name: dish }).first(),
          ).toBeVisible();
          const dishNotice = page
            .getByRole("main")
            .getByRole("status")
            .filter({ hasText: text.line });
          await expect(dishNotice).toBeVisible();
          await expect(dishNotice.getByRole("link", { name: text.link })).toBeVisible();
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b48-dish-${tag}.png`, fullPage: true });

          await open(page, "/menu/search", zh);
          await expect(page.getByRole("search")).toBeVisible();
          await expectCalmLine(page, zh, paid, width);

          await open(page, "/cart", zh);
          const cart = page.getByRole("region", { name: text.heading });
          await expect(cart).toBeVisible();
          await expect(cart).toContainText(text.short);
          await expect(cart.getByRole("link", { name: text.link })).toHaveAttribute(
            "href",
            "/dine-in/session",
          );
          await expect(cart.getByRole("button")).toHaveCount(0);
          const box = await cart.boundingBox();
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
          expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 - 40);
          await expectNothingToAdd(page);
          await page.screenshot({ path: `test-results/b48-cart-${tag}.png`, fullPage: true });
        }
        // Nothing was offered, so nothing was tapped: no cart was started or changed.
        expect(table.asked.filter((line) => line.startsWith("POST "))).toEqual([]);
      });

      // Batch 48 review: the cart answer landed after the table read and Cart said "paying the
      // bill" with See the bill for 15 s, although the bill was paid.
      test("Cart opened directly on a paid table says so at once, though its cart answer is slow", async ({
        page,
      }) => {
        const table: Table = { phase: "paid", asked: [], cartDelayMs: 1_500 };
        await stubTable(page, table);
        await open(page, "/cart", zh);
        const text = words(zh, true);
        const cart = page.getByRole("region", { name: text.heading });
        await expect(cart).toBeVisible({ timeout: 6_000 });
        await expect(cart.getByRole("link", { name: text.link })).toHaveAttribute(
          "href",
          "/dine-in/session",
        );
        await expect(page.getByText(words(zh, false).heading)).toHaveCount(0);
        await expectNothingToAdd(page);
      });

      test("an open Menu drops + within one table read after Start checkout, and gets it back after Cancel checkout", async ({
        page,
      }) => {
        test.setTimeout(60_000);
        const table: Table = { phase: "open", asked: [] };
        await page.clock.install();
        await stubTable(page, table);
        const plus = page.getByRole("button", { name: /Beef noodles \(TEST\)/u });
        await open(page, "/menu", zh);
        await expect(plus).toBeEnabled();
        // Staff press Start checkout while the Menu stays open.
        table.phase = "checkout-started";
        await page.clock.fastForward(16_000);
        await expectCalmLine(page, zh, false, width);
        // Nobody has paid: staff press Cancel checkout so the table can order one more drink.
        table.phase = "open";
        await page.clock.fastForward(16_000);
        await expect(plus).toBeEnabled();
        await expect(page.getByText(words(zh, false).line)).toHaveCount(0);
        expect(table.asked.filter((line) => line.startsWith("POST "))).toEqual([]);
      });
    });

import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// Batch 49 (v15 b48 live, guest-menu-during-checkout new finding 1): a guest's Cart left open
// while staff pressed Start checkout showed the "paying the bill" card with the old cart below it:
// Items 0, Order summary, Continue shopping, a disabled Place order and "Nothing is charged now.
// Your table pays once at the end." After the table paid in full the same page said "bill is paid"
// above that note. A Cart opened afresh showed the card alone. An open Cart (and Your table) now
// shows, in each phase, what the same page opened afresh shows. Synthetic HTTP interception on the
// production PWA, in the shapes v15 answered (409 cart_table_checking_out from Start checkout until
// the table is closed; the table read says what is paid and due).
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });
const id = (n: number) => "018f8a48-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const publicStore = id(4);
const tm2 = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
const dish = "Beef noodles (TEST)";
const tableLabel = "G49 C (TEST)";
const height = 844;
// Fixed, so a page on a fake clock and one opened afresh read the same times.
const roundSentAt = new Date(Date.now() - 1_800_000).toISOString();
const paidAt = new Date(Date.now() - 60_000).toISOString();

type Phase = "open" | "checkout-started" | "paid";
interface Table {
  phase: Phase;
  /** One dish this phone added and has not sent yet. */
  readonly unsent: boolean;
  /** Batch 50: the cart reads this page made, counted while a test looks. */
  cartReads?: number;
}

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

async function stubTable(page: Page, table: Table) {
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
  const checkingOut = json(409, {
    schemaVersion: 1,
    error: { code: "cart_table_checking_out", messageKey: "customer.cart.table_checking_out" },
  });
  await page.route(/\/bff\/customer\/cart(?:\?.*)?$/u, (route) => {
    if (table.cartReads !== undefined && route.request().method() === "GET") table.cartReads += 1;
    return route.fulfill(
      table.phase === "open"
        ? json(200, {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "DineIn",
              serviceMode: "DineIn",
              context: { brandName: tm2.brandDisplayName, storeName: tm2.storeDisplayName },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: table.unsent
                ? [
                    {
                      cartItemReference: id(2),
                      sellableReference: id(3),
                      displayName: dish,
                      quantity: 1,
                      configuration: [],
                      customerNote: null,
                      lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
                      warnings: [],
                    },
                  ]
                : [],
              quote: null,
              warnings: [],
            },
          })
        : checkingOut,
    );
  });
  // The cart's own price check and any change: refused while checking out, busy otherwise (a
  // failed price check changes nothing on the page).
  await page.route("**/api/v1/carts**", (route) =>
    route.fulfill(table.phase === "open" ? json(503, {}) : checkingOut),
  );
  // Your table's bill: owed from Start checkout, paid in full (not closed yet) after the payment.
  await page.route("**/api/v1/dine-in/table-payment", (route) =>
    route.fulfill(
      json(200, {
        schemaVersion: 1,
        payment: {
          tableLabel,
          checkingOut: table.phase !== "open",
          rounds: [
            {
              roundNumber: 1,
              items: [{ displayName: dish, subtotalMinor: "2500" }],
              totalMinor: "2825",
            },
          ],
          owed: { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
          consistent: true,
          tips: { enabled: false, tierPercents: [10, 15, 18] },
          state: table.phase === "paid" ? "Paid" : "NotPaid",
          attempt: null,
          split: null,
          receipt:
            table.phase === "paid"
              ? {
                  method: "Online",
                  roundsMinor: "2825",
                  pointsUsedMinor: "0",
                  tipMinor: "0",
                  roundingMinor: "0",
                  totalMinor: "2825",
                  paidAt,
                }
              : null,
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
  await page.route("**/api/v1/dine-in/session**", (route) => {
    const paid = table.phase === "paid";
    return route.fulfill(
      json(200, {
        schemaVersion: 1,
        session: {
          tableLabel,
          orderNumber: "31",
          checkedAt: roundSentAt,
          paymentTiming: "PayLater",
          rounds: [
            {
              roundNumber: 1,
              orderedBy: "You",
              submittedAt: roundSentAt,
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
            paid: money(paid ? "2825" : "0"),
            refunded: money("0"),
            refundPending: money("0"),
            due: money(paid ? "0" : "2825"),
            // v15: the table's one payment is settled (Online 2825, tip 0, rounding 0).
            ...(paid ? { tableTip: money("0"), cashRounding: money("0") } : {}),
          },
        },
      }),
    );
  });
}

function words(zh: boolean, phase: Phase) {
  return phase === "paid"
    ? {
        heading: zh ? "这桌已结清" : "Your table’s bill is paid",
        link: zh ? "查看收据" : "See the receipt",
      }
    : {
        heading: zh ? "这桌正在结账" : "Your table is paying the bill",
        link: zh ? "查看账单" : "See the bill",
      };
}

/** What a page left open must never keep once the table is checking out or paid. */
const staleCart = [
  "Order summary",
  "Continue shopping",
  "Place order",
  "Nothing is charged now",
  "继续选购",
  "下单",
  "现在不收款",
  "最后一起结账",
];

async function open(page: Page, path: string, zh: boolean) {
  await page.goto(path);
  if (zh && (await page.getByRole("button", { name: "切换到中文" }).count()) > 0)
    await page.getByRole("button", { name: "切换到中文" }).click();
}

/** Lets the page's own reads run (fake clock) until `check` holds. */
async function runUntil(page: Page, check: () => Promise<void>) {
  for (let step = 0; step < 24; step += 1) {
    try {
      await check();
      return;
    } catch {
      await page.clock.runFor(5_000);
    }
  }
  await check();
}

/**
 * Batch 50: moves the page's fake clock on in half-second steps, letting each answer arrive
 * (real time) before the clock moves again, so the reads keep the cadence the page sets.
 */
async function advance(page: Page, ms: number) {
  for (let done = 0; done < ms; done += 500) {
    await page.clock.runFor(500);
    await page.waitForTimeout(25);
  }
}

// The last-orders countdown follows the wall clock against the fixed 21:30 in storefront-reads
// (and the page clock moves on in the long-checkout test), so a comparison across a minute
// boundary saw "20 min left" then "18 min left": mask the count, compare everything else.
const mainText = (page: Page) =>
  page
    .getByRole("main")
    .innerText()
    .then((text) =>
      text
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/\d+ min left/u, "N min left")
        .replace(/还剩 \d+ 分钟/u, "还剩 N 分钟"),
    );

/** A table cart with a dish in it once the page knows the table pays at the end. */
async function expectPayLaterCart(page: Page) {
  await expect(page.getByRole("button", { name: /^(Place order|下单)$/u })).toBeVisible();
}

/** The same page opened afresh, at the same table phase, in the same language. */
async function freshText(browser: Browser, table: Table, path: string, zh: boolean, width: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: "block",
  });
  await routeStorefrontReads(context);
  const page = await context.newPage();
  await stubTable(page, table);
  await open(page, path, zh);
  if (path === "/cart" && table.phase !== "open")
    await expect(
      page.getByRole("main").getByRole("heading", { name: words(zh, table.phase).heading }),
    ).toBeVisible();
  else await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
  if (path === "/cart" && table.phase === "open" && table.unsent) await expectPayLaterCart(page);
  // Its own first reads settle (the table read decides "paying" or "paid").
  await page.waitForLoadState("networkidle");
  const text = await mainText(page);
  await context.close();
  return text;
}

async function expectCardOnly(page: Page, zh: boolean, phase: Phase, width: number) {
  const text = words(zh, phase);
  const card = page.getByRole("region", { name: text.heading });
  await expect(card).toBeVisible({ timeout: 1_000 });
  await expect(card.getByRole("link", { name: text.link })).toHaveAttribute(
    "href",
    "/dine-in/session",
  );
  const main = page.getByRole("main");
  const quick = { timeout: 1_000 };
  for (const stale of staleCart) await expect(main.getByText(stale)).toHaveCount(0, quick);
  await expect(main.getByText(dish)).toHaveCount(0, quick);
  await expect(main.getByRole("button")).toHaveCount(0, quick);
  await expect(main.getByRole("alert")).toHaveCount(0, quick);
  // The card sits inside the gutter on the first screen, with room for wider (Linux) fonts.
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(15);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 15);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height - 40);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await expectNoInternalText(page);
}

for (const width of [390, 1024, 1440])
  for (const zh of [false, true])
    test.describe(`@production CUST-DINE-IN a Cart left open while the table checks out (${zh ? "zh-Hans" : "en"} ${width})`, () => {
      test.use({ viewport: { width, height }, hasTouch: width < 768, isMobile: width < 768 });

      for (const unsent of [false, true])
        test(`Cart ${unsent ? "with an unsent dish" : "empty"} shows what a fresh Cart shows: checking out, then paid`, async ({
          page,
          browser,
        }) => {
          test.setTimeout(150_000);
          const table: Table = { phase: "open", unsent };
          await page.clock.install();
          await stubTable(page, table);
          await open(page, "/cart", zh);
          if (unsent) await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
          else await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible();

          // Staff press Start checkout while this Cart stays open.
          table.phase = "checkout-started";
          await runUntil(page, () => expectCardOnly(page, zh, "checkout-started", width));
          const tag = `${unsent ? "unsent" : "empty"}-${zh ? "zh" : "en"}-${width}`;
          await page.screenshot({ path: `test-results/b49-cart-checkout-${tag}.png` });
          expect(await mainText(page)).toBe(await freshText(browser, table, "/cart", zh, width));

          // Another phone pays the whole table; staff have not closed it yet.
          table.phase = "paid";
          await runUntil(page, () => expectCardOnly(page, zh, "paid", width));
          await page.screenshot({ path: `test-results/b49-cart-paid-${tag}.png` });
          expect(await mainText(page)).toBe(await freshText(browser, table, "/cart", zh, width));
        });

      test("Cart with an unsent dish comes back as it was after Cancel checkout", async ({
        page,
        browser,
      }) => {
        test.setTimeout(150_000);
        const table: Table = { phase: "open", unsent: true };
        await page.clock.install();
        await stubTable(page, table);
        await open(page, "/cart", zh);
        await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
        await expectPayLaterCart(page);
        await page.waitForLoadState("networkidle");
        const before = await mainText(page);

        table.phase = "checkout-started";
        await runUntil(page, () => expectCardOnly(page, zh, "checkout-started", width));
        // Nobody has paid: staff press Cancel checkout so the table can order one more drink.
        table.phase = "open";
        await runUntil(page, async () => {
          await expect(page.getByText(words(zh, "checkout-started").heading)).toHaveCount(0, {
            timeout: 500,
          });
          await expect(page.getByRole("main").getByText(dish).first()).toBeVisible({
            timeout: 500,
          });
        });
        await expectPayLaterCart(page);
        await page.waitForLoadState("networkidle");
        const after = await mainText(page);
        expect(after).toBe(before);
        expect(after).toBe(await freshText(browser, table, "/cart", zh, width));
      });

      // Batch 50 (v15 b49 live, guest-cart-open-through-checkout): every 409 "checking out" answer
      // was counted as a failed read, so the open Cart's reads backed off to 8/16/32/60 s. After a
      // real checkout of a few minutes, Cancel checkout (or the payment) reached the Cart up to a
      // minute late. Checking out is a known state, read every 4 s like any other.
      for (const after of ["Cancel checkout", "paid in full"] as const)
        test(`after a checkout of over two minutes, ${after} reaches the open Cart within one read`, async ({
          page,
        }) => {
          test.setTimeout(150_000);
          const table: Table = { phase: "open", unsent: true };
          await page.clock.install();
          await stubTable(page, table);
          await open(page, "/cart", zh);
          await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
          await expectPayLaterCart(page);
          await page.waitForLoadState("networkidle");
          const before = await mainText(page);

          table.phase = "checkout-started";
          await runUntil(page, () => expectCardOnly(page, zh, "checkout-started", width));
          // Staff take their time with the bill: 150 s, the Cart on screen the whole while.
          table.cartReads = 0;
          await advance(page, 150_000);
          // One read about every 4 s (over 30), never a minute's silence (backing off: about 6).
          expect(table.cartReads).toBeGreaterThanOrEqual(25);
          await expectCardOnly(page, zh, "checkout-started", width);

          if (after === "Cancel checkout") {
            table.phase = "open";
            // The next normal read (4 s) brings the cart back as it was.
            await advance(page, 4_500);
            await expect(page.getByRole("main").getByText(dish).first()).toBeVisible({
              timeout: 2_000,
            });
            await expect(page.getByText(words(zh, "checkout-started").heading)).toHaveCount(0);
            await expectPayLaterCart(page);
            await page.waitForLoadState("networkidle");
            expect(await mainText(page)).toBe(before);
          } else {
            table.phase = "paid";
            // The table read (every 15 s) says the bill is paid; the Cart says so with it.
            await advance(page, 15_500);
            await expectCardOnly(page, zh, "paid", width);
          }
          await page.screenshot({
            path: `test-results/b50-cart-after-long-checkout-${after === "paid in full" ? "paid" : "cancel"}-${zh ? "zh" : "en"}-${width}.png`,
          });
        });

      // Batch 51 (b50 reviewer, not run live): an empty Cart (nobody at the table has an unsent
      // dish) left open through a checkout of over two minutes, then Cancel checkout. Batch 49 saw
      // about 29 s; it reads every 4 s like the Cart with a dish in it, and comes back as it was.
      test("an empty Cart kept open through a checkout of over two minutes comes back after Cancel", async ({
        page,
      }) => {
        test.setTimeout(150_000);
        const table: Table = { phase: "open", unsent: false };
        await page.clock.install();
        await stubTable(page, table);
        await open(page, "/cart", zh);
        await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        const before = await mainText(page);

        table.phase = "checkout-started";
        await runUntil(page, () => expectCardOnly(page, zh, "checkout-started", width));
        table.cartReads = 0;
        await advance(page, 150_000);
        expect(table.cartReads).toBeGreaterThanOrEqual(25);
        await expectCardOnly(page, zh, "checkout-started", width);

        table.phase = "open";
        await advance(page, 4_500);
        await expect(page.getByText(words(zh, "checkout-started").heading)).toHaveCount(0, {
          timeout: 2_000,
        });
        await page.waitForLoadState("networkidle");
        // The same empty Cart as before checkout, word for word (no card, no stale checkout line).
        await expect(
          page.getByRole("heading", { name: zh ? "购物车是空的" : "Your cart is empty" }),
        ).toBeVisible();
        expect(await mainText(page)).toBe(before);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        await expectNoInternalText(page);
        await page.screenshot({
          path: `test-results/b51-empty-cart-after-long-checkout-${zh ? "zh" : "en"}-${width}.png`,
        });
      });

      test("Your table left open says the bill, then the paid bill, as it does opened afresh", async ({
        page,
        browser,
      }) => {
        test.setTimeout(150_000);
        const table: Table = { phase: "open", unsent: false };
        await page.clock.install();
        await stubTable(page, table);
        await open(page, "/dine-in/session", zh);
        await expect(page.getByRole("main").getByText(dish).first()).toBeVisible();
        for (const phase of ["checkout-started", "paid"] as const) {
          table.phase = phase;
          const fresh = await freshText(browser, table, "/dine-in/session", zh, width);
          await runUntil(page, async () => {
            await page.waitForLoadState("networkidle");
            expect(await mainText(page)).toBe(fresh);
          });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
          await expectNoInternalText(page);
        }
      });
    });

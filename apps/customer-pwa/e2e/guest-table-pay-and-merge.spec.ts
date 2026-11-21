import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// v15 dinner-shift sweep 38 (batch 39). Synthetic HTTP (routes standing in for the API) on the
// production PWA: a pay-at-the-end table whose bill read fails for a moment (the table being paid
// or closed by staff right then) is read again by itself and never shows a payment outage; a bill
// read that says this phone is no longer at an open table reads the table page again; a merged
// table's bill split by rounds says whose rounds each part pays; a table merged away offers no
// "order more"; a dish sold out today is said as sold out. The amounts and the server's answers are
// proven by the API tests and the restricted-role database acceptance.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block", trace: "off", video: "off" });

const id = (n: number) => `018f8b39-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const csrf = "o".repeat(43);
const seatedCsrf = "q".repeat(43);
const beef = id(20);
const json = { "cache-control": "no-store" };
const outage = "We couldn’t reach the payment service. Check your connection and try again.";

interface Item {
  readonly cancelled?: boolean;
  readonly takenOff?: true;
  readonly soldOut?: true;
}
const sessionBody = (item: Item = {}) => ({
  schemaVersion: 1,
  session: {
    tableLabel: "H4",
    orderNumber: "4",
    checkedAt: new Date().toISOString(),
    paymentTiming: "PayLater",
    rounds: [
      {
        roundNumber: 1,
        orderedBy: "AnotherGuest",
        submittedAt: "2026-11-20T23:50:00.000Z",
        status: item.cancelled === true ? "Served" : "Served",
        payment: "OnTableBill",
        cancelsAt: null,
        storeCancellationReason: null,
        items: [
          {
            displayName: "Sliced beef (TEST)",
            quantity: 1,
            servedQuantity: item.cancelled === true ? 0 : 1,
            cancelled: item.cancelled === true,
            lineTotal: cad("1694"),
            ...(item.takenOff === undefined ? {} : { takenOff: true }),
            ...(item.soldOut === undefined ? {} : { soldOut: true }),
            orderAgain: { sellableReference: beef, optionSelections: [] },
          },
          {
            displayName: "Tomato pot (TEST)",
            quantity: 1,
            servedQuantity: 1,
            cancelled: false,
            lineTotal: cad("1808"),
            orderAgain: { sellableReference: id(21), optionSelections: [] },
          },
        ],
        itemsTotal: cad(item.cancelled === true ? "1808" : "3502"),
      },
    ],
    summary: {
      paid: cad("0"),
      refunded: cad("0"),
      refundPending: cad("0"),
      due: cad(item.cancelled === true ? "2043" : "3957"),
    },
  },
});

const payment = (overrides: Record<string, unknown>) => ({
  schemaVersion: 1,
  payment: {
    tableLabel: "H4",
    checkingOut: false,
    rounds: [],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    tips: { enabled: false, tierPercents: [10, 15, 18] },
    state: "NotPaid",
    attempt: null,
    split: null,
    receipt: null,
    ...overrides,
  },
});

async function openTable(
  page: Page,
  {
    session,
    tablePayment,
    heading = "Your table · H4",
  }: {
    readonly session: (route: Route) => Promise<void>;
    readonly tablePayment: (route: Route) => Promise<void>;
    readonly heading?: string;
  },
) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: json,
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Hotpot",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: csrf,
      },
    }),
  );
  await page.route("**/api/v1/dine-in/session**", session);
  await page.route("**/api/v1/dine-in/table-payment", tablePayment);
  await page.route("**/api/v1/dine-in/staff-call", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: { schemaVersion: 1, staffCall: { open: null, recentlyClosed: null, nextCallAt: null } },
    }),
  );
  await page.route("**/api/v1/dine-in/invitation", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: { schemaVersion: 1, invitation: { canInvite: false } },
    }),
  );
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.route("**/bff/customer/cart**", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 1,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Hotpot" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [],
          quote: null,
          warnings: [],
        },
      },
    }),
  );
  await page.route("**/bff/customer/dining/qr-join", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: {
        status: "Joined",
        operationReference: route.request().headers()["idempotency-key"],
        admissionReference: id(30),
      },
    }),
  );
  await page.route("**/bff/customer/dining-binding/prepare", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: {
        status: "Prepared",
        operationReference: route.request().headers()["idempotency-key"],
        candidateCsrfToken: seatedCsrf,
        recoveryProof: "r".repeat(43),
        expiresAt,
      },
    }),
  );
  await page.route("**/bff/customer/dining-binding/activate", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      json: {
        status: "Activated",
        operationReference: route.request().headers()["idempotency-key"],
        csrfToken: seatedCsrf,
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.getByRole("heading", { name: "Synthetic Hotpot", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Join this table", exact: true }).click();
  await expect(page).toHaveURL(/\/menu$/u);
  await page.evaluate(() => {
    history.pushState(null, "", "/dine-in/session");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

const ok = (body: unknown) => (route: Route) =>
  route.fulfill({ status: 200, headers: json, json: body });

test.describe("@production a pay-at-the-end table after another phone paid, merges and sold-out dishes", () => {
  test("a bill read that fails for a moment is read again; the receipt shows, never an outage", async ({
    page,
  }) => {
    let reads = 0;
    await openTable(page, {
      session: ok(sessionBody()),
      tablePayment: (route) => {
        reads += 1;
        // The other phone's payment is being recorded right then: the store's side answers 503.
        if (reads === 1)
          return route.fulfill({
            status: 503,
            headers: { ...json, "retry-after": "5" },
            json: { schemaVersion: 1, error: { code: "table_payment_unavailable" } },
          });
        return route.fulfill({
          status: 200,
          headers: json,
          json: payment({
            state: "Paid",
            receipt: {
              method: "Online",
              roundsMinor: "8692",
              pointsUsedMinor: "0",
              tipMinor: "0",
              roundingMinor: "0",
              totalMinor: "8692",
              paidAt: "2026-11-21T00:22:07.105Z",
            },
          }),
        });
      },
    });
    const seen: number[] = [];
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      seen.push(await page.getByText(outage).count());
      if ((await page.getByRole("heading", { name: "Receipt" }).count()) > 0) break;
      await page.waitForTimeout(200);
    }
    await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible({ timeout: 100 });
    await expect(page.getByText("Thank you! Your table is paid in full.")).toBeVisible();
    expect(seen.every((count) => count === 0)).toBe(true);
    await expect(page.getByText(outage)).toHaveCount(0);
    await expectNoInternalText(page);
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/b39-paid-after-blip-${width}.png` });
    }
  });

  test("a bill read saying this phone left an open table reads the table page again", async ({
    page,
  }) => {
    let sessionReads = 0;
    let atClose: number | null = null;
    await openTable(page, {
      session: (route) => {
        sessionReads += 1;
        return route.fulfill({ status: 200, headers: json, json: sessionBody() });
      },
      // Staff close the table while the bill is read (answered after the page settled).
      tablePayment: async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        atClose ??= sessionReads;
        return route.fulfill({
          status: 404,
          headers: json,
          json: { schemaVersion: 1, error: { code: "table_not_found" } },
        });
      },
    });
    await expect.poll(() => atClose, { timeout: 5_000 }).not.toBeNull();
    // The page reads the table again at once (its next regular read is 15 s away), which says
    // how the meal ended; nothing about payment is said meanwhile.
    await expect.poll(() => sessionReads, { timeout: 5_000 }).toBeGreaterThan(atClose ?? 0);
    await expect(
      page.getByText("This phone isn’t part of the table any more. Ask a staff member for help."),
    ).toHaveCount(0);
    await expect(page.getByText(outage)).toHaveCount(0);
  });

  test("a merged table split by rounds says whose rounds each part pays (en and zh-Hans)", async ({
    page,
  }) => {
    const part = (partNumber: number, amountMinor: string, table: string, rounds: number[]) => ({
      partNumber,
      amountMinor,
      subtotalMinor: amountMinor,
      dishes: [],
      status: "ToPay",
      tables: [table],
      roundNumbers: rounds,
    });
    await openTable(page, {
      session: ok(sessionBody()),
      tablePayment: ok(
        payment({
          checkingOut: true,
          owed: { subtotalMinor: "10291", taxMinor: "1338", totalMinor: "11629" },
          split: {
            mode: "ByRounds",
            stale: false,
            paidInFull: false,
            paidParts: 0,
            remainingMinor: "11629",
            parts: [part(1, "5307", "H4", [1, 3, 5]), part(2, "6322", "H6", [2, 4, 6])],
          },
        }),
      ),
    });
    const parts = page.getByRole("group", { name: "Which part you pay" });
    await expect(parts).toContainText("Part 1 · $53.07");
    await expect(parts).toContainText("Table H4 · rounds 1, 3, 5");
    await expect(parts).toContainText("Part 2 · $63.22");
    await expect(parts).toContainText("Table H6 · rounds 2, 4, 6");
    // No tip is promised where this Store takes none.
    await expect(page.getByText(/tip/iu)).toHaveCount(0);
    await expectNoInternalText(page);
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/b39-merged-parts-${width}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByRole("group", { name: "付哪一份" })).toContainText(
      "H6 桌 · 第 2, 4, 6 轮",
    );
    await expect(page.getByText(/小费/u)).toHaveCount(0);
    await page.screenshot({ path: "test-results/b39-merged-parts-zh-390.png" });
  });

  test("a table merged away says where to scan and offers no ordering from here", async ({
    page,
  }) => {
    await openTable(page, {
      heading: "Your table was merged into table H4",
      session: (route) =>
        route.fulfill({
          status: 409,
          headers: json,
          json: {
            schemaVersion: 1,
            error: {
              code: "dining_table_moved",
              messageKey: "customer.dining.session.table_moved",
            },
            tableLabel: "H4",
            merged: true,
          },
        }),
      tablePayment: ok(payment({})),
    });
    await expect(page.getByText("Scan the code on table H4", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Order more from the menu" })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/b39-merged-away-390.png" });
  });

  test("a dish sold out today is said as sold out, ordering it again and taken off the bill", async ({
    page,
  }) => {
    await openTable(page, {
      session: ok(sessionBody({ cancelled: true, takenOff: true, soldOut: true })),
      tablePayment: ok(payment({})),
    });
    await expect(page.getByText("Sold out · taken off the bill, not charged")).toBeVisible();
    await page.route("**/api/v1/carts/*/items", (route) =>
      route.fulfill({
        status: 422,
        headers: json,
        json: { error: { code: "cart_selection_invalid", issueCodes: ["CATALOG_ITEM_SOLD_OUT"] } },
      }),
    );
    await page.getByRole("button", { name: "Order one more Tomato pot (TEST)" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Tomato pot (TEST) is sold out today.");
    await expect(alert).not.toContainText("menu has changed");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/b39-sold-out-390.png", fullPage: true });
    await page.getByRole("button", { name: "切换到中文" }).click();
    await expect(page.getByText("已售罄 · 已从账单删除，不收费")).toBeVisible();
  });
});

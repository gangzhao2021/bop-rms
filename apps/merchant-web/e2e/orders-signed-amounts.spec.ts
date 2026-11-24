import { expect, test, type Page } from "@playwright/test";

/**
 * b59 (live58, TM2 order 19, zh-Hans at 390): the Orders comp line "牛肉面 · 已免单 · 致歉/好意 ·
 * 由你经办，08:13 −$14.13 （含税）" broke between the minus sign and the amount, so "$14.13 （含税）"
 * on the next line read as money in. A signed amount (sign, currency, digits and its tax note)
 * never breaks; the words before it wrap instead. The dish names run from 1 to 64 characters so
 * that, at every width and whatever the font (DejaVu on Linux, the system font on macOS), some line ends where the
 * amount starts. Synthetic Store; the server is mocked.
 */
const id = (n: number) => "01909971-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const names = Array.from({ length: 64 }, (_, n) =>
  "牛肉面拉面汤饺子馄饨炒饭烧卖春卷".repeat(4).slice(0, n + 1),
);

async function mock(page: Page, zh: boolean) {
  if (zh)
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-24",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
  const order = {
    orderReference: id(1),
    orderNumber: "19",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-24T13:12:00.000Z",
    observedAt: "2026-11-24T13:20:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        unpaidRemovableItems: [],
        unpaidRemovedItems: [],
        compableItems: [],
        compedItems: names.map((_, n) => ({
          orderItemReference: id(200 + n),
          kind: "Comp",
          percent: null,
          amountMinor: "1413",
          reasonCode: "GOODWILL",
          decidedAt: "2026-11-24T13:13:00.000Z",
          byLabel: "You",
        })),
      },
    ],
    canRequestAcceptance: false,
    tableBill: { totalMinor: "0", paid: null },
    currentPhase: "Fulfilled",
    currentVersion: 4,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order,
        lines: {
          items: names.map((name, n) => ({
            orderItemReference: id(200 + n),
            orderBatchReference: id(51),
            name,
            options: [],
            quantity: 1,
            customerNote: null,
            unitPrice: money("1250"),
            subtotal: money("1250"),
            discount: money("1250"),
            tax: money("0"),
            fee: money("0"),
            total: money("0"),
            canCancel: false,
            cancellation: null,
          })),
          totals: {
            subtotal: money("20000"),
            discount: money("20000"),
            tax: money("0"),
            fee: money("0"),
            taxRounding: money("0"),
            total: money("0"),
          },
        },
      },
    }),
  );
}

/** Each signed amount on one line, with ~40 px to spare on its line (Linux fonts are wider). */
async function amountsHold(page: Page) {
  const comps = page.locator(".order-comp-records li > span:last-child");
  await expect(comps).toHaveCount(names.length);
  const amounts = page.locator(".order-comp-records li > span:last-child, .order-line-amount");
  const found = await amounts.evaluateAll((elements) =>
    elements
      .filter((element) => /[−+]/u.test(element.textContent ?? ""))
      .map((element) => {
        const line = element.closest("li");
        return {
          text: element.textContent ?? "",
          lines: element.getClientRects().length,
          height: element.getBoundingClientRect().height,
          fontLine: parseFloat(getComputedStyle(element).lineHeight) || 24,
          spare: (line?.getBoundingClientRect().width ?? 0) - element.getBoundingClientRect().width,
        };
      }),
  );
  expect(found.length).toBeGreaterThanOrEqual(names.length);
  for (const amount of found) {
    expect(amount, amount.text).toMatchObject({ lines: 1 });
    expect(amount.height, amount.text).toBeLessThan(amount.fontLine * 1.5);
    expect(amount.spare, amount.text).toBeGreaterThanOrEqual(40);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b59: a comp's signed amount never breaks on the order's page (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh);
      await page.goto("/operations/orders/" + id(1));
      await expect(page.locator(".order-comp-records").first()).toContainText(
        zh ? "由你经办，08:13" : "by You, 08:13",
      );
      await expect(page.locator(".order-comp-records").first()).toContainText(
        zh ? "−$14.13 （含税）" : "−$14.13 incl. tax",
      );
      await amountsHold(page);
      await page.screenshot({
        path: `test-results/b59-comp-amount-page-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b59: a comp's signed amount never breaks in the Orders detail (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh);
      await page.goto("/operations/orders");
      const opener = page.locator("li.order-row").first().locator(".order-row__open");
      await expect(opener).toBeVisible();
      // The one order listed opens by itself.
      if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".order-comp-records").first()).toBeVisible();
      await amountsHold(page);
    });
  }
}

import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
// Synthetic HTTP responses exercise the production App; no live issuance evidence.
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function payload() {
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    orderReference: id(1),
    freshnessStatus: "Stale",
    deliveryStatus: "Unavailable",
    supportEligible: false,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-08-12T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Synthetic Store",
          orderNumber: "1001",
          issuedAt: "2026-08-12T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: amount("1000"),
            },
          ],
          subtotal: amount("1000"),
          tax: amount("130"),
          tip: amount("0"),
          total: amount("1130"),
          paymentStatus: "Paid",
          refundedTotal: amount("0"),
        },
      },
    ],
  };
}

test("@production receipt navigation removes inaccessible history and fits common widths", async ({
  page,
}) => {
  const csrf = "c".repeat(43);
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Status Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: csrf,
      },
    }),
  );

  await page.route("**/api/v1/orders/*/receipt", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
    expect(route.request().method()).toBe("GET");
    if (route.request().url().includes(id(1))) {
      await route.fulfill({ json: { schemaVersion: 1, receipt: payload() } });
    } else await route.fulfill({ status: 404, json: { schemaVersion: 1 } });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
  ).toBeVisible();
  const navigate = async (reference: string) =>
    page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference + "/receipt");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, reference);
  await navigate(id(1));
  await expect(page.getByText("Synthetic Operating Entity", { exact: true })).toBeVisible();
  // No permanent technical notice: the receipt is the record, payment amounts are checked live.
  await expect(page.getByText(/Live receipt status|delivery and support status/u)).toHaveCount(0);
  await expect(page.getByText("$11.30", { exact: true })).toBeVisible();
  // WP-2423 Q10: no inactive email stub; printing or saving is the working way to keep a copy.
  await expect(page.getByRole("button", { name: "Request email receipt" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Print or save receipt" })).toBeVisible();
  await expectNoInternalText(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "Receipt history" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Keep a copy" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to order status" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const headerColor = await page
      .locator(".bop-shell__header")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const canvasColor = await page
      .locator(".receipt-page")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(headerColor).toBe("rgb(255, 255, 255)");
    expect(canvasColor).toBe("rgb(255, 255, 255)");
    const history = await page.locator(".receipt-page__history").boundingBox();
    const financial = await page.locator(".receipt-page__financial").boundingBox();
    expect(history).not.toBeNull();
    expect(financial).not.toBeNull();
    if (history && financial && viewport.width >= 768) {
      expect(financial.x).toBeGreaterThan(history.x);
      expect(Math.abs(financial.y - history.y)).toBeLessThan(1);
      expect(history.width).toBeGreaterThan(financial.width);
    }
    if (history && financial && viewport.width < 768) {
      expect(financial.y).toBeLessThan(history.y);
      expect(financial.x).toBe(history.x);
      expect(financial.width).toBe(history.width);
    }
    const actions = page.locator(".receipt-page__actions");
    await expect(actions).toHaveCSS("flex-direction", viewport.width <= 511 ? "column" : "row");
    const print = await page.getByRole("button", { name: "Print or save receipt" }).boundingBox();
    expect(print).not.toBeNull();
    expect(print?.height).toBeGreaterThanOrEqual(44);
    // WP-2423 Q10: the Store's contact (or "ask a staff member") sits beside the receipt actions.
    await expect(page.getByRole("heading", { name: "Questions about this order?" })).toBeVisible();
    await page.screenshot({ path: `test-results/receipt-${viewport.width}.png`, fullPage: true });
  }
  await navigate(id(99));
  await expect(page.getByRole("heading", { name: "Receipt not found", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Operating Entity", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("@production DEC-TIP-REFUND-PROPORTIONAL: a receipt states cancelled items' share of the tip", async ({
  page,
}) => {
  const csrf = "c".repeat(43);
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const lines = [
    {
      lineReference: id(4),
      displayName: "Mocha",
      quantity: 1,
      lineTotal: amount("650"),
      lineSubtotal: amount("575"),
    },
    {
      lineReference: id(5),
      displayName: "Synthetic croissant",
      quantity: 1,
      lineTotal: amount("650"),
      lineSubtotal: amount("575"),
    },
  ];
  const snapshot = {
    receiptReference: id(3),
    operatingEntityDisplayName: "Synthetic Operating Entity",
    storeDisplayName: "Synthetic Store",
    orderNumber: "20",
    issuedAt: "2026-10-17T15:00:00.000Z",
    locale: "en-CA",
    lines,
    subtotal: amount("1150"),
    tax: amount("150"),
    tip: amount("124"),
    total: amount("1424"),
    paymentStatus: "Paid",
    refundedTotal: amount("0"),
  };
  const receipt = {
    orderReference: id(1),
    freshnessStatus: "Fresh",
    deliveryStatus: "Unavailable",
    supportEligible: false,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-10-17T15:00:00.000Z",
        reasonCode: null,
        snapshot,
      },
      {
        recordReference: id(7),
        version: 2,
        kind: "Refund",
        recordedAt: "2026-10-17T15:05:00.000Z",
        reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
        snapshot: {
          ...snapshot,
          paymentStatus: "PartiallyRefunded",
          refundedTotal: amount("712"),
          // The store cancelled the mocha: its price, tax and half of the tip (equal nets).
          refunds: [
            {
              kind: "ItemCancellation",
              lines: [
                { lineReference: id(4), displayName: "Mocha", quantity: 1, amount: amount("575") },
              ],
              tax: amount("75"),
              tip: amount("62"),
              other: amount("0"),
              total: amount("712"),
              newInThisVersion: true,
            },
          ],
        },
      },
    ],
  };
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Status Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: csrf,
      },
    }),
  );
  await page.route("**/api/v1/orders/*/receipt", (route) =>
    route.fulfill({ json: { schemaVersion: 1, receipt } }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
  ).toBeVisible();
  await page.evaluate((reference) => {
    history.pushState(null, "", "/orders/" + reference + "/receipt");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, id(1));
  const refunds = page.locator(".receipt-page__refunds").last();
  await expect(refunds).toContainText("Cancelled items");
  await expect(refunds.locator(".receipt-page__refund dl")).toContainText("Tax$0.75");
  await expect(refunds.locator(".receipt-page__refund dl")).toContainText("Tip$0.62");
  await expect(refunds.locator(".receipt-page__refund dl")).toContainText("Refunded$7.12");
  await expect(refunds).toContainText("Total after refunds$7.12");
  await expectNoInternalText(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/receipt-item-cancel-tip-${width}.png` });
  }
});

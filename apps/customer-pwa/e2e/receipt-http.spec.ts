import { expect, test } from "@playwright/test";
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
  await expect(
    page.getByRole("heading", { name: "Live receipt status is unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("$11.30", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request email receipt" })).toHaveAttribute(
    "aria-describedby",
    "receipt-email-unavailable",
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "Receipt history" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Receipt actions" })).toBeVisible();
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
    const print = await page.getByRole("button", { name: "Print receipt" }).boundingBox();
    const email = await page.getByRole("button", { name: "Request email receipt" }).boundingBox();
    expect(print).not.toBeNull();
    expect(email).not.toBeNull();
    expect(print?.height).toBeGreaterThanOrEqual(44);
    expect(email?.height).toBeGreaterThanOrEqual(44);
    if (viewport.width <= 511 && print && email) {
      expect(email.y).toBeGreaterThanOrEqual(print.y + print.height);
      expect(email.x).toBe(print.x);
      expect(email.width).toBe(print.width);
    }
    await page.screenshot({ path: `test-results/receipt-${viewport.width}.png`, fullPage: true });
  }
  await navigate(id(99));
  await expect(page.getByRole("heading", { name: "Receipt not found", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Operating Entity", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

import { expect, test } from "@playwright/test";

// WP-2423 Q9-G1: synthetic HTTP evidence for the production App. No live Store or Payment result.
const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function status(storeAcceptance: unknown) {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(8),
      projectedAt: "2026-08-11T14:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference: id(1),
        orderNumber: "1001",
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-08-11T13:00:00.000Z",
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:00:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "Synthetic tea",
                quantity: 1,
                lineTotal: { amountMinor: "1500", currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-08-11T13:02:00.000Z",
            amount: { amountMinor: "1500", currencyCode: "CAD" },
            freshnessStatus: "Fresh",
          },
        ],
        storeAcceptance,
      },
    },
  };
}

test.describe("@production order paid while the store was offline", () => {
  test.use({ serviceWorkers: "block" });
  test("tells the customer when the store has not confirmed, then that the payment was refunded", async ({
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
    let state: unknown = { state: "AwaitingStore" };
    await page.route("**/api/v1/orders/*/status", (route) =>
      route.fulfill({ json: status(state) }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      state = { state: "AwaitingStore" };
      await page.getByRole("button", { name: "Refresh now", exact: true }).click();
      await expect(
        page.getByText(
          "The store hasn’t confirmed your order yet. Please wait or contact the store.",
        ),
      ).toBeVisible();
      await page.screenshot({ path: `test-results/outage-awaiting-${width}.png`, fullPage: true });
      state = {
        state: "NotAccepted",
        closedAt: "2026-08-11T13:59:00.000Z",
        refundStatus: "Refunded",
      };
      await page.getByRole("button", { name: "Refresh now", exact: true }).click();
      await expect(
        page.getByText(
          "The store couldn’t accept your order, so your payment was refunded to your original payment method.",
        ),
      ).toBeVisible();
      await expect(page.getByText("Refunded $15.00", { exact: true })).toBeVisible();
      await expect(page.getByText(/Payment received/u)).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/outage-refunded-${width}.png`, fullPage: true });
    }
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/CapacityExpired|NotAccepted|AwaitingStore|hold/iu);
  });
});

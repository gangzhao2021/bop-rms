import { expect, test } from "@playwright/test";

// Synthetic HTTP evidence for the production App. No live Store or Payment result.
const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function status(orderReference: string, orderNumber: string, amountMinor: string) {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(8),
      projectedAt: "2026-08-11T14:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference,
        orderNumber,
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-08-11T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "Synthetic tea",
                quantity: 1,
                lineTotal: { amountMinor, currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            {
              orderBatchReference: id(3),
              status: "InProgress",
              updatedAt: "2026-08-11T13:59:00.000Z",
            },
          ],
        },
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-08-11T13:56:00.000Z",
            amount: { amountMinor, currencyCode: "CAD" },
            freshnessStatus: "Fresh",
          },
        ],
      },
    },
  };
}

test.describe("@production order status HTTP continuity", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test("keeps current order identity and clears data after revoked access", async ({ page }) => {
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
    let firstCalls = 0;
    let revoke = false;
    let releaseOld: (() => void) | undefined;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route("**/api/v1/orders/*/status", async (route) => {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      expect(route.request().method()).toBe("GET");
      if (route.request().url().includes(id(1))) {
        firstCalls += 1;
        if (firstCalls === 2) await oldResponse;
        await route.fulfill({ json: status(id(1), "1001", "2598") });
      } else if (revoke) await route.fulfill({ status: 403, json: { schemaVersion: 1 } });
      else {
        const partial = status(id(2), "1002", "1299");
        const first = partial.status.order.batches[0];
        const kitchen = partial.status.sources.kitchen.batches[0];
        if (!first || !kitchen) throw new Error("fixture");
        partial.status.order.orderType = "DineIn";
        partial.status.order.batches.push({
          ...first,
          orderBatchReference: id(30),
          items: first.items.map((item) => ({ ...item, orderItemReference: id(31) })),
        });
        kitchen.status = "Ready";
        await route.fulfill({
          json: {
            ...partial,
            status: {
              ...partial.status,
              sources: {
                ...partial.status.sources,
                dining: {
                  items: partial.status.order.batches.flatMap((batch, index) =>
                    batch.items.map((item) => ({
                      orderItemReference: item.orderItemReference,
                      orderBatchReference: batch.orderBatchReference,
                      servedQuantity: index === 0 ? 1 : 0,
                    })),
                  ),
                },
              },
            },
          },
        });
      }
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    // Same-document navigation, as in checkout-continuity, retains the real Entry CSRF context.
    const navigate = async (reference: string) =>
      page.evaluate((reference) => {
        history.pushState(null, "", "/orders/" + reference);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, reference);
    await navigate(id(1));
    await expect(page.getByText("Payment received: CAD 25.98", { exact: true })).toBeVisible();
    await expect(page.getByText("Preparing", { exact: true })).toHaveCount(2);
    await expect(
      page.getByRole("heading", { name: "Preparing your order", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect.poll(() => firstCalls).toBe(2);
    await navigate(id(2));
    await expect(page.getByText("Payment received: CAD 12.99", { exact: true })).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/^Served 1 of /)).toBeVisible();
    await expect(page.getByText(/^Served 0 of /)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Serving your order", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Preparing", { exact: true })).toHaveCount(1);
    await expect(
      page
        .getByRole("region", { name: "Order batches" })
        .getByText("Not available yet", { exact: true }),
    ).toBeVisible();
    const response = page.waitForResponse(
      (response) => response.url().includes(id(1)) && response.url().endsWith("/status"),
    );
    if (!releaseOld) throw new Error("missing response gate");
    releaseOld();
    await response;
    await expect(page.getByText("Payment received: CAD 25.98", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Payment received: CAD 12.99", { exact: true })).toBeVisible();
    revoke = true;
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Order access denied", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Payment received: CAD 12.99", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });
});

import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import {
  v15PickupOrderReference,
  v15PickupStatusBody,
} from "../src/order-status/v15-pickup-status.fixture";

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
    await expect(page.getByText("Payment received $25.98", { exact: true })).toBeVisible();
    await expect(page.getByText("Preparing", { exact: true })).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Preparing your order", exact: true }),
    ).toBeVisible();
    await expectNoInternalText(page);
    await page.getByRole("button", { name: "Refresh now", exact: true }).click();
    await expect.poll(() => firstCalls).toBe(2);
    await navigate(id(2));
    await expect(page.getByText("Payment received $12.99", { exact: true })).toBeVisible();
    // WP-2423: a round that has been served says so, not the kitchen's earlier "Ready".
    await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Served", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/^Served 1 of /)).toBeVisible();
    await expect(page.getByText(/^Served 0 of /)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Serving your order", exact: true }),
    ).toBeVisible();
    // The kitchen summary covers the round still to be made, which it hasn't started.
    await expect(page.getByText("Preparing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("In the queue", { exact: true })).toHaveCount(1);
    await expect(
      page
        .getByRole("region", { name: "Ordered at your table" })
        .getByText("Not started yet", { exact: true }),
    ).toBeVisible();
    // v15 8c4480dd M1: a dine-in order is the table's, with every guest's rounds.
    await expect(
      page.getByText("Every round at your table, from you and the other guests.", { exact: true }),
    ).toBeVisible();
    await expectNoInternalText(page);
    const response = page.waitForResponse(
      (response) => response.url().includes(id(1)) && response.url().endsWith("/status"),
    );
    if (!releaseOld) throw new Error("missing response gate");
    releaseOld();
    await response;
    await expect(page.getByText("Payment received $25.98", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Payment received $12.99", { exact: true })).toBeVisible();
    revoke = true;
    await page.getByRole("button", { name: "Refresh now", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Your visit on this phone has ended", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Payment received $12.99", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

  test("46940b76 L4: a pickup cancelled item by item and then in full states every refund and the tip", async ({
    page,
  }) => {
    const csrf = "d".repeat(43);
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
    const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
    const body = status(id(23), "23", "537");
    body.status.order.canonicalPhase = "Cancelled";
    const [batch] = body.status.order.batches;
    if (batch === undefined) throw new Error("fixture");
    batch.items = [
      { orderItemReference: id(4), displayName: "Mocha", quantity: 1, lineTotal: cad("537") },
      { orderItemReference: id(5), displayName: "Latte", quantity: 1, lineTotal: cad("486") },
      { orderItemReference: id(7), displayName: "Tea", quantity: 1, lineTotal: cad("553") },
    ];
    const sources = {
      ...body.status.sources,
      kitchen: null,
      payments: [
        {
          status: "Succeeded",
          occurredAt: "2026-08-11T13:56:00.000Z",
          amount: cad("1785"),
          freshnessStatus: "Fresh",
        },
      ],
      itemCancellations: [
        {
          orderBatchReference: id(3),
          orderItemReferences: [id(4)],
          cancelledAt: "2026-08-11T13:57:00.000Z",
          reason: "SoldOut",
          refundStatus: "Refunded",
          refundAmount: cad("608"),
        },
      ],
      staffCancellations: [
        {
          orderBatchReference: id(3),
          cancelledAt: "2026-08-11T13:58:00.000Z",
          reason: "SoldOut",
          refundStatus: "Refunded",
        },
      ],
      refunds: {
        refunded: cad("1785"),
        entries: [
          {
            kind: "ItemCancellation",
            orderItemReferences: [id(4)],
            total: cad("608"),
            tip: cad("71"),
          },
          {
            kind: "RoundRefund",
            orderItemReferences: [id(5), id(7)],
            total: cad("1177"),
            tip: cad("138"),
          },
        ],
      },
    };
    await page.route("**/api/v1/orders/*/status", (route) =>
      route.fulfill({
        headers: { "cache-control": "no-store" },
        json: { ...body, status: { ...body.status, sources } },
      }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(23));
    const main = page.getByRole("main");
    // v15 8c4480dd L2: each item shows its price with tax the same way (the item cancelled on its
    // own no longer shows its refund with its tip share); the tip is in the refund sentences.
    await expect(main.getByText("Cancelled · Refunded $5.37")).toBeVisible();
    await expect(main.getByText("Cancelled · Refunded $6.08")).toHaveCount(0);
    await expect(main.getByText("Cancelled · Refunded $4.86")).toBeVisible();
    await expect(main.getByText("Cancelled · Refunded $5.53")).toBeVisible();
    await expect(
      main.getByText(
        "Refund: $6.08 returned to your original payment, including $0.71 of the tip.",
      ),
    ).toBeVisible();
    await expect(
      main.getByText(
        "Refund: $11.77 returned to your original payment, including $1.38 of the tip.",
      ),
    ).toBeVisible();
    await expectNoInternalText(page);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-store-cancelled-refunds-${viewport.width}.png`,
        fullPage: true,
      });
    }
  });

  test("renders the unavailable state cleanly at desktop and compact widths", async ({ page }) => {
    const csrf = "d".repeat(43);
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
    await page.route("**/api/v1/orders/*/status", async (route) => {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ status: 503, json: { schemaVersion: 1 } });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(99));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Order status isn’t available" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Try loading status" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Back to menu" })).toBeVisible();
    await expect(main).not.toContainText("Synthetic tea");
    const card = main.locator(".order-status__unavailable");
    await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const button = await main.getByRole("button", { name: "Try loading status" }).boundingBox();
      const cardBox = await card.boundingBox();
      const backBox = await main.getByRole("link", { name: "Back to menu" }).boundingBox();
      expect(button?.height).toBeGreaterThanOrEqual(44);
      expect(cardBox).not.toBeNull();
      expect(backBox?.y).toBeGreaterThanOrEqual((cardBox?.y ?? 0) + (cardBox?.height ?? 0));
      if (viewport.width <= 390 && button && cardBox) {
        expect(button.width).toBeGreaterThanOrEqual(cardBox.width - 64);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-unavailable-${viewport.width}.png`,
        fullPage: true,
      });
    }
  });

  test("renders the source-supported loaded view at desktop and compact widths", async ({
    page,
  }) => {
    const csrf = "f".repeat(43);
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
    await page.route("**/api/v1/orders/*/status", async (route) => {
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      expect(route.request().method()).toBe("GET");
      // WP-2423 D5: the item's frozen price before tax and its tax ($23.00 + $2.98 = $25.98).
      const body = status(id(1), "1001", "2598");
      Object.assign(body.status.sources, {
        itemPrices: [
          {
            orderItemReference: id(4),
            subtotal: { amountMinor: "2300", currencyCode: "CAD" },
            tax: { amountMinor: "298", currencyCode: "CAD" },
          },
        ],
      });
      await route.fulfill({ json: body });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Preparing your order" })).toBeVisible();
    await expect(main.getByText("Payment received $25.98", { exact: true })).toBeVisible();
    await expect(main).not.toContainText(/\bPaid\b/u);
    await expect(main.getByText("Synthetic tea", { exact: false })).toBeVisible();
    // WP-2423 D5: the item at its price before tax, then subtotal, tax and the total paid.
    await expect(main.locator(".order-status__item-amount").first()).toHaveText("$23.00");
    await expect(main.locator(".order-status__money")).toContainText("Subtotal$23.00");
    await expect(main.locator(".order-status__money")).toContainText("Tax$2.98");
    await expect(main.locator(".order-status__total")).toHaveText("Total$25.98");
    await expect(main).not.toContainText("Items total");
    await expect(main).not.toContainText("Estimated time");
    await expect(main.getByRole("link", { name: "View receipt and support" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Refresh now" })).toBeVisible();
    await expect(main).not.toContainText(/paid in full|\bETA\s*\d/i);
    await expectNoInternalText(page);

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const summary = main.locator(".order-status__summary");
      const batch = main.locator(".order-status__batch").first();
      const summaryBox = await summary.boundingBox();
      const batchBox = await batch.boundingBox();
      expect(summaryBox).not.toBeNull();
      expect(batchBox?.y).toBeGreaterThanOrEqual((summaryBox?.y ?? 0) + (summaryBox?.height ?? 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-ready-${viewport.width}.png`,
        fullPage: true,
      });
    }
  });

  test("WP-2423 Q26: tells the customer to wait while part of a ready pickup is remade", async ({
    page,
  }) => {
    const csrf = "g".repeat(43);
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
    await page.route("**/api/v1/orders/*/status", async (route) => {
      const body = status(id(1), "1001", "2598");
      const kitchenBatch = body.status.sources.kitchen.batches[0];
      if (kitchenBatch) kitchenBatch.status = "Ready";
      await route.fulfill({
        json: {
          ...body,
          status: {
            ...body.status,
            sources: {
              ...body.status.sources,
              remakes: [{ orderItemReference: id(4), quantity: 1 }],
            },
          },
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Remaking part of your order" })).toBeVisible();
    await expect(main.getByText("Being remade", { exact: true })).toBeVisible();
    await expect(main).not.toContainText("Your order is ready. Show your pickup code");
    await expectNoInternalText(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-remake-${width}.png`,
        fullPage: true,
      });
    }
  });

  // DEC-PILOT-BATCH-PHASE-01: a dine-in Order is Fulfilled once every remaining item was served
  // (Dining's served quantities); the table can still order another round, so checks continue.
  test("WP-2423: a fully served dine-in order reads served and keeps checking for updates", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const csrf = "s".repeat(43);
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
    let calls = 0;
    await page.route("**/api/v1/orders/*/status", async (route) => {
      calls += 1;
      const body = status(id(1), "1001", "2598");
      body.status.order.orderType = "DineIn";
      body.status.order.canonicalPhase = "Fulfilled";
      const kitchenBatch = body.status.sources.kitchen.batches[0];
      if (kitchenBatch) kitchenBatch.status = "Ready";
      await route.fulfill({
        json: {
          ...body,
          status: {
            ...body.status,
            sources: {
              ...body.status.sources,
              dining: {
                items: [
                  { orderItemReference: id(4), orderBatchReference: id(3), servedQuantity: 1 },
                ],
              },
            },
          },
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Items served" })).toBeVisible();
    await expect(main.getByText("This page checks for updates every few seconds.")).toBeVisible();
    await expect(main).not.toContainText("This order is complete.");
    await expect(main).not.toContainText("Thank you for visiting");
    await expectNoInternalText(page);
    await expect.poll(() => calls, { timeout: 25_000 }).toBeGreaterThan(1);
  });

  // WP-2423 (DEC-PICKUP-COUNTER-CODE): the guest reads a six-digit code to staff.
  test("WP-2423: shows the six-digit pickup code large once the order is ready", async ({
    page,
  }) => {
    const csrf = "h".repeat(43);
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
    await page.route("**/api/v1/orders/*/status", async (route) => {
      const body = status(id(1), "1001", "2598");
      const kitchenBatch = body.status.sources.kitchen.batches[0];
      if (kitchenBatch) kitchenBatch.status = "Ready";
      await route.fulfill({ json: body });
    });
    const longCode = "AbCdEfGhIjKlMnOpQrStUQ";
    await page.route("**/api/v1/orders/*/pickup-code", (route) =>
      route.fulfill({
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          status: "Ready",
          orderReference: id(1),
          orderNumber: "1001",
          storeDisplayName: "Synthetic Status Store",
          pickupInstruction: "Show this code at the pickup counter.",
          generation: 1,
          proofKind: "Opaque",
          proofValue: longCode,
          counterCode: "048213",
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByText("048 213", { exact: true })).toBeVisible();
    // Screen readers hear the code digit by digit; the large code itself is hidden from them.
    await expect(
      main.getByText("Order 1001. Pickup code 0 4 8 2 1 3", { exact: true }),
    ).toHaveCount(1);
    await expect(main.locator(".pickup-code__visual--short")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(main).not.toContainText(longCode);
    await expect(main).toContainText("Show or read this code to staff");
    await expectNoInternalText(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-pickup-code-${width}.png`,
        fullPage: true,
      });
    }
  });

  // WP-2423: a ready order whose code window ended (or never had a code) still reads as ready.
  test("WP-2423: tells the guest a ready order without a code is ready and how to collect it", async ({
    page,
  }) => {
    const csrf = "j".repeat(43);
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
    await page.route("**/api/v1/orders/*/status", async (route) => {
      const body = status(id(1), "1001", "2598");
      const kitchenBatch = body.status.sources.kitchen.batches[0];
      if (kitchenBatch) kitchenBatch.status = "Ready";
      await route.fulfill({ json: body });
    });
    let reason = "CodeUnavailable";
    await page.route("**/api/v1/orders/*/pickup-code", (route) =>
      route.fulfill({
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          status: "ReadyWithoutCode",
          orderReference: id(1),
          orderNumber: "1001",
          reason,
        },
      }),
    );
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(
      main.getByText(
        "Your order is ready. Show your order number at the counter — staff will check your name or phone number.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(main.locator(".pickup-code code")).toHaveText("1001");
    await expect(main).not.toContainText("isn’t ready");
    await expect(main).not.toContainText("Show your pickup code");
    await expectNoInternalText(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/order-status-ready-without-code-${width}.png`,
        fullPage: true,
      });
    }
    // An order staff took at the counter says so plainly.
    reason = "CounterOrder";
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    await expect(
      main.getByText("Your order is ready at the counter.", { exact: true }),
    ).toBeVisible();
    await expect(main).not.toContainText("isn’t ready");
    await expectNoInternalText(page);
  });

  // v15 2026-10-16: right after paying, the order's status can arrive a few seconds after the
  // order itself. The guest sees "Order received" (never "can't show this order") until it does.
  test("WP-2423: says a just-paid order was received and shows its status as soon as it arrives", async ({
    page,
  }) => {
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
          csrfToken: "h".repeat(43),
        },
      }),
    );
    let reads = 0;
    await page.route("**/api/v1/orders/*/status", async (route) => {
      reads += 1;
      if (reads <= 2)
        await route.fulfill({
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            received: {
              orderReference: id(1),
              orderNumber: "1001",
              orderType: "Pickup",
              submittedAt: "2026-08-11T13:55:00.000Z",
              checkedAt: new Date().toISOString(),
            },
          },
        });
      else await route.fulfill({ json: status(id(1), "1001", "2598") });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Order received" })).toBeVisible();
    await expect(main).toContainText("Order 1001 is in");
    await expect(main).not.toContainText("can’t show this order");
    await expect(main).not.toContainText("can’t show this order");
    await expectNoInternalText(page);
    // The page checks again by itself every couple of seconds; no tap needed.
    await expect(main.getByText("Synthetic tea")).toBeVisible({ timeout: 6_000 });
    await expect(main.getByRole("heading", { name: "Order received" })).toHaveCount(0);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  // v15 2026-10-16: once the order is ready, the code is checked every second until it is issued,
  // so it shows about a second after staff mark the order ready instead of ~4 s later.
  test("WP-2423: shows the pickup code within about a second of it being issued", async ({
    page,
  }) => {
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
          csrfToken: "h".repeat(43),
        },
      }),
    );
    await page.route("**/api/v1/orders/*/status", async (route) => {
      const body = status(id(1), "1001", "2598");
      const kitchenBatch = body.status.sources.kitchen.batches[0];
      if (kitchenBatch) kitchenBatch.status = "Ready";
      await route.fulfill({ json: body });
    });
    let issuedAt: number | null = null;
    let codeReads = 0;
    await page.route("**/api/v1/orders/*/pickup-code", (route) => {
      codeReads += 1;
      // The first check finds the code still being issued; it exists from then on.
      if (codeReads === 1) {
        issuedAt = Date.now();
        return route.fulfill({
          headers: { "cache-control": "no-store" },
          json: {
            schemaVersion: 1,
            status: "ReadyWithoutCode",
            orderReference: id(1),
            orderNumber: "1001",
            reason: "CodePending",
          },
        });
      }
      return route.fulfill({
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          status: "Ready",
          orderReference: id(1),
          orderNumber: "1001",
          storeDisplayName: "Synthetic Status Store",
          pickupInstruction: "Show this code at the pickup counter.",
          generation: 1,
          proofKind: "Opaque",
          proofValue: "AbCdEfGhIjKlMnOpQrStUQ",
          counterCode: "048213",
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id(1));
    const main = page.getByRole("main");
    await expect(main.getByText("048 213", { exact: true })).toBeVisible({ timeout: 5_000 });
    expect(issuedAt).not.toBeNull();
    // Shown on the first follow-up (one second), well before the old 2 s + 3 s backoff.
    expect(Date.now() - (issuedAt ?? 0)).toBeLessThan(2_500);
    expect(codeReads).toBeGreaterThanOrEqual(2);
  });

  // v15 2026-10-17: the pilot keeps the order phase at Submitted while the kitchen works; the page
  // read that as "not accepted" and checked every 15 s, so Ready showed 13 s after the kitchen
  // finished. Bodies below are the shape the pilot sends (see v15-pickup-status.fixture.ts).
  test("WP-2423: shows a pilot pickup ready within seconds of the kitchen finishing, with no tap before", async ({
    page,
  }) => {
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
          csrfToken: "h".repeat(43),
        },
      }),
    );
    let readyAt: number | null = null;
    let reads = 0;
    await page.route("**/api/v1/orders/*/status", async (route) => {
      reads += 1;
      // The kitchen finishes just after the guest's second check.
      if (reads === 2) readyAt = Date.now() + 200;
      const finished = readyAt !== null && Date.now() >= readyAt;
      await route.fulfill({
        headers: { "cache-control": "no-store" },
        json: v15PickupStatusBody(finished ? "ready" : reads === 1 ? "queued" : "preparing"),
      });
    });
    let codeReads = 0;
    await page.route("**/api/v1/orders/*/pickup-code", (route) => {
      codeReads += 1;
      return route.fulfill({
        headers: { "cache-control": "no-store" },
        json: {
          schemaVersion: 1,
          status: "Ready",
          orderReference: v15PickupOrderReference,
          orderNumber: "17",
          storeDisplayName: "Synthetic Status Store",
          pickupInstruction: "Show this code at the pickup counter.",
          generation: 1,
          proofKind: "Opaque",
          proofValue: "AbCdEfGhIjKlMnOpQrStUQ",
          counterCode: "048213",
          observedAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, v15PickupOrderReference);
    const main = page.getByRole("main");
    await expect(main).toContainText("In the queue");
    // Before the order is ready there is nothing to tap and no code is asked for.
    await expect(main).toContainText(
      "Your pickup code appears here as soon as your order is ready.",
    );
    await expect(main.getByRole("button", { name: "Show pickup code" })).toHaveCount(0);
    expect(codeReads).toBe(0);
    await expect(main.getByText("048 213", { exact: true })).toBeVisible({ timeout: 8_000 });
    expect(readyAt).not.toBeNull();
    // One 3 s check plus the code read, against up to 15 s before.
    expect(Date.now() - (readyAt ?? 0)).toBeLessThan(5_000);
    await expectNoInternalText(page);
  });

  // v15 ac46bf22 (2026-10-17): a paid pickup waiting for the Store was checked every 15 s, so
  // "Order accepted" showed up to 15 s after the Store accepted. It is now checked every 5 s.
  test("WP-2423: shows a paid pilot pickup accepted within about 5 s of the Store accepting", async ({
    page,
  }) => {
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
          csrfToken: "h".repeat(43),
        },
      }),
    );
    let acceptedAt: number | null = null;
    let reads = 0;
    await page.route("**/api/v1/orders/*/status", async (route) => {
      reads += 1;
      // The Store accepts just after the guest's first check.
      if (reads === 1) acceptedAt = Date.now() + 200;
      const accepted = acceptedAt !== null && Date.now() >= acceptedAt;
      // Since the phase resolver (v15 live run of ac46bf22) the status API reads Accepted once the
      // Store accepts; before that it is Submitted with no kitchen ticket.
      const body = v15PickupStatusBody(accepted ? "queued" : "awaiting-acceptance");
      if (accepted) body.status.order.canonicalPhase = "Accepted";
      await route.fulfill({ headers: { "cache-control": "no-store" }, json: body });
    });
    await page.goto("/#qr=aaa.bbb.ccc");
    await expect(
      page.getByRole("heading", { name: "Synthetic Status Store", exact: true }),
    ).toBeVisible();
    await page.evaluate((reference) => {
      history.pushState(null, "", "/orders/" + reference);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, v15PickupOrderReference);
    const main = page.getByRole("main");
    await expect(main).toContainText("Order submitted");
    await expect(main).toContainText("Order accepted", { timeout: 8_000 });
    expect(acceptedAt).not.toBeNull();
    // One 5 s check, against up to 15 s before.
    expect(Date.now() - (acceptedAt ?? 0)).toBeLessThan(6_500);
    expect(reads).toBe(2);
    await expectNoInternalText(page);
  });
});

import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 DEC-STORE-CUSTOMER-NAME synthetic HTTP evidence for the production App: after the Owner
// renames the Store, the restored session, the order page (header and "Contact the store"), the
// pickup panel and a newly issued receipt all show the one published name; a receipt issued
// before the rename keeps the name it was issued with. TEST-ONLY values; no live Store.
const id = (n: number) => "018f8816-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const orderReference = id(1);
const renamed = "Maple Noodle House";
const previous = "DEMO Store - not production";
const json = { "content-type": "application/json", "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

function status() {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(8),
      projectedAt: "2026-10-15T14:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference,
        orderNumber: "12",
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-10-15T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(9),
            submittedAt: "2026-10-15T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(10),
                displayName: "Synthetic bowl",
                quantity: 1,
                lineTotal: money("1130"),
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: "2026-10-15T14:00:00.000Z",
        kitchen: {
          batches: [
            { orderBatchReference: id(9), status: "Ready", updatedAt: "2026-10-15T13:59:00.000Z" },
          ],
        },
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-10-15T13:56:00.000Z",
            amount: money("1130"),
            freshnessStatus: "Fresh",
          },
        ],
        storeContact: {
          phone: "+14165550199",
          addressLines: ["200 Example Street", "Unit 4"],
          locality: "Exampleville",
          regionCode: "ON",
          postalCode: "A1A 1A1",
        },
      },
    },
  };
}

function receipt(storeDisplayName: string) {
  return {
    schemaVersion: 1,
    receipt: {
      orderReference,
      freshnessStatus: "Stale",
      deliveryStatus: "Unavailable",
      supportEligible: false,
      cancellationEligible: false,
      records: [
        {
          recordReference: id(2),
          version: 1,
          kind: "Original",
          recordedAt: "2026-10-15T14:00:00.000Z",
          reasonCode: null,
          snapshot: {
            receiptReference: id(3),
            operatingEntityDisplayName: "Synthetic Issuer Ltd. (TEST-ONLY)",
            storeDisplayName,
            orderNumber: "12",
            issuedAt: "2026-10-15T14:00:00.000Z",
            locale: "en-CA",
            lines: [
              {
                lineReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 1,
                lineTotal: money("1130"),
                lineSubtotal: money("1000"),
              },
            ],
            subtotal: money("1000"),
            tax: money("130"),
            taxDetails: {
              businessAddress: {
                addressLines: ["200 Example Street", "Unit 4"],
                locality: "Exampleville",
                regionCode: "ON",
                postalCode: "A1A 1A1",
                countryCode: "CA",
              },
              taxRegistrations: [],
              taxLines: [
                { label: "HST", ratePercent: "13", included: false, amount: money("130") },
              ],
              paymentMethod: "Card",
            },
            tip: money("0"),
            total: money("1130"),
            paymentStatus: "Paid",
            refundedTotal: money("0"),
          },
        },
      ],
    },
  };
}

async function renamedSession(page: Page) {
  // The restored session names the Store from its current published profile.
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      body: JSON.stringify({
        schemaVersion: 1,
        csrfToken: csrf,
        menuContext: {
          publicStoreReference: id(6),
          channel: "Pickup",
          locale: "en-CA",
          brandDisplayName: "Synthetic Brand",
          storeDisplayName: renamed,
        },
      }),
    }),
  );
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`@production WP-2423 one store name after a rename at ${viewport.width}px`, () => {
    test.use({ viewport, serviceWorkers: "block" });

    test("the order page, its contact card and the pickup panel show the published name", async ({
      page,
    }) => {
      await renamedSession(page);
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(status()) }),
      );
      await page.route("**/api/v1/orders/*/pickup-code", (route) =>
        route.fulfill({
          headers: json,
          body: JSON.stringify({
            schemaVersion: 1,
            status: "Ready",
            orderReference,
            orderNumber: "12",
            storeDisplayName: renamed,
            pickupInstruction: "Show this code at the pickup counter.",
            generation: 1,
            proofKind: "Opaque",
            proofValue: "AbCdEfGhIjKlMnOpQrStUQ",
            counterCode: "048213",
            observedAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
        }),
      );
      await page.goto("/orders/" + orderReference);
      const main = page.getByRole("main");
      await expect(main.getByText("048 213", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: renamed, exact: true }).first()).toBeVisible();
      // Pickup panel and "Contact the store" use the same name as the page header.
      await expect(page.locator(".pickup-code h3")).toHaveText(renamed);
      await expect(main.getByText("200 Example Street")).toBeVisible();
      const names = await page.evaluate(() => document.body.innerText);
      expect(names).not.toContain("DEMO Store");
      expect(names.split(renamed).length - 1).toBeGreaterThanOrEqual(3);
      await expectNoInternalText(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
    });

    test("a new receipt carries the published name; one issued before keeps its own", async ({
      page,
    }) => {
      await renamedSession(page);
      let issued = renamed;
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(receipt(issued)) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      const merchant = page.getByRole("region", { name: "Merchant and order" });
      await expect(merchant.getByText(renamed, { exact: true })).toBeVisible();
      await expectNoInternalText(page);

      issued = previous;
      await page.reload();
      // The issued document is never rewritten: it shows the name it was issued with.
      await expect(merchant.getByText(previous, { exact: true })).toBeVisible();
      await expect(merchant.getByText(renamed, { exact: true })).toHaveCount(0);
    });
  });
}

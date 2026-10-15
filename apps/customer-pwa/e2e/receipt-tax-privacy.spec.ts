import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// WP-2423 Q15/Q16 synthetic HTTP evidence for the production App: the tax receipt (address,
// registration, one line per tax and rate), the Store's privacy notice link where contact details
// are collected and on the receipt, and the customer's own contact removal. TEST-ONLY values; no
// live Store, registration or Provider.
const id = (n: number) => "018f8815-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "c".repeat(43);
const orderReference = id(1);
const privacyNoticeUrl = "https://example.test/privacy";
const json = { "content-type": "application/json", "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const menuContext = {
  publicStoreReference: id(6),
  channel: "Pickup",
  locale: "en-CA",
  brandDisplayName: "Synthetic Brand",
  storeDisplayName: "Synthetic Receipt Store",
};

function receipt(withPrivacy: boolean) {
  return {
    schemaVersion: 1,
    receipt: {
      orderReference,
      freshnessStatus: "Stale",
      deliveryStatus: "Unavailable",
      supportEligible: false,
      cancellationEligible: false,
      ...(withPrivacy ? { privacyNoticeUrl } : {}),
      records: [
        {
          recordReference: id(2),
          version: 1,
          kind: "Original",
          recordedAt: "2026-10-14T14:00:00.000Z",
          reasonCode: null,
          snapshot: {
            receiptReference: id(3),
            operatingEntityDisplayName: "Synthetic Issuer Ltd. (TEST-ONLY)",
            storeDisplayName: "Synthetic Receipt Store",
            orderNumber: "12",
            issuedAt: "2026-10-14T14:00:00.000Z",
            locale: "en-CA",
            lines: [
              {
                lineReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 1,
                lineTotal: money("1000"),
              },
            ],
            subtotal: money("1000"),
            tax: money("130"),
            taxDetails: {
              businessAddress: {
                addressLines: ["1 Test-only Street"],
                locality: "Toronto",
                regionCode: "ON",
                postalCode: "M5V 0A0",
                countryCode: "CA",
              },
              taxRegistrations: withPrivacy
                ? [{ label: "GST/HST", number: "000000000RT0001" }]
                : [],
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

function status(contactDetails: "Stored" | "Removed") {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(8),
      projectedAt: "2026-10-14T14:00:00.000Z",
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
        submittedAt: "2026-10-14T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(9),
            submittedAt: "2026-10-14T13:55:00.000Z",
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
        checkedAt: "2026-10-14T14:00:00.000Z",
        kitchen: null,
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-10-14T13:56:00.000Z",
            amount: money("1130"),
            freshnessStatus: "Fresh",
          },
        ],
        contactDetails,
        privacyNoticeUrl,
      },
    },
  };
}

async function bootstrap(page: Page) {
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      status: 200,
      headers: json,
      body: JSON.stringify({ schemaVersion: 1, csrfToken: csrf, menuContext }),
    }),
  );
}
async function noOverflowOrBlockingAxe(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
}

async function checkout(page: Page, withPrivacy: boolean) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Checkout Store",
        publicStoreReference: id(6),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: csrf,
      },
    }),
  );
  await page.route("**/bff/customer/cart", (route) =>
    route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(11),
          version: 3,
          orderType: "Pickup",
          serviceMode: "Pickup",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Checkout Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(12),
              sellableReference: id(13),
              displayName: "Synthetic tea",
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
              warnings: [],
            },
          ],
          quote: null,
          warnings: [],
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(11), cartVersion: 3, orderType: "Pickup", details: null },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/policy", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(11),
          cartVersion: 3,
          orderType: "Pickup",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
          ...(withPrivacy ? { privacyNoticeUrl } : {}),
        },
      },
    }),
  );
  await page.route("**/api/v1/carts/*/quote", (route) =>
    route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(14),
          quoteVersion: 1,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: "100", currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "13", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: "113", currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          priceChange: null,
        },
      },
    }),
  );
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Checkout Store", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/checkout");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: "Checkout", exact: true })).toBeVisible();
  await expect(page.getByText(/only to contact you about this order/u)).toBeVisible();
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`@production WP-2423 Q15/Q16 receipt and privacy at ${viewport.width}px`, () => {
    test.use({ viewport, serviceWorkers: "block" });

    test("the receipt shows address, registration, each tax with its rate, and the privacy link", async ({
      page,
    }) => {
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(receipt(true)) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      const merchant = page.getByRole("region", { name: "Merchant and order" });
      await expect(merchant.getByText("Synthetic Issuer Ltd. (TEST-ONLY)")).toBeVisible();
      await expect(merchant.getByText("1 Test-only Street")).toBeVisible();
      await expect(merchant.getByText("Toronto, ON M5V 0A0", { exact: true })).toBeVisible();
      await expect(
        merchant.getByText("GST/HST registration no. 000000000RT0001", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("HST 13%", { exact: true })).toBeVisible();
      await expect(page.getByText("Card · Paid", { exact: true })).toBeVisible();
      const link = page.getByRole("link", { name: /Privacy notice/u });
      await expect(link).toHaveAttribute("href", privacyNoticeUrl);
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });

    test("without registration or privacy link the receipt prints neither", async ({ page }) => {
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(receipt(false)) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      await expect(page.getByText("HST 13%", { exact: true })).toBeVisible();
      await expect(page.getByText(/registration no\./u)).toHaveCount(0);
      await expect(page.getByRole("link", { name: /Privacy notice/u })).toHaveCount(0);
    });

    test("checkout links the privacy notice where contact details are collected", async ({
      page,
    }) => {
      await checkout(page, true);
      const hint = page.getByText(/only to contact you about this order/u);
      await expect(hint).toContainText("deleted 30 days after your order");
      await expect(hint.getByRole("link", { name: /Privacy notice/u })).toHaveAttribute(
        "href",
        privacyNoticeUrl,
      );
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });

    test("checkout shows no privacy link until the Owner enters one", async ({ page }) => {
      await checkout(page, false);
      await expect(page.getByRole("link", { name: /Privacy notice/u })).toHaveCount(0);
    });

    test("the customer removes their contact details from the order page", async ({ page }) => {
      await bootstrap(page);
      let removed = false;
      const removals: Record<string, string>[] = [];
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({
          headers: json,
          body: JSON.stringify(status(removed ? "Removed" : "Stored")),
        }),
      );
      await page.route("**/api/v1/orders/*/contact-removal", (route) => {
        removals.push(route.request().headers());
        expect(route.request().method()).toBe("POST");
        removed = true;
        return route.fulfill({
          headers: json,
          body: JSON.stringify({ schemaVersion: 1, removal: { status: "Removed" } }),
        });
      });
      await page.goto("/orders/" + orderReference);
      const section = page.getByRole("region", { name: "Your contact details" });
      await expect(section.getByText(/only to contact you about this order/u)).toBeVisible();
      await expect(section.getByText(/30 days after your order/u)).toBeVisible();
      await expect(section.getByRole("link", { name: /Privacy notice/u })).toHaveAttribute(
        "href",
        privacyNoticeUrl,
      );
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
      await section.getByRole("button", { name: "Remove my contact details" }).click();
      await expect(section.getByText(/won't be able to call or email you/u)).toBeVisible();
      await section.getByRole("button", { name: "Keep them" }).click();
      expect(removals).toHaveLength(0);
      await section.getByRole("button", { name: "Remove my contact details" }).click();
      await section.getByRole("button", { name: "Remove now" }).click();
      // One sentence after removal, not the action message and the refreshed state together.
      await expect(
        section.getByText("Your contact details have been removed from this order."),
      ).toBeVisible();
      await expect(section.getByText(/removed from this order/u)).toHaveCount(1);
      await expect(section.getByRole("button", { name: "Remove my contact details" })).toHaveCount(
        0,
      );
      expect(removals).toHaveLength(1);
      expect(removals[0]?.["x-csrf-token"]).toBe(csrf);
      await noOverflowOrBlockingAxe(page);
    });

    test("a repeat removal says the details were already removed", async ({ page }) => {
      // The page still shows the details as kept (for example opened before another tab removed
      // them); the server finds them already gone and changes nothing.
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(status("Stored")) }),
      );
      await page.route("**/api/v1/orders/*/contact-removal", (route) =>
        route.fulfill({
          headers: json,
          body: JSON.stringify({ schemaVersion: 1, removal: { status: "AlreadyRemoved" } }),
        }),
      );
      await page.goto("/orders/" + orderReference);
      const section = page.getByRole("region", { name: "Your contact details" });
      await section.getByRole("button", { name: "Remove my contact details" }).click();
      await section.getByRole("button", { name: "Remove now" }).click();
      await expect(
        section.getByText(
          "Your contact details had already been removed from this order. There is nothing more to remove.",
        ),
      ).toBeVisible();
      await expect(section.getByText(/removed from this order/u)).toHaveCount(1);
      await expect(section.getByRole("button", { name: "Remove my contact details" })).toHaveCount(
        0,
      );
      await noOverflowOrBlockingAxe(page);
    });
  });
}

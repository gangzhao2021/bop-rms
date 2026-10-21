import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

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
                // WP-2423 D5: the frozen total after tax, and the price before tax that is printed.
                lineTotal: money("1130"),
                lineSubtotal: money("1000"),
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
      // WP-2423 D5: the item is printed before tax and adds up to the subtotal; tax then total.
      const line = page.locator(".receipt-page__lines li").first();
      await expect(line).toHaveText("1 × Synthetic bowl$10.00");
      await expect(page.locator(".receipt-page__totals div", { hasText: "Subtotal" })).toHaveText(
        "Subtotal$10.00",
      );
      await expect(page.locator(".receipt-page__totals div", { hasText: /^Total/u })).toHaveText(
        "Total$11.30",
      );
      await expect(page.getByText("already include tax")).toHaveCount(0);
      // Amounts stay on one line at phone width.
      const amount = page.locator(".receipt-page__totals div", { hasText: "HST" }).locator("dd");
      const box = await amount.boundingBox();
      expect(box?.height ?? 0).toBeLessThan(30);
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

    test("the receipt and the order page list each item's chosen options with their prices", async ({
      page,
    }) => {
      // WP-2423: the item price already includes its options, so the items still add up to the
      // subtotal; a free option prints its name only. TEST-ONLY item and option names.
      const options = [
        { displayName: "Whipped cream", quantity: 1, amount: money("50") },
        { displayName: "Oat milk", quantity: 1, amount: money("0") },
      ];
      const issued = receipt(true);
      const issuedLine = issued.receipt.records[0]?.snapshot.lines[0];
      if (!issuedLine) throw new Error("fixture");
      Object.assign(issuedLine, { displayName: "TEST Hot Chocolate", options });
      const current = status("Stored");
      Object.assign(current.status.sources, {
        itemPrices: [
          {
            orderItemReference: id(10),
            subtotal: money("1000"),
            tax: money("130"),
            options,
            customerNote: "Less sweet",
          },
        ],
      });
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(issued) }),
      );
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(current) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      const line = page.locator(".receipt-page__lines li").first();
      await expect(line).toContainText("1 × TEST Hot Chocolate");
      await expect(line.locator(".receipt-page__option")).toHaveText([
        "Whipped cream +$0.50",
        "Oat milk",
      ]);
      await expect(line.locator("> span").last()).toHaveText("$10.00");
      await expect(page.locator(".receipt-page__totals div", { hasText: "Subtotal" })).toHaveText(
        "Subtotal$10.00",
      );
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
      await page.goto("/orders/" + orderReference);
      const item = page.locator(".order-status__batch li").first();
      await expect(item.locator(".order-status__item-options")).toHaveText(
        "Whipped cream +$0.50, Oat milk",
      );
      await expect(item.locator(".order-status__item-note")).toHaveText("Note: Less sweet");
      await expect(item.locator(".order-status__item-amount")).toHaveText("$10.00");
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });

    test("the order page's total includes the tip and equals what was paid and the receipt", async ({
      page,
    }) => {
      // WP-2423 (v15 aa3d9fac D2): $8.50 + $1.11 tax + $1.35 tip = $10.96 paid. TEST-ONLY item.
      const issued = receipt(false);
      const snapshot = issued.receipt.records[0]?.snapshot;
      const issuedLine = snapshot?.lines[0];
      if (!snapshot || !issuedLine) throw new Error("fixture");
      Object.assign(issuedLine, { lineTotal: money("961"), lineSubtotal: money("850") });
      Object.assign(snapshot, {
        subtotal: money("850"),
        tax: money("111"),
        tip: money("135"),
        total: money("1096"),
      });
      snapshot.taxDetails.taxLines = [
        { label: "HST", ratePercent: "13", included: false, amount: money("111") },
      ];
      const current = status("Stored");
      const batch = current.status.order.batches[0];
      const payment = current.status.sources.payments[0];
      if (!batch?.items[0] || !payment) throw new Error("fixture");
      batch.items[0].lineTotal = money("961");
      payment.amount = money("1096");
      Object.assign(current.status.sources, {
        itemPrices: [{ orderItemReference: id(10), subtotal: money("850"), tax: money("111") }],
        tips: [{ orderBatchReference: id(9), amount: money("135") }],
      });
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(issued) }),
      );
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(current) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      await expect(page.locator(".receipt-page__totals div", { hasText: /^Total/u })).toHaveText(
        "Total$10.96",
      );
      await page.goto("/orders/" + orderReference);
      const summary = page.locator(".order-status__money");
      await expect(summary).toContainText("Subtotal$8.50");
      await expect(summary).toContainText("Tax$1.11");
      await expect(summary).toContainText("Tip$1.35");
      await expect(page.locator(".order-status__total")).toHaveText("Total$10.96");
      await expect(page.getByText("Payment received $10.96")).toBeVisible();
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
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

    test("DEC-PILOT-NOTIFICATIONS: without a connected channel nothing extra is offered or collected", async ({
      page,
    }) => {
      await checkout(page, false);
      await expect(page.getByText(/only to contact you about this order/u)).toBeVisible();
      await expect(page.getByText(/We’ll also (text|email) you/u)).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: "Email my receipt" })).toHaveCount(0);
      await expect(
        page.getByText("Your receipt appears on your order page, where you can print or save it."),
      ).toBeVisible();
    });

    test("DEC-PILOT-NOTIFICATIONS: with text and email connected, checkout says how the contact is used and offers Email my receipt", async ({
      page,
    }) => {
      await page.route("**/api/v1/customer/order-messages", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
          body: JSON.stringify({ schemaVersion: 1, orderMessages: { sms: true, email: true } }),
        }),
      );
      await checkout(page, false);
      await expect(
        page.getByText("We’ll also text you when the store has your order and when it’s ready.", {
          exact: false,
        }),
      ).toBeVisible();
      const emailReceipt = page.getByRole("checkbox", { name: "Email my receipt" });
      await expect(emailReceipt).not.toBeChecked();
      await emailReceipt.check();
      await expect(page.getByRole("textbox", { name: "Receipt email" })).toBeVisible();
      await expect(page.getByText(/We send your receipt to this address once/u)).toBeVisible();
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
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
      await expect(section.getByText(/won’t be able to call or email you/u)).toBeVisible();
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

    // WP-2423 (v15 3cd0f8dd M3/M4): a refund confirmed after payment. The receipt gains a version
    // that says what the refund returned (and keeps version 1 as issued); the order page shows the
    // same refund. TEST-ONLY: $10.00 + $1.30 tax + $1.50 tip paid; $5.00 item, $0.65 tax and $0.75
    // of the tip refunded.
    test("a refund version says what was refunded, and the order page shows the refund", async ({
      page,
    }) => {
      const issued = receipt(true);
      const first = issued.receipt.records[0];
      if (!first) throw new Error("fixture");
      const line = first.snapshot.lines[0];
      if (!line) throw new Error("fixture");
      Object.assign(line, { quantity: 2 });
      Object.assign(first.snapshot, { tip: money("150"), total: money("1280") });
      const refunded = {
        ...first,
        recordReference: id(30),
        version: 2,
        kind: "Refund",
        recordedAt: "2026-10-14T14:20:00.000Z",
        reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
        snapshot: {
          ...first.snapshot,
          paymentStatus: "PartiallyRefunded",
          refundedTotal: money("640"),
          refunds: [
            {
              kind: "Refund",
              lines: [
                {
                  lineReference: id(4),
                  displayName: "Synthetic bowl",
                  quantity: 1,
                  amount: money("500"),
                },
              ],
              tax: money("65"),
              tip: money("75"),
              other: money("0"),
              total: money("640"),
              newInThisVersion: true,
            },
          ],
        },
      };
      const body = {
        ...issued,
        receipt: {
          ...issued.receipt,
          records: [first, refunded],
          financial: {
            observedAt: "2026-10-14T14:21:00.000Z",
            currencyCode: "CAD",
            capturedMinor: "1280",
            confirmedRefundMinor: "640",
            pendingRefundMinor: "0",
            unresolvedAttemptCount: 0,
            paidOnlineMinor: "1280",
            paidOnCardMachineMinor: "0",
          },
        },
      };
      const current = status("Stored");
      const batch = current.status.order.batches[0];
      const payment = current.status.sources.payments[0];
      if (!batch?.items[0] || !payment) throw new Error("fixture");
      Object.assign(batch.items[0], { quantity: 2, lineTotal: money("1130") });
      payment.amount = money("1280");
      Object.assign(current.status.sources, {
        tips: [{ orderBatchReference: id(9), amount: money("150") }],
        refunds: {
          refunded: money("640"),
          entries: [
            {
              kind: "Refund",
              orderItemReferences: [id(10)],
              total: money("640"),
              tip: money("75"),
            },
          ],
        },
      });
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(body) }),
      );
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(current) }),
      );
      await page.goto("/orders/" + orderReference + "/receipt");
      await expect(page.getByText("Confirmed refunds$6.40")).toBeVisible();
      const version2 = page.getByRole("article", { name: "Version 2: Refund" });
      await expect(
        version2.getByText("Reason: A refund was made to your original payment."),
      ).toBeVisible();
      const what = version2.getByRole("region", { name: "What was refunded" });
      await expect(what.getByText("Refund · new on this version")).toBeVisible();
      await expect(what.locator(".receipt-page__lines li")).toHaveText(["1 × Synthetic bowl$5.00"]);
      await expect(what.locator(".receipt-page__totals div", { hasText: "Tax" })).toHaveText(
        "Tax$0.65",
      );
      await expect(what.locator(".receipt-page__totals div", { hasText: "Tip" })).toHaveText(
        "Tip$0.75",
      );
      await expect(
        what.locator(".receipt-page__totals div", { hasText: "Total after refunds" }),
      ).toHaveText("Total after refunds$6.40");
      // Version 1 is printed as it was issued: nothing refunded on it.
      const version1 = page.getByRole("article", { name: "Version 1: Receipt" });
      await expect(version1.getByRole("region", { name: "What was refunded" })).toHaveCount(0);
      await expect(
        version1.locator(".receipt-page__totals div", { hasText: /^Refunded/u }),
      ).toHaveText("Refunded$0.00");
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
      await page.goto("/orders/" + orderReference);
      await expect(page.getByText("Payment received $12.80")).toBeVisible();
      await expect(
        page.locator(".order-status__summary dl div", { hasText: "Refunded" }),
      ).toHaveText("Refunded$6.40");
      await expect(
        page.getByText(
          "Refund: $6.40 returned to your original payment, including $0.75 of the tip.",
        ),
      ).toBeVisible();
      await expect(page.locator(".order-status__item-refunded")).toHaveText("Refunded");
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });

    // WP-2423 (v15 3cd0f8dd H1): a table that paid round 1 online and round 2 with staff on the
    // Store's card machine owes nothing; both pages say what was paid and how. TEST-ONLY amounts.
    test("a round paid on the store's card machine counts on the order page and the receipt", async ({
      page,
    }) => {
      const current = status("Stored");
      const order = current.status.order;
      const first = order.batches[0];
      const payment = current.status.sources.payments[0];
      if (!first?.items[0] || !payment) throw new Error("fixture");
      Object.assign(order, { orderType: "DineIn", canonicalPhase: "Accepted" });
      first.items[0].lineTotal = money("480");
      payment.amount = money("544");
      order.batches.push({
        orderBatchReference: id(20),
        submittedAt: "2026-10-14T13:58:00.000Z",
        items: [
          {
            orderItemReference: id(21),
            displayName: "Synthetic mocha",
            quantity: 1,
            lineTotal: money("537"),
          },
        ],
      });
      current.status.sources.payments.push({
        status: "Succeeded",
        occurredAt: "2026-10-14T13:59:00.000Z",
        amount: money("537"),
        freshnessStatus: "Fresh",
        ...{ method: "CardMachine", orderBatchReference: id(20) },
      });
      Object.assign(current.status.sources, {
        tips: [{ orderBatchReference: id(9), amount: money("64") }],
      });
      const issued = receipt(true);
      Object.assign(issued.receipt, {
        financial: {
          observedAt: "2026-10-14T14:01:00.000Z",
          currencyCode: "CAD",
          capturedMinor: "1081",
          confirmedRefundMinor: "0",
          pendingRefundMinor: "0",
          unresolvedAttemptCount: 0,
          paidOnlineMinor: "544",
          paidOnCardMachineMinor: "537",
        },
      });
      await bootstrap(page);
      await page.route("**/api/v1/orders/*/status", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(current) }),
      );
      await page.route("**/api/v1/orders/*/receipt", (route) =>
        route.fulfill({ headers: json, body: JSON.stringify(issued) }),
      );
      await page.goto("/orders/" + orderReference);
      await expect(
        page.getByText("Payment received $10.81 ($5.44 online, $5.37 on the store’s card machine)"),
      ).toBeVisible();
      await expect(page.locator(".order-status__total")).toHaveText(
        "Total including tax and tip$10.81",
      );
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
      await page.goto("/orders/" + orderReference + "/receipt");
      const paid = page.getByRole("region", { name: "Payment and refunds" });
      await expect(paid.locator(".receipt-page__totals div", { hasText: /^Paid\$/u })).toHaveText(
        "Paid$10.81",
      );
      await expect(paid.getByText("Paid online$5.44")).toBeVisible();
      await expect(paid.getByText("Paid on the store’s card machine$5.37")).toBeVisible();
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });

    // WP-2423 (v15 3cd0f8dd M5): the table was closed after the guest left. The order page says the
    // visit ended (no ordering) and opens the receipt, read only, with the ended visit's credential.
    test("after the visit ended, the guest still opens their receipt from the order page", async ({
      page,
    }) => {
      const ended = "e".repeat(43);
      // The receipt stays readable on this phone until 24 hours after the visit started.
      const until = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
      await page.route("**/api/v1/customer/session/csrf", (route) =>
        route.fulfill({
          status: 200,
          headers: json,
          body: JSON.stringify({
            schemaVersion: 1,
            endedVisit: {
              csrfToken: ended,
              order: { orderReference, orderNumber: "12", orderType: "DineIn" },
              receiptAvailableUntil: until,
            },
          }),
        }),
      );
      const statusCalls: string[] = [];
      await page.route("**/api/v1/orders/*/status", (route) => {
        statusCalls.push(route.request().url());
        return route.fulfill({ status: 404, headers: json, body: "{}" });
      });
      const receiptTokens: (string | undefined)[] = [];
      await page.route("**/api/v1/orders/*/receipt", (route) => {
        receiptTokens.push(route.request().headers()["x-csrf-token"]);
        return route.fulfill({
          headers: json,
          body: JSON.stringify({
            ...receipt(true),
            receipt: {
              ...receipt(true).receipt,
              visitEnded: { receiptAvailableUntil: until },
            },
          }),
        });
      });
      await page.goto("/orders/" + orderReference);
      const notice = page.getByRole("alert");
      await expect(
        notice.getByRole("heading", { name: "Your visit on this phone has ended" }),
      ).toBeVisible();
      await expect(
        notice.getByText(
          "You can still view and save your receipt on this phone for 24 hours after your visit started.",
        ),
      ).toBeVisible();
      await expect(notice).not.toContainText("ask a staff member for the table code to continue");
      // No order status (and nothing to order with) is read for an ended visit.
      expect(statusCalls).toEqual([]);
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
      await notice.getByRole("link", { name: "View your receipt" }).click();
      await expect(page.getByRole("heading", { name: "Your visit has ended" })).toBeVisible();
      await expect(
        page.getByText(/You can still view and save this receipt on this phone until/u),
      ).toBeVisible();
      await expect(page.getByText("HST 13%", { exact: true })).toBeVisible();
      expect(receiptTokens).toEqual([ended]);
      await expectNoInternalText(page);
      await noOverflowOrBlockingAxe(page);
    });
  });
}

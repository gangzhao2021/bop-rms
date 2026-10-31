import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423 DEC-DINE-IN-PAY-LATER: at a table that pays once at the end, the guest's round goes to
// the kitchen from the checkout — no tip and no payment step — and the table page then shows it
// in the kitchen and on the table's bill. Synthetic HTTP interception on the production PWA.
test.beforeEach(({ context }) => routeStorefrontReads(context));
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

async function stubTable(page: Page, sent: { body: unknown; key: string | undefined }[]) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  let roundSent = false;
  await page.route("**/api/v1/customer/order-messages", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ schemaVersion: 1, orderMessages: { sms: false, email: false } }),
    }),
  );
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Table Store",
        publicStoreReference: id(4),
        publicTableReference: id(5),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
      },
    }),
  );
  await page.route("**/bff/customer/cart", (route) =>
    route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 3,
          orderType: "DineIn",
          serviceMode: "DineIn",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Table Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: "Synthetic noodles",
              quantity: 2,
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
  await page.route("**/api/v1/carts/*/quote", (route) =>
    route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(6),
          quoteVersion: 1,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: "2000", currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "260", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: "2260", currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          priceChange: null,
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(1), cartVersion: 3, orderType: "DineIn", details: null },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/policy", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(1),
          cartVersion: 3,
          orderType: "DineIn",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details", async (route) => {
    const request = route.request(),
      body = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        details: {
          operationReference: request.headers()["idempotency-key"],
          detailsReference: body.detailsReference,
          detailsVersion: 1,
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          orderType: "DineIn",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    const body = route.request().postDataJSON() as { quoteReference: string };
    return route.fulfill({
      status: 200,
      json: {
        schemaVersion: 1,
        session: {
          checkoutSessionReference: id(10),
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: body.quoteReference,
          quoteVersion: 1,
          createdAt: now,
        },
      },
    });
  });
  await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
    const request = route.request();
    sent.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
    roundSent = true;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        round: {
          checkoutSessionReference: id(10),
          orderReference: id(20),
          status: "Sent",
          total: { amountMinor: "2260", currency: "CAD" },
        },
      },
    });
  });
  await page.route("**/api/v1/dine-in/session**", (route) =>
    route.fulfill({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        session: {
          tableLabel: "12",
          orderNumber: roundSent ? "1042" : null,
          checkedAt: new Date().toISOString(),
          paymentTiming: "PayLater",
          rounds: roundSent
            ? [
                {
                  roundNumber: 1,
                  orderedBy: "You",
                  submittedAt: now,
                  status: "Queued",
                  payment: "OnTableBill",
                  cancelsAt: null,
                  storeCancellationReason: null,
                  items: [
                    {
                      displayName: "Synthetic noodles",
                      quantity: 2,
                      servedQuantity: 0,
                      cancelled: false,
                      lineTotal: { amountMinor: "2260", currencyCode: "CAD" },
                    },
                  ],
                  itemsTotal: { amountMinor: "2260", currencyCode: "CAD" },
                },
              ]
            : [],
          summary: roundSent
            ? {
                paid: { amountMinor: "0", currencyCode: "CAD" },
                refunded: { amountMinor: "0", currencyCode: "CAD" },
                refundPending: { amountMinor: "0", currencyCode: "CAD" },
                due: { amountMinor: "2260", currencyCode: "CAD" },
              }
            : null,
        },
      },
    }),
  );
}

for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Pay-later table checkout " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    test("sends the round to the kitchen with no tip or payment step", async ({ page }) => {
      const failures: string[] = [];
      page.on("pageerror", () => failures.push("page error"));
      const sent: { body: unknown; key: string | undefined }[] = [];
      await stubTable(page, sent);
      await page.goto("/#qr=aaa.bbb.ccc");
      await expect(
        page.getByRole("heading", { name: "Synthetic Table Store", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        history.pushState(null, "", "/checkout");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const send = page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u });
      await expect(send).toBeEnabled();
      // The table chooses its tip once, when it pays at the end.
      await expect(page.getByRole("heading", { name: "Tip", exact: true })).toHaveCount(0);
      await expect(page.getByText("Nothing is charged now.", { exact: false })).toBeVisible();
      await expectNoInternalText(page);
      await send.click();
      await expect(page).toHaveURL(/\/dine-in\/session$/u);
      await expect(page.getByText("On the table's bill").first()).toBeVisible();
      await expect(page.getByText("To pay at the end")).toBeVisible();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toEqual({ sendToKitchen: true });
      expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
      expect(failures).toEqual([]);
    });
  });
}

/**
 * v15 2026-10-30: the moved party's phone, in the order things happen. It joins the table (scans
 * T6's code), sends a round, staff move the party to T7, and the guest reloads the same table page:
 * it says the table moved (not "join your table first"); scanning T7's code joins again and the
 * round is there. Synthetic HTTP standing in for the server, which the database acceptance test
 * proves (the restore of a moved phone's visit says where the party sits, nothing else).
 */
test.describe("@production a moved party's phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test("reloads its table page after the move and joins the new table again", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", () => failures.push("page error"));
    const sent: { body: unknown; key: string | undefined }[] = [];
    await stubTable(page, sent);
    // The server's side of the story: staff moved the party; the phone joined the new table.
    const table = { moved: false, rejoined: false };
    const movedAway = () => table.moved && !table.rejoined;
    const ok = (route: import("@playwright/test").Route, json: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { operationReference: route.request().headers()["idempotency-key"], ...json },
      });
    // Restoring the visit on a reload (the page keeps its token in memory only).
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      movedAway()
        ? route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, movedTable: { tableLabel: "T7" } },
          })
        : route.fulfill({ status: 204, headers: { "cache-control": "no-store" } }),
    );
    await page.route("**/bff/customer/dining/qr-join", (route) => {
      table.rejoined = table.moved;
      return ok(route, { status: "Joined", admissionReference: id(30) });
    });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await page.route("**/bff/customer/dining-binding/prepare", (route) =>
      ok(route, {
        status: "Prepared",
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      }),
    );
    await page.route("**/bff/customer/dining-binding/activate", (route) =>
      ok(route, { status: "Activated", csrfToken: "n".repeat(43) }),
    );

    // Joins at T6 and sends a round.
    await page.goto("/#qr=aaa.bbb.ccc");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/checkout");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(page.getByText("On the table's bill").first()).toBeVisible();

    // Staff move the party to T7; the guest reloads the same page.
    table.moved = true;
    await page.reload();
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Your table moved to table T7" })).toBeVisible();
    await expect(main).toContainText("Scan the code on table T7");
    await expect(main).not.toContainText("Join your table first");
    await expectNoInternalText(page);

    // Scans T7's code and joins again: the round is on the table page.
    await page.goto("/#qr=ddd.eee.fff");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
    expect(table.rejoined).toBe(true);
    await page.evaluate(() => {
      history.pushState(null, "", "/dine-in/session");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText("On the table's bill").first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Your table moved");
    expect(sent).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the merged party's phone, in the order things happen. It joins the table (scans
 * T6's code), sends a round, staff merge its table into T7, and the guest reloads the same table page:
 * it says the table was merged into T7; scanning T7's code joins again and the round is on T7's bill. Synthetic HTTP standing in for the server, which the database acceptance test
 * proves (the restore of a moved phone's visit says where the party sits, nothing else).
 */
test.describe("@production a merged party's phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  test("reloads its table page after the merge and joins the other table", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", () => failures.push("page error"));
    const sent: { body: unknown; key: string | undefined }[] = [];
    await stubTable(page, sent);
    // The server's side of the story: staff moved the party; the phone joined the new table.
    const table = { moved: false, rejoined: false };
    const movedAway = () => table.moved && !table.rejoined;
    const ok = (route: import("@playwright/test").Route, json: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { operationReference: route.request().headers()["idempotency-key"], ...json },
      });
    // Restoring the visit on a reload (the page keeps its token in memory only).
    await page.route("**/api/v1/customer/session/csrf", (route) =>
      movedAway()
        ? route.fulfill({
            status: 200,
            headers: { "cache-control": "no-store" },
            json: { schemaVersion: 1, movedTable: { tableLabel: "T7", merged: true } },
          })
        : route.fulfill({ status: 204, headers: { "cache-control": "no-store" } }),
    );
    await page.route("**/bff/customer/dining/qr-join", (route) => {
      table.rejoined = table.moved;
      return ok(route, { status: "Joined", admissionReference: id(30) });
    });
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await page.route("**/bff/customer/dining-binding/prepare", (route) =>
      ok(route, {
        status: "Prepared",
        candidateCsrfToken: "n".repeat(43),
        recoveryProof: "r".repeat(43),
        expiresAt,
      }),
    );
    await page.route("**/bff/customer/dining-binding/activate", (route) =>
      ok(route, { status: "Activated", csrfToken: "n".repeat(43) }),
    );

    // Joins at T6 and sends a round.
    await page.goto("/#qr=aaa.bbb.ccc");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
    await page.evaluate(() => {
      history.pushState(null, "", "/checkout");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: /Send to the kitchen · \$22\.60/u }).click();
    await expect(page).toHaveURL(/\/dine-in\/session$/u);
    await expect(page.getByText("On the table's bill").first()).toBeVisible();

    // Staff merge this table into T7; the guest reloads the same page.
    table.moved = true;
    await page.reload();
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Your table was merged into table T7" }),
    ).toBeVisible();
    await expect(main).toContainText("Everything your table ordered is on that table's bill.");
    await expect(main).toContainText("Scan the code on table T7");
    await expect(main).not.toContainText("Join your table first");
    await expectNoInternalText(page);

    // Scans T7's code and joins again: the round is on the table page.
    await page.goto("/#qr=ddd.eee.fff");
    await page.getByRole("button", { name: "Join this table", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
    expect(table.rejoined).toBe(true);
    await page.evaluate(() => {
      history.pushState(null, "", "/dine-in/session");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText("On the table's bill").first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("merged into table");
    expect(sent).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

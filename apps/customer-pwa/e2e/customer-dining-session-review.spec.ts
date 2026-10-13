import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q8: synthetic HTTP views exercise the production CUST-DINE-IN-SESSION page; these
// fixtures grant no real membership and contain no real Store, guest or payment data.
const id = (n: number) => `018f2330-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const session = {
  schemaVersion: 1,
  session: {
    tableLabel: "12",
    orderNumber: "1042",
    checkedAt: "2026-10-13T18:00:00.000Z",
    rounds: [
      {
        roundNumber: 1,
        orderedBy: "You",
        submittedAt: "2026-10-13T17:40:00.000Z",
        status: "Serving",
        payment: "Paid",
        cancelsAt: null,
        storeCancellationReason: null,
        items: [
          {
            displayName: "Synthetic tonkotsu ramen with extra chashu",
            quantity: 2,
            servedQuantity: 1,
            cancelled: false,
            lineTotal: cad("3398"),
          },
          {
            displayName: "Synthetic green tea",
            quantity: 1,
            servedQuantity: 0,
            cancelled: true,
            lineTotal: cad("339"),
          },
        ],
        itemsTotal: cad("3737"),
      },
      {
        roundNumber: 2,
        orderedBy: "AnotherGuest",
        submittedAt: "2026-10-13T17:55:00.000Z",
        status: "PaymentFailed",
        payment: "Failed",
        cancelsAt: "2026-10-13T18:25:00.000Z",
        storeCancellationReason: null,
        items: [
          {
            displayName: "Synthetic gyoza",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: cad("904"),
          },
        ],
        itemsTotal: cad("904"),
      },
    ],
    summary: {
      paid: cad("4282"),
      refunded: cad("0"),
      refundPending: cad("339"),
      due: cad("904"),
    },
  },
};

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function enterTable(page: Page, onSession: () => { status: number; json: unknown }) {
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Noodle Bar",
        publicStoreReference: id(6),
        publicTableReference: id(7),
        channel: "DineIn",
        operatingState: "Open",
        availableServiceModes: ["DineIn"],
        locale: "en-CA",
        contextExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        csrfToken: "s".repeat(43),
      },
    }),
  );
  await page.route("**/api/v1/dine-in/session", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-csrf-token"]).toBe("s".repeat(43));
    expect(new URL(route.request().url()).search).toBe("");
    const { status, json } = onSession();
    return route.fulfill({ status, headers: { "cache-control": "no-store" }, json });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Noodle Bar", exact: true }),
  ).toBeVisible();
  // Same-document navigation retains the real Entry CSRF context, as after joining the table.
  await page.evaluate(() => {
    history.pushState(null, "", "/menu");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page
    .getByRole("navigation", { name: "Customer journey" })
    .getByRole("link", { name: "Your table" })
    .click();
  await expect(page).toHaveURL(/\/dine-in\/session$/u);
}

test.describe("@production CUST-DINE-IN-SESSION table view", () => {
  test.use({ serviceWorkers: "block" });

  test("shows the table's rounds, statuses and amounts at responsive widths", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await enterTable(page, () => ({ status: 200, json: session }));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Your table · 12" })).toBeVisible();
    await expect(main.getByText("Order 1042", { exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Round 1 · Ordered by you" })).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Round 2 · Ordered by another guest" }),
    ).toBeVisible();
    await expect(main.getByText("Being served", { exact: true })).toBeVisible();
    await expect(main.getByText("Served 1 of 2", { exact: true })).toBeVisible();
    await expect(main.getByText("On hold until paid", { exact: true })).toBeVisible();
    await expect(main.getByText(/This round will be cancelled at/u)).toBeVisible();
    const summary = main.getByRole("region", { name: "Table total" });
    await expect(summary.getByText("$42.82", { exact: true })).toBeVisible();
    await expect(summary.getByText("$9.04", { exact: true })).toBeVisible();
    await expect(summary.getByText("$3.39", { exact: true })).toBeVisible();
    // No internal codes or references reach the guest.
    await expect(main.getByText(/AnotherGuest|PaymentFailed|RefundPending|018f2330/u)).toHaveCount(
      0,
    );
    await expect(main.getByRole("link", { name: "Order more from the menu" })).toHaveAttribute(
      "href",
      "/menu",
    );

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
      for (const card of await main.locator(".order-status__card").all()) {
        const box = await card.boundingBox();
        if (box === null) throw new Error("table card missing");
        expect(box.width).toBeLessThanOrEqual(width - 16);
      }
      const header = await page.locator(".bop-shell__header").boundingBox();
      if (header === null) throw new Error("Customer frame is incomplete");
      expect(header.width).toBe(width);
      if (width !== 320)
        await page.screenshot({
          path: `test-results/customer-dining-session-${width}.png`,
          fullPage: true,
        });
    }
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(errors).toEqual([]);
  });

  test("asks a guest who has not joined to join first", async ({ page }) => {
    await enterTable(page, () => ({ status: 404, json: { schemaVersion: 1 } }));
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Join your table first" })).toBeVisible();
    await expect(main.getByText("Round 1", { exact: false })).toHaveCount(0);
  });

  test("recovers after a failed load with Try again", async ({ page }) => {
    let response: { status: number; json: unknown } = { status: 503, json: { schemaVersion: 1 } };
    await enterTable(page, () => response);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "We couldn’t load your table" })).toBeVisible();
    response = { status: 200, json: session };
    await main.getByRole("button", { name: "Try again" }).click();
    await expect(main.getByRole("heading", { name: "Round 1 · Ordered by you" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "We couldn’t load your table" })).toHaveCount(0);
  });
});

import { expect, test } from "@playwright/test";

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): the Tables board warns before an unpaid
 * guest round is cancelled, and a manager cancels it from the selected table. Synthetic HTTP
 * fixtures exercise the built page; the server rules run in the database acceptance.
 */
test("@production WP-2423: Tables warns about a guest round nobody paid for and a manager cancels it", async ({
  page,
}) => {
  const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-16",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  const payBy = new Date(Date.now() + 7 * 60_000).toISOString();
  let cancelled = false;
  const posts: unknown[] = [];
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCancelUnpaidRounds: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "DEMO-02",
            areaCode: "DEMO",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: id(11),
            elapsedMinutes: 45,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            guestRoundsAwaitingPayment: cancelled
              ? []
              : [
                  {
                    orderReference: id(20),
                    orderBatchReference: id(21),
                    roundNumber: 1,
                    payBy,
                  },
                ],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/cancel-unpaid-round", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    posts.push(route.request().postDataJSON());
    cancelled = true;
    return route.fulfill({
      headers,
      json: { status: "Cancelled", cancelledAt: new Date().toISOString() },
    });
  });
  await page.goto("/operations/dining");
  const tile = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select DEMO-02", exact: true }) });
  // Last 10 minutes: urgent on the list, with the minutes left; the panel says what to do.
  await expect(tile).toContainText(/Round not paid yet\s*\d+ min left/u);
  await expect(tile).toHaveAttribute("data-urgent", "true");
  await tile.getByRole("button", { name: "Select DEMO-02", exact: true }).click();
  const unpaid = page.getByRole("region", { name: "Unpaid rounds" });
  await expect(unpaid).toContainText("If the guest won't pay for it, cancel it now.");
  // Staff words only: no references or codes in the warning or the action.
  await expect(unpaid).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-7|_[A-Z]|UNPAID/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/tables-unpaid-round-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await unpaid.getByRole("button", { name: "Cancel unpaid round 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel unpaid round 1 of table DEMO-02?" });
  await dialog.getByRole("button", { name: "Cancel round 1", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unpaid rounds" })).toHaveCount(0);
  await expect(tile).not.toContainText("Round not paid yet");
  expect(posts).toEqual([
    {
      orderReference: id(20),
      orderBatchReference: id(21),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
});

/**
 * WP-2423 abandoned payment: a round whose card payment the provider still can't confirm 5 minutes
 * after its deadline is handed to the manager (check with the guest, then cancel with that
 * confirmation); and a payment that arrives while the manager cancels is reported as "just arrived".
 */
test("@production WP-2423: Tables hands an unconfirmed card payment to the manager and reports a payment that just arrived", async ({
  page,
}) => {
  const id = (n: number) => "0190996b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-16",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  const rounds = [
    // Unconfirmed: the deadline passed 8 minutes ago and the round is still unpaid.
    { orderReference: id(30), orderBatchReference: id(31), roundNumber: 1, payBy: -8 },
    // Its payment arrives while the manager cancels (still listed until Ordering records it).
    { orderReference: id(40), orderBatchReference: id(41), roundNumber: 2, payBy: 20 },
  ].map(({ payBy, ...round }) => ({
    ...round,
    payBy: new Date(Date.now() + payBy * 60_000).toISOString(),
  }));
  const gone = new Set<string>();
  const posts: unknown[] = [];
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCancelUnpaidRounds: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "DEMO-03",
            areaCode: "DEMO",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: id(11),
            elapsedMinutes: 55,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            staffRoundsAwaitingPayment: [],
            guestRoundsAwaitingPayment: rounds.filter(
              (round) => !gone.has(round.orderBatchReference),
            ),
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/cancel-unpaid-round", (route) => {
    const body = route.request().postDataJSON() as { orderBatchReference: string };
    posts.push(body);
    gone.add(body.orderBatchReference);
    return body.orderBatchReference === id(41)
      ? route.fulfill({ status: 409, headers, json: { error: "unpaid_round_paid" } })
      : route.fulfill({
          headers,
          json: { status: "Cancelled", cancelledAt: new Date().toISOString() },
        });
  });
  await page.goto("/operations/dining");
  const tile = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select DEMO-03", exact: true }) });
  await expect(tile).toContainText("Payment not confirmedask the guest");
  await tile.getByRole("button", { name: "Select DEMO-03", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Selected table details" })).toContainText(
    "Round 1: the card provider couldn't confirm the guest's payment",
  );
  const unpaid = page.getByRole("region", { name: "Unpaid rounds" });
  const details = page.getByRole("complementary", { name: "Selected table details" });
  await expect(details).toContainText("Ask the guest whether their card was charged.");
  // The notice already says to cancel once the guest confirms; no generic sentence repeats it.
  await expect(details).not.toContainText("If the guest won't pay for it");
  await expect(unpaid).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-7|_[A-Z]|UNPAID/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/tables-unconfirmed-payment-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Round 1: the manager checked with the guest; the request says so.
  await unpaid.getByRole("button", { name: "Cancel unpaid round 1" }).click();
  const first = page.getByRole("dialog", { name: "Cancel unpaid round 1 of table DEMO-03?" });
  await expect(first).toContainText("couldn't confirm the guest's payment for this round");
  await expect(first).toContainText("refunded to the guest automatically");
  await first.getByRole("button", { name: "Not charged: cancel round 1", exact: true }).click();
  await expect(first).toBeHidden();
  // Round 2 (not yet past its grace): its payment arrived meanwhile.
  await unpaid.getByRole("button", { name: "Cancel unpaid round 2" }).click();
  const second = page.getByRole("dialog", { name: "Cancel unpaid round 2 of table DEMO-03?" });
  await expect(second).toContainText("Nobody has paid for this round");
  await second.getByRole("button", { name: "Cancel round 2", exact: true }).click();
  await expect(second).toContainText("Payment just arrived");
  await expect(second.getByRole("button", { name: "Cancel round 2", exact: true })).toBeDisabled();
  await second.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unpaid rounds" })).toHaveCount(0);
  expect(posts).toEqual([
    {
      orderReference: id(30),
      orderBatchReference: id(31),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      acknowledgeUnconfirmedPayment: true,
    },
    {
      orderReference: id(40),
      orderBatchReference: id(41),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
});

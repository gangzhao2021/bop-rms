import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): a guest started paying for a dine-in
 * round on their phone and left. Staff see when it is cancelled automatically unless paid, and a
 * manager cancels the unpaid round now with a plain confirmation; nothing is charged. Synthetic
 * HTTP fixtures exercise the built page; the server rules run in the database acceptance.
 */
test("@production WP-2423: a manager cancels an unpaid dine-in round from the Orders page", async ({
  page,
}) => {
  const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
  const cancelsAt = new Date(Date.now() + 25 * 60_000).toISOString();
  let cancelled = false;
  const posts: unknown[] = [];
  const order = () => ({
    orderReference: id(1),
    orderNumber: "12",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    initialBatchReference: id(2),
    batches: [
      {
        orderBatchReference: id(2),
        sequence: 1,
        acceptanceStatus: cancelled ? "Cancelled" : "NotAccepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        canCancelUnpaid: !cancelled,
        paymentDue: cancelled ? null : { status: "Awaiting", cancelsAt },
      },
    ],
    canRequestAcceptance: false,
    currentPhase: cancelled ? "Cancelled" : "Submitted",
    currentVersion: cancelled ? 2 : 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: !cancelled,
  });
  await page.route("**/merchant/orders?*", (route) => route.fallback());
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
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
  await page.goto("/operations/orders");
  // A single order opens on its own; open it if not.
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  await expect(page.getByRole("heading", { name: "12", exact: true })).toBeVisible();
  if (!(await round.isVisible()))
    await page.getByRole("heading", { name: "12", exact: true }).click();
  // Warned before the deadline, in staff words, with what to do.
  await expect(
    round.getByText(/Not paid · cancelled automatically at .* unless paid/u),
  ).toBeVisible();
  await expect(page.getByText(/Ask them to finish paying on their phone/u)).toBeVisible();
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/orders-unpaid-round-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Cancel unpaid round 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel unpaid round 1 of order 12?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Nobody is charged.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep round" }).click();
  expect(posts).toEqual([]);
  await page.getByRole("button", { name: "Cancel unpaid round 1" }).click();
  await dialog.getByRole("button", { name: "Cancel round 1", exact: true }).click();
  await expect(page.getByText("Round cancelled · not paid.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel unpaid round 1" })).toHaveCount(0);
  expect(posts).toEqual([
    {
      orderReference: id(1),
      orderBatchReference: id(2),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
  await page.screenshot({ path: "test-results/orders-unpaid-round-cancelled.png", fullPage: true });
});

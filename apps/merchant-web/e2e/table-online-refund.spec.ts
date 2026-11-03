import { expect, test, type Page } from "@playwright/test";

const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const payment = {
  partNumber: null,
  method: "Online",
  roundsMinor: "4000",
  tipMinor: "600",
  roundingMinor: "0",
  totalMinor: "4600",
  takenAt: "2026-11-02T20:00:00.000Z",
  recordedAfterOutage: false,
  cashRefunds: [],
  onlineRefunds: [] as unknown[],
  refundableMinor: "4600",
};
const refund = (state: string) => ({
  amountMinor: "1000",
  reasonCode: "FOOD_ISSUE",
  requestedAt: "2026-11-02T20:10:00.000Z",
  state,
});

async function orderPage(page: Page, reads: () => unknown) {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-02",
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
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-1",
            orderType: "DineIn",
            sourceChannel: "Web",
            submittedAt: "2026-11-02T19:00:00.000Z",
            observedAt: "2026-11-02T20:20:00.000Z",
            initialBatchReference: id(90),
            batches: [
              {
                orderBatchReference: id(90),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
            canRecordCardMachinePayment: false,
            canViewPayments: true,
            tableBill: {
              totalMinor: "4000",
              paid: { amountMinor: "4600", method: "Online" },
            },
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/table-payment", (route) =>
    route.fulfill({ headers, json: reads() }),
  );
}

const fill = async (page: Page, amount: string) => {
  await page.getByRole("button", { name: "Refund to the card", exact: true }).click();
  await page.getByLabel("Amount to refund").fill(amount);
  await page.getByRole("combobox", { name: /Reason/u }).selectOption("FOOD_ISSUE");
};

test("@production a manager refunds a table paid on a guest's phone to the card", async ({
  page,
}) => {
  await orderPage(page, () => ({ orderReference: id(1), payment, parts: [] }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/table-payment/online-refund", (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(1),
        payment: { ...payment, onlineRefunds: [refund("Refunded")], refundableMinor: "3600" },
        parts: [],
      },
    });
  });
  await page.goto("/operations/orders");
  await fill(page, "46.01");
  await expect(page.getByRole("button", { name: /to the card$/u })).toBeDisabled();
  await page.getByLabel("Amount to refund").fill("10");
  await page.getByRole("button", { name: /10\.00 to the card$/u }).click();
  await expect(page.getByText(/^Refunded to the card/u)).toBeVisible();
  await expect(page.getByText(/few days/u)).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    orderReference: id(1),
    amountMinor: "1000",
    reasonCode: "FOOD_ISSUE",
  });
  expect(bodies[0]).not.toHaveProperty("partNumber");
});

test("@production a refund on its way says so and shows its result without reopening", async ({
  page,
}) => {
  let state = "Sending";
  await orderPage(page, () => ({
    orderReference: id(1),
    payment: { ...payment, onlineRefunds: [refund(state)], refundableMinor: "3600" },
    parts: [],
  }));
  await page.goto("/operations/orders");
  await expect(page.getByText(/^Going back to the card/u)).toBeVisible();
  await expect(page.getByText(/don't need to press again/u)).toBeVisible();
  state = "Refunded";
  await expect(page.getByText(/^Refunded to the card/u)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/don't need to press again/u)).toHaveCount(0);
});

test("@production staff without authority are told who refunds; a refusal can be refunded again", async ({
  page,
}) => {
  await orderPage(page, () => ({
    orderReference: id(1),
    payment: { ...payment, onlineRefunds: [refund("Refused")] },
    parts: [],
  }));
  await page.route("**/merchant/orders/table-payment/online-refund", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "denied" } }),
  );
  await page.goto("/operations/orders");
  await expect(page.getByText(/refused refund moved no money/u)).toBeVisible();
  await fill(page, "10");
  await page.getByRole("button", { name: /10\.00 to the card$/u }).click();
  await expect(page.getByRole("alert").filter({ hasText: "A manager refunds" })).toBeVisible();
});

test("@production a split bill shows each paid part with its own refund", async ({ page }) => {
  await orderPage(page, () => ({
    orderReference: id(1),
    payment: null,
    parts: [
      { ...payment, partNumber: 1 },
      { ...payment, partNumber: 2, method: "CardMachine", refundableMinor: "0" },
    ],
  }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/table-payment/online-refund", (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({
      headers,
      json: { payment: null, parts: [{ ...payment, partNumber: 1, refundableMinor: "3600" }] },
    });
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("region", { name: /part 2$/u })).toContainText(
    "can't be refunded here yet",
  );
  await fill(page, "10");
  await page.getByRole("button", { name: /10\.00 to the card$/u }).click();
  await expect.poll(() => bodies[0]?.partNumber).toBe(1);
});

for (const width of [1440, 1024, 390])
  test(`@production the refund form fits at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await orderPage(page, () => ({ orderReference: id(1), payment, parts: [] }));
    await page.goto("/operations/orders");
    await fill(page, "10");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

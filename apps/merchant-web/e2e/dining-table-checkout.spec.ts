import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (DIN-FLOOR-BOARD): a pay-later table pays once at the end. Staff
 * start checkout from Tables, read the whole table's bill, choose the tip and take cash — rounded
 * to 5 cents, with the change shown — then see the table's receipt and close it as usual.
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

const unpaidBill = (phase: "Active" | "Closing", version: number) => ({
  diningSessionReference: id(2),
  sessionPhase: phase,
  sessionVersion: version,
  paymentTiming: "PayLater",
  tableLabel: "T2",
  orderReference: id(3),
  rounds: [
    {
      roundNumber: 1,
      orderBatchReference: id(21),
      submissionReference: id(31),
      items: [{ displayName: "Shoyu Ramen", subtotalMinor: "2003", totalMinor: "2263" }],
      subtotalMinor: "2003",
      taxMinor: "260",
      totalMinor: "2263",
      paid: false,
    },
    {
      roundNumber: 2,
      orderBatchReference: id(22),
      submissionReference: id(32),
      items: [{ displayName: "Gyoza", subtotalMinor: "1000", totalMinor: "1130" }],
      subtotalMinor: "1000",
      taxMinor: "130",
      totalMinor: "1130",
      paid: false,
    },
  ],
  owed: { subtotalMinor: "3003", taxMinor: "390", totalMinor: "3393" },
  consistent: true,
  settlement: null,
});

async function floor(page: Page, state: { phase: "Active" | "Closing"; version: number }) {
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
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-15",
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
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T2",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 55,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: { phase: state.phase, version: state.version, orderReference: id(3) },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        tableLabel: "T2",
        diningSessionReference: id(2),
        sessionPhase: state.phase,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        sessionVersion: state.version,
        tableAssignmentVersion: 1,
        orderVersion: 4,
        phase: "Fulfilled",
        observedAt: "2026-10-15T19:00:00.000Z",
        // Every dish served.
        items: [21, 22].map((batch, index) => ({
          orderItemReference: id(100 + batch),
          orderBatchReference: id(batch),
          displayName: index === 0 ? "Shoyu Ramen" : "Gyoza",
          batchSequence: index + 1,
          itemOrdinal: 1,
          phase: "Fulfilled",
          orderedQuantity: 1,
          deliveredQuantity: 1,
          remainingQuantity: 0,
          itemServiceVersion: 1,
        })),
      },
    }),
  );
}

test("@production DEC-DINE-IN-PAY-LATER: staff start checkout, take cash rounded to 5 cents with change, and see the table's receipt", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = { phase: "Active", version: 6 };
  await floor(page, state);
  let paid = false;
  const closing: Record<string, unknown>[] = [];
  const settles: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/closing", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    closing.push(body);
    state.phase = "Closing";
    state.version = 7;
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "Applied", phase: "Closing", sessionVersion: 7 }),
    });
  });
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: [],
        closeBlockers: paid ? [] : ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  const paidBill = () => ({
    ...unpaidBill("Closing", 7),
    rounds: unpaidBill("Closing", 7).rounds.map((round) => ({ ...round, paid: true })),
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    settlement: {
      method: "Cash",
      roundsMinor: "3393",
      tipMinor: "450",
      roundingMinor: "2",
      totalMinor: "3845",
      tenderedMinor: "5000",
      changeMinor: "1155",
      recordedAt: "2026-10-15T19:05:00.000Z",
      recordedAfterOutage: false,
    },
  });
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: paid ? paidBill() : unpaidBill(state.phase, state.version) }),
  );
  await page.route("**/merchant/dining/table-settle", (route) => {
    settles.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    paid = true;
    return route.fulfill({ headers, json: { status: "Recorded", bill: paidBill() } });
  });

  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await expect(checkout).toContainText("This table pays once at the end.");
  await checkout.getByRole("button", { name: "Start checkout" }).click();
  expect(closing[0]).toMatchObject({
    action: "Begin",
    diningSessionReference: id(2),
    expectedSessionVersion: 6,
  });

  // The whole table's bill, round by round, then subtotal, tax and total.
  await expect(checkout.getByText("Round 1")).toBeVisible();
  await expect(checkout).toContainText("Shoyu Ramen");
  await expect(checkout).toContainText("Gyoza");
  await expect(checkout).toContainText("$33.93");
  // Not paid: the table can't be closed yet.
  await expect(page.getByRole("button", { name: "Close table T2", exact: true })).toHaveCount(0);

  await checkout.getByRole("radio", { name: /15%/u }).check();
  await checkout.getByRole("radio", { name: "Cash" }).check();
  // 33.93 + tip 4.50 = 38.43 → 38.45 in cash.
  await expect(checkout.getByText("Cash total $38.45 (rounded to 5 cents)")).toBeVisible();
  await checkout.getByRole("textbox", { name: "Cash received" }).fill("50");
  await expect(checkout.getByText("Change $11.55")).toBeVisible();
  // "Temporarily unavailable" is the Tables state filter's own wording.
  await expectNoInternalText(page, ["Temporarily unavailable"]);
  await checkout.getByRole("button", { name: "Cash received · $38.45" }).click();
  // The browser sends intent only: method, tip choice and the cash handed over — never totals.
  expect(settles).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      diningSessionReference: id(2),
      method: "Cash",
      tip: { kind: "Percent", percent: 15 },
      tenderedMinor: "5000",
      slipReference: null,
      recordedAfterOutage: false,
      takenAt: null,
    },
  ]);
  // One receipt for the whole table: tip, cash rounding, total, how it was paid and the change.
  const receipt = checkout.getByLabel("Receipt for table T2");
  await expect(receipt).toContainText("Cash rounding");
  await expect(receipt).toContainText("$38.45");
  await expect(receipt).toContainText("$11.55");
  await expect(checkout.getByRole("button", { name: "Print receipt" })).toBeVisible();
  // Paid in full and every dish served: the table can now be closed as usual.
  await expect(page.getByRole("button", { name: "Close table T2", exact: true })).toBeVisible();

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/dining-table-checkout-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
});

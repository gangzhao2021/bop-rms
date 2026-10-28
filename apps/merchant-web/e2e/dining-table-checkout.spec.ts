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
    // Begin starts checkout; Cancel takes the table back to ordering (DEC rule 3).
    state.phase = body.action === "Cancel" ? "Active" : "Closing";
    state.version += 1;
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        status: "Applied",
        phase: state.phase,
        sessionVersion: state.version,
      }),
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

  // The guests want more after all: checkout is cancelled and the table orders again.
  await expect(checkout.getByText("Round 1")).toBeVisible();
  await checkout.getByRole("button", { name: "Cancel checkout" }).click();
  await expect(checkout.getByRole("button", { name: "Start checkout" })).toBeVisible();
  expect(closing[1]).toMatchObject({ action: "Cancel", expectedSessionVersion: 7 });
  await checkout.getByRole("button", { name: "Start checkout" }).click();
  expect(closing[2]).toMatchObject({ action: "Begin", expectedSessionVersion: 8 });

  // The whole table's bill, round by round, then subtotal, tax and total.
  await expect(checkout.getByText("Round 1")).toBeVisible();
  await expect(checkout).toContainText("Shoyu Ramen");
  await expect(checkout).toContainText("Gyoza");
  await expect(checkout).toContainText("$33.93");
  // Not paid: the table can't be closed yet.
  await expect(page.getByRole("button", { name: "Close table T2", exact: true })).toHaveCount(0);

  // WP-2423 item 8 ① (Owner 2026-10-27): no tip is chosen for the guests; staff ask first.
  await expect(checkout.getByRole("radio", { name: /15%/u })).not.toBeChecked();
  await expect(checkout.getByRole("radio", { name: "No tip" })).not.toBeChecked();
  await expect(
    checkout.getByRole("button", { name: "Choose a tip to take payment" }),
  ).toBeDisabled();
  await checkout.getByRole("radio", { name: /15%/u }).check();
  await checkout.getByRole("radio", { name: "Cash" }).check();
  // 33.93 + tip 4.50 = 38.43 → 38.45 in cash.
  await expect(checkout.getByText("Cash total $38.45 (rounded to 5 cents)")).toBeVisible();
  await checkout.getByRole("textbox", { name: "Cash received" }).fill("50");
  await expect(checkout.getByText("Change $11.55")).toBeVisible();
  // "Temporarily unavailable" is the Tables state filter's own wording.
  await expectNoInternalText(page, ["Temporarily unavailable"]);
  await checkout.getByRole("button", { name: "Cash received · $38.45" }).click();
  // Money is confirmed: cash due (rounded), received and change, once more, before it is recorded.
  const confirm = checkout.getByRole("alertdialog", { name: "Confirm the payment" });
  await expect(confirm).toContainText("Cash due (rounded to 5 cents)$38.45");
  await expect(confirm).toContainText("Cash received$50.00");
  await expect(confirm).toContainText("Change to give$11.55");
  expect(settles).toEqual([]);
  await page.screenshot({ path: "test-results/dining-table-checkout-confirm.png", fullPage: true });
  await confirm.getByRole("button", { name: "Confirm $38.45 cash received" }).click();
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
  // A paid table never goes back to ordering: no Cancel checkout.
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
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

test("@production DEC-DINE-IN-PAY-LATER: a table the guests left without paying shows it was written off and offers no payment", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = {
    phase: "Closing",
    version: 7,
  };
  await floor(page, state);
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: [],
        closeBlockers: [],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        ...unpaidBill("Closing", 7),
        writeOff: { amountMinor: "3393", decidedAt: "2026-10-15T19:05:00.000Z" },
      },
    }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await expect(checkout.getByRole("heading", { name: "Written off" })).toBeVisible();
  await expect(checkout).toContainText("A manager wrote off $33.93");
  // Nothing to take, no second decision and no way back to ordering.
  await expect(checkout.getByRole("radio", { name: "Cash" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: "Guests left without paying" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

test("@production DEC-DINE-IN-PAY-LATER S4: while a guest pays on their phone staff take nothing else, and can stop a payment the guest gave up on", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = {
    phase: "Closing",
    version: 7,
  };
  await floor(page, state);
  let stopped = false;
  const stops: unknown[] = [];
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: [],
        closeBlockers: ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  const billNow = () => ({
    ...unpaidBill("Closing", 7),
    onlinePayment: {
      status: stopped ? "Cancelled" : "InProgress",
      totalMinor: "3843",
      tipMinor: "450",
      startedAt: "2026-10-15T19:01:00.000Z",
    },
  });
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: billNow() }),
  );
  await page.route("**/merchant/dining/table-online-payment/stop", (route) => {
    stops.push(route.request().postDataJSON());
    stopped = true;
    return route.fulfill({ headers, json: { status: "Stopped", bill: billNow() } });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await expect(checkout).toContainText("A guest is paying the whole table on their phone: $38.43.");
  // Nothing else to take, and no way back to ordering, while the guest pays.
  await expect(checkout.getByRole("radio", { name: "Cash" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  await checkout.getByRole("button", { name: "Stop the phone payment" }).click();
  expect(stops).toEqual([{ diningSessionReference: id(2) }]);
  // Stopped: the table is paid here as usual.
  await expect(checkout.getByRole("radio", { name: "Cash" })).toBeVisible();
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

/**
 * WP-2423 item 8 ④ (Figma "分单 / AA · v3"): a table split evenly in three — part 1 paid on the
 * card machine, part 3 being paid on a guest's phone — staff collect part 2 in cash with its own
 * rounding and change; the browser sends only the part number and intent.
 */
test("@production split bill: staff collect one part in cash while the others are paid or being paid", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = {
    phase: "Closing",
    version: 7,
  };
  await floor(page, state);
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: [],
        closeBlockers: [],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  const { splitBillFixture } = await import("../src/table-split.fixtures.js");
  const split = { ...splitBillFixture(), diningSessionReference: id(2), orderReference: id(3) };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: split }),
  );
  const sent: unknown[] = [];
  await page.route("**/merchant/dining/table-settle", (route) => {
    sent.push(route.request().postDataJSON());
    const paid = structuredClone(split) as typeof split & {
      split: { parts: Record<string, unknown>[]; paidParts: number; remainingMinor: string };
    };
    paid.split.parts[1] = {
      ...paid.split.parts[1],
      payment: {
        method: "Cash",
        tipMinor: "0",
        roundingMinor: "1",
        totalMinor: "3165",
        tenderedMinor: "4000",
        changeMinor: "835",
        recordedAt: "2026-10-29T00:50:00.000Z",
        recordedAfterOutage: false,
      },
    };
    paid.split.paidParts = 2;
    paid.split.remainingMinor = "3164";
    return route.fulfill({ headers, json: { status: "Recorded", bill: paid } });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  const parts = checkout.getByRole("list", { name: "Parts" });
  await expect(parts).toContainText("Part 1 · $31.64");
  await expect(parts).toContainText("Paid $35.84 · card machine");
  await expect(parts).toContainText("A guest is paying on their phone");
  await expect(checkout).toContainText("1 of 3 parts paid · $63.28 to go");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await checkout.screenshot({ path: `test-results/split-bill-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkout.getByRole("button", { name: "Collect this part" }).click();
  await expect(checkout.getByRole("heading", { name: "Collect part 2 of 3" })).toBeVisible();
  await expect(checkout).toContainText("This part with tax$31.64");
  await checkout.getByRole("radio", { name: "No tip" }).check();
  await checkout.getByRole("radio", { name: "Cash" }).check();
  await checkout.getByRole("textbox", { name: "Cash received" }).fill("40");
  await checkout.screenshot({ path: "test-results/split-bill-collect-1440.png" });
  // The part's own cash total, rounded to 5 cents: $31.64 → $31.65.
  await checkout.getByRole("button", { name: "Cash received · $31.65" }).click();
  const confirm = checkout.getByRole("alertdialog", { name: "Confirm the payment" });
  await confirm.getByRole("button", { name: "Confirm $31.65 cash received" }).click();
  await expect(checkout).toContainText("2 of 3 parts paid · $31.64 to go");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    diningSessionReference: id(2),
    method: "Cash",
    tip: { kind: "None" },
    tenderedMinor: "4000",
    partNumber: 2,
  });
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

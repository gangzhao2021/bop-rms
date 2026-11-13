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
      items: [
        {
          orderItemReference: id(901),
          quantity: 1,
          displayName: "Shoyu Ramen",
          subtotalMinor: "2003",
          totalMinor: "2263",
        },
      ],
      subtotalMinor: "2003",
      taxMinor: "260",
      totalMinor: "2263",
      paid: false,
    },
    {
      roundNumber: 2,
      orderBatchReference: id(22),
      submissionReference: id(32),
      items: [
        {
          orderItemReference: id(902),
          quantity: 1,
          displayName: "Gyoza",
          subtotalMinor: "1000",
          totalMinor: "1130",
        },
      ],
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

async function floor(
  page: Page,
  state: { phase: "Active" | "Closing"; version: number },
  options: { canWriteOff?: boolean; timeZone?: string } = {},
) {
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
          selectedScope:
            options.timeZone === undefined ? scope : { ...scope, timeZone: options.timeZone },
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
        ...(options.canWriteOff ? { canWriteOff: true } : {}),
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
  // The browser sends intent only: method, tip choice and the cash handed over. The server prices
  // the payment; the bill staff saw goes along only to be checked (refused if it changed since).
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
      owedMinor: "3393",
    },
  ]);
  // One receipt for the whole table: tip, cash rounding, total, how it was paid and the change.
  const receipt = checkout.getByLabel("Paid bill for table T2");
  await expect(receipt).toContainText("Cash rounding");
  await expect(receipt).toContainText("$38.45");
  await expect(receipt).toContainText("$11.55");
  await expect(checkout.getByRole("button", { name: "Print paid bill" })).toBeVisible();
  // v15 batch 7 (M50): printed, the paid bill starts at the top of the page — even from the
  // scrolled side panel at 1440/1024 — and says the Store, the table, when and every dish; the
  // Store/table header and dish list are for paper only.
  await expect(receipt.getByText("Synthetic Store")).toBeHidden();
  await page.evaluate(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => {
      const aside = document.querySelector(".dining-session-detail");
      if (aside !== null) aside.scrollTop = aside.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await checkout.getByRole("button", { name: "Print paid bill" }).click();
    await page.emulateMedia({ media: "print" });
    const printed = await page.evaluate(() => {
      const root = document.querySelector("[data-print-root]");
      const rect = root?.getBoundingClientRect();
      return {
        top: rect === undefined ? null : rect.top + window.scrollY,
        height: rect?.height ?? 0,
        text: root instanceof HTMLElement ? root.innerText : "",
        printing: document.body.getAttribute("data-printing"),
        bottom: rect === undefined ? 0 : rect.bottom + window.scrollY,
        pageHeight: document.documentElement.scrollHeight,
        windowHeight: window.innerHeight,
      };
    });
    expect(printed.printing).toBe("table-bill");
    expect(printed.top).not.toBeNull();
    expect(printed.top as number).toBeGreaterThanOrEqual(0);
    expect(printed.top as number).toBeLessThan(80);
    expect(printed.height).toBeGreaterThan(100);
    // Nothing but the bill is laid out: no blank pages after it.
    expect(printed.pageHeight).toBeLessThanOrEqual(
      Math.max(printed.windowHeight, printed.bottom + 100),
    );
    for (const words of ["Synthetic Store", "Table T2", "Paid ", "1 × Shoyu Ramen", "1 × Gyoza"])
      expect(printed.text).toContain(words);
    expect(printed.text).toContain("Total paid");
    expect(printed.text).not.toContain("Print paid bill");
    expect(printed.text).not.toContain("Close the table when the guests have left");
    await page.screenshot({ path: `test-results/dining-table-paid-bill-print-${width}.png` });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  }
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(3);
  await page.setViewportSize({ width: 1440, height: 900 });
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

test("@production the printed paid bill adds up: each dish less its comp or discount comes to the Subtotal", async ({
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
  // Two $12.50 dishes at a 13 % TEST tax: one comped in full ($14.13 with tax), one 10 % off
  // ($1.25 before tax, $1.41 with it). The round is $11.25 after comps, $1.47 tax.
  const bill = unpaidBill("Closing", 7);
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        ...bill,
        rounds: [
          {
            ...bill.rounds[0],
            items: [
              {
                orderItemReference: id(901),
                quantity: 1,
                displayName: "Synthetic noodles",
                subtotalMinor: "1250",
                totalMinor: "0",
                reduction: { kind: "Comp", percent: null, amountMinor: "1413", netMinor: "1250" },
              },
              {
                orderItemReference: id(903),
                quantity: 1,
                displayName: "Synthetic dumplings",
                subtotalMinor: "1250",
                totalMinor: "1272",
                reduction: { kind: "Percent", percent: 10, amountMinor: "141", netMinor: "125" },
              },
            ],
            subtotalMinor: "1125",
            taxMinor: "147",
            totalMinor: "1272",
            taxRoundingMinor: "0",
            paid: true,
          },
        ],
        taxRoundingMinor: "0",
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        tips: { enabled: false, tierPercents: [12, 18, 20] },
        settlement: {
          method: "CardMachine",
          roundsMinor: "1272",
          tipMinor: "0",
          roundingMinor: "0",
          totalMinor: "1272",
          tenderedMinor: null,
          changeMinor: null,
          recordedAt: "2026-10-15T19:05:00.000Z",
          recordedAfterOutage: false,
        },
      },
    }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await expect(checkout.getByRole("button", { name: "Print paid bill" })).toBeVisible();
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await checkout.getByRole("button", { name: "Print paid bill" }).click();
  await page.emulateMedia({ media: "print" });
  const paper = await page.evaluate(() => {
    const cents = (text: string) => {
      const found = /(−?)\$(\d+)\.(\d\d)/u.exec(text);
      if (found === null) return null;
      const value = Number(found[2]) * 100 + Number(found[3]);
      return found[1] === "−" ? -value : value;
    };
    const lines = [...document.querySelectorAll(".table-receipt__dishes > li")].map((li) => ({
      dish: cents((li.children[1] as HTMLElement).innerText),
      off: li.children[2] === undefined ? 0 : cents((li.children[2] as HTMLElement).innerText),
    }));
    const subtotal = [...document.querySelectorAll(".table-receipt dt")].find(
      (dt) => (dt as HTMLElement).innerText === "Subtotal",
    )?.nextElementSibling as HTMLElement | undefined;
    return {
      lines,
      subtotal: subtotal === undefined ? null : cents(subtotal.innerText),
      text: (document.querySelector("[data-print-root]") as HTMLElement | null)?.innerText ?? "",
    };
  });
  expect(paper.lines).toEqual([
    { dish: 1250, off: -1250 },
    { dish: 1250, off: -125 },
  ]);
  expect(paper.subtotal).toBe(1125);
  expect(paper.lines.reduce((sum, line) => sum + (line.dish ?? 0) + (line.off ?? 0), 0)).toBe(
    paper.subtotal,
  );
  expect(paper.text).toContain("Total paid");
  expect(paper.text).toContain("$12.72");
  await page.emulateMedia({ media: "screen" });
});

test("@production the paid bill states one tax, the bill's own: $2.93 on $22.50, no separate rounding", async ({
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
  // v15 batch 9 live finding (P7 C): 2 × $12.50, then 1 × $12.50, at a 13 % TEST tax. The second
  // round was comped; 10 % came off the first ($2.50 and $0.33 of its tax). The rounds were then
  // charged $2.92 of tax, and the bill's tax is round(22.50 × 13 %) = $2.93: the round's tax holds
  // that cent (its share of the bill's tax rounding).
  const bill = unpaidBill("Closing", 7);
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        ...bill,
        rounds: [
          {
            ...bill.rounds[0],
            items: [
              {
                orderItemReference: id(911),
                quantity: 2,
                displayName: "Synthetic noodles",
                subtotalMinor: "2500",
                totalMinor: "2542",
                reduction: { kind: "Percent", percent: 10, amountMinor: "283", netMinor: "250" },
              },
            ],
            subtotalMinor: "2250",
            taxMinor: "293",
            totalMinor: "2543",
            taxRoundingMinor: "1",
            paid: true,
          },
          {
            ...bill.rounds[1],
            items: [
              {
                orderItemReference: id(912),
                quantity: 1,
                displayName: "Synthetic noodles",
                subtotalMinor: "1250",
                totalMinor: "0",
                reduction: { kind: "Comp", percent: null, amountMinor: "1413", netMinor: "1250" },
              },
            ],
            subtotalMinor: "0",
            taxMinor: "0",
            totalMinor: "0",
            taxRoundingMinor: "0",
            paid: true,
          },
        ],
        taxRoundingMinor: "1",
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        tips: { enabled: false, tierPercents: [12, 18, 20] },
        settlement: {
          method: "CardMachine",
          roundsMinor: "2543",
          tipMinor: "0",
          roundingMinor: "0",
          totalMinor: "2543",
          tenderedMinor: null,
          changeMinor: null,
          recordedAt: "2026-10-15T19:05:00.000Z",
          recordedAfterOutage: false,
        },
      },
    }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  const receipt = checkout.getByLabel("Paid bill for table T2");
  await expect(receipt).toContainText("Subtotal$22.50");
  await expect(receipt).toContainText("Tax$2.93");
  await expect(receipt).not.toContainText("Tax rounding");
  await expect(receipt).toContainText("Total paid$25.43");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(receipt).toContainText("Tax$2.93");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/paid-bill-one-tax-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await checkout.getByRole("button", { name: "Print paid bill" }).click();
  await page.emulateMedia({ media: "print" });
  const paper = await page.evaluate(
    () => (document.querySelector("[data-print-root]") as HTMLElement | null)?.innerText ?? "",
  );
  expect(paper).toContain("$2.93");
  expect(paper).not.toContain("$2.92");
  expect(paper).not.toContain("Tax rounding");
  await page.emulateMedia({ media: "screen" });
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
  await expect(checkout).toContainText("$33.93 was written off");
  // Nothing to take, no second decision and no way back to ordering.
  await expect(checkout.getByRole("radio", { name: "Cash" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: "Guests left without paying" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

// A phone joined after the table was shown: the refused start reads the table again and tries once
// more as a new operation at the new version (live check 2026-11-03: it took a second tap).
test("@production staff can start checkout after a phone joined the table", async ({ page }) => {
  const state: { phase: "Active" | "Closing"; version: number } = { phase: "Active", version: 6 };
  await floor(page, state);
  const closing: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/closing", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    closing.push(body);
    if (body.expectedSessionVersion !== state.version)
      return route.fulfill({ status: 409, headers, json: { error: "version_conflict" } });
    state.phase = "Closing";
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
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: unpaidBill(state.phase, state.version) }),
  );

  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  const start = checkout.getByRole("button", { name: "Start checkout" });
  await expect(start).toBeVisible();
  state.version = 7;
  await start.click();
  // No second tap and no message: the refusal was only about the phone that joined.
  await expect.poll(() => closing.length).toBe(2);
  await expect(page.getByText("This table changed since it was shown.")).toHaveCount(0);
  await expect(checkout.getByText("Round 1")).toBeVisible();
  const last = closing.at(-1) as Record<string, unknown>;
  expect(last).toMatchObject({ action: "Begin", expectedSessionVersion: 7 });
  expect(last.operationReference).not.toBe(closing[0]?.operationReference);
  expect(state.phase).toBe("Closing");
});

// WP-2423 item 8 ⑦ (Owner decision 11): with tips off, staff are asked no tip and the payment is
// recorded with none; the Store's own percentages are offered while tips are on.
test("@production a store with tips off takes the table's payment with no tip", async ({
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
        closeBlockers: ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  let tips = { enabled: true, tierPercents: [12, 18, 20] };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: { ...unpaidBill("Closing", 7), tips } }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/table-settle", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, status: 409, json: { error: "tips_off" } });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  const tip = checkout.getByRole("group", { name: "Tip" });
  await expect(tip.getByRole("radio", { name: /^12% · /u })).toBeVisible();
  await expect(tip.getByRole("radio", { name: /^15%/u })).toHaveCount(0);
  // Tips turned off meanwhile: refused, the bill is read again and no tip is asked.
  await tip.getByRole("radio", { name: /^20% · /u }).check();
  await checkout.getByRole("radio", { name: "Card machine" }).check();
  tips = { enabled: false, tierPercents: [12, 18, 20] };
  await checkout.getByRole("button", { name: /^Paid on card machine · /u }).click();
  await checkout
    .getByRole("alertdialog", { name: "Confirm the payment" })
    .getByRole("button", { name: /^Confirm /u })
    .click();
  expect(sent[0]).toMatchObject({ tip: { kind: "Percent", percent: 20 } });
  await expect(checkout).toContainText(
    "Tips are turned off for this store, so nothing was recorded.",
  );
  await expect(tip).toBeHidden();
  // With no tip to choose, the payment is the bill as it stands.
  await expect(
    checkout.getByRole("button", { name: "Paid on card machine · $33.93" }),
  ).toBeEnabled();
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

// WP-2423 (v15 fabf0261, Hotpot PC 9): a table paid on paper is entered with its slip's time. A
// date other than today and a time a little before the last round was ordered are warned about
// (a card machine's clock drifts); a time well before it is refused by the server, and staff
// correct it in the paid-at field, where the refusal is said.
test("@production a table's paper paid-at is checked against when it ordered, and corrected where it is refused", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = {
    phase: "Closing",
    version: 7,
  };
  await floor(page, state, { timeZone: "America/Toronto" });
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
  const minute = 60_000;
  const lastRoundAt = Date.now() - 20 * minute;
  const bill = unpaidBill("Closing", 7);
  const liveBill = {
    ...bill,
    rounds: [
      { ...bill.rounds[0], liveOrderedAt: new Date(Date.now() - 50 * minute).toISOString() },
      { ...bill.rounds[1], liveOrderedAt: new Date(lastRoundAt).toISOString() },
    ],
  };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: liveBill }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/table-settle", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, status: 409, json: { error: "taken_before_ordered" } });
  });
  const storeLocal = (at: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(at))
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await checkout.getByRole("radio", { name: "No tip" }).check();
  await checkout.getByRole("radio", { name: "Card machine" }).check();
  await checkout
    .getByRole("checkbox", { name: "Paid while the system was down (enter it from paper now)" })
    .check();
  const paidAt = checkout.getByLabel("Paid at (store time)");
  // A slip from yesterday: the date is asked to be checked (it counts on the day it was paid).
  await paidAt.fill(storeLocal(Date.now() - 26 * 60 * minute));
  await expect(checkout.getByRole("note").filter({ hasText: "is not today" })).toBeVisible();
  // A typo well before the table ordered: the server refuses it, and the field says so.
  await checkout.getByRole("button", { name: /^Paid on card machine · /u }).click();
  const confirm = checkout.getByRole("alertdialog", { name: "Confirm the payment" });
  await expect(confirm).toContainText("Paid at");
  await expect(confirm).toContainText("is not today");
  await confirm.getByRole("button", { name: /^Confirm /u }).click();
  expect(sent[0]).toMatchObject({ recordedAfterOutage: true, takenAt: expect.any(String) });
  const refusal = checkout
    .getByRole("alert")
    .filter({ hasText: "before this table's last round was ordered in the system" });
  await expect(refusal).toBeVisible();
  await expect(paidAt).toBeFocused();
  await expect(paidAt).toHaveAttribute("aria-invalid", "true");
  await expect(paidAt).toHaveAttribute("aria-describedby", "table-checkout-paid-at-refused");
  // Corrected to the slip's time, a few minutes before the last round by the machine's clock:
  // warned about, not refused here, and the refusal is gone.
  await paidAt.fill(storeLocal(lastRoundAt - 5 * minute));
  await expect(paidAt).toHaveAttribute("aria-invalid", "false");
  await expect(refusal).toHaveCount(0);
  await checkout.getByRole("button", { name: /^Paid on card machine · /u }).click();
  await expect(confirm).toContainText(
    "This is before this table's last round was ordered in the system",
  );
  await expect(confirm).not.toContainText("is not today");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/dining-table-paper-paid-at-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await floor(page, state, { canWriteOff: true });
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
  // v15 2026-10-28: a part is paid, so checkout can't be cancelled.
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  // v15 2026-10-28 b: with parts unpaid, the write-off is offered for those parts only.
  await checkout.getByRole("button", { name: "Guests left without paying the rest" }).click();
  await expect(checkout.getByRole("group", { name: "Guests left without paying" })).toContainText(
    "left without paying the 2 parts still unpaid ($63.28)? The parts already paid stay paid.",
  );
  await checkout.getByRole("button", { name: "Cancel", exact: true }).click();
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
  // Once every part is paid, nothing is left to write off: not offered.
  const allPaid = structuredClone(split) as typeof split & {
    split: { parts: Record<string, unknown>[]; paidParts: number; remainingMinor: string };
    owed: { subtotalMinor: string; taxMinor: string; totalMinor: string };
  };
  for (const entry of allPaid.split.parts)
    entry.payment ??= {
      method: "Cash",
      tipMinor: "0",
      roundingMinor: "1",
      totalMinor: "3165",
      tenderedMinor: "4000",
      changeMinor: "835",
      recordedAt: "2026-10-29T00:55:00.000Z",
      recordedAfterOutage: false,
    };
  for (const entry of allPaid.split.parts) entry.guestPaying = false;
  allPaid.split.paidParts = 3;
  allPaid.split.remainingMinor = "0";
  allPaid.owed = { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" };
  await page.unroute("**/merchant/dining/table-bill");
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: allPaid }),
  );
  await page.reload();
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  await expect(checkout.getByRole("heading", { name: "Paid" })).toBeVisible();
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  await expect(checkout.getByRole("button", { name: /Guests left without paying/u })).toHaveCount(
    0,
  );
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

/**
 * WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06): guests pay by dish on their phones — one paid
 * the noodles online, another is paying the dumplings — and staff take the dishes nobody chose at
 * the counter: the rest's own amount, the browser sending no part (the server appends it).
 */
test("@production guests paying by dish: staff see each guest's dishes and take the rest", async ({
  page,
}) => {
  const state: { phase: "Active" | "Closing"; version: number } = {
    phase: "Closing",
    version: 7,
  };
  await floor(page, state, { canWriteOff: true });
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
  const base: Record<string, unknown> = {
    ...splitBillFixture(),
    diningSessionReference: id(2),
    orderReference: id(3),
  };
  const fixtureParts = (base.split as { parts: Record<string, unknown>[] }).parts;
  const byDish = (restPaid: boolean) =>
    structuredClone({
      ...base,
      owed: restPaid
        ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
        : { subtotalMinor: "1900", taxMinor: "248", totalMinor: "2148" },
      split: {
        ...(base.split as Record<string, unknown>),
        mode: "ByGuests",
        stale: false,
        dishChoices: [],
        paidInFull: restPaid,
        paidParts: restPaid ? 3 : 1,
        remainingMinor: restPaid ? "0" : "2148",
        restMinor: restPaid ? null : "1131",
        restSubtotalMinor: restPaid ? null : "1000",
        parts: [
          {
            ...fixtureParts[0],
            partNumber: 2,
            amountMinor: "1356",
            subtotalMinor: "1200",
            taxMinor: "156",
            dishes: [{ displayName: "Beef noodle soup", quantity: 1, shared: false }],
            payment: {
              ...(fixtureParts[0]?.payment as object),
              method: "Online",
              totalMinor: "1356",
            },
            guestPaying: false,
            choice: "Mine",
          },
          {
            ...fixtureParts[2],
            partNumber: 3,
            amountMinor: "1017",
            subtotalMinor: "900",
            taxMinor: "117",
            dishes: [{ displayName: "Pork dumplings", quantity: 3, shared: false }],
            payment: restPaid
              ? { ...(fixtureParts[0]?.payment as object), method: "Online", totalMinor: "1017" }
              : null,
            guestPaying: !restPaid,
            choice: "Chosen",
          },
          ...(restPaid
            ? [
                {
                  ...fixtureParts[1],
                  partNumber: 4,
                  amountMinor: "1131",
                  subtotalMinor: "1000",
                  taxMinor: "131",
                  dishes: [{ displayName: "Jasmine tea", quantity: 2, shared: false }],
                  payment: {
                    method: "Cash",
                    tipMinor: "0",
                    roundingMinor: "-1",
                    totalMinor: "1130",
                    tenderedMinor: "2000",
                    changeMinor: "870",
                    recordedAt: "2026-10-29T00:50:00.000Z",
                    recordedAfterOutage: false,
                  },
                  guestPaying: false,
                  choice: "Rest",
                  byStaff: true,
                },
              ]
            : []),
        ],
      },
    });
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: byDish(false) }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/table-settle", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, json: { status: "Recorded", bill: byDish(true) } });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  const parts = checkout.getByRole("list", { name: "Payments by dish" });
  await expect(checkout.getByRole("heading", { name: "Guests paying by dish" })).toBeVisible();
  await expect(parts).toContainText("Beef noodle soup");
  await expect(parts).toContainText("Paid $13.56");
  await expect(parts).toContainText("3 × Pork dumplings");
  await expect(parts).toContainText("A guest is paying on their phone");
  await expect(checkout).toContainText("Not chosen yet · $11.31. Take it at the counter below.");
  await expect(
    checkout.getByRole("heading", { name: "Take the rest at the counter" }),
  ).toBeVisible();
  await expect(checkout).toContainText("The rest with tax$11.31");
  // Guests are paying: checkout can't go back to ordering.
  await expect(checkout.getByRole("button", { name: "Cancel checkout" })).toHaveCount(0);
  await checkout.getByRole("radio", { name: "No tip" }).check();
  await checkout.getByRole("radio", { name: "Cash" }).check();
  await checkout.getByRole("textbox", { name: "Cash received" }).fill("20");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await checkout.screenshot({ path: `test-results/pay-by-dish-staff-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The rest's own cash total, rounded to 5 cents: $11.31 → $11.30.
  await checkout.getByRole("button", { name: "Cash received · $11.30" }).click();
  const confirm = checkout.getByRole("alertdialog", { name: "Confirm the payment" });
  await confirm.getByRole("button", { name: "Confirm $11.30 cash received" }).click();
  await expect(checkout.getByText("Every dish is paid.")).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    diningSessionReference: id(2),
    method: "Cash",
    tip: { kind: "None" },
    tenderedMinor: "2000",
    owedMinor: "1131",
  });
  expect(sent[0]).not.toHaveProperty("partNumber");
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

test("@production DEC-TAX-WHOLE-RECEIPT: checkout states one tax, the bill's own, as the paid bill does", async ({
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
        closeBlockers: ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  // The rounds were charged 260¢ + 130¢; the whole bill's tax is 1¢ less (on round 2).
  const bill = unpaidBill("Closing", 7);
  const rounds = bill.rounds.map((round, index) =>
    index === 1
      ? { ...round, taxMinor: "129", totalMinor: "1129", taxRoundingMinor: "-1" }
      : { ...round, taxRoundingMinor: "0" },
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        ...bill,
        rounds,
        taxRoundingMinor: "-1",
        owed: { subtotalMinor: "3003", taxMinor: "389", totalMinor: "3392" },
        tips: { enabled: false, tierPercents: [12, 18, 20] },
      },
    }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  // v15 b11: one tax, the whole bill's ($3.89), as the printed paid bill; no "Tax rounding" line.
  await expect(checkout).toContainText("Tax$3.89");
  await expect(checkout).not.toContainText("Tax rounding");
  // Each round as the bill charges it (its share of the rounding in its tax): they add up.
  await expect(checkout.locator(".table-checkout__rounds > li").nth(1)).toContainText(
    "Round 2$11.29",
  );
  await expect(checkout).toContainText("Total with tax$33.92");
  await checkout.getByRole("radio", { name: "Card machine" }).check();
  await expect(
    checkout.getByRole("button", { name: "Paid on card machine · $33.92" }),
  ).toBeEnabled();
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

test("@production a table payment the server failed goes again as the same request, so it is recorded once", async ({
  page,
}) => {
  await floor(page, { phase: "Closing", version: 7 });
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
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: unpaidBill("Closing", 7) }),
  );
  const settles: { operationReference: string }[] = [];
  let failing = true;
  await page.route("**/merchant/dining/table-settle", (route) => {
    settles.push(route.request().postDataJSON() as { operationReference: string });
    if (failing) return route.fulfill({ status: 503, headers, json: { error: "retry_later" } });
    const paid = unpaidBill("Closing", 8);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        bill: {
          ...paid,
          rounds: paid.rounds.map((round) => ({ ...round, paid: true })),
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          settlement: {
            method: "Cash",
            roundsMinor: "3393",
            tipMinor: "0",
            roundingMinor: "2",
            totalMinor: "3395",
            tenderedMinor: "5000",
            changeMinor: "1605",
            recordedAt: "2026-10-15T19:05:00.000Z",
            recordedAfterOutage: false,
          },
        },
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await checkout.getByRole("radio", { name: "No tip" }).check();
  await checkout.getByRole("radio", { name: "Cash" }).check();
  await checkout.getByRole("textbox", { name: "Cash received" }).fill("50");
  const pay = async () => {
    await checkout.getByRole("button", { name: "Cash received · $33.95" }).click();
    await checkout
      .getByRole("alertdialog", { name: "Confirm the payment" })
      .getByRole("button", { name: "Confirm $33.95 cash received" })
      .click();
  };
  await pay();
  await expect(
    checkout.getByText("We couldn't confirm the result. Press again: it is never recorded twice.", {
      exact: false,
    }),
  ).toBeVisible();
  // The payment may already be recorded: never "card machine for payment" here.
  await expect(checkout.getByText("do not charge them again", { exact: false })).toBeVisible();
  const words = (await checkout.innerText()).toLowerCase();
  expect(words).not.toContain("connection");
  expect(words).not.toContain("permission");
  expect(words).not.toContain("card machine for payment");
  failing = false;
  await pay();
  await expect(checkout.getByLabel("Paid bill for table T2")).toContainText("$33.95");
  expect(settles).toHaveLength(2);
  expect(settles[1]?.operationReference).toBe(settles[0]?.operationReference);
});

// v15 2026-11-06 (Fireside Table 5): a guest round waiting for staff OK is not on the bill and
// no payment is taken until staff decide it, right in checkout. Sending it puts it on the bill.
test("@production a round waiting for staff OK is decided in checkout before the table pays", async ({
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
        closeBlockers: ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  let sent = false;
  const decisions: Record<string, unknown>[] = [];
  const settles: Record<string, unknown>[] = [];
  const waiting = {
    ...unpaidBill("Closing", 7),
    rounds: unpaidBill("Closing", 7).rounds.slice(0, 1),
    owed: { subtotalMinor: "2003", taxMinor: "260", totalMinor: "2263" },
    waitingRounds: [
      {
        orderReference: id(3),
        orderBatchReference: id(22),
        heldAt: "2026-10-15T18:50:00.000Z",
        reason: "PhoneRapid",
        itemCount: 1,
        totalMinor: "1130",
        orderedBy: 2,
      },
    ],
    tips: { enabled: false, tierPercents: [12, 18, 20] },
  };
  const afterSend = {
    ...unpaidBill("Closing", 7),
    waitingRounds: [],
    tips: { enabled: false, tierPercents: [12, 18, 20] },
  };
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: sent ? afterSend : waiting }),
  );
  await page.route("**/merchant/dining/held-round", (route) => {
    decisions.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    sent = true;
    return route.fulfill({ headers, json: { status: "Sent" } });
  });
  await page.route("**/merchant/dining/table-settle", (route) => {
    settles.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        bill: {
          ...afterSend,
          rounds: afterSend.rounds.map((round) => ({ ...round, paid: true })),
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          settlement: {
            method: "CardMachine",
            roundsMinor: "3393",
            tipMinor: "0",
            roundingMinor: "0",
            totalMinor: "3393",
            tenderedMinor: null,
            changeMinor: null,
            recordedAt: "2026-10-15T19:05:00.000Z",
            recordedAfterOutage: false,
          },
        },
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const checkout = page.getByRole("region", { name: "Checkout" });
  await expect(checkout).toContainText(
    "1 round is waiting for your OK and is not on this bill ($11.30). Send it to the kitchen or cancel it before taking payment.",
  );
  await expect(checkout).toContainText("A round the guests were already served or charged for");
  // The bill is round 1 only; no payment until the waiting round is decided.
  await expect(checkout).toContainText("Total with tax$22.63");
  await checkout.getByRole("radio", { name: "Card machine" }).check();
  const blocked = checkout.getByRole("button", {
    name: "Decide the rounds waiting for your OK first",
  });
  await expect(blocked).toBeDisabled();
  await expect(page.getByText("cancelled automatically")).toHaveCount(0);
  await expect(page.getByText("Card payment not confirmed")).toHaveCount(0);
  const results = await new AxeBuilder({ page }).include(".table-checkout").analyze();
  expect(results.violations).toEqual([]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await checkout.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/held-round-checkout-${width}.png`,
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Staff send it to the kitchen: it is on the bill, and the payment takes the new total.
  await checkout.getByRole("button", { name: "Send to kitchen" }).click();
  expect(decisions[0]).toMatchObject({
    action: "Confirm",
    orderReference: id(3),
    orderBatchReference: id(22),
  });
  await expect(checkout).toContainText("Total with tax$33.93");
  await expect(checkout).not.toContainText("waiting for your OK and is not on this bill");
  const pay = checkout.getByRole("button", { name: "Paid on card machine · $33.93" });
  await expect(pay).toBeEnabled();
  await pay.click();
  await checkout.getByRole("button", { name: "Confirm $33.93 paid" }).click();
  await expect.poll(() => settles.length).toBe(1);
  expect(settles[0]).toMatchObject({ method: "CardMachine", owedMinor: "3393" });
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

// v15 batch 8 (table-pay-by-dish, print-orders-records): a table paid in full reads paid on the
// Tables list even when the order queue read is slow or fails: the row is said from the table's
// own bill (the panel's), never "Checking the bill" while the money is in.
for (const width of [1440, 1024, 390])
  test(`@production a table paid in full reads paid on the list without the order queue at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await floor(page, { phase: "Closing", version: 7 });
    // The order queue never answers in time (load on the server).
    await page.route("**/merchant/orders*", (route) => route.abort("timedout"));
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({
        headers,
        json: {
          ...unpaidBill("Closing", 7),
          rounds: unpaidBill("Closing", 7).rounds.map((round) => ({ ...round, paid: true })),
          owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
          settlement: {
            method: "Online",
            roundsMinor: "3393",
            tipMinor: "0",
            roundingMinor: "0",
            totalMinor: "3393",
            tenderedMinor: null,
            changeMinor: null,
            recordedAt: "2026-10-15T19:05:00.000Z",
            recordedAfterOutage: false,
          },
        },
      }),
    );
    await page.goto("/operations/dining");
    const row = page
      .locator(".table-row")
      .filter({ has: page.getByRole("button", { name: "Select T2", exact: true }) });
    await expect(row).toContainText("Paid · close when the guests leave");
    await expect(row).toContainText("$33.93");
    await expect(row).not.toContainText("Checking the bill");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await row.screenshot({ path: `test-results/tables-paid-row-${width}.png` });
  });

// Review of f9d052f0: a table checking out that the order queue never brings is read from its own
// bill on every list read, so a guest who pays on the phone between two reads turns the row to
// paid at the next read — the row never keeps telling staff to take a payment already made.
test("@production a table checking out the queue never brings reads paid once the guest pays between two reads", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-15T19:00:00.000Z") });
  await floor(page, { phase: "Closing", version: 7 });
  await page.route("**/merchant/orders*", (route) => route.abort("timedout"));
  let guestPaid = false;
  let billReads = 0;
  await page.route("**/merchant/dining/table-bill", (route) => {
    billReads += 1;
    const bill = unpaidBill("Closing", 7);
    return route.fulfill({
      headers,
      json: guestPaid
        ? {
            ...bill,
            rounds: bill.rounds.map((round) => ({ ...round, paid: true })),
            owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
            settlement: {
              method: "Online",
              roundsMinor: "3393",
              tipMinor: "0",
              roundingMinor: "0",
              totalMinor: "3393",
              tenderedMinor: null,
              changeMinor: null,
              recordedAt: "2026-10-15T19:00:20.000Z",
              recordedAfterOutage: false,
            },
          }
        : bill,
    });
  });
  await page.goto("/operations/dining");
  const row = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select T2", exact: true }) });
  await expect(row).toContainText("Waiting for payment");
  await expect(row).toContainText("$33.93");
  const firstReads = billReads;
  // The guest pays in full on the phone; the queue still never answers.
  guestPaid = true;
  // The list reads again every 30 seconds (two 15-second ticks).
  await page.clock.fastForward(15_500);
  await page.clock.fastForward(15_500);
  await expect(row).toContainText("Paid · close when the guests leave");
  await expect(row).not.toContainText("Waiting for payment");
  await expect(row).not.toContainText("Checking the bill");
  expect(billReads).toBeGreaterThan(firstReads);
});

for (const width of [390, 1024, 1440])
  test(`@production a bill that is slow to read tells staff it is still coming, then shows, at ${width}`, async ({
    page,
  }) => {
    // v15 2026-11-11: on a busy evening a merged table's bill took 7–8 s, with only "Reading the
    // bill…" on screen, and staff wondered whether to tap again.
    await page.setViewportSize({ width, height: 900 });
    await floor(page, { phase: "Closing", version: 7 });
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
    await page.route("**/merchant/dining/table-bill", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.fulfill({
        headers,
        json: {
          ...unpaidBill("Closing", 7),
          taxRoundingMinor: "0",
          owed: { subtotalMinor: "3003", taxMinor: "390", totalMinor: "3393" },
          tips: { enabled: false, tierPercents: [12, 18, 20] },
        },
      });
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "Select T2", exact: true }).click();
    const checkout = page.getByRole("region", { name: "Checkout" });
    await expect(checkout.getByText("Reading the bill…")).toBeVisible();
    await expect(
      checkout.getByText("Still working; the system is busy.", { exact: false }),
    ).toBeVisible({
      timeout: 4_500,
    });
    await expect(checkout.getByText("Round 1")).toBeVisible({ timeout: 8_000 });
    await expect(
      checkout.getByText("Still working; the system is busy.", { exact: false }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
  });

for (const width of [390, 1024, 1440])
  test(`@production a bill read that never answers is given up, staff are told, and the next read shows the bill, at ${width}`, async ({
    page,
  }) => {
    // Review of checkout-session-outage: a re-read waits for the one still running, so a read that
    // never settles (tablet Wi-Fi dropped mid-request) would stop every later re-read.
    await page.clock.install();
    await page.setViewportSize({ width, height: 900 });
    await floor(page, { phase: "Closing", version: 7 });
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
    // The Tables list reads a table checking out from its own bill too (v15 batch 8), on the same
    // route and often first, so counting requests never says which read is the panel's. Instead
    // every bill read sent while the connection is down never answers, as when the Wi-Fi drops.
    let down = true;
    let reads = 0;
    let answered = 0;
    await page.route("**/merchant/dining/table-bill", async (route) => {
      reads += 1;
      if (down) return;
      answered += 1;
      await route.fulfill({
        headers,
        json: {
          ...unpaidBill("Closing", 7),
          taxRoundingMinor: "0",
          owed: { subtotalMinor: "3003", taxMinor: "390", totalMinor: "3393" },
          tips: { enabled: false, tierPercents: [12, 18, 20] },
        },
      });
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "Select T2", exact: true }).click();
    const checkout = page.getByRole("region", { name: "Checkout" });
    await expect(checkout.getByText("Reading the bill…")).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
    // Before the ceiling the open read is waited for: staff still see it reading, not given up.
    await page.clock.runFor(20_000);
    await expect(checkout.getByText("Reading the bill…")).toBeVisible();
    await expect(checkout.getByText("couldn't be read just now", { exact: false })).toHaveCount(0);
    await page.clock.runFor(5_500);
    await expect(
      checkout.getByText("The bill couldn't be read just now. Trying again by itself."),
    ).toBeVisible();
    // The re-read sent as the first was given up is lost too (still down): it is given up in turn,
    // and once the connection is back the read after it shows the bill.
    down = false;
    await page.clock.runFor(25_000);
    await expect(checkout.getByText("Round 1")).toBeVisible();
    await expect(checkout.getByText("couldn't be read just now", { exact: false })).toHaveCount(0);
    expect(answered).toBeGreaterThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
  });

// v15 batch 11 (tables-list-bill-reads): three tables checking out while the order queue fails.
// One table's bill answers 503 every time (BR C at Test Merchant 2): the other two are still read
// and shown, each on its own, and a guest who pays on the phone turns that table's row to paid.
const threeClosing = (page: Page) =>
  page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        items: [1, 2, 3].map((n) => ({
          tableReference: id(10 + n),
          stableLabel: "C" + String(n),
          areaCode: "MAIN",
          capacity: 4,
          lifecycle: "Published",
          operationalState: "Available",
          blockReasonCode: null,
          aggregateVersion: 2,
          currentDiningSessionReference: id(20 + n),
          elapsedMinutes: 55,
          qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          paymentTiming: "PayLater",
          session: { phase: "Closing", version: 7, orderReference: id(30 + n) },
          staffRoundsAwaitingPayment: [],
        })),
        nextAfterTableReference: null,
      },
    }),
  );
const paidOnPhone = (bill: ReturnType<typeof unpaidBill>) => ({
  ...bill,
  rounds: bill.rounds.map((round) => ({ ...round, paid: true })),
  owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
  settlement: {
    method: "Online",
    roundsMinor: "3393",
    tipMinor: "0",
    roundingMinor: "0",
    totalMinor: "3393",
    tenderedMinor: null,
    changeMinor: null,
    recordedAt: "2026-10-15T19:00:20.000Z",
    recordedAfterOutage: false,
  },
});
for (const width of [390, 1024, 1440])
  test(`@production one table whose bill can't be read never holds back the others on the list at ${width}`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-15T19:00:00.000Z") });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await floor(page, { phase: "Closing", version: 7 });
    await threeClosing(page);
    await page.route("**/merchant/orders*", (route) => route.abort("timedout"));
    let guestPaid = false;
    const reads: string[] = [];
    await page.route("**/merchant/dining/table-bill", (route) => {
      const session = (route.request().postDataJSON() as { diningSessionReference: string })
        .diningSessionReference;
      reads.push(session);
      // C1's bill answers "try again later" every time.
      if (session === id(21))
        return route.fulfill({ status: 503, headers, json: { error: "retry_later" } });
      const n = Number.parseInt(session.slice(-2), 16) - 0x20;
      const bill = {
        ...unpaidBill("Closing", 7),
        diningSessionReference: session,
        orderReference: id(30 + n),
        tableLabel: "C" + String(n),
      };
      return route.fulfill({
        headers,
        json: guestPaid && session === id(23) ? paidOnPhone(bill) : bill,
      });
    });
    await page.goto("/operations/dining");
    const row = (label: string) =>
      page
        .locator(".table-row")
        .filter({ has: page.getByRole("button", { name: `Select ${label}`, exact: true }) });
    await expect(row("C2")).toContainText("Waiting for payment");
    await expect(row("C2")).toContainText("$33.93");
    await expect(row("C3")).toContainText("Waiting for payment");
    // v15 b12: C1's own bill and the queue both failed: it stays in "Needs action" with its Take
    // payment step, never moved among the seated tables as "Checking the bill".
    await expect(row("C1")).toContainText("Checking out · bill not read");
    await expect(row("C1")).toContainText("open the table to see what is owed");
    await expect(row("C1").getByRole("button", { name: "Take payment" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Needs action/u }).locator(".table-tabs__count"),
    ).toHaveText("3");
    // The guest at C3 pays in full on the phone; C1 still fails and the queue still never answers.
    guestPaid = true;
    await page.clock.fastForward(15_500);
    await page.clock.fastForward(15_500);
    await expect(row("C3")).toContainText("Paid · close when the guests leave");
    await expect(row("C3")).not.toContainText("Waiting for payment");
    await expect(row("C2")).toContainText("Waiting for payment");
    // Every table checking out was read in each list read, C1 included.
    expect(reads.filter((session) => session === id(23)).length).toBeGreaterThanOrEqual(2);
    expect(reads.filter((session) => session === id(21)).length).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/tables-one-bill-fails-${width}.png` });
  });

// v15 batch 11: the queue answered once (the table owes $33.93), then fails. The guest pays in full
// on the phone: the table's own bill, read after it, turns the row to paid.
test("@production a table the queue last said owes money reads paid once its own bill says the guest paid", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-15T19:00:00.000Z") });
  await floor(page, { phase: "Closing", version: 7 });
  let queueFails = false;
  await page.route("**/merchant/orders*", (route) =>
    queueFails
      ? route.abort("timedout")
      : route.fulfill({
          headers,
          json: {
            items: [
              {
                orderReference: id(3),
                orderNumber: "ORD-3",
                orderType: "DineIn",
                sourceChannel: "Qr",
                submittedAt: "2026-10-15T18:10:00.000Z",
                observedAt: "2026-10-15T19:00:00.000Z",
                initialBatchReference: id(21),
                batches: [
                  {
                    orderBatchReference: id(21),
                    sequence: 1,
                    acceptanceStatus: "Accepted",
                    canRequestAcceptance: false,
                    canCancel: false,
                    staffCancellation: null,
                    canCancelItems: false,
                  },
                ],
                canRequestAcceptance: false,
                readyToServeItemCount: 0,
                tableBill: { totalMinor: "3393", paid: null },
                currentPhase: "Fulfilled",
                currentVersion: 4,
                unfulfillable: null,
                pickupNotCollected: false,
                acceptBy: null,
                awaitingPayment: false,
              },
            ],
            nextAfterOrderReference: null,
          },
        }),
  );
  let guestPaid = false;
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: guestPaid ? paidOnPhone(unpaidBill("Closing", 7)) : unpaidBill("Closing", 7),
    }),
  );
  await page.goto("/operations/dining");
  const row = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select T2", exact: true }) });
  await expect(row).toContainText("Waiting for payment");
  await expect(row).toContainText("$33.93");
  queueFails = true;
  guestPaid = true;
  await page.clock.fastForward(15_500);
  await page.clock.fastForward(15_500);
  await expect(row).toContainText("Paid · close when the guests leave");
  await expect(row).not.toContainText("Waiting for payment");
});

// v15 batch 11: stopping a phone payment asks the payment company, which can take a while on a busy
// evening. Staff are told what is happening and not to take the payment another way meanwhile;
// the bill's own re-reads wait, and a bill read before the stop answers never puts the phone
// payment back on screen.
for (const width of [390, 1024, 1440])
  test(`@production stopping a phone payment says what staff wait for at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await floor(page, { phase: "Closing", version: 7 });
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
    let stopped = false;
    let billReadsDuringStop = 0;
    let stopping = false;
    const billOf = (status: string) => ({
      ...unpaidBill("Closing", 7),
      onlinePayment: {
        status,
        totalMinor: "3843",
        tipMinor: "450",
        startedAt: "2026-10-15T19:01:00.000Z",
      },
    });
    await page.route("**/merchant/dining/table-bill", (route) => {
      if (stopping) billReadsDuringStop += 1;
      return route.fulfill({ headers, json: billOf(stopped ? "Cancelled" : "InProgress") });
    });
    let answerStop: () => void = () => undefined;
    await page.route("**/merchant/dining/table-online-payment/stop", async (route) => {
      stopping = true;
      await new Promise<void>((resolve) => (answerStop = resolve));
      stopped = true;
      stopping = false;
      return route.fulfill({ headers, json: { status: "Stopped", bill: billOf("Cancelled") } });
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "Select T2", exact: true }).click();
    const checkout = page.getByRole("region", { name: "Checkout" });
    await checkout.getByRole("button", { name: "Stop the phone payment" }).click();
    await expect(
      checkout.getByRole("button", { name: "Stopping the phone payment…" }),
    ).toBeDisabled();
    await expect(checkout).toContainText(
      "Asking the payment company whether the guest finished paying. Don't take the payment another way until it answers.",
    );
    // Longer than the bill's 5-second re-read: it waits for the stop.
    await page.waitForTimeout(6_500);
    expect(billReadsDuringStop).toBe(0);
    await checkout.screenshot({ path: `test-results/table-phone-stopping-${width}.png` });
    answerStop();
    await expect(checkout).toContainText("Phone payment stopped. Take the payment here.");
    await expect(checkout.getByRole("radio", { name: "Cash" })).toBeVisible();
    // v15 b12: said where the phone payment was, above how the table pays — not under "Cancel
    // checkout" — and in the panel's own text size.
    const stoppedLine = checkout.locator(".table-checkout__phone-stopped");
    await expect(stoppedLine).toHaveText("Phone payment stopped. Take the payment here.");
    const before = (a: string, b: string) =>
      page.evaluate(
        ([first, second]) => {
          const x = document.querySelector(first!);
          const y = document.querySelector(second!);
          return (
            x !== null &&
            y !== null &&
            (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          );
        },
        [a, b],
      );
    expect(await before(".table-checkout__phone-stopped", ".table-checkout__method")).toBe(true);
    expect(await before(".table-checkout__phone-stopped", ".table-checkout__cancel")).toBe(true);
    expect(
      await stoppedLine.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    await checkout.screenshot({ path: `test-results/table-phone-stopped-${width}.png` });
    await expect(checkout).not.toContainText("Asking the payment company");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

// v15 batch 11 review: a stop that never answers (Wi-Fi dropped mid-request) is given up. Staff are
// told it isn't known whether it stopped, never that they lack access or were signed out, and the
// bill's re-reads start again, so a guest who finished paying meanwhile reads paid.
for (const width of [390, 1024, 1440])
  test(`@production a phone payment stop that never answers is given up and the bill read again at ${width}`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-15T19:02:00.000Z") });
    await page.setViewportSize({ width, height: 900 });
    await floor(page, { phase: "Closing", version: 7 });
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
    let guestPaid = false;
    const paying = {
      ...unpaidBill("Closing", 7),
      onlinePayment: {
        status: "InProgress",
        totalMinor: "3843",
        tipMinor: "450",
        startedAt: "2026-10-15T19:01:00.000Z",
      },
    };
    const paid = {
      ...unpaidBill("Closing", 7),
      rounds: unpaidBill("Closing", 7).rounds.map((round) => ({ ...round, paid: true })),
      owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
      settlement: {
        method: "Online",
        roundsMinor: "3393",
        tipMinor: "450",
        roundingMinor: "0",
        totalMinor: "3843",
        tenderedMinor: null,
        changeMinor: null,
        recordedAt: "2026-10-15T19:02:10.000Z",
        recordedAfterOutage: false,
      },
    };
    // While the connection is down, a bill read sent never answers either.
    let down = false;
    await page.route("**/merchant/dining/table-bill", async (route) => {
      if (down) return;
      await route.fulfill({ headers, json: guestPaid ? paid : paying });
    });
    let stopsSent = 0;
    // The stop never answers.
    await page.route("**/merchant/dining/table-online-payment/stop", () => {
      stopsSent += 1;
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "Select T2", exact: true }).click();
    const checkout = page.getByRole("region", { name: "Checkout" });
    const stop = checkout.getByRole("button", { name: "Stop the phone payment" });
    await expect(stop).toBeVisible();
    // The connection drops: the bill's next re-read is sent and never answers, then Stop is pressed.
    down = true;
    await page.clock.runFor(5_500);
    await stop.click();
    await expect(
      checkout.getByRole("button", { name: "Stopping the phone payment…" }),
    ).toBeDisabled();
    await expect.poll(() => stopsSent).toBe(1);
    // The re-read reaches its own limit during the stop: no "trying again" is said, as none runs.
    await page.clock.runFor(25_000);
    await expect(checkout).toContainText("Asking the payment company");
    await expect(checkout).not.toContainText("Trying again by itself");
    // The connection is back; the stop itself never answers and is given up.
    down = false;
    await page.clock.runFor(6_000);
    await expect(
      checkout.getByText(
        "No answer came about stopping the phone payment, so it isn't known whether it stopped or whether the guest paid. The bill is being read again: check it before taking the payment another way.",
      ),
    ).toBeVisible();
    await expect(checkout).not.toContainText("Asking the payment company");
    await expect(checkout).not.toContainText("Your access doesn't allow this");
    await expect(page.getByText("signed out", { exact: false })).toHaveCount(0);
    // The bill was read again: the phone payment still reads open, and Stop can be pressed again.
    await expect(stop).toBeEnabled();
    await checkout.screenshot({ path: `test-results/table-phone-stop-unanswered-${width}.png` });
    // The guest finishes paying on the phone: the next re-read shows it paid, nothing more to take.
    guestPaid = true;
    await page.clock.runFor(5_500);
    await expect(checkout).toContainText("Paid in full.");
    await expect(checkout.getByRole("radio", { name: "Cash" })).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    expect(stopsSent).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
  });

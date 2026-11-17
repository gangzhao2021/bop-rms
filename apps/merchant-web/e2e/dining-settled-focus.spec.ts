import { expect, test, type Page } from "@playwright/test";

/**
 * b25 (live24, Tables): after a comp is confirmed, the floor is reread and the table panel locks
 * for a moment; the focus then goes back to "Comp or discount". When staff click plain page text
 * meanwhile (a tap moves no focus), they have moved on: the focus is never pulled back to the
 * button afterwards. With nothing done meanwhile, the focus still goes back (b24). The same holds
 * for a take-off of one dish of a round (its "Take dishes off round 1" stays on the page).
 *
 * b25 review: when the confirm fails (an outage, a refusal) the panel stays open, and Cancel, by
 * click or Enter, gives the focus back to the opener again; it never drops to the page itself.
 *
 * The confirm is held until the test lets it answer, so a tap or key press is known to come while
 * the confirm is still on its way (never after the answer, whatever the machine's speed).
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

type Action = "comp" | "takeOff";
/** How the confirm answers: held until `answer()` is called, or refused at once with a status. */
type ConfirmAnswer = "held" | 503 | 403;

async function tableWith(page: Page, action: Action, answerWith: ConfirmAnswer) {
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
          businessDate: "2026-10-27",
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
  let done = false;
  let rereadsAfterDone = 0;
  // The floor reread after the confirm is slow, so the panel stays locked for a while.
  await page.route("**/merchant/dining/tables", async (route) => {
    if (done) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        canTransferHost: false,
        canCancelUnpaidRounds: true,
        canWriteOff: true,
        items: [
          {
            tableReference: id(70),
            stableLabel: "T3",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(71),
            elapsedMinutes: 48,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: { phase: "Active", version: 3, orderReference: id(1) },
            staffRoundsAwaitingPayment: [],
            guestRoundsAwaitingPayment: [],
            roundsAwaitingAcceptance: [],
            staffCall: null,
          },
        ],
        nextAfterTableReference: null,
      },
    });
  });
  const line = (n: number, name: string) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(51),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1000"),
    subtotal: money("1000"),
    discount: money("0"),
    tax: money("130"),
    fee: money("0"),
    total: money("1130"),
    canCancel: false,
    cancellation: null,
  });
  const comp = action === "comp";
  const order = () => ({
    orderReference: id(1),
    orderNumber: "T-1",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-10-27T23:00:00.000Z",
    observedAt: "2026-10-27T23:40:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        // The other dish can still be comped or taken off afterwards, so the opener stays.
        unpaidRemovableItems: comp ? [] : done ? [id(201)] : [id(201), id(202)],
        unpaidRemovedItems: !comp && done ? [id(202)] : [],
        compableItems: !comp ? [] : done ? [id(201)] : [id(201), id(202)],
        compedItems:
          comp && done
            ? [{ orderItemReference: id(202), kind: "Comp", percent: null, amountMinor: "1130" }]
            : [],
      },
    ],
    canRequestAcceptance: false,
    tableBill: done ? { totalMinor: "1130", paid: null } : { totalMinor: "2260", paid: null },
    currentPhase: "InProgress",
    currentVersion: done ? 4 : 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) => {
    if (done) rereadsAfterDone += 1;
    return route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(),
        lines: {
          items: [line(1, "Synthetic mapo tofu"), line(2, "Synthetic boiled fish")],
          totals: {
            subtotal: money("2000"),
            discount: money("0"),
            tax: money("260"),
            fee: money("0"),
            taxRounding: money("0"),
            total: money("2260"),
          },
        },
      },
    });
  });
  await page.route("**/merchant/orders/comp-items/preview", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Preview",
        totalMinor: "1130",
        lines: [{ orderItemReference: id(202), amountMinor: "1130" }],
      },
    }),
  );
  await page.route("**/merchant/orders/remove-unpaid-items/preview", (route) =>
    route.fulfill({ headers, json: { status: "Preview", totalMinor: "1130" } }),
  );
  let letAnswer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    letAnswer = resolve;
  });
  let confirmsAsked = 0;
  const recorded = comp
    ? {
        status: "Recorded",
        reductions: [
          {
            orderItemReference: id(202),
            kind: "Comp",
            percent: null,
            amountMinor: "1130",
            reasonCode: "GOODWILL",
            decidedAt: "2026-10-27T23:41:00.000Z",
          },
        ],
      }
    : { status: "Removed" };
  await page.route(
    comp ? "**/merchant/orders/comp-items" : "**/merchant/orders/remove-unpaid-items",
    async (route) => {
      confirmsAsked += 1;
      if (answerWith !== "held") {
        await route.fulfill({ status: answerWith, headers, json: { status: "Unavailable" } });
        return;
      }
      await answered;
      done = true;
      await route.fulfill({ headers, json: recorded });
    },
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T3", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Selected table details" });
  const openerName = comp ? "Comp or discount" : "Take dishes off round 1";
  const opener = details.getByRole("button", { name: openerName });
  await opener.click();
  const group = details.getByRole("group", { name: openerName });
  if (comp) {
    await group.getByLabel(/Synthetic boiled fish/u).check();
    await group.getByRole("radio", { name: "Goodwill" }).check();
  } else {
    await group.getByRole("checkbox", { name: /Synthetic boiled fish/u }).check();
    await group.getByRole("combobox").selectOption({ index: 1 });
  }
  const confirm = group.getByRole("button", { name: comp ? "Comp $11.30" : "Take off $11.30" });
  await expect(confirm).toBeEnabled();
  return {
    opener,
    openerName,
    group,
    confirm,
    /** The confirm request has reached the server and is waiting for its answer. */
    asked: () => expect.poll(() => confirmsAsked).toBe(1),
    answer: () => letAnswer(),
    /** The change is on the page and the floor was reread after it. */
    settled: async () => {
      await expect.poll(() => rereadsAfterDone).toBeGreaterThan(0);
      if (comp)
        await expect(details.getByRole("list", { name: "Comps and discounts" })).toContainText(
          "Synthetic boiled fish",
        );
      else await expect(confirm).toHaveCount(0);
      await expect(opener).toBeEnabled();
    },
  };
}

const activeName = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body ? "BODY" : (active.textContent ?? "");
  });

for (const action of ["comp", "takeOff"] as const) {
  const what = action === "comp" ? "a comp" : "a take-off";
  test(`@production a click on plain text while ${what} is being confirmed is never overridden by the focus going back`, async ({
    page,
  }) => {
    const table = await tableWith(page, action, "held");
    await table.confirm.focus();
    await page.keyboard.press("Enter");
    await table.asked();
    // Staff click plain text while the confirm is still on its way (the store's name beside the
    // menu: no focus moves).
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByText("Synthetic Store", { exact: true })
      .first()
      .click();
    table.answer();
    await table.settled();
    // Long enough for the focus to have gone back had it been going to (the wait is 50 ms steps).
    await page.waitForTimeout(800);
    expect(await activeName(page)).not.toBe(table.openerName);
  });

  test(`@production a key pressed while ${what} is being confirmed is never overridden either`, async ({
    page,
  }) => {
    const table = await tableWith(page, action, "held");
    await table.confirm.click();
    await table.asked();
    await page.keyboard.press("Shift");
    table.answer();
    await table.settled();
    await page.waitForTimeout(800);
    expect(await activeName(page)).not.toBe(table.openerName);
  });

  test(`@production with nothing done meanwhile, the focus goes back to the opener once ${what} is confirmed and the panel unlocks`, async ({
    page,
  }) => {
    const table = await tableWith(page, action, "held");
    await table.confirm.click();
    await table.asked();
    table.answer();
    await expect(table.opener).toBeFocused();
  });

  for (const [status, how] of [
    [503, "click"],
    [403, "Enter"],
  ] as const) {
    test(`@production when ${what} cannot be confirmed (${status}), Cancel by ${how} gives the focus back to the opener`, async ({
      page,
    }) => {
      const table = await tableWith(page, action, status);
      await table.confirm.click();
      await table.asked();
      const cancel = table.group.getByRole("button", { name: "Cancel" });
      await expect(cancel).toBeEnabled();
      // The panel stays open with what went wrong, so staff can read it before cancelling.
      await expect(table.group).toBeVisible();
      if (how === "click") await cancel.click();
      else {
        await cancel.focus();
        await page.keyboard.press("Enter");
      }
      await expect(table.opener).toBeFocused();
    });
  }
}

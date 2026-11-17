import { expect, test, type Page } from "@playwright/test";

/**
 * b25 (live24, Tables): after a comp is confirmed, the floor is reread and the table panel locks
 * for a moment; the focus then goes back to "Comp or discount". When staff click plain page text
 * meanwhile (a tap moves no focus), they have moved on: the focus is never pulled back to the
 * button afterwards. With nothing done meanwhile, the focus still goes back (b24).
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

async function compTable(page: Page) {
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
  let comped = false;
  // The floor reread after the confirm is slow, so the panel stays locked for a while.
  await page.route("**/merchant/dining/tables", async (route) => {
    if (comped) await new Promise((resolve) => setTimeout(resolve, 600));
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
        unpaidRemovableItems: [],
        unpaidRemovedItems: [],
        // The tofu can still be comped afterwards, so "Comp or discount" stays on the page.
        compableItems: comped ? [id(201)] : [id(201), id(202)],
        compedItems: comped
          ? [{ orderItemReference: id(202), kind: "Comp", percent: null, amountMinor: "1130" }]
          : [],
      },
    ],
    canRequestAcceptance: false,
    tableBill: comped ? { totalMinor: "1130", paid: null } : { totalMinor: "2260", paid: null },
    currentPhase: "InProgress",
    currentVersion: comped ? 4 : 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
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
    }),
  );
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
  await page.route("**/merchant/orders/comp-items", async (route) => {
    // The confirm takes a moment to answer, as on v15 (about 0.1 s).
    await new Promise((resolve) => setTimeout(resolve, 150));
    comped = true;
    await route.fulfill({
      headers,
      json: {
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
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T3", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Selected table details" });
  await details.getByRole("button", { name: "Comp or discount" }).click();
  const group = details.getByRole("group", { name: "Comp or discount" });
  await group.getByLabel(/Synthetic boiled fish/u).check();
  await group.getByRole("radio", { name: "Goodwill" }).check();
  const confirm = group.getByRole("button", { name: "Comp $11.30" });
  await expect(confirm).toBeEnabled();
  return { details, confirm };
}

const activeName = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body ? "BODY" : (active.textContent ?? "");
  });

test("@production a click on plain text after a comp is confirmed is never overridden by the focus going back", async ({
  page,
}) => {
  const { details, confirm } = await compTable(page);
  await confirm.focus();
  await page.keyboard.press("Enter");
  // Staff click plain text straight away (the store's name beside the menu: no focus moves).
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByText("Synthetic Store", { exact: true })
    .first()
    .click();
  await expect(details.getByRole("list", { name: "Comps and discounts" })).toContainText(
    "Synthetic boiled fish",
  );
  await expect(details.getByRole("button", { name: "Comp or discount" })).toBeEnabled();
  // Long enough for the focus to have gone back had it been going to (the wait is 50 ms steps).
  await page.waitForTimeout(800);
  expect(await activeName(page)).not.toBe("Comp or discount");
});

test("@production a key pressed on the page after a comp is confirmed is never overridden either", async ({
  page,
}) => {
  const { details, confirm } = await compTable(page);
  await confirm.click();
  await page.keyboard.press("Shift");
  await expect(details.getByRole("button", { name: "Comp or discount" })).toBeEnabled();
  await page.waitForTimeout(800);
  expect(await activeName(page)).not.toBe("Comp or discount");
});

test("@production with nothing done meanwhile, the focus goes back to Comp or discount once the panel unlocks", async ({
  page,
}) => {
  const { details, confirm } = await compTable(page);
  await confirm.click();
  await expect(details.getByRole("button", { name: "Comp or discount" })).toBeFocused();
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ① segment 2 (Owner decision 2, Figma 45:315): on the Tables page a manager comps
 * or discounts a dish the kitchen started, before the table pays. Money, so it is confirmed with
 * the exact amount; the browser sends only the choice and a reason; the comp stays on the table.
 */
const id = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

test("@production a manager discounts a started dish from the Tables page; only the choice is sent", async ({
  page,
}) => {
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
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
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
    }),
  );
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
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
  let discounted = false;
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
        // The kitchen started the fish; the tofu reached it but nobody marked it started, so it
        // can still come off the bill as well as be comped.
        unpaidRemovableItems: discounted ? [] : [id(201)],
        unpaidRemovedItems: [],
        compableItems: discounted ? [id(201)] : [id(201), id(202)],
        compedItems: discounted
          ? [{ orderItemReference: id(202), kind: "Percent", percent: 15, amountMinor: "170" }]
          : [],
      },
    ],
    canRequestAcceptance: false,
    // The table's bill (Payment's figure): 22.60, then 1.70 off and the bill's tax rounded once
    // (DEC-TAX-WHOLE-RECEIPT: 18.50 × 13% = 2.405 → 2.41, the rounds charged 2.40): 20.91.
    // v15 batch 9: on the order's detail, that rounding is said under the comps (its Total stays
    // as ordered); the order list has no detail, so no rounding.
    tableBill: discounted ? { totalMinor: "2091", paid: null } : { totalMinor: "2260", paid: null },
    currentPhase: "InProgress",
    currentVersion: 3,
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
        order: discounted
          ? { ...order(), tableBill: { totalMinor: "2091", paid: null, taxRoundingMinor: "1" } }
          : order(),
        lines: {
          items: [line(1, "Synthetic mapo tofu"), line(2, "Synthetic boiled fish")],
          totals: {
            subtotal: money("2000"),
            discount: money("0"),
            tax: money("260"),
            fee: money("0"),
            // v15 batch 9: an Order with comps keeps its Total as ordered; the bill's rounding,
            // worked out after the comps, is under them (tableBill.taxRoundingMinor).
            taxRounding: money("0"),
            total: money("2260"),
          },
        },
      },
    }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/comp-items", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    discounted = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        reductions: [
          {
            orderItemReference: id(202),
            kind: "Percent",
            percent: 15,
            amountMinor: "170",
            reasonCode: "LONG_WAIT",
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
  const removableNote = group.getByRole("note").filter({ hasText: "hasn't marked" });
  await expect(removableNote).toHaveCount(0);
  // A comped dish can't come off the bill afterwards: said before, while removal is still open.
  await group.getByLabel(/Synthetic mapo tofu/u).check();
  await expect(removableNote).toContainText(
    "The kitchen hasn't marked Synthetic mapo tofu started. Once comped or discounted, a dish can't come off the bill.",
  );
  await group.getByLabel(/Synthetic mapo tofu/u).uncheck();
  await expect(removableNote).toHaveCount(0);
  // Nothing is sent without a reason; the amount is shown exactly before it is recorded.
  await group.getByRole("radio", { name: "Percent off" }).check();
  await group.getByRole("textbox", { name: "Percent off (1–99)" }).fill("15");
  await expect(group.getByRole("button", { name: "Take $1.70 off" })).toBeDisabled();
  await group.getByRole("radio", { name: "Waited too long" }).check();
  // 15 % of 10.00 = 1.50, tax 1.30 × 15 % = 0.195 → 0.20: 1.70 off.
  const confirm = group.getByRole("button", { name: "Take $1.70 off" });
  await expect(confirm).toBeEnabled();
  await expect(group).toContainText("It can't be deleted.");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dining-item-comp-${width}.png`, fullPage: true });
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
  await confirm.click();
  // The browser sends the choice and the reason only — never an amount owed.
  expect(sent).toEqual([
    {
      orderReference: id(1),
      orderItemReferences: [id(202)],
      kind: "Percent",
      percent: 15,
      amountOffMinor: null,
      reasonCode: "LONG_WAIT",
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
  // The discount stays on the table's order, with what came off.
  await expect(details.getByRole("list", { name: "Comps and discounts" })).toContainText(
    "Synthetic boiled fish · 15% off−$1.70",
  );
  // What is left to pay shows under it at once, before checkout.
  await expect(details.getByRole("list", { name: "Comps and discounts" })).toContainText(
    "Whole bill to pay after comps$20.91",
  );
  // v15 batch 9 (DEC-TAX-WHOLE-RECEIPT): the order's Total stays what was ordered ($22.60, as
  // the guest's "Total ordered"); the cent the bill's tax rounds by after the discount is listed
  // under the comps, so ordered − taken off + rounding = to pay: 22.60 − 1.70 + 0.01 = 20.91.
  const tableOrder = details.getByRole("region", { name: "This table's order" });
  const comps = details.getByRole("list", { name: "Comps and discounts" });
  await expect(comps.getByRole("listitem")).toHaveText([
    "Synthetic boiled fish · 15% off−$1.70",
    "Tax rounding$0.01",
    "Whole bill to pay after comps$20.91",
  ]);
  await expect(tableOrder.locator(".order-lines-totals").first()).toContainText("Total$22.60");
  await expect(tableOrder.locator(".order-lines-totals").first()).not.toContainText("Tax rounding");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(comps).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    // v15 b11: each amount stays on one line ("−$1.70", never "−" alone over "$1.70"), even
    // beside a comp line as long as v15's ("Beef noodles (TEST) · 10% off · Goodwill · by You,
    // 18:34"): the words wrap, the amount does not.
    const amountLines = await comps.locator("li").evaluateAll((items) =>
      items.map((item) => {
        const [label, amount] = item.querySelectorAll(":scope > span");
        if (label === undefined || amount === undefined) return 0;
        const saved = label.textContent;
        label.textContent =
          "Synthetic boiled fish with chilli oil (TEST) · 15% off · Goodwill · by You, 18:34";
        const range = document.createRange();
        range.selectNodeContents(amount);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        label.textContent = saved;
        return lines.size;
      }),
    );
    expect(amountLines).toEqual([1, 1, 1]);
    await page.screenshot({
      path: `test-results/dining-item-comp-rounding-${width}.png`,
      fullPage: true,
    });
  }
  await expectNoInternalText(page, ["Temporarily unavailable"]);
});

import { expect, test, type Page } from "@playwright/test";
import { orderPanel } from "./order-queue-helpers";

// WP-2423 Q7 (OPS-ORDER-ENTRY, DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the
// counter, charge it on the store's card machine and record it; a paper order is entered after an
// outage; the order queue shows counter orders and a card-machine refund is recorded.
const id = (n: number) => "01909977-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const menu = {
  screenId: "OPS-ORDER-ENTRY",
  menu: {
    status: "Found",
    schemaVersion: 1,
    projection: {},
    scope: {},
    menu: {
      menuReference: id(1),
      menuVersionReference: id(2),
      releaseReference: id(3),
      locale: "en-CA",
      name: "Menu",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(4),
          name: "Coffee",
          sellables: [
            {
              sellableReference: id(5),
              productVersionReference: id(6),
              name: "Flat White",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  name: "Milk",
                  bindingReference: id(7),
                  optionSetVersionReference: id(8),
                  minimumSelections: 1,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(9), id(10)],
                  defaultOptionReferences: [id(9)],
                  options: [
                    {
                      optionReference: id(9),
                      name: "Whole milk",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: true,
                      incrementalPrice: price("0.00"),
                    },
                    {
                      optionReference: id(10),
                      name: "Oat milk",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                      incrementalPrice: price("0.75"),
                    },
                  ],
                },
              ],
              allergenDisclosure: {},
              displayPrice: price("4.50"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(11),
              productVersionReference: id(12),
              name: "Butter Croissant",
              presentationRole: "Standard",
              pinned: false,
              availability: "SoldOut",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("3.25"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(13),
              productVersionReference: id(14),
              name: "Banana Bread",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("3.75"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
};

async function signIn(page: Page) {
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
          businessDate: "2026-10-13",
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
            {
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
          ],
        },
      },
    }),
  );
}

// WP-2423 item 8 ⑦ (Owner decision 11): the counter offers the Store's own tip percentages; with
// tips off it asks nothing and sends no tip; a refusal (tips turned off meanwhile) re-reads them.
test("@production the counter offers the Store's tip percentages, and none while tips are off", async ({
  page,
}) => {
  await signIn(page);
  let tips = { enabled: true, tierPercents: [12, 18, 22] };
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ headers, json: { ...menu, tips } }),
  );
  const placedBodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/counter/orders", (route) => {
    placedBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    // The owner turned tips off after the screen read them.
    tips = { enabled: false, tierPercents: [12, 18, 22] };
    return route.fulfill({ status: 409, headers, json: { error: "tips_turned_off" } });
  });
  await page.goto("/operations/order-entry");
  const tip = page.getByRole("group", { name: "Tip" });
  await expect(tip.getByRole("radio")).toHaveCount(5);
  await expect(tip.getByRole("radio", { name: "12%" })).toBeVisible();
  await expect(tip.getByRole("radio", { name: "15%" })).toHaveCount(0);
  await expect(tip.getByRole("radio", { name: "No tip" })).toBeChecked();
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await tip.getByRole("radio", { name: "22%" }).check();
  await page.getByRole("button", { name: "Send order" }).click();
  expect(placedBodies[0]).toMatchObject({ tip: { kind: "Percent", percent: 22 } });
  await expect(
    page.getByText(
      "Tips are turned off for this store, so nothing was sent or charged. Send it again with no tip.",
    ),
  ).toBeVisible();
  // The choices are read again: no tip to choose any more.
  await expect(tip).toBeHidden();
});

test("@production staff take a counter pickup order, charge it on the card machine and record it", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const placedBodies: Record<string, unknown>[] = [];
  let soldOutOnce = true;
  await page.route("**/merchant/counter/orders", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    placedBodies.push(body);
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (soldOutOnce && (body.lines as unknown[]).length === 2) {
      soldOutOnce = false;
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "item_unavailable", lineIndex: 1 },
      });
    }
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "12",
        orderVersion: 1,
        orderMinor: "593",
        tipMinor: "79",
        totalMinor: "672",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: body.recordedAfterOutage === true,
        // DEC-PAPER-ORDER-PAID-AT-SEND: a paper order's payment is recorded with it.
        ...(body.paperPayment === undefined
          ? {}
          : {
              payment: {
                status: "Recorded",
                amountMinor: "672",
                recordingReason: "RecordedAfterOutage",
                takenAt: (body.paperPayment as { takenAt: string }).takenAt,
                recordedAt: new Date().toISOString(),
                acceptance: "Accepted",
              },
            }),
      },
    });
  });
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    if (body.expectedTotalMinor !== "672")
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "amount_changed", totalMinor: "672" },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "672",
        recordingReason: body.takenAt === null ? "AtCounter" : "RecordedAfterOutage",
        takenAt: (body.takenAt as string | null) ?? new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        // WP-2423 D1: the server accepts the paid order with its payment record.
        acceptance: "Accepted",
      },
    });
  });
  const accepted: unknown[] = [];
  await page.route("**/merchant/orders/accept", (route) => {
    accepted.push(route.request().postDataJSON());
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "Created", acceptedOrderVersion: 2 }),
    });
  });

  await page.goto("/operations/order-entry");
  await expect(page.getByRole("heading", { level: 1, name: "Counter order" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Counter order" }),
  ).toHaveAttribute("aria-current", "page");
  // Sold out items cannot be added.
  await expect(page.getByRole("button", { name: "Add Butter Croissant" })).toBeDisabled();
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("radio", { name: /Oat milk/ }).check();
  // WP-2423 M53: the counter takes the guest's note for the kitchen, as a table round does.
  await page.getByRole("textbox", { name: "Note for the kitchen (optional)" }).fill("Extra hot");
  await page.getByRole("button", { name: "Add to order" }).click();
  // Owner 2026-10-26: an item with nothing to choose goes straight onto the order.
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket).toContainText("1 × Flat White · Oat milk");
  await expect(ticket).toContainText("$5.25");
  await expect(page.getByText("About $9.00 before tax and tip.")).toBeVisible();
  await page.getByRole("radio", { name: "15%" }).check();

  // Banana Bread sold out while staff were taking the order: plain words, nothing charged.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Banana Bread can't be sold right now (sold out or off the menu).",
  );
  await page.getByRole("button", { name: "Remove Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $6.72 on the card machine" }),
  ).toBeVisible();
  // The browser sends intent only: items, options, tip choice — never prices or totals.
  expect(placedBodies.at(-1)).toEqual({
    operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    lines: [
      {
        sellableReference: id(5),
        quantity: 1,
        optionSelections: [{ optionReference: id(10), quantity: 1 }],
        customerNote: "Extra hot",
      },
    ],
    tip: { kind: "Percent", percent: 15 },
    recordedAfterOutage: false,
  });
  await expect(page.getByText(/Record the payment by \d\d:\d\d/u)).toBeVisible();
  // v15 751dd768: once sent, the ticket no longer says the total comes later.
  await expect(
    page.getByText("Sent. Charge $6.72 with tax and tip on the card machine."),
  ).toBeVisible();
  await expect(page.getByText(/The final total comes when you send the order/u)).toHaveCount(0);
  const slip = page.getByRole("textbox", { name: "Slip reference (optional)" });
  await slip.fill("1234 5678 9012 3456");
  await expect(page.getByRole("button", { name: /Paid on card machine/ })).toBeDisabled();
  await slip.fill("AUTH 482913");

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(
      page.getByRole("heading", { name: "Charge $6.72 on the card machine" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-order-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "Paid on card machine · $6.72" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Paid and sent to the kitchen." }),
  ).toBeVisible();
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(20),
      orderBatchReference: id(21),
      expectedTotalMinor: "672",
      slipReference: "AUTH 482913",
      takenAt: null,
    },
  ]);
  // WP-2423 D1: accepted by the server with the payment, not by the page.
  expect(accepted).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText(id(20));

  // A paper order taken during an outage: entered with the time and way it was paid, and
  // recorded with its payment in one step (DEC-PAPER-ORDER-PAID-AT-SEND), never left to charge.
  await page.getByRole("button", { name: "New counter order" }).click();
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
  const sendPaper = page.getByRole("button", { name: "Send and record paper order" });
  await expect(sendPaper).toBeDisabled();
  const paid = new Date(Date.now() - 2 * 60 * 60_000);
  const local = (value: Date) =>
    new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Paid at (store time, from the paper order)").fill(local(paid));
  const how = page.getByRole("group", { name: "How it was paid during the outage" });
  await expect(how.getByRole("radio", { name: "Card machine" })).toBeChecked();
  const paperSlip = page.getByRole("textbox", { name: "Slip reference (optional)" });
  await paperSlip.fill("1234 5678 9012 3456");
  await expect(sendPaper).toBeDisabled();
  await paperSlip.fill("AUTH 7701");
  await expect(
    page.getByText("Sending records the order and the payment on the slip together.", {
      exact: false,
    }),
  ).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(sendPaper).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-paper-form-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const recordedBefore = payments.length;
  await sendPaper.click();
  await expect(page.getByRole("heading", { name: "Order 12 paid" })).toBeVisible();
  await expect(
    page.getByText("Recorded after the outage and accepted.", { exact: false }),
  ).toBeVisible();
  expect(placedBodies.at(-1)).toMatchObject({
    recordedAfterOutage: true,
    paperPayment: {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      tender: "CardMachine",
      slipReference: "AUTH 7701",
      takenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    },
  });
  // No separate charge step, and nothing on screen asks to charge, release or cancel it.
  expect(payments).toHaveLength(recordedBefore);
  await expect(page.locator("main")).not.toContainText(
    /To charge|released|Ask a manager|Charge \$|Paid on card machine ·/u,
  );
  expect(accepted).toHaveLength(0);
});

// WP-2423 (v15 fabf0261 F1): the server refuses a paper order's paid-at (here: before the store
// started recording sales) when it records the payment sent with the order
// (DEC-PAPER-ORDER-PAID-AT-SEND). The order is in; the time is corrected in the record-again step,
// where it is shown, and recorded as a new payment; a retry after no answer with the same time is
// the same payment. Nothing there asks staff to charge the guest, or says it is released.
for (const language of ["en", "zh-Hans"] as const)
  test(`@production a refused paper paid-at is corrected in the charge step and recorded (${language})`, async ({
    page,
  }) => {
    if (language === "zh-Hans")
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      });
    const zh = language === "zh-Hans";
    await signIn(page);
    await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
    const placedBodies: Record<string, unknown>[] = [];
    await page.route("**/merchant/counter/orders", (route) => {
      placedBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(20),
          orderBatchReference: id(21),
          orderNumber: "12",
          orderVersion: 1,
          orderMinor: "593",
          tipMinor: "79",
          totalMinor: "672",
          payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
          recordedAfterOutage: true,
          paymentError: "taken_before_records",
        },
      });
    });
    const payments: Record<string, unknown>[] = [];
    await page.route("**/merchant/orders/card-machine-payment", (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      payments.push(body);
      if (payments.length === 1) return route.abort("connectionreset");
      return route.fulfill({
        headers,
        json: {
          status: "Recorded",
          orderReference: id(20),
          orderBatchReference: id(21),
          amountMinor: "672",
          recordingReason: "RecordedAfterOutage",
          takenAt: body.takenAt,
          recordedAt: new Date().toISOString(),
          acceptance: "Accepted",
        },
      });
    });
    // Store time (America/Toronto) as the paid-at field takes it, whatever the device's zone.
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
    const paidAtLabel = zh
      ? "付款时间（门店时间，以纸质订单为准）"
      : "Paid at (store time, from the paper order)";
    await page.goto("/operations/order-entry");
    await page.getByRole("button", { name: zh ? "添加Flat White" : "Add Flat White" }).click();
    await page.getByRole("button", { name: zh ? "加入订单" : "Add to order" }).click();
    await page
      .getByRole("checkbox", {
        name: zh ? "停电/断网后补录（纸质记录）" : "Recorded after an outage (taken on paper)",
      })
      .check();
    await page.getByLabel(paidAtLabel).fill(storeLocal(Date.now() - 2 * 60 * 60_000));
    await page
      .getByRole("button", { name: zh ? "发送并录入纸质订单" : "Send and record paper order" })
      .click();
    const pay = page.getByRole("button", {
      name: zh ? "录入纸单付款 · $6.72" : "Record paper payment · $6.72",
    });
    await expect(pay).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: zh ? "纸质订单 12：付款还没录入" : "Paper order 12: its payment isn't recorded yet",
      }),
    ).toBeVisible();
    // Sent: the one paid-at field is the record-again step's, holding the time from the paper order.
    await expect(page.getByLabel(paidAtLabel)).toHaveCount(1);
    await expect(page.locator("main")).not.toContainText(
      zh ? /应收|释放|请经理取消/u : /To charge|released|Ask a manager|Charge \$/u,
    );
    await expect(page.locator("main")).toContainText(
      zh
        ? "录入前这笔销售不计入当天营业额"
        : "Until it is recorded the sale isn't in the day's takings",
    );
    const refusal = page.getByRole("alert").filter({
      hasText: zh
        ? "早于本店开始在系统里记录销售的时间"
        : "before this store started recording sales",
    });
    await expect(refusal).toBeVisible();
    const chargePaidAt = page.getByLabel(paidAtLabel);
    await expect(chargePaidAt).toBeEnabled();
    await expect(chargePaidAt).toBeFocused();
    await expect(chargePaidAt).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("body")).toContainText(
      zh
        ? "时间填错了就在这里改正，然后再记录一次。"
        : "If the time was wrong, correct it here and record again.",
    );
    if (zh)
      await expect(page.locator("main")).not.toContainText(
        /taken_before|TakenBefore|order\b|round\b|undefined|null/u,
      );
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(chargePaidAt).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/counter-paid-at-refused-${language}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // Corrected: a new payment with the new time.
    const corrected = storeLocal(Date.now() - 60 * 60_000);
    await chargePaidAt.fill(corrected);
    await expect(chargePaidAt).toHaveAttribute("aria-invalid", "false");
    await pay.click();
    await expect(
      page.getByRole("alert").filter({
        hasText: zh ? "订单已录入，但纸质单上的付款还没录入" : "The order is in, but its payment",
      }),
    ).toBeVisible();
    // No answer: pressed again with the same time, it is the same payment (never counted twice).
    await expect(chargePaidAt).toBeEnabled();
    await pay.click();
    await expect(
      page.getByText(zh ? "停电/断网后补录并已接单。" : "Recorded after the outage and accepted.", {
        exact: false,
      }),
    ).toBeVisible();
    const sentWith = placedBodies[0]?.paperPayment as Record<string, unknown>;
    expect(sentWith).toMatchObject({ tender: "CardMachine", slipReference: null });
    expect(payments).toHaveLength(2);
    expect(payments[0]?.operationReference).not.toBe(sentWith.operationReference);
    expect(payments[0]?.takenAt).not.toBe(sentWith.takenAt);
    expect(payments[1]?.operationReference).toBe(payments[0]?.operationReference);
    expect(payments[1]?.takenAt).toBe(payments[0]?.takenAt);
    await expect(page.locator("body")).not.toContainText(id(20));
  });

test("@production the order queue shows counter orders and records a card-machine refund", async ({
  page,
}) => {
  await signIn(page);
  let refunded = false;
  const counterRow = () => ({
    orderReference: id(30),
    orderNumber: "12",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:00:00.000Z",
    observedAt: "2026-10-13T16:20:00.000Z",
    initialBatchReference: id(31),
    counter: {
      recordedAfterOutage: true,
      paidOnCardMachine: {
        amountMinor: "672",
        takenAt: "2026-10-13T15:40:00.000Z",
        recordedAfterOutage: true,
        refundedMinor: refunded ? "672" : "0",
      },
    },
    batches: [
      {
        orderBatchReference: id(31),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: {
          reasonCode: "CUSTOMER_REQUEST",
          cancelledAt: "2026-10-13T16:10:00.000Z",
          refundStatus: refunded ? "Refunded" : "Pending",
          refundMethod: "CardMachine",
          refundAmountMinor: "672",
        },
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Cancelled",
    currentVersion: 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  // A paid counter order that expired before it was accepted: refunded on the machine by staff.
  const expiredRow = () => ({
    orderReference: id(40),
    orderNumber: "14",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: "2026-10-13T16:30:00.000Z",
    observedAt: "2026-10-13T17:20:00.000Z",
    initialBatchReference: id(41),
    counter: {
      recordedAfterOutage: false,
      paidOnCardMachine: {
        amountMinor: "500",
        takenAt: "2026-10-13T16:31:00.000Z",
        recordedAfterOutage: false,
        refundedMinor: "0",
      },
    },
    batches: [
      {
        orderBatchReference: id(41),
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Submitted",
    currentVersion: 1,
    unfulfillable: "CapacityExpired",
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  const listed = () => ({ items: [expiredRow(), counterRow()], nextAfterOrderReference: null });
  await page.route("**/merchant/orders?*", (route) => route.fulfill({ headers, json: listed() }));
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: listed() }));
  const refunds: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-refund", (route) => {
    refunds.push(route.request().postDataJSON() as Record<string, unknown>);
    refunded = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(30),
        orderBatchReference: id(31),
        amountMinor: "672",
        refundedAt: new Date().toISOString(),
      },
    });
  });
  await page.goto("/operations/orders");
  const expired = page.locator("li.order-row").first();
  await expect(expired).toContainText("Expired · refund on card machine");
  await expired.locator(".order-row__open").click();
  await expect(
    orderPanel(page).getByText("refund $5.00 on the card machine, then record it here.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    orderPanel(page).getByRole("button", { name: "Record card-machine refund" }),
  ).toBeVisible();
  const row = page.locator("li.order-row").nth(1);
  await row.locator(".order-row__open").click();
  const entry = orderPanel(page);
  await expect(entry).toContainText("Pickup · Counter");
  await expect(entry).toContainText("Paid on card machine $6.72");
  await expect(entry).toContainText("Recorded after outage");
  await expect(entry).toContainText("Cancelled by store · refund on card machine");
  await expect(
    entry.getByText("Refund $6.72 on the store's card machine, then record it here."),
  ).toBeVisible();
  // Orders v3: the panel says "Counter" in its header line; the payment is under Payment.
  await expect(entry.locator(".order-panel__meta")).toContainText("Counter");
  await entry.getByRole("button", { name: "Record card-machine refund" }).click();
  const dialog = page.getByRole("dialog", { name: "Refund $6.72 on the card machine" });
  await dialog.getByRole("textbox", { name: "Slip reference (optional)" }).fill("REFUND 7731");
  await dialog.getByRole("button", { name: "Refunded $6.72 on card machine" }).click();
  await expect(entry).toContainText("Cancelled by store · refunded on card machine");
  // WP-2423: recording the refund refreshes the order in place; it stays open.
  await expect(row).toHaveAttribute("data-open", "true");
  expect(refunds).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(30),
      orderBatchReference: id(31),
      slipReference: "REFUND 7731",
      refundedAt: null,
    },
  ]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-queue-${width}.png`, fullPage: true });
  }
});

test("@production counter order fails closed without the staff ordering permission", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "request_denied" } }),
  );
  await page.goto("/operations/order-entry");
  await expect(page.getByRole("heading", { name: "No access", exact: true })).toBeVisible();
  await expect(
    page.getByText("You don't have access to this page. Ask the owner or a manager."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send order" })).toHaveCount(0);
});

// v15 run: two of an item with one left returned "try again" without saying why. Staff are told
// which item is short and how many are left; the order stays on the page to fix and send.
test("@production a short item names how many are left and the order stays editable", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const sent: { sellableReference: string; quantity: number }[][] = [];
  await page.route("**/merchant/counter/orders", (route) => {
    const lines = (route.request().postDataJSON() as { lines: (typeof sent)[number] }).lines;
    sent.push(lines);
    const flatWhites = lines
      .filter((line) => line.sellableReference === id(5))
      .reduce((sum, line) => sum + line.quantity, 0);
    if (flatWhites > 1)
      return route.fulfill({
        status: 409,
        headers,
        json: { error: "item_short", lineIndex: 0, available: 1 },
      });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "14",
        orderVersion: 1,
        orderMinor: "932",
        tipMinor: "0",
        totalMinor: "932",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto("/operations/order-entry");
  for (let count = 0; count < 2; count++) {
    await page.getByRole("button", { name: "Add Flat White" }).click();
    await page.getByRole("button", { name: "Add to order" }).click();
  }
  // Owner 2026-10-26: an item with nothing to choose goes straight onto the order.
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Only 1 Flat White left, 2 in this order. Remove Flat White and add 1 back, then send again. Nothing was sent or charged.",
  );
  await expect(page.getByText(/item_short|counter_order|409|503/u)).toHaveCount(0);
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Send order" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove Flat White" }).first().click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $9.32 on the card machine" }),
  ).toBeVisible();
  expect(sent.map((lines) => lines.length)).toEqual([3, 2]);
});

// WP-2423 (DEC-COUNTER-WALK-UP-CAPACITY): a refused counter order said only "try again" and the
// resend kept failing. Staff now see the real reason and what to do; a system failure starts a new
// order on the next send instead of re-asking about the failed one.
test("@production a refused counter order says why and what to do, then sends as a new order", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const operations: string[] = [];
  const replies = [
    { status: 503, json: { error: "counter_order_unavailable" } },
    { status: 409, json: { error: "counter_order_no_pickup_times" } },
    // WP-2423 (staff-round-soldout): the dish's choices changed between adding and pricing it.
    {
      status: 409,
      json: { error: "item_unavailable", lineIndex: 0, sharedStock: false, optionsChanged: true },
    },
  ];
  await page.route("**/merchant/counter/orders", (route) => {
    operations.push(
      (route.request().postDataJSON() as { operationReference: string }).operationReference,
    );
    const refusal = replies.shift();
    if (refusal !== undefined) return route.fulfill({ ...refusal, headers });
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "15",
        orderVersion: 1,
        orderMinor: "475",
        tipMinor: "0",
        totalMinor: "475",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto("/operations/order-entry");
  // Owner 2026-10-26: an item with nothing to choose goes straight onto the order.
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The system couldn't place this order (a problem on our side, not with the order). Nothing was charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
  );
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Pickup times have run out in the system, so no pickup order can be entered right now. Nothing was sent or charged. Take this order on paper and charge it on the card machine, then enter it under Paper order once pickup times are back. Tell a manager — Home shows the alert.",
  );
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Banana Bread's choices changed on the menu. Remove it, add it again with the new choices, then send. Nothing was sent or charged.",
  );
  await expect(
    page.getByText(/counter_order|no_pickup_times|item_unavailable|409|503/u),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Items in this order" }).getByRole("listitem"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $4.75 on the card machine" }),
  ).toBeVisible();
  // Each send after a definite refusal is a new order (never a resend of the failed one).
  expect(new Set(operations).size).toBe(4);
});

// v15 run (738b4c8b): right after an order was sent the counter menu still offered Flat White
// although the milk left could not make one. The menu is re-read after each send and payment,
// and every 30 s while staff build an order.
test("@production the counter menu re-reads what the store can sell after a send and while building", async ({
  page,
}) => {
  await signIn(page);
  await page.clock.install();
  const soldOut = new Set<string>();
  let menuReads = 0;
  await page.route("**/merchant/counter/menu", (route) => {
    menuReads += 1;
    const current = structuredClone(menu);
    for (const sellable of current.menu.menu.sections[0]?.sellables ?? [])
      if (soldOut.has(sellable.name)) sellable.availability = "SoldOut";
    return route.fulfill({ headers, json: current });
  });
  await page.route("**/merchant/counter/orders", (route) => {
    // The order uses the last of the milk.
    soldOut.add("Flat White");
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "15",
        orderVersion: 1,
        orderMinor: "450",
        tipMinor: "0",
        totalMinor: "450",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.route("**/merchant/orders/card-machine-payment", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(20),
        orderBatchReference: id(21),
        amountMinor: "450",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        acceptance: "Accepted",
      },
    }),
  );
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await page.getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $4.50 on the card machine" }),
  ).toBeVisible();
  await expect.poll(() => menuReads).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Paid on card machine · $4.50" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Paid and sent to the kitchen." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New counter order" }).click();
  await expect(page.getByRole("button", { name: "Add Flat White" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toBeEnabled();

  // Banana Bread sells out at another till while staff build the next order.
  soldOut.add("Banana Bread");
  const before = menuReads;
  await page.clock.runFor(30_000);
  await expect.poll(() => menuReads).toBeGreaterThan(before);
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toBeDisabled();
});

// WP-2423 (v15 751dd768): a counter order sent but not paid is never lost to a reload. The counter
// page lists it from the server (Orders) with its release time, and it is charged and recorded from
// there or from its row on Orders; a cashier without payments access is not offered Payments and
// refunds.
test("@production a sent, unpaid counter order is charged after a reload, from Counter order and Orders", async ({
  page,
}) => {
  await signIn(page);
  const payBy = new Date(Date.now() + 20 * 60_000).toISOString();
  let paid = false;
  const row = (amountDueMinor: string | null) => ({
    orderReference: id(60),
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Pos",
    submittedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    observedAt: new Date().toISOString(),
    initialBatchReference: id(61),
    counter: paid
      ? {
          recordedAfterOutage: false,
          paidOnCardMachine: {
            amountMinor: "1130",
            takenAt: new Date().toISOString(),
            recordedAfterOutage: false,
            refundedMinor: "0",
          },
          payBy: null,
          amountDueMinor: null,
        }
      : { recordedAfterOutage: false, paidOnCardMachine: null, payBy, amountDueMinor },
    canRecordCardMachinePayment: true,
    canViewPayments: false,
    batches: [
      {
        orderBatchReference: id(61),
        sequence: 1,
        acceptanceStatus: paid ? "Accepted" : "NotAccepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: paid ? "Accepted" : "Submitted",
    currentVersion: paid ? 2 : 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: !paid,
  });
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [row(null)], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: row(paid ? null : "1130"),
        lines: {
          items: [
            {
              orderItemReference: id(62),
              orderBatchReference: id(61),
              name: "Flat White",
              options: [],
              quantity: 2,
              customerNote: null,
              unitPrice: { amountMinor: "450", currencyCode: "CAD" },
              subtotal: { amountMinor: "900", currencyCode: "CAD" },
              discount: { amountMinor: "0", currencyCode: "CAD" },
              tax: { amountMinor: "117", currencyCode: "CAD" },
              fee: { amountMinor: "0", currencyCode: "CAD" },
              total: { amountMinor: "1017", currencyCode: "CAD" },
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: { amountMinor: "900", currencyCode: "CAD" },
            discount: { amountMinor: "0", currencyCode: "CAD" },
            tax: { amountMinor: "117", currencyCode: "CAD" },
            fee: { amountMinor: "0", currencyCode: "CAD" },
            total: { amountMinor: "1017", currencyCode: "CAD" },
            tip: { amountMinor: "0", currencyCode: "CAD" },
          },
        },
      },
    }),
  );
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    payments.push(route.request().postDataJSON() as Record<string, unknown>);
    paid = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(60),
        orderBatchReference: id(61),
        amountMinor: "1130",
        recordingReason: "AtCounter",
        takenAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        acceptance: "Accepted",
      },
    });
  });

  // Orders: the row warns when it is released and offers the charge; no Payments and refunds.
  await page.goto("/operations/orders");
  const orderRow = page.locator("li.order-row").first();
  await expect(orderRow).toContainText(/Take payment by \d\d:\d\d · released if unpaid/u);
  await expect(page.getByText("1 order.", { exact: true })).toBeVisible();
  // The only order on the page opens on its own.
  await expect(orderRow).toHaveAttribute("data-open", "true");
  const entry = orderPanel(page);
  await expect(
    entry.getByText(/Not paid yet: take payment on the card machine or in cash/u),
  ).toBeVisible();
  await expect(entry.getByRole("button", { name: "Payments and refunds" })).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "Take payment" })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-unpaid-orders-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Counter order, opened fresh (as after a reload): the sent order is listed from the server.
  await page.goto("/operations/order-entry");
  const awaiting = page.getByRole("region", { name: "Sent, not paid yet" });
  await expect(awaiting).toContainText("Order 21");
  await expect(awaiting).toContainText(/Take payment by \d\d:\d\d · released if unpaid/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-awaiting-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await awaiting.getByRole("button", { name: "Take payment" }).click();
  const form = awaiting.getByRole("form", { name: "Record card-machine payment" });
  await expect(form).toContainText("Charge $11.30 on the card machine first");
  await expect(form).toContainText(/Record the payment by \d\d:\d\d/u);
  await form.getByRole("textbox", { name: "Slip reference (optional)" }).fill("AUTH 9921");
  await form.getByRole("button", { name: "Paid on card machine · $11.30" }).click();
  // v15 f971cecb: the same "Order N paid" panel as after a direct charge, with the next step.
  const paidPanel = page.getByRole("region", { name: "Order 21 paid" });
  await expect(paidPanel.getByRole("heading", { name: "Order 21 paid" })).toBeFocused();
  await expect(paidPanel).toContainText("Paid on card machine$11.30");
  await expect(paidPanel.getByRole("status")).toHaveText("Paid and sent to the kitchen.");
  await expect(paidPanel.getByRole("link", { name: "Open Orders" })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-awaiting-paid-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(60),
      orderBatchReference: id(61),
      expectedTotalMinor: "1130",
      slipReference: "AUTH 9921",
      takenAt: null,
    },
  ]);
  await expect(page.getByRole("region", { name: "Sent, not paid yet" })).toHaveCount(0);
  await paidPanel.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Order 21 paid" })).toHaveCount(0);
});

// Owner 2026-10-26: one tile per drink with its sizes as buttons; a tap on a size adds it; a sold
// out size cannot be tapped. Sizes are grouped only by the catalog's Product (version), never by
// name alone.
test("@production a drink's sizes share one tile and a tap adds that size", async ({ page }) => {
  await signIn(page);
  const bread = menu.menu.menu.sections[0]?.sellables[2];
  const sized = (n: number, version: number, name: string, amount: string, sold = false) => ({
    ...bread,
    sellableReference: id(n),
    productVersionReference: id(version),
    name,
    availability: sold ? "SoldOut" : "Available",
    displayPrice: price(amount),
  });
  const sizedMenu = structuredClone(menu);
  const coffee = sizedMenu.menu.menu.sections[0];
  if (coffee === undefined) throw new Error("the counter test menu has no section");
  coffee.sellables = [
    sized(60, 70, "Latte — Small (8 oz)", "4.50"),
    sized(61, 70, "Latte — Large (16 oz)", "5.65", true),
    // Same name pattern, another Product: its own tile.
    sized(62, 71, "Latte — Regular (12 oz)", "5.15"),
  ] as never;
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ headers, json: sizedMenu }),
  );
  await page.goto("/operations/order-entry");
  const latte = page.getByRole("group", { name: "Latte", exact: true });
  await expect(latte.getByRole("button")).toHaveCount(2);
  await expect(latte.getByRole("button", { name: "Add Latte — Large (16 oz)" })).toBeDisabled();
  await expect(latte.getByRole("button", { name: "Add Latte — Large (16 oz)" })).toContainText(
    "Sold out",
  );
  await expect(page.getByRole("button", { name: "Add Latte — Regular (12 oz)" })).toBeVisible();
  await latte.getByRole("button", { name: "Add Latte — Small (8 oz)" }).click();
  await latte.getByRole("button", { name: "Add Latte — Small (8 oz)" }).click();
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket.getByRole("listitem")).toHaveCount(1);
  await expect(ticket).toContainText("2 × Latte — Small (8 oz)");
  await expect(ticket).toContainText("$9.00");
});

// Owner 2026-11-03: the page works like a counter POS. Search finds a dish in either language,
// Enter adds the one left; choices open over the menu and the order keeps its place; what is sent
// often comes to the top on this tablet's next visit, and an order line can be changed.
test("@production staff search the menu, change a line and see what they order often", async ({
  page,
}) => {
  await signIn(page);
  const sellables = (
    menu.menu.menu.sections as { sellables: { sellableReference: string; name: string }[] }[]
  ).flatMap((section) => section.sellables);
  const bread = sellables.find((item) => item.name === "Banana Bread");
  const otherNames = { [String(bread?.sellableReference)]: "香蕉面包" };
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ headers, json: { ...menu, otherNames } }),
  );
  await page.goto("/operations/order-entry");
  const search = page.getByRole("searchbox", { name: "Search dishes (Chinese or English)" });
  await search.fill("香蕉");
  await expect(page.getByRole("button", { name: "Add Flat White" })).toHaveCount(0);
  await search.press("Enter");
  await expect(search).toHaveValue("");
  const ticket = page.getByRole("list", { name: "Items in this order" });
  await expect(ticket).toContainText("1 × Banana Bread");
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toContainText("1 ×");
  await search.fill("no such dish");
  await expect(page.getByRole("status").filter({ hasText: "No dish matches" })).toBeVisible();
  await search.clear();

  // Choices open as a dialog; the order behind it does not move, and a line can be changed.
  await page.getByRole("button", { name: "Add Flat White" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /^Add to order/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(ticket.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Add Flat White" }).click();
  await dialog.getByRole("button", { name: /^Add to order/ }).click();
  await page.getByRole("button", { name: "Change Flat White" }).click();
  await dialog.getByRole("radio", { name: /Oat milk/ }).check();
  await dialog.getByRole("button", { name: /^Save change/ }).click();
  await expect(ticket.getByRole("listitem")).toHaveCount(2);
  await expect(ticket).toContainText("Flat White · Oat milk");

  // Often ordered: nothing yet; after enough sends it leads the menu on the next visit.
  await expect(page.getByRole("region", { name: "Often ordered" })).toHaveCount(0);
  await page.evaluate(
    ([store, reference]) =>
      localStorage.setItem(
        "bop.counter.oftenOrdered.v1." + String(store),
        JSON.stringify({ [String(reference)]: 3 }),
      ),
    [scope.storeReference, bread?.sellableReference],
  );
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Often ordered" }).getByRole("button", {
      name: "Add Banana Bread",
    }),
  ).toBeVisible();
});

// WP-2423 M127 (v15 batch 5): straight after Send, while the counter still reads who may cancel,
// nobody is told to ask a manager (or offered Cancel); then the owner gets Cancel and Back to edit,
// and front of house is told to ask a manager.
for (const role of ["owner", "cashier"] as const)
  test(`@production the charge step says who cancels only once it is known (${role})`, async ({
    page,
  }) => {
    await signIn(page);
    await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
    const payBy = new Date(Date.now() + 30 * 60_000).toISOString();
    await page.route("**/merchant/counter/orders", (route) =>
      route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(20),
          orderBatchReference: id(21),
          orderNumber: "12",
          orderVersion: 1,
          orderMinor: "593",
          tipMinor: "0",
          totalMinor: "593",
          payBy,
          recordedAfterOutage: false,
        },
      }),
    );
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let sent = false;
    const row = {
      orderReference: id(20),
      orderNumber: "12",
      orderType: "Pickup",
      sourceChannel: "Pos",
      submittedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      initialBatchReference: id(21),
      batches: [
        {
          orderBatchReference: id(21),
          sequence: 1,
          acceptanceStatus: "NotAccepted",
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
      canRequestAcceptance: false,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: true,
      currentPhase: "Submitted",
      currentVersion: 1,
      counter: {
        recordedAfterOutage: false,
        paidOnCardMachine: null,
        payBy,
        amountDueMinor: null,
        canCancelUnpaid: role === "owner",
        cancelledBeforePayment: null,
      },
      canRecordCardMachinePayment: true,
      canViewPayments: role === "owner",
    };
    await page.route("**/merchant/orders", async (route) => {
      if (sent) await answered;
      return route.fulfill({
        headers,
        json: { items: sent ? [row] : [], nextAfterOrderReference: null },
      });
    });
    await page.goto("/operations/order-entry");
    await page.getByRole("button", { name: "Add Banana Bread" }).click();
    sent = true;
    await page.getByRole("button", { name: "Send order" }).click();
    await expect(
      page.getByRole("heading", { name: "Charge $5.93 on the card machine" }),
    ).toBeVisible();
    const charge = page.locator(".counter-order__charge");
    await expect(
      charge.getByText("Card declined? Try another card.", { exact: true }),
    ).toBeVisible();
    await expect(charge).not.toContainText("Ask a manager");
    await expect(charge.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    answer();
    if (role === "owner") {
      await expect(charge.getByRole("button", { name: "Cancel order" })).toBeVisible();
      await expect(charge.getByRole("button", { name: "Back to edit" })).toBeVisible();
      await expect(charge).toContainText("Guest not paying? Cancel the order so its items go back");
      await expect(charge).not.toContainText("Ask a manager");
    } else {
      await expect(charge).toContainText("Guest not paying? Ask a manager to cancel it");
      await expect(charge.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    }
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(charge).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/counter-charge-${role}-${width}.png`,
        fullPage: true,
      });
    }
  });

// DEC-PAPER-ORDER-PAID-AT-SEND: a paper order paid in cash during the outage is recorded with the
// send at its cash total (the change was given then); nothing asks to take the cash again.
test("@production a paper order paid in cash is recorded with the send", async ({ page }) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const placedBodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/counter/orders", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    placedBodies.push(body);
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "5",
        orderVersion: 1,
        orderMinor: "423",
        tipMinor: "0",
        totalMinor: "423",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: true,
        payment: {
          status: "Recorded",
          amountMinor: "423",
          recordingReason: "RecordedAfterOutage",
          takenAt: (body.paperPayment as { takenAt: string }).takenAt,
          recordedAt: new Date().toISOString(),
          cash: {
            cashTotalMinor: "425",
            roundingMinor: "2",
            tenderedMinor: "425",
            changeMinor: "0",
          },
          acceptance: "Accepted",
        },
      },
    });
  });
  const separate: unknown[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    separate.push(route.request().postDataJSON());
    return route.abort();
  });
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
  const paid = new Date(Date.now() - 60 * 60_000);
  await page
    .getByLabel("Paid at (store time, from the paper order)")
    .fill(new Date(paid.getTime() - paid.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await page
    .getByRole("group", { name: "How it was paid during the outage" })
    .getByRole("radio", { name: "Cash" })
    .check();
  await expect(page.getByRole("textbox", { name: "Slip reference (optional)" })).toHaveCount(0);
  await expect(
    page.getByText("Sending records the order and the cash taken during the outage together."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send and record paper order" }).click();
  await expect(page.getByRole("heading", { name: "Order 5 paid" })).toBeVisible();
  await expect(
    page.getByText("Cash recorded after the outage and accepted.", { exact: false }),
  ).toBeVisible();
  expect(placedBodies[0]?.paperPayment).toMatchObject({ tender: "Cash", slipReference: null });
  await expect(page.getByText("Change to give")).toHaveCount(0);
  expect(separate).toHaveLength(0);
  await expect(page.locator("main")).not.toContainText(/To charge|released|Take \$|Ask a manager/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("heading", { name: "Order 5 paid" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/counter-paper-cash-${width}.png`, fullPage: true });
  }
});

/** An unpaid counter order as the Orders read lists it (the one-order read wraps it). */
const unpaidCounterRow = (input: {
  readonly orderNumber: string;
  readonly payBy: string;
  readonly recordedAfterOutage: boolean;
  readonly canCancelUnpaid: boolean;
  readonly amountDueMinor: string | null;
}) => ({
  orderReference: id(70),
  orderNumber: input.orderNumber,
  orderType: "Pickup",
  sourceChannel: "Pos",
  submittedAt: new Date(Date.now() - 60_000).toISOString(),
  observedAt: new Date().toISOString(),
  initialBatchReference: id(71),
  batches: [
    {
      orderBatchReference: id(71),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: true,
  currentPhase: "Submitted",
  currentVersion: 1,
  counter: {
    recordedAfterOutage: input.recordedAfterOutage,
    paidOnCardMachine: null,
    payBy: input.payBy,
    amountDueMinor: input.amountDueMinor,
    canCancelUnpaid: input.canCancelUnpaid,
    cancelledBeforePayment: null,
  },
  canRecordCardMachinePayment: true,
  canViewPayments: false,
});
const counterDetail = (order: ReturnType<typeof unpaidCounterRow>) => ({
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order,
  lines: {
    items: [
      {
        orderItemReference: id(72),
        orderBatchReference: id(71),
        name: "Banana Bread",
        options: [],
        quantity: 1,
        customerNote: null,
        unitPrice: { amountMinor: "1000", currencyCode: "CAD" },
        subtotal: { amountMinor: "1000", currencyCode: "CAD" },
        discount: { amountMinor: "0", currencyCode: "CAD" },
        tax: { amountMinor: "132", currencyCode: "CAD" },
        fee: { amountMinor: "0", currencyCode: "CAD" },
        total: { amountMinor: "1132", currencyCode: "CAD" },
        canCancel: false,
        cancellation: null,
      },
    ],
    totals: {
      subtotal: { amountMinor: "1000", currencyCode: "CAD" },
      discount: { amountMinor: "0", currencyCode: "CAD" },
      tax: { amountMinor: "132", currencyCode: "CAD" },
      fee: { amountMinor: "0", currencyCode: "CAD" },
      total: { amountMinor: "1132", currencyCode: "CAD" },
      tip: { amountMinor: "0", currencyCode: "CAD" },
    },
  },
});

// DEC-PAPER-ORDER-PAID-AT-SEND decisions 2 and 4 (v15 batch-5 review): a paper order whose
// payment didn't record with the send is recorded from Orders in the same paper words as on the
// counter, and its cash at the cash total (its change was given during the outage).
test("@production a paper order is recorded from Orders by its cash total, never charged", async ({
  page,
}) => {
  await signIn(page);
  const payBy = new Date(Date.now() + 25 * 60_000).toISOString();
  const row = (amountDueMinor: string | null) =>
    unpaidCounterRow({
      orderNumber: "31",
      payBy,
      recordedAfterOutage: true,
      canCancelUnpaid: true,
      amountDueMinor,
    });
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [row(null)], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail?*", (route) =>
    route.fulfill({ headers, json: counterDetail(row("1132")) }),
  );
  const payments: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/card-machine-payment", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    payments.push(body);
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(70),
        orderBatchReference: id(71),
        amountMinor: "1132",
        recordingReason: "RecordedAfterOutage",
        takenAt: body.takenAt,
        recordedAt: new Date().toISOString(),
        cash: {
          cashTotalMinor: "1130",
          roundingMinor: "-2",
          tenderedMinor: "1130",
          changeMinor: "0",
        },
        acceptance: "Accepted",
      },
    });
  });
  await page.goto("/operations/orders");
  const entry = orderPanel(page);
  await entry.getByRole("button", { name: "Record the paper order's payment" }).click();
  const form = entry.getByRole("form", { name: "Record the paper order's payment" });
  await expect(form).toContainText("Already paid on paper.");
  await expect(form).toContainText("Record this paper order's payment now.");
  await expect(form).not.toContainText(/released|Charge|charged the card machine/u);
  const tender = form.getByRole("group", { name: "How it was paid during the outage" });
  await expect(form.getByRole("group", { name: "How the guest pays" })).toHaveCount(0);
  await tender.getByRole("radio", { name: "Cash" }).check();
  // No cash received to type and no change to give: both happened during the outage.
  await expect(form.getByRole("textbox", { name: /Cash received/u })).toHaveCount(0);
  await expect(form).toContainText(
    "Paid in cash during the outage: $11.30. Its change was given then.",
  );
  const paid = new Date(Date.now() - 40 * 60_000);
  await form
    .getByLabel("Paid at (store time)")
    .fill(new Date(paid.getTime() - paid.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await expect(form.getByRole("button", { name: /Cash received/u })).toHaveCount(0);
  await form.getByRole("button", { name: "Record paper payment · $11.30" }).click();
  await expect(
    entry.getByText("Cash recorded after the outage and accepted.", { exact: false }),
  ).toBeVisible();
  expect(payments).toEqual([
    {
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      orderReference: id(70),
      orderBatchReference: id(71),
      expectedTotalMinor: "1132",
      slipReference: null,
      takenAt: expect.stringMatching(/Z$/u),
      tenderedMinor: "1130",
    },
  ]);
  await expect(entry).not.toContainText(/Change to give|Give \$/u);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/orders-paper-cash-${width}.png`, fullPage: true });
  }
});

// DEC-PAPER-SEND-IDEMPOTENT (v15 batch-9): an Orders row and the top of its detail for a paper
// order whose payment didn't record with the send say it was paid on paper and only its record is
// missing; they never tell staff to take payment, charge it or that it is released.
for (const language of ["en", "zh-Hans"] as const)
  test(`@production an unrecorded paper order's Orders row never asks to charge it (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      });
    await signIn(page);
    const payBy = new Date(Date.now() + 25 * 60_000).toISOString();
    const row = (amountDueMinor: string | null) =>
      unpaidCounterRow({
        orderNumber: "52",
        payBy,
        recordedAfterOutage: true,
        canCancelUnpaid: false,
        amountDueMinor,
      });
    // Two rows, newest first, so the list shows its row actions (a single order opens on its own).
    const live = {
      ...unpaidCounterRow({
        orderNumber: "53",
        payBy,
        recordedAfterOutage: false,
        canCancelUnpaid: false,
        amountDueMinor: null,
      }),
      orderReference: id(80),
      initialBatchReference: id(81),
    };
    live.batches = live.batches.map((batch) => ({ ...batch, orderBatchReference: id(81) }));
    await page.route("**/merchant/orders", (route) =>
      route.fulfill({ headers, json: { items: [live, row(null)], nextAfterOrderReference: null } }),
    );
    await page.route("**/merchant/orders/detail?*", (route) =>
      route.fulfill({ headers, json: counterDetail(row("1132")) }),
    );
    await page.goto("/operations/orders");
    const paperRow = page.locator("li.order-row").filter({ hasText: "52" });
    await expect(paperRow).toContainText(
      zh ? "纸单已付款 · 付款还没录入" : "Paid on paper · payment not recorded",
    );
    await expect(paperRow).toContainText(
      zh
        ? /停电\/断网时已付款 · 请在 \d\d:\d\d 前录入/u
        : /Paid during the outage · record it by \d\d:\d\d/u,
    );
    await expect(paperRow).toContainText(zh ? "付款未录入" : "Payment not recorded");
    await expect(
      paperRow.getByRole("button", { name: zh ? "录入纸单付款" : "Record paper payment" }),
    ).toBeVisible();
    await expect(paperRow).not.toContainText(
      zh ? /收款|释放|未付款|等待柜台/u : /Take payment|released|Charge|Not paid|Awaiting payment/u,
    );
    // The live order next to it still reads as one to charge.
    const liveRow = page.locator("li.order-row").filter({ hasText: "53" });
    await expect(liveRow.getByRole("button", { name: zh ? "收款" : "Charge" })).toBeVisible();
    await expect(liveRow).toContainText(zh ? "未付款将释放" : "released if unpaid");
    // Its detail opens on the same paper words at the top.
    await paperRow
      .getByRole("button", { name: zh ? "录入纸单付款" : "Record paper payment" })
      .click();
    const entry = orderPanel(page);
    await expect(entry).toContainText(
      zh ? "纸单已付款 · 付款还没录入" : "Paid on paper · payment not recorded",
    );
    await expect(entry.locator(".order-panel__phase")).not.toContainText(
      zh ? /收款/u : /payment at the counter/u,
    );
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/orders-paper-row-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });

// DEC-PAPER-SEND-IDEMPOTENT (v15 batch-9 L5): a paper send whose answer was lost is sent again as
// the same order, even when staff correct its paid-at or change a dish meanwhile: the server then
// answers with the order it placed (its payment already recorded), never a second paper sale.
test("@production a paper send with no answer stays the same order after the paid-at or dishes change", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const sent: Record<string, unknown>[] = [];
  const answers: ((route: Parameters<Parameters<Page["route"]>[1]>[0]) => Promise<void>)[] = [
    // The server placed and recorded it; the answer never reached the page.
    (route) => route.abort("failed"),
    (route) => route.abort("failed"),
    (route) =>
      route.fulfill({
        status: 409,
        headers,
        json: { error: "counter_order_already_ordered", orderNumber: "77" },
      }),
    // b11: the next tap is a new order with no paper slip (the slip went with order 77).
    (route) =>
      route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(40),
          orderBatchReference: id(41),
          orderNumber: "78",
          orderVersion: 1,
          orderMinor: "848",
          tipMinor: "0",
          totalMinor: "848",
          payBy: new Date(Date.now() + 20 * 60_000).toISOString(),
          recordedAfterOutage: false,
        },
      }),
  ];
  await page.route("**/merchant/counter/orders", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    const answer = answers[sent.length - 1];
    if (answer === undefined) throw new Error("no more sends were expected");
    return answer(route);
  });
  const local = (at: Date) =>
    new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
  const paidAt = page.getByLabel("Paid at (store time, from the paper order)");
  await paidAt.fill(local(new Date(Date.now() - 20 * 60_000)));
  const send = page.getByRole("button", { name: "Send and record paper order" });
  await send.click();
  await expect(
    page.getByText(
      "No answer from the system. Send again — the same order is never created twice.",
    ),
  ).toBeVisible();
  // The paid-at is corrected from the slip: the same order, a new payment.
  await paidAt.fill(local(new Date(Date.now() - 25 * 60_000)));
  await send.click();
  await expect(
    page.getByText(
      "No answer from the system. Send again — the same order is never created twice.",
    ),
  ).toBeVisible();
  // A dish is added: still the same order operation, answered with the order it placed.
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await send.click();
  // b11: the paper slip went with order 77, so it is cleared here: sending again never records the
  // same slip twice.
  await expect(
    page.getByText(
      "Already ordered as order 77; this paper slip goes with that order. Nothing new was charged or recorded. The slip was cleared here so it is never recorded twice. To send dishes that aren't in order 77, take their own payment. Open it in Orders.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }),
  ).not.toBeChecked();
  expect(sent).toHaveLength(3);
  const operation = sent[0]?.operationReference;
  expect(sent.map((body) => body.operationReference)).toEqual([operation, operation, operation]);
  const payment = (n: number) => sent[n]?.paperPayment as Record<string, unknown>;
  expect(payment(1).operationReference).not.toBe(payment(0).operationReference);
  expect(payment(1).takenAt).not.toBe(payment(0).takenAt);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-paper-no-answer-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The next tap sends the dishes as a new order to charge, with no paper payment in it.
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(
    page.getByRole("heading", { name: "Charge $8.48 on the card machine" }),
  ).toBeVisible();
  expect(sent).toHaveLength(4);
  expect(sent[3]?.operationReference).not.toBe(operation);
  expect(sent[3]?.paperPayment).toBeUndefined();
  expect(sent[3]?.recordedAfterOutage).toBe(false);
});

// DEC-PAPER-SEND-IDEMPOTENT (review): staff reload a tablet that looks stuck after a paper send got
// no answer, then enter the slip again. The page kept that send for the Store, so the same order
// operation and the same payment operation go again: the order already recorded comes back, never
// a second paper sale. Once answered, a reload no longer mentions it.
test("@production a paper send with no answer is the same order after the page is reloaded", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/counter/orders", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    // The server placed and recorded it; the first answer never reached the page.
    if (sent.length === 1) return route.abort("failed");
    if (sent.length > 2) throw new Error("no more sends were expected");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyPlaced",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "77",
        orderVersion: 2,
        orderMinor: "367",
        tipMinor: "0",
        totalMinor: "367",
        payBy: new Date(Date.now() + 10 * 60_000).toISOString(),
        recordedAfterOutage: true,
        paid: true,
        payment: {
          status: "AlreadyRecorded",
          amountMinor: "367",
          recordingReason: "RecordedAfterOutage",
          takenAt: (body.paperPayment as { takenAt: string }).takenAt,
          recordedAt: new Date().toISOString(),
          acceptance: "Accepted",
        },
      },
    });
  });
  const paidAt = new Date(Date.now() - 20 * 60_000);
  const local = new Date(paidAt.getTime() - paidAt.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const enterSlip = async () => {
    await page.getByRole("button", { name: "Add Banana Bread" }).click();
    await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
    await page.getByLabel("Paid at (store time, from the paper order)").fill(local);
    await page.getByLabel("Slip reference (optional)").fill("TESTSLIP3");
    await page.getByRole("button", { name: "Send and record paper order" }).click();
  };
  await page.goto("/operations/order-entry");
  await enterSlip();
  await expect(
    page.getByText(
      "No answer from the system. Send again — the same order is never created twice.",
    ),
  ).toBeVisible();
  // The tablet looks stuck: staff reload it.
  await page.reload();
  const kept = page.getByText(
    /The last paper order sent from this tablet \(\d\d:\d\d\) got no answer, so it may already be recorded\./u,
  );
  await expect(kept).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-paper-reloaded-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Nothing about the slip itself is kept in the browser.
  expect(
    await page.evaluate(() => JSON.stringify(Object.entries(window.localStorage))),
  ).not.toContain("TESTSLIP3");
  await enterSlip();
  await expect(page.getByRole("heading", { name: "Order 77 paid" })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.operationReference).toBe(sent[0]?.operationReference);
  const payment = (n: number) => sent[n]?.paperPayment as Record<string, unknown>;
  expect(payment(1).operationReference).toBe(payment(0).operationReference);
  // Answered: a later reload starts afresh.
  await page.reload();
  await expect(page.getByRole("button", { name: "Add Banana Bread" })).toBeVisible();
  await expect(kept).toHaveCount(0);
});

// DEC-PAPER-SEND-IDEMPOTENT (review): a live counter order was charged from Orders while the
// counter page had no answer. The same send reads it back as paid: the page says so and never
// shows a charge step (a second card charge) with a pay-by in the past.
test("@production a live send that comes back already paid goes to paid, never to charge", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  let sends = 0;
  await page.route("**/merchant/counter/orders", (route) => {
    sends += 1;
    if (sends === 1) return route.abort("failed");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyPlaced",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "81",
        orderVersion: 2,
        orderMinor: "367",
        tipMinor: "0",
        totalMinor: "367",
        payBy: new Date(Date.now() - 5 * 60_000).toISOString(),
        recordedAfterOutage: false,
        paid: true,
      },
    });
  });
  // b11: the sent-not-paid read lags the payment for a moment and still lists order 81 unpaid.
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(20),
            orderNumber: "81",
            orderType: "Pickup",
            sourceChannel: "Pos",
            submittedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
            observedAt: new Date().toISOString(),
            initialBatchReference: id(21),
            counter: {
              recordedAfterOutage: false,
              paidOnCardMachine: null,
              payBy: new Date(Date.now() + 20 * 60_000).toISOString(),
              amountDueMinor: "367",
            },
            canRecordCardMachinePayment: true,
            canViewPayments: false,
            batches: [
              {
                orderBatchReference: id(21),
                sequence: 1,
                acceptanceStatus: "NotAccepted",
                canRequestAcceptance: false,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Submitted",
            currentVersion: 1,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: true,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  const send = page.getByRole("button", { name: "Send order" });
  await send.click();
  await expect(
    page.getByText(
      "No answer from the system. Send again — the same order is never created twice.",
    ),
  ).toBeVisible();
  await send.click();
  await expect(page.getByRole("heading", { name: "Order 81 paid" })).toBeVisible();
  // The amount is what was paid, never "To charge"; the lagging list never offers to take it.
  await expect(page.getByText("Amount paid", { exact: true })).toBeVisible();
  await expect(page.getByText("To charge", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sent, not paid yet" })).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/counter-paid-replay-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByText(
      "Order 81 is already paid; its payment is recorded. Don't charge the guest again",
    ),
  ).toBeVisible();
  // No charge step: nothing to record or take payment for.
  await expect(page.getByRole("button", { name: /Record/u })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/Take payment by|released if unpaid/u);
});

// DEC-PAPER-ORDER-PAID-AT-SEND (v15 batch-5 review): a retry of a paper send after no answer, with
// the tender changed, finds the first payment recorded; the sale is shown as recorded, never as
// "isn't recorded yet" or something to check before charging.
test("@production a paper send whose payment is already recorded reads as recorded", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/counter/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        status: "AlreadyPlaced",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "8",
        orderVersion: 1,
        orderMinor: "423",
        tipMinor: "0",
        totalMinor: "423",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: true,
        paymentError: "already_paid",
      },
    }),
  );
  await page.goto("/operations/order-entry");
  await page.getByRole("button", { name: "Add Banana Bread" }).click();
  await page.getByRole("checkbox", { name: "Recorded after an outage (taken on paper)" }).check();
  const paid = new Date(Date.now() - 60 * 60_000);
  await page
    .getByLabel("Paid at (store time, from the paper order)")
    .fill(new Date(paid.getTime() - paid.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Send and record paper order" }).click();
  await expect(page.getByRole("heading", { name: "Order 8 paid" })).toBeVisible();
  await expect(
    page.getByText("This paper order's payment is already recorded and in the day's takings."),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText(
    /isn't recorded yet|before charging|To charge/u,
  );
});

// WP-2423 M127 (v15 batch-5 review): the order being charged is not on the Orders read's first page
// (a busy Store, or the list lags the send): it is read on its own, so an owner still gets Cancel;
// staff who may not read Orders are told to ask a manager.
for (const variant of ["off the first page", "no Orders access"] as const)
  test(`@production the charge step learns who cancels when the order is ${variant}`, async ({
    page,
  }) => {
    await signIn(page);
    await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
    const payBy = new Date(Date.now() + 30 * 60_000).toISOString();
    await page.route("**/merchant/counter/orders", (route) =>
      route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(70),
          orderBatchReference: id(71),
          orderNumber: "14",
          orderVersion: 1,
          orderMinor: "593",
          tipMinor: "0",
          totalMinor: "593",
          payBy,
          recordedAfterOutage: false,
        },
      }),
    );
    let sent = false;
    await page.route("**/merchant/orders", (route) =>
      sent && variant === "no Orders access"
        ? route.fulfill({ status: 403, headers, json: { error: "forbidden" } })
        : route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
    );
    await page.route("**/merchant/orders/detail?*", (route) =>
      route.fulfill({
        headers,
        json: counterDetail(
          unpaidCounterRow({
            orderNumber: "14",
            payBy,
            recordedAfterOutage: false,
            canCancelUnpaid: true,
            amountDueMinor: "593",
          }),
        ),
      }),
    );
    await page.goto("/operations/order-entry");
    await page.getByRole("button", { name: "Add Banana Bread" }).click();
    sent = true;
    await page.getByRole("button", { name: "Send order" }).click();
    const charge = page.locator(".counter-order__charge");
    if (variant === "off the first page") {
      await expect(charge.getByRole("button", { name: "Cancel order" })).toBeVisible();
      await expect(charge).not.toContainText("Ask a manager");
    } else {
      await expect(charge).toContainText("Guest not paying? Ask a manager to cancel it");
      await expect(charge.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
    }
  });

// DEC-PAPER-ORDER-NEVER-RELEASED: a paper order whose payment wasn't recorded by its time is never
// released: it stays on the counter's "Sent, not paid yet" list (and Home) saying it is kept and
// must be entered again from the slip; a manager then links the new paper order (whose payment is
// recorded) and the old one closes as entered again. Front of house is told a manager links it.
// v15 batch-8 review: the new orders are read from the server (the re-entered one is already made
// and gone from this list), the paper order's sale is shown, and a cheaper order can't be chosen.
test("@production a paper order past its time stays listed until a manager links the re-entered order, at 1440, 1024 and 390", async ({
  page,
}) => {
  await signIn(page);
  const ended = new Date(Date.now() - 5 * 60_000).toISOString();
  let linked: Record<string, unknown> | null = null;
  let manager = true;
  const stale = () => {
    const row = unpaidCounterRow({
      orderNumber: "31",
      payBy: ended,
      recordedAfterOutage: true,
      canCancelUnpaid: false,
      amountDueMinor: null,
    });
    return {
      ...row,
      submittedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      counter: { ...row.counter, canCloseAsReentered: manager },
    };
  };
  await page.route("**/merchant/counter/menu", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: linked === null ? [stale()] : [],
        nextAfterOrderReference: null,
      },
    }),
  );
  let choicesRead = 0;
  await page.route("**/merchant/counter/orders/paper-reentry?*", (route) => {
    choicesRead += 1;
    expect(new URL(route.request().url()).searchParams.get("order")).toBe(id(70));
    return route.fulfill({
      headers,
      json: {
        paperOrder: { orderNumber: "31", saleMinor: "2000", currencyCode: "CAD" },
        candidates: [
          {
            orderReference: id(90),
            orderNumber: "36",
            submittedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
            saleMinor: "500",
            paidMinor: "500",
            coversSale: false,
          },
          {
            orderReference: id(80),
            orderNumber: "34",
            submittedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            saleMinor: "2000",
            paidMinor: "2300",
            coversSale: true,
          },
        ],
      },
    });
  });
  await page.route("**/merchant/counter/orders/cancel-unpaid", (route) => {
    linked = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      headers,
      json: { status: "Cancelled", cancelledAt: new Date().toISOString() },
    });
  });
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    linked = null;
    manager = true;
    await page.setViewportSize({ width, height });
    await page.goto("/operations/order-entry");
    const list = page.getByRole("region", { name: "Sent, not paid yet" });
    const row = list.getByRole("listitem").filter({ hasText: "Order 31" });
    await expect(row).toContainText("The order stays in the system");
    await expect(row).toContainText("enter it again from the paper slip as a new paper order");
    await expect(row).not.toContainText(/taken off|released|Take payment/u);
    // It can no longer be recorded on itself: no record button, only the link to the new order.
    await expect(row.getByRole("button", { name: "Record the paper order's payment" })).toHaveCount(
      0,
    );
    await row.getByRole("button", { name: "Link the re-entered order" }).click();
    const dialog = page.getByRole("dialog", { name: "Paper order 31 was entered again" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Paper order 31: dishes $20.00 with tax, before tip.");
    // A cheaper order can't carry a $20.00 sale: shown, but not choosable.
    await expect(
      dialog.getByRole("radio", { name: /^Order 36 · .*dishes \$5\.00/u }),
    ).toBeDisabled();
    await expect(dialog).toContainText("Less than this paper order: it can't carry this sale.");
    await dialog
      .getByRole("radio", { name: /^Order 34 · sent .* · dishes \$20\.00 · paid \$23\.00$/u })
      .check();
    await dialog.getByRole("button", { name: "Close as entered again" }).click();
    await expect(dialog).toBeHidden();
    expect(linked).toMatchObject({
      orderReference: id(70),
      orderBatchReference: id(71),
      expectedOrderVersion: 1,
      reasonCode: "COUNTER_PAPER_REENTERED",
      reenteredOrderReference: id(80),
    });
    await expect(list.getByRole("listitem").filter({ hasText: "Order 31" })).toHaveCount(0);
    expect(choicesRead).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    // Front of house sees it kept and is told a manager links the new order.
    linked = null;
    manager = false;
    await page.reload();
    const kept = page
      .getByRole("region", { name: "Sent, not paid yet" })
      .getByRole("listitem")
      .filter({ hasText: "Order 31" });
    await expect(kept).toContainText("a manager then links the new order here");
    await expect(kept.getByRole("button", { name: "Link the re-entered order" })).toHaveCount(0);
  }
});

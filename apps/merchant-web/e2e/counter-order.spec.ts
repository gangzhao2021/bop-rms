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

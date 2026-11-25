import { expect, test, type Page } from "@playwright/test";

/**
 * b62 (v15 b61 live check, TM2): money and merged tables said truthfully on Orders and Tables.
 * Synthetic Store; the server is mocked with the shapes seen live.
 *  - Orders 67/69/79: a paid pickup staff cancelled ($14.13 with its tip), the refund not answered
 *    yet. The read now sends the amount (Payment's remaining refundable) before the compensation
 *    case opens; the detail says "Refund on its way $14.13", never "Amount not known yet".
 *  - Order 73: S61 D merged into S61 C and paid there. At 390 the row showed only "—" (the note
 *    was phone-hidden); the detail never said where it was paid and offered "Close the table",
 *    which belongs to S61 C (the order's serving progress follows S61 C's session).
 *  - S61 B: paid $32.00 by phone, all of it refunded. Tables' checkout still said "Paid in full"
 *    with no refund.
 */
const id = (n: number) => "0190a62b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const csrf = "a".repeat(43);
type Shape = "pickupCancelPending" | "mergedAway";

async function signIn(page: Page, zh: boolean, screen: "orders" | "tables") {
  if (zh)
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-11-24",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            screen === "orders"
              ? {
                  screenId: "OPS-ORDER-QUEUE",
                  label: "Orders",
                  href: "/operations/orders",
                  permission: "ordering.operate",
                }
              : {
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
}

async function orders(page: Page, zh: boolean, shape: Shape) {
  await signIn(page, zh, "orders");
  const pickup = shape === "pickupCancelPending";
  // Payment's position before its compensation case opens: nothing back, nothing claimed yet.
  const position = {
    refundedMinor: "0",
    refundPendingMinor: "0",
    refundNotSentMinor: "0",
    refundOnMachineMinor: "0",
  };
  const order = {
    orderReference: id(1),
    orderNumber: pickup ? "67" : "73",
    orderType: pickup ? "Pickup" : "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-24T22:44:00.000Z",
    observedAt: "2026-11-24T22:53:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        // As the fixed read sends it before Payment's case opens: the amount the dialog said.
        staffCancellation: pickup
          ? {
              reasonCode: "CUSTOMER_REQUEST",
              cancelledAt: "2026-11-24T22:44:58.000Z",
              refundStatus: "Pending",
              refundMethod: "Online",
              refundAmountMinor: "1413",
            }
          : null,
        canCancelItems: false,
        ...(pickup
          ? {}
          : {
              unpaidRemovableItems: [],
              unpaidRemovedItems: [],
              compableItems: [],
              compedItems: [],
            }),
      },
    ],
    canRequestAcceptance: false,
    canViewPayments: false,
    canRecordCardMachinePayment: false,
    ...(pickup
      ? {
          paidOnline: money("1413"),
          paymentPosition: position,
        }
      : {
          tableBill: {
            totalMinor: "0",
            paid: null,
            mergedInto: { tableLabel: "S61 C (TEST)", paid: true },
            // Round 1 is S61 C's own; this order's round is round 2 on that bill.
            billRoundNumbers: [
              { orderBatchReference: id(81), roundNumber: 1 },
              { orderBatchReference: id(51), roundNumber: 2 },
            ],
          },
        }),
    currentPhase: pickup ? "Cancelled" : "Fulfilled",
    currentVersion: 4,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
  const lines = {
    items: [
      {
        orderItemReference: id(201),
        orderBatchReference: id(51),
        name: "Beef noodles (TEST)",
        options: [],
        quantity: 1,
        customerNote: null,
        unitPrice: money("1250"),
        subtotal: money("1250"),
        discount: money("0"),
        tax: money("163"),
        fee: money("0"),
        total: money("1413"),
        canCancel: false,
        cancellation: null,
      },
    ],
    totals: {
      subtotal: money("1250"),
      discount: money("0"),
      tax: money("163"),
      fee: money("0"),
      taxRounding: money("0"),
      total: money("1413"),
    },
  };
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order,
        lines,
        ...(pickup ? { paymentPosition: position } : {}),
      },
    }),
  );
  if (!pickup) {
    await page.route("**/merchant/orders/table-payment", (route) =>
      route.fulfill({ headers, json: { orderReference: id(1), payment: null, parts: [] } }),
    );
    // As v15 answered it for order 73: the host table's session (S61 C), in checkout.
    await page.route("**/merchant/dining/order-progress", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          tableLabel: "S61 C (TEST)",
          diningSessionReference: id(72),
          sessionPhase: "Closing",
          sessionVersion: 7,
          tableAssignmentVersion: 3,
          closureStatus: "Open",
          closureVersion: 0,
          currentOrderVersion: 4,
          orderVersion: 4,
          phase: "Fulfilled",
          observedAt: "2026-11-24T22:53:00.000Z",
          items: [
            {
              orderItemReference: id(201),
              orderBatchReference: id(51),
              displayName: "Beef noodles (TEST)",
              batchSequence: 1,
              itemOrdinal: 1,
              phase: "Fulfilled",
              orderedQuantity: 1,
              deliveredQuantity: 1,
              remainingQuantity: 0,
              itemServiceVersion: 2,
            },
          ],
        },
      }),
    );
  }
}

/** S61 B: $28.25 and a $3.75 tip paid by phone ($32.00), then refunded. */
async function tables(page: Page, zh: boolean, refunds: Record<string, string>) {
  await signIn(page, zh, "tables");
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        items: [
          {
            tableReference: id(10),
            stableLabel: "S61 B (TEST)",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 30,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: { phase: "Closing", version: 7, orderReference: id(3) },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-11-24T22:50:00.000Z",
        rounds: [],
        closeBlockers: [],
        totals: { onlineMinor: "3200", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        ...refunds,
        diningSessionReference: id(2),
        sessionPhase: "Closing",
        sessionVersion: 7,
        paymentTiming: "PayLater",
        tableLabel: "S61 B (TEST)",
        orderReference: id(3),
        rounds: [
          {
            roundNumber: 1,
            orderBatchReference: id(21),
            submissionReference: id(31),
            items: [
              {
                orderItemReference: id(901),
                quantity: 2,
                displayName: "Beef noodles (TEST)",
                subtotalMinor: "2500",
                totalMinor: "2825",
              },
            ],
            subtotalMinor: "2500",
            taxMinor: "325",
            totalMinor: "2825",
            paid: true,
          },
        ],
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        consistent: true,
        settlement: {
          method: "Online",
          roundsMinor: "2825",
          tipMinor: "375",
          roundingMinor: "0",
          totalMinor: "3200",
          tenderedMinor: null,
          changeMinor: null,
          recordedAt: "2026-11-24T22:45:00.000Z",
          recordedAfterOutage: false,
        },
      },
    }),
  );
}

const value = (page: Page, label: string) =>
  page
    .locator(".order-lines-totals > div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
    .locator("dd")
    .first();

async function noSideways(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

/** Each row of a dl: its figure on one line, ~40 px to spare (Linux fonts are wider). */
async function fits(page: Page, selector: string) {
  const found = await page.locator(selector).evaluateAll((rows) =>
    rows
      .filter((row) => row.getBoundingClientRect().width > 0)
      .map((row) => {
        const dd = row.querySelector("dd");
        const dt = row.querySelector("dt");
        const range = document.createRange();
        if (dd) range.selectNodeContents(dd);
        return {
          text: row.textContent ?? "",
          lines: dd ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0,
          spare:
            row.getBoundingClientRect().width -
            (dd?.getBoundingClientRect().width ?? 0) -
            (dt?.getBoundingClientRect().width ?? 0),
        };
      }),
  );
  expect(found.length).toBeGreaterThan(0);
  for (const row of found) {
    expect(row.lines, row.text).toBe(1);
    expect(row.spare, row.text).toBeGreaterThanOrEqual(40);
  }
  await noSideways(page);
}

async function openRow(page: Page) {
  const opener = page.locator("li.order-row").first().locator(".order-row__open");
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b62: a cancelled pickup's refund on its way says its amount (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await orders(page, zh, "pickupCancelPending");
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      await expect(row.locator(".order-row__money")).toHaveText("$14.13");
      await openRow(page);
      await expect(value(page, zh ? "合计" : "Total")).toHaveText("$14.13");
      await expect(value(page, zh ? "正在退回客人的卡" : "Refund on its way")).toHaveText("$14.13");
      await expect(page.getByText(zh ? "金额暂未知" : "Amount not known yet")).toHaveCount(0);
      await fits(page, ".order-lines-totals > div");
      await page.screenshot({
        path: `test-results/b62-pickup-cancel-pending-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b62: a table merged into another says so on its row and detail, and offers no close of the other table (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await orders(page, zh, "mergedAway");
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      // At every width, phones too: why there is no amount.
      const note = row.locator(".order-row__merged");
      await expect(note).toBeVisible();
      await expect(note).toHaveText(
        zh ? "已并入 S61 C (TEST) · 在那里付清" : "Merged into S61 C (TEST) · paid there",
      );
      const room = await note.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()];
        const what = element
          .closest("li.order-row")
          ?.querySelector(".order-row__what")
          ?.getBoundingClientRect();
        return {
          overflow: element.scrollWidth > element.clientWidth + 1,
          widest: Math.max(...rects.map((r) => r.width)),
          row: element.closest("li.order-row")?.getBoundingClientRect().width ?? 0,
          noteLeft: element.getBoundingClientRect().left,
          whatRight: what?.right ?? 0,
        };
      });
      expect(room.overflow).toBe(false);
      // Batch 63 (F19): the note ends the grey line under the dishes (Figma 37:2), inside the row,
      // so it never takes the amount's place.
      expect(room.widest).toBeLessThanOrEqual(room.row);
      await noSideways(page);
      await openRow(page);
      const said = page.locator(".order-panel__merged");
      await expect(said).toBeVisible();
      await expect(said).toHaveText(
        zh
          ? "已并入 S61 C (TEST)。本单各轮记在该桌账单上，已在那里付清。"
          : "Merged into S61 C (TEST). Its rounds are on that table's bill and were paid there.",
      );
      // The order and its rounds stay (never hidden); only S61 C's own steps are not offered.
      await expect(value(page, zh ? "合计" : "Total")).toHaveText("$14.13");
      await expect(page.getByText("Beef noodles (TEST)").first()).toBeVisible();
      await expect(page.getByRole("button", { name: zh ? "关台" : "Close the table" })).toHaveCount(
        0,
      );
      await expect(page.getByText(zh ? /^结账中$/u : /^Checking out$/u)).toHaveCount(0);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b62-merged-away-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b62: Tables checkout says a paid table bill was refunded (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await tables(page, zh, { refundedMinor: "3200" });
      await page.goto("/operations/dining");
      await page
        .getByRole("button", {
          name: zh ? "选择 S61 B (TEST)" : "Select S61 B (TEST)",
          exact: true,
        })
        .click();
      const checkout = page.getByRole("region", { name: zh ? "结账" : "Checkout" });
      const receipt = checkout.locator(".table-receipt");
      const row = (label: string) =>
        receipt
          .locator(".table-checkout__totals > div")
          .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
          .locator("dd");
      // b64 (v15 b62 live, S62 E): paid, then refunded in full, net $0.00 — never "Total paid",
      // a "Paid" heading or "Print paid bill" over it.
      await expect(row(zh ? "合计" : "Total")).toHaveText("$32.00");
      await expect(row(zh ? "已全部退款" : "Fully refunded")).toHaveText("−$32.00");
      await expect(row(zh ? "退款后合计" : "Total after refunds")).toHaveText("$0.00");
      await expect(receipt).toContainText(
        zh
          ? "已全部退款。客人离开后关台。"
          : "Fully refunded. Close the table when the guests have left.",
      );
      await expect(receipt).not.toContainText(zh ? "已全部付清" : "Paid in full");
      await expect(receipt).not.toContainText(zh ? "实付合计" : "Total paid");
      await expect(checkout.locator("#table-checkout-title")).toHaveText(
        zh ? "已退款" : "Refunded",
      );
      await expect(
        receipt.getByRole("button", { name: zh ? "打印账单" : "Print bill" }),
      ).toBeVisible();
      await expect(page.getByText(zh ? "打印已付账单" : "Print paid bill")).toHaveCount(0);
      await expect(
        page.getByText(zh ? /账单已付清|已付的账/u : /bill is paid|on a paid bill/u),
      ).toHaveCount(0);
      await fits(page, ".table-receipt .table-checkout__totals > div");
      await page.screenshot({
        path: `test-results/b62-tables-fully-refunded-${language}-${width}.png`,
        fullPage: true,
      });
      // The table's row on the list says it too (b63 review, F37: on a phone, back on the list).
      if (width < 768) await page.getByRole("button", { name: zh ? "‹ 桌台" : "‹ Tables" }).click();
      await expect(
        page.getByText(
          zh ? "已全部退款 · 客人走后关台" : "Fully refunded · close when the guests leave",
        ),
      ).toBeVisible();
    });
  }

  test(`@production b62: Tables checkout takes a part refund off and says one on its way apart (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await tables(page, zh, { refundedMinor: "800", refundPendingMinor: "300" });
    await page.goto("/operations/dining");
    await page
      .getByRole("button", { name: zh ? "选择 S61 B (TEST)" : "Select S61 B (TEST)", exact: true })
      .click();
    const receipt = page
      .getByRole("region", { name: zh ? "结账" : "Checkout" })
      .locator(".table-receipt");
    await expect(receipt).toContainText(zh ? "已退款−$5.00" : "Refunded−$5.00");
    await expect(receipt).toContainText(zh ? "退款后合计$27.00" : "Total after refunds$27.00");
    await expect(receipt).toContainText(zh ? "正在退回客人的卡$3.00" : "Refund on its way$3.00");
    await expect(receipt).not.toContainText(zh ? "已全部退款" : "Fully refunded");
    // b64: still paid, part of it refunded; never "Total paid" over a refunded bill.
    await expect(receipt).toContainText(
      zh
        ? "已付款，部分已退款。客人离开后关台。"
        : "Paid, part of it refunded. Close the table when the guests have left.",
    );
    await expect(receipt).not.toContainText(zh ? "实付合计" : "Total paid");
    await fits(page, ".table-receipt .table-checkout__totals > div");
  });
}

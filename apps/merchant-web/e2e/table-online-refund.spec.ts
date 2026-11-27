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
  cardRefunds: [] as unknown[],
  onlineRefunds: [] as unknown[],
  refundableMinor: "4600",
};
const refund = (state: string) => ({
  amountMinor: "1000",
  reasonCode: "FOOD_ISSUE",
  requestedAt: "2026-11-02T20:10:00.000Z",
  state,
});

async function orderPage(page: Page, reads: () => unknown, refundedMinor?: string) {
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
              paid: {
                amountMinor: "4600",
                method: "Online",
                ...(refundedMinor === undefined ? {} : { refundedMinor }),
              },
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

test("@production who can't refund is told so instead of being offered the form", async ({
  page,
}) => {
  await orderPage(page, () => ({
    orderReference: id(1),
    payment,
    parts: [],
    canRefund: false,
  }));
  await page.goto("/operations/orders");
  await expect(page.getByText("Refunds are made by a manager.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refund to the card", exact: true })).toHaveCount(
    0,
  );
});

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
  await page.getByRole("button", { name: /^Confirm: refund/u }).click();
  await expect(page.getByText(/^Refunded to the card/u)).toBeVisible();
  await expect(page.getByText(/few days/u)).toBeVisible();
  await expect(page.getByText("Can still be refunded", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: /^Confirm: refund/u }).click();
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
  await expect(page.getByRole("region", { name: /part 2$/u })).not.toContainText(
    "Record a card machine refund",
  );
  await fill(page, "10");
  await page.getByRole("button", { name: /10\.00 to the card$/u }).click();
  await page.getByRole("button", { name: /^Confirm: refund/u }).click();
  await expect.poll(() => bodies[0]?.partNumber).toBe(1);
});

// Batch 43 (v15 Fireside Hotpot, tips off): two even parts paid on the guests' phones with no
// tip. Each paid part lists how it was paid and its rounds, with no "Tip $0.00" line; a part that
// did take a tip shows it.
test("@production a paid part that took no tip has no Tip line; one that did shows it", async ({
  page,
}) => {
  await orderPage(page, () => ({
    orderReference: id(1),
    payment: null,
    parts: [
      {
        ...payment,
        partNumber: 1,
        roundsMinor: "2427",
        tipMinor: "0",
        totalMinor: "2427",
        refundableMinor: "2427",
      },
      { ...payment, partNumber: 2 },
    ],
  }));
  await page.goto("/operations/orders");
  const first = page.getByRole("region", { name: /part 1$/u });
  await expect(first).toContainText("$24.27");
  expect(await first.locator("dt").allTextContents()).not.toContain("Tip");
  const second = page.getByRole("region", { name: /part 2$/u });
  await expect(second).toContainText("Tip$6.00");
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

test("@production a manager records a refund made on the card machine of a table paid there", async ({
  page,
}) => {
  const machine = { ...payment, method: "CardMachine" };
  await orderPage(page, () => ({ orderReference: id(1), payment: machine, parts: [] }));
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/table-payment/card-refund", (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        payment: {
          ...machine,
          cardRefunds: [
            {
              amountMinor: "1000",
              reasonCode: "FOOD_ISSUE",
              refundedAt: "2026-11-02T20:10:00.000Z",
            },
          ],
          refundableMinor: "3600",
        },
        parts: [],
      },
    });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Record a card machine refund", exact: true }).click();
  await expect(page.getByText(/no money moves from this screen/u)).toBeVisible();
  await page.getByLabel("Amount to refund").fill("10");
  await page.getByRole("combobox", { name: /Reason/u }).selectOption("FOOD_ISSUE");
  await page.getByLabel("Slip reference (optional)").fill("4242424242424242 4242");
  await page.getByLabel("Slip reference (optional)").fill("AUTH 771");
  await page.getByRole("button", { name: /10\.00 refunded on the card machine$/u }).click();
  await page.getByRole("button", { name: /^Confirm: record/u }).click();
  await expect(page.getByText(/^Refunded on the card machine/u)).toBeVisible();
  await expect(page.getByText("Can still be refunded", { exact: true })).toBeVisible();
  expect(bodies[0]).toMatchObject({
    orderReference: id(1),
    amountMinor: "1000",
    reasonCode: "FOOD_ISSUE",
    slipReference: "AUTH 771",
  });
});

// Live check 2026-11-03: an Owner on a PIN sign-in was told "ask a manager". The server only wants
// to know who it is, so they are asked to confirm that, and nothing was recorded.
test("@production a refund on a PIN sign-in asks to confirm it's you, not for a manager", async ({
  page,
}) => {
  const machine = { ...payment, method: "CardMachine" };
  await orderPage(page, () => ({ orderReference: id(1), payment: machine, parts: [] }));
  await page.route("**/merchant/orders/table-payment/card-refund", (route) =>
    route.fulfill({ status: 403, headers, json: { error: "full_sign_in_required" } }),
  );
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Record a card machine refund", exact: true }).click();
  await page.getByLabel("Amount to refund").fill("10");
  await page.getByRole("combobox", { name: /Reason/u }).selectOption("FOOD_ISSUE");
  await page.getByRole("button", { name: /10\.00 refunded on the card machine$/u }).click();
  await page.getByRole("button", { name: /^Confirm: record/u }).click();
  await expect(page.getByRole("region", { name: "Confirm it's you" })).toBeVisible();
  await expect(page.getByText("A manager refunds this payment", { exact: false })).toHaveCount(0);
});

// v15 batch 7: a table order with a refund says so on its row without pushing the page sideways,
// with the order open beside it. b60: as a pickup's, under its amount ("$36.00", "$10.00
// refunded"), at every width.
for (const width of [1440, 1024, 390])
  test(`@production a refunded table order's row fits at ${width} with the order open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await orderPage(
      page,
      () => ({
        orderReference: id(1),
        payment: { ...payment, onlineRefunds: [refund("Refunded")], refundableMinor: "3600" },
        parts: [],
      }),
      "1000",
    );
    await page.goto("/operations/orders");
    await expect(
      page.getByRole("button", { name: "Refund to the card", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".order-row__money").first()).toHaveText("$36.00");
    await expect(page.locator(".order-row__refunded").first()).toBeVisible();
    await expect(page.locator(".order-row__refunded").first()).toHaveText("$10.00 refunded");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // The refunded amount in the order reads on one line, never "−$10" then ".00".
    const lines = await page
      .locator(".table-payment dd", { hasText: "$10.00" })
      .first()
      .evaluate((dd) => {
        const range = document.createRange();
        range.selectNodeContents(dd);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      });
    expect(lines).toBe(1);
    await page.screenshot({ path: `test-results/orders-table-refund-row-${width}.png` });
  });

/**
 * Batch 58 (v15 b57 live, Test Merchant 2 table L57R A): part 1 paid on the guest's phone
 * ($14.13), $8.00 refunded to the card by the signed-in manager. Orders said "… 4:09 AM by You",
 * in Chinese "… 4:09 经办你". The line now says who did it as a sentence.
 */
for (const language of ["en", "zh-Hans"] as const)
  test(`@production b58: a refund line says who made it as a sentence (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          /* the page falls back to English */
        }
      });
    await orderPage(
      page,
      () => ({
        orderReference: id(1),
        payment: {
          ...payment,
          partNumber: 1,
          roundsMinor: "1413",
          tipMinor: "0",
          totalMinor: "1413",
          onlineRefunds: [
            {
              amountMinor: "800",
              reasonCode: "CUSTOMER_REQUEST",
              requestedAt: "2026-11-02T20:09:00.000Z",
              state: "Refunded",
              byLabel: "You",
            },
            {
              amountMinor: "100",
              reasonCode: "CUSTOMER_REQUEST",
              requestedAt: "2026-11-02T20:12:00.000Z",
              state: "Refunded",
              byLabel: "Mei",
            },
          ],
          refundableMinor: "513",
        },
        parts: [],
      }),
      "900",
    );
    await page.goto("/operations/orders");
    const section = page.locator("section.table-payment").first();
    const mine = section.locator("dt", { hasText: zh ? "已退到卡上" : "Refunded to the card" });
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(mine.first()).toContainText(zh ? /由你经办$/u : /by You$/u);
      await expect(mine.nth(1)).toContainText(zh ? /由 Mei 经办$/u : /by Mei$/u);
      await expect(section).not.toContainText("经办你");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await section.screenshot({ path: `test-results/b58-refund-by-${language}-${width}.png` });
    }
  });

/**
 * b59 (live58, TM2 order 26): ~12 s after a $5.00 card refund the payment section read "Refunded
 * to the card · Guest asked · … −$5.00" and, under it, "$5.00 is going back to the guest's card."
 * although Payment had the refund Succeeded. The sentence said after the write was fixed at "on
 * its way" whatever Payment answered. One refund has one state: the sentence follows the refund's
 * state as read, and a refund still on its way is read again shortly after it was made.
 */
const sentence = (zh: boolean, state: "Sending" | "Refunded") =>
  zh
    ? state === "Sending"
      ? "$5.00 正在退回客人的卡。"
      : "$5.00 已退回客人的卡。"
    : state === "Sending"
      ? "$5.00 is going back to the guest's card."
      : "$5.00 went back to the guest's card.";
const partPaid = {
  ...payment,
  partNumber: 1,
  roundsMinor: "1413",
  tipMinor: "0",
  totalMinor: "1413",
  refundableMinor: "1413",
};
const live = (state: string) => ({
  amountMinor: "500",
  reasonCode: "CUSTOMER_REQUEST",
  requestedAt: "2026-11-24T13:41:00.000Z",
  state,
  byLabel: "You",
});
const afterRefund = (state: string) => ({
  ...partPaid,
  onlineRefunds: [live(state)],
  refundableMinor: "913",
});

async function refundFive(page: Page, zh: boolean) {
  await page
    .getByRole("button", { name: zh ? "退回客人的卡" : "Refund to the card", exact: true })
    .click();
  await page.getByLabel(zh ? "退款金额" : "Amount to refund").fill("5");
  await page.getByRole("combobox").last().selectOption("CUSTOMER_REQUEST");
  await page
    .getByRole("button", { name: zh ? "退 $5.00 到客人的卡" : "Refund $5.00 to the card" })
    .click();
  await page
    .getByRole("button", { name: zh ? "确认退回卡上 $5.00" : "Confirm: refund $5.00 to the card" })
    .click();
}
const zhFirst = async (page: Page, zh: boolean) => {
  if (zh)
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        /* the page falls back to English */
      }
    });
};
const fits = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    test(`@production b59: a card refund Payment already answered says it went back, once (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await zhFirst(page, zh);
      await page.setViewportSize({ width, height });
      let refunded = false;
      await orderPage(
        page,
        () => ({
          orderReference: id(1),
          payment: refunded ? afterRefund("Refunded") : partPaid,
          parts: [],
        }),
        refunded ? "500" : undefined,
      );
      await page.route("**/merchant/orders/table-payment/online-refund", (route) => {
        refunded = true;
        return route.fulfill({
          headers,
          json: {
            status: "Recorded",
            orderReference: id(1),
            payment: afterRefund("Refunded"),
            parts: [],
          },
        });
      });
      await page.goto("/operations/orders");
      await refundFive(page, zh);
      const section = page.locator("section.table-payment").first();
      await expect(
        section.locator("dt").filter({ hasText: zh ? "已退到卡上" : "Refunded to the card" }),
      ).toBeVisible();
      await expect(section.getByRole("status")).toHaveText(sentence(zh, "Refunded"));
      await expect(section).not.toContainText(sentence(zh, "Sending"));
      await page.waitForTimeout(4_000);
      await expect(section).not.toContainText(sentence(zh, "Sending"));
      await fits(page);
      await section.screenshot({ path: `test-results/b59-refund-done-${language}-${width}.png` });
    });

    test(`@production b59: a card refund still on its way says so, then says it went back once Payment answers (${language}, ${width})`, async ({
      page,
    }) => {
      const zh = language === "zh-Hans";
      await zhFirst(page, zh);
      await page.setViewportSize({ width, height });
      let state: "None" | "Sending" | "Refunded" = "None";
      await orderPage(page, () => ({
        orderReference: id(1),
        payment: state === "None" ? partPaid : afterRefund(state),
        parts: [],
      }));
      await page.route("**/merchant/orders/table-payment/online-refund", (route) => {
        state = "Sending";
        return route.fulfill({
          headers,
          json: {
            status: "Recorded",
            orderReference: id(1),
            payment: afterRefund("Sending"),
            parts: [],
          },
        });
      });
      await page.goto("/operations/orders");
      await refundFive(page, zh);
      const section = page.locator("section.table-payment").first();
      await expect(
        section.locator("dt").filter({ hasText: zh ? "正在退回卡上" : "Going back to the card" }),
      ).toBeVisible();
      await expect(section).toContainText(sentence(zh, "Sending"));
      // Payment's outcome arrives after the write: the panel reads it again without a reload.
      state = "Refunded";
      await expect(
        section.locator("dt").filter({ hasText: zh ? "已退到卡上" : "Refunded to the card" }),
      ).toBeVisible({
        timeout: 8_000,
      });
      await expect(section).toContainText(sentence(zh, "Refunded"));
      await expect(section).not.toContainText(sentence(zh, "Sending"));
      await fits(page);
    });
  }

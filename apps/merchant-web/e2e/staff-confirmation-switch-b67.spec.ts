import { expect, test, type Page } from "@playwright/test";

/*
 * Batch 67 (v15 b66 live, TM2 orders 20-22): switching the staff language right after a table
 * round was sent ("20 号单" sent to the kitchen) or a counter order was paid ("21 号单已付款")
 * reloaded the page to an empty order, and the confirmation of what was just sent or paid was gone.
 * The sale and the round were recorded; only the screen lost them. The confirmation now holds
 * through the switch, said in the new language, and nothing is sent or recorded again; a later
 * reload, or starting the next order, starts empty as before. Synthetic Store.
 */
const id = (n: number) => "01909979-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const tableReference = id(40);
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
      name: "Dine-in menu",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(4),
          name: "Noodles",
          sellables: [
            {
              sellableReference: id(5),
              productVersionReference: id(6),
              name: "Shoyu Ramen",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  name: "Noodles",
                  bindingReference: id(7),
                  optionSetVersionReference: id(8),
                  minimumSelections: 1,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(9), id(10)],
                  defaultOptionReferences: [id(9)],
                  options: [
                    {
                      optionReference: id(9),
                      name: "Regular",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: true,
                      incrementalPrice: price("0.00"),
                    },
                    {
                      optionReference: id(10),
                      name: "Extra noodles",
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                      incrementalPrice: price("2.00"),
                    },
                  ],
                },
              ],
              allergenDisclosure: {},
              displayPrice: price("16.00"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(11),
              productVersionReference: id(12),
              name: "Gyoza",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("7.00"),
              taxDisplayContext: {},
            },
            {
              sellableReference: id(13),
              productVersionReference: id(14),
              name: "Matcha Pudding",
              presentationRole: "Standard",
              pinned: false,
              availability: "SoldOut",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("6.00"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
};
const table = {
  tableReference,
  stableLabel: "T4",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: id(41),
  elapsedMinutes: 25,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
};

async function signIn(
  page: Page,
  tableItem: Record<string, unknown> = table,
  {
    counterOrder = true,
    tables = {},
  }: { readonly counterOrder?: boolean; readonly tables?: Record<string, unknown> } = {},
) {
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
          businessDate: "2026-10-15",
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
            // WP-2423 M08: the full-service setting (counter ordering off) does not list it.
            ...(counterOrder
              ? [
                  {
                    screenId: "OPS-ORDER-ENTRY",
                    label: "Counter order",
                    href: "/operations/order-entry",
                    permission: "ordering.order.create_staff",
                  },
                ]
              : []),
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
  // WP-2423 M35: the table's unsent guest lines, read before staff send (none unless a test says).
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [tableItem],
        nextAfterTableReference: null,
        ...tables,
      },
    }),
  );
}

const businessDay = (businessDate: string) => {
  const start = Date.now() - 6 * 3_600_000;
  return {
    businessDate,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 24 * 3_600_000).toISOString(),
    timeZone: "America/Toronto",
    observedAt: new Date().toISOString(),
  };
};

type Language = "en" | "zh-Hans";
const other = (language: Language): Language => (language === "en" ? "zh-Hans" : "en");
const switchTo = { en: "切换到中文", "zh-Hans": "Switch to English" } as const;
const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function start(page: Page, language: Language) {
  // Only the first load starts in this language: the switch's own choice holds after it.
  await page.addInitScript((chosen) => {
    if (window.localStorage.getItem("bop.merchant.language") === null)
      window.localStorage.setItem("bop.merchant.language", chosen);
  }, language);
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({ headers, json: businessDay("2026-10-15") }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
}

async function switchLanguage(page: Page, from: Language) {
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: switchTo[from] }).filter({ visible: true }).first().click(),
  ]);
}

async function fits(page: Page, panel: ReturnType<Page["locator"]>, where: string, width: number) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${where}: no sideways scroll`,
  ).toBe(true);
  const box = await panel.evaluate((n) => {
    const rect = n.getBoundingClientRect();
    const heading = n.querySelector("h2");
    return {
      left: rect.left,
      right: Math.max(...[...n.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right)),
      heading:
        heading === null
          ? null
          : [getComputedStyle(heading).fontSize, getComputedStyle(heading).fontWeight],
    };
  });
  expect(box.left, `${where}: the confirmation starts on screen`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${where}: nothing past the screen`).toBeLessThanOrEqual(width);
  return box.heading;
}

const keptKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) => key.includes("keptThroughLanguageSwitch")),
  );

for (const first of ["en", "zh-Hans"] as const)
  test(`@production b67: a table round just sent keeps its confirmation through a language switch (${first})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await start(page, first);
    await signIn(page, { ...table, paymentTiming: "PayLater" });
    const rounds: unknown[] = [];
    await page.route("**/merchant/dining/staff-rounds", (route) => {
      rounds.push(route.request().postDataJSON());
      return route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(20),
          orderBatchReference: id(21),
          orderNumber: "20",
          orderVersion: 4,
          tableLabel: "T4",
          orderMinor: "791",
          tipMinor: "0",
          totalMinor: "791",
          payBy: null,
          payLater: true,
          recordedAfterOutage: false,
        },
      });
    });
    let language: Language = first;
    await page.goto(`/operations/order-entry?table=${tableReference}`);
    for (const [width, height] of sizes) {
      const where = `${first} ${width}`;
      await page.setViewportSize({ width, height });
      const zh = language === "zh-Hans";
      await page
        .getByRole("button", { name: zh ? /^添加 ?Gyoza$/u : /^Add Gyoza$/u })
        .first()
        .click();
      await page.getByRole("button", { name: zh ? "发送订单" : "Send order" }).click();
      await expect.poll(() => rounds.length).toBe(1);
      const panel = page.locator(".counter-order__charge");
      await expect(panel.getByRole("heading")).toHaveText(
        zh ? "T4 桌这一轮已送厨房" : "Table T4 round sent to the kitchen",
      );
      await switchLanguage(page, language);
      language = other(language);
      const now = language === "zh-Hans";
      // The same confirmation, in the new language: its heading, order number and amount.
      await expect(panel.getByRole("heading"), `${where}: after the switch`).toHaveText(
        now ? "T4 桌这一轮已送厨房" : "Table T4 round sent to the kitchen",
      );
      await expect(panel.locator(".counter-order__order-number")).toHaveText(
        now ? "20 号单" : "Order 20",
      );
      await expect(panel.locator("dd")).toHaveText(["$7.91"]);
      // The round's own dish stays listed with it.
      await expect(
        page
          .getByRole("list", { name: now ? "此订单中的商品" : "Items in this order" })
          .getByRole("listitem"),
      ).toHaveText([/Gyoza/u]);
      expect(await fits(page, panel, where, width), where).toEqual(["20px", "600"]);
      await page.screenshot({
        path: `test-results/b67-round-sent-switch-${width}-${language}.png`,
      });
      expect(rounds, `${where}: nothing sent again`).toHaveLength(1);
      // A reload (not a switch) starts the next order empty, as before.
      await page.reload();
      await expect(page.getByText(now ? "还没有商品" : "No items yet")).toBeVisible();
      await expect(panel).toHaveCount(0);
      expect(await keptKeys(page)).toEqual([]);
      rounds.length = 0;
    }
  });

for (const first of ["en", "zh-Hans"] as const)
  test(`@production b67: a counter order just paid keeps its paid panel through a language switch (${first})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await start(page, first);
    await signIn(page);
    await page.route("**/merchant/orders", (route) =>
      route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
    );
    const sends: unknown[] = [];
    const payments: unknown[] = [];
    await page.route("**/merchant/counter/orders", (route) => {
      sends.push(route.request().postDataJSON());
      return route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(30),
          orderBatchReference: id(31),
          orderNumber: "21",
          orderVersion: 1,
          orderMinor: "791",
          tipMinor: "0",
          totalMinor: "791",
          payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
          recordedAfterOutage: false,
        },
      });
    });
    await page.route("**/merchant/orders/card-machine-payment", (route) => {
      payments.push(route.request().postDataJSON());
      return route.fulfill({
        headers,
        json: {
          status: "Recorded",
          orderReference: id(30),
          orderBatchReference: id(31),
          amountMinor: "791",
          recordingReason: "AtCounter",
          takenAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          acceptance: "Accepted",
        },
      });
    });
    let language: Language = first;
    await page.goto("/operations/order-entry");
    for (const [width, height] of sizes) {
      const where = `${first} ${width}`;
      await page.setViewportSize({ width, height });
      const zh = language === "zh-Hans";
      await page
        .getByRole("button", { name: zh ? /^添加 ?Gyoza$/u : /^Add Gyoza$/u })
        .first()
        .click();
      await page.getByRole("button", { name: zh ? "发送订单" : "Send order" }).click();
      await page
        .getByRole("button", {
          name: zh ? "已用刷卡机付款 · $7.91" : "Paid on card machine · $7.91",
        })
        .click();
      const panel = page.locator(".counter-order__charge");
      await expect(panel.getByRole("heading")).toHaveText(zh ? "21 号单已付款" : "Order 21 paid");
      await switchLanguage(page, language);
      language = other(language);
      const now = language === "zh-Hans";
      await expect(panel.getByRole("heading"), `${where}: after the switch`).toHaveText(
        now ? "21 号单已付款" : "Order 21 paid",
      );
      await expect(panel.locator(".counter-order__due")).toHaveText("$7.91");
      await expect(panel.getByRole("status")).toHaveText(
        now ? "已付款并发送到厨房。" : "Paid and sent to the kitchen.",
      );
      await expect(
        panel.getByRole("button", { name: now ? "新建柜台订单" : "New counter order" }),
      ).toBeVisible();
      // Paid: never offered to be charged again.
      await expect(
        page.getByRole("button", { name: now ? /^已用刷卡机付款/u : /^Paid on card machine/u }),
      ).toHaveCount(0);
      expect(await fits(page, panel, where, width), where).toEqual(["20px", "600"]);
      await page.screenshot({
        path: `test-results/b67-counter-paid-switch-${width}-${language}.png`,
      });
      expect([sends.length, payments.length], `${where}: nothing sent or recorded again`).toEqual([
        1, 1,
      ]);
      // "New counter order" starts the next one; a reload after it stays empty.
      await panel.getByRole("button", { name: now ? "新建柜台订单" : "New counter order" }).click();
      await expect(page.getByText(now ? "还没有商品" : "No items yet")).toBeVisible();
      await page.reload();
      await expect(page.getByText(now ? "还没有商品" : "No items yet")).toBeVisible();
      await expect(panel).toHaveCount(0);
      sends.length = 0;
      payments.length = 0;
    }
  });

// The same panel when a sent, unpaid counter order is recorded from its "Sent, not paid yet" list.
for (const first of ["en", "zh-Hans"] as const)
  test(`@production b67: a waiting counter order recorded from its list keeps "Order N paid" through a language switch (${first})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await start(page, first);
    await signIn(page);
    let payments = 0;
    const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
    const row = (amountDueMinor: string | null) => ({
      orderReference: id(70),
      orderNumber: "57",
      orderType: "Pickup",
      sourceChannel: "Pos",
      submittedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      observedAt: new Date().toISOString(),
      initialBatchReference: id(71),
      counter: {
        recordedAfterOutage: false,
        paidOnCardMachine: null,
        payBy: new Date(Date.now() + 20 * 60_000).toISOString(),
        amountDueMinor,
        canCancelUnpaid: true,
        cancelledBeforePayment: null,
      },
      canRecordCardMachinePayment: true,
      canViewPayments: false,
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
      currentPhase: "Submitted",
      currentVersion: 1,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: true,
    });
    let paid = false;
    await page.route("**/merchant/counter/menu**", (route) =>
      route.fulfill({ headers, json: menu }),
    );
    await page.route("**/merchant/orders", (route) =>
      route.fulfill({
        headers,
        json: { items: paid ? [] : [row(null)], nextAfterOrderReference: null },
      }),
    );
    await page.route("**/merchant/orders/detail?*", (route) =>
      route.fulfill({
        headers,
        json: {
          screenId: "OPS-ORDER-DETAIL",
          pickupContact: null,
          order: row("1413"),
          lines: {
            items: [
              {
                orderItemReference: id(74),
                orderBatchReference: id(71),
                name: "Gyoza",
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
              total: money("1413"),
              tip: money("0"),
            },
          },
        },
      }),
    );
    await page.route("**/merchant/orders/card-machine-payment", (route) => {
      paid = true;
      payments += 1;
      return route.fulfill({
        headers,
        json: {
          status: "Recorded",
          orderReference: id(70),
          orderBatchReference: id(71),
          amountMinor: "1413",
          recordingReason: "AtCounter",
          takenAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          acceptance: "Accepted",
        },
      });
    });
    let language: Language = first;
    for (const [width, height] of sizes) {
      const where = `${first} ${width}`;
      paid = false;
      payments = 0;
      await page.setViewportSize({ width, height });
      await page.goto("/operations/order-entry");
      const zh = language === "zh-Hans";
      const awaiting = page.getByRole("region", {
        name: zh ? "已发送，尚未付款" : "Sent, not paid yet",
      });
      await awaiting.getByRole("button", { name: zh ? /^收款/u : /^Take payment/u }).click();
      await awaiting
        .getByRole("button", {
          name: zh ? "已用刷卡机付款 · $14.13" : "Paid on card machine · $14.13",
        })
        .click();
      const panel = page.locator(".counter-order__awaiting-paid");
      await expect(panel.getByRole("heading")).toHaveText(zh ? "57 号单已付款" : "Order 57 paid");
      await switchLanguage(page, language);
      language = other(language);
      const now = language === "zh-Hans";
      await expect(panel.getByRole("heading"), `${where}: after the switch`).toHaveText(
        now ? "57 号单已付款" : "Order 57 paid",
      );
      await expect(panel.locator("dt")).toHaveText([
        now ? "已用刷卡机付款" : "Paid on card machine",
      ]);
      await expect(panel.locator("dd")).toHaveText(["$14.13"]);
      expect(await fits(page, panel, where, width), where).toEqual(["20px", "600"]);
      await page.screenshot({
        path: `test-results/b67-awaiting-paid-switch-${width}-${language}.png`,
      });
      expect(payments, `${where}: nothing recorded again`).toBe(1);
      // Done puts it away; a reload after that does not bring it back.
      await panel.getByRole("button", { name: now ? "完成" : "Done" }).click();
      await expect(panel).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(now ? "还没有商品" : "No items yet")).toBeVisible();
      await expect(panel).toHaveCount(0);
    }
  });

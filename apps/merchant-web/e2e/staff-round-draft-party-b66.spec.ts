import { expect, test, type Page } from "@playwright/test";

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

// Batch 66 (v15 b65 live, TM2 K65 A): after a language switch, staff closed, cleaned and seated
// the table again within the switch's minute, and the new party's order page showed the last
// party's two dishes with no note; a reload kept them. What the switch keeps was brought back with
// no party check, and it also dropped a brought-back round's "add the kitchen note again"
// reminder. Both ways a round is kept are now checked against the party seated at the table, and
// the reminder holds through the switch. The round's confirmation and the counter's paid panel
// say the order number in its one form ("Order 7", "7 号单"), as Kitchen and Pickup do.
type Language = "en" | "zh-Hans";
const words = {
  en: {
    add: (name: string) => new RegExp(`^Add ${name}$`, "u"),
    noteBox: "Note for the kitchen (optional)",
    addToOrder: "Add to order",
    items: "Items in this order",
    empty: "No items yet",
    send: "Send order",
    change: (name: string) => new RegExp(`^Change ${name}$`, "u"),
    save: "Save change",
    brought:
      "Brought back from this device: this table's order, not sent yet. Check it with the guests, then send it.",
    oneNote: " 1 kitchen note isn't kept on the device; add it again.",
    switchTo: "切换到中文",
    order: (n: string) => `Order ${n}`,
    orderTerm: "Order",
  },
  "zh-Hans": {
    add: (name: string) => new RegExp(`^添加 ?${name}$`, "u"),
    noteBox: "给厨房的备注（可选）",
    addToOrder: "加入订单",
    items: "此订单中的商品",
    empty: "还没有商品",
    send: "发送订单",
    change: (name: string) => new RegExp(`^修改 ?${name}$`, "u"),
    save: "保存更改",
    brought: "已恢复本设备上这桌还没发送的点单。请和客人核对后再发送。",
    oneNote: "有 1 条给厨房的备注不会保存在设备上，请重新添加。",
    switchTo: "Switch to English",
    order: (n: string) => `${n} 号单`,
    orderTerm: "订单",
  },
} as const;
const other = (language: Language): Language => (language === "en" ? "zh-Hans" : "en");
const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function openRound(page: Page, language: Language, tableExtra: Record<string, unknown> = {}) {
  // Only the first load starts in this language: the switch's own choice holds after it.
  await page.addInitScript((chosen) => {
    if (window.localStorage.getItem("bop.merchant.language") === null)
      window.localStorage.setItem("bop.merchant.language", chosen);
  }, language);
  let session: string | null = id(41);
  await signIn(page);
  await page.unroute("**/merchant/dining/tables");
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [
          {
            ...table,
            ...tableExtra,
            currentDiningSessionReference: session,
            // A free table has no time seated.
            elapsedMinutes: session === null ? null : table.elapsedMinutes,
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({ headers, json: businessDay("2026-10-15") }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  const rounds: unknown[] = [];
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    rounds.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        status: "Placed",
        orderReference: id(20),
        orderBatchReference: id(21),
        orderNumber: "7",
        orderVersion: 4,
        tableLabel: "T4",
        orderMinor: "2300",
        tipMinor: "0",
        totalMinor: "2300",
        payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
        recordedAfterOutage: false,
      },
    });
  });
  await page.goto(`/operations/order-entry?table=${tableReference}`);
  return {
    rounds,
    seat: (next: string | null) => {
      session = next;
    },
  };
}

const kept = (page: Page) =>
  page.evaluate(() => ({
    device: Object.keys(window.localStorage).filter((key) => key.includes("staffRoundDraft")),
    switch: Object.keys(window.sessionStorage).filter((key) =>
      key.includes("keptThroughLanguageSwitch.staffOrder"),
    ),
  }));

async function switchLanguage(page: Page, from: Language) {
  await Promise.all([
    page.waitForEvent("load"),
    page
      .getByRole("button", { name: words[from].switchTo })
      .filter({ visible: true })
      .first()
      .click(),
  ]);
}

/** Opened again in this tab without a reload, as from Tables after closing and seating it. */
async function openFromTables(page: Page) {
  await page.evaluate(() => {
    window.history.pushState(null, "", "/operations/dining");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForURL("**/operations/dining");
  await page.evaluate((href) => {
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/operations/order-entry?table=${tableReference}`);
}

async function addTwo(page: Page, language: Language, withNote = false) {
  const w = words[language];
  await page
    .getByRole("button", { name: w.add("Shoyu Ramen") })
    .first()
    .click();
  if (withNote) await page.getByRole("textbox", { name: w.noteBox }).fill("No peanuts");
  await page.getByRole("button", { name: w.addToOrder }).click();
  await page
    .getByRole("button", { name: w.add("Gyoza") })
    .first()
    .click();
  await expect(page.getByRole("list", { name: w.items }).getByRole("listitem")).toHaveCount(2);
}

async function fits(page: Page, where: string, width: number) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${where}: no sideways scroll`,
  ).toBe(true);
  const right = await page
    .locator("main")
    .evaluate((n) =>
      Math.max(...[...n.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right)),
    );
  expect(right, `${where}: nothing past the screen`).toBeLessThanOrEqual(width);
}

for (const start of ["en", "zh-Hans"] as const)
  test(`@production b66: after a language switch, another party's table never gets the last party's round (${start})`, async ({
    page,
  }) => {
    // Four ways back to the table at three widths, each with a language switch and reloads.
    test.setTimeout(120_000);
    const { rounds, seat } = await openRound(page, start);
    let language: Language = start;
    let party = 41;
    for (const [width, height] of sizes)
      for (const how of ["reload", "from Tables", "signed in again", "table free"] as const) {
        const where = `${start} ${width} ${how}`;
        await page.setViewportSize({ width, height });
        let w = words[language];
        await expect(page.getByText(w.empty)).toBeVisible();
        await addTwo(page, language);
        // The switch keeps this party's round, with no "brought back" note (nothing was lost).
        await switchLanguage(page, language);
        language = other(language);
        w = words[language];
        const ticket = page.getByRole("list", { name: w.items });
        await expect(ticket.getByRole("listitem"), where).toHaveCount(2);
        await expect(
          page.getByRole("status").filter({ hasText: w.brought.slice(0, 12) }),
        ).toHaveCount(0);
        // Within the switch's minute the table is closed and seated again (or left free).
        party += 1;
        seat(how === "table free" ? null : id(party));
        if (how === "reload") await page.reload();
        else if (how === "from Tables") await openFromTables(page);
        else await page.goto(`/operations/order-entry?table=${tableReference}`);
        await expect(page.getByText(w.empty), `${where}: the new party starts empty`).toBeVisible();
        await expect(ticket.getByRole("listitem")).toHaveCount(0);
        await expect(
          page.getByRole("status").filter({ hasText: w.brought.slice(0, 12) }),
        ).toHaveCount(0);
        await expect.poll(() => kept(page), where).toEqual({ device: [], switch: [] });
        await fits(page, where, width);
        await page.screenshot({
          path: `test-results/b66-new-party-${how.replace(/ /gu, "-")}-${width}-${language}.png`,
        });
        // And a reload after that still starts empty.
        await page.reload();
        await expect(page.getByText(w.empty), `${where}: still empty after a reload`).toBeVisible();
        if (how === "table free") {
          party += 1;
          seat(id(party));
          await page.reload();
          await expect(page.getByText(w.empty)).toBeVisible();
        }
      }
    expect(rounds, "nothing sent by itself").toHaveLength(0);
  });

for (const start of ["en", "zh-Hans"] as const)
  test(`@production b66: the same party's round and its kitchen-note reminder hold through a language switch (${start})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { rounds } = await openRound(page, start);
    let language: Language = start;
    for (const [width, height] of sizes) {
      const where = `${start} ${width}`;
      await page.setViewportSize({ width, height });
      await addTwo(page, language, true);
      await page.reload();
      let w = words[language];
      let back = page.getByRole("status").filter({ hasText: w.brought.slice(0, 12) });
      await expect(back, where).toHaveText(w.brought + w.oneNote);
      // The switch keeps the round for the same party, and still asks for the lost note.
      await switchLanguage(page, language);
      language = other(language);
      w = words[language];
      back = page.getByRole("status").filter({ hasText: w.brought.slice(0, 12) });
      const ticket = page.getByRole("list", { name: w.items });
      await expect(ticket.getByRole("listitem")).toHaveCount(2);
      await expect(back, `${where}: after the switch`).toHaveText(w.brought + w.oneNote);
      const box = await back.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return {
          right: r.right,
          size: getComputedStyle(n).fontSize,
          weight: getComputedStyle(n).fontWeight,
        };
      });
      expect(box.right, `${where}: the note fits`).toBeLessThanOrEqual(width);
      expect([box.size, box.weight]).toEqual(["14px", "400"]);
      await fits(page, where, width);
      await page.screenshot({
        path: `test-results/b66-note-after-switch-${width}-${language}.png`,
      });
      // Long after the switch (its minute is over), the round on the device still asks for it.
      await page.evaluate(() => window.sessionStorage.clear());
      await page.reload();
      await expect(back, `${where}: after the switch's minute`).toHaveText(w.brought + w.oneNote);
      // The note added again: nothing more to ask for, then or after a reload.
      await page.getByRole("button", { name: w.change("Shoyu Ramen") }).click();
      await page.getByRole("textbox", { name: w.noteBox }).fill("No peanuts");
      await page.getByRole("button", { name: w.save }).click();
      await expect(back).toHaveText(w.brought);
      await page.getByRole("button", { name: w.send }).click();
      await expect.poll(() => rounds.length).toBe(1);
      rounds.length = 0;
      await page.reload();
      await expect(page.getByText(w.empty)).toBeVisible();
    }
  });

for (const language of ["en", "zh-Hans"] as const)
  for (const timing of ["PayLater", "PayAtSend"] as const)
    test(`@production b66: a sent table round names its order in the one form (${timing}, ${language})`, async ({
      page,
    }) => {
      const w = words[language];
      const { rounds } = await openRound(
        page,
        language,
        timing === "PayLater" ? { paymentTiming: "PayLater" } : {},
      );
      for (const [width, height] of sizes) {
        const where = `${language} ${timing} ${width}`;
        await page.setViewportSize({ width, height });
        await addTwo(page, language);
        await page.getByRole("button", { name: w.send }).click();
        await expect.poll(() => rounds.length).toBe(1);
        const panel = page.locator(".counter-order__charge");
        const number = panel.locator(".counter-order__order-number");
        await expect(number, where).toHaveText(w.order("7"));
        // No second "订单 7" / "Order 7" label and value row.
        await expect(
          panel.locator("dt").filter({ hasText: new RegExp(`^${w.orderTerm}$`, "u") }),
        ).toHaveCount(0);
        await expect(panel.locator("dd").filter({ hasText: /^7$/u })).toHaveCount(0);
        const style = await number.evaluate((n) => {
          const r = n.getBoundingClientRect();
          return [getComputedStyle(n).fontSize, getComputedStyle(n).fontWeight, r.right];
        });
        expect(style.slice(0, 2), where).toEqual(["16px", "400"]);
        expect(Number(style[2])).toBeLessThanOrEqual(width);
        await fits(page, where, width);
        await page.screenshot({
          path: `test-results/b66-round-number-${timing}-${width}-${language}.png`,
        });
        rounds.length = 0;
        await page.reload();
        await expect(page.getByText(w.empty)).toBeVisible();
      }
    });

// The counter's "Order N paid" panel, after a sent, unpaid order is recorded: its heading names
// the order ("57 号单已付款"); there is no second "订单 57" label and value row under it.
for (const language of ["en", "zh-Hans"] as const)
  test(`@production b66: the counter's paid panel names its order once (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await page.addInitScript((chosen) => {
      window.localStorage.setItem("bop.merchant.language", chosen);
    }, language);
    await signIn(page);
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
    for (const [width, height] of sizes) {
      const where = `${language} ${width}`;
      paid = false;
      await page.setViewportSize({ width, height });
      await page.goto("/operations/order-entry");
      const awaiting = page.getByRole("region", {
        name: zh ? "已发送，尚未付款" : "Sent, not paid yet",
      });
      await awaiting.getByRole("button", { name: zh ? /^收款/u : /^Take payment/u }).click();
      await awaiting
        .getByRole("button", {
          name: zh ? "已用刷卡机付款 · $14.13" : "Paid on card machine · $14.13",
        })
        .click();
      const heading = zh ? "57 号单已付款" : "Order 57 paid";
      const panel = page.getByRole("region", { name: heading });
      await expect(panel.getByRole("heading", { name: heading }), where).toBeVisible();
      await expect(panel.locator("dt")).toHaveText([
        zh ? "已用刷卡机付款" : "Paid on card machine",
      ]);
      await expect(panel).not.toContainText(zh ? "订单57" : "Order57");
      await expect(panel.locator("dd").filter({ hasText: /^57$/u })).toHaveCount(0);
      await fits(page, where, width);
      await page.screenshot({ path: `test-results/b66-counter-paid-${width}-${language}.png` });
    }
  });

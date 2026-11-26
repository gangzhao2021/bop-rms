import { expect, test, type Page } from "@playwright/test";

// Batch 65 (v15 b64 live, TM2 table R64 A): staff added two dishes to a table's round, the page
// reloaded, and the order came back empty ("No items yet") with no word; signing in again did the
// same. The unsent round is kept on this device for its Store and table and comes back with a
// plain note; it is never sent by itself, a kitchen note (it may name an allergy) is not kept on
// the device, and it is dropped once sent, when the table's party changes or on another
// business day.
const id = (n: number) => "01909978-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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

async function openRound(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      window.localStorage.setItem("bop.merchant.language", "zh-Hans");
    });
  let session: string | null = id(41);
  let day = "2026-10-15";
  await signIn(page);
  await page.unroute("**/merchant/dining/tables");
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [{ ...table, currentDiningSessionReference: session }],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({ headers, json: businessDay(day) }),
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
    newDay: (next: string) => {
      day = next;
    },
  };
}

const words = {
  en: {
    add: (name: string) => new RegExp(`^Add ${name}$`, "u"),
    extra: /Extra noodles/u,
    noteBox: "Note for the kitchen (optional)",
    addToOrder: "Add to order",
    items: "Items in this order",
    back: "Brought back from this device: this table's order, not sent yet. Check it with the guests, then send it. 1 kitchen note isn't kept on the device; add it again.",
    empty: "No items yet",
    send: "Send order",
  },
  "zh-Hans": {
    add: (name: string) => new RegExp(`^添加 ?${name}$`, "u"),
    extra: /Extra noodles/u,
    noteBox: "给厨房的备注（可选）",
    addToOrder: "加入订单",
    items: "此订单中的商品",
    back: "已恢复本设备上这桌还没发送的点单。请和客人核对后再发送。有 1 条给厨房的备注不会保存在设备上，请重新添加。",
    empty: "还没有商品",
    send: "发送订单",
  },
} as const;

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b65: a table's unsent round comes back after a reload, never sent by itself (${language})`, async ({
    page,
  }) => {
    const w = words[language];
    const { rounds, seat, newDay } = await openRound(page, language);
    const ticket = page.getByRole("list", { name: w.items });
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ] as const) {
      const where = `${language} ${width}`;
      await page.setViewportSize({ width, height });
      await page
        .getByRole("button", { name: w.add("Shoyu Ramen") })
        .first()
        .click();
      await page.getByRole("radio", { name: w.extra }).check();
      await page.getByRole("textbox", { name: w.noteBox }).fill("No peanuts");
      await page.getByRole("button", { name: w.addToOrder }).click();
      await page
        .getByRole("button", { name: w.add("Gyoza") })
        .first()
        .click();
      await expect(ticket.getByRole("listitem")).toHaveCount(2);

      // A reload (or signing in again) brings it back, with a plain note, and sends nothing.
      await page.reload();
      const back = page.getByRole("status").filter({ hasText: w.back.slice(0, 12) });
      await expect(back, where).toHaveText(w.back);
      await expect(ticket.getByRole("listitem")).toHaveCount(2);
      await expect(ticket).toContainText("Shoyu Ramen");
      await expect(ticket).toContainText("Extra noodles");
      await expect(ticket).toContainText("Gyoza");
      // The note (it may name an allergy) was never written to the device.
      await expect(ticket).not.toContainText("No peanuts");
      const kept = await page.evaluate(() => JSON.stringify({ ...window.localStorage }));
      expect(kept).not.toContain("No peanuts");
      expect(kept).toContain("staffRoundDraft");
      expect(rounds, `${where}: nothing sent by itself`).toHaveLength(0);
      const box = await back.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return { right: r.right, size: getComputedStyle(n).fontSize };
      });
      expect(box.right, `${where}: the note fits the screen`).toBeLessThanOrEqual(width);
      expect(box.size).toBe("14px");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/b65-round-back-${width}-${language}.png` });

      // Sent: it is not kept any more, and a reload starts empty.
      await page.getByRole("button", { name: w.send }).click();
      await expect.poll(() => rounds.length).toBe(1);
      await expect
        .poll(() => page.evaluate(() => JSON.stringify({ ...window.localStorage })))
        .not.toContain("staffRoundDraft");
      await page.reload();
      await expect(page.getByText(w.empty)).toBeVisible();
      await expect(back).toHaveCount(0);
      rounds.length = 0;
    }

    // The table was closed and seated again: the round was another party's, so it is dropped.
    await page
      .getByRole("button", { name: w.add("Gyoza") })
      .first()
      .click();
    await expect(ticket.getByRole("listitem")).toHaveCount(1);
    seat(id(42));
    await page.reload();
    await expect(page.getByText(w.empty)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: w.back.slice(0, 12) })).toHaveCount(0);

    // Another business day: a round left from the day before is dropped.
    await page
      .getByRole("button", { name: w.add("Gyoza") })
      .first()
      .click();
    await expect(ticket.getByRole("listitem")).toHaveCount(1);
    newDay("2026-10-16");
    await page.reload();
    await expect(page.getByText(w.empty)).toBeVisible();
    expect(rounds).toHaveLength(0);
  });

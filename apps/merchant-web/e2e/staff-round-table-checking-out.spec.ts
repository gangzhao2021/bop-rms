import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 55 (v15 b54 live, guest-bill-closed-by-staff): after a guest paid the whole table on their
 * phone (order 63: "Paid in full. Close the table when the guests have left."), the Tables panel
 * still linked "Take order for <table>", order entry opened and let staff build a round, and Send
 * then got POST /merchant/dining/staff-rounds 409 table_unavailable. A table checking out (its
 * dining session Closing, paid or not) takes no staff round. The panel and order entry now follow
 * that rule: no link, a plain note with what to do next; order entry opened directly says so; and
 * a send refused because checkout began while staff built the round says why in plain words and
 * keeps the round on screen.
 *
 * The replies are the live shapes: the Tables list and the table's own bill (settlement Online,
 * owed 0) as v15 served them for L54 GB3 (TEST), with synthetic names and references.
 */
const id = (n: number) => "01909955-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const tableReference = id(40);
const session = id(41);
const order = id(42);
const shots = process.env.B55_SHOTS ?? "test-results-b55/shots";
const widths = [1440, 1024, 390] as const;
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
              name: "Beef noodles",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("12.50"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
};

interface State {
  phase: "Active" | "Closing";
  version: number;
  paid: boolean;
}

const round = (n: number, paid: boolean) => ({
  roundNumber: n,
  orderBatchReference: id(60 + n),
  items: [
    {
      orderItemReference: id(70 + n),
      quantity: 1,
      displayName: "Beef noodles",
      subtotalMinor: "1250",
      totalMinor: n === 1 ? "1413" : "1412",
      reduction: null,
    },
  ],
  takenOffDishes: [],
  subtotalMinor: "1250",
  taxMinor: n === 1 ? "163" : "162",
  totalMinor: n === 1 ? "1413" : "1412",
  taxRoundingMinor: "0",
  paid,
  orderedBy: n,
  fromTableLabel: null,
  liveOrderedAt: "2026-11-22T19:58:00.000Z",
});
const bill = (state: State) => ({
  diningSessionReference: session,
  sessionPhase: state.phase,
  sessionVersion: state.version,
  paymentTiming: "PayLater",
  tableLabel: "T7",
  orderReference: order,
  rounds: [round(1, state.paid), round(2, state.paid)],
  owed: state.paid
    ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
    : { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
  waitingRounds: [],
  taxRoundingMinor: "0",
  consistent: true,
  tips: { enabled: true, tierPercents: [10, 15, 18] },
  // A guest paid the whole table on their phone, no tip.
  settlement: state.paid
    ? {
        method: "Online",
        roundsMinor: "2825",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "2825",
        tenderedMinor: null,
        changeMinor: null,
        recordedAt: "2026-11-22T20:01:00.000Z",
        recordedAfterOutage: false,
      }
    : null,
  split: null,
  writeOff: null,
  onlinePayment: state.paid
    ? { status: "Captured", totalMinor: "2825", startedAt: "2026-11-22T20:00:30.000Z" }
    : null,
});

async function signIn(page: Page, state: State, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
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
          businessDate: "2026-11-22",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
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
        items: [
          {
            tableReference,
            stableLabel: "T7",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: session,
            elapsedMinutes: 3,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            staffCall: null,
            session: {
              phase: state.phase,
              version: state.version,
              orderReference: order,
              paymentStarted: state.paid,
              mergedTables: [],
            },
            staffRoundsAwaitingPayment: [],
            guestRoundsAwaitingPayment: [],
            roundsAwaitingAcceptance: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({ headers, json: bill(state) }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: order,
        diningSessionReference: session,
        orderVersion: 4,
        observedAt: "2026-11-22T20:02:00.000Z",
        rounds: [],
        closeBlockers: state.paid ? [] : ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: state.paid ? "2825" : "0", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: order,
        tableLabel: "T7",
        diningSessionReference: session,
        sessionPhase: state.phase,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        sessionVersion: state.version,
        tableAssignmentVersion: 1,
        orderVersion: 4,
        phase: "Fulfilled",
        observedAt: "2026-11-22T20:02:00.000Z",
        items: [1, 2].map((n) => ({
          orderItemReference: id(70 + n),
          orderBatchReference: id(60 + n),
          displayName: "Beef noodles",
          batchSequence: n,
          itemOrdinal: 1,
          phase: "Fulfilled",
          orderedQuantity: 1,
          deliveredQuantity: 1,
          remainingQuantity: 0,
          itemServiceVersion: 1,
        })),
      },
    }),
  );
  await page.route("**/merchant/dining/closing", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    state.phase = body.action === "Cancel" ? "Active" : "Closing";
    state.version += 1;
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        status: "Applied",
        phase: state.phase,
        sessionVersion: state.version,
      }),
    });
  });
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
}

const words = {
  en: {
    paid: "Table T7's bill is paid, so no more rounds can be added to it. If the guests want to order more, close the table and press Cleaned, then take their order: it starts a new bill.",
    checkingOut:
      "Table T7 is checking out, so no round can be added to its bill. If the guests want to order more, press Cancel checkout on the table before anyone pays.",
    kept: "Nothing was sent or charged, and this order is still here.",
    heading: "No round can be added for this table now",
    take: "Take order for table T7",
    select: "Select T7",
    panel: "Selected table details",
    paidInFull: "Paid in full.",
    cancel: "Cancel checkout",
    add: /^Add Beef noodles$/u,
    send: "Send order",
    ticket: "Items in this order",
  },
  "zh-Hans": {
    paid: "T7 号桌的账单已付清，不能再加单。客人如还要点，请先关台，再按“已清洁”，然后为他们点单：这会开一张新账单。",
    checkingOut:
      "T7 号桌正在结账，不能再往这张账单加单。客人如还要点，在有人付款前请在这桌按“取消结账”。",
    kept: "没有下单，也没有收款；这张单还在这里。",
    heading: "这桌现在不能加单",
    take: "为桌台 T7 点单",
    select: "选择 T7",
    panel: "所选桌台详情",
    paidInFull: "已全部付清。",
    cancel: "取消结账",
    add: /^添加\s?Beef noodles$/u,
    send: "发送订单",
    ticket: "此订单中的商品",
  },
} as const;

async function openTable(page: Page, language: "en" | "zh-Hans"): Promise<Locator> {
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: words[language].select, exact: true }).click();
  return page.getByRole("complementary", { name: words[language].panel });
}

/** At each width: nothing runs off the screen and the note sits inside the panel with room left. */
async function fitsAtEachWidth(page: Page, note: Locator, name: string) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(note).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const box = await note.boundingBox();
    expect(box).not.toBeNull();
    // Wrapped, never clipped: DejaVu (Linux CI) is wider than the macOS fonts.
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const language of ["en", "zh-Hans"] as const) {
  const said = words[language];

  test(`@production a table a guest paid in full offers no staff round, and says what to do next (${language})`, async ({
    page,
  }) => {
    const state: State = { phase: "Closing", version: 8, paid: true };
    await signIn(page, state, language);
    const rounds: unknown[] = [];
    await page.route("**/merchant/dining/staff-rounds", (route) => {
      rounds.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, headers, json: { error: "table_unavailable" } });
    });
    const panel = await openTable(page, language);
    await expect(panel).toContainText(said.paidInFull);
    await expect(panel.getByRole("link", { name: said.take })).toHaveCount(0);
    const note = panel.getByRole("note").filter({ hasText: said.paid });
    await expect(note).toHaveText(said.paid);
    await fitsAtEachWidth(page, note, `tables-paid-${language}`);
    await expectNoInternalText(page, ["Temporarily unavailable", "暂时不可用"]);

    // Opened directly (a bookmark, or a tab left open), order entry says the same and offers no
    // menu to build a round on.
    await page.goto(`/operations/order-entry?table=${tableReference}`);
    await expect(page.getByRole("heading", { name: said.heading })).toBeVisible();
    const refused = page.getByText(said.paid);
    await expect(refused).toBeVisible();
    await expect(page.getByRole("button", { name: said.send })).toHaveCount(0);
    await fitsAtEachWidth(page, refused, `entry-paid-${language}`);
    await expectNoInternalText(page);
    expect(rounds).toEqual([]);
  });

  test(`@production a table checking out before anyone paid offers no staff round until checkout is cancelled (${language})`, async ({
    page,
  }) => {
    const state: State = { phase: "Closing", version: 7, paid: false };
    await signIn(page, state, language);
    const panel = await openTable(page, language);
    await expect(panel.getByRole("button", { name: said.cancel })).toBeVisible();
    await expect(panel.getByRole("link", { name: said.take })).toHaveCount(0);
    const note = panel.getByRole("note").filter({ hasText: said.checkingOut });
    await expect(note).toBeVisible();
    await fitsAtEachWidth(page, note, `tables-checking-out-${language}`);
    // The guests want more: Cancel checkout, and the round is offered again.
    await panel.getByRole("button", { name: said.cancel }).click();
    await expect(panel.getByRole("link", { name: said.take })).toBeVisible();
    await expect(panel.getByRole("note").filter({ hasText: said.checkingOut })).toHaveCount(0);
  });

  test(`@production a send refused because the guest paid meanwhile says why and keeps the round (${language})`, async ({
    page,
  }) => {
    const state: State = { phase: "Active", version: 6, paid: false };
    await signIn(page, state, language);
    let sends = 0;
    await page.route("**/merchant/dining/staff-rounds", (route) => {
      sends += 1;
      return route.fulfill({ status: 409, headers, json: { error: "table_unavailable" } });
    });
    const panel = await openTable(page, language);
    await panel.getByRole("link", { name: said.take }).click();
    await page.getByRole("button", { name: said.add }).click();
    // Meanwhile staff started checkout and the guest paid the whole table on their phone.
    state.phase = "Closing";
    state.version = 8;
    state.paid = true;
    await page.getByRole("button", { name: said.send }).click();
    const alert = page.getByRole("alert").filter({ hasText: said.kept });
    await expect(alert).toHaveText(`${said.paid} ${said.kept}`);
    expect(sends).toBe(1);
    // The round is still on screen, as built.
    const ticket = page.getByRole("list", { name: said.ticket });
    await expect(ticket).toContainText("Beef noodles");
    await fitsAtEachWidth(page, alert, `entry-refused-${language}`);
    await expectNoInternalText(page);
  });
}

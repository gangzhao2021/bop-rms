import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 59 (v15 batch 58 live, orders-footer-and-refusal-link): at TM2 (156 tables in use) a guest
 * paid table "L58F A (TEST)" in full on their phone while staff built a round for it. Order entry's
 * refusal linked "Open L58F A (TEST) on Tables" / "在桌台页打开 L58F A (TEST)". At 390 the link opened
 * Tables with that table's panel selected, but the page stayed at scrollY 0: the panel was 7880 px
 * (en) / 4737 px (zh) down, under the whole list, and focus stayed on BODY. Pressing the table's
 * own Select button on the same page scrolled straight to it. Arriving from the link now does what
 * Select does at every width: the panel is brought into view, and focus moves to its heading so a
 * keyboard or screen reader user starts there.
 *
 * The replies are the live shapes: a Store with 156 tables in use read in two pages (100 + 56), a
 * seated table every tenth, and the paid table's bill (settlement Online, owed 0) as v15 served it
 * for L58F A (TEST), with synthetic names and references.
 */
const id = (n: number) => "01909959-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "c".repeat(43);
const count = 156;
// Far down the list, as L58F A was among TM2's tables.
const targetNumber = 150;
const tableReference = id(0x1000 + targetNumber);
const session = id(41);
const order = id(42);
const shots = process.env.B59_SHOTS ?? "test-results-b59/shots";
const widths = [390, 1024, 1440] as const;
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const label = (n: number) => (n === targetNumber ? "L58F A (TEST)" : `T${String(n)}`);

interface State {
  phase: "Active" | "Closing";
  version: number;
  paid: boolean;
}

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

const table = (n: number, state: State) => {
  const target = n === targetNumber;
  const seated = target || n % 10 === 0;
  return {
    tableReference: id(0x1000 + n),
    stableLabel: label(n),
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: target ? session : seated ? id(0x2000 + n) : null,
    elapsedMinutes: seated ? 25 : null,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    staffCall: null,
    ...(seated
      ? {
          session: target
            ? {
                phase: state.phase,
                version: state.version,
                orderReference: order,
                paymentStarted: state.paid,
                mergedTables: [],
              }
            : {
                phase: "Active",
                version: 2,
                orderReference: id(0x3000 + n),
                paymentStarted: false,
                mergedTables: [],
              },
        }
      : {}),
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
  };
};

const bill = (state: State) => ({
  diningSessionReference: session,
  sessionPhase: state.phase,
  sessionVersion: state.version,
  paymentTiming: "PayLater",
  tableLabel: label(targetNumber),
  orderReference: order,
  rounds: [
    {
      roundNumber: 1,
      orderBatchReference: id(61),
      items: [
        {
          orderItemReference: id(71),
          quantity: 1,
          displayName: "Beef noodles",
          subtotalMinor: "1250",
          totalMinor: "1413",
          reduction: null,
        },
      ],
      takenOffDishes: [],
      subtotalMinor: "1250",
      taxMinor: "163",
      totalMinor: "1413",
      taxRoundingMinor: "0",
      paid: state.paid,
      orderedBy: 1,
      fromTableLabel: null,
      liveOrderedAt: "2026-11-24T13:20:00.000Z",
    },
  ],
  owed: state.paid
    ? { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" }
    : { subtotalMinor: "1250", taxMinor: "163", totalMinor: "1413" },
  waitingRounds: [],
  taxRoundingMinor: "0",
  consistent: true,
  tips: { enabled: true, tierPercents: [10, 15, 18] },
  settlement: state.paid
    ? {
        method: "Online",
        roundsMinor: "1413",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "1413",
        tenderedMinor: null,
        changeMinor: null,
        recordedAt: "2026-11-24T13:21:00.000Z",
        recordedAfterOutage: false,
      }
    : null,
  split: null,
  writeOff: null,
  onlinePayment: state.paid
    ? { status: "Captured", totalMinor: "1413", startedAt: "2026-11-24T13:20:40.000Z" }
    : null,
});

async function signIn(page: Page, state: State, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Busy Store",
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
          businessDate: "2026-11-24",
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
  // Two pages, as the server answers 156 tables: 100, then the last 56.
  await page.route("**/merchant/dining/tables", (route) => {
    const query = route.request().postDataJSON() as { afterTableReference: string | null };
    const first = query.afterTableReference === null;
    const from = first ? 1 : 101;
    const to = first ? 100 : count;
    return route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        items: Array.from({ length: to - from + 1 }, (_, n) => table(from + n, state)),
        nextAfterTableReference: first ? id(0x1000 + 100) : null,
      },
    });
  });
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
        observedAt: "2026-11-24T13:21:30.000Z",
        rounds: [],
        closeBlockers: state.paid ? [] : ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: state.paid ? "1413" : "0", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: order,
        tableLabel: label(targetNumber),
        diningSessionReference: session,
        sessionPhase: state.phase,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        sessionVersion: state.version,
        tableAssignmentVersion: 1,
        orderVersion: 4,
        phase: "Fulfilled",
        observedAt: "2026-11-24T13:21:30.000Z",
        items: [
          {
            orderItemReference: id(71),
            orderBatchReference: id(61),
            displayName: "Beef noodles",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "Fulfilled",
            orderedQuantity: 1,
            deliveredQuantity: 1,
            remainingQuantity: 0,
            itemServiceVersion: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/table-cart", (route) =>
    route.fulfill({ headers, json: { cart: null } }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  // The table's order, as the panel reads it under the bill (one round, served).
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: {
          orderReference: order,
          orderNumber: "22",
          orderType: "DineIn",
          sourceChannel: "Qr",
          submittedAt: "2026-11-24T13:20:00.000Z",
          observedAt: "2026-11-24T13:21:30.000Z",
          initialBatchReference: id(61),
          batches: [
            {
              orderBatchReference: id(61),
              sequence: 1,
              acceptanceStatus: "Accepted",
              canRequestAcceptance: false,
              canCancel: false,
              staffCancellation: null,
              canCancelItems: false,
              unpaidRemovableItems: [],
              unpaidRemovedItems: [],
              compableItems: [],
              compedItems: [],
            },
          ],
          canRequestAcceptance: false,
          tableBill: null,
          currentPhase: "Fulfilled",
          currentVersion: 4,
          unfulfillable: null,
          pickupNotCollected: false,
          acceptBy: null,
          awaitingPayment: false,
        },
        lines: {
          items: [
            {
              orderItemReference: id(71),
              orderBatchReference: id(61),
              name: "Beef noodles",
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
        },
      },
    }),
  );
  let sends = 0;
  await page.route("**/merchant/dining/staff-rounds", (route) => {
    sends += 1;
    return route.fulfill({ status: 409, headers, json: { error: "table_unavailable" } });
  });
  return { sends: () => sends };
}

const words = {
  en: {
    add: /^Add Beef noodles$/u,
    send: "Send order",
    link: "Open L58F A (TEST) on Tables",
    heading: "L58F A (TEST)",
    panel: "Selected table details",
    paidInFull: "Paid in full.",
    checkingOut: "is checking out",
    back: "Back to Tables",
    select: "Select T1",
  },
  "zh-Hans": {
    add: /^添加\s?Beef noodles$/u,
    send: "发送订单",
    link: "在桌台页打开 L58F A (TEST)",
    heading: "L58F A (TEST)",
    panel: "所选桌台详情",
    paidInFull: "已全部付清。",
    checkingOut: "正在结账",
    back: "返回桌台",
    select: "选择 T1",
  },
} as const;

/** Builds a round for the table, then the guest pays (or checkout starts) before Send. */
async function refusedSend(page: Page, state: State, language: "en" | "zh-Hans", paid: boolean) {
  const said = words[language];
  await page.goto(`/operations/order-entry?table=${tableReference}`);
  await page.getByRole("button", { name: said.add }).click();
  state.phase = "Closing";
  state.version = 8;
  state.paid = paid;
  await page.getByRole("button", { name: said.send }).click();
  const link = page.getByRole("link", { name: said.link, exact: true });
  await expect(link).toBeVisible();
  // A store phone is slower than this machine: at a sixth of the speed, as on v15, the first read
  // of Tables is drawn a frame or more after it is answered.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  return link;
}

/** The panel is on screen with its heading focused, and stays there once its bill has loaded. */
async function landedOnPanel(page: Page, language: "en" | "zh-Hans", name: string) {
  const said = words[language];
  await expect(page).toHaveURL(/\/operations\/dining$/u);
  const panel = page.getByRole("complementary", { name: said.panel });
  const heading = panel.getByRole("heading", { name: said.heading, exact: true, level: 2 });
  // The bill below the heading arrives after the list; the heading stays in view all the same.
  await expect(panel).toContainText(said.paidInFull);
  await expect(panel.locator(".order-lines-state")).toHaveCount(0);
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  const view = await heading.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: window.innerHeight, y: window.scrollY };
  });
  expect(view.top).toBeGreaterThanOrEqual(0);
  // Room left under the heading for the first lines of the panel (DejaVu is taller than macOS).
  expect(view.bottom).toBeLessThanOrEqual(view.height - 40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `${shots}/${name}.png` });
  return { panel, heading, view };
}

for (const language of ["en", "zh-Hans"] as const) {
  const said = words[language];
  for (const width of widths) {
    const height = width === 390 ? 844 : 900;

    test(`@production following the paid-table refusal link by mouse lands on that table's panel far down Tables at ${width} (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const state: State = { phase: "Active", version: 6, paid: false };
      const api = await signIn(page, state, language);
      const link = await refusedSend(page, state, language, true);
      await link.click();
      await landedOnPanel(page, language, `paid-mouse-${language}-${width}`);
      await expectNoInternalText(page, ["Temporarily unavailable", "暂时不可用"]);
      expect(api.sends()).toBe(1);
    });

    test(`@production following the paid-table refusal link by keyboard lands on that table's panel far down Tables at ${width} (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const state: State = { phase: "Active", version: 6, paid: false };
      const api = await signIn(page, state, language);
      const link = await refusedSend(page, state, language, true);
      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      const { heading } = await landedOnPanel(page, language, `paid-keyboard-${language}-${width}`);
      // The next Tab goes on inside the panel, not back to the top of the page.
      await page.keyboard.press("Tab");
      expect(
        await heading.evaluate((element) =>
          element.closest("aside")?.contains(document.activeElement),
        ),
      ).toBe(true);
      expect(api.sends()).toBe(1);
    });
  }

  test(`@production the checking-out refusal link lands on the panel with Cancel checkout at 390 (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state: State = { phase: "Active", version: 6, paid: false };
    const api = await signIn(page, state, language);
    const link = await refusedSend(page, state, language, false);
    await link.click();
    await expect(page).toHaveURL(/\/operations\/dining$/u);
    const panel = page.getByRole("complementary", { name: said.panel });
    const heading = panel.getByRole("heading", { name: said.heading, exact: true, level: 2 });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await expect(panel).toContainText(said.checkingOut);
    await page.screenshot({ path: `${shots}/checking-out-${language}-390.png` });
    expect(api.sends()).toBe(1);
  });

  test(`@production with reduced motion the link jumps to the panel without animating (${language})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    const state: State = { phase: "Active", version: 6, paid: false };
    await signIn(page, state, language);
    const link = await refusedSend(page, state, language, true);
    await link.click();
    const panel = page.getByRole("complementary", { name: said.panel });
    const heading = panel.getByRole("heading", { name: said.heading, exact: true, level: 2 });
    await expect(heading).toBeFocused();
    // In view at once: no smooth scroll still running after the heading took focus.
    expect(await heading.evaluate((element) => element.getBoundingClientRect().top >= 0)).toBe(
      true,
    );
    await expect(heading).toBeInViewport();
  });

  test(`@production Tables opened plainly, after the link, starts at the top with no table chosen (${language})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state: State = { phase: "Active", version: 6, paid: false };
    await signIn(page, state, language);
    const link = await refusedSend(page, state, language, true);
    await link.click();
    const panel = page.getByRole("complementary", { name: said.panel });
    await expect(panel.getByRole("heading", { name: said.heading, exact: true })).toBeFocused();
    // Opened once: a reload finds Tables as staff would open it.
    await page.reload();
    await expect(page.getByRole("button", { name: said.select, exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: said.heading, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Order entry opened directly for the paid table offers "Back to Tables", a plain way back.
    await page.goto(`/operations/order-entry?table=${tableReference}`);
    const back = page.getByRole("link", { name: said.back, exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/operations\/dining$/u);
    await expect(page.getByRole("button", { name: said.select, exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: said.heading, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
}

import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 66 (v15 b65 live, guest-cart-and-payments): on G65 B two phones each added Beef noodles
 * and sent neither; staff pressed Start checkout and a guest pressed "Ask staff to add these" on
 * the Cart. Staff Tables read "Asked for staff · A problem with their order" and the table panel
 * "Guest asked for staff just now · A problem with their order"; the 2 unsent dishes were only in
 * the table's cart under "Manage this table", folded away, so the server had to ask the guest
 * what was missing. Now, while a guest's call is open, the panel lists those dishes right under
 * the call, and once the table takes a round (Cancel checkout) one link opens a staff round with
 * them already in it (staff check and send).
 *
 * The replies are the live shapes (Tables list, the table's bill, its cart) with synthetic names
 * and references.
 */
const id = (n: number) => "01909966-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const tableReference = id(40);
const session = id(41);
const order = id(42);
const shots = process.env.B66_SHOTS ?? "test-results-b66/shots";
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
  /** What the guest's open call asked for; the Cart's "Ask staff to add these" sends OrderProblem. */
  reason?: "OrderProblem" | "TableNeeds" | "ReadyToPay" | "Question";
}

const bill = (state: State) => ({
  diningSessionReference: session,
  sessionPhase: state.phase,
  sessionVersion: state.version,
  paymentTiming: "PayLater",
  tableLabel: "T7",
  orderReference: order,
  rounds: [
    {
      roundNumber: 1,
      orderBatchReference: id(61),
      items: [
        {
          orderItemReference: id(71),
          quantity: 2,
          displayName: "Beef noodles",
          subtotalMinor: "2500",
          totalMinor: "2825",
          reduction: null,
        },
      ],
      takenOffDishes: [],
      subtotalMinor: "2500",
      taxMinor: "325",
      totalMinor: "2825",
      taxRoundingMinor: "0",
      paid: false,
      orderedBy: 1,
      fromTableLabel: null,
      liveOrderedAt: "2026-11-27T06:21:00.000Z",
    },
  ],
  owed: { subtotalMinor: "2500", taxMinor: "325", totalMinor: "2825" },
  waitingRounds: [],
  taxRoundingMinor: "0",
  consistent: true,
  tips: { enabled: true, tierPercents: [10, 15, 18] },
  settlement: null,
  split: null,
  writeOff: null,
  onlinePayment: null,
});

/** Two phones each put 1 × Beef noodles in the table's cart and sent neither. */
const cartLine = (n: number, phoneNumber: number) => ({
  cartItemReference: id(80 + n),
  sellableReference: id(5),
  optionSelections: [],
  names: { en: "Beef noodles", "zh-Hans": "牛肉面" },
  quantity: 1,
  withOptions: false,
  phoneNumber,
  phoneLeft: false,
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
          businessDate: "2026-11-27",
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
            elapsedMinutes: 5,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            staffCall: {
              callReference: id(90),
              reason: state.reason ?? "OrderProblem",
              calledAt: new Date(Date.now() - 20_000).toISOString(),
            },
            session: {
              phase: state.phase,
              version: state.version,
              orderReference: order,
              paymentStarted: false,
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
  await page.route("**/merchant/dining/staff-calls/count", (route) =>
    route.fulfill({ headers, json: { open: 1 } }),
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
        observedAt: "2026-11-27T06:25:00.000Z",
        rounds: [],
        closeBlockers: ["ORDER_BALANCE_UNPAID"],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
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
        observedAt: "2026-11-27T06:25:00.000Z",
        items: [
          {
            orderItemReference: id(71),
            orderBatchReference: id(61),
            displayName: "Beef noodles",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "Fulfilled",
            orderedQuantity: 2,
            deliveredQuantity: 2,
            remainingQuantity: 0,
            itemServiceVersion: 1,
          },
        ],
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
    route.fulfill({
      headers,
      json: {
        cart: {
          cartReference: id(20),
          cartVersion: 3,
          guestPaying: false,
          guestChoosing: null,
          lines: [cartLine(1, 1), cartLine(2, 2)],
        },
      },
    }),
  );
  await page.route("**/merchant/counter/menu**", (route) => route.fulfill({ headers, json: menu }));
}

const words = {
  en: {
    select: "Select T7",
    panel: "Selected table details",
    call: "Guest asked for staff just now · A problem with their order",
    heading: "Not sent to the kitchen",
    lines: ["Beef noodles × 1Phone 1", "Beef noodles × 1Phone 2"],
    checkingOut: "No new rounds while checking out. To add dishes, cancel checkout first.",
    cancel: "Cancel checkout",
    order: "Order these for table T7",
    take: "Take order for table T7",
    guests: "From the guests' phones (not sent yet)",
    otherCalls: [
      ["TableNeeds", "Guest asked for staff just now · Water, cutlery, napkins"],
      ["ReadyToPay", "Guest asked for staff just now · Ready to pay"],
      ["Question", "Guest asked for staff just now · A question"],
    ],
  },
  "zh-Hans": {
    select: "选择 T7",
    panel: "所选桌台详情",
    call: "客人刚刚请店员过去 · 所点的菜有问题",
    heading: "没送到厨房",
    lines: ["牛肉面 × 1手机 1", "牛肉面 × 1手机 2"],
    checkingOut: "结账中不能加菜。要加菜，先取消结账。",
    cancel: "取消结账",
    order: "为桌台 T7 点这些菜",
    take: "为桌台 T7 点单",
    guests: "客人手机上还没送出的菜",
    otherCalls: [
      ["TableNeeds", "客人刚刚请店员过去 · 水、餐具、纸巾"],
      ["ReadyToPay", "客人刚刚请店员过去 · 可以买单"],
      ["Question", "客人刚刚请店员过去 · 有问题想问"],
    ],
  },
} as const;

/**
 * At each width: the list sits right under the call (above checkout), inside the panel
 * and the screen with room for wider Linux fonts, nothing clipped, and the page never scrolls
 * sideways.
 */
async function listedUnderCall(page: Page, panel: Locator, step: Locator, name: string) {
  const call = panel.getByRole("note").first();
  const block = panel.locator(".table-call-dishes");
  const heading = block.getByRole("heading", { level: 3 });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(block).toBeVisible();
    await step.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const [callBox, headingBox, rounds] = await Promise.all([
      call.boundingBox(),
      heading.boundingBox(),
      panel
        .getByRole("button", { name: /^(Start checkout|Cancel checkout|开始结账|取消结账)$/u })
        .first()
        .boundingBox(),
    ]);
    expect(callBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(rounds).not.toBeNull();
    // Right under the call, before checkout: never folded away below the bill.
    expect(headingBox?.y ?? 0).toBeGreaterThan(callBox?.y ?? 0);
    expect(headingBox?.y ?? 0).toBeLessThan(rounds?.y ?? 0);
    expect(
      await heading.evaluate((element) => {
        const css = getComputedStyle(element);
        return [css.fontSize, css.fontWeight];
      }),
    ).toEqual(["16px", "600"]);
    for (const part of [heading, ...(await block.locator("li").all()), step]) {
      const box = await part.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
      // Wrapped, never clipped: DejaVu (Linux CI) is wider than the macOS fonts.
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width - 16);
      expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
    }
    await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const language of ["en", "zh-Hans"] as const) {
  const said = words[language];

  test(`@production a call to add unsent dishes lists them under the call and opens a staff round with them (${language})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state: State = { phase: "Closing", version: 7 };
    await signIn(page, state, language);
    const rounds: unknown[] = [];
    await page.route("**/merchant/dining/staff-rounds", (route) => {
      rounds.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, headers, json: { error: "table_unavailable" } });
    });
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: said.select, exact: true }).click();
    const panel = page.getByRole("complementary", { name: said.panel });
    await expect(panel.getByRole("note").first()).toHaveText(said.call);
    const block = panel.locator(".table-call-dishes");
    await expect(block.getByRole("heading", { name: said.heading })).toBeVisible();
    await expect(block.locator("li")).toHaveText([...said.lines]);
    // Checking out, nobody paid: no round yet, the block says what comes first.
    await expect(block.getByRole("link")).toHaveCount(0);
    const first = block.getByText(said.checkingOut, { exact: true });
    await listedUnderCall(page, panel, first, `call-checking-out-${language}`);
    await expectNoInternalText(page);

    // The guests want them: Cancel checkout, and one link opens a round with the dishes in it.
    await panel.getByRole("button", { name: said.cancel }).click();
    const order = block.getByRole("link", { name: said.order });
    await expect(order).toBeVisible();
    // Said once: the panel's general "Take order" link gives way to the call's own.
    await expect(panel.getByRole("link", { name: said.take })).toHaveCount(0);
    await listedUnderCall(page, panel, order, `call-active-${language}`);
    await order.click();
    await expect(page).toHaveURL(
      new RegExp(`/operations/order-entry\\?table=${tableReference}$`, "u"),
    );
    const guests = page.getByRole("list", { name: said.guests });
    await expect(guests.locator("li")).toHaveCount(2);
    await expect(guests).toContainText("Beef noodles");
    // Staff still check and send: nothing was sent by opening it.
    expect(rounds).toEqual([]);
    await page.screenshot({ path: `${shots}/order-entry-${language}.png`, fullPage: true });
  });

  // Review of batch 66: only the Cart's "Ask staff to add these" call (OrderProblem) is about the
  // unsent dishes. A guest who asks for water, the bill or a question while a dish sits undecided
  // in the shared cart did not ask staff to send it: no list, and the panel's own round link stays.
  for (const [reason, call] of said.otherCalls) {
    test(`@production a ${reason} call does not list the table's unsent dishes as if the guest asked for them (${language})`, async ({
      page,
    }) => {
      const state: State = { phase: "Active", version: 7, reason };
      await signIn(page, state, language);
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: said.select, exact: true }).click();
      const panel = page.getByRole("complementary", { name: said.panel });
      await expect(panel.getByRole("note").first()).toHaveText(call);
      await expect(panel.getByRole("link", { name: said.take })).toBeVisible();
      await expect(panel.locator(".table-call-dishes")).toHaveCount(0);
      await expect(panel.getByRole("link", { name: said.order })).toHaveCount(0);
      await expect(panel.getByText(said.heading, { exact: true })).toHaveCount(0);
    });
  }
}

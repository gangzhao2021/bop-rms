import { expect, test, type Locator, type Page } from "@playwright/test";
import { notPausedServiceControl } from "./service-control-state";

/**
 * DEC-KITCHEN-ONE-TAP: one tap per dish. A new ticket offers Done, the server records Accept, Start
 * and Complete in that one tap, and the tap waits a moment first, so a mistake costs nothing.
 */
const id = (n: number) => "01a0f027-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-26T22:14:00.000Z";
const dish = (n: number, name: string, change: Record<string, unknown> = {}) => ({
  workItemReference: id(n),
  ticketReference: id(50),
  orderReference: id(51),
  orderItemReference: id(n + 20),
  stationReference: id(52),
  localizedDisplayNames: { "en-CA": name },
  allergens: { status: "Unavailable" },
  orderLabel: { orderNumber: "5", orderType: "Pickup", tableLabel: null },
  customerNote: null,
  selectedOptions: [],
  status: "Queued",
  requiredQuantity: 1,
  completedQuantity: 0,
  workItemCreatedAt: "2026-10-26T22:12:00.000Z",
  acceptedAt: null,
  orderItemReadyAt: null,
  ticketAggregateVersion: "7",
  workItemVersion: "2",
  ...change,
});

interface StepBody {
  readonly step: "Start" | "Finish";
  readonly lines: readonly {
    readonly workItemReference: string;
    readonly orderItemReference: string;
    readonly ticketReference: string;
    readonly optionReferences: readonly string[] | null;
  }[];
}

async function mockBoard(
  page: Page,
  source: readonly ReturnType<typeof dish>[] | (() => readonly ReturnType<typeof dish>[]),
  extra: Record<string, unknown> = {},
) {
  let items = typeof source === "function" ? source() : source;
  await page.clock.setFixedTime(new Date(at));
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
          businessDate: "2026-10-26",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/kitchen/query", (route) => {
    if (typeof source === "function") items = source();
    return route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        // Synthetic interaction state only (named operator), as in the kitchen queue spec.
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        ...extra,
        items,
        nextCursor: null,
      },
    });
  });
  const taps: StepBody[] = [];
  await page.route("**/merchant/kitchen/step", (route) => {
    const body = route.request().postDataJSON() as StepBody;
    taps.push(body);
    return route.fulfill({
      headers,
      json: {
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
        occurredAt: at,
        lines: body.lines.map((line) => {
          const current = items.find((entry) => entry.workItemReference === line.workItemReference);
          return {
            workItemReference: line.workItemReference,
            orderItemReference: line.orderItemReference,
            ticketReference: line.ticketReference,
            outcome: body.step === "Finish" ? "Finished" : "Started",
            refusedReason: null,
            ticketVersion: "9",
            workItemVersion: body.step === "Finish" ? "5" : "4",
            workItemStatus: body.step === "Finish" ? "Completed" : "In Progress",
            completedQuantity: body.step === "Finish" ? current?.requiredQuantity : 0,
            requiredQuantity: current?.requiredQuantity,
            acceptedAt: at,
            readyAt: body.step === "Finish" ? at : null,
            dishesDone: null,
          };
        }),
      },
    });
  });
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({
      headers,
      json: { storeReference: scope.storeReference, observedAt: at, items: [], canRework: true },
    }),
  );
  return { taps, items, setItems: (next: readonly ReturnType<typeof dish>[]) => (items = next) };
}
/**
 * Where a ticket sits on the page (not in the window). A click scrolls a button that is not wholly
 * in view into it; that scroll moves the window, not the ticket under the cook's finger (CI
 * 9094ba5d: on the Linux runner the Finished button ended below a 844 px phone, the click scrolled
 * 20 px and a window position read as a 20 px move).
 */
const pageYOf = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().y + window.scrollY);
const holdMs = 5_000;
/** kitchenSlotSettleMs: a ticket ignores taps this long after it moved. */
const slotSettleMs = 600;
/** SLOW_WAIT_MS: a tap the server has not answered by then is said to be still working. */
const slowWaitMs = 3_000;
const slowWaitText = "Still working; the system is busy.";

test("@production a new ticket offers Finished and a quiet Start, with Accept nowhere", async ({
  page,
}) => {
  const { taps } = await mockBoard(page, [dish(1, "TEST latte")]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await expect(ticket.locator(".kitchen-ticket__state")).toHaveText("To make");
  await expect(ticket.locator(".kitchen-ticket__next")).toHaveText("Finished");
  // Start stays quiet, in the ticket's top row, far from the button a cook reaches for.
  await expect(ticket.locator(".kitchen-ticket__top button")).toHaveText("Start cooking");
  await expect(page.getByText(/accept/iu)).toHaveCount(0);
  expect(taps).toEqual([]);
});

test("@production one tap takes a new ticket straight to done", async ({ page }) => {
  const { taps } = await mockBoard(page, [dish(1, "TEST latte")]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await ticket.locator(".kitchen-ticket__next").click();
  // Held first: said in the ticket's own top row, and nothing has gone to the server.
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect(ticket.locator(".kitchen-work-item")).toHaveAttribute("data-pending", "Holding");
  expect(taps).toEqual([]);
  await expect(ticket).toHaveCount(0, { timeout: holdMs + 5_000 });
  expect(taps).toHaveLength(1);
  expect(taps[0]?.step).toBe("Finish");
  expect(taps[0]?.lines).toEqual([
    expect.objectContaining({
      workItemReference: id(1),
      orderItemReference: id(21),
      ticketReference: id(50),
      optionReferences: null,
    }),
  ]);
  expect(JSON.stringify(taps[0])).not.toMatch(/expected/iu);
  await expect(page.locator(".kitchen-status-row__line")).toContainText("TEST latte done.");
});

test("@production undo within the hold sends nothing", async ({ page }) => {
  const { taps } = await mockBoard(page, [dish(1, "TEST latte"), dish(2, "TEST mocha")]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await ticket.getByRole("button", { name: "Mark TEST latte finished" }).click();
  const top = ticket.locator(".kitchen-ticket__top");
  await expect(top).toContainText("Marked done");
  await top.getByRole("button", { name: "Undo" }).click();
  await expect(top.getByRole("button", { name: "Start all" })).toBeVisible();
  await page.waitForTimeout(holdMs + 500);
  expect(taps).toEqual([]);
  await expect(ticket.getByRole("button", { name: "Mark TEST latte finished" })).toBeEnabled();
});

test("@production a double tap on the main button finishes one order only", async ({ page }) => {
  const other = dish(2, "TEST mocha", {
    ticketReference: id(60),
    orderReference: id(61),
    orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: "2026-10-26T22:13:00.000Z",
  });
  const { taps } = await mockBoard(page, [dish(1, "TEST latte"), other]);
  await page.goto("/operations/kitchen");
  const first = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await first.locator(".kitchen-ticket__next").dblclick();
  await expect(first.locator(".kitchen-work-item")).toHaveAttribute("data-pending", "Holding");
  await page.waitForTimeout(holdMs + 1_000);
  expect(taps).toHaveLength(1);
  expect(taps[0]?.lines.map((line) => line.workItemReference)).toEqual([id(1)]);
  const second = page.locator(".kitchen-ticket").filter({ hasText: "TEST mocha" });
  await expect(second.locator(".kitchen-work-item")).not.toHaveAttribute("data-pending", /./u);
});

test("@production a table's card reads clearly while a tap is held, at every width", async ({
  page,
}) => {
  const table = { orderNumber: "7", orderType: "DineIn", tableLabel: "T5" };
  await mockBoard(page, [
    dish(1, "担担面", { orderLabel: table }),
    dish(2, "水煮鱼", { orderLabel: table }),
    dish(3, "炒青菜", {
      orderLabel: table,
      ticketReference: id(70),
      workItemCreatedAt: "2026-10-26T22:13:30.000Z",
    }),
    dish(4, "奶茶", {
      ticketReference: id(60),
      orderReference: id(61),
      orderLabel: { orderNumber: "8", orderType: "Pickup", tableLabel: null },
      workItemCreatedAt: "2026-10-26T22:13:00.000Z",
    }),
  ]);
  await page.goto("/operations/kitchen");
  const card = page.locator(".kitchen-ticket").filter({ hasText: "担担面" });
  await card.getByRole("button", { name: "Mark 担担面 finished" }).click();
  await expect(card.locator(".kitchen-ticket__top")).toContainText("Marked done");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test-results/kitchen-held-${width}.png`, fullPage: true });
  }
});

test("@production the next ticket does not move during the hold", async ({ page }) => {
  const other = dish(2, "TEST mocha", {
    ticketReference: id(60),
    orderReference: id(61),
    orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: "2026-10-26T22:13:00.000Z",
  });
  await mockBoard(page, [dish(1, "TEST latte"), other]);
  await page.goto("/operations/kitchen");
  const first = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  const second = page.locator(".kitchen-ticket").filter({ hasText: "TEST mocha" });
  const before = await second.boundingBox();
  const foot = await first.locator(".kitchen-ticket__next").boundingBox();
  await first.locator(".kitchen-ticket__next").click();
  await expect(first.locator(".kitchen-ticket__top")).toContainText("Marked done");
  expect(await second.boundingBox()).toEqual(before);
  // The tapped slot keeps its place too: the button stays under the finger, disabled.
  expect(await first.locator(".kitchen-ticket__next").boundingBox()).toEqual(foot);
  await expect(first.locator(".kitchen-ticket__next")).toBeDisabled();
});

for (const width of [1024, 390] as const)
  test(`@production a ticket that moved when a line above it left ignores a tap for a moment and says so, at ${width} wide`, async ({
    page,
  }) => {
    // Three dishes on the first ticket and five more tickets: the second row sits under the first.
    const table = { orderNumber: "7", orderType: "DineIn", tableLabel: "T5" };
    const others = [11, 12, 13, 14, 15].map((n, index) =>
      dish(n, "TEST order " + n, {
        ticketReference: id(100 + n),
        orderReference: id(200 + n),
        orderLabel: { orderNumber: String(n), orderType: "Pickup", tableLabel: null },
        workItemCreatedAt: `2026-10-26T22:13:${String(10 + index).padStart(2, "0")}.000Z`,
      }),
    );
    await page.setViewportSize({ width, height: 900 });
    const { taps } = await mockBoard(page, [
      ...[1, 2, 3].map((n) => dish(n, "TEST dish " + n, { orderLabel: table })),
      ...others,
    ]);
    await page.goto("/operations/kitchen");
    const first = page.locator(".kitchen-ticket").filter({ hasText: "TEST dish 1" });
    const below = page.locator(".kitchen-ticket").filter({ hasText: "TEST order 13" });
    // Where the card sits on the page, and its size (a phone scrolls for each tap).
    const place = () =>
      below.evaluate((card) => {
        const box = card.getBoundingClientRect();
        return [box.top + window.scrollY, box.height] as const;
      });
    // Where it is on the screen, under the finger.
    const onScreen = () => below.evaluate((card) => Math.round(card.getBoundingClientRect().top));
    const [before] = await place();
    await first.getByRole("button", { name: "Mark TEST dish 1 finished" }).click();
    const screenBefore = await onScreen();
    // When the hold ends the dish leaves and the row below moves up on the board.
    await expect
      .poll(async () => (await place())[0], { timeout: holdMs + 8_000, intervals: [20] })
      .toBeLessThan(before);
    const moved = await place();
    // WP-2423 batch 32: a board the click scrolled is kept in view by the browser (scroll
    // anchoring), and a ticket that stayed under the finger takes its tap at once.
    if ((await onScreen()) === screenBefore) {
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await below.locator(".kitchen-ticket__next").click();
      await expect(below.locator(".kitchen-work-item").first()).toHaveAttribute(
        "data-pending",
        "Holding",
      );
      await expect(below.locator(".kitchen-ticket__top")).not.toContainText("Moved. Tap again.");
      return;
    }
    await below.locator(".kitchen-ticket__next").click();
    await expect(below.locator(".kitchen-work-item")).not.toHaveAttribute("data-pending", /./u);
    // The ignored tap is said on the card, so the cook knows to tap again.
    await expect(below.locator(".kitchen-ticket__top")).toContainText("Moved. Tap again.");
    // Said in the card's own top row: the card keeps its place and size.
    expect(await place()).toEqual(moved);
    await page.screenshot({ path: `test-results/kitchen-moved-tap-again-${width}.png` });
    // A moment later the same tap is taken.
    await page.waitForTimeout(700);
    await below.locator(".kitchen-ticket__next").click();
    await expect(below.locator(".kitchen-work-item")).toHaveAttribute("data-pending", "Holding");
    expect(taps.map((tap) => tap.lines.map((line) => line.workItemReference))).toEqual([[id(1)]]);
  });

test("@production a tap that could not be recorded keeps the ticket's name whole, at every width", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(at) });
  const table = { orderNumber: "15", orderType: "DineIn", tableLabel: "Patio 12" };
  await mockBoard(page, [dish(1, "TEST fish", { orderLabel: table })]);
  await page.route("**/merchant/kitchen/step", (route) => route.abort("failed"));
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket");
  await ticket.locator(".kitchen-ticket__next").click();
  // The hold, then the same body again at 3, 8 and 20 seconds; then the cook decides. Each failed
  // answer arrives in real time, so wait for it before moving the clock on.
  const line = ticket.locator(".kitchen-work-item").first();
  await page.clock.runFor(5_100);
  for (const wait of [3_100, 8_100, 20_100]) {
    await expect(line).toHaveAttribute("data-pending", "Retrying");
    await page.clock.runFor(wait);
  }
  await expect(line).toHaveAttribute("data-pending", "Failed");
  const top = ticket.locator(".kitchen-ticket__top");
  await expect(top).toContainText("Not recorded yet");
  await expect(top.getByRole("button", { name: "Try again" })).toBeVisible();
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const number = await ticket.locator(".kitchen-ticket__number").boundingBox();
    const card = await ticket.boundingBox();
    // The name reads on one line and is never squeezed into a column by the buttons.
    expect(number?.height ?? 99).toBeLessThan(40);
    expect(number?.width ?? 0).toBeGreaterThan(100);
    for (const button of await top.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
        (card?.x ?? 0) + (card?.width ?? 0) + 1,
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/kitchen-not-recorded-${width}.png` });
  }
  // Never mind gives the ticket back to the cook.
  await top.getByRole("button", { name: "Never mind" }).click();
  await expect(ticket.locator(".kitchen-ticket__next")).toBeEnabled();
});

test("@production a five-dish table takes five taps and the first dish needs no Start", async ({
  page,
}) => {
  const table = { orderNumber: "7", orderType: "DineIn", tableLabel: "T5" };
  const dishes = [1, 2, 3, 4, 5].map((n) => dish(n, "TEST dish " + n, { orderLabel: table }));
  const { taps } = await mockBoard(page, dishes);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket");
  for (const n of [1, 2, 3, 4, 5])
    await ticket.getByRole("button", { name: "Mark TEST dish " + n + " finished" }).click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect(page.locator(".kitchen-ticket")).toHaveCount(0, { timeout: holdMs + 8_000 });
  expect(taps.map((tap) => tap.step)).toEqual(["Finish", "Finish", "Finish", "Finish", "Finish"]);
  expect(
    taps
      .flatMap((tap) => tap.lines)
      .map((line) => line.workItemReference)
      .sort(),
  ).toEqual(dishes.map((entry) => entry.workItemReference).sort());
});

test("@production a round that arrives after the cook read the card is left out of the main button", async ({
  page,
}) => {
  const table = { orderNumber: "7", orderType: "DineIn", tableLabel: "T5" };
  const first = [1, 2].map((n) => dish(n, "TEST dish " + n, { orderLabel: table }));
  const later = dish(3, "TEST dish 3", {
    orderLabel: table,
    ticketReference: id(70),
    workItemCreatedAt: "2026-10-26T22:13:30.000Z",
  });
  const { taps } = await mockBoard(page, [...first, later]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket");
  await expect(ticket.locator(".kitchen-ticket__round")).toContainText("Added");
  const foot = ticket.locator(".kitchen-ticket__next");
  await expect(foot).toHaveText("Round finished");
  await foot.click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await page.waitForTimeout(holdMs + 500);
  expect(taps.flatMap((tap) => tap.lines).map((line) => line.workItemReference)).toEqual([
    id(1),
    id(2),
  ]);
  expect(taps[0]?.lines.every((line) => line.ticketReference === id(50))).toBe(true);
});

// Owner 2026-11-03: identical dishes read as one line; its step applies to each of them.
test("@production a merged line's own step records each of its dishes in one tap", async ({
  page,
}) => {
  const { taps } = await mockBoard(page, [
    dish(1, "TEST noodles"),
    dish(2, "TEST noodles"),
    dish(3, "TEST rice"),
  ]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST noodles" });
  await expect(ticket.locator(".kitchen-work-item h3")).toHaveText([
    "2×TEST noodles",
    "1×TEST rice",
  ]);
  await ticket.getByRole("button", { name: "Mark TEST noodles finished" }).click();
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
  expect(taps[0]?.step).toBe("Finish");
  expect(taps[0]?.lines.map((line) => line.workItemReference)).toEqual([id(1), id(2)]);
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const)
  test(`@production nothing above the tickets moves them at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const finished = dish(9, "TEST done", {
      ticketReference: id(80),
      orderReference: id(81),
      orderLabel: { orderNumber: "2", orderType: "Pickup", tableLabel: null },
      status: "Completed",
      completedQuantity: 1,
      acceptedAt: at,
      orderItemReadyAt: at,
      workItemCreatedAt: "2026-10-26T22:00:00.000Z",
    });
    let queryItems: readonly ReturnType<typeof dish>[] = [dish(1, "TEST latte"), finished];
    await mockBoard(page, () => queryItems);
    await page.route("**/merchant/kitchen/step", (route) =>
      route.fulfill({
        headers,
        json: {
          projectionName: "kitchen_work_queue_v1",
          projectionPending: true,
          occurredAt: at,
          lines: (route.request().postDataJSON() as StepBody).lines.map((line) => ({
            workItemReference: line.workItemReference,
            orderItemReference: line.orderItemReference,
            ticketReference: line.ticketReference,
            outcome: "Refused",
            refusedReason: "Cancelled",
            ticketVersion: null,
            workItemVersion: null,
            workItemStatus: null,
            completedQuantity: null,
            requiredQuantity: null,
            acceptedAt: null,
            readyAt: null,
            dishesDone: null,
          })),
        },
      }),
    );
    await page.route("**/merchant/kitchen/rework/command", (route) =>
      route.fulfill({ headers, status: 422, json: { error: "KITCHEN_REWORK_WINDOW_CLOSED" } }),
    );
    await page.goto("/operations/kitchen");
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
    await expect(ticket).toBeVisible();
    // The remakes are read beside the board, and Recently finished joins the bar when they answer.
    // On a phone with wider type (the Linux runner's) that bar takes a second row and the tickets
    // move down once as the board opens; the moved ticket then ignores a tap for a moment, by
    // design. What this test watches starts once the board has opened and settled.
    await expect(page.getByText("Recently finished · 1")).toBeVisible();
    await page.waitForTimeout(slotSettleMs);
    // The sound reminder leaves at the first tap anywhere: no ticket moves when it does.
    const yOf = async () => (await ticket.boundingBox())?.y;
    const start = await yOf();
    // A remake notice.
    await page.getByText("Recently finished · 1").click();
    await page.getByRole("button", { name: /^Remake TEST done/u }).click();
    const dialog = page.getByRole("dialog", { name: "Remake TEST done" });
    await dialog.getByLabel("Dropped").check();
    await dialog.getByRole("button", { name: "Send remake" }).click();
    await expect(page.locator(".kitchen-status-row__line")).toContainText("Remake not recorded");
    expect(await yOf()).toBe(start);
    // The remake's lane and notice stay out of the way of what comes next.
    await page.locator("details.kitchen-recent-finished > summary").click();
    // An arrival.
    queryItems = [
      dish(1, "TEST latte"),
      finished,
      dish(2, "TEST mocha", {
        ticketReference: id(60),
        orderReference: id(61),
        orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
        workItemCreatedAt: "2026-10-26T22:13:00.000Z",
      }),
    ];
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".kitchen-status-row__line")).toContainText("New order");
    expect(await yOf()).toBe(start);
    // A refusal.
    await ticket.locator(".kitchen-ticket__next").click();
    await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
    // The hold is the cook's moment to undo, not a wait on the system: nothing says the system is
    // busy, and nothing moves the tickets while it runs.
    await page.waitForTimeout(slowWaitMs + 500);
    expect(await yOf()).toBe(start);
    expect(await page.getByText(slowWaitText).count()).toBe(0);
    // The refusal is said when the server answers, after the tap's hold; a slow runner can take
    // longer than the hold to get there, and the line must then show it over the arrival.
    await expect(page.locator(".kitchen-status-row__line")).toContainText("was cancelled", {
      timeout: holdMs + 20_000,
    });
    expect(await yOf()).toBe(start);
    // Nothing scrolls sideways at this width.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/kitchen-one-tap-${width}.png`, fullPage: true });
  });

test("@production a slow answer to a tap is said in the status row and moves no ticket, at 390 wide", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1400 });
  await mockBoard(page, [
    dish(1, "TEST latte"),
    dish(2, "TEST mocha", {
      ticketReference: id(60),
      orderReference: id(61),
      orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
    }),
  ]);
  // Registered last, so it answers first: the server takes a while before it answers.
  await page.route("**/merchant/kitchen/step", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, slowWaitMs + 2_000));
    await route.fallback();
  });
  await page.goto("/operations/kitchen");
  const latte = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  const mocha = page.locator(".kitchen-ticket").filter({ hasText: "TEST mocha" });
  await expect(mocha).toBeVisible();
  await page.waitForTimeout(slotSettleMs);
  const start = (await mocha.boundingBox())?.y;
  await latte.locator(".kitchen-ticket__next").click();
  // Past the hold and the slow-wait time: the board says it is still working, in its one line.
  await expect(page.locator(".kitchen-status-row__line")).toContainText(slowWaitText, {
    timeout: holdMs + slowWaitMs + 1_500,
  });
  expect((await mocha.boundingBox())?.y).toBe(start);
  // The other ticket takes its tap at once: nothing above it moved.
  await mocha.locator(".kitchen-ticket__next").click();
  await expect(mocha.locator(".kitchen-ticket__top")).toContainText("Marked done");
  // The answer came: the line goes.
  await expect(page.locator(".kitchen-status-row__line")).not.toContainText(slowWaitText, {
    timeout: 4_000,
  });
});

test("@production the kitchen's own targets are large enough for wet fingers", async ({ page }) => {
  await mockBoard(page, [dish(1, "TEST latte"), dish(2, "TEST mocha")]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  for (const target of [
    ticket.locator(".kitchen-ticket__next"),
    ticket.locator(".kitchen-ticket__top button"),
    ticket.getByRole("button", { name: "Mark TEST latte finished" }),
  ]) {
    const box = await target.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }
});

test("@production a board read that fails during the hold keeps the Done on its ticket to send again", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(at) });
  const table = { orderNumber: "5", orderType: "DineIn", tableLabel: "12" };
  const { taps } = await mockBoard(page, [dish(1, "TEST fish", { orderLabel: table })]);
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket");
  let failing = false;
  // Registered last, so it answers first: a busy server for as long as failing is set.
  await page.route("**/merchant/kitchen/query", (route) =>
    failing ? route.fulfill({ status: 503, headers, json: {} }) : route.fallback(),
  );
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  failing = true;
  await page.getByRole("button", { name: "Refresh" }).first().click();
  // The failed read arrives in real time: the board says so before the hold runs out.
  await expect(page.getByText(/Read-only until reconnected/u)).toBeVisible();
  await page.clock.runFor(holdMs + 500);
  // Nothing was sent, and the cook's Done is still on the ticket, named, instead of gone.
  const top = ticket.locator(".kitchen-ticket__top");
  await expect(top).toContainText("Not recorded yet");
  await expect(top.getByRole("button", { name: "Try again" })).toBeDisabled();
  // The board's own state leads the status row; the dish and its table are named under it.
  await page.getByRole("button", { name: "Details" }).click();
  await expect(
    page
      .locator(".kitchen-status-row__detail")
      .getByText("Order 5 (table 12) · TEST fish is not recorded yet.", { exact: false }),
  ).toBeVisible();
  expect(taps).toEqual([]);
  // The next read is fresh: Try again sends that same Done.
  failing = false;
  await page.clock.runFor(60_000);
  await expect(top.getByRole("button", { name: "Try again" })).toBeEnabled();
  await top.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => taps.length).toBe(1);
  expect(taps[0]?.step).toBe("Finish");
  expect(taps[0]?.lines.map((line) => line.workItemReference)).toEqual([id(1)]);
});

for (const [width, height] of [
  [1440, 900],
  [390, 1400],
] as const)
  test(`@production a refusal stays on the status line while a later tap is slow, at ${width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await mockBoard(page, [
      dish(1, "TEST latte"),
      dish(2, "TEST mocha", {
        ticketReference: id(60),
        orderReference: id(61),
        orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
      }),
    ]);
    // Registered last, so it answers first: the latte was cancelled, and the mocha's answer is slow.
    await page.route("**/merchant/kitchen/step", async (route) => {
      const body = route.request().postDataJSON() as StepBody;
      if (body.lines.some((line) => line.workItemReference === id(1)))
        return route.fulfill({
          headers,
          json: {
            projectionName: "kitchen_work_queue_v1",
            projectionPending: true,
            occurredAt: at,
            lines: body.lines.map((line) => ({
              workItemReference: line.workItemReference,
              orderItemReference: line.orderItemReference,
              ticketReference: line.ticketReference,
              outcome: "Refused",
              refusedReason: "Cancelled",
              ticketVersion: null,
              workItemVersion: null,
              workItemStatus: null,
              completedQuantity: null,
              requiredQuantity: null,
              acceptedAt: null,
              readyAt: null,
              dishesDone: null,
            })),
          },
        });
      await new Promise((resolve) => setTimeout(resolve, slowWaitMs + 6_000));
      return route.fallback();
    });
    await page.goto("/operations/kitchen");
    const latte = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
    const mocha = page.locator(".kitchen-ticket").filter({ hasText: "TEST mocha" });
    await expect(mocha).toBeVisible();
    await page.waitForTimeout(slotSettleMs);
    const line = page.locator(".kitchen-status-row__line");
    await latte.locator(".kitchen-ticket__next").click();
    await expect(latte.locator(".kitchen-ticket__top")).toContainText("Marked done");
    await expect(line).toContainText("was cancelled", { timeout: holdMs + 8_000 });
    await page.waitForTimeout(slotSettleMs + 100);
    await mocha.locator(".kitchen-ticket__next").click();
    await expect(mocha.locator(".kitchen-ticket__top")).toContainText("Marked done");
    // The mocha's hold ends and its answer is slow: the board says so, but under the refusal.
    await expect(mocha.locator(".kitchen-ticket__top")).toContainText("Recording", {
      timeout: holdMs + 3_000,
    });
    await page.waitForTimeout(slowWaitMs + 700);
    await expect(line).toContainText("was cancelled");
    await expect(line).not.toContainText(slowWaitText);
    await page.locator(".kitchen-status-row__more").click();
    await expect(page.locator(".kitchen-status-row__detail")).toContainText(slowWaitText);
  });

for (const when of ["soon", "late"] as const)
  test(`@production on a phone with wide type, Recently finished answering ${when} moves no ticket and the next tap is taken`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const finished = dish(9, "TEST done", {
      ticketReference: id(80),
      orderReference: id(81),
      orderLabel: { orderNumber: "2", orderType: "Pickup", tableLabel: null },
      status: "Completed",
      completedQuantity: 1,
      acceptedAt: at,
      orderItemReadyAt: at,
      workItemCreatedAt: "2026-10-26T22:00:00.000Z",
    });
    const { taps } = await mockBoard(page, [dish(1, "TEST latte"), finished]);
    // The remakes answer after the board: soon (the board waits for them), or late (past that
    // wait, so the board opens first and keeps Recently finished's place).
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    await page.route("**/merchant/kitchen/rework/query", async (route) => {
      if (when === "soon") setTimeout(answer, 800);
      await answered;
      await route.fallback();
    });
    await page.goto("/operations/kitchen");
    // Wider type, as the Linux runner's sans: the bar's actions no longer fit one 358 px row.
    await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
    await expect(ticket).toBeVisible();
    const start = await pageYOf(ticket);
    if (when === "late") {
      await page.waitForTimeout(slotSettleMs);
      expect(await pageYOf(ticket)).toBe(start);
      await page.screenshot({ path: "test-results/kitchen-recent-finished-390-before.png" });
      answer();
    }
    await expect(page.getByText("Recently finished · 1")).toBeVisible();
    expect(await pageYOf(ticket)).toBe(start);
    // A tap right after is taken: nothing moved, so nothing is ignored.
    await ticket.locator(".kitchen-ticket__next").click();
    await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
    expect(await pageYOf(ticket)).toBe(start);
    await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/kitchen-recent-finished-390-${when}.png`,
      fullPage: true,
    });
  });

/**
 * WP-2423 batch 31 (v15 live check of b30): Pause ordering sits above the tickets. It answered after
 * the board opened and, on a phone, pushed every ticket 68 px down under the cook's finger, and the
 * tap guard did not notice (the move was the control's, not the board's).
 */
async function slowPause(page: Page, delayMs: number, answer: "Allowed" | "Denied" = "Allowed") {
  await page.route("**/merchant/service-control", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await (answer === "Denied"
      ? route.fulfill({ status: 403, headers, json: { error: "PERMISSION_DENIED" } })
      : route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }));
  });
}
for (const delayMs of [1_500, 3_000] as const)
  test(`@production on a phone with wide type, Pause ordering answering after ${delayMs} ms moves no ticket and the next tap is taken`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { taps } = await mockBoard(page, [dish(1, "TEST latte")]);
    await slowPause(page, delayMs);
    await page.goto("/operations/kitchen");
    await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
    const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
    await expect(ticket).toBeVisible();
    const start = await pageYOf(ticket);
    // Its place is kept while it has not answered: hidden, and out of reach of keyboard and taps.
    if (delayMs === 3_000) {
      const kept = page.locator('.pause-ordering[data-place-kept="true"]');
      await expect(kept).toHaveAttribute("aria-hidden", "true");
      await expect(kept).toBeHidden();
      await expect(kept.locator("button")).toBeDisabled();
    }
    const pause = page.getByRole("button", { name: "Pause ordering" });
    await expect(pause).toBeVisible({ timeout: delayMs + 3_000 });
    expect(await pageYOf(ticket)).toBe(start);
    await ticket.locator(".kitchen-ticket__next").click();
    await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
    await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
    await page.screenshot({ path: `test-results/kitchen-pause-late-${delayMs}-390.png` });
  });

test("@production a ticket moved by something above the board ignores a tap for a moment and says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { taps } = await mockBoard(page, [dish(1, "TEST latte")]);
  // Someone who may not pause: once the read says so, the kept place goes and the tickets move up.
  await slowPause(page, 3_000, "Denied");
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await expect(ticket).toBeVisible();
  const start = (await ticket.boundingBox())?.y ?? 0;
  await expect(page.locator(".pause-ordering")).toHaveCount(0, { timeout: 6_000 });
  expect((await ticket.boundingBox())?.y).toBeLessThan(start);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Moved. Tap again.");
  // A moment later the same tap is taken.
  await page.waitForTimeout(slotSettleMs + 100);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
});

test("@production a ticket moved by anything appearing above the tickets ignores a tap and says so", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { taps } = await mockBoard(page, [dish(1, "TEST latte")]);
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await expect(ticket).toBeVisible();
  await page.waitForTimeout(slotSettleMs + 100);
  // Something the board did not render (a banner, a notice) pushes the tickets down.
  await page.evaluate(() => {
    const notice = document.createElement("p");
    notice.style.height = "68px";
    notice.textContent = "TEST notice";
    document.querySelector(".kitchen-board-workspace")?.prepend(notice);
  });
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Moved. Tap again.");
  // A moment later the same tap is taken.
  await page.waitForTimeout(slotSettleMs + 100);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
});

/** Six tickets, so a phone's board scrolls and a lower ticket is tapped with the board scrolled. */
const sixTickets = () =>
  [1, 2, 3, 4, 5, 6].map((n) =>
    dish(n, `TEST dish ${n}`, {
      ticketReference: id(100 + n),
      orderReference: id(120 + n),
      orderLabel: { orderNumber: String(10 + n), orderType: "Pickup", tableLabel: null },
    }),
  );
/** Content the board did not render arrives above the tickets (a banner, a notice). */
const insertAbove = (page: Page) =>
  page.evaluate(() => {
    const notice = document.createElement("p");
    notice.style.height = "68px";
    notice.style.margin = "0";
    notice.textContent = "TEST notice";
    document.querySelector(".kitchen-board-workspace")?.prepend(notice);
  });
const screenYOf = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().y);

/**
 * WP-2423 batch 32 (v15 live check of batch 31): with the board scrolled, content added above the
 * tickets is kept out of the way by the browser (scroll anchoring), so the ticket stays where it is
 * on the screen, yet the guard measured the board's page offsets and refused the tap with "Moved.
 * Tap again.". It now judges where the ticket is under the finger.
 */
test("@production with the board scrolled, content added above a ticket that stays put on screen does not refuse its tap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { taps } = await mockBoard(page, sixTickets());
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.goto("/operations/kitchen");
  // Wider type, as the Linux runner's sans.
  await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST dish 5" });
  await expect(ticket).toBeVisible();
  await ticket.locator(".kitchen-ticket__next").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 40));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(slotSettleMs + 100);
  const onScreen = await screenYOf(ticket);
  await insertAbove(page);
  // The browser kept it in place on the screen (its place on the page moved down 68 px).
  expect(await screenYOf(ticket)).toBe(onScreen);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect(ticket.locator(".kitchen-ticket__top")).not.toContainText("Moved. Tap again.");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
  await page.screenshot({ path: "test-results/kitchen-scrolled-anchored-390.png" });
});

test("@production with the board scrolled, content added above that does move the ticket on screen still refuses its tap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { taps } = await mockBoard(page, sixTickets());
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.goto("/operations/kitchen");
  // A browser that does not keep it in place: the ticket moves down under the finger.
  await page.addStyleTag({ content: "html, body { overflow-anchor: none; }" });
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST dish 5" });
  await expect(ticket).toBeVisible();
  await ticket.locator(".kitchen-ticket__next").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 40));
  await page.waitForTimeout(slotSettleMs + 100);
  const onScreen = await screenYOf(ticket);
  await insertAbove(page);
  expect(await screenYOf(ticket)).toBeGreaterThan(onScreen);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Moved. Tap again.");
  await page.waitForTimeout(slotSettleMs + 100);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
});

/**
 * WP-2423 batch 32 review: with the board scrolled to the bottom, the content below the tickets got
 * shorter (on a phone, the last ticket closing at another station). The browser pulled the scroll
 * back (clamping), so every ticket moved down the screen though none moved on the page, and a tap
 * aimed at the old spot landed on the ticket above and was taken.
 */
test("@production with the board scrolled to the bottom, a ticket the shortened page pulls down the screen refuses its tap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { taps } = await mockBoard(page, sixTickets());
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.goto("/operations/kitchen");
  await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST dish 5" });
  await expect(ticket).toBeVisible();
  // Content below the tickets that will get shorter (as a closing last ticket does).
  await page.evaluate(() => {
    const below = document.createElement("div");
    below.id = "test-below";
    below.style.height = "200px";
    document.querySelector(".kitchen-board-workspace")?.append(below);
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(slotSettleMs + 100);
  const onScreen = await screenYOf(ticket);
  const onPage = await pageYOf(ticket);
  await page.evaluate(() => {
    const below = document.getElementById("test-below");
    if (below) below.style.height = "80px";
  });
  // Pulled down the screen, not moved on the page.
  await expect.poll(() => screenYOf(ticket)).toBeGreaterThan(onScreen + 60);
  expect(await pageYOf(ticket)).toBe(onPage);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Moved. Tap again.");
  await page.waitForTimeout(holdMs + 500);
  expect(taps.length).toBe(0);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
});

/**
 * WP-2423 batch 32 (batch 30 review): a later tap that went through took the one status line from
 * an earlier refusal, which then ran out behind "N more" unseen.
 */
for (const [width, height] of [
  [1440, 900],
  [390, 1400],
] as const)
  test(`@production a refusal keeps the status line when a later tap goes through, at ${width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const { taps } = await mockBoard(page, [
      dish(1, "TEST latte"),
      dish(2, "TEST mocha", {
        ticketReference: id(60),
        orderReference: id(61),
        orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
      }),
    ]);
    // Registered last, so it answers first: the latte was cancelled; the mocha goes through.
    await page.route("**/merchant/kitchen/step", async (route) => {
      const body = route.request().postDataJSON() as StepBody;
      if (!body.lines.some((line) => line.workItemReference === id(1))) return route.fallback();
      return route.fulfill({
        headers,
        json: {
          projectionName: "kitchen_work_queue_v1",
          projectionPending: true,
          occurredAt: at,
          lines: body.lines.map((line) => ({
            workItemReference: line.workItemReference,
            orderItemReference: line.orderItemReference,
            ticketReference: line.ticketReference,
            outcome: "Refused",
            refusedReason: "Cancelled",
            ticketVersion: null,
            workItemVersion: null,
            workItemStatus: null,
            completedQuantity: null,
            requiredQuantity: null,
            acceptedAt: null,
            readyAt: null,
            dishesDone: null,
          })),
        },
      });
    });
    await page.goto("/operations/kitchen");
    const latte = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
    const mocha = page.locator(".kitchen-ticket").filter({ hasText: "TEST mocha" });
    await expect(mocha).toBeVisible();
    await page.waitForTimeout(slotSettleMs);
    const line = page.locator(".kitchen-status-row__line");
    await latte.locator(".kitchen-ticket__next").click();
    await expect(line).toContainText("was cancelled", { timeout: holdMs + 4_000 });
    await page.waitForTimeout(slotSettleMs + 100);
    await mocha.locator(".kitchen-ticket__next").click();
    await expect(mocha.locator(".kitchen-ticket__top")).toContainText("Marked done");
    // The mocha's tap is recorded and said, under the refusal, which keeps the one line.
    await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
    await page.locator(".kitchen-status-row__more").click();
    await expect(
      page
        .locator('.kitchen-status-row__detail li[data-tone="Info"]')
        .filter({ hasText: /mocha/iu }),
    ).toBeVisible({ timeout: 4_000 });
    // Read once, while the done notice is still kept (a retrying check would wait for it to go).
    expect(await line.textContent()).toContain("was cancelled");
    await page.screenshot({ path: `test-results/kitchen-refusal-kept-${width}.png` });
  });

/**
 * WP-2423 batch 32 (batch 30 review): when the first remakes read failed, the board opened without
 * Recently finished and without its place; a later read that answered added it mid-service, and on
 * a phone with wide type the bar took a second row and every ticket moved under the cook's finger.
 */
test("@production on a phone with wide type, Recently finished arriving after a failed first read moves no ticket", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const finished = dish(9, "TEST done", {
    ticketReference: id(80),
    orderReference: id(81),
    orderLabel: { orderNumber: "2", orderType: "Pickup", tableLabel: null },
    status: "Completed",
    completedQuantity: 1,
    acceptedAt: at,
    orderItemReadyAt: at,
    workItemCreatedAt: "2026-10-26T22:00:00.000Z",
  });
  const { taps } = await mockBoard(page, [dish(1, "TEST latte"), finished]);
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  let remakeReads = 0;
  await page.route("**/merchant/kitchen/rework/query", async (route) => {
    remakeReads += 1;
    // The first read fails (an outage); the next ones answer.
    if (remakeReads === 1)
      return route.fulfill({ status: 503, headers, json: { error: "unavailable" } });
    return route.fallback();
  });
  await page.goto("/operations/kitchen");
  await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await expect(ticket).toBeVisible();
  await page.waitForTimeout(slotSettleMs);
  const start = await pageYOf(ticket);
  await page.screenshot({ path: "test-results/kitchen-recent-after-failed-read-390-before.png" });
  // The board's next read brings the remakes; Recently finished takes the place kept for it.
  await expect(page.getByText("Recently finished · 1")).toBeVisible({ timeout: 25_000 });
  expect(remakeReads).toBeGreaterThan(1);
  expect(await pageYOf(ticket)).toBe(start);
  await ticket.locator(".kitchen-ticket__next").click();
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => taps.length, { timeout: holdMs + 3_000 }).toBe(1);
  await page.screenshot({ path: "test-results/kitchen-recent-after-failed-read-390.png" });
});

/**
 * Batch 52 (v15 batch 51 live, Test Merchant 2 order 68): a new pickup order came onto the board
 * below the others and the first Finished on it was not taken ("Moved. Tap again."), although
 * nothing had been on that spot of the screen; it needed a second tap. A ticket that arrives
 * where no ticket was takes its first tap; one that arrives where another ticket was still waits.
 */
const arrivalText = {
  en: { done: "Marked done", moved: "Moved. Tap again.", refresh: "Refresh" },
  "zh-Hans": { done: "已做好", moved: "刚移动，请再点", refresh: "刷新" },
} as const;
const pickupDish = (n: number, name: string, orderNumber: string, minute: number) =>
  dish(n, name, {
    ticketReference: id(300 + n),
    orderReference: id(400 + n),
    orderItemReference: id(500 + n),
    orderLabel: { orderNumber, orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: `2026-10-26T22:${String(minute).padStart(2, "0")}:00.000Z`,
  });
for (const language of ["en", "zh-Hans"] as const)
  for (const width of [390, 1024, 1440] as const) {
    test(`@production a new order that arrives below the others takes its first tap, ${language} at ${width} wide`, async ({
      page,
    }) => {
      const words = arrivalText[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height: 900 });
      const older = [
        pickupDish(1, "TEST noodles", "66", 1),
        pickupDish(2, "TEST dumplings", "67", 2),
      ];
      const arriving = pickupDish(3, "TEST beef noodles", "68", 9);
      let items: readonly ReturnType<typeof dish>[] = older;
      const { taps } = await mockBoard(page, () => items);
      await page.goto("/operations/kitchen");
      await expect(page.locator(".kitchen-ticket")).toHaveCount(2);
      await page.waitForTimeout(slotSettleMs);
      // The new order arrives with the next read, after the ones already on the board.
      items = [...older, arriving];
      await page.getByRole("button", { name: words.refresh, exact: true }).first().click();
      const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST beef noodles" });
      await expect(ticket).toBeVisible();
      // Tapped the moment it shows, as the staff kit (and a cook already reaching) does.
      await ticket.locator(".kitchen-ticket__next").click();
      await expect(ticket.locator(".kitchen-ticket__top")).toContainText(words.done);
      await expect(ticket.locator(".kitchen-ticket__top")).not.toContainText(words.moved);
      await expect(ticket.locator(".kitchen-work-item").first()).toHaveAttribute(
        "data-pending",
        "Holding",
      );
      // The older tickets did not move, so they take taps too.
      const first = page.locator(".kitchen-ticket").filter({ hasText: "TEST noodles" }).first();
      await first.locator(".kitchen-ticket__next").click();
      await expect(first.locator(".kitchen-ticket__top")).toContainText(words.done);
      await page.screenshot({
        path: `test-results/kitchen-arrival-first-tap-${language}-${width}.png`,
      });
      await expect.poll(() => taps.length, { timeout: holdMs + 4_000 }).toBe(2);
      expect(taps.map((tap) => tap.lines[0]?.workItemReference).sort()).toEqual(
        [id(1), id(3)].sort(),
      );
    });

    test(`@production a new order that arrives where another ticket was still waits a moment and says so, ${language} at ${width} wide`, async ({
      page,
    }) => {
      const words = arrivalText[language];
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height: 900 });
      const leaving = pickupDish(1, "TEST noodles", "66", 1);
      const staying = pickupDish(2, "TEST dumplings", "67", 2);
      const arriving = pickupDish(3, "TEST beef noodles", "68", 9);
      let items: readonly ReturnType<typeof dish>[] = [leaving, staying];
      const { taps } = await mockBoard(page, () => items);
      await page.goto("/operations/kitchen");
      await expect(page.locator(".kitchen-ticket")).toHaveCount(2);
      await page.waitForTimeout(slotSettleMs);
      // Order 66 is finished elsewhere and leaves; 67 moves into its place and 68 arrives in 67's.
      items = [staying, arriving];
      await page.getByRole("button", { name: words.refresh, exact: true }).first().click();
      const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST beef noodles" });
      await expect(ticket).toBeVisible();
      await ticket.locator(".kitchen-ticket__next").click();
      await expect(ticket.locator(".kitchen-ticket__top")).toContainText(words.moved);
      await expect(ticket.locator(".kitchen-work-item").first()).not.toHaveAttribute(
        "data-pending",
        /./u,
      );
      await page.waitForTimeout(slotSettleMs + 100);
      await ticket.locator(".kitchen-ticket__next").click();
      await expect(ticket.locator(".kitchen-ticket__top")).toContainText(words.done);
      await expect.poll(() => taps.length, { timeout: holdMs + 4_000 }).toBe(1);
    });
  }

/**
 * Batch 53 (v15 batch 52 live, Test Merchant 2 orders 21, 22, 24 and 25): the store had 53 tickets
 * from earlier days in the collapsed "Needs attention" section and nothing else on the board. Those
 * cards still had boxes on the screen though nobody could see them, so every new order counted as
 * arriving where a ticket was and its first Finished said "Moved. Tap again.". Only tickets the
 * cook can see count: a closed section's cards do not, an open section's do.
 */
const backlogText = {
  en: { finished: "Finished", go: "Continue — Finished" },
  "zh-Hans": { finished: "做好了", go: "继续 — 做好了" },
} as const;
const earlierDish = (n: number) =>
  dish(n, `TEST old dish ${n}`, {
    ticketReference: id(700 + n),
    orderReference: id(800 + n),
    orderItemReference: id(900 + n),
    orderLabel: { orderNumber: String(n - 20), orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: "2026-10-24T22:00:00.000Z",
    businessDate: "2026-10-24",
  });
async function backlogBoard(page: Page, language: "en" | "zh-Hans", width: number) {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.setViewportSize({ width, height: 900 });
  // TM2 kept 53 such tickets; a dozen fill every spot where the first new ticket lands.
  const backlog = Array.from({ length: 12 }, (_, index) => earlierDish(index + 21));
  const arriving = {
    ...pickupDish(3, "TEST beef noodles", "21", 9),
    businessDate: "2026-10-26",
  };
  const second = { ...pickupDish(4, "TEST pork buns", "22", 11), businessDate: "2026-10-26" };
  let items: readonly ReturnType<typeof dish>[] = backlog;
  const board = await mockBoard(page, () => items, { canCloseEarlierDayTickets: true });
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-26",
        startsAt: "2026-10-26T08:00:00.000Z",
        endsAt: "2026-10-27T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: at,
      },
    }),
  );
  await page.goto("/operations/kitchen");
  const section = page.locator("details.kitchen-earlier-days");
  await expect(section).toBeVisible();
  await expect(section.locator(".kitchen-earlier-ticket")).toHaveCount(12);
  await expect(page.locator(".kitchen-ticket")).toHaveCount(0);
  return {
    ...board,
    section,
    arrive: async () => {
      items = [...backlog, arriving];
      await page
        .getByRole("button", { name: arrivalText[language].refresh, exact: true })
        .first()
        .click();
      const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST beef noodles" });
      await expect(ticket).toBeVisible();
      return ticket;
    },
    /** A second new order, once the first left the board (its tap went through). */
    arriveNext: async () => {
      items = [...backlog, second];
      await page
        .getByRole("button", { name: arrivalText[language].refresh, exact: true })
        .first()
        .click();
      const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST pork buns" });
      await expect(ticket).toBeVisible();
      return ticket;
    },
  };
}
const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
for (const language of ["en", "zh-Hans"] as const)
  for (const width of [390, 1024, 1440] as const) {
    test(`@production with earlier days' tickets collapsed, a new order takes its first tap, ${language} at ${width} wide`, async ({
      page,
    }) => {
      const words = arrivalText[language];
      const { taps, section, arrive } = await backlogBoard(page, language, width);
      await expect(section).not.toHaveAttribute("open", "");
      await page.waitForTimeout(slotSettleMs);
      const ticket = await arrive();
      // Tapped the moment it shows: nothing the cook could see was on that spot.
      await ticket.locator(".kitchen-ticket__next").click();
      await expect(ticket.locator(".kitchen-ticket__top")).toContainText(words.done);
      await expect(ticket.locator(".kitchen-ticket__top")).not.toContainText(words.moved);
      expect(await noSideScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/kitchen-backlog-collapsed-first-tap-${language}-${width}.png`,
      });
      await expect.poll(() => taps.length, { timeout: holdMs + 4_000 }).toBe(1);
      expect(taps[0]?.lines[0]?.workItemReference).toBe(id(3));
    });

    test(`@production with earlier days' tickets open, a new order below them takes its first tap and they still take theirs, ${language} at ${width} wide`, async ({
      page,
    }) => {
      const words = arrivalText[language];
      const backlogWords = backlogText[language];
      const { taps, section, arrive, arriveNext } = await backlogBoard(page, language, width);
      await section.locator("summary").click();
      await expect(section).toHaveAttribute("open", "");
      const first = section.locator(".kitchen-earlier-ticket").first();
      await expect(first).toBeVisible();
      await page.waitForTimeout(slotSettleMs);
      const ticket = await arrive();
      await ticket.locator(".kitchen-ticket__next").click();
      await expect(ticket.locator(".kitchen-ticket__top")).toContainText(words.done);
      await expect(ticket.locator(".kitchen-ticket__top")).not.toContainText(words.moved);
      // An open earlier day's ticket still asks first, then takes its step.
      await first.getByRole("button", { name: backlogWords.finished, exact: true }).click();
      await page.getByRole("button", { name: backlogWords.go, exact: true }).click();
      await expect(first).toContainText(words.done);
      expect(await noSideScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/kitchen-backlog-open-first-tap-${language}-${width}.png`,
      });
      await expect.poll(() => taps.length, { timeout: holdMs + 4_000 }).toBe(2);
      expect(taps.map((tap) => tap.lines[0]?.workItemReference).sort()).toEqual(
        [id(21), id(3)].sort(),
      );
      // Closed again, its cards are out of sight: the next new order takes its first tap too.
      await section.locator("summary").click();
      await expect(section).not.toHaveAttribute("open", "");
      await page.waitForTimeout(slotSettleMs);
      const next = await arriveNext();
      await next.locator(".kitchen-ticket__next").click();
      await expect(next.locator(".kitchen-ticket__top")).toContainText(words.done);
      await expect(next.locator(".kitchen-ticket__top")).not.toContainText(words.moved);
      await expect.poll(() => taps.length, { timeout: holdMs + 4_000 }).toBe(3);
      expect(taps[2]?.lines[0]?.workItemReference).toBe(id(4));
    });
  }

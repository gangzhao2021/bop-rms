import { expect, test, type Page } from "@playwright/test";

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
const holdMs = 5_000;

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
    await expect(page.locator(".kitchen-status-row__line")).toContainText("was cancelled", {
      timeout: holdMs + 5_000,
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

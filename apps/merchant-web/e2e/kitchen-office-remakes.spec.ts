import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 batch 40 (v15 batch 38-39 live check, Test Merchant 2): the data as it was seen live.
 * The Store had 53 unfinished tickets from earlier days, bilingual dish names (Chinese and
 * English), the whole back office sidebar, Pause ordering and the sound turned off. The batch-39
 * tests used one-language names and no earlier-day tickets, so they passed while the back office
 * drew 53 "Needs attention" rows above the remake (about 3,400 px down) and the kitchen display
 * named the same dish in two languages.
 */
const id = (n: number) => "01a0f040-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-11-20T18:13:00.000Z";
const today = "2026-11-20";

/** The back office sidebar a manager at that Store had (operations, commerce, supply, reports). */
const navigation = [
  ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
  ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
  ["OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry", "ordering.order.create_staff"],
  ["KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"],
  ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"],
  ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
  ["DIN-TABLE-LIST", "Table QR codes", "/app/operations/tables", "dining.table.qr.manage"],
  [
    "PAY-RECONCILIATION",
    "Settlement",
    "/app/operations/payment-reconciliation",
    "payment.settlement.read",
  ],
  ["APPROVAL-INBOX", "Approvals", "/app/approvals", "workflow.operate"],
  ["CAT-AVAILABILITY", "Item availability", "/app/commerce/availability", "catalog.sku.read"],
  [
    "STORE-SETUP",
    "Store setup",
    "/app/organization/stores/" + scope.storeReference + "/setup",
    "organization.manage",
  ],
].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission }));

/** Dish names as the Store keeps them: Chinese and English. */
const dishes = [
  { "zh-Hans": "牛肉面", "en-CA": "Beef noodles (TEST)" },
  { "zh-Hans": "担担面", "en-CA": "Dan dan noodles (TEST)" },
  { "zh-Hans": "豆浆", "en-CA": "Soy milk (TEST)" },
  { "zh-Hans": "拍黄瓜", "en-CA": "Smashed cucumber (TEST)" },
] as const;

const workItem = (n: number, overrides: Record<string, unknown>) => ({
  workItemReference: id(0x1000 + n * 4),
  ticketReference: id(0x1001 + n * 4),
  orderReference: id(0x1002 + n * 4),
  orderItemReference: id(0x1003 + n * 4),
  stationReference: id(5),
  localizedDisplayNames: dishes[n % dishes.length],
  allergens: { status: "Unavailable" },
  orderLabel: { orderNumber: String(n + 1), orderType: "Pickup", tableLabel: null },
  customerNote: null,
  selectedOptions: [],
  status: "Queued",
  requiredQuantity: 1,
  completedQuantity: 0,
  workItemCreatedAt: "2026-11-20T17:50:00.000Z",
  acceptedAt: "2026-11-20T17:50:30.000Z",
  orderItemReadyAt: null,
  ticketAggregateVersion: "2",
  workItemVersion: "1",
  businessDate: today,
  ...overrides,
});

/** 53 tickets never finished on Nov 5 and Nov 11, as at Test Merchant 2. */
const earlier = Array.from({ length: 53 }, (_, n) =>
  workItem(n, {
    orderLabel: { orderNumber: String(n + 2), orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: n < 4 ? "2026-11-05T22:00:00.000Z" : "2026-11-11T22:00:00.000Z",
    acceptedAt: n < 4 ? "2026-11-05T22:00:30.000Z" : "2026-11-11T22:00:30.000Z",
    businessDate: n < 4 ? "2026-11-05" : "2026-11-11",
  }),
);
/** Today: two orders to make, and Order 6 (Beef noodles) finished a minute ago. */
const todays = [
  workItem(60, { orderLabel: { orderNumber: "7", orderType: "Pickup", tableLabel: null } }),
  workItem(61, { orderLabel: { orderNumber: "8", orderType: "Pickup", tableLabel: null } }),
];
const finished = workItem(64, {
  localizedDisplayNames: dishes[0],
  orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
  status: "Completed",
  completedQuantity: 1,
  orderItemReadyAt: "2026-11-20T18:12:00.000Z",
  ticketAggregateVersion: "5",
  workItemVersion: "3",
});

/** The remake of Order 6's noodles, as the rework read serves it. */
const remake = (n: number, status: "Queued" | "In Progress" | "Completed") => ({
  reworkReference: id(0x600 + n),
  originalWorkItemReference: finished.workItemReference,
  orderReference: finished.orderReference,
  orderItemReference: finished.orderItemReference,
  reasonCode: "DROPPED",
  note: null,
  quantity: 1,
  wasteApplies: true,
  status,
  version: status === "Queued" ? 1 : 3,
  createdAt: at,
  startedAt: status === "Queued" ? null : at,
  completedAt: status === "Completed" ? at : null,
  cancelledAt: null,
  cancelReasonCode: null,
  // The staff member's language picks this one name; the board's rule needs both.
  displayName: "Beef noodles (TEST)",
  localizedDisplayNames: dishes[0],
  selectedOptions: [],
  orderLabel: finished.orderLabel,
  businessDate: today,
  customerNote: null,
  allergens: { status: "Unavailable" },
});

async function store(
  page: Page,
  operatorStatus: "Named" | "Unverified",
  state: { reworks: Record<string, unknown>[]; commands: Record<string, unknown>[] },
) {
  await page.addInitScript(() => localStorage.setItem("bop.kitchen.sound", "off"));
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
          businessDate: today,
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: today,
        startsAt: "2026-11-20T09:00:00.000Z",
        endsAt: "2026-11-21T09:00:00.000Z",
        timeZone: scope.timeZone,
        observedAt: at,
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({
      headers,
      json: {
        hours: {
          configurationSource: "StoreOverride",
          effectiveFrom: "2026-07-29T11:00:00.000Z",
          effectiveUntil: null,
          businessDayStartLocalTime: "04:00:00",
          weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
            isoWeekday: index + 1,
            intervals: [],
          })),
          exceptions: [],
        },
        screenId: "STORE-HOURS-SERVICE",
        storeReference: scope.storeReference,
        configurationReference: id(70),
        timeZone: scope.timeZone,
        enabledServiceModes: ["DineIn", "Pickup"],
        observedAt: at,
        expectedVersion: 4,
        activePauses: [],
      },
    }),
  );
  // 56 work items come in pages of 50, as the server sends them.
  const all = [...earlier, ...todays, finished];
  await page.route("**/merchant/kitchen/query", (route) => {
    const body = route.request().postDataJSON() as { cursor?: unknown };
    const from = body.cursor ? 50 : 0;
    const items = all.slice(from, from + 50);
    const last = items.at(-1);
    return route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus,
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        canCloseEarlierDayTickets: true,
        items,
        nextCursor:
          from + 50 < all.length && last
            ? {
                projectionGenerationReference: id(6),
                afterWorkItemReference: last.workItemReference,
                afterCreatedAt: last.workItemCreatedAt,
              }
            : null,
      },
    });
  });
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        observedAt: at,
        canRework: true,
        items: state.reworks,
      },
    }),
  );
  await page.route("**/merchant/kitchen/rework/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    state.commands.push(body);
    const current = state.reworks.find((entry) => entry.reworkReference === body.reworkReference);
    if (!current)
      return route.fulfill({ headers, status: 404, json: { error: "KITCHEN_REWORK_NOT_FOUND" } });
    const next = {
      ...current,
      version: Number(current.version) + 1,
      status: body.action === "StartKitchenRework" ? "In Progress" : "Completed",
      startedAt: at,
    };
    state.reworks = state.reworks.map((entry) => (entry === current ? next : entry));
    return route.fulfill({
      headers,
      json: { status: "Applied", action: body.action, rework: next },
    });
  });
}

async function atTop(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test("@production WP-2423 batch 40: on the back office Kitchen page a remake comes before 53 earlier-day tickets, which stay one tap away", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Unverified", state);
  await page.goto("/operations/kitchen");
  const lane = page.getByRole("region", { name: "Remakes" });
  const card = lane.getByRole("article", { name: /^Remake: .+, Pickup · Order 6$/u });
  await expect(card).toBeVisible();
  const attention = page.locator(".kitchen-office-earlier");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await atTop(page, width, height);
    // The remake is on the first screen (live: y=3372 at 1440x900), today's work right under it.
    await expect(card.locator(".kitchen-work-item__summary h3")).toBeInViewport();
    if (width === 1440)
      await expect(page.locator("section.kitchen-ticket").first()).toBeInViewport();
    // The earlier days are folded into one line that says how many and what to do, never hidden.
    await expect(attention.locator("summary")).toContainText(
      "Needs attention · 53 tickets from earlier days to check and close",
    );
    const close = attention.getByRole("button", { name: "Close ticket", includeHidden: true });
    await expect(close).toHaveCount(53);
    await expect(close.first()).toBeHidden();
    const laneBox = await lane.boundingBox();
    const attentionBox = await attention.boundingBox();
    const ticketBox = await page.locator("section.kitchen-ticket").first().boundingBox();
    expect(laneBox && attentionBox && ticketBox).toBeTruthy();
    if (laneBox && attentionBox && ticketBox) {
      expect(laneBox.y).toBeLessThan(attentionBox.y);
      // Folded, the earlier days are one line between the remakes and today's tickets.
      expect(ticketBox.y - attentionBox.y).toBeLessThan(120);
    }
    await page.screenshot({ path: `test-results/b40-office-${width}.png` });
  }
  await atTop(page, 1440, 900);
  // One tap opens the list, with each dish in both names, and Close ticket offered on each.
  await attention.locator("summary").click();
  const firstRow = attention.locator("li").first();
  await expect(firstRow).toContainText("Pickup · Order 2 · From Thu, Nov 5 · not finished");
  await expect(firstRow).toContainText("1× 牛肉面 Beef noodles (TEST)");
  await expect(attention.getByRole("button", { name: "Close ticket" }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/b40-office-open-1440.png", fullPage: true });
  await expectNoInternalText(page);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);

  // The same in Chinese.
  await page.getByRole("button", { name: "切换到中文" }).click();
  const zhAttention = page.locator(".kitchen-office-earlier");
  await expect(zhAttention.locator("summary")).toContainText("需要处理");
  await expect(zhAttention.locator("summary")).toContainText("53");
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await atTop(page, width, height);
    await expect(
      page
        .getByRole("region", { name: "重做" })
        .getByRole("article", { name: /^重做：/u })
        .locator(".kitchen-work-item__summary h3"),
    ).toBeInViewport();
    await page.screenshot({ path: `test-results/b40-office-${width}-zh.png` });
  }
});

test("@production WP-2423 batch 40: the kitchen display names a dish the same way on its card, in Recently finished and in the remake dialog", async ({
  page,
}) => {
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Named", state);
  await page.goto("/operations/kitchen");
  const card = page
    .getByRole("region", { name: "Remakes" })
    .getByRole("article", { name: /^Remake: 牛肉面, Pickup · Order 6$/u });
  // The card leads with the Chinese name and gives the English one under it, as every ticket does.
  await expect(card.getByRole("heading", { name: /牛肉面/u })).toBeVisible();
  await expect(card).toContainText("Beef noodles (TEST)");
  await page.getByText("Recently finished · 1").click();
  const row = page.locator(".kitchen-recent-finished li").first();
  await expect(row).toContainText("牛肉面");
  await expect(row).toContainText("Beef noodles (TEST)");
  await row.getByRole("button", { name: "Remake 牛肉面, Pickup · Order 6" }).click();
  const dialog = page.getByRole("dialog", { name: /^Remake 牛肉面/u });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Beef noodles (TEST)");
  await page.screenshot({ path: "test-results/b40-kds-names-1440.png" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("@production WP-2423 batch 40: on a 390 px phone a remake's buttons are on the first screen of the kitchen display", async ({
  page,
}) => {
  const state = { reworks: [remake(1, "Queued")], commands: [] as Record<string, unknown>[] };
  await store(page, "Named", state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/operations/kitchen");
  const lane = page.getByRole("region", { name: "Remakes" });
  await expect(lane).toBeVisible();
  await expect(page.getByText("Pause ordering")).toBeVisible();
  for (const language of ["en", "zh"] as const) {
    if (language === "zh") await page.getByRole("button", { name: "切换到中文" }).click();
    await atTop(page, 390, 844);
    const names =
      language === "en" ? ["Start remake", "Cancel remake"] : ["开始重做", /^取消重做/u];
    for (const name of names)
      await expect(
        page
          .getByRole("region", { name: language === "en" ? "Remakes" : "重做" })
          .getByRole("button", { name }),
      ).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `test-results/b40-kds-390-${language}.png` });
  }
});

test("@production WP-2423 batch 40: a remake card that has just arrived does not take a tap for a moment, and says so", async ({
  page,
}) => {
  const state = {
    reworks: [] as Record<string, unknown>[],
    commands: [] as Record<string, unknown>[],
  };
  await store(page, "Named", state);
  await page.goto("/operations/kitchen");
  await expect(page.locator("section.kitchen-ticket").first()).toBeVisible();
  // Another screen sends a remake; the cook taps it the moment it appears (DEC-KITCHEN-ONE-TAP).
  state.reworks = [remake(2, "Queued")];
  const start = page.getByRole("region", { name: "Remakes" }).getByRole("button", {
    name: "Start remake",
  });
  await start.waitFor({ state: "visible", timeout: 15_000 });
  await start.click({ delay: 0 });
  await expect(page.getByText("Moved. Tap again.")).toBeVisible();
  expect(state.commands).toEqual([]);
  // A tap after it has settled is taken.
  await page.waitForTimeout(700);
  await start.click();
  await expect
    .poll(() => state.commands.map((body) => body.action))
    .toEqual(["StartKitchenRework"]);
  await expect(page.getByText("Moved. Tap again.")).toHaveCount(0);
});

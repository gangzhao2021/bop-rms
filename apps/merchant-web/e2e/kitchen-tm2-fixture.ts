import { expect, type Page } from "@playwright/test";

/**
 * WP-2423 batch 40 (v15 batch 38-39 live check, Test Merchant 2): the data as it was seen live.
 * The Store had 53 unfinished tickets from earlier days, bilingual dish names (Chinese and
 * English), the whole back office sidebar, Pause ordering and the sound turned off. The batch-39
 * tests used one-language names and no earlier-day tickets, so they passed while the back office
 * drew 53 "Needs attention" rows above the remake (about 3,400 px down) and the kitchen display
 * named the same dish in two languages.
 */
export const id = (n: number) => "01a0f040-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
export const headers = { "cache-control": "no-store" };
export const at = "2026-11-20T18:13:00.000Z";
export const today = "2026-11-20";

/** The back office sidebar a manager at that Store had (operations, commerce, supply, reports). */
export const navigation = [
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
export const dishes = [
  { "zh-Hans": "牛肉面", "en-CA": "Beef noodles (TEST)" },
  { "zh-Hans": "担担面", "en-CA": "Dan dan noodles (TEST)" },
  { "zh-Hans": "豆浆", "en-CA": "Soy milk (TEST)" },
  { "zh-Hans": "拍黄瓜", "en-CA": "Smashed cucumber (TEST)" },
] as const;

export const workItem = (n: number, overrides: Record<string, unknown>) => ({
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
export const earlier = Array.from({ length: 53 }, (_, n) =>
  workItem(n, {
    orderLabel: { orderNumber: String(n + 2), orderType: "Pickup", tableLabel: null },
    workItemCreatedAt: n < 4 ? "2026-11-05T22:00:00.000Z" : "2026-11-11T22:00:00.000Z",
    acceptedAt: n < 4 ? "2026-11-05T22:00:30.000Z" : "2026-11-11T22:00:30.000Z",
    businessDate: n < 4 ? "2026-11-05" : "2026-11-11",
  }),
);
/** Today: two orders to make, and Order 6 (Beef noodles) finished a minute ago. */
export const todays = [
  workItem(60, { orderLabel: { orderNumber: "7", orderType: "Pickup", tableLabel: null } }),
  workItem(61, { orderLabel: { orderNumber: "8", orderType: "Pickup", tableLabel: null } }),
];
export const finished = workItem(64, {
  localizedDisplayNames: dishes[0],
  orderLabel: { orderNumber: "6", orderType: "Pickup", tableLabel: null },
  status: "Completed",
  completedQuantity: 1,
  orderItemReadyAt: "2026-11-20T18:12:00.000Z",
  ticketAggregateVersion: "5",
  workItemVersion: "3",
});

/** The remake of Order 6's noodles, as the rework read serves it. */
export const remake = (n: number, status: "Queued" | "In Progress" | "Completed") => ({
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

export async function store(
  page: Page,
  operatorStatus: "Named" | "Unverified",
  state: { reworks: Record<string, unknown>[]; commands: Record<string, unknown>[] },
  /** Batch 41: another day's board (today's items) and the Store's kitchen sections. */
  options: {
    readonly todays?: readonly Record<string, unknown>[];
    readonly finished?: readonly Record<string, unknown>[];
    readonly kitchenSections?: readonly string[];
    /** Batch 54 review: a sign-in with fewer screens (for example the kitchen alone). */
    readonly navigation?: readonly (typeof navigation)[number][];
  } = {},
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
          navigation: options.navigation ?? navigation,
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
  const all = [...earlier, ...(options.todays ?? todays), ...(options.finished ?? [finished])];
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
        ...(options.kitchenSections === undefined
          ? {}
          : { kitchenSections: options.kitchenSections }),
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

export async function atTop(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

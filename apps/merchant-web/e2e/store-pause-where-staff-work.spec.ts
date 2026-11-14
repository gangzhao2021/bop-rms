import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 store-service-controls (v15 M30 live check): the Store's pause where staff work. On
 * Orders it sits on the first screen above the earlier days' orders that need attention; on the
 * kitchen display it shows (with its 5-minute warning); a Pickup-only pause says table ordering is
 * still open. Synthetic HTTP interception on the production build, not live Store evidence.
 */
const id = (n: number) => "01a4da00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store", "content-type": "application/json" };
const start = Date.parse("2026-11-05T20:00:00.000Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const widths = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function signIn(page: Page, navigation: readonly Record<string, string>[]) {
  await page.clock.install({ time: new Date(start) });
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
          businessDate: "2026-11-05",
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
        businessDate: "2026-11-05",
        startsAt: "2026-11-05T08:00:00.000Z",
        endsAt: "2026-11-06T08:00:00.000Z",
        timeZone: scope.timeZone,
        observedAt: at(0),
      },
    }),
  );
  // Pickup alone paused until 15:23 Toronto time, at a Store taking table and pickup orders.
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
        observedAt: at(0),
        expectedVersion: 4,
        activePauses: [
          {
            closureReference: id(72),
            effectiveFrom: at(-2),
            effectiveUntil: at(23),
            serviceModes: ["Pickup"],
          },
        ],
      },
    }),
  );
}

/** The pause line is on the first screen: fully inside the viewport without scrolling. */
async function onFirstScreen(page: Page, height: number) {
  const line = page.locator(".pause-ordering");
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  if (box === null) throw new Error("no pause line");
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const earlierDayOrder = (n: number) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Qr",
  businessDate: "2026-11-04",
  listedBusinessDate: "2026-11-05",
  heldStock: null,
  earlierOpenPickup: true,
  submittedAt: "2026-11-04T21:00:00.000Z",
  observedAt: at(0),
  initialBatchReference: id(n + 100),
  batches: [
    {
      orderBatchReference: id(n + 100),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: true,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 3,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
});

test("@production Orders shows the pause and its warning on the first screen, above 14 earlier-day orders", async ({
  page,
}) => {
  await signIn(page, [
    {
      screenId: "OPS-ORDER-QUEUE",
      label: "Orders",
      href: "/operations/orders",
      permission: "ordering.operate",
    },
  ]);
  const earlier = Array.from({ length: 14 }, (_, index) => earlierDayOrder(index + 1));
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: { earlierDayItems: earlier, items: [], nextAfterOrderReference: null },
    }),
  );
  await page.goto("/operations/orders");
  await expect(page.getByRole("region", { name: "Needs attention" })).toContainText(
    "from an earlier day isn't finished",
  );
  await expect(page.locator(".pause-ordering")).toHaveText(
    /Pickup ordering paused until 15:23 · Table ordering still open/u,
  );
  // The pause comes before the earlier days' orders on the page.
  const order = await page.evaluate(() => {
    const pause = document.querySelector(".pause-ordering");
    const attention = document.querySelector(".order-attention");
    return pause !== null && attention !== null
      ? pause.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0;
  });
  expect(order).toBeTruthy();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await onFirstScreen(page, height);
  }
  // Inside the last 5 minutes it warns there, still on the first screen.
  await page.clock.fastForward(19 * 60_000);
  const warning = page.locator(".pause-ordering [role=alert]");
  await expect(warning).toHaveText(
    "Pickup ordering starts again at 15:23 (in 4 min). Table ordering is still open.",
  );
  await expect(page.getByRole("button", { name: "Pause 15 more min" })).toBeVisible();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await onFirstScreen(page, height);
  }
  await expectNoInternalText(page);
});

test("@production the kitchen display shows the pause and its 5-minute warning at every width", async ({
  page,
}) => {
  await signIn(page, [
    {
      screenId: "KIT-KITCHEN-QUEUE",
      label: "Kitchen",
      href: "/operations/kitchen",
      permission: "kitchen.operate",
    },
  ]);
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({ headers, json: { items: [], canRework: false } }),
  );
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at(0),
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        canCloseEarlierDayTickets: false,
        items: [],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/operations/kitchen");
  // The kitchen display's own frame, not the back office.
  await expect(page.getByRole("link", { name: "Orders" })).toHaveCount(0);
  await expect(page.locator(".pause-ordering")).toHaveText(
    /Pickup ordering paused until 15:23 · Table ordering still open/u,
  );
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await onFirstScreen(page, height);
  }
  await page.clock.fastForward(19 * 60_000);
  await expect(page.locator(".pause-ordering [role=alert]")).toHaveText(
    "Pickup ordering starts again at 15:23 (in 4 min). Table ordering is still open.",
  );
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await onFirstScreen(page, height);
    await expect(page.getByRole("button", { name: "Pause 15 more min" })).toBeVisible();
  }
  await expectNoInternalText(page);
});

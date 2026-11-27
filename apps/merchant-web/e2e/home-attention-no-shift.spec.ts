import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { notPausedServiceControl } from "./service-control-state";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";

/**
 * Batch 35 (v15 b34 live minor): Home's "Needs attention" started empty and gained its rows one at
 * a time between 0.2 and 2.1 s (orders waiting, tables to close, earlier orders, earlier pickups,
 * exceptions overdue), one per read as it answered, pushing "Right now" from 361 to 725 px at 1440
 * and 488 to 1198 px at 390, with or without the evening reminder. Home now shows the list whole
 * with its sections; a read slower than OVERVIEW_SETTLE_MS (3 s) holds nothing back for longer and
 * is named as still checking. Synthetic HTTP interception on the production build, TEST-only data.
 */
const id = (n: number) => "019a3501-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const day = "2026-10-27";
const observedAt = "2026-10-27T18:01:00.000Z";
const evening = "2026-10-28T01:42:00.000Z"; // 21:42 in Toronto, business day 2026-10-27
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Delays = Readonly<Record<"orders" | "tables" | "pickups" | "exceptions", number>>;
const staggered: Delays = { orders: 200, tables: 700, pickups: 1_100, exceptions: 1_900 };

function order(n: number, phase: "Submitted" | "Accepted", orderType: "Pickup" | "DineIn") {
  return {
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType,
    sourceChannel: orderType === "Pickup" ? "Web" : "Qr",
    submittedAt: "2026-10-27T17:00:00.000Z",
    observedAt,
    initialBatchReference: id(50 + n),
    batches: [
      {
        orderBatchReference: id(50 + n),
        sequence: 1,
        acceptanceStatus: phase === "Submitted" ? "NotAccepted" : "Accepted",
        canRequestAcceptance: phase === "Submitted",
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: phase === "Submitted",
    currentPhase: phase,
    currentVersion: phase === "Submitted" ? 1 : 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
}

async function home(
  page: Page,
  delays: Delays,
  withReminder: boolean,
  slow: { readonly day?: number; readonly tonight?: number } = {},
) {
  if (withReminder) await page.clock.setFixedTime(new Date(evening));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: day,
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
            ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup", "fulfillment.operate"],
            [
              "OPS-ORDER-EXCEPTION",
              "Exceptions",
              "/operations/order-exceptions",
              "operations.order-exception.manage",
            ],
            ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
            ...(withReminder
              ? [
                  [
                    "RPT-OPS-DASHBOARD",
                    "Reports",
                    "/app/reports/operations",
                    "reporting.sales.read",
                  ],
                ]
              : []),
          ].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission })),
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", async (route) => {
    await later(slow.day ?? 0);
    await route.fulfill({
      headers,
      json: {
        businessDate: day,
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: withReminder ? evening : observedAt,
      },
    });
  });
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(scope.storeReference) }),
  );
  await page.route("**/merchant/operations-alerts", (route) =>
    route.fulfill({
      headers,
      json: {
        monitor: "Reporting",
        observedAt,
        active: [],
        recentlyCleared: [],
        outbound: { email: false, webhooks: 0, heartbeat: false },
        lastSuccessfulBackupAt: "2026-10-27T08:30:00.000Z",
      },
    }),
  );
  if (withReminder)
    await page.route("**/merchant/reports/tonight", async (route) => {
      await later(slow.tonight ?? 0);
      await route.fulfill({ headers, json: tonightSummaryFixture() });
    });
  // Each read answers at its own moment, as on v15.
  await page.route("**/merchant/orders*", async (route) => {
    await later(delays.orders);
    await route.fulfill({
      headers,
      json: {
        // Newest first, as the queue contract requires.
        items: [
          {
            ...order(3, "Accepted", "Pickup"),
            earlierOpenPickup: true,
            kitchenPhase: "InProgress",
          },
          { ...order(2, "Accepted", "DineIn"), currentPhase: "Fulfilled" },
          order(1, "Submitted", "Pickup"),
        ],
        nextAfterOrderReference: null,
      },
    });
  });
  await page.route("**/merchant/dining/tables", async (route) => {
    await later(delays.tables);
    await route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: true,
        canTransferHost: true,
        canCancelUnpaidRounds: true,
        nextAfterTableReference: null,
        items: [
          {
            tableReference: id(40),
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 3,
            currentDiningSessionReference: id(41),
            elapsedMinutes: 55,
            qrCodeValidUntil: "2027-03-01T00:00:00.000Z",
            session: { phase: "Active", version: 2, orderReference: id(2) },
            guestRoundsAwaitingPayment: [],
            roundsAwaitingAcceptance: [],
            staffRoundsAwaitingPayment: [],
          },
        ],
      },
    });
  });
  await page.route("**/merchant/pickup/query", async (route) => {
    await later(delays.pickups);
    await route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt,
        nextAfterFulfillmentReference: null,
        items: [
          {
            fulfillmentReference: id(22),
            orderReference: id(5),
            phase: "Ready",
            aggregateVersion: "2",
            readyAt: "2026-10-25T13:50:00.000Z",
            businessDate: "2026-10-25",
            publicOrderReference: "B".repeat(22),
            proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-10-25T15:00:00.000Z" },
            items: [
              {
                fulfillmentItemReference: id(23),
                orderedQuantity: 1,
                readyQuantity: 1,
                handedOverQuantity: 0,
              },
            ],
          },
        ],
      },
    });
  });
  await page.route("**/merchant/order-exceptions", async (route) => {
    await later(delays.exceptions);
    await route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-EXCEPTION",
        projectionName: "merchant_order_exception_v1",
        storeLabel: scope.storeLabel,
        businessDate: day,
        projectedAt: observedAt,
        freshnessStatus: "Fresh",
        items: [
          {
            exceptionReference: id(30),
            orderReference: id(3),
            orderNumber: "ORD-3",
            kind: "PaymentReconciliationDifference",
            severity: "High",
            status: "Open",
            providerState: "Unknown",
            compensationStatus: "Pending",
            sourceOwner: "Payment",
            createdAt: "2026-10-27T13:00:00.000Z",
            dueAt: "2026-10-27T13:30:00.000Z",
            ownerStatus: "Unassigned",
            sourceFinal: false,
          },
        ],
      },
    });
  });
  // Every frame from Home's first render: where "Right now" is and how many rows the list has.
  await page.addInitScript(() => {
    const samples: { reminder: number; top: number; rows: number; at: number }[] = [];
    (window as unknown as { homeSamples: typeof samples }).homeSamples = samples;
    (window as unknown as { homeHiddenAgain: number }).homeHiddenAgain = 0;
    const sample = () => {
      const now = document.querySelector("main .overview-now");
      // Shown, that is: Home keeps its sections hidden while it holds them back.
      const shown = now !== null && now.getClientRects().length > 0;
      // A frame where Home hides again after it first showed. Counted per frame, so a slow CI
      // runner that skips frames (a long gap between samples) is not mistaken for Home hiding.
      if (!shown && samples.length > 0)
        (window as unknown as { homeHiddenAgain: number }).homeHiddenAgain += 1;
      if (now !== null && shown)
        samples.push({
          // How much of the evening reminder shows: none (-1), or its text (with or without figures).
          reminder:
            document.querySelector("main section.closing-reminder")?.textContent?.length ?? -1,
          top: Math.round(now.getBoundingClientRect().top + window.scrollY),
          rows: document.querySelectorAll("main .overview-attention > li").length,
          at: performance.now(),
        });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
interface Sample {
  readonly reminder: number;
  readonly top: number;
  readonly rows: number;
  readonly at: number;
}
const samples = (page: Page) =>
  page.evaluate(() => (window as unknown as { homeSamples: Sample[] }).homeSamples);
/** Each distinct [where "Right now" is, how much reminder shows], in the order they showed. */
const steps = (seen: readonly Sample[]) =>
  seen
    .map((entry) => `${entry.top}/${entry.reminder}`)
    .filter((key, index, all) => index === 0 || key !== all[index - 1]);
const shots = "test-results/b35";

for (const withReminder of [false, true])
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const)
    test(`@production Home shows Needs attention whole with its sections and nothing below moves for 8 s (${width}${withReminder ? ", evening reminder" : ""})`, async ({
      page,
    }) => {
      test.setTimeout(45_000);
      await page.setViewportSize({ width, height });
      await home(page, staggered, withReminder);
      await page.goto("/app");
      const needs = page.getByRole("region", { name: "Needs attention" });
      await expect(needs.getByText("Exceptions overdue")).toBeVisible();
      if (withReminder)
        await expect(page.getByRole("region", { name: "Before closing" })).toBeVisible();
      await page.waitForTimeout(8_000);
      const seen = await samples(page);
      expect(seen.length).toBeGreaterThan(100);
      // From the first frame "Right now" showed: one place, and every row already there.
      expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
      expect(new Set(seen.map((entry) => entry.rows)).size).toBe(1);
      for (const title of [
        "Orders waiting to be accepted",
        "Tables to close",
        "Earlier orders not finished",
        "Pickups from earlier days",
        "Exceptions overdue",
      ])
        await expect(needs.getByText(title)).toBeVisible();
      await expect(needs.getByText("Still checking")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const variant = withReminder ? "evening" : "day";
      await page.screenshot({ path: `${shots}/home-${variant}-${width}-en.png`, fullPage: true });
      await page.getByRole("button", { name: "切换到中文" }).first().click();
      await expect(needs.getByText("Exceptions overdue")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "需要处理" })).toBeVisible();
      await page.waitForTimeout(3_500);
      await page.screenshot({
        path: `${shots}/home-${variant}-${width}-zh-Hans.png`,
        fullPage: true,
      });
      await expectNoInternalText(page);
    });

test("@production a read slower than 3 s holds Home back no longer: what is known shows, the slow read is named as still checking", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await home(page, { ...staggered, exceptions: 6_000 }, false);
  const started = Date.now();
  await page.goto("/app");
  const needs = page.getByRole("region", { name: "Needs attention" });
  await expect(needs.getByText("Still checking")).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect(needs.getByText("Not answered yet: Exceptions")).toBeVisible();
  await page.screenshot({ path: `${shots}/home-still-checking-1440-en.png`, fullPage: true });
  // What the other reads found is already there.
  await expect(needs.getByText("Orders waiting to be accepted")).toBeVisible();
  await expect(needs.getByText("Pickups from earlier days")).toBeVisible();
  // Once it answers, its row takes the place of "Still checking".
  await expect(needs.getByText("Exceptions overdue")).toBeVisible({ timeout: 8_000 });
  await expect(needs.getByText("Still checking")).toHaveCount(0);
  await expectNoInternalText(page);
});

// Batch 35 review: the business-day read answering last. Inside BUSINESS_DAY_SETTLE_MS (here
// 1.5 s; tonight's figures take 0.3 s) Home showed for a frame or more with the reminder lacking
// its figures, then moved "Right now" 44 px when they came. Past it (2.5 s) Home hid its sections
// again while the reminder read, and the reminder could come in two steps, first without and then
// with its figures. Now: inside the cap, one shape from the first frame; past it, the reminder
// arrives once, whole, and Home never hides again.
for (const dayDelay of [1_500, 2_500])
  test(`@production the day's hours answering last (${dayDelay} ms): the evening reminder shows whole, at most one move (390)`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await home(page, { orders: 100, tables: 200, pickups: 300, exceptions: 400 }, true, {
      day: dayDelay,
      tonight: 300,
    });
    await page.goto("/app");
    const reminder = page.getByRole("region", { name: "Before closing" });
    await expect(reminder.getByText(/Today's net taken/u)).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(4_000);
    const seen = await samples(page);
    expect(seen.length).toBeGreaterThan(100);
    // Once shown, Home stays shown: no frame after the first sample has Home hidden again.
    expect(
      await page.evaluate(() => (window as unknown as { homeHiddenAgain: number }).homeHiddenAgain),
    ).toBe(0);
    // No frame shows the reminder without its figures.
    const whole = seen.at(-1)?.reminder;
    expect(seen.filter((entry) => entry.reminder !== -1 && entry.reminder !== whole)).toEqual([]);
    expect(steps(seen).length).toBe(dayDelay < 2_000 ? 1 : 2);
    expect(seen[0]?.reminder).toBe(dayDelay < 2_000 ? whole : -1);
  });

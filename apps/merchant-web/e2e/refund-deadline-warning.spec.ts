import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 pilot rule "Warn before timeouts" (v15 2026-10-17, order 9): a paid pickup order nobody
 * accepts is refunded automatically when its acceptance window ends. Every screen staff work in
 * warns from 5 minutes before, escalates and chimes at 2 minutes and 30 seconds, and starts again
 * when an outage deferral moves the deadline. The kitchen display role, which cannot accept, is
 * warned too. Synthetic HTTP interception on the production build, not live Store evidence.
 */
const id = (n: number) => "01a0f031-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const start = Date.parse("2026-10-17T13:55:30.000Z");
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

async function signIn(page: Page, navigation: readonly Record<string, string>[]) {
  // Counts the chime's tones instead of playing them.
  await page.addInitScript(() => {
    const tones = { count: 0 };
    (window as unknown as { __tones: typeof tones }).__tones = tones;
    const ignore = () => undefined;
    const node = () => ({
      connect: (next: unknown) => next ?? node(),
      frequency: { value: 0 },
      gain: { setValueAtTime: ignore, exponentialRampToValueAtTime: ignore },
      type: "sine",
      start: ignore,
      stop: ignore,
    });
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createOscillator() {
        tones.count += 1;
        return node();
      }
      createGain() {
        return node();
      }
      resume() {
        return Promise.resolve();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  await page.clock.install({ time: new Date(start) });
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
          businessDate: "2026-10-17",
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
        businessDate: "2026-10-17",
        startsAt: "2026-10-17T08:00:00.000Z",
        endsAt: "2026-10-18T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: at(0),
      },
    }),
  );
}
const chimes = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { __tones: { count: number } }).__tones.count)) /
  2;

test("@production every screen warns before an unaccepted paid order is refunded", async ({
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
  // Order 9: paid, not accepted, refunded at 13:58:00Z (2 min 30 s from the start).
  let deadline: { acceptBy: string | null; decideBy: string | null; held: boolean } = {
    acceptBy: "2026-10-17T13:58:00.000Z",
    decideBy: null,
    held: false,
  };
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(9),
            orderNumber: "9",
            orderType: "Pickup",
            sourceChannel: "Web",
            submittedAt: "2026-10-17T13:28:00.000Z",
            observedAt: at(0),
            initialBatchReference: id(59),
            batches: [
              {
                orderBatchReference: id(59),
                sequence: 1,
                acceptanceStatus: "NotAccepted",
                canRequestAcceptance: true,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: true,
            currentPhase: "Submitted",
            currentVersion: 1,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: deadline.acceptBy,
            acceptanceHold: deadline.held
              ? {
                  holdReference: id(79),
                  orderBatchReference: id(59),
                  heldAt: "2026-10-17T13:58:05.000Z",
                  lapsedDeadline: "2026-10-17T13:58:00.000Z",
                  storeLastSeenAt: "2026-10-17T13:52:00.000Z",
                  decideBy: deadline.decideBy,
                  refundChosen: false,
                  canRefund: true,
                }
              : null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.goto("/app");
  const warning = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(warning).toContainText(
    "Order 9 will be refunded automatically in 3 min unless someone accepts it.",
  );
  await expect(warning).toHaveAttribute("data-tier", "warning");
  await expect(warning.getByRole("link", { name: "Accept on Orders" })).toBeVisible();
  expect(await chimes(page)).toBe(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(warning).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/refund-deadline-warning-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  // 2 minutes left: stronger, announced, and one chime.
  await page.clock.runFor(31_000);
  await expect(warning).toContainText(
    "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
  );
  await expect(warning).toHaveAttribute("data-tier", "urgent");
  await expect(page.getByRole("alert").filter({ hasText: "in 2 min" })).toHaveCount(1);
  await expect.poll(() => chimes(page)).toBe(1);

  // The store went offline at the deadline: the order is held, nothing runs, no warning.
  deadline = { acceptBy: null, decideBy: null, held: true };
  await page.clock.runFor(16_000);
  await expect(warning).toHaveCount(0);
  // Back online: a manager has until 14:00:00Z. The warnings start again for the new time.
  deadline = {
    acceptBy: "2026-10-17T14:00:00.000Z",
    decideBy: "2026-10-17T14:00:00.000Z",
    held: true,
  };
  await page.clock.setSystemTime(new Date("2026-10-17T13:58:10.000Z"));
  await page.clock.runFor(16_000);
  await expect(warning).toContainText(
    "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
  );
  await expect.poll(() => chimes(page)).toBe(2);

  // Staff working on Orders see it too, without a link back to the page they are on.
  await warning.getByRole("link", { name: "Accept on Orders" }).click();
  await expect(page).toHaveURL(/\/operations\/orders$/u);
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("link")).toHaveCount(0);

  // The last 30 seconds: the final chime.
  await page.clock.runFor(75_000);
  await expect(warning).toContainText(
    "Order 9 will be refunded automatically in less than a minute unless someone accepts it.",
  );
  await expect(warning).toHaveAttribute("data-tier", "final");
  await expect.poll(() => chimes(page)).toBeGreaterThanOrEqual(3);
  await expectNoInternalText(page);
});

test("@production the kitchen display is warned too and told who can accept", async ({ page }) => {
  await signIn(page, [
    {
      screenId: "KIT-KITCHEN-QUEUE",
      label: "Kitchen",
      href: "/operations/kitchen",
      permission: "kitchen.operate",
    },
  ]);
  const queries: Record<string, unknown>[] = [];
  await page.route("**/merchant/kitchen/query", (route) => {
    queries.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
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
        awaitingAcceptance: [
          {
            orderNumber: "9",
            orderType: "Pickup",
            tableLabel: null,
            acceptBy: "2026-10-17T13:57:20.000Z",
          },
          { orderNumber: "4", orderType: "DineIn", tableLabel: "T2", acceptBy: null },
        ],
        items: [],
        nextCursor: null,
      },
    });
  });
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        observedAt: at(0),
        canRework: false,
        items: [],
      },
    }),
  );
  await page.goto("/operations/kitchen");
  const warning = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(warning).toContainText(
    "Order 9 will be refunded automatically in 2 min unless someone accepts it.",
  );
  await expect(warning).toContainText("Ask someone at the counter to accept it on Orders.");
  await expect(warning.getByRole("link")).toHaveCount(0);
  // A dine-in round is never refunded for waiting: no warning for it.
  await expect(warning).not.toContainText("Order 4");
  await expect.poll(() => chimes(page)).toBe(1);
  expect(queries.some((query) => query.limit === 1 && query.cursor === null)).toBe(true);
  await expectNoInternalText(page);
});

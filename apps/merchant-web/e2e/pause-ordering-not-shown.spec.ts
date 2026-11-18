import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * WP-2423 batch 32 (v15 live check of batch 31): for staff who may not pause ordering, Home, Orders
 * and Pickup kept a hidden 44 px place for Pause ordering until its read was refused, then the
 * place collapsed and the tabs, the order list (with its Accept buttons) and the Pickup list moved
 * up 52 px 1.4-2.9 s after opening, under a tap aimed at a row. The workspace now says whether the
 * control is shown, so for them nothing is kept, nothing is read and nothing moves. Synthetic HTTP
 * interception on the production build (the refusal answers late, as on a busy server).
 */
const id = (n: number) => "01a0f032-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const now = new Date().toISOString();
const widths = [
  [1440, 900],
  [390, 844],
] as const;
/** The refusal comes this late, as in the live check (1.4-2.9 s). */
const refusalMs = 1_500;

async function signIn(page: Page, navigation: readonly Record<string, string>[]) {
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
          businessDate: now.slice(0, 10),
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
          pauseOrderingShown: false,
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: now.slice(0, 10),
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        timeZone: scope.timeZone,
        observedAt: now,
      },
    }),
  );
  const reads = { count: 0 };
  // The server's own refusal, late: never asked for on the fixed build.
  await page.route("**/merchant/service-control", async (route) => {
    reads.count += 1;
    await new Promise((resolve) => setTimeout(resolve, refusalMs));
    await route.fulfill({ headers, status: 403, json: { error: "denied" } });
  });
  return reads;
}

/** Where the element sits on the screen now, and again after the late refusal would have landed. */
async function staysPut(page: Page, target: Locator, name: string) {
  // Wider type, as the Linux runner's sans.
  await page.addStyleTag({ content: "body { letter-spacing: 0.08em; }" });
  await expect(target).toBeVisible();
  const before = await target.boundingBox();
  await expect(page.locator(".pause-ordering")).toHaveCount(0);
  await page.waitForTimeout(refusalMs + 1_500);
  const after = await target.boundingBox();
  expect(after?.y, name).toBe(before?.y);
  await expect(page.locator(".pause-ordering")).toHaveCount(0);
}

const acceptable = (n: number) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: now,
  observedAt: now,
  initialBatchReference: id(n + 50),
  batches: [
    {
      orderBatchReference: id(n + 50),
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
  acceptBy: null,
  acceptanceHold: null,
  awaitingPayment: false,
});

for (const [width, height] of widths)
  test(`@production Orders for staff who may not pause: the order tabs and Accept rows never move, at ${width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const reads = await signIn(page, [
      {
        screenId: "OPS-ORDER-QUEUE",
        label: "Orders",
        href: "/operations/orders",
        permission: "ordering.operate",
      },
    ]);
    await page.route("**/merchant/orders*", (route) =>
      route.fulfill({
        headers,
        json: { items: [acceptable(22), acceptable(21)], nextAfterOrderReference: null },
      }),
    );
    await page.goto("/operations/orders");
    await expect(page.getByRole("button", { name: /Accept/u }).first()).toBeVisible();
    await staysPut(page, page.getByRole("group", { name: "Show orders" }), "order tabs");
    await staysPut(page, page.getByRole("button", { name: "Accept 21" }), "Accept");
    expect(reads.count).toBe(0);
    await page.screenshot({ path: `test-results/b32-orders-no-pause-${width}.png` });
  });

const waiting = (n: number) => ({
  fulfillmentReference: id(200 + n),
  orderReference: id(300 + n),
  phase: "Ready",
  aggregateVersion: "2",
  readyAt: now,
  publicOrderReference: String.fromCharCode(65 + n).repeat(22),
  proof: {
    kind: "HumanCode",
    generation: 1,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  items: [
    {
      fulfillmentItemReference: id(400 + n),
      orderedQuantity: 1,
      readyQuantity: 1,
      handedOverQuantity: 0,
    },
  ],
});

for (const [width, height] of widths)
  test(`@production Pickup for staff who may not pause: the list never moves, at ${width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const reads = await signIn(page, [
      {
        screenId: "FUL-PICKUP-QUEUE",
        label: "Pickup",
        href: "/operations/pickup",
        permission: "fulfillment.operate",
      },
    ]);
    await page.route("**/merchant/pickup/query", (route) =>
      route.fulfill({
        headers,
        json: {
          source: "CurrentFulfillment",
          workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
          storeReference: scope.storeReference,
          observedAt: now,
          nextAfterFulfillmentReference: null,
          items: [waiting(1), waiting(2)],
        },
      }),
    );
    await page.goto("/operations/pickup");
    await staysPut(page, page.locator(".pickup-queue__number").first(), "first pickup row");
    expect(reads.count).toBe(0);
    await page.screenshot({ path: `test-results/b32-pickup-no-pause-${width}.png` });
  });

for (const [width, height] of widths)
  test(`@production Home for staff who may not pause: what follows the pause's place never moves, at ${width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const reads = await signIn(page, [
      { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
      {
        screenId: "OPS-ORDER-QUEUE",
        label: "Orders",
        href: "/operations/orders",
        permission: "ordering.operate",
      },
    ]);
    await page.route("**/merchant/orders*", (route) =>
      route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
    );
    await page.goto("/app");
    await staysPut(page, page.locator(".overview-needs, .overview-now").first(), "Home summary");
    expect(reads.count).toBe(0);
    await page.screenshot({ path: `test-results/b32-home-no-pause-${width}.png` });
  });

import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { openOrder, orderPanel } from "./order-queue-helpers";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT at a Store that sends paid orders straight to the kitchen: what
 * Orders says, the one Store-level alarm on every screen, Can't make it, the brake on the floor, and
 * what the kitchen board says about orders left for a person. Synthetic HTTP interception on the
 * production build, not live Store evidence.
 */
const id = (n: number) => "01a0f032-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const start = Date.parse("2026-11-05T20:00:00.000Z");
const ago = (minutes: number) => new Date(start - minutes * 60_000).toISOString();

async function signIn(page: Page, navigation: readonly Record<string, string>[]) {
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
        timeZone: "America/Toronto",
        observedAt: ago(0),
      },
    }),
  );
  // Whoever can't pause gets the same refusal the server gives.
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "denied" } }),
  );
}
const ordersNavigation = [
  {
    screenId: "OPS-ORDER-QUEUE",
    label: "Orders",
    href: "/operations/orders",
    permission: "ordering.operate",
  },
];
const order = (n: number, batch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: ago(8),
  observedAt: ago(0),
  initialBatchReference: id(n + 50),
  batches: [
    {
      orderBatchReference: id(n + 50),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
      ...batch,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 2,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  acceptanceHold: null,
  awaitingPayment: false,
  ...extra,
});
const watch = (input: Record<string, unknown> = {}) => ({
  on: true,
  settingVersion: 3,
  lastKitchenStepAt: null,
  cantMakeRefunds: 0,
  canTurnOff: false,
  waiting: [
    {
      orderNumber: "21",
      orderType: "Pickup",
      acceptedAt: ago(6),
      reachedKitchen: true,
      refundAt: new Date(start + 24 * 60_000).toISOString(),
    },
  ],
  ...input,
});
const serviceHours = {
  configurationSource: "StoreOverride",
  effectiveFrom: "2026-07-29T11:00:00.000Z",
  effectiveUntil: null,
  businessDayStartLocalTime: "04:00:00",
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [],
  })),
  exceptions: [],
};
const chimes = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { __tones: { count: number } }).__tones.count)) /
  2;

test("@production Orders: sent by itself, why one is not, Can't make it and the brake", async ({
  page,
}) => {
  await signIn(page, ordersNavigation);
  let current = {
    // Newest first.
    items: [
      order(
        22,
        {
          acceptanceStatus: "NotAccepted",
          canRequestAcceptance: true,
          notSentAutomatically: { reason: "HasAlcohol", itemCount: 2 },
        },
        { canRequestAcceptance: true, currentPhase: "Submitted", currentVersion: 1 },
      ),
      order(21, { acceptedAutomaticallyAt: ago(6), canCantMake: true }),
    ],
    nextAfterOrderReference: null,
    paidOrderWatch: watch({ canTurnOff: true }) as Record<string, unknown> | undefined,
  };
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: current }));
  // What Can't make it would give back, read as its dialog opens.
  await page.route("**/merchant/orders/cant-make/preview", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(21),
        orderBatchReference: id(71),
        refundMethod: "Online",
        paidMinor: "1450",
        refundMinor: "1450",
        currencyCode: "CAD",
      },
    }),
  );
  const refusals: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/cant-make", (route) => {
    refusals.push(route.request().postDataJSON() as Record<string, unknown>);
    current = {
      ...current,
      items: [
        current.items[0] as (typeof current.items)[number],
        order(21, {
          acceptanceStatus: "Accepted",
          acceptedAutomaticallyAt: ago(6),
          canCantMake: false,
        }),
      ],
    };
    return route.fulfill({
      headers,
      json: {
        status: "Cancelled",
        orderReference: id(21),
        orderBatchReference: id(71),
        cancelledAt: ago(0),
        refundStatus: "Pending",
        refundMethod: "Online",
        refundAmountMinor: null,
      },
    });
  });
  const turnedOff: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/auto-accept/off", (route) => {
    turnedOff.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, json: { version: 4 } });
  });
  await page.goto("/operations/orders");
  const row = page.locator("main");
  // A person sees why this one is still here, in one line.
  await openOrder(page, "22");
  await expect(orderPanel(page).getByText("Has alcohol · check ID, then Accept")).toBeVisible();
  await openOrder(page, "21");
  await expect(orderPanel(page).getByText("Accepted automatically · sent 6 min ago")).toBeVisible();
  await expect(
    orderPanel(page).getByRole("button", { name: "Can't make it · refund" }),
  ).toBeVisible();
  // One alarm on the screen; no alarm per order.
  await expect(
    page.getByText(
      "The kitchen hasn't touched anything for 6 min and 1 paid order is waiting · check the kitchen screen",
    ),
  ).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/order-auto-accepted-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  // Can't make it: a reason, one confirmation, the same operation a retry would send.
  await orderPanel(page).getByRole("button", { name: "Can't make it · refund" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The customer is refunded in full, $14.50 including tip.");
  await expect(dialog).toContainText("The money goes back to the card they paid with");
  await expect(dialog.getByRole("button", { name: "Refund", exact: true })).toBeDisabled();
  await dialog.getByLabel("Reason").selectOption("SOLD_OUT");
  await dialog.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(
    orderPanel(page).getByRole("button", { name: "Can't make it · refund" }),
  ).toBeHidden();
  expect(refusals).toEqual([
    expect.objectContaining({
      orderReference: id(21),
      orderBatchReference: id(71),
      expectedOrderVersion: 2,
      reasonCode: "SOLD_OUT",
    }),
  ]);

  // The Store's own Pause is here too for whoever may pause (this person can't: nothing shows).
  await expect(row.getByRole("button", { name: "Pause ordering" })).toBeHidden();
  // The brake: asked once, recorded by the server.
  const line = row.getByText("Paid orders go straight to the kitchen", { exact: true });
  await expect(line).toBeVisible();
  await row.getByRole("button", { name: "Turn off" }).click();
  await row.getByRole("button", { name: "Yes, turn off" }).click();
  await expect(row.getByText("Paid orders now wait for Accept on Orders.")).toBeVisible();
  expect(turnedOff[0]).toMatchObject({ expectedVersion: 3 });
});

test("@production Orders: a pickup that never reached the kitchen is made by hand, and the warnings stack", async ({
  page,
}) => {
  await signIn(page, ordersNavigation);
  const lost = (kept: boolean) =>
    order(23, {
      acceptedAutomaticallyAt: ago(26),
      canCantMake: true,
      reachedKitchen: false,
      kept,
      canKeep: !kept,
    });
  const filler = Array.from({ length: 24 }, (_, index) =>
    order(100 + index, { acceptedAutomaticallyAt: ago(8), canCantMake: false }),
  ).reverse();
  let current = {
    items: [...filler, lost(false)],
    nextAfterOrderReference: null,
    paidOrderWatch: watch({
      waiting: [
        {
          orderNumber: "23",
          orderType: "Pickup",
          acceptedAt: ago(26),
          reachedKitchen: false,
          refundAt: new Date(start + 4 * 60_000).toISOString(),
        },
      ],
    }) as Record<string, unknown>,
  };
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: current }));
  const kept: Record<string, unknown>[] = [];
  await page.route("**/merchant/orders/auto-accepted/keep", (route) => {
    kept.push(route.request().postDataJSON() as Record<string, unknown>);
    current = {
      ...current,
      items: [...filler, lost(true)],
      paidOrderWatch: watch({ waiting: [] }) as Record<string, unknown>,
    };
    return route.fulfill({ headers, json: { status: "Kept" } });
  });
  await page.goto("/operations/orders");
  // The countdown says only a person on Orders can stop it; the alarm sits under it.
  const countdown = page.getByRole("region", { name: "Orders about to be refunded" });
  await expect(countdown).toContainText(
    "Order 23 did not reach the kitchen. It will be refunded automatically in 4 min unless someone taps Making it by hand on Orders.",
  );
  const alarm = page.locator(".paid-order-alarm");
  await expect(alarm).toContainText("1 paid order did not reach the kitchen");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await page.mouse.wheel(0, 1600);
    // Scrolled: the two warnings stack, and the page's own sticky parts start under both.
    const layout = await page.evaluate(() => {
      const box = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const countdown = box(".refund-deadline-warning:not(.paid-order-alarm)");
      const alarm = box(".paid-order-alarm");
      // What is on top at the alarm's middle: the alarm itself, not a row painted over it.
      const middle =
        alarm === null
          ? null
          : document.elementFromPoint(alarm.left + alarm.width / 2, alarm.top + alarm.height / 2);
      const onTop = middle?.closest(".paid-order-alarm") !== null && middle !== null;
      return {
        onTop,
        topTag: middle === null ? "none" : middle.tagName + "." + String(middle.className),
        scrollY: window.scrollY,
        background: getComputedStyle(document.querySelector(".paid-order-alarm") as Element)
          .backgroundColor,
        countdownBottom: countdown?.bottom ?? -1,
        alarmTop: alarm?.top ?? -1,
        alarmBottom: alarm?.bottom ?? -1,
        pinned: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--bop-pinned-top"),
        ),
      };
    });
    expect(layout, JSON.stringify(layout)).toMatchObject({
      onTop: true,
      background: "rgb(255, 255, 255)",
    });
    expect(Math.abs(layout.alarmTop - layout.countdownBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.pinned - layout.alarmBottom)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/order-auto-accepted-stacked-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.wheel(0, -4000);
  await openOrder(page, "23");
  await expect(
    orderPanel(page).getByText("Accepted automatically · it did not reach the kitchen screen"),
  ).toBeVisible();
  await expectNoInternalText(page);
  await orderPanel(page).getByRole("button", { name: "Making it by hand" }).click();
  await expect(
    orderPanel(page).getByText("Accepted automatically · being made by hand"),
  ).toBeVisible();
  await expect(orderPanel(page).getByRole("button", { name: "Making it by hand" })).toBeHidden();
  // Still possible to give it back after all.
  await expect(
    orderPanel(page).getByRole("button", { name: "Can't make it · refund" }),
  ).toBeVisible();
  // The screen-wide countdown re-reads on its own cycle, as after an Accept.
  await page.clock.fastForward(16_000);
  await expect(countdown).toBeHidden();
  expect(kept).toEqual([{ orderReference: id(23), orderBatchReference: id(73) }]);
});

test("@production a Store without it sees nothing new, and a working kitchen raises no alarm", async ({
  page,
}) => {
  await signIn(page, ordersNavigation);
  let current: Record<string, unknown> = {
    items: [order(31, {})],
    nextAfterOrderReference: null,
  };
  await page.route("**/merchant/orders", (route) => route.fulfill({ headers, json: current }));
  await page.goto("/operations/orders");
  const main = page.locator("main");
  await expect(main.getByText("31", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Paid orders go straight to the kitchen")).toBeHidden();
  await expect(page.getByText(/The kitchen hasn't touched anything/u)).toBeHidden();
  await expect(page.getByRole("button", { name: "Can't make it · refund" })).toBeHidden();
  // Switch on, kitchen working other tickets: a line for whoever may turn it off, nothing rings.
  current = { ...current, paidOrderWatch: watch({ lastKitchenStepAt: ago(1) }) };
  await page.clock.fastForward(16_000);
  await expect(page.getByText("Paid orders go straight to the kitchen")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off" })).toBeHidden();
  await expect(page.getByText(/The kitchen hasn't touched anything/u)).toBeHidden();
  expect(await chimes(page)).toBe(0);
});

test("@production the kitchen board says what needs a person, and an order that never arrived", async ({
  page,
}) => {
  // A kitchen-only screen: it can't accept, so it says who can, and it rings until seen.
  await signIn(page, [
    {
      screenId: "KIT-KITCHEN-QUEUE",
      label: "Kitchen",
      href: "/operations/kitchen",
      permission: "kitchen.operate",
    },
  ]);
  await page.addInitScript(() => localStorage.setItem("bop.kitchen.sound", "off"));
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
        projectedAt: ago(0),
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        canCloseEarlierDayTickets: false,
        awaitingAcceptance: [
          {
            orderNumber: "12",
            orderType: "DineIn",
            tableLabel: "4",
            acceptBy: null,
            notSent: { reason: "HasAlcohol", itemCount: 2 },
          },
        ],
        paidOrderWatch: {
          ...watch({
            waiting: [
              {
                orderNumber: "21",
                orderType: "DineIn",
                acceptedAt: ago(6),
                reachedKitchen: false,
                refundAt: null,
              },
            ],
          }),
          canAcceptOrders: false,
        },
        items: [],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/operations/kitchen");
  const needs = page.getByRole("alert").filter({ hasText: "Paid, needs a person" });
  await expect(needs).toContainText("Table 4 · Order 12 · Has alcohol · check ID, then Accept");
  await expect(needs).toContainText("Ask someone at the counter to accept it on Orders.");
  await expect(needs.getByRole("link")).toHaveCount(0);
  // Sound off is an alert here, not a small line: a silent board now means an unseen order.
  await expect(
    page.getByText("Paid orders now come straight here. Sound is off, so nobody will hear them."),
  ).toBeVisible();
  // A batch whose kitchen delivery failed is said on this screen too.
  await expect(page.getByText(/1 paid order did not reach the kitchen/u)).toBeVisible();
  await page.getByRole("button", { name: "Tap to turn it on" }).click();
  await expect(page.getByRole("button", { name: "Tap to turn it on" })).toBeHidden();
  const before = await chimes(page);
  await page.clock.fastForward(21_000);
  await expect.poll(() => chimes(page)).toBeGreaterThan(before);
  await needs.getByRole("button", { name: "Seen" }).click();
  await expect(needs).toBeHidden();
  await expectNoInternalText(page);
});

test("@production whoever may pause does it from Orders, at a Store sending orders straight through", async ({
  page,
}) => {
  await signIn(page, ordersNavigation);
  await page.unroute("**/merchant/service-control");
  const until = new Date(start + 30 * 60_000).toISOString();
  let paused = false;
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/service-control", (route) => {
    if (route.request().method() === "POST") {
      commands.push(route.request().postDataJSON() as Record<string, unknown>);
      paused = true;
      return route.fulfill({
        headers: { ...headers, "content-type": "application/json" },
        json: { status: "Applied", resultingVersion: 4 },
      });
    }
    return route.fulfill({
      headers: { ...headers, "content-type": "application/json" },
      json: {
        hours: serviceHours,
        screenId: "STORE-HOURS-SERVICE",
        storeReference: scope.storeReference,
        configurationReference: id(70),
        timeZone: scope.timeZone,
        enabledServiceModes: ["Pickup"],
        observedAt: ago(0),
        expectedVersion: paused ? 4 : 3,
        activePauses: paused
          ? [
              {
                closureReference: id(72),
                effectiveFrom: ago(0),
                effectiveUntil: until,
                serviceModes: null,
              },
            ]
          : [],
      },
    });
  });
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [order(41, {})],
        nextAfterOrderReference: null,
        paidOrderWatch: watch({ canTurnOff: true, waiting: [] }),
      },
    }),
  );
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Pause ordering" }).click();
  await expect(
    page.getByText("Guests can't order while paused. Orders already paid still come in."),
  ).toBeVisible();
  await page.getByRole("button", { name: "30 min", exact: true }).click();
  await expect(page.getByText(/Ordering paused until/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(commands[0]).toMatchObject({ command: "PauseService", expectedVersion: 3 });
  // When its time is up it is over here too, without anyone pressing Resume.
  await page.clock.fastForward(31 * 60_000);
  await expect(page.getByText(/Ordering paused until/u)).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause ordering" })).toBeVisible();
});

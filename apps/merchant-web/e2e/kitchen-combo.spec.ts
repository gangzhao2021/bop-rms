import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * WP-2423 item 8 ⑥ part 4 (coordinator 2026-10-28 decision 3): a combo on the kitchen card lists
 * each chosen dish under it, Chinese name first, each marked done on its own; the combo's own
 * "Finished" appears only once every dish is done, and the last dish finishes it. TEST-only data.
 */
const id = (n: number) => "01a0f0c0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-29T00:14:00.000Z";
const [wonton, rice] = [id(61), id(62)];

test("@production a combo's dishes are made and marked done one by one on the kitchen card", async ({
  page,
}, testInfo) => {
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
          businessDate: "2026-10-28",
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
  const done = new Set<string>();
  let completed = false;
  const combo = () => ({
    workItemReference: id(1),
    ticketReference: id(50),
    orderReference: id(51),
    orderItemReference: id(21),
    stationReference: id(52),
    localizedDisplayNames: { "zh-Hans": "二人套餐", "en-CA": "Combo for two (TEST)" },
    allergens: { status: "Unavailable" },
    orderLabel: { orderNumber: "12", orderType: "DineIn", tableLabel: "T1" },
    customerNote: null,
    selectedOptions: [
      { optionReference: wonton, quantity: 1, localizedNames: { "en-CA": "Wonton soup (TEST)" } },
      { optionReference: rice, quantity: 1, localizedNames: { "en-CA": "Fried rice (TEST)" } },
    ],
    comboParts: [
      { optionReference: wonton, nameZh: "馄饨汤", name: "Wonton soup (TEST)" },
      { optionReference: rice, nameZh: "炒饭", name: "Fried rice (TEST)" },
    ].map((part) => ({ ...part, done: done.has(part.optionReference), served: false })),
    status: completed ? "Completed" : "In Progress",
    requiredQuantity: 1,
    completedQuantity: completed ? 1 : 0,
    workItemCreatedAt: "2026-10-29T00:10:00.000Z",
    acceptedAt: "2026-10-29T00:11:00.000Z",
    orderItemReadyAt: null,
    ticketAggregateVersion: "7",
    workItemVersion: "3",
  });
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [combo()],
        nextCursor: null,
      },
    }),
  );
  const steps: {
    step: string;
    lines: { workItemReference: string; optionReferences: readonly string[] | null }[];
  }[] = [];
  await page.route("**/merchant/kitchen/step", (route) => {
    const body = route.request().postDataJSON() as (typeof steps)[number];
    steps.push(body);
    const [line] = body.lines;
    for (const option of line?.optionReferences ?? [wonton, rice]) done.add(option);
    completed = done.size === 2;
    return route.fulfill({
      headers,
      json: {
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
        occurredAt: at,
        lines: [
          {
            workItemReference: id(1),
            orderItemReference: id(21),
            ticketReference: combo().ticketReference,
            outcome: completed ? "Finished" : "DishDone",
            refusedReason: null,
            ticketVersion: completed ? "8" : "7",
            workItemVersion: completed ? "4" : "3",
            workItemStatus: completed ? "Completed" : "In Progress",
            completedQuantity: completed ? 1 : 0,
            requiredQuantity: 1,
            acceptedAt: "2026-10-29T00:11:00.000Z",
            readyAt: completed ? at : null,
            dishesDone: [...done],
          },
        ],
      },
    });
  });

  await page.goto("/operations/kitchen");
  const card = page.locator(".kitchen-work-item").filter({ hasText: "二人套餐" }).first();
  const dishes = card.getByRole("list", { name: "Dishes in this combo" });
  // Each chosen dish is its own line under the combo, Chinese name first.
  await expect(dishes.locator(".kitchen-work-item__combo-name")).toHaveText(["馄饨汤", "炒饭"]);
  await expect(dishes).toContainText("Wonton soup (TEST)");
  // Each dish has its own Done; the ticket's main step finishes every dish still to make, for the
  // one-screen shop.
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "二人套餐" });
  await expect(ticket.locator(".kitchen-ticket__next")).toHaveText("Finished");
  await expect(dishes.getByRole("button", { name: "Mark 馄饨汤 done" })).toHaveCSS(
    "min-height",
    "48px",
  );
  const axe = await new AxeBuilder({ page }).include(".kitchen-work-item").analyze();
  expect(axe.violations).toEqual([]);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    // Screenshot check at the three widths (kept where COMBO_SHOTS_DIR says, for review).
    await page.screenshot({
      path: process.env.COMBO_SHOTS_DIR
        ? `${process.env.COMBO_SHOTS_DIR}/kitchen-combo-${width}.png`
        : testInfo.outputPath(`kitchen-combo-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await dishes.getByRole("button", { name: "Mark 馄饨汤 done" }).click();
  // Held first, then recorded: that dish only, and the combo stays until its last dish.
  await expect(ticket.locator(".kitchen-ticket__top")).toContainText("Marked done");
  await expect.poll(() => steps.length, { timeout: 8_000 }).toBe(1);
  expect(steps[0]?.step).toBe("Finish");
  expect(steps[0]?.lines[0]?.optionReferences).toEqual([wonton]);
  await expect(dishes.getByRole("button", { name: "Mark 馄饨汤 done" })).toHaveCount(0);
  await expect(dishes.locator("li").first()).toContainText("Done");
  await expect(ticket).toBeVisible();
  // The last dish done finishes the combo in the same step, whichever cook taps it.
  await dishes.getByRole("button", { name: "Mark 炒饭 done" }).click();
  await expect.poll(() => steps.length, { timeout: 8_000 }).toBe(2);
  expect(steps[1]?.lines[0]?.optionReferences).toEqual([rice]);
});

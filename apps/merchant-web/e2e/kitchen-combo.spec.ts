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
  const partCommands: Record<string, string>[] = [];
  await page.route("**/merchant/kitchen/combo-part-done", (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    partCommands.push(body);
    done.add(body.optionReference ?? "");
    return route.fulfill({ headers, json: { allDone: done.size === 2 } });
  });
  const workCommands: Record<string, string>[] = [];
  await page.route("**/merchant/kitchen/work", (route) => {
    const command = route.request().postDataJSON() as Record<string, string>;
    workCommands.push(command);
    completed = true;
    return route.fulfill({
      headers,
      json: {
        action: command.action,
        ticketReference: command.ticketReference,
        workItemReference: command.workItemReference,
        orderItemReference: id(21),
        ticketVersion: "8",
        workItemVersion: "4",
        outcome: "Accepted",
        workItemStatus: "Completed",
        completedQuantity: 1,
        requiredQuantity: 1,
        occurredAt: at,
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
      },
    });
  });

  await page.goto("/operations/kitchen");
  const card = page.locator(".kitchen-work-item").filter({ hasText: "二人套餐" }).first();
  const dishes = card.getByRole("list", { name: "Dishes in this combo" });
  // Each chosen dish is its own line under the combo, Chinese name first.
  await expect(dishes.locator(".kitchen-work-item__combo-name")).toHaveText(["馄饨汤", "炒饭"]);
  await expect(dishes).toContainText("Wonton soup (TEST)");
  // The combo is not finished while a dish is still being made: not on the card, not by the
  // ticket's own step.
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "二人套餐" });
  await expect(ticket.getByRole("button", { name: /finish/iu })).toHaveCount(0);
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
  await expect(dishes.getByRole("button", { name: "Mark 馄饨汤 done" })).toHaveCount(0);
  await expect(dishes.locator("li").first()).toContainText("Done");
  await expect(ticket.getByRole("button", { name: /finish/iu })).toHaveCount(0);
  expect(workCommands).toEqual([]);
  // The last dish done finishes the combo with the kitchen's own step.
  await dishes.getByRole("button", { name: "Mark 炒饭 done" }).click();
  await expect.poll(() => workCommands.map((c) => c.action)).toEqual(["CompleteKitchenWorkItem"]);
  expect(workCommands[0]?.workItemReference).toBe(id(1));
  expect(partCommands.map((c) => c.optionReference)).toEqual([wonton, rice]);
  expect(new Set(partCommands.map((c) => c.operationReference)).size).toBe(2);
});

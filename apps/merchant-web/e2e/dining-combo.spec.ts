import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

test("@production a combo is served dish by dish; the last dish serves the combo", async ({
  page,
}) => {
  const id = (n: number) => "01a0f0d0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
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
          businessDate: "2026-09-14",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );

  // WP-2423 item 8 ⑥ part 4 (decision 3): the soup is made, the rice is still being made.
  const done = new Set(["wonton"]);
  const served = new Set<string>();
  let committed = false;
  const partCalls: Record<string, string>[] = [];
  const serveCalls: Record<string, unknown>[] = [];
  const option = (key: string) => (key === "wonton" ? id(61) : id(62));
  const phase = () => (committed ? "Fulfilled" : done.size === 2 ? "Ready" : "InProgress");
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-12",
            orderType: "DineIn",
            sourceChannel: "Web",
            submittedAt: "2026-09-14T00:00:00.000Z",
            observedAt: "2026-09-14T00:01:00.000Z",
            initialBatchReference: id(90),
            batches: [
              {
                orderBatchReference: id(90),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: phase(),
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderVersion: 2,
        sessionVersion: 2,
        diningSessionReference: id(55),
        sessionPhase: "Active",
        tableAssignmentVersion: 3,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        tableLabel: "T1",
        phase: phase(),
        observedAt: "2026-09-14T00:01:00.000Z",
        items: [
          {
            orderItemReference: id(3),
            orderBatchReference: id(90),
            displayName: "二人套餐",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: phase(),
            orderedQuantity: 1,
            deliveredQuantity: committed ? 1 : 0,
            remainingQuantity: committed ? 0 : 1,
            itemServiceVersion: committed ? 1 : 0,
            comboParts: [
              ["wonton", "馄饨汤", "Wonton soup (TEST)"],
              ["rice", "炒饭", "Fried rice (TEST)"],
            ].map(([key, nameZh, name]) => ({
              optionReference: option(key ?? ""),
              nameZh,
              name,
              done: done.has(key ?? ""),
              served: served.has(key ?? ""),
            })),
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/combo-part-served", (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    partCalls.push(body);
    served.add(body.optionReference === id(61) ? "wonton" : "rice");
    return route.fulfill({ headers, json: { allServed: served.size === 2 } });
  });
  await page.route("**/merchant/dining/serve", (route) => {
    serveCalls.push(route.request().postDataJSON() as Record<string, unknown>);
    committed = true;
    return route.fulfill({ headers, json: { status: "Committed", itemServiceVersion: 1 } });
  });
  await page.goto("/operations/orders");
  const round = page.getByRole("region", { name: "Round 1", exact: true });
  const dishes = round.getByRole("list", { name: "Dishes in this combo" });
  await expect(dishes.locator("li")).toHaveText([/馄饨汤.*Ready to serve/u, /炒饭.*Being made/u]);
  // The combo itself is served by its dishes: no "Mark served" for the whole line yet.
  await expect(round.getByRole("button", { name: /Mark 1 × 二人套餐 served/u })).toHaveCount(0);
  await expect(dishes.getByRole("button", { name: "Mark 炒饭 served" })).toHaveCount(0);
  // The combo's dishes (the orders page's own row heading order is checked elsewhere).
  const axe = await new AxeBuilder({ page }).include(".dining-round-item__combo").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await round.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: process.env.COMBO_SHOTS_DIR
        ? `${process.env.COMBO_SHOTS_DIR}/serving-combo-${width}.png`
        : test.info().outputPath(`serving-combo-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The soup goes out first.
  await dishes.getByRole("button", { name: "Mark 馄饨汤 served" }).click();
  await expect(dishes.locator("li").first()).toContainText("Served");
  expect(serveCalls).toEqual([]);
  // The kitchen finishes the rice; serving it serves the combo with the serving step.
  done.add("rice");
  await page.getByRole("button", { name: "Refresh orders", exact: true }).click();
  await dishes.getByRole("button", { name: "Mark 炒饭 served" }).click();
  await expect.poll(() => serveCalls.length).toBe(1);
  expect(serveCalls[0]).toMatchObject({ orderItemReference: id(3), quantity: 1 });
  expect(partCalls.map((c) => [c.orderReference, c.orderItemReference, c.optionReference])).toEqual(
    [
      [id(1), id(3), id(61)],
      [id(1), id(3), id(62)],
    ],
  );
  await expect(dishes.locator("li")).toHaveText([/馄饨汤.*Served/u, /炒饭.*Served/u]);
  await expect(dishes.getByRole("button")).toHaveCount(0);
});

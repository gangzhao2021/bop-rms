import { expect, test } from "@playwright/test";

/**
 * Kitchen v3 (Owner 2026-10-26): one main step per ticket. "Accept all" on a ticket of two dishes
 * records two steps, one per dish, one after the other: the second expects the ticket version the
 * server confirmed for the first, so it is never refused as out of date.
 */
const id = (n: number) => "01a0f027-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-26T22:14:00.000Z";
const dish = (n: number, name: string) => ({
  workItemReference: id(n),
  ticketReference: id(50),
  orderReference: id(51),
  orderItemReference: id(n + 20),
  stationReference: id(52),
  localizedDisplayNames: { "en-CA": name },
  allergens: { status: "Unavailable" },
  orderLabel: { orderNumber: "5", orderType: "Pickup", tableLabel: null },
  customerNote: null,
  selectedOptions: [],
  status: "Queued",
  requiredQuantity: 1,
  completedQuantity: 0,
  workItemCreatedAt: "2026-10-26T22:12:00.000Z",
  acceptedAt: null,
  orderItemReadyAt: null,
  ticketAggregateVersion: "7",
  workItemVersion: "2",
});

test("@production a ticket's one main step accepts each of its dishes in turn", async ({
  page,
}) => {
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
          businessDate: "2026-10-26",
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
  const items = [dish(1, "TEST latte"), dish(2, "TEST mocha")];
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        // Synthetic interaction state only (named operator), as in the kitchen queue spec.
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items,
        nextCursor: null,
      },
    }),
  );
  const commands: Record<string, string>[] = [];
  await page.route("**/merchant/kitchen/work", (route) => {
    const command = route.request().postDataJSON() as Record<string, string>;
    commands.push(command);
    const current = items.find((entry) => entry.workItemReference === command.workItemReference);
    return route.fulfill({
      headers,
      json: {
        action: command.action,
        ticketReference: command.ticketReference,
        workItemReference: command.workItemReference,
        orderItemReference: current?.orderItemReference,
        ticketVersion: (BigInt(command.expectedTicketVersion ?? "0") + 1n).toString(),
        workItemVersion: (BigInt(command.expectedWorkItemVersion ?? "0") + 1n).toString(),
        outcome: "Accepted",
        workItemStatus: "Queued",
        completedQuantity: 0,
        requiredQuantity: 1,
        occurredAt: at,
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
      },
    });
  });
  await page.goto("/operations/kitchen");
  const ticket = page.locator(".kitchen-ticket").filter({ hasText: "TEST latte" });
  await expect(ticket.locator(".kitchen-ticket__state")).toHaveText("To accept");
  // Each dish offers no step of its own while it waits; the ticket has the one.
  await expect(ticket.getByRole("button")).toHaveText(["Accept all"]);
  await ticket.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect(ticket.getByRole("button", { name: "Start all", exact: true })).toBeEnabled();
  await expect(ticket.getByRole("button", { name: "Start all", exact: true })).toBeFocused();
  expect(
    commands.map((command) => [command.workItemReference, command.expectedTicketVersion]),
  ).toEqual([
    [id(1), "7"],
    [id(2), "8"],
  ]);
  expect(new Set(commands.map((command) => command.idempotencyKey)).size).toBe(2);
  await expect(ticket.locator(".kitchen-ticket__state")).toHaveText("In progress");
  // 1-2 m from the screen: the number is large and the step is a 48px+ target.
  await expect(ticket.locator(".kitchen-ticket__number")).toHaveCSS("font-size", "32px");
  const box = await ticket.getByRole("button", { name: "Start all", exact: true }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(48);
});

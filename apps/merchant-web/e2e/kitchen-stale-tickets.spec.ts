import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS: order numbers restart every business day, so a kitchen ticket
 * left open from an earlier day looks like today's ticket with the same number. The board keeps it
 * in a collapsed "From earlier days — check and close" section with its day and age, asks before
 * any kitchen step on it, and lets a manager close it with a reason (no refund, no Order change).
 */
const id = (n: number) => "01a0f027-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-14T18:00:00.000Z";

const item = (n: number, overrides: Record<string, unknown>) => ({
  workItemReference: id(n),
  ticketReference: id(n + 1),
  orderReference: id(n + 2),
  orderItemReference: id(n + 3),
  stationReference: id(5),
  localizedDisplayNames: { "en-CA": "Beef noodle soup" },
  allergens: { status: "Unavailable" },
  orderLabel: { orderNumber: "2", orderType: "Pickup", tableLabel: null },
  customerNote: null,
  selectedOptions: [],
  status: "Queued",
  requiredQuantity: 1,
  completedQuantity: 0,
  workItemCreatedAt: "2026-10-14T17:50:00.000Z",
  acceptedAt: null,
  orderItemReadyAt: null,
  ticketAggregateVersion: "3",
  workItemVersion: "2",
  businessDate: "2026-10-14",
  ...overrides,
});

async function board(page: Page, canClose: boolean) {
  // Ticket ages follow the device clock; pin it to the board's time so "waiting 4 days" is stable.
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
          businessDate: "2026-10-14",
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
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-14",
        startsAt: "2026-10-14T08:00:00.000Z",
        endsAt: "2026-10-15T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: at,
      },
    }),
  );
  // Today's Order 2 and the Order 2 of Fri, Oct 9 that was never cleared from the board.
  const today = item(0x10, {});
  const old = item(0x20, {
    localizedDisplayNames: { "en-CA": "Pork dumplings" },
    workItemCreatedAt: "2026-10-09T22:00:00.000Z",
    businessDate: "2026-10-09",
    ticketAggregateVersion: "4",
  });
  let closed = false;
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
        canCloseEarlierDayTickets: canClose,
        items: closed ? [today] : [today, old],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({
      headers,
      json: { storeReference: scope.storeReference, observedAt: at, canRework: false, items: [] },
    }),
  );
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/kitchen/work", (route) => {
    commands.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ headers, status: 409, json: { error: "KITCHEN_WORK_CONFLICT" } });
  });
  const closes: Record<string, unknown>[] = [];
  await page.route("**/merchant/kitchen/stale-ticket/close", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    closes.push(body);
    expect(body).not.toHaveProperty("actorReference");
    expect(body).not.toHaveProperty("storeReference");
    expect(body).not.toHaveProperty("orderBusinessDate");
    closed = true;
    return route.fulfill({
      headers,
      json: {
        status: "Closed",
        ticketReference: body.ticketReference,
        reasonCode: body.reasonCode,
        foodMade: false,
        orderBusinessDate: "2026-10-09",
        closedAt: at,
      },
    });
  });
  return { commands, closes, old };
}

async function expectLayout(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByText("From earlier days — check and close")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
}

test("@production DEC-KITCHEN-STALE-TICKETS: an earlier day's ticket is kept apart, asks before a kitchen step and a manager closes it with a reason", async ({
  page,
}) => {
  const { commands, closes, old } = await board(page, true);
  await page.goto("/operations/kitchen");
  // Today's Order 2 is on the board; the earlier one is collapsed apart.
  const lanes = page.locator(".kitchen-board-lanes").last();
  await expect(lanes.getByText("Beef noodle soup")).toBeVisible();
  await expect(lanes.getByText("Pork dumplings")).toHaveCount(0);
  const earlier = page.locator("details.kitchen-earlier-days");
  await expect(earlier).not.toHaveAttribute("open", "");
  await expect(earlier.getByText("1 ticket")).toBeVisible();
  await expect(page.getByText("Pork dumplings")).toBeHidden();
  await earlier.getByText("From earlier days — check and close").click();
  const ticket = page.getByRole("region", { name: "Order 2 · Pickup, From Fri, Oct 9" });
  await expect(ticket.getByText("From Fri, Oct 9")).toBeVisible();
  await expect(ticket.getByText("waiting 4 days")).toBeVisible();
  await expect(ticket.getByText("Pork dumplings")).toBeVisible();
  await expectLayout(page, "kitchen-earlier-days");

  // A kitchen step on it asks first; going back sends nothing.
  await ticket.getByRole("button", { name: "Accept" }).click();
  const confirm = page.getByRole("dialog", { name: "This ticket is from Fri, Oct 9 — continue?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText("is not today's order with the same number")).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(confirm.getByRole("button", { name: "Continue — Accept" })).toBeInViewport();
    await page.screenshot({ path: `test-results/kitchen-earlier-confirm-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await confirm.getByRole("button", { name: "Go back" }).click();
  await expect(confirm).toBeHidden();
  expect(commands).toEqual([]);
  // Continuing sends exactly that step for the old ticket.
  await ticket.getByRole("button", { name: "Accept" }).click();
  await confirm.getByRole("button", { name: "Continue — Accept" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ workItemReference: old.workItemReference });

  // The manager closes it as never made; the dialog says plainly that nothing is refunded.
  await page.reload();
  await page.locator("details.kitchen-earlier-days").getByText("From earlier days").click();
  await page.getByRole("button", { name: "Close ticket" }).click();
  const dialog = page.getByRole("dialog", { name: "Close Order 2 · Pickup from Fri, Oct 9?" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("does not refund or cancel the order", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Orders" })).toHaveAttribute(
    "href",
    "/operations/orders",
  );
  const submit = dialog.getByRole("button", { name: "Close ticket" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Not made — order abandoned").check();
  await expect(dialog.getByText("Nothing is recorded as used", { exact: false })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(submit).toBeInViewport();
    await page.screenshot({ path: `test-results/kitchen-close-ticket-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await submit.click();
  await expect(page.getByRole("heading", { name: "Ticket closed" })).toBeVisible();
  await expect(page.getByText("cancel or refund it in Orders", { exact: false })).toBeVisible();
  expect(closes).toEqual([
    expect.objectContaining({
      ticketReference: old.ticketReference,
      expectedTicketVersion: "4",
      reasonCode: "NOT_MADE_ABANDONED",
    }),
  ]);
  await expect(page.locator("details.kitchen-earlier-days")).toHaveCount(0);
  await expect(
    page.locator(".kitchen-board-lanes").last().getByText("Beef noodle soup"),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test("@production DEC-KITCHEN-STALE-TICKETS: kitchen staff see earlier days apart but cannot close them", async ({
  page,
}) => {
  await board(page, false);
  await page.goto("/operations/kitchen");
  await page.locator("details.kitchen-earlier-days").getByText("From earlier days").click();
  await expect(page.getByText("Ask a manager to check and close them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close ticket" })).toHaveCount(0);
  // WP-2423: one order search covers the earlier days too, and says how many it found there.
  const search = page.locator(".kitchen-reference-search--desktop");
  const summary = page.locator("details.kitchen-earlier-days summary");
  await search.getByRole("searchbox", { name: "Order number or table" }).fill("2");
  await search.getByRole("button", { name: "Find" }).click();
  await expect(summary).toContainText("1 ticket from an earlier day has number or table “2”");
  await search.getByRole("searchbox", { name: "Order number or table" }).fill("9");
  await search.getByRole("button", { name: "Find" }).click();
  await expect(page.locator("details.kitchen-earlier-days")).toHaveCount(0);
  await expect(page.getByText("Nothing on the board for order or table “9”.")).toBeVisible();
});

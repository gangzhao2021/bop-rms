import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 Q26 (Handoff Section 26.6): the kitchen remakes a finished dish that was dropped, made
 * wrong or sent back; the original keeps its result and the remake is its own, clearly marked
 * ticket. A dish marked done by mistake goes back in progress within two minutes.
 */
const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-14T18:00:00.000Z";
const readyAt = "2026-10-14T17:59:00.000Z";

async function board(page: Page) {
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
  const item = {
    workItemReference: id(1),
    ticketReference: id(2),
    orderReference: id(3),
    orderItemReference: id(4),
    stationReference: id(5),
    localizedDisplayNames: { "en-CA": "Beef noodle soup" },
    allergens: { status: "Unavailable" },
    orderLabel: { orderNumber: "21", orderType: "DineIn", tableLabel: "T4" },
    customerNote: null,
    selectedOptions: [],
    status: "Completed",
    requiredQuantity: 2,
    completedQuantity: 2,
    workItemCreatedAt: "2026-10-14T17:40:00.000Z",
    acceptedAt: "2026-10-14T17:41:00.000Z",
    orderItemReadyAt: readyAt,
    ticketAggregateVersion: "7",
    workItemVersion: "4",
  };
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
        items: [item],
        nextCursor: null,
      },
    }),
  );
  let reworks: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  await page.route("**/merchant/kitchen/rework/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        observedAt: at,
        canRework: true,
        items: reworks,
      },
    }),
  );
  await page.route("**/merchant/kitchen/rework/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    expect(body).not.toHaveProperty("actorReference");
    expect(body).not.toHaveProperty("storeReference");
    let rework: Record<string, unknown>;
    if (body.action === "CreateKitchenRework") {
      rework = {
        reworkReference: id(10 + reworks.length),
        originalWorkItemReference: body.originalWorkItemReference,
        orderReference: item.orderReference,
        orderItemReference: item.orderItemReference,
        reasonCode: body.reasonCode,
        note: body.note,
        quantity: body.quantity,
        wasteApplies: body.reasonCode !== "NOT_READY",
        status: body.reasonCode === "NOT_READY" ? "In Progress" : "Queued",
        version: 1,
        createdAt: at,
        startedAt: body.reasonCode === "NOT_READY" ? at : null,
        completedAt: null,
        displayName: "Beef noodle soup",
        selectedOptions: [],
        orderLabel: item.orderLabel,
        customerNote: null,
        allergens: { status: "Unavailable" },
      };
      reworks = [rework, ...reworks];
    } else {
      const current = reworks.find((entry) => entry.reworkReference === body.reworkReference);
      if (!current)
        return route.fulfill({ headers, status: 404, json: { error: "KITCHEN_REWORK_NOT_FOUND" } });
      rework =
        body.action === "CancelKitchenRework"
          ? {
              ...current,
              version: Number(current.version) + 1,
              status: "Cancelled",
              cancelledAt: at,
              cancelReasonCode: body.cancelReasonCode,
            }
          : {
              ...current,
              version: Number(current.version) + 1,
              status: body.action === "StartKitchenRework" ? "In Progress" : "Completed",
              ...(body.action === "StartKitchenRework" ? { startedAt: at } : { completedAt: at }),
            };
      reworks = reworks.map((entry) =>
        entry.reworkReference === body.reworkReference ? rework : entry,
      );
    }
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        action: body.action,
        rework: { ...rework, displayName: null, selectedOptions: [] },
      },
    });
  });
  return commands;
}

async function expectLayout(page: Page, name: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("region", { name: "Remakes" })).toBeVisible();
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

test("@production WP-2423 Q26: the kitchen remakes a dropped dish and puts a dish marked done too early back in progress", async ({
  page,
}) => {
  const commands = await board(page);
  await page.goto("/operations/kitchen");
  const recent = page.getByText("Recently finished · 1");
  await expect(recent).toBeVisible();
  await recent.click();
  await page.getByRole("button", { name: "Remake Beef noodle soup, Table T4 · Order 21" }).click();

  const dialog = page.getByRole("dialog", { name: "Remake Beef noodle soup" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Not ready yet — marked done by mistake")).toBeVisible();
  const send = dialog.getByRole("button", { name: "Send remake" });
  await expect(send).toBeDisabled();
  await dialog.getByLabel("Dropped").check();
  await dialog.getByLabel("How many to remake (of 2)").fill("1");
  await dialog.getByLabel("Note for the kitchen (optional)").fill("Slipped off the pass");
  await expect(dialog.getByText("The guest is not charged again", { exact: false })).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(send).toBeInViewport();
    await page.screenshot({ path: `test-results/kitchen-remake-dialog-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await send.click();
  await expect(page.getByRole("heading", { name: "Remake sent to the kitchen" })).toBeVisible();
  expect(commands[0]).toMatchObject({
    action: "CreateKitchenRework",
    originalWorkItemReference: id(1),
    reasonCode: "DROPPED",
    note: "Slipped off the pass",
    quantity: 1,
  });

  const lane = page.getByRole("region", { name: "Remakes" });
  await expect(lane.getByText("Remake · Dropped")).toBeVisible();
  await expect(lane.getByText("Table T4 · Order 21")).toBeVisible();
  await expect(lane.getByText("Slipped off the pass")).toBeVisible();
  await expect(lane).not.toContainText("DROPPED");
  await expectLayout(page, "kitchen-remake-lane");

  await lane.getByRole("button", { name: "Start remake" }).click();
  await expect(lane.getByRole("button", { name: "Remake done" })).toBeVisible();
  await lane.getByRole("button", { name: "Remake done" }).click();
  await expect(lane).toHaveCount(0);
  expect(commands.map((command) => [command.action, command.expectedVersion])).toEqual([
    ["CreateKitchenRework", undefined],
    ["StartKitchenRework", 1],
    ["CompleteKitchenRework", 2],
  ]);

  // Marked done by mistake: back in progress, nothing wasted.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Remake Beef noodle soup, Table T4 · Order 21" }).click();
  await dialog.getByLabel("Not ready yet — marked done by mistake").check();
  await expect(dialog.getByText("Nothing is recorded as waste", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Put back in progress" }).click();
  await expect(
    page.getByText("The dish is back in progress. Nothing was recorded as waste."),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Remakes" })
      .getByText("Back in progress · Marked done too early"),
  ).toBeVisible();
  expect(commands[3]).toMatchObject({
    action: "CreateKitchenRework",
    reasonCode: "NOT_READY",
    quantity: 2,
  });
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({
    local: 0,
    session: 0,
  });
});

test("@production WP-2423 Q26: past two minutes a dish can no longer be put back in progress", async ({
  page,
}) => {
  await board(page);
  await page.route("**/merchant/kitchen/rework/command", (route) =>
    route.fulfill({ headers, status: 422, json: { error: "KITCHEN_REWORK_WINDOW_CLOSED" } }),
  );
  await page.goto("/operations/kitchen");
  await page.getByText("Recently finished · 1").click();
  await page.getByRole("button", { name: "Remake Beef noodle soup, Table T4 · Order 21" }).click();
  const dialog = page.getByRole("dialog", { name: "Remake Beef noodle soup" });
  await dialog.getByLabel("Not ready yet — marked done by mistake").check();
  await dialog.getByRole("button", { name: "Put back in progress" }).click();
  await expect(page.getByRole("heading", { name: "Remake not recorded" })).toBeVisible();
  await expect(page.getByText("More than two minutes have passed", { exact: false })).toBeVisible();
});

test("@production WP-2423 (2026-10-18): a remake opened by mistake or no longer wanted is cancelled and leaves the board", async ({
  page,
}) => {
  const commands = await board(page);
  await page.goto("/operations/kitchen");
  await page.getByText("Recently finished · 1").click();
  await page.getByRole("button", { name: "Remake Beef noodle soup, Table T4 · Order 21" }).click();
  const create = page.getByRole("dialog", { name: "Remake Beef noodle soup" });
  await create.getByLabel("Made wrong").check();
  await create.getByRole("button", { name: "Send remake" }).click();
  await expect(page.getByRole("heading", { name: "Remake sent to the kitchen" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();

  const lane = page.getByRole("region", { name: "Remakes" });
  await lane
    .getByRole("button", { name: "Cancel remake of Beef noodle soup, Table T4 · Order 21" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Cancel remake of Beef noodle soup" });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Cancel remake" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Guest doesn't want it any more").check();
  await expect(dialog.getByText("stays recorded as waste", { exact: false })).toBeVisible();
  await dialog.getByLabel("Opened by mistake").check();
  await expect(
    dialog.getByText("its ingredients go back to stock", { exact: false }),
  ).toBeVisible();
  await expect(dialog).not.toContainText("OPENED_BY_MISTAKE");
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(confirm).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/kitchen-remake-cancel-dialog-${width}.png` });
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
  await confirm.click();
  await expect(page.getByRole("heading", { name: "Remake cancelled" })).toBeVisible();
  await expect(
    page.getByText("Anything recorded as waste for it is put back in stock.", { exact: false }),
  ).toBeVisible();
  await expect(lane).toHaveCount(0);
  await expectNoInternalText(page);
  expect(commands[1]).toMatchObject({
    action: "CancelKitchenRework",
    expectedVersion: 1,
    cancelReasonCode: "OPENED_BY_MISTAKE",
  });
  // The board offers the remake again for the same dish.
  await expect(page.getByText("Recently finished · 1")).toBeVisible();
});

test("@production WP-2423 (2026-10-18): a cancellation whose answer was lost is retried as the same request", async ({
  page,
}) => {
  const commands = await board(page);
  await page.goto("/operations/kitchen");
  await page.getByText("Recently finished · 1").click();
  await page.getByRole("button", { name: "Remake Beef noodle soup, Table T4 · Order 21" }).click();
  await page.getByRole("dialog", { name: "Remake Beef noodle soup" }).getByLabel("Dropped").check();
  await page.getByRole("button", { name: "Send remake" }).click();
  await page.getByRole("button", { name: "Dismiss" }).click();
  let lost = true;
  await page.route("**/merchant/kitchen/rework/command", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "CancelKitchenRework" && lost) {
      lost = false;
      commands.push(body);
      return route.abort("connectionreset");
    }
    return route.fallback();
  });
  await page
    .getByRole("region", { name: "Remakes" })
    .getByRole("button", { name: "Cancel remake of Beef noodle soup, Table T4 · Order 21" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Cancel remake of Beef noodle soup" });
  await dialog.getByLabel("Guest doesn't want it any more").check();
  await dialog.getByRole("button", { name: "Cancel remake" }).click();
  await expect(page.getByRole("heading", { name: "Remake result unknown" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same cancellation" }).click();
  await expect(page.getByRole("heading", { name: "Remake cancelled" })).toBeVisible();
  await expect(page.getByText("The first dish stays recorded as waste.")).toBeVisible();
  const cancels = commands.filter((command) => command.action === "CancelKitchenRework");
  expect(cancels).toHaveLength(2);
  expect(cancels[1]).toEqual(cancels[0]);
});

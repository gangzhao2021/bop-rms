import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * DEC-TABLE-CLOSE-GUESTS-LEFT (WP-2423): a manager closes a table whose guests left. The close
 * dialog lists every round still open in staff words with the refunds, cancels them with the
 * existing staff cancellations (reason "Guests left"), and then closes the table as usual.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

async function floor(page: Page, session = { phase: "Active", version: 19 }) {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-15",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T2",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 4 * 24 * 60,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            session: { ...session, orderReference: id(3) },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
}

const progressItem = (n: number, batch: number, sequence: number, phase: string) => ({
  orderItemReference: id(100 + n),
  orderBatchReference: id(batch),
  displayName: "Latte",
  batchSequence: sequence,
  itemOrdinal: 1,
  phase,
  orderedQuantity: 1,
  deliveredQuantity: 0,
  remainingQuantity: 1,
  itemServiceVersion: 0,
});
const progress = (phase: string, items: unknown[], orderVersion = 19) => ({
  orderReference: id(3),
  tableLabel: "T2",
  diningSessionReference: id(2),
  sessionPhase: "Active",
  closureStatus: "Open",
  closureVersion: 0,
  currentOrderVersion: orderVersion,
  sessionVersion: 19,
  tableAssignmentVersion: 1,
  orderVersion,
  phase,
  observedAt: "2026-10-15T19:00:00.000Z",
  items,
});
const planRound = (
  batch: number,
  sequence: number,
  state: string,
  refund: null | { method: string; amountMinor: string },
) => ({
  orderBatchReference: id(batch),
  sequence,
  state,
  openItemCount: 1,
  startedItemCount: 0,
  cancellableItemReferences: [],
  refund,
  cancelsAt: null,
});

test("@production a manager closes out a table whose guests left: rounds cancelled with refunds shown first, then the table closes", async ({
  page,
}) => {
  await floor(page);
  let resolved = 0;
  let orderVersion = 19;
  const cancels: Record<string, unknown>[] = [];
  const closing: Record<string, unknown>[] = [];
  const rounds = () =>
    [
      planRound(21, 1, "AlreadyRefunded", { method: "Online", amountMinor: "0" }),
      planRound(24, 4, "PaidNotSent", { method: "Online", amountMinor: "1130" }),
      planRound(29, 9, "NotStarted", { method: "CardMachine", amountMinor: "593" }),
      // v15 DEMO-02 round 16: refunded in full on the card machine item by item already.
      planRound(30, 10, "NotStarted", { method: "CardMachine", amountMinor: "0" }),
    ].slice(resolved);
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json:
        resolved < 4
          ? progress(
              "Accepted",
              [
                progressItem(1, 21, 1, "Submitted"),
                progressItem(4, 24, 4, "Submitted"),
                progressItem(9, 29, 9, "Accepted"),
                progressItem(10, 30, 10, "Accepted"),
              ],
              orderVersion,
            )
          : progress(
              "Cancelled",
              [
                { ...progressItem(1, 21, 1, "Cancelled") },
                { ...progressItem(4, 24, 4, "Cancelled") },
                { ...progressItem(9, 29, 9, "Cancelled") },
                { ...progressItem(10, 30, 10, "Cancelled") },
              ],
              orderVersion,
            ),
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) => {
    expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({
      orderReference: id(3),
      diningSessionReference: id(2),
    });
    const left = rounds();
    return route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: left,
        closeBlockers: [],
        totals: {
          onlineMinor: left.some((round) => round.state === "PaidNotSent") ? "1130" : "0",
          cardMachineMinor: left.some((round) => round.orderBatchReference === id(29))
            ? "593"
            : "0",
        },
      },
    });
  });
  await page.route("**/merchant/orders/cancel", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    cancels.push(body);
    // The answer for the second round is lost: the same operation is sent again.
    if (cancels.length === 2) return route.abort("failed");
    resolved += 1;
    orderVersion += 1;
    return route.fulfill({
      headers,
      json: {
        status: "Cancelled",
        orderReference: id(3),
        orderBatchReference: body.orderBatchReference,
        cancelledAt: "2026-10-15T19:01:00.000Z",
        refundStatus: "Pending",
        refundMethod: "Online",
        refundAmountMinor: null,
      },
    });
  });
  await page.route("**/merchant/dining/closing", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    closing.push(body);
    return route.fulfill({
      headers,
      json:
        body.action === "Begin"
          ? { status: "Applied", phase: "Closing", sessionVersion: 20 }
          : { status: "Applied", phase: "Closed", sessionVersion: 21 },
    });
  });
  await page.route("**/merchant/orders/close", (route) => {
    closing.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: { status: "Committed", closureVersion: 1, closedOrderVersion: orderVersion },
    });
  });

  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const dialog = page.getByRole("region", { name: "Close this table" });
  const guests = dialog.getByRole("region", { name: "Guests have left" });
  await expect(guests).toContainText(
    "Round 1: never sent to the kitchen and already refunded in full. It will be closed; nothing more is refunded.",
  );
  await expect(guests).toContainText(
    "Round 4: paid CAD 11.30 online but never sent to the kitchen. It will be cancelled and the guest refunded.",
  );
  await expect(guests).toContainText(
    "Round 9: 1 item not started in the kitchen. It will be cancelled; then refund CAD 5.93 on the card machine",
  );
  await expect(guests).toContainText(
    "Round 10: 1 item not started in the kitchen, already refunded in full. It will be cancelled; nothing is left to refund.",
  );
  await expect(guests).not.toContainText("CAD 0.00");
  await expect(guests).toContainText(
    "refunds CAD 11.30 to the guest online and CAD 5.93 to refund on the card machine",
  );
  await expect(dialog.getByRole("button", { name: /^Close table/u })).toHaveCount(0);
  const confirm = guests.getByRole("button", { name: "Cancel 4 rounds and refund", exact: true });
  await expect(confirm).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(guests).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dining-guests-left-${width}.png`, fullPage: true });
  }
  // The table-state filter offers "Temporarily unavailable" (a blocked table), not a stub.
  await expectNoInternalText(page, ["Temporarily unavailable"]);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual(
    [],
  );

  await guests.getByRole("checkbox", { name: "The guests at table T2 have left" }).check();
  await confirm.click();
  // The lost answer: retry resends the same operation; nothing is done twice.
  const retry = guests.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  await expect(guests).toContainText("nothing is cancelled or refunded twice");
  // The list is read again after the failed step: round 1, already closed out, is gone.
  await expect(guests).toContainText("Round 4: paid CAD 11.30 online");
  await expect(guests).not.toContainText("Round 1:");
  await retry.click();
  await expect(dialog.getByRole("button", { name: "Close table T2", exact: true })).toBeVisible();
  expect(cancels).toHaveLength(5);
  expect(cancels[2]).toEqual(cancels[1]);
  expect(cancels.map((body) => [body.orderBatchReference, body.expectedOrderVersion])).toEqual([
    [id(21), 19],
    [id(24), 20],
    [id(24), 20],
    [id(29), 21],
    [id(30), 22],
  ]);
  for (const body of cancels) expect(body.reasonCode).toBe("GUEST_LEFT");

  // The table then closes as usual; its fully cancelled order is closed as cancelled.
  await dialog.getByRole("checkbox", { name: "The guests at table T2 have left" }).check();
  await dialog.getByRole("button", { name: "Close table T2", exact: true }).click();
  await expect(page.getByText("Table T2 is closed and free for the next party.")).toBeVisible();
  expect(closing.map((body) => body.action ?? body.reasonCode)).toEqual([
    "Begin",
    "ORDER_CANCELLED",
    "Finalize",
  ]);
});

test("@production a table whose order is no longer found says so instead of blaming the connection", async ({
  page,
}) => {
  await floor(page);
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({ status: 404, headers, json: { error: "dining_order_progress_unavailable" } }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({ status: 404, headers, json: { error: "dining_table_close_plan_not_found" } }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  await expect(
    page.getByText(
      "This table's order wasn't found at this store. Refresh the tables and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/Check the connection/u)).toHaveCount(0);
});

test("@production B759: a table left in Closing names what still stops it, then closing continues from there", async ({
  page,
}) => {
  // v15 DEMO-02: every round cancelled and refunded, the session already Closing (v20), the
  // order still open. The close dialog says what the server's close evaluation still waits for,
  // never an empty list or a permission message; once resolved, Close continues from Closing.
  await floor(page, { phase: "Closing", version: 20 });
  let blockers = ["REFUND_PENDING"];
  let closeAnswers = 0;
  const closing: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        ...progress("Cancelled", [{ ...progressItem(1, 21, 1, "Cancelled") }], 38),
        sessionPhase: "Closing",
        sessionVersion: 20,
      },
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 38,
        observedAt: "2026-10-15T19:00:00.000Z",
        rounds: [],
        closeBlockers: blockers,
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/orders/close", (route) => {
    closing.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    closeAnswers += 1;
    return closeAnswers === 1
      ? route.fulfill({
          status: 409,
          headers,
          json: { error: "order_not_ready", reasons: ["REFUND_PENDING"] },
        })
      : route.fulfill({
          headers,
          json: { status: "Committed", closureVersion: 1, closedOrderVersion: 38 },
        });
  });
  await page.route("**/merchant/dining/closing", (route) => {
    closing.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    return route.fulfill({
      headers,
      json: { status: "Applied", phase: "Closed", sessionVersion: 21 },
    });
  });

  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T2", exact: true }).click();
  const dialog = page.getByRole("region", { name: "Close this table" });
  await expect(dialog).toContainText("This table can't be closed yet:");
  await expect(dialog.getByRole("listitem")).toContainText([
    "A refund is still being made (online, or not yet recorded as refunded on the card machine).",
  ]);
  await expect(dialog.getByRole("button", { name: /^Close table/u })).toHaveCount(0);
  await expectNoInternalText(page, ["Temporarily unavailable"]);

  // The refund is made; checking again offers Close. A refusal still names why, not access.
  blockers = [];
  await dialog.getByRole("button", { name: "Check again", exact: true }).click();
  const close = dialog.getByRole("button", { name: "Close table T2", exact: true });
  await expect(close).toBeVisible();
  await expect(dialog).not.toContainText("can't be closed yet");
  await dialog.getByRole("checkbox", { name: "The guests at table T2 have left" }).check();
  await close.click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("The table wasn't closed yet:");
  await expect(alert).toContainText("A refund is still being made");
  await expect(page.getByText(/access doesn't allow/u)).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dining-b759-closing-${width}.png`, fullPage: true });
  }
  await dialog.getByRole("checkbox", { name: "The guests at table T2 have left" }).check();
  await dialog.getByRole("button", { name: "Close table T2", exact: true }).click();
  await expect(page.getByText("Table T2 is closed and free for the next party.")).toBeVisible();
  // No new Begin: the order close, then Finalize at the Closing session's version.
  expect(closing.map((body) => body.action ?? body.reasonCode)).toEqual([
    "ORDER_CANCELLED",
    "ORDER_CANCELLED",
    "Finalize",
  ]);
  expect(closing[2]).toMatchObject({ expectedSessionVersion: 20 });
});

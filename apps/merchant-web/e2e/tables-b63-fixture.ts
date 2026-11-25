import type { Locator, Page } from "@playwright/test";

/**
 * b63 (design review of v15 batch 62, bundle E): one Tables floor for the bundle's specs — T2 paying
 * at the end (seated, checking out or paid) and a free table F1 that can be opened. Synthetic,
 * TEST-only amounts; no guest data.
 */
export const id = (n: number) => "01909963-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);

export interface FloorState {
  phase: "Active" | "Closing";
  version: number;
  /** T2 has an order (false: just seated, nothing ordered). */
  ordered?: boolean;
  /** Every dish served (false: the round is still in the kitchen). */
  served?: boolean;
}

export async function zh(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("bop.merchant.language", "zh-Hans");
  });
}

export async function floor(
  page: Page,
  state: FloorState,
  options: { canOperateTables?: boolean; canTakeOrders?: boolean; closeBlockers?: string[] } = {},
) {
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
          businessDate: "2026-11-25",
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
            ...(options.canTakeOrders
              ? [
                  {
                    screenId: "OPS-ORDER-ENTRY",
                    label: "Counter order",
                    href: "/operations/order-entry",
                    permission: "ordering.order.create_staff",
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
  const ordered = state.ordered ?? true;
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: options.canOperateTables ?? false,
        canCloseSessions: true,
        ...(options.canTakeOrders ? { canTakeTableRounds: true } : {}),
        items: [
          {
            tableReference: id(1),
            stableLabel: "T2",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 35,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: {
              phase: state.phase,
              version: state.version,
              orderReference: ordered ? id(3) : null,
            },
            staffRoundsAwaitingPayment: [],
          },
          {
            tableReference: id(11),
            stableLabel: "F1",
            areaCode: "MAIN",
            capacity: 2,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: null,
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  const served = state.served ?? true;
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        tableLabel: "T2",
        diningSessionReference: id(2),
        sessionPhase: state.phase,
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        sessionVersion: state.version,
        tableAssignmentVersion: 1,
        orderVersion: 4,
        phase: served ? "Fulfilled" : "InProgress",
        observedAt: "2026-11-25T19:00:00.000Z",
        items: [
          {
            orderItemReference: id(101),
            orderBatchReference: id(21),
            displayName: "Beef noodles (TEST)",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: served ? "Fulfilled" : "Accepted",
            orderedQuantity: 1,
            deliveredQuantity: served ? 1 : 0,
            remainingQuantity: served ? 0 : 1,
            itemServiceVersion: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-11-25T19:00:00.000Z",
        rounds: served
          ? []
          : [
              {
                orderBatchReference: id(21),
                sequence: 1,
                state: "OnTableBill",
                openItemCount: 1,
                startedItemCount: 0,
                readyItemCount: 0,
                cancellableItemReferences: [],
                refund: null,
                cancelsAt: null,
                kitchenReceivedAt: null,
              },
            ],
        closeBlockers: options.closeBlockers ?? [],
        totals: { onlineMinor: "0", cardMachineMinor: "0" },
      },
    }),
  );
}

/** A bill split evenly in two, nothing paid yet (the split can still change). */
export async function splitBill(): Promise<Record<string, unknown>> {
  const { splitBillFixture } = await import("../src/table-split.fixtures.js");
  const bill: Record<string, unknown> = {
    ...splitBillFixture(),
    diningSessionReference: id(2),
    orderReference: id(3),
  };
  const split = bill.split as { parts: Record<string, unknown>[]; paidParts: number };
  bill.split = {
    ...split,
    paidParts: 0,
    remainingMinor: "6328",
    parts: split.parts.slice(0, 2).map((part, index) => ({
      ...part,
      amountMinor: "3164",
      subtotalMinor: "2800",
      taxMinor: "364",
      roundNumbers: [index + 1],
      payment: null,
      guestPaying: false,
    })),
  };
  return bill;
}

/** A target's box in CSS pixels. */
export async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("not on screen");
  return rect;
}

export const widths = [1440, 1024, 390] as const;
export async function atWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
}

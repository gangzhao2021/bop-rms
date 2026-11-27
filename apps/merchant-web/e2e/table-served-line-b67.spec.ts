import { expect, test } from "@playwright/test";

/**
 * Batch 67 (v15 b66 live, TM2 D66 A): a table with two rounds (3 dishes). "All served" under round
 * 1 (2 dishes) left the line "All 2 items marked served." on the Tables panel while round 2 still
 * showed "Served 0/1 · Mark served", as if the whole table had been served. The line now says how
 * many of the order's dishes are served ("2 of 3 items served."); once every dish is served it says
 * "All … marked served." as before. Synthetic Store.
 */
const id = (n: number) => "0190a670-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
};
// Round 1: noodles and dumplings, both ready. Round 2: soy milk, still being made.
const dishes = [
  { item: 201, batch: 51, sequence: 1, name: "Beef noodles (TEST)" },
  { item: 202, batch: 51, sequence: 1, name: "Dumplings (TEST)" },
  { item: 203, batch: 61, sequence: 2, name: "Soy milk (TEST)" },
] as const;
const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b67: serving one round of two says how many of the table's dishes are served, in ${language}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          /* the page falls back to English */
        }
      });
    let served = false;
    await page.route("**/merchant/session", (route) =>
      route.fulfill({
        headers,
        json: {
          authenticated: true,
          csrf,
          workspace: {
            screenId: "HOME-OVERVIEW",
            selectedScope: { ...scope, timeZone: "America/Toronto" },
            authorizedStores: [scope],
            businessDate: "2026-11-27",
            storeStatus: "Open",
            freshness: "Current",
            dashboardAvailability: "UnavailableUntilWP1905",
            navigation: [
              ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
              ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
            ].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission })),
          },
        },
      }),
    );
    await page.route("**/merchant/dining/tables", (route) =>
      route.fulfill({
        headers,
        json: {
          canOperateTables: true,
          canCloseSessions: true,
          canTransferHost: true,
          canCancelUnpaidRounds: true,
          canWriteOff: true,
          items: [
            {
              tableReference: id(70),
              stableLabel: "D67 A (TEST)",
              areaCode: "MAIN",
              capacity: 4,
              lifecycle: "Published",
              operationalState: "Available",
              blockReasonCode: null,
              aggregateVersion: 5,
              currentDiningSessionReference: id(71),
              elapsedMinutes: 12,
              qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
              paymentTiming: "PayLater",
              session: {
                phase: "Active",
                version: 4,
                orderReference: id(1),
                paymentStarted: false,
                mergedTables: [],
              },
              staffRoundsAwaitingPayment: [],
              guestRoundsAwaitingPayment: [],
              roundsAwaitingAcceptance: [],
              staffCall: null,
            },
          ],
          nextAfterTableReference: null,
        },
      }),
    );
    await page.route("**/merchant/orders/detail*", (route) =>
      route.fulfill({
        headers,
        json: {
          screenId: "OPS-ORDER-DETAIL",
          pickupContact: null,
          order: {
            orderReference: id(1),
            orderNumber: "T-1",
            orderType: "DineIn",
            sourceChannel: "Qr",
            submittedAt: "2026-11-27T16:20:00.000Z",
            observedAt: "2026-11-27T16:30:00.000Z",
            initialBatchReference: id(51),
            batches: [51, 61].map((batch, index) => ({
              orderBatchReference: id(batch),
              sequence: index + 1,
              acceptanceStatus: "Accepted",
              canRequestAcceptance: false,
              canCancel: false,
              staffCancellation: null,
              canCancelItems: false,
              unpaidRemovableItems: [],
              unpaidRemovedItems: [],
              compableItems: [],
              compedItems: [],
            })),
            canRequestAcceptance: false,
            tableBill: null,
            currentPhase: "InProgress",
            currentVersion: 3,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
          lines: {
            items: dishes.map((dish) => ({
              orderItemReference: id(dish.item),
              orderBatchReference: id(dish.batch),
              name: dish.name,
              options: [],
              quantity: 1,
              customerNote: null,
              unitPrice: money("1000"),
              subtotal: money("1000"),
              discount: money("0"),
              tax: money("130"),
              fee: money("0"),
              total: money("1130"),
              canCancel: false,
              cancellation: null,
            })),
            totals: {
              subtotal: money("3000"),
              discount: money("0"),
              tax: money("390"),
              fee: money("0"),
              taxRounding: money("0"),
              total: money("3390"),
            },
          },
        },
      }),
    );
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({
        headers,
        json: {
          diningSessionReference: id(71),
          sessionPhase: "Active",
          sessionVersion: 4,
          paymentTiming: "PayLater",
          tableLabel: "D67 A (TEST)",
          orderReference: id(1),
          rounds: [51, 61].map((batch, index) => {
            const items = dishes.filter((dish) => dish.batch === batch);
            const total = (1130 * items.length).toString();
            return {
              roundNumber: index + 1,
              orderReference: id(1),
              orderBatchReference: id(batch),
              submissionReference: id(300 + index),
              items: items.map((dish) => ({
                orderItemReference: id(dish.item),
                quantity: 1,
                displayName: dish.name,
                subtotalMinor: "1000",
                totalMinor: "1130",
                reduction: null,
              })),
              takenOffDishes: [],
              subtotalMinor: (1000 * items.length).toString(),
              taxMinor: (130 * items.length).toString(),
              totalMinor: total,
              taxRoundingMinor: "0",
              paid: false,
              orderedBy: null,
              fromTableLabel: null,
              liveOrderedAt: "2026-11-27T16:2" + String(index) + ":00.000Z",
            };
          }),
          owed: { subtotalMinor: "3000", taxMinor: "390", totalMinor: "3390" },
          consistent: true,
          settlement: null,
          split: null,
          writeOff: null,
          onlinePayment: null,
        },
      }),
    );
    await page.route("**/merchant/dining/order-progress", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          orderVersion: 3,
          sessionVersion: 4,
          diningSessionReference: id(71),
          sessionPhase: "Active",
          tableAssignmentVersion: 2,
          closureStatus: "Open",
          closureVersion: 0,
          currentOrderVersion: 3,
          tableLabel: "D67 A (TEST)",
          phase: "InProgress",
          observedAt: "2026-11-27T16:30:00.000Z",
          items: dishes.map((dish) => {
            const done = served && dish.sequence === 1;
            return {
              orderItemReference: id(dish.item),
              orderBatchReference: id(dish.batch),
              displayName: dish.name,
              batchSequence: dish.sequence,
              itemOrdinal: dish.item - 200,
              phase: done ? "Fulfilled" : dish.sequence === 1 ? "Ready" : "Accepted",
              orderedQuantity: 1,
              deliveredQuantity: done ? 1 : 0,
              remainingQuantity: done ? 0 : 1,
              itemServiceVersion: done ? 2 : 1,
            };
          }),
        },
      }),
    );
    await page.route("**/merchant/dining/table-close-plan", (route) =>
      route.fulfill({
        headers,
        json: {
          orderReference: id(1),
          diningSessionReference: id(71),
          orderVersion: 3,
          observedAt: "2026-11-27T16:30:00.000Z",
          rounds: [51, 61].map((batch, index) => ({
            orderBatchReference: id(batch),
            sequence: index + 1,
            state: "OnTableBill",
            openItemCount: served && index === 0 ? 0 : index === 0 ? 2 : 1,
            startedItemCount: 0,
            readyItemCount: !served && index === 0 ? 2 : 0,
            cancellableItemReferences: [],
            refund: null,
            cancelsAt: null,
            kitchenReceivedAt: null,
          })),
          totals: { onlineMinor: "0", cardMachineMinor: "0" },
          closeBlockers: ["ORDER_BALANCE_UNPAID"],
        },
      }),
    );
    const serves: unknown[] = [];
    await page.route("**/merchant/dining/serve-ready", (route) => {
      const body = route.request().postDataJSON() as { operationReference: string };
      serves.push(body);
      served = true;
      return route.fulfill({
        headers,
        json: {
          operationReference: body.operationReference,
          served: 2,
          alreadyServed: 0,
          changed: 0,
          failed: 0,
          lines: [
            { orderItemReference: id(201), outcome: "Served" },
            { orderItemReference: id(202), outcome: "Served" },
          ],
        },
      });
    });
    const details = page.getByRole("complementary", {
      name: zh ? "所选桌台详情" : "Selected table details",
    });
    for (const [width, height] of sizes) {
      const where = `${language} ${width}`;
      served = false;
      await page.setViewportSize({ width, height });
      await page.goto("/operations/dining");
      await page
        .getByRole("button", { name: /D67 A \(TEST\)/u })
        .first()
        .click();
      await details
        .getByRole("button", { name: zh ? "全部上了" : "All served", exact: true })
        .click();
      const line = details.locator(".dining-rounds__status").first();
      await expect(line, where).toHaveText(zh ? "已上 2/3 项。" : "2 of 3 items served.");
      await expect(details, where).not.toContainText(
        zh ? "全部已标记上桌" : "All 2 items marked served",
      );
      // Round 2 still has its dish to serve, as the line now says.
      await expect(details.getByText(zh ? "已上 0/1" : "Served 0/1").first()).toBeVisible();
      const box = await line.evaluate((n) => {
        const r = n.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          size: getComputedStyle(n).fontSize,
          weight: getComputedStyle(n).fontWeight,
        };
      });
      expect(box.left, `${where}: the line starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${where}: the line fits`).toBeLessThanOrEqual(width);
      expect([box.size, box.weight], where).toEqual(["14px", "400"]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${where}: no sideways scroll`,
      ).toBe(true);
      await details.screenshot({ path: `test-results/b67-served-line-${language}-${width}.png` });
    }
    expect(serves).toHaveLength(3);
  });

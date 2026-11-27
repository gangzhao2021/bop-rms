import { expect, test } from "@playwright/test";

/**
 * b40 (v15 b39 live, L39 M3 merged into L39 M2): the Tables panel's serving section numbered each
 * order's rounds from 1, so it had two "Take dishes off round 1" controls, while checkout, the
 * split and the guest call the four rounds 1-4 (in the order they were sent). It now numbers them
 * as the bill does. Also b40: a dish taken off because it sold out says so to staff, as it does to
 * the guest. The shapes are v15's: the bill's rounds carry their round reference, the merged
 * table's two rounds came from its one phone (phone 3 on the merged bill). Synthetic Store.
 */
const id = (n: number) => "0190a400-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
};

// Host order 1 (M2): round 1 noodles, then round 4 soy milk (taken off: sold out).
// Merged order 2 (M3): rounds 2 and 3, beef noodles each.
const rounds = [
  { order: 1, sequence: 1, batch: 51, item: 201, name: "Beef noodles (TEST)", number: 1 },
  { order: 2, sequence: 1, batch: 52, item: 202, name: "Beef noodles (TEST)", number: 2 },
  { order: 2, sequence: 2, batch: 62, item: 203, name: "Beef noodles (TEST)", number: 3 },
  { order: 1, sequence: 2, batch: 61, item: 204, name: "Soy milk (TEST)", number: 4 },
] as const;
const soldOut = 204;

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b40: a merged table's panel numbers rounds as the bill does and says a dish sold out, in ${language}`, async ({
    page,
  }) => {
    if (language === "zh-Hans")
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("bop.merchant.language", "zh-Hans");
        } catch {
          /* the page falls back to English */
        }
      });
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
            businessDate: "2026-11-20",
            storeStatus: "Open",
            freshness: "Current",
            dashboardAvailability: "UnavailableUntilWP1905",
            navigation: [
              ["OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"],
              ["KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"],
              ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
              ["RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations", "reporting.sales.read"],
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
              stableLabel: "L39 M2 (TEST)",
              areaCode: "MAIN",
              capacity: 4,
              lifecycle: "Published",
              operationalState: "Available",
              blockReasonCode: null,
              aggregateVersion: 5,
              currentDiningSessionReference: id(71),
              elapsedMinutes: 8,
              qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
              paymentTiming: "PayLater",
              session: {
                phase: "Active",
                version: 4,
                orderReference: id(1),
                paymentStarted: false,
                mergedTables: [{ fromTableLabel: "L39 M3 (TEST)", orderReference: id(2) }],
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
    const line = (round: (typeof rounds)[number]) => ({
      orderItemReference: id(round.item),
      orderBatchReference: id(round.batch),
      name: round.name,
      options: [],
      quantity: 1,
      customerNote: null,
      unitPrice: money("1250"),
      subtotal: money("1250"),
      discount: money("0"),
      tax: money("163"),
      fee: money("0"),
      total: money("1413"),
      canCancel: false,
      cancellation: null,
    });
    const order = (n: 1 | 2) => ({
      orderReference: id(n),
      orderNumber: "T-" + n,
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-11-21T06:20:00.000Z",
      observedAt: "2026-11-21T06:30:00.000Z",
      initialBatchReference: id(50 + n),
      batches: rounds
        .filter((round) => round.order === n)
        .map((round) => ({
          orderBatchReference: id(round.batch),
          sequence: round.sequence,
          acceptanceStatus: "Accepted",
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
          unpaidRemovableItems: round.item === soldOut ? [] : [id(round.item)],
          unpaidRemovedItems: round.item === soldOut ? [id(round.item)] : [],
          ...(round.item === soldOut ? { unpaidSoldOutItems: [id(round.item)] } : {}),
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
    });
    await page.route("**/merchant/orders/detail*", (route) => {
      const n = new URL(route.request().url()).searchParams.get("order") === id(2) ? 2 : 1;
      return route.fulfill({
        headers,
        json: {
          screenId: "OPS-ORDER-DETAIL",
          pickupContact: null,
          order: order(n),
          lines: {
            items: rounds.filter((round) => round.order === n).map(line),
            totals: {
              subtotal: money("2500"),
              discount: money("0"),
              tax: money("326"),
              fee: money("0"),
              taxRounding: money("0"),
              total: money("2826"),
            },
          },
        },
      });
    });
    // The whole bill as v15 sends it: rounds in the order they were sent, with their references.
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({
        headers,
        json: {
          diningSessionReference: id(71),
          sessionPhase: "Active",
          sessionVersion: 4,
          paymentTiming: "PayLater",
          tableLabel: "L39 M2 (TEST)",
          orderReference: id(1),
          rounds: rounds.map((round) => ({
            roundNumber: round.number,
            orderReference: id(round.order),
            orderBatchReference: id(round.batch),
            submissionReference: id(300 + round.number),
            items:
              round.item === soldOut
                ? []
                : [
                    {
                      orderItemReference: id(round.item),
                      quantity: 1,
                      displayName: round.name,
                      subtotalMinor: "1250",
                      totalMinor: "1413",
                      reduction: null,
                    },
                  ],
            takenOffDishes:
              round.item === soldOut
                ? [
                    {
                      orderItemReference: id(round.item),
                      quantity: 1,
                      displayName: round.name,
                      soldOut: true,
                    },
                  ]
                : [],
            subtotalMinor: round.item === soldOut ? "0" : "1250",
            taxMinor: round.item === soldOut ? "0" : "163",
            totalMinor: round.item === soldOut ? "0" : "1413",
            taxRoundingMinor: "0",
            paid: false,
            orderedBy: round.order === 1 ? 1 : 3,
            fromTableLabel: round.order === 1 ? null : "L39 M3 (TEST)",
            liveOrderedAt: "2026-11-21T06:2" + String(round.number) + ":00.000Z",
          })),
          owed: { subtotalMinor: "3750", taxMinor: "489", totalMinor: "4239" },
          consistent: true,
          settlement: null,
          split: null,
          writeOff: null,
          onlinePayment: null,
        },
      }),
    );
    // b41 (v15 b40 live): each Order's progress (nothing served yet) and close plan, the merged
    // Order's read under this table's session as the API now allows. Each lists its own rounds by
    // its own numbers (the host's soy milk round is its round 2, bill round 4).
    const open = rounds.filter((round) => round.item !== soldOut);
    await page.route("**/merchant/dining/order-progress", async (route) => {
      const n =
        (JSON.parse(route.request().postData() ?? "{}") as { orderReference?: string })
          .orderReference === id(2)
          ? 2
          : 1;
      return route.fulfill({
        headers,
        json: {
          orderReference: id(n),
          orderVersion: 3,
          sessionVersion: 4,
          diningSessionReference: n === 1 ? id(71) : id(72),
          sessionPhase: n === 1 ? "Active" : "Closed",
          tableAssignmentVersion: 2,
          closureStatus: "Open",
          closureVersion: 0,
          currentOrderVersion: 3,
          tableLabel: n === 1 ? "L39 M2 (TEST)" : "L39 M3 (TEST)",
          phase: "InProgress",
          observedAt: "2026-11-21T06:30:00.000Z",
          items: open
            .filter((round) => round.order === n)
            .map((round) => ({
              orderItemReference: id(round.item),
              orderBatchReference: id(round.batch),
              displayName: round.name,
              batchSequence: round.sequence,
              itemOrdinal: 1,
              phase: "Accepted",
              orderedQuantity: 1,
              deliveredQuantity: 0,
              remainingQuantity: 1,
              itemServiceVersion: 1,
            })),
        },
      });
    });
    const planRequests: string[] = [];
    await page.route("**/merchant/dining/table-close-plan", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        orderReference: string;
        diningSessionReference: string;
      };
      planRequests.push(body.orderReference);
      const n = body.orderReference === id(2) ? 2 : 1;
      return route.fulfill({
        headers,
        json: {
          orderReference: id(n),
          diningSessionReference: body.diningSessionReference,
          orderVersion: 3,
          observedAt: "2026-11-21T06:30:00.000Z",
          rounds: open
            .filter((round) => round.order === n)
            .map((round) => ({
              orderBatchReference: id(round.batch),
              sequence: round.sequence,
              state: "OnTableBill",
              openItemCount: 1,
              startedItemCount: 0,
              readyItemCount: 0,
              cancellableItemReferences: [],
              refund: null,
              cancelsAt: null,
              kitchenReceivedAt: null,
            })),
          totals: { onlineMinor: "0", cardMachineMinor: "0" },
          closeBlockers: n === 1 ? ["ORDER_BALANCE_UNPAID"] : [],
        },
      });
    });
    await page.goto("/operations/dining");
    await page
      .getByRole("button", { name: /L39 M2 \(TEST\)/u })
      .first()
      .click();
    const zh = language === "zh-Hans";
    const details = page.getByRole("complementary", {
      name: zh ? "所选桌台详情" : "Selected table details",
    });
    const host = details.locator(".table-order-rounds").first();
    const merged = details.locator(".table-panel__merged");
    const headings = (where: typeof host) =>
      where
        .locator(".order-round__head h3")
        .evaluateAll((all) => all.map((h) => (h.firstChild?.textContent ?? "").trim()));
    await expect(host.locator(".order-round__head h3")).toHaveCount(2);
    const round = (n: number) => (zh ? `第 ${n} 轮` : `Round ${n}`);
    expect((await headings(host)).map((text) => text.replace(/ · .*$/u, ""))).toEqual([
      round(1),
      round(4),
    ]);
    await expect(merged.locator(".order-round__head h3")).toHaveCount(2);
    expect((await headings(merged)).map((text) => text.replace(/ · .*$/u, ""))).toEqual([
      round(2),
      round(3),
    ]);
    // One "Take dishes off" control per round, each named by its own bill number.
    const takeOff = details.getByRole("button", {
      name: zh ? /第 \d+ 轮/u : /^Take dishes off round \d+$/u,
    });
    const names = await takeOff.allTextContents();
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(3);
    // The sold-out dish says why it is off the bill.
    await expect(host).toContainText(
      zh ? "已售罄 · 已从账单删除，不收费" : "Sold out · taken off the bill, not charged",
    );
    // b41: closing the table reads every unserved round of the merged bill. b63 (F35): the
    // rounds above already show what is unserved, so closing says it in one line, not again.
    await expect(
      details.getByRole("region", { name: zh ? "还没上的菜" : "Dishes still to serve" }),
    ).toHaveCount(0);
    await expect(details.locator(".dining-table-close__wait")).toHaveText(
      zh
        ? /^菜上齐、账结清后再关台。/u
        : /^Close after every dish is served and the bill is paid\./u,
    );
    expect([...new Set(planRequests)].sort()).toEqual([id(1), id(2)]);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await details.screenshot({ path: `test-results/b40-merged-rounds-${language}-${width}.png` });
    }
  });

import { expect, test } from "@playwright/test";

/**
 * v15 batch 9 review / b15 (DEC-TAX-WHOLE-RECEIPT): one tax figure everywhere. Two $12.50 dishes
 * at a 13% TEST tax, one per table, merged: each round was charged $1.63, the whole bill's tax is
 * $3.25, so the bill rounds by −$0.01 (rule v2: on the host's Order). The host reads Tax $1.62 /
 * Total $14.12 (its share of the rounding in them, never a "Tax rounding" line), then the whole
 * bill with the merged table, $28.25; the merged table reads what it ordered, $14.13. After a
 * manager comps the merged table's dish there is no rounding left: the host reads $1.63 / $14.13,
 * the bill it is, and the merged table its round on the bill, $0.00. b15 review: each round's
 * amount is the bill's for it (tax included). Synthetic Store; server mocked.
 */
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

for (const width of [1440, 1024, 390])
  for (const comped of [false, true])
    test(`@production the host reads the bill's one tax ${comped ? "after" : "before"} a comp on the merged table (${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
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
              businessDate: "2026-11-10",
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
            canTransferHost: false,
            canCancelUnpaidRounds: true,
            canWriteOff: true,
            items: [
              {
                tableReference: id(70),
                stableLabel: "MRS 1",
                areaCode: "MAIN",
                capacity: 4,
                lifecycle: "Published",
                operationalState: "Available",
                blockReasonCode: null,
                aggregateVersion: 2,
                currentDiningSessionReference: id(71),
                elapsedMinutes: 30,
                qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
                paymentTiming: "PayLater",
                session: {
                  phase: "Active",
                  version: 3,
                  orderReference: id(1),
                  paymentStarted: false,
                  mergedTables: [{ fromTableLabel: "MRS 2", orderReference: id(2) }],
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
      const line = (order: number, n: number, name: string) => ({
        orderItemReference: id(200 + n),
        orderBatchReference: id(50 + order),
        name,
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
      const billRound = (n: number, subtotal: string, tax: string, total: string) => ({
        orderBatchReference: id(50 + n),
        subtotalMinor: subtotal,
        taxMinor: tax,
        totalMinor: total,
      });
      const order = (n: number) => ({
        orderReference: id(n),
        orderNumber: "T-" + n,
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-11-10T23:00:00.000Z",
        observedAt: "2026-11-10T23:40:00.000Z",
        initialBatchReference: id(50 + n),
        batches: [
          {
            orderBatchReference: id(50 + n),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
            unpaidRemovableItems: [],
            unpaidRemovedItems: [],
            compableItems: [],
            // Only the merged table's dish is comped (after the comp).
            compedItems:
              comped && n === 2
                ? [
                    {
                      orderItemReference: id(202),
                      kind: "Comp",
                      percent: null,
                      amountMinor: "1413",
                    },
                  ]
                : [],
          },
        ],
        canRequestAcceptance: false,
        // The host's bill holds both tables; the merged table's bill is on the host's.
        tableBill:
          n === 1
            ? comped
              ? { totalMinor: "1413", paid: null, rounds: [billRound(n, "1250", "163", "1413")] }
              : {
                  totalMinor: "2825",
                  paid: null,
                  taxRoundingMinor: "-1",
                  rounds: [billRound(n, "1250", "162", "1412")],
                }
            : {
                totalMinor: "0",
                paid: null,
                mergedInto: { tableLabel: "MRS 1", paid: false },
                // b15: the merged table's round as the host's bill charges it (after its comp).
                rounds: [
                  comped ? billRound(n, "0", "0", "0") : billRound(n, "1250", "163", "1413"),
                ],
              },
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
              items: [line(n, n, n === 1 ? "Synthetic noodles" : "Synthetic dumplings")],
              totals: {
                subtotal: money("1250"),
                discount: money("0"),
                tax: money("163"),
                fee: money("0"),
                taxRounding: money("0"),
                total: money("1413"),
              },
            },
          },
        });
      });
      await page.goto("/operations/dining");
      await page.getByRole("button", { name: "Select MRS 1", exact: true }).click();
      const details = page.getByRole("complementary", { name: "Selected table details" });
      const host = details.getByRole("region", { name: "This table's order" }).first();
      const totals = host.locator(".order-lines-totals");
      await expect(host).not.toContainText("Tax rounding");
      if (comped) {
        // No rounding left on the bill: the host's Tax and Total are its round on the bill.
        await expect(totals.first()).toContainText("Tax$1.63");
        await expect(totals.first()).toContainText("Total$14.13");
        // b15 review: the comps list no longer repeats the bill; the merged table's bill is said
        // once, under the Total (the merged table's $0.00 round is on it).
        await expect(totals.nth(1)).toContainText("Whole bill to pay, with MRS 2$14.13");
        await expect(host).not.toContainText("after comps");
      } else {
        await expect(totals.first()).toContainText("Tax$1.62");
        await expect(totals.first()).toContainText("Total$14.12");
        await expect(totals.nth(1)).toContainText("Whole bill to pay, with MRS 2$28.25");
      }
      // b15 review: the round says what the bill charges for it, as checkout and the guest do.
      await expect(host.locator(".order-round__amount")).toHaveText([comped ? "$14.13" : "$14.12"]);
      const merged = details.getByRole("region", { name: /^From (table )?MRS 2$/u });
      const mergedTotals = merged.locator(".order-lines-totals").first();
      if (comped) {
        // The merged table's dish was comped: its round and Total are the bill's, $0.00, and the
        // comp list says what came off; no "Tax worked out again" line, the Tax is the bill's.
        await expect(merged.locator(".order-round__amount")).toHaveText(["$0.00"]);
        await expect(mergedTotals).toContainText("Subtotal after comps$0.00");
        await expect(mergedTotals).toContainText("Total$0.00");
        await expect(merged).not.toContainText("Tax worked out again");
      } else {
        await expect(merged.locator(".order-round__amount")).toHaveText(["$14.13"]);
        await expect(mergedTotals).toContainText("Total$14.13");
      }
      await expect(merged).not.toContainText("Tax rounding");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/dining-bill-rounding-apart-${comped ? "after" : "before"}-${width}.png`,
      });
    });

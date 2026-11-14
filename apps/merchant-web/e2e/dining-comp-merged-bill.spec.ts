import { expect, test } from "@playwright/test";

/**
 * v15 batch 7: after a comp at a table with another table merged into it, the comps list's
 * figure is the whole bill (both tables), said so; the merged table's own rounds say nothing
 * about paying (it pays on this table's bill). Synthetic Store; the server is mocked.
 */
const id = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

for (const width of [1440, 1024, 390])
  test(`@production a comp on a merged table's bill says it is the whole bill (${width})`, async ({
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
          compedItems: [
            { orderItemReference: id(200 + n), kind: "Comp", percent: null, amountMinor: "1413" },
          ],
        },
      ],
      canRequestAcceptance: false,
      // The host's bill holds both tables; the merged table's bill is on the host's.
      tableBill:
        n === 1
          ? { totalMinor: "1412", paid: null }
          : { totalMinor: "0", paid: null, mergedInto: { tableLabel: "MRS 1", paid: false } },
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
    await expect(host.getByRole("list", { name: "Comps and discounts" })).toContainText(
      "Whole bill to pay after comps, with MRS 2$14.12",
    );
    const merged = details.getByRole("region", { name: /^From (table )?MRS 2$/u });
    await expect(merged.getByRole("list", { name: "Comps and discounts" })).toContainText(
      "Synthetic dumplings",
    );
    await expect(merged).not.toContainText("to pay after comps");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/dining-comp-merged-bill-${width}.png` });
  });

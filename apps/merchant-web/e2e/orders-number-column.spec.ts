import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 53 sweep (v15 batch 52 live: on Pickup the waiting time of order 10 started right of order
 * 9's): on Orders the status of every row starts at the same place for order numbers 2 to 1234,
 * in both languages at 390, 1024 and 1440. Synthetic HTTP interception, TEST-only data.
 */
const id = (n: number) => "0190b153-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const session = {
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
};
const order = (n: number, type: "DineIn" | "Pickup", submittedAt: string) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: type,
  sourceChannel: "Web",
  submittedAt,
  observedAt: submittedAt,
  initialBatchReference: id(200 + n),
  batches: [
    {
      orderBatchReference: id(200 + n),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: true,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: true,
  currentPhase: "Submitted",
  currentVersion: 1,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
});

const numbers = [2, 9, 10, 99, 100, 1234] as const;

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production Orders statuses line up for orders 2 to 1234, ${language} at ${width}`, async ({
      page,
    }) => {
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      const at = new Date(Date.now() - 120_000).toISOString();
      // Newest first, as the server lists them.
      const listed = numbers.map((n) => order(n, n % 2 === 0 ? "Pickup" : "DineIn", at)).reverse();
      await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
      await page.route("**/merchant/orders/changes", (route) =>
        route.fulfill({ headers, json: { schemaVersion: 1, mark: "1".padStart(32, "0") } }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) =>
          route.fulfill({ headers, json: { items: listed, nextAfterOrderReference: null } }),
        );
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      await expect(rows).toHaveCount(numbers.length);
      const measured = await rows.evaluateAll((list) =>
        list.map((row) => {
          const number = row.querySelector(".order-row__open");
          const status = row.querySelector(".order-row__status");
          return {
            text: number?.textContent ?? "",
            numberRight: number?.getBoundingClientRect().right ?? 0,
            statusLeft: status?.getBoundingClientRect().left ?? -1,
          };
        }),
      );
      expect(measured.map((row) => row.text).sort()).toEqual(numbers.map(String).sort());
      const lefts = measured.map((row) => Math.round(row.statusLeft));
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(1);
      for (const row of measured) expect(row.statusLeft).toBeGreaterThanOrEqual(row.numberRight);
      await page.screenshot({
        path: test.info().outputPath(`orders-numbers-${language}-${width}.png`),
        fullPage: true,
      });
      await expectNoInternalText(page);
    });
  }

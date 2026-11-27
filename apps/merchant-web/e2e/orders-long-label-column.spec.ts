import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 54 (v15 batch 53 live, Orders at 390): rows whose label is longer than four characters
 * ("11/4 · 43", an earlier business day's pickup still open) widened their own number column, so
 * their status started up to 113.5 px right of today's rows. Every row's status now starts at the
 * same place: today's orders 2, 10 and 123, a long public reference, and earlier-day labels
 * "11/4 · 43" and "12/31 · 1234", in both languages at 390, 1024 and 1440. The labels stay whole on
 * one line. Synthetic HTTP interception, TEST-only data, in the shape v15 answers (earlier-day open
 * pickups in earlierDayItems).
 */
const id = (n: number) => "0190b154-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const today = "2026-11-23";
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
    businessDate: today,
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
const order = (n: number, orderNumber: string, businessDate: string, submittedAt: string) => {
  const earlier = businessDate !== today;
  return {
    orderReference: id(n),
    orderNumber,
    orderType: "Pickup",
    sourceChannel: "Web",
    businessDate,
    listedBusinessDate: businessDate,
    heldStock: null,
    earlierOpenPickup: earlier,
    submittedAt,
    observedAt: submittedAt,
    initialBatchReference: id(200 + n),
    batches: [
      {
        orderBatchReference: id(200 + n),
        sequence: 1,
        acceptanceStatus: earlier ? "Accepted" : "NotAccepted",
        canRequestAcceptance: !earlier,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: !earlier,
    currentPhase: earlier ? "Accepted" : "Submitted",
    currentVersion: earlier ? 2 : 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
};

const reference = "PU-7Q2M9K4X8R3T6W1Z5B4N";
const todayNumbers = ["2", "10", "123", reference] as const;
const earlier = [
  { orderNumber: "43", businessDate: "2026-11-04", label: "11/4 · 43" },
  { orderNumber: "1234", businessDate: "2025-12-31", label: "12/31 · 1234" },
] as const;

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production Orders statuses line up after earlier-day and long labels, ${language} at ${width}`, async ({
      page,
    }) => {
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      const now = Date.now();
      const at = new Date(now - 120_000).toISOString();
      // Newest first, as the server lists them.
      const items = todayNumbers.map((number, i) => order(i + 1, number, today, at)).reverse();
      const earlierDayItems = earlier.map((row, i) =>
        order(50 + i, row.orderNumber, row.businessDate, row.businessDate + "T21:33:01.000Z"),
      );
      await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: today,
            startsAt: new Date(now - 6 * 3_600_000).toISOString(),
            endsAt: new Date(now + 18 * 3_600_000).toISOString(),
            timeZone: "America/Toronto",
            observedAt: new Date(now).toISOString(),
          },
        }),
      );
      await page.route("**/merchant/orders/changes", (route) =>
        route.fulfill({ headers, json: { schemaVersion: 1, mark: "1".padStart(32, "0") } }),
      );
      for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
        await page.route(pattern, (route) =>
          route.fulfill({
            headers,
            json: { earlierDayItems, items, nextAfterOrderReference: null },
          }),
        );
      await page.goto("/operations/orders");
      const rows = page.locator("li.order-row:not([hidden])");
      const labels = [...todayNumbers, ...earlier.map((row) => row.label)];
      await expect(rows).toHaveCount(labels.length);
      await expect(rows.locator(".order-row__open", { hasText: "12/31 · 1234" })).toBeVisible();
      const measured = await rows.evaluateAll((list) =>
        list.map((row) => {
          const number = row.querySelector<HTMLElement>(".order-row__open");
          const status = row.querySelector(".order-row__status");
          const range = document.createRange();
          if (number) range.selectNodeContents(number);
          const lineTops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
          const numberBox = number?.getBoundingClientRect();
          const statusBox = status?.getBoundingClientRect();
          return {
            text: number?.textContent ?? "",
            lines: lineTops.size,
            clipped: number === null ? true : number.scrollWidth > number.clientWidth + 1,
            numberRight: numberBox?.right ?? 0,
            numberBottom: numberBox?.bottom ?? 0,
            rowRight: row.getBoundingClientRect().right,
            statusLeft: statusBox?.left ?? -1,
            statusTop: statusBox?.top ?? -1,
          };
        }),
      );
      expect(measured.map((row) => row.text).sort()).toEqual([...labels].sort());
      const lefts = measured.map((row) => Math.round(row.statusLeft));
      expect(
        Math.max(...lefts) - Math.min(...lefts),
        JSON.stringify(measured.map((row) => [row.text, row.statusLeft])),
      ).toBeLessThanOrEqual(1);
      for (const row of measured) {
        // Whole, on one line, and never under the status.
        expect(row.lines, row.text).toBe(1);
        expect(row.clipped, row.text).toBe(false);
        expect(
          row.statusLeft >= row.numberRight || row.statusTop >= row.numberBottom - 1,
          row.text,
        ).toBe(true);
        // Room for wider Linux fonts (DejaVu Sans) before the label reaches the row's end.
        expect(row.rowRight - row.numberRight, row.text).toBeGreaterThanOrEqual(40);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      await page.screenshot({
        path: test.info().outputPath(`orders-long-labels-${language}-${width}.png`),
        fullPage: true,
      });
      await expectNoInternalText(page);
    });
  }

for (const language of ["en", "zh-Hans"] as const)
  test(`@production a new order's "New order" mark keeps its status in the shared column, ${language} at 390`, async ({
    page,
  }) => {
    if (language === "zh-Hans")
      await page.addInitScript(() =>
        window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
      );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    const at = new Date(Date.now() - 120_000).toISOString();
    let items = ["2", "10", "123"].map((number, i) => order(i + 1, number, today, at)).reverse();
    await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
    for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
      await page.route(pattern, (route) =>
        route.fulfill({ headers, json: { items, nextAfterOrderReference: null } }),
      );
    await page.goto("/operations/orders");
    const rows = page.locator("li.order-row:not([hidden])");
    await expect(rows).toHaveCount(3);
    items = [order(9, "7", today, new Date(Date.now()).toISOString()), ...items];
    await page.clock.fastForward(11_000);
    await expect(page.locator("li.order-row[data-new]")).toHaveCount(1);
    await expect(page.locator("li.order-row[data-new] .order-row__new")).toBeVisible();
    const measured = await rows.evaluateAll((list) =>
      list.map((row) => {
        const heading = row.querySelector<HTMLElement>(".order-row__number");
        const status = row.querySelector(".order-row__status");
        return {
          text: heading?.textContent ?? "",
          headingBottom: heading?.getBoundingClientRect().bottom ?? 0,
          headingRight: heading?.getBoundingClientRect().right ?? 0,
          statusLeft: status?.getBoundingClientRect().left ?? -1,
          statusTop: status?.getBoundingClientRect().top ?? -1,
        };
      }),
    );
    const lefts = measured.map((row) => Math.round(row.statusLeft));
    expect(
      Math.max(...lefts) - Math.min(...lefts),
      JSON.stringify(measured.map((row) => [row.text, row.statusLeft])),
    ).toBeLessThanOrEqual(1);
    for (const row of measured)
      expect(
        row.statusLeft >= row.headingRight || row.statusTop >= row.headingBottom - 1,
        row.text,
      ).toBe(true);
    await expectNoInternalText(page);
  });

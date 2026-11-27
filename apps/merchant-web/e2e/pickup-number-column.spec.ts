import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { notPausedServiceControl } from "./service-control-state";

/**
 * Batch 53 (v15 batch 52 live, Test Merchant 2, 390 zh-Hans): on Pickup the number column grew
 * with each order's own number, so the dot and "已做好 n 分钟" of orders 10–12 started further right
 * than those of orders 2–9 and the rows did not line up. Now the waiting time and the code line
 * start at the same place for 1–4 digit numbers and for an order shown by its long public
 * reference, at every width and in both languages, and no number is cut or broken. Synthetic HTTP
 * interception on the production build, TEST-only data in the shape v15 returned
 * (orderNumber "10", a 22-character public reference); no pickup code is part of the queue read.
 */
const id = (n: number) => "0190b053-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: store,
  timeZone: "America/Toronto",
};
const observedAt = "2026-11-23T11:49:00.000Z";
const numbers = ["2", "9", "10", "99", "100", "1234"] as const;
const longReference = "R".repeat(22);
const order = (n: number, orderNumber: string | null) => ({
  fulfillmentReference: id(100 + n),
  orderReference: id(200 + n),
  phase: "Ready",
  aggregateVersion: "4",
  readyAt: "2026-11-23T11:48:00.000Z",
  ...(orderNumber === null ? {} : { orderNumber }),
  publicOrderReference: String.fromCharCode(65 + n).repeat(22),
  proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-11-23T12:48:00.000Z" },
  items: [
    {
      fulfillmentItemReference: id(300 + n),
      orderedQuantity: 1,
      readyQuantity: 1,
      handedOverQuantity: 0,
      name: "Beef noodles (TEST)",
      options: [],
    },
  ],
});
const queue = {
  source: "CurrentFulfillment",
  workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
  storeReference: store,
  observedAt,
  nextAfterFulfillmentReference: null,
  items: [
    ...numbers.map((value, n) => order(n, value)),
    // No order number: the card is called by its public reference.
    { ...order(numbers.length, null), publicOrderReference: longReference },
  ],
};

async function counter(page: Page) {
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
          businessDate: "2026-11-23",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          pauseOrderingShown: true,
          navigation: [
            {
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
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
        businessDate: "2026-11-23",
        startsAt: "2026-11-23T09:00:00.000Z",
        endsAt: "2026-11-24T09:00:00.000Z",
        timeZone: scope.timeZone,
        observedAt,
      },
    }),
  );
  await page.route("**/merchant/service-control", (route) =>
    route.fulfill({ headers, json: notPausedServiceControl(store, scope.timeZone) }),
  );
  await page.route("**/merchant/pickup/query", (route) => route.fulfill({ headers, json: queue }));
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production Pickup waiting times line up for orders 2 to 1234 and a long reference, ${language} at ${width}`, async ({
      page,
    }) => {
      if (language === "zh-Hans")
        await page.addInitScript(() =>
          window.localStorage.setItem("bop.merchant.language", "zh-Hans"),
        );
      await page.setViewportSize({ width, height });
      await counter(page);
      await page.goto("/operations/pickup");
      const cards = page.getByRole("main").locator("article.pickup-queue__card");
      await expect(cards).toHaveCount(numbers.length + 1);
      const rows = await cards.evaluateAll((list) =>
        list.map((card) => {
          const box = (selector: string) => {
            const element = card.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            return rect ? { left: rect.left, top: rect.top, right: rect.right } : null;
          };
          const number = card.querySelector<HTMLElement>(".pickup-queue__number-value");
          const range = document.createRange();
          if (number) range.selectNodeContents(number);
          const lines = number ? range.getClientRects().length : 0;
          const article = card.getBoundingClientRect();
          return {
            text: number?.textContent ?? "",
            lines,
            numberRight: number?.getBoundingClientRect().right ?? 0,
            cardRight: article.right,
            phase: box(".pickup-queue__phase"),
            code: box(".pickup-queue__code"),
          };
        }),
      );
      expect(rows.map((row) => row.text)).toEqual([...numbers, longReference]);
      const phaseLeft = rows.map((row) => Math.round(row.phase?.left ?? -1));
      const codeLeft = rows.map((row) => Math.round(row.code?.left ?? -1));
      // The dot and the waiting time, and the code line under them, start at one place.
      expect(Math.max(...phaseLeft) - Math.min(...phaseLeft)).toBeLessThanOrEqual(1);
      expect(Math.max(...codeLeft) - Math.min(...codeLeft)).toBeLessThanOrEqual(1);
      for (const row of rows) {
        // A short number is never broken over two lines, and no number runs past its row.
        if (row.text.length <= 4) expect(row.lines).toBe(1);
        expect(row.numberRight).toBeLessThanOrEqual(row.cardRight + 0.5);
        // The waiting time never sits on top of the number.
        if (row.lines === 1 && row.phase && row.text.length <= 4)
          expect(row.phase.left).toBeGreaterThanOrEqual(row.numberRight);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: test.info().outputPath(`pickup-numbers-${language}-${width}.png`),
        fullPage: true,
      });
      await expectNoInternalText(page);
    });
  }

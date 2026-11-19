import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 34 (v15 b33 live minor): after closing, Pickup sometimes first showed its list and 35-55 ms
 * later inserted "Mark all not collected (N)" above it (the control depends on the Store's hours for
 * the day, read apart from the queue), pushing the list down 44 px. The list now waits for that
 * read, so the control and the list arrive together and nothing moves; a failed read holds nothing
 * back. Synthetic HTTP interception on the production build, TEST-only data.
 */
const id = (n: number) => "0190a7f3-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};
const observedAt = "2026-10-30T03:30:00.000Z";
const readyItem = (n: number) => ({
  fulfillmentReference: id(200 + n),
  orderReference: id(300 + n),
  phase: "Ready",
  aggregateVersion: "2",
  readyAt: "2026-10-30T01:00:00.000Z",
  publicOrderReference: String.fromCharCode(65 + n).repeat(22),
  proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-10-30T02:00:00.000Z" },
  items: [
    {
      fulfillmentItemReference: id(400 + n),
      orderedQuantity: 1,
      readyQuantity: 1,
      handedOverQuantity: 0,
    },
  ],
});

async function pickup(page: Page, businessDay: "late" | "failed") {
  const answered: number[] = [];
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
          businessDate: "2026-10-29",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
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
  // The day's hours arrive after the queue: service ended at 22:00 Toronto time.
  await page.route("**/merchant/business-day", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    answered.push(Date.now());
    if (businessDay === "failed")
      return route.fulfill({ status: 502, headers, json: { code: "INTERNAL_API_UNAVAILABLE" } });
    return route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-29",
        startsAt: "2026-10-29T08:00:00.000Z",
        endsAt: "2026-10-30T08:00:00.000Z",
        timeZone: scope.timeZone,
        observedAt,
        closesAt: "2026-10-30T02:00:00.000Z",
      },
    });
  });
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: store,
        observedAt,
        nextAfterFulfillmentReference: null,
        items: [readyItem(1), readyItem(2), readyItem(3), readyItem(4)],
      },
    }),
  );
  // Every frame: where the first order is, and whether the closing control is there.
  await page.addInitScript(() => {
    const samples: { top: number; closing: boolean; at: number }[] = [];
    (window as unknown as { pickupSamples: typeof samples }).pickupSamples = samples;
    const sample = () => {
      const first = document.querySelector("main article");
      if (first !== null)
        samples.push({
          top: Math.round(first.getBoundingClientRect().top + window.scrollY),
          closing: document.querySelector(".pickup-closing") !== null,
          at: Date.now(),
        });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return answered;
}

const samples = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { pickupSamples: { top: number; closing: boolean; at: number }[] })
        .pickupSamples,
  );

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const)
  test(`@production after closing, Pickup shows Mark all not collected with its list and nothing moves (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await pickup(page, "late");
    await page.goto("/operations/pickup");
    const markAll = page.getByRole("button", { name: "Mark all not collected (4)" });
    await expect(markAll).toBeVisible();
    await expect(page.locator("main article")).toHaveCount(4);
    // A second after the list showed, it is still where it first appeared.
    await page.waitForTimeout(1_000);
    const seen = await samples(page);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.closing)).toBe(true);
    expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/b34-pickup-closing-${width}-en.png` });
    await page.getByRole("button", { name: "切换到中文" }).first().click();
    await expect(page.getByRole("button", { name: "全部标记未取餐（4）" })).toBeVisible();
    await page.screenshot({ path: `test-results/b34-pickup-closing-${width}-zh-Hans.png` });
    await expectNoInternalText(page);
  });

test("@production a failed read of the day's hours holds nothing back: the list shows, with no closing control", async ({
  page,
}) => {
  const answered = await pickup(page, "failed");
  await page.goto("/operations/pickup");
  await expect(page.locator("main article")).toHaveCount(4);
  await page.waitForTimeout(600);
  const seen = await samples(page);
  // Shown as soon as the read failed, not after the 2 s cap.
  expect(answered.length).toBeGreaterThan(0);
  expect((seen[0]?.at ?? Infinity) - (answered[0] ?? 0)).toBeLessThan(1_000);
  expect(seen.some((entry) => entry.closing)).toBe(false);
  expect(new Set(seen.map((entry) => entry.top)).size).toBe(1);
  await expectNoInternalText(page);
});

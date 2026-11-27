import { expect, test, type Page } from "@playwright/test";
import { atWidth, box, floor, headers, id, zh } from "./tables-b63-fixture";

/**
 * b63 review (F37, v3 46:324): on a phone, tapping a table dropped its panel under the whole list:
 * staff scrolled past every table to reach it, had no way back to where they were in the list,
 * and the step due scrolled away with the panel. The panel now takes the list's place, "‹ Tables"
 * brings the list back where it was, and the step due stays at the bottom of the screen.
 */
const shots = process.env.B63_SHOTS ?? "test-results/b63-shots";

/** T2 (just seated, nothing ordered) and 24 more seated tables, so the list scrolls on a phone. */
async function longFloor(page: Page) {
  await floor(page, { phase: "Active", version: 6, ordered: false }, { canTakeOrders: true });
  const seated = (n: number, label: string, ordered: boolean) => ({
    tableReference: id(200 + n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    blockReasonCode: null,
    aggregateVersion: 2,
    currentDiningSessionReference: id(400 + n),
    elapsedMinutes: 10 + n,
    qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
    paymentTiming: "PayLater",
    session: { phase: "Active", version: 6, orderReference: ordered ? id(3) : null },
    staffRoundsAwaitingPayment: [],
  });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        canTakeTableRounds: true,
        items: [
          {
            ...seated(0, "T2", false),
            tableReference: id(1),
            currentDiningSessionReference: id(2),
          },
          ...Array.from({ length: 24 }, (_, index) =>
            seated(index + 1, `S${String(index + 1).padStart(2, "0")}`, false),
          ),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
}

for (const language of ["en", "zh-Hans"] as const) {
  const chinese = language === "zh-Hans";
  const select = (label: string) =>
    ({ name: chinese ? `选择 ${label}` : `Select ${label}`, exact: true }) as const;

  test(`@production b63: on a phone a table's panel replaces the list and Tables brings it back where it was (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await longFloor(page);
    await atWidth(page, 390);
    await page.goto("/operations/dining");
    const list = page.getByRole("region", {
      name: chinese ? "按需要处理排列的桌台" : "Tables by what they need",
    });
    const panel = page.getByRole("complementary", {
      name: chinese ? "所选桌台详情" : "Selected table details",
    });
    const row = page.getByRole("button", select("S12"));
    await row.scrollIntoViewIfNeeded();
    const listAt = await page.evaluate(() => window.scrollY);
    expect(listAt).toBeGreaterThan(300);
    const rowAt = (await box(row)).y;
    await row.click();
    // The panel in the list's place: no list, no tabs above it, the table at the top.
    await expect(list).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: chinese ? "显示桌台" : "Show tables" }),
    ).toBeHidden();
    await expect(panel.locator(".table-panel__head h2")).toContainText("S12");
    const back = panel.getByRole("button", { name: chinese ? "‹ 桌台" : "‹ Tables" });
    await expect(back).toBeVisible();
    expect((await box(back)).height).toBeGreaterThanOrEqual(44);
    // The step due (take this table's order) stays at the bottom of the screen, in reach.
    const primary = panel.getByRole("link", {
      name: chinese ? /为桌台 S12 点单/u : /Take order for table S12/u,
    });
    await expect(primary).toBeVisible();
    const viewport = page.viewportSize() ?? { width: 390, height: 844 };
    const docked = await box(primary);
    expect(docked.y + docked.height).toBeGreaterThan(viewport.height - 40);
    expect(docked.y + docked.height).toBeLessThanOrEqual(viewport.height);
    expect(docked.x).toBeCloseTo(16, 0);
    expect(docked.width).toBeCloseTo(viewport.width - 32, 0);
    expect(docked.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.scrollBy(0, 200));
    const stillDocked = await box(primary);
    expect(stillDocked.y).toBeCloseTo(docked.y, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${shots}/phone-table-${language}.png` });
    // Back: the list again, where staff left it, the row they came from focused.
    await back.click();
    await expect(list).toBeVisible();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(listAt - 2);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(listAt + 2);
    // The row staff tapped is where it was on the screen.
    expect(Math.abs((await box(row)).y - rowAt)).toBeLessThan(2);
    await expect(row).toBeFocused();
    await page.screenshot({ path: `${shots}/phone-list-back-${language}.png` });
    // Another table opens in the list's place again.
    await page.getByRole("button", select("S13")).click();
    await expect(list).toBeHidden();
    await expect(panel.locator(".table-panel__head h2")).toContainText("S13");
  });

  test(`@production b63: from 768 up the list and the panel stay together, with no Tables link (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await longFloor(page);
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/operations/dining");
      await page.getByRole("button", select("T2")).click();
      const panel = page.getByRole("complementary", {
        name: chinese ? "所选桌台详情" : "Selected table details",
      });
      await expect(panel.locator(".table-panel__head h2")).toContainText("T2");
      await expect(
        page.getByRole("region", {
          name: chinese ? "按需要处理排列的桌台" : "Tables by what they need",
        }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: chinese ? "‹ 桌台" : "‹ Tables" }),
      ).toBeHidden();
      const primary = panel.locator(".table-panel__primary").first();
      await expect(primary).toBeVisible();
      expect(
        await primary.evaluate((element) => getComputedStyle(element).position),
        `${width}`,
      ).not.toBe("fixed");
    }
  });
}

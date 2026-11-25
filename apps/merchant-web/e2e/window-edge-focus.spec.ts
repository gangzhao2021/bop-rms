import { expect, test, type Page } from "@playwright/test";
import { windowEdgeSweep } from "./focus-ring-clip";
import { dishes, store as kitchenStore, workItem } from "./kitchen-tm2-fixture";

/**
 * Batch 62 (v15 batch 61 live, focus-ring-leftovers): when Tab brings a control in from below the
 * window, the browser scrolls only far enough to show the control's own box, so the bottom of its
 * ring (3 px plus a 3 px offset) is cut by the window's edge; Shift+Tab back up to the top bar's
 * language switch cut its top the same way. Live on Table QR codes, Test Merchant 2, owner: 123
 * cut rings at 390, 65 at 1024 and 4 at 1440 in a 500-stop sweep, on Print, Replace, Rename and
 * Turn off (打印, 更换, 重命名, 关闭) of each row that scrolls in (viewport bottom 6.09 / 6.34 px).
 * The batch 61 sweep found the same on Home, Exceptions and the kitchen board.
 *
 * Each test Tabs from the page's first stop to its last and Shift+Tabs back, measuring every ring
 * against the window and every clipping box around it.
 */
const id = (n: number) => "01909962-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const sizes = [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const;
type Language = "en" | "zh-Hans";

async function inLanguage(page: Page, language: Language) {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
}

/** TM2's tables as Table QR codes lists them: the batch 61 rows and the earlier test tables. */
const qrRows = () =>
  [
    ...["A", "B", "C", "D", "E"].map((letter) => `C61 ${letter} (TEST)`),
    ...["A", "B"].map((letter) => `S61 ${letter} (TEST)`),
    "F61 A (TEST)",
    "V61C A (TEST)",
    ...Array.from({ length: 21 }, (_, n) => `T${String(n + 1)}`),
  ].map((stableLabel, n) => ({
    tableReference: id(0x100 + n),
    stableLabel,
    areaCode: "MAIN",
    aggregateVersion: 3,
    seated: n % 7 === 3,
    codeState: n % 9 === 8 ? "None" : "Active",
    issuedAt: n % 9 === 8 ? null : "2026-11-01T15:00:00.000Z",
    validUntil: n % 9 === 8 ? null : "2027-05-01T15:00:00.000Z",
  }));

async function tableQrCodes(page: Page) {
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
          businessDate: "2026-11-24",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            ["HOME-OVERVIEW", "Overview", "/app", "merchant.access"],
            ["DIN-FLOOR-BOARD", "Tables", "/operations/dining", "dining.operate"],
            [
              "DIN-TABLE-LIST",
              "Table QR codes",
              "/app/operations/tables",
              "dining.table.qr.manage",
            ],
          ].map(([screenId, label, href, permission]) => ({ screenId, label, href, permission })),
        },
      },
    }),
  );
  await page.route("**/merchant/dining/table-qr", (route) =>
    route.fulfill({
      headers,
      json: { items: qrRows(), pickupLink: "https://order.example/#pickup=" + id(97) },
    }),
  );
}

const report = (sweep: Awaited<ReturnType<typeof windowEdgeSweep>>) => JSON.stringify(sweep.cut);

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production Tab keeps every ring whole at the window edge on Table QR codes at ${width} (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await tableQrCodes(page);
      await page.goto("/app/operations/tables");
      const list = page.locator("table.table-qr__list");
      await expect(list.getByRole("row")).toHaveCount(31);
      const sweep = await windowEdgeSweep(page);
      // The list is far taller than the window: Tab had to scroll it, row by row.
      expect(sweep.scrolled).toBeGreaterThan(height);
      expect(sweep.stops).toBeGreaterThan(100);
      expect(sweep.back).toBeGreaterThan(100);
      expect(sweep.cut, report(sweep)).toEqual([]);
      // Nothing moved without focus: the page is where it was before any Tab, at its top.
      await page.reload();
      await expect(list.getByRole("row")).toHaveCount(31);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    test(`@production Tab keeps every ring whole at the window edge on the kitchen board at ${width} (${language})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      // A dinner rush: 24 orders to make, each a dish named in both languages.
      await kitchenStore(
        page,
        "Named",
        { reworks: [], commands: [] },
        {
          todays: Array.from({ length: 24 }, (_, n) =>
            workItem(70 + n, {
              localizedDisplayNames: dishes[n % dishes.length],
              orderLabel: { orderNumber: String(20 + n), orderType: "Pickup", tableLabel: null },
            }),
          ),
        },
      );
      await page.goto("/operations/kitchen");
      await expect(page.locator("main")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight * 1.5))
        .toBe(true);
      const sweep = await windowEdgeSweep(page);
      expect(sweep.scrolled).toBeGreaterThan(height);
      expect(sweep.cut, report(sweep)).toEqual([]);
    });
  }

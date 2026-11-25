import { expect, test } from "@playwright/test";
import { atWidth, box, floor, widths, zh } from "./tables-b63-fixture";

/**
 * Batch 64 (v15 batch 63 live, TM2 at 390): with a table's panel open, the page's own "Table
 * settings" sat under the docked primary: on a free table the summary was at y 755-799 under the
 * button at 780-828 (a tap at y >= 785 opened the table), and on a seated table scrolled to the end
 * it was hidden. The page now keeps the docked button's room at its end, so the last thing on it
 * scrolls clear of the button; at 1024 and 1440 nothing docks and nothing covers it.
 */
for (const language of ["en", "zh-Hans"] as const)
  for (const which of ["free F1", "seated T2"] as const)
    test(`@production b64: the docked primary never covers Table settings (${which}, ${language})`, async ({
      page,
    }) => {
      const chinese = language === "zh-Hans";
      if (chinese) await zh(page);
      await floor(
        page,
        { phase: "Active", version: 6, ordered: false },
        { canOperateTables: true, canTakeOrders: true },
      );
      for (const width of widths) {
        await atWidth(page, width);
        await page.goto("/operations/dining");
        const label = which === "free F1" ? "F1" : "T2";
        await page
          .getByRole("button", { name: chinese ? `选择 ${label}` : `Select ${label}`, exact: true })
          .click();
        const panel = page.getByRole("complementary", {
          name: chinese ? "所选桌台详情" : "Selected table details",
        });
        await expect(panel.locator(".table-panel__head h2")).toContainText(label);
        const summary = page.locator(".table-settings > summary");
        await expect(summary).toHaveText(chinese ? "桌台设置" : "Table settings");
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const where = `${which} ${language} ${width}`;
        const settings = await box(summary);
        const viewport = page.viewportSize() ?? { width, height: 900 };
        expect(settings.y + settings.height, `${where}: on screen`).toBeLessThanOrEqual(
          viewport.height,
        );
        // Nothing drawn over any part of it: its middle and both ends are the summary itself.
        for (const x of [settings.x + 4, settings.x + settings.width / 2])
          for (const y of [settings.y + 2, settings.y + settings.height - 2])
            expect(
              await page.evaluate(
                ([px, py]) =>
                  document
                    .elementFromPoint(px as number, py as number)
                    ?.closest(".table-settings > summary") !== null,
                [x, y],
              ),
              `${where}: (${Math.round(x)}, ${Math.round(y)}) is Table settings`,
            ).toBe(true);
        const docked = panel.locator("[data-dock='bottom']");
        if (width === 390) {
          await expect(docked).toBeVisible();
          const button = await box(docked);
          expect(settings.y + settings.height, `${where}: above the docked button`).toBeLessThan(
            button.y - 8,
          );
        } else await expect(docked).toHaveCount(0);
        await page.screenshot({
          path: `test-results/b64-tables-settings-${which.split(" ")[1]}-${language}-${width}.png`,
        });
      }
    });

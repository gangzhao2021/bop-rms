import { expect, test, type Locator, type Page } from "@playwright/test";
import { accent } from "./tables-v3-look";
import { atWidth, box, floor, headers, id, splitBill, widths, zh } from "./tables-b63-fixture";

/**
 * b63 design review of v15 (bundle E, F33 + F35). Measured at 390, 1024 and 1440, in English and
 * Chinese; each holds with Linux fonts (sizes are set by padding and min sizes, not by the words).
 */
const shots = process.env.B63_SHOTS ?? "test-results/b63-shots";

async function openT2(page: Page, chinese: boolean) {
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: chinese ? "选择 T2" : "Select T2", exact: true }).click();
  return page.getByRole("complementary", {
    name: chinese ? "所选桌台详情" : "Selected table details",
  });
}

async function gapBetween(first: Locator, second: Locator) {
  const a = await box(first);
  const b = await box(second);
  return a.y + a.height <= b.y ? b.y - (a.y + a.height) : b.x - (a.x + a.width);
}

for (const language of ["en", "zh-Hans"] as const) {
  const chinese = language === "zh-Hans";

  // F33 (T3, v15 D62DV): Fewer/More people were 17 x 44 at 1024 and 390 — the first tap of every
  // even split. Each is now at least 44 x 44, the count between them 16/600 in even figures.
  test(`@production b63: the split's people stepper is a whole tap target at every width (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(page, { phase: "Closing", version: 7 });
    const bill = await splitBill();
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({ headers, json: bill }),
    );
    const panel = await openT2(page, chinese);
    const fewer = panel.getByRole("button", { name: chinese ? "减少人数" : "Fewer people" });
    const more = panel.getByRole("button", { name: chinese ? "增加人数" : "More people" });
    await expect(more).toBeVisible();
    for (const width of widths) {
      await atWidth(page, width);
      for (const step of [fewer, more]) {
        await step.scrollIntoViewIfNeeded();
        const size = await box(step);
        expect(size.width, `${width}`).toBeGreaterThanOrEqual(44);
        expect(size.height, `${width}`).toBeGreaterThanOrEqual(44);
      }
      const count = panel.locator(".table-split__people output");
      expect(
        await count.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.fontSize, style.fontWeight, style.fontVariantNumeric];
        }),
      ).toEqual(["16px", "600", "tabular-nums"]);
      await panel.locator(".table-split__people").screenshot({
        path: `${shots}/stepper-${language}-${width}.png`,
      });
    }
  });

  // F33 (T9): the row's Take payment was 126 x 36 (zh 60 x 36); 开台 was 36 px wide.
  test(`@production b63: the row's step and a free table's Open are 44 px targets (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(
      page,
      { phase: "Closing", version: 7 },
      { closeBlockers: ["ORDER_BALANCE_UNPAID"] },
    );
    const bill = await splitBill();
    bill.split = null;
    await page.route("**/merchant/dining/table-bill", (route) =>
      route.fulfill({ headers, json: bill }),
    );
    await page.goto("/operations/dining");
    const take = page.getByRole("button", { name: chinese ? "收款" : "Take payment" }).first();
    const open = page.getByRole("button", { name: chinese ? "开台" : "Open table", exact: true });
    await expect(take).toBeVisible();
    for (const width of widths) {
      await atWidth(page, width);
      await take.scrollIntoViewIfNeeded();
      expect((await box(take)).height, `${width}`).toBeGreaterThanOrEqual(44);
      await open.scrollIntoViewIfNeeded();
      const free = await box(open);
      expect(free.width, `${width}`).toBeGreaterThanOrEqual(44);
      expect(free.height, `${width}`).toBeGreaterThanOrEqual(44);
    }
  });

  // F35 (T5): every open table showed "This table can't be closed yet:" and two near-duplicate
  // paragraphs naming the serve step two ways. Now one dark line, no heading, nothing repeated.
  test(`@production b63: a table still serving says what is left in one line (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(
      page,
      { phase: "Active", version: 6, served: false },
      { closeBlockers: ["ORDER_BALANCE_UNPAID"] },
    );
    const panel = await openT2(page, chinese);
    const close = panel.getByRole("region", {
      name: chinese ? "关闭这张桌台" : "Close this table",
    });
    const line = chinese
      ? "菜上齐、账结清后再关台。"
      : "Close after every dish is served and the bill is paid.";
    await expect(close.locator(".dining-table-close__wait")).toContainText(line);
    await expect(close).not.toContainText(chinese ? "还不能关台" : "can't be closed yet");
    await expect(close).not.toContainText(chinese ? "全部上桌" : "Serve all on the table");
    await expect(close.getByRole("heading")).toHaveCount(0);
    await expect(close.getByRole("listitem")).toHaveCount(0);
    for (const width of widths) {
      await atWidth(page, width);
      const look = await close.locator(".dining-table-close__wait").evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.color, style.fontSize, style.fontWeight];
      });
      expect(look).toEqual(["rgb(23, 23, 23)", "14px", "400"]);
      await close.screenshot({ path: `${shots}/close-wait-${language}-${width}.png` });
    }
  });

  // F31 verifier: paid in full with a dish still to come, the next step is serving it.
  test(`@production b63: a paid table with dishes to come says serve them, then close (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(page, { phase: "Closing", version: 8, served: false });
    const panel = await openT2(page, chinese);
    const close = panel.getByRole("region", {
      name: chinese ? "关闭这张桌台" : "Close this table",
    });
    await expect(close.locator(".dining-table-close__wait")).toContainText(
      chinese ? "先把剩下的菜上齐，再关台。" : "Serve the remaining dishes, then close the table.",
    );
    await expect(close).not.toContainText(chinese ? "还不能关台" : "can't be closed yet");
  });

  // F33 (T9): "Open this table's order" was a 140 x 16 near-black underlined link.
  test(`@production b63: the link to the table's order is accent words, a 44 px target (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
    await floor(page, { phase: "Active", version: 6 }, { closeBlockers: ["REFUND_PENDING"] });
    const panel = await openT2(page, chinese);
    const link = panel.getByRole("link", {
      name: chinese ? "打开这张桌台的订单" : "Open this table's order",
    });
    await expect(link).toBeVisible();
    for (const width of widths) {
      await atWidth(page, width);
      await link.scrollIntoViewIfNeeded();
      const look = await link.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.color, style.textDecorationLine];
      });
      expect(look).toEqual([accent, "none"]);
      expect((await box(link)).height).toBeGreaterThanOrEqual(44);
    }
  });
}

// F33 (T9) + T15 on Table QR codes: five 28 px actions 15 px apart with a red Turn off between
// Rename and a grey Retire. Print and Replace stay; the rest wait under More, 24 px apart.
for (const language of ["en", "zh-Hans"] as const) {
  const chinese = language === "zh-Hans";
  test(`@production b63: Table QR codes keeps two row steps, the rest under More (${language})`, async ({
    page,
  }) => {
    if (chinese) await zh(page);
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
          csrf: "a".repeat(43),
          workspace: {
            screenId: "HOME-OVERVIEW",
            selectedScope: scope,
            authorizedStores: [scope],
            businessDate: "2026-11-25",
            storeStatus: "Open",
            freshness: "Current",
            dashboardAvailability: "UnavailableUntilWP1905",
            navigation: [
              {
                screenId: "DIN-TABLE-LIST",
                label: "Table QR codes",
                href: "/app/operations/tables",
                permission: "dining.table.qr.manage",
              },
            ],
          },
        },
      }),
    );
    const later = new Date(Date.now() + 170 * 86_400_000).toISOString();
    const row = (n: number, label: string, seated: boolean) => ({
      tableReference: id(n),
      stableLabel: label,
      areaCode: "MAIN",
      aggregateVersion: 3,
      seated,
      codeState: "Active",
      issuedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      validUntil: later,
    });
    await page.route("**/merchant/dining/table-qr", (route) =>
      route.fulfill({ headers, json: { items: [row(1, "T1", false), row(2, "T2", true)] } }),
    );
    await page.goto("/app/operations/tables");
    const t1 = page.getByRole("row", { name: /T1/u });
    await expect(
      page.getByRole("columnheader", { name: chinese ? "状态" : "Status" }),
    ).toBeVisible();
    const print = t1.getByRole("button", { name: chinese ? "打印" : "Print", exact: true });
    const replace = t1.getByRole("button", { name: chinese ? "更换" : "Replace", exact: true });
    const more = t1.getByRole("button", { name: chinese ? "更多" : "More", exact: true });
    const rename = t1.getByRole("button", { name: chinese ? "重命名" : "Rename", exact: true });
    const turnOff = t1.getByRole("button", { name: chinese ? "关闭" : "Turn off", exact: true });
    const retire = t1.getByRole("button", { name: chinese ? "停用" : "Retire", exact: true });
    await expect(print).toBeVisible();
    await expect(rename).toBeHidden();
    await expect(turnOff).toBeHidden();
    await expect(retire).toBeHidden();
    for (const width of widths) {
      await atWidth(page, width);
      for (const step of [print, replace, more]) {
        const size = await box(step);
        expect(size.width, `${width}`).toBeGreaterThanOrEqual(44);
        expect(size.height, `${width}`).toBeGreaterThanOrEqual(44);
      }
      expect(await gapBetween(print, replace), `${width}`).toBeGreaterThanOrEqual(24);
      expect(await gapBetween(replace, more), `${width}`).toBeGreaterThanOrEqual(24);
      await more.click();
      for (const step of [rename, turnOff, retire]) {
        const size = await box(step);
        expect(size.width, `${width}`).toBeGreaterThanOrEqual(44);
        expect(size.height, `${width}`).toBeGreaterThanOrEqual(44);
      }
      expect(await gapBetween(rename, turnOff), `${width}`).toBeGreaterThanOrEqual(24);
      expect(await gapBetween(turnOff, retire), `${width}`).toBeGreaterThanOrEqual(24);
      // Retire is red words, never grey.
      expect(await retire.evaluate((element) => getComputedStyle(element).color)).not.toBe(
        "rgb(102, 102, 102)",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `${shots}/qr-more-${language}-${width}.png`, fullPage: true });
      await more.click();
      await expect(rename).toBeHidden();
    }
    // A seated table's Retire is said in words (close the table first), never a grey button.
    const t2 = page.getByRole("row", { name: /T2/u });
    await t2.getByRole("button", { name: chinese ? "更多" : "More", exact: true }).click();
    await expect(t2.getByRole("button", { name: chinese ? "停用" : "Retire" })).toHaveCount(0);
    await expect(t2).toContainText(
      chinese
        ? "客人离开、关台后才能停用。"
        : "Retire after the guests leave and the table is closed.",
    );
  });
}

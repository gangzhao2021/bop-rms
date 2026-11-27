import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { renderTableQrSheet } from "../../api/src/table-qr-sheet.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 58 (v15 b57 live, TM2 with 157 printable tables): "Print all codes" sent all 157 tables
 * in one sheet request, the API refused more than 100 and answered 503, and staff were told to
 * try again, which could never work. A Store prints every code its page shows, in one file.
 *
 * The sheet route answers with the real sheet renderer, so the page and the renderer's bound are
 * checked together. Codes and links are never written to the test output: only counts are compared.
 */
const id = (n: number) => "018f7800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(9999),
};
const headers = { "cache-control": "no-store" };
const later = new Date(Date.now() + 170 * 24 * 60 * 60 * 1000).toISOString();
const issued = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const tables = 157;
const rows = Array.from({ length: tables }, (_, i) => ({
  tableReference: id(i + 1),
  stableLabel: "T" + (i + 1),
  areaCode: "MAIN",
  aggregateVersion: 3,
  seated: false,
  codeState: "Active",
  issuedAt: issued,
  validUntil: later,
}));
// A synthetic code link as long as a real signed table code (header, payload, 86-character
// signature), so every card is the QR size real codes print at.
const link = (n: number) =>
  "https://order.example.test/#qr=" +
  "e".repeat(80) +
  "." +
  n.toString(36).padStart(8, "0").padEnd(440, "p") +
  "." +
  "s".repeat(86);

async function open(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => window.localStorage.setItem("bop.merchant.language", "zh-Hans"));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-11-24",
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
  await page.route("**/merchant/dining/table-qr", (route) =>
    route.fulfill({ headers, json: { items: rows } }),
  );
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const language of ["en", "zh-Hans"] as const) {
  test(`@production Table QR codes: Print all prints every one of ${tables} tables in one file (${language})`, async ({
    page,
  }) => {
    await open(page, language);
    const requested: number[] = [];
    await page.route("**/merchant/dining/table-qr/sheet", async (route) => {
      const body = route.request().postDataJSON() as { tableReferences: string[] };
      requested.push(body.tableReferences.length);
      const byReference = new Map(rows.map((row, i) => [row.tableReference, i + 1]));
      let html: string;
      try {
        html = renderTableQrSheet({
          storeName: "Training Store",
          timeZone: "America/Toronto",
          cards: body.tableReferences.map((reference) => {
            const n = byReference.get(reference) ?? 0;
            return { tableLabel: "T" + n, url: link(n), validUntil: later };
          }),
        });
      } catch {
        // What the API answers when the sheet cannot be made.
        await route.fulfill({ status: 503, headers, json: { error: "service_unavailable" } });
        return;
      }
      await route.fulfill({ headers, json: { fileName: "table-qr-codes-2026-11-24.html", html } });
    });
    await page.goto("/app/operations/tables");
    await expect(page.getByRole("row", { name: /T157/u })).toBeVisible();

    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: language === "en" ? "Print all codes" : "打印所有桌台二维码" })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("table-qr-codes-2026-11-24.html");
    // One request and one file for every printable table.
    expect(requested).toEqual([tables]);
    await expect(
      page.getByText(
        language === "en"
          ? `Downloaded table-qr-codes-2026-11-24.html with ${tables} table QR codes. Open it and print at 100% scale.`
          : `已下载 table-qr-codes-2026-11-24.html，里面有 ${tables} 张桌台二维码。打开后按 100% 比例打印。`,
      ),
    ).toBeVisible();

    // The downloaded file opens as a page with one card and one code per table.
    const html = await readFile((await file.path()) ?? "", "utf8");
    const sheet = await page.context().newPage();
    await sheet.setContent(html);
    const counts = await sheet.evaluate(() => ({
      cards: document.querySelectorAll("article.card").length,
      codes: document.querySelectorAll("article.card a.code svg").length,
      lastLabel: document.querySelector("article.card:last-of-type h2")?.textContent ?? "",
    }));
    expect(counts).toEqual({ cards: tables, codes: tables, lastLabel: "Table T157" });
    await sheet.close();

    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(page.locator(".table-qr__notices")).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/table-qr-print-all-${language}-${width}.png`,
        fullPage: false,
      });
    }
    // The downloaded file's own name (it carries the Store's date) is what staff look for.
    await expectNoInternalText(page, ["table-qr-codes-2026-11-24.html"]);
  });

  test(`@production Table QR codes: a sheet over the file's limit is refused in plain words, not as an outage (${language})`, async ({
    page,
  }) => {
    await open(page, language);
    await page.route("**/merchant/dining/table-qr/sheet", (route) =>
      route.fulfill({ status: 413, headers, json: { error: "dining_table_qr_too_many" } }),
    );
    await page.goto("/app/operations/tables");
    await expect(page.getByRole("row", { name: /T157/u })).toBeVisible();
    await page
      .getByRole("button", { name: language === "en" ? "Print all codes" : "打印所有桌台二维码" })
      .click();
    const notice = page.locator(".table-qr__notices");
    await expect(notice).toContainText(
      language === "en"
        ? "One file can hold up to 500 table codes. Nothing changed."
        : "一个文件最多可放 500 张桌台二维码。没有任何更改。",
    );
    // A refusal never asks staff to repeat what cannot work.
    await expect(notice).not.toContainText(language === "en" ? "try again" : "重试");
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(notice).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/table-qr-too-many-${language}-${width}.png`,
        fullPage: false,
      });
    }
    await expectNoInternalText(page);
  });
}

import { describe, expect, it } from "vitest";
import {
  renderTableQrSheet,
  renderTableQrSheetGivingWay,
  tableQrSheetMaximum,
} from "./table-qr-sheet.js";

const url = (n: number) => "https://127.0.0.1:4443/#qr=aaa.bbb" + n + "." + "c".repeat(86);

describe("WP-2423 Q11 printable table code sheet", () => {
  it("prints one card per table with plain guest instructions and the store-local end date", () => {
    const html = renderTableQrSheet({
      storeName: "DEMO <Store>",
      timeZone: "America/Toronto",
      cards: [
        { tableLabel: "T1", url: url(1), validUntil: "2027-04-12T03:30:00.000Z" },
        { tableLabel: "Patio & 2", url: url(2), validUntil: "2027-04-12T03:30:00.000Z" },
      ],
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<article class="card">/gu)).toHaveLength(2);
    expect(html).toContain("<h2>Table T1</h2>");
    expect(html).toContain("<h2>Table Patio &amp; 2</h2>");
    expect(html).toContain("DEMO &lt;Store&gt;");
    expect(html).toContain("Ask your server for this table's joining code.");
    expect(html).toContain("No app or account needed.");
    // Toronto local date of 03:30 UTC on 12 April is 11 April.
    expect(html).toContain("Code works until April 11, 2027");
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script/iu);
  });

  it("batch 58: holds every table a Store lists (500) within the size and time budget", () => {
    // A link as long as a pilot table code under a longer customer origin.
    const link = (n: number) =>
      "https://order.example-restaurant-group.ca/#qr=" +
      "e".repeat(80) +
      "." +
      n.toString(36).padStart(8, "0").padEnd(440, "p") +
      "." +
      "s".repeat(86);
    const started = performance.now();
    const html = renderTableQrSheet({
      storeName: "DEMO Hall",
      timeZone: "America/Toronto",
      cards: Array.from({ length: tableQrSheetMaximum }, (_, i) => ({
        tableLabel: "Hall " + (i + 1),
        url: link(i + 1),
        validUntil: "2027-04-12T03:30:00.000Z",
      })),
    });
    const seconds = (performance.now() - started) / 1000;
    expect(tableQrSheetMaximum).toBe(500);
    expect(html.split('<article class="card">').length - 1).toBe(500);
    // About 17 MB; the page reads up to 40 MB. Made in about 3 s on a developer Mac.
    expect(html.length).toBeLessThan(20_000_000);
    expect(seconds).toBeLessThan(30);
  });

  it("batch 58: draws the same sheet a few cards at a time, letting other work run between", async () => {
    const input = {
      storeName: "S",
      timeZone: "UTC",
      cards: Array.from({ length: 45 }, (_, i) => ({
        tableLabel: "T" + (i + 1),
        url: url(i + 1),
        validUntil: "2027-04-12T03:30:00.000Z",
      })),
    };
    let otherWork = 0;
    const tick = () => {
      otherWork++;
      if (otherWork < 100) setImmediate(tick);
    };
    setImmediate(tick);
    const html = await renderTableQrSheetGivingWay(input, 20);
    expect(otherWork).toBeGreaterThanOrEqual(2);
    expect(html).toBe(renderTableQrSheet(input));
    await expect(renderTableQrSheetGivingWay({ ...input, cards: [] })).rejects.toThrow(
      "TABLE_QR_SHEET_INVALID",
    );
  });

  it("refuses an empty sheet, more than 500 tables and a non-HTTPS or non-QR link", () => {
    const card = { tableLabel: "T1", url: url(1), validUntil: "2027-04-12T03:30:00.000Z" };
    const sheet = (cards: (typeof card)[]) =>
      renderTableQrSheet({ storeName: "S", timeZone: "UTC", cards });
    expect(() => sheet([])).toThrow("TABLE_QR_SHEET_INVALID");
    expect(() => sheet(Array.from({ length: 501 }, () => card))).toThrow("TABLE_QR_SHEET_INVALID");
    expect(sheet(Array.from({ length: 101 }, () => card)).split("<article").length - 1).toBe(101);
    expect(() => sheet([{ ...card, url: "http://127.0.0.1/#qr=a.b.c" }])).toThrow(
      "TABLE_QR_SHEET_INVALID",
    );
    expect(() => sheet([{ ...card, url: "https://127.0.0.1/?t=a.b.c" }])).toThrow(
      "TABLE_QR_SHEET_INVALID",
    );
  });
});

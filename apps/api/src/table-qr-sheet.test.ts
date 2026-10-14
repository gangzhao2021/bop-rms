import { describe, expect, it } from "vitest";
import { renderTableQrSheet } from "./table-qr-sheet.js";

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

  it("refuses an empty sheet, more than 100 tables and a non-HTTPS or non-QR link", () => {
    const card = { tableLabel: "T1", url: url(1), validUntil: "2027-04-12T03:30:00.000Z" };
    const sheet = (cards: (typeof card)[]) =>
      renderTableQrSheet({ storeName: "S", timeZone: "UTC", cards });
    expect(() => sheet([])).toThrow("TABLE_QR_SHEET_INVALID");
    expect(() => sheet(Array.from({ length: 101 }, () => card))).toThrow("TABLE_QR_SHEET_INVALID");
    expect(() => sheet([{ ...card, url: "http://127.0.0.1/#qr=a.b.c" }])).toThrow(
      "TABLE_QR_SHEET_INVALID",
    );
    expect(() => sheet([{ ...card, url: "https://127.0.0.1/?t=a.b.c" }])).toThrow(
      "TABLE_QR_SHEET_INVALID",
    );
  });
});

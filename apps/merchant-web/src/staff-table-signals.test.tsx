import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { elapsedText } from "./elapsed-text.js";
import { openedOnEarlierDay } from "./earlier-day-tables.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { parseKitchenBoardView, type KitchenBoardItem } from "./kitchen-board.js";
import { kitchenBoardSearch } from "./KitchenBoardPages.js";
import { fromEarlierKitchenDay, previousBusinessDate } from "./KitchenEarlierDays.js";
import { optionLabel, type AvailabilityOption } from "./store-availability-page.js";
import { parseTonightSummary } from "./store-reports-client.js";
import { heldRoundReasonText, staffCallReasonText } from "./table-needs.js";
import { tablesClosingAlert } from "./tables-closing-alert.js";
import { TonightSummaryView } from "./TonightSummary.js";
import { tonightSummaryFixture } from "./tonight-summary.fixtures.js";

// b39 (v15 b38 dinner sweep): what staff read about tables, calls, choices and earlier days.
afterEach(() => setLanguageForTest("en"));

describe("b39 guest call reasons and durations in staff words", () => {
  it("says what the guest chose, in English and Chinese", () => {
    expect(staffCallReasonText("TableNeeds")).toBe("Water, cutlery, napkins");
    setLanguageForTest("zh-Hans");
    expect(staffCallReasonText("TableNeeds")).toBe("水、餐具、纸巾");
  });
  it("never says 'just now' beside how long a held round waited", () => {
    expect(heldRoundReasonText("PhoneRapid")).not.toMatch(/just now/u);
    setLanguageForTest("zh-Hans");
    expect(heldRoundReasonText("PhoneRapid")).not.toMatch(/刚/u);
  });
  it("reads two weeks as days, never as thousands of minutes", () => {
    expect(elapsedText(21_563)).toBe("14 days");
    expect(elapsedText(90)).toBe("1 h 30 min");
    setLanguageForTest("zh-Hans");
    expect(elapsedText(21_563)).toBe("14 天");
  });
});

describe("b39 same-named choices in different groups", () => {
  const option = (n: number, name: string, groupName: string): AvailabilityOption => ({
    optionReference: String(n),
    name,
    groupName,
    dishNames: ["鸳鸯锅"],
    status: "Available",
    soldOutUntil: null,
  });
  it("names the group only when another choice has the same name", () => {
    const options = [
      option(1, "番茄", "第一边"),
      option(2, "番茄", "第二边"),
      option(3, "菌菇", "第一边"),
    ];
    expect(options.map((entry) => optionLabel(entry, options))).toEqual([
      "番茄 · 第一边",
      "番茄 · 第二边",
      "菌菇",
    ]);
  });
  it("b40: on a Chinese screen a group with no Chinese name keeps the merchant's own name", () => {
    // v15: Fireside Hotpot named the pot's groups only in English. Its words are the only thing
    // that tells the two 番茄 apart; nothing is translated or invented for the merchant.
    setLanguageForTest("zh-Hans");
    const options = [option(1, "番茄", "Side one broth"), option(2, "番茄", "Side two broth")];
    expect(options.map((entry) => optionLabel(entry, options))).toEqual([
      "番茄 · Side one broth",
      "番茄 · Side two broth",
    ]);
  });
});

describe("b39 earlier days are not today's", () => {
  const dayStart = Date.parse("2026-11-20T09:00:00.000Z");
  const at = Date.parse("2026-11-21T01:00:00.000Z");
  it("keeps a late service past the day's turn as today's, a two-week-old table apart", () => {
    expect(openedOnEarlierDay(60, at, dayStart)).toBe(false);
    // Seated at 00:00 Store time, the day turning at 04:00: a late service, still today's at 05:00.
    expect(
      openedOnEarlierDay(
        5 * 60,
        Date.parse("2026-11-21T10:00:00.000Z"),
        Date.parse("2026-11-21T09:00:00.000Z"),
      ),
    ).toBe(false);
    expect(openedOnEarlierDay(17 * 60, at, dayStart)).toBe(true);
    expect(openedOnEarlierDay(21_563, at, dayStart)).toBe(true);
    expect(openedOnEarlierDay(null, at, dayStart)).toBe(false);
    expect(openedOnEarlierDay(21_563, at, Number.NaN)).toBe(false);
  });
  it("keeps a seated table's round from the day before on today's board, older ones apart", () => {
    expect(previousBusinessDate("2026-11-20")).toBe("2026-11-19");
    expect(previousBusinessDate("2026-03-01")).toBe("2026-02-28");
    const round = (businessDate: string) => ({ businessDate, atSeatedTable: true });
    expect(fromEarlierKitchenDay(round("2026-11-19"), "2026-11-20")).toBe(false);
    expect(fromEarlierKitchenDay(round("2026-11-05"), "2026-11-20")).toBe(true);
    expect(fromEarlierKitchenDay({ businessDate: "2026-11-19" }, "2026-11-20")).toBe(true);
  });
  it("b39-2: moves a table seated the evening before and never closed off today's kitchen board", () => {
    // Business day Nov 20 began at 04:00 Toronto (09:00Z). Table 5 was seated Nov 19 at 19:00
    // (00:00Z) and never closed; at 14:00 on Nov 20 Tables lists it under "From earlier days".
    const at = "2026-11-20T19:00:00.000Z";
    const seated = (n: number, createdAt: string, tableLabel: string) => ({
      ...kitchenItemFixture(),
      workItemReference: `018f0f58-767a-7f3b-a1d0-00000000050${n}`,
      ticketReference: `018f0f58-767a-7f3b-a1d0-00000000060${n}`,
      orderReference: `018f0f58-767a-7f3b-a1d0-00000000070${n}`,
      createdAt,
      businessDate: "2026-11-19",
      atSeatedTable: true,
      orderLabel: { orderNumber: String(n), orderType: "DineIn", tableLabel },
    });
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      projectedAt: at,
      items: [
        // The forgotten table: its dinner round, and a last round at 02:00 (07:00Z).
        seated(1, "2026-11-20T00:10:00.000Z", "5"),
        seated(2, "2026-11-20T07:00:00.000Z", "5"),
        // A late service seated at 03:30 (08:30Z), still eating at 14:00: today's work.
        seated(3, "2026-11-20T08:30:00.000Z", "9"),
      ],
    });
    const board = kitchenBoardSearch({
      items: view.items,
      reworks: [],
      today: "2026-11-20",
      at,
      search: null,
    });
    expect(board.earlier.map((ticket) => ticket.orderLabel)).toEqual([
      "Table 5 · Order 1",
      "Table 5 · Order 2",
    ]);
    expect(board.todayMatches.map((item) => item.orderLabel?.tableLabel)).toEqual(["9"]);
    // One ticket alone, aged by its own time: 19 h old is an earlier day's, 10 h 30 min is not.
    const [dinner, , late] = view.items as readonly [
      KitchenBoardItem,
      KitchenBoardItem,
      KitchenBoardItem,
    ];
    expect(fromEarlierKitchenDay(dinner, "2026-11-20", at)).toBe(true);
    expect(fromEarlierKitchenDay(late, "2026-11-20", at)).toBe(false);
  });
  it("lists an earlier day's table apart in tonight's summary, out of tonight's amount", () => {
    const fixture = tonightSummaryFixture();
    const openTables = [
      ...(fixture.openTables as { owedMinor: string }[]),
      {
        tableLabel: "5",
        phase: "Closing",
        paymentTiming: "PayLater",
        owedMinor: "9596",
        openedMinutes: 21_563,
        standing: "Owes",
      },
    ];
    const summary = parseTonightSummary({
      ...fixture,
      openTables,
      openTablesOwedMinor: String(
        openTables.reduce((sum, table) => sum + Number(table.owedMinor), 0),
      ),
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TonightSummaryView summary={summary} />
      </MemoryRouter>,
    );
    expect(html).toContain("From earlier days");
    expect(html).toContain("Table 5");
    expect(html).toContain("open 14 days");
    expect(html).not.toMatch(/\d{4,} min/u);
    const tonight = html.slice(0, html.indexOf("From earlier days"));
    expect(tonight).not.toContain("$95.96");
  });
});

describe("b39 warn before the business day ends with tables open", () => {
  const day = { endsAt: "2026-11-21T09:00:00.000Z", closesAt: "2026-11-21T03:00:00.000Z" };
  const zone = "America/Toronto";
  it("says nothing earlier in the evening or with every table closed", () => {
    expect(tablesClosingAlert(day, Date.parse("2026-11-21T01:00:00.000Z"), 3, zone)).toBeNull();
    expect(tablesClosingAlert(day, Date.parse("2026-11-21T02:30:00.000Z"), 0, zone)).toBeNull();
    expect(tablesClosingAlert(null, Date.parse("2026-11-21T02:30:00.000Z"), 3, zone)).toBeNull();
  });
  it("warns from an hour before closing, and after closing until the day ends", () => {
    // The time is the Store's, written as the guests' pages write it (b40: "10:00 p.m.", never
    // "10:00 PM"), and a time that ends the sentence brings its own period.
    const soon = tablesClosingAlert(day, Date.parse("2026-11-21T02:30:00.000Z"), 3, zone);
    expect(soon?.tone).toBe("soon");
    expect(soon?.text).toMatch(
      /^Closing at 10:00\sp\.m\.: 3 tables still open\. Take each table's payment and close it when the guests leave\.$/u,
    );
    expect(tablesClosingAlert(day, Date.parse("2026-11-21T05:00:00.000Z"), 1, zone)?.text).toMatch(
      /^Closed at 10:00\sp\.m\.: 1 table still open\. Take the payment, or record that the guests left without paying, and close each table before the day ends at 4:00\sa\.m\.$/u,
    );
    expect(tablesClosingAlert(day, Date.parse("2026-11-21T09:00:00.000Z"), 1, zone)).toBeNull();
  });
  it("batch 47: a Store open 24 hours is told when the day ends, never that it is closing", () => {
    // /merchant/business-day for Test Merchant 2: open all day, so it closes with the day.
    const allDay = { endsAt: day.endsAt, closesAt: day.endsAt };
    expect(tablesClosingAlert(allDay, Date.parse("2026-11-21T07:00:00.000Z"), 2, zone)).toBeNull();
    const last = tablesClosingAlert(allDay, Date.parse("2026-11-21T08:30:00.000Z"), 2, zone);
    expect(last?.tone).toBe("past");
    expect(last?.text).toMatch(/^The business day ends at 4:00\sa\.m\.: 2 tables still open\./u);
    expect(last?.text).not.toMatch(/Clos/u);
  });
  it("without published hours, warns in the day's last hour", () => {
    const open = { endsAt: day.endsAt, closesAt: null };
    expect(tablesClosingAlert(open, Date.parse("2026-11-21T07:00:00.000Z"), 2, zone)).toBeNull();
    expect(tablesClosingAlert(open, Date.parse("2026-11-21T08:30:00.000Z"), 2, zone)?.tone).toBe(
      "past",
    );
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { StoreBusinessDayContext } from "./StoreBusinessDay.js";
import { StoreReports, StoreReportsPage, coveredRangeFrom, shiftDate } from "./StoreReportsPage.js";
import { createStoreReportsClient, parseStoreReportsView } from "./store-reports-client.js";
import { storeReportsViewFixture } from "./store-reports.fixtures.js";

const render = (value: unknown, onDownload: (() => void) | null = () => undefined) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StoreReports view={parseStoreReportsView(value)} onDownload={onDownload} />
    </MemoryRouter>,
  );

describe("WP-2423 Q14 store reports client", () => {
  it("parses the reports view strictly", () => {
    const view = parseStoreReportsView(storeReportsViewFixture());
    expect(view.summary.collectedMinor).toBe("5097");
    expect(view.days.map((day) => day.status)).toEqual(["Closed", "Open"]);
    expect(view.mayExport).toBe(true);
    for (const corrupt of [
      { screenId: "PAY-RECONCILIATION" },
      { from: "2026/10/13" },
      { from: "2026-10-15" },
      { currencyCode: "USD" },
      { extra: true },
      { hours: [{ hour: "25:00" }] },
    ])
      expect(() => parseStoreReportsView({ ...storeReportsViewFixture(), ...corrupt })).toThrow();
  });
  it("reads and downloads with the same-origin, no-store contract and maps denial and busy", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("same-origin");
      if (String(input).startsWith("/merchant/reports/export"))
        return new Response("﻿business_date,item\r\n", {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="items-2026-10-13-to-2026-10-14.csv"',
            "cache-control": "no-store",
          },
        });
      expect(String(input)).toBe("/merchant/reports?from=2026-10-13&to=2026-10-14");
      return new Response(JSON.stringify(storeReportsViewFixture()), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    });
    const client = createStoreReportsClient(fetcher as typeof fetch);
    const signal = new AbortController().signal;
    expect((await client.load("2026-10-13", "2026-10-14", signal)).to).toBe("2026-10-14");
    const file = await client.download("items", "2026-10-13", "2026-10-14", signal);
    expect(file.fileName).toBe("items-2026-10-13-to-2026-10-14.csv");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "/merchant/reports/export?report=items&from=2026-10-13&to=2026-10-14",
    );
    await expect(client.load("2026-10-14", "2026-10-13", signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
    const denied = createStoreReportsClient(
      (async () => new Response("{}", { status: 403 })) as typeof fetch,
    );
    await expect(denied.load("2026-10-14", "2026-10-14", signal)).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    const busy = createStoreReportsClient(
      (async () =>
        new Response(JSON.stringify({ error: "reports_busy" }), { status: 503 })) as typeof fetch,
    );
    await expect(busy.load("2026-10-14", "2026-10-14", signal)).rejects.toMatchObject({
      code: "Busy",
    });
  });
});

describe("WP-2423 Q14 store reports page", () => {
  it("shows the summary, payment and order-type splits, items, hours and tips in plain words", () => {
    const html = render(storeReportsViewFixture());
    expect(html).toContain("Tue, Oct 13 – Wed, Oct 14");
    expect(html).toContain("Today so far");
    expect(html).toContain(
      "Closed days match the day-end settlement. Today is checked against it when the day closes.",
    );
    for (const text of [
      "Gross sales",
      "Net sales",
      "Tax · SYNTHETIC TAX",
      "Total collected",
      "Net collected",
      "Online (card)",
      "Store card machine",
      "Dine-in",
      "Pickup",
      "Counter",
      "Latte — Large",
      "Muffin",
      "Sales by hour",
      "11:00",
      "does not record which staff member earned them",
      "Download CSV",
      "By day",
    ])
      expect(html).toContain(text);
    // No internal references or codes reach staff.
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(html).not.toContain("CardMachine");
    expect(html).not.toContain("DineIn");
  });
  it("says an open day is checked at day end and a closed range matches the settlement", () => {
    const fixture = storeReportsViewFixture();
    const days = fixture.days as readonly Record<string, unknown>[];
    const today = render({ ...fixture, days: days.filter((day) => day.status === "Open") });
    expect(today).toContain("Checked against the day-end settlement when the day closes.");
    expect(today).not.toContain("Matches the day-end settlement");
    const closed = render({
      ...fixture,
      includesOpenDay: false,
      days: days.map((day) => ({ ...day, status: "Closed" })),
    });
    expect(closed).toContain("Matches the day-end settlement: $50.97 collected, $19.22 refunded.");
    expect(closed).not.toContain("when the day closes");
  });
  it("says when the totals differ from the settlement and when refunds await confirmation", () => {
    const fixture = storeReportsViewFixture();
    const html = render({
      ...fixture,
      reconciliation: {
        ...(fixture.reconciliation as Record<string, unknown>),
        matchesSettlement: false,
        settlementCollectedMinor: "5000",
        pendingOnlineRefundCount: 2,
      },
    });
    expect(html).toContain("These totals differ from the day-end settlement");
    expect(html).toContain('href="/app/operations/payment-reconciliation"');
    expect(html).toContain("2 online refunds");
  });
  it("DEC-DINE-IN-PAY-LATER: lists tables written off when guests left without paying", () => {
    const view = storeReportsViewFixture();
    const summary = view.summary as Record<string, unknown>;
    summary.unpaidWriteOffCount = 1;
    summary.unpaidWriteOffMinor = "537";
    const html = render(view);
    expect(html).toContain("Guests left without paying (written off) · 1 table");
    expect(html).toContain("$5.37");
    // None in the period: no line.
    expect(render(storeReportsViewFixture())).not.toContain("written off");
  });

  it("WP-2423 item 8 ① segment 2: lists a manager's comps and discounts on their own line", () => {
    const view = storeReportsViewFixture();
    const summary = view.summary as Record<string, unknown>;
    summary.compCount = 2;
    summary.compsMinor = "2830";
    const html = render(view);
    expect(html).toContain("Comps and discounts by a manager · 2 dishes");
    expect(html).toContain("−$28.30");
    expect(render(storeReportsViewFixture())).not.toContain("Comps and discounts by a manager");
  });

  it("offers downloads only with the export permission", () => {
    const html = render({ ...storeReportsViewFixture(), permissions: { mayExport: false } });
    expect(html).not.toContain("Download CSV");
    expect(html).toContain("Downloading reports needs the export permission.");
  });
  it("shows empty periods plainly", () => {
    const fixture = storeReportsViewFixture();
    const html = render({ ...fixture, items: [], hours: [], tips: [] });
    expect(html).toContain("No items sold or refunded in this period.");
    expect(html).toContain("No payments in this period.");
    expect(html).toContain("No tips in this period.");
  });
  it("starts on the Store's current business day and limits the period", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreBusinessDayContext.Provider
          value={{
            businessDate: "2026-10-14",
            startsAt: "2026-10-14T08:00:00.000Z",
            endsAt: "2026-10-15T08:00:00.000Z",
          }}
        >
          <StoreReportsPage
            storeLabel="Synthetic Store"
            fetcher={vi.fn() as typeof fetch}
            initialTab="Period"
          />
        </StoreBusinessDayContext.Provider>
      </MemoryRouter>,
    );
    expect(html).toContain("Reports");
    expect(html).toContain('max="2026-10-14"');
    expect(html).toContain("Last 7 days");
    expect(shiftDate("2026-11-01", -6)).toBe("2026-10-26");
  });
  it("WP-2423 item 8 ②: opens on tonight's closing summary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreReportsPage storeLabel="Synthetic Store" fetcher={vi.fn() as typeof fetch} />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-pressed="true">Today&#x27;s summary');
    expect(html).toContain("Reading today&#x27;s figures…");
    expect(html).not.toContain("Last 7 days");
  });
});

/**
 * WP-2423 M160 (v15 2026-11-06): a Store set up partway through a business day. Its first day reads
 * in full and is marked, a period asked from before it starts there and says so, and a period
 * wholly before it is an answer with the way to the first day — never "Reports unavailable".
 */
describe("WP-2423 M160 the Store's first business day in reports", () => {
  const firstDay = (fixture = storeReportsViewFixture()) => ({
    ...fixture,
    from: "2026-10-13",
    requestedFrom: "2026-10-01",
    recordsBeginOn: "2026-10-13",
    days: (fixture.days as Record<string, unknown>[]).map((day, index) => ({
      ...day,
      opensAt: index === 0 ? "2026-10-14T00:51:00.000Z" : null,
    })),
  });
  it("reads where records begin and when the first day opened, strictly", () => {
    const view = parseStoreReportsView(firstDay());
    expect(view).toMatchObject({ requestedFrom: "2026-10-01", recordsBeginOn: "2026-10-13" });
    expect(view.days.map((day) => day.opensAt)).toEqual(["2026-10-14T00:51:00.000Z", null]);
    // Before M160 the server sent neither (the period is then exactly what was asked).
    expect(parseStoreReportsView(storeReportsViewFixture())).toMatchObject({
      requestedFrom: "2026-10-13",
      recordsBeginOn: null,
    });
    for (const corrupt of [
      { recordsBeginOn: "2026-10-12" },
      { requestedFrom: "2026-10-14" },
      { recordsBeginOn: null },
      { recordsBeginOn: "13 Oct" },
    ])
      expect(() => parseStoreReportsView({ ...firstDay(), ...corrupt })).toThrow();
    const odd = firstDay();
    expect(() =>
      parseStoreReportsView({
        ...odd,
        days: odd.days.map((day) => ({ ...day, opensAt: "today" })),
      }),
    ).toThrow();
  });
  it("says the records begin on the first day and marks it in the day list", () => {
    const html = render(firstDay());
    expect(html).toContain(
      "Records begin on Tue, Oct 13. Days before that have no sales and are counted as zero.",
    );
    expect(html).toContain("First day · from 20:51");
    const single = firstDay();
    const one = render({
      ...single,
      to: "2026-10-13",
      days: single.days.slice(0, 1),
      requestedFrom: "2026-10-13",
      recordsBeginOn: null,
    });
    expect(one).toContain("First day · from 20:51");
    expect(one).not.toContain("Records begin");
  });
  it("answers a period wholly before the Store with its first day, and offers the same length from it", async () => {
    const client = createStoreReportsClient(
      (async () =>
        new Response(
          JSON.stringify({ error: "reports_not_covered", firstBusinessDate: "2026-11-04" }),
          { status: 404, headers: { "cache-control": "no-store" } },
        )) as typeof fetch,
    );
    const signal = new AbortController().signal;
    await expect(client.load("2026-10-01", "2026-10-31", signal)).rejects.toMatchObject({
      code: "NotCovered",
      firstBusinessDate: "2026-11-04",
    });
    const plain404 = createStoreReportsClient(
      (async () => new Response("{}", { status: 404 })) as typeof fetch,
    );
    await expect(plain404.load("2026-10-01", "2026-10-31", signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
    // "Show from {date}": the asked number of days from the first day, ending no later than today.
    expect(
      coveredRangeFrom("2026-11-04", { from: "2026-10-01", to: "2026-10-31" }, "2026-11-06"),
    ).toEqual({ from: "2026-11-04", to: "2026-11-06" });
    expect(
      coveredRangeFrom("2026-11-04", { from: "2026-10-30", to: "2026-10-31" }, "2026-11-20"),
    ).toEqual({ from: "2026-11-04", to: "2026-11-05" });
    expect(
      coveredRangeFrom("2026-11-04", { from: "2026-11-03", to: "2026-11-03" }, "2026-11-06"),
    ).toEqual({ from: "2026-11-04", to: "2026-11-04" });
  });
});

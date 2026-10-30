import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CurrentOrderView, EntryContextView } from "./EntryContextPage.js";
import type { CustomerEntryEstablishedContext, CustomerEntryScreenState } from "./types.js";
import { forgetSettledTable, rememberSettledTable } from "../dining/SettledTableReceipt.js";
import { setSettledTable } from "../session/customer-transaction-context.js";

const context: CustomerEntryEstablishedContext = Object.freeze({
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
  publicStoreReference: "018f2a1b-7c3d-7a4e-8b5c-1234567890ab",
  publicTableReference: "018f2a1b-7c3d-7a4e-9b5c-1234567890ab",
  channel: "DineIn",
  operatingState: "Open",
  availableServiceModes: Object.freeze(["DineIn", "Pickup"] as const),
  locale: "en-CA",
  contextExpiresAt: "2026-08-11T20:00:00.000Z",
  csrfToken: "A".repeat(43),
});

function render(state: CustomerEntryScreenState): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EntryContextView onContinue={vi.fn()} onRetry={vi.fn()} state={state} />
    </MemoryRouter>,
  );
}

describe("CUST-ENTRY-CONTEXT", () => {
  it("a table no party is seated at says so before joining, and keeps the menu to browse", () => {
    const html = render({ kind: "Established", context: { ...context, tableOpen: false } });
    expect(html).toContain("This table isn’t open yet");
    expect(html).toContain("Ask staff to seat you, then scan again.");
    expect(html).toContain("Look at the menu first");
    expect(html).not.toContain("Ready to order");
    expect(html).not.toContain("is confirmed for dine-in");
    expect(html).not.toContain("Join this table");
    // Open (or unknown) tables are unchanged.
    expect(render({ kind: "Established", context: { ...context, tableOpen: true } })).toContain(
      "Ready to order",
    );
  });

  it("a guest whose table was just settled scans again: thanked, with the receipt read before", async () => {
    setSettledTable({ tableLabel: "DEMO-03", csrfToken: "C".repeat(43) });
    await rememberSettledTable({
      read: async () => ({
        tableLabel: "DEMO-03",
        rounds: [
          {
            roundNumber: 1,
            fromTableLabel: null,
            items: [{ displayName: "Milk tea", subtotalMinor: "450", reduced: null }],
          },
        ],
        subtotalMinor: "450",
        taxMinor: "59",
        ordersTotalMinor: "509",
        tipMinor: "0",
        roundingMinor: "1",
        paidMinor: "510",
        split: false,
        payments: [{ partNumber: null, method: "Cash", totalMinor: "510" }],
      }),
    });
    setSettledTable(null);
    try {
      const html = render({ kind: "Established", context: { ...context, tableOpen: false } });
      expect(html).toContain("This table is settled. Thank you for dining with us.");
      expect(html).toContain("Table DEMO-03 has paid and closed.");
      expect(html).toContain("Milk tea");
      expect(html).toContain("$5.10");
      expect(html).toContain("New party? Ask staff to seat you, then scan again.");
      expect(html).not.toContain("This table isn’t open yet");
      // At an open table, the new party's visit goes on as usual.
      expect(render({ kind: "Established", context: { ...context, tableOpen: true } })).toContain(
        "Ready to order",
      );
    } finally {
      forgetSettledTable();
    }
  });

  it("shows the safe public context and never renders credentials or public references", () => {
    const html = render({ kind: "Established", context });
    expect(html).toContain("BOP Test Kitchen");
    expect(html).toContain("Harbour Test Store");
    expect(html).toContain("Ready to order");
    expect(html).toContain("Your table at Harbour Test Store is confirmed for dine-in");
    // The service is in the sentence above; open status and hours are said once, in the store card.
    expect(html).not.toContain("Available service");
    expect(html).not.toContain("Open for ordering");
    expect(html).toContain("Continue to menu");
    expect(html).not.toContain(context.publicStoreReference);
    expect(html).not.toContain(String(context.publicTableReference));
    expect(html).not.toContain(context.csrfToken);
    // WP-2423: the entry context's own expiry is not the Store's last-order time; don't show it.
    expect(html).not.toContain("Order by");
    expect(html).not.toContain(context.contextExpiresAt);
  });

  it.each([
    { ...context, channel: "Pickup" as const, publicTableReference: null },
    { ...context, publicTableReference: null },
    { ...context, operatingState: "Closed" as const },
    { ...context, availableServiceModes: ["Pickup"] as const },
  ])("does not offer table admission outside eligible entry context", (next) => {
    expect(render({ kind: "Established", context: next })).not.toContain(
      "dining-admission-heading",
    );
  });
  it("shows unavailable admission honestly for eligible context without runtime", () => {
    expect(render({ kind: "Established", context })).toContain("Table joining is unavailable");
  });

  it("uses explicit non-colour status and blocks continuation when closed", () => {
    const html = render({
      kind: "Established",
      context: { ...context, operatingState: "Closed", availableServiceModes: [] },
    });
    // Said once, in words (never colour alone); open hours live in the store card.
    expect(html).toContain("This location is not accepting orders");
    expect(html).not.toContain("Location status");
    expect(html).not.toContain("Continue to menu");
  });

  it.each([
    ["Missing", "Scan the location QR code", "No store search is shown"],
    ["RequestInvalid", "This entry link can’t be used", "ask a staff member"],
    ["EntryUnavailable", "This entry link can’t be used", "ask a staff member"],
    ["ServiceUnavailable", "Ordering is unavailable", "No order was submitted"],
    ["CommandFailed", "Ordering is unavailable", "No order was submitted"],
    ["Offline", "You’re offline", "No request or order was submitted"],
  ] as const)("renders the %s state with recovery", (kind, heading, recovery) => {
    const html = render({ kind } as CustomerEntryScreenState);
    expect(html).toContain(heading);
    expect(html).toContain(recovery);
  });

  it("keeps service failure bounded and explicitly retryable", () => {
    const html = render({ kind: "ServiceUnavailable" });
    expect(html).toContain("Try again");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("synthetic entry failure");
  });

  it.each([
    { kind: "Missing" },
    { kind: "Offline" },
    { kind: "ServiceUnavailable" },
    { kind: "Established", context },
  ] as const)("supplies accessibility and allergen assistance once $kind is known", (state) => {
    const html = render(state);
    expect(html).toContain("accessible ordering option");
    expect(html).toContain("allergies");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps the assistance out from under the brief loading notice so it never jumps", () => {
    const html = render({ kind: "Loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("entry-help");
  });
});

it("shows a rate-limit wait without enabling retry or revealing context", () => {
  const html = render({ kind: "RateLimited", retryAfterSeconds: 5 });
  expect(html).toContain("Please wait before trying again");
  expect(html).toContain("Try again in 5 seconds.");
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-live="off"');
  expect(html).not.toContain("Continue to menu");
  expect(html).not.toContain(context.csrfToken);
});

describe("WP-2423 Q4 not accepting orders", () => {
  it("names the store, says why and gives today's hours instead of a dead link", () => {
    const closed = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [{ start: "11:00:00", end: "21:30:00", endsNextDay: false }],
      todayKind: null,
      nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
      localDate: "2026-12-22",
    });
    expect(closed).toContain("Synthetic Store isn’t taking orders right now");
    expect(closed).toContain("The store is closed now.");
    expect(closed).toContain("Today’s hours: 11:00 AM–9:30 PM");
    expect(closed).not.toContain("can’t be used");
    // Decision 16: when the Store opens next.
    expect(closed).toContain("Opens tomorrow at 11:00 a.m.");
    const paused = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: true,
      todayHours: [],
      todayKind: null,
      nextOpening: null,
      localDate: null,
    });
    expect(paused).toContain("Online ordering is paused for a short while.");
    expect(paused).toContain("Closed today.");
  });
  it("WP-2423 item 8 ③ decision 16: a holiday says so once and gives the next opening", () => {
    const holiday = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [],
      todayKind: "Holiday",
      nextOpening: { localDate: "2026-12-26", startLocalTime: "11:00:00" },
      localDate: "2026-12-25",
    });
    expect(holiday).toContain("The store is closed today for a holiday.");
    expect(holiday).toContain("Opens tomorrow at 11:00 a.m.");
    expect(holiday).not.toContain("Closed today.");
    const later = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [],
      todayKind: "TemporaryClosure",
      nextOpening: { localDate: "2026-12-29", startLocalTime: "17:00:00" },
      localDate: "2026-12-25",
    });
    expect(later).toContain("The store is closed today.");
    expect(later).toContain("Opens Tuesday, Dec 29 at 5:00 p.m.");
  });
});

describe("WP-2423 Q11 replaced table code", () => {
  it("tells the guest in plain words to ask staff, with no retry or internal code", () => {
    const replaced = render({ kind: "TableCodeRetired", replaced: true });
    expect(replaced).toContain("This table code was replaced. Please ask a staff member.");
    expect(replaced).not.toContain("Try again");
    expect(replaced).not.toMatch(/qr_|entry_|410/u);
    const off = render({ kind: "TableCodeRetired", replaced: false });
    expect(off).toContain("This table code is no longer in use. Please ask a staff member.");
  });
});

describe("WP-2423 Q10 continue the order in progress", () => {
  const order = Object.freeze({
    orderReference: "018f2a1b-7c3d-7a4e-8b5c-1234567890ac",
    orderNumber: "12",
    orderType: "Pickup" as const,
  });
  const view = (props: Parameters<typeof CurrentOrderView>[0]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <CurrentOrderView {...props} />
      </MemoryRouter>,
    );
  it("offers the pickup order first and says what a new order does to it", () => {
    const html = view({
      order,
      onStartNew: vi.fn(),
      store: { storeName: "Harbour Test Store", serviceMode: "Pickup" },
    });
    expect(html).toContain("Your order 12");
    expect(html).toContain("Harbour Test Store");
    expect(html).not.toContain("Scan the location QR code to begin");
    expect(html).toContain(`href="/orders/${order.orderReference}"`);
    expect(html).toContain("View order 12");
    expect(html).toContain("Start a new order");
    expect(html).toContain("closes this order on this phone");
    expect(html).not.toContain("Your table");
  });
  it("links a dine-in guest to the table and asks for a QR scan when no code was scanned", () => {
    const html = view({ order: { ...order, orderType: "DineIn" } });
    expect(html).toContain('href="/dine-in/session"');
    expect(html).toContain("scan the QR code at your table or at the counter");
    // No "start a new order" action in the page (the header only carries the language switch).
    expect(html.split("<main")[1]).not.toContain("<button");
  });
});

describe("WP-2423 item 8 ⑤ one primary action", () => {
  it("at a table, joining comes first and the menu is there to look at; one filled button", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EntryContextView
          onContinue={vi.fn()}
          onRetry={vi.fn()}
          state={{ kind: "Established", context }}
          diningAdmission={{
            journey: {} as never,
            generateOperationReference: () => "",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Join this table</button>");
    expect(html).toContain("Look at the menu first");
    expect(html.match(/class="entry-action"/gu)).toHaveLength(1);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CurrentOrderView, EntryContextView, currentOrderPayment } from "./EntryContextPage.js";
import { formatClockTime } from "../journey/format.js";
import type { CustomerEntryEstablishedContext, CustomerEntryScreenState } from "./types.js";
import { setSettledTable } from "../session/customer-transaction-context.js";
import { zhHans as zh } from "../i18n/zh-Hans.js";

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

describe("DEC-DINING-GUEST-TABLE-START: a table guests start themselves", () => {
  const table = {
    publicStoreReference: context.publicStoreReference,
    channel: "DineIn" as const,
    locale: "en-CA",
    brandDisplayName: context.brandDisplayName,
    storeDisplayName: context.storeDisplayName,
  };
  it.each(["TableMayStart", "TableBeingCleaned", "TableAskNewParty"] as const)(
    "%s names the Store, and doesn't tell the guest to scan what they just scanned",
    (kind) => {
      const html = render({ kind, context: table });
      expect(html).toContain("Harbour Test Store");
      expect(html).not.toContain("Scan the location QR code to begin");
      expect(html).not.toContain("Start your order");
    },
  );
  it("a table nobody opened at a Store without guest starts reads as it did", () => {
    const html = render({ kind: "TableNotOpen", context: table });
    expect(html).toContain("Scan the location QR code to begin");
  });
  it("the question makes the answer that ends a table the quieter one", () => {
    const html = render({ kind: "TableAskNewParty", context: table });
    expect(html).toContain('class="entry-action" type="button">Yes, join them');
    expect(html).toContain('class="entry-secondary-action" type="button">No, we just sat down');
    expect(html).not.toContain("receipt");
  });
  it("a guest whose visit ended sees the receipt first, and what either answer does to it", () => {
    setSettledTable({ tableLabel: "DEMO-03", csrfToken: "C".repeat(43) });
    try {
      const asked = render({ kind: "TableAskNewParty", context: table });
      expect(asked).toContain("This table is settled. Thank you for dining with us.");
      expect(asked).toContain("Loading receipt");
      expect(asked).toContain("After you answer, this receipt won’t open on this phone.");
      expect(asked.indexOf("Loading receipt")).toBeLessThan(asked.indexOf("Yes, join them"));
      const start = render({ kind: "TableMayStart", context: table });
      expect(start).toContain("After you start, this receipt won’t open on this phone.");
    } finally {
      setSettledTable(null);
    }
  });
});

describe("CUST-ENTRY-CONTEXT", () => {
  it("a table no party is seated at says so, keeps the menu, and starts no visit", () => {
    const notOpen: CustomerEntryScreenState = {
      kind: "TableNotOpen",
      context: {
        publicStoreReference: context.publicStoreReference,
        channel: "DineIn",
        locale: "en-CA",
        brandDisplayName: context.brandDisplayName,
        storeDisplayName: context.storeDisplayName,
      },
    };
    const html = render(notOpen);
    // WP-2423 live minor 27: the guest is told which restaurant's table it is.
    expect(html).toContain(`This table at ${context.storeDisplayName} isn’t open yet`);
    expect(html).toContain(
      "Ask staff to seat you. This page continues by itself once the table is open.",
    );
    expect(html).toContain("Look at the menu first");
    expect(html).not.toContain("Ready to order");
    expect(html).not.toContain("is confirmed for dine-in");
    expect(html).not.toContain("Join this table");
    expect(html).not.toContain(context.publicStoreReference);
    // A guest whose own visit ended with a settled table (still on this browser) is thanked.
    setSettledTable({ tableLabel: "DEMO-03", csrfToken: "C".repeat(43) });
    try {
      const settled = render(notOpen);
      expect(settled).toContain("This table is settled. Thank you for dining with us.");
      expect(settled).toContain("Table DEMO-03 has paid and closed.");
      expect(settled).toContain("Loading receipt");
      expect(settled).toContain("New party? Ask staff to seat you, then scan again.");
      expect(settled).not.toContain("isn’t open yet");
    } finally {
      setSettledTable(null);
    }
  });

  it("shows the safe public context and never renders credentials or public references", () => {
    const html = render({ kind: "Established", context });
    expect(html).toContain("BOP Test Kitchen");
    expect(html).toContain("Harbour Test Store");
    expect(html).toContain("Welcome to");
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
  it("WP-2423 item 11: a Store not ready yet says so in plain words, with no hours to mislead", () => {
    const text = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [{ start: "11:00:00", end: "21:30:00", endsNextDay: false }],
      todayKind: null,
      nextOpening: { localDate: "2026-12-23", startLocalTime: "11:00:00" },
      localDate: "2026-12-22",
      notReady: true,
    });
    expect(text).toContain("Synthetic Store isn’t taking orders yet");
    expect(text).toContain("This store is still getting ready.");
    expect(text).not.toContain("Today’s hours");
    expect(text).not.toContain("closed");
    expect(text.toLowerCase()).not.toContain("kitchen");
  });
  it("WP-2423 item 13 ②: a paused merchant says it takes no new orders, asks for staff, no hours", () => {
    const text = render({
      kind: "NotAccepting",
      storeDisplayName: "Synthetic Store",
      paused: false,
      todayHours: [{ start: "11:00:00", end: "21:30:00", endsNextDay: false }],
      todayKind: null,
      nextOpening: null,
      localDate: "2026-12-22",
      newGuestsPaused: true,
    });
    expect(text).toContain("Synthetic Store isn’t taking new orders right now");
    expect(text).toContain("Please ask a staff member for help.");
    expect(text).not.toContain("Today’s hours");
    expect(text).not.toContain("closed");
    expect(text.toLowerCase()).not.toContain("platform");
  });
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
    expect(replaced).toContain("This table QR code was replaced. Please ask a staff member.");
    expect(replaced).not.toContain("Try again");
    expect(replaced).not.toMatch(/qr_|entry_|410/u);
    const off = render({ kind: "TableCodeRetired", replaced: false });
    expect(off).toContain("This table QR code is no longer in use. Please ask a staff member.");
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

describe("WP-2423 M18: an unpaid pickup on the entry page", () => {
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
  it("says it isn't paid, until when, and leads to finishing the payment", () => {
    const html = view({
      order,
      onStartNew: vi.fn(),
      payment: { kind: "due", payBy: "2026-08-11T14:10:00.000Z" },
    });
    expect(html).toContain(
      `Not paid yet. Pay by ${formatClockTime("2026-08-11T14:10:00.000Z")}, or it is cancelled`,
    );
    expect(html).toMatch(/class="entry-action" href="\/orders\/[^"]+"[^>]*>Finish paying</u);
    expect(html).not.toContain("Check its status and your pickup code");
  });
  it("says an order cancelled for not being paid wasn't charged, and starting again comes first", () => {
    const html = view({ order, onStartNew: vi.fn(), payment: { kind: "cancelledUnpaid" } });
    expect(html).toContain("cancelled because it wasn’t paid in time. You weren’t charged.");
    expect(html).toContain('class="entry-action" type="button"');
  });
  it("reads the order's payment from its status: due, cancelled unpaid, or nothing to say", () => {
    const status = (sources: object) => ({
      order: { orderType: "Pickup", canonicalPhase: "Submitted", batches: [] },
      sources: { checkedAt: "2026-08-11T14:00:00.000Z", kitchen: null, payments: [], ...sources },
    });
    const due = [
      { orderBatchReference: "x", payBy: "2026-08-11T14:10:00.000Z", lastAttempt: "Open" },
    ];
    expect(currentOrderPayment(status({ paymentsDue: due }))).toEqual({
      kind: "due",
      payBy: "2026-08-11T14:10:00.000Z",
    });
    expect(
      currentOrderPayment(
        status({ unpaidCancellation: { cancelledAt: "2026-08-11T14:10:00.000Z" } }),
      ),
    ).toEqual({ kind: "cancelledUnpaid" });
    expect(currentOrderPayment(status({}))).toBeNull();
    // The order received but not yet projected: nothing claimed.
    expect(currentOrderPayment({ status: "received" })).toBeNull();
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

// M02 (v15 07b7a1b7): a reload, a home-screen launch or the same code again stays at this phone's
// own visit: the same Store and table, with the cart, and nothing new started.
describe("M02 resumed visit", () => {
  const resumed = {
    publicStoreReference: context.publicStoreReference,
    locale: "en-CA",
    brandDisplayName: "Lane Brand",
    storeDisplayName: "Lane Dessert",
  };
  it("pickup says the same Store is selected and continues ordering", () => {
    const html = render({
      kind: "Resumed",
      context: { ...resumed, channel: "Pickup", publicTableReference: null, joined: false },
    });
    expect(html).toContain("Ready to order");
    expect(html).toContain("Pickup from Lane Dessert is selected.");
    expect(html).toContain('class="entry-action" type="button">Continue ordering');
    expect(html).not.toContain("DEMO");
    expect(html).not.toContain(context.publicStoreReference);
  });
  it("a joined table welcomes the guest back with one action", () => {
    const html = render({
      kind: "Resumed",
      context: {
        ...resumed,
        channel: "DineIn",
        publicTableReference: context.publicTableReference,
        joined: true,
      },
    });
    expect(html).toContain("Welcome to Lane Dessert");
    expect(html).toContain("Continue ordering");
    expect(html).not.toContain("Join this table");
    expect(html).not.toContain(String(context.publicTableReference));
  });
  it("a table this phone hasn't joined yet offers the same join as a fresh scan", () => {
    const html = render({
      kind: "Resumed",
      context: {
        ...resumed,
        channel: "DineIn",
        publicTableReference: context.publicTableReference,
        joined: false,
      },
    });
    expect(html).toContain("Welcome to Lane Dessert");
    expect(html).not.toContain("Continue ordering");
    expect(html).toContain("Continue to menu");
  });
  it("in Chinese", () => {
    expect(zh["Continue ordering"]).toBe("继续点单");
    expect(zh["We’ve been seated"]).toBe("我们已入座");
    expect(zh["Ask staff to seat you. This page continues by itself once the table is open."]).toBe(
      "请让店员带位，开台后这里会自动继续。",
    );
  });
  it("a table not open yet offers 'We've been seated' while it waits, not after a settled visit", () => {
    const notOpen: CustomerEntryScreenState = {
      kind: "TableNotOpen",
      context: { ...resumed, channel: "DineIn" },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EntryContextView onContinue={vi.fn()} onSeated={vi.fn()} state={notOpen} />
      </MemoryRouter>,
    );
    expect(html).toContain("We’ve been seated");
    setSettledTable({ tableLabel: "DEMO-03", csrfToken: "C".repeat(43) });
    try {
      const settled = renderToStaticMarkup(
        <MemoryRouter>
          <EntryContextView onContinue={vi.fn()} onSeated={vi.fn()} state={notOpen} />
        </MemoryRouter>,
      );
      expect(settled).not.toContain("We’ve been seated");
    } finally {
      setSettledTable(null);
    }
  });
});

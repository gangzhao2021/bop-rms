import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  DiningSessionPage,
  DiningSessionScreen,
  isDiningSessionActive,
  type DiningSessionState,
  roundTime,
} from "./DiningSessionPage.js";
import type { DiningRound, DiningSessionView } from "./dining-session-client.js";
import { formatClockTime } from "../journey/format.js";
import { CustomerPage } from "../journey/CustomerPage.js";
import { parseSettledTableReceipt, SettledTableReceiptView } from "./SettledTableReceipt.js";

const cad = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const at = "2026-10-13T18:00:00.000Z";
function round(overrides: Partial<DiningRound> = {}): DiningRound {
  return {
    roundNumber: 1,
    orderedBy: "You",
    submittedAt: at,
    status: "Preparing",
    payment: "Paid",
    cancelsAt: null,
    storeCancellationReason: null,
    items: [
      {
        displayName: "Ramen",
        quantity: 2,
        servedQuantity: 1,
        cancelled: false,
        lineTotal: cad("3000"),
      },
    ],
    itemsTotal: cad("3000"),
    ...overrides,
  };
}
function view(overrides: Partial<DiningSessionView> = {}): DiningSessionView {
  return {
    tableLabel: "12",
    orderNumber: "1042",
    checkedAt: at,
    paymentTiming: "PayFirst",
    rounds: [
      round(),
      round({
        roundNumber: 2,
        orderedBy: "AnotherGuest",
        status: "AwaitingPayment",
        payment: "Awaiting",
        items: [
          {
            displayName: "Gyoza",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: cad("900"),
          },
        ],
        itemsTotal: cad("900"),
      }),
    ],
    summary: { paid: cad("3450"), refunded: cad("0"), refundPending: cad("0"), due: cad("900") },
    ...overrides,
  };
}
const store = { storeName: "Synthetic Noodle Bar", serviceMode: "DineIn" as const };
function render(state: DiningSessionState) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/dine-in/session"]}>
      <DiningSessionScreen state={state} store={store} onRefresh={() => undefined} />
    </MemoryRouter>,
  );
}

describe("CUST-DINE-IN-SESSION (WP-2423 Q8)", () => {
  it("shows the table, each round with who ordered it, its status and payment, and the table total", () => {
    const html = render({ status: "ready", view: view(), refreshing: false });
    expect(html).toContain("Your table · 12");
    expect(html).toContain("Order 1042");
    expect(html).toContain("Round 1 · Ordered by you");
    expect(html).toContain("Round 2 · Ordered by another guest");
    expect(html).toContain("Being prepared");
    expect(html).toContain("Waiting for payment");
    expect(html).toContain("Not paid yet");
    expect(html).toContain("Served 1 of 2");
    expect(html).toContain("2 × Ramen");
    expect(html).toContain("$30.00");
    expect(html).toContain("Paid so far");
    expect(html).toContain("$34.50");
    expect(html).toContain("$9.00");
    expect(html).toContain("The kitchen starts this round once it is paid.");
    expect(html).toContain('aria-current="page">Your table');
    expect(html).toContain("Refresh now");
    expect(html).toContain('href="/menu"');
  });

  it("explains cancelled, failed and refunded rounds in plain words", () => {
    const html = render({
      status: "ready",
      refreshing: false,
      view: view({
        rounds: [
          round({
            status: "StoreCancelled",
            payment: "Refunded",
            storeCancellationReason: "SoldOut",
          }),
          round({
            roundNumber: 2,
            status: "PaymentFailed",
            payment: "Failed",
            cancelsAt: "2026-10-13T18:40:00.000Z",
          }),
          round({ roundNumber: 3, status: "NotPaidCancelled", payment: "NotCharged" }),
          round({ roundNumber: 4, status: "Served", payment: "Paid" }),
        ],
        summary: {
          paid: cad("3450"),
          refunded: cad("3450"),
          refundPending: cad("452"),
          due: cad("0"),
        },
      }),
    });
    expect(html).toContain("Cancelled by the store");
    expect(html).toContain("An item you ordered sold out.");
    expect(html).toContain("The payment was refunded.");
    expect(html).toContain("On hold until paid");
    expect(html).toContain("Payment failed");
    expect(html).toContain(
      `This round will be cancelled at ${formatClockTime("2026-10-13T18:40:00.000Z")}`,
    );
    expect(html).toContain("No one was charged for it.");
    expect(html).toContain("Refund on its way");
    expect(html).toContain("$4.52");
    expect(html).toContain("Nothing");
    expect(html).toContain("Served");
  });

  // WP-2423 abandoned payment: the guest who sent a round and left the payment page pays it here.
  it("offers the guest who ordered an unpaid round to pay for it, never another guest's", () => {
    const html = render({
      status: "ready",
      refreshing: false,
      view: view({
        rounds: [
          round({
            roundNumber: 1,
            orderedBy: "You",
            status: "AwaitingPayment",
            payment: "Awaiting",
          }),
          round({
            roundNumber: 2,
            orderedBy: "AnotherGuest",
            status: "AwaitingPayment",
            payment: "Awaiting",
          }),
        ],
      }),
    });
    expect(html).toContain('href="/checkout/payment"');
    expect(html).toContain("Pay for round 1");
    expect(html).not.toContain("Pay for round 2");
  });

  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): a round staff entered for the table.
  it("shows a round staff entered for the table and how it is paid", () => {
    const html = render({
      status: "ready",
      refreshing: false,
      view: view({
        rounds: [
          round(),
          round({
            roundNumber: 2,
            orderedBy: "Staff",
            status: "AwaitingPayment",
            payment: "Awaiting",
          }),
          round({ roundNumber: 3, orderedBy: "Staff", status: "Queued", payment: "Paid" }),
        ],
      }),
    });
    expect(html).toContain("Round 2 · Entered by staff");
    expect(html).toContain("Round 3 · Entered by staff");
    expect(html).toContain(
      "Staff entered this round for your table. Pay them on the card machine and the kitchen starts it.",
    );
    expect(html).not.toMatch(/\bStaff\b(?! entered)|card_machine|StoreCardMachine/u);
  });

  it("WP-2423 Q26: says which dish the kitchen is making again and that it will come to the table", () => {
    const ramen = round().items[0];
    if (ramen === undefined) throw new Error("fixture");
    const html = render({
      status: "ready",
      refreshing: false,
      view: view({
        rounds: [
          round({
            status: "Serving",
            items: [
              { ...ramen, quantity: 1, servedQuantity: 0, beingRemade: true },
              { ...ramen, displayName: "Gyoza", quantity: 1, servedQuantity: 1 },
            ],
          }),
        ],
      }),
    });
    expect(html).toContain("Being remade · we&#x27;ll bring it to your table shortly");
    // The dish being remade does not also claim it was served; the other dish still does.
    expect(html.match(/Being remade/gu)).toHaveLength(1);
    expect(html).toContain("Served 1 of 1");
    expect(html).not.toContain("Served 0 of 1");
    expect(html.replace(/<[^>]*>/gu, " ")).not.toMatch(/beingRemade|rework|remake/u);
  });

  it("never shows names, contact details, internal codes or references", () => {
    const html = render({ status: "ready", view: view(), refreshing: false });
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(html).not.toMatch(
      /AnotherGuest|AwaitingPayment|PaymentFailed|NotPaidCancelled|StoreCancelled|RefundPending|SoldOut|@|phone|email/iu,
    );
  });

  it("tells a guest who has not joined how to join, and offers retry when the table can't load", () => {
    const notJoined = render({ status: "not-joined" });
    expect(notJoined).toContain("Join your table first");
    expect(notJoined).toContain("Ask a staff member, or the person who joined your table first");
    expect(notJoined).not.toContain("Round");
    const failed = render({ status: "unavailable", view: null, offline: false });
    expect(failed).toContain("We couldn’t load your table");
    expect(failed).toContain("Try again");
    const stale = render({ status: "unavailable", view: view(), offline: true });
    expect(stale).toContain("You’re offline");
    expect(stale).toContain("Showing what was loaded before.");
    expect(stale).toContain("Round 1 · Ordered by you");
  });

  it("thanks a guest whose table was settled and loads the table's receipt", () => {
    const plain = render({ status: "settled", tableLabel: "DEMO-02" });
    expect(plain).toContain("This table is settled. Thank you for dining with us.");
    expect(plain).toContain("Table DEMO-02 has paid and closed.");
    expect(plain).toContain("New party? Scan the table code");
    expect(plain).toContain("Loading receipt");
    expect(plain).not.toContain("/orders/");
    expect(plain).not.toContain("Join your table first");
    expect(plain).not.toMatch(/staff member|Need a staff/iu);
    expect(plain).not.toContain("Order more from the menu");
    expect(plain).not.toContain("Everything ordered at this table");
  });

  it("shows a settled table's receipt: dishes, tax, tip, cash rounding and how it was paid", () => {
    const receipt = (payments: unknown[], extra: Record<string, unknown> = {}) =>
      renderToStaticMarkup(
        <SettledTableReceiptView
          receipt={parseSettledTableReceipt({
            schemaVersion: 1,
            receipt: {
              tableLabel: "DEMO-03",
              rounds: [
                {
                  roundNumber: 1,
                  fromTableLabel: null,
                  items: [
                    { displayName: "Milk tea", subtotalMinor: "450", reduced: null },
                    { displayName: "Tea", subtotalMinor: "0", reduced: "Comp" },
                  ],
                },
                {
                  roundNumber: 2,
                  fromTableLabel: "T-M",
                  items: [{ displayName: "Ramen", subtotalMinor: "1200", reduced: "Discount" }],
                },
              ],
              subtotalMinor: "1650",
              taxMinor: "215",
              ordersTotalMinor: "1865",
              tipMinor: "0",
              roundingMinor: "0",
              paidMinor: "1865",
              split: false,
              payments,
              ...extra,
            },
          })}
        />,
      );
    const cash = receipt([{ partNumber: null, method: "Cash", totalMinor: "1865" }], {
      roundingMinor: "1",
      paidMinor: "1866",
      tipMinor: "0",
    });
    for (const text of [
      "Receipt",
      "Round 1",
      "Milk tea",
      "Tea · On the house",
      "Round 2 · From table T-M",
      "Ramen · Discounted",
      "Subtotal before tax",
      "$16.50",
      "Tax",
      "$2.15",
      "Cash rounding",
      "$0.01",
      "Total paid",
      "$18.66",
      "Paid by",
      "Cash",
    ])
      expect(cash).toContain(text);
    expect(cash).not.toContain("Tip");
    expect(cash).not.toContain("Tax rounding");
    // WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding on its own line.
    const rounded = receipt([{ partNumber: null, method: "Cash", totalMinor: "1864" }], {
      taxRoundingMinor: "-1",
      ordersTotalMinor: "1864",
      paidMinor: "1865",
    });
    expect(rounded).toContain("Tax rounding");
    expect(rounded).toContain("-$0.01");
    const split = receipt(
      [
        { partNumber: 1, method: "Online", totalMinor: "1100" },
        { partNumber: 2, method: "CardMachine", totalMinor: "1000" },
      ],
      { split: true, tipMinor: "235", paidMinor: "2100" },
    );
    expect(split).toContain("Part 1 paid by");
    expect(split).toContain("Card on a guest’s phone · $11.00");
    expect(split).toContain("Part 2 paid by");
    expect(split).toContain("Card at the table · $10.00");
    expect(split).toContain("Tip");
    expect(split).toContain("$2.35");
    // Public fields only.
    expect(cash + split).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7|CardMachine|Online\b|@/u);
    expect(() => parseSettledTableReceipt({ receipt: { tableLabel: "<b>" } })).toThrow();
  });

  it("shows an empty table plainly and only keeps polling while something is in progress", () => {
    const empty = view({ rounds: [], summary: null, orderNumber: null });
    const html = render({ status: "ready", view: empty, refreshing: false });
    expect(html).toContain("No one at this table has ordered yet");
    expect(html).not.toContain("Table total");
    expect(isDiningSessionActive(empty)).toBe(true);
    expect(isDiningSessionActive(view())).toBe(true);
    expect(
      isDiningSessionActive(
        view({ rounds: [round({ status: "Served" }), round({ status: "NotPaidCancelled" })] }),
      ),
    ).toBe(false);
  });

  it("starts in a loading state before the table is read", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dine-in/session"]}>
        <DiningSessionPage store={store} client={{ load: async () => view() }} />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading your table");
    expect(html).not.toContain("unavailable");
  });

  it("is linked from the journey header for dine-in guests only", () => {
    const page = (serviceMode: "DineIn" | "Pickup") =>
      renderToStaticMarkup(
        <MemoryRouter>
          <CustomerPage step="menu" store={{ storeName: "Synthetic", serviceMode }}>
            <p>Menu</p>
          </CustomerPage>
        </MemoryRouter>,
      );
    expect(page("DineIn")).toContain('href="/dine-in/session"');
    expect(page("DineIn")).toContain(">Your table</a>");
    expect(page("Pickup")).not.toContain("/dine-in/session");
  });
});

describe("CUST-DINE-IN-SESSION item prices before tax (WP-2423 D5)", () => {
  // Ramen 2 × $13.27 + 13% tax = $30.00; Gyoza $7.96 + $1.04 = $9.00.
  const priced = view({
    rounds: [
      round({
        items: round().items.map((entry) => ({ ...entry, priceBeforeTax: cad("2655") })),
        subtotal: cad("2655"),
        tax: cad("345"),
      }),
      round({
        roundNumber: 2,
        orderedBy: "AnotherGuest",
        status: "AwaitingPayment",
        payment: "Awaiting",
        items: [
          {
            displayName: "Gyoza",
            quantity: 1,
            servedQuantity: 0,
            cancelled: false,
            lineTotal: cad("900"),
            priceBeforeTax: cad("796"),
          },
        ],
        subtotal: cad("796"),
        tax: cad("104"),
        itemsTotal: cad("900"),
      }),
    ],
    summary: {
      paid: cad("3000"),
      refunded: cad("0"),
      refundPending: cad("0"),
      due: cad("900"),
      ordered: { subtotal: cad("3451"), tax: cad("449"), total: cad("3900") },
    },
  });
  const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");

  it("lists items before tax, then each round's and the table's subtotal, tax and total", () => {
    const html = text(render({ status: "ready", view: priced, refreshing: false }));
    expect(html).toContain("2 × Ramen $26.55");
    expect(html).toContain("1 × Gyoza $7.96");
    expect(html).toContain("Subtotal $26.55 Tax $3.45 Round total $30.00");
    expect(html).toContain("Subtotal $7.96 Tax $1.04 Round total $9.00");
    expect(html).toContain("Subtotal $34.51 Tax $4.49 Total ordered $39.00");
    // What the table paid and still owes is unchanged.
    expect(html).toContain("Paid so far $30.00");
    expect(html).toContain("Waiting for payment $9.00");
    expect(html).toContain("Item prices are before tax.");
    expect(html).not.toContain("Discounts and fees");
  });

  it("keeps totals including tax, labelled so, when the prices before tax are not known", () => {
    const html = text(render({ status: "ready", view: view(), refreshing: false }));
    expect(html).toContain("2 × Ramen $30.00");
    expect(html).toContain("Round total including tax $30.00");
    expect(html).not.toContain("Subtotal");
    expect(html).not.toContain("Item prices are before tax.");
  });
  it("WP-2423 item 5: tells guests when an unpaid round with no payment started is cancelled", () => {
    const html = render({
      status: "ready",
      refreshing: false,
      view: view({
        rounds: [
          round({
            orderedBy: "Staff",
            status: "AwaitingPayment",
            payment: "Awaiting",
            cancelsAt: "2026-10-13T18:40:00.000Z",
          }),
          round({ roundNumber: 2, status: "NotPaidCancelled", payment: "NotCharged" }),
        ],
      }),
    });
    expect(html).toContain("Pay them on the card machine and the kitchen starts it.");
    expect(html).toContain(
      `If it isn&#x27;t paid by ${formatClockTime("2026-10-13T18:40:00.000Z")}, it is cancelled and nobody is charged.`,
    );
    expect(html).toContain("Cancelled — not paid");
    expect(html).toContain("No one was charged for it.");
  });
});

it("WP-2423 D5: a round from another day shows its date, today's only its time", () => {
  const now = Date.parse("2026-10-15T18:00:00");
  const today = new Date("2026-10-15T12:05:00").toISOString();
  const earlier = new Date("2026-10-11T19:40:00").toISOString();
  expect(roundTime(today, now)).toBe(formatClockTime(today));
  const dated = roundTime(earlier, now);
  expect(dated).toContain("Oct");
  expect(dated).toContain("11");
  expect(dated).not.toBe(formatClockTime(earlier));
});

describe("WP-2423 item 8 ④ v15 a: a table paying its split bill in parts", () => {
  it("shows what is still to pay and says the table pays in parts", () => {
    const html = render({
      status: "ready",
      view: view({
        paymentTiming: "PayLater",
        summary: {
          paid: cad("680"),
          refunded: cad("0"),
          refundPending: cad("0"),
          due: cad("339"),
          splitParts: { count: 3, paid: 2 },
        },
      }),
      refreshing: false,
    });
    expect(html).toContain("Still to pay");
    expect(html).toContain("$3.39");
    expect(html).toContain("The table is paying the bill in 3 parts; 2 paid so far.");
    expect(html).not.toContain("To pay at the end");
    expect(html).not.toContain("The table paid once at the end");
  });
});

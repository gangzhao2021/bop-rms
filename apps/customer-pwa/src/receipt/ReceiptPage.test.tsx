import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { ReceiptPage, receiptLineAmount } from "./ReceiptPage.js";
import type { ReceiptController } from "./receipt-controller.js";
import type { ReceiptState } from "./types.js";

const id = (n: number) => `018f8a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function ready(): ReceiptState {
  const amount = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  return {
    status: "ready",
    view: {
      orderReference: id(1),
      freshnessStatus: "Fresh",
      deliveryStatus: "Unavailable",
      supportEligible: true,
      cancellationEligible: false,
      records: [
        {
          recordReference: id(2),
          version: 1,
          kind: "Original",
          recordedAt: "2026-08-12T14:00:00.000Z",
          reasonCode: null,
          snapshot: {
            receiptReference: id(3),
            operatingEntityDisplayName: "Synthetic Operating Entity",
            storeDisplayName: "Synthetic Store",
            orderNumber: "1001",
            issuedAt: "2026-08-12T14:00:00.000Z",
            locale: "en-CA",
            lines: [
              {
                lineReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 1,
                lineTotal: amount(1000n),
              },
            ],
            subtotal: amount(1000n),
            tax: amount(130n),
            tip: amount(0n),
            total: amount(1130n),
            paymentStatus: "Paid",
            refundedTotal: amount(0n),
          },
        },
      ],
    },
  };
}
function render(state: ReceiptState) {
  const controller: ReceiptController = {
    getState: () => state,
    subscribe: () => () => undefined,
    load: async () => undefined,
    setOnline: () => undefined,
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/orders/${id(1)}/receipt`]}>
      <Routes>
        <Route
          path="/orders/:orderReference/receipt"
          element={<ReceiptPage controller={controller} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
describe("CUST-RECEIPT-SUPPORT screen contract", () => {
  it("renders the immutable snapshot, accessible totals and print, with no inactive email stub", () => {
    const html = render(ready());
    expect(html).toContain('class="receipt-page__content"');
    expect(html).toContain('class="receipt-page__history"');
    expect(html).toContain('class="receipt-page__action-card"');
    expect(html).toContain("Receipt history");
    expect(html).toContain("Synthetic Operating Entity");
    expect(html).toContain("$11.30");
    expect(html).toContain("Print or save receipt");
    expect(html).toContain("Refresh receipt");
    // WP-2423 Q10: no reachable stub — email appears only once a provider is connected.
    expect(html).not.toContain("Request email receipt");
    expect(html).not.toContain("not active yet");
    // No internal delivery/support codes for the customer.
    expect(html).not.toMatch(/Delivery status|support action|server validation/u);
    expect(html).toContain("Ask a staff member at Synthetic Store");
    expect(html).not.toContain(`>${id(1)}<`);
  });
  it.each([
    [{ status: "loading" }, "Loading receipt"],
    [{ status: "invalid-reference" }, "Receipt link is invalid"],
    [{ status: "permission-denied" }, "Your visit on this phone has ended"],
    [{ status: "not-found" }, "Receipt not found"],
    [{ status: "feature-disabled" }, "Digital receipt is disabled"],
    [{ status: "unavailable" }, "We couldn’t load your receipt"],
    [{ status: "offline", view: null }, "You’re offline"],
  ] as const)("renders bounded state %#", (state, message) =>
    expect(render(state)).toContain(message),
  );
});

describe("receipt adjustment display", () => {
  it("prints optional discount and fee amounts with the receipt totals", () => {
    const state = ready();
    if (state.status !== "ready") throw new Error("missing fixture");
    const record = state.view.records[0];
    if (!record) throw new Error("missing fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        records: [
          {
            ...record,
            snapshot: {
              ...record.snapshot,
              total: { amountMinor: 1080n, currencyCode: "CAD" },
              adjustments: {
                discount: { amountMinor: 100n, currencyCode: "CAD" },
                fee: { amountMinor: 50n, currencyCode: "CAD" },
              },
            },
          },
        ],
      },
    });
    expect(html).toContain("<dt>Discount</dt><dd>$1.00</dd>");
    expect(html).toContain("<dt>Fees</dt><dd>$0.50</dd>");
    expect(html).toContain("$10.80");
    expect(html).toContain("Print or save receipt");
    const original = render(ready());
    expect(original).not.toContain("<dt>Discount</dt>");
    expect(original).not.toContain("<dt>Fees</dt>");
  });
});

it("separates current pending refunds from immutable history and hides them offline", () => {
  const state = ready();
  if (state.status !== "ready") throw new Error("fixture");
  const view = {
    ...state.view,
    financial: {
      observedAt: "2026-09-21T13:00:00.000Z",
      currencyCode: "CAD",
      capturedMinor: 1130n,
      confirmedRefundMinor: 100n,
      pendingRefundMinor: 600n,
      unresolvedAttemptCount: 1,
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("$6.00");
  expect(html).toContain("Pending refunds are not confirmed refunds");
  expect(html).toContain("Some payment attempts still need a final result");
  expect(html).toContain("Receipt history");
  const offline = render({ status: "offline", view });
  expect(offline).not.toContain("$6.00");
  expect(offline).toContain("be checked while you");
});

describe("WP-2423 Q10 store contact on the receipt", () => {
  it("shows the Store's published phone and address with a call link", () => {
    const state = ready();
    if (state.status !== "ready") throw new Error("missing fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        storeContact: {
          phone: "+14165550123",
          addressLines: ["DEMO 100 Test Street"],
          locality: "Toronto",
          regionCode: "ON",
          postalCode: "M5V 1A1",
        },
      },
    });
    expect(html).toContain("Contact the store");
    expect(html).toContain('href="tel:+14165550123"');
    expect(html).toContain("Call (416) 555-0123");
    expect(html).toContain("DEMO 100 Test Street");
    expect(html).toContain("Toronto, ON M5V 1A1");
  });
});

describe("receipt version reasons", () => {
  it("says why a version was issued in guest words and never shows the reason code", () => {
    const state = ready();
    if (state.status !== "ready") throw new Error("missing fixture");
    const record = state.view.records[0];
    if (!record) throw new Error("missing fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        records: [
          record,
          {
            ...record,
            recordReference: id(5),
            version: 2,
            kind: "Reissue",
            reasonCode: "ORDER_ADDITIONAL_PAYMENT_CAPTURED",
          },
          {
            ...record,
            recordReference: id(6),
            version: 3,
            kind: "Correction",
            reasonCode: "SOME_UNREVIEWED_CODE",
          },
        ],
      },
    });
    expect(html).toContain("Reason: An additional payment was added to this order.");
    expect(html).not.toMatch(/ORDER.ADDITIONAL|SOME.UNREVIEWED/u);
  });
});

describe("WP-2423 D5/D6: item prices before tax and plain payment wording", () => {
  const amount = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  function versioned(lines: unknown[], subtotal: bigint, tax: bigint): ReceiptState {
    const state = ready();
    if (state.status !== "ready") throw new Error("fixture");
    const record = state.view.records[0];
    if (!record) throw new Error("fixture");
    return {
      ...state,
      view: {
        ...state.view,
        records: [
          {
            ...record,
            snapshot: {
              ...record.snapshot,
              lines: lines as typeof record.snapshot.lines,
              subtotal: amount(subtotal),
              tax: amount(tax),
              total: amount(subtotal + tax),
            },
          },
        ],
      },
    };
  }
  it("prints each item before tax so the items add up to the subtotal, then tax and total", () => {
    const lines = [
      {
        lineReference: id(4),
        displayName: "DEMO Latte",
        quantity: 1,
        lineTotal: amount(1130n),
        lineSubtotal: amount(1000n),
      },
      {
        lineReference: id(5),
        displayName: "Synthetic muffin",
        quantity: 2,
        lineTotal: amount(905n),
        lineSubtotal: amount(801n),
      },
    ];
    const html = render(versioned(lines, 1801n, 234n));
    expect(html).toContain("<span>1 × DEMO Latte</span><span>$10.00</span>");
    expect(html).toContain("<span>2 × Synthetic muffin</span><span>$8.01</span>");
    expect(html).toContain("<dt>Subtotal</dt><dd>$18.01</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$20.35</dd>");
    expect(html).not.toContain("$11.30");
    expect(html).not.toContain("already include tax");
    const printed = lines.reduce((sum, line) => sum + receiptLineAmount(line).amountMinor, 0n);
    expect(printed).toBe(1801n);
    expect(printed + 234n).toBe(2035n);
  });
  it("prints an older version's items as issued and says they include tax", () => {
    const html = render(
      versioned(
        [
          {
            lineReference: id(4),
            displayName: "DEMO Latte",
            quantity: 1,
            lineTotal: amount(1130n),
          },
        ],
        1000n,
        130n,
      ),
    );
    expect(html).toContain("<span>1 × DEMO Latte</span><span>$11.30</span>");
    expect(html).toContain("Item amounts on this version already include tax");
  });
  it("lists each chosen option with what it added under its item, inside the item price (WP-2423)", () => {
    const lines = [
      {
        lineReference: id(4),
        displayName: "TEST Hot Chocolate — Small (8 oz)",
        quantity: 1,
        lineTotal: amount(452n),
        lineSubtotal: amount(400n),
        options: [
          { displayName: "Whipped cream", quantity: 1, amount: amount(50n) },
          { displayName: "Extra shot", quantity: 2, amount: amount(150n) },
          { displayName: "Oat milk", quantity: 1, amount: amount(0n) },
        ],
      },
    ];
    const html = render(versioned(lines, 400n, 52n));
    expect(html).toContain(
      '<span>1 × TEST Hot Chocolate — Small (8 oz)<span class="receipt-page__option">Whipped cream +$0.50</span><span class="receipt-page__option">Extra shot × 2 +$1.50</span><span class="receipt-page__option">Oat milk</span></span><span>$4.00</span>',
    );
    // The item price already includes its options, so the items still add up to the subtotal.
    expect(html).toContain("<dt>Subtotal</dt><dd>$4.00</dd>");
    expect(html).toContain("<dt>Total</dt><dd>$4.52</dd>");
    expect(lines.reduce((sum, line) => sum + receiptLineAmount(line).amountMinor, 0n)).toBe(400n);
  });
  it("prints a version issued before options were recorded exactly as issued", () => {
    const html = render(
      versioned(
        [
          {
            lineReference: id(4),
            displayName: "TEST Hot Chocolate — Small (8 oz)",
            quantity: 1,
            lineTotal: amount(452n),
            lineSubtotal: amount(400n),
          },
        ],
        400n,
        52n,
      ),
    );
    expect(html).toContain("<span>1 × TEST Hot Chocolate — Small (8 oz)</span><span>$4.00</span>");
    expect(html).not.toContain("receipt-page__option");
  });
  it("labels the captured amount as Paid", () => {
    const state = ready();
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        financial: {
          observedAt: "2026-08-12T14:05:00.000Z",
          currencyCode: "CAD",
          capturedMinor: 1130n,
          confirmedRefundMinor: 0n,
          pendingRefundMinor: 0n,
          unresolvedAttemptCount: 0,
        },
      },
    });
    expect(html).toContain("<dt>Paid</dt><dd>$11.30</dd>");
    expect(html).not.toContain("Captured");
  });
});

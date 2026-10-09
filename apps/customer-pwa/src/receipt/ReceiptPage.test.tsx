import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { ReceiptPage } from "./ReceiptPage.js";
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
  it("renders the immutable snapshot, accessible totals, print and gated email intent", () => {
    const html = render(ready());
    expect(html).toContain('class="receipt-page__content"');
    expect(html).toContain('class="receipt-page__history"');
    expect(html).toContain('class="receipt-page__action-card"');
    expect(html).toContain("Receipt history");
    expect(html).toContain("Synthetic Operating Entity");
    expect(html).toContain("$11.30");
    expect(html).toContain("Print receipt");
    expect(html).toContain("Refresh receipt");
    expect(html).toContain("Request email receipt");
    expect(html).toContain("disabled");
    expect(html).not.toContain(`>${id(1)}<`);
  });
  it.each([
    [{ status: "loading" }, "Loading receipt"],
    [{ status: "invalid-reference" }, "Receipt link is invalid"],
    [{ status: "permission-denied" }, "Receipt access denied"],
    [{ status: "not-found" }, "Receipt not found"],
    [{ status: "feature-disabled" }, "Digital receipt is disabled"],
    [{ status: "unavailable" }, "Receipt is unavailable"],
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
    expect(html).toContain("Print receipt");
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
  expect(offline).toContain("unavailable while offline");
});

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
    expect(html).toContain("Immutable receipt history");
    expect(html).toContain("Synthetic Operating Entity");
    expect(html).toContain("CAD 11.30");
    expect(html).toContain("Print receipt");
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
    [{ status: "offline", view: null }, "Offline read-only"],
  ] as const)("renders bounded state %#", (state, message) =>
    expect(render(state)).toContain(message),
  );
});

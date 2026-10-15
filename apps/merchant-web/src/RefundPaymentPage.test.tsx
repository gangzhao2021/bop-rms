import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { cardMachineRefundRecordedText } from "./CardMachineRequestRefund.js";
import {
  CardMachineRefundDone,
  PaymentFinancialSummary,
  paymentStateLabel,
} from "./RefundPaymentPage.js";
import { StoreTimeZoneContext } from "./StoreTime.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const context = {
  paymentIntentReference: id(1),
  paymentAttemptReference: id(2),
  orderReference: id(3),
  orderBatchReference: id(4),
  observedAt: "2026-10-15T17:52:00.000Z",
  paymentState: "Captured" as const,
  paymentMethod: "CardMachine" as const,
  currencyCode: "CAD" as const,
  capturedAmountMinor: "593",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "593",
  canRequest: true,
};

it("WP-2423: the payment summary says Paid, never the internal Captured state", () => {
  const html = renderToStaticMarkup(
    <PaymentFinancialSummary
      initial={context}
      csrf={"a".repeat(43)}
      revision={0}
      onContext={vi.fn()}
    />,
  );
  expect(html).toContain("<dt>Paid</dt>");
  expect(html).toContain("Payment state: Paid, refund pending");
  expect(html).not.toMatch(/Captured/u);
  expect(
    paymentStateLabel({ ...context, confirmedRefundMinor: "593", pendingRefundMinor: "0" }),
  ).toBe("Refunded");
});

it("WP-2423 item 4: a recorded card-machine refund shows its slip reference in staff language", () => {
  const render = (slipReference: string | null) =>
    renderToStaticMarkup(
      <StoreTimeZoneContext.Provider value="America/Toronto">
        <CardMachineRefundDone
          amountMinor="593"
          refundedAt="2026-10-15T17:52:00.000Z"
          slipReference={slipReference}
        />
      </StoreTimeZoneContext.Provider>,
    );
  const html = render("RF4821");
  expect(html).toContain("Refunded CAD 5.93 on the store&#x27;s card machine");
  expect(html).toContain("Oct 15, 2026, 1:52 PM");
  expect(html).toContain("Slip reference: RF4821.");
  expect(html).not.toContain(id(1));
  expect(render(null)).toContain("No slip reference was entered.");
});

it("WP-2423 item 4: recording the machine refund confirms it plainly, with the customer's receipt", () => {
  const result = { amountMinor: "593", refundedAt: "2026-10-15T17:52:00.000Z" };
  expect(
    cardMachineRefundRecordedText(
      { ...result, receipt: "NoDigitalReceipt" },
      "CAD 5.93",
      "593",
      "America/Toronto",
    ),
  ).toBe(
    "Card-machine refund recorded: CAD 5.93 refunded on the card machine at Oct 15, 2026, 1:52 PM. The card machine's refund slip is the customer's receipt.",
  );
  expect(
    cardMachineRefundRecordedText({ ...result, receipt: "Issued" }, "CAD 5.93", "593", "UTC"),
  ).toMatch(/^Card-machine refund recorded: CAD 5\.93 .* digital receipt now shows the refund\.$/u);
  // The server's amount wins over the request's when they differ.
  expect(
    cardMachineRefundRecordedText(
      { amountMinor: "500", refundedAt: result.refundedAt, receipt: "NotIssued" },
      "CAD 5.93",
      "593",
      "UTC",
    ),
  ).toMatch(/^Card-machine refund recorded: \S*5\.00 .*not counted twice\)\.$/u);
});

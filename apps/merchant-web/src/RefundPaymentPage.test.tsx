import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { cardMachineRefundRecordedText } from "./CardMachineRequestRefund.js";
import {
  CardMachineRefundDone,
  nextFinancialSummary,
  PaymentFinancialSummary,
  paymentRefundStateLabel,
  paymentStateLabel,
  refundWizardSections,
  requestProgressLabel,
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
  expect(html).toContain("Refunded $5.93 on the store&#x27;s card machine");
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
      "$5.93",
      "593",
      "America/Toronto",
    ),
  ).toBe(
    "Card-machine refund recorded: $5.93 refunded on the card machine at Oct 15, 2026, 1:52 PM. The card machine's refund slip is the customer's receipt.",
  );
  expect(
    cardMachineRefundRecordedText({ ...result, receipt: "Issued" }, "$5.93", "593", "UTC"),
  ).toMatch(/^Card-machine refund recorded: \$5\.93 .* digital receipt now shows the refund\.$/u);
  // The server's amount wins over the request's when they differ.
  expect(
    cardMachineRefundRecordedText(
      { amountMinor: "500", refundedAt: result.refundedAt, receipt: "NotIssued" },
      "$5.93",
      "593",
      "UTC",
    ),
  ).toMatch(/^Card-machine refund recorded: \S*5\.00 .*not counted twice\)\.$/u);
});

it("WP-2423 v15: a recorded refund request leaves no confirmation or record button behind", () => {
  // Before recording: the calculated amount is confirmed and recorded here.
  expect(refundWizardSections("Idle", true, true)).toEqual({
    confirmation: true,
    startAnother: false,
  });
  // A result still unknown keeps the same request on screen to retry it.
  expect(refundWizardSections("Unknown", true, true).confirmation).toBe(true);
  // Recorded: the confirmation is gone; another request is started explicitly.
  expect(refundWizardSections("Recorded", true, true)).toEqual({
    confirmation: false,
    startAnother: true,
  });
  // Someone who only follows requests is never offered a new one.
  expect(refundWizardSections("Recorded", false, false)).toEqual({
    confirmation: false,
    startAnother: false,
  });
});

it("WP-2423 item 6: a send whose result is unconfirmed is retried before another request", () => {
  expect(refundWizardSections("Recorded", false, true, true)).toEqual({
    confirmation: false,
    startAnother: false,
  });
});

it("WP-2423 item 6: a refund is called sent only once it was really sent", () => {
  // Prepared (or recorded) but not sent: never "Sent".
  expect(requestProgressLabel("Recorded", "Online", null)).toBe("Recorded, not sent yet");
  expect(requestProgressLabel("ReadyToSend", "Online", null)).toBe("Not sent yet");
  expect(requestProgressLabel("ReadyToSend", "Online", "Approved")).toBe("Approved, not sent yet");
  expect(requestProgressLabel("Sending", "Online", null)).toBe(
    "Sent — waiting for the card provider's answer",
  );
  expect(requestProgressLabel("Sending", "Online", "Approved")).toBe(
    "Sent — waiting for the card provider's answer",
  );
  expect(requestProgressLabel("Refunded", "Online", null)).toBe("Refunded");
  expect(requestProgressLabel("Recorded", "Online", "AwaitingApproval")).toBe(
    "Waiting for owner approval",
  );
  expect(requestProgressLabel("Recorded", "CardMachine", "Approved")).toBe(
    "Approved — refund it on the card machine and record it",
  );
  expect(requestProgressLabel("Refunded", "CardMachine", null)).toBe(
    "Refunded on the card machine",
  );
  expect(paymentRefundStateLabel("NotDispatched")).toBe("Not sent yet");
  expect(paymentRefundStateLabel("Prepared")).toBe("Not sent yet");
  expect(paymentRefundStateLabel("NeedsReconciliation")).toBe(
    "Sent — waiting for the card provider's answer",
  );
  expect(paymentRefundStateLabel("Confirmed")).toBe("Refunded");
});

it("WP-2423: after a refund is recorded the amounts stay shown while they are reread", () => {
  const shown = { context, busy: false, message: "" };
  // The refund result triggers a reread: staff keep seeing the last amounts, calmly updating.
  const rereading = nextFinancialSummary(shown, { kind: "Rereading" });
  expect(rereading).toEqual({ context, busy: true, message: "Updating payment amounts…" });
  // A second reread superseding the first (status and request list both refresh) changes nothing.
  expect(nextFinancialSummary(rereading, { kind: "Rereading" })).toEqual(rereading);
  const refunded = { ...context, confirmedRefundMinor: "593", pendingRefundMinor: "0" };
  expect(nextFinancialSummary(rereading, { kind: "Read", context: refunded })).toEqual({
    context: refunded,
    busy: false,
    message: "",
  });
  // Only a reread that actually failed withdraws the amounts; the refresh button retries.
  expect(
    nextFinancialSummary(rereading, { kind: "Failed", message: "Unable to refresh." }),
  ).toEqual({ context: null, busy: false, message: "Unable to refresh." });
});

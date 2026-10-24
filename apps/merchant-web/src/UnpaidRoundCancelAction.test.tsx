import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  isPaymentUnconfirmed,
  UnpaidRoundCancelAction,
  unpaidRoundCancelMessage,
  unpaidRoundCancelOutcome,
} from "./UnpaidRoundCancelAction.js";

const id = (n: number) => "0190ee34-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("WP-2423 abandoned payment: maps the server's answers to staff outcomes", () => {
  expect(unpaidRoundCancelOutcome(200, null)).toBe("Cancelled");
  expect(unpaidRoundCancelOutcome(409, "unpaid_round_paid")).toBe("Paid");
  expect(unpaidRoundCancelOutcome(409, "unpaid_round_payment_in_progress")).toBe(
    "PaymentInProgress",
  );
  expect(unpaidRoundCancelOutcome(409, "order_version_conflict")).toBe("NotCancellable");
  expect(unpaidRoundCancelOutcome(403, "order_cancellation_permission_denied")).toBe("Denied");
  expect(unpaidRoundCancelOutcome(503, "unpaid_round_cancellation_unavailable")).toBe("Unknown");
  for (const text of Object.values(unpaidRoundCancelMessage))
    expect(text).not.toMatch(/[a-z]+_[a-z]+|[A-Z]{3,}_/u);
});

it("WP-2423 abandoned payment: names the round and says nobody is charged", () => {
  const raw = renderToStaticMarkup(
    <UnpaidRoundCancelAction
      orderReference={id(1)}
      orderBatchReference={id(2)}
      roundNumber={1}
      orderLabel="order 12"
      csrf="c"
      onSettled={() => undefined}
    />,
  );
  const html = raw.replaceAll("<!-- -->", "");
  expect(html).toContain("Cancel unpaid round 1");
  expect(html).toContain("Cancel unpaid round 1 of order 12?");
  expect(html).toContain("Nobody is charged.");
  expect(html.replace(/<[^>]+>/gu, " ")).not.toContain(id(2));
});

it("WP-2423 abandoned payment: a payment that just arrived is reported as paid, with a refresh", () => {
  expect(unpaidRoundCancelMessage.Paid).toMatch(/^Payment just arrived/u);
  expect(unpaidRoundCancelMessage.Paid).toContain("Refresh");
});

it("WP-2423 abandoned payment: hands a payment the card provider can't confirm to the manager", () => {
  expect(
    isPaymentUnconfirmed("2026-10-18T12:00:00.000Z", Date.parse("2026-10-18T12:04:59.999Z")),
  ).toBe(false);
  expect(
    isPaymentUnconfirmed("2026-10-18T12:00:00.000Z", Date.parse("2026-10-18T12:05:00.000Z")),
  ).toBe(true);
  expect(isPaymentUnconfirmed(null, Date.now())).toBe(false);
  const html = renderToStaticMarkup(
    <UnpaidRoundCancelAction
      orderReference={id(1)}
      orderBatchReference={id(2)}
      roundNumber={2}
      orderLabel="table A1"
      csrf="c"
      paymentUnconfirmed
      onSettled={() => undefined}
    />,
  ).replaceAll("<!-- -->", "");
  expect(html).toContain("couldn&#x27;t confirm the guest&#x27;s payment");
  expect(html).toContain("Not charged: cancel round 2");
  expect(html).toContain("refunded to the guest automatically");
  expect(html).not.toContain("Nobody has paid for this round");
});

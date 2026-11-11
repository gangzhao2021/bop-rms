import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  CurrentOrderDetails,
  CurrentOrderQueueRows,
  cancelledUnpaid,
  orderCountText,
} from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import {
  counterAwaitingCardMachine,
  counterPayByText,
  counterPayByTier,
  paidNoteText,
} from "./counter-payment.js";
import { refundErrorText } from "./OrderPaymentLinks.js";
import { OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { StaffRoundPaymentAction } from "./StaffRoundPaymentAction.js";

/**
 * WP-2423 (v15 751dd768): a counter order sent and not paid yet stays chargeable after a reload
 * (from the server's Orders read), with its release time warned; Payments and refunds is offered
 * only to people the server lets read them; cancelled unpaid orders and the order count read
 * plainly.
 */
const ref = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = Date.parse("2026-10-21T17:00:00.000Z");
const payBy = "2026-10-21T17:20:00.000Z";
const counterItem = (
  overrides: Record<string, unknown> = {},
  counter: Record<string, unknown> = {},
) => ({
  orderReference: ref(1),
  orderNumber: "7",
  orderType: "Pickup",
  sourceChannel: "Pos",
  submittedAt: "2026-10-21T16:55:00.000Z",
  observedAt: "2026-10-21T16:59:00.000Z",
  initialBatchReference: ref(2),
  batches: [
    {
      orderBatchReference: ref(2),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: true,
  currentPhase: "Submitted",
  currentVersion: 1,
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: null,
    payBy,
    amountDueMinor: null,
    ...counter,
  },
  canRecordCardMachinePayment: true,
  canViewPayments: false,
  ...overrides,
});
const parse = (item: unknown) => {
  const [order] = parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }).items;
  if (order === undefined) throw new Error("no order");
  return order;
};

it("reads a sent, unpaid counter order's release time, amount and the person's capabilities", () => {
  const order = parse(counterItem());
  expect(order.counter?.payBy).toBe(payBy);
  expect(order.counter?.amountDueMinor).toBeNull();
  expect(order.canRecordCardMachinePayment).toBe(true);
  expect(order.canViewPayments).toBe(false);
  expect(counterAwaitingCardMachine(order, now)).toBe(true);
  // Released (pay-by passed), paid, or accepted: no longer chargeable.
  expect(counterAwaitingCardMachine(order, Date.parse(payBy))).toBe(false);
  expect(counterAwaitingCardMachine(parse(counterItem({ awaitingPayment: false })), now)).toBe(
    false,
  );
  // The amount is only for an unpaid order with a release time; a paid one has neither.
  expect(() => parse(counterItem({}, { amountDueMinor: "1130", payBy: null }))).toThrow();
  expect(() =>
    parse(
      counterItem(
        {},
        {
          paidOnCardMachine: {
            amountMinor: "1130",
            takenAt: "2026-10-21T16:58:00.000Z",
            recordedAfterOutage: false,
            refundedMinor: "0",
          },
        },
      ),
    ),
  ).toThrow();
  expect(() => parse(counterItem({ canViewPayments: "yes" }))).toThrow();
  // An older server sends neither: the actions stay offered and a refusal is explained.
  const older: Record<string, unknown> = { ...counterItem() };
  delete older.canRecordCardMachinePayment;
  delete older.canViewPayments;
  const legacy = parse({
    ...older,
    counter: { recordedAfterOutage: false, paidOnCardMachine: null },
  });
  expect(legacy.canViewPayments).toBe(true);
  expect(legacy.counter?.payBy).toBeNull();
  // The one-order read carries what to charge.
  expect(parse(counterItem({}, { amountDueMinor: "1130" })).counter?.amountDueMinor).toBe("1130");
});

it("warns before the release time in staff words, urgently in the last minutes", () => {
  expect(counterPayByText(payBy, "America/Toronto", now)).toBe(
    "Take payment by 13:20 · released if unpaid",
  );
  expect(counterPayByTier(payBy, now)).toBe("warning");
  const late = Date.parse(payBy) - 4 * 60_000;
  expect(counterPayByText(payBy, "America/Toronto", late)).toBe(
    "4 min left to charge · released at 13:20 if unpaid",
  );
  expect(counterPayByTier(payBy, late)).toBe("urgent");
});

it("Orders offers the card-machine charge on the row and says when it is released", () => {
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parseCurrentOrderQueue({ items: [counterItem()], nextAfterOrderReference: null })}
      timeZone="America/Toronto"
      now={now}
    />,
  );
  expect(html).toContain("Take payment by 13:20 · released if unpaid");
  expect(html).toContain(
    "Not paid yet: take payment on the card machine or in cash, then record it below",
  );
  expect(html).not.toContain("from Counter order.");
});

it("WP-2423 M127: Orders tells front of house to ask a manager about an unpaid counter order", () => {
  const rows = (counter: Record<string, unknown>) =>
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parseCurrentOrderQueue({
          items: [counterItem({}, { cancelledBeforePayment: null, ...counter })],
          nextAfterOrderReference: null,
        })}
        timeZone="America/Toronto"
        now={now}
      />,
    );
  const frontOfHouse = rows({ canCancelUnpaid: false });
  expect(frontOfHouse).toContain(
    "A guest who isn&#x27;t paying: ask a manager to cancel it; otherwise it is released at 13:20 and its items go back to stock.",
  );
  const manager = rows({ canCancelUnpaid: true });
  expect(manager).toContain(
    "A guest who isn&#x27;t paying: cancel it below so its items go back to stock.",
  );
  expect(manager).not.toContain("ask a manager to cancel it");
});

it("DEC-PAPER-ORDER-PAID-AT-SEND: a paper order whose payment didn't record is never to charge", () => {
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parseCurrentOrderQueue({
        items: [
          counterItem(
            {},
            { recordedAfterOutage: true, canCancelUnpaid: false, cancelledBeforePayment: null },
          ),
        ],
        nextAfterOrderReference: null,
      })}
      timeZone="America/Toronto"
      now={now}
    />,
  );
  expect(html).toContain("Paid during the outage, but its payment isn&#x27;t recorded yet");
  expect(html).toContain("Don&#x27;t charge again.");
  expect(html).not.toContain("take payment on the card machine");
  expect(html).not.toContain("ask a manager to cancel");
  expect(counterPayByText(payBy, "America/Toronto", now, true)).toBe(
    "Paid during the outage · record it by 13:20, or it is taken off",
  );
  expect(counterPayByText(payBy, "America/Toronto", Date.parse(payBy), true)).toBe(
    "Not recorded by 13:20 · enter the paper order again",
  );
});

it("the counter charge form names the order and warns before release", () => {
  const html = renderToStaticMarkup(
    <StaffRoundPaymentAction
      subject="order"
      label="Take payment"
      csrf="csrf"
      orderReference={ref(1)}
      orderBatchReference={ref(2)}
      amountDueMinor="1130"
      payBy={payBy}
      recordedAfterOutage={false}
      onRecorded={() => undefined}
    />,
  );
  expect(html).toContain("Take payment · $11.30");
});

it("Payments and refunds is hidden from people who can't read payments", () => {
  const details = (canViewPayments: boolean) =>
    renderToStaticMarkup(
      <CurrentOrderDetails
        order={parse(counterItem({ canViewPayments }))}
        csrf="csrf"
        locked={false}
        onBusy={() => undefined}
      />,
    );
  expect(details(false)).not.toContain("Payments and refunds");
  expect(details(true)).toContain("Payments and refunds");
  expect(refundErrorText(new OrdinaryRefundClientError("Denied"))).toBe(
    "Payments and refunds for this order are handled by a manager. Ask a manager if the guest needs a refund.",
  );
});

it("a cancelled order with no payment says so instead of a dash", () => {
  const cancelled = parse({
    ...counterItem({ counter: null, sourceChannel: "Qr", orderType: "DineIn" }),
    awaitingPayment: false,
    currentPhase: "Cancelled",
    batches: [],
  });
  expect(cancelledUnpaid(cancelled)).toBe(true);
  expect(
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={{ items: [cancelled], nextAfterOrderReference: null, unreadable: [] }}
        timeZone="America/Toronto"
      />,
    ),
  ).toContain("Cancelled before payment");
});

it("says how many orders the list shows without page jargon", () => {
  expect(
    orderCountText({ shown: 50, total: 50, filtered: false, olderPage: false, morePages: true }),
  ).toBe("50 orders, newest first. Older orders are on the next page.");
  expect(
    orderCountText({ shown: 12, total: 12, filtered: false, olderPage: false, morePages: false }),
  ).toBe("12 orders.");
  expect(
    orderCountText({ shown: 1, total: 1, filtered: false, olderPage: false, morePages: false }),
  ).toBe("1 order.");
  expect(
    orderCountText({ shown: 3, total: 50, filtered: true, olderPage: false, morePages: true }),
  ).toBe("3 of 50 orders on this page match. Other pages are not searched.");
  expect(
    orderCountText({ shown: 3, total: 9, filtered: true, olderPage: false, morePages: false }),
  ).toBe("3 of 9 orders match.");
});

it("v15 f971cecb: a payment recorded from the list reads like a direct charge", () => {
  expect(
    paidNoteText({ tableMode: false, recordedAfterOutage: false, acceptance: "Accepted" }),
  ).toBe("Paid and sent to the kitchen.");
  expect(
    paidNoteText({ tableMode: false, recordedAfterOutage: true, acceptance: "Accepted" }),
  ).toMatch(/^Recorded after the outage and accepted\./u);
  expect(
    paidNoteText({ tableMode: false, recordedAfterOutage: false, acceptance: "NotAccepted" }),
  ).toMatch(/^Paid, but not sent to the kitchen yet\. Accept it in Orders now/u);
  expect(
    paidNoteText({ tableMode: true, recordedAfterOutage: false, acceptance: "Accepted" }),
  ).toBe("Paid and sent to the kitchen. It shows on the table's order as entered by staff.");
});

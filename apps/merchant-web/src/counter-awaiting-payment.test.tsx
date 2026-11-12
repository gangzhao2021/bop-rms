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
  paperPaymentProblem,
} from "./counter-payment.js";
import { awaitingListGuidance } from "./CounterAwaitingPayment.js";
import { CounterOrderClientError } from "./staff-order-entry.js";
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
    "Paid during the outage · record it by 13:20",
  );
  expect(counterPayByText(payBy, "America/Toronto", Date.parse(payBy), true)).toBe(
    "Not recorded by 13:20 · enter it again from the paper slip",
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

it("DEC-PAPER-ORDER-NEVER-RELEASED: a paper order closed as entered again names the new order carrying its sale on Orders", () => {
  const closed = parse({
    ...counterItem(
      {},
      {
        recordedAfterOutage: true,
        canCancelUnpaid: false,
        canCloseAsReentered: false,
        cancelledBeforePayment: {
          reasonCode: "COUNTER_PAPER_REENTERED",
          cancelledAt: "2026-10-21T17:30:00.000Z",
          reenteredOrderNumber: "34",
        },
      },
    ),
    awaitingPayment: false,
    currentPhase: "Cancelled",
  });
  expect(closed.counter?.cancelledBeforePayment?.reenteredOrderNumber).toBe("34");
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={{ items: [closed], nextAfterOrderReference: null, unreadable: [] }}
      timeZone="America/Toronto"
    />,
  );
  expect(html).toContain("Closed by staff · entered again as order 34, which carries its sale");
  // It was paid on paper: never "cancelled before payment".
  expect(html).not.toContain("Cancelled before payment");
  // v15 2026-11-11 b10: nor a "Cancelled" badge or "Not paid." beside it: the guest paid.
  expect(html).toContain("Paid on paper · entered again");
  expect(html).not.toMatch(/>Cancelled</u);
  expect(html).not.toContain("Not paid.");
  expect(html).toContain(
    "Paid on paper during the outage. Its sale is on order 34; don&#x27;t charge again.",
  );
  // The order number is only for that reason, and only digits.
  for (const wrong of [
    { reasonCode: "COUNTER_GUEST_LEFT_UNPAID", reenteredOrderNumber: "34" },
    { reasonCode: "COUNTER_PAPER_REENTERED", reenteredOrderNumber: "id-34" },
  ])
    expect(() =>
      parse(
        counterItem(
          {},
          {
            recordedAfterOutage: true,
            cancelledBeforePayment: { cancelledAt: "2026-10-21T17:30:00.000Z", ...wrong },
          },
        ),
      ),
    ).toThrow();
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

it("DEC-PAPER-ORDER-PAID-AT-SEND: a list of paper and ordinary orders never asks to charge or cancel the paper ones", () => {
  const listed = (...counters: Record<string, unknown>[]) =>
    parseCurrentOrderQueue({
      items: counters.map((counter, index) =>
        counterItem(
          { orderReference: ref(30 - index) },
          { cancelledBeforePayment: null, canCancelUnpaid: false, ...counter },
        ),
      ),
      nextAfterOrderReference: null,
    }).items;
  const mixed = awaitingListGuidance(
    listed({ recordedAfterOutage: true }, { recordedAfterOutage: false }),
  );
  expect(mixed).toContain("Paper orders were paid during the outage");
  expect(mixed).toContain("don't charge again");
  expect(mixed).toContain("Take payment for the others");
  expect(mixed).toContain("ask a manager to cancel it");
  expect(mixed).not.toContain("Take payment for each");
  // Only an ordinary order's own cancel right decides the cancel words.
  expect(
    awaitingListGuidance(
      listed({ recordedAfterOutage: true }, { recordedAfterOutage: false, canCancelUnpaid: true }),
    ),
  ).toContain("a guest who isn't paying: cancel it so its items go back to stock");
  expect(awaitingListGuidance(listed({ recordedAfterOutage: true }))).toContain(
    "These paper orders were paid during the outage",
  );
});

it("DEC-PAPER-ORDER-PAID-AT-SEND: a paper order's refusals and its recorded cash never ask for cash received or change", () => {
  // There is no cash-received field for a paper cash order: only the paid-at time is checked.
  expect(paperPaymentProblem(new CounterOrderClientError("Invalid"), true)).toBe(
    "Check the paid-at time on the paper slip, then record it again.",
  );
  // Already recorded (an earlier try or another tablet): in the takings, never "to charge".
  const recorded = paperPaymentProblem(new CounterOrderClientError("AlreadyPaid"));
  expect(recorded).toContain("already recorded and in the day's takings");
  expect(recorded).not.toMatch(/before charging/u);
  const notAccepted = paidNoteText({
    tableMode: false,
    recordedAfterOutage: true,
    acceptance: "NotAccepted",
    cash: { changeMinor: "0" },
  });
  expect(notAccepted).toContain("Cash recorded after the outage.");
  expect(notAccepted).not.toContain("change");
});

it("DEC-PAPER-ORDER-NEVER-RELEASED: a paper order past its time stays open, to be entered again and linked by a manager", async () => {
  const { paperAwaitingReentry } = await import("./counter-payment.js");
  const { parsePaperReentryChoices, paperReentryOutcome } = await import("./PaperReentryAction.js");
  const after = Date.parse(payBy) + 60_000;
  const paper = parse(
    counterItem(
      {},
      {
        recordedAfterOutage: true,
        canCancelUnpaid: false,
        cancelledBeforePayment: null,
        canCloseAsReentered: true,
      },
    ),
  );
  // Before its time it is recorded on itself; after it, it is never released but waits to be
  // entered again (a live order past its time is not).
  expect(paperAwaitingReentry(paper, now)).toBe(false);
  expect(paperAwaitingReentry(paper, after)).toBe(true);
  expect(paper.counter?.canCloseAsReentered).toBe(true);
  expect(paperAwaitingReentry(parse(counterItem()), after)).toBe(false);
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parseCurrentOrderQueue({
        items: [
          counterItem(
            {},
            {
              recordedAfterOutage: true,
              canCancelUnpaid: false,
              cancelledBeforePayment: null,
              canCloseAsReentered: true,
            },
          ),
        ],
        nextAfterOrderReference: null,
      })}
      timeZone="America/Toronto"
      now={after}
    />,
  );
  expect(html).toContain("The order stays open: enter it again from the paper slip");
  expect(html).not.toMatch(/taken off|released|Not paid\./u);
  // The new paper orders it may stand for are read from the server (any business day), with both
  // orders' amounts; a cheaper one is marked as unable to carry the sale. The read is strict.
  const choices = parsePaperReentryChoices({
    paperOrder: { orderNumber: "7", saleMinor: "20000", currencyCode: "CAD" },
    candidates: [
      {
        orderReference: ref(110),
        orderNumber: "10",
        submittedAt: "2026-10-21T17:26:00.000Z",
        saleMinor: "500",
        paidMinor: "500",
        coversSale: false,
      },
      {
        orderReference: ref(109),
        orderNumber: "9",
        submittedAt: "2026-10-21T17:25:00.000Z",
        saleMinor: "20000",
        paidMinor: "23000",
        coversSale: true,
      },
    ],
  });
  expect(
    choices.candidates.map((candidate) => [candidate.orderNumber, candidate.coversSale]),
  ).toEqual([
    ["10", false],
    ["9", true],
  ]);
  expect(() =>
    parsePaperReentryChoices({ paperOrder: choices.paperOrder, candidates: [], extra: 1 }),
  ).toThrow();
  expect(() =>
    parsePaperReentryChoices({
      paperOrder: { ...choices.paperOrder, saleMinor: "1.5" },
      candidates: [],
    }),
  ).toThrow();
  expect(paperReentryOutcome(409, "paper_reentry_amount_lower")).toBe("Lower");
  expect(paperReentryOutcome(409, "paper_reentry_used")).toBe("Used");
  expect(paperReentryOutcome(409, "paper_reentry_invalid")).toBe("Invalid");
  expect(paperReentryOutcome(409, "paper_order_still_recordable")).toBe("Recordable");
  expect(paperReentryOutcome(403, "order_cancellation_permission_denied")).toBe("Denied");
  // An outage is never read as no permission.
  expect(paperReentryOutcome(503, "counter_cancellation_unavailable")).toBe("Unknown");
});

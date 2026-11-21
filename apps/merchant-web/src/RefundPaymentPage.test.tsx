import { OrdinaryRefundClientError, type RefundRecoveryView } from "./ordinary-refund-client.js";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { cardMachineRefundRecordedText } from "./CardMachineRequestRefund.js";
import {
  cardMachineRefundBySenderText,
  CardMachineRefundDone,
  cardMachineRefundToRecord,
  MoneyTakenBack,
  moneyTakenBackFailure,
  cardMachineRequestsToCheck,
  nextFinancialSummary,
  onlineSendControl,
  PaymentFinancialSummary,
  paymentLoadFailure,
  paymentRefundStateLabel,
  paymentStateLabel,
  refundEverythingQuantities,
  cardMachineReviewText,
  cashDrawerGivesBackMinor,
  cashRequestRecordedText,
  refundSendsOnConfirm,
  refundWizardSections,
  requestOnlyAbove,
  requestBlockedMessage,
  requestFinished,
  refundStopForCashierText,
  refundStopOffered,
  requestProgressLabel,
  stopMakingByDefault,
} from "./RefundPaymentPage.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { setLanguageForTest } from "./i18n/i18n.js";

afterEach(() => setLanguageForTest("en"));

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const context = {
  paymentIntentReference: id(1),
  paymentAttemptReference: id(2),
  orderReference: id(3),
  orderBatchReference: id(4),
  observedAt: "2026-10-15T17:52:00.000Z",
  paymentState: "Captured" as const,
  paymentMethod: "CardMachine" as const,
  paidInCash: false,
  cashLeftMinor: null,
  cashGivenBackMinor: null,
  currencyCode: "CAD" as const,
  capturedAmountMinor: "593",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "593",
  canRequest: true,
  requestBlocked: null as "SoleOperatorOff" | null,
  canSend: true,
  canRecover: false,
  recoveries: [] as RefundRecoveryView[],
  cashTakeBackLeftMinor: null as string | null,
  recoveryUnreadable: false,
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
  expect(html).toContain("<dt>Refunded</dt>");
  expect(html).toContain("<dt>Being refunded</dt>");
  expect(html).toContain("<dd>Paid, refund pending</dd>");
  expect(html).not.toMatch(/Captured/u);
  expect(
    paymentStateLabel({ ...context, confirmedRefundMinor: "593", pendingRefundMinor: "0" }),
  ).toBe("Refunded");
});

const line = (n: number, change: Record<string, unknown> = {}) => ({
  orderBatchReference: id(90),
  orderItemReference: id(100 + n),
  label: "Mapo tofu",
  quantity: 1,
  unclaimedQuantity: 1,
  paymentCaptured: true,
  refundedByCancellation: false,
  paymentIntentReference: id(1),
  paymentMethod: "CardMachine" as const,
  ...change,
});
type Lines = Parameters<typeof refundEverythingQuantities>[0];

it("Refund everything fills each identical line, and skips what cannot be refunded", () => {
  const lines = [
    line(1),
    line(2),
    line(3, { quantity: 3, unclaimedQuantity: 2 }),
    line(4, { unclaimedQuantity: 0 }),
    line(5, { paymentCaptured: false, unclaimedQuantity: 0, paymentMethod: null }),
    line(6, { refundedByCancellation: true, unclaimedQuantity: 0 }),
  ] as unknown as Lines;
  expect(refundEverythingQuantities(lines, id(1))).toEqual({
    quantities: { [id(101)]: 1, [id(102)]: 1, [id(103)]: 2 },
    limited: false,
  });
});

it("Refund everything stays on this payment when a card-machine refund cannot cover the order", () => {
  const lines = [
    line(1),
    line(2, { paymentIntentReference: id(9), paymentMethod: "Online" }),
  ] as unknown as Lines;
  expect(refundEverythingQuantities(lines, id(1))).toEqual({
    quantities: { [id(101)]: 1 },
    limited: true,
  });
  // Online payments of one order can go on one refund, so all of them are filled.
  const online = [
    line(1, { paymentMethod: "Online" }),
    line(2, { paymentIntentReference: id(9), paymentMethod: "Online" }),
  ] as unknown as Lines;
  expect(refundEverythingQuantities(online, id(1))).toEqual({
    quantities: { [id(101)]: 1, [id(102)]: 1 },
    limited: false,
  });
});

it("a request reads its status by itself until it is refunded", () => {
  expect(requestFinished({ progress: "Recorded" })).toBe(false);
  expect(requestFinished({ progress: "ReadyToSend" })).toBe(false);
  expect(requestFinished({ progress: "Sending" })).toBe(false);
  expect(requestFinished({ progress: "Refunded" })).toBe(true);
});

it("the payment summary and request states read in Chinese, with no English left", () => {
  setLanguageForTest("zh-Hans");
  const html = renderToStaticMarkup(
    <PaymentFinancialSummary
      initial={context}
      csrf={"a".repeat(43)}
      revision={0}
      onContext={vi.fn()}
    />,
  );
  for (const words of ["<dt>状态</dt>", "<dt>已付款</dt>", "<dt>已退款</dt>", "<dt>退款中</dt>"])
    expect(html).toContain(words);
  expect(html).toContain("已付款，退款处理中");
  expect(html).not.toMatch(/Paid|Refund|Last checked|card machine/u);
  expect(requestProgressLabel("Recorded", "CardMachine", "Approved")).toBe(
    "已批准 — 请在刷卡机上退款并记录",
  );
  expect(requestProgressLabel("Sending", "Online", null)).toBe("已发送 — 等待发卡方回复");
  expect(paymentRefundStateLabel("NotDispatched")).toBe("还没发出");
  expect(
    cardMachineRefundRecordedText(
      { amountMinor: "593", refundedAt: "2026-10-15T17:52:00.000Z", receipt: "NoDigitalReceipt" },
      "$5.93",
      "593",
      "America/Toronto",
    ),
  ).toMatch(/^刷卡机退款已记录：.*\$5\.93。刷卡机打印的退款签购单就是顾客的收据。$/u);
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

it("v15 2026-10-17: the payment page lists this payment's card-machine refunds still to record", () => {
  const entry = (n: number, change: Record<string, unknown> = {}) => ({
    requestReference: id(40 + n),
    operationReference: id(50 + n),
    claimVersion: n,
    requestedAt: "2026-10-15T17:52:00.000Z",
    reasonCode: "QUALITY_ISSUE",
    currencyCode: "CAD" as const,
    amountMinor: "480",
    decline: null,
    progress: "Recorded" as const,
    paymentMethod: "CardMachine" as const,
    ...change,
  });
  const items = {
    orderReference: id(3),
    orderNumber: "T4-2",
    canRequest: true,
    claimVersion: 4,
    items: [],
    recentRequests: [
      entry(1),
      entry(2, { progress: "Refunded" }),
      entry(3, { paymentMethod: "Online" }),
      entry(4, {
        decline: {
          reasonCode: "OTHER",
          declinedAt: "2026-10-15T17:53:00.000Z",
          declinerName: null,
          declinedByYou: false,
        },
      }),
    ],
  } as unknown as Parameters<typeof cardMachineRequestsToCheck>[0];
  expect(cardMachineRequestsToCheck(items).map((value) => value.claimVersion)).toEqual([1]);
  const status = (state: "NotDispatched" | "Confirmed", intent = id(1)) =>
    ({
      orderReference: id(3),
      requestReference: id(41),
      operationReference: id(51),
      observedAt: "2026-10-15T17:54:00.000Z",
      currencyCode: "CAD",
      amountMinor: "480",
      payments: [
        {
          paymentAttemptReference: id(2),
          paymentIntentReference: intent,
          method: "CardMachine",
          state,
          executionOperationReference: null,
          executionApprovalReference: null,
          amountMinor: "480",
          confirmedMinor: state === "Confirmed" ? "480" : "0",
          pendingMinor: state === "Confirmed" ? "0" : "480",
          refundedOnCardMachineAt: state === "Confirmed" ? "2026-10-15T17:53:00.000Z" : null,
          cardMachineSlipReference: null,
        },
      ],
    }) as unknown as Parameters<typeof cardMachineRefundToRecord>[2];
  const [first] = cardMachineRequestsToCheck(items);
  if (first === undefined) throw new Error("missing request");
  expect(cardMachineRefundToRecord(id(1), first, status("NotDispatched"), null)).toEqual({
    entry: first,
    amountMinor: "480",
    approval: null,
    cashMinor: null,
  });
  // WP-2423 M52/M131: a counter cash payment says what goes back from the drawer (whole nickels).
  const inCash = status("NotDispatched");
  const cashPayment = { ...inCash.payments[0], cashGivenBackMinor: "480" };
  expect(
    cardMachineRefundToRecord(id(1), first, { ...inCash, payments: [cashPayment] } as never, null)
      ?.cashMinor,
  ).toBe("480");
  // Already recorded, or a request of another payment of the same order: not offered here.
  expect(cardMachineRefundToRecord(id(1), first, status("Confirmed"), null)).toBeNull();
  expect(cardMachineRefundToRecord(id(1), first, status("NotDispatched", id(9)), null)).toBeNull();
  // b12: listed above alone only when nothing is left to do on another payment of the request.
  const own = status("NotDispatched");
  expect(requestOnlyAbove(id(1), own)).toBe(true);
  const other = status("NotDispatched", id(9)).payments[0];
  expect(requestOnlyAbove(id(1), { ...own, payments: [...own.payments, other] } as never)).toBe(
    false,
  );
  const otherDone = status("Confirmed", id(9)).payments[0];
  expect(requestOnlyAbove(id(1), { ...own, payments: [...own.payments, otherDone] } as never)).toBe(
    true,
  );
});

it("M126 I.5: another store's payment and a role that can't refund say why, with no Refresh", () => {
  expect(paymentLoadFailure(new OrdinaryRefundClientError("NotFound"))).toEqual({
    message: "This payment belongs to another store. Switch to that store to refund it.",
    retry: false,
  });
  expect(paymentLoadFailure(new OrdinaryRefundClientError("Denied"))).toEqual({
    message: "Your role can't refund payments. Ask the owner or a manager.",
    retry: false,
  });
  // Only a read that couldn't answer offers reading again.
  expect(paymentLoadFailure(new OrdinaryRefundClientError("Unavailable"))).toMatchObject({
    retry: true,
  });
  setLanguageForTest("zh-Hans");
  expect(paymentLoadFailure(new OrdinaryRefundClientError("NotFound")).message).toBe(
    "这笔付款不属于当前门店，请切换到下单的门店再退款。",
  );
  expect(paymentLoadFailure(new OrdinaryRefundClientError("Denied")).message).toBe(
    "你的角色不能退款，请找店主或店长。",
  );
});

it("WP-2423 M13: an owner whose sole operator is off is told how a refund gets recorded", () => {
  const owner = { ...context, pendingRefundMinor: "0", canRequest: false };
  const blocked = renderToStaticMarkup(
    <MemoryRouter>
      {requestBlockedMessage({ ...owner, requestBlocked: "SoleOperatorOff" })}
    </MemoryRouter>,
  );
  expect(blocked).toContain("turn on Sole operator in Store setup");
  expect(blocked).toContain("Store Manager role in Staff");
  expect(blocked).not.toContain("Only a store manager records refund requests");
  // Finance (approve only) keeps the Approvals pointer.
  expect(
    renderToStaticMarkup(<MemoryRouter>{requestBlockedMessage(owner)}</MemoryRouter>),
  ).toContain("Only a store manager records refund requests");
});

it("WP-2423 M163: a manager takes money back on a refunded order; what was taken back is listed", () => {
  const refunded = { ...context, confirmedRefundMinor: "593", pendingRefundMinor: "0" };
  const html = (value: typeof refunded) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <MoneyTakenBack context={value} csrf="c" onRecorded={() => undefined} />
      </MemoryRouter>,
    );
  expect(html({ ...refunded, canRecover: true })).toContain("Take money back");
  // Nothing refunded, or a reader who may not record it: nothing is offered.
  expect(html({ ...refunded, canRecover: true, confirmedRefundMinor: "0" })).toBe("");
  expect(html(refunded)).toBe("");
  const listed = html({
    ...refunded,
    canRecover: false,
    recoveries: [
      {
        recoveryReference: "01909974-0000-7000-8000-000000000070",
        method: "Cash" as const,
        amountMinor: "500",
        currencyCode: "CAD" as const,
        reasonCode: "REFUNDED_TOO_MUCH" as const,
        businessDate: "2026-11-10",
        recordedAt: "2026-11-10T12:00:00.000Z",
        recordedByName: "Sam",
      },
    ],
  });
  expect(listed).toContain("Money taken back +$5.00 · Cash · Sam");
  expect(listed).not.toContain("Take money back");
});

it("WP-2423 M14: a cashier's unsent request is never read as approved, and Send is only for who may send", () => {
  const notSent = { method: "Online", state: "NotDispatched", executionOperationReference: null };
  const prepared = { ...notSent, state: "Prepared", executionOperationReference: id(9) };
  // A cashier's own request (NotSent on Approvals): told who sends it, never offered Send.
  expect(onlineSendControl(notSent, { state: "NotSent" }, false)).toBe("AskedManagerSends");
  // Not on Approvals yet: still no Send for someone who can't send.
  expect(onlineSendControl(notSent, null, false)).toBe("ManagerSends");
  expect(onlineSendControl(prepared, null, false)).toBe("ManagerSends");
  // A manager or the owner reading a cashier's request sends it here, not "approved".
  expect(onlineSendControl(notSent, { state: "NotSent" }, true)).toBe("AskedSendHere");
  expect(onlineSendControl(notSent, null, true)).toBe("Send");
  expect(onlineSendControl(prepared, null, true)).toBe("Send");
  // Approval states are said as they are.
  expect(onlineSendControl(notSent, { state: "AwaitingApproval" }, true)).toBe("AwaitingApproval");
  expect(onlineSendControl(notSent, { state: "Approved" }, true)).toBe("ApprovedNotSent");
  expect(onlineSendControl({ ...notSent, method: "CardMachine" }, null, true)).toBeNull();
});

it("WP-2423 M163: an attempt already recorded with other details is said plainly, never retried forever", () => {
  const conflict = moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryConflict"));
  expect(conflict.message).toContain("already recorded with other details");
  expect(conflict.message).not.toContain("Press Record again");
  expect(conflict).toMatchObject({ attemptAnswered: true, reread: true });
  // Only an unknown result keeps the attempt, so pressing Record again never records it twice.
  expect(moneyTakenBackFailure(new OrdinaryRefundClientError("OutcomeUnknown"))).toMatchObject({
    attemptAnswered: false,
    message: "Couldn't confirm it was recorded. Press Record again: it is never recorded twice.",
  });
  expect(
    moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryAboveRefunded")).attemptAnswered,
  ).toBe(true);
});

it("b12: a cash order's take-back refused for its method or cents says why, never a permission", () => {
  const cashOnly = moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryCashOnly"));
  expect(cashOnly).toMatchObject({
    message: "This order was paid in cash, so money taken back is cash only. Nothing was recorded.",
    attemptAnswered: true,
    reread: true,
  });
  const nickels = moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryWholeNickels"));
  expect(nickels.message).toBe(
    "Cash comes back in whole nickels, for example 3.65. Nothing was recorded.",
  );
  setLanguageForTest("zh-Hans");
  expect(moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryCashOnly")).message).toBe(
    "这单用现金付款，收回的钱只能是现金。没有记录。",
  );
  expect(moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryWholeNickels")).message).toBe(
    "现金按 5 分取整，例如 3.65。没有记录。",
  );
});

it("WP-2423 M10: stop making it too is ticked by default only for a dish known not to be made", () => {
  expect(stopMakingByDefault("NotStarted")).toBe(true);
  expect(stopMakingByDefault("Started")).toBe(false);
  // Not known (the kitchen could not be read): never preselected.
  expect(stopMakingByDefault(null)).toBe(false);
});

it("WP-2423 M10/M14: a cashier, whose request a manager sends, is pointed to Cancel items instead of Stop making it too", () => {
  const dish = { kitchen: "NotStarted" as const, withdrawnQuantity: 0, quantity: 2 };
  expect(refundStopOffered(dish, true, true)).toBe(true);
  expect(refundStopForCashierText(dish, true, true)).toBeNull();
  // A cashier who may take dishes off an order: no checkbox, a note saying what to do.
  expect(refundStopOffered(dish, true, false)).toBe(false);
  expect(refundStopForCashierText(dish, true, false)).toContain("use Cancel items on the order");
  // Nobody is told about a dish they couldn't stop anyway.
  expect(refundStopForCashierText(dish, false, false)).toBeNull();
  expect(refundStopForCashierText({ ...dish, kitchen: "Cancelled" }, true, false)).toBeNull();
  setLanguageForTest("zh-Hans");
  expect(refundStopForCashierText(dish, true, false)).toContain("取消商品");
});

it("WP-2423 M14: a cashier's review never says the refund is sent on confirming", () => {
  // v15 batch 5: the cashier read "Send $15.68 refund" and "as soon as you confirm", though
  // pressing it only records a request a manager or the owner sends.
  expect(refundSendsOnConfirm({ approvalRequired: false }, false, true)).toBe(true);
  expect(refundSendsOnConfirm({ approvalRequired: false }, false, false)).toBe(false);
  expect(refundSendsOnConfirm({ approvalRequired: true }, false, true)).toBe(false);
  expect(refundSendsOnConfirm({ approvalRequired: false }, true, true)).toBe(false);
  expect(refundSendsOnConfirm(null, false, true)).toBe(false);
});

it("v15 batch 5: a cashier's card-machine review matches what they are told after recording", () => {
  // The review told a cashier to refund on the machine and record it, which a cashier can't do.
  // b13: nor is a card-machine refund "sent from Approvals": a manager or the owner refunds it on
  // the card machine and records it on the payment page, as the request line says.
  for (const approvalRequired of [false, true]) {
    const cashier = cardMachineReviewText(approvalRequired, false);
    expect(cashier).toContain(
      "a manager or the owner refunds it on the card machine and records it on the payment page",
    );
    expect(cashier).not.toMatch(/sends? it|Approvals/u);
    expect(cashier).not.toContain("refund this amount on that machine");
  }
  expect(cardMachineReviewText(false, true)).toContain("refund this amount on that machine");
  expect(cardMachineReviewText(true, true)).toContain("recorded and approved");
  setLanguageForTest("zh-Hans");
  expect(cardMachineReviewText(false, false)).toContain(
    "由店长或店主在刷卡机上退款，并在付款页记录",
  );
  expect(cardMachineReviewText(false, false)).not.toContain("审批");
  expect(cardMachineReviewText(true, false)).toContain("批准后");
});

it("v15 batch 8: a counter cash payment is described as cash from the drawer, never the card machine", () => {
  const html = renderToStaticMarkup(
    <PaymentFinancialSummary
      initial={{ ...context, paidInCash: true, cashLeftMinor: "1075" }}
      csrf={"a".repeat(43)}
      revision={0}
      onContext={vi.fn()}
    />,
  );
  expect(html).toContain("Paid in cash at the counter.");
  expect(html).toContain("whole nickels");
  expect(html).not.toContain("card machine");
  expect(requestProgressLabel("Recorded", "CardMachine", null, true)).toBe("To give back in cash");
  expect(requestProgressLabel("Refunded", "CardMachine", null, true)).toBe("Given back in cash");
  expect(requestProgressLabel("Recorded", "CardMachine", "Approved", true)).toBe(
    "Approved — give it back in cash and record it",
  );
  expect(requestProgressLabel("Recorded", "CardMachine", "AwaitingApproval", true)).toBe(
    "Waiting for owner approval",
  );
  // The review names the requested amount and the whole nickels the drawer gives back, for a
  // cashier (a manager or the owner gives it back) and after approval alike: never "sent".
  const cash = { requested: "$3.67", drawer: "$3.65" };
  for (const approvalRequired of [false, true])
    for (const canSend of [false, true]) {
      const review = cardMachineReviewText(approvalRequired, canSend, cash);
      expect(review).toMatch(/^Paid in cash\./u);
      expect(review).not.toMatch(/card machine|on that machine|sends?\b/u);
      expect(review).toContain("give");
      expect(review).toContain(
        "back $3.65 from the drawer (the refund of $3.67, in whole nickels)",
      );
      if (!canSend) expect(review).toContain("a manager or the owner gives back $3.65");
      if (approvalRequired) expect(review).toContain("approved");
    }
  // The drawer amount: whole nickels, never more than the drawer still holds of the payment.
  expect(cashDrawerGivesBackMinor("367", "1075")).toBe("365");
  expect(cashDrawerGivesBackMinor("368", "1075")).toBe("370");
  expect(cashDrawerGivesBackMinor("338", "335")).toBe("335");
  expect(cashDrawerGivesBackMinor("367", null)).toBe("365");
  expect(cashDrawerGivesBackMinor("367", "0")).toBe("0");
  // After recording: the same words as the review and Approvals, for every way it can go.
  const recorded = (awaitingApproval: boolean, approveAlone: boolean, canSend: boolean) =>
    cashRequestRecordedText({
      total: "$3.67",
      drawer: "$3.65",
      awaitingApproval,
      approveAlone,
      canSend,
    });
  for (const text of [
    recorded(false, false, false),
    recorded(false, false, true),
    recorded(true, false, false),
    recorded(true, false, true),
    recorded(true, true, true),
  ]) {
    expect(text).toContain("Request recorded for $3.67.");
    expect(text).toContain("$3.65 from the drawer (in whole nickels)");
    expect(text).not.toMatch(/card machine|\bsen[dt]s?\b/u);
  }
  expect(recorded(false, false, false)).toContain("a manager or the owner gives back $3.65");
  expect(recorded(true, false, false)).toContain(
    "once the owner approves it, a manager or the owner gives back",
  );
  expect(recorded(false, false, true)).toContain("Now give back $3.65");
  // A card-machine payment keeps its card-machine words.
  expect(requestProgressLabel("Recorded", "CardMachine", null)).toBe(
    "To refund on the card machine",
  );
  setLanguageForTest("zh-Hans");
  expect(requestProgressLabel("Recorded", "CardMachine", null, true)).toBe("待退还现金");
  expect(cardMachineReviewText(false, true, cash)).toContain(
    "请从钱箱退还现金 $3.65（退款 $3.67，按 5 分取整）",
  );
  expect(cardMachineReviewText(true, false, cash)).toContain("由店长或店主从钱箱退还现金 $3.65");
  expect(recorded(true, false, false)).toContain("店主批准后，由店长或店主从钱箱退还现金 $3.65");
  expect(recorded(false, false, true)).toContain("请从钱箱退还现金 $3.65（按 5 分取整）");
});

// b9 refund-cashier-authorization (WP-2423 M14): a cashier is told who makes and records the
// card-machine or cash refund, never asked to record it themselves.
it("tells a cashier that a manager or the owner makes and records the machine or cash refund", () => {
  expect(cardMachineRefundBySenderText("$2.83", null)).toBe(
    "Not refunded yet. A manager or the owner refunds $2.83 on the card machine and records it.",
  );
  expect(cardMachineRefundBySenderText("$2.83", "$2.85")).toBe(
    "Not given back yet. A manager or the owner gives back $2.85 in cash and records it.",
  );
  setLanguageForTest("zh-Hans");
  expect(cardMachineRefundBySenderText("$2.83", null)).toBe(
    "还没退款。由店长或店主在刷卡机上退款 $2.83，再在这里记录。",
  );
  expect(cardMachineRefundBySenderText("$2.83", "$2.85")).toBe(
    "还没退还。由店长或店主从钱箱退还现金 $2.85，再在这里记录。",
  );
});

it("b13: a cash payment says both the refund and the cash given back, with one Refresh for the page", () => {
  // v15 b12 live: after $5.10 left the drawer for a $5.09 refund, the page read "Refunded $5.09"
  // only, and the refund page had three Refresh links.
  const html = renderToStaticMarkup(
    <PaymentFinancialSummary
      initial={{
        ...context,
        paidInCash: true,
        cashLeftMinor: "0",
        cashGivenBackMinor: "510",
        capturedAmountMinor: "509",
        confirmedRefundMinor: "509",
        pendingRefundMinor: "0",
      }}
      csrf={"a".repeat(43)}
      revision={0}
      onContext={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(html).toContain("<dt>Refunded</dt><dd>$5.09</dd>");
  expect(html).toContain("<dt>Cash given back from the drawer</dt><dd>$5.10</dd>");
  expect(html.match(/>Refresh</gu)).toHaveLength(1);
  expect(html).toContain('aria-label="Refresh the payment and its refunds"');
  // A card payment has no cash line.
  const card = renderToStaticMarkup(
    <PaymentFinancialSummary
      initial={context}
      csrf={"a".repeat(43)}
      revision={0}
      onContext={vi.fn()}
    />,
  );
  expect(card).not.toContain("Cash given back");
  setLanguageForTest("zh-Hans");
  expect(
    renderToStaticMarkup(
      <PaymentFinancialSummary
        initial={{ ...context, paidInCash: true, cashLeftMinor: "0", cashGivenBackMinor: "510" }}
        csrf={"a".repeat(43)}
        revision={0}
        onContext={vi.fn()}
      />,
    ),
  ).toContain("从钱箱退还的现金");
});

it("b13: a take-back of nothing is told as an amount to enter, never as a permission refusal", () => {
  const answer = moneyTakenBackFailure(new OrdinaryRefundClientError("RecoveryAmountZero"));
  expect(answer).toEqual({
    message: "Enter the amount taken back; it must be more than $0.00. Nothing was recorded.",
    attemptAnswered: true,
    reread: false,
  });
  expect(answer.message).not.toMatch(/manager|owner|permission/iu);
});

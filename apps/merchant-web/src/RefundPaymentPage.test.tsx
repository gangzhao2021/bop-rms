import type { RefundRecoveryView } from "./ordinary-refund-client.js";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { cardMachineRefundRecordedText } from "./CardMachineRequestRefund.js";
import {
  CardMachineRefundDone,
  cardMachineRefundToRecord,
  MoneyTakenBack,
  cardMachineRequestsToCheck,
  nextFinancialSummary,
  PaymentFinancialSummary,
  paymentLoadFailure,
  paymentRefundStateLabel,
  paymentStateLabel,
  refundEverythingQuantities,
  refundWizardSections,
  requestBlockedMessage,
  requestFinished,
  requestProgressLabel,
} from "./RefundPaymentPage.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { OrdinaryRefundClientError } from "./ordinary-refund-client.js";

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
  currencyCode: "CAD" as const,
  capturedAmountMinor: "593",
  confirmedRefundMinor: "0",
  pendingRefundMinor: "593",
  canRequest: true,
  requestBlocked: null as "SoleOperatorOff" | null,
  canSend: true,
  canRecover: false,
  recoveries: [] as RefundRecoveryView[],
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
  });
  // Already recorded, or a request of another payment of the same order: not offered here.
  expect(cardMachineRefundToRecord(id(1), first, status("Confirmed"), null)).toBeNull();
  expect(cardMachineRefundToRecord(id(1), first, status("NotDispatched", id(9)), null)).toBeNull();
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

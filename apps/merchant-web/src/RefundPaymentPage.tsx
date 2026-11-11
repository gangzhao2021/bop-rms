import { dollarsToMinor } from "./store-price-pages.js";
import { countOf, t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { refundErrorText as errorMessage } from "./OrderPaymentLinks.js";
import {
  RefundExecutionAction,
  RefundSendAction,
  refundRunPorts,
} from "./RefundExecutionAction.js";
import { CardMachineRequestRefund } from "./CardMachineRequestRefund.js";
import {
  createRefundRun,
  RefundRunError,
  refundRunFailureText,
  refundRunProgressText,
  refundRunRetryLabel,
  refundRunUncertain,
  type RefundRun,
  type RefundRunStep,
} from "./ordinary-refund-run.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { SourceTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  createOrdinaryRefundClient,
  OrdinaryRefundClientError,
  type RefundRequestProgress,
} from "./ordinary-refund-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
import { createRefundApprovalClient, type RefundApprovalEntry } from "./refund-approval-client.js";
import {
  declineReasonLabel,
  describeRefundReason,
  escalationReasonLabel,
  refundReasonCodes,
  refundReasonLabel,
} from "./refund-reasons.js";
const client = createOrdinaryRefundClient();
const approvalClient = createRefundApprovalClient();
type Context = Awaited<ReturnType<typeof client.context>>;
type Items = Awaited<ReturnType<typeof client.items>>;
type RefundItem = Items["items"][number];
type Intent = ReturnType<typeof client.prepareRequest>;
type Preview = Awaited<ReturnType<Intent["preview"]>>;
type Submitted = Awaited<ReturnType<Intent["submit"]>>;
const amount = (value: string | null) =>
  value === null ? t("Not known") : orderMoney({ amountMinor: value, currencyCode: "CAD" });
/** WP-2423 Q5: what is left of the captured amount after confirmed and pending refunds. */
function refundableMinor(context: Context): bigint {
  if (
    context.capturedAmountMinor === null ||
    context.confirmedRefundMinor === null ||
    context.pendingRefundMinor === null
  )
    return 0n;
  return (
    BigInt(context.capturedAmountMinor) -
    BigInt(context.confirmedRefundMinor) -
    BigInt(context.pendingRefundMinor)
  );
}
/** WP-2423 Q5: why no new refund request can be recorded on this payment, or null. */
export function requestBlockedMessage(context: Context): ReactNode {
  if (refundableMinor(context) <= 0n) {
    const pending = BigInt(context.pendingRefundMinor ?? "0");
    return (
      <p>
        {pending > 0n
          ? t(
              "A refund of {amount} is being made; nothing more can be refunded until it finishes.",
              {
                amount: amount(String(pending)),
              },
            )
          : t("Nothing is left to refund on this payment.")}
        {context.canRequest ? null : (
          <>
            {" "}
            <Link to="/app/approvals">{t("Open Approvals")}</Link>
          </>
        )}
      </p>
    );
  }
  if (!context.canRequest)
    return context.requestBlocked === "SoleOperatorOff" ? (
      // WP-2423 M13 (DEC-OWNER-DEFAULTS-2026-11-06 item 1): two people stay the default; the
      // owner running the store alone is told how to record one.
      <p>
        {t(
          "Refunds are recorded by a store manager, and then you approve them. If you run the store alone, turn on Sole operator in Store setup (it applies to every store of this brand), or give someone the Store Manager role in Staff.",
        )}{" "}
        <Link to="/app/approvals">{t("Open Approvals")}</Link>
      </p>
    ) : (
      <p>
        {t("Only a store manager records refund requests. To approve or decline a refund:")}{" "}
        <Link to="/app/approvals">{t("Open Approvals")}</Link>
      </p>
    );
  return null;
}
/** Payment state in staff language, including refunds already made. */
export function paymentStateLabel(context: Context): string {
  if (context.paymentState !== "Captured")
    return context.paymentState === "Failed" ? t("Failed") : t("Not confirmed yet");
  const captured = BigInt(context.capturedAmountMinor ?? "0"),
    confirmed = BigInt(context.confirmedRefundMinor ?? "0"),
    pending = BigInt(context.pendingRefundMinor ?? "0");
  if (confirmed >= captured && captured > 0n) return t("Refunded");
  if (confirmed > 0n)
    return pending > 0n ? t("Partly refunded, refund pending") : t("Partly refunded");
  if (pending > 0n) return t("Paid, refund pending");
  return t("Paid");
}
/**
 * WP-2423 item 6: where one recorded request stands, in staff language. A refund is called sent
 * only once it was really sent to the card provider ("Sending"); prepared is still not sent.
 */
export function requestProgressLabel(
  progress: RefundRequestProgress,
  paymentMethod: "Online" | "CardMachine",
  approvalState: RefundApprovalEntry["state"] | null,
): string {
  if (approvalState === "AwaitingApproval") return t("Waiting for owner approval");
  if (paymentMethod === "CardMachine")
    return approvalState === "Approved"
      ? t("Approved — refund it on the card machine and record it")
      : progress === "Refunded"
        ? t("Refunded on the card machine")
        : t("To refund on the card machine");
  if (progress === "Refunded") return t("Refunded");
  if (progress === "Sending") return t("Sent — waiting for the card provider's answer");
  if (approvalState === "Approved") return t("Approved, not sent yet");
  return progress === "Recorded" ? t("Recorded, not sent yet") : t("Not sent yet");
}
/** WP-2423 item 6: one online payment's refund state within a request, in staff language. */
export function paymentRefundStateLabel(
  state: "NotDispatched" | "Prepared" | "NeedsReconciliation" | "Confirmed",
): string {
  return state === "Confirmed"
    ? t("Refunded")
    : state === "NeedsReconciliation"
      ? t("Sent — waiting for the card provider's answer")
      : t("Not sent yet");
}
/** WP-2423 item 4: a request's refund as recorded from the store's card machine. */
export function CardMachineRefundDone({
  amountMinor,
  refundedAt,
  slipReference,
}: {
  readonly amountMinor: string;
  readonly refundedAt: string;
  /** The reference printed on the refund slip, as staff entered it (null: none entered). */
  readonly slipReference: string | null;
}) {
  return (
    <>
      {t("Refunded {amount} on the store's card machine", { amount: amount(amountMinor) })}{" "}
      <SourceTime instant={refundedAt} /> ·{" "}
      {slipReference !== null
        ? t("Slip reference: {slipReference}.", { slipReference })
        : t("No slip reference was entered.")}
    </>
  );
}
/** A request with nothing left to follow up: its details open on request, not by themselves. */
export function requestFinished(entry: Pick<Items["recentRequests"][number], "progress">): boolean {
  return entry.progress === "Refunded";
}
type RequestTone = "attention" | "progress" | "done" | "quiet";
/** The dot beside a request's state: needs someone now, on its way, or done. */
function requestTone(
  entry: Items["recentRequests"][number],
  approvalState: RefundApprovalEntry["state"] | null,
): RequestTone {
  if (requestFinished(entry)) return "done";
  return entry.paymentMethod === "CardMachine" && approvalState !== "AwaitingApproval"
    ? "attention"
    : "progress";
}
/** One recorded request: its amount and where it stands, then why and when under them. */
function RequestRow({
  entry,
  amountMinor = entry.amountMinor,
  tone,
  state,
  action,
  children,
}: {
  readonly entry: Items["recentRequests"][number];
  readonly amountMinor?: string;
  readonly tone: RequestTone;
  readonly state: string;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <div className="refund-request__head">
        <strong className="refund-request__amount">{amount(amountMinor)}</strong>
        <span className="refund-request__state" data-tone={tone}>
          {state}
        </span>
        {action}
      </div>
      <p className="refund-request__meta">
        {t("Request {value}", { value: entry.claimVersion })} ·{" "}
        {describeRefundReason(entry.reasonCode)} · <SourceTime instant={entry.requestedAt} />
      </p>
      {children}
    </>
  );
}
/**
 * WP-2423 M14/Q5: what a recorded online refund payment that is not sent yet offers this reader.
 * Waiting for or holding an approval is said as it is; a request needing no approval that nobody
 * sent (NotSent on Approvals, a cashier's) is never read as approved. Send is offered only to a
 * reader who may send (payment.refund.execute); a cashier is told who sends it.
 */
export function onlineSendControl(
  payment: { method: string; state: string; executionOperationReference: string | null },
  approval: Pick<RefundApprovalEntry, "state"> | null,
  canSend: boolean,
):
  | "AwaitingApproval"
  | "ApprovedNotSent"
  | "AskedSendHere"
  | "AskedManagerSends"
  | "ManagerSends"
  | "Send"
  | null {
  if (payment.method !== "Online") return null;
  if (payment.state === "Prepared" && payment.executionOperationReference)
    return canSend ? "Send" : "ManagerSends";
  if (payment.state !== "NotDispatched") return null;
  if (approval?.state === "AwaitingApproval") return "AwaitingApproval";
  if (approval?.state === "Approved") return "ApprovedNotSent";
  if (approval?.state === "NotSent") return canSend ? "AskedSendHere" : "AskedManagerSends";
  return canSend ? "Send" : "ManagerSends";
}
const onlineSendOffered = (control: ReturnType<typeof onlineSendControl>) =>
  control === "Send" || control === "AskedSendHere";
function RecordedRequestStatus({
  orderReference,
  entry,
  approval,
  csrf,
  onFinancialChange,
  onRequestsChange,
  onPending,
  held = false,
  refreshSignal,
  canSend = true,
}: {
  orderReference: string;
  entry: Items["recentRequests"][number];
  /**
   * WP-2423 M14: this reader may send a refund (payment.refund.execute). A cashier asks; a
   * manager or the owner sends it, so a cashier is never offered Send.
   */
  canSend?: boolean;
  /** WP-2423 item 6: the refund form below is still sending this request (resume it there). */
  held?: boolean;
  /** WP-2423 Q5: this request's place in the Store's approval list (null: none needed/known). */
  approval: RefundApprovalEntry | null;
  csrf: string;
  onFinancialChange: () => void;
  /** Reread the order's recorded requests after a write on this one. */
  onRequestsChange: () => void;
  onPending: (paymentReference: string, active: boolean) => void;
  /** Changes when staff refresh the whole list: this request's status is read again then. */
  refreshSignal: number;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.status>> | null>(null);
  const [message, setMessage] = useState("");
  // The confirmation of a write on this request; kept while its status is reread.
  const [notice, setNotice] = useState<string | null>(null);
  // The machine refund was just recorded here: its form is gone until the status is reread.
  const [recordedHere, setRecordedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef<AbortController | null>(null);
  const everRead = useRef(false);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  /**
   * "auto" follows the list and writes nothing, so it leaves the payment amounts alone (several
   * requests would otherwise reread them over each other). "tap" is staff asking; "write" comes
   * after a change on this request and supersedes any read started before it. The last status
   * stays on screen during a reread: its record and send controls hold the references of a retry.
   */
  const load = async (mode: "auto" | "tap" | "write") => {
    const afterWrite = mode === "write";
    if (pending.current) {
      if (!afterWrite) return;
      // A write supersedes a read that started before it.
      pending.current.abort();
    }
    const controller = new AbortController();
    pending.current = controller;
    everRead.current = true;
    setBusy(true);
    setMessage("");
    if (mode === "tap") setNotice(null);
    try {
      const value = await client.status(
        orderReference,
        entry.operationReference,
        csrf,
        controller.signal,
      );
      if (
        value.requestReference !== entry.requestReference ||
        value.amountMinor !== entry.amountMinor
      )
        throw new OrdinaryRefundClientError("Unavailable");
      if (!controller.signal.aborted) {
        setResult(value);
        setRecordedHere(false);
        if (mode !== "auto") onFinancialChange();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(errorMessage(error));
        setRecordedHere(false);
        // The write happened: the payment amounts are reread even when this status is not.
        if (afterWrite) onFinancialChange();
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // A request not finished shows where it stands straight away, and follows the list when its
  // progress changes or staff refresh. A finished one is read only once staff open its details.
  const finished = requestFinished(entry);
  useEffect(() => {
    if (finished && !everRead.current) return;
    void load("auto");
    // Only these inputs start a read; load itself changes on every render.
  }, [entry.operationReference, entry.progress, refreshSignal]);
  // WP-2423 item 4: after the machine refund is recorded, show where the request now stands from
  // the server (this status, the payment amounts and the order's request list), not a local guess.
  const recorded = (confirmation: string) => {
    setNotice(confirmation);
    setRecordedHere(true);
    onRequestsChange();
    void load("write");
  };
  const paymentPending = (paymentReference: string) => (active: boolean) => {
    onPending(paymentReference, active);
    setPreparing((prior) => {
      const next = new Set(prior);
      if (active) next.add(paymentReference);
      else next.delete(paymentReference);
      return next;
    });
  };
  const opened = result !== null || !finished;
  return (
    <RequestRow
      entry={entry}
      tone={requestTone(entry, approval?.state ?? null)}
      state={requestProgressLabel(entry.progress, entry.paymentMethod, approval?.state ?? null)}
      action={
        <button
          type="button"
          className="refund-text refund-request__refresh"
          disabled={busy || preparing.size > 0}
          aria-label={
            opened
              ? t("Refresh request {value}", { value: entry.claimVersion })
              : t("Show details of request {value}", { value: entry.claimVersion })
          }
          onClick={() => void load("tap")}
        >
          {opened ? t("Refresh") : t("Details")}
        </button>
      }
    >
      {notice ? (
        <p role="status" className="refund-request__note">
          {notice}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="refund-request__note">
          {message}
        </p>
      ) : null}
      {busy && result === null ? (
        <p role="status" className="refund-request__muted">
          {t("Loading…")}
        </p>
      ) : null}
      {result ? (
        <section
          aria-label={t("Details of request {value}", { value: entry.claimVersion })}
          className="refund-request__details"
        >
          <ul>
            {result.payments.map((payment, index) => (
              <li key={payment.paymentAttemptReference}>
                {payment.method === "CardMachine" ? (
                  // WP-2423 item 4: refunded on the store's card machine, then recorded here.
                  payment.state === "Confirmed" && payment.refundedOnCardMachineAt !== null ? (
                    <p>
                      <CardMachineRefundDone
                        amountMinor={payment.amountMinor}
                        refundedAt={payment.refundedOnCardMachineAt}
                        slipReference={payment.cardMachineSlipReference}
                      />
                    </p>
                  ) : approval?.state === "AwaitingApproval" ? (
                    <p>
                      {t("{amount} to refund on the card machine once an owner approves it.", {
                        amount: amount(payment.amountMinor),
                      })}{" "}
                      <Link to="/app/approvals">{t("Open Approvals")}</Link>
                    </p>
                  ) : recordedHere ? null : (
                    <CardMachineRequestRefund
                      orderReference={orderReference}
                      requestReference={entry.requestReference}
                      amountMinor={payment.amountMinor}
                      amountLabel={amount(payment.amountMinor)}
                      csrf={csrf}
                      onRecorded={recorded}
                    />
                  )
                ) : (
                  <p>
                    {result.payments.length > 1
                      ? t("Payment {value}:", { value: index + 1 }) + " "
                      : ""}
                    {paymentRefundStateLabel(payment.state)} ·{" "}
                    {t("Requested {requested}; refunded {refunded}; being refunded {pending}.", {
                      requested: amount(payment.amountMinor),
                      refunded: amount(payment.confirmedMinor),
                      pending: amount(payment.pendingMinor),
                    })}
                  </p>
                )}
                {payment.method === "Online" &&
                (payment.state === "NeedsReconciliation" || payment.state === "Confirmed") &&
                payment.executionOperationReference ? (
                  <RefundExecutionAction
                    key={payment.executionOperationReference + ":" + payment.state}
                    orderReference={orderReference}
                    operationReference={payment.executionOperationReference}
                    csrf={csrf}
                    onPending={paymentPending(payment.paymentAttemptReference)}
                    onDone={(confirmation) => {
                      setNotice(confirmation);
                      onRequestsChange();
                      void load("write");
                    }}
                  />
                ) : null}
                {(() => {
                  const control = onlineSendControl(payment, approval, canSend);
                  const text =
                    control === "AwaitingApproval"
                      ? t(
                          "Waiting for an owner or finance member to approve this refund in person. It is sent once approved.",
                        )
                      : control === "ApprovedNotSent"
                        ? t(
                            "Approved, not sent yet. The approver sends it from Approvals; it is never sent twice.",
                          )
                        : control === "AskedSendHere"
                          ? t("Asked by staff, not sent yet. Send it here or from Approvals.")
                          : control === "AskedManagerSends"
                            ? t("Not sent yet. A manager or the owner sends it from Approvals.")
                            : control === "ManagerSends"
                              ? t("Not sent yet. A manager or the owner sends it.")
                              : null;
                  return text === null ? null : (
                    <p>
                      {text}
                      {control === "AwaitingApproval" ||
                      control === "ApprovedNotSent" ||
                      control === "AskedManagerSends" ? (
                        <>
                          {" "}
                          <Link to="/app/approvals">{t("Open Approvals")}</Link>
                        </>
                      ) : null}
                    </p>
                  );
                })()}
                {onlineSendOffered(onlineSendControl(payment, approval, canSend)) ? (
                  held ? (
                    <p>
                      {t("Continue sending this refund with the button further down the page.")}
                    </p>
                  ) : (
                    <RefundSendAction
                      // A Manager sends a refund that needs no approval with one confirmation; an
                      // approved refund is prepared by its approval and only sent from here.
                      key={payment.paymentAttemptReference + ":" + payment.state}
                      orderReference={orderReference}
                      requestReference={entry.requestReference}
                      requestOperationReference={entry.operationReference}
                      paymentAttemptReference={payment.paymentAttemptReference}
                      preparedOperationReference={payment.executionOperationReference}
                      approvalReference={payment.executionApprovalReference}
                      amountLabel={amount(payment.amountMinor)}
                      csrf={csrf}
                      onPending={paymentPending(payment.paymentAttemptReference)}
                      onDone={recorded}
                    />
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {/* What the card provider has not answered yet; a machine refund is staff's own step. */}
          {result.payments.some(
            (payment) => payment.method === "Online" && BigInt(payment.pendingMinor) > 0n,
          ) ? (
            <p className="refund-request__muted">
              {t(
                "The amount being refunded stays set aside until the refund finishes, so it cannot be refunded twice. The refund receipt is ready once it is refunded.",
              )}
            </p>
          ) : null}
          {result.payments.some((payment) => payment.method === "Online") ? (
            <p className="refund-request__muted">
              {t("Last checked")} <SourceTime instant={result.observedAt} />
            </p>
          ) : null}
        </section>
      ) : null}
    </RequestRow>
  );
}
/**
 * WP-2423: what the refund wizard shows. Once a request is recorded its confirmation (amount,
 * checkbox and record button) is gone: the success message and the reread request list remain,
 * the selection is cleared and locked, and staff start another request explicitly.
 */
export function refundWizardSections(
  state: "Idle" | "Busy" | "Unknown" | "Recorded",
  hasPreview: boolean,
  requestable: boolean,
  /** WP-2423 item 6: a send whose result is unconfirmed is retried before anything else. */
  sendUnconfirmed = false,
): { readonly confirmation: boolean; readonly startAnother: boolean } {
  return {
    confirmation: hasPreview && state !== "Recorded",
    startAnother: requestable && state === "Recorded" && !sendUnconfirmed,
  };
}
/**
 * What "Refund everything" fills: every refundable quantity. A card-machine payment is refunded on
 * its machine, one payment at a time, so when the order's items cannot go on one refund it fills
 * this payment's items only (`limited`) instead of a selection the review would refuse.
 */
export function refundEverythingQuantities(
  items: Items["items"],
  paymentIntentReference: string,
): { readonly quantities: Readonly<Record<string, number>>; readonly limited: boolean } {
  const refundable = items.filter(
    (item) => item.paymentCaptured && !item.refundedByCancellation && item.unclaimedQuantity > 0,
  );
  const limited =
    refundable.some((item) => item.paymentMethod === "CardMachine") &&
    new Set(refundable.map((item) => item.paymentIntentReference)).size > 1;
  const chosen = limited
    ? refundable.filter((item) => item.paymentIntentReference === paymentIntentReference)
    : refundable;
  return {
    quantities: Object.fromEntries(
      chosen.map((item) => [item.orderItemReference, item.unclaimedQuantity]),
    ),
    limited,
  };
}
/** A quantity with − and + big enough for a finger, around a real input that can be typed in. */
function QuantityStepper({
  id,
  itemLabel,
  value,
  max,
  onChange,
}: {
  readonly id: string;
  readonly itemLabel: string;
  readonly value: number;
  readonly max: number;
  readonly onChange: (quantity: number) => void;
}) {
  return (
    <div className="refund-stepper">
      <button
        type="button"
        aria-label={t("One less of {item}", { item: itemLabel })}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(event) => {
          const quantity = Number(event.target.value);
          if (Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= max)
            onChange(quantity);
        }}
      />
      <button
        type="button"
        aria-label={t("One more of {item}", { item: itemLabel })}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}
/**
 * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): "stop making it too" is Yes by default only
 * when the dish is known not to be made yet. Started, or not known (the kitchen could not be
 * read), leaves it unticked: staff tick it themselves after checking with the kitchen.
 */
export const stopMakingByDefault = (kitchen: RefundItem["kitchen"]) => kitchen === "NotStarted";
function RefundWizard({
  orderReference,
  paymentIntentReference,
  csrf,
  onFinancialChange,
  blockedMessage = null,
  canSend = true,
}: {
  readonly orderReference: string;
  /** The payment this page is for: what "Refund everything" means when items can't be mixed. */
  readonly paymentIntentReference: string;
  readonly csrf: string;
  readonly onFinancialChange: () => void;
  /** WP-2423 Q5: why no new request can be recorded here (history stays visible). */
  readonly blockedMessage?: ReactNode;
  /**
   * WP-2423 M14: they send what they request. A cashier's request is recorded with its reason and
   * a manager or the owner sends it from Approvals.
   */
  readonly canSend?: boolean;
}) {
  const [items, setItems] = useState<Items | null>(null),
    [quantities, setQuantities] = useState<Record<string, number>>({}),
    // WP-2423 M10: per dish, staff's answer to "stop making it too?" (absent: the default).
    [stopMaking, setStopMaking] = useState<Record<string, boolean>>({}),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [approvals, setApprovals] = useState<ReadonlyMap<string, RefundApprovalEntry>>(new Map()),
    [verifiedUntil, setVerifiedUntil] = useState<string | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    // WP-2423 M10: the previewed request asks the kitchen to stop making some dishes.
    [previewStops, setPreviewStops] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState(""),
    // WP-2423: the request was refused on an unconfirmed PIN sign-in (retry the same one after).
    [signIn, setSignIn] = useState(false),
    [state, setState] = useState<"Idle" | "Busy" | "Unknown" | "Recorded">("Idle");
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  // Staff refreshed the whole list: every open request rereads its status too.
  const [refreshSignal, setRefreshSignal] = useState(0);
  // WP-2423 item 6: one confirmation records, prepares and sends a refund needing no approval.
  // The run keeps every step's references, so a retry resumes where it stopped.
  const run = useRef<RefundRun<Submitted> | null>(null),
    [runStep, setRunStep] = useState<RefundRunStep | null>(null),
    [runFailure, setRunFailure] = useState<RefundRunError | null>(null),
    // The recorded request the stopped run is still sending (its list entry points back here).
    [heldRequest, setHeldRequest] = useState<string | null>(null);
  const operationReference = useRef<string | null>(null);
  // WP-2423 Q5: one preview identity while the selection, reason and note stay the same.
  const previewIdentity = useRef<{
    key: string;
    requestReference: string;
    operationReference: string;
  } | null>(null);
  const operation = useRef<Intent | null>(null),
    pending = useRef<AbortController | null>(null),
    status = useRef<HTMLParagraphElement>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (message) status.current?.focus();
  }, [message]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    if (state === "Unknown" || state === "Busy" || runFailure !== null)
      window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state, runFailure]);
  const locked = state !== "Idle" || preparing.size > 0;
  // WP-2423 item 4: the calculated refund is of a card-machine payment (refunded on the machine).
  const previewOnMachine =
    items?.items.some(
      (item) =>
        (quantities[item.orderItemReference] ?? 0) > 0 && item.paymentMethod === "CardMachine",
    ) === true;
  // WP-2423 Q5: someone who cannot record a new request here only follows recorded ones.
  const requestable = blockedMessage === null && items?.canRequest !== false;
  const sendUnconfirmed =
    runFailure !== null && refundRunUncertain(runFailure) && run.current?.mayHaveSent === true;
  const sections = refundWizardSections(state, preview !== null, requestable, sendUnconfirmed);
  // WP-2423 item 6: an online refund that needs no approval is sent on the same confirmation.
  const sendsNow = preview !== null && !previewOnMachine && preview.approvalRequired !== true;
  const verificationCurrent = () =>
    verifiedUntil !== null && Date.parse(verifiedUntil) > Date.now();
  const clearPreview = () => {
    setSignIn(false);
    setPreview(null);
    setConfirmed(false);
    operation.current = null;
    operationReference.current = null;
    // A new calculation is a new request: an unstarted or refused run is not resumed.
    run.current = null;
  };
  // WP-2423: a recorded request leaves nothing selected or confirmed behind it.
  const clearRequestForm = () => {
    clearPreview();
    setQuantities({});
    setReason("");
    setNote("");
  };
  const startAnother = () => {
    if (state !== "Recorded" || pending.current || sendUnconfirmed) return;
    run.current = null;
    setRunFailure(null);
    setHeldRequest(null);
    clearRequestForm();
    previewIdentity.current = null;
    setMessage("");
    setState("Idle");
  };
  const load = async () => {
    if (pending.current || preparing.size > 0 || state === "Busy") return;
    const wasUnknown = state === "Unknown";
    const wasRecorded = state === "Recorded";
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    if (!wasUnknown && !wasRecorded) clearPreview();
    try {
      const result = await client.items(orderReference, csrf, controller.signal);
      // WP-2423 Q5: which recorded requests wait for an owner's approval (best effort).
      const pendingApprovals = await approvalClient
        .approvals(controller.signal)
        .then(
          (view) =>
            new Map(
              view.entries
                .filter((value) => value.orderReference === orderReference)
                .map((value) => [value.requestReference, value] as const),
            ),
        )
        .catch(() => new Map<string, RefundApprovalEntry>());
      if (!controller.signal.aborted) {
        setApprovals(pendingApprovals);
        setItems(result);
        setRefreshSignal((value) => value + 1);
        if (wasUnknown) {
          const recovered = result.recentRequests.find(
            (entry) => entry.operationReference === operationReference.current,
          );
          if (recovered) {
            previewIdentity.current = null;
            run.current = null;
            clearRequestForm();
          }
          setState(recovered ? "Recorded" : "Unknown");
          setMessage(
            recovered
              ? t("The request was recorded. See above where it stands and what to do next.")
              : t(
                  "This request does not show in the records, so its result is still unknown. Retry the same request.",
                ),
          );
        } else if (wasRecorded) {
          setState("Recorded");
          onFinancialChange();
          setMessage(
            runFailure !== null
              ? refundRunFailureText(runFailure)
              : t("The request stays recorded. See above where it stands."),
          );
        } else {
          setQuantities({});
          setState("Idle");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(errorMessage(error));
        setState(wasUnknown ? "Unknown" : wasRecorded ? "Recorded" : "Idle");
      }
    } finally {
      // An aborted read may finish after the next one has started: only clear our own.
      if (pending.current === controller) pending.current = null;
    }
  };
  // WP-2423 item 4: after a write on a recorded request, reread the order's requests (and their
  // approvals) without touching the selection, calculation or status message being worked on.
  const requestsRefresh = useRef<AbortController | null>(null);
  useEffect(() => () => requestsRefresh.current?.abort(), []);
  const reloadRequests = async () => {
    requestsRefresh.current?.abort();
    const controller = new AbortController();
    requestsRefresh.current = controller;
    try {
      const result = await client.items(orderReference, csrf, controller.signal);
      const current = await approvalClient
        .approvals(controller.signal)
        .then(
          (view) =>
            new Map(
              view.entries
                .filter((value) => value.orderReference === orderReference)
                .map((value) => [value.requestReference, value] as const),
            ),
        )
        .catch(() => null);
      if (!controller.signal.aborted) {
        setItems(result);
        if (current !== null) setApprovals(current);
      }
    } catch {
      if (!controller.signal.aborted)
        setMessage(
          t("The refund was recorded, but this list could not be updated. Select Refresh."),
        );
    } finally {
      if (requestsRefresh.current === controller) requestsRefresh.current = null;
    }
  };
  // The refundable items and this order's requests are there as soon as the page opens. Under
  // React's development double run the abort above clears the first read, so the second starts.
  useEffect(() => {
    void load();
    // Once on open; refreshing later is staff's choice.
  }, []);
  const calculate = async () => {
    if (!items || locked || pending.current) return;
    const selection = items.items
      .filter((item) => (quantities[item.orderItemReference] ?? 0) > 0)
      .map((item) => ({
        orderBatchReference: item.orderBatchReference,
        orderItemReference: item.orderItemReference,
        quantity: quantities[item.orderItemReference] ?? 0,
      }));
    if (!selection.length) {
      setMessage(t("Choose at least one item to refund."));
      return;
    }
    // WP-2423 item 4: items paid on the store's card machine are refunded on that machine, one
    // payment at a time; they are never mixed with items paid online.
    const chosen = items.items.filter((item) => (quantities[item.orderItemReference] ?? 0) > 0);
    if (
      chosen.some((item) => item.paymentMethod === "CardMachine") &&
      new Set(chosen.map((item) => item.paymentIntentReference)).size > 1
    ) {
      setMessage(
        t(
          "Refund items paid on the card machine separately: choose only items from that one payment.",
        ),
      );
      return;
    }
    if (!refundReasonCodes.includes(reason as (typeof refundReasonCodes)[number])) {
      setMessage(t("Choose the reason for this refund."));
      return;
    }
    if (reason === "OTHER" && (note.trim() === "" || [...note.trim()].length > 200)) {
      setMessage(t("Explain the reason in a short note (up to 200 characters)."));
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    clearPreview();
    try {
      // WP-2423 M10: the units of each refunded dish the kitchen stops making (never more than
      // are left to make).
      const withdraw = chosen
        .filter((item) => stops(item))
        .map((item) => ({
          orderItemReference: item.orderItemReference,
          quantity: Math.min(
            quantities[item.orderItemReference] ?? 0,
            item.quantity - item.withdrawnQuantity,
          ),
        }))
        .filter((entry) => entry.quantity > 0);
      const key = JSON.stringify([items.claimVersion, selection, reason, note.trim(), withdraw]);
      if (previewIdentity.current?.key !== key)
        previewIdentity.current = {
          key,
          requestReference: serviceOperationReference(),
          operationReference: serviceOperationReference(),
        };
      operationReference.current = previewIdentity.current.operationReference;
      const intent = client.prepareRequest({
        orderReference,
        requestReference: previewIdentity.current.requestReference,
        operationReference: operationReference.current,
        expectedClaimVersion: items.claimVersion,
        reasonCode: reason,
        items: selection,
        ...(reason === "OTHER" ? { note: note.trim() } : {}),
        ...(withdraw.length > 0 ? { withdraw } : {}),
      });
      operation.current = intent;
      const result = await intent.preview(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setPreviewStops(withdraw.length > 0);
        setPreview(result);
        setState("Idle");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        clearPreview();
        setMessage(errorMessage(error));
        setState("Idle");
      }
    } finally {
      pending.current = null;
    }
  };
  const submit = async () => {
    const resuming = runFailure !== null;
    if (
      pending.current ||
      (!resuming &&
        (!operation.current ||
          !preview ||
          (!confirmed && state !== "Unknown") ||
          state === "Recorded" ||
          (preview.approvalRequired === true && state !== "Unknown" && !verificationCurrent())))
    )
      return;
    if (!run.current) {
      const intent = operation.current;
      if (!intent) return;
      run.current = createRefundRun<Submitted>({
        orderReference,
        newReference: serviceOperationReference,
        sendAfterRequest: !previewOnMachine && canSend,
        ports: refundRunPorts(orderReference, csrf, (signal) => intent.submit(csrf, signal)),
      });
    }
    const current = run.current;
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    setSignIn(false);
    setRunFailure(null);
    try {
      const outcome = await current.run(controller.signal, setRunStep);
      if (!controller.signal.aborted) {
        const result = outcome.request;
        run.current = null;
        setHeldRequest(null);
        previewIdentity.current = null;
        clearRequestForm();
        setState("Recorded");
        onFinancialChange();
        const recovered =
          result?.replayed === true
            ? t("This request was already recorded; nothing repeated. ")
            : "";
        const total = amount(result?.amountMinor ?? null);
        setMessage(
          recovered +
            (outcome.kind === "Refunded"
              ? t("Refunded {total} to the customer's original payment method.", { total })
              : outcome.kind === "WaitingForAnswer"
                ? t(
                    "Sent — waiting for the card provider's answer. {total} stays set aside until it answers; the request above shows the result.",
                    { total },
                  )
                : outcome.kind === "AwaitingApproval" && result?.approveAlone
                  ? t(
                      "Request recorded for {total}. Nothing is refunded yet. You run this business alone: open Approvals and approve it yourself after confirming it is you; it is sent once approved.",
                      { total },
                    )
                  : outcome.kind === "AwaitingApproval"
                    ? t(
                        "Request recorded for {total}. Nothing is refunded yet: it is sent once the owner approves it. Ask the owner to open Approvals on this device or theirs. If more than 15 minutes pass after your verification, you'll be asked to verify again here.",
                        { total },
                      )
                    : !canSend
                      ? t(
                          "Request recorded for {total}. Nothing is refunded yet: a manager or the owner sends it from Approvals.",
                          { total },
                        )
                      : t(
                          "Request recorded for {total}. Now refund it on the store's card machine and record it under the request above.",
                          { total },
                        )),
        );
        // The request appears in the list (and its units leave the selection) straight away.
        void reloadRequests();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const stopped =
          error instanceof RefundRunError ? error : new RefundRunError("Request", error);
        const cause = stopped.cause;
        if (stopped.step !== "Request") {
          // The request is recorded; the refund stopped on its way out. Say what happened and
          // let staff continue from the step reached (same references, nothing sent twice).
          previewIdentity.current = null;
          clearRequestForm();
          run.current = current;
          setState("Recorded");
          setRunFailure(stopped);
          setHeldRequest(current.requestReference);
          setSignIn(needsFullSignIn(cause));
          setMessage(refundRunFailureText(stopped));
          onFinancialChange();
          void reloadRequests();
        } else if (cause instanceof OrdinaryRefundClientError && cause.code === "OutcomeUnknown") {
          setState("Unknown");
          setMessage(
            t(
              "Request result unknown. Keep this page open and retry the same request; do not start another refund.",
            ),
          );
        } else if (needsFullSignIn(cause)) {
          // Keep the confirmed request: once verified, the same request is recorded once.
          setState("Idle");
          setSignIn(true);
        } else {
          run.current = null;
          setState("Idle");
          clearPreview();
          setMessage(errorMessage(cause));
        }
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setRunStep(null);
    }
  };
  const lines = items?.items ?? [];
  const offered = lines.filter((item) => item.paymentCaptured && !item.refundedByCancellation);
  const everything = refundEverythingQuantities(lines, paymentIntentReference);
  const anyChosen = Object.values(quantities).some((quantity) => quantity > 0);
  // Which way each dish was paid matters only when the order's items were paid differently.
  const mixedPayment = new Set(offered.map((item) => item.paymentMethod)).size > 1;
  const setQuantity = (reference: string, quantity: number) => {
    setQuantities((prior) => ({ ...prior, [reference]: quantity }));
    clearPreview();
  };
  // WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): "stop making it too" is offered to staff who
  // may take dishes off an order, Yes by default while the kitchen has not started the dish.
  const stopOffered = (item: RefundItem) =>
    items?.canWithdraw === true &&
    item.kitchen !== "Cancelled" &&
    item.withdrawnQuantity < item.quantity;
  const stops = (item: RefundItem) =>
    stopOffered(item) && (stopMaking[item.orderItemReference] ?? stopMakingByDefault(item.kitchen));
  // The items and requests load by themselves; rereading them is offered when it has a purpose:
  // a failed read, an unknown result, a recorded request, or a follower watching the list.
  const refresh =
    (items === null && state === "Busy") ||
    (state === "Idle" && items !== null && requestable && message === "") ? null : (
      <button
        type="button"
        className="refund-text"
        disabled={state === "Busy" || preparing.size > 0}
        aria-label={
          state === "Unknown" || items === null ? undefined : t("Refresh refund requests and items")
        }
        onClick={() => void load()}
      >
        {state === "Unknown"
          ? t("Check whether it was recorded")
          : items === null
            ? t("Try again")
            : t("Refresh")}
      </button>
    );
  const showRequests = items !== null && (items.recentRequests.length > 0 || !requestable);
  return (
    <section aria-label={t("Refund")} data-screen-id="PAY-REFUND-WIZARD" className="refund-wizard">
      {items !== null && showRequests ? (
        <section
          aria-label={t("Refunds on this order")}
          aria-busy={state === "Busy"}
          className="refund-requests"
        >
          <div className="refund-section-head">
            <h2>{requestable ? t("Refunds on this order") : t("Refund requests")}</h2>
            {refresh}
          </div>
          {items.recentRequests.length === 0 ? (
            <p>{t("No refund requests on this order yet.")}</p>
          ) : null}
          {items.claimVersion > items.recentRequests.length ? (
            <p className="refund-request__muted">
              {t("Showing the latest {shown} of {total}.", {
                shown: items.recentRequests.length,
                total: items.claimVersion,
              })}
            </p>
          ) : null}
          <ol>
            {items.recentRequests.map((entry) => (
              <li key={entry.requestReference} className="refund-request">
                {entry.decline !== null ? (
                  <RequestRow
                    entry={entry}
                    tone="quiet"
                    state={
                      entry.decline.declinedByYou
                        ? t("Declined by you")
                        : entry.decline.declinerName !== null
                          ? t("Declined by {name}", { name: entry.decline.declinerName })
                          : t("Declined by an owner")
                    }
                  >
                    <p className="refund-request__note">
                      {t("{reason}. Nothing was refunded; you can request again.", {
                        reason: declineReasonLabel[entry.decline.reasonCode] ?? t("Other reason"),
                      })}{" "}
                      <SourceTime instant={entry.decline.declinedAt} />
                    </p>
                  </RequestRow>
                ) : (
                  <RecordedRequestStatus
                    held={heldRequest === entry.requestReference}
                    approval={approvals.get(entry.requestReference) ?? null}
                    canSend={canSend}
                    onFinancialChange={onFinancialChange}
                    onRequestsChange={() => void reloadRequests()}
                    orderReference={orderReference}
                    entry={entry}
                    csrf={csrf}
                    refreshSignal={refreshSignal}
                    onPending={(paymentReference, active) =>
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        const key = entry.requestReference + ":" + paymentReference;
                        if (active) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {requestable && state !== "Recorded" ? (
        <div className="refund-section-head">
          <h2>{t("Request a refund")}</h2>
          {showRequests ? null : refresh}
        </div>
      ) : null}
      {!requestable ? (
        <div role="status" className="refund-blocked">
          {blockedMessage ?? (
            <p>
              {t(
                "Only a store manager records refund requests. You can follow these refunds here. To approve or decline one:",
              )}{" "}
              <Link to="/app/approvals">{t("Open Approvals")}</Link>
            </p>
          )}
        </div>
      ) : items !== null && state !== "Recorded" ? (
        <fieldset disabled={locked} className="refund-form">
          <legend>{t("What to refund")}</legend>
          {offered.some((item) => item.unclaimedQuantity > 0) ? (
            <div className="refund-form__quick">
              {anyChosen ? (
                <button
                  type="button"
                  className="refund-text"
                  onClick={() => {
                    setQuantities({});
                    clearPreview();
                  }}
                >
                  {t("Clear")}
                </button>
              ) : null}
              {Object.keys(everything.quantities).length > 0 ? (
                <button
                  type="button"
                  className="refund-text"
                  onClick={() => {
                    setQuantities({ ...everything.quantities });
                    clearPreview();
                  }}
                >
                  {t("Refund everything")}
                </button>
              ) : null}
            </div>
          ) : null}
          {everything.limited ? (
            <p className="refund-form__hint">
              {t(
                "Refund everything fills this payment's items only. Items paid another way are refunded from their own payment page.",
              )}
            </p>
          ) : null}
          {lines.length === 0 ? <p>{t("This order has no items to refund.")}</p> : null}
          {offered.length > 0 ? (
            <ul className="refund-lines">
              {lines.map((item, index) => {
                // WP-2423 Q5: a line that was never charged (e.g. a round cancelled before
                // payment) cannot be refunded; it is summarized below instead of offered. A round
                // the store cancelled was refunded whole by that cancellation; listed below too.
                if (!item.paymentCaptured || item.refundedByCancellation) return null;
                const same = offered.filter((other) => other.label === item.label);
                const inputId = "refund-quantity-" + index;
                return (
                  <li key={item.orderItemReference} className="refund-line">
                    <label htmlFor={inputId} className="refund-line__label">
                      <span className="refund-line__name">
                        {item.label}
                        {same.length > 1 ? (
                          // Identical lines stay separate; only a screen reader needs them told apart.
                          <span className="visually-hidden">
                            {" "}
                            {t("({position} of {count})", {
                              position: same.indexOf(item) + 1,
                              count: same.length,
                            })}
                          </span>
                        ) : null}
                      </span>
                      {item.unclaimedQuantity > 0 && item.quantity > 1 ? (
                        <span className="refund-line__meta">
                          {t("{left} of {total} left to refund", {
                            left: item.unclaimedQuantity,
                            total: item.quantity,
                          })}
                        </span>
                      ) : null}
                      {mixedPayment && item.paymentMethod === "CardMachine" ? (
                        <span className="refund-line__meta">{t("Paid on card machine")}</span>
                      ) : null}
                    </label>
                    {(quantities[item.orderItemReference] ?? 0) > 0 && stopOffered(item) ? (
                      // WP-2423 M10: the kitchen and the counter follow the refund.
                      <label className="refund-line__stop">
                        <input
                          type="checkbox"
                          checked={stops(item)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setStopMaking((prior) => ({
                              ...prior,
                              [item.orderItemReference]: checked,
                            }));
                            clearPreview();
                          }}
                        />{" "}
                        {t("Stop making it too")}
                        <span className="refund-line__meta">
                          {stops(item)
                            ? t("The kitchen and the counter leave it out.")
                            : item.kitchen === "Started"
                              ? t("Already being made: the guest keeps the food.")
                              : item.kitchen === null
                                ? t(
                                    "The kitchen's progress couldn't be read. Check with the kitchen; unticked, the guest keeps the food.",
                                  )
                                : t("The guest keeps the food.")}
                        </span>
                      </label>
                    ) : null}
                    {item.withdrawnQuantity > 0 ? (
                      <span className="refund-line__meta">
                        {t("{count} not made, refunded", { count: item.withdrawnQuantity })}
                      </span>
                    ) : null}
                    {item.unclaimedQuantity === 0 ? (
                      <span className="refund-line__meta">{t("Already in a refund")}</span>
                    ) : (
                      <QuantityStepper
                        id={inputId}
                        itemLabel={item.label}
                        value={quantities[item.orderItemReference] ?? 0}
                        max={item.unclaimedQuantity}
                        onChange={(quantity) => setQuantity(item.orderItemReference, quantity)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {lines.some((item) => !item.paymentCaptured) ? (
            <p className="refund-form__hint">
              {t("Not charged, so not refundable: {items}.", {
                items: lines
                  .filter((item) => !item.paymentCaptured)
                  .map((item) => item.label)
                  .join(", "),
              })}
            </p>
          ) : null}
          {lines.some((item) => item.refundedByCancellation) ? (
            <p className="refund-form__hint">
              {t("Already refunded in full when the round was cancelled: {items}.", {
                items: lines
                  .filter((item) => item.refundedByCancellation)
                  .map((item) => item.label)
                  .join(", "),
              })}
            </p>
          ) : null}
          {canSend ? null : (
            // WP-2423 M14: a cashier asks; a manager or the owner sends the refund.
            <p className="refund-form__hint">{t("A manager or the owner sends it.")}</p>
          )}
          <div className="refund-form__field">
            <label htmlFor="refund-reason">{t("Reason")}</label>
            <select
              id="refund-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                clearPreview();
              }}
            >
              <option value="">{t("Select a reason")}</option>
              {refundReasonCodes.map((code) => (
                <option key={code} value={code}>
                  {refundReasonLabel[code]}
                </option>
              ))}
            </select>
          </div>
          {reason === "OTHER" ? (
            <div className="refund-form__field">
              <label htmlFor="refund-note">
                {t("Note for the approver (required, up to 200 characters)")}
              </label>
              <textarea
                id="refund-note"
                maxLength={200}
                required
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  clearPreview();
                }}
              />
              <p className="refund-form__hint">
                {t("Describe what happened. Do not include card numbers or health details.")}
              </p>
            </div>
          ) : null}
          <button
            type="button"
            className={
              preview && sections.confirmation
                ? "refund-text refund-review"
                : "refund-primary refund-review"
            }
            disabled={!items}
            onClick={() => void calculate()}
          >
            {t("Review refund")}
          </button>
        </fieldset>
      ) : null}
      {preview && sections.confirmation ? (
        <section aria-labelledby="refund-review-heading" className="refund-review-panel">
          <h3 id="refund-review-heading">{t("Review this refund")}</h3>
          <dl className="refund-amounts">
            {(
              [
                [t("Items"), "netAmountMinor"],
                [t("Tax"), "taxAmountMinor"],
                [t("Tip"), "tipAmountMinor"],
                [t("Service charge"), "serviceChargeAmountMinor"],
                [t("Service charge tax"), "serviceChargeTaxAmountMinor"],
              ] as const
            )
              // Only what this refund includes; the total is always the server's.
              .filter(
                ([, key]) => key === "netAmountMinor" || (preview.components[key] ?? "0") !== "0",
              )
              .map(([label, key]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{amount(preview.components[key] ?? null)}</dd>
                </div>
              ))}
            <div className="refund-amounts__total">
              <dt>{t("Total")}</dt>
              <dd>{amount(preview.amountMinor)}</dd>
            </div>
          </dl>
          {previewOnMachine ? (
            <p>
              {preview.approvalRequired === true
                ? t(
                    "Paid on the store's card machine. After the request is recorded and approved, refund this amount on that machine and record it under the request.",
                  )
                : t(
                    "Paid on the store's card machine. After the request is recorded, refund this amount on that machine and record it under the request.",
                  )}
            </p>
          ) : sendsNow ? (
            <p>
              {t(
                "Refunded to the customer's original payment method as soon as you confirm. The card provider's answer is shown here.",
              )}
              {preview.paymentAttemptReferences.length > 1
                ? " " +
                  t("This refund covers {payments} of this order.", {
                    payments: countOf(preview.paymentAttemptReferences.length, "payment"),
                  })
                : ""}
            </p>
          ) : (
            <p>
              {t("Recording this request does not refund anything yet: it is sent once approved.")}
            </p>
          )}
          {preview.approvalRequired === true && previewStops ? (
            // WP-2423 M10: the kitchen and the counter change only with a refund nobody can
            // decline any more; the server refuses this combination too.
            <p className="refund-withdraw-approval" role="alert">
              {t(
                "This refund needs the owner's approval, so the kitchen isn't told now. Untick Stop making it too to ask for approval; for a dish the kitchen hasn't started, use Cancel items on the order.",
              )}
            </p>
          ) : null}
          {preview.approvalRequired === true ? (
            <section aria-label={t("Owner approval needed")} className="refund-escalation">
              <h4>{t("Needs owner approval")}</h4>
              <ul>
                {preview.escalationReasons.map((code) => (
                  <li key={code}>{escalationReasonLabel[code]}</li>
                ))}
              </ul>
              <p>
                {preview.approveAlone
                  ? t(
                      "You run this business alone, so you can approve this refund yourself on the Approvals page after confirming it is you. First confirm it is you; your verification lasts 15 minutes.",
                    )
                  : t(
                      "An owner or finance member who is not you must approve this refund in person. First confirm it is you; your verification lasts 15 minutes.",
                    )}
              </p>
              <StepUpVerification
                purpose="RefundRequest"
                csrf={csrf}
                verifiedUntil={verifiedUntil}
                onVerified={setVerifiedUntil}
                label={t("Verify with your authenticator")}
              />
            </section>
          ) : null}
          <label className="refund-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {sendsNow
                ? t("I confirm the selected quantities, reason and {amount} refund.", {
                    amount: amount(preview.amountMinor),
                  })
                : t("I confirm the selected quantities, reason and {amount} request.", {
                    amount: amount(preview.amountMinor),
                  })}
            </span>
          </label>
          <button
            type="button"
            className="refund-primary"
            disabled={
              !confirmed ||
              locked ||
              (preview.approvalRequired === true && (previewStops || !verificationCurrent()))
            }
            onClick={() => void submit()}
          >
            {preview.approvalRequired === true
              ? t("Record request for owner approval")
              : sendsNow
                ? t("Send {amount} refund", { amount: amount(preview.amountMinor) })
                : t("Record refund request")}
          </button>
        </section>
      ) : null}
      <p ref={status} tabIndex={-1} role="status" className="refund-status">
        {state === "Busy"
          ? runStep
            ? refundRunProgressText(runStep)
            : items === null
              ? t("Loading…")
              : t("Working…")
          : message}
      </p>
      {state === "Unknown" ? (
        <button type="button" className="refund-primary" onClick={() => void submit()}>
          {refundRunRetryLabel("Request")}
        </button>
      ) : null}
      {runFailure !== null && state === "Recorded" ? (
        <button type="button" className="refund-primary" onClick={() => void submit()}>
          {refundRunRetryLabel(runFailure.step)}
        </button>
      ) : null}
      {signIn && state !== "Busy" ? <FullSignInPrompt csrf={csrf} /> : null}
      {requestable && state === "Recorded" && !showRequests ? refresh : null}
      {sections.startAnother ? (
        <button
          type="button"
          className="refund-text refund-another"
          disabled={preparing.size > 0}
          onClick={startAnother}
        >
          {t("Start another refund request")}
        </button>
      ) : null}
    </section>
  );
}
/** What the payment summary shows: the amounts last read, whether a reread runs, and its result. */
export interface FinancialSummaryState {
  readonly context: Context | null;
  readonly busy: boolean;
  readonly message: string;
}
/**
 * WP-2423: one step of the payment summary. While amounts are reread (after a refund is recorded
 * or on request) the last amounts stay on screen with a calm "updating" note; they are withdrawn
 * only when the reread actually fails, and the refresh button then retries.
 */
export function nextFinancialSummary(
  state: FinancialSummaryState,
  event:
    | { readonly kind: "Rereading" }
    | { readonly kind: "Read"; readonly context: Context }
    | { readonly kind: "Failed"; readonly message: string },
): FinancialSummaryState {
  if (event.kind === "Rereading")
    return { context: state.context, busy: true, message: t("Updating payment amounts…") };
  if (event.kind === "Read") return { context: event.context, busy: false, message: "" };
  return { context: null, busy: false, message: event.message };
}
export function PaymentFinancialSummary({
  initial,
  csrf,
  revision,
  onContext,
}: {
  initial: Context;
  csrf: string;
  revision: number;
  /** The reread payment, so what the page offers next follows the current amounts. */
  onContext: (context: Context) => void;
}) {
  const [{ context, busy, message }, setSummary] = useState<FinancialSummaryState>({
    context: initial,
    busy: false,
    message: "",
  });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (revision === 0 && refresh === 0) return;
    const controller = new AbortController();
    setSummary((state) => nextFinancialSummary(state, { kind: "Rereading" }));
    void client
      .context(initial.paymentIntentReference, csrf, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSummary((state) => nextFinancialSummary(state, { kind: "Read", context: value }));
          onContext(value);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setSummary((state) =>
            nextFinancialSummary(state, { kind: "Failed", message: errorMessage(error) }),
          );
      });
    return () => controller.abort();
    // onContext is the page's state setter (stable); a new initial value never rereads.
  }, [initial.paymentIntentReference, csrf, revision, refresh]);
  return (
    <>
      {context ? (
        <section
          aria-labelledby="payment-summary-heading"
          aria-busy={busy}
          data-screen-id="PAY-PAYMENT-DETAIL"
          className="refund-summary"
        >
          <h2 id="payment-summary-heading" className="visually-hidden">
            {t("Payment summary")}
          </h2>
          <dl>
            <div>
              <dt>{t("State")}</dt>
              <dd>{paymentStateLabel(context)}</dd>
            </div>
            <div>
              <dt>{t("Paid")}</dt>
              <dd>{amount(context.capturedAmountMinor)}</dd>
            </div>
            <div>
              <dt>{t("Refunded")}</dt>
              <dd>{amount(context.confirmedRefundMinor)}</dd>
            </div>
            <div>
              <dt>{t("Being refunded")}</dt>
              <dd>{amount(context.pendingRefundMinor)}</dd>
            </div>
          </dl>
          {context.paymentMethod === "CardMachine" ? (
            <p className="refund-summary__note">
              {t(
                "Paid on the store's card machine. Its refunds are made on that machine and recorded here; they count on the day they are made.",
              )}
            </p>
          ) : null}
        </section>
      ) : (
        <p>{t("Payment amounts could not be shown. Refresh to try again.")}</p>
      )}
      <div className="refund-summary__foot">
        <p role="status">
          {message ||
            (context ? (
              <>
                {t("Last checked")} <SourceTime instant={context.observedAt} />
              </>
            ) : null)}
        </p>
        <button
          type="button"
          className="refund-text"
          disabled={busy}
          aria-label={t("Refresh payment amounts")}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t("Refresh")}
        </button>
      </div>
    </>
  );
}
type RequestEntry = Items["recentRequests"][number];
type RequestStatus = Awaited<ReturnType<typeof client.status>>;
/** One recorded request of this payment still to be refunded on the store's card machine. */
export interface CardMachineRefundToRecord {
  readonly entry: RequestEntry;
  readonly amountMinor: string;
  readonly approval: RefundApprovalEntry | null;
}
/** Recorded, not declined card-machine requests that may still be owed (status decides). */
export function cardMachineRequestsToCheck(items: Items): readonly RequestEntry[] {
  return items.recentRequests.filter(
    (entry) =>
      entry.paymentMethod === "CardMachine" &&
      entry.decline === null &&
      entry.progress !== "Refunded",
  );
}
/**
 * WP-2423 item 4 (v15 2026-10-17): a request is to be recorded on this payment's page when the
 * server's status names this payment, taken on the card machine, and no machine refund is recorded
 * for it yet. Requests of other payments of the same order are left to their own payment page.
 */
export function cardMachineRefundToRecord(
  paymentIntentReference: string,
  entry: RequestEntry,
  status: RequestStatus,
  approval: RefundApprovalEntry | null,
): CardMachineRefundToRecord | null {
  if (status.requestReference !== entry.requestReference) return null;
  const payment = status.payments.find(
    (value) =>
      value.method === "CardMachine" && value.paymentIntentReference === paymentIntentReference,
  );
  if (payment === undefined || payment.state === "Confirmed") return null;
  return { entry, amountMinor: payment.amountMinor, approval };
}
/**
 * WP-2423 item 4 (v15 2026-10-17): on the payment page itself, each recorded refund of this
 * card-machine payment that is still to be made on the machine, with its record action. Staff who
 * just refunded on the machine record it here without opening the refund wizard. The server
 * decides who may record (refund handlers); someone who may not read refunds sees nothing here.
 */
export function PendingCardMachineRefunds({
  context,
  csrf,
  onFinancialChange,
}: {
  readonly context: Context;
  readonly csrf: string;
  readonly onFinancialChange: () => void;
}) {
  const pendingMinor = context.pendingRefundMinor ?? "0";
  const owed = context.paymentMethod === "CardMachine" && BigInt(pendingMinor) > 0n;
  const [refunds, setRefunds] = useState<readonly CardMachineRefundToRecord[] | null>(null);
  const [message, setMessage] = useState("");
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // The confirmation of the last recorded refund stays while the amounts are reread.
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!owed) {
      setRefunds([]);
      return;
    }
    const controller = new AbortController();
    setMessage("");
    void (async () => {
      try {
        const items = await client.items(context.orderReference, csrf, controller.signal);
        const candidates = cardMachineRequestsToCheck(items);
        const approvals =
          candidates.length === 0
            ? new Map<string, RefundApprovalEntry>()
            : await approvalClient
                .approvals(controller.signal)
                .then(
                  (view) =>
                    new Map(
                      view.entries
                        .filter((value) => value.orderReference === context.orderReference)
                        .map((value) => [value.requestReference, value] as const),
                    ),
                )
                .catch(() => new Map<string, RefundApprovalEntry>());
        const found: CardMachineRefundToRecord[] = [];
        // One request at a time: each status read is small and the list stays short.
        for (const entry of candidates) {
          const status = await client.status(
            context.orderReference,
            entry.operationReference,
            csrf,
            controller.signal,
          );
          const refund = cardMachineRefundToRecord(
            context.paymentIntentReference,
            entry,
            status,
            approvals.get(entry.requestReference) ?? null,
          );
          if (refund !== null) found.push(refund);
        }
        if (!controller.signal.aborted) {
          setHidden(false);
          setRefunds(found);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof OrdinaryRefundClientError && error.code === "Denied") setHidden(true);
        else setMessage(errorMessage(error));
      }
    })();
    return () => controller.abort();
  }, [owed, context.orderReference, context.paymentIntentReference, pendingMinor, csrf, reload]);
  if (hidden || (notice === null && message === "" && (refunds === null || refunds.length === 0)))
    return null;
  return (
    <section
      aria-labelledby="card-machine-refunds-heading"
      className="card-machine-refunds-to-record refund-requests"
    >
      <h2 id="card-machine-refunds-heading">{t("Refunds to make on the card machine")}</h2>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {message !== "" ? (
        <div role="status">
          <p>{message}</p>
          <button
            type="button"
            className="refund-text"
            onClick={() => setReload((value) => value + 1)}
          >
            {t("Try again")}
          </button>
        </div>
      ) : null}
      {refunds !== null && refunds.length > 0 ? (
        <ul>
          {refunds.map(({ entry, amountMinor, approval }) => (
            <li key={entry.requestReference} className="refund-request">
              <RequestRow
                entry={entry}
                amountMinor={amountMinor}
                tone={requestTone(entry, approval?.state ?? null)}
                state={requestProgressLabel(
                  entry.progress,
                  entry.paymentMethod,
                  approval?.state ?? null,
                )}
              >
                {approval?.state === "AwaitingApproval" ? (
                  <p>
                    <Link to="/app/approvals">{t("Open Approvals")}</Link>
                  </p>
                ) : open === entry.requestReference ? (
                  <CardMachineRequestRefund
                    orderReference={context.orderReference}
                    requestReference={entry.requestReference}
                    amountMinor={amountMinor}
                    amountLabel={amount(amountMinor)}
                    csrf={csrf}
                    onRecorded={(confirmation) => {
                      setNotice(confirmation);
                      setOpen(null);
                      // The payment amounts and this list are reread from the server.
                      onFinancialChange();
                      setReload((value) => value + 1);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="refund-text"
                    onClick={() => {
                      setNotice(null);
                      setOpen(entry.requestReference);
                    }}
                  >
                    {t("Record the {amount} card-machine refund", { amount: amount(amountMinor) })}
                  </button>
                )}
              </RequestRow>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
function PaymentContent({
  paymentIntentReference,
  csrf,
  storeLabel,
  wizard,
}: {
  readonly paymentIntentReference: string;
  readonly csrf: string;
  readonly storeLabel: string;
  readonly wizard: boolean;
}) {
  const [financialRevision, setFinancialRevision] = useState(0);
  const refreshFinancial = useCallback(() => setFinancialRevision((value) => value + 1), []);
  const [context, setContext] = useState<Context | null>(null),
    [loading, setLoading] = useState(true),
    [failure, setFailure] = useState<PaymentLoadFailure>({ message: "", retry: true }),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setLoading(true);
    setFailure({ message: "", retry: true });
    void client
      .context(paymentIntentReference, csrf, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setContext(result);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setFailure(paymentLoadFailure(error));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [paymentIntentReference, csrf, refresh]);
  return (
    <WorkspacePage
      className="refund-page"
      title={wizard ? t("Refund") : t("Payment")}
      meta={storeLabel}
      back={
        context ? (
          <Link to={"/operations/orders/" + context.orderReference}>
            <span aria-hidden="true">←</span> {t("Back to order")}
          </Link>
        ) : null
      }
    >
      {!context ? (
        <>
          <p role="status" className="refund-status">
            {loading ? t("Loading payment…") : failure.message}
          </p>
          {loading || !failure.retry ? null : (
            <button
              type="button"
              className="refund-text"
              onClick={() => setRefresh((value) => value + 1)}
            >
              {t("Refresh payment")}
            </button>
          )}
        </>
      ) : (
        <>
          <PaymentFinancialSummary
            initial={context}
            csrf={csrf}
            revision={financialRevision}
            onContext={setContext}
          />
          {!wizard ? (
            <PendingCardMachineRefunds
              context={context}
              csrf={csrf}
              onFinancialChange={refreshFinancial}
            />
          ) : null}
          {!wizard ? (
            <MoneyTakenBack context={context} csrf={csrf} onRecorded={refreshFinancial} />
          ) : null}
          {context.paymentState !== "Captured" ? (
            <p>{t("A refund can be requested once this payment is paid.")}</p>
          ) : !wizard && context.canRequest && refundableMinor(context) > 0n ? (
            <p className="refund-start">
              <Link
                className={
                  BigInt(context.pendingRefundMinor ?? "0") > 0n ? "refund-text" : "refund-primary"
                }
                to={"/app/operations/payments/" + paymentIntentReference + "/refund"}
              >
                {t("Start a refund")}
              </Link>
            </p>
          ) : (
            <RefundWizard
              onFinancialChange={refreshFinancial}
              key={context.orderReference}
              orderReference={context.orderReference}
              paymentIntentReference={paymentIntentReference}
              csrf={csrf}
              blockedMessage={requestBlockedMessage(context)}
              canSend={context.canSend}
            />
          )}
        </>
      )}
    </WorkspacePage>
  );
}
/** What staff are told when the payment can't be shown, and whether reading again can help. */
export interface PaymentLoadFailure {
  readonly message: string;
  readonly retry: boolean;
}

/**
 * M126 I.5: another Store's payment, or a role that can't refund, is said in plain words with no
 * Refresh (reading again changes nothing); only a read that couldn't answer offers it.
 */
export function paymentLoadFailure(error: unknown): PaymentLoadFailure {
  if (error instanceof OrdinaryRefundClientError && error.code === "NotFound")
    return {
      message: t("This payment belongs to another store. Switch to that store to refund it."),
      retry: false,
    };
  if (error instanceof OrdinaryRefundClientError && error.code === "Denied")
    return {
      message: t("Your role can't refund payments. Ask the owner or a manager."),
      retry: false,
    };
  return { message: errorMessage(error), retry: true };
}
const recoveryReasons = [
  ["REFUNDED_TOO_MUCH", () => t("Refunded too much")],
  ["WRONG_ITEM_REFUNDED", () => t("The wrong item was refunded")],
  ["OTHER", () => t("Other")],
] as const;
/**
 * WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5): staff refunded too much by mistake and the
 * guest gives the money back. A Store Manager or the Owner records it on the order, in their name,
 * on today's business day; the refund stays as it was. Lists what was already taken back.
 */
/**
 * WP-2423 M163: what staff are told when money taken back was not confirmed as recorded, and
 * whether that attempt is answered (a new Record starts a new one). Only an unknown result keeps
 * the attempt, so pressing Record again can never record it twice; an attempt already recorded
 * with other details says so plainly instead of asking for the same Record forever.
 */
export function moneyTakenBackFailure(error: unknown): {
  readonly message: string;
  readonly attemptAnswered: boolean;
  readonly reread: boolean;
} {
  const code = error instanceof OrdinaryRefundClientError ? error.code : null;
  if (code === "RecoveryAboveRefunded")
    return {
      message: t("That is more than was refunded on this order. Nothing was recorded."),
      attemptAnswered: true,
      reread: false,
    };
  if (code === "RecoveryConflict")
    return {
      message: t(
        "This was already recorded with other details, shown in the list. Nothing more was recorded. Check the list before recording again.",
      ),
      attemptAnswered: true,
      reread: true,
    };
  if (code === "Denied")
    return {
      message: t("Only a store manager or the owner records money taken back."),
      attemptAnswered: true,
      reread: false,
    };
  return {
    message: t("Couldn't confirm it was recorded. Press Record again: it is never recorded twice."),
    attemptAnswered: false,
    reread: false,
  };
}
export function MoneyTakenBack({
  context,
  csrf,
  onRecorded,
}: {
  readonly context: Context;
  readonly csrf: string;
  readonly onRecorded: () => void;
}) {
  const [open, setOpen] = useState(false),
    [method, setMethod] = useState<"Cash" | "CardMachine">("Cash"),
    [dollars, setDollars] = useState(""),
    [reason, setReason] = useState<(typeof recoveryReasons)[number][0]>("REFUNDED_TOO_MUCH"),
    [slip, setSlip] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  // One record per attempt: a retry after an unknown result reuses it.
  const operation = useRef<string | null>(null);
  const refunded = BigInt(context.confirmedRefundMinor ?? "0");
  const taken = context.recoveries.reduce((sum, entry) => sum + BigInt(entry.amountMinor), 0n);
  const left = refunded - taken;
  if (context.recoveries.length === 0 && (!context.canRecover || left <= 0n)) return null;
  const submit = async () => {
    const amountMinor = dollarsToMinor(dollars);
    if (amountMinor === null || BigInt(amountMinor) <= 0n) {
      setMessage(t("Enter the amount taken back, for example 5.00."));
      return;
    }
    if (BigInt(amountMinor) > left) {
      setMessage(
        t("That is more than was refunded on this order ({amount}).", {
          amount: amount(left.toString()),
        }),
      );
      return;
    }
    if (method === "CardMachine" && slip.trim() === "") {
      setMessage(t("Enter the card machine slip's reference."));
      return;
    }
    if (!confirmed) {
      setMessage(t("Confirm that this adds a record and the refund stays as it was."));
      return;
    }
    operation.current ??= serviceOperationReference();
    setBusy(true);
    setMessage("");
    try {
      await client.recover(
        {
          orderReference: context.orderReference,
          operationReference: operation.current,
          method,
          amountMinor,
          reasonCode: reason,
          ...(method === "CardMachine" ? { slipReference: slip.trim() } : {}),
        },
        csrf,
      );
      operation.current = null;
      setOpen(false);
      setDollars("");
      setSlip("");
      setConfirmed(false);
      setMessage(t("Recorded: {amount} taken back.", { amount: amount(amountMinor) }));
      onRecorded();
    } catch (error) {
      const failure = moneyTakenBackFailure(error);
      setMessage(failure.message);
      // The attempt is answered (refused, or recorded earlier with other details): the next
      // Record is a new one. The list is read again so what was recorded is in front of staff.
      if (failure.attemptAnswered) operation.current = null;
      if (failure.reread) onRecorded();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="money-taken-back-heading" className="refund-requests">
      <h2 id="money-taken-back-heading">{t("Money taken back")}</h2>
      {context.recoveries.length > 0 ? (
        <ul>
          {context.recoveries.map((entry) => (
            <li key={entry.recoveryReference} className="refund-request">
              {t("Money taken back +{amount} · {method} · {name}", {
                amount: amount(entry.amountMinor),
                method: entry.method === "Cash" ? t("Cash") : t("Card machine"),
                name: entry.recordedByName ?? t("someone no longer on staff"),
              })}{" "}
              · <SourceTime instant={entry.recordedAt} />
            </li>
          ))}
        </ul>
      ) : null}
      {message !== "" ? <p role="status">{message}</p> : null}
      {!context.canRecover || left <= 0n ? null : !open ? (
        <p>
          <button type="button" className="refund-text" onClick={() => setOpen(true)}>
            {t("Take money back")}
          </button>
        </p>
      ) : (
        <form
          className="refund-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="refund-form__hint">
            {t("If too much was refunded and the guest gives it back, record it here.")}
          </p>
          <fieldset className="refund-form__field">
            <legend>{t("How it was taken back")}</legend>
            <label>
              <input
                type="radio"
                name="recovery-method"
                checked={method === "Cash"}
                onChange={() => setMethod("Cash")}
              />{" "}
              {t("Cash")}
            </label>{" "}
            <label>
              <input
                type="radio"
                name="recovery-method"
                checked={method === "CardMachine"}
                onChange={() => setMethod("CardMachine")}
              />{" "}
              {t("Charged on the card machine")}
            </label>
          </fieldset>
          <div className="refund-form__field">
            <label htmlFor="recovery-amount">
              {t("Amount (up to {amount})", { amount: amount(left.toString()) })}
            </label>
            <input
              id="recovery-amount"
              inputMode="decimal"
              autoComplete="off"
              value={dollars}
              onChange={(event) => setDollars(event.target.value)}
            />
          </div>
          {method === "CardMachine" ? (
            <div className="refund-form__field">
              <label htmlFor="recovery-slip">{t("Card machine slip reference")}</label>
              <input
                id="recovery-slip"
                autoComplete="off"
                value={slip}
                onChange={(event) => setSlip(event.target.value)}
              />
            </div>
          ) : null}
          <div className="refund-form__field">
            <label htmlFor="recovery-reason">{t("Reason")}</label>
            <select
              id="recovery-reason"
              value={reason}
              onChange={(event) =>
                setReason(event.target.value as (typeof recoveryReasons)[number][0])
              }
            >
              {recoveryReasons.map(([code, label]) => (
                <option key={code} value={code}>
                  {label()}
                </option>
              ))}
            </select>
          </div>
          <label className="refund-line__stop">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            {t("This adds a record. The refund stays as it was.")}
          </label>
          <p>
            <button type="submit" className="refund-primary" disabled={busy}>
              {t("Record money taken back")}
            </button>{" "}
            <button type="button" className="refund-text" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </button>
          </p>
        </form>
      )}
    </section>
  );
}

export function RefundPaymentPage({
  csrf,
  storeLabel,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
}) {
  const { id = "" } = useParams(),
    location = useLocation();
  return (
    <PaymentContent
      key={id}
      paymentIntentReference={id}
      csrf={csrf}
      storeLabel={storeLabel}
      wizard={location.pathname.endsWith("/refund")}
    />
  );
}

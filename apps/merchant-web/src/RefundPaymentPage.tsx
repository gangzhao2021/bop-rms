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
type Intent = ReturnType<typeof client.prepareRequest>;
type Preview = Awaited<ReturnType<Intent["preview"]>>;
type Submitted = Awaited<ReturnType<Intent["submit"]>>;
const amount = (value: string | null) =>
  value === null ? "Unavailable" : orderMoney({ amountMinor: value, currencyCode: "CAD" });
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
function requestBlockedMessage(context: Context): ReactNode {
  if (refundableMinor(context) <= 0n) {
    const pending = BigInt(context.pendingRefundMinor ?? "0");
    return (
      <p>
        {pending > 0n
          ? `A refund of ${amount(String(pending))} is pending; nothing more can be requested until it finishes.`
          : "Nothing is left to refund on this payment."}
        {context.canRequest ? null : (
          <>
            {" "}
            <Link to="/app/approvals">Open Approvals</Link>
          </>
        )}
      </p>
    );
  }
  if (!context.canRequest)
    return (
      <p>
        Only a store manager records refund requests. Refunds that need your approval or decline are
        on the <Link to="/app/approvals">Approvals</Link> page.
      </p>
    );
  return null;
}
/** Payment state in staff language, including refunds already made. */
export function paymentStateLabel(context: Context): string {
  if (context.paymentState !== "Captured")
    return context.paymentState === "Failed" ? "Failed" : "Not confirmed yet";
  const captured = BigInt(context.capturedAmountMinor ?? "0"),
    confirmed = BigInt(context.confirmedRefundMinor ?? "0"),
    pending = BigInt(context.pendingRefundMinor ?? "0");
  if (confirmed >= captured && captured > 0n) return "Refunded";
  if (confirmed > 0n) return pending > 0n ? "Partly refunded, refund pending" : "Partly refunded";
  if (pending > 0n) return "Paid, refund pending";
  return "Paid";
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
  if (approvalState === "AwaitingApproval") return "Waiting for owner approval";
  if (paymentMethod === "CardMachine")
    return approvalState === "Approved"
      ? "Approved — refund it on the card machine and record it"
      : progress === "Refunded"
        ? "Refunded on the card machine"
        : "To refund on the card machine";
  if (progress === "Refunded") return "Refunded";
  if (progress === "Sending") return "Sent — waiting for the card provider's answer";
  if (approvalState === "Approved") return "Approved, not sent yet";
  return progress === "Recorded" ? "Recorded, not sent yet" : "Not sent yet";
}
/** WP-2423 item 6: one online payment's refund state within a request, in staff language. */
export function paymentRefundStateLabel(
  state: "NotDispatched" | "Prepared" | "NeedsReconciliation" | "Confirmed",
): string {
  return state === "Confirmed"
    ? "Refunded"
    : state === "NeedsReconciliation"
      ? "Sent — waiting for the card provider's answer"
      : "Not sent yet";
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
      Refunded {amount(amountMinor)} on the store&apos;s card machine{" "}
      <SourceTime instant={refundedAt} />.
      {slipReference !== null
        ? ` Slip reference: ${slipReference}.`
        : " No slip reference was entered."}
    </>
  );
}
function RecordedRequestStatus({
  orderReference,
  entry,
  approval,
  csrf,
  onFinancialChange,
  onRequestsChange,
  onPending,
  held = false,
}: {
  orderReference: string;
  entry: Items["recentRequests"][number];
  /** WP-2423 item 6: the refund form above is still sending this request (resume it there). */
  held?: boolean;
  /** WP-2423 Q5: this request's place in the Store's approval list (null: none needed/known). */
  approval: RefundApprovalEntry | null;
  csrf: string;
  onFinancialChange: () => void;
  /** Reread the order's recorded requests after a write on this one. */
  onRequestsChange: () => void;
  onPending: (paymentReference: string, active: boolean) => void;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.status>> | null>(null);
  const [message, setMessage] = useState("");
  // The confirmation of a write on this request; kept while its status is reread.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async (afterWrite = false) => {
    if (pending.current) {
      if (!afterWrite) return;
      // A write supersedes a read that started before it.
      pending.current.abort();
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    if (!afterWrite) setNotice(null);
    setResult(null);
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
        onFinancialChange();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(errorMessage(error));
        // The write happened: the payment amounts are reread even when this status is not.
        if (afterWrite) onFinancialChange();
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // WP-2423 item 4: after the machine refund is recorded, show where the request now stands from
  // the server (this status, the payment amounts and the order's request list), not a local guess.
  const recorded = (confirmation: string) => {
    setNotice(confirmation);
    onRequestsChange();
    void load(true);
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
  return (
    <div>
      <button disabled={busy || preparing.size > 0} onClick={() => void load()}>
        Check execution status for request {entry.claimVersion}
      </button>
      {notice ? <p role="status">{notice}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {result ? (
        <section aria-label={"Execution status for request " + entry.claimVersion}>
          <p>
            Last checked <SourceTime instant={result.observedAt} />
          </p>
          <ul>
            {result.payments.map((payment, index) => (
              <li key={payment.paymentAttemptReference}>
                Payment {index + 1}:{" "}
                {payment.method === "CardMachine" ? (
                  // WP-2423 item 4: refunded on the store's card machine, then recorded here.
                  <>
                    {payment.state === "Confirmed" && payment.refundedOnCardMachineAt !== null ? (
                      <CardMachineRefundDone
                        amountMinor={payment.amountMinor}
                        refundedAt={payment.refundedOnCardMachineAt}
                        slipReference={payment.cardMachineSlipReference}
                      />
                    ) : approval?.state === "AwaitingApproval" ? (
                      <>
                        {amount(payment.amountMinor)} to refund on the card machine once an owner
                        approves it. <Link to="/app/approvals">Open approvals</Link>
                      </>
                    ) : (
                      <CardMachineRequestRefund
                        orderReference={orderReference}
                        requestReference={entry.requestReference}
                        amountMinor={payment.amountMinor}
                        amountLabel={amount(payment.amountMinor)}
                        csrf={csrf}
                        onRecorded={recorded}
                      />
                    )}
                  </>
                ) : null}
                {payment.method === "CardMachine" ? null : (
                  <>
                    {paymentRefundStateLabel(payment.state)}. Requested{" "}
                    {amount(payment.amountMinor)}; confirmed {amount(payment.confirmedMinor)};
                    pending {amount(payment.pendingMinor)}.
                  </>
                )}
                {payment.method === "Online" &&
                (payment.state === "NeedsReconciliation" || payment.state === "Confirmed") &&
                payment.executionOperationReference ? (
                  <RefundExecutionAction
                    onFinancialChange={onFinancialChange}
                    key={payment.executionOperationReference + ":" + payment.state}
                    orderReference={orderReference}
                    operationReference={payment.executionOperationReference}
                    csrf={csrf}
                    onPending={paymentPending(payment.paymentAttemptReference)}
                  />
                ) : null}
                {payment.method === "Online" &&
                payment.state === "NotDispatched" &&
                approval !== null ? (
                  <p>
                    {approval.state === "AwaitingApproval"
                      ? "Waiting for an owner or finance member to approve this refund in person. It is sent once approved."
                      : "Approved, not sent yet. The approver sends it with Send approved refund on the Approvals page; it is never sent twice."}{" "}
                    <Link to="/app/approvals">Open approvals</Link>
                  </p>
                ) : null}
                {payment.method === "Online" &&
                ((payment.state === "NotDispatched" && approval === null) ||
                  (payment.state === "Prepared" && payment.executionOperationReference)) ? (
                  held ? (
                    <p>Continue sending this refund with the button under the refund form.</p>
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
          {result.payments.some((payment) => BigInt(payment.pendingMinor) > 0n) ? (
            <p>
              A pending amount stays set aside until its refund finishes, so it cannot be requested
              again. The refund receipt is ready once the refund is confirmed.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
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
function RefundWizard({
  orderReference,
  csrf,
  onFinancialChange,
  blockedMessage = null,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly onFinancialChange: () => void;
  /** WP-2423 Q5: why no new request can be recorded here (history stays visible). */
  readonly blockedMessage?: ReactNode;
}) {
  const [items, setItems] = useState<Items | null>(null),
    [quantities, setQuantities] = useState<Record<string, number>>({}),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [approvals, setApprovals] = useState<ReadonlyMap<string, RefundApprovalEntry>>(new Map()),
    [verifiedUntil, setVerifiedUntil] = useState<string | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [message, setMessage] = useState(""),
    // WP-2423: the request was refused on an unconfirmed PIN sign-in (retry the same one after).
    [signIn, setSignIn] = useState(false),
    [state, setState] = useState<"Idle" | "Busy" | "Unknown" | "Recorded">("Idle");
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
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
  useEffect(() => () => pending.current?.abort(), []);
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
              ? "Original request recovered. See below where it stands and what to do next."
              : "The original request is not confirmed by this history. Its result remains unknown; retry the same request.",
          );
        } else if (wasRecorded) {
          setState("Recorded");
          onFinancialChange();
          setMessage(
            runFailure !== null
              ? refundRunFailureText(runFailure)
              : "Request remains recorded. Updated records are shown below.",
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
      pending.current = null;
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
          "The refund was recorded, but this list could not be updated. Select Refresh recorded requests.",
        );
    } finally {
      if (requestsRefresh.current === controller) requestsRefresh.current = null;
    }
  };
  // WP-2423 Q5: show this order's refund requests and their progress straight away.
  const loadedOnce = useRef(false);
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    void load();
  });
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
      setMessage("Select at least one item quantity.");
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
        "Refund items paid on the card machine separately: select only items from that one payment.",
      );
      return;
    }
    if (!refundReasonCodes.includes(reason as (typeof refundReasonCodes)[number])) {
      setMessage("Select the reason for this refund.");
      return;
    }
    if (reason === "OTHER" && (note.trim() === "" || [...note.trim()].length > 200)) {
      setMessage("Explain the reason in a short note (up to 200 characters).");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    clearPreview();
    try {
      const key = JSON.stringify([items.claimVersion, selection, reason, note.trim()]);
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
      });
      operation.current = intent;
      const result = await intent.preview(csrf, controller.signal);
      if (!controller.signal.aborted) {
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
        sendAfterRequest: !previewOnMachine,
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
        const recovered = result?.replayed === true ? "Original request recovered. " : "";
        const total = amount(result?.amountMinor ?? null);
        setMessage(
          outcome.kind === "Refunded"
            ? `${recovered}Refunded ${total} to the customer's original payment method.`
            : outcome.kind === "WaitingForAnswer"
              ? `${recovered}Sent — waiting for the card provider's answer. ${total} stays set aside until it answers; the request below shows the result.`
              : `${recovered || "Request recorded. "}Refund amount: ${total}` +
                (outcome.kind === "AwaitingApproval" && result?.approveAlone
                  ? ". Nothing is refunded yet. You run this business alone (sole operator): open Approvals and approve it yourself after confirming it is you; it is sent once approved."
                  : outcome.kind === "AwaitingApproval"
                    ? ". Nothing is refunded yet: it is sent once the owner approves it. Ask the owner to open Approvals on this device or theirs. If more than 15 minutes pass after your verification, you'll be asked to verify again here."
                    : ". Now refund it on the store's card machine and record it under the request below."),
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
            "Request result unknown. Keep this page open and retry the same request; do not start another refund.",
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
  return (
    <section aria-labelledby="refund-heading" data-screen-id="PAY-REFUND-WIZARD">
      <h2 id="refund-heading">{requestable ? "Request a refund" : "Refund requests"}</h2>
      {requestable ? (
        <p>
          Select items from the paid rounds of this order. The server checks remaining quantity and
          balance when calculating and submitting.
        </p>
      ) : null}
      <button disabled={state === "Busy" || preparing.size > 0} onClick={() => void load()}>
        {state === "Unknown"
          ? "Check recorded requests"
          : state === "Recorded" || (!requestable && items !== null)
            ? "Refresh recorded requests"
            : requestable
              ? "Load refundable items"
              : "Show refund requests"}
      </button>
      {items ? (
        <section aria-label="Recorded refund requests">
          <h3>Recorded refund requests</h3>
          <p>
            Latest {items.recentRequests.length} of {items.claimVersion} refund requests for this
            order, with where each one stands.
          </p>
          {items.recentRequests.length === 0 ? (
            <p>No recorded requests in this snapshot.</p>
          ) : (
            <ol>
              {items.recentRequests.map((entry) => (
                <li key={entry.requestReference}>
                  Request {entry.claimVersion}: {amount(entry.amountMinor)} ·{" "}
                  {describeRefundReason(entry.reasonCode)} ·{" "}
                  <SourceTime instant={entry.requestedAt} />
                  {entry.decline !== null ? (
                    <>
                      {" · Declined by "}
                      {entry.decline.declinedByYou
                        ? "you"
                        : (entry.decline.declinerName ?? "an owner")}{" "}
                      <SourceTime instant={entry.decline.declinedAt} />
                      {": " +
                        (declineReasonLabel[entry.decline.reasonCode] ?? "Other reason") +
                        ". Nothing was refunded; you can request again."}
                    </>
                  ) : (
                    " · " +
                    requestProgressLabel(
                      entry.progress,
                      entry.paymentMethod,
                      approvals.get(entry.requestReference)?.state ?? null,
                    )
                  )}
                  {entry.decline !== null ? null : (
                    <RecordedRequestStatus
                      held={heldRequest === entry.requestReference}
                      approval={approvals.get(entry.requestReference) ?? null}
                      onFinancialChange={onFinancialChange}
                      onRequestsChange={() => void reloadRequests()}
                      orderReference={orderReference}
                      entry={entry}
                      csrf={csrf}
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
          )}
        </section>
      ) : null}
      {!requestable ? (
        <div role="status">
          {blockedMessage ?? (
            <p>
              Only a store manager records refund requests. You can follow these refunds here and
              approve or decline them on the <Link to="/app/approvals">Approvals</Link> page.
            </p>
          )}
        </div>
      ) : (
        <fieldset disabled={locked}>
          <legend>Refund selection</legend>
          {items?.items.map((item, index) =>
            // WP-2423 Q5: a line that was never charged (e.g. a round cancelled before payment)
            // cannot be refunded; it is summarized below instead of offered as a quantity.
            // A round the store cancelled was refunded whole by that cancellation; listed below.
            !item.paymentCaptured || item.refundedByCancellation ? null : (
              <div className="form-field" key={item.orderItemReference}>
                <label htmlFor={"refund-quantity-" + index}>
                  {item.label} · line {index + 1} ({item.unclaimedQuantity} unclaimed of{" "}
                  {item.quantity})
                  {item.paymentMethod === "CardMachine" ? " · paid on card machine" : ""}
                </label>
                <input
                  id={"refund-quantity-" + index}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={item.unclaimedQuantity}
                  step={1}
                  value={quantities[item.orderItemReference] ?? 0}
                  disabled={!item.paymentCaptured || item.unclaimedQuantity === 0}
                  onChange={(event) => {
                    const quantity = Number(event.target.value);
                    if (
                      Number.isSafeInteger(quantity) &&
                      quantity >= 0 &&
                      quantity <= item.unclaimedQuantity
                    ) {
                      setQuantities((prior) => ({ ...prior, [item.orderItemReference]: quantity }));
                      clearPreview();
                    }
                  }}
                />
              </div>
            ),
          )}
          {items && items.items.some((item) => !item.paymentCaptured) ? (
            <p>
              Not charged, so not refundable:{" "}
              {items.items
                .filter((item) => !item.paymentCaptured)
                .map((item) => item.label)
                .join(", ")}
              .
            </p>
          ) : null}
          {items && items.items.some((item) => item.refundedByCancellation) ? (
            <p>
              Already refunded in full when the round was cancelled:{" "}
              {items.items
                .filter((item) => item.refundedByCancellation)
                .map((item) => item.label)
                .join(", ")}
              .
            </p>
          ) : null}
          {items?.items.length === 0 ? <p>No items are available.</p> : null}
          <label htmlFor="refund-reason">Reason</label>
          <select
            id="refund-reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              clearPreview();
            }}
          >
            <option value="">Select a reason</option>
            {refundReasonCodes.map((code) => (
              <option key={code} value={code}>
                {refundReasonLabel[code]}
              </option>
            ))}
          </select>
          {reason === "OTHER" ? (
            <>
              <label htmlFor="refund-note">
                Note for the approver (required, up to 200 characters)
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
              <p>Describe what happened. Do not include card numbers or health details.</p>
            </>
          ) : null}
          <button disabled={!items} onClick={() => void calculate()}>
            Calculate refund
          </button>
        </fieldset>
      )}
      {sections.startAnother ? (
        <button type="button" disabled={preparing.size > 0} onClick={startAnother}>
          Start another refund request
        </button>
      ) : null}
      {preview && sections.confirmation ? (
        <section aria-label="Refund calculation">
          <h3>Confirm refund amount</h3>
          <dl>
            {[
              ["Items", "netAmountMinor"],
              ["Tax", "taxAmountMinor"],
              ["Tip", "tipAmountMinor"],
              ["Service charge", "serviceChargeAmountMinor"],
              ["Service charge tax", "serviceChargeTaxAmountMinor"],
            ].map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{amount(preview.components[key ?? ""] ?? null)}</dd>
              </div>
            ))}
            <div>
              <dt>Total</dt>
              <dd>{amount(preview.amountMinor)}</dd>
            </div>
          </dl>
          {previewOnMachine ? (
            <p>
              Paid on the store&apos;s card machine. After the request is recorded
              {preview.approvalRequired === true ? " and approved" : ""}, refund this amount on that
              machine and record it under the request.
            </p>
          ) : sendsNow ? (
            <p>
              Refunded to the customer&apos;s original payment method (
              {preview.paymentAttemptReferences.length} payment(s)) as soon as you confirm: the
              request is recorded and sent to the card provider in one step, and its answer is shown
              here.
            </p>
          ) : (
            <p>
              {preview.paymentAttemptReferences.length} original payment(s). Recording this request
              does not refund anything yet: it is sent once approved.
            </p>
          )}
          {preview.approvalRequired === true ? (
            <section aria-label="Owner approval needed" className="refund-escalation">
              <h4>Needs owner approval</h4>
              <ul>
                {preview.escalationReasons.map((code) => (
                  <li key={code}>{escalationReasonLabel[code]}</li>
                ))}
              </ul>
              <p>
                {preview.approveAlone
                  ? "You run this business alone (sole operator), so you can approve this refund yourself on the Approvals page after confirming it is you. First confirm it is you; your verification lasts 15 minutes."
                  : "An owner or finance member who is not you must approve this refund in person. First confirm it is you; your verification lasts 15 minutes."}
              </p>
              <StepUpVerification
                purpose="RefundRequest"
                csrf={csrf}
                verifiedUntil={verifiedUntil}
                onVerified={setVerifiedUntil}
                label="Verify with your authenticator"
              />
            </section>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm the selected quantities, reason and {amount(preview.amountMinor)}{" "}
            {sendsNow ? "refund" : "request"}.
          </label>
          <button
            disabled={
              !confirmed || locked || (preview.approvalRequired === true && !verificationCurrent())
            }
            onClick={() => void submit()}
          >
            {preview.approvalRequired === true
              ? "Record request for owner approval"
              : sendsNow
                ? `Send ${amount(preview.amountMinor)} refund`
                : "Record refund request"}
          </button>
        </section>
      ) : null}
      {state === "Unknown" ? (
        <button onClick={() => void submit()}>{refundRunRetryLabel("Request")}</button>
      ) : null}
      {runFailure !== null && state === "Recorded" ? (
        <button onClick={() => void submit()}>{refundRunRetryLabel(runFailure.step)}</button>
      ) : null}
      {signIn && state !== "Busy" ? <FullSignInPrompt csrf={csrf} /> : null}
      <p ref={status} tabIndex={-1} role="status">
        {state === "Busy" ? (runStep ? refundRunProgressText(runStep) : "Working…") : message}
      </p>
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
    return { context: state.context, busy: true, message: "Updating payment amounts…" };
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
      <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh payment amounts
      </button>
      <p role="status">{message}</p>
      {context ? (
        <section
          aria-label="Payment financial summary"
          aria-busy={busy}
          data-screen-id="PAY-PAYMENT-DETAIL"
        >
          <h2>Payment financial summary</h2>
          <p>Payment state: {paymentStateLabel(context)}</p>
          {context.paymentMethod === "CardMachine" ? (
            <p>
              Paid on the store&apos;s card machine. Its refunds are made on that machine and
              recorded here; they count on the day they are made.
            </p>
          ) : null}
          <dl>
            <div>
              <dt>Paid</dt>
              <dd>{amount(context.capturedAmountMinor)}</dd>
            </div>
            <div>
              <dt>Confirmed refunds</dt>
              <dd>{amount(context.confirmedRefundMinor)}</dd>
            </div>
            <div>
              <dt>Pending refunds</dt>
              <dd>{amount(context.pendingRefundMinor)}</dd>
            </div>
          </dl>
          <p>
            Last checked <SourceTime instant={context.observedAt} />
          </p>
        </section>
      ) : (
        <p>Payment amounts are unavailable until refreshed.</p>
      )}
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
      className="card-machine-refunds-to-record"
    >
      <h2 id="card-machine-refunds-heading">Refunds to make on the card machine</h2>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {message !== "" ? (
        <div role="status">
          <p>{message}</p>
          <button onClick={() => setReload((value) => value + 1)}>
            Check refunds to record again
          </button>
        </div>
      ) : null}
      {refunds !== null && refunds.length > 0 ? (
        <ul>
          {refunds.map(({ entry, amountMinor, approval }) => {
            const label = `Record the card-machine refund for request ${entry.claimVersion} (${amount(amountMinor)})`;
            return (
              <li key={entry.requestReference}>
                <p>
                  Request {entry.claimVersion}: {amount(amountMinor)} ·{" "}
                  {describeRefundReason(entry.reasonCode)} · requested{" "}
                  <SourceTime instant={entry.requestedAt} />
                </p>
                {approval?.state === "AwaitingApproval" ? (
                  <p>
                    Waiting for an owner&apos;s approval before it is refunded on the card machine.{" "}
                    <Link to="/app/approvals">Open approvals</Link>
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
                    onClick={() => {
                      setNotice(null);
                      setOpen(entry.requestReference);
                    }}
                  >
                    {label}
                  </button>
                )}
              </li>
            );
          })}
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
    [message, setMessage] = useState("Loading payment…"),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setContext(null);
    setMessage("Loading payment…");
    void client
      .context(paymentIntentReference, csrf, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setContext(result);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      });
    return () => controller.abort();
  }, [paymentIntentReference, csrf, refresh]);
  return (
    <WorkspacePage title="Payment" meta={storeLabel}>
      <p role="status">{message}</p>
      {!context ? (
        <button onClick={() => setRefresh((value) => value + 1)}>Refresh payment</button>
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
          {context.paymentState !== "Captured" ? (
            <p>A refund can be requested once this payment is paid.</p>
          ) : !wizard && context.canRequest && refundableMinor(context) > 0n ? (
            <Link to={"/app/operations/payments/" + paymentIntentReference + "/refund"}>
              Start refund request
            </Link>
          ) : (
            <RefundWizard
              onFinancialChange={refreshFinancial}
              key={context.orderReference}
              orderReference={context.orderReference}
              csrf={csrf}
              blockedMessage={requestBlockedMessage(context)}
            />
          )}
        </>
      )}
    </WorkspacePage>
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

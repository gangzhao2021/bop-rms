import { RefundExecutionAction } from "./RefundExecutionAction.js";
import {
  createOrdinaryRefundPreparationClient,
  OrdinaryRefundPreparationClientError,
} from "./ordinary-refund-preparation-client.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { SourceTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { createOrdinaryRefundClient, OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { StepUpVerification } from "./StepUpVerification.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, needsFullSignIn } from "./full-sign-in.js";
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
const amount = (value: string | null) =>
  value === null
    ? "Unavailable"
    : "CAD " +
      (BigInt(value) / 100n).toString() +
      "." +
      (BigInt(value) % 100n).toString().padStart(2, "0");
const errorMessage = (error: unknown) =>
  needsFullSignIn(error)
    ? FULL_SIGN_IN_REQUIRED_TEXT
    : error instanceof OrdinaryRefundClientError && error.code === "Denied"
      ? "Your current permissions do not allow this refund workflow."
      : error instanceof OrdinaryRefundClientError && error.code === "Conflict"
        ? "The payment or refund selection changed. Refresh before trying again."
        : "Unable to refresh this information. Check your connection and try again.";
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
function paymentStateLabel(context: Context): string {
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
export function OrderPaymentLinks({
  orderReference,
  csrf,
  fetcher,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  /** WP-2423 P5: an injected transport (the local demo); the shared client otherwise. */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const paymentClient = useMemo(
    () => (fetcher === undefined ? client : createOrdinaryRefundClient(fetcher)),
    [fetcher],
  );
  const [links, setLinks] = useState<readonly string[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const result = await paymentClient.items(orderReference, csrf, controller.signal);
      if (!controller.signal.aborted) {
        const ids = [
          ...new Set(
            result.items.flatMap((item) =>
              item.paymentIntentReference === null ? [] : [item.paymentIntentReference],
            ),
          ),
        ];
        setLinks(ids);
        if (!ids.length) setMessage("No captured payment is available for this order.");
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section aria-label="Order payments">
      <button disabled={busy} onClick={() => void load()}>
        Payments and refunds
      </button>
      <p role="status">{message}</p>
      {links.map((reference, index) => (
        <p key={reference}>
          <Link to={"/app/operations/payments/" + reference}>
            Payment {index + 1} · refunds and details
          </Link>
        </p>
      ))}
    </section>
  );
}
const preparationClient = createOrdinaryRefundPreparationClient();
function RefundPreparationAction({
  orderReference,
  requestReference,
  paymentAttemptReference,
  approvalReference,
  csrf,
  onPending,
}: {
  orderReference: string;
  requestReference: string;
  paymentAttemptReference: string;
  /** WP-2423 Q5: the independent approval this request carries, if one was needed. */
  approvalReference: string | null;
  csrf: string;
  onPending: (pending: boolean) => void;
}) {
  const [state, setState] = useState<"Idle" | "Busy" | "Unknown" | "Recorded">("Idle"),
    [message, setMessage] = useState(""),
    [signIn, setSignIn] = useState(false);
  const intent = useRef<ReturnType<typeof preparationClient.prepare> | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    if (state === "Busy" || state === "Unknown") window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);
  const prepare = async () => {
    if (pending.current || state === "Recorded") return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    setSignIn(false);
    onPending(true);
    try {
      intent.current ??= preparationClient.prepare({
        orderReference,
        requestReference,
        paymentAttemptReference,
        operationReference: serviceOperationReference(),
        auditReference: serviceOperationReference(),
        approvalReference,
      });
      const result = await intent.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        setState("Recorded");
        onPending(false);
        setMessage(
          (result.replayed ? "Original preparation recovered. " : "Preparation recorded. ") +
            "Check execution status for updates. No completed refund is confirmed here.",
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (needsFullSignIn(error)) {
          // WP-2423: confirm the PIN sign-in, then retry this same preparation.
          setState("Idle");
          onPending(false);
          setSignIn(true);
        } else if (
          error instanceof OrdinaryRefundPreparationClientError &&
          error.code !== "OutcomeUnknown"
        ) {
          setState("Idle");
          onPending(false);
          intent.current = null;
          setMessage(
            error.code === "Unavailable"
              ? "Refund preparation is not configured for this store. Contact the pilot operator."
              : error.code === "PermissionDenied"
                ? "Preparation was denied. Current execution permission and any required independent approval must be satisfied."
                : "The refund changed. Check execution status before preparing again.",
          );
        } else {
          setState("Unknown");
          setMessage(
            "Preparation result unknown. Keep this page open and retry the same preparation.",
          );
        }
      }
    } finally {
      pending.current = null;
    }
  };
  return (
    <div>
      <p>
        The server rechecks execution permission, balance and any required independent approval
        before recording preparation.
      </p>
      <button disabled={state === "Busy" || state === "Recorded"} onClick={() => void prepare()}>
        {state === "Unknown" ? "Retry same refund preparation" : "Prepare refund execution"}
      </button>
      {message ? <p role="status">{message}</p> : null}
      {signIn ? <FullSignInPrompt csrf={csrf} /> : null}
    </div>
  );
}
function RecordedRequestStatus({
  orderReference,
  entry,
  approval,
  csrf,
  onFinancialChange,
  onPending,
}: {
  orderReference: string;
  entry: Items["recentRequests"][number];
  /** WP-2423 Q5: this request's place in the Store's approval list (null: none needed/known). */
  approval: RefundApprovalEntry | null;
  csrf: string;
  onFinancialChange: () => void;
  onPending: (paymentReference: string, active: boolean) => void;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof client.status>> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
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
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div>
      <button disabled={busy || preparing.size > 0} onClick={() => void load()}>
        Check execution status for request {entry.claimVersion}
      </button>
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
                {payment.state === "Confirmed"
                  ? "Refund confirmed"
                  : payment.state === "Prepared"
                    ? "Preparation recorded; awaiting dispatch"
                    : payment.state === "NotDispatched"
                      ? "Not dispatched"
                      : "Needs reconciliation"}
                . Requested {amount(payment.amountMinor)}; confirmed{" "}
                {amount(payment.confirmedMinor)}; pending {amount(payment.pendingMinor)}.
                {payment.state !== "NotDispatched" && payment.executionOperationReference ? (
                  <RefundExecutionAction
                    onFinancialChange={onFinancialChange}
                    key={payment.executionOperationReference + ":" + payment.state}
                    orderReference={orderReference}
                    requestReference={entry.requestReference}
                    operationReference={payment.executionOperationReference}
                    approvalReference={payment.executionApprovalReference}
                    phase={payment.state}
                    amountLabel={amount(payment.amountMinor)}
                    csrf={csrf}
                    onPending={(active) => {
                      onPending(payment.paymentAttemptReference, active);
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        if (active) next.add(payment.paymentAttemptReference);
                        else next.delete(payment.paymentAttemptReference);
                        return next;
                      });
                    }}
                  />
                ) : null}
                {payment.state === "NotDispatched" && approval !== null ? (
                  <p>
                    {approval.state === "AwaitingApproval"
                      ? "Waiting for an owner or finance member to approve this refund in person."
                      : "Approved; the approver finishes sending it on the Approvals page."}{" "}
                    <Link to="/app/approvals">Open approvals</Link>
                  </p>
                ) : null}
                {payment.state === "NotDispatched" && approval === null ? (
                  <RefundPreparationAction
                    // A Manager prepares only a refund that needs no approval; an approved
                    // refund is prepared and sent by its approval (one operation, never two).
                    approvalReference={null}
                    orderReference={orderReference}
                    requestReference={entry.requestReference}
                    paymentAttemptReference={payment.paymentAttemptReference}
                    csrf={csrf}
                    onPending={(active) => {
                      onPending(payment.paymentAttemptReference, active);
                      setPreparing((prior) => {
                        const next = new Set(prior);
                        if (active) next.add(payment.paymentAttemptReference);
                        else next.delete(payment.paymentAttemptReference);
                        return next;
                      });
                    }}
                  />
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
    if (state === "Unknown" || state === "Busy") window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);
  const locked = state !== "Idle" || preparing.size > 0;
  // WP-2423 Q5: someone who cannot record a new request here only follows recorded ones.
  const requestable = blockedMessage === null && items?.canRequest !== false;
  const verificationCurrent = () =>
    verifiedUntil !== null && Date.parse(verifiedUntil) > Date.now();
  const clearPreview = () => {
    setSignIn(false);
    setPreview(null);
    setConfirmed(false);
    operation.current = null;
    operationReference.current = null;
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
          setState(recovered ? "Recorded" : "Unknown");
          setMessage(
            recovered
              ? "Original request recovered. No completed refund is confirmed here."
              : "The original request is not confirmed by this history. Its result remains unknown; retry the same request.",
          );
        } else if (wasRecorded) {
          setState("Recorded");
          onFinancialChange();
          setMessage(
            "Request remains recorded. Updated records are shown below; no completed refund is confirmed here.",
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
    if (
      !operation.current ||
      !preview ||
      (!confirmed && state !== "Unknown") ||
      pending.current ||
      state === "Recorded" ||
      (preview.approvalRequired === true && state !== "Unknown" && !verificationCurrent())
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Busy");
    setMessage("");
    setSignIn(false);
    try {
      const result = await operation.current.submit(csrf, controller.signal);
      if (!controller.signal.aborted) {
        previewIdentity.current = null;
        setState("Recorded");
        onFinancialChange();
        setMessage(
          (result.replayed ? "Original request recovered. " : "Request recorded. ") +
            "Refund amount: " +
            amount(result.amountMinor) +
            (result.approvalRequired === true && result.approveAlone
              ? ". You run this business alone (sole operator): open Approvals and approve it yourself after confirming it is you."
              : result.approvalRequired === true
                ? ". Ask the owner to open Approvals on this device or theirs. If more than 15 minutes pass after your verification, you'll be asked to verify again here."
                : ". Approval and execution are separate. No completed refund is confirmed here."),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OrdinaryRefundClientError && error.code === "OutcomeUnknown") {
          setState("Unknown");
          setMessage(
            "Request result unknown. Keep this page open and retry the same request; do not start another refund.",
          );
        } else if (needsFullSignIn(error)) {
          // Keep the confirmed request: once verified, the same request is recorded once.
          setState("Idle");
          setSignIn(true);
        } else {
          setState("Idle");
          clearPreview();
          setMessage(errorMessage(error));
        }
      }
    } finally {
      pending.current = null;
    }
  };
  return (
    <section aria-labelledby="refund-heading" data-screen-id="PAY-REFUND-WIZARD">
      <h2 id="refund-heading">{requestable ? "Request a refund" : "Refund requests"}</h2>
      {requestable ? (
        <p>
          Select items from the paid batches of this order. The server checks remaining quantity and
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
                  ) : approvals.get(entry.requestReference)?.state === "AwaitingApproval" ? (
                    " · Waiting for owner approval"
                  ) : approvals.get(entry.requestReference)?.state === "Approved" ? (
                    " · Approved, sending not finished"
                  ) : entry.progress === "Refunded" ? (
                    " · Refunded"
                  ) : entry.progress === "Sending" ? (
                    " · Sent — result pending"
                  ) : (
                    " · Recorded, not sent yet"
                  )}
                  {entry.decline !== null ? null : (
                    <RecordedRequestStatus
                      approval={approvals.get(entry.requestReference) ?? null}
                      onFinancialChange={onFinancialChange}
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
            !item.paymentCaptured ? null : (
              <div className="form-field" key={item.orderItemReference}>
                <label htmlFor={"refund-quantity-" + index}>
                  {item.label} · line {index + 1} ({item.unclaimedQuantity} unclaimed of{" "}
                  {item.quantity})
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
      {preview ? (
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
          <p>
            {preview.paymentAttemptReferences.length} original payment(s). Recording a request does
            not issue a refund.
          </p>
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
            I confirm the selected quantities, reason and {amount(preview.amountMinor)} request.
          </label>
          <button
            disabled={
              !confirmed || locked || (preview.approvalRequired === true && !verificationCurrent())
            }
            onClick={() => void submit()}
          >
            {preview.approvalRequired === true
              ? "Record request for owner approval"
              : "Record refund request"}
          </button>
        </section>
      ) : null}
      {state === "Unknown" ? (
        <button onClick={() => void submit()}>Retry same refund request</button>
      ) : null}
      {signIn && state !== "Busy" ? <FullSignInPrompt csrf={csrf} /> : null}
      <p ref={status} tabIndex={-1} role="status">
        {state === "Busy" ? "Working…" : message}
      </p>
    </section>
  );
}
function PaymentFinancialSummary({
  initial,
  csrf,
  revision,
}: {
  initial: Context;
  csrf: string;
  revision: number;
}) {
  const [context, setContext] = useState<Context | null>(initial);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (revision === 0 && refresh === 0) return;
    const controller = new AbortController();
    setBusy(true);
    setContext(null);
    setMessage("Refreshing payment amounts…");
    void client
      .context(initial.paymentIntentReference, csrf, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setContext(value);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [initial.paymentIntentReference, csrf, revision, refresh]);
  return (
    <>
      <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh payment amounts
      </button>
      <p role="status">{message}</p>
      {context ? (
        <section aria-label="Payment financial summary" data-screen-id="PAY-PAYMENT-DETAIL">
          <h2>Payment financial summary</h2>
          <p>Payment state: {paymentStateLabel(context)}</p>
          <dl>
            <div>
              <dt>Captured</dt>
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
          <PaymentFinancialSummary initial={context} csrf={csrf} revision={financialRevision} />
          {context.paymentState !== "Captured" ? (
            <p>A captured payment is required before starting a refund request.</p>
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

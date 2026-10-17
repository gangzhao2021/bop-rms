import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { StatePanel } from "@bop-rms/ui";
import { WorkspacePage } from "./WorkspacePage.js";
import { SourceTime } from "./StoreTime.js";
import { StepUpVerification } from "./StepUpVerification.js";
import {
  createRefundApprovalClient,
  declineReasons,
  RefundApprovalClientError,
  type DeclineReason,
  type RefundApprovalEntry,
} from "./refund-approval-client.js";
import {
  declineReasonLabel,
  describeRefundReason,
  escalationReasonLabel,
  formatCad,
} from "./refund-reasons.js";
import { serviceOperationReference } from "./service-control-client.js";
import { createOrdinaryRefundClient } from "./ordinary-refund-client.js";
import { SoleOperatorSection } from "./SoleOperatorSection.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { needsFullSignIn } from "./full-sign-in.js";
import type { SoleOperatorStatus } from "./refund-approval-client.js";

const pollIntervalMs = 3000,
  pollLimit = 40;

type View = Awaited<ReturnType<ReturnType<typeof createRefundApprovalClient>["approvals"]>>;
type Outcome =
  | { readonly kind: "Idle" }
  | { readonly kind: "Busy" }
  | {
      readonly kind: "Sent";
      readonly unknown: boolean;
      /**
       * Follows the refund after approval (WP-2423 item 6): being sent, really sent and waiting
       * for the card provider's answer, refunded; or, when following stops, still waiting for an
       * answer (Sent) or still not sent (NotSent).
       */
      readonly progress: "Sending" | "Sent" | "Refunded" | "StillPending" | "NotSent";
    }
  /** WP-2423 item 4: approved; staff now refund it on the store's card machine and record it. */
  | { readonly kind: "OnMachine" }
  | { readonly kind: "Declined"; readonly declinedAt: string }
  | { readonly kind: "Failed"; readonly message: string; readonly retry: boolean }
  /** WP-2423: refused on an unconfirmed PIN sign-in; verify, then approve or decline again. */
  | { readonly kind: "SignIn" };

/** Why an approval or decline did not go through; a PIN sign-in shows how to confirm it is them. */
export function ApprovalFailureNotice({
  outcome,
  csrf,
  fetcher,
}: {
  readonly outcome: Outcome;
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  if (outcome.kind === "SignIn") return <FullSignInPrompt csrf={csrf} fetcher={fetcher} />;
  return outcome.kind === "Failed" ? <p role="alert">{outcome.message}</p> : null;
}

const person = (entry: RefundApprovalEntry) =>
  entry.requestedByYou ? "You" : (entry.requesterName ?? "The staff member who asked");

/** One refund awaiting approval: who asked, why, and the in-person approval that sends it. */
function ApprovalCard({
  entry,
  csrf,
  viewerVerifiedUntil,
  onViewerVerified,
  onChanged,
  fetcher,
  soleOperator,
}: {
  readonly entry: RefundApprovalEntry;
  readonly csrf: string;
  /** WP-2423 Q19: sole operator for the signed-in approver (null when not read). */
  readonly soleOperator: SoleOperatorStatus | null;
  /** The signed-in member's own verification, shared by every card (it belongs to the person). */
  readonly viewerVerifiedUntil: string | null;
  readonly onViewerVerified: (validUntil: string) => void;
  readonly onChanged: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useRef(createRefundApprovalClient(fetcher ?? fetch));
  // One approval identity per card: a retry reuses it, so the refund is never sent twice.
  const approvalReference = useRef(entry.approvalReference ?? serviceOperationReference());
  const pending = useRef<AbortController | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "Idle" });
  const requesterVerifiedUntil = entry.requestedByYou
    ? viewerVerifiedUntil
    : entry.requesterVerifiedUntil;
  const approverVerifiedUntil = viewerVerifiedUntil;
  const refunds = useRef(createOrdinaryRefundClient(fetcher ?? fetch));
  const polling = useRef<AbortController | null>(null);
  useEffect(() => () => polling.current?.abort(), []);
  /** After approval: read the request's progress until it is refunded (or give up quietly). */
  const follow = async () => {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;
    let sent = false;
    for (let attempt = 0; attempt < pollLimit; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      if (controller.signal.aborted) return;
      try {
        const progress = await refunds.current.progress(
          entry.orderReference,
          entry.requestReference,
          csrf,
          controller.signal,
        );
        if (progress === "Refunded") {
          setOutcome({ kind: "Sent", unknown: false, progress: "Refunded" });
          return;
        }
        // WP-2423 item 6: "Sent" only once the refund really went to the card provider.
        if (progress === "Sending" && !sent) {
          sent = true;
          setOutcome({ kind: "Sent", unknown: false, progress: "Sent" });
        }
      } catch {
        // Keep following; a read failure says nothing about the refund itself.
      }
    }
    if (!controller.signal.aborted)
      setOutcome({ kind: "Sent", unknown: false, progress: sent ? "StillPending" : "NotSent" });
  };
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const risky = outcome.kind === "Busy" || (outcome.kind === "Failed" && outcome.retry);
    if (risky) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [outcome]);
  const who = person(entry);
  // One decline identity per card: a retry after an unknown result reuses it.
  const declineOperation = useRef(serviceOperationReference());
  const [declineReason, setDeclineReason] = useState<DeclineReason | "">("");
  // WP-2423 Q19: approving your own refund as sole operator needs an explicit confirmation.
  const sole = entry.soleOperatorApproval;
  const [confirmed, setConfirmed] = useState(false);
  const withdrawReasons: readonly DeclineReason[] = ["ENTERED_IN_ERROR", "CUSTOMER_WITHDREW"];
  const declineRefund = async () => {
    if (pending.current || declineReason === "") return;
    const controller = new AbortController();
    pending.current = controller;
    setOutcome({ kind: "Busy" });
    try {
      const result = await client.current.decline(
        {
          orderReference: entry.orderReference,
          requestReference: entry.requestReference,
          operationReference: declineOperation.current,
          reasonCode: declineReason,
          ...(sole ? { soleOperator: true } : {}),
        },
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setOutcome({ kind: "Declined", declinedAt: result.declinedAt });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (needsFullSignIn(error)) {
        setOutcome({ kind: "SignIn" });
        return;
      }
      const code = error instanceof RefundApprovalClientError ? error.code : "OutcomeUnknown";
      setOutcome({
        kind: "Failed",
        retry: false,
        message:
          code === "AlreadyPrepared"
            ? "This refund was already sent, so it can no longer be declined. Refresh the list."
            : code === "AlreadyDeclined"
              ? "This refund was already declined. Refresh the list."
              : code === "SamePerson"
                ? "You asked for this refund. Another owner or finance member must decide."
                : code === "NeedsReverification"
                  ? "Confirm it is you with your authenticator code, then decline."
                  : code === "NotPermitted"
                    ? "Only an owner or finance member who didn't ask for this refund can decline it."
                    : code === "Denied"
                      ? "Your session has ended. Sign in again, then decline."
                      : "Result unknown. Decline again with the same reason — it is recorded once.",
      });
    } finally {
      pending.current = null;
    }
  };
  const approve = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setOutcome({ kind: "Busy" });
    try {
      const result = await client.current.approve(
        {
          orderReference: entry.orderReference,
          requestReference: entry.requestReference,
          approvalReference: approvalReference.current,
          ...(sole ? { soleOperator: true } : {}),
        },
        csrf,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.payments.every((payment) => payment.state === "RecordOnCardMachine")) {
        setOutcome({ kind: "OnMachine" });
        return;
      }
      const unknown = result.payments.some((payment) => payment.state === "ResultUnknown");
      setOutcome({ kind: "Sent", unknown, progress: "Sending" });
      if (!unknown) void follow();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (needsFullSignIn(error)) {
        setOutcome({ kind: "SignIn" });
        return;
      }
      const code = error instanceof RefundApprovalClientError ? error.code : "OutcomeUnknown";
      const party = error instanceof RefundApprovalClientError ? error.party : null;
      setOutcome({
        kind: "Failed",
        retry: code === "OutcomeUnknown",
        message:
          code === "NeedsReverification"
            ? party === "Requester"
              ? `${who} must confirm it is them again (their verification is older than 15 minutes). Ask them to verify, then approve.`
              : party === "Approver"
                ? "Confirm it is you with your authenticator code, then approve."
                : `You and ${who} must both confirm with an authenticator code again, then approve.`
            : code === "SoleOperatorNotInEffect"
              ? "Someone else now also holds refund approval at this store, so they must approve this refund. See Sole operator on this page."
              : code === "SamePerson"
                ? "You asked for this refund. Another owner or finance member must approve it."
                : code === "Changed" || code === "AlreadyDeclined" || code === "AlreadyPrepared"
                  ? code === "AlreadyDeclined"
                    ? "This refund was declined. Refresh the list."
                    : "This refund changed since it was shown. Refresh the list."
                  : code === "NotPermitted"
                    ? "Only an owner or finance member who didn't ask for this refund can approve it."
                    : code === "RequesterNotEligible"
                      ? `${who} can no longer request refunds at this store. Ask a store manager to request it again.`
                      : code === "Denied"
                        ? "Your session has ended. Sign in again, then approve."
                        : "Result unknown. Approve again to retry the same approval — it will not refund twice.",
      });
    } finally {
      pending.current = null;
    }
  };
  const approverCurrent =
    approverVerifiedUntil !== null && Date.parse(approverVerifiedUntil) > Date.now();
  const requesterCurrent =
    requesterVerifiedUntil !== null && Date.parse(requesterVerifiedUntil) > Date.now();
  const busy = outcome.kind === "Busy";
  // WP-2423 item 4: a card-machine refund is made on the store's machine once approved.
  const onMachine = entry.paymentMethod === "CardMachine";
  const machineApproved = onMachine && (entry.state === "Approved" || outcome.kind === "OnMachine");
  const paymentDetail = "/app/operations/payments/" + (entry.paymentIntentReferences[0] ?? "");
  const paymentPage = paymentDetail + "/refund";
  return (
    <li className="refund-approval-card">
      <h3>
        Order {entry.orderNumber} · {formatCad(entry.amountMinor)}
      </h3>
      <dl>
        <div>
          <dt>Reason</dt>
          <dd>{describeRefundReason(entry.reasonCode)}</dd>
        </div>
        {entry.note !== null ? (
          <div>
            <dt>Note from {who === "You" ? "you" : who}</dt>
            <dd>{entry.note}</dd>
          </div>
        ) : null}
        <div>
          <dt>Asked by</dt>
          <dd>
            {who} · <SourceTime instant={entry.requestedAt} />
          </dd>
        </div>
        <div>
          <dt>Why approval is needed</dt>
          <dd>
            {entry.escalationReasons.length === 0 ? (
              "Approved request still being sent"
            ) : (
              <ul>
                {entry.escalationReasons.map((reason) => (
                  <li key={reason}>{escalationReasonLabel[reason]}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {outcome.kind === "Declined"
              ? "Declined — nothing was refunded"
              : machineApproved
                ? "Approved — refund it on the store's card machine, then record it"
                : outcome.kind === "Sent"
                  ? outcome.unknown
                    ? "Approved — sending result unknown"
                    : outcome.progress === "Refunded"
                      ? "Refunded"
                      : outcome.progress === "Sent" || outcome.progress === "StillPending"
                        ? "Approved — sent, waiting for the card provider's answer"
                        : outcome.progress === "NotSent"
                          ? "Approved — not sent yet"
                          : "Approved — sending to the card provider"
                  : entry.state === "Approved"
                    ? "Approved — sending not finished"
                    : "Waiting for approval"}
          </dd>
        </div>
        <div>
          <dt>{entry.requestedByYou ? "Your verification" : `${who}'s verification`}</dt>
          <dd>
            {requesterCurrent && requesterVerifiedUntil !== null ? (
              <>
                Current until <SourceTime instant={requesterVerifiedUntil} />
              </>
            ) : (
              "Needs to verify again before approval"
            )}
          </dd>
        </div>
      </dl>
      {sole && outcome.kind !== "Sent" && outcome.kind !== "Declined" ? (
        <div className="sole-operator-confirm">
          <p>
            You asked for this refund and you are the only person who can approve refunds at this
            store (sole operator). Check it before approving it yourself: order {entry.orderNumber},{" "}
            {formatCad(entry.amountMinor)}, {describeRefundReason(entry.reasonCode)}. It will be
            recorded as approved by you alone and shown at day-end settlement.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />{" "}
            I checked this refund and approve it on my own
          </label>
        </div>
      ) : null}
      {entry.requestedByYou && !sole && entry.state === "AwaitingApproval" ? (
        <p>
          {soleOperator === "OtherApprovers"
            ? "Someone else holds refund approval at this store, so they must approve your request."
            : "An owner or finance member who did not ask for this refund must approve it."}
        </p>
      ) : null}
      {entry.requestedByYou && !sole && outcome.kind !== "Sent" ? (
        <StepUpVerification
          purpose="RefundRequest"
          csrf={csrf}
          verifiedUntil={viewerVerifiedUntil}
          onVerified={onViewerVerified}
          loadServerStatus={false}
          label="Verify for the owner's approval"
          fetcher={fetcher}
        />
      ) : null}
      {entry.canApprove &&
      !machineApproved &&
      outcome.kind !== "Declined" &&
      !(outcome.kind === "Sent" && !outcome.unknown && outcome.progress !== "NotSent") ? (
        <div className="card-actions">
          <StepUpVerification
            purpose="RefundApproval"
            csrf={csrf}
            verifiedUntil={viewerVerifiedUntil}
            onVerified={onViewerVerified}
            loadServerStatus={false}
            label="Verify to approve"
            fetcher={fetcher}
          />
          <button
            type="button"
            data-variant="primary"
            disabled={busy || !approverCurrent || (sole && !confirmed)}
            onClick={() => void approve()}
          >
            {busy
              ? "Approving…"
              : sole && entry.state === "AwaitingApproval" && outcome.kind === "Idle"
                ? `Approve my own refund of ${formatCad(entry.amountMinor)}`
                : outcome.kind === "Sent"
                  ? "Retry sending the same refund"
                  : outcome.kind === "Failed" && outcome.retry
                    ? "Retry same approval"
                    : entry.state === "Approved"
                      ? "Send approved refund"
                      : onMachine
                        ? `Approve card machine refund of ${formatCad(entry.amountMinor)}`
                        : `Approve and refund ${formatCad(entry.amountMinor)}`}
          </button>
        </div>
      ) : null}
      {entry.canApprove &&
      entry.state === "AwaitingApproval" &&
      outcome.kind !== "Sent" &&
      outcome.kind !== "Declined" ? (
        <form
          className="card-actions refund-decline"
          onSubmit={(event) => {
            event.preventDefault();
            void declineRefund();
          }}
        >
          <label htmlFor={"decline-reason-" + entry.requestReference}>
            {sole ? "Withdraw reason" : "Decline reason"}
          </label>
          <select
            id={"decline-reason-" + entry.requestReference}
            required
            value={declineReason}
            disabled={busy}
            onChange={(event) => setDeclineReason(event.currentTarget.value as DeclineReason | "")}
          >
            <option value="">Select a reason</option>
            {(sole ? withdrawReasons : declineReasons).map((code) => (
              <option key={code} value={code}>
                {declineReasonLabel[code]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            data-variant="destructive"
            disabled={busy || !approverCurrent || declineReason === ""}
          >
            {sole ? "Withdraw my request" : "Decline refund"}
          </button>
        </form>
      ) : null}
      {outcome.kind === "Declined" ? (
        <div role="status">
          <p>
            Declined <SourceTime instant={outcome.declinedAt} />. Nothing was refunded and the
            request no longer counts toward this order; {who === "You" ? "you" : who} can see why.
          </p>
          <button type="button" onClick={onChanged}>
            Refresh list
          </button>
        </div>
      ) : null}
      {!entry.canApprove && !entry.requestedByYou ? (
        <p>Only an owner or finance member who did not ask for this refund can approve it.</p>
      ) : null}
      <ApprovalFailureNotice outcome={outcome} csrf={csrf} fetcher={fetcher} />
      {machineApproved ? (
        <div role="status">
          <p>
            Approved. Refund {formatCad(entry.amountMinor)} on the store&apos;s card machine to the
            card the customer paid with, then record it on the payment page with the slip reference.
            The refund counts on the day it is made on the machine.
          </p>
          {/* v15 2026-10-17: the payment page lists it with its record action straight away. */}
          <Link to={paymentDetail}>Record the card machine refund</Link>
        </div>
      ) : null}
      {outcome.kind === "Sent" ? (
        <div role="status">
          <p>
            {outcome.unknown
              ? "Approved, but sending was not confirmed. Retry sending: the same refund is reused and the customer is never refunded twice."
              : outcome.progress === "Refunded"
                ? "Refunded to the customer's original payment method."
                : outcome.progress === "StillPending"
                  ? "Sent — the card provider has not answered yet. The amount stays set aside until it answers; open the payment to check its answer."
                  : outcome.progress === "Sent"
                    ? "Sent — waiting for the card provider's answer."
                    : outcome.progress === "NotSent"
                      ? "Approved, but the refund has not been sent yet. Retry sending: the same refund is reused and the customer is never refunded twice."
                      : "Approved. Sending the refund to the card provider…"}
          </p>
          {outcome.progress === "StillPending" ? (
            <Link to={paymentPage}>Open the payment to check its answer</Link>
          ) : null}
          <button type="button" onClick={onChanged}>
            Refresh list
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * WP-2423 Q5 (Section 88 APPROVAL-INBOX, /app/approvals): refunds at the selected Store that need
 * an Owner/Finance approval. Approval happens in person: both people confirm it is them with
 * their authenticator code (valid 15 minutes), then the refund is sent at once.
 */
export function RefundApprovalsPage({
  csrf,
  storeLabel,
  fetcher,
}: {
  readonly csrf: string;
  readonly storeLabel: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useRef(createRefundApprovalClient(fetcher ?? fetch));
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"Loading" | "Ready" | "Denied" | "Unavailable">("Loading");
  const [refresh, setRefresh] = useState(0);
  // The signed-in member's verification, read once from the server and shared by every card.
  const [viewerVerifiedUntil, setViewerVerifiedUntil] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client.current
      .stepUpStatus(controller.signal)
      .then((until) => {
        if (!controller.signal.aborted) setViewerVerifiedUntil(until);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [refresh]);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState("Loading");
    void client.current
      .approvals(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setView(value);
        setState("Ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState(
          error instanceof RefundApprovalClientError && error.code === "Denied"
            ? "Denied"
            : "Unavailable",
        );
      });
    return () => controller.abort();
  }, [refresh]);
  return (
    <WorkspacePage
      title="Approvals"
      meta={storeLabel}
      actions={
        <button type="button" disabled={state === "Loading"} onClick={reload}>
          Refresh
        </button>
      }
    >
      <section aria-labelledby="refund-approvals-heading" data-screen-id="APPROVAL-INBOX">
        <h2 id="refund-approvals-heading">Refunds awaiting approval</h2>
        <p>
          Refunds above $100 for an order, from an earlier business day or more than 24 hours after
          payment need an owner or finance member who did not ask for them. Approve in person: both
          of you confirm with your authenticator code, then the refund is sent.
        </p>
        {state === "Loading" ? (
          <StatePanel heading="Loading refunds" status>
            <p>Checking refunds awaiting approval…</p>
          </StatePanel>
        ) : state === "Denied" ? (
          <StatePanel heading="Not available for your role" tone="error" status>
            <p>Only staff who may request or approve refunds can see this list.</p>
          </StatePanel>
        ) : state === "Unavailable" ? (
          <StatePanel heading="Refunds could not be loaded" tone="error" status>
            <p>Check your connection, then refresh.</p>
          </StatePanel>
        ) : view && view.entries.length === 0 ? (
          <StatePanel heading="Nothing to approve" status>
            <p>No refund at this store is waiting for approval.</p>
          </StatePanel>
        ) : view ? (
          <>
            <p>
              Last checked <SourceTime instant={view.observedAt} />.
            </p>
            <ul className="refund-approval-list">
              {view.entries.map((entry) => (
                <ApprovalCard
                  key={entry.requestReference + ":" + (entry.approvalReference ?? "")}
                  entry={entry}
                  csrf={csrf}
                  viewerVerifiedUntil={viewerVerifiedUntil}
                  onViewerVerified={setViewerVerifiedUntil}
                  onChanged={reload}
                  fetcher={fetcher}
                  soleOperator={view.soleOperator}
                />
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <SoleOperatorSection
        key={refresh}
        csrf={csrf}
        fetcher={fetcher}
        onChanged={reload}
        verifiedUntil={viewerVerifiedUntil}
        onVerified={setViewerVerifiedUntil}
      />
    </WorkspacePage>
  );
}

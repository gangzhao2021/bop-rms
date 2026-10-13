import { useCallback, useEffect, useRef, useState } from "react";
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

type View = Awaited<ReturnType<ReturnType<typeof createRefundApprovalClient>["approvals"]>>;
type Outcome =
  | { readonly kind: "Idle" }
  | { readonly kind: "Busy" }
  | { readonly kind: "Sent"; readonly unknown: boolean }
  | { readonly kind: "Declined"; readonly declinedAt: string }
  | { readonly kind: "Failed"; readonly message: string; readonly retry: boolean };

const person = (entry: RefundApprovalEntry) =>
  entry.requestedByYou ? "You" : (entry.requesterName ?? "The staff member who asked");

/** One refund awaiting approval: who asked, why, and the in-person approval that sends it. */
function ApprovalCard({
  entry,
  csrf,
  approverVerifiedUntil,
  onApproverVerified,
  onChanged,
  fetcher,
}: {
  readonly entry: RefundApprovalEntry;
  readonly csrf: string;
  readonly approverVerifiedUntil: string | null;
  readonly onApproverVerified: (validUntil: string) => void;
  readonly onChanged: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useRef(createRefundApprovalClient(fetcher ?? fetch));
  // One approval identity per card: a retry reuses it, so the refund is never sent twice.
  const approvalReference = useRef(entry.approvalReference ?? serviceOperationReference());
  const pending = useRef<AbortController | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "Idle" });
  const [requesterVerifiedUntil, setRequesterVerifiedUntil] = useState(
    entry.requesterVerifiedUntil,
  );
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
        },
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setOutcome({ kind: "Declined", declinedAt: result.declinedAt });
    } catch (error) {
      if (controller.signal.aborted) return;
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
        },
        csrf,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setOutcome({
        kind: "Sent",
        unknown: result.payments.some((payment) => payment.state === "ResultUnknown"),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
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
              : outcome.kind === "Sent"
                ? outcome.unknown
                  ? "Approved — sending result unknown"
                  : "Approved — refund sent"
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
      {entry.requestedByYou && outcome.kind !== "Sent" ? (
        <StepUpVerification
          purpose="RefundRequest"
          csrf={csrf}
          verifiedUntil={requesterVerifiedUntil}
          onVerified={setRequesterVerifiedUntil}
          label="Verify for the owner's approval"
          fetcher={fetcher}
        />
      ) : null}
      {entry.canApprove &&
      outcome.kind !== "Declined" &&
      !(outcome.kind === "Sent" && !outcome.unknown) ? (
        <div className="card-actions">
          <StepUpVerification
            purpose="RefundApproval"
            csrf={csrf}
            verifiedUntil={approverVerifiedUntil}
            onVerified={onApproverVerified}
            label="Verify to approve"
            fetcher={fetcher}
          />
          <button
            type="button"
            data-variant="primary"
            disabled={busy || !approverCurrent}
            onClick={() => void approve()}
          >
            {busy
              ? "Approving and sending…"
              : outcome.kind === "Sent"
                ? "Retry sending the same refund"
                : outcome.kind === "Failed" && outcome.retry
                  ? "Retry same approval"
                  : entry.state === "Approved"
                    ? "Send approved refund"
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
          <label htmlFor={"decline-reason-" + entry.requestReference}>Decline reason</label>
          <select
            id={"decline-reason-" + entry.requestReference}
            required
            value={declineReason}
            disabled={busy}
            onChange={(event) => setDeclineReason(event.currentTarget.value as DeclineReason | "")}
          >
            <option value="">Select a reason</option>
            {declineReasons.map((code) => (
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
            Decline refund
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
      {outcome.kind === "Failed" ? <p role="alert">{outcome.message}</p> : null}
      {outcome.kind === "Sent" ? (
        <div role="status">
          <p>
            {outcome.unknown
              ? "Approved, but the payment provider's answer was not received. Retry sending: the same refund is reused and the customer is never refunded twice."
              : "Approved and sent to the customer's original payment method. The provider's result is recorded automatically and shown on the order's payment page."}
          </p>
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
  const [approverVerifiedUntil, setApproverVerifiedUntil] = useState<string | null>(null);
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
          Refunds above CAD 100 for an order, from an earlier business day or more than 24 hours
          after payment need an owner or finance member who did not ask for them. Approve in person:
          both of you confirm with your authenticator code, then the refund is sent.
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
                  approverVerifiedUntil={approverVerifiedUntil}
                  onApproverVerified={setApproverVerifiedUntil}
                  onChanged={reload}
                  fetcher={fetcher}
                />
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </WorkspacePage>
  );
}

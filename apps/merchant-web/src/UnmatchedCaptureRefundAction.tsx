import { useRef, useState } from "react";
import { serviceOperationReference } from "./service-control-client.js";

export interface UnmatchedCaptureRefundView {
  readonly status: "NotApplicable" | "Unrefunded" | "Requested" | "Approved" | "Refunded";
  readonly amountMinor?: string;
  readonly currencyCode?: "CAD";
  readonly capturedAt?: string;
  readonly requestedAt?: string | null;
  readonly requestedByYou?: boolean;
  readonly approvedAt?: string | null;
  readonly refundedAt?: string | null;
  readonly providerResult?: "Unknown";
}
type Failure = "Denied" | "SameApprover" | "Changed" | "Unknown";

/** Whole-cent CAD from integer minor units; never binary floating point. */
export function formatMinorCad(amountMinor: string): string {
  if (!/^[0-9]{1,12}$/u.test(amountMinor)) return "CAD amount unavailable";
  const padded = amountMinor.padStart(3, "0");
  return "CAD " + String(BigInt(padded.slice(0, -2))) + "." + padded.slice(-2);
}
export function unmatchedRefundFailure(status: number, error: unknown): Failure {
  return status === 403
    ? "Denied"
    : status === 422 && error === "UNMATCHED_REFUND_SAME_APPROVER"
      ? "SameApprover"
      : status === 409 || status === 404
        ? "Changed"
        : "Unknown";
}
/** The next step this person may take, from the server's view. */
export function unmatchedRefundNextStep(view: UnmatchedCaptureRefundView) {
  switch (view.status) {
    case "Unrefunded":
      return "Request" as const;
    case "Requested":
      return view.requestedByYou ? ("AwaitApproval" as const) : ("Approve" as const);
    case "Approved":
      return "Resend" as const;
    default:
      return "None" as const;
  }
}

/**
 * WP-2423 P6: a charge the payment Provider captured that matches no payment or Order of this
 * Store is refunded in full: a manager requests it and a different person approves and sends it.
 * Each action keeps its idempotency key until a definite answer, so a lost response is retried.
 */
export function UnmatchedCaptureRefundAction({
  exceptionReference,
  csrf,
  readOnly,
  fetcher = fetch,
}: {
  readonly exceptionReference: string;
  readonly csrf: string;
  readonly readOnly: boolean;
  readonly fetcher?: typeof fetch;
}) {
  const [view, setView] = useState<UnmatchedCaptureRefundView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const intent = useRef<{ step: string; idempotencyReference: string } | null>(null);
  const post = async (step: "status" | "request" | "approve") => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    if (step !== "status" && intent.current?.step !== step)
      intent.current = { step, idempotencyReference: serviceOperationReference() };
    try {
      const response = await fetcher("/merchant/payments/unmatched-capture-refund/" + step, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(
          step === "status"
            ? { exceptionReference }
            : { exceptionReference, idempotencyReference: intent.current?.idempotencyReference },
        ),
      });
      const body = (await response.json().catch(() => null)) as
        (UnmatchedCaptureRefundView & { error?: unknown }) | null;
      if (!response.ok || body === null) {
        const next = unmatchedRefundFailure(response.status, body?.error);
        setFailure(next);
        if (next !== "Unknown") intent.current = null;
        return;
      }
      if (step !== "status" && body.providerResult !== "Unknown") intent.current = null;
      setConfirmed(false);
      setView(body);
    } catch {
      setFailure("Unknown");
    } finally {
      setBusy(false);
    }
  };
  const failureText: Record<Failure, string> = {
    Denied: "You do not have refund authority for this Store.",
    SameApprover: "The person who requested this refund cannot approve it. Ask another manager.",
    Changed: "This refund changed. Review it again.",
    Unknown: "Result unknown. Retry the same action to recover its result.",
  };
  if (view === null || view.status === "NotApplicable")
    return (
      <section className="unmatched-refund" aria-label="Unmatched charge refund">
        <button disabled={busy} onClick={() => void post("status")}>
          Review unmatched charge
        </button>
        {view?.status === "NotApplicable" ? (
          <p>No Provider charge without a matching order is recorded for this exception.</p>
        ) : null}
        <p role="status">{failure ? failureText[failure] : busy ? "Loading…" : null}</p>
      </section>
    );
  const amount = formatMinorCad(view.amountMinor ?? "");
  const next = unmatchedRefundNextStep(view);
  return (
    <section className="unmatched-refund" aria-label="Unmatched charge refund">
      <dl>
        <div>
          <dt>Charged by the payment Provider</dt>
          <dd>
            {amount} · {view.capturedAt}
          </dd>
        </div>
        <div>
          <dt>Refund</dt>
          <dd>
            {view.status === "Refunded"
              ? `Refunded in full · ${view.refundedAt}`
              : view.status === "Approved"
                ? `Approved · ${view.approvedAt} · Provider result not yet confirmed`
                : view.status === "Requested"
                  ? `Requested · ${view.requestedAt} · awaiting approval by another manager`
                  : "Not requested"}
          </dd>
        </div>
      </dl>
      {next === "Request" ? (
        <>
          <p>
            No order or payment of this Store matches this charge. Refund it in full to the card it
            came from. Another manager must approve before it is sent.
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={readOnly}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            I checked that no order of this Store was paid by this charge
          </label>
          <button disabled={readOnly || busy || !confirmed} onClick={() => void post("request")}>
            {failure === "Unknown" ? "Retry same request" : `Request refund of ${amount}`}
          </button>
        </>
      ) : null}
      {next === "AwaitApproval" ? (
        <p>You requested this refund. Another manager must approve and send it.</p>
      ) : null}
      {next === "Approve" || next === "Resend" ? (
        <>
          {next === "Approve" ? (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={readOnly}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
              I approve refunding {amount} in full to the original card
            </label>
          ) : null}
          <button
            disabled={readOnly || busy || (next === "Approve" && !confirmed)}
            onClick={() => void post("approve")}
          >
            {next === "Resend" || failure === "Unknown"
              ? "Retry sending the approved refund"
              : "Approve and send refund"}
          </button>
        </>
      ) : null}
      <p role="status">
        {failure
          ? failureText[failure]
          : busy
            ? "Working…"
            : view.providerResult === "Unknown"
              ? "Approved. The Provider did not confirm yet; retry sending to recover its result."
              : null}
      </p>
    </section>
  );
}

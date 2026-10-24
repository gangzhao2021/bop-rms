import { t } from "./i18n/i18n.js";
import { useRef, useState } from "react";
import { orderMoney } from "./order-money.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import {
  FULL_SIGN_IN_REQUIRED,
  isFullSignInRequired,
  type FullSignInRequired,
} from "./full-sign-in.js";
import { serviceOperationReference } from "./service-control-client.js";
import { SourceTime } from "./StoreTime.js";

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
type Failure = "Denied" | FullSignInRequired | "SameApprover" | "Changed" | "Unknown";

/** Whole-cent CAD from integer minor units in the app's one money format; never floating point. */
export function formatMinorCad(amountMinor: string): string {
  if (!/^[0-9]{1,12}$/u.test(amountMinor)) return t("Amount unavailable");
  return orderMoney({ amountMinor: String(BigInt(amountMinor)), currencyCode: "CAD" });
}
export function unmatchedRefundFailure(status: number, error: unknown): Failure {
  if (isFullSignInRequired(status, { error })) return FULL_SIGN_IN_REQUIRED;
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
        // Unknown, or a PIN sign-in to confirm first: a retry keeps the same idempotency key.
        if (next !== "Unknown" && next !== FULL_SIGN_IN_REQUIRED) intent.current = null;
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
  const failureText: Record<Exclude<Failure, FullSignInRequired>, string> = {
    Denied: t("You do not have refund authority for this store."),
    SameApprover: t("The person who requested this refund cannot approve it. Ask another manager."),
    Changed: t("This refund changed. Review it again."),
    Unknown: t("Result unknown. Retry the same action to recover its result."),
  };
  if (view === null || view.status === "NotApplicable")
    return (
      <section className="unmatched-refund" aria-label={t("Unmatched charge refund")}>
        <button disabled={busy} onClick={() => void post("status")}>
          {t("Review unmatched charge")}
        </button>
        {view?.status === "NotApplicable" ? (
          <p>{t("No charge without a matching order is recorded for this difference.")}</p>
        ) : null}
        {failure === FULL_SIGN_IN_REQUIRED ? (
          <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
        ) : (
          <p role="status">{failure ? failureText[failure] : busy ? t("Loading…") : null}</p>
        )}
      </section>
    );
  const amount = formatMinorCad(view.amountMinor ?? "");
  const next = unmatchedRefundNextStep(view);
  return (
    <section className="unmatched-refund" aria-label={t("Unmatched charge refund")}>
      <dl>
        <div>
          <dt>{t("Charged by the payment provider")}</dt>
          <dd>
            {amount} · {view.capturedAt ? <SourceTime instant={view.capturedAt} /> : null}
          </dd>
        </div>
        <div>
          <dt>{t("Refund")}</dt>
          <dd>
            {view.status === "Refunded" ? (
              <>
                {t("Refunded in full ·")}{" "}
                {view.refundedAt ? <SourceTime instant={view.refundedAt} /> : null}
              </>
            ) : view.status === "Approved" ? (
              <>
                {t("Approved ·")}{" "}
                {view.approvedAt ? <SourceTime instant={view.approvedAt} /> : null}{" "}
                {t("· the payment provider has not confirmed it yet")}
              </>
            ) : view.status === "Requested" ? (
              <>
                {t("Requested ·")}{" "}
                {view.requestedAt ? <SourceTime instant={view.requestedAt} /> : null}{" "}
                {t("· awaiting approval by another manager")}
              </>
            ) : (
              t("Not requested")
            )}
          </dd>
        </div>
      </dl>
      {next === "Request" ? (
        <>
          <p>
            {t(
              "No order or payment of this store matches this charge. Refund it in full to the card it came from. Another manager must approve before it is sent.",
            )}
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={readOnly}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
            {t("I checked that no order of this store was paid by this charge")}
          </label>
          <button disabled={readOnly || busy || !confirmed} onClick={() => void post("request")}>
            {failure === "Unknown"
              ? t("Retry same request")
              : t("Request refund of {amount}", { amount: amount })}
          </button>
        </>
      ) : null}
      {next === "AwaitApproval" ? (
        <p>{t("You requested this refund. Another manager must approve and send it.")}</p>
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
              {t("I approve refunding {amount} in full to the original card", { amount: amount })}
            </label>
          ) : null}
          <button
            disabled={readOnly || busy || (next === "Approve" && !confirmed)}
            onClick={() => void post("approve")}
          >
            {next === "Resend" || failure === "Unknown"
              ? t("Retry sending the approved refund")
              : t("Approve and send refund")}
          </button>
        </>
      ) : null}
      {failure === FULL_SIGN_IN_REQUIRED ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : null}
      <p role="status">
        {failure === FULL_SIGN_IN_REQUIRED
          ? null
          : failure
            ? failureText[failure]
            : busy
              ? t("Working…")
              : view.providerResult === "Unknown"
                ? t(
                    "Approved. The payment provider has not confirmed it yet; send it again to get its answer.",
                  )
                : null}
      </p>
    </section>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import {
  createRefundApprovalClient,
  StepUpError,
  type StepUpFailure,
  type StepUpPurpose,
} from "./refund-approval-client.js";
import { SourceTime } from "./StoreTime.js";

const failureMessage = (error: StepUpError): string => {
  const messages: Record<StepUpFailure, string> = {
    CodeRejected:
      "That code did not match. Check the six-digit code in your authenticator app and try again.",
    CodeAlreadyUsed: "That code was already used. Wait for the next code and enter it.",
    TooManyAttempts:
      error.retryAfterSeconds === null
        ? "Too many wrong codes. Wait a few minutes before trying again."
        : `Too many wrong codes. Try again in ${Math.ceil(error.retryAfterSeconds / 60)} minute(s).`,
    NotSetUp:
      "Verification is not set up for you yet. Ask the store owner to add your authenticator app.",
    Denied: "Your session ended or does not allow this. Sign in again, then verify.",
    Unavailable: "The code could not be checked. Check your connection and try again.",
  };
  return messages[error.code];
};

/**
 * WP-2423 Q5: the signed-in staff member confirms it is them with the six-digit code from their
 * authenticator app. A verification stays valid for 15 minutes for refund requests and approvals.
 * The code is cleared as soon as it is sent and is never shown again.
 */
export function StepUpVerification({
  purpose,
  csrf,
  verifiedUntil,
  onVerified,
  label,
  fetcher,
  loadServerStatus = true,
  explanation,
}: {
  readonly purpose: StepUpPurpose;
  readonly csrf: string;
  /** Current verification end, if this page already holds one. */
  readonly verifiedUntil: string | null;
  readonly onVerified: (validUntil: string) => void;
  readonly label: string;
  readonly fetcher?: typeof fetch | undefined;
  /** Read the server's current verification on first display (off when the page shares it). */
  readonly loadServerStatus?: boolean;
  /** What a verification allows, when it is not the default refunds and approvals wording. */
  readonly explanation?: string | undefined;
}) {
  const client = useRef(createRefundApprovalClient(fetcher ?? fetch));
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => () => pending.current?.abort(), []);
  // Start from the server's own record, so every page shows the same verification.
  useEffect(() => {
    if (verifiedUntil !== null || !loadServerStatus) return;
    const controller = new AbortController();
    void client.current
      .stepUpStatus(controller.signal)
      .then((until) => {
        if (!controller.signal.aborted && until !== null && Date.parse(until) > Date.now())
          onVerified(until);
      })
      .catch(() => undefined);
    return () => controller.abort();
    // Only on first display; later changes come from this component's own verification.
  }, []);
  useEffect(() => {
    if (verifiedUntil === null) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [verifiedUntil]);
  const current = verifiedUntil !== null && Date.parse(verifiedUntil) > now;
  const submit = async () => {
    if (busy || !/^[0-9]{6}$/u.test(code)) {
      setMessage("Enter the six-digit code from your authenticator app.");
      return;
    }
    const sent = code;
    setCode("");
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const result = await client.current.stepUp(purpose, sent, csrf, controller.signal);
      if (controller.signal.aborted) return;
      dialog.current?.close();
      setNow(Date.now());
      onVerified(result.validUntil);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(
        failureMessage(error instanceof StepUpError ? error : new StepUpError("Unavailable")),
      );
      input.current?.focus();
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // Unique per instance: several cards on one page each label their own code field.
  const titleId = "step-up-" + useId().replace(/[^A-Za-z0-9_-]/gu, "");
  return (
    <div className="step-up-verification">
      <p role="status">
        {current ? (
          <>
            Verified until <SourceTime instant={verifiedUntil} />.
          </>
        ) : (
          "Confirm it is you with the code from your authenticator app."
        )}
      </p>
      {current ? null : (
        <button
          type="button"
          onClick={() => {
            setMessage("");
            dialog.current?.showModal();
            input.current?.focus();
          }}
        >
          {label}
        </button>
      )}
      <dialog
        ref={dialog}
        className="step-up-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => setCode("")}
      >
        <h2 id={titleId}>Confirm it is you</h2>
        <p>
          {explanation ??
            "Open your authenticator app and enter the six-digit code shown for this store. Codes change every 30 seconds. After you verify, approvals and refunds can go ahead for 15 minutes."}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={titleId + "-code"}>Six-digit code</label>
          <input
            ref={input}
            id={titleId + "-code"}
            name="one-time-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            disabled={busy}
            onChange={(event) => setCode(event.currentTarget.value.replace(/[^0-9]/gu, ""))}
          />
          <div className="card-actions">
            <button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Verify"}
            </button>
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
          <p role="alert">{message}</p>
        </form>
      </dialog>
    </div>
  );
}

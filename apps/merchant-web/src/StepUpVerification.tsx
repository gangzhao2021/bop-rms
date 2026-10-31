import { t } from "./i18n/i18n.js";
import { useEffect, useId, useRef, useState } from "react";
import {
  createRefundApprovalClient,
  StepUpError,
  type StepUpFailure,
  type StepUpMethod,
  type StepUpPurpose,
} from "./refund-approval-client.js";
import {
  openStepUpSignIn,
  STEP_UP_SIGN_IN_EXPLANATION,
  stepUpResultText,
  stepUpStartPath,
  subscribeStepUpResult,
  type ChannelFactory,
  type StepUpResult,
  type StepUpWindow,
} from "./step-up-sign-in.js";
import { SourceTime } from "./StoreTime.js";

const failureMessage = (error: StepUpError): string => {
  const messages: Record<StepUpFailure, string> = {
    CodeRejected: t(
      "That code did not match. Check the six-digit code in your authenticator app and try again.",
    ),
    CodeAlreadyUsed: t("That code was already used. Wait for the next code and enter it."),
    TooManyAttempts:
      error.retryAfterSeconds === null
        ? t("Too many wrong codes. Wait a few minutes before trying again.")
        : t("Too many wrong codes. Try again in {value} minute(s).", {
            value: Math.ceil(error.retryAfterSeconds / 60),
          }),
    NotSetUp: t(
      "Verification is not set up for you yet. Ask the store owner to add your authenticator app.",
    ),
    Denied: t("Your session ended or does not allow this. Sign in again, then verify."),
    Unavailable: t("The code could not be checked. Check your connection and try again."),
  };
  return messages[error.code];
};

export interface StepUpExplanation {
  readonly code: string;
  readonly signIn: string;
}
export const STEP_UP_CODE_EXPLANATION = t(
  "Open your authenticator app and enter the six-digit code shown for this store. Codes change every 30 seconds. After you verify, approvals and refunds can go ahead for 15 minutes.",
);
/** The dialog text for how this sign-in confirms it is the person (never a code in sign-in mode). */
export function stepUpExplanationText(
  method: StepUpMethod,
  explanation: StepUpExplanation | undefined,
): string {
  return method === "SignIn"
    ? (explanation?.signIn ?? STEP_UP_SIGN_IN_EXPLANATION)
    : (explanation?.code ?? STEP_UP_CODE_EXPLANATION);
}

const currentPath = () =>
  typeof window === "undefined" ? "/app" : window.location.pathname + window.location.search;

/**
 * WP-2423 Q5: the signed-in staff member confirms it is them with the six-digit code from their
 * authenticator app. A verification stays valid for 15 minutes for refund requests and approvals.
 * The code is cleared as soon as it is sent and is never shown again.
 *
 * WP-2423 DEC-COGNITO-STORE-STAFF: a staff member signed in with their own account confirms it by
 * signing in again (password and authenticator app) in a small window instead ("SignIn"); the
 * server's step-up read says which. No code is entered on this page then.
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
  hint = true,
  channel,
  openWindow,
  mode = "inline",
  openRef,
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
  /**
   * What a verification allows, when it is not the default refunds and approvals wording: one
   * text for each way of confirming (the code on this page, or signing in again).
   */
  readonly explanation?: StepUpExplanation | undefined;
  /**
   * Show "Confirm it is you with the code from your authenticator app." before verifying. Off
   * where the text around the button already says so, so the hint is never shown twice.
   */
  readonly hint?: boolean;
  /** Test seam: the BroadcastChannel the sign-in window answers on (null: none). */
  readonly channel?: ChannelFactory | null | undefined;
  /** Test seam: where the sign-in window is opened. */
  readonly openWindow?: StepUpWindow | undefined;
  /**
   * Owner 2026-10-25: "dialog" renders only the dialog, opened through `openRef` by the action
   * that needs a verification (no separate "Verify" button or status line on the page).
   */
  readonly mode?: "inline" | "dialog";
  readonly openRef?: { current: (() => void) | null } | undefined;
}) {
  const client = useRef(createRefundApprovalClient(fetcher ?? fetch));
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // How this sign-in confirms it is the person; null until the server has said.
  const [method, setMethod] = useState<StepUpMethod | null>(null);
  const [checkingMethod, setCheckingMethod] = useState(false);
  // The sign-in window is open and this page waits for its answer.
  const [waiting, setWaiting] = useState(false);
  const latestVerified = useRef(onVerified);
  latestVerified.current = onVerified;
  useEffect(() => () => pending.current?.abort(), []);
  // Start from the server's own record, so every page shows the same verification.
  useEffect(() => {
    if (!loadServerStatus) return;
    const controller = new AbortController();
    void client.current
      .stepUpState(controller.signal)
      .then((state) => {
        if (controller.signal.aborted) return;
        setMethod(state.method);
        if (
          verifiedUntil === null &&
          state.validUntil !== null &&
          Date.parse(state.validUntil) > Date.now()
        )
          onVerified(state.validUntil);
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
  // While the sign-in window is open: its answer arrives on the channel; where there is no
  // channel, coming back to this window re-reads the server's verification once per return.
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const recheck = async (result: StepUpResult | null) => {
      if (result === "cancelled" || result === "failed" || result === "unavailable") {
        setWaiting(false);
        setMessage(stepUpResultText[result]);
        return;
      }
      try {
        const state = await client.current.stepUpState();
        if (!active) return;
        if (state.validUntil !== null && Date.parse(state.validUntil) > Date.now()) {
          setWaiting(false);
          setMessage("");
          dialog.current?.close();
          setNow(Date.now());
          latestVerified.current(state.validUntil);
        } else if (result === "verified") {
          setWaiting(false);
          setMessage(stepUpResultText.failed);
        }
      } catch {
        if (active && result === "verified") {
          setWaiting(false);
          setMessage(t("We couldn't check your sign-in. Check your connection and try again."));
        }
      }
    };
    const unsubscribe = subscribeStepUpResult((result) => void recheck(result), channel);
    const onFocus = () => void recheck(null);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [waiting, channel]);
  const current = verifiedUntil !== null && Date.parse(verifiedUntil) > now;
  const submit = async () => {
    if (busy || !/^[0-9]{6}$/u.test(code)) {
      setMessage(t("Enter the six-digit code from your authenticator app."));
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
  const open = () => {
    setMessage("");
    dialog.current?.showModal();
    if (method !== null) {
      if (method === "Code") input.current?.focus();
      return;
    }
    // The server says how to confirm before a code can be entered; an older server, or one that
    // cannot be reached, keeps the authenticator code.
    setCheckingMethod(true);
    void client.current
      .stepUpState()
      .then(
        (state) => state.method,
        () => "Code" as const,
      )
      .then((found) => {
        setMethod(found);
        setCheckingMethod(false);
        if (found === "Code") setTimeout(() => input.current?.focus(), 0);
      });
  };
  if (openRef) openRef.current = open;
  const startSignIn = () => {
    setMessage("");
    setWaiting(true);
    openStepUpSignIn(stepUpStartPath(purpose, currentPath()), openWindow ?? window);
  };
  // Unique per instance: several cards on one page each label their own code field.
  const titleId = "step-up-" + useId().replace(/[^A-Za-z0-9_-]/gu, "");
  const signIn = method === "SignIn";
  return (
    <div className="step-up-verification">
      {mode === "inline" && (current || hint) ? (
        <p role="status">
          {current ? (
            <>
              {t("Verified until")} <SourceTime instant={verifiedUntil} />.
            </>
          ) : signIn ? (
            t("Confirm it is you by signing in again.")
          ) : (
            t("Confirm it is you with the code from your authenticator app.")
          )}
        </p>
      ) : null}
      {current || mode === "dialog" ? null : (
        <button type="button" onClick={open}>
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
        onClose={() => {
          setCode("");
          setWaiting(false);
        }}
      >
        <h2 id={titleId}>{t("Confirm it is you")}</h2>
        {signIn ? (
          <>
            <p>{stepUpExplanationText("SignIn", explanation)}</p>
            {waiting ? (
              <p role="status">
                {t("Finish signing in in the new window. This page continues when you are done.")}
              </p>
            ) : null}
            <div className="card-actions">
              <button type="button" onClick={startSignIn}>
                {t("Continue to sign in")}
              </button>
              <button type="button" onClick={() => dialog.current?.close()}>
                {t("Cancel")}
              </button>
            </div>
            <p role="alert">{message}</p>
          </>
        ) : (
          <>
            <p>{stepUpExplanationText("Code", explanation)}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor={titleId + "-code"}>{t("Six-digit code")}</label>
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
                disabled={busy || checkingMethod}
                onChange={(event) => setCode(event.currentTarget.value.replace(/[^0-9]/gu, ""))}
              />
              <div className="card-actions">
                <button type="submit" disabled={busy || checkingMethod || code.length !== 6}>
                  {busy ? t("Checking…") : t("Verify")}
                </button>
                <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>
                  {t("Cancel")}
                </button>
              </div>
              <p role="alert">
                {checkingMethod ? t("Checking how to confirm it is you…") : message}
              </p>
            </form>
          </>
        )}
      </dialog>
    </div>
  );
}

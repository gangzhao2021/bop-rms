import { t } from "../i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClockTime } from "../journey/format.js";
import {
  createHttpDiningInvitationClient,
  DiningInvitationClientError,
  type DiningInvitationClient,
} from "./dining-invitation-client.js";

/**
 * WP-2423 DEC-DINING-GUEST-INVITATION (Handoff 6.11, 87.4.1): the guest who joined the table first
 * (the table's host) makes a one-time code for the next person joining, instead of waiting for
 * staff. Shown only to that guest. The code lives in memory only; it is never stored or put in
 * the address.
 */
export type DiningInvitationState =
  | { readonly status: "hidden" }
  | { readonly status: "ready" }
  | { readonly status: "issuing" }
  | {
      readonly status: "issued";
      readonly code: string;
      readonly expiresAt: string;
      /** The request that made this code; the phone asks about the code by it, never by the code. */
      readonly operationReference?: string;
    }
  | { readonly status: "expired" }
  /** A guest joined with the code. */
  | { readonly status: "used" }
  /** Staff or another phone of the host made a newer code, so this one stopped working. */
  | { readonly status: "replaced" }
  /** This guest can no longer invite (table closing, host changed); the code stopped working. */
  | { readonly status: "ended" }
  | { readonly status: "lost" }
  | { readonly status: "not-host" }
  | { readonly status: "table-changed" }
  | { readonly status: "too-many"; readonly retryAt: string | null }
  | { readonly status: "failed"; readonly offline: boolean };

/** How often the host's phone checks the code it is showing while the page is visible. */
export const diningInvitationCheckIntervalMs = 4_000;

export function DiningInvitationPanel({
  client: provided,
}: {
  readonly client?: DiningInvitationClient | undefined;
}) {
  const [client] = useState(() => provided ?? createHttpDiningInvitationClient());
  const [state, setState] = useState<DiningInvitationState>({ status: "hidden" });
  // The request key of an attempt whose result is not known yet; a retry repeats it.
  const pending = useRef<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    client.canInvite(controller.signal).then(
      (allowed) => {
        if (!controller.signal.aborted) setState({ status: allowed ? "ready" : "hidden" });
      },
      // Not the host, not joined or not reachable: there is nothing this guest can do here.
      () => undefined,
    );
    return () => controller.abort();
  }, [client]);
  useEffect(() => {
    if (state.status !== "issued") return;
    const remaining = Date.parse(state.expiresAt) - Date.now();
    const timer = window.setTimeout(
      () => setState({ status: "expired" }),
      Math.max(0, Math.min(remaining, 2_147_000_000)),
    );
    return () => window.clearTimeout(timer);
  }, [state]);
  // v15 42e95248: a code shown here can stop working elsewhere (a guest joined with it, staff or
  // another phone made a newer one). Check every few seconds while it is shown and the page is
  // visible, and as soon as the page is shown again, so the next guest is not told a dead code.
  const issuedReference = state.status === "issued" ? (state.operationReference ?? null) : null;
  useEffect(() => {
    if (issuedReference === null) return;
    const operation = issuedReference;
    let stopped = false;
    let inFlight: AbortController | null = null;
    const check = () => {
      if (stopped || inFlight !== null || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      inFlight = controller;
      client.codeState(operation, controller.signal).then(
        (result) => {
          inFlight = null;
          if (stopped) return;
          const next: DiningInvitationState | null = !result.canInvite
            ? { status: "ended" }
            : result.codeState === "Used"
              ? { status: "used" }
              : result.codeState === "Replaced"
                ? { status: "replaced" }
                : result.codeState === "Expired"
                  ? { status: "expired" }
                  : null;
          if (next === null) return;
          setState((current) =>
            current.status === "issued" && current.operationReference === operation
              ? next
              : current,
          );
        },
        // Offline or briefly unreachable: keep showing the code and check again shortly.
        () => {
          inFlight = null;
        },
      );
    };
    const timer = window.setInterval(check, diningInvitationCheckIntervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      inFlight?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
    };
  }, [client, issuedReference]);
  const make = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    const operation = pending.current ?? client.newOperationReference();
    pending.current = operation;
    setState({ status: "issuing" });
    client
      .issue(operation)
      .then(
        (result) => {
          pending.current = null;
          if (result.status === "Issued")
            setState({
              status: "issued",
              code: result.code,
              expiresAt: result.expiresAt,
              operationReference: operation,
            });
          else if (result.status === "Lost") setState({ status: "lost" });
          else if (result.status === "NotHost") setState({ status: "not-host" });
          else if (result.status === "TableChanged") setState({ status: "table-changed" });
          else setState({ status: "too-many", retryAt: result.retryAt });
        },
        (error: unknown) => {
          if (error instanceof DiningInvitationClientError && error.code === "not-joined") {
            pending.current = null;
            setState({ status: "not-host" });
            return;
          }
          setState({
            status: "failed",
            offline: typeof navigator !== "undefined" && navigator.onLine === false,
          });
        },
      )
      .finally(() => {
        busy.current = false;
      });
  }, [client]);
  return <DiningInvitationView state={state} onMake={make} />;
}

/** "482913" read and shown in two groups of three: "482 913". */
function grouped(code: string): string {
  return code.slice(0, 3) + " " + code.slice(3);
}

export function DiningInvitationView({
  state,
  onMake,
}: {
  readonly state: DiningInvitationState;
  readonly onMake: () => void;
}) {
  if (state.status === "hidden") return null;
  const heading = <h2 id="dining-invitation-heading">{t("Invite someone at your table")}</h2>;
  const makeButton = (label: string, secondary = false) => (
    <button
      className={
        secondary
          ? "dining-invitation__action dining-invitation__action--secondary"
          : "dining-invitation__action"
      }
      type="button"
      onClick={onMake}
      disabled={state.status === "issuing"}
    >
      {label}
    </button>
  );
  return (
    <section
      className="order-status__card dining-invitation"
      aria-labelledby="dining-invitation-heading"
      aria-busy={state.status === "issuing"}
    >
      {heading}
      {state.status === "ready" || state.status === "issuing" ? (
        <>
          <p>
            {t(
              "Someone joining you? Make a code on this phone. They scan the QR code on the table, then enter the code to order with you.",
            )}
          </p>
          {makeButton(state.status === "issuing" ? t("Making a code…") : t("Make a code"))}
        </>
      ) : null}
      {state.status === "issued" ? (
        <>
          <p className="dining-invitation__code" role="status" aria-live="polite">
            <span className="dining-invitation__label">{t("Code")}</span>{" "}
            <span className="dining-invitation__digits" aria-hidden="true">
              {grouped(state.code)}
            </span>
            <span className="sr-only">{state.code.split("").join(" ")}</span>
          </p>
          <p>
            {t("Show this code to the person joining you. It works once and for 15 minutes (until")}{" "}
            {formatClockTime(state.expiresAt)}).
          </p>
          <p className="dining-invitation__note">
            {t("For someone else after them, make a new code. A new code replaces this one.")}
          </p>
          {makeButton(t("Make a new code"), true)}
        </>
      ) : null}
      {state.status === "expired" ? (
        <>
          <p role="status">
            {t("This code has expired. Make a new one if someone still needs to join.")}
          </p>
          {makeButton(t("Make a new code"))}
        </>
      ) : null}
      {state.status === "used" ? (
        <>
          <p role="status">
            {t("Someone joined with this code. For someone else, make another code.")}
          </p>
          {makeButton(t("Make another code"))}
        </>
      ) : null}
      {state.status === "replaced" ? (
        <>
          <p role="status">{t("This code was replaced. Make a new one.")}</p>
          {makeButton(t("Make a new code"))}
        </>
      ) : null}
      {state.status === "ended" ? (
        <p role="status">
          {t("This code no longer works. A staff member can give a code to someone joining.")}
        </p>
      ) : null}
      {state.status === "lost" ? (
        <>
          <p role="status">{t("We couldn’t show that code. Make a new one.")}</p>
          {makeButton(t("Make a new code"))}
        </>
      ) : null}
      {state.status === "not-host" ? (
        <p role="status">
          {t(
            "Only the person who joined this table first can make codes. A staff member can give you one.",
          )}
        </p>
      ) : null}
      {state.status === "table-changed" ? (
        <p role="status">
          {t("Your table was changed. Ask a staff member for a code for your new table.")}
        </p>
      ) : null}
      {state.status === "too-many" ? (
        <p role="status">
          {state.retryAt
            ? t(
                "You’ve made a lot of codes in the last few minutes. You can make another at {value1}, or ask a staff member for one.",
                { value1: formatClockTime(state.retryAt) },
              )
            : t(
                "You’ve made a lot of codes in the last few minutes. Try again in a few minutes, or ask a staff member for one.",
              )}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <>
          <p role="alert">
            {state.offline
              ? t("You’re offline, so no code was made. Reconnect, then try again.")
              : t("We couldn’t make a code. Try again, or ask a staff member for one.")}
          </p>
          {makeButton(t("Try again"))}
        </>
      ) : null}
    </section>
  );
}

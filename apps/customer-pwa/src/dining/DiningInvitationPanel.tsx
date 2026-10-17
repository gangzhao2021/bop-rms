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
  | { readonly status: "issued"; readonly code: string; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "lost" }
  | { readonly status: "not-host" }
  | { readonly status: "table-changed" }
  | { readonly status: "too-many"; readonly retryAt: string | null }
  | { readonly status: "failed"; readonly offline: boolean };

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
            setState({ status: "issued", code: result.code, expiresAt: result.expiresAt });
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
  const heading = <h2 id="dining-invitation-heading">Invite someone at your table</h2>;
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
            Someone joining you? Make a code on this phone. They scan the QR code on the table, then
            enter the code to order with you.
          </p>
          {makeButton(state.status === "issuing" ? "Making a code…" : "Make a code")}
        </>
      ) : null}
      {state.status === "issued" ? (
        <>
          <p className="dining-invitation__code" role="status" aria-live="polite">
            <span className="dining-invitation__label">Code</span>{" "}
            <span className="dining-invitation__digits" aria-hidden="true">
              {grouped(state.code)}
            </span>
            <span className="sr-only">{state.code.split("").join(" ")}</span>
          </p>
          <p>
            Show this code to the person joining you. It works once and for 15 minutes (until{" "}
            {formatClockTime(state.expiresAt)}).
          </p>
          <p className="dining-invitation__note">
            For someone else after them, make a new code. A new code replaces this one.
          </p>
          {makeButton("Make a new code", true)}
        </>
      ) : null}
      {state.status === "expired" ? (
        <>
          <p role="status">This code has expired. Make a new one if someone still needs to join.</p>
          {makeButton("Make a new code")}
        </>
      ) : null}
      {state.status === "lost" ? (
        <>
          <p role="status">We couldn’t show that code. Make a new one.</p>
          {makeButton("Make a new code")}
        </>
      ) : null}
      {state.status === "not-host" ? (
        <p role="status">
          Only the person who joined this table first can make codes. A staff member can give you
          one.
        </p>
      ) : null}
      {state.status === "table-changed" ? (
        <p role="status">
          Your table was changed. Ask a staff member for a code for your new table.
        </p>
      ) : null}
      {state.status === "too-many" ? (
        <p role="status">
          {state.retryAt
            ? `You’ve made a lot of codes in the last few minutes. You can make another at ${formatClockTime(state.retryAt)}, or ask a staff member for one.`
            : "You’ve made a lot of codes in the last few minutes. Try again in a few minutes, or ask a staff member for one."}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <>
          <p role="alert">
            {state.offline
              ? "You’re offline, so no code was made. Reconnect, then try again."
              : "We couldn’t make a code. Try again, or ask a staff member for one."}
          </p>
          {makeButton("Try again")}
        </>
      ) : null}
    </section>
  );
}

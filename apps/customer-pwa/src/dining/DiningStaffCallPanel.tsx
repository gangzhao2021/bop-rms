import { t } from "../i18n/i18n.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClockTime } from "../journey/format.js";
import {
  createHttpDiningStaffCallClient,
  DiningStaffCallClientError,
  diningStaffCallReasons,
  type DiningStaffCallClient,
  type DiningStaffCallReason,
  type DiningStaffCallView,
} from "./dining-staff-call-client.js";

/**
 * WP-2423 Q28 DEC-DINING-STAFF-CALL: a guest at the table asks staff to come over. One open call
 * per table; any guest at the table sees it and may say it is no longer needed. Nothing is typed,
 * so no allergy or personal detail is recorded: staff ask at the table.
 */
export type DiningStaffCallState =
  | { readonly status: "hidden" }
  | { readonly status: "ready"; readonly view: DiningStaffCallView }
  | { readonly status: "sending"; readonly view: DiningStaffCallView }
  | {
      readonly status: "failed";
      readonly view: DiningStaffCallView | null;
      readonly offline: boolean;
    };

/** How often the phone checks whether staff answered an open call, while the page is visible. */
export const diningStaffCallCheckIntervalMs = 10_000;

const reasonText = (): Record<DiningStaffCallReason, string> => ({
  Question: t("A question"),
  TableNeeds: t("Something for the table (water, cutlery, napkins)"),
  OrderProblem: t("A problem with my order"),
});

export function DiningStaffCallPanel({
  client: provided,
}: {
  readonly client?: DiningStaffCallClient | undefined;
}) {
  const [client] = useState(() => provided ?? createHttpDiningStaffCallClient());
  const [state, setState] = useState<DiningStaffCallState>({ status: "hidden" });
  const [reason, setReason] = useState<DiningStaffCallReason>("Question");
  // The request key of an attempt whose result is not known yet; a retry repeats it.
  const pending = useRef<{ readonly kind: "call" | "withdraw"; readonly key: string } | null>(null);
  const busy = useRef(false);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const view = await client.read(signal);
        if (signal?.aborted) return;
        setState((prior) => (prior.status === "sending" ? prior : { status: "ready", view }));
      } catch (error) {
        if (signal?.aborted) return;
        // Not seated at a table (or the table ended): nothing to offer here.
        if (
          error instanceof DiningStaffCallClientError &&
          (error.code === "not-joined" || error.code === "not-offered")
        )
          setState({ status: "hidden" });
        else
          // Not reachable: say so (and to wave to staff) rather than hide the way to ask.
          setState((prior) => ({
            status: "failed",
            view: prior.status === "hidden" ? null : prior.view,
            offline: typeof navigator !== "undefined" && navigator.onLine === false,
          }));
      }
    },
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const open = state.status !== "hidden" && state.view?.open != null;
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, diningStaffCallCheckIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [open, refresh]);

  if (state.status === "hidden") return null;
  const view = state.view;
  const sending = state.status === "sending";
  const send = async (kind: "call" | "withdraw") => {
    if (busy.current || view === null) return;
    busy.current = true;
    const key =
      pending.current?.kind === kind ? pending.current.key : client.newOperationReference();
    pending.current = { kind, key };
    setState({ status: "sending", view });
    try {
      if (kind === "call") {
        const outcome = await client.call(key, reason);
        pending.current = null;
        setState({
          status: "ready",
          view:
            outcome.status === "TooMany"
              ? { open: null, recentlyClosed: view.recentlyClosed, nextCallAt: outcome.retryAt }
              : outcome.view,
        });
      } else if (view.open !== null) {
        await client.withdraw(key, view.open.callReference);
        pending.current = null;
        setState({
          status: "ready",
          view: {
            open: null,
            recentlyClosed: { kind: "Withdrawn", closedAt: new Date().toISOString() },
            nextCallAt: null,
          },
        });
        void refresh();
      }
    } catch (error) {
      if (
        error instanceof DiningStaffCallClientError &&
        (error.code === "not-joined" || error.code === "not-offered")
      ) {
        pending.current = null;
        setState({ status: "hidden" });
      } else
        setState({
          status: "failed",
          view,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        });
    } finally {
      busy.current = false;
    }
  };
  const reasons = reasonText();
  return (
    <section
      className="order-status__card dining-staff-call"
      aria-labelledby="dining-staff-call-heading"
    >
      {view?.open ? (
        <>
          <h2 id="dining-staff-call-heading">{t("Staff have been asked to come to your table")}</h2>
          <p role="status">
            {t("Asked at {time} · {reason}", {
              time: formatClockTime(view.open.calledAt),
              reason: reasons[view.open.reason],
            })}
          </p>
          <p className="dining-invitation__note">
            {t("Everyone at your table sees this. Someone will come over as soon as they can.")}
          </p>
          <button
            className="dining-invitation__action dining-invitation__action--secondary"
            type="button"
            disabled={sending}
            onClick={() => void send("withdraw")}
          >
            {sending ? t("Sending…") : t("No longer needed")}
          </button>
        </>
      ) : (
        <>
          <h2 id="dining-staff-call-heading">{t("Need a staff member?")}</h2>
          {view?.recentlyClosed ? (
            <p role="status">
              {view.recentlyClosed.kind === "Answered"
                ? t("A staff member saw your request at {time}.", {
                    time: formatClockTime(view.recentlyClosed.closedAt),
                  })
                : t("Your request was withdrawn.")}
            </p>
          ) : null}
          {view?.nextCallAt ? (
            <p role="status">
              {t(
                "You’ve asked several times. You can ask again at {time}, or wave to a staff member.",
                { time: formatClockTime(view.nextCallAt) },
              )}
            </p>
          ) : (
            <>
              <fieldset className="dining-staff-call__reasons" disabled={sending || view === null}>
                <legend>{t("What do you need?")}</legend>
                {diningStaffCallReasons.map((code) => (
                  <label key={code}>
                    <input
                      type="radio"
                      name="dining-staff-call-reason"
                      value={code}
                      checked={reason === code}
                      onChange={() => setReason(code)}
                    />
                    {reasons[code]}
                  </label>
                ))}
              </fieldset>
              <p className="dining-invitation__note">
                {t("Please don’t share allergies here; tell the staff member when they arrive.")}
              </p>
              <button
                className="dining-invitation__action"
                type="button"
                disabled={sending || view === null}
                onClick={() => void send("call")}
              >
                {sending ? t("Sending…") : t("Ask staff to come to the table")}
              </button>
            </>
          )}
        </>
      )}
      {state.status === "failed" ? (
        <p className="dining-staff-call__failed" role="alert">
          {state.offline
            ? t("You’re offline, so staff weren’t told. Please wave to a staff member.")
            : t("We couldn’t reach the staff. Try again, or wave to a staff member.")}
        </p>
      ) : null}
    </section>
  );
}

import { t } from "./i18n/i18n.js";
import { notConfirmedPressAgainText } from "./failure-words.js";
import { useEffect, useRef, useState } from "react";
import {
  createDiningSessionCloseClient,
  DiningSessionCloseClientError,
} from "./dining-session-close-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { DiningProgress } from "./dining-progress-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningSessionCloseClient>["prepare"]>;
export function DiningSessionCloseAction({
  view,
  csrf,
  locked,
  onBusy,
  onClosed,
}: {
  readonly view: DiningProgress;
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  readonly onClosed: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied" | "NotReady">("Idle");
  const operation = useRef<Operation | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (view.sessionPhase === "Closed") return null;
  const action = view.sessionPhase === "Active" ? "Begin" : "Finalize";
  const submit = async () => {
    if (pending.current || (!operation.current && (!confirmed || locked))) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onBusy(true);
    try {
      operation.current ??= createDiningSessionCloseClient().prepare({
        operationReference: serviceOperationReference(),
        diningSessionReference: view.diningSessionReference,
        action,
        expectedSessionVersion: view.sessionVersion,
      });
      await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        onBusy(false);
        onClosed();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown =
          error instanceof DiningSessionCloseClientError && error.code === "OutcomeUnknown";
        setState(
          unknown
            ? "Unknown"
            : error instanceof DiningSessionCloseClientError && error.code === "NotReady"
              ? "NotReady"
              : "Denied",
        );
        if (!unknown) onBusy(false);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  return (
    <div>
      <p>
        {action === "Begin"
          ? t("Start checkout for this table: the guests can't send more rounds.")
          : t(
              "Close the table. Every order, payment and open problem is checked before the table is free for the next guests.",
            )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={state !== "Idle" || locked}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {/* b13: plain table words, as on the Tables page (never "dining session"). */}
        {action === "Begin"
          ? t("I confirm the guests have finished ordering")
          : t("I confirm the guests have left and the table can be closed")}
      </label>
      {state !== "Denied" && state !== "NotReady" ? (
        <button
          disabled={state === "Submitting" || (state !== "Unknown" && (!confirmed || locked))}
          onClick={() => void submit()}
        >
          {state === "Unknown"
            ? t("Send it again")
            : state === "Submitting"
              ? t("Updating the table…")
              : action === "Begin"
                ? t("Start checkout")
                : t("Close the table")}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">{notConfirmedPressAgainText}</p>
      ) : state === "NotReady" ? (
        <p role="status">
          {t(
            "This table can't be closed yet: a dish has not been served. Serve it, or resolve it on the Tables page, then close the table.",
          )}
        </p>
      ) : state === "Denied" ? (
        <p role="status">
          {t(
            "The table was not closed. Refresh, then check its orders, payments and open problems.",
          )}
        </p>
      ) : null}
    </div>
  );
}

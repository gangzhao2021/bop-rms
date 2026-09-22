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
    [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied">("Idle");
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
        setState(unknown ? "Unknown" : "Denied");
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
          ? "Begin closing this dining session to stop further ordering."
          : "Finish closing this dining session. All orders, payments and unresolved exceptions will be checked before releasing its table."}
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={state !== "Idle" || locked}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this dining session is ready for the next closing step
      </label>
      {state !== "Denied" ? (
        <button
          disabled={state === "Submitting" || (state !== "Unknown" && (!confirmed || locked))}
          onClick={() => void submit()}
        >
          {state === "Unknown"
            ? "Retry same session close request"
            : state === "Submitting"
              ? "Updating dining session…"
              : action === "Begin"
                ? "Begin session closing"
                : "Finalize session closing"}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">The result is unknown. Retry the same request to recover its result.</p>
      ) : state === "Denied" ? (
        <p role="status">
          Session closure was not confirmed. Refresh and check all orders, payments, exceptions and
          permissions.
        </p>
      ) : null}
    </div>
  );
}

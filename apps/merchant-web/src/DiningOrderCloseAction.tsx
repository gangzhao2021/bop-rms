import { useEffect, useRef, useState } from "react";
import {
  createDiningOrderCloseClient,
  DiningOrderCloseClientError,
} from "./dining-order-close-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { closeReasonTexts } from "./dining-close-reasons.js";
import type { DiningProgress } from "./dining-progress-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningOrderCloseClient>["prepare"]>;
export function DiningOrderCloseAction({
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
    [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied">("Idle"),
    // WP-2423 (B759): why the server refused (not ready / changed / no access), in staff words.
    [refusal, setRefusal] = useState<readonly string[]>([]);
  const operation = useRef<Operation | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (view.closureStatus !== "Open" || view.phase !== "Fulfilled") return null;
  const submit = async () => {
    if (pending.current || (!operation.current && (!confirmed || locked))) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onBusy(true);
    try {
      operation.current ??= createDiningOrderCloseClient().prepare({
        operationReference: serviceOperationReference(),
        orderReference: view.orderReference,
        expectedOrderVersion: view.currentOrderVersion,
        expectedClosureVersion: view.closureVersion,
        reasonCode: "ORDER_COMPLETED",
      });
      await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        onBusy(false);
        onClosed();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown =
          error instanceof DiningOrderCloseClientError && error.code === "OutcomeUnknown";
        setState(unknown ? "Unknown" : "Denied");
        setRefusal(
          !(error instanceof DiningOrderCloseClientError) || unknown
            ? []
            : error.code === "NotReady"
              ? closeReasonTexts(error.reasons.length > 0 ? error.reasons : ["UNKNOWN"])
              : error.code === "PermissionDenied"
                ? ["Your access doesn't allow closing orders. Ask an Owner or Store Manager."]
                : ["The order changed meanwhile. Refresh it and try again."],
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
        Close this completed order. Payment and unresolved exceptions will be checked before
        closing. The dining session stays open.
      </p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={state !== "Idle" || locked}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this order is complete
      </label>
      {state !== "Denied" ? (
        <button
          disabled={state === "Submitting" || (state !== "Unknown" && (!confirmed || locked))}
          onClick={() => void submit()}
        >
          {state === "Unknown"
            ? "Retry same close request"
            : state === "Submitting"
              ? "Closing order…"
              : "Close order"}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">
          We couldn&apos;t reach the server to confirm whether the order was closed, even after
          checking again. Check this device&apos;s connection, then retry: it reports what already
          happened and nothing is done twice.
        </p>
      ) : state === "Denied" ? (
        <div role="status">
          <p>The order wasn&apos;t closed.</p>
          {refusal.length > 0 ? (
            <ul>
              {refusal.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

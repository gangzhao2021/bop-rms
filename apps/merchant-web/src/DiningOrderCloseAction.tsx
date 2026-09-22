import { useEffect, useRef, useState } from "react";
import {
  createDiningOrderCloseClient,
  DiningOrderCloseClientError,
} from "./dining-order-close-client.js";
import { serviceOperationReference } from "./service-control-client.js";
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
    [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied">("Idle");
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
        <p role="status">The result is unknown. Retry the same request to recover its result.</p>
      ) : state === "Denied" ? (
        <p role="status">
          Order closure was not confirmed. Refresh and check payment, unresolved exceptions and
          permissions.
        </p>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { createDiningServeClient, DiningServeClientError } from "./dining-serve-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { DiningProgress } from "./dining-progress-client.js";
type Operation = ReturnType<ReturnType<typeof createDiningServeClient>["prepare"]>;
export function DiningServeAction({
  view,
  item,
  csrf,
  locked,
  onBusy,
  onServed,
}: {
  readonly view: DiningProgress;
  readonly item: DiningProgress["items"][number];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onBusy: (busy: boolean) => void;
  readonly onServed: () => void;
}) {
  const [quantity, setQuantity] = useState("1"),
    [confirmed, setConfirmed] = useState(false),
    [state, setState] = useState<"Idle" | "Submitting" | "Unknown" | "Denied">("Idle");
  const operation = useRef<Operation | null>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (
    view.sessionPhase !== "Active" ||
    view.closureStatus !== "Open" ||
    item.phase !== "Ready" ||
    item.remainingQuantity < 1
  )
    return null;
  const valid = /^[1-9][0-9]{0,2}$/.test(quantity) && Number(quantity) <= item.remainingQuantity;
  const submit = async () => {
    if (pending.current || (!operation.current && (!valid || !confirmed || locked))) return;
    const controller = new AbortController();
    pending.current = controller;
    setState("Submitting");
    onBusy(true);
    try {
      if (!operation.current)
        operation.current = createDiningServeClient().prepare({
          operationReference: serviceOperationReference(),
          orderReference: view.orderReference,
          orderItemReference: item.orderItemReference,
          quantity: Number(quantity),
          expectedOrderVersion: view.orderVersion,
          expectedItemServiceVersion: item.itemServiceVersion,
          expectedSessionVersion: view.sessionVersion,
          expectedTableAssignmentVersion: view.tableAssignmentVersion,
        });
      await operation.current.execute(csrf, controller.signal);
      if (!controller.signal.aborted) {
        onBusy(false);
        onServed();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const unknown = error instanceof DiningServeClientError && error.code === "OutcomeUnknown";
        setState(unknown ? "Unknown" : "Denied");
        if (!unknown) onBusy(false);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const frozen = state !== "Idle" || locked;
  return (
    <div>
      <label>
        Quantity served · {item.displayName} · batch {item.batchSequence}
        <input
          type="number"
          min="1"
          max={item.remainingQuantity}
          step="1"
          value={quantity}
          disabled={frozen}
          onChange={(event) => {
            setQuantity(event.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={frozen}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm {quantity} × {item.displayName} delivered to table {view.tableLabel}
      </label>
      {state !== "Denied" ? (
        <button
          disabled={
            state === "Submitting" || (state !== "Unknown" && (!valid || !confirmed || locked))
          }
          onClick={() => void submit()}
        >
          {state === "Unknown"
            ? "Retry same serving request"
            : state === "Submitting"
              ? "Recording served quantity…"
              : "Confirm served quantity"}
        </button>
      ) : null}
      {state === "Unknown" ? (
        <p role="status">
          The result is unknown. Retry this same request to recover its result; do not create
          another serving operation.
        </p>
      ) : state === "Denied" ? (
        <p role="status">
          Serving was not confirmed. Refresh progress to check current quantities, table and
          permissions.
        </p>
      ) : null}
    </div>
  );
}

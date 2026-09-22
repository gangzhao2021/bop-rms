import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import { DiningOrderCloseAction } from "./DiningOrderCloseAction.js";
import { DiningServeAction } from "./DiningServeAction.js";
import { useEffect, useRef, useState } from "react";
import {
  createDiningProgressClient,
  DiningProgressError,
  type DiningProgress,
} from "./dining-progress-client.js";
type State =
  | { kind: "Idle" | "Loading" | "PermissionDenied" | "Unavailable" }
  | { kind: "Ready"; view: DiningProgress };
export function DiningProgressView({
  view,
  action,
}: {
  readonly view: DiningProgress;
  readonly action?: (item: DiningProgress["items"][number]) => React.ReactNode;
}) {
  return (
    <div>
      <p>
        <strong>Table {view.tableLabel}</strong>
      </p>
      <p>
        Last checked <time dateTime={view.observedAt}>{view.observedAt}</time>
      </p>
      {view.closureStatus === "Closed" ? <p>Order closed. Serving history is read-only.</p> : null}
      <p>Dining session: {view.sessionPhase}</p>
      <ol>
        {view.items.map((item) => (
          <li key={item.orderItemReference}>
            <strong>{item.displayName}</strong>
            <p>
              Batch {item.batchSequence} · Item {item.itemOrdinal}
            </p>
            <p>
              {item.phase} · Ordered {item.orderedQuantity} · Served {item.deliveredQuantity} ·
              Remaining {item.remainingQuantity}
            </p>
            {view.closureStatus === "Open" && view.sessionPhase === "Active"
              ? action?.(item)
              : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
export function DiningOrderProgress({
  orderReference,
  csrf,
  locked = false,
  onBusy,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly locked?: boolean;
  readonly onBusy?: (busy: boolean) => void;
}) {
  const [state, setState] = useState<State>({ kind: "Idle" });
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setState({ kind: "Idle" });
    return () => {
      active.current?.abort();
    };
  }, [orderReference, csrf]);
  const load = async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: "Loading" });
    try {
      const view = await createDiningProgressClient().load(orderReference, csrf, controller.signal);
      if (!controller.signal.aborted) setState({ kind: "Ready", view });
    } catch (error) {
      if (!controller.signal.aborted)
        setState({ kind: error instanceof DiningProgressError ? error.code : "Unavailable" });
    }
  };
  return (
    <section aria-label="Dining serving progress">
      <button onClick={() => void load()} disabled={state.kind === "Loading" || busy || locked}>
        {state.kind === "Idle" ? "View serving progress" : "Refresh serving progress"}
      </button>
      <div role="status">
        {state.kind === "Loading" ? (
          <p>Loading serving progress…</p>
        ) : state.kind === "PermissionDenied" ? (
          <p>Your current permissions do not allow serving progress.</p>
        ) : state.kind === "Unavailable" ? (
          <p>Serving progress unavailable. Check your connection and refresh.</p>
        ) : null}
      </div>
      {state.kind === "Ready" ? (
        <>
          <DiningOrderCloseAction
            key={
              state.view.orderReference +
              ":" +
              state.view.currentOrderVersion +
              ":" +
              state.view.closureVersion
            }
            view={state.view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={(value) => {
              setBusy(value);
              onBusy?.(value);
            }}
            onClosed={() => void load()}
          />
          <DiningSessionCloseAction
            key={state.view.diningSessionReference + ":" + state.view.sessionVersion}
            view={state.view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={(value) => {
              setBusy(value);
              onBusy?.(value);
            }}
            onClosed={() => void load()}
          />
          <DiningProgressView
            view={state.view}
            action={(item) => (
              <DiningServeAction
                key={item.orderItemReference}
                view={state.view}
                item={item}
                csrf={csrf}
                locked={busy || locked}
                onBusy={(value) => {
                  setBusy(value);
                  onBusy?.(value);
                }}
                onServed={() => void load()}
              />
            )}
          />
        </>
      ) : null}
    </section>
  );
}

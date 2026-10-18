import { DiningSessionCloseAction } from "./DiningSessionCloseAction.js";
import { DiningOrderCloseAction } from "./DiningOrderCloseAction.js";
import { DiningServeAction } from "./DiningServeAction.js";
import { DiningServeReadyActions, optionsText } from "./DiningServeReadyAction.js";
import { CheckedTime } from "./StoreTime.js";
import { useEffect, useRef, useState } from "react";
import {
  createDiningProgressClient,
  DiningProgressError,
  servableQuantity,
  type DiningProgress,
} from "./dining-progress-client.js";
type State =
  | { kind: "Idle" | "Loading" | "PermissionDenied" | "Unavailable" }
  | { kind: "Ready"; view: DiningProgress };
/** WP-2423 (v15 2026-10-16): an item's progress and the table's state in staff words. */
const itemPhaseText: Readonly<Record<string, string>> = {
  Submitted: "Waiting for staff",
  Accepted: "Sent to the kitchen",
  InProgress: "Being made",
  Ready: "Ready to serve",
  Fulfilled: "Served",
  Rejected: "Not accepted",
  Cancelled: "Cancelled",
};
const sessionPhaseText = {
  Active: "Table open",
  Closing: "Table closing",
  Closed: "Table closed",
} as const;
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
        <CheckedTime instant={view.observedAt} />
      </p>
      {view.closureStatus === "Closed" ? <p>Order closed. Serving history is read-only.</p> : null}
      <p>{sessionPhaseText[view.sessionPhase]}</p>
      <ol className="dining-progress-lines">
        {view.items.map((item) => (
          <li key={item.orderItemReference}>
            <strong>{item.displayName}</strong>
            {optionsText(item) ? (
              <span className="order-line-options">{optionsText(item)}</span>
            ) : null}
            {item.details?.customerNote ? (
              <span className="order-line-note">Note: {item.details.customerNote}</span>
            ) : null}
            <p>
              Round {item.batchSequence} · Item {item.itemOrdinal}
            </p>
            <p>
              {item.phase === "Ready" &&
              (item.remakingQuantity ?? 0) > 0 &&
              servableQuantity(item) === 0
                ? "Being remade"
                : (itemPhaseText[item.phase] ?? "Checking")}{" "}
              · Ordered {item.orderedQuantity} · Served {item.deliveredQuantity} · Remaining{" "}
              {item.remainingQuantity}
            </p>
            {(item.remakingQuantity ?? 0) > 0 ? (
              // WP-2423 (2026-10-18): never serve or promise a dish the kitchen is making again.
              <p className="dining-progress-remaking" role="note">
                <strong>Remaking — kitchen is making it again</strong>
                {(item.remakingQuantity ?? 0) > 1 ? ` (${item.remakingQuantity} of them)` : ""}.
                Don&apos;t serve it until the kitchen marks the remake done; tell the guest
                it&apos;s being remade.
              </p>
            ) : null}
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
  onChanged,
  fetcher,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly locked?: boolean;
  readonly onBusy?: (busy: boolean) => void;
  /**
   * WP-2423: after an item was served or the Order/session closed, so the order's status (its
   * header: "Ready" becomes "Served") is reread at once instead of at the next background poll.
   */
  readonly onChanged?: (() => void) | undefined;
  /** WP-2423 P5: an injected transport (the local demo). */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [state, setState] = useState<State>({ kind: "Idle" });
  const [busy, setBusy] = useState(false);
  // WP-2423: what "Serve all ready items" did, kept across the reread that follows it.
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  // WP-2423: a command in flight pauses the page's background reread (onBusy). If this panel is
  // closed meanwhile (the order collapsed), its command is abandoned and never reports back, so
  // the pause is released here; otherwise the order's status would stay as it was.
  const busyRef = useRef(false);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(
    () => () => {
      if (busyRef.current) onBusyRef.current?.(false);
    },
    [],
  );
  const markBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
    onBusy?.(value);
  };
  const changed = () => {
    void load();
    onChanged?.();
  };
  useEffect(() => {
    setState({ kind: "Idle" });
    setNotice(null);
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
      const view = await createDiningProgressClient(fetcher).load(
        orderReference,
        csrf,
        controller.signal,
      );
      if (!controller.signal.aborted) setState({ kind: "Ready", view });
    } catch (error) {
      if (!controller.signal.aborted)
        setState({
          kind:
            error instanceof DiningProgressError && error.code === "PermissionDenied"
              ? "PermissionDenied"
              : "Unavailable",
        });
    }
  };
  return (
    <section aria-label="Dining serving progress">
      <button
        onClick={() => {
          setNotice(null);
          void load();
        }}
        disabled={state.kind === "Loading" || busy || locked}
      >
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
        {notice === null ? null : <p>{notice}</p>}
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
            onBusy={markBusy}
            onClosed={changed}
          />
          <DiningSessionCloseAction
            key={state.view.diningSessionReference + ":" + state.view.sessionVersion}
            view={state.view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={markBusy}
            onClosed={changed}
          />
          <DiningServeReadyActions
            key={"serve-ready:" + state.view.observedAt}
            view={state.view}
            csrf={csrf}
            locked={busy || locked}
            onBusy={markBusy}
            onDone={(summary) => {
              setNotice(summary);
              changed();
            }}
            fetcher={fetcher}
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
                onBusy={markBusy}
                onServed={changed}
              />
            )}
          />
        </>
      ) : null}
    </section>
  );
}

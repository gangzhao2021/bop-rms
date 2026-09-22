import { useKitchenActions } from "./use-kitchen-actions.js";
import type { KitchenAction } from "./kitchen-work-client.js";
import { createKitchenBoardClient } from "./kitchen-board-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, useParams } from "react-router";
import {
  KitchenBoardClientError,
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemView,
  unavailableKitchenBoardClient,
  type KitchenBoardClient,
  type KitchenBoardItem,
  type KitchenBoardView,
} from "./kitchen-board.js";

type LoadState<T> =
  | {
      readonly kind:
        | "Loading"
        | "PermissionDenied"
        | "NotFound"
        | "Offline"
        | "Conflict"
        | "CommandFailed"
        | "Unavailable";
    }
  | { readonly kind: "Found"; readonly view: T };
function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [stored, setStored] = useState<{
    key: string;
    load: () => Promise<T>;
    state: LoadState<T>;
  }>({ key, load, state: { kind: "Loading" } });
  useEffect(() => {
    let active = true;
    const setState = (state: LoadState<T>) => setStored({ key, load, state });
    setState({ kind: "Loading" });
    void load()
      .then((view) => {
        if (active) setState({ kind: "Found", view });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof KitchenBoardClientError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  return stored.key === key && stored.load === load ? stored.state : { kind: "Loading" };
}

export function KitchenBoardStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const copy = {
    Loading: ["Loading", "Loading the authorized Kitchen queue…"],
    PermissionDenied: [
      "Permission denied",
      "Your Kitchen permission or Store scope does not allow this board.",
    ],
    NotFound: [
      "Work item unavailable",
      "This work item is unavailable in the authorized Store scope.",
    ],
    Offline: [
      "Offline read-only",
      "Reconnect and refresh from the authoritative queue before any action.",
    ],
    Conflict: ["Source changed", "Refresh the authoritative work item version before retrying."],
    CommandFailed: ["Command failed", "No Kitchen transition is assumed. Refresh before retrying."],
    Unavailable: [
      "Kitchen Board unavailable",
      "The authorized Kitchen queue could not be loaded. Refresh to try again.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}

function WorkCard({
  item,
  readOnly,
  observedAt,
  onAction,
}: {
  readonly item: KitchenBoardItem;
  readonly readOnly: boolean;
  readonly observedAt: string;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.createdAt)) / 60_000),
  );
  return (
    <article className="store-card" data-read-only={readOnly}>
      <header>
        <div>
          <p className="bop-eyebrow">
            {item.stationLabel} · {age} minutes
          </p>
          <h3>{item.displayName}</h3>
        </div>
        <strong>{item.status}</strong>
      </header>
      <dl>
        <div>
          <dt>Quantity</dt>
          <dd>
            {item.completedQuantity} / {item.requiredQuantity}
          </dd>
        </div>
        <div>
          <dt>Allergen safety</dt>
          <dd>{item.allergenCue}</dd>
        </div>
        <div>
          <dt>Exception</dt>
          <dd>{item.exceptionStatus}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>Not available</dd>
        </div>
      </dl>
      <div className="card-actions">
        <Link to={`/operations/kitchen/work-items/${item.workItemReference}`}>Open work item</Link>
        <button
          disabled={
            readOnly ||
            !onAction ||
            !item.execution ||
            item.status !== "Queued" ||
            item.execution.acceptedAt !== null
          }
          onClick={() => onAction?.(item, "AcceptKitchenWorkItem")}
        >
          Accept
        </button>
        <button
          disabled={
            readOnly ||
            !onAction ||
            !item.execution ||
            item.status !== "Queued" ||
            item.execution.acceptedAt === null
          }
          onClick={() => onAction?.(item, "StartKitchenWorkItem")}
        >
          Start
        </button>
        <button
          disabled={
            readOnly ||
            !onAction ||
            !item.execution ||
            item.status !== "In Progress" ||
            item.completedQuantity >= item.requiredQuantity
          }
          onClick={() => onAction?.(item, "CompleteKitchenWorkItem")}
        >
          Complete remaining quantity
        </button>
        <button
          disabled={
            readOnly ||
            !onAction ||
            !item.execution ||
            item.status !== "Completed" ||
            item.execution.readyAt !== null
          }
          onClick={() => onAction?.(item, "MarkKitchenOrderItemReady")}
        >
          Mark ready
        </button>
        <button disabled>Hold / prioritize unavailable</button>
      </div>
    </article>
  );
}

export function KitchenBoardScreen({
  view,
  onRefresh,
  refreshButtonRef,
  onAction,
  actionsBlocked = true,
}: {
  readonly view: KitchenBoardView;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  readonly actionsBlocked?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [station, setStation] = useState("All");
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const stations = [...new Set(view.items.map((item) => item.stationLabel))];
  const items = view.items.filter((item) => station === "All" || item.stationLabel === station);
  return (
    <AppFrame title="Kitchen Board" description={`KIT-KITCHEN-QUEUE · ${view.storeLabel}`}>
      <header className="screen-heading">
        <div>
          <h2>Active work</h2>
          <p>
            {view.freshnessStatus} · {view.operatorStatus} operator · {view.projectedAt}
          </p>
        </div>
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh from source
        </button>
      </header>
      {readOnly ? (
        <StatePanel heading="Board locked — read-only" tone="offline" status>
          <p>
            A fresh projection and named unlocked operator session are required for Kitchen
            commands.
          </p>
        </StatePanel>
      ) : null}
      <div className="list-filters" role="search">
        <label>
          Station
          <select value={station} onChange={(event) => setStation(event.currentTarget.value)}>
            <option>All</option>
            {stations.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <StatePanel heading="No active work" status>
          <p>No authorized work item matches this station.</p>
        </StatePanel>
      ) : (
        <div className="store-card-grid">
          {items.map((item) => (
            <WorkCard
              key={item.workItemReference}
              item={item}
              readOnly={readOnly || actionsBlocked}
              {...(onAction ? { onAction } : {})}
              observedAt={view.projectedAt}
            />
          ))}
        </div>
      )}
    </AppFrame>
  );
}

export function KitchenWorkItemScreen({ item }: { readonly item: KitchenBoardItem }) {
  return (
    <AppFrame
      title={item.displayName}
      description="KIT-WORK-ITEM · privacy-minimized execution snapshot"
    >
      <WorkCard item={item} readOnly observedAt={item.createdAt} />
      <StatePanel heading="Safety and lifecycle authority">
        <p>
          Allergen acknowledgement, timers, dependencies, history and policy actions require a fresh
          authoritative detail response; absent facts are not inferred.
        </p>
      </StatePanel>
      <Link to="/operations/kitchen">Return to Kitchen Board</Link>
    </AppFrame>
  );
}

interface KitchenPageProps {
  readonly client?: KitchenBoardClient;
  readonly csrf?: string;
  readonly storeLabel?: string;
  readonly storeReference?: string;
}
function useClient({ client, csrf, storeLabel, storeReference }: KitchenPageProps) {
  return useMemo(
    () =>
      client ??
      (csrf && storeLabel && storeReference
        ? createKitchenBoardClient({ csrf, storeLabel, storeReference })
        : unavailableKitchenBoardClient),
    [client, csrf, storeLabel, storeReference],
  );
}
export function KitchenBoardPage(props: KitchenPageProps) {
  const client = useClient(props),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  const load = useCallback(() => client.loadQueue().then(parseKitchenBoardView), [client]);
  const state = useLoad(load, "queue:" + revision);
  const actions = useKitchenActions({
    csrf: props.csrf,
    storeReference: props.storeReference,
    view: state.kind === "Found" ? state.view : null,
    revision,
  });
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (revision > 0 && state.kind !== "Loading") refreshButtonRef.current?.focus();
  }, [revision, state.kind]);
  return (
    <>
      {actions.state.kind !== "Idle" ? (
        <StatePanel
          heading={
            actions.state.kind === "Submitting"
              ? "Submitting Kitchen action"
              : actions.state.kind === "Unknown"
                ? "Action result unknown"
                : actions.state.kind === "Confirmed"
                  ? actions.reflected
                    ? "Kitchen action confirmed"
                    : "Waiting for refreshed queue"
                  : "Kitchen action not completed"
          }
          status
        >
          <p>
            {actions.state.kind === "Submitting"
              ? "Please wait before taking another action."
              : actions.state.kind === "Unknown"
                ? "The response was lost. Retry this same operation to recover its result; do not create another operation."
                : actions.state.kind === "Confirmed"
                  ? actions.reflected
                    ? "The queue now reflects the confirmed operation."
                    : "The operation is confirmed. Refresh from source until the queue reflects its new version."
                  : actions.rejectedRefreshed
                    ? "The queue has been refreshed. Review the current item before choosing an action."
                    : actions.state.code === "PermissionDenied"
                      ? "Your current permission or Store scope no longer allows this action. Refresh before continuing."
                      : actions.state.code === "Conflict"
                        ? "The work item changed. Refresh and review its current state before choosing an action."
                        : "The action was not accepted. Refresh and review the current work item."}
          </p>
          {actions.state.kind === "Unknown" ? (
            <button disabled={!actions.canRetry} onClick={actions.retry}>
              Retry same operation
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      {state.kind === "Found" ? (
        <KitchenBoardScreen
          view={state.view}
          onRefresh={refresh}
          refreshButtonRef={refreshButtonRef}
          onAction={actions.act}
          actionsBlocked={actions.blocked}
        />
      ) : (
        <>
          <KitchenBoardStatePanel state={state.kind} />
          {state.kind !== "Loading" ? (
            <button ref={refreshButtonRef} onClick={refresh}>
              Refresh from source
            </button>
          ) : null}
        </>
      )}
    </>
  );
}
export function KitchenWorkItemPage(props: KitchenPageProps) {
  const client = useClient(props),
    { id = "" } = useParams(),
    [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    let reference: string;
    try {
      reference = parseKitchenRouteReference(id);
    } catch {
      throw new KitchenBoardClientError("NotFound");
    }
    return parseKitchenWorkItemView(await client.loadWorkItem(reference));
  }, [client, id]);
  const state = useLoad(load, id + ":" + revision);
  return (
    <>
      {state.kind === "Found" ? (
        <KitchenWorkItemScreen item={state.view} />
      ) : (
        <KitchenBoardStatePanel state={state.kind} />
      )}
      {state.kind !== "Loading" ? (
        <button onClick={() => setRevision((value) => value + 1)}>Refresh from source</button>
      ) : null}
    </>
  );
}

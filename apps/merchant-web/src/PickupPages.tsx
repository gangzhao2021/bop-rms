import { PickupProofForm } from "./PickupProofForm.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useState, useMemo, useRef, type RefObject } from "react";
import { createPickupClient } from "./pickup-client.js";
import { Link } from "react-router";
import {
  parsePickupQueueView,
  PickupClientError,
  unavailablePickupClient,
  type PickupClient,
  type PickupQueueItem,
  type PickupQueueView,
  type PickupWorkstation,
} from "./pickup.js";
type State =
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
  | { readonly kind: "Found"; readonly view: PickupQueueView };
export function PickupStatePanel({ state }: { readonly state: Exclude<State["kind"], "Found"> }) {
  const copy = {
    Loading: ["Loading", "Loading the authorized Pickup Queue…"],
    PermissionDenied: [
      "Permission denied",
      "Your Fulfillment permission or Store scope does not allow this queue.",
    ],
    NotFound: ["Pickup unavailable", "This Pickup is not available in the authorized Store scope."],
    Offline: ["Offline read-only", "Reconnect and refresh before any Pickup action."],
    Conflict: ["Source changed", "Refresh the authoritative Fulfillment version before retrying."],
    CommandFailed: ["Command failed", "No handoff or Fulfillment transition is assumed."],
    Unavailable: [
      "Pickup Queue unavailable",
      "The authorized Pickup queue could not be loaded. Refresh to try again.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Return to overview</Link>
    </StatePanel>
  );
}
function PickupCard({
  item,
  observedAt,
  readOnly,
  proofContext,
  workstation,
}: {
  readonly workstation?: PickupWorkstation | null | undefined;
  readonly item: PickupQueueItem;
  readonly observedAt: string;
  readonly readOnly: boolean;
  readonly proofContext?: { csrf: string; storeReference: string } | undefined;
}) {
  const completed = item.phase === "Completed";
  const wait = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.readyAt)) / 60_000),
  );
  const canComplete = !readOnly && item.phase !== "Completed" && item.proofReadiness === "Ready";
  return (
    <article className="store-card">
      <header>
        <div>
          <p className="bop-eyebrow">
            {completed ? "Completed" : `Ready ${wait} minutes · ${item.phase}`}
          </p>
          <h3>
            {item.publicOrderNumber ??
              item.execution?.publicOrderReference ??
              "Order reference unavailable"}
          </h3>
        </div>
        <strong>{completed ? "Handed over" : wait >= 15 ? "Overdue" : "Waiting"}</strong>
      </header>
      <dl>
        <div>
          <dt>Proof</dt>
          <dd>{item.proofReadiness}</dd>
        </div>
        <div>
          <dt>Staging</dt>
          <dd>{item.stagingLocation ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{item.claimStatus}</dd>
        </div>
        <div>
          <dt>Exception</dt>
          <dd>{item.exceptionStatus}</dd>
        </div>
        <div>
          <dt>Packages</dt>
          <dd>{item.packageCount ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Allergen cue</dt>
          <dd>{item.allergenCue}</dd>
        </div>
      </dl>
      {!completed ? (
        <div className="card-actions">
          <button disabled>Claim</button>
          {canComplete && item.execution && proofContext ? (
            <PickupProofForm
              key={item.execution.aggregateVersion + ":" + item.execution.proof?.generation}
              item={item}
              workstation={workstation}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
            />
          ) : (
            <button disabled>Open proof verification</button>
          )}
          <button disabled>Report exception</button>
        </div>
      ) : null}
      {canComplete ? (
        <StatePanel heading="Explicit handoff confirmation required" status>
          <p>
            Verify the signed proof, confirm this exact Order and submit one idempotent Complete
            Pickup Handoff command.
          </p>
          {!workstation ? <button disabled>Complete handoff — adapter unavailable</button> : null}
        </StatePanel>
      ) : null}
    </article>
  );
}
export function PickupQueueScreen({
  view,
  onRefresh,
  onNext,
  onPrevious,
  includeCompleted = false,
  onCompletedChange,
  refreshButtonRef,
  proofContext,
}: {
  readonly view: PickupQueueView;
  readonly proofContext?: { csrf: string; storeReference: string } | undefined;
  readonly onRefresh?: () => void;
  readonly onNext?: () => void;
  readonly onPrevious?: () => void;
  readonly includeCompleted?: boolean;
  readonly onCompletedChange?: (value: boolean) => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [filter, setFilter] = useState("All");
  const readOnly = view.freshnessStatus !== "Fresh";
  const items = view.items.filter(
    (item) =>
      filter === "All" ||
      (filter === "Overdue"
        ? item.phase !== "Completed" &&
          Date.parse(view.projectedAt) - Date.parse(item.readyAt) >= 900_000
        : item.phase === filter),
  );
  return (
    <AppFrame title="Pickup Queue" description={`FUL-PICKUP-QUEUE · ${view.storeLabel}`}>
      <header className="screen-heading">
        <div>
          <h2>Ready for pickup</h2>
          <p>
            {view.freshnessStatus} · {view.projectedAt}
          </p>
        </div>
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh from source
        </button>
      </header>
      {readOnly ? (
        <StatePanel heading="Queue stale — read-only" tone="offline" status>
          <p>A fresh Fulfillment source is required before claim, proof verification or handoff.</p>
        </StatePanel>
      ) : null}
      <div className="list-filters">
        <label>
          <input
            type="checkbox"
            checked={includeCompleted}
            disabled={!onCompletedChange}
            onChange={(event) => onCompletedChange?.(event.currentTarget.checked)}
          />
          Include completed pickups
        </label>
        <label>
          Current page filter
          <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
            <option>All</option>
            <option>Ready</option>
            <option>InProgress</option>
            <option>Completed</option>
            <option>Overdue</option>
          </select>
        </label>
      </div>
      <nav aria-label="Pickup pages">
        <button disabled={!onPrevious} onClick={onPrevious}>
          Previous page
        </button>
        <button disabled={!onNext} onClick={onNext}>
          Next page
        </button>
      </nav>
      {items.length ? (
        <div className="store-card-grid">
          {items.map((item) => (
            <PickupCard
              key={item.fulfillmentReference}
              item={item}
              observedAt={view.projectedAt}
              readOnly={readOnly}
              proofContext={proofContext}
              workstation={view.workstation}
            />
          ))}
        </div>
      ) : (
        <StatePanel heading="No matching pickups" status>
          <p>No authorized pickup matches this page and filter.</p>
        </StatePanel>
      )}
    </AppFrame>
  );
}
export function PickupQueuePage(props: {
  readonly client?: PickupClient;
  readonly csrf?: string;
  readonly storeReference?: string;
  readonly storeLabel?: string;
}) {
  const client = useMemo(
    () =>
      props.client ??
      (props.csrf && props.storeReference && props.storeLabel
        ? createPickupClient({
            csrf: props.csrf,
            storeReference: props.storeReference,
            storeLabel: props.storeLabel,
          })
        : unavailablePickupClient),
    [props.client, props.csrf, props.storeReference, props.storeLabel],
  );
  const [cursors, setCursors] = useState<string[]>([]),
    [includeCompleted, setIncludeCompleted] = useState(false),
    [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback(
    () =>
      client
        .loadQueue({ afterFulfillmentReference: cursor, includeCompleted })
        .then(parsePickupQueueView),
    [client, cursor, includeCompleted],
  );
  const key = JSON.stringify([cursor, includeCompleted, revision]);
  const [stored, setStored] = useState<{ key: string; load: typeof load; state: State }>({
    key,
    load,
    state: { kind: "Loading" },
  });
  const state =
    stored.key === key && stored.load === load ? stored.state : { kind: "Loading" as const };
  const refreshButtonRef = useRef<HTMLButtonElement>(null),
    focusAfterLoad = useRef(false);
  useEffect(() => {
    let active = true;
    void load()
      .then((view) => {
        if (active) setStored({ key, load, state: { kind: "Found", view } });
      })
      .catch((error) => {
        if (active)
          setStored({
            key,
            load,
            state: { kind: error instanceof PickupClientError ? error.code : "Unavailable" },
          });
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  useEffect(() => {
    if (state.kind !== "Loading" && focusAfterLoad.current) {
      refreshButtonRef.current?.focus();
      focusAfterLoad.current = false;
    }
  }, [state.kind, key]);
  const refresh = () => {
    focusAfterLoad.current = true;
    setRevision((value) => value + 1);
  };
  if (state.kind !== "Found")
    return (
      <>
        <PickupStatePanel state={state.kind} />
        {state.kind !== "Loading" ? (
          <button ref={refreshButtonRef} onClick={refresh}>
            Refresh from source
          </button>
        ) : null}
      </>
    );
  const next = state.view.nextAfterFulfillmentReference;
  return (
    <PickupQueueScreen
      view={state.view}
      proofContext={
        props.csrf && props.storeReference
          ? { csrf: props.csrf, storeReference: props.storeReference }
          : undefined
      }
      onRefresh={refresh}
      refreshButtonRef={refreshButtonRef}
      includeCompleted={includeCompleted}
      onCompletedChange={(value) => {
        focusAfterLoad.current = true;
        setCursors([]);
        setIncludeCompleted(value);
      }}
      {...(next
        ? {
            onNext: () => {
              focusAfterLoad.current = true;
              setCursors((values) => [...values, next]);
            },
          }
        : {})}
      {...(cursors.length
        ? {
            onPrevious: () => {
              focusAfterLoad.current = true;
              setCursors((values) => values.slice(0, -1));
            },
          }
        : {})}
    />
  );
}

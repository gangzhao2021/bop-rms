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
  hidden,
}: {
  readonly workstation?: PickupWorkstation | null | undefined;
  readonly item: PickupQueueItem;
  readonly observedAt: string;
  readonly readOnly: boolean;
  readonly proofContext?: { csrf: string; storeReference: string } | undefined;
  readonly hidden: boolean;
}) {
  const completed = item.phase === "Completed";
  const wait = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.readyAt)) / 60_000),
  );
  const canComplete = !readOnly && item.phase !== "Completed" && item.proofReadiness === "Ready";
  return (
    <article className="store-card pickup-queue__card" hidden={hidden}>
      <header>
        <div>
          <p className="bop-eyebrow pickup-queue__phase">
            {completed ? "Completed" : `Ready ${wait} minutes · ${item.phase}`}
          </p>
          <h3>
            {item.publicOrderNumber ??
              item.execution?.publicOrderReference ??
              "Order reference unavailable"}
          </h3>
        </div>
        <strong className="pickup-queue__status" data-completed={completed}>
          {completed ? "Handed over" : "Waiting"}
        </strong>
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
          <button disabled aria-describedby="pickup-command-availability">
            Claim
          </button>
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
          <button disabled aria-describedby="pickup-command-availability">
            Report exception
          </button>
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
  const [claimFilter, setClaimFilter] = useState("All");
  const [exceptionFilter, setExceptionFilter] = useState("All");
  const [orderQuery, setOrderQuery] = useState("");
  const readOnly = view.freshnessStatus !== "Fresh";
  const query = orderQuery.trim().toLocaleLowerCase();
  const items = view.items.filter(
    (item) =>
      (!query ||
        (item.publicOrderNumber ?? item.execution?.publicOrderReference ?? "")
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "All" ||
        (filter === "Waiting" ? item.phase !== "Completed" : item.phase === filter)) &&
      (claimFilter === "All" || item.claimStatus === claimFilter) &&
      (exceptionFilter === "All" || item.exceptionStatus === exceptionFilter),
  );
  const hasLocalFilters =
    Boolean(query) || filter !== "All" || claimFilter !== "All" || exceptionFilter !== "All";
  const visibleReferences = new Set(items.map((item) => item.fulfillmentReference));
  return (
    <AppFrame
      className="bop-shell--pickup"
      title="Pickup Queue"
      description={`FUL-PICKUP-QUEUE · ${view.storeLabel}`}
    >
      <div className="pickup-queue">
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
            <p>
              A fresh Fulfillment source is required before claim, proof verification or handoff.
            </p>
          </StatePanel>
        ) : null}
        <div className="list-filters pickup-queue__filters">
          <label>
            Search Order reference
            <input
              type="search"
              value={orderQuery}
              onChange={(event) => setOrderQuery(event.currentTarget.value)}
              placeholder="Public Order reference"
            />
          </label>
          <label className="pickup-completed-filter">
            <input
              className="pickup-completed-filter__checkbox"
              type="checkbox"
              checked={includeCompleted}
              disabled={!onCompletedChange}
              onChange={(event) => onCompletedChange?.(event.currentTarget.checked)}
            />
            Include completed pickups
          </label>
          <label>
            Current page filter
            <select
              aria-describedby="pickup-overdue-availability"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>Ready</option>
              <option>Waiting</option>
              <option>InProgress</option>
              <option>Completed</option>
              <option disabled>Overdue</option>
            </select>
          </label>
          <label>
            Claim
            <select
              value={claimFilter}
              onChange={(event) => setClaimFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>Unclaimed</option>
              <option>Claimed</option>
              <option>Unavailable</option>
            </select>
          </label>
          <label>
            Exception
            <select
              value={exceptionFilter}
              onChange={(event) => setExceptionFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>None</option>
              <option>Reported</option>
              <option>Unavailable</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!hasLocalFilters}
            onClick={() => {
              setOrderQuery("");
              setFilter("All");
              setClaimFilter("All");
              setExceptionFilter("All");
            }}
          >
            Clear page filters
          </button>
        </div>
        <p id="pickup-command-availability" className="muted">
          Claim and Report exception are unavailable until an authorized source-bound Task or
          Fulfillment command is defined for this Pickup.
        </p>
        <p id="pickup-overdue-availability" className="muted">
          Waiting time shows elapsed minutes since the Order became ready. Overdue classification is
          unavailable because this view has no authorized due time.
        </p>
        <nav className="pickup-pagination" aria-label="Pickup pages">
          <button disabled={!onPrevious} onClick={onPrevious}>
            Previous page
          </button>
          <button disabled={!onNext} onClick={onNext}>
            Next page
          </button>
        </nav>
        {view.items.length ? (
          <div className="store-card-grid pickup-queue__cards">
            {view.items.map((item) => (
              <PickupCard
                key={item.fulfillmentReference}
                item={item}
                observedAt={view.projectedAt}
                readOnly={readOnly}
                proofContext={proofContext}
                workstation={view.workstation}
                hidden={!visibleReferences.has(item.fulfillmentReference)}
              />
            ))}
          </div>
        ) : null}
        {items.length === 0 ? (
          <StatePanel heading="No matching pickups" status>
            <p>No authorized pickup matches this page and filter.</p>
          </StatePanel>
        ) : null}
      </div>
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

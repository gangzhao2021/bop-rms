import { PickupProofForm } from "./PickupProofForm.js";
import { PickupHandoffForm } from "./PickupHandoffForm.js";
import { PickupNotCollectedAction, pickupHoldMinutes } from "./PickupNotCollectedAction.js";
import { StatePanel } from "@bop-rms/ui";
import { Freshness } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
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
    Loading: ["Loading", "Loading pickups…"],
    PermissionDenied: [
      "Permission denied",
      "Your permissions or Store scope do not allow the pickup queue.",
    ],
    NotFound: ["Pickup unavailable", "This pickup is not at the selected Store."],
    Offline: ["You’re offline", "Reconnect and refresh before handing over a pickup."],
    Conflict: ["Pickup changed", "Refresh to see the current pickup before trying again."],
    CommandFailed: [
      "Action not confirmed",
      "The handoff was not confirmed. Refresh before trying again.",
    ],
    Unavailable: [
      "Pickups unavailable",
      "The pickup queue could not be loaded. Refresh to try again.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Home</Link>
    </StatePanel>
  );
}
/** Waiting-time tier for the eyebrow colour: a pickup left too long turns visibly late. */
export function waitTier(waitMinutes: number, completed: boolean): "ok" | "warning" | "late" {
  if (completed) return "ok";
  return waitMinutes >= pickupHoldMinutes ? "late" : waitMinutes >= 15 ? "warning" : "ok";
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
  // WP-2423: the pickup code expired or was never sent; staff check the customer in person.
  const inPersonEligible =
    !readOnly &&
    item.phase === "Ready" &&
    (item.proofReadiness === "Expired" || item.proofReadiness === "NotIssued");
  return (
    <article className="store-card pickup-queue__card" hidden={hidden}>
      <header>
        <div>
          <p className="bop-eyebrow pickup-queue__phase" data-wait={waitTier(wait, completed)}>
            {completed ? "Completed" : `Ready for ${wait} min`}
          </p>
          <h3>
            Order{" "}
            {item.publicOrderNumber ?? item.execution?.publicOrderReference ?? "number unavailable"}
          </h3>
        </div>
        <strong className="pickup-queue__status" data-completed={completed}>
          {completed ? "Handed over" : "Waiting"}
        </strong>
      </header>
      <dl>
        <div>
          <dt>Pickup code</dt>
          <dd>
            {item.proofReadiness === "Expired"
              ? "Code expired · check in person"
              : item.proofReadiness === "NotIssued"
                ? "No code sent · check in person"
                : item.proofReadiness === "Ready"
                  ? "Sent to customer"
                  : item.proofReadiness}
          </dd>
        </div>
        <div>
          <dt>Shelf</dt>
          <dd>{item.stagingLocation ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Packages</dt>
          <dd>{item.packageCount ?? "Not set"}</dd>
        </div>
        <div>
          <dt>Allergen</dt>
          <dd>
            {item.allergenCue === "Present"
              ? "Allergen present"
              : item.allergenCue === "None"
                ? "No cue"
                : "Unavailable"}
          </dd>
        </div>
        {item.exceptionStatus === "Reported" ? (
          <div>
            <dt>Exception</dt>
            <dd>Reported</dd>
          </div>
        ) : null}
      </dl>
      {!completed ? (
        <div className="card-actions">
          {inPersonEligible && workstation && proofContext ? (
            <PickupHandoffForm
              key={"in-person:" + (item.execution?.aggregateVersion ?? "")}
              item={item}
              verification={null}
              workstation={workstation}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
            />
          ) : canComplete && item.execution && proofContext ? (
            <PickupProofForm
              key={item.execution.aggregateVersion + ":" + item.execution.proof?.generation}
              item={item}
              workstation={workstation}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
            />
          ) : null}
          {inPersonEligible && wait >= pickupHoldMinutes && proofContext ? (
            <PickupNotCollectedAction
              item={item}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
            />
          ) : null}
        </div>
      ) : null}
      {canComplete && !workstation ? (
        <p role="status">Handoff is not available on this device. Ask a manager.</p>
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
    <WorkspacePage
      className="pickup-queue"
      title="Pickup"
      meta={view.storeLabel}
      status={<Freshness status={view.freshnessStatus} at={view.projectedAt} />}
      actions={
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      <>
        {readOnly ? (
          <StatePanel heading="Data may be out of date" tone="offline" status>
            <p>Refresh before confirming a handoff.</p>
          </StatePanel>
        ) : null}
        <div className="list-filters pickup-queue__filters">
          <label>
            Order number
            <input
              type="search"
              value={orderQuery}
              onChange={(event) => setOrderQuery(event.currentTarget.value)}
              placeholder="e.g. 16"
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
            Status
            <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
              <option value="All">All</option>
              <option value="Ready">Ready</option>
              <option value="Waiting">Waiting</option>
              <option value="InProgress">In progress</option>
              <option value="Completed">Completed</option>
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
            Clear filters
          </button>
        </div>
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
          <StatePanel heading="No pickups waiting" status>
            <p>
              {view.items.length === 0
                ? "Nothing is waiting for pickup right now."
                : "No pickup on this page matches the filters."}
            </p>
          </StatePanel>
        ) : null}
      </>
    </WorkspacePage>
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
      <WorkspacePage
        className="pickup-queue"
        title="Pickup"
        meta={props.storeLabel}
        actions={
          state.kind !== "Loading" ? (
            <button ref={refreshButtonRef} onClick={refresh}>
              Refresh
            </button>
          ) : null
        }
      >
        <PickupStatePanel state={state.kind} />
      </WorkspacePage>
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

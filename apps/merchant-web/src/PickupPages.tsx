import { PickupProofForm } from "./PickupProofForm.js";
import { PickupHandoffForm } from "./PickupHandoffForm.js";
import { PickupNotCollectedAction, pickupHoldMinutes } from "./PickupNotCollectedAction.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { StatePanel } from "@bop-rms/ui";
import { Freshness } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { useCallback, useEffect, useState, useMemo, useRef, type RefObject } from "react";
import { createPickupClient } from "./pickup-client.js";
import { Link } from "react-router";
import {
  readFailureReason,
  replacesLastRead,
  StaleReadNotice,
  useBrowserOffline,
  useStaleRetry,
  type ReadFailure,
  type StaleRead,
} from "./stale-read.js";
import {
  parsePickupQueueView,
  PickupClientError,
  unavailablePickupClient,
  type PickupClient,
  type PickupQueueItem,
  type PickupQueueView,
  type PickupWorkstation,
} from "./pickup.js";
export type PickupLoadState = State;
type State =
  | { readonly kind: "Loading" }
  | { readonly kind: ReadFailure }
  | {
      readonly kind: "Found";
      readonly view: PickupQueueView;
      readonly loadedAt: string;
      /** IDR-0039: the re-read failed; `view` is the last loaded queue, shown read-only. */
      readonly stale?: StaleRead;
    };
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
/** WP-2423 Q9: the pickup queue re-reads on its own while it is visible. */
export const pickupRefreshIntervalMs = 10_000;
/** The queue the browser just reported offline: the last pickups stay, read-only (IDR-0039). */
export function pickupOfflineState<
  T extends { readonly state: PickupLoadState; readonly failures: number },
>(previous: T): T {
  if (previous.state.kind !== "Found" || previous.state.stale !== undefined) return previous;
  const failures = previous.failures + 1;
  return {
    ...previous,
    failures,
    state: {
      ...previous.state,
      stale: { reason: "Offline", lastLoadedAt: previous.state.loadedAt, attempts: failures },
    },
  };
}
/** Waiting-time tier for the eyebrow colour: a pickup left too long turns visibly late. */
export function waitTier(waitMinutes: number, completed: boolean): "ok" | "warning" | "late" {
  if (completed) return "ok";
  return waitMinutes >= pickupHoldMinutes ? "late" : waitMinutes >= 15 ? "warning" : "ok";
}
/** "20 min", "3 h 5 min", "5 days" — long waits in hours or days, never thousands of minutes. */
export function pickupWaitText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
  }
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? "1 day" : `${days} days`;
}
/** WP-2423 Q26: an order from an earlier business day (its number may repeat today). */
export function fromEarlierDay(item: PickupQueueItem, today: string | null | undefined): boolean {
  return Boolean(item.businessDate && today && item.businessDate < today);
}

function PickupCard({
  item,
  observedAt,
  readOnly,
  paused,
  proofContext,
  workstation,
  hidden,
  earlier = false,
  onHandedOver,
  onRefresh,
}: {
  /** Re-read the queue (after code checks were locked, to offer the in-person check). */
  readonly onRefresh?: (() => void) | undefined;
  /** WP-2423: the handover was recorded; the queue re-reads and confirms it. */
  readonly onHandedOver?: ((orderLabel: string) => void) | undefined;
  /** IDR-0039: offline or stale; actions stay on screen but cannot be used. */
  readonly paused: boolean;
  readonly workstation?: PickupWorkstation | null | undefined;
  readonly item: PickupQueueItem;
  readonly observedAt: string;
  readonly readOnly: boolean;
  readonly proofContext?: { csrf: string; storeReference: string } | undefined;
  readonly hidden: boolean;
  /** WP-2423 Q26: the order belongs to an earlier business day. */
  readonly earlier?: boolean;
}) {
  const completed = item.phase === "Completed";
  const wait = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.readyAt)) / 60_000),
  );
  const canComplete = !readOnly && item.phase !== "Completed" && item.proofReadiness === "Ready";
  // WP-2423: the pickup code expired, was never sent, or is locked after five wrong codes; staff
  // check the customer in person.
  const inPersonEligible =
    !readOnly &&
    item.phase === "Ready" &&
    (item.proofReadiness === "Expired" ||
      item.proofReadiness === "NotIssued" ||
      item.proofReadiness === "Locked");
  const orderLabel =
    item.publicOrderNumber ?? item.execution?.publicOrderReference ?? "number unavailable";
  const recorded = onHandedOver ? () => onHandedOver(orderLabel) : undefined;
  return (
    <article className="store-card pickup-queue__card" hidden={hidden}>
      <header>
        <div>
          <p className="bop-eyebrow pickup-queue__phase" data-wait={waitTier(wait, completed)}>
            {completed ? "Completed" : `Ready for ${pickupWaitText(wait)}`}
          </p>
          <h3>
            Order{" "}
            {item.publicOrderNumber ?? item.execution?.publicOrderReference ?? "number unavailable"}
          </h3>
          {earlier && item.businessDate ? (
            <p className="pickup-queue__day">From {businessDateText(item.businessDate)}</p>
          ) : null}
        </div>
        <strong className="pickup-queue__status" data-completed={completed}>
          {completed ? "Handed over" : "Waiting"}
        </strong>
      </header>
      {earlier && !completed ? (
        <p className="pickup-queue__earlier" role="note">
          From an earlier business day. Check whether it was collected, then close it.
        </p>
      ) : null}
      {!completed && item.remakeQuantity ? (
        <p className="pickup-queue__remake" role="status">
          Kitchen is remaking{" "}
          {item.remakeQuantity === 1 ? "1 item" : `${item.remakeQuantity} items`} — wait for it
          before handing this order over.
        </p>
      ) : null}
      <dl>
        <div>
          <dt>Pickup code</dt>
          <dd>
            {item.proofReadiness === "Expired"
              ? "Code expired · check in person"
              : item.proofReadiness === "Locked"
                ? "Too many wrong codes · check in person"
                : item.proofReadiness === "NotIssued"
                  ? "No code sent · check in person"
                  : item.proofReadiness === "Ready"
                    ? "Sent to customer"
                    : "Not known yet · check in person"}
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
        {item.allergenCue !== "Unavailable" ? (
          <div>
            <dt>Allergen</dt>
            <dd>{item.allergenCue === "Present" ? "Allergen present" : "No cue"}</dd>
          </div>
        ) : null}
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
              paused={paused}
              item={item}
              verification={null}
              workstation={workstation}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
              onRecorded={recorded}
            />
          ) : canComplete && item.execution && proofContext ? (
            <PickupProofForm
              key={item.execution.aggregateVersion + ":" + item.execution.proof?.generation}
              paused={paused}
              item={item}
              workstation={workstation}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
              onRecorded={recorded}
              onLocked={onRefresh}
            />
          ) : null}
          {inPersonEligible && wait >= pickupHoldMinutes && proofContext ? (
            <PickupNotCollectedAction
              paused={paused}
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
  stale,
  checkedAt,
  handedOver,
  onHandedOver,
}: {
  readonly view: PickupQueueView;
  /** WP-2423: the order just handed over on this device (plain confirmation). */
  readonly handedOver?: string | null | undefined;
  readonly onHandedOver?: ((orderLabel: string) => void) | undefined;
  readonly stale?: StaleRead | undefined;
  /** When this device last read the queue successfully (shown as "Last checked"). */
  readonly checkedAt?: string | undefined;
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
  const claimFilterAvailable =
    view.items.length > 0 && view.items.every((item) => item.claimStatus !== "Unavailable");
  const exceptionFilterAvailable =
    view.items.length > 0 && view.items.every((item) => item.exceptionStatus !== "Unavailable");
  const activeClaim = claimFilterAvailable ? claimFilter : "All";
  const activeException = exceptionFilterAvailable ? exceptionFilter : "All";
  const query = orderQuery.trim().toLocaleLowerCase();
  const items = view.items.filter(
    (item) =>
      (!query ||
        (item.publicOrderNumber ?? item.execution?.publicOrderReference ?? "")
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "All" ||
        (filter === "Waiting" ? item.phase !== "Completed" : item.phase === filter)) &&
      (activeClaim === "All" || item.claimStatus === activeClaim) &&
      (activeException === "All" || item.exceptionStatus === activeException),
  );
  const hasLocalFilters =
    Boolean(query) || filter !== "All" || activeClaim !== "All" || activeException !== "All";
  const visibleReferences = new Set(items.map((item) => item.fulfillmentReference));
  // WP-2423 Q26: earlier business days' orders are grouped apart so their repeated numbers are not
  // mistaken for today's orders.
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const earlierItems = view.items.filter((item) => fromEarlierDay(item, today));
  const todayItems = view.items.filter((item) => !fromEarlierDay(item, today));
  return (
    <WorkspacePage
      className="pickup-queue"
      title="Pickup"
      meta={view.storeLabel}
      status={
        <Freshness
          status={stale ? "Stale" : view.freshnessStatus}
          at={view.projectedAt}
          checkedAt={checkedAt}
        />
      }
      actions={
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      <>
        {handedOver ? (
          <p className="pickup-queue__handed-over" role="status">
            Order {handedOver} handed over.
          </p>
        ) : null}
        {stale ? (
          <StaleReadNotice stale={stale} />
        ) : readOnly ? (
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
          {/* WP-2423: a filter is offered only when the loaded pickups carry that fact. */}
          {claimFilterAvailable ? (
            <label>
              Claim
              <select
                value={claimFilter}
                onChange={(event) => setClaimFilter(event.currentTarget.value)}
              >
                <option value="All">All</option>
                <option value="Unclaimed">Not claimed</option>
                <option value="Claimed">Claimed</option>
              </select>
            </label>
          ) : null}
          {exceptionFilterAvailable ? (
            <label>
              Exception
              <select
                value={exceptionFilter}
                onChange={(event) => setExceptionFilter(event.currentTarget.value)}
              >
                <option value="All">All</option>
                <option value="None">No exception</option>
                <option value="Reported">Exception reported</option>
              </select>
            </label>
          ) : null}
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
        {todayItems.length ? (
          <div className="store-card-grid pickup-queue__cards">
            {todayItems.map((item) => (
              <PickupCard
                key={item.fulfillmentReference}
                item={item}
                observedAt={view.projectedAt}
                readOnly={readOnly}
                paused={stale !== undefined}
                proofContext={proofContext}
                workstation={view.workstation}
                hidden={!visibleReferences.has(item.fulfillmentReference)}
                onHandedOver={onHandedOver}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        ) : null}
        {earlierItems.some((item) => visibleReferences.has(item.fulfillmentReference)) ? (
          <section
            className="pickup-queue__earlier-section"
            aria-labelledby="pickup-earlier-heading"
          >
            <h2 id="pickup-earlier-heading">From earlier days — check and close</h2>
            <p>
              These orders are from an earlier business day. Their numbers may repeat today&apos;s.
              If the customer collected the order, hand it over with the code or in person; if not,
              a manager closes it as not collected.
            </p>
            <div className="store-card-grid pickup-queue__cards">
              {earlierItems.map((item) => (
                <PickupCard
                  key={item.fulfillmentReference}
                  item={item}
                  observedAt={view.projectedAt}
                  readOnly={readOnly}
                  paused={stale !== undefined}
                  proofContext={proofContext}
                  workstation={view.workstation}
                  hidden={!visibleReferences.has(item.fulfillmentReference)}
                  earlier
                  onHandedOver={onHandedOver}
                  onRefresh={onRefresh}
                />
              ))}
            </div>
          </section>
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
    [revision, setRevision] = useState(0),
    [handedOver, setHandedOver] = useState<string | null>(null);
  // WP-2423: the confirmation stays long enough to read, then clears.
  useEffect(() => {
    if (handedOver === null) return;
    const timer = window.setTimeout(() => setHandedOver(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [handedOver]);
  const cursor = cursors.at(-1) ?? null;
  const load = useCallback(
    () =>
      client
        .loadQueue({ afterFulfillmentReference: cursor, includeCompleted })
        .then(parsePickupQueueView),
    [client, cursor, includeCompleted],
  );
  const queueKey = JSON.stringify([cursor, includeCompleted]);
  const key = queueKey + ":" + String(revision);
  const [stored, setStored] = useState<{
    key: string;
    queueKey: string;
    load: typeof load;
    state: State;
    failures: number;
  }>({ key, queueKey, load, state: { kind: "Loading" }, failures: 0 });
  const current = stored.key === key && stored.load === load;
  // A plain refresh keeps the queue on screen while it re-reads; another page or filter does not.
  const sameQueue = stored.queueKey === queueKey && stored.load === load;
  const state: State =
    current || (sameQueue && stored.state.kind === "Found") ? stored.state : { kind: "Loading" };
  const refreshButtonRef = useRef<HTMLButtonElement>(null),
    focusAfterLoad = useRef(false);
  useEffect(() => {
    let active = true;
    void load()
      .then((view) => {
        if (active)
          setStored({
            key,
            queueKey,
            load,
            failures: 0,
            state: { kind: "Found", view, loadedAt: new Date().toISOString() },
          });
      })
      .catch((error) => {
        if (!active) return;
        const reason = readFailureReason(
          error instanceof PickupClientError ? error.code : "Unavailable",
        );
        setStored((previous) => {
          const failures = previous.failures + 1;
          // IDR-0039: the same queue stays visible, read-only, unless access itself was lost.
          const keep =
            previous.state.kind === "Found" &&
            previous.load === load &&
            previous.queueKey === queueKey &&
            !replacesLastRead(reason);
          return {
            key,
            queueKey,
            load,
            failures,
            state:
              keep && previous.state.kind === "Found"
                ? {
                    kind: "Found",
                    view: previous.state.view,
                    loadedAt: previous.state.loadedAt,
                    stale: { reason, lastLoadedAt: previous.state.loadedAt, attempts: failures },
                  }
                : { kind: reason },
          };
        });
      });
    return () => {
      active = false;
    };
  }, [key, queueKey, load]);
  const stale = state.kind === "Found" ? state.stale : undefined;
  useStaleRetry(stale?.attempts ?? null, () => setRevision((value) => value + 1));
  // IDR-0039: the browser saying the network is gone is enough to go read-only at once.
  useBrowserOffline(() => setStored(pickupOfflineState));
  // Re-read on its own while visible, like the Kitchen board, so an outage is noticed.
  const live = state.kind === "Found" && stale === undefined;
  useEffect(() => {
    if (!live || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    }, pickupRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (current && state.kind !== "Loading" && focusAfterLoad.current) {
      refreshButtonRef.current?.focus();
      focusAfterLoad.current = false;
    }
  }, [current, state.kind, key]);
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
      stale={stale}
      checkedAt={state.loadedAt}
      handedOver={handedOver}
      onHandedOver={(orderLabel) => {
        // Re-read at once so the order leaves Waiting without anyone pressing Refresh.
        setHandedOver(orderLabel);
        focusAfterLoad.current = true;
        setRevision((value) => value + 1);
      }}
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

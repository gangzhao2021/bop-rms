import { useKitchenActions } from "./use-kitchen-actions.js";
import type { KitchenAction } from "./kitchen-work-client.js";
import { createKitchenBoardClient } from "./kitchen-board-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  KitchenBoardClientError,
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemDetailView,
  unavailableKitchenBoardClient,
  type KitchenBoardClient,
  type KitchenBoardItem,
  type KitchenBoardView,
  type KitchenQueueSearch,
  type KitchenWorkItemDetailView,
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

function formatKitchenSourceTime(value: string): string {
  return `${new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
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
  showDetails = true,
  showActions = true,
  showModifiers = false,
  detailState,
}: {
  readonly item: KitchenBoardItem;
  readonly readOnly: boolean;
  readonly observedAt: string;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  readonly showDetails?: boolean;
  readonly showActions?: boolean;
  readonly showModifiers?: boolean;
  readonly detailState?: KitchenQueueScope;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(item.createdAt)) / 60_000),
  );
  const allergenLabel = {
    None: "No allergen cue",
    ReviewRequired: "Allergen review required",
    Acknowledged: "Allergen acknowledged",
    Unavailable: "Allergen status unavailable",
  }[item.allergenCue];
  const exceptionLabel =
    item.exceptionStatus === "Reported"
      ? "Exception reported"
      : item.exceptionStatus === "Unavailable"
        ? "Exception status unavailable"
        : null;
  const safetyCuesUnavailable =
    item.allergenCue === "Unavailable" && item.exceptionStatus === "Unavailable";
  return (
    <article
      className={`kitchen-work-item${!showDetails && !showActions ? " kitchen-work-item--detail" : ""}`}
      data-read-only={readOnly}
    >
      <div className="kitchen-work-item__summary">
        <h3>
          {showDetails ? (
            <Link
              className="kitchen-work-item__detail-link"
              to={`/operations/kitchen/work-items/${item.workItemReference}`}
              state={detailState ? { kitchenQueueScope: detailState } : undefined}
            >
              {item.displayName}
            </Link>
          ) : (
            item.displayName
          )}
        </h3>
      </div>
      <div className="kitchen-work-item__state">
        <strong data-status={item.status}>{item.status}</strong>
        <span>{age} min</span>
      </div>
      <div className="kitchen-work-item__facts">
        <dl className="kitchen-work-item__quantity">
          <dt>Quantity</dt>
          <dd>
            {item.completedQuantity} / {item.requiredQuantity}
          </dd>
        </dl>
        {safetyCuesUnavailable && showDetails ? (
          <span
            className="kitchen-work-item__cue"
            data-kind="unavailable"
            aria-label="Allergen status unavailable; Exception status unavailable"
          >
            Allergen / exception cues unavailable
          </span>
        ) : (
          <>
            <span
              className="kitchen-work-item__cue"
              data-kind="allergen"
              data-value={item.allergenCue}
            >
              {allergenLabel}
            </span>
            {exceptionLabel ? (
              <span
                className="kitchen-work-item__cue"
                data-kind="exception"
                data-value={item.exceptionStatus}
              >
                {exceptionLabel}
              </span>
            ) : null}
          </>
        )}
      </div>
      {showModifiers ? (
        <section className="kitchen-work-item__modifiers" aria-label="Modifiers">
          <h4>Modifiers</h4>
          {item.selectedOptions.length === 0 ? (
            <p>No selected modifiers</p>
          ) : (
            <ul>
              {item.selectedOptions.map((option, index) => (
                <li key={`${option.displayName}:${index}`}>
                  <span>{option.displayName}</span>
                  <span aria-label={`Quantity ${option.quantity}`}>× {option.quantity}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showDetails || showActions ? (
        <div className="kitchen-work-item__actions">
          {showActions ? (
            item.execution ? (
              <>
                {item.status === "Queued" && item.execution.acceptedAt === null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "AcceptKitchenWorkItem")}
                  >
                    Accept
                  </button>
                ) : null}
                {item.status === "Queued" && item.execution.acceptedAt !== null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "StartKitchenWorkItem")}
                  >
                    Start
                  </button>
                ) : null}
                {item.status === "In Progress" && item.completedQuantity < item.requiredQuantity ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "CompleteKitchenWorkItem")}
                  >
                    Complete quantity
                  </button>
                ) : null}
                {item.status === "Completed" && item.execution.readyAt === null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "MarkKitchenOrderItemReady")}
                  >
                    Mark ready
                  </button>
                ) : null}
              </>
            ) : (
              <span>Lifecycle action state unavailable from this projection</span>
            )
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

interface KitchenQueueScope {
  readonly station: string;
  readonly status: string;
  readonly allergen: string;
  readonly exception: string;
}

function restoredQueueScope(value: unknown): KitchenQueueScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).kitchenQueueScope;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    Reflect.ownKeys(candidate).length !== 4
  )
    return undefined;
  const scope: Record<string, unknown> = {};
  for (const key of ["station", "status", "allergen", "exception"]) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    scope[key] = descriptor.value;
  }
  if (
    typeof scope.station !== "string" ||
    scope.station.length > 100 ||
    !["All", "Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(
      String(scope.status),
    ) ||
    !["All", "None", "ReviewRequired", "Acknowledged", "Unavailable"].includes(
      String(scope.allergen),
    ) ||
    !["All", "None", "Reported", "Unavailable"].includes(String(scope.exception))
  )
    return undefined;
  return {
    station: scope.station,
    status: scope.status as string,
    allergen: scope.allergen as string,
    exception: scope.exception as string,
  };
}

export function KitchenBoardScreen({
  view,
  onSearch,
  searchApplied = false,
  onRefresh,
  refreshButtonRef,
  onAction,
  actionsBlocked = true,
  navigation,
}: {
  readonly view: KitchenBoardView;
  readonly onSearch?: (search: KitchenQueueSearch | null) => void;
  readonly searchApplied?: boolean;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  readonly actionsBlocked?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly navigation?: ReactNode;
}) {
  const location = useLocation();
  const restored = restoredQueueScope(location.state);
  const [station, setStation] = useState(restored?.station ?? "All");
  const [status, setStatus] = useState(restored?.status ?? "All");
  const [allergen, setAllergen] = useState(restored?.allergen ?? "All");
  const [exception, setException] = useState(restored?.exception ?? "All");
  const [referenceKind, setReferenceKind] = useState<KitchenQueueSearch["kind"]>("Order");
  const [referenceInput, setReferenceInput] = useState("");
  const filterSheetRef = useRef<HTMLDialogElement>(null);
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const stations = [
    ...new Set(
      view.items.flatMap((item) => (item.stationLabel === null ? [] : [item.stationLabel])),
    ),
  ];
  const stationFilterAvailable =
    stations.length > 0 && view.items.every((item) => item.stationLabel !== null);
  const allergenFilterAvailable =
    view.items.length > 0 && view.items.every((item) => item.allergenCue !== "Unavailable");
  const exceptionFilterAvailable =
    view.items.length > 0 && view.items.every((item) => item.exceptionStatus !== "Unavailable");
  const activeStation = stationFilterAvailable && stations.includes(station) ? station : "All";
  const activeAllergen = allergenFilterAvailable ? allergen : "All";
  const activeException = exceptionFilterAvailable ? exception : "All";
  const items = view.items.filter(
    (item) =>
      (activeStation === "All" || item.stationLabel === activeStation) &&
      (status === "All" || item.status === status) &&
      (activeAllergen === "All" || item.allergenCue === activeAllergen) &&
      (activeException === "All" || item.exceptionStatus === activeException),
  );
  const stationLaneMap = new Map<
    string,
    { key: string; stationLabel: string | null; items: KitchenBoardItem[] }
  >();
  for (const item of items) {
    const stationReference = item.execution?.stationReference;
    const key =
      stationReference !== undefined
        ? `reference:${stationReference}`
        : item.stationLabel === null
          ? "unavailable"
          : `label:${item.stationLabel}`;
    const lane = stationLaneMap.get(key);
    if (lane) lane.items.push(item);
    else stationLaneMap.set(key, { key, stationLabel: item.stationLabel, items: [item] });
  }
  const stationLanes = [...stationLaneMap.values()];
  const hasFilters =
    activeStation !== "All" ||
    status !== "All" ||
    activeAllergen !== "All" ||
    activeException !== "All";
  const openFilterSheet = () => {
    const dialog = filterSheetRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLSelectElement>("select:not(:disabled)")?.focus();
  };
  const renderReferenceSearch = (layout: "desktop" | "mobile") => (
    <form
      className={`kitchen-reference-search kitchen-reference-search--${layout}`}
      role="search"
      aria-label="Search Kitchen by exact reference"
      onSubmit={(event) => {
        event.preventDefault();
        if (!onSearch) return;
        try {
          parseKitchenRouteReference(referenceInput);
          onSearch({ kind: referenceKind, reference: referenceInput });
          setReferenceInput("");
        } catch {
          const input = event.currentTarget.elements.namedItem("reference");
          if (input instanceof HTMLInputElement) input.reportValidity();
        }
      }}
    >
      <label
        className={`kitchen-reference-search__label${layout === "desktop" ? " kitchen-filter-visually-hidden" : ""}`}
        htmlFor={`kitchen-reference-search-${layout}`}
      >
        Order or ticket reference
      </label>
      <select
        aria-label="Reference type"
        value={referenceKind}
        onChange={(event) => setReferenceKind(event.currentTarget.value as "Order" | "Ticket")}
      >
        <option>Order</option>
        <option>Ticket</option>
      </select>
      <input
        id={`kitchen-reference-search-${layout}`}
        name="reference"
        aria-label="Exact reference"
        aria-describedby={`kitchen-reference-search-hint-${layout}`}
        placeholder={layout === "mobile" ? "UUIDv7 reference" : "Exact UUIDv7 reference"}
        value={referenceInput}
        onChange={(event) => setReferenceInput(event.currentTarget.value)}
        required
        pattern="[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="kitchen-reference-search__actions">
        <button type="submit" disabled={!onSearch}>
          Search
        </button>
        {layout === "mobile" || searchApplied ? (
          <button
            type="button"
            aria-label="Clear search"
            disabled={!searchApplied && referenceInput.length === 0}
            onClick={() => {
              setReferenceInput("");
              if (searchApplied) onSearch?.(null);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <span
        className={`kitchen-reference-search__hint${layout === "desktop" ? " kitchen-filter-visually-hidden" : ""}`}
        id={`kitchen-reference-search-hint-${layout}`}
      >
        Exact reference only. The value stays in this page session and is not added to the URL.
      </span>
    </form>
  );
  const renderFilters = (layout: "desktop" | "mobile") => (
    <div
      className={`list-filters kitchen-board-filters kitchen-board-filters--${layout}`}
      role="search"
      aria-label="Filter Kitchen work items"
    >
      <label>
        <span
          className={
            layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
          }
        >
          Station
        </span>
        <select
          value={activeStation}
          disabled={!stationFilterAvailable}
          onChange={(event) => setStation(event.currentTarget.value)}
        >
          <option value="All">{stationFilterAvailable ? "All stations" : "Unavailable"}</option>
          {stations.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        <span
          className={
            layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
          }
        >
          Work state
        </span>
        <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="All">All states</option>
          <option>Queued</option>
          <option>Held</option>
          <option>In Progress</option>
          <option>Completed</option>
          <option>Cancelled</option>
        </select>
      </label>
      <label>
        <span
          className={
            layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
          }
        >
          Allergen
        </span>
        <select
          value={activeAllergen}
          disabled={!allergenFilterAvailable}
          onChange={(event) => setAllergen(event.currentTarget.value)}
        >
          <option value="All">
            {allergenFilterAvailable ? (layout === "mobile" ? "All" : "Allergen") : "Unavailable"}
          </option>
          <option>None</option>
          <option>ReviewRequired</option>
          <option>Acknowledged</option>
          <option>Unavailable</option>
        </select>
      </label>
      <label>
        <span
          className={
            layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
          }
        >
          Exception
        </span>
        <select
          value={activeException}
          disabled={!exceptionFilterAvailable}
          onChange={(event) => setException(event.currentTarget.value)}
        >
          <option value="All">
            {exceptionFilterAvailable ? (layout === "mobile" ? "All" : "Exception") : "Unavailable"}
          </option>
          <option>None</option>
          <option>Reported</option>
          <option>Unavailable</option>
        </select>
      </label>
      {layout === "mobile" || hasFilters ? (
        <button
          type="button"
          disabled={!hasFilters}
          onClick={() => {
            setStation("All");
            setStatus("All");
            setAllergen("All");
            setException("All");
          }}
        >
          Clear filters
        </button>
      ) : null}
      {layout === "mobile" ? (
        <>
          <button
            className="kitchen-filter-sheet__done"
            type="button"
            onClick={() => filterSheetRef.current?.close()}
          >
            Done
          </button>
          <p className="kitchen-filter-sheet__note">
            Filters apply only to fields present for every loaded work item. Allergen and exception
            filters are unavailable here; the KDS Session and device lock are unverified, and board
            actions are disabled.
          </p>
        </>
      ) : null}
    </div>
  );
  return (
    <AppFrame
      title="OPERATIONS"
      mobileBrandTitle="KITCHEN"
      description={view.storeLabel}
      navigation={
        navigation ? (
          <>
            <span className="kitchen-navigation-label">WORKSPACE</span>
            {navigation}
          </>
        ) : undefined
      }
    >
      <div className="kitchen-board-workspace">
        <header className="screen-heading">
          <div>
            <h2>Kitchen</h2>
            <p className="kitchen-board-eyebrow">KIT-KITCHEN-QUEUE · Active work</p>
            <p className="kitchen-board-freshness">
              <span data-freshness={view.freshnessStatus}>{view.freshnessStatus}</span>
              <span>
                {view.operatorStatus === "Unverified"
                  ? "KDS session unverified"
                  : `${view.operatorStatus} operator`}
              </span>
            </p>
          </div>
          <button
            ref={refreshButtonRef}
            disabled={!onRefresh}
            onClick={onRefresh}
            aria-label="Refresh from source"
          >
            <span className="kitchen-refresh-label--long">Refresh from source</span>
            <span className="kitchen-refresh-label--short" aria-hidden="true">
              Refresh
            </span>
          </button>
        </header>
        <button
          className="kitchen-filter-toggle"
          type="button"
          aria-haspopup="dialog"
          onClick={openFilterSheet}
        >
          Filters{hasFilters || searchApplied ? " · Active" : " · All work"}
        </button>
        {readOnly ? (
          <div className="kitchen-board-lock">
            <StatePanel heading="Board locked — read-only" tone="offline" status>
              <p>
                {view.operatorStatus === "Unverified"
                  ? "KDS session or device lock is unverified. Kitchen commands are disabled."
                  : "A fresh projection and named unlocked operator session are required for Kitchen commands."}
              </p>
            </StatePanel>
          </div>
        ) : null}
        <header className="kitchen-queue-heading">
          <div>
            <h2>Queue</h2>
            <p>
              Available filters use fields in the current Kitchen projection for {view.storeLabel}.
            </p>
          </div>
        </header>
        <div className="kitchen-filter-toolbar">
          {renderReferenceSearch("desktop")}
          {renderFilters("desktop")}
          <span className="kitchen-queue-count" aria-live="polite">
            {items.length} work {items.length === 1 ? "item" : "items"}
          </span>
        </div>
        <dialog
          className="kitchen-filter-sheet"
          ref={filterSheetRef}
          aria-labelledby="kitchen-filter-title"
        >
          <div className="kitchen-filter-sheet__heading">
            <h2 id="kitchen-filter-title">Filter Kitchen work</h2>
            <button type="button" onClick={() => filterSheetRef.current?.close()}>
              Close
            </button>
          </div>
          {renderReferenceSearch("mobile")}
          {renderFilters("mobile")}
        </dialog>
        {items.length === 0 ? (
          <StatePanel
            heading={searchApplied || view.items.length > 0 ? "No matching work" : "No active work"}
            status
          >
            <p>
              {searchApplied
                ? "No work item matches this exact reference. Clear search to restore the queue."
                : view.items.length === 0
                  ? "No authorized work item is available in the loaded queue."
                  : "No loaded work item matches the current filters. Clear the filters to restore the queue."}
            </p>
          </StatePanel>
        ) : (
          <div className="kitchen-board-lanes">
            {stationLanes.map((lane, laneIndex) => {
              const stationName = lane.stationLabel ?? "Station labels unavailable";
              const stationItems = lane.items;
              return (
                <section
                  className="kitchen-station-lane"
                  role="region"
                  key={lane.key}
                  aria-label={
                    lane.stationLabel === null
                      ? `Kitchen work items; station labels unavailable; lane ${laneIndex + 1} of ${stationLanes.length}`
                      : `${stationName} station`
                  }
                >
                  <header className="kitchen-station-lane__heading">
                    <h3>{stationName}</h3>
                    <span aria-label={`${stationItems.length} active items`}>
                      {stationItems.length}
                    </span>
                  </header>
                  <div className="kitchen-station-lane__items">
                    {stationItems.map((item) => (
                      <WorkCard
                        key={item.workItemReference}
                        item={item}
                        readOnly={readOnly || actionsBlocked}
                        {...(onAction ? { onAction } : {})}
                        observedAt={view.projectedAt}
                        detailState={{
                          station: activeStation,
                          status,
                          allergen,
                          exception,
                        }}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        <p className="muted">
          Unavailable here: safe Order/ticket reference display, station labels, allergen/exception
          cues, course, priority, overdue criteria and Hold/Prioritize actions.
        </p>
      </div>
    </AppFrame>
  );
}

export function KitchenWorkItemScreen({
  view,
  onRefresh,
  navigation,
}: {
  readonly view: KitchenWorkItemDetailView;
  readonly onRefresh?: () => void;
  readonly navigation?: ReactNode;
}) {
  const location = useLocation();
  const queueState = restoredQueueScope(location.state);
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const milestones = [
    { label: "Work item created", at: view.item.createdAt },
    ...(view.item.execution?.acceptedAt
      ? [{ label: "Accepted", at: view.item.execution.acceptedAt }]
      : []),
    ...(view.item.execution?.readyAt
      ? [{ label: "Order item marked ready", at: view.item.execution.readyAt }]
      : []),
  ].sort((left, right) => left.at.localeCompare(right.at) || left.label.localeCompare(right.label));
  return (
    <AppFrame
      title="OPERATIONS"
      description={view.storeLabel}
      navigation={
        navigation ? (
          <>
            <span className="kitchen-navigation-label">WORKSPACE</span>
            {navigation}
          </>
        ) : undefined
      }
    >
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading">
          <div>
            <p className="kitchen-board-eyebrow">KIT-WORK-ITEM · Execution snapshot</p>
            <h2>{view.item.displayName}</h2>
            <p className="kitchen-board-freshness">
              <span data-freshness={view.freshnessStatus}>{view.freshnessStatus}</span>
              <span>
                {view.operatorStatus === "Unverified"
                  ? "KDS session unverified"
                  : `${view.operatorStatus} operator`}
              </span>
            </p>
          </div>
          <div className="kitchen-work-item-screen__heading-actions">
            <Link
              to="/operations/kitchen"
              state={queueState ? { kitchenQueueScope: queueState } : undefined}
            >
              Return to Kitchen queue
            </Link>
            <button onClick={onRefresh} disabled={!onRefresh} aria-label="Refresh from source">
              <span className="kitchen-refresh-label--long">Refresh from source</span>
              <span className="kitchen-refresh-label--short" aria-hidden="true">
                Refresh
              </span>
            </button>
          </div>
        </header>
        {readOnly ? (
          <div className="kitchen-board-lock">
            <StatePanel heading="Board locked — read-only" tone="offline" status>
              <p>
                {view.operatorStatus === "Unverified"
                  ? "The current source cannot verify a named KDS operator session or device lock. Kitchen commands are disabled."
                  : "A fresh projection and named unlocked operator session are required for Kitchen commands."}
              </p>
            </StatePanel>
          </div>
        ) : null}
        <section className="kitchen-work-item-screen__content" aria-labelledby="work-item-current">
          <h3 id="work-item-current">Current work</h3>
          <WorkCard
            item={view.item}
            readOnly
            observedAt={view.projectedAt}
            showDetails={false}
            showActions={false}
            showModifiers
          />
        </section>
        <section className="kitchen-work-item-screen__details" aria-labelledby="work-item-details">
          <header>
            <h3 id="work-item-details">Additional detail</h3>
            <p>
              Only milestones present in this authorized projection are shown; other registered
              detail remains unavailable.
            </p>
          </header>
          <dl>
            <div>
              <dt>Recipe &amp; handling snapshots</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Allergen acknowledgements</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Timers &amp; dependencies</dt>
              <dd>Unavailable</dd>
            </div>
            <div className="kitchen-work-item-screen__history-row">
              <dt>Work item history</dt>
              <dd>
                <ol className="kitchen-work-item-screen__history" aria-label="Work item milestones">
                  {milestones.map((milestone) => (
                    <li key={`${milestone.label}:${milestone.at}`}>
                      <span>{milestone.label}</span>
                      <time dateTime={milestone.at}>{formatKitchenSourceTime(milestone.at)}</time>
                    </li>
                  ))}
                </ol>
                <p className="kitchen-work-item-screen__history-note">
                  {view.item.execution
                    ? "Recorded acceptance and Order item ready times are shown above when available. Kitchen start, progress and completion timestamps are unavailable from this projection."
                    : "Acceptance and Order item ready times are not included in this response. Kitchen start, progress and completion timestamps are unavailable from this projection."}
                </p>
              </dd>
            </div>
          </dl>
          <p className="kitchen-work-item-screen__command-note">
            Commands are unavailable from this detail route. Queue filters are preserved when
            returning.
          </p>
        </section>
      </div>
    </AppFrame>
  );
}

function KitchenWorkItemUnavailableScreen({
  state,
  onRefresh,
  storeLabel,
  navigation,
  queueState,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found" | "Loading">;
  readonly onRefresh: () => void;
  readonly storeLabel: string;
  readonly navigation?: ReactNode;
  readonly queueState?: KitchenQueueScope;
}) {
  return (
    <AppFrame
      title="OPERATIONS"
      description={storeLabel}
      navigation={
        navigation ? (
          <>
            <span className="kitchen-navigation-label">WORKSPACE</span>
            {navigation}
          </>
        ) : undefined
      }
    >
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading">
          <div>
            <p className="kitchen-board-eyebrow">KIT-WORK-ITEM</p>
            <h2>Work item detail</h2>
          </div>
          <div className="kitchen-work-item-screen__heading-actions">
            <Link
              to="/operations/kitchen"
              state={queueState ? { kitchenQueueScope: queueState } : undefined}
            >
              Return to Kitchen queue
            </Link>
            <button onClick={onRefresh}>Refresh from source</button>
          </div>
        </header>
        <KitchenBoardStatePanel state={state} />
      </div>
    </AppFrame>
  );
}

interface KitchenPageProps {
  readonly client?: KitchenBoardClient;
  readonly csrf?: string;
  readonly storeLabel?: string;
  readonly storeReference?: string;
  readonly navigation?: ReactNode;
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
function KitchenBoardContent(props: KitchenPageProps) {
  const client = useClient(props),
    [revision, setRevision] = useState(0);
  const [search, setSearch] = useState<KitchenQueueSearch | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  const load = useCallback(
    () => client.loadQueue(search ?? undefined).then(parseKitchenBoardView),
    [client, search],
  );
  const state = useLoad(
    load,
    `queue:${revision}:${search?.kind ?? "all"}:${search ? "exact" : ""}`,
  );
  const actions = useKitchenActions({
    csrf: props.csrf,
    storeReference: props.storeReference,
    view: state.kind === "Found" ? state.view : null,
    revision,
  });
  const refreshButtonRef = useRef<HTMLButtonElement>(null),
    retryButtonRef = useRef<HTMLButtonElement>(null),
    restoreRetryFocus = useRef(false);
  const runAction = (item: KitchenBoardItem, action: KitchenAction) => {
    restoreRetryFocus.current = document.activeElement instanceof HTMLButtonElement;
    actions.act(item, action);
  };
  const retry = () => {
    restoreRetryFocus.current = document.activeElement === retryButtonRef.current;
    actions.retry();
  };
  useEffect(() => {
    if (actions.state.kind !== "Unknown" || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body) retryButtonRef.current?.focus();
  }, [actions.state.kind]);
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
            <button ref={retryButtonRef} disabled={!actions.canRetry} onClick={retry}>
              Retry same operation
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      {state.kind === "Found" ? (
        <KitchenBoardScreen
          view={state.view}
          onSearch={setSearch}
          searchApplied={search !== null}
          onRefresh={refresh}
          refreshButtonRef={refreshButtonRef}
          onAction={runAction}
          actionsBlocked={actions.blocked}
          navigation={props.navigation}
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
/** IDR-0039 named-operator browser KDS: visibility loss covers the whole board (no snapshot),
 * and handover signs the current named Session out before the next operator signs in. */
export function KitchenBoardPage(
  props: KitchenPageProps & { readonly signOut?: () => Promise<void> },
) {
  const [covered, setCovered] = useState(false),
    [handover, setHandover] = useState<"Idle" | "SigningOut" | "SignedOut" | "Failed">("Idle"),
    [resumed, setResumed] = useState(0);
  useEffect(() => {
    const cover = () => {
      if (document.visibilityState === "hidden") setCovered(true);
    };
    document.addEventListener("visibilitychange", cover);
    return () => document.removeEventListener("visibilitychange", cover);
  }, []);
  const named = Boolean(props.csrf && props.storeReference);
  const signOut =
    props.signOut ??
    (async () => {
      // Kitchen records the Release first; the next named operator's Start derives the handover.
      const release = await fetch("/merchant/kitchen/release", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-bop-csrf": props.csrf ?? "" },
      });
      if (release.status !== 204) throw new Error("KDS_RELEASE_FAILED");
      const response = await fetch("/merchant/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("KDS_SIGN_OUT_FAILED");
    });
  if (handover === "SignedOut")
    return (
      <StatePanel heading="Kitchen display signed out" status>
        <p>The next named operator must sign in before using this board.</p>
      </StatePanel>
    );
  if (covered)
    return (
      <StatePanel heading="Kitchen display covered" tone="offline" status>
        <p>
          The board was hidden while this device was away. Resume reloads the board and rechecks the
          current operator Session.
        </p>
        <button
          onClick={() => {
            setCovered(false);
            setResumed((value) => value + 1);
          }}
        >
          Resume as current operator
        </button>
      </StatePanel>
    );
  return (
    <>
      {named ? (
        <p>
          <button
            disabled={handover === "SigningOut"}
            onClick={() => {
              setHandover("SigningOut");
              signOut().then(
                () => setHandover("SignedOut"),
                () => setHandover("Failed"),
              );
            }}
          >
            Hand over / sign out
          </button>
          {handover === "Failed" ? (
            <span role="alert">
              {" "}
              Handover was not recorded or sign-out was not confirmed. Retry before handing over.
            </span>
          ) : null}
        </p>
      ) : null}
      <KitchenBoardContent key={resumed} {...props} />
    </>
  );
}
export function KitchenWorkItemPage(props: KitchenPageProps) {
  const client = useClient(props),
    { id = "" } = useParams(),
    location = useLocation(),
    [revision, setRevision] = useState(0);
  const queueState = restoredQueueScope(location.state);
  const load = useCallback(async () => {
    let reference: string;
    try {
      reference = parseKitchenRouteReference(id);
    } catch {
      throw new KitchenBoardClientError("NotFound");
    }
    return parseKitchenWorkItemDetailView(await client.loadWorkItem(reference));
  }, [client, id]);
  const state = useLoad(load, id + ":" + revision);
  return (
    <>
      {state.kind === "Found" ? (
        <KitchenWorkItemScreen
          view={state.view}
          onRefresh={() => setRevision((value) => value + 1)}
          navigation={props.navigation}
        />
      ) : state.kind === "Loading" ? null : (
        <KitchenWorkItemUnavailableScreen
          state={state.kind}
          onRefresh={() => setRevision((value) => value + 1)}
          storeLabel={props.storeLabel ?? "Selected Store"}
          navigation={props.navigation}
          {...(queueState ? { queueState } : {})}
        />
      )}
    </>
  );
}

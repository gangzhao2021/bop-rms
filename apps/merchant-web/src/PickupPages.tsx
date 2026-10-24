import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { PickupProofForm, pickupCodeLockedText } from "./PickupProofForm.js";
import { PickupHandoffForm } from "./PickupHandoffForm.js";
import { PickupNotCollectedAction, pickupHoldMinutes } from "./PickupNotCollectedAction.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { StatePanel } from "@bop-rms/ui";
import { Freshness } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { useCallback, useEffect, useState, useMemo, useRef, type RefObject } from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
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
  pickupItemLabel,
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
    Loading: ["Loading", t("Loading pickups…")],
    PermissionDenied: [noAccessHeading, pageAccessDeniedText],
    NotFound: [t("Pickup unavailable"), t("This pickup is not at the selected Store.")],
    Offline: [t("You’re offline"), t("Reconnect and refresh before handing over a pickup.")],
    Conflict: [t("Pickup changed"), t("Refresh to see the current pickup before trying again.")],
    CommandFailed: [
      t("Action not confirmed"),
      t("The handoff was not confirmed. Refresh before trying again."),
    ],
    Unavailable: [
      t("Pickups unavailable"),
      t("The pickup queue could not be loaded. Refresh to try again."),
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">{t("Home")}</Link>
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
  if (minutes < 60) return t("{minutes} min", { minutes: minutes });
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? t(" {rest} min", { rest: rest }) : ""}`;
  }
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? t("1 day") : t("{days} days", { days: days });
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
  onNotCollected,
  onRefresh,
}: {
  /** WP-2423: the order was closed as not collected; the queue re-reads at once. */
  readonly onNotCollected?: ((orderLabel: string) => void) | undefined;
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
  // WP-2423: taken at the counter: no pickup code is sent; staff hand it over in person.
  const counter = item.takenAtCounter === true && item.proofReadiness === "NotIssued";
  const orderLabel =
    item.publicOrderNumber ?? item.execution?.publicOrderReference ?? t("number unavailable");
  const recorded = onHandedOver ? () => onHandedOver(orderLabel) : undefined;
  const tier = waitTier(wait, completed);
  // What is in the bag, as ordered, for a quick match at the counter.
  const contents = item.execution?.items ?? [];
  return (
    <article
      className="store-card pickup-queue__card"
      hidden={hidden}
      data-wait={tier}
      data-completed={completed}
    >
      <header>
        <div>
          <p className="bop-eyebrow pickup-queue__phase" data-wait={tier}>
            {completed ? t("Completed") : t("Ready for {wait}", { wait: pickupWaitText(wait) })}
          </p>
          <h3 className="pickup-queue__number">
            {t("Order")} <span className="pickup-queue__number-value">{orderLabel}</span>
          </h3>
          {earlier && item.businessDate ? (
            <p className="pickup-queue__day">
              {t("From {businessDate}", { businessDate: businessDateText(item.businessDate) })}
            </p>
          ) : null}
        </div>
        <strong className="pickup-queue__status" data-completed={completed}>
          {completed ? t("Handed over") : t("Waiting")}
        </strong>
      </header>
      {earlier && !completed ? (
        <p className="pickup-queue__earlier" role="note">
          {t("From an earlier business day. Check whether it was collected, then close it.")}
        </p>
      ) : null}
      {!completed && item.remakeQuantity ? (
        <p className="pickup-queue__remake" role="status">
          {t("Kitchen is remaking {value} — wait for it before handing this order over.", {
            value:
              item.remakeQuantity === 1
                ? t("1 item")
                : t("{remakeQuantity} items", { remakeQuantity: item.remakeQuantity }),
          })}
        </p>
      ) : null}
      {contents.length > 0 ? (
        <ul className="pickup-queue__items" aria-label={`Items in order ${orderLabel}`}>
          {contents.map((line, index) => (
            <li key={line.fulfillmentItemReference}>
              <span className="pickup-queue__item-quantity">{line.orderedQuantity} ×</span>{" "}
              {pickupItemLabel(line, index)}
            </li>
          ))}
        </ul>
      ) : null}
      <dl>
        <div>
          <dt>{t("Pickup code")}</dt>
          <dd>
            {counter
              ? t("Not needed · taken at the counter")
              : item.proofReadiness === "Expired"
                ? t("Code expired · check in person")
                : item.proofReadiness === "Locked"
                  ? t("Too many wrong codes · check in person")
                  : item.proofReadiness === "NotIssued"
                    ? t("No code sent · check in person")
                    : item.proofReadiness === "Ready"
                      ? t("Sent to customer")
                      : t("Not known yet · check in person")}
          </dd>
        </div>
        <div>
          <dt>{t("Shelf")}</dt>
          <dd>{item.stagingLocation ?? t("Not set")}</dd>
        </div>
        <div>
          <dt>{t("Packages")}</dt>
          <dd>{item.packageCount ?? t("Not set")}</dd>
        </div>
        {item.allergenCue !== "Unavailable" ? (
          <div>
            <dt>{t("Allergen")}</dt>
            <dd>{item.allergenCue === "Present" ? t("Allergen present") : t("No cue")}</dd>
          </div>
        ) : null}
        {item.exceptionStatus === "Reported" ? (
          <div>
            <dt>{t("Exception")}</dt>
            <dd>{t("Reported")}</dd>
          </div>
        ) : null}
      </dl>
      {!completed && counter ? (
        <p className="pickup-queue__counter" role="note">
          {t("Taken at the counter — call the order number and hand it over.")}
        </p>
      ) : null}
      {!completed && item.proofReadiness === "Locked" ? (
        // WP-2423: the check that locked the code re-reads the queue; the reason stays said here.
        <p className="pickup-queue__locked" role="status">
          {pickupCodeLockedText}
        </p>
      ) : null}
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
            <>
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
              {item.phase === "Ready" && workstation ? (
                // WP-2423: the code is still valid but the customer can't show it (phone dead,
                // code never received, order page lost): a deliberate in-person check with a
                // stated reason, without wrong codes to lock the order first.
                <PickupHandoffForm
                  key={
                    "no-code:" +
                    item.execution.aggregateVersion +
                    ":" +
                    item.execution.proof?.generation
                  }
                  codeNotShown
                  paused={paused}
                  item={item}
                  verification={null}
                  workstation={workstation}
                  csrf={proofContext.csrf}
                  storeReference={proofContext.storeReference}
                  onRecorded={recorded}
                />
              ) : null}
            </>
          ) : null}
          {inPersonEligible && wait >= pickupHoldMinutes && proofContext ? (
            <PickupNotCollectedAction
              onClosed={onNotCollected ? () => onNotCollected(orderLabel) : undefined}
              paused={paused}
              item={item}
              csrf={proofContext.csrf}
              storeReference={proofContext.storeReference}
            />
          ) : null}
        </div>
      ) : null}
      {canComplete && !workstation ? (
        <p role="status">{t("Handoff is not available on this device. Ask a manager.")}</p>
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
  notCollected,
  onNotCollected,
}: {
  readonly view: PickupQueueView;
  /** WP-2423: the order just closed as not collected on this device (plain confirmation). */
  readonly notCollected?: string | null | undefined;
  readonly onNotCollected?: ((orderLabel: string) => void) | undefined;
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
  const completedCount = view.items.filter((item) => item.phase === "Completed").length;
  const waitingCount = view.items.length - completedCount;
  return (
    <WorkspacePage
      className="pickup-queue"
      title={t("Pickup")}
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
          {t("Refresh")}
        </button>
      }
    >
      <>
        {handedOver ? (
          <p className="pickup-queue__handed-over" role="status">
            {t("Order {handedOver} handed over.", { handedOver: handedOver })}
          </p>
        ) : null}
        {notCollected ? (
          <p className="pickup-queue__handed-over" role="status">
            {t("Order {notCollected} closed as not collected.", { notCollected: notCollected })}
          </p>
        ) : null}
        {stale ? (
          <StaleReadNotice stale={stale} />
        ) : readOnly ? (
          <StatePanel heading={t("Data may be out of date")} tone="offline" status>
            <p>{t("Refresh before confirming a handoff.")}</p>
          </StatePanel>
        ) : null}
        <div className="list-filters pickup-queue__filters">
          <label>
            {t("Order number")}
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
            {t("Include completed pickups")}
          </label>
          <label>
            {t("Status")}
            <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
              <option value="All">{t("All")}</option>
              <option value="Ready">{t("Ready")}</option>
              <option value="Waiting">{t("Waiting")}</option>
              <option value="InProgress">{t("In progress")}</option>
              <option value="Completed">{t("Completed")}</option>
            </select>
          </label>
          {/* WP-2423: a filter is offered only when the loaded pickups carry that fact. */}
          {claimFilterAvailable ? (
            <label>
              {t("Claim")}
              <select
                value={claimFilter}
                onChange={(event) => setClaimFilter(event.currentTarget.value)}
              >
                <option value="All">{t("All")}</option>
                <option value="Unclaimed">{t("Not claimed")}</option>
                <option value="Claimed">{t("Claimed")}</option>
              </select>
            </label>
          ) : null}
          {exceptionFilterAvailable ? (
            <label>
              {t("Exception")}
              <select
                value={exceptionFilter}
                onChange={(event) => setExceptionFilter(event.currentTarget.value)}
              >
                <option value="All">{t("All")}</option>
                <option value="None">{t("No exception")}</option>
                <option value="Reported">{t("Exception reported")}</option>
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
            {t("Clear filters")}
          </button>
        </div>
        {view.items.length > 0 ? (
          <p className="pickup-queue__summary">
            {waitingCount === 1
              ? t("1 order waiting")
              : t("{waitingCount} orders waiting", { waitingCount: waitingCount })}
            {completedCount > 0
              ? t(" · {completedCount} handed over", { completedCount: completedCount })
              : ""}
            {onNext || onPrevious ? t(" on this page") : ""}
          </p>
        ) : null}
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
                onNotCollected={onNotCollected}
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
            <h2 id="pickup-earlier-heading">{t("From earlier days — check and close")}</h2>
            <p>
              {t(
                "These orders are from an earlier business day. Their numbers may repeat today's. If the customer collected the order, hand it over with the code or in person; if not, a manager closes it as not collected.",
              )}
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
                  onNotCollected={onNotCollected}
                  onRefresh={onRefresh}
                />
              ))}
            </div>
          </section>
        ) : null}
        {items.length === 0 ? (
          <div className="pickup-queue__empty" data-filtered={view.items.length > 0}>
            <StatePanel
              heading={view.items.length === 0 ? t("No pickups waiting") : t("No matching pickups")}
              status
            >
              <p>
                {view.items.length === 0
                  ? includeCompleted
                    ? t(
                        "Nothing is waiting or handed over on this page. Ready orders show here as soon as the kitchen marks them ready.",
                      )
                    : t(
                        "Nothing is waiting for pickup right now. Ready orders show here as soon as the kitchen marks them ready.",
                      )
                  : t(
                      "No pickup on this page matches the filters. Clear the filters to see every pickup.",
                    )}
              </p>
            </StatePanel>
          </div>
        ) : null}
        {onPrevious || onNext ? (
          <nav className="pickup-pagination" aria-label={t("Pickup pages")}>
            <button disabled={!onPrevious} onClick={onPrevious}>
              {t("Previous page")}
            </button>
            <button disabled={!onNext} onClick={onNext}>
              {t("Next page")}
            </button>
          </nav>
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
    [handedOver, setHandedOver] = useState<string | null>(null),
    [notCollected, setNotCollected] = useState<string | null>(null);
  // WP-2423: the confirmation stays long enough to read, then clears.
  useEffect(() => {
    if (handedOver === null) return;
    const timer = window.setTimeout(() => setHandedOver(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [handedOver]);
  useEffect(() => {
    if (notCollected === null) return;
    const timer = window.setTimeout(() => setNotCollected(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [notCollected]);
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
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const signedIn = useStaffSessionLive();
  useEffect(() => {
    if (!live || !signedIn || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    }, pickupRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [live, signedIn]);
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
        title={t("Pickup")}
        meta={props.storeLabel}
        actions={
          state.kind !== "Loading" ? (
            <button ref={refreshButtonRef} onClick={refresh}>
              {t("Refresh")}
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
      notCollected={notCollected}
      onNotCollected={(orderLabel) => {
        // WP-2423: re-read at once, like a handover, instead of waiting for the next poll.
        setNotCollected(orderLabel);
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

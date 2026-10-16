import { kitchenActionNotice, kitchenStepText, useKitchenActions } from "./use-kitchen-actions.js";
import { useKitchenClock } from "./kitchen-clock.js";
import {
  KitchenRecentlyFinished,
  KitchenRemakeDialog,
  KitchenRemakeLane,
  KitchenReworkStatus,
  recentlyFinishedKitchenItems,
  remakeOffered,
  useKitchenRework,
  type RemakeChoice,
} from "./KitchenRework.js";
import type { KitchenReworkView } from "./kitchen-rework-client.js";
import {
  earlierDayText,
  earlierDayTickets,
  fromEarlierKitchenDay,
  KitchenCloseTicketDialog,
  KitchenEarlierDayConfirm,
  KitchenStaleCloseStatus,
  kitchenWaitText,
  useKitchenStaleClose,
  type EarlierDayTicket,
} from "./KitchenEarlierDays.js";
import type { KitchenStaleCloseReason } from "./kitchen-stale-close-client.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
import type { KitchenAction } from "./kitchen-work-client.js";
import { createKitchenBoardClient } from "./kitchen-board-client.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { Freshness, SourceTime } from "./StoreTime.js";
import {
  browserOffline,
  readFailureReason,
  replacesLastRead,
  StaleReadNotice,
  useBrowserOffline,
  useStaleRetry,
  type ReadFailure,
  type StaleRead,
} from "./stale-read.js";

/** WP-2423 M3: the board re-reads the queue on its own while it is visible. */
export const kitchenRefreshIntervalMs = 10_000;
/** Waiting-time tiers that colour a ticket's age (TEST-ONLY defaults until Store policy carries them). */
export const kitchenWarningMinutes = 8;
export const kitchenLateMinutes = 15;
export function kitchenAgeTier(minutes: number): "ok" | "warning" | "late" {
  return minutes >= kitchenLateMinutes
    ? "late"
    : minutes >= kitchenWarningMinutes
      ? "warning"
      : "ok";
}

import { playKitchenChime } from "./alert-chime.js";
export { playKitchenChime };

/** WP-2423 Q2: "Table T4 · Order 14", "Pickup · Order 5"; never a Customer's name. */
export function kitchenOrderLabel(item: KitchenBoardItem): string {
  return kitchenOrderText(item.orderLabel);
}
/** WP-2423 Q2: a lane's items with each Order's work together, oldest Order first. */
export function groupKitchenItemsByOrder(items: readonly KitchenBoardItem[]) {
  const groups = new Map<string, KitchenBoardItem[]>();
  for (const item of items) {
    const group = groups.get(item.orderReference);
    if (group) group.push(item);
    else groups.set(item.orderReference, [item]);
  }
  const oldest = (group: readonly KitchenBoardItem[]) =>
    Math.min(...group.map((item) => Date.parse(item.createdAt)));
  return [...groups.entries()]
    .map(([orderReference, group]) => ({ orderReference, items: group }))
    .sort((a, b) => oldest(a.items) - oldest(b.items));
}
/**
 * WP-2423 Q2: work still to be done — including completed work not yet marked ready. Finished
 * work (ready, or cancelled) is one filter away for recall.
 */
export function isActiveKitchenWork(item: KitchenBoardItem): boolean {
  if (item.status === "Cancelled") return false;
  if (item.status !== "Completed") return true;
  return item.execution !== undefined && item.execution.readyAt === null;
}

/** IDR-0039 handover belongs to a kitchen display sign-in, never to a counter/office sign-in. */
export function kitchenHandoverOffered(
  named: boolean,
  operator: KitchenBoardView["operatorStatus"] | null,
): boolean {
  return named && operator !== null && operator !== "Unverified";
}

/**
 * WP-2423: what the order search box understands, in staff terms: the order number printed on the
 * ticket and receipt ("14", "#14", "Order 14") or the table ("T4", "Table T4"). Null when empty.
 */
export function kitchenOrderSearchTerm(input: string): string | null {
  const term = input
    .trim()
    .replace(/^(?:order|table)\b\s*/iu, "")
    .replace(/^#\s*/u, "")
    .trim()
    .toUpperCase();
  return term.length === 0 ? null : term;
}

/** WP-2423: whether an order (by its number or table) is the one staff searched for. */
export function matchesKitchenOrderLabel(
  label: KitchenOrderLabel | null | undefined,
  input: string,
): boolean {
  const term = kitchenOrderSearchTerm(input);
  if (term === null) return true;
  if (!label) return false;
  const number = (value: string) => value.toUpperCase().replace(/^0+(?=\d)/u, "");
  return number(label.orderNumber) === number(term) || label.tableLabel?.toUpperCase() === term;
}

/** WP-2423: whether a work item belongs to the order (or table) staff searched for. */
export function matchesKitchenOrderSearch(item: KitchenBoardItem, input: string): boolean {
  return matchesKitchenOrderLabel(item.orderLabel, input);
}

/**
 * WP-2423: one order search applies to the whole board: today's lanes, remakes, the earlier days'
 * tickets and recently finished work. Earlier days' open tickets are kept apart from today's lanes.
 */
export function kitchenBoardSearch(input: {
  readonly items: readonly KitchenBoardItem[];
  readonly reworks: readonly KitchenReworkView[];
  readonly today: string | null;
  readonly search: string | null;
}) {
  const { search } = input;
  const match = (item: KitchenBoardItem) =>
    search === null || matchesKitchenOrderSearch(item, search);
  const earlier = earlierDayTickets(
    input.items.filter(isActiveKitchenWork),
    input.today,
    kitchenOrderLabel,
  );
  const earlierOpen = new Set(
    earlier.flatMap((ticket) => ticket.items.map((item) => item.workItemReference)),
  );
  return {
    /** Every open ticket from an earlier business day, whatever the search. */
    earlier,
    earlierOpen,
    /** The earlier days' tickets the search finds. */
    earlierShown: search === null ? earlier : earlier.filter((ticket) => ticket.items.some(match)),
    /** Today's work the search finds (before the lane filters). */
    todayMatches: input.items.filter(
      (item) => !earlierOpen.has(item.workItemReference) && match(item),
    ),
    reworks:
      search === null
        ? input.reworks
        : input.reworks.filter((rework) => matchesKitchenOrderLabel(rework.orderLabel, search)),
    /** Board items the search finds, for the recently finished list. */
    items: search === null ? input.items : input.items.filter(match),
  };
}

/**
 * WP-2423: what the search found when nothing of it is shown in the lanes. Filters hide something
 * only when unfinished work matches; when every matching item is finished (ready, or cancelled)
 * the order or table is done, in staff words, pointing to Recently finished when it lists it.
 * Null when the search found nothing today.
 */
export function kitchenSearchHiddenText(input: {
  readonly matches: readonly KitchenBoardItem[];
  readonly search: string;
  /** Whether the Recently finished list on this board shows any of the matches. */
  readonly inRecentlyFinished: boolean;
}): string | null {
  const { matches, search } = input;
  if (matches.length === 0) return null;
  if (matches.some(isActiveKitchenWork))
    return `Order or table “${search}” has work, but the filters hide it. Clear the filters to see it.`;
  const term = kitchenOrderSearchTerm(search);
  const number = (value: string) => value.toUpperCase().replace(/^0+(?=\d)/u, "");
  const byNumber = matches.find(
    (item) =>
      term !== null && item.orderLabel && number(item.orderLabel.orderNumber) === number(term),
  );
  const byTable = matches.find(
    (item) => term !== null && item.orderLabel?.tableLabel?.toUpperCase() === term,
  );
  const subject =
    byNumber && !byTable
      ? `order ${byNumber.orderLabel?.orderNumber ?? search}`
      : byTable && !byNumber
        ? `table ${byTable.orderLabel?.tableLabel ?? search}`
        : `order or table “${search}”`;
  const allCancelled = matches.every((item) => item.status === "Cancelled");
  const capitalized = subject.charAt(0).toUpperCase() + subject.slice(1);
  return allCancelled
    ? `${capitalized} has nothing left to make: its items were cancelled.`
    : `All of ${subject} is done.` +
        (input.inRecentlyFinished ? " Its dishes are listed under Recently finished." : "");
}

/** WP-2423: how many of the earlier days' tickets carry the searched number, in staff words. */
export function earlierDaySearchText(count: number, search: string): string {
  return count === 1
    ? `1 ticket from an earlier day has number or table “${search}”`
    : `${count} tickets from earlier days have number or table “${search}”`;
}

/**
 * WP-2423: a kitchen display sign-in ("Start kitchen display as …") only works the kitchen, so its
 * screens show the kitchen navigation alone (the board and, Q17, marking an item sold out), not
 * the back office. Presentation only: the server still checks every request. Before the board has
 * said who is using it, nothing is shown rather than flashing the back-office navigation at a cook.
 */
export function kitchenNavigationFor(
  named: boolean,
  operator: KitchenBoardView["operatorStatus"] | null,
  navigation: ReactNode,
  kitchenOnly?: ReactNode,
): ReactNode {
  if (!named) return navigation;
  if (operator === null) return undefined;
  return kitchenHandoverOffered(named, operator) ? kitchenOnly : navigation;
}

/** WP-2423 Q17: where the kitchen display's sold-out link leads (the page offers the way back). */
export const kitchenSoldOutHref = (soldOutHref: string) => `${soldOutHref}?from=kitchen`;

/** WP-2423: the kitchen display's own navigation: the board, and marking an item sold out. */
export function KitchenDisplayNavigation({
  current,
  soldOutHref,
}: {
  readonly current: "Kitchen" | "SoldOut";
  readonly soldOutHref?: string | undefined;
}) {
  return (
    <>
      <a
        className="kitchen-display-nav-link"
        href="/operations/kitchen"
        aria-current={current === "Kitchen" ? "page" : undefined}
      >
        Kitchen
      </a>
      {soldOutHref ? (
        <a
          className="kitchen-display-nav-link"
          href={kitchenSoldOutHref(soldOutHref)}
          aria-current={current === "SoldOut" ? "page" : undefined}
        >
          Mark an item sold out
        </a>
      ) : null}
    </>
  );
}

/**
 * WP-2423: the kitchen display's own controls in its header: whether the screen stays awake and
 * the handover. Styled like the board's other controls (thin outline, 44 px).
 */
export function KitchenDisplayHeaderControls({
  handoverOffered,
  handover,
  awake,
  onHandover,
}: {
  readonly handoverOffered: boolean;
  readonly handover: "Idle" | "SigningOut" | "SignedOut" | "Failed";
  readonly awake: "Held" | "Unsupported" | "Released";
  readonly onHandover: () => void;
}) {
  return (
    <div className="kitchen-display-controls">
      <span className="kitchen-screen-awake" data-state={awake} role="status">
        {awake === "Held"
          ? "Screen kept on"
          : awake === "Unsupported"
            ? "This browser cannot keep the screen on — set the device to never sleep"
            : ""}
      </span>
      {handoverOffered ? (
        <button
          type="button"
          className="kitchen-handover-button"
          disabled={handover === "SigningOut"}
          onClick={onHandover}
        >
          Hand over / sign out
        </button>
      ) : null}
      {handover === "Failed" ? (
        <span className="kitchen-handover-failed" role="alert">
          Handover was not recorded or sign-out was not confirmed. Retry before handing over.
        </span>
      ) : null}
    </div>
  );
}

/** WP-2423: how the board names who is using it, in staff words. */
export function kitchenOperatorText(status: KitchenBoardView["operatorStatus"]): string {
  return {
    Named: "Kitchen display",
    Locked: "Kitchen display locked",
    HandoverRequired: "Handover needed",
    Unavailable: "Kitchen display sign-in not confirmed",
    Unverified: "View only",
  }[status];
}

/**
 * WP-2423 / IDR-0039: kitchen steps need this device's kitchen display sign-in ("Start kitchen
 * display"). A counter or office sign-in sees the board but cannot change it, and is told how to
 * start the kitchen display here instead of being left with a dead board.
 */
function KitchenBoardLock({
  operatorStatus,
  freshnessStatus,
}: {
  readonly operatorStatus: KitchenBoardView["operatorStatus"];
  readonly freshnessStatus: KitchenBoardView["freshnessStatus"];
}) {
  if (operatorStatus === "Unverified")
    return (
      <div className="kitchen-board-lock">
        <StatePanel heading="View only on this screen" tone="neutral" status>
          <p>
            You are signed in for the counter or office, so this screen cannot change tickets. To
            work tickets on this device, start the kitchen display: this signs you out here, then
            choose “Start kitchen display” for yourself.
          </p>
          <StaffSwitchButton label="Start kitchen display here" />
        </StatePanel>
      </div>
    );
  if (operatorStatus === "Named" && freshnessStatus !== "Fresh")
    return (
      <div className="kitchen-board-lock">
        <StatePanel heading="Catching up with new orders" tone="offline" status>
          <p>
            Kitchen steps are paused until the board is up to date. It checks again on its own;
            press Refresh if this stays.
          </p>
        </StatePanel>
      </div>
    );
  return (
    <div className="kitchen-board-lock">
      <StatePanel heading="Kitchen display paused" tone="offline" status>
        <p>
          {operatorStatus === "HandoverRequired"
            ? "The previous cook’s shift must be handed over first. Use Hand over / sign out, then start the kitchen display again."
            : "This device’s kitchen display sign-in can no longer be confirmed. Use Hand over / sign out, then start the kitchen display again."}
        </p>
      </StatePanel>
    </div>
  );
}

/**
 * WP-2423 Q3: what the published menu declares for this item, in plain words. Modifiers can add
 * allergens the base disclosure does not cover; without a disclosure the cook is told so.
 */
export function KitchenAllergenLine({ item }: { readonly item: KitchenBoardItem }) {
  const allergens = item.allergens;
  if (allergens === undefined || allergens.status === "Unavailable")
    return (
      <p className="kitchen-work-item__allergens" data-kind="unavailable" role="note">
        Allergens not available · check the recipe
      </p>
    );
  const none = allergens.contains.length === 0 && allergens.mayContain.length === 0;
  return (
    <p
      className="kitchen-work-item__allergens"
      data-kind={none ? "none" : "declared"}
      role="note"
      aria-label={
        none
          ? "No menu allergens declared"
          : [
              allergens.contains.length > 0 ? "Contains " + allergens.contains.join(", ") : "",
              allergens.mayContain.length > 0
                ? "May contain " + allergens.mayContain.join(", ")
                : "",
            ]
              .filter(Boolean)
              .join(". ")
      }
    >
      {none ? (
        "No menu allergens declared"
      ) : (
        <>
          {allergens.contains.length > 0 ? (
            <strong>Contains: {allergens.contains.join(", ")}</strong>
          ) : null}
          {allergens.mayContain.length > 0 ? (
            <span>May contain: {allergens.mayContain.join(", ")}</span>
          ) : null}
        </>
      )}
      {item.selectedOptions.length > 0 ? (
        <span className="kitchen-work-item__allergens-modifiers">Modifiers may add allergens</span>
      ) : null}
    </p>
  );
}

/** The queued work item references that were not in the previous read. */
export function newQueuedReferences(
  previous: KitchenBoardView | null,
  next: KitchenBoardView,
): readonly string[] {
  if (previous === null) return [];
  const seen = new Set(previous.items.map((item) => item.workItemReference));
  return next.items
    .filter((item) => item.status === "Queued" && !seen.has(item.workItemReference))
    .map((item) => item.workItemReference);
}
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
  kitchenOrderText,
  parseKitchenBoardView,
  parseKitchenRouteReference,
  parseKitchenWorkItemDetailView,
  unavailableKitchenBoardClient,
  type KitchenBoardClient,
  type KitchenBoardItem,
  type KitchenBoardView,
  type KitchenOrderLabel,
  type KitchenWorkItemDetailView,
} from "./kitchen-board.js";
import { StaffSignInLink, StaffSwitchButton } from "./StaffSession.js";

export type LoadState<T> =
  | { readonly kind: "Loading" }
  | { readonly kind: ReadFailure; readonly attempts?: number }
  | {
      readonly kind: "Found";
      readonly view: T;
      /** When this device loaded `view` (UTC instant). */
      readonly loadedAt: string;
      readonly reloading?: boolean;
      /** IDR-0039: the re-read failed; `view` is the last loaded data, shown read-only. */
      readonly stale?: StaleRead;
    };
/**
 * The state after a failed read. With `keepLast`, work already on screen stays visible in an
 * explicit stale, read-only state; a denial or missing scope still replaces it at once.
 */
export function failedLoadState<T>(
  previous: LoadState<T>,
  reason: ReadFailure,
  attempts: number,
  keepLast: boolean,
): LoadState<T> {
  if (keepLast && previous.kind === "Found" && !replacesLastRead(reason))
    return {
      kind: "Found",
      view: previous.view,
      loadedAt: previous.loadedAt,
      stale: { reason, lastLoadedAt: previous.loadedAt, attempts },
    };
  return { kind: reason, attempts };
}
/** Consecutive failed reads that should be retried on their own, or null when nothing should. */
export function retryAttempts(state: LoadState<unknown>): number | null {
  if (state.kind === "Found") return state.stale?.attempts ?? null;
  if (state.kind === "Loading" || replacesLastRead(state.kind)) return null;
  return state.attempts ?? null;
}
/**
 * Loads for a key. A board that already shows work keeps showing it while a re-read is in
 * flight (no flash to "Loading" every ten seconds). A failed re-read either replaces it or, with
 * `keepLast`, keeps it on screen as stale and read-only.
 */
function useLoad<T>(load: () => Promise<T>, key: string, keepLast = false): LoadState<T> {
  const [stored, setStored] = useState<{
    key: string;
    load: () => Promise<T>;
    state: LoadState<T>;
    failures: number;
  }>({ key, load, state: { kind: "Loading" }, failures: 0 });
  useEffect(() => {
    let active = true;
    setStored((previous) => ({
      key,
      load,
      failures: previous.failures,
      state:
        previous.state.kind === "Found"
          ? { ...previous.state, reloading: true }
          : { kind: "Loading" },
    }));
    void load()
      .then((view) => {
        if (active)
          setStored({
            key,
            load,
            failures: 0,
            state: { kind: "Found", view, loadedAt: new Date().toISOString() },
          });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const reason = readFailureReason(
          error instanceof KitchenBoardClientError ? error.code : "Unavailable",
        );
        setStored((previous) => ({
          key,
          load,
          failures: previous.failures + 1,
          state: failedLoadState(previous.state, reason, previous.failures + 1, keepLast),
        }));
      });
    return () => {
      active = false;
    };
  }, [key, load]);
  // IDR-0039: the browser saying the network is gone is enough to go read-only at once.
  useBrowserOffline(() => {
    if (!keepLast) return;
    setStored((previous) =>
      previous.state.kind === "Found" && previous.state.stale === undefined
        ? {
            ...previous,
            failures: previous.failures + 1,
            state: failedLoadState(previous.state, "Offline", previous.failures + 1, true),
          }
        : previous,
    );
  });
  if (stored.key === key && stored.load === load) return stored.state;
  // A new key whose read has not started yet is already a re-read in flight.
  return stored.state.kind === "Found" ? { ...stored.state, reloading: true } : { kind: "Loading" };
}

export function KitchenBoardStatePanel({
  state,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found">;
}) {
  const copy = {
    Loading: ["Loading", "Loading the kitchen queue…"],
    PermissionDenied: [
      "Permission denied",
      "Your kitchen permission or Store scope does not allow this board.",
    ],
    NotFound: ["Work item unavailable", "This work item is not at the selected Store."],
    Offline: ["You’re offline", "Reconnect and refresh before taking an action."],
    Conflict: ["Work item changed", "Refresh to see its current state before trying again."],
    CommandFailed: ["Action not confirmed", "Nothing is assumed. Refresh before trying again."],
    Unavailable: [
      "Kitchen unavailable",
      "The kitchen queue could not be loaded. Refresh to try again.",
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">Home</Link>
    </StatePanel>
  );
}

interface KitchenFocusIntent {
  readonly reference: string;
  /** The cards after the acted one, in board order, for when it leaves the list. */
  readonly followers: readonly string[];
}
const kitchenCards = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>("[data-work-item]")].filter(
    (card) => !card.closest("details:not([open])"),
  );
const kitchenCard = (root: ParentNode, reference: string) =>
  kitchenCards(root).find((card) => card.dataset.workItem === reference);
function kitchenFocusIntent(root: ParentNode | null, reference: string): KitchenFocusIntent {
  const order = root ? kitchenCards(root).map((card) => card.dataset.workItem ?? "") : [];
  const index = order.indexOf(reference);
  return { reference, followers: index < 0 ? [] : order.slice(index + 1) };
}
const nextStep = (card: HTMLElement) =>
  card.querySelector<HTMLButtonElement>(".kitchen-work-item__actions button:not(:disabled)");
/** Focus is lost when it fell to the page, onto a control the step disabled, or stayed on the card. */
function focusLost(root: HTMLElement, pending: KitchenFocusIntent): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected) return true;
  if (active instanceof HTMLButtonElement && active.disabled) return true;
  return kitchenCard(root, pending.reference)?.contains(active) === true;
}
/**
 * Where focus belongs while a kitchen step settles: the acted card (its next step once enabled),
 * else the next card still on the board, else the queue heading. `done` ends the tracking.
 */
export function kitchenFocusTarget(
  root: HTMLElement,
  pending: KitchenFocusIntent,
  actionsBlocked: boolean,
): { readonly element: HTMLElement | null; readonly done: boolean } {
  const card = kitchenCard(root, pending.reference);
  if (card) {
    const step = actionsBlocked ? null : nextStep(card);
    return step ? { element: step, done: true } : { element: card, done: false };
  }
  for (const reference of pending.followers) {
    const follower = kitchenCard(root, reference);
    if (follower)
      return { element: (!actionsBlocked && nextStep(follower)) || follower, done: true };
  }
  return { element: root.querySelector<HTMLElement>("#kitchen-queue-heading"), done: true };
}

function WorkCard({
  item,
  readOnly,
  observedAt,
  ageAt,
  onAction,
  onRemake,
  showDetails = true,
  showActions = true,
  showModifiers = false,
  detailState,
}: {
  readonly item: KitchenBoardItem;
  readonly readOnly: boolean;
  readonly observedAt: string;
  /** The ticking clock ages are measured against (falls back to the projection time). */
  readonly ageAt?: string;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  /** WP-2423 Q26: offered on finished dishes when the operator may remake them. */
  readonly onRemake?: ((item: KitchenBoardItem) => void) | undefined;
  readonly showDetails?: boolean;
  readonly showActions?: boolean;
  readonly showModifiers?: boolean;
  readonly detailState?: KitchenQueueScope;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(ageAt ?? observedAt) - Date.parse(item.createdAt)) / 60_000),
  );
  const allergenLabel = {
    None: "No allergen cue",
    ReviewRequired: "Allergen review required",
    Acknowledged: "Allergen acknowledged",
    Unavailable: "Allergen status unavailable",
  }[item.allergenCue];
  return (
    <article
      className={`kitchen-work-item${!showDetails && !showActions ? " kitchen-work-item--detail" : ""}`}
      data-work-item={showActions ? item.workItemReference : undefined}
      tabIndex={showActions ? -1 : undefined}
      aria-label={showActions ? item.displayName : undefined}
      data-read-only={readOnly}
      data-age={kitchenAgeTier(age)}
      data-status={item.status}
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
        <strong data-status={item.status}>
          {item.status === "In Progress"
            ? "In progress"
            : item.status === "Queued" && item.execution?.acceptedAt
              ? "Accepted"
              : item.status}
        </strong>
        {!isActiveKitchenWork(item) ? (
          <span data-age="done">Done</span>
        ) : (
          <span data-age={kitchenAgeTier(age)}>{kitchenWaitText(age)}</span>
        )}
      </div>
      <div className="kitchen-work-item__facts">
        <dl className="kitchen-work-item__quantity">
          <dt>Quantity</dt>
          <dd>
            {item.completedQuantity} / {item.requiredQuantity}
          </dd>
        </dl>
        <KitchenAllergenLine item={item} />
        {!showModifiers && item.selectedOptions.length > 0 ? (
          <ul className="kitchen-work-item__options" aria-label="Modifiers">
            {item.selectedOptions.map((option, index) => (
              <li key={`${option.displayName}:${index}`}>
                {option.quantity > 1
                  ? `${option.displayName} × ${option.quantity}`
                  : option.displayName}
              </li>
            ))}
          </ul>
        ) : null}
        {item.orderLabel?.enteredByStaff ? (
          <p className="kitchen-work-item__staff">Entered by staff</p>
        ) : null}
        {item.customerNote ? (
          <p className="kitchen-work-item__note">
            <span>Note:</span> {item.customerNote}
          </p>
        ) : null}
        {item.allergenCue !== "Unavailable" ? (
          <span
            className="kitchen-work-item__cue"
            data-kind="allergen"
            data-value={item.allergenCue}
          >
            {allergenLabel}
          </span>
        ) : null}
        {item.exceptionStatus === "Reported" ? (
          <span
            className="kitchen-work-item__cue"
            data-kind="exception"
            data-value={item.exceptionStatus}
          >
            Exception reported
          </span>
        ) : null}
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
                {onRemake && remakeOffered(item, observedAt) ? (
                  <button
                    className="kitchen-remake-button"
                    disabled={readOnly}
                    onClick={() => onRemake(item)}
                  >
                    Remake
                  </button>
                ) : null}
              </>
            ) : (
              <span className="kitchen-work-item__no-actions">
                No kitchen steps for this item on this screen
              </span>
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
    !["Active", "All", "Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(
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
  onRefresh,
  refreshButtonRef,
  onAction,
  actionsBlocked = true,
  navigation,
  soundOn,
  onSoundToggle,
  autoRefresh = false,
  stale,
  checkedAt,
  soldOutHref,
  remakes,
  earlierDays,
  headerStatus,
  notices,
}: {
  readonly view: KitchenBoardView;
  /** What happened to the last kitchen step, remake or ticket close. */
  readonly notices?: ReactNode;
  /** WP-2423: the kitchen display's own controls (screen awake, handover) in the header. */
  readonly headerStatus?: ReactNode;
  /** When this device last read the board successfully (shown as "Last checked"). */
  readonly checkedAt?: string | undefined;
  /** DEC-KITCHEN-STALE-TICKETS: closing an earlier business day's ticket, when offered. */
  readonly earlierDays?:
    | {
        readonly blocked: boolean;
        readonly onClose: (ticket: EarlierDayTicket, reason: KitchenStaleCloseReason) => void;
      }
    | undefined;
  /** WP-2423 Q26: remakes, when this source offers them. */
  readonly remakes?:
    | {
        readonly items: readonly KitchenReworkView[];
        readonly canRework: boolean;
        readonly readFailed: boolean;
        readonly blocked: boolean;
        readonly onCreate: (item: KitchenBoardItem, choice: RemakeChoice) => void;
        readonly onAdvance: (rework: KitchenReworkView) => void;
      }
    | undefined;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  readonly actionsBlocked?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly navigation?: ReactNode;
  /** New-ticket chime; off until the operator turns it on (browsers need that gesture). */
  readonly soundOn?: boolean | undefined;
  readonly onSoundToggle?: (() => void) | undefined;
  /** Whether the board re-reads itself; shown so the operator knows nothing is stuck. */
  readonly autoRefresh?: boolean;
  /** IDR-0039: the last re-read failed; the board shows the last loaded work, read-only. */
  readonly stale?: StaleRead | undefined;
  /** WP-2423 Q17: where the cook marks an item sold out for today, when the role may. */
  readonly soldOutHref?: string | undefined;
}) {
  // WP-2423 follow-up: ages follow the clock and each poll, not only changes to the work.
  const clockAt = useKitchenClock(view.projectedAt, checkedAt);
  const location = useLocation();
  const restored = restoredQueueScope(location.state);
  const [station, setStation] = useState(restored?.station ?? "All");
  const [status, setStatus] = useState(restored?.status ?? "Active");
  const [allergen, setAllergen] = useState(restored?.allergen ?? "All");
  const [exception, setException] = useState(restored?.exception ?? "All");
  // WP-2423: staff find an order by the number on its ticket or receipt (or its table), over the
  // board already loaded; the text stays on this screen and is never sent or put in the address.
  const [orderInput, setOrderInput] = useState("");
  const [orderSearch, setOrderSearch] = useState<string | null>(null);
  const searchApplied = orderSearch !== null;
  const filterSheetRef = useRef<HTMLDialogElement>(null);
  const [remakeTarget, setRemakeTarget] = useState<KitchenBoardItem | null>(null);
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const remakeReadOnly = readOnly || stale !== undefined || (remakes?.blocked ?? true);
  // DEC-KITCHEN-STALE-TICKETS: order numbers restart every business day. An earlier day's open
  // work is kept apart (collapsed), labelled with its day and guarded before any kitchen step.
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const dayLabel = (item: KitchenBoardItem) =>
    fromEarlierKitchenDay(item, today) && item.businessDate
      ? `${kitchenOrderLabel(item)} · ${earlierDayText(item.businessDate)}`
      : kitchenOrderLabel(item);
  const [confirm, setConfirm] = useState<{
    readonly businessDate: string;
    readonly orderLabel: string;
    readonly actionLabel: string;
    readonly proceed: () => void;
  } | null>(null);
  const [closeTarget, setCloseTarget] = useState<EarlierDayTicket | null>(null);
  const guarded = (item: KitchenBoardItem, actionLabel: string, proceed: () => void) => {
    if (fromEarlierKitchenDay(item, today) && item.businessDate)
      setConfirm({
        businessDate: item.businessDate,
        orderLabel: kitchenOrderLabel(item),
        actionLabel,
        proceed,
      });
    else proceed();
  };
  const actionLabels: Record<KitchenAction, string> = {
    AcceptKitchenWorkItem: "Accept",
    StartKitchenWorkItem: "Start",
    CompleteKitchenWorkItem: "Complete quantity",
    MarkKitchenOrderItemReady: "Mark ready",
  };
  // WP-2423: after a kitchen step the cook stays where they were: on the same card (its next
  // step once the board shows it), or on the next card when this one has left the list.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<KitchenFocusIntent | null>(null);
  useEffect(() => {
    const root = workspaceRef.current;
    if (!root) return;
    const moved = (event: FocusEvent) => {
      const pending = pendingFocus.current;
      if (pending && !kitchenCard(root, pending.reference)?.contains(event.target as Node))
        pendingFocus.current = null;
    };
    document.addEventListener("focusin", moved);
    return () => document.removeEventListener("focusin", moved);
  }, []);
  useEffect(() => {
    const root = workspaceRef.current;
    const pending = pendingFocus.current;
    if (!root || !pending) return;
    const target = kitchenFocusTarget(root, pending, actionsBlocked);
    if (target.done) pendingFocus.current = null;
    if (target.element && document.activeElement !== target.element && focusLost(root, pending))
      target.element.focus();
  });
  const guardedAction = onAction
    ? (item: KitchenBoardItem, action: KitchenAction) =>
        guarded(item, actionLabels[action], () => {
          pendingFocus.current = kitchenFocusIntent(workspaceRef.current, item.workItemReference);
          onAction(item, action);
        })
    : undefined;
  const onRemake = remakes?.canRework
    ? (item: KitchenBoardItem) => guarded(item, "Remake", () => setRemakeTarget(item))
    : undefined;
  const board = kitchenBoardSearch({
    items: view.items,
    reworks: remakes?.items ?? [],
    today,
    search: orderSearch,
  });
  const { earlierOpen } = board;
  const earlierTickets = board.earlierShown;
  const earlierElsewhere =
    orderSearch !== null && earlierTickets.length > 0
      ? earlierDaySearchText(earlierTickets.length, orderSearch)
      : null;
  const canCloseEarlier = view.canCloseEarlierDayTickets === true && earlierDays !== undefined;
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
  const searchMatches = board.todayMatches;
  const items = searchMatches.filter(
    (item) =>
      (activeStation === "All" || item.stationLabel === activeStation) &&
      (status === "All" ||
        (status === "Active" ? isActiveKitchenWork(item) : item.status === status)) &&
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
    status !== "Active" ||
    activeAllergen !== "All" ||
    activeException !== "All";
  const openFilterSheet = () => {
    const dialog = filterSheetRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLSelectElement>("select:not(:disabled)")?.focus();
  };
  const renderOrderSearch = (layout: "desktop" | "mobile") => (
    <form
      className={`kitchen-reference-search kitchen-reference-search--${layout}`}
      role="search"
      aria-label="Find an order"
      onSubmit={(event) => {
        event.preventDefault();
        const term = kitchenOrderSearchTerm(orderInput);
        setOrderSearch(term === null ? null : orderInput.trim());
        // The result is behind the sheet on a phone.
        if (layout === "mobile") filterSheetRef.current?.close();
      }}
    >
      <label
        className={`kitchen-reference-search__label${layout === "desktop" ? " kitchen-filter-visually-hidden" : ""}`}
        htmlFor={`kitchen-reference-search-${layout}`}
      >
        Order number or table
      </label>
      <input
        id={`kitchen-reference-search-${layout}`}
        name="order"
        type="search"
        inputMode="text"
        aria-describedby={`kitchen-reference-search-hint-${layout}`}
        placeholder="Order number or table"
        value={orderInput}
        onChange={(event) => setOrderInput(event.currentTarget.value)}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="kitchen-reference-search__actions">
        <button type="submit">Find</button>
        {layout === "mobile" || searchApplied ? (
          <button
            type="button"
            aria-label="Clear search"
            disabled={!searchApplied && orderInput.length === 0}
            onClick={() => {
              setOrderInput("");
              if (searchApplied) {
                setOrderSearch(null);
                if (layout === "mobile") filterSheetRef.current?.close();
              }
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
        The number on the ticket or receipt, or the table. Shows only that order&apos;s work.
      </span>
    </form>
  );
  const renderFilters = (layout: "desktop" | "mobile") => (
    <div
      className={`list-filters kitchen-board-filters kitchen-board-filters--${layout}`}
      role="search"
      aria-label="Filter Kitchen work items"
    >
      {/* WP-2423: a filter is offered only when every loaded item carries that fact. */}
      {stationFilterAvailable ? (
        <label>
          <span
            className={
              layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
            }
          >
            Station
          </span>
          <select value={activeStation} onChange={(event) => setStation(event.currentTarget.value)}>
            <option value="All">All stations</option>
            {stations.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        <span
          className={
            layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
          }
        >
          Work state
        </span>
        <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="Active">Active work</option>
          <option value="All">All states</option>
          <option>Queued</option>
          <option>Held</option>
          <option>In Progress</option>
          <option>Completed</option>
          <option>Cancelled</option>
        </select>
      </label>
      {allergenFilterAvailable ? (
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
            onChange={(event) => setAllergen(event.currentTarget.value)}
          >
            <option value="All">{layout === "mobile" ? "All" : "Allergen"}</option>
            <option value="None">No allergen cue</option>
            <option value="ReviewRequired">Needs allergen review</option>
            <option value="Acknowledged">Allergen checked</option>
          </select>
        </label>
      ) : null}
      {exceptionFilterAvailable ? (
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
            onChange={(event) => setException(event.currentTarget.value)}
          >
            <option value="All">{layout === "mobile" ? "All" : "Exception"}</option>
            <option value="None">No exception</option>
            <option value="Reported">Exception reported</option>
          </select>
        </label>
      ) : null}
      {layout === "mobile" || hasFilters ? (
        <button
          type="button"
          disabled={!hasFilters}
          onClick={() => {
            setStation("All");
            setStatus("Active");
            setAllergen("All");
            setException("All");
          }}
        >
          Clear filters
        </button>
      ) : null}
      {layout === "mobile" ? (
        <button
          className="kitchen-filter-sheet__done"
          type="button"
          onClick={() => filterSheetRef.current?.close()}
        >
          Done
        </button>
      ) : null}
    </div>
  );
  return (
    <AppFrame
      title={view.storeLabel}
      description="Kitchen display"
      navigation={navigation}
      headerStatus={headerStatus}
      className="kitchen-shell"
    >
      <div className="kitchen-board-workspace" ref={workspaceRef}>
        <header className="screen-heading kitchen-board-heading">
          <div>
            <h2>Kitchen</h2>
            <p className="kitchen-board-freshness">
              <Freshness
                status={stale ? "Stale" : view.freshnessStatus}
                at={view.projectedAt}
                checkedAt={checkedAt}
              />
              <span data-operator={view.operatorStatus}>
                {kitchenOperatorText(view.operatorStatus)}
              </span>
              {autoRefresh && !stale ? <span>Auto-refresh every 10 s</span> : null}
            </p>
          </div>
          <div className="kitchen-board-heading__actions">
            {soldOutHref ? (
              <a className="kitchen-sold-out-link" href={soldOutHref}>
                Mark an item sold out
              </a>
            ) : null}
            {onSoundToggle ? (
              <button
                type="button"
                aria-pressed={soundOn === true}
                onClick={onSoundToggle}
                className="kitchen-sound-toggle"
              >
                {soundOn ? "Sound on" : "Sound off"}
              </button>
            ) : null}
            <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
              Refresh
            </button>
          </div>
        </header>
        {notices}
        <button
          className="kitchen-filter-toggle"
          type="button"
          aria-haspopup="dialog"
          onClick={openFilterSheet}
        >
          Filters{hasFilters || searchApplied ? " · Applied" : " · Active work"}
        </button>
        {stale ? (
          <StaleReadNotice stale={stale} className="kitchen-board-lock kitchen-board-stale" />
        ) : readOnly ? (
          <KitchenBoardLock
            operatorStatus={view.operatorStatus}
            freshnessStatus={view.freshnessStatus}
          />
        ) : null}
        <header className="kitchen-queue-heading">
          <h2 id="kitchen-queue-heading" tabIndex={-1}>
            Queue
          </h2>
        </header>
        <div className="kitchen-filter-toolbar">
          {renderOrderSearch("desktop")}
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
          {renderOrderSearch("mobile")}
          {renderFilters("mobile")}
        </dialog>
        {remakes?.readFailed ? (
          <p className="kitchen-remake-read-failed" role="status">
            Remakes could not be refreshed. The board keeps trying.
          </p>
        ) : null}
        {remakes ? (
          <div className="kitchen-board-lanes kitchen-board-remakes">
            <KitchenRemakeLane
              items={board.reworks}
              today={today}
              readOnly={remakeReadOnly}
              onAdvance={remakes.onAdvance}
            />
          </div>
        ) : null}
        {earlierTickets.length > 0 ? (
          <details className="kitchen-earlier-days">
            <summary>
              <span>From earlier days — check and close</span>
              <span className="kitchen-earlier-days__count">
                {earlierElsewhere ??
                  (earlierTickets.length === 1 ? "1 ticket" : `${earlierTickets.length} tickets`)}
              </span>
            </summary>
            <p className="kitchen-earlier-days__intro">
              These tickets are from an earlier business day. Order numbers restart every day, so
              they are not today&apos;s orders with the same number.{" "}
              {canCloseEarlier
                ? "Check what happened to each one, then close it."
                : "Ask a manager to check and close them."}
            </p>
            <div className="kitchen-earlier-days__tickets">
              {earlierTickets.map((ticket) => {
                const waited = Math.max(
                  0,
                  Math.floor((Date.parse(clockAt) - Date.parse(ticket.createdAt)) / 60_000),
                );
                return (
                  <section
                    className="kitchen-earlier-ticket"
                    key={ticket.ticketReference}
                    aria-label={`${ticket.orderLabel}, ${earlierDayText(ticket.businessDate)}`}
                  >
                    <header className="kitchen-earlier-ticket__heading">
                      <div>
                        <h4 className="kitchen-order-group__label">{ticket.orderLabel}</h4>
                        <p className="kitchen-earlier-ticket__day">
                          <strong>{earlierDayText(ticket.businessDate)}</strong> · waiting{" "}
                          {kitchenWaitText(waited)}
                        </p>
                      </div>
                      {canCloseEarlier ? (
                        <button
                          type="button"
                          className="kitchen-earlier-ticket__close"
                          disabled={
                            stale !== undefined ||
                            (earlierDays?.blocked ?? true) ||
                            ticket.ticketVersion === null
                          }
                          onClick={() => setCloseTarget(ticket)}
                        >
                          Close ticket
                        </button>
                      ) : null}
                    </header>
                    {ticket.items.map((item) => (
                      <WorkCard
                        key={item.workItemReference}
                        item={item}
                        readOnly={readOnly || actionsBlocked || stale !== undefined}
                        {...(guardedAction ? { onAction: guardedAction } : {})}
                        onRemake={onRemake}
                        observedAt={view.projectedAt}
                        ageAt={clockAt}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          </details>
        ) : null}
        {items.length === 0 ? (
          <StatePanel
            heading={
              searchApplied || view.items.length > earlierOpen.size
                ? "No matching work"
                : "No active work"
            }
            status
          >
            <p>
              {orderSearch !== null
                ? searchMatches.length > 0
                  ? kitchenSearchHiddenText({
                      matches: searchMatches,
                      search: orderSearch,
                      inRecentlyFinished:
                        remakes !== undefined &&
                        onRemake !== undefined &&
                        recentlyFinishedKitchenItems(board.items, view.projectedAt).some((item) =>
                          searchMatches.includes(item),
                        ),
                    })
                  : earlierElsewhere !== null
                    ? `Nothing from today for order or table “${orderSearch}”. ${earlierElsewhere}: see From earlier days above.`
                    : `Nothing on the board for order or table “${orderSearch}”. Clear the search to see the whole queue.`
                : view.items.length === 0
                  ? "No authorized work item is available in the loaded queue."
                  : view.items.length === earlierOpen.size
                    ? "Nothing from today is waiting. Earlier days' tickets are listed above."
                    : "No loaded work item matches the current filters. Clear the filters to restore the queue."}
            </p>
          </StatePanel>
        ) : (
          <div className="kitchen-board-lanes">
            {stationLanes.map((lane) => {
              // WP-2423: a Store without named stations sees its work as one "All work" lane, or
              // numbered lanes when the source separates stations without naming them.
              const unnamed = stationLanes.filter((entry) => entry.stationLabel === null);
              const stationName =
                lane.stationLabel ??
                (unnamed.length > 1 ? `Station ${unnamed.indexOf(lane) + 1}` : "All work");
              const stationItems = lane.items;
              return (
                <section
                  className="kitchen-station-lane"
                  role="region"
                  key={lane.key}
                  aria-label={
                    lane.stationLabel === null && unnamed.length === 1
                      ? "All kitchen work"
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
                    {groupKitchenItemsByOrder(stationItems).map((group) => (
                      <section
                        className="kitchen-order-group"
                        key={group.orderReference}
                        aria-label={dayLabel(group.items[0] as KitchenBoardItem)}
                      >
                        <h4 className="kitchen-order-group__label">
                          {dayLabel(group.items[0] as KitchenBoardItem)}
                        </h4>
                        {group.items.map((item) => (
                          <WorkCard
                            key={item.workItemReference}
                            item={item}
                            readOnly={readOnly || actionsBlocked || stale !== undefined}
                            {...(guardedAction ? { onAction: guardedAction } : {})}
                            onRemake={onRemake}
                            observedAt={view.projectedAt}
                            ageAt={clockAt}
                            detailState={{
                              station: activeStation,
                              status,
                              allergen,
                              exception,
                            }}
                          />
                        ))}
                      </section>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {remakes && onRemake ? (
          <KitchenRecentlyFinished
            items={board.items}
            reworks={remakes.items}
            observedAt={view.projectedAt}
            readOnly={remakeReadOnly}
            onRemake={onRemake}
            orderLabel={dayLabel}
          />
        ) : null}
        {remakes && onRemake ? (
          <KitchenRemakeDialog
            item={remakeTarget}
            observedAt={view.projectedAt}
            onSubmit={remakes.onCreate}
            onClose={() => setRemakeTarget(null)}
          />
        ) : null}
        <KitchenEarlierDayConfirm request={confirm} onCancel={() => setConfirm(null)} />
        {canCloseEarlier && earlierDays ? (
          <KitchenCloseTicketDialog
            ticket={closeTarget}
            onSubmit={earlierDays.onClose}
            onClose={() => setCloseTarget(null)}
          />
        ) : null}
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
  const clockAt = useKitchenClock(view.projectedAt);
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
      title={view.storeLabel}
      description="Kitchen display"
      // WP-2423: a kitchen display shows the kitchen only; "Return to Kitchen queue" leads back.
      navigation={view.operatorStatus === "Unverified" ? navigation : undefined}
      className="kitchen-shell"
    >
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading kitchen-board-heading">
          <div>
            <p className="kitchen-board-eyebrow">{kitchenOrderLabel(view.item)}</p>
            <h2>{view.item.displayName}</h2>
            <p className="kitchen-board-freshness">
              <Freshness status={view.freshnessStatus} at={view.projectedAt} />
              <span data-operator={view.operatorStatus}>
                {kitchenOperatorText(view.operatorStatus)}
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
            <button onClick={onRefresh} disabled={!onRefresh}>
              Refresh
            </button>
          </div>
        </header>
        {readOnly ? (
          <KitchenBoardLock
            operatorStatus={view.operatorStatus}
            freshnessStatus={view.freshnessStatus}
          />
        ) : null}
        <section className="kitchen-work-item-screen__content" aria-labelledby="work-item-current">
          <h3 id="work-item-current">Current work</h3>
          <WorkCard
            item={view.item}
            readOnly
            observedAt={view.projectedAt}
            ageAt={clockAt}
            showDetails={false}
            showActions={false}
            showModifiers
          />
        </section>
        <section className="kitchen-work-item-screen__details" aria-labelledby="work-item-details">
          <header>
            <h3 id="work-item-details">Additional detail</h3>
            <p>Only recorded milestones are shown.</p>
          </header>
          <dl>
            <div className="kitchen-work-item-screen__history-row">
              <dt>Work item history</dt>
              <dd>
                <ol className="kitchen-work-item-screen__history" aria-label="Work item milestones">
                  {milestones.map((milestone) => (
                    <li key={`${milestone.label}:${milestone.at}`}>
                      <span>{milestone.label}</span>
                      <SourceTime instant={milestone.at} />
                    </li>
                  ))}
                </ol>
                <p className="kitchen-work-item-screen__history-note">
                  Start, progress and completion times are not recorded on this screen yet.
                </p>
              </dd>
            </div>
          </dl>
          <p className="kitchen-work-item-screen__command-note">
            Take actions from the queue. Your filters are kept when you return.
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
      title={storeLabel}
      description="Kitchen display"
      navigation={navigation}
      className="kitchen-shell"
    >
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading kitchen-board-heading">
          <div>
            <p className="kitchen-board-eyebrow">Work item</p>
            <h2>Work item detail</h2>
          </div>
          <div className="kitchen-work-item-screen__heading-actions">
            <Link
              to="/operations/kitchen"
              state={queueState ? { kitchenQueueScope: queueState } : undefined}
            >
              Return to Kitchen queue
            </Link>
            <button onClick={onRefresh}>Refresh</button>
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
  /** WP-2423 Q17: the Item availability page, when the role may mark items sold out. */
  readonly soldOutHref?: string | undefined;
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
function KitchenBoardContent(
  props: KitchenPageProps & {
    /** Who the board says is using it, so the page offers handover only to the kitchen display. */
    readonly onOperatorStatus?: (status: KitchenBoardView["operatorStatus"]) => void;
    /** Who the board last said was using it (kept while a later read fails). */
    readonly operator?: KitchenBoardView["operatorStatus"] | null;
    /** The kitchen display's header controls, given who is using the board. */
    readonly headerStatus?:
      ((operator: KitchenBoardView["operatorStatus"] | null) => ReactNode) | undefined;
  },
) {
  const client = useClient(props),
    [revision, setRevision] = useState(0);
  const manualRefresh = useRef(false);
  const refresh = () => {
    manualRefresh.current = true;
    setRevision((value) => value + 1);
  };
  const [soundOn, setSoundOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const toggleSound = () => {
    setSoundOn((value) => {
      const next = !value;
      if (next) {
        // Created inside the operator's tap so the browser allows it to play later.
        try {
          const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
          audio.current ??= Audio ? new Audio() : null;
          if (audio.current) playKitchenChime(audio.current);
        } catch {
          audio.current = null;
        }
      }
      return next;
    });
  };
  const load = useCallback(() => client.loadQueue().then(parseKitchenBoardView), [client]);
  const state = useLoad(load, `queue:${revision}`, true);
  const stale = state.kind === "Found" ? state.stale : undefined;
  const operatorStatus = state.kind === "Found" ? state.view.operatorStatus : null;
  const { onOperatorStatus } = props;
  useEffect(() => {
    if (operatorStatus !== null) onOperatorStatus?.(operatorStatus);
  }, [operatorStatus, onOperatorStatus]);
  const actions = useKitchenActions({
    csrf: props.csrf,
    storeReference: props.storeReference,
    view: state.kind === "Found" ? state.view : null,
    revision,
  });
  // WP-2423 Q26: a confirmed command re-reads the board at once (not at the next 10 s refresh), so
  // an accepted ticket does not keep showing "Accept".
  // The queue projection may lag the command by a moment: re-read a few more times, 1.5 s apart.
  const confirmedState = actions.state.kind === "Confirmed" ? actions.state : null;
  const followUps = useRef(0);
  useEffect(() => {
    followUps.current = 0;
    if (confirmedState !== null) setRevision((value) => value + 1);
  }, [confirmedState]);
  const awaitingProjection = confirmedState !== null && !actions.reflected;
  useEffect(() => {
    if (!awaitingProjection || followUps.current >= 4 || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      followUps.current += 1;
      setRevision((value) => value + 1);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [awaitingProjection, revision]);
  // WP-2423 Q26: remakes are read with the board and refresh it after a change.
  const rework = useKitchenRework({
    csrf: props.csrf,
    storeReference: props.storeReference,
    revision,
    onChanged: useCallback(() => setRevision((value) => value + 1), []),
  });
  // DEC-KITCHEN-STALE-TICKETS: a manager closes an earlier business day's ticket.
  const staleClose = useKitchenStaleClose({
    csrf: props.csrf,
    onChanged: useCallback(() => setRevision((value) => value + 1), []),
  });
  const refreshButtonRef = useRef<HTMLButtonElement>(null),
    retryButtonRef = useRef<HTMLButtonElement>(null),
    restoreRetryFocus = useRef(false);
  // M3: re-read the queue on its own while the board is visible and no action is in flight.
  const submitting = actions.state.kind === "Submitting";
  const found = state.kind === "Found" && stale === undefined;
  useEffect(() => {
    if (!found || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !submitting) setRevision((value) => value + 1);
    }, kitchenRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [found, submitting]);
  // IDR-0039: after a failed read, keep trying with backoff (and at once when the network returns).
  useStaleRetry(retryAttempts(state), () => setRevision((value) => value + 1));
  // M3: chime once for work that arrived since the previous read, when the operator asked for it.
  const previousView = useRef<KitchenBoardView | null>(null);
  useEffect(() => {
    if (state.kind !== "Found") return;
    const arrived = newQueuedReferences(previousView.current, state.view);
    previousView.current = state.view;
    if (soundOn && arrived.length > 0 && audio.current) playKitchenChime(audio.current);
  }, [soundOn, state]);
  const runAction = (item: KitchenBoardItem, action: KitchenAction) => {
    // Never send while offline or stale; nothing is queued for later (IDR-0039).
    if (stale !== undefined || browserOffline()) return;
    restoreRetryFocus.current = document.activeElement instanceof HTMLButtonElement;
    actions.act(item, action);
  };
  const retry = () => {
    if (stale !== undefined || browserOffline()) return;
    restoreRetryFocus.current = document.activeElement === retryButtonRef.current;
    actions.retry();
  };
  useEffect(() => {
    if (actions.state.kind !== "Unknown" || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    // The acted card holds focus while the step is sent; an unknown result moves it to Retry.
    const active = document.activeElement;
    if (active === document.body || active?.matches("[data-work-item]"))
      retryButtonRef.current?.focus();
  }, [actions.state.kind]);
  const settled = state.kind !== "Loading" && !(state.kind === "Found" && state.reloading);
  useEffect(() => {
    if (revision > 0 && settled && manualRefresh.current) {
      manualRefresh.current = false;
      refreshButtonRef.current?.focus();
    }
  }, [revision, settled]);
  // WP-2423: a kitchen display shows the kitchen only; the back office stays for other sign-ins.
  const named = Boolean(props.csrf && props.storeReference);
  const operator = state.kind === "Found" ? state.view.operatorStatus : (props.operator ?? null);
  const navigation =
    state.kind === "Loading" && operator === null
      ? undefined
      : kitchenNavigationFor(
          named,
          operator ?? (named ? "Unverified" : null),
          props.navigation,
          <KitchenDisplayNavigation current="Kitchen" soldOutHref={props.soldOutHref} />,
        );
  const kitchenDisplay = kitchenHandoverOffered(named, operator);
  const headerStatus = props.headerStatus?.(operator);
  // WP-2423: what happened to the last step is said inside the board, under its heading, not
  // above the page frame.
  const notices = (
    <>
      {actions.state.kind !== "Idle" ? (
        <StatePanel
          heading={
            actions.state.kind === "Confirmed"
              ? // WP-2423: what the cook just did, said plainly; the card already shows it.
                kitchenStepText(
                  kitchenOrderLabel(actions.state.attempt.item),
                  actions.state.attempt.item,
                  actions.state.result,
                )
              : kitchenActionNotice(actions.state, actions.rejectedRefreshed).heading
          }
          status
        >
          {actions.state.kind === "Confirmed" ? null : (
            <p>{kitchenActionNotice(actions.state, actions.rejectedRefreshed).text}</p>
          )}
          {actions.state.kind === "Unknown" ? (
            <button
              ref={retryButtonRef}
              disabled={!actions.canRetry || stale !== undefined}
              onClick={retry}
            >
              {kitchenActionNotice(actions.state, actions.rejectedRefreshed).retry}
            </button>
          ) : null}
        </StatePanel>
      ) : null}
      <KitchenReworkStatus rework={rework} />
      <KitchenStaleCloseStatus close={staleClose} />
    </>
  );
  return (
    <>
      {state.kind === "Found" ? (
        <KitchenBoardScreen
          view={actions.view ?? state.view}
          notices={notices}
          onRefresh={refresh}
          refreshButtonRef={refreshButtonRef}
          onAction={runAction}
          actionsBlocked={actions.blocked || stale !== undefined}
          navigation={navigation}
          headerStatus={headerStatus}
          soundOn={soundOn}
          onSoundToggle={toggleSound}
          autoRefresh
          stale={stale}
          checkedAt={state.loadedAt}
          // The kitchen display offers marking an item sold out in its own navigation (Q17).
          soldOutHref={kitchenDisplay ? undefined : props.soldOutHref}
          earlierDays={
            props.csrf
              ? {
                  blocked: staleClose.busy || browserOffline(),
                  onClose: staleClose.close,
                }
              : undefined
          }
          remakes={
            rework.board
              ? {
                  items: rework.board.items,
                  canRework: rework.board.canRework,
                  readFailed: rework.readFailed,
                  blocked: rework.busy || browserOffline(),
                  onCreate: rework.create,
                  onAdvance: rework.advance,
                }
              : undefined
          }
        />
      ) : (
        <AppFrame
          title={props.storeLabel ?? "Kitchen"}
          description="Kitchen display"
          navigation={navigation}
          headerStatus={headerStatus}
          className="kitchen-shell"
        >
          {notices}
          <KitchenBoardStatePanel state={state.kind} />
          {state.kind !== "Loading" ? (
            <button ref={refreshButtonRef} onClick={refresh}>
              Refresh
            </button>
          ) : null}
        </AppFrame>
      )}
    </>
  );
}
/**
 * WP-2423 Q2: keeps a kitchen screen awake while the board is open (Screen Wake Lock), so new work
 * keeps arriving and chiming instead of the device sleeping. Re-acquired whenever the page is shown
 * again; released on leave. "Unsupported" when the browser cannot hold the screen on.
 */
export function useKitchenScreenAwake(active: boolean) {
  const [state, setState] = useState<"Held" | "Unsupported" | "Released">("Released");
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
      }
    ).wakeLock;
    if (!wakeLock) {
      setState("Unsupported");
      return;
    }
    let sentinel: { release(): Promise<void> } | null = null,
      stopped = false;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      wakeLock.request("screen").then(
        (held) => {
          if (stopped) void held.release().catch(() => undefined);
          else {
            sentinel = held;
            setState("Held");
          }
        },
        () => {
          if (!stopped) setState("Unsupported");
        },
      );
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
      setState("Released");
    };
  }, [active]);
  return state;
}

/** IDR-0039 named-operator browser KDS: visibility loss covers the whole board (no snapshot),
 * and handover signs the current named Session out before the next operator signs in. */
/**
 * WP-2423: the kitchen display's handover (release the shift, then sign out), shared by the board
 * and the kitchen display's sold-out page so staff can hand over from either.
 */
export function useKitchenHandover(csrf: string | undefined, signOut?: () => Promise<void>) {
  const [handover, setHandover] = useState<"Idle" | "SigningOut" | "SignedOut" | "Failed">("Idle");
  const run =
    signOut ??
    (async () => {
      // Kitchen records the Release first; the next named operator's Start derives the handover.
      const release = await fetch("/merchant/kitchen/release", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-bop-csrf": csrf ?? "" },
      });
      if (release.status !== 204) throw new Error("KDS_RELEASE_FAILED");
      const response = await fetch("/merchant/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("KDS_SIGN_OUT_FAILED");
    });
  const handOver = () => {
    setHandover("SigningOut");
    run().then(
      () => setHandover("SignedOut"),
      () => setHandover("Failed"),
    );
  };
  return { handover, handOver };
}
/** WP-2423: what a kitchen display shows once its shift has been handed over. */
export function KitchenSignedOutPanel() {
  return (
    <StatePanel heading="Kitchen display signed out" status>
      <p>The next named operator must sign in before using this board.</p>
      {/* WP-2423 Q18: the sign-in that works here (the labelled test sign-in in the pilot). */}
      <StaffSignInLink label="Sign in to the kitchen display" />
    </StatePanel>
  );
}
export function KitchenBoardPage(
  props: KitchenPageProps & { readonly signOut?: () => Promise<void> },
) {
  const [covered, setCovered] = useState(false),
    { handover, handOver } = useKitchenHandover(props.csrf, props.signOut),
    [resumed, setResumed] = useState(0);
  useEffect(() => {
    const cover = () => {
      if (document.visibilityState === "hidden") setCovered(true);
    };
    document.addEventListener("visibilitychange", cover);
    return () => document.removeEventListener("visibilitychange", cover);
  }, []);
  const named = Boolean(props.csrf && props.storeReference);
  // A counter or office sign-in has no kitchen shift to hand over; its board offers
  // "Start kitchen display here" instead (WP-2423).
  const [operator, setOperator] = useState<KitchenBoardView["operatorStatus"] | null>(null);
  const awake = useKitchenScreenAwake(!covered && handover !== "SignedOut");
  if (handover === "SignedOut") return <KitchenSignedOutPanel />;
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
    <KitchenBoardContent
      key={resumed}
      {...props}
      operator={operator}
      onOperatorStatus={setOperator}
      headerStatus={
        named
          ? (current) => (
              <KitchenDisplayHeaderControls
                handoverOffered={kitchenHandoverOffered(named, current)}
                handover={handover}
                awake={awake}
                onHandover={handOver}
              />
            )
          : undefined
      }
    />
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

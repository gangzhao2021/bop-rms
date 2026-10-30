import { PageIntro } from "./PageIntro.js";
import { listSeparator, t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { kitchenActionNotice, kitchenStepText, useKitchenActions } from "./use-kitchen-actions.js";
import { useKitchenClock } from "./kitchen-clock.js";
import {
  KitchenRecentlyFinished,
  KitchenRemakeCancelDialog,
  KitchenRemakeDialog,
  KitchenRemakeLane,
  KitchenReworkStatus,
  recentlyFinishedKitchenItems,
  remakeOffered,
  useKitchenRework,
  type RemakeChoice,
} from "./KitchenRework.js";
import type { KitchenReworkCancelReason, KitchenReworkView } from "./kitchen-rework-client.js";
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

/**
 * WP-2423 UI refresh: a ticket's timer is its longest-waiting unfinished dish (a table's rounds can
 * differ); null minutes when everything on it is finished. Derived from the board's own clock.
 */
export function kitchenTicketAge(
  items: readonly KitchenBoardItem[],
  at: string,
): { readonly minutes: number | null; readonly tier: "ok" | "warning" | "late" | "done" } {
  const open = items.filter(isActiveKitchenWork);
  if (open.length === 0) return { minutes: null, tier: "done" };
  const minutes = Math.max(
    ...open.map((item) =>
      Math.max(0, Math.floor((Date.parse(at) - Date.parse(item.createdAt)) / 60_000)),
    ),
  );
  return { minutes, tier: kitchenAgeTier(minutes) };
}
/** The waiting tier in words, so a ticket's urgency never rests on colour alone. */
export function kitchenTicketTierText(tier: "ok" | "warning" | "late" | "done"): string | null {
  return tier === "late" ? t("Overdue") : tier === "warning" ? t("Running long") : null;
}

/** Not a combo, or a combo whose every chosen dish is done. */
export const combosDishesDone = (item: KitchenBoardItem) =>
  item.comboParts === undefined || item.comboParts.every((part) => part.done);

/**
 * Kitchen v3 (Owner 2026-10-26): a ticket's one main step — the earliest step any of its open items
 * is at — and every item at that step. Accept, then Start, then Done (the rest of each quantity),
 * then Ready for any done item not yet marked ready. Null when nothing on it takes a step here.
 */
export function kitchenTicketNextStep(items: readonly KitchenBoardItem[]): {
  readonly action: KitchenAction;
  readonly items: readonly KitchenBoardItem[];
  readonly label: string;
} | null {
  const open = items.filter((item) => item.execution !== undefined && isActiveKitchenWork(item));
  const at = (test: (item: KitchenBoardItem) => boolean) => open.filter(test);
  const accept = at((item) => item.status === "Queued" && item.execution?.acceptedAt === null);
  if (accept.length > 0)
    return {
      action: "AcceptKitchenWorkItem",
      items: accept,
      label: accept.length > 1 ? t("Accept all") : t("Accept order"),
    };
  const start = at((item) => item.status === "Queued" && item.execution?.acceptedAt !== null);
  if (start.length > 0)
    return {
      action: "StartKitchenWorkItem",
      items: start,
      label: start.length > 1 ? t("Start all") : t("Start cooking"),
    };
  const done = at(
    (item) =>
      item.status === "In Progress" &&
      item.completedQuantity < item.requiredQuantity &&
      // WP-2423 item 8 ⑥ part 4: a combo is finished by its dishes, each marked done on its own.
      combosDishesDone(item),
  );
  if (done.length > 0)
    return { action: "CompleteKitchenWorkItem", items: done, label: t("Finished") };
  const ready = at((item) => item.status === "Completed" && item.execution?.readyAt === null);
  if (ready.length > 0)
    return { action: "MarkKitchenOrderItemReady", items: ready, label: t("Mark ready") };
  return null;
}

/** Kitchen v3: what the whole ticket is at, in the three status meanings. */
export function kitchenTicketState(
  items: readonly KitchenBoardItem[],
): "ToAccept" | "InProgress" | "Done" {
  const open = items.filter(isActiveKitchenWork);
  if (open.length === 0) return "Done";
  return open.some((item) => item.status === "Queued" && !item.execution?.acceptedAt)
    ? "ToAccept"
    : "InProgress";
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
  /** v15: today's paid orders still waiting for acceptance (null or omitted when unknown). */
  readonly awaitingAcceptance?: readonly KitchenOrderLabel[] | null | undefined;
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
    /**
     * Today's work the search finds (before the lane filters). v15 2026-10-16: an earlier business
     * day's work is never today's, open or finished: order numbers restart every day, so an earlier
     * day's finished or cancelled order 13 must not answer for today's order 13.
     */
    todayMatches: input.items.filter(
      (item) =>
        !earlierOpen.has(item.workItemReference) &&
        !fromEarlierKitchenDay(item, input.today) &&
        match(item),
    ),
    /** v15: today's orders the search finds that are paid but not accepted yet (no work yet). */
    awaitingMatches:
      search === null
        ? []
        : (input.awaitingAcceptance ?? []).filter((label) =>
            matchesKitchenOrderLabel(label, search),
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
    return t(
      "Order or table “{search}” has work, but the filters hide it. Clear the filters to see it.",
      { search: search },
    );
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
      ? t("order {value}", { value: byNumber.orderLabel?.orderNumber ?? search })
      : byTable && !byNumber
        ? t("table {value}", { value: byTable.orderLabel?.tableLabel ?? search })
        : t("order or table “{search}”", { search: search });
  const allCancelled = matches.every((item) => item.status === "Cancelled");
  const capitalized = subject.charAt(0).toUpperCase() + subject.slice(1);
  return allCancelled
    ? t("{capitalized} has nothing left to make: its items were cancelled.", {
        capitalized: capitalized,
      })
    : t("All of {subject} is done.", { subject: subject }) +
        (input.inRecentlyFinished ? t(" Its dishes are listed under Recently finished.") : "");
}

/**
 * WP-2423 (v15 2026-10-16): the searched order is paid but staff have not accepted it, so the
 * kitchen has nothing for it yet. `hasKitchenWork`: some of the order (an earlier round of a table)
 * is already on the board and done, and a new round waits for acceptance.
 */
export function kitchenSearchAwaitingText(
  labels: readonly Pick<KitchenOrderLabel, "orderNumber" | "orderType" | "tableLabel">[],
  search: string,
  hasKitchenWork: boolean,
): string | null {
  const [first] = labels;
  if (first === undefined) return null;
  if (labels.length > 1)
    return t("{length} orders for “{search}” are not accepted yet — accept them on Orders.", {
      length: labels.length,
      search: search,
    });
  const subject =
    first.orderType === "DineIn" && first.tableLabel
      ? t("Order {orderNumber} (table {tableLabel})", {
          orderNumber: first.orderNumber,
          tableLabel: first.tableLabel,
        })
      : t("Order {orderNumber}", { orderNumber: first.orderNumber });
  return hasKitchenWork
    ? t("{subject} has a new round that is not accepted yet — accept it on Orders.", {
        subject: subject,
      })
    : t("{subject} is not accepted yet — accept it on Orders.", { subject: subject });
}

/** WP-2423: how many of the earlier days' tickets carry the searched number, in staff words. */
export function earlierDaySearchText(count: number, search: string): string {
  return count === 1
    ? t("1 ticket from an earlier day has number or table “{search}”", { search: search })
    : t("{count} tickets from earlier days have number or table “{search}”", {
        count: count,
        search: search,
      });
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

/**
 * WP-2423 (2026-10-21 live check): the shared workspace frame (grouped sidebar, Switch staff, My
 * PIN) supplied by the app. A counter or office sign-in reads the Kitchen inside it like any other
 * back-office page; the kitchen display keeps its own kitchen-only frame.
 */
export type KitchenWorkspaceFrame = (content: ReactNode) => ReactNode;

/**
 * Which frame a kitchen screen uses: the workspace frame only once the board said this is a counter
 * or office sign-in (never before, so a cook never sees the back office flash past).
 */
export function kitchenUsesWorkspaceFrame(
  named: boolean,
  operator: KitchenBoardView["operatorStatus"] | null,
  workspaceFrame: KitchenWorkspaceFrame | undefined,
): workspaceFrame is KitchenWorkspaceFrame {
  return named && operator === "Unverified" && workspaceFrame !== undefined;
}

/** The kitchen screens' frame: the app's workspace frame, or the kitchen display's own. */
function KitchenFrame({
  workspaceFrame,
  title,
  navigation,
  headerStatus,
  children,
}: {
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
  readonly title: string;
  readonly navigation?: ReactNode;
  readonly headerStatus?: ReactNode;
  readonly children: ReactNode;
}) {
  if (workspaceFrame)
    return (
      <>
        {workspaceFrame(
          <div className="kitchen-shell kitchen-shell--workspace">
            <main className="bop-shell__main" id="main-content" tabIndex={-1}>
              {headerStatus === undefined ? null : (
                <div className="kitchen-workspace-status">{headerStatus}</div>
              )}
              {children}
            </main>
          </div>,
        )}
      </>
    );
  return (
    <AppFrame
      title={title}
      description={t("Kitchen display")}
      navigation={navigation}
      headerStatus={headerStatus}
      className="kitchen-shell"
    >
      {children}
    </AppFrame>
  );
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
      <Link
        className="kitchen-display-nav-link"
        to="/operations/kitchen"
        aria-current={current === "Kitchen" ? "page" : undefined}
      >
        {t("Kitchen")}
      </Link>
      {soldOutHref ? (
        <Link
          className="kitchen-display-nav-link"
          to={kitchenSoldOutHref(soldOutHref)}
          aria-current={current === "SoldOut" ? "page" : undefined}
        >
          {t("Mark an item sold out")}
        </Link>
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
          ? t("Screen kept on")
          : awake === "Unsupported"
            ? t("This browser cannot keep the screen on — set the device to never sleep")
            : ""}
      </span>
      {handoverOffered ? (
        <button
          type="button"
          className="kitchen-handover-button"
          disabled={handover === "SigningOut"}
          onClick={onHandover}
        >
          {t("Hand over / sign out")}
        </button>
      ) : null}
      {handover === "Failed" ? (
        <span className="kitchen-handover-failed" role="alert">
          {t("Handover was not recorded or sign-out was not confirmed. Retry before handing over.")}
        </span>
      ) : null}
    </div>
  );
}

/** WP-2423: how the board names who is using it, in staff words. */
export function kitchenOperatorText(status: KitchenBoardView["operatorStatus"]): string {
  return {
    Named: t("Kitchen display"),
    Locked: t("Kitchen display locked"),
    HandoverRequired: t("Handover needed"),
    Unavailable: t("Kitchen display sign-in not confirmed"),
    Unverified: t("View only"),
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
        <StatePanel heading={t("View only on this screen")} tone="neutral" status>
          <PageIntro summary={t("This sign-in cannot change tickets.")}>
            <p>
              {t(
                "You are signed in for the counter or office, so this screen cannot change tickets. To work tickets on this device, start the kitchen display: this signs you out here, then choose “Start kitchen display” for yourself.",
              )}
            </p>
          </PageIntro>
          <StaffSwitchButton label={t("Start kitchen display here")} />
        </StatePanel>
      </div>
    );
  if (operatorStatus === "Named" && freshnessStatus !== "Fresh")
    return (
      <div className="kitchen-board-lock">
        <StatePanel heading={t("Catching up with new orders")} tone="offline" status>
          <p>
            {t(
              "Kitchen steps are paused until the board is up to date. It checks again on its own; press Refresh if this stays.",
            )}
          </p>
        </StatePanel>
      </div>
    );
  return (
    <div className="kitchen-board-lock">
      <StatePanel heading={t("Kitchen display paused")} tone="offline" status>
        <p>
          {operatorStatus === "HandoverRequired"
            ? t(
                "The previous cook’s shift must be handed over first. Use Hand over / sign out, then start the kitchen display again.",
              )
            : t(
                "This device’s kitchen display sign-in can no longer be confirmed. Use Hand over / sign out, then start the kitchen display again.",
              )}
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
        {t("Allergens not available · check the recipe")}
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
          ? t("No menu allergens declared")
          : [
              allergens.contains.length > 0
                ? t("Contains {value}", { value: allergens.contains.join(listSeparator()) })
                : "",
              allergens.mayContain.length > 0
                ? t("May contain {value}", { value: allergens.mayContain.join(listSeparator()) })
                : "",
            ]
              .filter(Boolean)
              .join(". ")
      }
    >
      {none ? (
        t("No menu allergens declared")
      ) : (
        <>
          {allergens.contains.length > 0 ? (
            <strong>{t("Contains: {value}", { value: allergens.contains.join(", ") })}</strong>
          ) : null}
          {allergens.mayContain.length > 0 ? (
            <span>{t("May contain: {value}", { value: allergens.mayContain.join(", ") })}</span>
          ) : null}
        </>
      )}
      {item.selectedOptions.length > 0 && !allergens.forChoices ? (
        <span className="kitchen-work-item__allergens-modifiers">
          {t("Modifiers may add allergens")}
        </span>
      ) : null}
    </p>
  );
}

/** WP-2423 Q33: how often an unanswered new-work announcement rings again. */
export const kitchenArrivalRepeatMs = 20_000;

/**
 * WP-2423 Q33: the announced arrivals after a read: the ones still waiting to be accepted, plus
 * the newly arrived ones.
 */
export function unansweredArrivals(
  current: readonly string[],
  arrived: readonly string[],
  view: KitchenBoardView,
): readonly string[] {
  const queued = new Set(
    view.items.filter((item) => item.status === "Queued").map((item) => item.workItemReference),
  );
  const next = [...current, ...arrived].filter((reference) => queued.has(reference));
  return next.length === current.length && next.every((ref, i) => ref === current[i])
    ? current
    : [...new Set(next)];
}

const KITCHEN_SOUND_KEY = "bop.kitchen.sound";
function storedKitchenSound(): boolean {
  try {
    return globalThis.localStorage?.getItem(KITCHEN_SOUND_KEY) === "on";
  } catch {
    return false;
  }
}
function storeKitchenSound(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(KITCHEN_SOUND_KEY, on ? "on" : "off");
  } catch {
    // Private browsing: the choice holds until this page reloads.
  }
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 5): the kitchen section (档口) this screen shows, kept on this
 * device only ("All": every section; "None": dishes with no section).
 */
const KITCHEN_SECTION_KEY = "bop.kitchen.section";
function storedKitchenSection(): string {
  try {
    return globalThis.localStorage?.getItem(KITCHEN_SECTION_KEY) ?? "All";
  } catch {
    return "All";
  }
}
function storeKitchenSection(section: string): void {
  try {
    // "All" is the default: nothing is kept for it.
    if (section === "All") globalThis.localStorage?.removeItem(KITCHEN_SECTION_KEY);
    else globalThis.localStorage?.setItem(KITCHEN_SECTION_KEY, section);
  } catch {
    // Private browsing: the choice holds until this page reloads.
  }
}
/** The section a work item is in: its name, or "None" for a dish with no section. */
const sectionOf = (item: KitchenBoardItem) => item.kitchenSection ?? "None";

/** WP-2423 Q33: new work, announced across the board until a cook says they saw it. */
export function KitchenArrivals({
  view,
  arrivals,
  onSeen,
}: {
  readonly view: KitchenBoardView;
  readonly arrivals: readonly string[];
  readonly onSeen?: (() => void) | undefined;
}) {
  if (arrivals.length === 0) return null;
  const wanted = new Set(arrivals);
  const orders = [
    ...new Set(
      view.items
        .filter((item) => wanted.has(item.workItemReference))
        .map((item) => kitchenOrderLabel(item)),
    ),
  ];
  if (orders.length === 0) return null;
  return (
    <section className="kitchen-arrivals" role="alert" aria-labelledby="kitchen-arrivals-heading">
      <div>
        <h3 id="kitchen-arrivals-heading">
          {orders.length === 1
            ? t("New order to accept")
            : t("{count} new orders to accept", { count: orders.length })}
        </h3>
        <p>{orders.join(listSeparator())}</p>
      </div>
      {onSeen ? (
        <button type="button" onClick={onSeen}>
          {t("Seen")}
        </button>
      ) : null}
    </section>
  );
}

/**
 * WP-2423 item 8 ⑦: work still being made that a server chased since the previous read (its
 * chase count went up). The first read sounds nothing: only chases while the board is open.
 */
export function newKitchenChases(
  previous: KitchenBoardView | null,
  next: KitchenBoardView,
): readonly string[] {
  if (previous === null) return [];
  const before = new Map(
    previous.items.map((item) => [item.workItemReference, item.chase?.count ?? 0]),
  );
  return next.items
    .filter(
      (item) =>
        item.chase !== undefined &&
        isActiveKitchenWork(item) &&
        item.chase.count > (before.get(item.workItemReference) ?? 0),
    )
    .map((item) => item.workItemReference);
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
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { ComboPartDoneContext, markComboPartDone } from "./combo-part-client.js";
import type { ComboPartView } from "./combo-parts.js";
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
    Loading: [t("Loading"), t("Loading the kitchen queue…")],
    PermissionDenied: [noAccessHeading, pageAccessDeniedText],
    NotFound: [t("Work item unavailable"), t("This work item is not at the selected Store.")],
    Offline: [t("You’re offline"), t("Reconnect and refresh before taking an action.")],
    Conflict: [t("Work item changed"), t("Refresh to see its current state before trying again.")],
    CommandFailed: [
      t("Action not confirmed"),
      t("Nothing is assumed. Refresh before trying again."),
    ],
    Unavailable: [
      t("Kitchen unavailable"),
      t("The kitchen queue could not be loaded. Refresh to try again."),
    ],
  } as const;
  return (
    <StatePanel heading={copy[state][0]} tone={state === "Loading" ? "neutral" : "error"} status>
      <p>{copy[state][1]}</p>
      <Link to="/app">{t("Home")}</Link>
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
/** Kitchen v3: on a ticket, its one main step; otherwise the card's own next step. */
const nextStep = (card: HTMLElement) =>
  card
    .closest(".kitchen-ticket")
    ?.querySelector<HTMLButtonElement>(".kitchen-ticket__next:not(:disabled)") ??
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
  // The queue heading where it is shown (an older layout), else the board's title.
  const queueHeading = root.querySelector<HTMLElement>("#kitchen-queue-heading");
  return {
    element:
      queueHeading && queueHeading.getClientRects().length > 0
        ? queueHeading
        : root.querySelector<HTMLElement>("#kitchen-board-title"),
    done: true,
  };
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
  inTicket = false,
}: {
  readonly item: KitchenBoardItem;
  /**
   * Kitchen v3: on a ticket whose one main step is at its foot. The item then offers only "Done"
   * for itself while it is being made (and Remake once finished).
   */
  readonly inTicket?: boolean;
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
    None: t("No allergen cue"),
    ReviewRequired: t("Allergen review required"),
    Acknowledged: t("Allergen acknowledged"),
    Unavailable: t("Allergen status unavailable"),
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
      data-in-ticket={inTicket ? "true" : undefined}
      data-finished={inTicket && !isActiveKitchenWork(item) ? "true" : undefined}
      data-chased={item.chase !== undefined && isActiveKitchenWork(item) ? "true" : undefined}
      data-partial={
        item.completedQuantity > 0 && item.completedQuantity < item.requiredQuantity
          ? "true"
          : undefined
      }
    >
      <div className="kitchen-work-item__summary">
        <h3>
          {/* WP-2423 UI refresh: "2×" leads the line as on a kitchen ticket; the quantity is also
              read out below ("Quantity 0 / 2"), so the prefix is not repeated to screen readers. */}
          <span className="kitchen-work-item__count" aria-hidden="true">
            {item.requiredQuantity}×
          </span>
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
        {item.otherName === undefined ? null : (
          <p className="kitchen-work-item__other-name" lang="en">
            {item.otherName}
          </p>
        )}
        {item.chase === undefined || !isActiveKitchenWork(item) ? null : (
          // WP-2423 item 8 ⑦: the table is waiting; how often a server chased it.
          <p className="kitchen-work-item__chased" role="note">
            {item.chase.count === 1
              ? t("Chased by the server")
              : t("Chased {count} times", { count: item.chase.count })}{" "}
            · <SourceTime instant={item.chase.lastChasedAt} withDate={false} />
          </p>
        )}
      </div>
      <div className="kitchen-work-item__state">
        <strong data-status={item.status}>
          {item.status === "In Progress"
            ? t("In progress")
            : item.status === "Queued" && item.execution?.acceptedAt
              ? t("Accepted")
              : item.status}
        </strong>
        {!isActiveKitchenWork(item) ? (
          <span data-age="done">{t("Done")}</span>
        ) : (
          <span data-age={kitchenAgeTier(age)}>{kitchenWaitText(age)}</span>
        )}
      </div>
      <div className="kitchen-work-item__facts">
        <dl className="kitchen-work-item__quantity">
          <dt>{t("Quantity")}</dt>
          <dd>
            {item.completedQuantity} / {item.requiredQuantity}
          </dd>
        </dl>
        <KitchenAllergenLine item={item} />
        {item.comboParts !== undefined ? (
          <KitchenComboParts item={item} actionable={showActions === true && inTicket === true} />
        ) : !showModifiers && item.selectedOptions.length > 0 ? (
          <ul className="kitchen-work-item__options" aria-label={t("Modifiers")}>
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
          <p className="kitchen-work-item__staff">{t("Entered by staff")}</p>
        ) : null}
        {item.orderLabel?.movedFromTableLabel ? (
          // WP-2423 item 8 ⑧: the party moved; the ticket goes to the table it sits at now.
          <p className="kitchen-work-item__staff">
            {t("Moved from table {table}", { table: item.orderLabel.movedFromTableLabel })}
          </p>
        ) : null}
        {item.customerNote ? (
          <p className="kitchen-work-item__note">
            <span>{t("Note:")}</span> {item.customerNote}
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
            {t("Exception reported")}
          </span>
        ) : null}
      </div>
      {showModifiers ? (
        <section className="kitchen-work-item__modifiers" aria-label={t("Modifiers")}>
          <h4>{t("Modifiers")}</h4>
          {item.selectedOptions.length === 0 ? (
            <p>{t("No selected modifiers")}</p>
          ) : (
            <ul>
              {item.selectedOptions.map((option, index) => (
                <li key={`${option.displayName}:${index}`}>
                  <span>{option.displayName}</span>
                  <span aria-label={t("Quantity {quantity}", { quantity: option.quantity })}>
                    × {option.quantity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {showDetails || showActions ? (
        <div className="kitchen-work-item__actions">
          {showActions ? (
            inTicket ? (
              <>
                {item.execution ? null : (
                  <span className="kitchen-work-item__no-actions">
                    {t("No kitchen steps for this item on this screen")}
                  </span>
                )}
                {item.execution &&
                item.status === "In Progress" &&
                item.completedQuantity < item.requiredQuantity &&
                // A combo is finished when every dish of it is done.
                combosDishesDone(item) ? (
                  <button
                    className="kitchen-work-item__done"
                    disabled={readOnly || !onAction}
                    aria-label={t("Mark {displayName} finished", { displayName: item.displayName })}
                    onClick={() => onAction?.(item, "CompleteKitchenWorkItem")}
                  >
                    {t("Finished")}
                  </button>
                ) : null}
                {onRemake && remakeOffered(item, observedAt) ? (
                  <button
                    className="kitchen-remake-button"
                    disabled={readOnly}
                    onClick={() => onRemake(item)}
                  >
                    {t("Remake")}
                  </button>
                ) : null}
              </>
            ) : item.execution ? (
              <>
                {item.status === "Queued" && item.execution.acceptedAt === null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "AcceptKitchenWorkItem")}
                  >
                    {t("Accept")}
                  </button>
                ) : null}
                {item.status === "Queued" && item.execution.acceptedAt !== null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "StartKitchenWorkItem")}
                  >
                    {t("Start")}
                  </button>
                ) : null}
                {item.status === "In Progress" &&
                item.completedQuantity < item.requiredQuantity &&
                combosDishesDone(item) ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "CompleteKitchenWorkItem")}
                  >
                    {t("Complete quantity")}
                  </button>
                ) : null}
                {item.status === "Completed" && item.execution.readyAt === null ? (
                  <button
                    disabled={readOnly || !onAction}
                    onClick={() => onAction?.(item, "MarkKitchenOrderItemReady")}
                  >
                    {t("Mark ready")}
                  </button>
                ) : null}
                {onRemake && remakeOffered(item, observedAt) ? (
                  <button
                    className="kitchen-remake-button"
                    disabled={readOnly}
                    onClick={() => onRemake(item)}
                  >
                    {t("Remake")}
                  </button>
                ) : null}
              </>
            ) : (
              <span className="kitchen-work-item__no-actions">
                {t("No kitchen steps for this item on this screen")}
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
  onActionAll,
  actionsBlocked = true,
  navigation,
  soundOn,
  soundResumes = false,
  onSoundToggle,
  arrivals = [],
  onArrivalsSeen,
  autoRefresh = false,
  stale,
  checkedAt,
  soldOutHref,
  remakes,
  earlierDays,
  headerStatus,
  notices,
  workspaceFrame,
}: {
  readonly view: KitchenBoardView;
  /** A counter or office sign-in: the app's workspace frame instead of the kitchen display's. */
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
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
        /** DEC-KITCHEN-REWORK cancel: offered with the remake permission. */
        readonly onCancel?: (rework: KitchenReworkView, reason: KitchenReworkCancelReason) => void;
      }
    | undefined;
  readonly onAction?: (item: KitchenBoardItem, action: KitchenAction) => void;
  /** Kitchen v3: one step for every item of a ticket at that step, one after another. */
  readonly onActionAll?: (items: readonly KitchenBoardItem[], action: KitchenAction) => void;
  readonly actionsBlocked?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly navigation?: ReactNode;
  /** New-ticket chime; off until the operator turns it on (browsers need that gesture). */
  readonly soundOn?: boolean | undefined;
  readonly onSoundToggle?: (() => void) | undefined;
  /** WP-2423 Q33: sound was on before this page loaded; it returns at the next tap. */
  readonly soundResumes?: boolean | undefined;
  /** WP-2423 Q33: work that arrived since the cook last said they saw new work. */
  readonly arrivals?: readonly string[] | undefined;
  readonly onArrivalsSeen?: (() => void) | undefined;
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
  const [section, setSection] = useState(storedKitchenSection);
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
  const [cancelTarget, setCancelTarget] = useState<KitchenReworkView | null>(null);
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
    AcceptKitchenWorkItem: t("Accept"),
    StartKitchenWorkItem: t("Start"),
    CompleteKitchenWorkItem: t("Complete quantity"),
    MarkKitchenOrderItemReady: t("Mark ready"),
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
  const guardedActionAll = onAction
    ? (group: readonly KitchenBoardItem[], action: KitchenAction) => {
        const first = group[0];
        if (first === undefined) return;
        guarded(first, actionLabels[action], () => {
          pendingFocus.current = kitchenFocusIntent(workspaceRef.current, first.workItemReference);
          if (onActionAll) onActionAll(group, action);
          else onAction(first, action);
        });
      }
    : undefined;
  const onRemake = remakes?.canRework
    ? (item: KitchenBoardItem) => guarded(item, "Remake", () => setRemakeTarget(item))
    : undefined;
  const board = kitchenBoardSearch({
    items: view.items,
    reworks: remakes?.items ?? [],
    today,
    search: orderSearch,
    awaitingAcceptance: view.awaitingAcceptance,
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
  // v15 2026-10-16: a paid order nobody accepted yet has no kitchen work; say so, and where to go.
  const awaitingText =
    orderSearch === null || searchMatches.some(isActiveKitchenWork)
      ? null
      : kitchenSearchAwaitingText(board.awaitingMatches, orderSearch, searchMatches.length > 0);
  const awaitingNotice =
    awaitingText === null ? null : (
      <>
        {awaitingText}
        {view.operatorStatus === "Named" ? null : (
          <>
            {" "}
            <Link to="/operations/orders">{t("Open Orders")}</Link>
          </>
        )}
      </>
    );
  // WP-2423 item 8 ⑧: the Store's sections in its order (a screen can be set to one before it has
  // work), then any other a dish on the board is in (a dish with none is in "No section"); the one
  // chosen on this device stays chosen even while it has no work.
  const sectionNames = [
    ...new Set([
      ...(view.kitchenSections ?? []),
      ...view.items
        .flatMap((item) =>
          item.kitchenSection === undefined || item.kitchenSection === null
            ? []
            : [item.kitchenSection],
        )
        .sort((a, b) => a.localeCompare(b)),
    ]),
  ];
  const sectionFilterAvailable =
    sectionNames.length > 0 || (section !== "All" && section !== "None");
  const sectionChoices = [
    ...sectionNames,
    ...(section !== "All" && section !== "None" && !sectionNames.includes(section)
      ? [section]
      : []),
  ];
  const activeSection = sectionFilterAvailable ? section : "All";
  const chooseSection = (value: string) => {
    setSection(value);
    storeKitchenSection(value);
  };
  // What waits in the other sections, so nothing is hidden quietly: orders (tickets) per section.
  const otherSections =
    activeSection === "All"
      ? []
      : [
          ...searchMatches
            .filter((item) => isActiveKitchenWork(item) && sectionOf(item) !== activeSection)
            .reduce((found, item) => {
              const tickets = found.get(sectionOf(item)) ?? new Set<string>();
              tickets.add(item.ticketReference);
              return found.set(sectionOf(item), tickets);
            }, new Map<string, Set<string>>()),
        ]
          .map(([name, tickets]) => ({ name, count: tickets.size }))
          .sort((a, b) =>
            a.name === "None" ? 1 : b.name === "None" ? -1 : a.name.localeCompare(b.name),
          );
  const sectionText = (name: string) => (name === "None" ? t("No section") : name);
  const items = searchMatches.filter(
    (item) =>
      (activeSection === "All" || sectionOf(item) === activeSection) &&
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
        ? t("reference:{stationReference}", { stationReference: stationReference })
        : item.stationLabel === null
          ? "unavailable"
          : t("label:{stationLabel}", { stationLabel: item.stationLabel });
    const lane = stationLaneMap.get(key);
    if (lane) lane.items.push(item);
    else stationLaneMap.set(key, { key, stationLabel: item.stationLabel, items: [item] });
  }
  const stationLanes = [...stationLaneMap.values()];
  const hasFilters =
    activeSection !== "All" ||
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
      aria-label={t("Find an order")}
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
        {t("Order number or table")}
      </label>
      <input
        id={`kitchen-reference-search-${layout}`}
        name="order"
        type="search"
        inputMode="text"
        aria-describedby={`kitchen-reference-search-hint-${layout}`}
        placeholder={t("Order number or table")}
        value={orderInput}
        onChange={(event) => setOrderInput(event.currentTarget.value)}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="kitchen-reference-search__actions">
        <button type="submit">{t("Find")}</button>
        {layout === "mobile" || searchApplied ? (
          <button
            type="button"
            aria-label={t("Clear search")}
            disabled={!searchApplied && orderInput.length === 0}
            onClick={() => {
              setOrderInput("");
              if (searchApplied) {
                setOrderSearch(null);
                if (layout === "mobile") filterSheetRef.current?.close();
              }
            }}
          >
            {t("Clear")}
          </button>
        ) : null}
      </div>
      <span
        className={`kitchen-reference-search__hint${layout === "desktop" ? " kitchen-filter-visually-hidden" : ""}`}
        id={`kitchen-reference-search-hint-${layout}`}
      >
        {t("The number on the ticket or receipt, or the table. Shows only that order's work.")}
      </span>
    </form>
  );
  const renderFilters = (layout: "desktop" | "mobile") => (
    <div
      className={`list-filters kitchen-board-filters kitchen-board-filters--${layout}`}
      role="search"
      aria-label={t("Filter Kitchen work items")}
    >
      {sectionFilterAvailable && workspaceFrame ? (
        // WP-2423 item 8 ⑧: the kitchen section this screen shows (kept on this device); on the
        // kitchen display it sits in the header instead.
        <label>
          <span
            className={
              layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
            }
          >
            {t("Kitchen section")}
          </span>
          <select
            value={activeSection}
            onChange={(event) => chooseSection(event.currentTarget.value)}
          >
            <option value="All">{t("All sections")}</option>
            {sectionChoices.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
            <option value="None">{t("No section")}</option>
          </select>
        </label>
      ) : null}
      {/* WP-2423: a filter is offered only when every loaded item carries that fact. */}
      {stationFilterAvailable ? (
        <label>
          <span
            className={
              layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
            }
          >
            {t("Station")}
          </span>
          <select value={activeStation} onChange={(event) => setStation(event.currentTarget.value)}>
            <option value="All">{t("All stations")}</option>
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
          {t("Work state")}
        </span>
        <select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="Active">{t("Active work")}</option>
          <option value="All">{t("All states")}</option>
          <option>{t("Queued")}</option>
          <option>{t("Held")}</option>
          <option>{t("In Progress")}</option>
          <option>{t("Completed")}</option>
          <option>{t("Cancelled")}</option>
        </select>
      </label>
      {allergenFilterAvailable ? (
        <label>
          <span
            className={
              layout === "mobile" ? "kitchen-board-filter-label" : "kitchen-filter-visually-hidden"
            }
          >
            {t("Allergen")}
          </span>
          <select
            value={activeAllergen}
            onChange={(event) => setAllergen(event.currentTarget.value)}
          >
            <option value="All">{layout === "mobile" ? t("All") : t("Allergen")}</option>
            <option value="None">{t("No allergen cue")}</option>
            <option value="ReviewRequired">{t("Needs allergen review")}</option>
            <option value="Acknowledged">{t("Allergen checked")}</option>
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
            {t("Exception")}
          </span>
          <select
            value={activeException}
            onChange={(event) => setException(event.currentTarget.value)}
          >
            <option value="All">{layout === "mobile" ? t("All") : t("Exception")}</option>
            <option value="None">{t("No exception")}</option>
            <option value="Reported">{t("Exception reported")}</option>
          </select>
        </label>
      ) : null}
      {layout === "mobile" || hasFilters ? (
        <button
          type="button"
          disabled={!hasFilters}
          onClick={() => {
            chooseSection("All");
            setStation("All");
            setStatus("Active");
            setAllergen("All");
            setException("All");
          }}
        >
          {t("Clear filters")}
        </button>
      ) : null}
      {layout === "mobile" ? (
        <button
          className="kitchen-filter-sheet__done"
          type="button"
          onClick={() => filterSheetRef.current?.close()}
        >
          {t("Done")}
        </button>
      ) : null}
    </div>
  );
  return (
    <KitchenFrame
      workspaceFrame={workspaceFrame}
      title={view.storeLabel}
      navigation={navigation}
      headerStatus={headerStatus}
    >
      <div className="kitchen-board-workspace" ref={workspaceRef}>
        <header className="screen-heading kitchen-board-heading">
          <div>
            {workspaceFrame ? (
              <h1 id="kitchen-board-title" tabIndex={-1}>
                {t("Kitchen")}
              </h1>
            ) : (
              <h2 id="kitchen-board-title" tabIndex={-1}>
                {t("Kitchen")}
              </h2>
            )}
            <p className="kitchen-board-freshness">
              <Freshness
                status={stale ? "Stale" : view.freshnessStatus}
                at={view.projectedAt}
                checkedAt={checkedAt}
              />
              <span data-operator={view.operatorStatus}>
                {kitchenOperatorText(view.operatorStatus)}
              </span>
              {autoRefresh && !stale ? (
                <span className="kitchen-board-autorefresh">{t("Auto-refresh every 10 s")}</span>
              ) : null}
              <span className="kitchen-queue-count" aria-live="polite">
                {t("{length} work {value}", {
                  length: items.length,
                  value: items.length === 1 ? t("item") : t("items"),
                })}
              </span>
            </p>
          </div>
          <div className="kitchen-board-heading__actions">
            {/* Owner 2026-10-26: recently finished sits in the top bar, so a wrong dish is found
                and remade at once. */}
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
            {sectionFilterAvailable && !workspaceFrame ? (
              // WP-2423 item 8 ⑧: the section this kitchen screen shows, kept on this device.
              <label className="kitchen-section-choice">
                <span>{t("Kitchen section")}</span>
                <select
                  value={activeSection}
                  onChange={(event) => chooseSection(event.currentTarget.value)}
                >
                  <option value="All">{t("All sections")}</option>
                  {sectionChoices.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  <option value="None">{t("No section")}</option>
                </select>
              </label>
            ) : null}
            {/* The workspace view keeps its own search row. */}
            {workspaceFrame ? null : (
              <button
                type="button"
                className="kitchen-find-button"
                aria-haspopup="dialog"
                onClick={openFilterSheet}
              >
                {searchApplied || hasFilters ? t("Find an order · Applied") : t("Find an order")}
              </button>
            )}
            {soldOutHref ? (
              <Link className="kitchen-sold-out-link" to={soldOutHref}>
                {t("Mark an item sold out")}
              </Link>
            ) : null}
            {onSoundToggle ? (
              <button
                type="button"
                aria-pressed={soundOn === true}
                onClick={onSoundToggle}
                className="kitchen-sound-toggle"
              >
                {soundOn ? t("Sound on") : t("Sound off")}
              </button>
            ) : null}
            <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
              {t("Refresh")}
            </button>
          </div>
        </header>
        {onSoundToggle && !soundOn ? (
          <p className="kitchen-sound-reminder" role="status">
            {soundResumes
              ? t("Sound turns back on at your next tap on this screen.")
              : t("Sound is off. New orders will not ring on this screen.")}
          </p>
        ) : null}
        <KitchenArrivals view={view} arrivals={arrivals} onSeen={onArrivalsSeen} />
        {notices}
        <button
          className="kitchen-filter-toggle"
          type="button"
          aria-haspopup="dialog"
          onClick={openFilterSheet}
        >
          {t("Filters{value}", {
            value: hasFilters || searchApplied ? t(" · Applied") : t(" · Active work"),
          })}
        </button>
        {stale ? (
          <StaleReadNotice stale={stale} className="kitchen-board-lock kitchen-board-stale" />
        ) : readOnly ? (
          <KitchenBoardLock
            operatorStatus={view.operatorStatus}
            freshnessStatus={view.freshnessStatus}
          />
        ) : null}
        <div className="kitchen-queue-bar">
          <header className="kitchen-queue-heading">
            <h2 id="kitchen-queue-heading" tabIndex={-1}>
              {t("Queue")}
            </h2>
          </header>
          <div className="kitchen-filter-toolbar">
            {renderOrderSearch("desktop")}
            {renderFilters("desktop")}
          </div>
        </div>
        <dialog
          className="kitchen-filter-sheet"
          ref={filterSheetRef}
          aria-labelledby="kitchen-filter-title"
        >
          <div className="kitchen-filter-sheet__heading">
            <h2 id="kitchen-filter-title">{t("Filter Kitchen work")}</h2>
            <button type="button" onClick={() => filterSheetRef.current?.close()}>
              {t("Close")}
            </button>
          </div>
          {renderOrderSearch("mobile")}
          {renderFilters("mobile")}
        </dialog>
        {remakes?.readFailed ? (
          <p className="kitchen-remake-read-failed" role="status">
            {t("Remakes could not be refreshed. The board keeps trying.")}
          </p>
        ) : null}
        {remakes ? (
          <div className="kitchen-board-lanes kitchen-board-remakes">
            <KitchenRemakeLane
              items={board.reworks}
              today={today}
              readOnly={remakeReadOnly}
              onAdvance={remakes.onAdvance}
              onCancel={remakes.canRework && remakes.onCancel ? setCancelTarget : undefined}
            />
          </div>
        ) : null}
        {earlierTickets.length > 0 ? (
          <details className="kitchen-earlier-days">
            <summary>
              <span>{t("From earlier days — check and close")}</span>
              <span className="kitchen-earlier-days__count">
                {earlierElsewhere ??
                  (earlierTickets.length === 1
                    ? t("1 ticket")
                    : t("{length} tickets", { length: earlierTickets.length }))}
              </span>
            </summary>
            <p className="kitchen-earlier-days__intro">
              {t(
                "These tickets are from an earlier business day. Order numbers restart every day, so they are not today's orders with the same number. {value}",
                {
                  value: canCloseEarlier
                    ? t("Check what happened to each one, then close it.")
                    : t("Ask a manager to check and close them."),
                },
              )}
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
                          <strong>{earlierDayText(ticket.businessDate)}</strong>{" "}
                          {t("· waiting {waited}", { waited: kitchenWaitText(waited) })}
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
                          {t("Close ticket")}
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
        {activeSection !== "All" ? (
          // WP-2423 item 8 ⑧: this screen shows one section; the others' orders are counted here.
          <p className="kitchen-section-others" role="status">
            {t("Showing {section}.", { section: sectionText(activeSection) })}{" "}
            {otherSections.length === 0
              ? t("No orders wait in other sections.")
              : t("Other sections: {list}.", {
                  list: otherSections
                    .map((entry) =>
                      entry.count === 1
                        ? t("{section} 1 order", { section: sectionText(entry.name) })
                        : t("{section} {count} orders", {
                            section: sectionText(entry.name),
                            count: String(entry.count),
                          }),
                    )
                    .join(" · "),
                })}
          </p>
        ) : null}
        {items.length > 0 && awaitingNotice !== null ? (
          <p className="kitchen-search-awaiting" role="status">
            {awaitingNotice}
          </p>
        ) : null}
        {items.length === 0 ? (
          <div className="kitchen-board-empty">
            <StatePanel
              heading={
                searchApplied || (hasFilters && view.items.length > earlierOpen.size)
                  ? t("No matching work")
                  : t("No active work")
              }
              status
            >
              <p>
                {orderSearch !== null && awaitingNotice !== null
                  ? awaitingNotice
                  : orderSearch !== null
                    ? searchMatches.length > 0
                      ? kitchenSearchHiddenText({
                          matches: searchMatches,
                          search: orderSearch,
                          inRecentlyFinished:
                            remakes !== undefined &&
                            onRemake !== undefined &&
                            recentlyFinishedKitchenItems(board.items, view.projectedAt).some(
                              (item) => searchMatches.includes(item),
                            ),
                        })
                      : earlierElsewhere !== null
                        ? t(
                            "Nothing from today for order or table “{orderSearch}”. {earlierElsewhere}: see From earlier days above.",
                            { orderSearch: orderSearch, earlierElsewhere: earlierElsewhere },
                          )
                        : t(
                            "Nothing on the board for order or table “{orderSearch}”. Clear the search to see the whole queue.",
                            { orderSearch: orderSearch },
                          )
                    : view.items.length > 0 && view.items.length === earlierOpen.size
                      ? t("Nothing from today is waiting. Earlier days' tickets are listed above.")
                      : !hasFilters || view.items.length === 0
                        ? // v15 2026-10-16: an empty board with no filter set is simply quiet.
                          t("Nothing to make right now.")
                        : t("Nothing matches these filters. Clear the filters to see all work.")}
              </p>
            </StatePanel>
          </div>
        ) : (
          <div className="kitchen-board-lanes">
            {stationLanes.map((lane) => {
              // WP-2423: a Store without named stations sees its work as one "All work" lane, or
              // numbered lanes when the source separates stations without naming them.
              const unnamed = stationLanes.filter((entry) => entry.stationLabel === null);
              const stationName =
                lane.stationLabel ??
                (unnamed.length > 1
                  ? t("Station {value}", { value: unnamed.indexOf(lane) + 1 })
                  : t("All work"));
              const stationItems = lane.items;
              return (
                <section
                  className="kitchen-station-lane"
                  role="region"
                  key={lane.key}
                  aria-label={
                    lane.stationLabel === null && unnamed.length === 1
                      ? t("All kitchen work")
                      : `${stationName} station`
                  }
                >
                  <header className="kitchen-station-lane__heading">
                    <h3>{stationName}</h3>
                    <span aria-label={t("{length} active items", { length: stationItems.length })}>
                      {stationItems.length}
                    </span>
                  </header>
                  <div className="kitchen-station-lane__items">
                    {groupKitchenItemsByOrder(stationItems).map((group) => {
                      const ticket = kitchenTicketAge(group.items, clockAt);
                      const tierText = kitchenTicketTierText(ticket.tier);
                      const first = group.items[0] as KitchenBoardItem;
                      const label = first.orderLabel;
                      const state = kitchenTicketState(group.items);
                      const next = kitchenTicketNextStep(group.items);
                      const ticketReadOnly = readOnly || actionsBlocked || stale !== undefined;
                      return (
                        <section
                          className="kitchen-order-group kitchen-ticket"
                          key={group.orderReference}
                          data-age={ticket.tier}
                          data-fresh={
                            group.items.some((item) => arrivals.includes(item.workItemReference))
                              ? "true"
                              : undefined
                          }
                          // WP-2423 item 8 ⑦: a server chased a dish still being made here.
                          data-chased={
                            group.items.some(
                              (item) => item.chase !== undefined && isActiveKitchenWork(item),
                            )
                              ? "true"
                              : undefined
                          }
                          aria-label={dayLabel(first)}
                        >
                          <header className="kitchen-ticket__header">
                            <h4 className="kitchen-order-group__label" aria-label={dayLabel(first)}>
                              {/* Kitchen v3: the number (or table) read from across the kitchen;
                                  how the order came, in grey after it. */}
                              <span className="kitchen-ticket__number">
                                {!label
                                  ? kitchenOrderLabel(first)
                                  : label.orderType === "DineIn" && label.tableLabel
                                    ? t("Table {tableLabel}", { tableLabel: label.tableLabel })
                                    : label.orderNumber}
                              </span>
                              {label ? (
                                <span className="kitchen-ticket__kind">
                                  {label.orderType === "Pickup"
                                    ? t("Pickup")
                                    : label.tableLabel
                                      ? t("Order {orderNumber}", {
                                          orderNumber: label.orderNumber,
                                        })
                                      : t("Dine-in")}
                                  {fromEarlierKitchenDay(first, today) && first.businessDate
                                    ? ` · ${earlierDayText(first.businessDate)}`
                                    : ""}
                                </span>
                              ) : null}
                            </h4>
                            <p className="kitchen-ticket__wait">
                              {ticket.minutes === null ? (
                                <span className="kitchen-ticket__timer">{t("Done")}</span>
                              ) : (
                                <span className="kitchen-ticket__timer" data-age={ticket.tier}>
                                  {kitchenWaitText(ticket.minutes)}
                                </span>
                              )}
                              {tierText ? (
                                <span className="kitchen-ticket__tier">{tierText}</span>
                              ) : null}
                            </p>
                          </header>
                          <p className="kitchen-ticket__state" data-state={state}>
                            {state === "ToAccept"
                              ? t("To accept")
                              : state === "InProgress"
                                ? t("In progress")
                                : t("Done")}
                          </p>
                          {group.items.map((item) => (
                            <WorkCard
                              key={item.workItemReference}
                              item={item}
                              inTicket
                              readOnly={ticketReadOnly}
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
                          {next && guardedActionAll ? (
                            <button
                              type="button"
                              className="kitchen-ticket__next"
                              disabled={ticketReadOnly}
                              onClick={() => guardedActionAll(next.items, next.action)}
                            >
                              {next.label}
                            </button>
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {remakes?.canRework && remakes.onCancel ? (
          <KitchenRemakeCancelDialog
            rework={cancelTarget}
            onSubmit={remakes.onCancel}
            onClose={() => setCancelTarget(null)}
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
    </KitchenFrame>
  );
}

/**
 * WP-2423 item 8 ⑥ part 4 (coordinator 2026-10-28 decision 3): a combo's chosen dishes, each its
 * own line under the combo — Chinese name first — marked done on its own once the combo is started.
 */
function KitchenComboParts({
  item,
  actionable,
}: {
  readonly item: KitchenBoardItem;
  readonly actionable: boolean;
}) {
  const markDone = useContext(ComboPartDoneContext);
  const parts = item.comboParts ?? [];
  return (
    <ul className="kitchen-work-item__combo" aria-label={t("Dishes in this combo")}>
      {parts.map((part) => {
        const label = part.nameZh || part.name;
        return (
          <li key={part.optionReference} data-done={part.done ? "true" : undefined}>
            <span className="kitchen-work-item__combo-name" lang={part.nameZh ? "zh-Hans" : "en"}>
              {label}
            </span>
            {part.nameZh && part.name !== part.nameZh ? (
              <span className="kitchen-work-item__other-name" lang="en">
                {part.name}
              </span>
            ) : null}
            {part.done ? (
              <span className="kitchen-work-item__combo-done">{t("Done")}</span>
            ) : actionable && markDone !== null && item.status === "In Progress" ? (
              <button
                type="button"
                className="kitchen-work-item__combo-step"
                aria-label={t("Mark {displayName} done", { displayName: label })}
                onClick={() => markDone(item.workItemReference, part)}
              >
                {t("Done")}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function KitchenWorkItemScreen({
  view,
  onRefresh,
  navigation,
  workspaceFrame,
}: {
  readonly view: KitchenWorkItemDetailView;
  readonly onRefresh?: () => void;
  readonly navigation?: ReactNode;
  /** A counter or office sign-in: the app's workspace frame instead of the kitchen display's. */
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
}) {
  const clockAt = useKitchenClock(view.projectedAt);
  const location = useLocation();
  const queueState = restoredQueueScope(location.state);
  const readOnly = view.freshnessStatus !== "Fresh" || view.operatorStatus !== "Named";
  const milestones = [
    { label: t("Work item created"), at: view.item.createdAt },
    ...(view.item.execution?.acceptedAt
      ? [{ label: t("Accepted"), at: view.item.execution.acceptedAt }]
      : []),
    ...(view.item.execution?.readyAt
      ? [{ label: t("Order item marked ready"), at: view.item.execution.readyAt }]
      : []),
  ].sort((left, right) => left.at.localeCompare(right.at) || left.label.localeCompare(right.label));
  return (
    <KitchenFrame
      workspaceFrame={view.operatorStatus === "Unverified" ? workspaceFrame : undefined}
      title={view.storeLabel}
      // WP-2423: a kitchen display shows the kitchen only; "Return to Kitchen queue" leads back.
      navigation={view.operatorStatus === "Unverified" ? navigation : undefined}
    >
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading kitchen-board-heading">
          <div>
            <p className="kitchen-board-eyebrow">{kitchenOrderLabel(view.item)}</p>
            {workspaceFrame && view.operatorStatus === "Unverified" ? (
              <h1>{view.item.displayName}</h1>
            ) : (
              <h2>{view.item.displayName}</h2>
            )}
            {view.item.otherName === undefined ? null : (
              <p className="kitchen-work-item__other-name" lang="en">
                {view.item.otherName}
              </p>
            )}
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
              {t("Return to Kitchen queue")}
            </Link>
            <button onClick={onRefresh} disabled={!onRefresh}>
              {t("Refresh")}
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
          <h3 id="work-item-current">{t("Current work")}</h3>
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
            <h3 id="work-item-details">{t("Additional detail")}</h3>
            <p>{t("Only recorded milestones are shown.")}</p>
          </header>
          <dl>
            <div className="kitchen-work-item-screen__history-row">
              <dt>{t("Work item history")}</dt>
              <dd>
                <ol
                  className="kitchen-work-item-screen__history"
                  aria-label={t("Work item milestones")}
                >
                  {milestones.map((milestone) => (
                    <li key={`${milestone.label}:${milestone.at}`}>
                      <span>{milestone.label}</span>
                      <SourceTime instant={milestone.at} />
                    </li>
                  ))}
                </ol>
                <p className="kitchen-work-item-screen__history-note">
                  {t("Start, progress and completion times are not recorded on this screen yet.")}
                </p>
              </dd>
            </div>
          </dl>
          <p className="kitchen-work-item-screen__command-note">
            {t("Take actions from the queue. Your filters are kept when you return.")}
          </p>
        </section>
      </div>
    </KitchenFrame>
  );
}

function KitchenWorkItemUnavailableScreen({
  state,
  onRefresh,
  storeLabel,
  navigation,
  queueState,
  workspaceFrame,
}: {
  readonly state: Exclude<LoadState<never>["kind"], "Found" | "Loading">;
  readonly onRefresh: () => void;
  readonly storeLabel: string;
  readonly navigation?: ReactNode;
  readonly queueState?: KitchenQueueScope;
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
}) {
  return (
    <KitchenFrame workspaceFrame={workspaceFrame} title={storeLabel} navigation={navigation}>
      <div className="kitchen-board-workspace kitchen-work-item-screen">
        <header className="screen-heading kitchen-board-heading">
          <div>
            <p className="kitchen-board-eyebrow">{t("Work item")}</p>
            {workspaceFrame ? <h1>{t("Work item detail")}</h1> : <h2>{t("Work item detail")}</h2>}
          </div>
          <div className="kitchen-work-item-screen__heading-actions">
            <Link
              to="/operations/kitchen"
              state={queueState ? { kitchenQueueScope: queueState } : undefined}
            >
              {t("Return to Kitchen queue")}
            </Link>
            <button onClick={onRefresh}>{t("Refresh")}</button>
          </div>
        </header>
        <KitchenBoardStatePanel state={state} />
      </div>
    </KitchenFrame>
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
  /** The app's workspace frame, used once the board says this is a counter or office sign-in. */
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
  /** Who the board last said was using it in this sign-in (kept by the app between pages). */
  readonly knownOperator?: KitchenBoardView["operatorStatus"] | null | undefined;
  /** Tells the app who the board says is using it. */
  readonly onKnownOperator?: ((status: KitchenBoardView["operatorStatus"]) => void) | undefined;
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
  // WP-2423 Q33: this display remembers that the cook wanted sound. Browsers only allow audio
  // after a tap, so after a reload the sound comes back at the next tap anywhere on the board.
  const [soundResumes, setSoundResumes] = useState(() => storedKitchenSound());
  const audio = useRef<AudioContext | null>(null);
  const startAudio = () => {
    // Created inside the operator's tap so the browser allows it to play later.
    try {
      const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      audio.current ??= Audio ? new Audio() : null;
      void audio.current?.resume().catch(() => undefined);
    } catch {
      audio.current = null;
    }
  };
  const toggleSound = () => {
    setSoundResumes(false);
    setSoundOn((value) => {
      const next = !value;
      storeKitchenSound(next);
      if (next) {
        startAudio();
        if (audio.current) playKitchenChime(audio.current);
      }
      return next;
    });
  };
  useEffect(() => {
    if (!soundResumes || typeof document === "undefined") return;
    const resume = () => {
      startAudio();
      setSoundResumes(false);
      setSoundOn(true);
    };
    document.addEventListener("pointerdown", resume, { once: true, capture: true });
    document.addEventListener("keydown", resume, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", resume, { capture: true });
      document.removeEventListener("keydown", resume, { capture: true });
    };
  }, [soundResumes]);
  const load = useCallback(() => client.loadQueue().then(parseKitchenBoardView), [client]);
  const state = useLoad(load, t("queue:{revision}", { revision: revision }), true);
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
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!found || !live || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !submitting) setRevision((value) => value + 1);
    }, kitchenRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [found, live, submitting]);
  // IDR-0039: after a failed read, keep trying with backoff (and at once when the network returns).
  useStaleRetry(retryAttempts(state), () => setRevision((value) => value + 1));
  // M3: chime once for work that arrived since the previous read, when the operator asked for it.
  // WP-2423 Q33: new work also stays announced on screen until a cook says they saw it, or until
  // it is no longer waiting to be accepted; the chime repeats while it is unanswered.
  const previousView = useRef<KitchenBoardView | null>(null);
  const previousChases = useRef<KitchenBoardView | null>(null);
  const [arrivals, setArrivals] = useState<readonly string[]>([]);
  useEffect(() => {
    if (state.kind !== "Found") return;
    const arrived = newQueuedReferences(previousView.current, state.view);
    previousView.current = state.view;
    setArrivals((current) => unansweredArrivals(current, arrived, state.view));
    // WP-2423 item 8 ⑦: a server chased a dish since the previous read.
    const chased = newKitchenChases(previousChases.current, state.view);
    previousChases.current = state.view;
    if (soundOn && (arrived.length > 0 || chased.length > 0) && audio.current)
      playKitchenChime(audio.current);
  }, [soundOn, state]);
  const waiting = arrivals.length > 0;
  useEffect(() => {
    if (!waiting || !soundOn || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (audio.current) playKitchenChime(audio.current);
    }, kitchenArrivalRepeatMs);
    return () => window.clearInterval(timer);
  }, [waiting, soundOn]);
  const runAction = (item: KitchenBoardItem, action: KitchenAction) => {
    // Never send while offline or stale; nothing is queued for later (IDR-0039).
    if (stale !== undefined || browserOffline()) return;
    restoreRetryFocus.current = document.activeElement instanceof HTMLButtonElement;
    actions.act(item, action);
  };
  // WP-2423 item 8 ⑥ part 4: one dish of a combo done; the last one finishes the combo.
  const comboPartDone = (workItemReference: string, part: ComboPartView) => {
    if (stale !== undefined || browserOffline() || props.csrf === undefined) return;
    void markComboPartDone(props.csrf, {
      workItemReference,
      optionReference: part.optionReference,
    })
      .then((allDone) => {
        const item =
          state.kind === "Found"
            ? (actions.view ?? state.view).items.find(
                (candidate) => candidate.workItemReference === workItemReference,
              )
            : undefined;
        if (allDone && item !== undefined && item.status === "In Progress")
          runAction(
            {
              ...item,
              comboParts: (item.comboParts ?? []).map((p) => ({ ...p, done: true })),
            },
            "CompleteKitchenWorkItem",
          );
        else setRevision((value) => value + 1);
      })
      .catch(() => setRevision((value) => value + 1));
  };
  const runActionAll = (items: readonly KitchenBoardItem[], action: KitchenAction) => {
    if (stale !== undefined || browserOffline()) return;
    restoreRetryFocus.current = document.activeElement instanceof HTMLButtonElement;
    actions.actAll(items, action);
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
  // A counter or office sign-in reads the board inside the workspace frame (grouped sidebar).
  const workspaceFrame = kitchenUsesWorkspaceFrame(named, operator, props.workspaceFrame)
    ? props.workspaceFrame
    : undefined;
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
    <ComboPartDoneContext.Provider value={comboPartDone}>
      {state.kind === "Found" ? (
        <KitchenBoardScreen
          view={actions.view ?? state.view}
          notices={notices}
          onRefresh={refresh}
          refreshButtonRef={refreshButtonRef}
          onAction={runAction}
          onActionAll={runActionAll}
          actionsBlocked={actions.blocked || stale !== undefined}
          navigation={navigation}
          headerStatus={headerStatus}
          workspaceFrame={workspaceFrame}
          soundOn={soundOn}
          soundResumes={soundResumes}
          onSoundToggle={toggleSound}
          arrivals={arrivals}
          onArrivalsSeen={() => setArrivals([])}
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
                  onCancel: rework.cancel,
                }
              : undefined
          }
        />
      ) : (
        <KitchenFrame
          workspaceFrame={workspaceFrame}
          title={props.storeLabel ?? t("Kitchen")}
          navigation={navigation}
          headerStatus={headerStatus}
        >
          {workspaceFrame ? <h1 className="kitchen-workspace-title">{t("Kitchen")}</h1> : null}
          {notices}
          <KitchenBoardStatePanel state={state.kind} />
          {state.kind !== "Loading" ? (
            <button ref={refreshButtonRef} onClick={refresh}>
              {t("Refresh")}
            </button>
          ) : null}
        </KitchenFrame>
      )}
    </ComboPartDoneContext.Provider>
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
    <StatePanel heading={t("Kitchen display signed out")} status>
      <p>{t("The next named operator must sign in before using this board.")}</p>
      {/* WP-2423 Q18: the sign-in that works here (the labelled test sign-in in the pilot). */}
      <StaffSignInLink label={t("Sign in to the kitchen display")} />
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
  const [operator, setOperator] = useState<KitchenBoardView["operatorStatus"] | null>(
    props.knownOperator ?? null,
  );
  const { onKnownOperator } = props;
  const reportOperator = useCallback(
    (status: KitchenBoardView["operatorStatus"]) => {
      setOperator(status);
      onKnownOperator?.(status);
    },
    [onKnownOperator],
  );
  // A view-only (counter or office) sign-in cannot work tickets, so there is no operator to
  // protect: leaving the tab does not cover its board (IDR-0039 covers the kitchen display).
  const viewOnly = named && operator === "Unverified";
  const awake = useKitchenScreenAwake(!covered && handover !== "SignedOut");
  if (handover === "SignedOut") return <KitchenSignedOutPanel />;
  if (covered && !viewOnly)
    return (
      <StatePanel heading={t("Kitchen display covered")} tone="offline" status>
        <p>
          {t(
            "The board was hidden while this device was away. Resume reloads the board and rechecks the current operator Session.",
          )}
        </p>
        <button
          onClick={() => {
            setCovered(false);
            setResumed((value) => value + 1);
          }}
        >
          {t("Resume as current operator")}
        </button>
      </StatePanel>
    );
  return (
    <KitchenBoardContent
      key={resumed}
      {...props}
      operator={operator}
      onOperatorStatus={reportOperator}
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
  const named = Boolean(props.csrf && props.storeReference);
  const operator = state.kind === "Found" ? state.view.operatorStatus : null;
  const { onKnownOperator } = props;
  useEffect(() => {
    if (operator !== null) onKnownOperator?.(operator);
  }, [operator, onKnownOperator]);
  // While the item cannot be read, the frame follows who the board last said was using it.
  const unavailableFrame = kitchenUsesWorkspaceFrame(
    named,
    props.knownOperator ?? null,
    props.workspaceFrame,
  )
    ? props.workspaceFrame
    : undefined;
  return (
    <>
      {state.kind === "Found" ? (
        <KitchenWorkItemScreen
          view={state.view}
          onRefresh={() => setRevision((value) => value + 1)}
          navigation={props.navigation}
          workspaceFrame={named ? props.workspaceFrame : undefined}
        />
      ) : state.kind === "Loading" ? (
        unavailableFrame ? (
          <>{unavailableFrame(null)}</>
        ) : null
      ) : (
        <KitchenWorkItemUnavailableScreen
          state={state.kind}
          onRefresh={() => setRevision((value) => value + 1)}
          storeLabel={props.storeLabel ?? "Selected Store"}
          navigation={props.navigation}
          workspaceFrame={unavailableFrame}
          {...(queueState ? { queueState } : {})}
        />
      )}
    </>
  );
}

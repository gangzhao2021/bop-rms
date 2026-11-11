import { LanguageSwitch } from "./i18n/LanguageSwitch.js";
import { allergenName, listSeparator, t, saidTable, systemText } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { useKitchenActions, type KitchenStepTarget } from "./use-kitchen-actions.js";
import type { KitchenTap } from "./kitchen-step-queue.js";
import type { KitchenStepKind } from "./kitchen-step-client.js";
import { useKitchenClock } from "./kitchen-clock.js";
import {
  KitchenRecentlyFinished,
  KitchenRemakeCancelDialog,
  KitchenRemakeDialog,
  KitchenRemakeLane,
  kitchenReworkStatusHeading,
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
  kitchenStaleCloseHeading,
  KitchenStaleCloseStatus,
  kitchenWaitText,
  useKitchenStaleClose,
  type EarlierDayTicket,
} from "./KitchenEarlierDays.js";
import type { KitchenStaleCloseReason } from "./kitchen-stale-close-client.js";
import { useStoreBusinessDay } from "./StoreBusinessDay.js";
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
      Math.max(0, Math.floor((Date.parse(at) - Date.parse(kitchenWaitStart(item))) / 60_000)),
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
 * DEC-KITCHEN-ONE-TAP: a table's card is one Order across its rounds, oldest round first. Each round
 * is one ticket. The foot button and the quiet Start act on the oldest round still open, never on a
 * round that reached the card after the cook read it.
 */
export function kitchenTicketRounds(items: readonly KitchenBoardItem[]) {
  const rounds = new Map<string, KitchenBoardItem[]>();
  for (const item of items) {
    const round = rounds.get(item.ticketReference);
    if (round) round.push(item);
    else rounds.set(item.ticketReference, [item]);
  }
  const oldest = (round: readonly KitchenBoardItem[]) =>
    Math.min(...round.map((item) => Date.parse(kitchenWaitStart(item))));
  return [...rounds.entries()]
    .map(([ticketReference, round]) => ({
      ticketReference,
      items: round,
      createdAt: oldest(round),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Whether a line can still be finished here (Held work and a combo's undone dishes cannot). */
export function kitchenLineFinishable(item: KitchenBoardItem): boolean {
  return (
    item.execution !== undefined &&
    item.comboPartOf?.done !== true &&
    (item.status === "Queued" || item.status === "In Progress") &&
    item.completedQuantity < item.requiredQuantity
  );
}
/**
 * WP-1407: Start is the allergen check before cooking. A line that needs that check always shows
 * Start as its step, and Done only after Start: never a refusal after the food is made.
 */
export function kitchenLineNeedsStartFirst(item: KitchenBoardItem): boolean {
  return (
    item.execution !== undefined &&
    item.status === "Queued" &&
    item.allergenCue === "ReviewRequired"
  );
}

/** The oldest round on the card with anything still to do. */
function oldestOpenRound(items: readonly KitchenBoardItem[]) {
  const rounds = kitchenTicketRounds(items);
  const open = rounds.find((round) =>
    round.items.some((item) => item.execution !== undefined && isActiveKitchenWork(item)),
  );
  return { open, later: open === undefined ? 0 : rounds.length - 1 - rounds.indexOf(open) };
}

export type KitchenTicketStep =
  | {
      readonly kind: "Finish" | "Start";
      readonly items: readonly KitchenBoardItem[];
      readonly label: string;
    }
  | {
      readonly kind: "MarkReady";
      readonly items: readonly KitchenBoardItem[];
      readonly label: string;
    };

/**
 * DEC-KITCHEN-ONE-TAP: the card's one main step, always Done: on the oldest round still open. Dishes
 * that need their allergens checked come first with Start. Mark ready (Expo Enabled) follows when a
 * round is all done. Null when nothing on it takes a step here.
 */
export function kitchenTicketNextStep(
  items: readonly KitchenBoardItem[],
): KitchenTicketStep | null {
  const { open, later } = oldestOpenRound(items);
  if (open === undefined) return null;
  const lines = open.items.filter(
    (item) => item.execution !== undefined && isActiveKitchenWork(item),
  );
  const startFirst = lines.filter(kitchenLineNeedsStartFirst);
  if (startFirst.length > 0)
    return {
      kind: "Start",
      items: startFirst,
      label: startFirst.length > 1 ? t("Start all") : t("Start cooking"),
    };
  const finish = lines.filter(kitchenLineFinishable);
  // A combo's foot button finishes every dish of it still to make: it says "all" over two dishes,
  // so it never reads as one of the dish buttons above it.
  const dishes = finish.reduce(
    (sum, item) => sum + Math.max(1, item.comboParts?.filter((part) => !part.done).length ?? 1),
    0,
  );
  if (finish.length > 0)
    return {
      kind: "Finish",
      items: finish,
      label:
        later > 0 && dishes > 1
          ? t("Round finished")
          : dishes > 1
            ? t("All finished")
            : t("Finished"),
    };
  const ready = lines.filter(
    (item) => item.status === "Completed" && item.execution?.readyAt === null,
  );
  if (ready.length > 0) return { kind: "MarkReady", items: ready, label: t("Mark ready") };
  return null;
}

/**
 * The quiet Start at the top of the card, on the oldest round still open: for kitchens that want
 * guests to see Being made and want to close the cancel window. Never on a dish line of a section's
 * screen: that section did not start the combo, and its Done records it.
 */
export function kitchenTicketStartStep(items: readonly KitchenBoardItem[]) {
  const { open } = oldestOpenRound(items);
  if (open === undefined) return null;
  const lines = open.items.filter(
    (item) =>
      item.execution !== undefined &&
      item.status === "Queued" &&
      item.comboPartOf === undefined &&
      !kitchenLineNeedsStartFirst(item),
  );
  if (lines.length === 0) return null;
  return {
    items: lines,
    label: lines.length > 1 ? t("Start all") : t("Start cooking"),
  };
}

/**
 * What the whole ticket is at, in words true whether or not anyone tapped Start: "to make" says what
 * is left, not whether a pan is on. A dish line of a section's screen reads to make until it is done,
 * whatever another section did with its combo.
 */
export function kitchenTicketState(
  items: readonly KitchenBoardItem[],
): "ToMake" | "Making" | "Done" {
  const open = items.filter(isActiveKitchenWork);
  if (open.length === 0) return "Done";
  return open.some((item) => item.status === "In Progress" && item.comboPartOf === undefined)
    ? "Making"
    : "ToMake";
}

import { useRememberedAlertSound } from "./alert-sound.js";
import { SlowWaitNotice } from "./slow-wait.js";
import { playKitchenChime } from "./alert-chime.js";
export { playKitchenChime };
import { KitchenPaidOrderNotices } from "./KitchenPaidOrderNotices.js";
import { PauseOrderingControl } from "./PauseOrderingControl.js";

/** WP-2423 Q2: "Table T4 · Order 14", "Pickup · Order 5"; never a Customer's name. */
export function kitchenOrderLabel(item: KitchenBoardItem): string {
  return kitchenOrderText(item.orderLabel);
}
/**
 * Owner 2026-11-03: dishes on a ticket that a cook makes the same way read as one line ("3× 担担面").
 * Anything that changes what to make or what to watch for keeps its own line (options, note,
 * allergens, a chase, a combo, part of a quantity done); a step on the line applies to all of them.
 * Finished dishes stay apart: each is remade on its own.
 */
export function mergeIdenticalKitchenItems(items: readonly KitchenBoardItem[]) {
  const lines = new Map<string, KitchenBoardItem[]>();
  for (const item of items) {
    const mergeable =
      (item.status === "Queued" || item.status === "Held" || item.status === "In Progress") &&
      item.completedQuantity === 0 &&
      item.comboParts === undefined &&
      item.comboPartOf === undefined &&
      item.chase === undefined;
    // DEC-KITCHEN-ONE-TAP: a merged line never spans rounds, so a tap never takes a dish of a round
    // the cook has not read.
    const key = mergeable
      ? JSON.stringify([
          item.ticketReference,
          item.displayName,
          item.otherName ?? null,
          item.status,
          item.selectedOptions,
          item.customerNote ?? null,
          item.allergens ?? null,
          item.allergenCue,
          item.exceptionStatus,
          item.kitchenSection ?? null,
          item.stationLabel,
        ])
      : item.workItemReference;
    const line = lines.get(key);
    if (line) line.push(item);
    else lines.set(key, [item]);
  }
  return [...lines.values()].map((same) => {
    const first = same[0] as KitchenBoardItem;
    return {
      items: same,
      item:
        same.length === 1
          ? first
          : {
              ...first,
              requiredQuantity: same.reduce((sum, item) => sum + item.requiredQuantity, 0),
            },
    };
  });
}

/** Facts about the whole order, said once on its ticket rather than under every dish. */
function KitchenOrderOrigin({ label }: { readonly label: KitchenOrderLabel | null | undefined }) {
  if (!label) return null;
  const facts = [
    label.enteredByStaff ? t("Entered by staff") : null,
    // WP-2423 item 8 ⑧: the party moved; the ticket goes to the table it sits at now.
    label.movedFromTableLabel
      ? t("Moved from table {table}", { table: saidTable(label.movedFromTableLabel) })
      : null,
    // WP-2423 item 8 ⑨: the party was merged into this table; its dishes go here now.
    label.mergedFromTableLabel
      ? t("Merged from table {table}", { table: saidTable(label.mergedFromTableLabel) })
      : null,
  ].filter((fact) => fact !== null);
  return (
    <>
      <KitchenTableAllergies label={label} />
      {facts.length === 0 ? null : <p className="kitchen-ticket__origin">{facts.join(" · ")}</p>}
    </>
  );
}

/** WP-2423 (M171, Owner decision 17): the allergens staff marked for this table, in red. */
export function KitchenTableAllergies({
  label,
}: {
  readonly label: KitchenOrderLabel | null | undefined;
}) {
  const allergies = label?.tableAllergies;
  if (allergies === undefined || allergies.length === 0) return null;
  return (
    <p className="kitchen-ticket__table-allergy" role="alert">
      {t("Table allergy: {list}", {
        list: allergies
          .map((allergy) => allergenName(allergy.code, allergy.name))
          .join(listSeparator()),
      })}
    </p>
  );
}

/** WP-2423 (M171): a dish whose menu allergens include one the table must avoid. */
export function containsTableAllergy(item: KitchenBoardItem): boolean {
  const allergies = item.orderLabel?.tableAllergies;
  const allergens = item.allergens;
  if (allergies === undefined || allergens === undefined || allergens.status !== "Declared")
    return false;
  const named = new Set([...allergens.contains, ...allergens.mayContain]);
  return allergies.some((allergy) => named.has(allergy.name));
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
    Math.min(...group.map((item) => Date.parse(kitchenWaitStart(item))));
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
  // Combos by section: a dish done leaves this screen, whatever its combo is still waiting for.
  if (item.comboPartOf?.done === true) return false;
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
        ? t("table {value}", { value: saidTable(byTable.orderLabel?.tableLabel ?? search) })
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
  labels: readonly (Pick<KitchenOrderLabel, "orderNumber" | "orderType" | "tableLabel"> & {
    readonly acceptedNotInKitchen?: true;
  })[],
  search: string,
  hasKitchenWork: boolean,
): string | null {
  const [first] = labels;
  if (first === undefined) return null;
  // WP-2423 M04: accepted and paid, but its ticket never arrived: never "not accepted yet".
  if (labels.length === 1 && first.acceptedNotInKitchen === true)
    return t(
      "{subject} was accepted but hasn't reached the kitchen yet — make it from its dishes on Orders.",
      {
        subject:
          first.orderType === "DineIn" && first.tableLabel
            ? t("Order {orderNumber} (table {tableLabel})", {
                orderNumber: first.orderNumber,
                tableLabel: saidTable(first.tableLabel),
              })
            : t("Order {orderNumber}", { orderNumber: first.orderNumber }),
      },
    );
  if (labels.length > 1)
    return t("{length} orders for “{search}” are not accepted yet — accept them on Orders.", {
      length: labels.length,
      search: search,
    });
  const subject =
    first.orderType === "DineIn" && first.tableLabel
      ? t("Order {orderNumber} (table {tableLabel})", {
          orderNumber: first.orderNumber,
          tableLabel: saidTable(first.tableLabel),
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
            {/* Owner 2026-11-03: no display controls here. This sign-in only reads the board, and the
                keep-awake line sat over the language switch. */}
            <main className="bop-shell__main" id="main-content" tabIndex={-1}>
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
        {/* Owner 2026-11-03: the button says it signs out, so nothing needs explaining behind "more". */}
        <StatePanel heading={t("View only on this screen")} tone="neutral" status>
          <StaffSwitchButton label={t("Sign out and start kitchen display")} />
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
        {t("Allergens not on file. Ask the manager before serving anyone with an allergy.")}
      </p>
    );
  const none = allergens.contains.length === 0 && allergens.mayContain.length === 0;
  // WP-2423 live minor 9: a combo dish on its own line carries the whole combo's disclosure (the
  // menu declares allergens per combo, not per dish in it), so it is named as the combo's.
  const part = item.comboPartOf !== undefined;
  const contains = (value: string) =>
    part ? t("Whole combo contains {value}", { value }) : t("Contains {value}", { value });
  const mayContain = (value: string) =>
    part ? t("Whole combo may contain {value}", { value }) : t("May contain {value}", { value });
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
                ? contains(allergens.contains.join(listSeparator()))
                : "",
              allergens.mayContain.length > 0
                ? mayContain(allergens.mayContain.join(listSeparator()))
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
            <strong>
              {part
                ? t("Whole combo contains: {value}", { value: allergens.contains.join(", ") })
                : t("Contains: {value}", { value: allergens.contains.join(", ") })}
            </strong>
          ) : null}
          {allergens.mayContain.length > 0 ? (
            <span>
              {part
                ? t("Whole combo may contain: {value}", { value: allergens.mayContain.join(", ") })
                : t("May contain: {value}", { value: allergens.mayContain.join(", ") })}
            </span>
          ) : null}
        </>
      )}
      {item.selectedOptions.length > 0 && !allergens.forChoices ? (
        <span className="kitchen-work-item__allergens-modifiers">
          {t("Modifiers may add allergens")}
        </span>
      ) : null}
      {allergens.changedSinceListed === true ? (
        <strong className="kitchen-work-item__allergens-changed">
          {t("Allergens changed since this menu was listed. Check with the manager.")}
        </strong>
      ) : null}
    </p>
  );
}

/** A slot ignores taps this long after what is in it changes. */
export const kitchenSlotSettleMs = 600;
/** A new line rings once and keeps its mark this long; the kitchen no longer accepts anything. */
export const kitchenArrivalFreshMs = 60_000;
/** One reminder while nobody has touched this screen since the ticket appeared (WP-2423 Q33). */
export const kitchenArrivalReminderMs = 120_000;

/** The key a line has on this screen: its work item, or its work item and chosen dish. */
export function kitchenLineKey(item: KitchenBoardItem): string {
  return item.comboPartOf === undefined
    ? item.workItemReference
    : item.workItemReference + ":" + item.comboPartOf.optionReference;
}

/** Whether this line is work this screen has not made yet. */
function waitingToBeMade(item: KitchenBoardItem): boolean {
  return item.comboPartOf !== undefined
    ? !item.comboPartOf.done && item.status !== "Cancelled" && item.status !== "Completed"
    : item.status === "Queued";
}

/**
 * The lines still announced after a read: those already announced that are still to be made, with
 * when they arrived, plus the newly arrived ones.
 */
export function unansweredArrivals(
  current: ReadonlyMap<string, number>,
  arrived: readonly string[],
  lines: readonly KitchenBoardItem[],
  now: number,
): ReadonlyMap<string, number> {
  const waiting = new Set(lines.filter(waitingToBeMade).map(kitchenLineKey));
  const next = new Map<string, number>();
  for (const [key, at] of current) if (waiting.has(key)) next.set(key, at);
  for (const key of arrived) if (waiting.has(key) && !next.has(key)) next.set(key, now);
  return next.size === current.size && [...next.keys()].every((key) => current.has(key))
    ? current
    : next;
}

/** Whether a line arrived after anyone last touched this screen (the back-to-the-screen case). */
export function kitchenArrivalsUnattended(
  arrivals: ReadonlyMap<string, number>,
  lastTouchAt: number,
): boolean {
  return [...arrivals.values()].some((at) => at > lastTouchAt);
}

const KITCHEN_SOUND_KEY = "bop.kitchen.sound";

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
/** The section this device's choice means on this board (a Store without sections shows all). */
function kitchenSectionOnBoard(view: KitchenBoardView, section: string): string {
  const known =
    (view.kitchenSections ?? []).length > 0 ||
    view.items.some(
      (item) =>
        item.kitchenSection != null ||
        Object.values(item.comboPartSections ?? {}).some((name) => name !== null),
    );
  return known || (section !== "All" && section !== "None") ? section : "All";
}
/** The section a work item is in: its name, or "None" for a dish with no section. */
const sectionOf = (item: KitchenBoardItem) => item.kitchenSection ?? "None";

/** One thing the board has to say, in one line. */
export interface KitchenStatusEntry {
  readonly key: string;
  readonly tone: "Info" | "New" | "Problem";
  readonly text: string;
  /** When it was said (this page's clock); a standing fact has none and comes last. */
  readonly at?: number;
}
/**
 * DEC-KITCHEN-ONE-TAP: nothing above the tickets changes height during service, so a message arriving
 * as a finger lands never puts that finger on another order's button. This row always keeps its
 * height. It says the newest thing in one line, and more on a tap, laid over the board.
 */
export function KitchenStatusRow({
  entries,
  details,
}: {
  readonly entries: readonly KitchenStatusEntry[];
  /** What a status needs beyond one line (a retry, a dismiss). */
  readonly details?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...entries].sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  const [first] = sorted;
  const hasMore = entries.length > 1 || details !== undefined;
  const opened = open && hasMore;
  const hasDetails = details !== undefined;
  useEffect(() => {
    setOpen(false);
  }, [hasDetails]);
  return (
    <div className="kitchen-status-row" data-tone={first?.tone}>
      <p role="status" className="kitchen-status-row__line">
        {first?.text ?? ""}
      </p>
      {hasMore ? (
        <button
          type="button"
          className="kitchen-status-row__more"
          aria-expanded={opened}
          onClick={() => setOpen((value) => !value)}
        >
          {details === undefined ? t("{count} more", { count: entries.length - 1 }) : t("Details")}
        </button>
      ) : null}
      {opened ? (
        <div className="kitchen-status-row__detail">
          {entries.length > 0 ? (
            <ul>
              {sorted.map((entry) => (
                <li key={entry.key} data-tone={entry.tone}>
                  {entry.text}
                </li>
              ))}
            </ul>
          ) : null}
          {details}
        </div>
      ) : null}
    </div>
  );
}

/** Where a line of a combo's dish says how its combo stands, short enough for a wet glance. */
export function kitchenComboDishNote(line: KitchenBoardItem["comboPartOf"]): string | null {
  if (line === undefined) return null;
  const { comboName, stillToMake } = line;
  const count = stillToMake.length;
  if (count === 0) return t("Combo: {comboName} · last dish of it", { comboName });
  return count <= 2
    ? t("Combo: {comboName} · also {dishes}", {
        comboName,
        dishes: stillToMake.join(listSeparator()),
      })
    : t("Combo: {comboName} · {count} more dishes", { comboName, count });
}

/**
 * Combos by section. "All sections": the combo stays one card with its dishes under it. One section:
 * a regular dish shows if it is in that section; a combo is replaced by one line per chosen dish in
 * that section, each with its own Done, reading to make whatever another section did. A dish with no
 * section shows under "No section" only, as an ordinary dish does, so two stations never both make it;
 * each section's screen counts it as waiting in "No section". A combo still open with no dish left to
 * make shows on every screen as one line, so it can be finished.
 */
export function kitchenScreenLines(
  items: readonly KitchenBoardItem[],
  section: string,
): readonly KitchenBoardItem[] {
  if (section === "All") return items;
  return items.flatMap((item) => {
    const parts = item.comboParts;
    const sections = item.comboPartSections;
    if (parts === undefined || sections === undefined)
      return sectionOf(item) === section ? [item] : [];
    const open = item.status === "Queued" || item.status === "In Progress";
    if (open && parts.every((part) => part.done)) return [item];
    return parts.flatMap((part) => {
      const dishSection = sections[part.optionReference] ?? null;
      if ((dishSection ?? "None") !== section) return [];
      const label = part.nameZh || part.name;
      const line = Object.fromEntries(
        Object.entries(item).filter(
          ([key]) => !["comboParts", "comboPartSections", "otherName"].includes(key),
        ),
      ) as unknown as KitchenBoardItem;
      return [
        Object.freeze({
          ...line,
          displayName: label,
          ...(part.nameZh && part.name !== part.nameZh ? { otherName: part.name } : {}),
          selectedOptions: Object.freeze([]),
          comboPartOf: Object.freeze({
            comboName: item.displayName,
            optionReference: part.optionReference,
            done: part.done,
            stillToMake: Object.freeze(
              parts
                .filter((other) => other !== part && !other.done)
                .map((other) => other.nameZh || other.name),
            ),
          }),
        }),
      ];
    });
  });
}

/** Whether a line belongs under a work-state tab or filter. */
function kitchenLineInStatus(item: KitchenBoardItem, value: string): boolean {
  if (value === "All") return true;
  if (value === "Active") return isActiveKitchenWork(item);
  if (item.comboPartOf !== undefined)
    return item.status === "Cancelled"
      ? value === "Cancelled"
      : item.comboPartOf.done
        ? value === "Completed"
        : value === "Queued";
  return item.status === value;
}

/** The sections that still have something to make of this work. */
function sectionsWithWork(item: KitchenBoardItem): readonly string[] {
  const parts = item.comboParts;
  const sections = item.comboPartSections;
  if (parts === undefined || sections === undefined) return [sectionOf(item)];
  return [
    ...new Set(
      parts.filter((part) => !part.done).map((part) => sections[part.optionReference] ?? "None"),
    ),
  ];
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

/**
 * The lines to make on this screen that were not on it at the previous read. The first read sounds
 * nothing. A chosen dish alerts its own screen even if another section already started its combo.
 */
export function newQueuedReferences(
  previous: readonly KitchenBoardItem[] | null,
  next: readonly KitchenBoardItem[],
): readonly string[] {
  if (previous === null) return [];
  const seen = new Set(previous.map(kitchenLineKey));
  return next
    .filter((item) => waitingToBeMade(item) && !seen.has(kitchenLineKey(item)))
    .map(kitchenLineKey);
}

/** A line stays on its card this long once cancelled, so a cook does not keep making it. */
export const kitchenCancelledNoticeMs = 60_000;
/**
 * Lines on this screen that became cancelled since the previous read: the kitchen is told, because a
 * dish nobody tapped Start on may already be in the pan.
 */
export function newKitchenCancellations(
  previous: readonly KitchenBoardItem[] | null,
  next: readonly KitchenBoardItem[],
): readonly string[] {
  if (previous === null) return [];
  const before = new Map(previous.map((item) => [kitchenLineKey(item), item.status]));
  return next
    .filter((item) => {
      const status = before.get(kitchenLineKey(item));
      return item.status === "Cancelled" && status !== undefined && status !== "Cancelled";
    })
    .map(kitchenLineKey);
}
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useStaffSessionLive } from "./staff-session-reads.js";
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
  kitchenWaitStart,
} from "./kitchen-board.js";
import { StaffSignInLink, StaffSwitchButton } from "./StaffSession.js";
import { floorServerProblemHeading, kitchenServerProblemText } from "./failure-words.js";

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
    ServerProblem: [floorServerProblemHeading, kitchenServerProblemText],
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

/** What a tap asks of a line. */
export type KitchenBoardStep = KitchenStepKind | "MarkReady";

/** The taps that hold any line of these items (a combo's dishes are held under its work item). */
function kitchenCardTaps(
  items: readonly KitchenBoardItem[],
  pendingLines: ReadonlyMap<string, KitchenTap<KitchenStepTarget>> | undefined,
): readonly KitchenTap<KitchenStepTarget>[] {
  return [
    ...new Map(
      [...(pendingLines?.entries() ?? [])]
        .filter(([key]) =>
          items.some(
            (item) => key === kitchenLineKey(item) || key.startsWith(item.workItemReference + ":"),
          ),
        )
        .map(([, tap]) => [tap.id, tap] as const),
    ).values(),
  ];
}

/**
 * What a tap on this card is doing, in the card's top row, away from the Done just tapped: Undo while
 * it is held, "recording" while it goes, and a retry once it failed. Otherwise the row shows what the
 * card offers there (the quiet Start).
 */
function KitchenTapStatus({
  taps,
  readOnly,
  steps,
  children,
}: {
  readonly taps: readonly KitchenTap<KitchenStepTarget>[];
  readonly readOnly: boolean;
  readonly steps:
    | {
        readonly onUndo: (taps: readonly number[]) => void;
        readonly onRetry: (taps: readonly number[]) => void;
        readonly onDismiss: (taps: readonly number[]) => void;
      }
    | undefined;
  readonly children?: ReactNode;
}) {
  const failed = taps.filter((tap) => tap.phase === "Failed").map((tap) => tap.id);
  const holding = taps.filter((tap) => tap.phase === "Holding");
  const sending = taps.some(
    (tap) => tap.phase === "Waiting" || tap.phase === "Sending" || tap.phase === "Retrying",
  );
  return (
    <div className="kitchen-ticket__top" aria-live="polite">
      {failed.length > 0 ? (
        <>
          <span className="kitchen-ticket__top-text" data-tone="problem">
            {t("Not recorded yet")}
          </span>
          <button type="button" disabled={readOnly} onClick={() => steps?.onRetry(failed)}>
            {t("Try again")}
          </button>
          <button type="button" onClick={() => steps?.onDismiss(failed)}>
            {t("Never mind")}
          </button>
        </>
      ) : holding.length > 0 ? (
        <>
          <span className="kitchen-ticket__top-text">
            {holding.every((tap) => tap.step === "Start") ? t("Marked started") : t("Marked done")}
          </span>
          <button type="button" onClick={() => steps?.onUndo(holding.map((tap) => tap.id))}>
            {t("Undo")}
          </button>
        </>
      ) : sending ? (
        <span className="kitchen-ticket__top-text">{t("Recording…")}</span>
      ) : (
        children
      )}
    </div>
  );
}

function WorkCard({
  item,
  readOnly,
  observedAt,
  ageAt,
  onStep,
  onDishDone,
  pending,
  pendingLines,
  cancelledNotice = false,
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
  readonly onStep?: (item: KitchenBoardItem, step: KitchenBoardStep) => void;
  /** Combos: one chosen dish done, on the screen that shows the whole combo. */
  readonly onDishDone?: ((item: KitchenBoardItem, part: ComboPartView) => void) | undefined;
  /** What a tap currently holds of this line, if anything. */
  readonly pending?: KitchenTap<KitchenStepTarget> | undefined;
  /** The same for a combo's dishes, by each dish's line key. */
  readonly pendingLines?: ReadonlyMap<string, KitchenTap<KitchenStepTarget>> | undefined;
  /** This line was just cancelled: it stays struck through so nobody keeps making it. */
  readonly cancelledNotice?: boolean;
  /** WP-2423 Q26: offered on finished dishes when the operator may remake them. */
  readonly onRemake?: ((item: KitchenBoardItem) => void) | undefined;
  readonly showDetails?: boolean;
  readonly showActions?: boolean;
  readonly showModifiers?: boolean;
  readonly detailState?: KitchenQueueScope;
}) {
  const age = Math.max(
    0,
    Math.floor((Date.parse(ageAt ?? observedAt) - Date.parse(kitchenWaitStart(item))) / 60_000),
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
      data-work-item={showActions ? kitchenLineKey(item) : undefined}
      tabIndex={showActions ? -1 : undefined}
      aria-label={showActions ? item.displayName : undefined}
      data-read-only={readOnly}
      data-age={kitchenAgeTier(age)}
      data-status={item.status}
      data-pending={pending?.phase}
      data-cancelled-notice={cancelledNotice ? "true" : undefined}
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
        {cancelledNotice ? (
          <p className="kitchen-work-item__cancelled" role="alert">
            {t("Cancelled · don't make it")}
          </p>
        ) : null}
        {item.comboPartOf === undefined ? null : (
          <p className="kitchen-work-item__combo-note">{kitchenComboDishNote(item.comboPartOf)}</p>
        )}
        {item.takenOnPaper !== true || !isActiveKitchenWork(item) ? null : (
          // Owner 2026-11-03: it came from a paper slip, so the kitchen may have made it already.
          <p className="kitchen-work-item__paper" role="note">
            {t(
              "From a paper slip during the outage. Already made? Don't make it again, just mark it done.",
            )}
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
          {item.comboPartOf !== undefined
            ? item.comboPartOf.done
              ? t("Done")
              : t("To make")
            : item.status === "In Progress"
              ? t("Being made")
              : item.status === "Queued"
                ? t("To make")
                : systemText(item.status)}
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
        {/* Owner 2026-11-03 walkthrough: what to make comes first, then what it contains. */}
        {item.comboParts !== undefined ? (
          <KitchenComboParts
            item={item}
            readOnly={readOnly}
            onDishDone={showActions === true && inTicket === true ? onDishDone : undefined}
            pendingLines={pendingLines}
          />
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
        <KitchenAllergenLine item={item} />
        {containsTableAllergy(item) ? (
          <p className="kitchen-work-item__table-allergy" role="alert">
            {t("Contains a table allergy")}
          </p>
        ) : null}
        {!inTicket ? <KitchenTableAllergies label={item.orderLabel} /> : null}
        {!inTicket && item.orderLabel?.enteredByStaff ? (
          <p className="kitchen-work-item__staff">{t("Entered by staff")}</p>
        ) : null}
        {!inTicket && item.orderLabel?.movedFromTableLabel ? (
          // WP-2423 item 8 ⑧: the party moved; the ticket goes to the table it sits at now.
          <p className="kitchen-work-item__staff">
            {t("Moved from table {table}", {
              table: saidTable(item.orderLabel.movedFromTableLabel),
            })}
          </p>
        ) : null}
        {!inTicket && item.orderLabel?.mergedFromTableLabel ? (
          // WP-2423 item 8 ⑨: the party was merged into this table; its dishes go here now.
          <p className="kitchen-work-item__staff">
            {t("Merged from table {table}", {
              table: saidTable(item.orderLabel.mergedFromTableLabel),
            })}
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
                {kitchenLineNeedsStartFirst(item) ? (
                  <button
                    className="kitchen-work-item__done"
                    disabled={readOnly || !onStep || pending !== undefined}
                    onClick={() => onStep?.(item, "Start")}
                  >
                    {t("Start cooking")}
                  </button>
                ) : kitchenLineFinishable(item) &&
                  // A combo is finished when every dish of it is done; each has its own Done.
                  combosDishesDone(item) ? (
                  <button
                    className="kitchen-work-item__done"
                    disabled={readOnly || !onStep || pending !== undefined}
                    aria-label={t("Mark {displayName} finished", { displayName: item.displayName })}
                    onClick={() => onStep?.(item, "Finish")}
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
                {item.status === "Queued" ? (
                  <button
                    disabled={readOnly || !onStep || pending !== undefined}
                    onClick={() => onStep?.(item, "Start")}
                  >
                    {t("Start cooking")}
                  </button>
                ) : null}
                {/* A combo on an earlier day's card finishes as a whole; no dish lines here. */}
                {kitchenLineFinishable(item) && !kitchenLineNeedsStartFirst(item) ? (
                  <button
                    disabled={readOnly || !onStep || pending !== undefined}
                    onClick={() => onStep?.(item, "Finish")}
                  >
                    {t("Finished")}
                  </button>
                ) : null}
                {item.status === "Completed" && item.execution.readyAt === null ? (
                  <button
                    disabled={readOnly || !onStep}
                    onClick={() => onStep?.(item, "MarkReady")}
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
  steps,
  actionsBlocked = true,
  navigation,
  soundOn,
  onRing,
  soundResumes = false,
  onSoundToggle,
  arrivals = [],
  arrivalsAt,
  cancelledLines,
  section: chosenSection,
  onSection,
  autoRefresh = false,
  stale,
  checkedAt,
  soldOutHref,
  remakes,
  earlierDays,
  headerStatus,
  statusEntries = [],
  statusDetails,
  pauseOrdering,
  workspaceFrame,
}: {
  readonly view: KitchenBoardView;
  /** A counter or office sign-in: the app's workspace frame instead of the kitchen display's. */
  readonly workspaceFrame?: KitchenWorkspaceFrame | undefined;
  /** What happened to the last kitchen step, remake or ticket close, newest first. */
  readonly statusEntries?: readonly KitchenStatusEntry[];
  /** What those need beyond one line (a retry, a dismiss), shown on a tap. */
  readonly statusDetails?: ReactNode;
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
  /** DEC-KITCHEN-ONE-TAP: the board's steps, when this screen can take them. */
  readonly steps?:
    | {
        readonly pendingLines: ReadonlyMap<string, KitchenTap<KitchenStepTarget>>;
        readonly onStep: (targets: readonly KitchenStepTarget[], step: KitchenStepKind) => void;
        readonly onMarkReady: (items: readonly KitchenBoardItem[]) => void;
        readonly onUndo: (taps: readonly number[]) => void;
        readonly onRetry: (taps: readonly number[]) => void;
        readonly onDismiss: (taps: readonly number[]) => void;
      }
    | undefined;
  readonly actionsBlocked?: boolean;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: RefObject<HTMLButtonElement | null>;
  readonly navigation?: ReactNode;
  /** New-ticket chime; off until the operator turns it on (browsers need that gesture). */
  readonly soundOn?: boolean | undefined;
  /** One chime on this screen, when sound is on. */
  readonly onRing?: (() => void) | undefined;
  /** DEC-PAID-ORDER-AUTO-ACCEPT: the Store's Pause, for whoever may pause (absent: not offered). */
  readonly pauseOrdering?: ReactNode;
  readonly onSoundToggle?: (() => void) | undefined;
  /** WP-2423 Q33: sound was on before this page loaded; it returns at the next tap. */
  readonly soundResumes?: boolean | undefined;
  /** The lines of this screen that arrived in the last minute. */
  readonly arrivals?: readonly string[] | undefined;
  /** When the newest of them arrived (this page's clock). */
  readonly arrivalsAt?: number | undefined;
  /** The lines of this screen just cancelled, kept on their card for a minute. */
  readonly cancelledLines?: ReadonlySet<string> | undefined;
  /** The section this screen shows, when the page keeps it (it decides what rings here). */
  readonly section?: string | undefined;
  readonly onSection?: ((section: string) => void) | undefined;
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
  const [ownSection, setOwnSection] = useState(storedKitchenSection);
  const section = chosenSection ?? ownSection;
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
  const stepLabels: Record<KitchenBoardStep, string> = {
    Start: t("Start cooking"),
    Finish: t("Finished"),
    MarkReady: t("Mark ready"),
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
  // DEC-KITCHEN-ONE-TAP: a slot ignores taps for a moment after what is in it changes, so a double
  // tap, or a ticket leaving because of a read, never lands on another order's button.
  const slots = useRef(new Map<string, { signature: string; changedAt: number }>());
  const slotsSeeded = useRef(false);
  const slotSettled = (key: string) =>
    performance.now() - (slots.current.get(key)?.changedAt ?? -Infinity) >= kitchenSlotSettleMs;
  const pendingLines = steps?.pendingLines;
  const tapLines = (
    slot: string,
    lines: readonly KitchenBoardItem[],
    step: KitchenBoardStep,
  ): void => {
    const first = lines[0];
    if (first === undefined || steps === undefined || !slotSettled(slot)) return;
    guarded(first, stepLabels[step], () => {
      pendingFocus.current = kitchenFocusIntent(workspaceRef.current, kitchenLineKey(first));
      if (step === "MarkReady") {
        steps.onMarkReady(lines);
        return;
      }
      steps.onStep(
        lines.map((line) => ({
          lineKey: kitchenLineKey(line),
          item: line,
          optionReferences: line.comboPartOf ? [line.comboPartOf.optionReference] : null,
        })),
        step,
      );
    });
  };
  const tapDish = (slot: string, item: KitchenBoardItem, part: ComboPartView) => {
    if (steps === undefined || !slotSettled(slot)) return;
    guarded(item, stepLabels.Finish, () =>
      steps.onStep(
        [
          {
            lineKey: item.workItemReference + ":" + part.optionReference,
            item,
            optionReferences: [part.optionReference],
          },
        ],
        "Finish",
      ),
    );
  };
  const onRemake = remakes?.canRework
    ? (item: KitchenBoardItem) => guarded(item, t("Remake"), () => setRemakeTarget(item))
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
          item.comboPartSections !== undefined
            ? Object.values(item.comboPartSections).filter((name) => name !== null)
            : item.kitchenSection === undefined || item.kitchenSection === null
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
    setOwnSection(value);
    onSection?.(value);
    storeKitchenSection(value);
  };
  // What waits in the other sections, so nothing is hidden quietly: orders (tickets) per section. A
  // combo's dish with no section waits in "No section", like any dish with none.
  const otherSections =
    activeSection === "All"
      ? []
      : [
          ...searchMatches.filter(isActiveKitchenWork).reduce((found, item) => {
            for (const name of sectionsWithWork(item)) {
              if (name === activeSection) continue;
              const tickets = found.get(name) ?? new Set<string>();
              tickets.add(item.ticketReference);
              found.set(name, tickets);
            }
            return found;
          }, new Map<string, Set<string>>()),
        ]
          .map(([name, tickets]) => ({ name, count: tickets.size }))
          .sort((a, b) =>
            a.name === "None" ? 1 : b.name === "None" ? -1 : a.name.localeCompare(b.name),
          );
  const sectionText = (name: string) => (name === "None" ? t("No section") : name);
  const screenLines = kitchenScreenLines(searchMatches, activeSection);
  const itemsInStatus = (value: string) =>
    screenLines.filter(
      (item) =>
        (activeStation === "All" || item.stationLabel === activeStation) &&
        (kitchenLineInStatus(item, value) ||
          (value === "Active" && cancelledLines?.has(kitchenLineKey(item)) === true)) &&
        (activeAllergen === "All" || item.allergenCue === activeAllergen) &&
        (activeException === "All" || item.exceptionStatus === activeException),
    );
  const items = itemsInStatus(status);
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
  const queueCount = (
    <span className="kitchen-queue-count" aria-live="polite">
      {t("{length} work {value}", {
        length: items.length,
        value: items.length === 1 ? t("item") : t("items"),
      })}
    </span>
  );
  const boardFreshness = (
    <p className="kitchen-board-freshness">
      {workspaceFrame ? null : queueCount}
      <Freshness
        status={stale ? "Stale" : view.freshnessStatus}
        at={view.projectedAt}
        checkedAt={checkedAt}
      />
      <span data-operator={view.operatorStatus}>{kitchenOperatorText(view.operatorStatus)}</span>
      {autoRefresh && !stale ? (
        <span className="kitchen-board-autorefresh">{t("Auto-refresh every 10 s")}</span>
      ) : null}
    </p>
  );
  // Held work is rare: its tab shows only while there is some, or while it is chosen.
  const statusTabs: readonly (readonly [string, string])[] = [
    ["Active", t("Open work")],
    ["Queued", t("To make")],
    ...(status === "Held" || itemsInStatus("Held").length > 0
      ? ([["Held", t("Held")]] as const)
      : []),
    ["Completed", t("Completed")],
    ["All", t("All")],
  ];
  const renderEarlierAttention = () =>
    earlierTickets.length === 0 ? null : (
      <section className="order-attention" aria-labelledby="kitchen-attention-heading">
        <h2 id="kitchen-attention-heading">{t("Needs attention")}</h2>
        <ul>
          {earlierTickets.map((ticket) => {
            const waited = Math.max(
              0,
              Math.floor((Date.parse(clockAt) - Date.parse(ticket.createdAt)) / 60_000),
            );
            const dishes = ticket.items
              .map((item) => `${item.requiredQuantity}× ${item.displayName}`)
              .join("、");
            return (
              <li key={ticket.ticketReference}>
                <div>
                  <p>
                    {t("{orderLabel} · {day} · not finished", {
                      orderLabel: ticket.orderLabel,
                      day: earlierDayText(ticket.businessDate),
                    })}
                  </p>
                  <p className="order-attention__hint">
                    {dishes} {t("· waiting {waited}", { waited: kitchenWaitText(waited) })}
                  </p>
                </div>
                {canCloseEarlier ? (
                  <button
                    type="button"
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
              </li>
            );
          })}
        </ul>
        {canCloseEarlier ? null : (
          <p className="order-attention__hint">{t("Ask a manager to check and close them.")}</p>
        )}
      </section>
    );
  const filterToggle = (
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
  );
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
        onChange={(event) => {
          const value = event.currentTarget.value;
          setOrderInput(value);
          // Owner 2026-11-03: the row finds as staff type, so a touch screen needs no key or button.
          // WP-2423 M157: the phone's sheet finds as staff type too; Done then shows the result.
          setOrderSearch(kitchenOrderSearchTerm(value) === null ? null : value.trim());
        }}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
      />
      {/* Owner 2026-11-03: the row searches on Enter; the phone's sheet keeps its own button. */}
      {layout === "mobile" || searchApplied ? (
        <div className="kitchen-reference-search__actions">
          {layout === "mobile" ? <button type="submit">{t("Find")}</button> : null}
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
        </div>
      ) : null}
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
      {/* The back office switches state with the tabs, as on the Orders page. */}
      {layout === "desktop" && workspaceFrame ? null : (
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
            <option value="Queued">{t("To make")}</option>
            <option value="Held">{t("Held")}</option>
            <option value="In Progress">{t("Being made")}</option>
            <option value="Completed">{t("Completed")}</option>
            <option value="Cancelled">{t("Cancelled")}</option>
          </select>
        </label>
      )}
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
          onClick={() => {
            // WP-2423 M157: Done applies what was typed, so a number never needs "Find" as well.
            setOrderSearch(kitchenOrderSearchTerm(orderInput) === null ? null : orderInput.trim());
            filterSheetRef.current?.close();
          }}
        >
          {t("Done")}
        </button>
      ) : null}
    </div>
  );
  const queueBar = (
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
  );
  const arrivalLabels = [
    ...new Set(
      // merchant-outage-recovery M120: only this screen's station, and only dishes not started.
      screenLines
        .filter(
          (item) =>
            arrivals.includes(kitchenLineKey(item)) &&
            (activeStation === "All" || item.stationLabel === activeStation) &&
            waitingToBeMade(item),
        )
        .map((item) => kitchenOrderLabel(item)),
    ),
  ];
  const groupsByLane = stationLanes.map((lane) => groupKitchenItemsByOrder(lane.items));
  // What sits in each slot now, in board order (see slotSettled).
  groupsByLane.flat().forEach((group, index) => {
    const signature = index + ":" + group.items.map(kitchenLineKey).join(",");
    const known = slots.current.get(group.orderReference);
    if (known === undefined)
      slots.current.set(group.orderReference, {
        signature,
        changedAt: slotsSeeded.current ? performance.now() : -Infinity,
      });
    else if (known.signature !== signature)
      slots.current.set(group.orderReference, { signature, changedAt: performance.now() });
  });
  slotsSeeded.current = true;
  // A ticket that moved is a changed slot too (a line of the ticket above it left, or a ticket before
  // it closed): the finger that was over its Done may now be over another order's. Measured from
  // its place on the board, so scrolling is never a move.
  const slotPlaces = useRef(new Map<string, string>());
  const slotElements = useRef(new Map<string, HTMLElement>());
  const slotRef = (key: string) => (element: HTMLElement | null) => {
    if (element) slotElements.current.set(key, element);
    else slotElements.current.delete(key);
  };
  useLayoutEffect(() => {
    const now = performance.now();
    const places = new Map<string, string>();
    for (const [key, element] of slotElements.current) {
      const place = `${element.offsetLeft},${element.offsetTop}`;
      places.set(key, place);
      const before = slotPlaces.current.get(key);
      if (before !== undefined && before !== place)
        slots.current.set(key, {
          signature: slots.current.get(key)?.signature ?? "",
          changedAt: now,
        });
    }
    slotPlaces.current = places;
  });
  return (
    <KitchenFrame
      workspaceFrame={workspaceFrame}
      title={view.storeLabel}
      navigation={navigation}
      headerStatus={headerStatus}
    >
      <div
        className={`kitchen-board-workspace${workspaceFrame ? " orders-page" : ""}`}
        ref={workspaceRef}
        data-view-only={view.operatorStatus === "Unverified" ? "true" : undefined}
      >
        <header
          className={`${workspaceFrame ? "workspace-page__header" : "screen-heading"} kitchen-board-heading`}
        >
          <div className={workspaceFrame ? "workspace-page__title" : undefined}>
            {workspaceFrame ? (
              <h1 id="kitchen-board-title" tabIndex={-1}>
                {t("Kitchen")}
              </h1>
            ) : (
              <h2 id="kitchen-board-title" tabIndex={-1}>
                {t("Kitchen")}
              </h2>
            )}
            {workspaceFrame ? (
              // Owner 2026-11-03: built as the Orders page is: one sentence under the title.
              <p className="workspace-page__meta">
                {t("Today")} {queueCount}
                {board.earlier.length > 0
                  ? ` ${t("· {count} more from earlier days", { count: board.earlier.length })}`
                  : null}
              </p>
            ) : (
              boardFreshness
            )}
          </div>
          <div className="kitchen-board-heading__actions">
            {workspaceFrame ? boardFreshness : null}
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
            <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
              {t("Refresh")}
            </button>
            {/* Owner 2026-11-03: a setting, not an alarm; red only where new orders would go unheard. */}
            {onSoundToggle ? (
              <button
                type="button"
                aria-pressed={soundOn === true}
                onClick={onSoundToggle}
                className="kitchen-sound-toggle"
                data-alert={!soundOn && !readOnly ? "true" : undefined}
              >
                {soundOn ? t("Sound on") : t("Sound off")}
              </button>
            ) : null}
            {/* Owner 2026-10-26: the language switch ends the title row, as on every workspace page. */}
            {workspaceFrame ? <LanguageSwitch className="workspace-page__language" /> : null}
          </div>
        </header>
        <KitchenStatusRow
          entries={[
            ...(stale
              ? [
                  {
                    key: "stale",
                    tone: "Problem" as const,
                    at: Infinity,
                    text:
                      t("Read-only until reconnected") +
                      " · " +
                      (stale.reason === "Offline" ? t("Offline") : t("Connection lost")),
                  },
                ]
              : view.operatorStatus === "Named" && view.freshnessStatus !== "Fresh"
                ? [
                    {
                      key: "catching-up",
                      tone: "Problem" as const,
                      at: Infinity,
                      text: t("Catching up with new orders"),
                    },
                  ]
                : []),
            ...statusEntries,
            ...(arrivalLabels.length === 0
              ? []
              : [
                  {
                    key: "arrivals",
                    tone: "New" as const,
                    ...(arrivalsAt === undefined ? {} : { at: arrivalsAt }),
                    text:
                      arrivalLabels.length === 1
                        ? t("New order: {list}", { list: arrivalLabels.join(listSeparator()) })
                        : t("{count} new orders: {list}", {
                            count: arrivalLabels.length,
                            list: arrivalLabels.join(listSeparator()),
                          }),
                  },
                ]),
            ...(view.moreWaiting === undefined
              ? []
              : [
                  {
                    key: "more-waiting",
                    tone: "Problem" as const,
                    text:
                      view.moreWaiting === true
                        ? t("More orders are waiting. They show as you finish these.")
                        : t("{count} more orders are waiting. They show as you finish these.", {
                            count: view.moreWaiting,
                          }),
                  },
                ]),
            ...(remakes?.readFailed
              ? [
                  {
                    key: "remakes-read",
                    tone: "Problem" as const,
                    text: t("Remakes could not be refreshed. The board keeps trying."),
                  },
                ]
              : []),
            ...(board.reworks.length > 0
              ? [
                  {
                    key: "remakes",
                    tone: "New" as const,
                    text: t("Remakes below: {count}", { count: board.reworks.length }),
                  },
                ]
              : []),
            // The toggle already says the sound is off; this says what that means.
            ...(onSoundToggle && !soundOn
              ? [
                  {
                    key: "sound",
                    tone: "Info" as const,
                    text: soundResumes
                      ? t("Sound turns back on at your next tap on this screen.")
                      : t("Sound is off. New orders will not ring on this screen."),
                  },
                ]
              : []),
          ]}
          details={
            stale || statusDetails ? (
              <>
                {stale ? (
                  <StaleReadNotice
                    stale={stale}
                    className="kitchen-board-lock kitchen-board-stale"
                    serverProblemText={kitchenServerProblemText}
                  />
                ) : null}
                {statusDetails}
              </>
            ) : undefined
          }
        />
        {/* DEC-PAID-ORDER-AUTO-ACCEPT: says nothing at a Store that doesn't use it. */}
        <KitchenPaidOrderNotices
          view={view}
          soundOn={soundOn === true}
          soundResumes={soundResumes === true}
          onSoundOn={onSoundToggle}
          onRing={() => onRing?.()}
        />
        {pauseOrdering}
        {/* merchant-outage-recovery M68: a tap still waiting after a few seconds says so. */}
        <SlowWaitNotice busy={(pendingLines?.size ?? 0) > 0} />
        {workspaceFrame ? null : filterToggle}
        {!stale && readOnly && !(view.operatorStatus === "Named") ? (
          <KitchenBoardLock
            operatorStatus={view.operatorStatus}
            freshnessStatus={view.freshnessStatus}
          />
        ) : null}
        {workspaceFrame ? renderEarlierAttention() : null}
        {workspaceFrame ? (
          <div className="order-toolbar">
            <div className="order-status-filters" role="group" aria-label={t("Show kitchen work")}>
              {statusTabs.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={status === value}
                  onClick={() => setStatus(value)}
                >
                  {label}
                  <span className="order-status-filters__count">{itemsInStatus(value).length}</span>
                </button>
              ))}
            </div>
            <div className="order-toolbar__tools">
              {filterToggle}
              {queueBar}
            </div>
          </div>
        ) : (
          queueBar
        )}
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
        {!workspaceFrame && earlierTickets.length > 0 ? (
          <details className="kitchen-earlier-days">
            <summary>
              {/* One line of attention above the day's work. Only someone who can close them is told to. */}
              <span data-action={canCloseEarlier && earlierElsewhere === null ? "true" : undefined}>
                {earlierElsewhere ??
                  (canCloseEarlier
                    ? earlierTickets.length === 1
                      ? t("1 ticket from earlier days to check and close")
                      : t("{length} tickets from earlier days to check and close", {
                          length: earlierTickets.length,
                        })
                    : earlierTickets.length === 1
                      ? t("1 ticket from earlier days")
                      : t("{length} tickets from earlier days", {
                          length: earlierTickets.length,
                        }))}
              </span>
            </summary>
            <p className="kitchen-earlier-days__intro">
              {t("Order numbers restart every day, so these are not today's orders. {value}", {
                value: canCloseEarlier
                  ? t("Check what happened to each one, then close it.")
                  : t("Ask a manager to check and close them."),
              })}
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
                    ref={slotRef(ticket.ticketReference)}
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
                      <KitchenTapStatus
                        taps={kitchenCardTaps(ticket.items, pendingLines)}
                        readOnly={readOnly || actionsBlocked || stale !== undefined}
                        steps={steps}
                      />
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
                        {...(steps
                          ? {
                              onStep: (line: KitchenBoardItem, step: KitchenBoardStep) =>
                                tapLines(ticket.ticketReference, [line], step),
                            }
                          : {})}
                        pending={pendingLines?.get(kitchenLineKey(item))}
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
            {stationLanes.map((lane, laneIndex) => {
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
                    {(groupsByLane[laneIndex] ?? []).map((group) => {
                      const ticket = kitchenTicketAge(group.items, clockAt);
                      const tierText = kitchenTicketTierText(ticket.tier);
                      const first = group.items[0] as KitchenBoardItem;
                      const label = first.orderLabel;
                      const state = kitchenTicketState(group.items);
                      const allCancelled =
                        state === "Done" &&
                        group.items.every((item) => item.status === "Cancelled");
                      const next = kitchenTicketNextStep(group.items);
                      const start = kitchenTicketStartStep(group.items);
                      const ticketReadOnly = readOnly || actionsBlocked || stale !== undefined;
                      const slot = group.orderReference;
                      const heldOf = (line: KitchenBoardItem) =>
                        pendingLines?.get(kitchenLineKey(line));
                      const cardTaps = kitchenCardTaps(group.items, pendingLines);
                      const rounds = kitchenTicketRounds(group.items);
                      return (
                        <section
                          className="kitchen-order-group kitchen-ticket"
                          key={group.orderReference}
                          ref={slotRef(slot)}
                          data-age={ticket.tier}
                          data-fresh={
                            group.items.some((item) => arrivals.includes(kitchenLineKey(item)))
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
                                    ? t("Table {tableLabel}", {
                                        tableLabel: saidTable(label.tableLabel),
                                      })
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
                            {/* Away from the Done just tapped, so undo is never a stray second tap. */}
                            <KitchenTapStatus
                              taps={cardTaps}
                              readOnly={ticketReadOnly}
                              steps={steps}
                            >
                              {start !== null && steps !== undefined ? (
                                <button
                                  type="button"
                                  className="kitchen-ticket__start"
                                  disabled={ticketReadOnly}
                                  onClick={() => tapLines(slot, start.items, "Start")}
                                >
                                  {start.label}
                                </button>
                              ) : null}
                            </KitchenTapStatus>
                          </header>
                          {/* The ticket's state and its wait share one row, on every ticket. */}
                          <div className="kitchen-ticket__status">
                            <p
                              className="kitchen-ticket__state"
                              data-state={allCancelled ? "Cancelled" : state}
                            >
                              {allCancelled
                                ? t("Cancelled")
                                : state === "ToMake"
                                  ? t("To make")
                                  : state === "Making"
                                    ? t("Being made")
                                    : t("Done")}
                            </p>
                            <p className="kitchen-ticket__wait">
                              {allCancelled ? null : ticket.minutes === null ? (
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
                          </div>
                          <KitchenOrderOrigin label={label} />
                          {rounds.map((round, roundIndex) => (
                            <Fragment key={round.ticketReference}>
                              {roundIndex === 0 ? null : (
                                // A later round of the table: read apart, and left out of the foot
                                // button until the round above it is done.
                                <p className="kitchen-ticket__round">
                                  {t("Added · {minutes} min ago", {
                                    minutes: Math.max(
                                      0,
                                      Math.floor((Date.parse(clockAt) - round.createdAt) / 60_000),
                                    ),
                                  })}
                                </p>
                              )}
                              {mergeIdenticalKitchenItems(round.items).map((line) => (
                                <WorkCard
                                  key={kitchenLineKey(line.item)}
                                  item={line.item}
                                  inTicket
                                  readOnly={ticketReadOnly}
                                  {...(steps
                                    ? {
                                        onStep: (_item: KitchenBoardItem, step: KitchenBoardStep) =>
                                          tapLines(slot, line.items, step),
                                      }
                                    : {})}
                                  onDishDone={(item, part) => tapDish(slot, item, part)}
                                  pending={line.items.map(heldOf).find(Boolean)}
                                  pendingLines={pendingLines}
                                  cancelledNotice={
                                    line.item.status === "Cancelled" &&
                                    cancelledLines?.has(kitchenLineKey(line.item)) === true
                                  }
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
                            </Fragment>
                          ))}
                          {next && steps !== undefined ? (
                            <button
                              type="button"
                              className="kitchen-ticket__next"
                              disabled={
                                ticketReadOnly ||
                                next.items.every((item) => heldOf(item) !== undefined)
                              }
                              onClick={() =>
                                tapLines(
                                  slot,
                                  next.items.filter((item) => heldOf(item) === undefined),
                                  next.kind,
                                )
                              }
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
        {remakes ? (
          // Below the tickets: a remake from another tablet never moves a ticket under a finger.
          // The row at the top says it is here.
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
  readOnly,
  onDishDone,
  pendingLines,
}: {
  readonly item: KitchenBoardItem;
  readonly readOnly: boolean;
  readonly onDishDone?: ((item: KitchenBoardItem, part: ComboPartView) => void) | undefined;
  readonly pendingLines?: ReadonlyMap<string, KitchenTap<KitchenStepTarget>> | undefined;
}) {
  const parts = item.comboParts ?? [];
  const open = item.status === "Queued" || item.status === "In Progress";
  return (
    <ul className="kitchen-work-item__combo" aria-label={t("Dishes in this combo")}>
      {parts.map((part) => {
        const label = part.nameZh || part.name;
        const pending = pendingLines?.get(item.workItemReference + ":" + part.optionReference);
        return (
          <li
            key={part.optionReference}
            data-done={part.done ? "true" : undefined}
            data-pending={pending?.phase}
          >
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
            ) : onDishDone !== undefined && open ? (
              <button
                type="button"
                className="kitchen-work-item__combo-step"
                disabled={readOnly || pending !== undefined}
                aria-label={t("Mark {displayName} finished", { displayName: label })}
                onClick={() => onDishDone(item, part)}
              >
                {t("Finished")}
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
    ...(view.item.placedAt === undefined
      ? []
      : [{ label: t("Order placed"), at: view.item.placedAt }]),
    { label: t("Work item created"), at: view.item.createdAt },
    ...(view.item.execution?.acceptedAt
      ? [{ label: t("Taken by the kitchen"), at: view.item.execution.acceptedAt }]
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
  // WP-2423 Q33: this display remembers that the cook wanted sound (alert-sound.ts).
  const {
    soundOn,
    soundResumes,
    toggle: toggleSound,
    audio,
  } = useRememberedAlertSound(KITCHEN_SOUND_KEY);
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
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
    stale: stale !== undefined,
  });
  // WP-2423 Q26: a confirmed step re-reads the board at once (not at the next 10 s refresh). The
  // queue projection may lag the command by a moment: re-read a few more times, 1.5 s apart.
  const { confirmedCount, awaitingProjection } = actions;
  const followUps = useRef(0);
  useEffect(() => {
    followUps.current = 0;
    if (confirmedCount > 0) setRevision((value) => value + 1);
  }, [confirmedCount]);
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
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  // M3: re-read the queue on its own while the board is visible.
  const found = state.kind === "Found" && stale === undefined;
  // v15 cbff9d6f: no reads once this screen's sign-in has ended.
  const live = useStaffSessionLive();
  useEffect(() => {
    if (!found || !live || typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1);
    }, kitchenRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [found, live]);
  // IDR-0039: after a failed read, keep trying with backoff (and at once when the network returns).
  useStaleRetry(retryAttempts(state), () => setRevision((value) => value + 1));
  // Combos by section: what this screen shows decides what rings on it. A drinks screen stops
  // ringing for wok orders, and a dish alerts its own screen even if its combo was already started.
  const [section, setSection] = useState(storedKitchenSection);
  const boardView = state.kind === "Found" ? state.view : null;
  const screenLines = useMemo(
    () =>
      boardView === null
        ? null
        : kitchenScreenLines(boardView.items, kitchenSectionOnBoard(boardView, section)),
    [boardView, section],
  );
  const previousLines = useRef<readonly KitchenBoardItem[] | null>(null);
  const previousSection = useRef(section);
  const previousChases = useRef<KitchenBoardView | null>(null);
  const [arrivals, setArrivals] = useState<ReadonlyMap<string, number>>(new Map());
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (boardView === null || screenLines === null) return;
    // Changing section sets a new baseline without ringing.
    const baseline = previousSection.current === section ? previousLines.current : null;
    previousSection.current = section;
    const arrived = newQueuedReferences(baseline, screenLines);
    const justCancelled = newKitchenCancellations(baseline, screenLines);
    previousLines.current = screenLines;
    setArrivals((current) => unansweredArrivals(current, arrived, screenLines, performance.now()));
    // WP-2423 item 8 ⑦: a server chased a dish since the previous read.
    const chased = newKitchenChases(previousChases.current, boardView);
    previousChases.current = boardView;
    // Start is optional, so the kitchen is told: a dish nobody marked started may be in the pan.
    if (justCancelled.length > 0) {
      setCancelled((current) => new Set([...current, ...justCancelled]));
      window.setTimeout(() => {
        setCancelled((current) => {
          const next = new Set(current);
          for (const key of justCancelled) next.delete(key);
          return next;
        });
      }, kitchenCancelledNoticeMs);
    }
    if (
      soundOnRef.current &&
      (arrived.length > 0 || chased.length > 0 || justCancelled.length > 0) &&
      audio.current
    )
      playKitchenChime(audio.current);
  }, [boardView, screenLines, section]);
  // A new line rings once and keeps its mark for a minute. A reminder rings only while nobody has
  // touched this screen since it appeared: that is someone away from the screen (WP-2423 Q33).
  const lastTouch = useRef(typeof performance === "undefined" ? 0 : performance.now());
  useEffect(() => {
    const touched = () => {
      lastTouch.current = performance.now();
    };
    document.addEventListener("pointerdown", touched, { capture: true });
    return () => document.removeEventListener("pointerdown", touched, { capture: true });
  }, []);
  const [arrivalClock, setArrivalClock] = useState(0);
  const anyArrival = arrivals.size > 0;
  useEffect(() => {
    if (!anyArrival || typeof window === "undefined") return;
    const tick = window.setInterval(() => setArrivalClock(performance.now()), 5_000);
    const reminder = window.setInterval(() => {
      if (
        soundOnRef.current &&
        audio.current &&
        kitchenArrivalsUnattended(arrivalsRef.current, lastTouch.current)
      )
        playKitchenChime(audio.current);
    }, kitchenArrivalReminderMs);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(reminder);
    };
  }, [anyArrival]);
  const arrivalsRef = useRef(arrivals);
  arrivalsRef.current = arrivals;
  const freshArrivals = useMemo(() => {
    const now = Math.max(arrivalClock, typeof performance === "undefined" ? 0 : performance.now());
    return [...arrivals].filter(([, at]) => now - at < kitchenArrivalFreshMs).map(([key]) => key);
  }, [arrivals, arrivalClock]);
  // When each last changed: the row says the newest thing first.
  const reworkKind = useRef(rework.state.kind);
  const reworkChangedAt = useRef(0);
  if (reworkKind.current !== rework.state.kind) {
    reworkKind.current = rework.state.kind;
    reworkChangedAt.current = performance.now();
  }
  const closeKind = useRef(staleClose.state.kind);
  const closeChangedAt = useRef(0);
  if (closeKind.current !== staleClose.state.kind) {
    closeKind.current = staleClose.state.kind;
    closeChangedAt.current = performance.now();
  }
  // A remake that went through has nothing more to say after a moment.
  const dismissRework = rework.dismiss;
  const reworkConfirmed = rework.state.kind === "Confirmed";
  useEffect(() => {
    if (!reworkConfirmed || typeof window === "undefined") return;
    const timer = window.setTimeout(dismissRework, 30_000);
    return () => window.clearTimeout(timer);
  }, [reworkConfirmed, dismissRework]);
  const statusEntries: readonly KitchenStatusEntry[] = [
    ...actions.notices.map((notice) => ({
      key: "step-" + notice.id,
      tone: notice.tone === "Done" ? ("Info" as const) : ("Problem" as const),
      text: notice.text,
      at: notice.at,
    })),
    ...(rework.state.kind === "Idle"
      ? []
      : [
          {
            key: "rework",
            at: reworkChangedAt.current,
            tone:
              rework.state.kind === "Confirmed" || rework.state.kind === "Submitting"
                ? ("Info" as const)
                : ("Problem" as const),
            text: kitchenReworkStatusHeading(rework),
          },
        ]),
    ...(staleClose.state.kind === "Idle"
      ? []
      : [
          {
            key: "stale-close",
            at: closeChangedAt.current,
            tone:
              staleClose.state.kind === "Confirmed" || staleClose.state.kind === "Submitting"
                ? ("Info" as const)
                : ("Problem" as const),
            text: kitchenStaleCloseHeading(staleClose),
          },
        ]),
  ];
  const statusDetails =
    rework.state.kind === "Idle" && staleClose.state.kind === "Idle" ? undefined : (
      <>
        <KitchenReworkStatus rework={rework} />
        <KitchenStaleCloseStatus close={staleClose} />
      </>
    );
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
  // DEC-PAID-ORDER-AUTO-ACCEPT: the Store's Pause, for whoever may pause.
  const pauseOrdering =
    props.csrf !== undefined && props.storeReference !== undefined && props.csrf !== "" ? (
      <PauseOrderingControl csrf={props.csrf} storeReference={props.storeReference} />
    ) : null;
  return state.kind === "Found" ? (
    <KitchenBoardScreen
      view={actions.view ?? state.view}
      statusEntries={statusEntries}
      statusDetails={statusDetails}
      pauseOrdering={pauseOrdering}
      onRefresh={refresh}
      refreshButtonRef={refreshButtonRef}
      steps={{
        pendingLines: actions.pendingLines,
        onStep: actions.step,
        onMarkReady: actions.markReady,
        onUndo: actions.undo,
        onRetry: actions.retry,
        onDismiss: actions.dismiss,
      }}
      actionsBlocked={actions.blocked || stale !== undefined}
      navigation={navigation}
      headerStatus={headerStatus}
      workspaceFrame={workspaceFrame}
      soundOn={soundOn}
      onRing={() => {
        if (audio.current) playKitchenChime(audio.current);
      }}
      soundResumes={soundResumes}
      onSoundToggle={toggleSound}
      arrivals={freshArrivals}
      arrivalsAt={freshArrivals.length === 0 ? undefined : Math.max(...arrivals.values())}
      cancelledLines={cancelled}
      section={section}
      onSection={setSection}
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
      <KitchenBoardStatePanel state={state.kind} />
      {state.kind !== "Loading" ? (
        <button ref={refreshButtonRef} onClick={refresh}>
          {t("Refresh")}
        </button>
      ) : null}
      {pauseOrdering}
    </KitchenFrame>
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
  // "Sign out and start kitchen display" instead (WP-2423).
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

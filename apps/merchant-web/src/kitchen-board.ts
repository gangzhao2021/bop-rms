import { parseComboParts, type ComboPartView } from "./combo-parts.js";
import { t, saidTable } from "./i18n/i18n.js";
import { parsePaidOrderWatch, type PaidOrderWatch } from "./paid-order-watch.js";
export type KitchenStatus = "Queued" | "Held" | "In Progress" | "Completed" | "Cancelled";

export interface KitchenSelectedOption {
  readonly displayName: string;
  readonly quantity: number;
}

/**
 * WP-2423 Q3: the allergen disclosure published on the menu this item was ordered from (base item;
 * modifiers can add more). Unavailable when no published disclosure exists. Never an
 * allergen-free claim.
 */
export type KitchenItemAllergens =
  | {
      readonly status: "Declared";
      readonly contains: readonly string[];
      readonly mayContain: readonly string[];
      /**
       * WP-2423 ⑪: true when these are for exactly the options chosen on the item; otherwise they
       * cover every choice of the item and chosen options may add more.
       */
      readonly forChoices: boolean;
      /**
       * WP-2423 (M77, M167): a recipe bound or ended since the menu was listed changed what the
       * dish contains; the names above include what it adds. Absent otherwise.
       */
      readonly changedSinceListed?: true;
    }
  | { readonly status: "Unavailable" };

export interface KitchenOrderLabel {
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly tableLabel: string | null;
  /** WP-2423 Q7 slice 2: staff entered this order or table round for the guests. */
  readonly enteredByStaff?: boolean;
  /** WP-2423 item 8 ⑧: the table the party was moved from (null or absent: not moved). */
  readonly movedFromTableLabel?: string | null;
  /** WP-2423 item 8 ⑨: the table the party was merged from (null or absent: not merged). */
  readonly mergedFromTableLabel?: string | null;
  /** WP-2423 (M171): the allergens staff marked for this table (absent: none marked). */
  readonly tableAllergies?: readonly { readonly code: string; readonly name: string }[];
}

export interface KitchenBoardItem {
  readonly workItemReference: string;
  readonly ticketReference: string;
  readonly orderReference: string;
  readonly stationLabel: string | null;
  readonly displayName: string;
  /** WP-2423 item 8 ③ (decision 8): the English name under a Chinese one, when it has both. */
  readonly otherName?: string;
  /** WP-2423 item 8 ⑥ part 4: a combo's chosen dishes, each made and marked done on its own. */
  readonly comboParts?: readonly ComboPartView[];
  /**
   * Combos by section: each chosen dish's kitchen section by its option, by the dish's own mark now
   * (null: no section). Beside `comboParts`, so a tablet on an older page keeps reading the board.
   */
  readonly comboPartSections?: Readonly<Record<string, string | null>>;
  /**
   * Combos by section: this line of a section's screen is one chosen dish of a combo. It keeps the
   * work item's real status; the dish's own state is here. Never read from the server.
   */
  readonly comboPartOf?: KitchenComboDishLine;
  /** WP-2423 item 8 ⑦: a server chased this dish (how often, and when last). */
  readonly chase?: { readonly count: number; readonly lastChasedAt: string };
  /** Owner 2026-11-03: entered after an outage from a paper slip: it may already be made. */
  readonly takenOnPaper?: boolean;
  /** WP-2423 (M93): the dish contains alcohol; check ID (19+) when serving it. */
  readonly checkId?: boolean;
  /**
   * WP-2423 M10: units of this dish staff refunded and said not to make (1..requiredQuantity);
   * absent when none.
   */
  readonly refundedQuantity?: number;
  /**
   * WP-2423 item 8 ⑧ (decision 5): the dish's kitchen section (档口); null: no section. Absent from
   * older servers (no section filter then).
   */
  readonly kitchenSection?: string | null;
  readonly status: KitchenStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
  readonly createdAt: string;
  /**
   * merchant-outage-recovery M120: when the guest or staff sent the item's round (absent from an
   * older server, or unknown). The wait counts from here, not from acceptance.
   */
  readonly placedAt?: string;
  readonly allergenCue: "None" | "ReviewRequired" | "Acknowledged" | "Unavailable";
  readonly exceptionStatus: "None" | "Reported" | "Unavailable";
  readonly selectedOptions: readonly KitchenSelectedOption[];
  /** WP-2423 Q3: omitted by older sources; shown as unavailable. */
  readonly allergens?: KitchenItemAllergens;
  /** WP-2423 Q2: how the kitchen names the Order; null when the Order cannot be read. */
  readonly orderLabel?: KitchenOrderLabel | null;
  /** WP-2423 Q2 (DEC-KDS-CUSTOMER-NOTE): Restricted; shown verbatim, never stored or logged. */
  readonly customerNote?: string | null;
  /**
   * DEC-KITCHEN-STALE-TICKETS: the Order's business day (order numbers restart every day). Omitted
   * by older sources; null when unknown.
   */
  readonly businessDate?: string | null;
  readonly execution?: {
    readonly orderItemReference: string;
    readonly stationReference: string;
    readonly ticketVersion: string;
    readonly workItemVersion: string;
    readonly acceptedAt: string | null;
    readonly readyAt: string | null;
  };
}

export interface KitchenComboDishLine {
  readonly comboName: string;
  readonly optionReference: string;
  readonly done: boolean;
  /** The combo's other dishes still to make. */
  readonly stillToMake: readonly string[];
}

export interface KitchenBoardView {
  readonly screenId: "KIT-KITCHEN-QUEUE";
  readonly projectionName: "kitchen_work_queue_v1";
  readonly projectionVersion: 1;
  readonly storeLabel: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly operatorStatus: "Named" | "Locked" | "HandoverRequired" | "Unavailable" | "Unverified";
  readonly items: readonly KitchenBoardItem[];
  /** DEC-KITCHEN-STALE-TICKETS: this staff member may close an earlier business day's ticket. */
  readonly canCloseEarlierDayTickets?: boolean;
  /**
   * WP-2423 (v15 2026-10-16): today's paid orders still waiting for acceptance (no kitchen work
   * yet), so the order search can say so. Omitted by older servers; null when not read.
   */
  readonly awaitingAcceptance?: readonly KitchenAwaitingLabel[] | null;
  /** WP-2423 item 8 ⑧: the Store's kitchen sections, in its order (omitted: not read). */
  readonly kitchenSections?: readonly string[];
  /** DEC-PAID-ORDER-AUTO-ACCEPT: only at a Store that sends paid orders straight here. */
  readonly paidOrderWatch?: PaidOrderWatch | null;
  /**
   * DEC-KITCHEN-ONE-TAP: open work this board could not carry (it shows the oldest): how many
   * tickets when the server knows, true when only that some were left out. Omitted: none.
   */
  readonly moreWaiting?: number | true;
}
/** A paid order not accepted yet; a pickup carries when it is refunded unless someone accepts it. */
export interface KitchenAwaitingLabel extends KitchenOrderLabel {
  /** Warn before timeouts (WP-2423 2026-10-17); null or absent when no refund deadline runs. */
  readonly acceptBy?: string | null;
  /** DEC-PAID-ORDER-AUTO-ACCEPT: why it was not sent automatically (absent: it does not apply). */
  readonly notSent?: { readonly reason: string; readonly itemCount: number | null };
  /** WP-2423 M04: staff accepted it; it has not reached the kitchen yet (absent: not so). */
  readonly acceptedNotInKitchen?: true;
}

export interface KitchenWorkItemDetailView {
  readonly screenId: "KIT-WORK-ITEM";
  readonly projectionName: "kitchen_work_queue_v1";
  readonly projectionVersion: 1;
  readonly storeLabel: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly operatorStatus: KitchenBoardView["operatorStatus"];
  readonly item: KitchenBoardItem;
}

export interface KitchenBoardClient {
  loadQueue(search?: KitchenQueueSearch): Promise<unknown>;
  loadWorkItem(reference: string): Promise<unknown>;
}

export interface KitchenQueueSearch {
  readonly kind: "Order" | "Ticket";
  readonly reference: string;
}

export class KitchenBoardClientError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Offline"
      | "Conflict"
      | "CommandFailed"
      | "Unavailable"
      | "ServerProblem",
  ) {
    super(t("Kitchen Board is unavailable"));
    this.name = "KitchenBoardClientError";
  }
}

/** DEC-KITCHEN-ONE-TAP: what one board read carries; open work past it is said, never a failure. */
export const kitchenBoardMaxItems = 300;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]{1,100}$/u;

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("KITCHEN_BOARD_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function parseKitchenRouteReference(value: unknown): string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !INSTANT.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}

function selectedOption(value: unknown): KitchenSelectedOption {
  const input = closed(value, ["displayName", "quantity"]);
  if (
    typeof input.displayName !== "string" ||
    !SAFE_TEXT.test(input.displayName) ||
    !Number.isSafeInteger(input.quantity) ||
    Number(input.quantity) < 1 ||
    Number(input.quantity) > 999
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({ displayName: input.displayName, quantity: Number(input.quantity) });
}

function selectedOptions(value: unknown): readonly KitchenSelectedOption[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze(value.map(selectedOption));
}

/** WP-2423 Q2: the Order's number and, for dine-in, its current table. */
export function parseKitchenOrderLabel(value: unknown): KitchenOrderLabel | null {
  if (value === null) return null;
  // WP-2423 Q7 slice 2: enteredByStaff; item 8 ⑧: movedFromTableLabel (older servers answered
  // without them).
  const has = (key: string) =>
    typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
  const input = closed(value, [
    "orderNumber",
    "orderType",
    "tableLabel",
    ...(has("enteredByStaff") ? ["enteredByStaff"] : []),
    ...(has("movedFromTableLabel") ? ["movedFromTableLabel"] : []),
    ...(has("mergedFromTableLabel") ? ["mergedFromTableLabel"] : []),
    ...(has("tableAllergies") ? ["tableAllergies"] : []),
  ]);
  const tableAllergies =
    input.tableAllergies === undefined
      ? undefined
      : Array.isArray(input.tableAllergies) &&
          input.tableAllergies.length >= 1 &&
          input.tableAllergies.length <= 14 &&
          input.orderType === "DineIn"
        ? Object.freeze(
            (input.tableAllergies as unknown[]).map((entry) => {
              const allergy = closed(entry, ["code", "name"]);
              if (
                typeof allergy.code !== "string" ||
                !/^[A-Z][A-Z0-9_-]{1,39}$/u.test(allergy.code) ||
                typeof allergy.name !== "string" ||
                !SAFE_TEXT.test(allergy.name)
              )
                throw new Error("KITCHEN_BOARD_INVALID");
              return Object.freeze({ code: allergy.code, name: allergy.name });
            }),
          )
        : (() => {
            throw new Error("KITCHEN_BOARD_INVALID");
          })();
  const movedFrom = input.movedFromTableLabel ?? null;
  const mergedFrom = input.mergedFromTableLabel ?? null;
  if (
    typeof input.orderNumber !== "string" ||
    !/^[A-Z0-9][A-Z0-9-]{0,39}$/u.test(input.orderNumber) ||
    (input.orderType !== "Pickup" && input.orderType !== "DineIn") ||
    (input.tableLabel !== null &&
      (input.orderType !== "DineIn" ||
        typeof input.tableLabel !== "string" ||
        !/^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(input.tableLabel))) ||
    (input.enteredByStaff !== undefined && typeof input.enteredByStaff !== "boolean") ||
    [movedFrom, mergedFrom].some(
      (label) =>
        label !== null &&
        (input.orderType !== "DineIn" ||
          typeof label !== "string" ||
          !/^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(label)),
    )
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    orderNumber: input.orderNumber,
    orderType: input.orderType,
    tableLabel: input.tableLabel as string | null,
    enteredByStaff: input.enteredByStaff === true,
    movedFromTableLabel: movedFrom as string | null,
    mergedFromTableLabel: mergedFrom as string | null,
    ...(tableAllergies === undefined ? {} : { tableAllergies }),
  });
}
/** WP-2423: an order waiting for acceptance, with a pickup's refund deadline when one runs. */
function parseKitchenAwaitingLabel(value: unknown): KitchenAwaitingLabel {
  const hasDeadline =
    value !== null && typeof value === "object" && Object.hasOwn(value, "acceptBy");
  const { acceptBy, notSent, acceptedNotInKitchen, ...rest } = (
    hasDeadline ? value : { ...(value as object), acceptBy: null }
  ) as {
    acceptBy: unknown;
    notSent?: unknown;
    acceptedNotInKitchen?: unknown;
  };
  const label = parseKitchenOrderLabel(rest);
  if (
    label === null ||
    (acceptBy !== null && label.orderType !== "Pickup") ||
    (acceptedNotInKitchen !== undefined && acceptedNotInKitchen !== true)
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const why = notSent === undefined ? null : closed(notSent, ["reason", "itemCount"]);
  if (
    why !== null &&
    (typeof why.reason !== "string" ||
      !/^[A-Za-z]{1,40}$/u.test(why.reason) ||
      (why.itemCount !== null && !Number.isSafeInteger(why.itemCount)))
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    ...label,
    ...(acceptedNotInKitchen === true ? { acceptedNotInKitchen: true as const } : {}),
    acceptBy: acceptBy === null ? null : instant(acceptBy),
    ...(why === null
      ? {}
      : {
          notSent: Object.freeze({
            reason: why.reason as string,
            itemCount: why.itemCount as number | null,
          }),
        }),
  });
}
/** WP-2423 Q2: the Customer's note, as written (bounded, no control characters). */
export function parseKitchenCustomerNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[^\p{Cc}\p{Cf}]{1,500}$/u.test(value.replace(/\n/gu, " ")))
    throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}
/** DEC-KITCHEN-STALE-TICKETS: a business date (YYYY-MM-DD) or null when unknown. */
export function parseKitchenBusinessDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return value;
}
/** WP-2423 Q3: names grouped by classification, as the API serves them. */
export function parseKitchenItemAllergens(value: unknown): KitchenItemAllergens {
  const status =
    value !== null && typeof value === "object" ? (value as { status?: unknown }).status : null;
  if (status === "Unavailable") {
    closed(value, ["status"]);
    return Object.freeze({ status: "Unavailable" });
  }
  const changed =
    value !== null && typeof value === "object" && Object.hasOwn(value, "changedSinceListed");
  const input = closed(value, [
    "status",
    "contains",
    "mayContain",
    "forChoices",
    ...(changed ? ["changedSinceListed"] : []),
  ]);
  if (typeof input.forChoices !== "boolean" || (changed && input.changedSinceListed !== true))
    throw new Error("KITCHEN_BOARD_INVALID");
  const names = (list: unknown) => {
    if (!Array.isArray(list) || list.length > 30) throw new Error("KITCHEN_BOARD_INVALID");
    return Object.freeze(
      list.map((name) => {
        if (typeof name !== "string" || !SAFE_TEXT.test(name))
          throw new Error("KITCHEN_BOARD_INVALID");
        return name;
      }),
    );
  };
  if (input.status !== "Declared") throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    status: "Declared",
    contains: names(input.contains),
    mayContain: names(input.mayContain),
    forChoices: input.forChoices,
    ...(changed ? { changedSinceListed: true as const } : {}),
  });
}

function item(value: unknown): KitchenBoardItem {
  const hasExecution =
    value !== null && typeof value === "object" && Object.hasOwn(value, "execution");
  const hasAllergens =
    value !== null && typeof value === "object" && Object.hasOwn(value, "allergens");
  const hasOrderLabel =
    value !== null && typeof value === "object" && Object.hasOwn(value, "orderLabel");
  const hasCustomerNote =
    value !== null && typeof value === "object" && Object.hasOwn(value, "customerNote");
  const hasBusinessDate =
    value !== null && typeof value === "object" && Object.hasOwn(value, "businessDate");
  const hasOtherName =
    value !== null && typeof value === "object" && Object.hasOwn(value, "otherName");
  const hasComboParts =
    value !== null && typeof value === "object" && Object.hasOwn(value, "comboParts");
  const hasChase = value !== null && typeof value === "object" && Object.hasOwn(value, "chase");
  const hasPaper =
    value !== null && typeof value === "object" && Object.hasOwn(value, "takenOnPaper");
  const hasCheckId = value !== null && typeof value === "object" && Object.hasOwn(value, "checkId");
  const hasRefunded =
    value !== null && typeof value === "object" && Object.hasOwn(value, "refundedQuantity");
  const hasSection =
    value !== null && typeof value === "object" && Object.hasOwn(value, "kitchenSection");
  const hasPartSections =
    value !== null && typeof value === "object" && Object.hasOwn(value, "comboPartSections");
  const hasPlacedAt =
    value !== null && typeof value === "object" && Object.hasOwn(value, "placedAt");
  const input = closed(value, [
    "workItemReference",
    "ticketReference",
    "orderReference",
    "stationLabel",
    "displayName",
    "status",
    "requiredQuantity",
    "completedQuantity",
    "createdAt",
    "allergenCue",
    "exceptionStatus",
    "selectedOptions",
    ...(hasAllergens ? ["allergens"] : []),
    ...(hasOrderLabel ? ["orderLabel"] : []),
    ...(hasCustomerNote ? ["customerNote"] : []),
    ...(hasBusinessDate ? ["businessDate"] : []),
    ...(hasExecution ? ["execution"] : []),
    ...(hasOtherName ? ["otherName"] : []),
    ...(hasComboParts ? ["comboParts"] : []),
    ...(hasChase ? ["chase"] : []),
    ...(hasPaper ? ["takenOnPaper"] : []),
    ...(hasCheckId ? ["checkId"] : []),
    ...(hasRefunded ? ["refundedQuantity"] : []),
    ...(hasSection ? ["kitchenSection"] : []),
    ...(hasPartSections ? ["comboPartSections"] : []),
    ...(hasPlacedAt ? ["placedAt"] : []),
  ]);
  if (
    hasSection &&
    input.kitchenSection !== null &&
    (typeof input.kitchenSection !== "string" || !SAFE_TEXT.test(input.kitchenSection))
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const chase = hasChase ? closed(input.chase, ["count", "lastChasedAt"]) : null;
  if (chase !== null && (!Number.isSafeInteger(chase.count) || Number(chase.count) < 1))
    throw new Error("KITCHEN_BOARD_INVALID");
  if (
    (input.stationLabel !== null &&
      (typeof input.stationLabel !== "string" || !SAFE_TEXT.test(input.stationLabel))) ||
    typeof input.displayName !== "string" ||
    !SAFE_TEXT.test(input.displayName) ||
    (hasOtherName && (typeof input.otherName !== "string" || !SAFE_TEXT.test(input.otherName))) ||
    !["Queued", "Held", "In Progress", "Completed", "Cancelled"].includes(String(input.status)) ||
    !["None", "ReviewRequired", "Acknowledged", "Unavailable"].includes(
      String(input.allergenCue),
    ) ||
    !["None", "Reported", "Unavailable"].includes(String(input.exceptionStatus)) ||
    !Number.isSafeInteger(input.requiredQuantity) ||
    Number(input.requiredQuantity) < 1 ||
    !Number.isSafeInteger(input.completedQuantity) ||
    Number(input.completedQuantity) < 0 ||
    Number(input.completedQuantity) > Number(input.requiredQuantity) ||
    (hasRefunded &&
      (!Number.isSafeInteger(input.refundedQuantity) ||
        Number(input.refundedQuantity) < 1 ||
        Number(input.refundedQuantity) > Number(input.requiredQuantity)))
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    workItemReference: parseKitchenRouteReference(input.workItemReference),
    ticketReference: parseKitchenRouteReference(input.ticketReference),
    orderReference: parseKitchenRouteReference(input.orderReference),
    stationLabel: input.stationLabel as string | null,
    displayName: input.displayName,
    ...(hasOtherName ? { otherName: input.otherName as string } : {}),
    ...(hasComboParts ? { comboParts: parseComboParts(input.comboParts) } : {}),
    ...(hasSection ? { kitchenSection: input.kitchenSection as string | null } : {}),
    ...(hasPartSections ? { comboPartSections: comboPartSections(input.comboPartSections) } : {}),
    ...(input.takenOnPaper === true ? { takenOnPaper: true } : {}),
    ...(hasCheckId
      ? input.checkId === true
        ? { checkId: true }
        : (() => {
            throw new Error("KITCHEN_BOARD_INVALID");
          })()
      : {}),
    ...(hasRefunded ? { refundedQuantity: Number(input.refundedQuantity) } : {}),
    ...(chase === null
      ? {}
      : {
          chase: Object.freeze({
            count: Number(chase.count),
            lastChasedAt: instant(chase.lastChasedAt),
          }),
        }),
    status: input.status as KitchenStatus,
    requiredQuantity: Number(input.requiredQuantity),
    completedQuantity: Number(input.completedQuantity),
    createdAt: instant(input.createdAt),
    ...(hasPlacedAt ? { placedAt: instant(input.placedAt) } : {}),
    allergenCue: input.allergenCue as KitchenBoardItem["allergenCue"],
    exceptionStatus: input.exceptionStatus as KitchenBoardItem["exceptionStatus"],
    selectedOptions: selectedOptions(input.selectedOptions),
    ...(hasAllergens ? { allergens: parseKitchenItemAllergens(input.allergens) } : {}),
    ...(hasOrderLabel ? { orderLabel: parseKitchenOrderLabel(input.orderLabel) } : {}),
    ...(hasCustomerNote ? { customerNote: parseKitchenCustomerNote(input.customerNote) } : {}),
    ...(hasBusinessDate ? { businessDate: parseKitchenBusinessDate(input.businessDate) } : {}),
    ...(hasExecution ? { execution: execution(input.execution) } : {}),
  });
}

/** Option → the dish's section: a closed record, at most one combo's worth of dishes. */
function comboPartSections(value: unknown): Readonly<Record<string, string | null>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length > 20
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const sections: Record<string, string | null> = {};
  for (const key of Reflect.ownKeys(value)) {
    const option = parseKitchenRouteReference(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("KITCHEN_BOARD_INVALID");
    const name: unknown = descriptor.value;
    if (name !== null && (typeof name !== "string" || !SAFE_TEXT.test(name)))
      throw new Error("KITCHEN_BOARD_INVALID");
    sections[option] = name as string | null;
  }
  return Object.freeze(sections);
}

function execution(value: unknown): NonNullable<KitchenBoardItem["execution"]> {
  const raw = closed(value, [
    "orderItemReference",
    "stationReference",
    "ticketVersion",
    "workItemVersion",
    "acceptedAt",
    "readyAt",
  ]);
  const version = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(value) ||
      BigInt(value) > 9223372036854775807n
    )
      throw new Error("KITCHEN_BOARD_INVALID");
    return value;
  };
  return Object.freeze({
    orderItemReference: parseKitchenRouteReference(raw.orderItemReference),
    stationReference: parseKitchenRouteReference(raw.stationReference),
    ticketVersion: version(raw.ticketVersion),
    workItemVersion: version(raw.workItemVersion),
    acceptedAt: raw.acceptedAt === null ? null : instant(raw.acceptedAt),
    readyAt: raw.readyAt === null ? null : instant(raw.readyAt),
  });
}

export function parseKitchenBoardView(value: unknown): KitchenBoardView {
  const hasCanClose =
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "canCloseEarlierDayTickets");
  const hasAwaiting =
    value !== null && typeof value === "object" && Object.hasOwn(value, "awaitingAcceptance");
  const hasSections =
    value !== null && typeof value === "object" && Object.hasOwn(value, "kitchenSections");
  const hasWatch =
    value !== null && typeof value === "object" && Object.hasOwn(value, "paidOrderWatch");
  const hasMoreWaiting =
    value !== null && typeof value === "object" && Object.hasOwn(value, "moreWaiting");
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "storeLabel",
    "projectedAt",
    "freshnessStatus",
    "operatorStatus",
    "items",
    ...(hasCanClose ? ["canCloseEarlierDayTickets"] : []),
    ...(hasAwaiting ? ["awaitingAcceptance"] : []),
    ...(hasSections ? ["kitchenSections"] : []),
    ...(hasWatch ? ["paidOrderWatch"] : []),
    ...(hasMoreWaiting ? ["moreWaiting"] : []),
  ]);
  if (
    hasMoreWaiting &&
    input.moreWaiting !== true &&
    (!Number.isSafeInteger(input.moreWaiting) || Number(input.moreWaiting) < 1)
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  if (
    hasSections &&
    (!Array.isArray(input.kitchenSections) ||
      input.kitchenSections.length > 12 ||
      input.kitchenSections.some((name) => typeof name !== "string" || !SAFE_TEXT.test(name)) ||
      new Set(input.kitchenSections).size !== input.kitchenSections.length)
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  if (hasCanClose && typeof input.canCloseEarlierDayTickets !== "boolean")
    throw new Error("KITCHEN_BOARD_INVALID");
  if (
    hasAwaiting &&
    input.awaitingAcceptance !== null &&
    (!Array.isArray(input.awaitingAcceptance) || input.awaitingAcceptance.length > 200)
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const awaiting =
    !hasAwaiting || input.awaitingAcceptance === null
      ? null
      : Object.freeze(
          (input.awaitingAcceptance as readonly unknown[]).map(parseKitchenAwaitingLabel),
        );
  if (
    input.screenId !== "KIT-KITCHEN-QUEUE" ||
    input.projectionName !== "kitchen_work_queue_v1" ||
    input.projectionVersion !== 1 ||
    typeof input.storeLabel !== "string" ||
    !SAFE_TEXT.test(input.storeLabel) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    !["Named", "Locked", "HandoverRequired", "Unavailable", "Unverified"].includes(
      String(input.operatorStatus),
    ) ||
    !Array.isArray(input.items) ||
    input.items.length > kitchenBoardMaxItems
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  const items = Object.freeze(input.items.map(item));
  if (new Set(items.map((entry) => entry.workItemReference)).size !== items.length)
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    screenId: "KIT-KITCHEN-QUEUE",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    storeLabel: input.storeLabel,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as KitchenBoardView["freshnessStatus"],
    operatorStatus: input.operatorStatus as KitchenBoardView["operatorStatus"],
    items,
    ...(hasCanClose
      ? { canCloseEarlierDayTickets: input.canCloseEarlierDayTickets as boolean }
      : {}),
    ...(hasAwaiting ? { awaitingAcceptance: awaiting } : {}),
    ...(hasSections
      ? { kitchenSections: Object.freeze([...(input.kitchenSections as string[])]) }
      : {}),
    ...(hasWatch ? { paidOrderWatch: parsePaidOrderWatch(input.paidOrderWatch) } : {}),
    ...(hasMoreWaiting ? { moreWaiting: input.moreWaiting as number | true } : {}),
  });
}

export function parseKitchenWorkItemView(value: unknown): KitchenBoardItem {
  return item(value);
}

export function parseKitchenWorkItemDetailView(value: unknown): KitchenWorkItemDetailView {
  const input = closed(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "storeLabel",
    "projectedAt",
    "freshnessStatus",
    "operatorStatus",
    "item",
  ]);
  if (
    input.screenId !== "KIT-WORK-ITEM" ||
    input.projectionName !== "kitchen_work_queue_v1" ||
    input.projectionVersion !== 1 ||
    typeof input.storeLabel !== "string" ||
    !SAFE_TEXT.test(input.storeLabel) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    !["Named", "Locked", "HandoverRequired", "Unavailable", "Unverified"].includes(
      String(input.operatorStatus),
    )
  )
    throw new Error("KITCHEN_BOARD_INVALID");
  return Object.freeze({
    screenId: "KIT-WORK-ITEM",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    storeLabel: input.storeLabel,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as KitchenWorkItemDetailView["freshnessStatus"],
    operatorStatus: input.operatorStatus as KitchenWorkItemDetailView["operatorStatus"],
    item: item(input.item),
  });
}

export const unavailableKitchenBoardClient: KitchenBoardClient = Object.freeze({
  loadQueue: () => Promise.reject(new KitchenBoardClientError("Unavailable")),
  loadWorkItem: () => Promise.reject(new KitchenBoardClientError("Unavailable")),
});

/**
 * WP-2423 Q2: how a ticket names its Order, where it goes first ("Table T4 · Order 14",
 * "Pickup · Order 5"): order numbers restart each business day and a table opened on an earlier
 * day keeps its number, so two tickets can share a number; the destination tells them apart.
 * Never a Customer's name.
 */
export function kitchenOrderText(
  label: Pick<KitchenOrderLabel, "orderNumber" | "orderType" | "tableLabel"> | null | undefined,
): string {
  if (!label) return t("Order details unavailable");
  return (
    (label.orderType === "Pickup"
      ? t("Pickup")
      : label.tableLabel
        ? t("Table {tableLabel}", { tableLabel: saidTable(label.tableLabel) })
        : t("Dine-in")) +
    t(" · Order ") +
    label.orderNumber
  );
}

/**
 * merchant-outage-recovery M120: when an item's wait started: when its round was sent, or (an
 * older server, a remake) when the kitchen received it.
 */
export function kitchenWaitStart(item: Pick<KitchenBoardItem, "createdAt" | "placedAt">): string {
  return item.placedAt !== undefined && item.placedAt < item.createdAt
    ? item.placedAt
    : item.createdAt;
}

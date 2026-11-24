import type { CustomerTableWaitAnswer } from "../entry/types.js";
import { forgetTableWait, keepTableWait, readKeptTableWait } from "./table-wait-tab.js";
const csrfContextListeners = new Set<() => void>();
let csrfContext = Symbol();
let csrfCredential: string | null = null;
let paymentOperationReference: string | null = null;
let checkoutSessionReference: string | null = null;
export interface CheckoutTipSelection {
  readonly checkoutSessionReference: string;
  readonly selectionReference: string;
  readonly amountMinor: string;
}
let checkoutTipSelection: CheckoutTipSelection | null = null;

/**
 * WP-2423 (v15 3cd0f8dd M5): a visit on this device ended (its table closed, or it sat idle) after
 * it placed an order. The guest can still open that order's receipt — read only — until
 * `receiptAvailableUntil`; nothing else uses this credential. Held in memory only.
 */
export interface EndedVisitReceiptAccess {
  readonly csrfToken: string;
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly receiptAvailableUntil: string;
}
let endedVisitReceipt: EndedVisitReceiptAccess | null = null;

export function setEndedVisitReceiptAccess(value: EndedVisitReceiptAccess | null): void {
  endedVisitReceipt = value === null ? null : Object.freeze({ ...value });
}

/** The ended visit's receipt access for this order, while it lasts (else null). */
export function getEndedVisitReceiptAccess(
  orderReference: string,
  now: number = Date.now(),
): EndedVisitReceiptAccess | null {
  return endedVisitReceipt !== null &&
    endedVisitReceipt.orderReference === orderReference &&
    now < Date.parse(endedVisitReceipt.receiptAvailableUntil)
    ? endedVisitReceipt
    : null;
}

/**
 * v15 2026-10-30: staff moved this device's party to another table after it joined; the label of
 * the table it sits at now (the guest scans that table's code to join it again). Memory only.
 */
let movedTableLabel: string | null = null;

/**
 * M126 I.2: why this phone's place at its table ended, as the Store last said (left or removed,
 * the table's visit closed, the party's table changed). Memory only; cleared with a new visit.
 */
export type ParticipationEndedReason = "Left" | "TableClosed" | "Changed";
let participationEnded: ParticipationEndedReason | null = null;

export function setParticipationEnded(value: ParticipationEndedReason | null): void {
  participationEnded = value;
}

export function getParticipationEnded(): ParticipationEndedReason | null {
  return participationEnded;
}
/** WP-2423 item 8 ⑨: staff merged the party into the party at that table (not just moved it). */
let movedTableMerged = false;
type RestoredStore = Readonly<{ brandDisplayName: string; storeDisplayName: string }>;
/** Batch 45 (v15 b44 live): the moved party's Store, when the restore named it (the header). */
let movedTableStore: RestoredStore | null = null;
/** Batch 46 (v15 b45 live): the moved or merged party had ordered nothing at its own table. */
let movedTableNothingOrdered = false;

export function setMovedTableLabel(
  value: string | null,
  merged = false,
  store: RestoredStore | null = null,
  nothingOrdered = false,
): void {
  movedTableLabel = value;
  movedTableMerged = value !== null && merged;
  movedTableStore = value === null || store === null ? null : Object.freeze({ ...store });
  movedTableNothingOrdered = value !== null && nothingOrdered;
}

export function getMovedTableNothingOrdered(): boolean {
  return movedTableNothingOrdered;
}

export function getMovedTableMerged(): boolean {
  return movedTableMerged;
}

export function getMovedTableLabel(): string | null {
  return movedTableLabel;
}

/**
 * Coordinator 2026-10-30 (Owner authorized): the table this device's guest sat at when it was
 * closed and its bill settled, and the ended visit's CSRF value that reads that table's receipt
 * (read only); the dine-in page thanks them instead of asking them to join. Memory only.
 */
/**
 * Batch 44 (v15 b43 live): the Store's and brand's names come with it (a newer server), so the
 * page's header names the Store after a reload, not "scan the code to begin".
 */
interface SettledTable {
  readonly tableLabel: string;
  readonly csrfToken: string;
  readonly store?: Readonly<{ brandDisplayName: string; storeDisplayName: string }>;
}
let settledTable: SettledTable | null = null;

export function setSettledTable(value: SettledTable | null): void {
  settledTable =
    value === null
      ? null
      : Object.freeze({
          ...value,
          ...(value.store === undefined ? {} : { store: Object.freeze({ ...value.store }) }),
        });
}

/** The settled table's Store (its names only), when the restore said which it is. */
export function getSettledTableStore(): SettledTable["store"] | null {
  return settledTable?.store ?? null;
}

/**
 * Batch 45 (v15 b44 live): staff closed this device's table with nothing ordered (nothing was
 * charged, there is no receipt). Its label and Store only; nothing to act with. Memory only.
 */
interface EmptyTable {
  readonly tableLabel: string;
  readonly store?: RestoredStore;
  /**
   * Batch 55 review (v15 b54): staff closed the bill when the guests left, after nothing or some
   * of it was paid. Such a bill has no receipt either. Absent: nothing was ordered.
   */
  readonly closedByStaff?: ClosedBillPaid;
  /**
   * Batch 56 (v15 b55 live): this phone paid part of that bill: how much (minor units, on this
   * phone) and the ended visit's read-only value for its own payment's receipt. Absent: it paid
   * nothing there.
   */
  readonly yourPayment?: { readonly amountMinor: string; readonly csrfToken: string };
}
/** What was paid on a bill staff closed when the guests left. */
export type ClosedBillPaid = "Nothing" | "Some";
let emptyTable: EmptyTable | null = null;

export function setEmptyTable(value: EmptyTable | null): void {
  emptyTable =
    value === null
      ? null
      : Object.freeze({
          tableLabel: value.tableLabel,
          ...(value.store === undefined ? {} : { store: Object.freeze({ ...value.store }) }),
          ...(value.closedByStaff === undefined ? {} : { closedByStaff: value.closedByStaff }),
          ...(value.yourPayment === undefined
            ? {}
            : { yourPayment: Object.freeze({ ...value.yourPayment }) }),
        });
}

/** Batch 56: the ended visit's value for this phone's own payment's receipt (null: none). */
export function getClosedTableOwnReceiptCsrf(): string | null {
  return emptyTable?.yourPayment?.csrfToken ?? null;
}

export function getEmptyTableLabel(): string | null {
  return emptyTable?.tableLabel ?? null;
}

/** Batch 55 review: the ended table's bill was closed by staff (what was paid), else null. */
export function getEmptyTableClosedByStaff(): ClosedBillPaid | null {
  return emptyTable?.closedByStaff ?? null;
}

/** Batch 45: the Store of the table this device's visit ended at (settled, empty or moved). */
export function getEndedTableStore(): RestoredStore | null {
  return settledTable?.store ?? emptyTable?.store ?? movedTableStore;
}

/**
 * Batch 46 (v15 b45 live): how this phone's table visit ended, as the restore said: one answer
 * for every guest tab (Menu, Cart, Your table, a dish page), so none falls back to "scan the
 * code to begin" or "your visit ended" with a refresh button. Null while a visit goes on.
 */
export type EndedTable = Readonly<
  | { kind: "Settled"; tableLabel: string; store: RestoredStore | null }
  | { kind: "Empty"; tableLabel: string; store: RestoredStore | null }
  /** Batch 55 review: staff closed the bill when the guests left; there is no receipt. */
  | {
      kind: "ClosedByStaff";
      tableLabel: string;
      paid: ClosedBillPaid;
      store: RestoredStore | null;
      /** Batch 56: what this phone paid on that bill (minor units); null or absent: nothing. */
      yourPaidMinor?: string | null;
    }
  | {
      kind: "Moved";
      tableLabel: string;
      merged: boolean;
      nothingOrdered: boolean;
      store: RestoredStore | null;
    }
>;

export function getEndedTable(): EndedTable | null {
  if (csrfCredential !== null) return null;
  if (movedTableLabel !== null)
    return Object.freeze({
      kind: "Moved",
      tableLabel: movedTableLabel,
      merged: movedTableMerged,
      nothingOrdered: movedTableNothingOrdered,
      store: movedTableStore,
    });
  if (settledTable !== null)
    return Object.freeze({
      kind: "Settled",
      tableLabel: settledTable.tableLabel,
      store: settledTable.store ?? null,
    });
  if (emptyTable?.closedByStaff !== undefined)
    return Object.freeze({
      kind: "ClosedByStaff",
      tableLabel: emptyTable.tableLabel,
      paid: emptyTable.closedByStaff,
      store: emptyTable.store ?? null,
      ...(emptyTable.yourPayment === undefined
        ? {}
        : { yourPaidMinor: emptyTable.yourPayment.amountMinor }),
    });
  if (emptyTable !== null)
    return Object.freeze({
      kind: "Empty",
      tableLabel: emptyTable.tableLabel,
      store: emptyTable.store ?? null,
    });
  return null;
}

export function getSettledTableLabel(): string | null {
  return settledTable?.tableLabel ?? null;
}

export function getSettledTableReceiptCsrf(): string | null {
  return settledTable?.csrfToken ?? null;
}

/**
 * Coordinator 2026-10-30: this device scanned a table no party is seated at; no visit was started
 * (ordering waits until staff seat the party and the code is scanned again). Memory only.
 */
let unseatedTableScan = false;

export function setUnseatedTableScan(value: boolean): void {
  unseatedTableScan = value;
}

export function isUnseatedTableScan(): boolean {
  return unseatedTableScan;
}

/**
 * Batch 42 (v15 b41 live): this phone scanned a table staff have not opened yet (or one being
 * cleaned) and its start page says so. The other tabs (Menu, Cart, Your table) say the same and
 * offer the way back, instead of asking for a join code nobody hands out. `check` is the scan's
 * cheap "is it open now?"; a page that waits uses it to go on by itself. Memory only.
 */
export interface UnseatedTableWait {
  readonly kind: "NotOpen" | "BeingCleaned";
  readonly storeDisplayName: string;
  readonly tableLabel: string | null;
  readonly check: (() => Promise<CustomerTableWaitAnswer>) | null;
  /**
   * Batch 43: the rest of the Store's public context (its header and menu), so the wait is kept in
   * this tab across a reload (session/table-wait-tab.ts). Without it the wait is memory only.
   */
  readonly context?: Readonly<{
    publicStoreReference: string;
    brandDisplayName: string;
    locale: string;
  }>;
}
let unseatedTableWait: UnseatedTableWait | null = null;

/** Batch 43: kept in this tab too (never its check, code or token); null forgets it there. */
export function setUnseatedTableWait(value: UnseatedTableWait | null): void {
  unseatedTableWait = value === null ? null : Object.freeze({ ...value });
  keepUnseatedTableWait();
}

/** The table still isn't open: the kept wait lasts as long as the checks from now would. */
export function keepUnseatedTableWait(): void {
  const wait = unseatedTableWait;
  if (wait?.context === undefined) {
    forgetTableWait();
    return;
  }
  keepTableWait({
    kind: wait.kind,
    tableLabel: wait.tableLabel,
    storeDisplayName: wait.storeDisplayName,
    ...wait.context,
  });
}

/**
 * Batch 43: a reload (or a tab the phone discarded) of a page other than the start page, with no
 * visit: the wait this tab kept, checked with `check` (this browser's waiting scan). Returns the
 * Store's public context for the header and the menu, or null when nothing is kept.
 */
export function restoreUnseatedTableWait(
  check: (() => Promise<CustomerTableWaitAnswer>) | null,
): Readonly<{
  publicStoreReference: string;
  channel: "DineIn";
  locale: string;
  brandDisplayName: string;
  storeDisplayName: string;
}> | null {
  if (csrfCredential !== null) {
    forgetTableWait();
    return null;
  }
  const kept = readKeptTableWait();
  if (kept === null) return null;
  unseatedTableScan = true;
  unseatedTableWait = Object.freeze({
    kind: kept.kind,
    storeDisplayName: kept.storeDisplayName,
    tableLabel: kept.tableLabel,
    check: kept.kind === "NotOpen" ? check : null,
    context: Object.freeze({
      publicStoreReference: kept.publicStoreReference,
      brandDisplayName: kept.brandDisplayName,
      locale: kept.locale,
    }),
  });
  return Object.freeze({
    publicStoreReference: kept.publicStoreReference,
    channel: "DineIn" as const,
    locale: kept.locale,
    brandDisplayName: kept.brandDisplayName,
    storeDisplayName: kept.storeDisplayName,
  });
}

/** The waiting scan can't be asked about any more: a reload no longer waits for it. */
export function forgetKeptUnseatedTableWait(): void {
  forgetTableWait();
}

export function getUnseatedTableWait(): UnseatedTableWait | null {
  return unseatedTableWait;
}

/**
 * Staff opened the table while the guest was on another tab: the start page asks the scan again at
 * once (not its earlier "not open yet" answer), so it shows the join straight away. Memory only.
 */
let tableOpenedWhileAway = false;

export function setTableOpenedWhileAway(value: boolean): void {
  tableOpenedWhileAway = value;
}

export function isTableOpenedWhileAway(): boolean {
  return tableOpenedWhileAway;
}

/**
 * Batch 44 (v15 b43 verify): the guest tapped Add on a dish while waiting, and the check said
 * staff had just opened the table. The start page offers the join and says this dish wasn't added
 * yet (its name only, as on the menu). Memory only; cleared once the start page has said it.
 */
let dishNotAddedYet: string | null = null;

export function setDishNotAddedYet(name: string | null): void {
  dishNotAddedYet = name;
}

export function getDishNotAddedYet(): string | null {
  return dishNotAddedYet;
}

/**
 * WP-2423 DEC-DINING-GUEST-TABLE-START: this scan offered to start a free table. A guest's tap on Add
 * on the menu runs this, which starts and joins the table, so the dish they configured is kept.
 * Refused: why, in the guest's terms. Memory only; a link preview never reaches it.
 */
export type GuestTableStartAnswer =
  | "Started"
  | "Refused"
  /** People are at this table now: the start page asks whether this phone is with them. */
  | "InUse";
let guestTableStarter: (() => Promise<GuestTableStartAnswer>) | null = null;

export function setGuestTableStarter(value: (() => Promise<GuestTableStartAnswer>) | null): void {
  guestTableStarter = value;
}

export function getGuestTableStarter(): (() => Promise<GuestTableStartAnswer>) | null {
  return guestTableStarter;
}

/**
 * WP-2423 M115: this phone is looking at the menu of an open table it may join by its QR code but
 * has not joined. A guest's tap on Add runs this, which joins the table (the same QR join as the
 * entry page's), so the dish they configured goes in. Answers as the starter does ("Started" =
 * joined). Memory only: after a reload the menu sends the guest to the table's page to join.
 */
let guestTableJoiner: (() => Promise<GuestTableStartAnswer>) | null = null;

export function setGuestTableJoiner(value: (() => Promise<GuestTableStartAnswer>) | null): void {
  guestTableJoiner = value;
}

export function getGuestTableJoiner(): (() => Promise<GuestTableStartAnswer>) | null {
  return guestTableJoiner;
}

/**
 * This scan asked whether this phone is with the people at the table, and nobody has answered: the
 * menu sends the guest back to that question rather than to staff. Memory only.
 */
let guestTableQuestion = false;

export function setGuestTableQuestion(value: boolean): void {
  guestTableQuestion = value;
}

export function isGuestTableQuestion(): boolean {
  return guestTableQuestion;
}

/** This phone said it isn't with the people at the table; the next QR join says so. Memory only. */
let newPartyJoin = false;

export function setNewPartyJoin(value: boolean): void {
  newPartyJoin = value;
}

export function isNewPartyJoin(): boolean {
  return newPartyJoin;
}

/**
 * WP-2423 item 2: a card form (or the simulated one) was offered in this tab since it loaded. No money
 * moves before a guest submits that form, so until then a page may say a failed start charged nothing;
 * afterwards it may not, because the card could still be confirming. It stays set when the credential
 * is replaced, which is exactly when a page ends a payment and says what it knows, and it dies with the
 * page's memory on a reload (which lands on the result page). Never sent anywhere.
 */
let checkoutCardOffered = false;

export function markCheckoutCardOffered(): void {
  checkoutCardOffered = true;
}

export function wasCheckoutCardOffered(): boolean {
  return checkoutCardOffered;
}

/**
 * Guest payment state: a card (or the simulated one) was submitted in this tab since it loaded. Until
 * then nobody in this tab could have paid, so a payment whose time ran out while its card form was
 * open can be said to have charged nothing while the Store cancels it. Memory only, never sent.
 */
let checkoutCardSubmitted = false;

export function markCheckoutCardSubmitted(): void {
  checkoutCardSubmitted = true;
}

export function wasCheckoutCardSubmitted(): boolean {
  return checkoutCardSubmitted;
}

/**
 * WP-2423 item 6 (DEC-DINE-IN-PAY-LATER): how this table pays, as last read. A table's timing is fixed
 * when it opens, so it stays good for the visit; memory only, cleared with the credential.
 */
export type TablePaymentTiming = "PayFirst" | "PayLater";
let tablePaymentTiming: TablePaymentTiming | null = null;

export function setTablePaymentTiming(value: TablePaymentTiming | null): void {
  tablePaymentTiming = value;
}

export function getTablePaymentTiming(): TablePaymentTiming | null {
  return tablePaymentTiming;
}

/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): this page asked the Store for its visit
 * and got no answer it could use (busy, no connection in time, a network failure), so it does not
 * know whether the visit goes on. Not knowing is never "your session ended": an action that needs
 * the visit says the system is busy, and the visit is asked for again. Memory only; cleared once
 * the Store answers (a visit restored, or none to restore).
 */
let sessionRestoreUnavailable = false;

export function setCustomerSessionRestoreUnavailable(value: boolean): void {
  sessionRestoreUnavailable = value;
}

export function isCustomerSessionRestoreUnavailable(): boolean {
  return sessionRestoreUnavailable && csrfCredential === null;
}

export function setCustomerCsrfCredential(value: string | null): void {
  csrfContext = Symbol();
  csrfCredential = value;
  if (value !== null) sessionRestoreUnavailable = false;
  tablePaymentTiming = null;
  // A new visit replaces the ended one on this device (its cookie replaces the old Session).
  if (value !== null) {
    endedVisitReceipt = null;
    movedTableLabel = null;
    movedTableStore = null;
    movedTableNothingOrdered = false;
    participationEnded = null;
    settledTable = null;
    emptyTable = null;
    unseatedTableScan = false;
    // Batch 43: once this phone has a visit, a reload never waits for the table again.
    unseatedTableWait = null;
    forgetTableWait();
    guestTableStarter = null;
    guestTableQuestion = false;
  }
  paymentOperationReference = null;
  checkoutSessionReference = null;
  checkoutTipSelection = null;
  for (const listener of csrfContextListeners) {
    try {
      listener();
    } catch {
      /* Credential replacement must complete for every subscriber. */
    }
  }
}

export function subscribeCustomerCsrfContext(listener: () => void): () => void {
  csrfContextListeners.add(listener);
  return () => {
    csrfContextListeners.delete(listener);
  };
}

/** A private foreground lease; callers can only test whether their context is still current. */
export function captureCustomerCsrfContext(): () => boolean {
  const captured = csrfContext;
  return () => captured === csrfContext;
}

export function getCustomerCsrfCredential(): string | null {
  return csrfCredential;
}

export function setPaymentOperationReference(value: string | null): void {
  paymentOperationReference = value;
}

export function getPaymentOperationReference(): string | null {
  return paymentOperationReference;
}

export function setCheckoutSessionReference(value: string | null): void {
  if (
    value !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    throw new Error("invalid checkout session reference");
  if (checkoutSessionReference !== value) checkoutTipSelection = null;
  checkoutSessionReference = value;
}
export function getCheckoutSessionReference(): string | null {
  return csrfCredential === null ? null : checkoutSessionReference;
}

export function setCheckoutTipSelection(value: CheckoutTipSelection): void {
  if (
    getCheckoutSessionReference() !== value.checkoutSessionReference ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.selectionReference,
    ) ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value.amountMinor) ||
    BigInt(value.amountMinor) > 9223372036854775807n
  )
    throw new Error("invalid checkout tip selection");
  if (
    checkoutTipSelection !== null &&
    (checkoutTipSelection.selectionReference !== value.selectionReference ||
      checkoutTipSelection.amountMinor !== value.amountMinor)
  )
    throw new Error("checkout tip selection is already fixed");
  checkoutTipSelection = Object.freeze({ ...value });
}
export function getCheckoutTipSelection(): CheckoutTipSelection | null {
  return getCheckoutSessionReference() === checkoutTipSelection?.checkoutSessionReference
    ? checkoutTipSelection
    : null;
}

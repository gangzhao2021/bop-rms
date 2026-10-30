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
/** WP-2423 item 8 ⑨: staff merged the party into the party at that table (not just moved it). */
let movedTableMerged = false;

export function setMovedTableLabel(value: string | null, merged = false): void {
  movedTableLabel = value;
  movedTableMerged = value !== null && merged;
}

export function getMovedTableMerged(): boolean {
  return movedTableMerged;
}

export function getMovedTableLabel(): string | null {
  return movedTableLabel;
}

/**
 * Coordinator 2026-10-30 (Owner authorized): the table this device's guest sat at when it was
 * closed and its bill settled; the dine-in page thanks them instead of asking them to join.
 * Memory only.
 */
let settledTableLabel: string | null = null;

export function setSettledTableLabel(value: string | null): void {
  settledTableLabel = value;
}

export function getSettledTableLabel(): string | null {
  return settledTableLabel;
}

/** The order this device's ended dine-in visit placed (its receipt is readable), else null. */
export function getEndedDineInOrderReference(now: number = Date.now()): string | null {
  return endedVisitReceipt !== null &&
    endedVisitReceipt.orderType === "DineIn" &&
    now < Date.parse(endedVisitReceipt.receiptAvailableUntil)
    ? endedVisitReceipt.orderReference
    : null;
}

export function setCustomerCsrfCredential(value: string | null): void {
  csrfContext = Symbol();
  csrfCredential = value;
  // A new visit replaces the ended one on this device (its cookie replaces the old Session).
  if (value !== null) {
    endedVisitReceipt = null;
    movedTableLabel = null;
    settledTableLabel = null;
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

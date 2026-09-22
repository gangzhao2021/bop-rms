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

export function setCustomerCsrfCredential(value: string | null): void {
  csrfContext = Symbol();
  csrfCredential = value;
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

let csrfContext = Symbol();
let csrfCredential: string | null = null;
let paymentOperationReference: string | null = null;

export function setCustomerCsrfCredential(value: string | null): void {
  csrfContext = Symbol();
  csrfCredential = value;
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

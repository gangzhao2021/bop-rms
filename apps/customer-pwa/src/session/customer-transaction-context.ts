let csrfCredential: string | null = null;
let paymentOperationReference: string | null = null;

export function setCustomerCsrfCredential(value: string | null): void {
  csrfCredential = value;
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

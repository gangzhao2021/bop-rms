let csrfCredential: string | null = null;

export function setCustomerCsrfCredential(value: string | null): void {
  csrfCredential = value;
}

export function getCustomerCsrfCredential(): string | null {
  return csrfCredential;
}

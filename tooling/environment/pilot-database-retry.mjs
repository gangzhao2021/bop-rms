/** Only pre-transaction acquisition failure is eligible; never replay arbitrary transaction errors. */
export function isRetryablePilotDatabaseAcquisition(error) {
  try {
    return (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "TENANT_DATABASE_ACQUIRE_FAILED"
    );
  } catch {
    return false;
  }
}

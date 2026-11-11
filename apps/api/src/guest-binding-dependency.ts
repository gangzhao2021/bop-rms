/**
 * WP-2423 (outage-reads-and-retry, v15 2026-11-11): a guest's place is checked against the
 * Store's records (the QR, the Store, the table) on every cart read. When those records can't be
 * read — no free database connection in a rush, a statement cut off — that says nothing about the
 * guest. It is thrown as a dependency failure (`dependencyFailure: true`, as the Guest Session
 * store's own failures are), so the phone is told "busy, try again" and keeps its cart, never
 * "your session ended". Only what the records really say ("not this Store", "QR revoked") is an
 * answer of `Unavailable`/null.
 */
export function guestBindingSourceUnavailable(cause: unknown): Error {
  return Object.assign(new Error("GUEST_BINDING_SOURCE_UNAVAILABLE"), {
    dependencyFailure: true as const,
    cause,
  });
}

export function isGuestDependencyFailure(error: unknown): boolean {
  return (error as { dependencyFailure?: unknown } | null)?.dependencyFailure === true;
}

/**
 * The owners' readers write a failed query over with null. A failed statement leaves the
 * PostgreSQL transaction unable to answer, so a null answer is checked against the transaction
 * itself before it is believed (as persistent-entry-operating does for entry).
 */
export async function confirmTransactionAnswered(transaction: {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}): Promise<void> {
  try {
    await transaction.query("SELECT 1", []);
  } catch (probe) {
    throw guestBindingSourceUnavailable(probe);
  }
}

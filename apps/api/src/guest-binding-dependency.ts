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

const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
/** A PostgreSQL error (its SQLSTATE) or this repository's wrapped database diagnostic. */
const databaseFailure = (value: unknown): boolean => {
  const code = own(value, "code");
  if (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/u.test(code) &&
    own(value, "severity") !== undefined
  )
    return true;
  const sqlState = (own(value, "diagnostic") as { sqlState?: unknown } | undefined)?.sqlState;
  return typeof sqlState === "string";
};
const permanentCode = /(?:^|_)INVALID$/u;
/**
 * WP-2423 (outage-reads-and-retry review): what no wait can change — a malformed reference or a
 * registration that does not fit the phone's QR (`DINING_SESSION_INPUT_INVALID`,
 * `DINING_QR_REGISTRATION_INVALID`, ...). It stays the answer "Unavailable", so the phone is told
 * to scan again instead of "busy" for ever. A database failure anywhere behind it is not one.
 */
export function isGuestBindingPermanentRefusal(error: unknown): boolean {
  const chain: unknown[] = [];
  for (
    let current = error, depth = 0;
    depth < 4 && current !== null && typeof current === "object";
    depth += 1, current = own(current, "cause")
  )
    chain.push(current);
  if (chain.some(databaseFailure)) return false;
  return chain.some((link) =>
    ["code", "message"].some((key) => {
      const value = own(link, key);
      return typeof value === "string" && permanentCode.test(value);
    }),
  );
}
/**
 * The error a binding read throws on: a passing fault (`dependencyFailure`) unless it already is
 * one or it is a permanent refusal (then the caller answers "Unavailable"/null as before).
 */
export function guestBindingReadFailure(error: unknown): unknown {
  return isGuestDependencyFailure(error) || isGuestBindingPermanentRefusal(error)
    ? error
    : guestBindingSourceUnavailable(error);
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

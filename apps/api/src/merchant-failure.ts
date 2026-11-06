/**
 * WP-2423 item 10: what a failure on a merchant request means, in one place. A failure is a
 * refusal only when the error says so. Anything else is an outage or a fault, however it reads, and
 * staff are never told "you have no permission" for it. Nothing here grants access: the service
 * threw, so nothing was returned.
 *
 * - Refused: the request was decided against (a permission, an ended sign-in, a malformed request).
 * - Changed: the facts moved under the request (another server got there first, a row went). Try
 *   again after reading again.
 * - RetryLater: a known passing condition (a lock, a busy pool, a service answering unavailable).
 * - Unexpected: everything else, including no code, TypeError, a raw SQLSTATE and a new code nobody
 *   listed, so a new fault is seen rather than hidden. Each code the services throw today is
 *   classified in merchant-failure.test.ts.
 *
 * A service that rewrites whatever failed into its own "unavailable" code keeps the cause, and a
 * refusal of the person behind it (an ended sign-in, a permission) stays a refusal: otherwise someone
 * whose sign-in has ended is told "try again" for ever instead of being sent to sign in.
 */
export type MerchantFailureKind = "Refused" | "Changed" | "RetryLater" | "Unexpected";

/** Set by the database transaction runner on an error thrown after one of its queries failed. */
const databaseFailureKey = Symbol.for("bop.database.failure");

function own(value: unknown, key: PropertyKey): unknown {
  return value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

/** The failure's code: an owner error's `code`, or the UPPER_SNAKE message of a plain Error. */
export function merchantFailureCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = own(error, "code");
  if (typeof code === "string") return code;
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)
    ? error.message
    : null;
}

const deniedCodes: ReadonlySet<string> = new Set([
  // Merchant*Error codes that refuse the person.
  "Denied",
  "PermissionDenied",
  "NotOwner",
  "OwnerOnly",
  // A sign-in that has ended or was never good. The people behind it are sent to sign in again.
  "BROWSER_SESSION_ENDED",
  "SESSION_EXPIRED",
  "SESSION_REVOKED",
  "ACTOR_INACTIVE",
  "TENANT_CONTEXT_ACTOR_INVALID",
]);
const malformedCodes: ReadonlySet<string> = new Set([
  "Invalid",
  // Malformed identifiers in a request.
  "ACTOR_REFERENCE_INVALID",
  "BRAND_REFERENCE_INVALID",
  "STORE_REFERENCE_INVALID",
]);
const changedCodes: ReadonlySet<string> = new Set([
  // Merchant*Error codes that name a race.
  "Conflict",
  "VersionConflict",
  "Changed",
  "Stale",
  "NotFound",
  // The round this refund asks about was refunded by a cancellation meanwhile.
  "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
]);
const retryCodes: ReadonlySet<string> = new Set([
  "Unavailable",
  "Offline",
  "TENANT_DATABASE_TRANSACTION_CONFLICT",
  "TENANT_DATABASE_ACQUIRE_FAILED",
]);
const deniedEnding = /_(?:DENIED|FORBIDDEN)$/u;
const malformedEnding = /_(?:INPUT_INVALID|COMMAND_INVALID|REQUEST_INVALID)$/u;
const changedEnding = /_(?:CONFLICT|CHANGED|NOT_FOUND|EXPIRED|HISTORY_UNAVAILABLE)$/u;
/** Nobody is a member or assigned here: a refusal (more than one active is bad data: Unexpected). */
const activeNotFound = /^ACTIVE_[A-Z_]+_NOT_FOUND$/u;

/** The person may not do this, as opposed to a request that could not be read. */
const namesDenial = (code: string) =>
  deniedCodes.has(code) || deniedEnding.test(code) || activeNotFound.test(code);
const namesRefusal = (code: string) =>
  namesDenial(code) || malformedCodes.has(code) || malformedEnding.test(code);

/**
 * Behind a rewrite, the person was refused, and no query of the transaction had failed: nothing was
 * read wrongly to decide it with. A malformed value behind a rewrite is not their refusal: it may be
 * a stored row that did not parse.
 */
function deniedBehindRewrite(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (own(current, databaseFailureKey) !== undefined) return false;
    const code = merchantFailureCode(current);
    if (depth > 0 && code !== null && namesDenial(code)) return true;
    current = own(current, "cause");
  }
  return false;
}

/** A statement cancelled by its timeout or a lost connection is transient; other failures are not. */
function transientSqlState(sqlState: unknown): boolean {
  return typeof sqlState === "string" && (sqlState === "57014" || sqlState.startsWith("08"));
}

/**
 * A race code written after a statement of its transaction failed names that race only when the
 * statement failed on a constraint (class 23) or a conflict: a unique key taken, a row that moved.
 * A missing grant, a missing table or a bad value is a fault whatever the code says.
 */
function raceSqlState(sqlState: unknown): boolean {
  return (
    typeof sqlState === "string" &&
    (sqlState.startsWith("23") || ["40001", "40P01", "55P03"].includes(sqlState))
  );
}
const namesChange = (code: string) => changedCodes.has(code) || changedEnding.test(code);

/**
 * The SQLSTATE of the statement that failed first: what follows it in an aborted transaction (a
 * scope restored in a finally block) only ever says 25P02.
 */
function failedStatementState(error: unknown): unknown {
  const first = own(error, databaseFailureKey) as { sqlState?: unknown } | undefined;
  return first?.sqlState ?? (own(error, "diagnostic") as { sqlState?: unknown } | null)?.sqlState;
}

export function merchantFailureKind(error: unknown): MerchantFailureKind {
  const code = merchantFailureCode(error);
  if (code === null) return deniedBehindRewrite(error) ? "Refused" : "Unexpected";
  if (code === "TENANT_DATABASE_TRANSACTION_FAILED")
    return transientSqlState(failedStatementState(error)) ? "RetryLater" : "Unexpected";
  if (retryCodes.has(code)) return deniedBehindRewrite(error) ? "Refused" : "RetryLater";
  if (namesRefusal(code)) {
    // Decided after a query of its own transaction failed: nothing was read to decide it with.
    const failure = own(error, databaseFailureKey) as { sqlState?: unknown } | undefined;
    if (failure === undefined) return "Refused";
    return transientSqlState(failure.sqlState) ? "RetryLater" : "Unexpected";
  }
  if (namesChange(code)) {
    const failure = own(error, databaseFailureKey) as { sqlState?: unknown } | undefined;
    if (failure === undefined || raceSqlState(failure.sqlState)) return "Changed";
    return transientSqlState(failure.sqlState) ? "RetryLater" : "Unexpected";
  }
  if (deniedBehindRewrite(error)) return "Refused";
  return code.endsWith("_UNAVAILABLE") ? "RetryLater" : "Unexpected";
}

/** Whether the failure, or one it was written over, carries this code. */
export function failureNamed(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (merchantFailureCode(current) === code) return true;
    current = own(current, "cause");
  }
  return false;
}

/** True only for an error that says the request was refused. */
export function isMerchantRefusal(error: unknown): boolean {
  return merchantFailureKind(error) === "Refused";
}

/**
 * For a service that turns the failure of a session or scope read into its own refusal:
 * `.catch(onlyRefusal(() => fail("PermissionDenied")))`. A real refusal becomes the service's;
 * anything else carries on as itself, so a lock timeout never reads as "no permission".
 */
export function onlyRefusal<T>(refuse: () => T): (error: unknown) => T {
  return (error) => {
    if (isMerchantRefusal(error)) return refuse();
    throw error;
  };
}

/**
 * Keeps what really failed behind an error class whose constructor takes no options: non-enumerable,
 * as `new Error(..., { cause })` makes it, so it is logged by code and never answered or serialized.
 */
export function withCause<T>(error: T, cause: unknown): T {
  if (
    error !== null &&
    typeof error === "object" &&
    Object.isExtensible(error) &&
    !Object.hasOwn(error, "cause")
  )
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  return error;
}

/** For a rewrite that throws through a helper: `.catch(keepingCause(() => fail("Unavailable")))`. */
export function keepingCause<T>(rewrite: () => T): (cause: unknown) => T {
  return (cause) => {
    try {
      return rewrite();
    } catch (error) {
      throw withCause(error, cause);
    }
  };
}

/** A lock, a busy pool or a timeout, itself or behind a rewrite: it passes if the page waits. */
export function isDatabaseContention(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = merchantFailureCode(current);
    if (
      code === "TENANT_DATABASE_TRANSACTION_CONFLICT" ||
      code === "TENANT_DATABASE_ACQUIRE_FAILED"
    )
      return true;
    for (const failure of [own(current, "diagnostic"), own(current, databaseFailureKey)])
      if (transientSqlState((failure as { sqlState?: unknown } | null | undefined)?.sqlState))
        return true;
    current = own(current, "cause");
  }
  return false;
}

/** Contention that outlasted its own reruns, itself or behind a rewrite: ordinary service. */
export function isExpectedContention(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (merchantFailureCode(current) === "TENANT_DATABASE_TRANSACTION_CONFLICT") return true;
    current = own(current, "cause");
  }
  return false;
}

/**
 * A refusal thrown out of a transaction after one of its queries failed is not a refusal: a read
 * deep inside (a session, a membership, a Store, a policy) made its own of a database failure, and
 * a service's typed answer would say "no permission". Nor is a race code written over a failure
 * that was not a constraint or a conflict: the typed "Conflict" would answer 409 "it changed" with
 * nothing logged, every time. Wraps the transaction host once, at
 * composition, so everything run through it says what happened, whatever its inner catch blocks
 * wrote. Other rewrites keep their own error (a constraint failure answered as "code taken", a typed
 * "unavailable"), with the failure's SQLSTATE riding along.
 */
export function refusalsStayReal<
  H extends {
    run<T>(work: (transaction: never) => Promise<T>): Promise<T>;
    runSnapshot?<T>(work: (transaction: never) => Promise<T>): Promise<T>;
  },
>(transactions: H): H {
  const honest = (error: unknown): unknown => {
    const failure = own(error, databaseFailureKey);
    const code = merchantFailureCode(error);
    if (failure === undefined || code === null) return error;
    const sqlState = (failure as { sqlState?: unknown }).sqlState;
    if (!namesRefusal(code) && !(namesChange(code) && !raceSqlState(sqlState))) return error;
    return withCause(
      Object.assign(new Error("MERCHANT_REFUSAL_AFTER_DATABASE_FAILURE"), {
        code: "TENANT_DATABASE_TRANSACTION_FAILED",
        diagnostic: failure,
      }),
      error,
    );
  };
  const guard =
    (call: (work: (transaction: never) => Promise<unknown>) => Promise<unknown>) =>
    (work: (transaction: never) => Promise<unknown>) =>
      call(work).catch((error: unknown) => {
        throw honest(error);
      });
  return Object.freeze({
    ...transactions,
    run: guard(transactions.run.bind(transactions)),
    ...(transactions.runSnapshot === undefined
      ? {}
      : { runSnapshot: guard(transactions.runSnapshot.bind(transactions)) }),
  }) as H;
}

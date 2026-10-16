/**
 * v15 2026-10-16: a customer read that answers 503 logs which failure caused it, as a safe code
 * and SQLSTATE only (for example `TENANT_DATABASE_TRANSACTION_CONFLICT_SQL_40P01`). No message,
 * reference, credential or row value is ever read from the error.
 */
const causeKey = Symbol.for("bop.failure.cause");
/** Set by the database transaction runner on an error thrown after one of its queries failed. */
const databaseFailureKey = Symbol.for("bop.database.failure");
const safeCode = /^[A-Z][A-Z0-9_]{0,44}$/u;
const sqlStatePattern = /^[0-9A-Z]{5}$/u;

/** Keeps the original failure behind a customer-facing error, without exposing it. */
export function withFailureCause<T extends object>(target: T, cause: unknown): T {
  if (cause !== null && typeof cause === "object" && Object.isExtensible(target))
    Object.defineProperty(target, causeKey, { value: cause, enumerable: false });
  return target;
}

function own(value: unknown, key: PropertyKey): unknown {
  return value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

function sqlStateOf(value: unknown): string | null {
  for (const holder of [own(value, "diagnostic"), own(value, databaseFailureKey)]) {
    const state = own(holder, "sqlState");
    if (typeof state === "string" && sqlStatePattern.test(state)) return state;
  }
  return null;
}

/**
 * The innermost safe failure code in the error and its kept causes, with the database SQLSTATE
 * when one is known. Undefined when nothing safe can be told.
 */
export function customerFailureCode(error: unknown): string | undefined {
  let code: string | undefined;
  let sqlState: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
    const candidate = own(current, "code");
    if (typeof candidate === "string" && safeCode.test(candidate)) code = candidate;
    sqlState = sqlStateOf(current) ?? sqlState;
    current = own(current, causeKey) ?? own(current, "cause");
  }
  if (code === undefined && sqlState === null) return undefined;
  return (code ?? "DATABASE_FAILURE") + (sqlState === null ? "" : "_SQL_" + sqlState);
}

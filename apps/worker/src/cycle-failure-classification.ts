/**
 * WP-2423 pilot resilience (2026-10-15): one failed cycle of one workload must not stop the
 * others. A failure is Transient when retrying the whole cycle later can succeed without anyone
 * changing data or configuration: a serialization/deadlock/lock conflict, a cancelled or timed-out
 * statement, a lost or refused connection, or an owner reporting its dependency temporarily
 * unavailable. Everything else (invalid/mismatched/changed state, denied access, missing
 * configuration, an unrecognised error) needs a person: Attention.
 *
 * Only safe identifiers are read (own `code`, `message` shape, `diagnostic.sqlState`, `cause`),
 * never values; untrusted errors cannot make classification throw.
 */
export type CycleFailureDisposition = "Transient" | "Attention";

const SQLSTATE = /^[0-9A-Z]{5}$/u;
/** Retry-safe SQLSTATEs: nothing of the failed transaction was committed. */
function transientSqlState(state: string): boolean {
  return (
    state === "40001" || // serialization_failure
    state === "40P01" || // deadlock_detected
    state === "55P03" || // lock_not_available (lock_timeout)
    state === "57014" || // query_canceled (statement_timeout)
    state === "57P01" || // admin_shutdown (backend terminated)
    state === "57P02" || // crash_shutdown
    state === "57P03" || // cannot_connect_now (starting up / recovering)
    state === "25P03" || // idle_in_transaction_session_timeout
    state === "53300" || // too_many_connections
    state === "53400" || // configuration_limit_exceeded
    state.startsWith("08") // connection_exception class
  );
}
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
/** node-postgres reports a lost socket or pool timeout without a SQLSTATE. */
const CONNECTION_MESSAGES: ReadonlySet<string> = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
  "Query read timeout",
  "tenant database connection is unavailable",
]);
const APPLICATION_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
/** Owner codes that report a retryable dependency state rather than corrupt data. */
function transientApplicationCode(code: string): boolean {
  return (
    code === "TENANT_DATABASE_ACQUIRE_FAILED" ||
    code.endsWith("_UNAVAILABLE") ||
    code.endsWith("_CONFLICT") ||
    code.endsWith("_TIMEOUT")
  );
}
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
}

export function classifyCycleFailure(error: unknown): CycleFailureDisposition {
  try {
    let sqlState: string | null = null;
    let network = false;
    let connectionMessage = false;
    let firstApplicationCode: string | null = null;
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
      const value: object = current;
      const code = own(value, "code");
      const message = own(value, "message");
      const diagnostic = own(value, "diagnostic");
      const diagnosticState =
        diagnostic !== null && typeof diagnostic === "object" ? own(diagnostic, "sqlState") : null;
      if (sqlState === null && typeof code === "string" && SQLSTATE.test(code)) sqlState = code;
      if (
        sqlState === null &&
        typeof diagnosticState === "string" &&
        SQLSTATE.test(diagnosticState)
      )
        sqlState = diagnosticState;
      if (typeof code === "string" && NETWORK_CODES.has(code)) network = true;
      if (typeof message === "string" && CONNECTION_MESSAGES.has(message)) connectionMessage = true;
      if (firstApplicationCode === null)
        for (const text of [code, message])
          if (
            typeof text === "string" &&
            text.length <= 80 &&
            !SQLSTATE.test(text) &&
            APPLICATION_CODE.test(text)
          ) {
            firstApplicationCode = text;
            break;
          }
      current = own(value, "cause");
    }
    // A database fact decides first: a constraint violation wrapped as *_UNAVAILABLE is not
    // transient, and a timeout wrapped as *_FAILED is.
    if (sqlState !== null) return transientSqlState(sqlState) ? "Transient" : "Attention";
    if (network || connectionMessage) return "Transient";
    if (firstApplicationCode !== null && transientApplicationCode(firstApplicationCode))
      return "Transient";
  } catch {
    /* Fail closed: an unreadable error needs a person. */
  }
  return "Attention";
}

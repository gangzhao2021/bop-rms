import { expect, it } from "vitest";
import { classifyCycleFailure } from "./cycle-failure-classification.js";

const pg = (code: string) => Object.assign(Error("database said no"), { code });
const tenant = (code: string, sqlState: string | null) =>
  Object.assign(Error("tenant database transaction failed"), {
    code,
    diagnostic: { sqlState, constraint: null, table: null, closed: false },
  });
/** An owner error that turned a failed query into its own code; the runner attaches the query's
 * sanitized diagnostic under a registered symbol (packages/database transaction-runner). */
const ownerOver = (code: string, sqlState: string) =>
  Object.defineProperty(Error(code), Symbol.for("bop.database.failure"), {
    value: { sqlState, constraint: null, table: null, closed: false },
    enumerable: false,
  });
it.each([
  ["serialization", pg("40001")],
  ["deadlock", pg("40P01")],
  ["lock timeout", pg("55P03")],
  ["statement timeout", pg("57014")],
  ["terminated backend", pg("57P01")],
  ["idle in transaction timeout", pg("25P03")],
  ["connection failure class", pg("08006")],
  ["too many connections", pg("53300")],
  ["socket reset", Object.assign(Error("read ECONNRESET"), { code: "ECONNRESET" })],
  ["pg lost socket", Error("Connection terminated unexpectedly")],
  ["pool timeout", Error("timeout exceeded when trying to connect")],
  ["tenant conflict without diagnostic", tenant("TENANT_DATABASE_TRANSACTION_CONFLICT", null)],
  ["tenant failed with statement timeout", tenant("TENANT_DATABASE_TRANSACTION_FAILED", "57014")],
  ["tenant acquire", tenant("TENANT_DATABASE_ACQUIRE_FAILED", null)],
  [
    "owner unavailable",
    Object.assign(Error("x"), { code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" }),
  ],
  ["wrapped kitchen refresh", Error("KITCHEN_QUEUE_REFRESH_UNAVAILABLE", { cause: pg("57014") })],
  ["wrapped timeout", Error("SOMETHING_TIMEOUT")],
  // WP-2423 (v15 2026-10-17): what a short host stall during a deploy actually produced.
  [
    "tenant setup or commit on a lost connection",
    tenant("TENANT_DATABASE_TRANSACTION_FAILED", "08006"),
  ],
  ["tenant idle-in-transaction timeout", tenant("TENANT_DATABASE_TRANSACTION_FAILED", "25P03")],
  ["event consumer without a connection", Error("CONSUMER_TEMPORARY_FAILURE")],
  ["event consumer commit lost", Error("COMMIT_OUTCOME_UNKNOWN")],
  ["owner error over a lost query", ownerOver("INTERNAL_COMPENSATION_REPAIR_FAILED", "08006")],
])("transient: %s", (_name, error) => {
  expect(classifyCycleFailure(error)).toBe("Transient");
});
it.each([
  ["invalid discovery", Error("PAYMENT_WAIT_DISCOVERY_INVALID")],
  ["unique violation", tenant("TENANT_DATABASE_TRANSACTION_FAILED", "23505")],
  ["unavailable wrapping a constraint", Error("X_UNAVAILABLE", { cause: pg("23514") })],
  ["permission", pg("42501")],
  ["concurrent query", tenant("TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY", null)],
  ["changed scope", Error("BUSINESS_WORKER_SCOPE_CHANGED")],
  // Still a person's job: an unexplained tenant failure, and an owner error over bad data.
  ["tenant failed without diagnostic", tenant("TENANT_DATABASE_TRANSACTION_FAILED", null)],
  ["owner error over a constraint", ownerOver("INTERNAL_COMPENSATION_REPAIR_FAILED", "23505")],
  ["owner error without a database cause", Error("INTERNAL_COMPENSATION_REPAIR_FAILED")],
  ["free text", Error("something odd happened")],
  ["non-error", "boom"],
  ["null", null],
  [
    "hostile getter",
    Object.defineProperty({}, "code", {
      get() {
        throw Error("trap");
      },
    }),
  ],
])("attention: %s", (_name, error) => {
  expect(classifyCycleFailure(error)).toBe("Attention");
});

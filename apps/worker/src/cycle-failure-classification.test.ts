import { expect, it } from "vitest";
import { classifyCycleFailure } from "./cycle-failure-classification.js";

const pg = (code: string) => Object.assign(Error("database said no"), { code });
const tenant = (code: string, sqlState: string | null) =>
  Object.assign(Error("tenant database transaction failed"), {
    code,
    diagnostic: { sqlState, constraint: null, table: null, closed: false },
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

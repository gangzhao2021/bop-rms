import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserSessionError } from "@bop/identity";
import { MembershipContractError } from "@bop/membership";
import { describe, expect, it } from "vitest";
import {
  isDatabaseContention,
  isExpectedContention,
  isMerchantRefusal,
  keepingCause,
  merchantFailureCode,
  merchantFailureKind,
  onlyRefusal,
  refusalsStayReal,
  withCause,
} from "./merchant-failure.js";

const coded = (code: string) => Object.assign(new Error("safe"), { code });
const database = (code: string, sqlState: string | null) =>
  Object.assign(new Error("safe"), { code, diagnostic: { sqlState } });
const missingGrant = () => database("TENANT_DATABASE_TRANSACTION_FAILED", "42501");
const afterFailedQuery = (error: Error, sqlState: string) =>
  Object.defineProperty(error, Symbol.for("bop.database.failure"), {
    value: { sqlState },
    enumerable: false,
  });

describe("what a failure means", () => {
  it.each([
    "BROWSER_SESSION_DENIED",
    "BROWSER_SESSION_ENDED",
    "BROWSER_SESSION_INPUT_INVALID",
    "SESSION_EXPIRED",
    "SESSION_REVOKED",
    "ACTOR_INACTIVE",
    "STORE_SERVICE_PERMISSION_DENIED",
    "BRAND_SERVICE_PERMISSION_DENIED",
    "MERCHANT_SELECTED_CONTEXT_DENIED",
    "MERCHANT_ORGANIZATION_NOT_ACTIVE_DENIED",
    "BROWSER_SESSION_SELECTION_DENIED",
    "TENANT_CONTEXT_STORE_DENIED",
    "DINING_TABLE_COMMAND_DENIED",
    "DINING_TABLE_CONTEXT_DENIED",
    "SOMETHING_FORBIDDEN",
    "Denied",
    "PermissionDenied",
    "NotOwner",
    "OwnerOnly",
    "Invalid",
    "IDENTITY_INPUT_INVALID",
    "MEMBERSHIP_INPUT_INVALID",
    "DINING_SESSION_INPUT_INVALID",
    "STORE_SERVICE_COMMAND_INVALID",
    "ACTOR_REFERENCE_INVALID",
    "ACTIVE_MEMBERSHIP_NOT_FOUND",
    "ACTIVE_STORE_ASSIGNMENT_NOT_FOUND",
  ])("%s is a refusal", (code) => {
    expect(merchantFailureKind(coded(code))).toBe("Refused");
    expect(merchantFailureKind(new Error(code.toUpperCase()))).toBe(
      /^[A-Z][A-Z0-9_]+$/u.test(code) ? "Refused" : "Unexpected",
    );
  });

  it.each([
    "BROWSER_SESSION_UNAVAILABLE",
    "TENANT_DATABASE_TRANSACTION_CONFLICT",
    "TENANT_DATABASE_ACQUIRE_FAILED",
    "MERCHANT_ORGANIZATION_UNAVAILABLE",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
    "Unavailable",
  ])("%s is a passing condition", (code) => {
    expect(merchantFailureKind(coded(code))).toBe("RetryLater");
  });

  it.each(["57014", "08006", "08001"])(
    "a transaction lost to %s is a passing condition",
    (state) => {
      expect(merchantFailureKind(database("TENANT_DATABASE_TRANSACTION_FAILED", state))).toBe(
        "RetryLater",
      );
    },
  );

  it.each([
    "DINING_SESSION_VERSION_CONFLICT",
    "BROWSER_SESSION_VERSION_CONFLICT",
    "DINING_TABLE_COMMAND_CONFLICT",
    "DINING_TABLE_CONTEXT_CHANGED",
    "DINING_JOIN_STATE_CHANGED",
    "KITCHEN_QUEUE_NOT_FOUND",
    "ORDER_QUOTE_EXPIRED",
    "MERCHANT_REFUND_READ_CHANGED",
    "ORDINARY_REFUND_HISTORY_UNAVAILABLE",
    "ORDINARY_REFUND_ROUND_REFUNDED_BY_CANCELLATION",
    "Conflict",
    "NotFound",
    "Stale",
  ])("%s means the facts moved: read again", (code) => {
    expect(merchantFailureKind(coded(code))).toBe("Changed");
  });

  it("anything else is unexpected, so it is seen", () => {
    expect(merchantFailureKind(new TypeError("x is not a function"))).toBe("Unexpected");
    expect(merchantFailureKind(new Error("guest Sam at table 4"))).toBe("Unexpected");
    expect(merchantFailureKind(null)).toBe("Unexpected");
    expect(merchantFailureKind("text")).toBe("Unexpected");
    // A raw SQLSTATE, a missing grant, and a new code nobody listed.
    expect(merchantFailureKind(coded("42501"))).toBe("Unexpected");
    expect(merchantFailureKind(database("TENANT_DATABASE_TRANSACTION_FAILED", "42501"))).toBe(
      "Unexpected",
    );
    expect(merchantFailureKind(database("TENANT_DATABASE_TRANSACTION_FAILED", null))).toBe(
      "Unexpected",
    );
    expect(merchantFailureKind(coded("TENANT_DATABASE_TRANSACTION_CONCURRENT_QUERY"))).toBe(
      "Unexpected",
    );
    expect(merchantFailureKind(coded("BRAND_NEW_CODE"))).toBe("Unexpected");
    // Two active memberships is corrupt data that someone must fix: no access, and it is logged.
    expect(merchantFailureKind(coded("ACTIVE_MEMBERSHIP_AMBIGUOUS"))).toBe("Unexpected");
    expect(merchantFailureKind(coded("ACTIVE_STORE_ASSIGNMENT_AMBIGUOUS"))).toBe("Unexpected");
  });

  it("reads the owners' own error classes", () => {
    expect(merchantFailureKind(new BrowserSessionError("BROWSER_SESSION_DENIED"))).toBe("Refused");
    expect(merchantFailureKind(new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT"))).toBe(
      "Changed",
    );
    expect(merchantFailureKind(new MembershipContractError("ACTIVE_MEMBERSHIP_NOT_FOUND"))).toBe(
      "Refused",
    );
    expect(merchantFailureKind(new MembershipContractError("ACTIVE_MEMBERSHIP_AMBIGUOUS"))).toBe(
      "Unexpected",
    );
  });

  it("a refusal decided after a query of its transaction failed is no refusal", () => {
    const refused = () => new Error("STORE_SERVICE_PERMISSION_DENIED");
    expect(merchantFailureKind(afterFailedQuery(refused(), "42501"))).toBe("Unexpected");
    expect(merchantFailureKind(afterFailedQuery(refused(), "57014"))).toBe("RetryLater");
    // A typed answer to a failed statement keeps its meaning: "code taken", "conflict".
    expect(merchantFailureKind(afterFailedQuery(new Error("X_CONFLICT"), "23505"))).toBe("Changed");
  });

  it("a race written over a failed statement is a race only for a constraint or a conflict", () => {
    for (const code of ["Conflict", "NotFound", "X_CONFLICT", "X_NOT_FOUND", "X_CHANGED"]) {
      expect(merchantFailureKind(afterFailedQuery(coded(code), "23505"))).toBe("Changed");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "23P01"))).toBe("Changed");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "42501"))).toBe("Unexpected");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "42P01"))).toBe("Unexpected");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "22P02"))).toBe("Unexpected");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "57014"))).toBe("RetryLater");
      expect(merchantFailureKind(afterFailedQuery(coded(code), "08006"))).toBe("RetryLater");
      expect(merchantFailureKind(coded(code))).toBe("Changed");
    }
  });

  it("a rewrite around a refusal of the person stays a refusal", () => {
    const rewrite = (cause: unknown) =>
      withCause(new Error("MERCHANT_TASK_INBOX_UNAVAILABLE"), cause);
    expect(merchantFailureKind(rewrite(new Error("BROWSER_SESSION_DENIED")))).toBe("Refused");
    expect(merchantFailureKind(rewrite(coded("SESSION_REVOKED")))).toBe("Refused");
    expect(merchantFailureKind(rewrite(rewrite(coded("ACTIVE_MEMBERSHIP_NOT_FOUND"))))).toBe(
      "Refused",
    );
    expect(merchantFailureKind(withCause(coded("Unavailable"), coded("PermissionDenied")))).toBe(
      "Refused",
    );
    expect(merchantFailureKind(withCause(new Error("guest Sam"), coded("X_DENIED")))).toBe(
      "Refused",
    );
    // Whatever else is behind it stays what it was.
    expect(merchantFailureKind(rewrite(new TypeError("x")))).toBe("RetryLater");
    expect(merchantFailureKind(rewrite(missingGrant()))).toBe("RetryLater");
    // A stored row that did not parse is no refusal of this person.
    expect(merchantFailureKind(rewrite(coded("ACTOR_REFERENCE_INVALID")))).toBe("RetryLater");
    // Decided after a query failed: nothing was read to decide it with, wherever that shows.
    expect(merchantFailureKind(afterFailedQuery(rewrite(coded("X_DENIED")), "42501"))).toBe(
      "RetryLater",
    );
    expect(merchantFailureKind(rewrite(afterFailedQuery(coded("X_DENIED"), "42501")))).toBe(
      "RetryLater",
    );
    expect(isMerchantRefusal(rewrite(coded("X_DENIED")))).toBe(true);
  });

  it("takes the code from `code`, or from a code-shaped message and never other text", () => {
    expect(merchantFailureCode(coded("X_DENIED"))).toBe("X_DENIED");
    expect(merchantFailureCode(new Error("X_DENIED"))).toBe("X_DENIED");
    expect(merchantFailureCode(new Error("guest Sam"))).toBeNull();
    expect(merchantFailureCode(undefined)).toBeNull();
  });
});

describe("every code a service throws today", () => {
  /** Faults on purpose: a bad service result or a broken guard is for the log and a retry. */
  const unexpectedOnPurpose = new Set([
    "COMPENSATION_RECONCILIATION_RESULT_INVALID",
    "DINING_COMBO_PART_NOT_READY",
    "MENU_READ_ONLY",
    "MERCHANT_BFF_RESULT_INVALID",
    "MERCHANT_BFF_UNREPORTED_FAILURE",
    "MERCHANT_REFUSAL_AFTER_DATABASE_FAILURE",
    "MERCHANT_STORE_ROUTING_INVALID",
    "ORDINARY_REFUND_COMPOSITION_SCOPE_MISMATCH",
    "PAYMENT_RECONCILIATION_DETAIL_MISSING",
    "PRICE_READ_ONLY",
    "RECONCILIATION_ASSIGNEES_INVALID",
    "RECONCILIATION_EVIDENCE_INVALID",
    "RECONCILIATION_FOLLOW_UP_RESULT_INVALID",
    "REFUND_RECEIPT_RESULT_INVALID",
    "STOCK_HOLDING_INVALID",
    "STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID",
    "STORE_CONFIGURATION_PUBLICATION_CHECKS_INVALID",
    "STORE_CONFIGURATION_REFERENCE_INVALID",
    "STORE_PRICE_READ_ONLY",
  ]);
  it("is classified, so a new refusal or race is not told to try again by accident", () => {
    const source = dirname(fileURLToPath(import.meta.url));
    const unlisted = new Set<string>();
    for (const name of readdirSync(source)) {
      if (!/^(?:persistent-)?merchant-.*\.ts$/u.test(name) || name.endsWith(".test.ts")) continue;
      for (const found of readFileSync(join(source, name), "utf8").matchAll(
        /\bError\(\s*"([A-Z][A-Z0-9_]{2,})"/gu,
      )) {
        const code = found[1] as string;
        if (merchantFailureKind(new Error(code)) === "Unexpected" && !unexpectedOnPurpose.has(code))
          unlisted.add(code);
      }
    }
    expect([...unlisted]).toEqual([]);
  });
});

describe("a service's own refusal", () => {
  const refuse = () => {
    throw new Error("MY_SERVICE_DENIED");
  };

  it("onlyRefusal refuses a refusal and lets everything else carry on as itself", () => {
    expect(() => onlyRefusal(refuse)(new Error("STORE_SERVICE_PERMISSION_DENIED"))).toThrow(
      "MY_SERVICE_DENIED",
    );
    for (const failure of [
      database("TENANT_DATABASE_TRANSACTION_FAILED", "42501"),
      coded("TENANT_DATABASE_TRANSACTION_CONFLICT"),
      new BrowserSessionError("BROWSER_SESSION_UNAVAILABLE"),
      new TypeError("bug"),
    ]) {
      let thrown: unknown;
      try {
        onlyRefusal(refuse)(failure);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
    }
  });

  it("onlyRefusal can answer with a value, for a read that may simply not be allowed", () => {
    expect(onlyRefusal(() => null)(new Error("X_DENIED"))).toBeNull();
    expect(() => onlyRefusal(() => null)(new TypeError("bug"))).toThrow("bug");
  });

  it("keeps what really failed behind a rewrite, out of any serialized answer", () => {
    const cause = coded("42501");
    const rewritten = withCause(new Error("X_UNAVAILABLE"), cause);
    expect(rewritten.cause).toBe(cause);
    expect(Object.keys(rewritten)).toEqual([]);
    expect(JSON.stringify(rewritten)).toBe("{}");
    expect(withCause(new Error("Y", { cause: "first" }), cause).cause).toBe("first");
    const raised = (() => {
      try {
        keepingCause(() => {
          throw new Error("X_UNAVAILABLE");
        })(cause);
      } catch (error) {
        return error as Error;
      }
    })();
    expect(raised?.message).toBe("X_UNAVAILABLE");
    expect(raised?.cause).toBe(cause);
  });

  it("tells contention from a fault, itself or behind a rewrite", () => {
    const conflict = coded("TENANT_DATABASE_TRANSACTION_CONFLICT");
    expect(isExpectedContention(conflict)).toBe(true);
    expect(isExpectedContention(withCause(new Error("X_UNAVAILABLE"), conflict))).toBe(true);
    expect(isExpectedContention(coded("TENANT_DATABASE_ACQUIRE_FAILED"))).toBe(false);
    expect(isExpectedContention(new TypeError("bug"))).toBe(false);
    expect(isDatabaseContention(conflict)).toBe(true);
    expect(isDatabaseContention(coded("TENANT_DATABASE_ACQUIRE_FAILED"))).toBe(true);
    expect(isDatabaseContention(database("TENANT_DATABASE_TRANSACTION_FAILED", "57014"))).toBe(
      true,
    );
    expect(
      isDatabaseContention(
        withCause(
          new Error("X_UNAVAILABLE"),
          database("TENANT_DATABASE_TRANSACTION_FAILED", "08006"),
        ),
      ),
    ).toBe(true);
    expect(isDatabaseContention(database("TENANT_DATABASE_TRANSACTION_FAILED", "42501"))).toBe(
      false,
    );
    expect(isDatabaseContention(new TypeError("bug"))).toBe(false);
  });
});

describe("a transaction host that keeps refusals honest", () => {
  const hostThrowing = (error: unknown) => ({
    run: () => Promise.reject(error),
    runSnapshot: () => Promise.reject(error),
  });

  it.each(["run", "runSnapshot"] as const)(
    "%s: a refusal after a failed query becomes the failure, with what was said behind it",
    async (mode) => {
      const said = afterFailedQuery(coded("PermissionDenied"), "42501");
      const host = refusalsStayReal(hostThrowing(said) as never) as unknown as {
        run(work: () => Promise<unknown>): Promise<unknown>;
        runSnapshot(work: () => Promise<unknown>): Promise<unknown>;
      };
      const thrown = await host[mode](async () => undefined).catch((error: unknown) => error);
      expect(merchantFailureCode(thrown)).toBe("TENANT_DATABASE_TRANSACTION_FAILED");
      expect(merchantFailureKind(thrown)).toBe("Unexpected");
      expect((thrown as Error).cause).toBe(said);
      expect((thrown as unknown as { diagnostic: unknown }).diagnostic).toEqual({
        sqlState: "42501",
      });
    },
  );

  it("a race code written over a missing grant becomes the failure, so it is not answered 409", async () => {
    const said = afterFailedQuery(coded("Conflict"), "42501");
    const host = refusalsStayReal(hostThrowing(said) as never) as unknown as {
      run(work: () => Promise<unknown>): Promise<unknown>;
    };
    const thrown = await host.run(async () => undefined).catch((error: unknown) => error);
    expect(merchantFailureCode(thrown)).toBe("TENANT_DATABASE_TRANSACTION_FAILED");
    expect(merchantFailureKind(thrown)).toBe("Unexpected");
    expect((thrown as Error).cause).toBe(said);
  });

  it("leaves a real refusal, and a typed answer to a failed statement, as they are", async () => {
    const refused = coded("PermissionDenied");
    const taken = afterFailedQuery(new Error("CODE_CONFLICT"), "23505");
    for (const error of [refused, taken]) {
      const host = refusalsStayReal(hostThrowing(error) as never) as unknown as {
        run(work: () => Promise<unknown>): Promise<unknown>;
      };
      await expect(host.run(async () => undefined)).rejects.toBe(error);
    }
  });

  it("works with a host that has no snapshot reads, and passes results through", async () => {
    const host = refusalsStayReal({
      run: <T>(work: (transaction: never) => Promise<T>) => work(undefined as never),
    });
    expect("runSnapshot" in host).toBe(false);
    await expect(host.run(async () => 7)).resolves.toBe(7);
  });
});

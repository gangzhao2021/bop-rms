import { describe, expect, it } from "vitest";
import {
  guestBindingReadFailure,
  guestBindingSourceUnavailable,
  isGuestBindingPermanentRefusal,
  isGuestDependencyFailure,
} from "./guest-binding-dependency.js";

const postgres = (code: string) =>
  Object.assign(new Error("canceling statement due to statement timeout"), {
    code,
    severity: "ERROR",
  });

describe("WP-2423 outage-reads-and-retry review: a binding read's failure", () => {
  it("a malformed reference or a registration that doesn't fit stays the answer", () => {
    for (const error of [
      Object.assign(new Error("dining session input is invalid"), {
        code: "DINING_SESSION_INPUT_INVALID",
      }),
      new Error("DINING_QR_REGISTRATION_INVALID"),
      new Error("PICKUP_QR_REGISTRATION_INVALID"),
    ]) {
      expect(isGuestBindingPermanentRefusal(error)).toBe(true);
      expect(guestBindingReadFailure(error)).toBe(error);
      expect(isGuestDependencyFailure(guestBindingReadFailure(error))).toBe(false);
    }
  });
  it("a database failure is a passing fault, even behind an 'invalid' rewrite", () => {
    const behind = Object.assign(new Error("DINING_SESSION_INPUT_INVALID"), {
      cause: postgres("57014"),
    });
    const wrapped = Object.assign(new Error("TENANT_DATABASE_ACQUIRE_FAILED"), {
      diagnostic: { sqlState: "53300" },
    });
    for (const error of [
      postgres("57014"),
      behind,
      wrapped,
      new Error("timeout exceeded when trying to connect"),
      new Error("DINING_SESSION_DEPENDENCY_UNAVAILABLE"),
    ]) {
      expect(isGuestBindingPermanentRefusal(error)).toBe(false);
      expect(guestBindingReadFailure(error)).toMatchObject({ dependencyFailure: true });
    }
    const already = guestBindingSourceUnavailable(postgres("57014"));
    expect(guestBindingReadFailure(already)).toBe(already);
  });
});

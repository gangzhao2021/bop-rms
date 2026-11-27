import { describe, expect, it } from "vitest";
import { logGuestFailure } from "./guest-failure-log.js";

describe("WP-2423 guest failure line", () => {
  it("reads-under-burst: names the code an owner kept behind its plain answer, and only codes", () => {
    const store = new Error("GUEST_SESSION_UNAVAILABLE");
    Object.defineProperty(store, Symbol.for("bop.failure.cause"), {
      value: Object.freeze({ code: "TENANT_DATABASE_ACQUIRE_FAILED" }),
    });
    const error = Object.assign(new Error("CART_DEPENDENCY_UNAVAILABLE"), {
      code: "CART_DEPENDENCY_UNAVAILABLE",
      cause: Object.assign(new Error("private detail"), {
        code: "GUEST_SESSION_UNAVAILABLE",
        cause: store,
      }),
    });
    const lines: string[] = [];
    logGuestFailure("CUSTOMER_CART_READ_UNAVAILABLE", error, (line) => lines.push(line), 40);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: 40,
      time: expect.any(String),
      event: "CUSTOMER_CART_READ_UNAVAILABLE",
      code: "CART_DEPENDENCY_UNAVAILABLE",
      causes: [
        "GUEST_SESSION_UNAVAILABLE",
        "GUEST_SESSION_UNAVAILABLE",
        "TENANT_DATABASE_ACQUIRE_FAILED",
      ],
    });
    expect(lines[0]).not.toContain("private");
  });
});

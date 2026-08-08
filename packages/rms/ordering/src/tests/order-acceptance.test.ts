import { describe, expect, it } from "vitest";

import { OrderAcceptanceError, parseOrderAcceptanceEvidence } from "../index.js";

const id = (suffix: string) => `0198a902-0000-7000-8000-${suffix.padStart(12, "0")}`;

function evidence() {
  return {
    acceptanceReference: id("1"),
    checkpointReference: id("2"),
    sourceVersion: 7,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    brandReference: id("3"),
    storeReference: id("4"),
    orderReference: id("5"),
    orderBatchReference: id("6"),
    paymentAttemptReference: id("7"),
    phase: "Accepted",
    acceptanceKind: "TerminalAuthorization",
    acceptedAt: "2026-08-08T14:00:00.000Z",
  };
}

function rejects(value: unknown): void {
  expect(() => parseOrderAcceptanceEvidence(value)).toThrow(OrderAcceptanceError);
}

describe("Ordering acceptance evidence", () => {
  it("accepts only the exact immutable Accepted checkpoint", () => {
    const parsed = parseOrderAcceptanceEvidence(evidence());
    expect(parsed.phase).toBe("Accepted");
    expect(parsed.acceptanceKind).toBe("TerminalAuthorization");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("does not alias Submitted, PaymentPending or OrderCreated as acceptance", () => {
    rejects({ ...evidence(), phase: "Submitted" });
    rejects({ ...evidence(), phase: "PaymentPending" });
    rejects({ ...evidence(), phase: "OrderCreated" });
  });

  it("rejects extra, accessor, mutable-prototype and stale source data", () => {
    rejects({ ...evidence(), status: "Accepted" });
    const accessor = { ...evidence() };
    Object.defineProperty(accessor, "acceptedAt", {
      enumerable: true,
      get: () => "2026-08-08T14:00:00.000Z",
    });
    rejects(accessor);
    rejects(Object.assign(Object.create({}), evidence()));
    rejects({ ...evidence(), sourceVersion: 0 });
  });

  it("rejects malformed references, digest and non-canonical instants", () => {
    rejects({ ...evidence(), paymentAttemptReference: "attempt" });
    rejects({ ...evidence(), sourceDigest: "sha256:abcd" });
    rejects({ ...evidence(), acceptedAt: "2026-08-08T14:00:00Z" });
  });
});

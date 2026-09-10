import { describe, expect, it, vi } from "vitest";
import { createPostgresGuestDiningBindingStore } from "../infrastructure/persistence/guest-dining-binding-store.js";
import {
  parseGuestSelectorHash,
  parseGuestDiningAdmissionEvidence,
} from "../contracts/guest-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

describe("WP-2295 binding store boundary", () => {
  it("rejects malformed preparation without opening a transaction", async () => {
    const run = vi.fn();
    const store = createPostgresGuestDiningBindingStore(
      { run },
      { brandReference: id(1), storeReference: id(2) },
      { append: vi.fn() },
      (a, b) => a === b,
    );
    await expect(
      store.prepare({} as never, parseCanonicalInstant("2026-09-08T12:00:00.000Z")),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(run).not.toHaveBeenCalled();
  });
  it("bounds driver errors without exposing SQL or selectors", async () => {
    const store = createPostgresGuestDiningBindingStore(
      {
        async run() {
          throw new Error("synthetic private SQL");
        },
      },
      { brandReference: id(1), storeReference: id(2) },
      { append: vi.fn() },
      (a, b) => a === b,
    );
    await expect(
      store.complete({
        operationReference: id(3),
        sessionSelectorHash: parseGuestSelectorHash("a".repeat(64)),
        csrfSelectorHash: parseGuestSelectorHash("b".repeat(64)),
        observedAt: parseCanonicalInstant("2026-09-08T12:00:00.000Z"),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "GUEST_SESSION_UNAVAILABLE",
        message: "guest session is unavailable",
      }),
    );
  });
});

describe("WP-2295 captured store commands", () => {
  const proof = () => ({
    sessionSelectorHash: parseGuestSelectorHash("a".repeat(64)),
    csrfSelectorHash: parseGuestSelectorHash("b".repeat(64)),
    recoverySelectorHash: parseGuestSelectorHash("c".repeat(64)),
  });
  const observedAt = parseCanonicalInstant("2026-09-08T12:00:03.000Z");
  const ownerEvidence = () => ({
    ...parseGuestDiningAdmissionEvidence({
      guestSessionReference: id(6),
      decision: "Allowed" as const,
      admissionReference: id(4),
      operationReference: id(3),
      storeReference: id(2),
      publicTableReference: id(7),
      diningSessionReference: id(8),
      diningParticipantReference: id(9),
      evaluatedAt: parseCanonicalInstant("2026-09-08T12:00:02.000Z"),
      validUntil: parseCanonicalInstant("2026-09-08T12:05:00.000Z"),
    }),
  });
  for (const name of ["acknowledge", "activate", "complete"] as const) {
    for (const shape of [
      "extra",
      "missing",
      "accessor",
      "symbol",
      "hidden",
      "prototype",
      "array",
      "null",
    ] as const) {
      it(`${name} rejects ${shape} before transactions or getters`, async () => {
        const run = vi.fn(async () => undefined);
        const store = createPostgresGuestDiningBindingStore(
          { run: run as never },
          { brandReference: id(1), storeReference: id(2) },
          { append: vi.fn() },
          (a, b) => a === b,
        );
        let input: unknown =
          name === "complete"
            ? {
                operationReference: id(3),
                sessionSelectorHash: proof().sessionSelectorHash,
                csrfSelectorHash: proof().csrfSelectorHash,
                observedAt,
              }
            : {
                operationReference: id(3),
                currentSelectorHash: proof().sessionSelectorHash,
                proof: proof(),
                ...(name === "activate" ? { ownerEvidence: ownerEvidence() } : {}),
                observedAt,
              };
        let reads = 0;
        if (shape === "extra") Object.assign(input as object, { extra: true });
        if (shape === "missing") Reflect.deleteProperty(input as object, "operationReference");
        if (shape === "accessor")
          Object.defineProperty(input, "operationReference", {
            enumerable: true,
            get: () => {
              reads++;
              return id(3);
            },
          });
        if (shape === "symbol") Object.assign(input as object, { [Symbol("extra")]: true });
        if (shape === "hidden") Object.defineProperty(input, "extra", { value: true });
        if (shape === "prototype") Object.setPrototypeOf(input, { extra: true });
        if (shape === "array") input = [];
        if (shape === "null") input = null;
        let failure: unknown;
        try {
          await store[name](input as never);
        } catch (error) {
          failure = error;
        }
        expect(reads).toBe(0);
        expect(run).not.toHaveBeenCalled();
        expect(failure).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      });
    }
  }
  for (const field of ["proof", "ownerEvidence"] as const) {
    it(`captures ${field} without nested getter evaluation before any transaction`, async () => {
      const run = vi.fn(async () => undefined);
      const store = createPostgresGuestDiningBindingStore(
        { run: run as never },
        { brandReference: id(1), storeReference: id(2) },
        { append: vi.fn() },
        (a, b) => a === b,
      );
      const input = {
        operationReference: id(3),
        currentSelectorHash: proof().sessionSelectorHash,
        proof: proof(),
        ownerEvidence: ownerEvidence(),
        observedAt,
      };
      let reads = 0;
      Object.defineProperty(
        input[field],
        field === "proof" ? "sessionSelectorHash" : "admissionReference",
        {
          enumerable: true,
          get: () => {
            reads++;
            return id(4);
          },
        },
      );
      await expect(store.activate(input)).rejects.toMatchObject({
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      expect(reads).toBe(0);
      expect(run).not.toHaveBeenCalled();
    });
  }
  it("rejects constructor scope accessors without invoking them", () => {
    let reads = 0;
    const scope = {
      get brandReference() {
        reads++;
        return id(1);
      },
      storeReference: id(2),
    };
    expect(() =>
      createPostgresGuestDiningBindingStore(
        { run: vi.fn() },
        scope,
        { append: vi.fn() },
        (a, b) => a === b,
      ),
    ).toThrow();
    expect(reads).toBe(0);
  });
});

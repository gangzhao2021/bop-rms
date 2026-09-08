import { describe, expect, it, vi } from "vitest";
import { createPostgresGuestBindingStore } from "../infrastructure/persistence/guest-binding-store.js";
import { parseGuestSelectorHash } from "../contracts/guest-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

describe("WP-2235 binding store boundary", () => {
  it("rejects malformed preparation without opening a transaction", async () => {
    const run = vi.fn();
    const store = createPostgresGuestBindingStore(
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
    const store = createPostgresGuestBindingStore(
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

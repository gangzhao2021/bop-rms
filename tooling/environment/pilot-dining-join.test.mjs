import { describe, expect, it, vi } from "vitest";
import { createInternalDiningJoinRequestContext } from "./pilot-dining-join.mjs";

// v15 batch 39 live check (b40): a guest who scanned before staff seated the party tapped "Join
// this table" four times and was told "Too many tries" for minutes, while the DINING_JOIN_FAILURE
// bucket of that guest reached 13: every attempt of every QR tap was taken from the wrong-code
// budget (10 per 5 minutes), successes included. A QR join presents the code Dining issued to
// that guest a moment ago; only a typed code is a guess.
function resources() {
  const queries = [];
  return {
    queries,
    value: {
      scope: { storeReference: "01902423-0000-7000-8000-000000000003" },
      publicProfile: { binding: { validUntil: "2026-11-21T07:00:00.000Z" } },
      database: {
        acquire: async () => ({
          query: async (sql, values) => {
            queries.push({ sql, values });
            return { rows: [{ allowed: true, remaining: 9, retry_after_seconds: 0 }] };
          },
          release: () => undefined,
        }),
      },
    },
  };
}
const runtime = { credentials: { hashJoinBudget: () => new Uint8Array(32).fill(1) } };
const context = (observedAt) => ({
  guestSessionReference: "01902423-0000-7000-8000-000000000081",
  kind: "HumanCode",
  observedAt,
});

describe("the guest's join budget (pilot)", () => {
  it("a QR join takes nothing from the wrong-code budget", async () => {
    const r = resources();
    const request = createInternalDiningJoinRequestContext(r.value, runtime);
    expect(typeof request.abuse.admitIssued).toBe("function");
    for (let tap = 0; tap < 20; tap += 1)
      expect(await request.abuse.admitIssued(context("2026-11-21T06:17:03.000Z"))).toBe("Admitted");
    expect(r.queries).toEqual([]);
  });
  it("a typed code still counts against the wrong-code budget", async () => {
    const r = resources();
    const request = createInternalDiningJoinRequestContext(r.value, runtime);
    expect(await request.abuse.admit(context("2026-11-21T06:17:03.000Z"))).toBe("Admitted");
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0].sql).toContain("security.consume_abuse_budget");
    expect(r.queries[0].values[0]).toBe("DINING_JOIN_FAILURE");
    expect(r.queries[0].values.slice(3, 5)).toEqual([300, 10]);
  });
  it("neither admits once the Store's public profile binding has ended", async () => {
    const r = resources();
    const request = createInternalDiningJoinRequestContext(r.value, runtime);
    const late = context("2026-11-21T07:00:00.000Z");
    expect(await request.abuse.admitIssued(late)).toBe("Cooldown");
    expect(await request.abuse.admit(late)).toBe("Cooldown");
    expect(r.queries).toEqual([]);
    vi.restoreAllMocks();
  });
});

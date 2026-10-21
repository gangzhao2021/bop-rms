import { describe, expect, it, vi } from "vitest";
import {
  OrderRecoveryError,
  buildOrderRecoveryLink,
  createGuestSessionCredentialProvider,
  createOrderRecoveryAbuseKey,
  createOrderRecoveryService,
  createOrderRecoveryTokenHasher,
  type OrderRecoveryStorePort,
} from "../index.js";

const id = (n: number) => `0190aa20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const key = (fill: number) => new Uint8Array(32).fill(fill);

function harness(options: { limited?: boolean; budgetDown?: boolean } = {}) {
  const records: {
    tokenHash: string;
    pepperVersion: number;
    orderReference: string;
    expiresAt: string;
    consumed: boolean;
  }[] = [];
  let now = "2026-10-20T12:00:00.000Z";
  let n = 10;
  const store: OrderRecoveryStorePort = {
    appendAuthorization: vi.fn(async (input) => {
      const active = records.filter(
        (r) =>
          r.orderReference === input.orderReference &&
          !r.consumed &&
          Date.parse(r.expiresAt) > Date.parse(input.issuedAt),
      );
      if (active.length >= 2) return "SiblingLimit" as const;
      records.push({
        tokenHash: input.tokenHash,
        pepperVersion: input.pepperVersion,
        orderReference: input.orderReference,
        expiresAt: input.expiresAt,
        consumed: false,
      });
      return "Created" as const;
    }),
    peekOrder: vi.fn(async ({ candidates }) => {
      const found = records.find((r) =>
        candidates.some(
          (c: { tokenHash: string; pepperVersion: number }) =>
            c.tokenHash === r.tokenHash && c.pepperVersion === r.pepperVersion,
        ),
      );
      return found?.orderReference ?? null;
    }),
    consumeAndRekey: vi.fn(async ({ candidates, observedAt }) => {
      const found = records.find(
        (r) =>
          !r.consumed &&
          Date.parse(r.expiresAt) > Date.parse(observedAt) &&
          candidates.some(
            (c: { tokenHash: string; pepperVersion: number }) =>
              c.tokenHash === r.tokenHash && c.pepperVersion === r.pepperVersion,
          ),
      );
      if (!found) return null;
      for (const r of records) if (r.orderReference === found.orderReference) r.consumed = true;
      return { orderReference: found.orderReference };
    }),
  };
  const budget = {
    consume: vi.fn(async () => {
      if (options.budgetDown) throw new Error("limiter down");
      return options.limited
        ? ({ status: "RateLimited", retryAfterSeconds: 600 } as const)
        : ({ status: "Allowed" } as const);
    }),
  };
  const service = createOrderRecoveryService({
    hasher: createOrderRecoveryTokenHasher([{ version: 1, key: key(7) }]),
    store,
    budget,
    credentials: createGuestSessionCredentialProvider(key(3)),
    references: { generate: () => id(n++) },
    clock: { now: () => now },
  });
  return {
    service,
    store,
    budget,
    records,
    advance: (to: string) => {
      now = to;
    },
  };
}
const mint = (h: ReturnType<typeof harness>, attempt = id(5)) =>
  h.service.mint({
    orderReference: id(1),
    guestSessionReference: id(2),
    notificationAttemptReference: attempt,
  });

describe("DEC-PILOT-NOTIFICATIONS R1: one-time order recovery", () => {
  it("mints a 256-bit token, stores only its keyed hash and expires in 30 minutes", async () => {
    const h = harness();
    const minted = await mint(h);
    expect(minted?.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(minted?.expiresAt).toBe("2026-10-20T12:30:00.000Z");
    expect(JSON.stringify(h.records)).not.toContain(minted?.token as string);
    expect(h.records[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("allows at most two live siblings per Order", async () => {
    const h = harness();
    expect(await mint(h, id(5))).not.toBeNull();
    expect(await mint(h, id(6))).not.toBeNull();
    expect(await mint(h, id(7))).toBeNull();
  });

  it("consumes once, revokes siblings and re-keys with a fresh session credential", async () => {
    const h = harness();
    const first = await mint(h, id(5));
    const sibling = await mint(h, id(6));
    const opened = await h.service.consume({ token: first?.token, peerAddress: "203.0.113.9" });
    expect(opened.orderReference).toBe(id(1));
    expect(opened.sessionCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      h.service.consume({ token: first?.token, peerAddress: "203.0.113.9" }),
    ).rejects.toEqual(new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE"));
    await expect(
      h.service.consume({ token: sibling?.token, peerAddress: "203.0.113.9" }),
    ).rejects.toBeInstanceOf(OrderRecoveryError);
  });

  it("refuses an expired, unknown or malformed token with the same error", async () => {
    const h = harness();
    const minted = await mint(h);
    h.advance("2026-10-20T12:30:00.000Z");
    for (const token of [minted?.token, "Z".repeat(43), "short", 7])
      await expect(h.service.consume({ token, peerAddress: "203.0.113.9" })).rejects.toEqual(
        new OrderRecoveryError("ORDER_RECOVERY_UNAVAILABLE"),
      );
  });

  it("spends the abuse budget before trying and fails closed when it cannot be checked", async () => {
    const limited = harness({ limited: true });
    const token = (await mint(limited))?.token;
    await expect(
      limited.service.consume({ token, peerAddress: "203.0.113.9" }),
    ).rejects.toMatchObject({ code: "ORDER_RECOVERY_RATE_LIMITED", retryAfterSeconds: 600 });
    expect(limited.store.consumeAndRekey).not.toHaveBeenCalled();
    const down = harness({ budgetDown: true });
    const other = (await mint(down))?.token;
    await expect(
      down.service.consume({ token: other, peerAddress: "203.0.113.9" }),
    ).rejects.toThrow();
    expect(down.store.consumeAndRekey).not.toHaveBeenCalled();
  });

  it("keys the budget by Order and peer (IPv6 by /64), never by the raw address", () => {
    const keyOf = createOrderRecoveryAbuseKey(key(9));
    expect(keyOf(id(1), "2001:db8:1:2:aaaa::1").equals(keyOf(id(1), "2001:db8:1:2:bbbb::9"))).toBe(
      true,
    );
    expect(keyOf(id(1), "203.0.113.9").equals(keyOf(id(2), "203.0.113.9"))).toBe(false);
    expect(keyOf(null, "203.0.113.9").byteLength).toBe(32);
  });

  it("dual-reads older pepper versions after a rotation", () => {
    const before = createOrderRecoveryTokenHasher([{ version: 1, key: key(1) }]);
    const after = createOrderRecoveryTokenHasher([
      { version: 1, key: key(1) },
      { version: 2, key: key(2) },
    ]);
    const minted = before.mint();
    expect(after.candidates(minted.token)).toContainEqual({
      tokenHash: minted.tokenHash,
      pepperVersion: 1,
    });
    expect(after.mint().pepperVersion).toBe(2);
  });

  it("puts the token only in the URL fragment of the customer origin", () => {
    expect(buildOrderRecoveryLink("https://order.example.test", "A".repeat(43))).toBe(
      `https://order.example.test/resume#t=${"A".repeat(43)}`,
    );
    expect(() => buildOrderRecoveryLink("http://order.example.test", "A".repeat(43))).toThrow();
  });
});

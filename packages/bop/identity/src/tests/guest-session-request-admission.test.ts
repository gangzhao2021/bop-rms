import { describe, expect, it, vi } from "vitest";
import {
  createGuestSessionRequestAdmission,
  createGuestSessionAbuseKeys,
  guestTableWaitPolicy,
  type GuestSessionAbuseBudget,
} from "../index.js";
const scope = {
  brandReference: "00000000-0000-7000-8000-000000000001",
  storeReference: "00000000-0000-7000-8000-000000000002",
};
const at = "2026-09-19T12:00:00.000Z";
const request = { remoteAddress: "192.0.2.1", requestedAt: at };
const keys = () => createGuestSessionAbuseKeys(new Uint8Array(32).fill(1));
function setup(consume: GuestSessionAbuseBudget["consume"]) {
  return createGuestSessionRequestAdmission({
    scope,
    keys: keys(),
    now: () => at,
    budget: { consume },
  });
}
describe("Guest request abuse policy", () => {
  it("consumes exact accepted IP20 and Store300 budgets with distinct hashes", async () => {
    const consume = vi.fn<GuestSessionAbuseBudget["consume"]>(async (input) => ({
      allowed: true,
      remaining: input.limitCount - 1,
      retry_after_seconds: 0,
    }));
    expect(await setup(consume).consume(request)).toEqual({ status: "Allowed" });
    expect(
      consume.mock.calls.map(([input]) => [
        input.windowSeconds,
        input.limitCount,
        input.observedAt,
      ]),
    ).toEqual([
      [600, 120, at],
      [600, 300, at],
    ]);
    expect(consume.mock.calls[0]?.[0].keyHash).not.toEqual(consume.mock.calls[1]?.[0].keyHash);
  });
  it("does not consume Store budget once IP budget is exhausted", async () => {
    const consume = vi.fn(async () => ({ allowed: false, remaining: 0, retry_after_seconds: 42 }));
    expect(await setup(consume).consume(request)).toEqual({
      status: "RateLimited",
      retryAfterSeconds: 42,
    });
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("retains consumed IP attempt on Store denial or failure", async () => {
    const consume = vi
      .fn<GuestSessionAbuseBudget["consume"]>()
      .mockResolvedValueOnce({ allowed: true, remaining: 19, retry_after_seconds: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, retry_after_seconds: 50 });
    expect(await setup(consume).consume(request)).toEqual({
      status: "RateLimited",
      retryAfterSeconds: 50,
    });
    expect(consume).toHaveBeenCalledTimes(2);
    consume
      .mockReset()
      .mockResolvedValueOnce({ allowed: true, remaining: 19, retry_after_seconds: 0 })
      .mockRejectedValueOnce(new Error("private dependency detail"));
    expect(await setup(consume).consume(request)).toEqual({ status: "Unavailable" });
    expect(consume).toHaveBeenCalledTimes(2);
  });
  it("WP-2423: with no true address only the Store's limit counts, never one shared key", async () => {
    const consume = vi
      .fn<GuestSessionAbuseBudget["consume"]>()
      .mockResolvedValue({ allowed: true, remaining: 3, retry_after_seconds: 0 });
    expect(await setup(consume).consume({ ...request, remoteAddress: null })).toEqual({
      status: "Allowed",
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0].limitCount).toBe(300);
  });
  it("WP-2423: one address at two Stores spends two budgets", () => {
    const provider = keys();
    expect(provider.ip("192.0.2.1", scope)).not.toEqual(
      provider.ip("192.0.2.1", {
        ...scope,
        storeReference: "0190ab20-0000-7000-8000-000000000099",
      }),
    );
  });
  it("fails closed before budget access for invalid peer or future request", async () => {
    const consume = vi.fn();
    for (const input of [
      { ...request, remoteAddress: "192.0.2.1, 192.0.2.2" },
      { ...request, remoteAddress: "fe80::1%eth0" },
      { ...request, requestedAt: "2026-09-19T12:00:01.000Z" },
    ])
      expect(await setup(consume).consume(input)).toEqual({ status: "Unavailable" });
    expect(consume).not.toHaveBeenCalled();
  });
  it("rejects malformed or impossible budget output", async () => {
    for (const result of [
      { allowed: true, remaining: 120, retry_after_seconds: 0 },
      { allowed: false, remaining: 0, retry_after_seconds: 601 },
      { allowed: true, remaining: 1, retry_after_seconds: 1 },
    ])
      expect(await setup(async () => result).consume(request)).toEqual({ status: "Unavailable" });
  });
});
describe("Guest abuse keyed scopes", () => {
  it("canonicalizes IPv4-mapped IPv6 and groups equivalent IPv6 /64 peers", () => {
    const provider = keys();
    expect(provider.ip("::ffff:192.0.2.1", scope)).toEqual(provider.ip("192.0.2.1", scope));
    expect(provider.ip("0:0:0:0:0:ffff:c000:201", scope)).toEqual(provider.ip("192.0.2.1", scope));
    expect(provider.ip("2001:db8:1:2::1", scope)).toEqual(
      provider.ip("2001:0DB8:0001:0002:ffff::abcd", scope),
    );
    expect(provider.ip("2001:db8:1:3::1", scope)).not.toEqual(
      provider.ip("2001:db8:1:2::1", scope),
    );
  });
  it("separates stores/peppers and copies the pepper", () => {
    const pepper = new Uint8Array(32).fill(1);
    const provider = createGuestSessionAbuseKeys(pepper);
    pepper.fill(0);
    expect(provider.ip("192.0.2.1", scope)).toEqual(keys().ip("192.0.2.1", scope));
    expect(provider.store(scope)).not.toEqual(
      provider.store({ ...scope, storeReference: scope.brandReference }),
    );
    expect(provider.ip("192.0.2.1", scope)).not.toEqual(
      createGuestSessionAbuseKeys(pepper).ip("192.0.2.1", scope),
    );
    expect(provider.ip("192.0.2.1", scope)).toHaveLength(32);
  });
});

// M02 (v15 07b7a1b7), WP-2423 (guest-waits-and-refund-lock): a phone at a table not open yet asks
// "is it open now?" every few seconds (apps/customer-pwa tableWaitCheckDelaysSeconds, which its own
// test holds to at most 70 checks in any ten minutes). Those checks have their own budget, with
// their own keys; the entry's budget pays only the scan and, once the table is open, one entry.
describe("waiting phones leave room for new guests", () => {
  const waitChecksPerPhone = 70;
  function windowBudget(): GuestSessionAbuseBudget["consume"] {
    const used = new Map<string, number>();
    return async ({ keyHash, limitCount }) => {
      const key = Buffer.from(keyHash).toString("hex");
      const count = used.get(key) ?? 0;
      if (count >= limitCount) return { allowed: false, remaining: 0, retry_after_seconds: 60 };
      used.set(key, count + 1);
      return { allowed: true, remaining: limitCount - count - 1, retry_after_seconds: 0 };
    };
  }
  it("eight parties waiting on the Wi-Fi and twenty-two on their own phones: a full room still gets in", async () => {
    const consume = windowBudget();
    const pepper = new Uint8Array(32).fill(1);
    const entry = createGuestSessionRequestAdmission({
      scope,
      keys: createGuestSessionAbuseKeys(pepper),
      now: () => at,
      budget: { consume },
    });
    const waiting = createGuestSessionRequestAdmission({
      scope,
      keys: createGuestSessionAbuseKeys(pepper, "table-wait"),
      now: () => at,
      budget: { consume },
      policy: guestTableWaitPolicy,
    });
    const wifi = "198.51.100.7";
    const phones = [
      ...Array.from({ length: 8 }, () => wifi),
      ...Array.from({ length: 22 }, (_, phone) => `203.0.113.${phone + 1}`),
    ];
    const answers: string[] = [];
    for (const address of phones) {
      answers.push((await entry.consume({ ...request, remoteAddress: address })).status);
      for (let check = 0; check < waitChecksPerPhone; check += 1)
        answers.push((await waiting.consume({ ...request, remoteAddress: address })).status);
      // Staff open the table: one ordinary entry.
      answers.push((await entry.consume({ ...request, remoteAddress: address })).status);
    }
    expect(answers.every((status) => status === "Allowed")).toBe(true);
    // A hundred new guests scanning on the same Wi-Fi in the same ten minutes all get in.
    for (let guest = 0; guest < 100; guest += 1)
      expect(await entry.consume({ ...request, remoteAddress: wifi })).toEqual({
        status: "Allowed",
      });
    // The checks are still bounded: a phone asking without end is told to wait.
    const alone = createGuestSessionRequestAdmission({
      scope,
      keys: createGuestSessionAbuseKeys(pepper, "table-wait"),
      now: () => at,
      budget: { consume: windowBudget() },
      policy: guestTableWaitPolicy,
    });
    let allowed = 0;
    while ((await alone.consume({ ...request, remoteAddress: "192.0.2.99" })).status === "Allowed")
      allowed += 1;
    expect(allowed).toBe(guestTableWaitPolicy.ipLimit);
  });
  it("keeps the waiting checks' keys apart from the entry's", () => {
    const pepper = new Uint8Array(32).fill(1);
    const entry = createGuestSessionAbuseKeys(pepper);
    const waiting = createGuestSessionAbuseKeys(pepper, "table-wait");
    expect(waiting.ip("192.0.2.1", scope)).not.toEqual(entry.ip("192.0.2.1", scope));
    expect(waiting.store(scope)).not.toEqual(entry.store(scope));
    expect(waiting.ip("192.0.2.1", scope)).toHaveLength(32);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createGuestSessionRequestAdmission,
  createGuestSessionAbuseKeys,
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
      [600, 20, at],
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
  it("fails closed before budget access for invalid peer or future request", async () => {
    const consume = vi.fn();
    for (const input of [
      { ...request, remoteAddress: null },
      { ...request, remoteAddress: "192.0.2.1, 192.0.2.2" },
      { ...request, remoteAddress: "fe80::1%eth0" },
      { ...request, requestedAt: "2026-09-19T12:00:01.000Z" },
    ])
      expect(await setup(consume).consume(input)).toEqual({ status: "Unavailable" });
    expect(consume).not.toHaveBeenCalled();
  });
  it("rejects malformed or impossible budget output", async () => {
    for (const result of [
      { allowed: true, remaining: 20, retry_after_seconds: 0 },
      { allowed: false, remaining: 0, retry_after_seconds: 601 },
      { allowed: true, remaining: 1, retry_after_seconds: 1 },
    ])
      expect(await setup(async () => result).consume(request)).toEqual({ status: "Unavailable" });
  });
});
describe("Guest abuse keyed scopes", () => {
  it("canonicalizes IPv4-mapped IPv6 and groups equivalent IPv6 /64 peers", () => {
    const provider = keys();
    expect(provider.ip("::ffff:192.0.2.1")).toEqual(provider.ip("192.0.2.1"));
    expect(provider.ip("0:0:0:0:0:ffff:c000:201")).toEqual(provider.ip("192.0.2.1"));
    expect(provider.ip("2001:db8:1:2::1")).toEqual(provider.ip("2001:0DB8:0001:0002:ffff::abcd"));
    expect(provider.ip("2001:db8:1:3::1")).not.toEqual(provider.ip("2001:db8:1:2::1"));
  });
  it("separates stores/peppers and copies the pepper", () => {
    const pepper = new Uint8Array(32).fill(1);
    const provider = createGuestSessionAbuseKeys(pepper);
    pepper.fill(0);
    expect(provider.ip("192.0.2.1")).toEqual(keys().ip("192.0.2.1"));
    expect(provider.store(scope)).not.toEqual(
      provider.store({ ...scope, storeReference: scope.brandReference }),
    );
    expect(provider.ip("192.0.2.1")).not.toEqual(
      createGuestSessionAbuseKeys(pepper).ip("192.0.2.1"),
    );
    expect(provider.ip("192.0.2.1")).toHaveLength(32);
  });
});

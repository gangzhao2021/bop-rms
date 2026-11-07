import { describe, expect, it } from "vitest";
import { createIdentityActor } from "../contracts/identity-actor.js";
import { parseCurrentWorkforceAccount } from "../contracts/current-workforce-account.js";
const id = "0190ed60-0000-7000-8000-000000000001";
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const input = () => ({
  profile: "CurrentWorkforceAccountV1",
  actorType: "User",
  actorReference: id,
  accountKind: "Workforce",
  status: "Active",
  observedAt: at,
  validUntil: until,
});
describe("current Workforce account identity", () => {
  it("returns detached frozen account facts without inventing login or MFA", () => {
    const raw = input(),
      fact = parseCurrentWorkforceAccount(raw);
    raw.actorReference = "changed";
    expect(fact.actorReference).toBe(id);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.keys(fact)).toEqual([
      "profile",
      "actorType",
      "actorReference",
      "accountKind",
      "status",
      "observedAt",
      "validUntil",
    ]);
    expect(() => createIdentityActor(fact)).toThrow();
  });
  it.each([
    "authenticatedAt",
    "recentMfaAt",
    "authenticationMethod",
    "verificationLevel",
    "sessionReference",
    "cookie",
    "subject",
    "email",
    "permission",
    "role",
  ])("rejects extra %s instead of asserting session/privilege facts", (key) => {
    expect(() => parseCurrentWorkforceAccount({ ...input(), [key]: "controlled-extra" })).toThrow();
  });
  it.each([
    { profile: "Other" },
    { actorType: "Service" },
    { accountKind: "Platform" },
    { accountKind: "Customer" },
    { status: "Suspended" },
    { status: "Disabled" },
    { status: "Merged" },
    { actorReference: null },
    { actorReference: "not-a-uuid" },
    { actorReference: id.toUpperCase() },
  ])("rejects wrong account fact %j", (patch) => {
    expect(() => parseCurrentWorkforceAccount({ ...input(), ...patch })).toThrow();
  });
  it.each([
    "0000-01-01T00:00:00.000Z",
    "infinity",
    "2026-10-06T12:00:00Z",
    "2026-10-06T12:00:00.0001Z",
    "2026-02-30T12:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
  ])("rejects invalid finite UTC instant %s", (value) => {
    for (const key of ["observedAt", "validUntil"])
      expect(() => parseCurrentWorkforceAccount({ ...input(), [key]: value })).toThrow();
  });
  it("requires positive interval bounded to five seconds, including supported endpoint years", () => {
    for (const validUntil of [at, "2026-10-06T11:59:59.999Z", "2026-10-06T12:00:05.001Z"])
      expect(() => parseCurrentWorkforceAccount({ ...input(), validUntil })).toThrow();
    expect(
      parseCurrentWorkforceAccount({
        ...input(),
        observedAt: "0001-01-01T00:00:00.000Z",
        validUntil: "0001-01-01T00:00:05.000Z",
      }).status,
    ).toBe("Active");
    expect(
      parseCurrentWorkforceAccount({
        ...input(),
        observedAt: "9999-12-31T23:59:54.999Z",
        validUntil: "9999-12-31T23:59:59.999Z",
      }).status,
    ).toBe("Active");
  });
  it("refuses missing, inherited and accessor facts without executing getters", () => {
    let calls = 0;
    const accessor = Object.defineProperty(input(), "actorReference", {
      enumerable: true,
      get() {
        calls++;
        return id;
      },
    });
    expect(() => parseCurrentWorkforceAccount(accessor)).toThrow();
    expect(calls).toBe(0);
    expect(() => parseCurrentWorkforceAccount(Object.create(input()))).toThrow();
    const { observedAt: discarded, ...missing } = input();
    void discarded;
    expect(() => parseCurrentWorkforceAccount(missing)).toThrow();
  });
});

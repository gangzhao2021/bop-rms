import { describe, expect, it } from "vitest";

import {
  diningJoinMaximumLifetimeMs,
  diningJoinNetworkDeviceFailureBudget,
  diningJoinSessionFailureBudget,
  diningJoinSiblingScope,
  evaluateDiningJoin,
  parseDiningJoinCapability,
  parseDiningJoinHumanCode,
  parseDiningJoinInvitationCredential,
  PublicCapabilityError,
  regenerateDiningJoinCapability,
} from "../index.js";

const refs = {
  capability: "018f0000-0000-7000-8000-000000001001",
  replacement: "018f0000-0000-7000-8000-000000001002",
  store: "018f0000-0000-7000-8000-000000001101",
  otherStore: "018f0000-0000-7000-8000-000000001102",
  table: "018f0000-0000-7000-8000-000000001201",
  otherTable: "018f0000-0000-7000-8000-000000001202",
  session: "018f0000-0000-7000-8000-000000001301",
  otherSession: "018f0000-0000-7000-8000-000000001302",
} as const;
const invitation = Buffer.alloc(16, 71).toString("base64url");
const fixedQrReference = "018f0000-0000-7000-8000-000000009999";
const hash = (fill: string): string => fill.repeat(64);

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityReference: refs.capability,
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: refs.store,
    tableReference: refs.table,
    diningSessionReference: refs.session,
    selectorHash: hash("a"),
    pepperVersion: 1,
    assignmentVersion: 4,
    generation: 1,
    status: "Active",
    version: 1,
    issuedAt: "2026-07-30T05:00:00.000Z",
    expiresAt: "2026-07-30T05:15:00.000Z",
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function evaluation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: capability(),
    purpose: "DiningJoin",
    storeReference: refs.store,
    tableReference: refs.table,
    diningSessionReference: refs.session,
    assignmentVersion: 4,
    generation: 1,
    selectorHash: hash("a"),
    sessionPhase: "Active",
    abuseDecision: "Admitted",
    observedAt: "2026-07-30T05:05:00.000Z",
    expectedVersion: 1,
    ...overrides,
  };
}

function expectInvalid(
  action: () => unknown,
  code: PublicCapabilityError["code"] = "PUBLIC_CAPABILITY_INPUT_INVALID",
): void {
  expect(action).toThrowError(
    expect.objectContaining<Partial<PublicCapabilityError>>({
      code,
    }),
  );
}

describe("Dining Join credential contract", () => {
  it("accepts only exact 128-bit invitations and six ASCII digits", () => {
    expect(parseDiningJoinInvitationCredential(invitation)).toBe(invitation);
    expect(Buffer.from(invitation, "base64url")).toHaveLength(16);
    expect(parseDiningJoinHumanCode("004219")).toBe("004219");
  });

  it.each([
    () => parseDiningJoinInvitationCredential(`${invitation}=`),
    () => parseDiningJoinInvitationCredential(Buffer.alloc(15, 1).toString("base64url")),
    () => parseDiningJoinInvitationCredential(fixedQrReference),
    () => parseDiningJoinHumanCode("12345"),
    () => parseDiningJoinHumanCode("１２３４５６"),
    () => parseDiningJoinHumanCode("123 456"),
  ])("rejects malformed credentials and fixed QR references", (action) => {
    expectInvalid(action);
  });

  it("publishes only the accepted abuse budgets", () => {
    expect(diningJoinSessionFailureBudget).toEqual({
      failures: 5,
      windowMs: 10 * 60 * 1000,
    });
    expect(diningJoinNetworkDeviceFailureBudget).toEqual({
      failures: 20,
      windowMs: 10 * 60 * 1000,
    });
    expect(diningJoinSessionFailureBudget).not.toHaveProperty("ip");
    expect(diningJoinNetworkDeviceFailureBudget).not.toHaveProperty("device");
  });
});

describe("Dining Join capability lifecycle", () => {
  it("enforces closed records and the 15-minute maximum", () => {
    expect(diningJoinMaximumLifetimeMs).toBe(15 * 60 * 1000);
    expect(parseDiningJoinCapability(capability())).toEqual(capability());
    expectInvalid(() =>
      parseDiningJoinCapability(capability({ expiresAt: "2026-07-30T05:15:00.001Z" })),
    );
    expectInvalid(() =>
      parseDiningJoinCapability(capability({ status: "Consumed", consumedAt: null })),
    );
    expectInvalid(() =>
      parseDiningJoinCapability(
        capability({ status: "Revoked", revokedAt: "2026-07-30T04:59:59.999Z" }),
      ),
    );
    expectInvalid(() => parseDiningJoinCapability({ ...capability(), rawCredential: invitation }));
  });

  it("rejects accessor, symbol, array, null, and non-plain inputs", () => {
    const accessor = capability();
    Object.defineProperty(accessor, "status", { get: () => "Active", enumerable: true });
    const symbol = capability();
    Object.defineProperty(symbol, Symbol("raw"), { value: invitation });
    for (const candidate of [
      accessor,
      symbol,
      [],
      null,
      Object.assign(Object.create({ inherited: true }), capability()),
    ]) {
      expectInvalid(() => parseDiningJoinCapability(candidate));
    }
  });

  it("consumes one exact admitted capability without returning authority", () => {
    const result = evaluateDiningJoin(evaluation());
    expect(result).toEqual({
      decision: "Allowed",
      capability: {
        ...capability(),
        status: "Consumed",
        version: 2,
        consumedAt: "2026-07-30T05:05:00.000Z",
      },
    });
    expect(result).not.toHaveProperty("participant");
    expect(result).not.toHaveProperty("host");
    expect(result).not.toHaveProperty("order");
    expect(JSON.stringify(result)).not.toContain(invitation);
  });

  it.each([
    [
      "consumed replay",
      {
        capability: capability({
          status: "Consumed",
          consumedAt: "2026-07-30T05:04:00.000Z",
        }),
      },
      "StatusUnavailable",
    ],
    [
      "revoked",
      {
        capability: capability({
          status: "Revoked",
          revokedAt: "2026-07-30T05:04:00.000Z",
        }),
      },
      "StatusUnavailable",
    ],
    ["materialized expiry", { capability: capability({ status: "Expired" }) }, "StatusUnavailable"],
    ["Closing", { sessionPhase: "Closing" }, "SessionUnavailable"],
    ["Closed", { sessionPhase: "Closed" }, "SessionUnavailable"],
    ["Cancelled", { sessionPhase: "Cancelled" }, "SessionUnavailable"],
    ["cooldown", { abuseDecision: "Cooldown" }, "Cooldown"],
    ["before issue", { observedAt: "2026-07-30T04:59:59.999Z" }, "StatusUnavailable"],
    ["at expiry", { observedAt: "2026-07-30T05:15:00.000Z" }, "Expired"],
    ["wrong version", { expectedVersion: 2 }, "VersionMismatch"],
    ["wrong purpose", { purpose: "PickupHandoff" }, "ScopeMismatch"],
    ["wrong Store", { storeReference: refs.otherStore }, "ScopeMismatch"],
    ["wrong Table", { tableReference: refs.otherTable }, "ScopeMismatch"],
    ["wrong Session", { diningSessionReference: refs.otherSession }, "ScopeMismatch"],
    ["reassigned Table", { assignmentVersion: 5 }, "AssignmentMismatch"],
    ["prior generation", { generation: 0 }, "GenerationMismatch"],
    ["wrong selector", { selectorHash: hash("b") }, "SelectorMismatch"],
  ])("fails closed for %s", (_name, overrides, reason) => {
    expect(evaluateDiningJoin(evaluation(overrides))).toEqual({
      decision: "Unavailable",
      reason,
    });
  });

  it("rejects an absent or malformed abuse decision", () => {
    expectInvalid(() => evaluateDiningJoin(evaluation({ abuseDecision: "Unknown" })));
  });

  it("exposes a stable sibling scope without credential material", () => {
    expect(diningJoinSiblingScope(capability())).toEqual({
      purpose: "DiningJoin",
      storeReference: refs.store,
      tableReference: refs.table,
      diningSessionReference: refs.session,
    });
  });

  it("regenerates only exact next-generation fresh evidence", () => {
    const replacement = capability({
      capabilityReference: refs.replacement,
      selectorHash: hash("b"),
      generation: 2,
      issuedAt: "2026-07-30T05:06:00.000Z",
      expiresAt: "2026-07-30T05:21:00.000Z",
    });
    const result = regenerateDiningJoinCapability({
      previous: capability(),
      replacement,
      observedAt: "2026-07-30T05:06:00.000Z",
    });
    expect(result.previous).toMatchObject({
      status: "Revoked",
      version: 2,
      revokedAt: "2026-07-30T05:06:00.000Z",
    });
    expect(result.current).toEqual(replacement);
  });

  it.each([
    { generation: 1 },
    { generation: 3 },
    { capabilityReference: refs.capability },
    { selectorHash: hash("a") },
    { storeReference: refs.otherStore },
    { tableReference: refs.otherTable },
    { diningSessionReference: refs.otherSession },
    { assignmentVersion: 5 },
  ])("rejects unsafe regeneration %#", (replacementOverride) => {
    expectInvalid(
      () =>
        regenerateDiningJoinCapability({
          previous: capability(),
          replacement: capability({
            capabilityReference: refs.replacement,
            selectorHash: hash("b"),
            generation: 2,
            issuedAt: "2026-07-30T05:06:00.000Z",
            expiresAt: "2026-07-30T05:21:00.000Z",
            ...replacementOverride,
          }),
          observedAt: "2026-07-30T05:06:00.000Z",
        }),
      "PUBLIC_CAPABILITY_STATE_INVALID",
    );
  });
});

describe("WP-2276 fresh generation after consumption and expiry", () => {
  const replacement = (
    instant = "2026-07-30T05:16:00.000Z",
    overrides: Record<string, unknown> = {},
  ) =>
    capability({
      capabilityReference: refs.replacement,
      selectorHash: hash("b"),
      generation: 2,
      issuedAt: instant,
      expiresAt: "2026-07-30T05:31:00.000Z",
      ...overrides,
    });
  it.each(["Consumed", "Expired"] as const)(
    "preserves %s terminal history while issuing a fresh capability",
    (status) => {
      const previous = capability({
        status,
        version: 2,
        consumedAt: status === "Consumed" ? "2026-07-30T05:05:00.000Z" : null,
      });
      const result = regenerateDiningJoinCapability({
        previous,
        replacement: replacement(),
        observedAt: "2026-07-30T05:16:00.000Z",
      });
      expect(result.previous).toEqual(previous);
      expect(Object.isFrozen(result.previous)).toBe(true);
      expect(result.current).toMatchObject({
        status: "Active",
        version: 1,
        generation: 2,
        capabilityReference: refs.replacement,
      });
    },
  );
  it("revokes a clock-expired Active record without extending the old expiry", () => {
    const result = regenerateDiningJoinCapability({
      previous: capability(),
      replacement: replacement(),
      observedAt: "2026-07-30T05:16:00.000Z",
    });
    expect(result.previous).toMatchObject({
      status: "Revoked",
      version: 2,
      expiresAt: "2026-07-30T05:15:00.000Z",
      revokedAt: "2026-07-30T05:16:00.000Z",
    });
    expect(result.current.expiresAt).toBe("2026-07-30T05:31:00.000Z");
  });
  it.each([
    { status: "Revoked", version: 2, revokedAt: "2026-07-30T05:05:00.000Z" },
    { status: "Consumed", version: 2, consumedAt: "2026-07-30T05:07:00.000Z" },
    { status: "Expired", version: 2 },
  ])("rejects revoked or future terminal evidence %#", (previous) => {
    expectInvalid(
      () =>
        regenerateDiningJoinCapability({
          previous: capability(previous),
          replacement: replacement("2026-07-30T05:06:00.000Z", {
            expiresAt: "2026-07-30T05:21:00.000Z",
          }),
          observedAt: "2026-07-30T05:06:00.000Z",
        }),
      "PUBLIC_CAPABILITY_STATE_INVALID",
    );
  });
  it.each([
    { generation: 1 },
    { generation: 3 },
    { version: 2 },
    { capabilityReference: refs.capability },
    { selectorHash: hash("a") },
    { storeReference: refs.otherStore },
    { tableReference: refs.otherTable },
    { diningSessionReference: refs.otherSession },
    { assignmentVersion: 5 },
  ])("retains fresh-generation boundaries for terminal predecessors %#", (override) => {
    expectInvalid(
      () =>
        regenerateDiningJoinCapability({
          previous: capability({
            status: "Consumed",
            version: 2,
            consumedAt: "2026-07-30T05:05:00.000Z",
          }),
          replacement: replacement(undefined, override),
          observedAt: "2026-07-30T05:16:00.000Z",
        }),
      "PUBLIC_CAPABILITY_STATE_INVALID",
    );
  });
});

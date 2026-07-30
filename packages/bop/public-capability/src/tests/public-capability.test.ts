import { describe, expect, it } from "vitest";

import {
  evaluateOrderResume,
  evaluatePickupProof,
  moduleManifest,
  orderResumeMaximumActiveSiblings,
  orderResumeMaximumLifetimeMs,
  orderResumeSiblingScope,
  parseCanonicalInstant,
  parseOrderResumeCapability,
  parseOrderResumeRawCredential,
  parsePickupHumanCode,
  parsePickupOpaqueRawCredential,
  parsePickupProofCapability,
  parsePublicCapabilitySelectorHash,
  parsePublicOrderReference,
  pickupProofMaximumLifetimeMs,
  PublicCapabilityError,
  regeneratePickupProof,
} from "../index.js";

const reference = (fill: number): string => Buffer.alloc(16, fill).toString("base64url");
const rawResume = Buffer.alloc(32, 31).toString("base64url");
const rawPickup = Buffer.alloc(16, 47).toString("base64url");
const hash = (fill: string): string => fill.repeat(64);

const refs = {
  capability: "018f0000-0000-7000-8000-000000000101",
  replacementCapability: "018f0000-0000-7000-8000-000000000102",
  store: "018f0000-0000-7000-8000-000000000201",
  otherStore: "018f0000-0000-7000-8000-000000000202",
  order: "018f0000-0000-7000-8000-000000000301",
  otherOrder: "018f0000-0000-7000-8000-000000000302",
  fulfillment: "018f0000-0000-7000-8000-000000000401",
  otherFulfillment: "018f0000-0000-7000-8000-000000000402",
} as const;

const publicOrderReference = reference(11);
const otherPublicOrderReference = reference(12);

function resume(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityReference: refs.capability,
    purpose: "OrderResume",
    storeReference: refs.store,
    orderReference: refs.order,
    publicOrderReference,
    selectorHash: hash("a"),
    pepperVersion: 1,
    status: "Active",
    version: 1,
    issuedAt: "2026-07-29T05:00:00.000Z",
    expiresAt: "2026-07-29T05:30:00.000Z",
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function resumeEvaluation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: resume(),
    purpose: "OrderResume",
    storeReference: refs.store,
    orderReference: refs.order,
    publicOrderReference,
    selectorHash: hash("a"),
    observedAt: "2026-07-29T05:10:00.000Z",
    expectedVersion: 1,
    ...overrides,
  };
}

function pickup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilityReference: refs.capability,
    purpose: "PickupHandoff",
    kind: "Opaque",
    storeReference: refs.store,
    fulfillmentReference: refs.fulfillment,
    publicOrderReference,
    selectorHash: hash("b"),
    pepperVersion: 1,
    generation: 1,
    status: "Active",
    version: 1,
    readyAt: "2026-07-29T05:00:00.000Z",
    expiresAt: "2026-07-29T06:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function pickupEvaluation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: pickup(),
    storeReference: refs.store,
    fulfillmentReference: refs.fulfillment,
    generation: 1,
    selectorHash: hash("b"),
    fulfillmentState: "Ready",
    observedAt: "2026-07-29T05:10:00.000Z",
    expectedVersion: 1,
    ...overrides,
  };
}

function expectInputInvalid(action: () => unknown): void {
  expect(action).toThrowError(
    expect.objectContaining<Partial<PublicCapabilityError>>({
      code: "PUBLIC_CAPABILITY_INPUT_INVALID",
    }),
  );
}

describe("public capability credential grammar", () => {
  it("accepts only canonical fixed-width public and raw credentials", () => {
    expect(parsePublicOrderReference(publicOrderReference)).toBe(publicOrderReference);
    expect(parseOrderResumeRawCredential(rawResume)).toBe(rawResume);
    expect(parsePickupOpaqueRawCredential(rawPickup)).toBe(rawPickup);
    expect(parsePickupHumanCode("004219")).toBe("004219");
    expect(parsePublicCapabilitySelectorHash(hash("a"))).toBe(hash("a"));

    expect(Buffer.from(publicOrderReference, "base64url")).toHaveLength(16);
    expect(Buffer.from(rawResume, "base64url")).toHaveLength(32);
    expect(Buffer.from(rawPickup, "base64url")).toHaveLength(16);
    expect(publicOrderReference).not.toBe(hash("a"));
  });

  it.each([
    () => parsePublicOrderReference(`${publicOrderReference}=`),
    () => parsePublicOrderReference(reference(1).slice(1)),
    () => parseOrderResumeRawCredential(reference(1)),
    () => parsePickupOpaqueRawCredential(rawResume),
    () => parsePickupHumanCode("12345"),
    () => parsePickupHumanCode("１２３４５６"),
    () => parsePublicCapabilitySelectorHash("A".repeat(64)),
    () => parseCanonicalInstant("2026-07-29T05:00:00Z"),
  ])("rejects malformed or non-canonical credential input", (action) => {
    expectInputInvalid(action);
  });

  it("rejects open, accessor, symbol, array, null, and non-plain records", () => {
    const accessor = resume();
    Object.defineProperty(accessor, "status", { get: () => "Active", enumerable: true });
    const symbolRecord = resume();
    Object.defineProperty(symbolRecord, Symbol("raw"), { value: rawResume });

    for (const candidate of [
      { ...resume(), rawCredential: rawResume },
      Object.fromEntries(Object.entries(resume()).filter(([key]) => key !== "selectorHash")),
      accessor,
      symbolRecord,
      [],
      null,
      Object.assign(Object.create({ inherited: true }), resume()),
    ]) {
      expectInputInvalid(() => parseOrderResumeCapability(candidate));
    }
  });
});

describe("Order Resume capability", () => {
  it("enforces lifecycle invariants and the 30-minute maximum", () => {
    expect(orderResumeMaximumLifetimeMs).toBe(30 * 60 * 1000);
    expect(parseOrderResumeCapability(resume())).toEqual(resume());
    expectInputInvalid(() =>
      parseOrderResumeCapability(resume({ expiresAt: "2026-07-29T05:30:00.001Z" })),
    );
    expectInputInvalid(() =>
      parseOrderResumeCapability(resume({ status: "Consumed", consumedAt: null })),
    );
    expectInputInvalid(() =>
      parseOrderResumeCapability(
        resume({ status: "Revoked", revokedAt: "2026-07-29T04:59:59.999Z" }),
      ),
    );
    expect(parseOrderResumeCapability(resume({ status: "Expired" }))).toMatchObject({
      status: "Expired",
      consumedAt: null,
      revokedAt: null,
    });
  });

  it("consumes once and returns only a server-derived clean path", () => {
    const decision = evaluateOrderResume(resumeEvaluation());
    expect(decision).toEqual({
      decision: "Allowed",
      capability: {
        ...resume(),
        status: "Consumed",
        version: 2,
        consumedAt: "2026-07-29T05:10:00.000Z",
      },
      redirectPath: `/orders/${publicOrderReference}`,
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(JSON.stringify(decision)).not.toContain(rawResume);
    expect(decision).not.toHaveProperty("redirect");
    if (decision.decision === "Allowed") {
      expect(Object.isFrozen(decision.capability)).toBe(true);
    }
  });

  it.each([
    [
      "Consumed replay",
      { capability: resume({ status: "Consumed", consumedAt: "2026-07-29T05:05:00.000Z" }) },
      "StatusUnavailable",
    ],
    [
      "Revoked",
      { capability: resume({ status: "Revoked", revokedAt: "2026-07-29T05:05:00.000Z" }) },
      "StatusUnavailable",
    ],
    ["materialized expiry", { capability: resume({ status: "Expired" }) }, "StatusUnavailable"],
    ["before issue", { observedAt: "2026-07-29T04:59:59.999Z" }, "StatusUnavailable"],
    ["at expiry", { observedAt: "2026-07-29T05:30:00.000Z" }, "Expired"],
    ["wrong version", { expectedVersion: 2 }, "VersionMismatch"],
    ["wrong purpose", { purpose: "PickupHandoff" }, "ScopeMismatch"],
    ["wrong Store", { storeReference: refs.otherStore }, "ScopeMismatch"],
    ["wrong Order", { orderReference: refs.otherOrder }, "ScopeMismatch"],
    [
      "wrong public reference",
      { publicOrderReference: otherPublicOrderReference },
      "ScopeMismatch",
    ],
    ["wrong selector", { selectorHash: hash("c") }, "SelectorMismatch"],
  ])("fails closed for %s", (_name, overrides, reason) => {
    expect(evaluateOrderResume(resumeEvaluation(overrides))).toEqual({
      decision: "Unavailable",
      reason,
    });
  });

  it("exposes only a stable sibling scope and the two-sibling limit", () => {
    expect(orderResumeMaximumActiveSiblings).toBe(2);
    expect(orderResumeSiblingScope(resume())).toEqual({
      purpose: "OrderResume",
      storeReference: refs.store,
      orderReference: refs.order,
    });
  });
});

describe("Pickup Proof capability", () => {
  it("enforces the 60-minute Ready lifetime and closed lifecycle", () => {
    expect(pickupProofMaximumLifetimeMs).toBe(60 * 60 * 1000);
    expect(parsePickupProofCapability(pickup())).toEqual(pickup());
    expectInputInvalid(() =>
      parsePickupProofCapability(pickup({ expiresAt: "2026-07-29T06:00:00.001Z" })),
    );
    expectInputInvalid(() =>
      parsePickupProofCapability(
        pickup({ status: "Active", revokedAt: "2026-07-29T05:10:00.000Z" }),
      ),
    );
    expectInputInvalid(() => parsePickupProofCapability(pickup({ kind: "HumanReadable" })));
  });

  it("returns proof evidence without completion or override authority", () => {
    const decision = evaluatePickupProof(pickupEvaluation());
    expect(decision).toEqual({
      decision: "Allowed",
      capabilityReference: refs.capability,
      generation: 1,
    });
    expect(decision).not.toHaveProperty("complete");
    expect(decision).not.toHaveProperty("managerOverride");
    expect(JSON.stringify(decision)).not.toContain(rawPickup);
  });

  it.each([
    [
      "revoked",
      { capability: pickup({ status: "Revoked", revokedAt: "2026-07-29T05:05:00.000Z" }) },
      "StatusUnavailable",
    ],
    ["Pending", { fulfillmentState: "Pending" }, "NotReady"],
    ["Completed", { fulfillmentState: "Completed" }, "NotReady"],
    ["Cancelled", { fulfillmentState: "Cancelled" }, "NotReady"],
    ["before Ready", { observedAt: "2026-07-29T04:59:59.999Z" }, "NotReady"],
    ["at expiry", { observedAt: "2026-07-29T06:00:00.000Z" }, "Expired"],
    ["wrong version", { expectedVersion: 2 }, "VersionMismatch"],
    ["wrong Store", { storeReference: refs.otherStore }, "ScopeMismatch"],
    ["wrong Fulfillment", { fulfillmentReference: refs.otherFulfillment }, "ScopeMismatch"],
    ["prior generation", { generation: 0 }, "GenerationMismatch"],
    ["wrong selector", { selectorHash: hash("c") }, "SelectorMismatch"],
  ])("fails closed for %s", (_name, overrides, reason) => {
    expect(evaluatePickupProof(pickupEvaluation(overrides))).toEqual({
      decision: "Unavailable",
      reason,
    });
  });

  it("regenerates only with the exact next generation and fresh proof evidence", () => {
    const result = regeneratePickupProof({
      previous: pickup(),
      replacement: pickup({
        capabilityReference: refs.replacementCapability,
        selectorHash: hash("c"),
        generation: 2,
        readyAt: "2026-07-29T05:15:00.000Z",
        expiresAt: "2026-07-29T06:15:00.000Z",
      }),
      observedAt: "2026-07-29T05:15:00.000Z",
    });
    expect(result.previous).toMatchObject({
      status: "Revoked",
      version: 2,
      revokedAt: "2026-07-29T05:15:00.000Z",
    });
    expect(result.current).toMatchObject({
      capabilityReference: refs.replacementCapability,
      generation: 2,
      status: "Active",
    });
  });

  it.each([
    { generation: 1 },
    { generation: 3 },
    { capabilityReference: refs.capability },
    { selectorHash: hash("b") },
    { storeReference: refs.otherStore },
    { fulfillmentReference: refs.otherFulfillment },
    { publicOrderReference: otherPublicOrderReference },
    { kind: "HumanCode" },
  ])("rejects invalid regeneration replacement %#", (replacementOverride) => {
    expect(() =>
      regeneratePickupProof({
        previous: pickup(),
        replacement: pickup({
          capabilityReference: refs.replacementCapability,
          selectorHash: hash("c"),
          generation: 2,
          readyAt: "2026-07-29T05:15:00.000Z",
          expiresAt: "2026-07-29T06:15:00.000Z",
          ...replacementOverride,
        }),
        observedAt: "2026-07-29T05:15:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PublicCapabilityError>>({
        code: "PUBLIC_CAPABILITY_STATE_INVALID",
      }),
    );
  });

  it("classifies credential material and keeps it out of metadata and errors", () => {
    expect(moduleManifest.piiClassification.classes).toContain("credential");
    expect(moduleManifest.piiClassification.handling).toMatchObject({
      logs: "prohibited",
      urls: "prohibited",
      analytics: "prohibited",
    });
    try {
      parseOrderResumeRawCredential("not-a-token");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicCapabilityError);
      expect(JSON.stringify(error)).not.toContain("not-a-token");
    }
    expect(JSON.stringify(moduleManifest)).not.toContain(rawResume);
    expect(JSON.stringify(moduleManifest)).not.toContain(rawPickup);
  });
});

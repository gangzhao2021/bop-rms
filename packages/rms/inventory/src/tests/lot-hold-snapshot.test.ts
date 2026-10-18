import { describe, it, expect } from "vitest";
import { createLotHold, releaseLot, quarantineLot } from "../domain/lot-hold.js";
import { parseLotHoldSnapshot } from "../domain/lot-hold-snapshot.js";

const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-09-11T10:00:00.000Z";
function hold() {
  return createLotHold({
    holdReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    stockScope: { scopeType: "Location", scopeReference: id(4) as never },
    locationReference: id(4),
    itemReference: id(5),
    lotReference: id(6),
    expiryDate: "2026-09-20",
    onHand: "999999999999999999.000001",
    reserved: "0",
    balanceVersion: 1,
    reasonCode: "SYNTHETIC_HOLD",
    complianceDecisionReference: id(7),
    actorReference: id(8),
    occurredAt: now,
  });
}
function release() {
  return releaseLot(hold(), {
    expectedVersion: 1,
    reasonCode: "SYNTHETIC_RELEASE",
    complianceDecisionReference: id(9),
    onHand: "2",
    reserved: "1",
    balanceVersion: 2,
    actorReference: id(8),
    occurredAt: "2026-09-11T11:00:00.000Z",
  });
}
function snapshot() {
  return JSON.parse(JSON.stringify(release())) as Record<string, unknown>;
}
describe("persisted Lot Hold replay", () => {
  it("rebuilds initial quarantine and the complete release/requarantine history", () => {
    const released = release();
    const quarantined = quarantineLot(released, {
      expectedVersion: 2,
      reasonCode: "SYNTHETIC_REHOLD",
      complianceDecisionReference: id(10),
      onHand: "2",
      reserved: "1",
      balanceVersion: 2,
      actorReference: id(8),
      occurredAt: "2026-09-11T12:00:00.000Z",
    });
    for (const value of [hold(), released, quarantined])
      expect(parseLotHoldSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it("detaches and freezes nested scope and decisions without changing decimals", () => {
    const source = JSON.parse(JSON.stringify(hold())) as { decisions: { onHand: string }[] };
    const decoded = parseLotHoldSnapshot(source);
    for (const decision of source.decisions) decision.onHand = "0";
    expect(decoded.onHand).toBe("999999999999999999.000001");
    for (const value of [decoded, decoded.stockScope, decoded.decisions, decoded.decisions[0]])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it.each([
    { status: "Quarantined" },
    { aggregateVersion: 1 },
    { onHand: "3" },
    { reserved: "0" },
    { balanceVersion: 1 },
    { createdAt: "2026-09-11T11:00:00.000Z" },
    { updatedBy: id(99) },
    { decisions: [] },
    { unexpected: true },
  ])("rejects final state mismatching history %j", (change) => {
    expect(() => parseLotHoldSnapshot({ ...snapshot(), ...change })).toThrow(
      "Lot hold operation failed",
    );
  });
  it("rejects a history that starts with release or repeats quarantine", () => {
    const initial = hold();
    expect(() =>
      parseLotHoldSnapshot({
        ...initial,
        decisions: [{ ...initial.decisions[0], decision: "Released" }],
      }),
    ).toThrow();
    expect(() =>
      parseLotHoldSnapshot({
        ...initial,
        aggregateVersion: 2,
        decisions: [...initial.decisions, ...initial.decisions],
      }),
    ).toThrow();
  });
  it.each([
    { occurredAt: "2026-09-11T09:00:00.000Z" },
    { balanceVersion: 0 },
    { complianceDecisionReference: "missing" },
  ])("rejects backward or invalid decision %j", (change) => {
    const current = release();
    expect(() =>
      parseLotHoldSnapshot({
        ...current,
        decisions: [current.decisions[0], { ...current.decisions[1], ...change }],
      }),
    ).toThrow();
  });
  it("rejects hidden/accessor and sparse history without executing getters", () => {
    let reads = 0;
    const current = snapshot();
    Object.defineProperty(current, "status", {
      enumerable: true,
      get() {
        reads += 1;
        return "Available";
      },
    });
    expect(() => parseLotHoldSnapshot(current)).toThrow();
    expect(reads).toBe(0);
    expect(() => parseLotHoldSnapshot({ ...snapshot(), decisions: new Array(1) })).toThrow();
  });
  it("rejects a scope that claims a different Location", () => {
    expect(() =>
      parseLotHoldSnapshot({
        ...snapshot(),
        stockScope: { scopeType: "Location", scopeReference: id(99) },
      }),
    ).toThrow();
  });
});

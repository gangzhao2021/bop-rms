import { describe, it, expect } from "vitest";
import {
  summarizeOrderItemProgress,
  resolveOrderItemDeliveryProgress,
  type OrderItemProgressPhase,
} from "../domain/order-item-progress.js";

const facts = (phases: OrderItemProgressPhase[]) =>
  phases.map((phase, i) => ({
    orderItemReference: "01909989-0000-7000-8000-" + (i + 1).toString(16).padStart(12, "0"),
    phase,
    everAccepted: ["Accepted", "InProgress", "Ready", "Fulfilled"].includes(phase),
    everStarted: ["InProgress", "Ready", "Fulfilled"].includes(phase),
  }));
describe("accepted multi-batch item phase rules", () => {
  it.each<[OrderItemProgressPhase[], OrderItemProgressPhase]>([
    [["Submitted", "Submitted"], "Submitted"],
    [["Accepted", "Submitted"], "Accepted"],
    [["InProgress", "Submitted"], "InProgress"],
    [["Ready", "Submitted"], "InProgress"],
    [["Fulfilled", "Submitted"], "InProgress"],
    [["Fulfilled", "Ready"], "Ready"],
    [["Fulfilled", "Fulfilled"], "Fulfilled"],
    [["Cancelled", "Ready"], "Ready"],
    [["Rejected", "Rejected"], "Rejected"],
    [["Cancelled", "Rejected"], "Cancelled"],
  ])("combines %j as %s without mutating facts", (phases, expected) => {
    const items = facts(phases);
    const before = structuredClone(items);
    expect(summarizeOrderItemProgress(items).phase).toBe(expected);
    expect(items).toEqual(before);
  });
  it("retains accepted/started history of terminated items", () => {
    const items = facts(["Cancelled", "Submitted"]);
    if (!items[0]) throw new Error("fixture");
    items[0] = { ...items[0], everAccepted: true, everStarted: true };
    expect(summarizeOrderItemProgress(items)).toEqual({
      phase: "Submitted",
      everAccepted: true,
      everStarted: true,
    });
    expect(summarizeOrderItemProgress([{ ...items[0], phase: "Rejected" }]).phase).toBe(
      "Cancelled",
    );
  });
  it("rejects empty, duplicate and contradictory facts", () => {
    expect(() => summarizeOrderItemProgress([])).toThrow();
    const one = facts(["Ready"])[0];
    if (!one) throw new Error("fixture");
    expect(() => summarizeOrderItemProgress([one, one])).toThrow();
    expect(() => summarizeOrderItemProgress([{ ...one, everAccepted: false }])).toThrow();
    expect(() =>
      summarizeOrderItemProgress([{ ...one, phase: "InProgress", everStarted: false }]),
    ).toThrow();
  });
});

it("does not invent preparation history for non-kitchen items", () => {
  const items = facts(["Fulfilled", "Submitted"]);
  const delivered = items[0];
  if (!delivered) throw new Error("fixture");
  items[0] = { ...delivered, everStarted: false };
  expect(summarizeOrderItemProgress(items)).toEqual({
    phase: "InProgress",
    everAccepted: true,
    everStarted: false,
  });
  expect(summarizeOrderItemProgress([items[0]])).toEqual({
    phase: "Fulfilled",
    everAccepted: true,
    everStarted: false,
  });
});

describe("item delivery quantity", () => {
  const ready = facts(["Ready"])[0];
  if (!ready) throw new Error("fixture");
  it.each([0, 1, 2])("retains Ready until all quantity is delivered: %i", (quantity) => {
    const result = resolveOrderItemDeliveryProgress({
      ...ready,
      orderedQuantity: 2,
      deliveredQuantity: quantity,
    });
    expect(result.phase).toBe(quantity === 2 ? "Fulfilled" : "Ready");
    expect(result.remainingQuantity).toBe(2 - quantity);
  });
  it.each([-1, 0.5, 3, Number.NaN])("rejects invalid delivered quantity %s", (quantity) => {
    expect(() =>
      resolveOrderItemDeliveryProgress({
        ...ready,
        orderedQuantity: 2,
        deliveredQuantity: quantity,
      }),
    ).toThrow();
  });
  it("rejects service before readiness and incomplete Fulfilled facts", () => {
    expect(() =>
      resolveOrderItemDeliveryProgress({
        ...ready,
        phase: "Accepted",
        orderedQuantity: 2,
        deliveredQuantity: 1,
      }),
    ).toThrow();
    expect(() =>
      resolveOrderItemDeliveryProgress({
        ...ready,
        phase: "Fulfilled",
        orderedQuantity: 2,
        deliveredQuantity: 1,
      }),
    ).toThrow();
  });
});

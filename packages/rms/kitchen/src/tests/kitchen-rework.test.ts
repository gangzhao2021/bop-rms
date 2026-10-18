import { describe, expect, it } from "vitest";
import {
  createKitchenReworkCreatedEnvelope,
  KitchenReworkError,
  kitchenReworkWasteApplies,
  parseKitchenReworkCommand,
  parseKitchenReworkCreatedEnvelope,
} from "../index.js";

const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const create = {
  action: "CreateKitchenRework",
  idempotencyKey: id(1),
  originalWorkItemReference: id(2),
  reasonCode: "DROPPED",
  note: null,
  quantity: 1,
  correlationReference: id(3),
};
const code = (work: () => unknown) => {
  try {
    work();
    return "accepted";
  } catch (error) {
    return error instanceof KitchenReworkError ? error.code : "other";
  }
};

describe("WP-2423 Q26 Kitchen rework (Handoff Section 26.6)", () => {
  it("accepts a closed remake command and refuses anything else", () => {
    expect(parseKitchenReworkCommand(create)).toEqual(create);
    expect(
      parseKitchenReworkCommand({ ...create, reasonCode: "OTHER", note: "Guest changed sides" }),
    ).toMatchObject({ reasonCode: "OTHER", note: "Guest changed sides" });
    for (const invalid of [
      { ...create, reasonCode: "OTHER" },
      { ...create, reasonCode: "CUSTOMER_REQUEST" },
      { ...create, quantity: 0 },
      { ...create, quantity: 1.5 },
      { ...create, note: " padded" },
      { ...create, note: "x".repeat(201) },
      { ...create, note: "bell\u0007" },
      { ...create, actorReference: id(4) },
      { ...create, storeReference: id(5) },
      { ...create, correlationReference: id(1) },
      { ...create, originalWorkItemReference: "not-a-reference" },
    ])
      expect(code(() => parseKitchenReworkCommand(invalid))).toBe("KITCHEN_REWORK_INPUT_INVALID");
    const start = {
      action: "StartKitchenRework",
      idempotencyKey: id(6),
      reworkReference: id(7),
      expectedVersion: 1,
      correlationReference: id(8),
    };
    expect(parseKitchenReworkCommand(start)).toEqual(start);
    expect(code(() => parseKitchenReworkCommand({ ...start, expectedVersion: 3 }))).toBe(
      "KITCHEN_REWORK_INPUT_INVALID",
    );
    expect(code(() => parseKitchenReworkCommand({ ...start, action: "UndoReady" }))).toBe(
      "KITCHEN_REWORK_INPUT_INVALID",
    );
  });

  it("wastes the first dish unless it was only marked done too early", () => {
    for (const reason of [
      "WRONG_ITEM",
      "DROPPED",
      "CUSTOMER_RETURNED",
      "QUALITY_ISSUE",
      "OTHER",
    ] as const)
      expect(kitchenReworkWasteApplies(reason), reason).toBe(true);
    expect(kitchenReworkWasteApplies("NOT_READY")).toBe(false);
  });

  it("publishes a minimal, truthful KitchenReworkCreated event without staff notes", () => {
    const payload = {
      kitchenReworkItemReference: id(10),
      kitchenTicketReference: id(11),
      originalKitchenWorkItemReference: id(12),
      orderReference: id(13),
      orderBatchReference: id(14),
      orderItemReference: id(15),
      reasonCode: "CUSTOMER_RETURNED" as const,
      quantity: 2,
      wasteApplies: true,
      createdAt: "2026-10-14T12:00:00.000Z",
    };
    const input = {
      eventReference: id(16),
      operationReference: id(17),
      correlationReference: id(18),
      actorReference: id(19),
      brandReference: id(20),
      storeReference: id(21),
      payload,
    };
    const envelope = createKitchenReworkCreatedEnvelope(input);
    expect(envelope).toMatchObject({
      eventType: "KitchenReworkCreated",
      aggregateType: "KitchenReworkItem",
      aggregateId: id(10),
      aggregateVersion: 1n,
      tenantId: id(20),
      actor: { type: "Actor", actorId: id(19) },
    });
    expect(parseKitchenReworkCreatedEnvelope({ ...envelope })).toEqual(envelope);
    for (const broken of [
      { ...payload, wasteApplies: false },
      { ...payload, reasonCode: "NOT_READY" as const },
      { ...payload, note: "secret" },
      { ...payload, quantity: 1000 },
    ])
      expect(() =>
        createKitchenReworkCreatedEnvelope({ ...input, payload: broken as typeof payload }),
      ).toThrow();
    expect(() =>
      parseKitchenReworkCreatedEnvelope({ ...envelope, occurredAt: "2026-10-14T12:00:01.000Z" }),
    ).toThrow();
  });
});

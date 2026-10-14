import { describe, expect, it } from "vitest";
import {
  createKitchenTicketClosedEnvelope,
  kitchenStaleTicketFoodMade,
  KitchenStaleTicketError,
  parseCloseStaleKitchenTicketCommand,
  parseKitchenBusinessDate,
  parseKitchenTicketClosedEnvelope,
} from "../index.js";

const id = (n: number) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = {
  idempotencyKey: id(1),
  ticketReference: id(2),
  expectedTicketVersion: "4",
  reasonCode: "ALREADY_SERVED",
  correlationReference: id(3),
};
const payload = {
  kitchenTicketReference: id(20),
  orderReference: id(21),
  orderBatchReference: id(22),
  reasonCode: "ALREADY_SERVED" as const,
  foodMade: true,
  orderBusinessDate: "2026-10-09",
  ticketVersion: "4",
  openWorkItems: [
    {
      kitchenWorkItemReference: id(30),
      orderItemReference: id(31),
      status: "In Progress" as const,
      requiredQuantity: 2,
      completedQuantity: 1,
    },
  ],
  closedAt: "2026-10-14T12:00:00.000Z",
};
const envelope = (overrides: Partial<typeof payload> = {}) =>
  createKitchenTicketClosedEnvelope({
    eventReference: id(10),
    closureReference: id(11),
    correlationReference: id(12),
    actorReference: id(13),
    brandReference: id(14),
    storeReference: id(15),
    payload: { ...payload, ...overrides },
  });

describe("DEC-KITCHEN-STALE-TICKETS", () => {
  it("accepts only the closed browser intent with a known reason and an exact version", () => {
    expect(parseCloseStaleKitchenTicketCommand(command)).toEqual(command);
    for (const invalid of [
      { ...command, reasonCode: "REFUNDED" },
      { ...command, expectedTicketVersion: 4 },
      { ...command, expectedTicketVersion: "04" },
      { ...command, actorReference: id(9) },
      { ...command, correlationReference: command.idempotencyKey },
      { ...command, ticketReference: "Order 2" },
    ])
      expect(() => parseCloseStaleKitchenTicketCommand(invalid)).toThrow(KitchenStaleTicketError);
  });
  it("says the food was made only when it was served", () => {
    expect(kitchenStaleTicketFoodMade("ALREADY_SERVED")).toBe(true);
    expect(kitchenStaleTicketFoodMade("CANCELLED_ELSEWHERE")).toBe(false);
    expect(kitchenStaleTicketFoodMade("NOT_MADE_ABANDONED")).toBe(false);
  });
  it("reads real business dates only", () => {
    expect(parseKitchenBusinessDate("2026-10-09")).toBe("2026-10-09");
    for (const invalid of ["2026-02-30", "Oct 9", "2026-10-9", null])
      expect(() => parseKitchenBusinessDate(invalid)).toThrow();
  });
  it("builds a closed event bound to the ticket version and refuses a mismatched or enlarged payload", () => {
    const event = envelope();
    expect(event).toMatchObject({
      eventType: "KitchenTicketClosed",
      aggregateType: "KitchenTicket",
      aggregateId: id(20),
      aggregateVersion: 4n,
      causationId: id(11),
      actor: { type: "Actor", actorId: id(13) },
    });
    expect(parseKitchenTicketClosedEnvelope(event)).toEqual(event);
    expect(() => envelope({ foodMade: false })).toThrow();
    expect(() => envelope({ orderBusinessDate: "2026-13-01" })).toThrow();
    expect(() =>
      parseKitchenTicketClosedEnvelope({
        ...event,
        payload: { ...event.payload, note: "guest left" },
      }),
    ).toThrow();
    expect(() => parseKitchenTicketClosedEnvelope({ ...event, aggregateVersion: 5n })).toThrow();
    // Only open remakes may be left: no open work items is still a valid closure.
    expect(envelope({ openWorkItems: [] }).payload.openWorkItems).toEqual([]);
  });
});

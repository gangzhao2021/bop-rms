import { describe, expect, it } from "vitest";
import { kitchenTicketNextStep, kitchenTicketState } from "./KitchenBoardPages.js";
import type { KitchenBoardItem } from "./kitchen-board.js";

const ref = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString().padStart(12, "0");
function item(
  n: number,
  status: KitchenBoardItem["status"],
  o: { accepted?: boolean; done?: number; ready?: boolean } = {},
): KitchenBoardItem {
  return {
    workItemReference: ref(n),
    ticketReference: ref(900),
    orderReference: ref(901),
    stationLabel: null,
    displayName: `TEST dish ${n}`,
    status,
    requiredQuantity: 2,
    completedQuantity: o.done ?? 0,
    createdAt: "2026-10-26T22:00:00.000Z",
    allergenCue: "Unavailable",
    exceptionStatus: "Unavailable",
    selectedOptions: [],
    execution: {
      orderItemReference: ref(n + 100),
      stationReference: ref(902),
      ticketVersion: "3",
      workItemVersion: "1",
      acceptedAt: o.accepted || status !== "Queued" ? "2026-10-26T22:01:00.000Z" : null,
      readyAt: o.ready ? "2026-10-26T22:05:00.000Z" : null,
    },
  } as KitchenBoardItem;
}

describe("Kitchen v3: one main step per ticket", () => {
  it("accepts every item not yet accepted first, then starts, finishes and marks ready", () => {
    const fresh = [item(1, "Queued"), item(2, "Queued"), item(3, "In Progress")];
    expect(kitchenTicketNextStep(fresh)).toMatchObject({
      action: "AcceptKitchenWorkItem",
      label: "Accept all",
    });
    expect(kitchenTicketNextStep(fresh)?.items.map((entry) => entry.displayName)).toEqual([
      "TEST dish 1",
      "TEST dish 2",
    ]);
    expect(kitchenTicketNextStep([item(1, "Queued")])?.label).toBe("Accept order");
    expect(
      kitchenTicketNextStep([item(1, "Queued", { accepted: true }), item(2, "In Progress")]),
    ).toMatchObject({ action: "StartKitchenWorkItem", label: "Start cooking" });
    expect(kitchenTicketNextStep([item(1, "In Progress"), item(2, "In Progress")])).toMatchObject({
      action: "CompleteKitchenWorkItem",
      label: "Finished",
    });
    expect(kitchenTicketNextStep([item(1, "Completed", { done: 2 })])).toMatchObject({
      action: "MarkKitchenOrderItemReady",
    });
    expect(kitchenTicketNextStep([item(1, "Completed", { done: 2, ready: true })])).toBeNull();
  });
  it("skips finished and cancelled items and items with no kitchen steps here", () => {
    const noSteps: KitchenBoardItem = { ...item(4, "Queued") };
    delete (noSteps as { execution?: unknown }).execution;
    expect(kitchenTicketNextStep([noSteps, item(5, "Cancelled")])).toBeNull();
    expect(
      kitchenTicketNextStep([
        item(1, "Completed", { done: 2, ready: true }),
        item(2, "In Progress"),
      ])?.items,
    ).toHaveLength(1);
  });
  it("names the whole ticket's state in the three meanings", () => {
    expect(kitchenTicketState([item(1, "Queued"), item(2, "In Progress")])).toBe("ToAccept");
    expect(kitchenTicketState([item(1, "Queued", { accepted: true })])).toBe("InProgress");
    expect(kitchenTicketState([item(1, "Completed", { done: 2, ready: true })])).toBe("Done");
  });
});

import { describe, expect, it } from "vitest";
import type { TableCloseRound } from "./merchant-dining-table-close-plan.js";
import {
  tableClosePlanResponse,
  tableCloseRoundResponse,
} from "./merchant-dining-table-close-plan-response.js";

const roundKeys = [
  "cancellableItemReferences",
  "cancelsAt",
  "kitchenReceivedAt",
  "openItemCount",
  "orderBatchReference",
  "readyItemCount",
  "refund",
  "sequence",
  "startedItemCount",
  "state",
];
const received: TableCloseRound = {
  orderBatchReference: "018f7f9a-ad3e-7a11-8d01-000000000011",
  sequence: 1,
  state: "OnTableBill",
  openItemCount: 2,
  startedItemCount: 0,
  readyItemCount: 0,
  cancellableItemReferences: [],
  refund: null,
  cancelsAt: null,
  kitchenReceivedAt: "2026-11-05T19:00:00.000Z",
};
const notReceived: TableCloseRound = {
  ...received,
  orderBatchReference: "018f7f9a-ad3e-7a11-8d01-000000000012",
  sequence: 2,
  state: "NotStarted",
  refund: { method: "Online", amountMinor: "1250" },
  kitchenReceivedAt: null,
};

describe("table close plan reply", () => {
  it("carries every round field, kitchenReceivedAt included", () => {
    for (const round of [received, notReceived]) {
      const wire = tableCloseRoundResponse(round);
      expect(Object.keys(wire).sort()).toEqual(roundKeys);
      expect(wire).toEqual(round);
    }
  });

  it("leaves out anything the plan carries beyond the reply fields", () => {
    const plan = {
      orderReference: "018f7f9a-ad3e-7a11-8d01-000000000001",
      diningSessionReference: "018f7f9a-ad3e-7a11-8d01-000000000002",
      orderVersion: 4,
      observedAt: "2026-11-05T19:05:00.000Z",
      rounds: [{ ...received, auditReference: "private-audit" } as TableCloseRound, notReceived],
      totals: { onlineMinor: "1250", cardMachineMinor: "0" },
      closeBlockers: ["ITEMS_NOT_SERVED"],
      brandReference: "private-brand",
    };
    const wire = tableClosePlanResponse(plan);
    expect(Object.keys(wire).sort()).toEqual([
      "closeBlockers",
      "diningSessionReference",
      "observedAt",
      "orderReference",
      "orderVersion",
      "rounds",
      "totals",
    ]);
    expect(wire.rounds).toEqual([received, notReceived]);
  });
});

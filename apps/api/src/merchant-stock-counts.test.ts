import { describe, expect, it } from "vitest";
import { parseStockCountCommandBody, redactStockCount } from "./merchant-stock-counts.js";
import { parseStoreWasteCommandBody } from "./merchant-store-waste.js";

const id = (n: number) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const base = { operationReference: id(1), countReference: id(2), expectedVersion: 3 };
describe("WP-2423 stock count command body", () => {
  it("accepts each count action", () => {
    const bodies = [
      {
        action: "Create",
        operationReference: id(1),
        locationReference: id(4),
        countType: "Cycle",
        assigneeReference: id(5),
      },
      { action: "Start", ...base },
      { action: "Submit", ...base },
      { action: "Refresh", ...base },
      { action: "SendBack", ...base },
      { action: "Cancel", ...base },
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "4.25" },
      {
        action: "ExplainVariance",
        ...base,
        lineReference: id(6),
        varianceReasonCode: "UNRECORDED_WASTE",
      },
      { action: "ApproveAndPost", ...base, postOperationReference: id(7) },
    ];
    expect(bodies.map((body) => parseStockCountCommandBody(body).action)).toEqual(
      bodies.map((body) => body.action),
    );
  });
  it.each([
    [
      "a negative count",
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "-1" },
    ],
    [
      "a client unit",
      { action: "SaveLine", ...base, lineReference: id(6), countedQuantity: "1", unitCode: "KG" },
    ],
    [
      "an unknown variance reason",
      { action: "ExplainVariance", ...base, lineReference: id(6), varianceReasonCode: "BECAUSE" },
    ],
    [
      "a visible-expected count",
      {
        action: "Create",
        operationReference: id(1),
        locationReference: id(4),
        countType: "Cycle",
        assigneeReference: id(5),
        expectedQuantityVisibility: "Visible",
      },
    ],
    ["a separate Post", { action: "Post", ...base }],
    ["a zero version", { action: "Submit", ...base, expectedVersion: 0 }],
  ])("refuses %s", (_name, body) => {
    expect(() => parseStockCountCommandBody(body)).toThrow();
  });
});
describe("WP-2423 waste command body", () => {
  it("accepts recording and reviews with their reasons", () => {
    expect(
      parseStoreWasteCommandBody({
        action: "Record",
        operationReference: id(1),
        wasteReference: id(2),
        lines: [],
      }).action,
    ).toBe("Record");
    expect(
      parseStoreWasteCommandBody({
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Voided",
        reasonCode: "ENTERED_IN_ERROR",
      }).action,
    ).toBe("Review");
  });
  it.each([
    [
      "an accept with a void reason",
      {
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Accepted",
        reasonCode: "ENTERED_IN_ERROR",
      },
    ],
    [
      "a client recorder",
      {
        action: "Record",
        operationReference: id(1),
        wasteReference: id(2),
        lines: [],
        recordedBy: id(3),
      },
    ],
    [
      "an unknown decision",
      {
        action: "Review",
        operationReference: id(1),
        wasteReference: id(2),
        decision: "Approved",
        reasonCode: "REVIEWED_OK",
      },
    ],
  ])("refuses %s", (_name, body) => {
    expect(() => parseStoreWasteCommandBody(body)).toThrow();
  });
});

describe("WP-2423 blind count redaction", () => {
  const count = (status: string, assignee: string) =>
    ({
      status,
      assigneeReference: assignee,
      expectedQuantityVisibility: "BlindUntilSubmit",
      lines: [{ expectedQuantity: "14", variance: "-0.5", balanceVersion: 3 }],
    }) as never;
  it("hides expected quantities from the counter even when they may approve", () => {
    expect(redactStockCount(count("InProgress", id(9)), true, id(9)).lines[0]).toMatchObject({
      expectedQuantity: null,
      variance: null,
    });
  });
  it("shows them to other approvers, and to everyone once submitted", () => {
    expect(
      redactStockCount(count("InProgress", id(9)), true, id(8)).lines[0]?.expectedQuantity,
    ).toBe("14");
    expect(
      redactStockCount(count("InProgress", id(9)), false, id(8)).lines[0]?.expectedQuantity,
    ).toBeNull();
    expect(
      redactStockCount(count("Submitted", id(9)), false, id(9)).lines[0]?.expectedQuantity,
    ).toBe("14");
  });
  it("never sends ledger versions to the browser", () => {
    expect(
      redactStockCount(count("Posted", id(9)), true, id(8)).lines[0]?.balanceVersion,
    ).toBeUndefined();
  });
});

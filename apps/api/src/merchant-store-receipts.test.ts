import { describe, expect, it } from "vitest";
import { parseStoreReceiptCommandBody } from "./merchant-store-receipts.js";

const id = (n: number) => "01909a16-0000-7000-8000-" + n.toString(16).padStart(12, "0");
describe("WP-2423 Store receipt command body", () => {
  it("accepts post and void", () => {
    expect(
      parseStoreReceiptCommandBody({
        action: "Post",
        operationReference: id(1),
        receiptReference: id(2),
        supplierName: "Metro",
        supplierDocument: null,
        lines: [],
      }).action,
    ).toBe("Post");
    expect(
      parseStoreReceiptCommandBody({
        action: "Void",
        operationReference: id(1),
        receiptReference: id(2),
        reasonCode: "ENTERED_IN_ERROR",
      }).action,
    ).toBe("Void");
  });
  it.each([
    [
      "an unknown void reason",
      { action: "Void", operationReference: id(1), receiptReference: id(2), reasonCode: "BECAUSE" },
    ],
    [
      "a client receivedBy",
      {
        action: "Post",
        operationReference: id(1),
        receiptReference: id(2),
        supplierName: "M",
        supplierDocument: null,
        lines: [],
        receivedBy: id(5),
      },
    ],
    ["an edit action", { action: "Edit", operationReference: id(1), receiptReference: id(2) }],
  ])("refuses %s", (_label, value) => {
    expect(() => parseStoreReceiptCommandBody(value)).toThrow(/Invalid/u);
  });
});

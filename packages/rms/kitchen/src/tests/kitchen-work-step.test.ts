import { describe, expect, it } from "vitest";
import {
  chunkKitchenWorkStepLines,
  kitchenWorkStepMaxLines,
  kitchenWorkStepNotAttempted,
  parseKitchenWorkStepBody,
} from "../index.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = (n: number, ticket = 900, options: readonly string[] | null = null) => ({
  idempotencyKey: id(n),
  ticketReference: id(ticket),
  workItemReference: id(n + 1000),
  orderItemReference: id(n + 2000),
  optionReferences: options,
});
const body = (lines: readonly unknown[], step = "Finish") => ({
  step,
  storeReference: id(1),
  correlationReference: id(2),
  lines,
});
const invalid = { code: "KITCHEN_WORK_INPUT_INVALID" };

describe("DEC-KITCHEN-ONE-TAP a tap's closed body", () => {
  it("names a step and its lines and nothing else: the browser sends no versions", () => {
    expect(parseKitchenWorkStepBody(body([line(1)])).lines).toHaveLength(1);
    expect(() =>
      parseKitchenWorkStepBody({ ...body([line(1)]), expectedTicketVersion: "1" }),
    ).toThrow(expect.objectContaining(invalid));
    expect(() =>
      parseKitchenWorkStepBody(body([{ ...line(1), expectedWorkItemVersion: "1" }])),
    ).toThrow(expect.objectContaining(invalid));
    expect(() => parseKitchenWorkStepBody(body([line(1)], "Accept"))).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() =>
      parseKitchenWorkStepBody({ ...body([line(1)]), storeReference: undefined }),
    ).toThrow(expect.objectContaining(invalid));
  });
  it("takes one to fifty lines, one per work item", () => {
    expect(() => parseKitchenWorkStepBody(body([]))).toThrow(expect.objectContaining(invalid));
    const lines = Array.from({ length: kitchenWorkStepMaxLines + 1 }, (_, n) => line(n + 1));
    expect(() => parseKitchenWorkStepBody(body(lines))).toThrow(expect.objectContaining(invalid));
    expect(parseKitchenWorkStepBody(body(lines.slice(1))).lines).toHaveLength(50);
    expect(() => parseKitchenWorkStepBody(body([line(1), line(1)]))).toThrow(
      expect.objectContaining(invalid),
    );
  });
  it("names chosen dishes only when finishing them", () => {
    expect(
      parseKitchenWorkStepBody(body([line(1, 900, [id(7)])])).lines[0]?.optionReferences,
    ).toEqual([id(7)]);
    expect(() => parseKitchenWorkStepBody(body([line(1, 900, [id(7)])], "Start"))).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseKitchenWorkStepBody(body([line(1, 900, [])]))).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseKitchenWorkStepBody(body([line(1, 900, [id(7), id(7)])]))).toThrow(
      expect.objectContaining(invalid),
    );
  });
});

describe("DEC-KITCHEN-ONE-TAP chunks", () => {
  it("runs one ticket per chunk, at most eight lines each, in the tap's order", () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, n) => line(n + 1, 900)),
      line(50, 901),
      line(51, 900),
    ];
    const chunks = chunkKitchenWorkStepLines(parseKitchenWorkStepBody(body(lines)).lines);
    expect(chunks.map((chunk) => chunk.length)).toEqual([8, 3, 1]);
    expect(chunks.every((chunk) => new Set(chunk.map((l) => l.ticketReference)).size === 1)).toBe(
      true,
    );
    expect(chunks[2]?.[0]?.ticketReference).toBe(id(901));
  });
  it("says a line was not attempted without inventing a state for it", () => {
    expect(kitchenWorkStepNotAttempted(line(1))).toMatchObject({
      outcome: "NotAttempted",
      refusedReason: null,
      ticketVersion: null,
      workItemStatus: null,
    });
  });
});

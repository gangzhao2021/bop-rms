import { expect, it } from "vitest";
import { parseItemCompCommand } from "./merchant-dining-item-comp.js";

const id = (n: number) => "01a0fe00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const base = {
  orderReference: id(1),
  orderItemReferences: [id(3), id(2)],
  kind: "Comp",
  percent: null,
  amountOffMinor: null,
  reasonCode: "QUALITY",
  operationReference: id(9),
};

it("WP-2423 item 8 ① segment 2: reads only the manager's choice, never an amount owed", () => {
  expect(parseItemCompCommand(base)).toMatchObject({
    orderItemReferences: [id(2), id(3)],
    choice: { kind: "Comp" },
    reasonCode: "QUALITY",
  });
  expect(parseItemCompCommand({ ...base, kind: "Percent", percent: 15 }).choice).toEqual({
    kind: "Percent",
    percent: 15,
  });
  expect(
    parseItemCompCommand({
      ...base,
      kind: "Amount",
      amountOffMinor: "500",
      orderItemReferences: [id(2)],
    }).choice,
  ).toEqual({ kind: "Amount", netMinor: 500n });
  for (const bad of [
    { ...base, reasonCode: "OTHER" },
    { ...base, kind: "Percent", percent: 100 },
    { ...base, kind: "Comp", percent: 10 },
    // An amount off is for one dish.
    { ...base, kind: "Amount", amountOffMinor: "500" },
    { ...base, orderItemReferences: [id(2), id(2)] },
    { ...base, orderItemReferences: [] },
    { ...base, totalMinor: "0" },
  ])
    expect(() => parseItemCompCommand(bad)).toThrow(
      expect.objectContaining({ code: "ITEM_COMP_INPUT_INVALID" }),
    );
});

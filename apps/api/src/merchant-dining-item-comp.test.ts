import { expect, it } from "vitest";
import {
  createMerchantDiningItemComp,
  createMerchantDiningItemCompPreview,
  ItemCompError,
  parseItemCompCommand,
  parseItemCompPreview,
} from "./merchant-dining-item-comp.js";

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

it("v15 b16 DEC-COMP-BILL-CENT: the command may carry the amount its button showed; the preview the choice only", () => {
  expect(parseItemCompCommand(base).expectedTotalMinor).toBeNull();
  expect(parseItemCompCommand({ ...base, expectedTotalMinor: "2825" }).expectedTotalMinor).toBe(
    2825n,
  );
  for (const bad of ["0", "-1", "28.25", 2825, null])
    expect(() => parseItemCompCommand({ ...base, expectedTotalMinor: bad })).toThrow(
      expect.objectContaining({ code: "ITEM_COMP_INPUT_INVALID" }),
    );
  const choice = {
    orderReference: base.orderReference,
    orderItemReferences: base.orderItemReferences,
    kind: base.kind,
    percent: base.percent,
    amountOffMinor: base.amountOffMinor,
  };
  expect(parseItemCompPreview(choice)).toMatchObject({
    orderItemReferences: [id(2), id(3)],
    choice: { kind: "Comp" },
    operationReference: null,
    expectedTotalMinor: null,
  });
  // A preview never takes a reason, a reference or an amount: it records nothing.
  for (const bad of [base, { ...choice, expectedTotalMinor: "2825" }])
    expect(() => parseItemCompPreview(bad)).toThrow(
      expect.objectContaining({ code: "ITEM_COMP_INPUT_INVALID" }),
    );
});

it("v15 b16: a body the comp can't read is refused as a promise (the route's 400), never thrown out of the route", async () => {
  let ran = 0;
  const options = {
    persistence: {
      now: () => new Date(0),
      identity: { hasher: {} },
      currentActor: {},
      validateAssociation: async () => false,
      transactions: {
        run: () => {
          ran += 1;
          throw new Error("NOT_REACHED");
        },
      },
    },
    authentication: { authorize: () => Promise.reject(new Error("NOT_REACHED")) },
    installContext: () => Promise.resolve(),
    nextReference: () => id(99),
  } as unknown as Parameters<typeof createMerchantDiningItemComp>[0];
  for (const create of [createMerchantDiningItemComp, createMerchantDiningItemCompPreview]) {
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = create(options)({
        sessionCookie: "c",
        csrf: "x",
        command: { orderReference: "not-a-reference" },
      });
    }).not.toThrow();
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ItemCompError && error.code === "ITEM_COMP_INPUT_INVALID",
    );
  }
  expect(ran).toBe(0);
});

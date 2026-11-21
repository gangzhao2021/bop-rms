import { expect, it } from "vitest";
import {
  createMerchantDiningUnpaidItemRemovalPreview,
  parseUnpaidItemRemovalCommand,
  parseUnpaidItemRemovalPreview,
  UnpaidItemRemovalError,
} from "./merchant-dining-unpaid-item-removal.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const asked = {
  orderReference: id(1),
  orderBatchReference: id(2),
  orderItemReferences: [id(4), id(3)],
  expectedOrderVersion: 3,
};
const invalid = (error: unknown) =>
  error instanceof UnpaidItemRemovalError && error.code === "UNPAID_ITEM_REMOVAL_INPUT_INVALID";

// v15 b20 (DEC-TAX-WHOLE-RECEIPT): the preview asks only which dishes and the version it saw.
it("v15 b20: the preview reads the dishes and version, never a reason or an operation", () => {
  expect(parseUnpaidItemRemovalPreview(asked)).toMatchObject({
    ...asked,
    orderItemReferences: [id(3), id(4)],
    operationReference: null,
    reasonCode: null,
  });
  for (const broken of [
    { ...asked, reasonCode: "SOLD_OUT" },
    { ...asked, expectedOrderVersion: 1 },
    { ...asked, orderItemReferences: [] },
    { ...asked, orderItemReferences: [id(3), id(3)] },
  ])
    expect(() => parseUnpaidItemRemovalPreview(broken)).toThrow(
      expect.objectContaining({ code: "UNPAID_ITEM_REMOVAL_INPUT_INVALID" }),
    );
  // The command still needs its reason and operation.
  expect(() => parseUnpaidItemRemovalCommand(asked)).toThrow(UnpaidItemRemovalError);
  expect(
    parseUnpaidItemRemovalCommand({
      ...asked,
      operationReference: id(9),
      reasonCode: "SOLD_OUT",
    }).reasonCode,
  ).toBe("SOLD_OUT");
});

it("v15 b20: a preview body it can't read is refused before any database work", async () => {
  let ran = 0;
  const preview = createMerchantDiningUnpaidItemRemovalPreview({
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
    authentication: { authorize: () => Promise.resolve({ sessionReference: id(7) }) },
    installContext: () => Promise.resolve(),
    nextReference: () => id(99),
  } as unknown as Parameters<typeof createMerchantDiningUnpaidItemRemovalPreview>[0]);
  await expect(
    preview({ sessionCookie: "c", csrf: "x", command: { orderReference: "not-a-reference" } }),
  ).rejects.toSatisfy(invalid);
  expect(ran).toBe(0);
});

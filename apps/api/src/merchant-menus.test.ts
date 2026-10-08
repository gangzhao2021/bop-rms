import { describe, expect, it } from "vitest";
import { MerchantMenuError, parseMenuCommandBody } from "./merchant-menus.js";

const id = (n: number) => "01909a1e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "b".repeat(64);
const save = (change: Record<string, unknown> = {}) => ({
  action: "SaveDraft",
  operationReference: id(1),
  menuReference: id(2),
  expectedAggregateVersion: 3,
  name: "  All   Day ",
  sections: [
    {
      sectionReference: null,
      code: "coffee",
      name: "Coffee",
      items: [{ skuReference: id(4), featured: true }],
    },
  ],
  ...change,
});
const invalid = (value: unknown) => {
  try {
    parseMenuCommandBody(value);
  } catch (error) {
    return error instanceof MerchantMenuError && error.code === "Invalid";
  }
  return false;
};
describe("WP-2423 menu command body", () => {
  it("normalizes a draft and accepts each lifecycle action", () => {
    expect(parseMenuCommandBody(save())).toMatchObject({
      name: "All Day",
      sections: [{ code: "COFFEE", sectionReference: null }],
    });
    for (const body of [
      {
        action: "Revise",
        operationReference: id(1),
        menuReference: id(2),
        expectedAggregateVersion: 4,
      },
      { action: "Submit", operationReference: id(1), menuReference: id(2) },
      {
        action: "Approve",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 2,
        snapshotDigest: digest,
      },
      {
        action: "Publish",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 3,
        snapshotDigest: digest,
      },
      {
        action: "Rebuild",
        operationReference: id(1),
        menuReference: id(2),
        publishOperationReference: id(5),
      },
    ])
      expect(parseMenuCommandBody(body).action).toBe(body.action);
  });
  it.each([
    ["no sections", save({ sections: [] })],
    ["an extra field", { ...save(), storeReference: id(9) }],
    ["a non-v7 reference", save({ menuReference: "00000000-0000-4000-8000-000000000000" })],
    ["a zero version", save({ expectedAggregateVersion: 0 })],
    ["an empty name", save({ name: "   " })],
    [
      "a SKU twice in a section",
      save({
        sections: [
          {
            sectionReference: null,
            code: "COFFEE",
            name: "Coffee",
            items: [
              { skuReference: id(4), featured: false },
              { skuReference: id(4), featured: true },
            ],
          },
        ],
      }),
    ],
    [
      "duplicate section names",
      save({
        sections: ["A", "B"].map((c) => ({
          sectionReference: null,
          code: c,
          name: "Tea",
          items: [],
        })),
      }),
    ],
    [
      "a malformed digest",
      {
        action: "Publish",
        operationReference: id(1),
        menuReference: id(2),
        menuVersionReference: id(3),
        expectedVersion: 3,
        snapshotDigest: "sha256:xyz",
      },
    ],
    ["an unknown action", { action: "Archive", operationReference: id(1), menuReference: id(2) }],
  ])("rejects %s", (_, body) => expect(invalid(body)).toBe(true));
});

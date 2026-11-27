import { describe, expect, it } from "vitest";
import { choiceGroupLimitsAllowed, newChoiceGroupCommand } from "./NewChoiceGroupForm.js";

const ref = "01a4d900-0000-7000-8000-000000000001";
describe("WP-2423 item 8 ⑥ a simple choice group from the dish editor (v15 finding g)", () => {
  it("makes 辣度: choose one, required, the first by default", () => {
    expect(
      newChoiceGroupCommand({
        operationReference: ref,
        name: "Spice level",
        nameZh: "辣度",
        kind: "One",
        required: true,
        firstIsDefault: true,
        options: [
          { name: "Mild", nameZh: "微辣" },
          { name: "Medium", nameZh: "中辣" },
          { name: "Hot", nameZh: "特辣" },
          { name: "Not spicy", nameZh: "不辣" },
          { name: " ", nameZh: "" },
        ],
      }),
    ).toEqual({
      action: "Create",
      operationReference: ref,
      name: "Spice level",
      nameZh: "辣度",
      kind: "One",
      minimum: 1,
      maximum: 1,
      perOptionMaximum: 1,
      options: [
        { optionReference: null, name: "Mild", nameZh: "微辣", offered: true, defaultChoice: true },
        {
          optionReference: null,
          name: "Medium",
          nameZh: "中辣",
          offered: true,
          defaultChoice: false,
        },
        { optionReference: null, name: "Hot", nameZh: "特辣", offered: true, defaultChoice: false },
        {
          optionReference: null,
          name: "Not spicy",
          nameZh: "不辣",
          offered: true,
          defaultChoice: false,
        },
      ],
    });
  });
  it("makes 加饭: at most one, optional, no default; refuses an empty or repeated group", () => {
    const rice = newChoiceGroupCommand({
      operationReference: ref,
      name: "Add rice",
      nameZh: "加饭",
      kind: "One",
      required: false,
      firstIsDefault: false,
      options: [
        { name: "Steamed rice", nameZh: "加一碗白饭" },
        { name: "Egg fried rice", nameZh: "加一份蛋炒饭" },
      ],
    });
    expect([rice?.minimum, rice?.maximum, rice?.options.some((o) => o.defaultChoice)]).toEqual([
      0,
      1,
      false,
    ]);
    const base = {
      operationReference: ref,
      nameZh: "",
      kind: "Any" as const,
      required: false,
      firstIsDefault: false,
    };
    expect(
      newChoiceGroupCommand({ ...base, name: "", options: [{ name: "A", nameZh: "" }] }),
    ).toBeNull();
    expect(newChoiceGroupCommand({ ...base, name: "X", options: [] })).toBeNull();
    expect(
      newChoiceGroupCommand({
        ...base,
        name: "X",
        options: [
          { name: "A", nameZh: "" },
          { name: "a", nameZh: "" },
        ],
      }),
    ).toBeNull();
  });
  const toppings = {
    operationReference: ref,
    name: "Toppings",
    nameZh: "加料",
    kind: "Any" as const,
    required: false,
    firstIsDefault: false,
    options: [
      { name: "Pearls", nameZh: "珍珠" },
      { name: "Pudding", nameZh: "布丁" },
    ],
  };
  it("makes Toppings: any, at most 3 (WP-2423 item 3b)", () => {
    const group = newChoiceGroupCommand({ ...toppings, most: 3 });
    expect([group?.kind, group?.minimum, group?.maximum, group?.perOptionMaximum]).toEqual([
      "Any",
      0,
      3,
      1,
    ]);
    // No limit stays as it was.
    expect(newChoiceGroupCommand(toppings)?.maximum).toBeNull();
  });
  it("up to 2 of each makes a Quantity group, at most 6 in total", () => {
    const group = newChoiceGroupCommand({ ...toppings, most: 6, perChoice: 2 });
    expect([group?.kind, group?.minimum, group?.maximum, group?.perOptionMaximum]).toEqual([
      "Quantity",
      0,
      6,
      2,
    ]);
    expect(group?.options.every((o) => !o.defaultChoice)).toBe(true);
  });
  it("refuses 3 of each with at most 2, and limits outside what the server takes", () => {
    expect(newChoiceGroupCommand({ ...toppings, most: 2, perChoice: 3 })).toBeNull();
    expect(choiceGroupLimitsAllowed(2, 3)).toBe(false);
    for (const [most, perChoice] of [
      [0, 1],
      [51, 1],
      [1.5, 1],
      [null, 0],
      [null, 21],
      [Number.NaN, 1],
      [null, Number.NaN],
    ] as const)
      expect(choiceGroupLimitsAllowed(most, perChoice)).toBe(false);
    expect(choiceGroupLimitsAllowed(null, 20)).toBe(true);
    expect(choiceGroupLimitsAllowed(50, 20)).toBe(true);
  });
  it("a choose-one group ignores the limits of an any-number group", () => {
    const group = newChoiceGroupCommand({
      ...toppings,
      kind: "One",
      most: 5,
      perChoice: 3,
    });
    expect([group?.kind, group?.maximum, group?.perOptionMaximum]).toEqual(["One", 1, 1]);
  });
});

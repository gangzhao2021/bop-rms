import { describe, expect, it } from "vitest";
import { newChoiceGroupCommand } from "./NewChoiceGroupForm.js";

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
});

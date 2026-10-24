import { describe, expect, it } from "vitest";
import { codeForName, codeFromName, parseOptionSetCommandBody } from "./merchant-option-sets.js";

const id = (n: number) => "01909a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const option = (name: string, change: Record<string, unknown> = {}) => ({
  optionReference: null,
  name,
  offered: true,
  defaultChoice: false,
  ...change,
});
const milk = {
  action: "Create",
  operationReference: id(1),
  name: " Milk ",
  kind: "One",
  minimum: 1,
  maximum: 1,
  perOptionMaximum: 1,
  options: [option("Whole milk", { defaultChoice: true }), option("Oat milk")],
};

describe("WP-2423 option sets", () => {
  it("derives stable codes from names", () => {
    expect(codeFromName("Oat milk")).toBe("OAT_MILK");
    expect(codeFromName("Crème brûlée")).toBe("CREME_BRULEE");
    expect(codeFromName("2% milk")).toBe("MILK");
    expect(codeForName("燕麦奶", "OPTION")).toMatch(/^OPTION_[0-9A-F]{8}$/u);
    expect(codeForName("Oat milk", "OPTION")).toBe("OAT_MILK");
  });
  it("parses Create, Save and Archive and trims names", () => {
    expect(parseOptionSetCommandBody(milk)).toMatchObject({ action: "Create", name: "Milk" });
    const save = {
      ...milk,
      action: "Save",
      optionSetReference: id(2),
      expectedAggregateVersion: 1,
    };
    expect(parseOptionSetCommandBody(save).action).toBe("Save");
    expect(
      parseOptionSetCommandBody({
        action: "Archive",
        operationReference: id(1),
        optionSetReference: id(2),
        expectedAggregateVersion: 3,
      }).action,
    ).toBe("Archive");
  });
  it("refuses limits customers cannot meet and ambiguous options", () => {
    const refuse = (change: Record<string, unknown>) =>
      expect(() => parseOptionSetCommandBody({ ...milk, ...change })).toThrow("Invalid");
    refuse({ maximum: 2 });
    refuse({ minimum: 2 });
    refuse({ options: [option("Oat"), option("oat")] });
    refuse({
      options: [option("A", { defaultChoice: true }), option("B", { defaultChoice: true })],
    });
    refuse({ kind: "Any", minimum: 3, maximum: null });
    refuse({ kind: "Any", minimum: 1, maximum: null, options: [option("A", { offered: false })] });
    refuse({ extra: true });
    refuse({ options: [] });
  });
});

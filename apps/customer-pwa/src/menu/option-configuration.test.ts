import { expect, it } from "vitest";
import {
  activeMenuOptionRules,
  defaultMenuOptionSelections,
  selectedMenuOptions,
} from "./option-configuration.js";
import type { MenuOptionRule } from "./types.js";
const group = (
  reference: string,
  defaultQuantity: number,
  activation: readonly string[],
): MenuOptionRule => ({
  name: null,
  minimumSelections: 0,
  maximumSelections: 3,
  activationOptionReferences: activation,
  options: [
    {
      optionReference: reference,
      name: reference,
      maximumQuantity: 3,
      conflictOptionReferences: [],
      selectedByDefault: defaultQuantity > 0,
      defaultQuantity,
      price: null,
    },
  ],
});
it("uses default quantities while keeping inactive descendants out of commands", () => {
  const rules = [
    group("root", 0, []),
    group("child", 2, ["root"]),
    group("grandchild", 1, ["child"]),
  ];
  const initial = defaultMenuOptionSelections(rules);
  expect(initial.get("child")).toBe(2);
  expect(activeMenuOptionRules(rules, initial)).toEqual([rules[0]]);
  expect(selectedMenuOptions(rules, initial)).toEqual([]);
  const enabled = new Map(initial).set("root", 1);
  expect(activeMenuOptionRules(rules, enabled)).toEqual(rules);
  expect(selectedMenuOptions(rules, enabled)).toEqual([
    { optionReference: "root", quantity: 1 },
    { optionReference: "child", quantity: 2 },
    { optionReference: "grandchild", quantity: 1 },
  ]);
  enabled.delete("root");
  expect(selectedMenuOptions(rules, enabled)).toEqual([]);
});

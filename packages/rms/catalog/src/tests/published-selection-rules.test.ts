import { describe, expect, it } from "vitest";
import { publishedSelectionRules } from "../application/current-selection-source.js";

const id = (n: number) => "01909a21-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const option = (n: number, maximumQuantity = 1) => ({
  optionReference: id(n),
  maximumQuantity,
  conflictOptionReferences: [],
});
const published = (binding: number, options: number[], minimum = 1) =>
  ({
    semanticsVersion: 2,
    channelCodes: ["CUSTOMER_PWA"],
    activationOptionReferences: [],
    bindingReference: id(binding),
    optionSetVersionReference: id(binding + 100),
    minimumSelections: minimum,
    maximumSelections: 1,
    enabledOptionReferences: options.map(id),
    defaultOptionReferences: [],
    options: options.map((n) => ({
      ...option(n, 3),
      localizedNames: { "en-CA": "Option " + n },
      selectedByDefault: false,
    })),
  }) as never;
const current = (binding: number, options: number[], minimum = 1) =>
  ({
    bindingReference: id(binding),
    optionSetVersionReference: id(binding + 100),
    activationOptionReferences: [],
    minimumQuantity: minimum,
    maximumQuantity: 1,
    options: options.map((n) => option(n)),
  }) as never;

describe("WP-2423 published menu choices", () => {
  it("ignores choices added since the menu was published", () => {
    expect(publishedSelectionRules([], [current(1, [10, 11])], "CUSTOMER_PWA")).toEqual([]);
  });
  it("keeps what customers were shown, narrowed to what is still offered", () => {
    const [rule] = publishedSelectionRules(
      [published(1, [10, 11, 12])],
      [current(1, [10, 12]), current(2, [20])],
      "CUSTOMER_PWA",
    );
    expect(rule).toMatchObject({ minimumQuantity: 1, maximumQuantity: 1 });
    expect(rule?.options.map((o) => [o.optionReference, o.maximumQuantity])).toEqual([
      [id(10), 1],
      [id(12), 1],
    ]);
  });
  it("keeps a required published choice whose binding is gone, with nothing to choose", () => {
    expect(publishedSelectionRules([published(1, [10])], [], "CUSTOMER_PWA")).toEqual([
      expect.objectContaining({ bindingReference: id(1), minimumQuantity: 1, options: [] }),
    ]);
  });
  it("applies only rules published for the channel", () => {
    expect(publishedSelectionRules([published(1, [10])], [current(1, [10])], "POS")).toEqual([]);
  });
});

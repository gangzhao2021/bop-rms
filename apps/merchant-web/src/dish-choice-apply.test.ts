import { describe, expect, it } from "vitest";
import {
  additionsFor,
  appliedDishCommand,
  applySections,
  choicesChangedHere,
  dishGroupExtras,
  firstDishUsing,
  hasEveryChoice,
  mergedDeclaration,
  planDishApply,
  runDishApply,
  summarisePriceChanges,
} from "./dish-choice-apply.js";
import { copiedChoices, dishEditorSource, type DishEditorSource } from "./dish-editor-source.js";
import type { MenuDish, MenuSectionRow } from "./one-store-menu.js";
import type { AllergenClassification, SaveDishCommand } from "./store-menu-pages.js";

const dish = (n: number, overrides: Partial<MenuDish> = {}): MenuDish => ({
  skuReference: `sku-${n}`,
  name: `Drink ${n}`,
  nameZh: "",
  sizeName: null,
  priceMinor: "500",
  pendingPriceMinor: null,
  productReference: `product-${n}`,
  soldOut: false,
  hidden: false,
  featured: false,
  allergens: { source: "StaffDeclared", declared: [] },
  sizes: [
    {
      skuReference: `sku-${n}`,
      sizeName: null,
      priceMinor: "500",
      pendingPriceMinor: null,
      soldOut: false,
      hidden: false,
      featured: false,
    },
  ],
  ...overrides,
});
const row = (dishes: readonly MenuDish[]): MenuSectionRow => ({
  sectionReference: "s",
  code: "DRINKS",
  name: "Drinks",
  nameZh: "",
  dishes,
});
const group = {
  options: [
    { optionReference: "pearl", name: "Pearls", offered: true },
    { optionReference: "large", name: "Large", offered: true },
    { optionReference: "foam", name: "Foam", offered: true },
  ],
};
const source = (chosen: [string, [string, string][]][]): DishEditorSource => ({
  name: "Drink",
  nameZh: "奶茶",
  description: "d",
  descriptionZh: "",
  taxClassificationReference: "tax",
  sizes: 1,
  taxClasses: [],
  groups: [],
  chosen: new Map(chosen.map(([set, options]) => [set, new Map(options)])),
  usual: new Map(),
  last: new Map(),
});

describe("WP-2423 item 3 F: which dishes can take a choice group", () => {
  it("skips dishes with sizes, no price, a combo, a fee and this dish", () => {
    const sized = dish(2);
    const sections = applySections(
      [
        row([
          dish(1),
          { ...sized, sizes: [...sized.sizes, ...sized.sizes] },
          dish(3, { priceMinor: null, pendingPriceMinor: null }),
          dish(4),
          dish(5, { allergens: { source: "StaffDeclared", declared: [], noIngredients: true } }),
          dish(6),
          dish(7, { priceMinor: null, pendingPriceMinor: "300" }),
        ]),
      ],
      (sku) => sku === "sku-4",
      "sku-6",
    );
    expect(sections[0]?.dishes.map((d) => d.skuReference)).toEqual(["sku-1", "sku-7"]);
  });
  it("reads what each dish has of the group, its waiting price first", () => {
    const prices = {
      products: [
        {
          productReference: "product-1",
          optionSets: [
            {
              optionSetReference: "toppings",
              options: [
                { optionReference: "pearl", priceMinor: "80", pending: { priceMinor: "90" } },
                { optionReference: "large", priceMinor: null, pending: null },
              ],
            },
            { optionSetReference: "ice", options: [{ optionReference: "cold", priceMinor: "0" }] },
          ],
        },
      ],
    };
    const has = dishGroupExtras(prices, "toppings");
    expect([...(has.get("product-1") ?? [])]).toEqual([
      ["pearl", "0.90"],
      ["large", "0.00"],
    ]);
    expect(dishGroupExtras(prices, "other").size).toBe(0);
    expect(hasEveryChoice(new Map([["pearl", "1.00"]]), has.get("product-1"))).toBe(true);
    expect(hasEveryChoice(new Map([["foam", "1.00"]]), has.get("product-1"))).toBe(false);
    expect(hasEveryChoice(new Map([["foam", "1.00"]]), undefined)).toBe(false);
    expect(
      firstDishUsing([row([dish(9), dish(1)])], prices, "toppings", () => false)?.skuReference,
    ).toBe("sku-1");
    expect(firstDishUsing([row([dish(9)])], prices, "toppings", () => false)).toBeNull();
    expect(firstDishUsing([row([dish(1)])], prices, "toppings", (s) => s === "sku-1")).toBeNull();
  });
});

describe("WP-2423 item 3 F: what a run does to a dish", () => {
  const extras = new Map([
    ["pearl", "0.80"],
    ["large", "1.00"],
  ]);
  it("adding a topping leaves another dish's Large extra alone", () => {
    const plan = planDishApply({
      group,
      extras,
      has: new Map([["large", "1.50"]]),
      changeExisting: false,
      changedHere: new Set(),
    });
    expect(plan.adds).toEqual([{ optionReference: "pearl", name: "Pearls", dollars: "0.80" }]);
    expect(plan.changes).toEqual([]);
  });
  it("a changed extra touches only that choice", () => {
    const changedHere = choicesChangedHere(
      extras,
      new Map([
        ["pearl", "0.80"],
        ["large", "0.90"],
      ]),
    );
    expect([...changedHere]).toEqual(["large"]);
    const plan = planDishApply({
      group,
      extras,
      has: new Map([
        ["pearl", "0.50"],
        ["large", "1.50"],
      ]),
      changeExisting: true,
      changedHere,
    });
    expect(plan.adds).toEqual([]);
    expect(plan.changes).toEqual([
      { optionReference: "large", name: "Large", from: "1.50", to: "1.00" },
    ]);
  });
  it("with no change made here, changing existing extras offers every one that differs", () => {
    const plan = planDishApply({
      group,
      extras,
      has: new Map([
        ["pearl", "0.50"],
        ["large", "1"],
      ]),
      changeExisting: true,
      changedHere: new Set(),
    });
    // "1" and "1.00" are the same money.
    expect(plan.changes.map((c) => c.optionReference)).toEqual(["pearl"]);
  });
  it("summarises price changes by choice and amounts", () => {
    const change = { optionReference: "large", name: "Large", from: "1.50", to: "1.00" };
    expect(
      summarisePriceChanges([
        { adds: [], changes: [change] },
        { adds: [], changes: [change] },
        { adds: [], changes: [{ ...change, from: "0.90" }] },
      ]),
    ).toEqual([
      { choice: "Large", from: "1.50", to: "1.00", dishes: 2 },
      { choice: "Large", from: "0.90", to: "1.00", dishes: 1 },
    ]);
  });
  it("never removes a choice or a group, and sends no price or section", () => {
    const command = appliedDishCommand({
      menuReference: "menu",
      productReference: "product-1",
      operationReference: "op",
      source: source([
        ["ice", [["cold", "0.00"]]],
        ["toppings", [["large", "1.50"]]],
      ]),
      optionSetReference: "toppings",
      plan: {
        adds: [{ optionReference: "pearl", name: "Pearls", dollars: "0.80" }],
        changes: [],
      },
      allergens: null,
    });
    expect(command).toMatchObject({
      priceMinor: null,
      sectionCode: null,
      name: "Drink",
      nameZh: "奶茶",
      taxClassificationReference: "tax",
      allergens: null,
      choiceGroups: [
        { optionSetReference: "ice", options: [{ optionReference: "cold", amountMinor: "0" }] },
        {
          optionSetReference: "toppings",
          options: [
            { optionReference: "large", amountMinor: "150" },
            { optionReference: "pearl", amountMinor: "80" },
          ],
        },
      ],
    });
  });
  it("a matching dish produces no command", () => {
    expect(
      appliedDishCommand({
        menuReference: "menu",
        productReference: "product-1",
        operationReference: "op",
        source: source([["toppings", [["large", "1.50"]]]]),
        optionSetReference: "toppings",
        plan: { adds: [], changes: [] },
        allergens: null,
      }),
    ).toBeNull();
  });
});

describe("WP-2423 item 3 F: allergens a choice brings", () => {
  const add = (optionReference: string) => ({ optionReference, name: "x", dollars: "1.00" });
  const list = ["soy", "milk", "egg", "peanut"].map((allergenReference) => ({ allergenReference }));
  it("adds to what the dish declared and keeps the stronger answer", () => {
    expect(
      mergedDeclaration(
        {
          source: "StaffDeclared",
          declared: [
            { allergenReference: "soy", classification: "Contains" },
            { allergenReference: "milk", classification: "CrossContactPossible" },
          ],
        },
        new Map([
          ["milk", "Contains"],
          ["soy", "CrossContactPossible"],
          ["egg", "CrossContactPossible"],
        ]),
        list,
      ),
    ).toEqual([
      { allergenReference: "soy", classification: "Contains" },
      { allergenReference: "milk", classification: "Contains" },
      { allergenReference: "egg", classification: "CrossContactPossible" },
      // WP-2423 (M76): the rest of the list is answered No, never left out.
      { allergenReference: "peanut", classification: "None" },
    ]);
  });
  it("leaves a recipe, an undeclared dish and one already saying so unchanged", () => {
    const milk = new Map([["milk", "Contains" as const]]);
    expect(mergedDeclaration({ source: "Recipe", declared: [] }, milk, list)).toBeNull();
    expect(mergedDeclaration({ source: "None", declared: [] }, milk, list)).toBeNull();
    expect(
      mergedDeclaration(
        {
          source: "StaffDeclared",
          declared: [{ allergenReference: "milk", classification: "Contains" }],
        },
        milk,
        list,
      ),
    ).toBeNull();
  });
  it("only the choices a dish is getting bring their allergens", () => {
    const answers = new Map<string, ReadonlyMap<string, AllergenClassification>>([
      ["foam", new Map([["milk", "Contains"]])],
      ["pearl", new Map([["soy", "CrossContactPossible"]])],
    ]);
    expect([...additionsFor({ adds: [add("foam")], changes: [] }, answers)]).toEqual([
      ["milk", "Contains"],
    ]);
  });
});

describe("WP-2423 item 3 F: the run", () => {
  const commandFor = (dishOf: MenuDish, read: DishEditorSource, operationReference: string) =>
    appliedDishCommand({
      menuReference: "menu",
      productReference: dishOf.productReference as string,
      operationReference,
      source: read,
      optionSetReference: "toppings",
      plan: planDishApply({
        group,
        extras: new Map([["pearl", "0.80"]]),
        has: read.chosen.get("toppings"),
        changeExisting: false,
        changedHere: new Set(),
      }),
      allergens: null,
    });
  const harness = (fail: Set<string>) => {
    const saved: SaveDishCommand[] = [];
    let next = 0;
    const progress: [number, number][] = [];
    return {
      saved,
      progress,
      run: (dishes: readonly MenuDish[], memory: Map<string, SaveDishCommand>) =>
        runDishApply({
          dishes,
          memory,
          counted: 1,
          stillOpen: () => true,
          load: async (product) =>
            product === "product-2"
              ? source([["toppings", [["pearl", "0.80"]]]])
              : source([["toppings", [["large", "1.50"]]]]),
          commandFor: (d, read) => commandFor(d, read, `op-${++next}`),
          save: async (command) => {
            saved.push(command);
            if (fail.has(String(command.productReference))) {
              fail.delete(String(command.productReference));
              throw new Error("stopped");
            }
            return command.productReference === "product-3"
              ? { status: "Saved", choicesWaiting: true }
              : { status: "Saved" };
          },
          onProgress: (done, total) => progress.push([done, total]),
        }),
    };
  };
  it("skips a dish that matches, and does not count it", async () => {
    const run = harness(new Set());
    const result = await run.run([dish(1), dish(2)], new Map());
    expect(result.applied.map((d) => d.skuReference)).toEqual(["sku-1"]);
    expect(run.saved.map((c) => c.productReference)).toEqual(["product-1"]);
    expect(run.progress.at(-1)).toEqual([2, 2]);
  });
  it("names a dish left waiting for allergens apart from those done", async () => {
    const run = harness(new Set());
    const result = await run.run([dish(3)], new Map());
    expect(result.waiting.map((d) => d.skuReference)).toEqual(["sku-3"]);
    expect(result.applied).toEqual([]);
  });
  it("stops at the first failure, and trying again keeps that dish's one operation", async () => {
    const run = harness(new Set(["product-1"]));
    const memory = new Map<string, SaveDishCommand>();
    const first = await run.run([dish(1), dish(4)], memory);
    expect(first.failed?.dish.skuReference).toBe("sku-1");
    expect(run.saved).toHaveLength(1);
    const second = await run.run([dish(1), dish(4)], memory);
    expect(second.failed).toBeNull();
    expect(run.saved[1]?.operationReference).toBe(run.saved[0]?.operationReference);
    expect(run.saved[2]?.operationReference).not.toBe(run.saved[0]?.operationReference);
    expect(memory.size).toBe(0);
  });
});

describe("WP-2423 item 3 B: what a new dish copies", () => {
  const groups = [
    {
      optionSetReference: "toppings",
      name: "Toppings",
      archived: false,
      displayStyle: "MultiSelect",
      minimum: 0,
      maximum: null,
      perOptionMaximum: 1,
      options: [
        { optionReference: "pearl", name: "Pearls", offered: true },
        { optionReference: "old", name: "Old", offered: false },
      ],
    },
  ];
  it("copies only the groups staff can see and the choices still offered", () => {
    const copied = copiedChoices({
      groups,
      chosen: new Map([
        ["archived", new Map([["x", "1.00"]])],
        [
          "toppings",
          new Map([
            ["pearl", "0.80"],
            ["old", "0.50"],
          ]),
        ],
      ]),
    });
    expect([...copied.keys()]).toEqual(["toppings"]);
    expect([...(copied.get("toppings") ?? [])]).toEqual([["pearl", "0.80"]]);
  });
  it("leaves out archived groups and a combo's parts, and reads the usual extras", () => {
    const read = dishEditorSource(null, {
      product: {
        taxClasses: [],
        optionSetChoices: [
          { optionSetReference: "a", archived: true, options: [] },
          { optionSetReference: "b", archived: false, comboPart: true, options: [] },
          { optionSetReference: "c", archived: false, comboPart: false, options: [] },
        ],
      },
      optionPrices: { products: [], usual: { pearl: "80" } },
    });
    expect(read.groups.map((g) => g.optionSetReference)).toEqual(["c"]);
    expect([...read.usual]).toEqual([["pearl", "0.80"]]);
    // A read without them (an older server) still opens the editor.
    expect(
      dishEditorSource(null, { product: { taxClasses: [] }, optionPrices: null }).usual.size,
    ).toBe(0);
  });
});

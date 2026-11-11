import { describe, expect, it } from "vitest";
import { changedAllergenDisclosure } from "../application/customer-menu-query-service.js";
import {
  SELLABLE_ALLERGEN_CHOICE_LIMIT,
  sellableAllergenChangeForChoices,
  withSellableAllergenChange,
  type SellableAllergenNow,
} from "../domain/sellable-allergen-change.js";
import {
  listSellableAllergenChangesSince,
  recordSellableAllergenChange,
} from "../infrastructure/persistence/sellable-allergen-change-store.js";

/** WP-2423 (M77, M167): synthetic, TEST-only allergens. */
const ref = (n: number) => "01909b00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Allergen = SellableAllergenNow;
const egg: Allergen = {
  allergenReference: ref(1),
  code: "EGG",
  localizedNames: { "en-CA": "Eggs", "zh-Hans": "蛋" },
  classification: "Contains" as const,
};
const milk: Allergen = {
  ...egg,
  allergenReference: ref(2),
  code: "MILK",
  localizedNames: { "en-CA": "Milk" },
};
const change = (allergens: Allergen[] | null) => ({
  skuReference: ref(9),
  storeReference: null,
  cause: "RecipeBound" as const,
  allergens,
  recordedAt: "2026-11-06T16:00:00.000Z",
});
const listed = (code: string, classification: "Contains" | "CrossContactPossible") => ({
  code,
  classification,
});
const entry = (a: Allergen) => ({ code: a.code, classification: a.classification });

describe("WP-2423 (M77, M167): a recipe change read with the listed allergens", () => {
  it("adds what the recipe brings, keeps Contains over May contain, and says it changed", () => {
    expect(withSellableAllergenChange([listed("MILK", "Contains")], undefined, entry)).toEqual({
      items: [listed("MILK", "Contains")],
      changed: false,
    });
    expect(
      withSellableAllergenChange([listed("MILK", "Contains")], change([egg, milk]), entry),
    ).toEqual({ items: [listed("MILK", "Contains"), listed("EGG", "Contains")], changed: true });
    expect(
      withSellableAllergenChange([listed("EGG", "CrossContactPossible")], change([egg]), entry),
    ).toEqual({ items: [listed("EGG", "Contains")], changed: true });
    // A recipe that leaves an allergen out never removes it before the menu is listed again.
    expect(withSellableAllergenChange([listed("MILK", "Contains")], change([]), entry)).toEqual({
      items: [listed("MILK", "Contains")],
      changed: false,
    });
    // Not resolved: the listed list stays, and guests are told to ask.
    expect(withSellableAllergenChange([], change(null), entry)).toEqual({
      items: [],
      changed: true,
    });
  });

  it("guests read the egg in the dish and in every set of choices, said just updated", () => {
    const disclosure = {
      registryVersionReference: ref(50),
      items: [
        {
          allergenReference: ref(2),
          code: "MILK",
          name: "Milk",
          classification: "Contains" as const,
        },
      ],
      allergenFreeClaim: false as const,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED" as const,
      byChoice: {
        options: [ref(30)],
        outcomes: [[], [listed("MILK", "Contains")]],
        sets: [[0], [1, 0]],
      },
    } as never;
    const seen = changedAllergenDisclosure(
      disclosure,
      change([egg]),
      (names) => names["zh-Hans"] ?? "",
    );
    expect(seen.justUpdated).toBe(true);
    expect(seen.items.map((item) => [item.code, item.name, item.classification])).toEqual([
      ["MILK", "Milk", "Contains"],
      ["EGG", "蛋", "Contains"],
    ]);
    expect(seen.byChoice?.outcomes).toEqual([
      [listed("EGG", "Contains")],
      [listed("MILK", "Contains"), listed("EGG", "Contains")],
    ]);
    // Nothing new: the listed disclosure as it was, not said updated.
    expect(changedAllergenDisclosure(disclosure, change([milk]), () => "")).toBe(disclosure);
    expect(changedAllergenDisclosure(disclosure, undefined, () => "")).toBe(disclosure);
  });

  // b7 (sold-out-allergens): staff tick Eggs for Egg fried rice on a listed Mapo tofu.
  it("a choice's staff answer is read under that choice and only with it, the dish list says all choices", () => {
    const rice = ref(30),
      plain = ref(31);
    const answered = {
      ...change([milk, egg]),
      cause: "StaffDeclared" as const,
      choices: { dish: [milk], options: { [rice.slice(-12)]: [egg] } },
    };
    const disclosure = {
      registryVersionReference: ref(50),
      items: [
        {
          allergenReference: ref(2),
          code: "MILK",
          name: "Milk",
          classification: "Contains" as const,
        },
      ],
      allergenFreeClaim: false as const,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED" as const,
      byChoice: {
        options: [rice, plain],
        outcomes: [[listed("MILK", "Contains")]],
        sets: [
          [0, 0],
          [0, 1],
        ],
      },
    } as never;
    const seen = changedAllergenDisclosure(disclosure, answered, (names) => names["en-CA"] ?? "", [
      rice,
      plain,
    ]);
    expect(seen.justUpdated).toBe(true);
    // Everything the dish may contain across its choices.
    expect(seen.items.map((item) => item.code)).toEqual(["MILK", "EGG"]);
    // Under the choice that adds it, and nowhere else.
    expect(seen.byOption).toEqual({ [rice]: [listed("EGG", "Contains")] });
    // With fried rice: milk and egg; with plain rice: milk only.
    expect(seen.byChoice?.sets).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(seen.byChoice?.outcomes).toEqual([
      [listed("MILK", "Contains"), listed("EGG", "Contains")],
      [listed("MILK", "Contains")],
    ]);
    // The kitchen: a dish ordered with plain rice is not told egg; unknown choices keep it all.
    expect(sellableAllergenChangeForChoices(answered, [plain])?.allergens).toEqual([milk]);
    expect(sellableAllergenChangeForChoices(answered, [rice])?.allergens).toEqual([milk, egg]);
    expect(sellableAllergenChangeForChoices(answered, null)).toBe(answered);
    // A change that does not say what each choice adds keeps the whole change.
    expect(sellableAllergenChangeForChoices(change([egg]), [plain])?.allergens).toEqual([egg]);
  });

  // b7 (review): staff answer "Adds none" for Plain rice on a listed dish with no reviewed sets.
  it("a choice answered as adding none is read as answered, not as never answered, and adds nothing", () => {
    const rice = ref(30),
      plain = ref(31),
      never = ref(32);
    const answered = {
      ...change([milk]),
      cause: "StaffDeclared" as const,
      choices: { dish: [milk], options: { [plain.slice(-12)]: [] } },
    };
    const disclosure = {
      registryVersionReference: ref(50),
      items: [
        {
          allergenReference: ref(2),
          code: "MILK",
          name: "Milk",
          classification: "Contains" as const,
        },
      ],
      allergenFreeClaim: false as const,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED" as const,
      byOption: { [rice]: [listed("EGG", "Contains")] },
    } as never;
    const seen = changedAllergenDisclosure(disclosure, answered, () => "", [rice, plain, never]);
    // Plain rice is answered (adds none); the choice nobody answered stays absent; the listed
    // egg under fried rice stays; nothing new to read, so not said just updated.
    expect(seen.byOption).toEqual({ [rice]: [listed("EGG", "Contains")], [plain]: [] });
    expect(seen).not.toHaveProperty("justUpdated");
    expect(seen.items.map((item) => item.code)).toEqual(["MILK"]);
    // An answer of none never removes what the listed menu names under a choice.
    const listedNone = changedAllergenDisclosure(
      disclosure,
      { ...answered, choices: { dish: [milk], options: { [rice.slice(-12)]: [] } } },
      () => "",
      [rice],
    );
    expect(listedNone).toBe(disclosure);
    // The kitchen: a dish ordered with Plain rice is told the dish's own only.
    expect(sellableAllergenChangeForChoices(answered, [plain])?.allergens).toEqual([milk]);
  });

  // b7 (review): a dish with more answered choices than one change can hold.
  it("a change about too many choices is refused when written and read as the dish's list, never failing the menu", async () => {
    const many = Object.fromEntries(
      Array.from({ length: SELLABLE_ALLERGEN_CHOICE_LIMIT + 1 }, (_, n) => [
        n.toString(16).padStart(12, "0"),
        [] as Allergen[],
      ]),
    );
    const seen: string[] = [];
    const tx = {
      query: async <Row>(sql: string): Promise<{ rows: readonly Row[]; rowCount: number }> => {
        seen.push(sql);
        if (sql.includes("DISTINCT ON"))
          return {
            rows: [
              {
                version: ref(40),
                sku: ref(9),
                store: null,
                cause: "StaffDeclared",
                allergens: [milk],
                choices: { dish: [milk], options: many },
                recorded_at: "2026-11-06T16:00:00.000Z",
              },
            ] as never[],
            rowCount: 1,
          };
        return { rows: [{ brand: "", store: "" }] as never[], rowCount: 1 };
      },
    };
    await expect(
      recordSellableAllergenChange(
        tx,
        { tenantReference: ref(1), brandReference: ref(3) },
        {
          changeReference: ref(10),
          operationReference: ref(11),
          skuReference: ref(9),
          storeReference: null,
          cause: "StaffDeclared",
          allergens: [milk],
          choices: { dish: [milk], options: many },
          actorReference: ref(12),
          recordedAt: "2026-11-06T16:00:00.000Z",
        },
      ),
    ).rejects.toMatchObject({ code: "SELLABLE_ALLERGEN_CHANGE_INVALID" });
    expect(seen.some((sql) => sql.includes("INSERT"))).toBe(false);
    const read = await listSellableAllergenChangesSince(
      tx,
      { brandReference: ref(3), storeReference: ref(7) },
      [{ menuVersionReference: ref(40), skuReference: ref(9) }],
    );
    const found = read.get(ref(40) + ":" + ref(9));
    expect(found?.allergens).toEqual([milk]);
    expect(found).not.toHaveProperty("choices");
  });
});

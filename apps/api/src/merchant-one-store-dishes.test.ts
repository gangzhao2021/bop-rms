import { describe, expect, it } from "vitest";
import {
  createMerchantOneStoreDishes,
  MerchantOneStoreDishError,
  newDishCode,
  parseOneStoreDishBody,
} from "./merchant-one-store-dishes.js";

const id = (n: number) => "01a4d800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const MENU = id(1),
  TAX = id(2),
  SPICE = id(3),
  MILD = id(4),
  HOT = id(5),
  PEANUT = id(6);

/** In-memory stand-ins for the six pages' services (TEST-only), recording each command. */
function fakes() {
  const calls: string[] = [];
  const state = {
    /** The Brand's allergen list as the menu read gives it (empty: none yet). */
    allergenChoices: [] as unknown[],
    product: null as null | {
      productReference: string;
      lifecycle: string;
      aggregateVersion: number;
      name: string;
      nameZh: string;
      taxClassificationReference: string;
      sizes: {
        skuReference: string;
        skuCode: string;
        name: string;
        nameZh: string;
        lifecycle: string;
      }[];
      optionSets: { optionSetReference: string; enabledOptionReferences: string[] }[];
      presentation: { description: string; descriptionZh: string; photo: null };
    },
    books: [] as {
      priceBookReference: string;
      lifecycle: string;
      createdAt: string;
      aggregateVersion: number;
      prices: { sellableReference: string; amountMinor: string }[];
      purpose: "MenuListing" | "PriceChange" | null;
      startedBy: string | null;
    }[],
    assigned: null as string | null,
    optionPrices: new Map<string, { price: string | null; pending: string | null }>(),
    publishedRuleCounts: [] as number[],
    menu: {
      aggregateVersion: 1,
      versionReference: id(90),
      name: "TEST menu",
      sections: [
        {
          sectionReference: id(80),
          code: "NOODLES",
          name: "Noodles",
          nameZh: "面",
          items: [] as { skuReference: string; featured: boolean }[],
        },
      ],
    },
    published: true,
    declared: null as unknown,
    optionRecipes: new Map<string, { published: boolean; reviews: string[] }>(),
    /** How many rounds of choice recipes a save took, and each round's choices. */
    coverRounds: [] as { skuReference: string; choices: Map<string, string | null> }[],
    /** The size has no recipe yet (its allergens are not declared). */
    noRecipe: false,
    /** A round reports this many left without covering any. */
    stuck: false,
    /** The next round throws this. */
    coverFails: null as unknown,
    /** "List it"'s carrying of "no change" choices to new quantities throws this. */
    extendFails: null as unknown,
    /** Product commands answer what they recorded back then (a replay after a lost response). */
    replayProductCommands: false,
    /** Each round covers this many choices. */
    perRound: 12,
    /** The menu's own check refuses (a choice without a recipe). */
    menuRefused: false,
    /** WP-2423 M69: the menu's check finds a dish with no recipe (no allergens answered). */
    recipeMissing: false,
    // Store availability by size: absent = never decided here (NotOffered).
    offered: new Map<string, string>([[id(12), "Hidden"]]),
    /** WP-2423 M70: the Brand has several Stores; this Store's own prices by size. */
    multiStore: false,
    storePrices: new Map<string, string>(),
  };
  const record = (name: string, body: Record<string, unknown>) =>
    calls.push(name + ":" + String(body.action));
  const services = {
    availability: {
      query: async () => ({
        items: [id(11), id(12)].map((sku) => ({
          skuReference: sku,
          status:
            state.offered.get(sku) === "Hidden"
              ? "NotOffered"
              : (state.offered.get(sku) ?? "NotOffered"),
          decidedHere: state.offered.has(sku),
        })),
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("availability", body);
        state.offered.set(String(body.skuReference), "Available");
        return {};
      },
    },
    products: {
      query: async () => {
        calls.push("product:read");
        return { product: state.product };
      },
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("product", body);
        const replay = state.replayProductCommands
          ? { status: "AlreadyApplied", product: state.product }
          : null;
        if (replay !== null && replay.product !== null) return replay;
        if (body.action === "Create") {
          state.product = {
            productReference: id(10),
            lifecycle: "Draft",
            aggregateVersion: 1,
            name: String(body.name),
            nameZh: String(body.nameZh ?? ""),
            taxClassificationReference: String(body.taxClassificationReference),
            sizes: [
              {
                skuReference: id(11),
                skuCode: newDishCode(String(body.operationReference).slice(0, 36)) + "-1",
                name: String(body.name),
                nameZh: String(body.nameZh ?? ""),
                lifecycle: "Draft",
              },
            ],
            optionSets: [],
            presentation: { description: "", descriptionZh: "", photo: null },
          };
          return { status: "Applied", product: state.product };
        }
        const p = state.product;
        if (p === null) throw new Error("TEST_NO_PRODUCT");
        if (body.action === "SaveDraft") {
          p.name = String(body.name);
          p.nameZh = String(body.nameZh);
          p.optionSets = body.optionSets as typeof p.optionSets;
          p.presentation = { ...(body.presentation as typeof p.presentation) };
          p.sizes = p.sizes.map((s) => ({ ...s, name: p.name, nameZh: p.nameZh }));
        } else {
          p.lifecycle = "Active";
          p.sizes = p.sizes.map((s) => ({ ...s, lifecycle: "Active" }));
        }
        p.aggregateVersion += 1;
        return { status: "Applied", product: p };
      },
    },
    prices: {
      query: async ({ priceBookReference }: { priceBookReference: string | null }) => {
        if (priceBookReference === null)
          return {
            books: state.books,
            viewer: id(50),
            allStores: { multiStore: state.multiStore, mayList: true },
            storeAssignment:
              state.assigned === null ? null : { priceBookReference: state.assigned },
          };
        const book = state.books.find((b) => b.priceBookReference === priceBookReference);
        if (book === undefined) throw new Error("TEST_NO_BOOK");
        return { book, draftAuthor: book.lifecycle === "Draft" ? id(50) : null, viewer: id(50) };
      },
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("price", body);
        if (body.action === "CreateDraft") {
          const copy = state.books.find((b) => b.priceBookReference === body.copyFrom);
          state.books.push({
            priceBookReference: id(20 + state.books.length),
            lifecycle: "Draft",
            createdAt: "2026-10-28T20:00:00.000Z",
            aggregateVersion: 1,
            prices: [...(copy?.prices ?? [])],
            purpose: body.purpose as "MenuListing" | "PriceChange",
            startedBy: id(50),
          });
          return { priceBookReference: id(20 + state.books.length - 1) };
        }
        const book = state.books.find((b) => b.priceBookReference === body.priceBookReference);
        if (book === undefined) throw new Error("TEST_NO_BOOK");
        if (body.action === "SaveDraft") book.prices = body.prices as typeof book.prices;
        if (body.action === "Publish") book.lifecycle = "Published";
        if (body.action === "AssignToStore") state.assigned = book.priceBookReference;
        book.aggregateVersion += 1;
        return {};
      },
    },
    storePrices: {
      query: async () => ({
        prices: [...state.storePrices].map(([sellableReference, storePriceMinor]) => ({
          sellableReference,
          storePriceMinor,
        })),
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("storePrice", body);
        state.storePrices.set(String(body.sellableReference), String(body.amountMinor));
        return { status: "Applied" };
      },
    },
    optionPrices: {
      waiting: async () =>
        [...state.optionPrices]
          .filter(([, v]) => v.pending !== null)
          .map(([rule]) => ({ ruleReference: rule, aggregateVersion: 1, byViewer: true })),
      query: async () => ({
        products:
          state.product === null
            ? []
            : [
                {
                  productReference: id(10),
                  optionSets: [
                    {
                      bindingReference: id(30),
                      options: [MILD, HOT, ...state.optionPrices.keys()]
                        .filter((o, n, all) => all.indexOf(o) === n)
                        .map((o) => ({
                          optionReference: o,
                          ruleReference: o,
                          aggregateVersion: 1,
                          priceMinor: state.optionPrices.get(o)?.price ?? null,
                          pending:
                            state.optionPrices.get(o)?.pending == null
                              ? null
                              : { priceMinor: state.optionPrices.get(o)?.pending, byViewer: true },
                        })),
                    },
                  ],
                },
              ],
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("optionPrice", body);
        if (body.action === "SetPrices")
          for (const p of body.prices as { optionReference: string; amountMinor: string }[])
            state.optionPrices.set(p.optionReference, {
              price: state.optionPrices.get(p.optionReference)?.price ?? null,
              pending: p.amountMinor,
            });
        else {
          const rules = body.rules as { ruleReference: string }[];
          state.publishedRuleCounts.push(rules.length);
          for (const { ruleReference } of rules) {
            const v = state.optionPrices.get(ruleReference);
            if (v)
              state.optionPrices.set(ruleReference, { price: v.pending ?? v.price, pending: null });
          }
        }
        return {};
      },
    },
    menus: {
      query: async () => ({
        menu: state.menu,
        publication: state.published ? { state: "Published" } : null,
        allergenChoices: state.allergenChoices,
        // Where each size's allergens come from, as the menu page reads them.
        sellables: Array.isArray(state.declared)
          ? [
              {
                skuReference: id(11),
                allergens: {
                  source: "StaffDeclared",
                  declared: state.declared,
                  noIngredients: false,
                  unanswered: [],
                },
              },
            ]
          : [],
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("menu", body);
        if (body.action === "Check") {
          if (state.recipeMissing)
            throw Object.assign(new Error("refused"), {
              name: "MerchantMenuError",
              code: "ReviewBlocked",
              problem: { missing: "Recipe", productName: "Dan dan noodles (TEST)" },
            });
          if (state.menuRefused)
            throw Object.assign(new Error("refused"), {
              name: "MerchantMenuError",
              code: "OptionRecipeMissing",
            });
          return { status: "Ready" };
        }
        if (body.action === "Revise") state.published = false;
        if (body.action === "SaveDraft")
          state.menu = { ...state.menu, sections: body.sections as typeof state.menu.sections };
        if (body.action === "List") state.published = true;
        state.menu.aggregateVersion += 1;
        return { status: "Listed" };
      },
    },
    dishAllergens: {
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("allergens", body);
        state.declared = body.allergens;
        return { status: "Applied" };
      },
    },
    optionRecipes: {
      extendNoChangeChoices: async () => {
        if (state.extendFails !== null) throw state.extendFails;
        return { extended: 0, needsPerson: 0 };
      },
      coverDishChoices: async (input: {
        skuReference: string;
        choices: Map<string, string | null>;
      }) => {
        if (state.coverFails !== null) {
          const failure = state.coverFails;
          state.coverFails = null;
          throw failure;
        }
        const uncovered = [...input.choices.keys()].filter(
          (o) => state.optionRecipes.get(o)?.published !== true,
        );
        if (uncovered.length === 0) return { remaining: 0, waitingForAllergens: false };
        if (state.noRecipe) return { remaining: uncovered.length, waitingForAllergens: true };
        calls.push("optionRecipe:cover");
        state.coverRounds.push({ skuReference: input.skuReference, choices: input.choices });
        if (state.stuck) return { remaining: uncovered.length, waitingForAllergens: false };
        const taken = uncovered.slice(0, state.perRound);
        for (const o of taken) state.optionRecipes.set(o, { published: true, reviews: [] });
        return { remaining: uncovered.length - taken.length, waitingForAllergens: false };
      },
    },
  };
  const dishes = createMerchantOneStoreDishes({
    ...(services as unknown as Parameters<typeof createMerchantOneStoreDishes>[0]),
    now: () => "2026-10-28T20:00:00.000Z",
  });
  return { calls, state, dishes };
}
const save = (overrides: Record<string, unknown> = {}) => ({
  action: "SaveDish",
  operationReference: id(100),
  menuReference: MENU,
  productReference: null,
  sectionCode: "NOODLES",
  name: "Dan dan noodles (TEST)",
  nameZh: "担担面",
  description: "Sesame and chili (TEST)",
  descriptionZh: "麻酱辣油",
  taxClassificationReference: TAX,
  priceMinor: "1288",
  priceScope: "AllStores",
  expectedPriceMinor: null,
  choiceGroups: [
    {
      optionSetReference: SPICE,
      options: [
        { optionReference: MILD, amountMinor: "0" },
        { optionReference: HOT, amountMinor: "50" },
      ],
    },
  ],
  allergens: [{ allergenReference: PEANUT, classification: "Contains" }],
  ...overrides,
});
const session = { sessionCookie: "cookie", csrf: "csrf" };
/** WP-2423 M71: "List it" confirming the menu's own price draft as the review read it. */
const listAll = (
  operationReference: string,
  state: ReturnType<typeof fakes>["state"],
  confirmed?: { priceBookReference: string; aggregateVersion: number } | null,
) => {
  const draft = state.books.find((b) => b.lifecycle === "Draft" && b.purpose === "MenuListing");
  return {
    action: "ListAll",
    operationReference,
    menuReference: MENU,
    confirmedPriceBook:
      confirmed !== undefined
        ? confirmed
        : draft === undefined
          ? null
          : {
              priceBookReference: draft.priceBookReference,
              aggregateVersion: draft.aggregateVersion,
            },
  };
};

describe("WP-2423 item 8 ⑥ one dish saved from the one-page menu", () => {
  it("does each page's step in order, then a retry changes nothing", async () => {
    const { calls, state, dishes } = fakes();
    expect(await dishes.command({ ...session, body: save() })).toMatchObject({
      status: "Saved",
      skuReference: id(11),
    });
    expect(calls).toEqual([
      // The listed menu opens its draft before the first change it will list.
      "menu:Revise",
      "product:Create",
      "product:SaveDraft",
      "product:StartSelling",
      "availability:Offer",
      "price:CreateDraft",
      "price:SaveDraft",
      "optionPrice:SetPrices",
      "menu:SaveDraft",
      "allergens:DeclareDish",
      "optionRecipe:cover",
    ]);
    expect(state.books[0]?.prices).toEqual([{ sellableReference: id(11), amountMinor: "1288" }]);
    expect(state.menu.sections[0]?.items).toEqual([{ skuReference: id(11), featured: false }]);
    expect(state.product?.presentation).toMatchObject({
      description: "Sesame and chili (TEST)",
      descriptionZh: "麻酱辣油",
    });
    // The same save again: every step already holds (the allergens are re-sent; the generator
    // answers AlreadyApplied).
    calls.length = 0;
    await dishes.command({ ...session, body: save({ productReference: id(10) }) });
    expect(calls).toEqual(["product:read", "allergens:DeclareDish"]);
  });

  describe("WP-2423 item 3: saving a dish with many choices", () => {
    const manyChoices = (count: number, offset = 200) => ({
      choiceGroups: [
        {
          optionSetReference: SPICE,
          options: Array.from({ length: count }, (_, n) => ({
            optionReference: id(offset + n),
            amountMinor: "0",
          })),
        },
      ],
    });

    it("a dish with 19 choices covers them through coverDishChoices, not one command per step", async () => {
      const { calls, state, dishes } = fakes();
      state.perRound = 6;
      const saved = await dishes.command({ ...session, body: save(manyChoices(19)) });
      expect(saved).toMatchObject({ status: "Saved", choicesWaiting: false });
      expect(calls.filter((c) => c.startsWith("optionRecipe"))).toEqual([
        "optionRecipe:cover",
        "optionRecipe:cover",
        "optionRecipe:cover",
        "optionRecipe:cover",
      ]);
      // Every round is for this dish's one size and all of its choices, with no item to add.
      expect(state.coverRounds[0]?.skuReference).toBe(id(11));
      expect([...(state.coverRounds[0]?.choices.values() ?? [])].every((v) => v === null)).toBe(
        true,
      );
      expect(state.coverRounds[0]?.choices.size).toBe(19);
      // A new dish needs no read the commands already answered.
      expect(calls).not.toContain("product:read");
    });

    it("a replay reads the product and the Store's availability again", async () => {
      const { calls, state, dishes } = fakes();
      await dishes.command({ ...session, body: save({ choiceGroups: [] }) });
      // The response of the first save was lost, and staff hid the dish since: the same save again
      // answers what it recorded back then, and the dish stays hidden.
      calls.length = 0;
      state.replayProductCommands = true;
      state.offered.set(id(11), "Hidden");
      await dishes.command({ ...session, body: save({ choiceGroups: [] }) });
      expect(calls[0]).toBe("product:Create");
      expect(calls).toContain("product:read");
      expect(calls).not.toContain("availability:Offer");
      expect(state.offered.get(id(11))).toBe("Hidden");
    });

    it("a dish whose allergens are not declared yet saves, and says its choices wait", async () => {
      const { calls, state, dishes } = fakes();
      state.noRecipe = true;
      const saved = await dishes.command({ ...session, body: save({ allergens: null }) });
      expect(saved).toMatchObject({ status: "Saved", choicesWaiting: true });
      expect(calls).not.toContain("optionRecipe:cover");
    });

    it("WP-2423 (M76): a new dish with its allergens unanswered at a Brand with a list is refused, with nothing recorded", async () => {
      const { calls, state, dishes } = fakes();
      state.allergenChoices = [{ allergenReference: PEANUT }];
      await expect(
        dishes.command({ ...session, body: save({ allergens: null }) }),
      ).rejects.toMatchObject({ name: "MerchantOneStoreDishError", code: "AllergensUnanswered" });
      expect(calls).toEqual([]);
      // An existing dish not declared yet still saves (a price change, say).
      await dishes.command({ ...session, body: save() });
      calls.length = 0;
      await dishes.command({
        ...session,
        // WP-2423 M70: an edit's price is compared with the one the editor saw.
        body: save({
          productReference: id(10),
          allergens: null,
          priceMinor: "1388",
          expectedPriceMinor: "1288",
        }),
      });
      expect(calls).not.toContain("allergens:DeclareDish");
      expect(calls).toContain("price:SaveDraft");
    });

    it("allergens sent and still no recipe is a real failure, not a waiting dish", async () => {
      const { state, dishes } = fakes();
      state.noRecipe = true;
      await expect(dishes.command({ ...session, body: save() })).rejects.toMatchObject({
        code: "NoRecipe",
        productReference: id(10),
      });
    });

    it("a round that covers nothing stops as stopped part-way, naming the dish", async () => {
      const { state, dishes } = fakes();
      state.stuck = true;
      await expect(dishes.command({ ...session, body: save() })).rejects.toMatchObject({
        code: "StoppedPartWay",
        productReference: id(10),
      });
    });

    it("a lock that outlived its retries is stopped part-way too, never a refusal", async () => {
      const { state, dishes } = fakes();
      state.coverFails = Object.assign(new Error("conflict"), {
        code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
      });
      const failure = await dishes.command({ ...session, body: save() }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(MerchantOneStoreDishError);
      expect(failure).toMatchObject({ code: "StoppedPartWay", productReference: id(10) });
    });

    it("a page's refusal stays what it was, and names the dish once it exists", async () => {
      const { state, dishes } = fakes();
      state.coverFails = Object.assign(new Error("denied"), {
        name: "MerchantOptionRecipeError",
        code: "PermissionDenied",
      });
      await expect(dishes.command({ ...session, body: save() })).rejects.toMatchObject({
        code: "PermissionDenied",
        productReference: id(10),
      });
    });

    it("no price and no section leave both as they are (an existing dish only)", async () => {
      const { calls, state, dishes } = fakes();
      await dishes.command({ ...session, body: save({ allergens: null }) });
      state.books[0]?.prices.splice(0, 1, { sellableReference: id(11), amountMinor: "999" });
      calls.length = 0;
      state.published = true;
      await dishes.command({
        ...session,
        body: save({
          productReference: id(10),
          operationReference: id(105),
          priceMinor: null,
          priceScope: null,
          sectionCode: null,
          allergens: null,
        }),
      });
      expect(calls.filter((c) => c.startsWith("price"))).toEqual([]);
      expect(calls).not.toContain("menu:SaveDraft");
      // Nothing changed: the listed menu opens no draft, so nothing waits to be listed.
      expect(calls).not.toContain("menu:Revise");
      expect(state.books[0]?.prices).toEqual([{ sellableReference: id(11), amountMinor: "999" }]);
      for (const missing of [{ priceMinor: null, priceScope: null }, { sectionCode: null }])
        expect(() => parseOneStoreDishBody(save(missing))).toThrow(MerchantOneStoreDishError);
      expect(
        parseOneStoreDishBody(
          save({ productReference: id(10), priceMinor: null, priceScope: null, sectionCode: null }),
        ),
      ).toMatchObject({ priceMinor: null, sectionCode: null });
    });
  });

  it("WP-2423 (v15 batch 5): a price at this Store only is live at once and leaves nothing to list", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    await dishes.command({ ...session, body: listAll(id(101), state) });
    state.multiStore = true;
    calls.length = 0;
    const result = await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(140),
        priceMinor: "1350",
        priceScope: "ThisStore",
        expectedPriceMinor: "1288",
      }),
    });
    expect(calls).toEqual(["product:read", "storePrice:ChangeStorePrice", "allergens:DeclareDish"]);
    expect(state.published).toBe(true);
    expect(result).toMatchObject({ listingNeeded: false, price: { storePriceMinor: "1350" } });
    // The same price with a new name: the name waits for "List it", the price does not.
    calls.length = 0;
    const renamed = await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(141),
        name: "Dan dan noodles, spicy (TEST)",
        priceMinor: "1400",
        priceScope: "ThisStore",
        expectedPriceMinor: "1350",
      }),
    });
    expect(calls.slice(0, 3)).toEqual(["product:read", "menu:Revise", "product:SaveDraft"]);
    expect(calls).toContain("storePrice:ChangeStorePrice");
    expect(renamed).toMatchObject({ listingNeeded: true, price: { storePriceMinor: "1400" } });
  });

  it("WP-2423 (v15 batch 5): changed allergens on a listed dish are listed with the menu", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    await dishes.command({ ...session, body: listAll(id(101), state) });
    calls.length = 0;
    const result = await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(142),
        priceMinor: null,
        priceScope: null,
        allergens: [{ allergenReference: PEANUT, classification: "CrossContactPossible" }],
      }),
    });
    expect(calls).toEqual(["product:read", "menu:Revise", "allergens:DeclareDish"]);
    expect(result).toMatchObject({ listingNeeded: true });
  });

  it("WP-2423 item 8 ⑦: declares a charge with no stock ingredients in the same save", async () => {
    const { calls, dishes } = fakes();
    await dishes.command({
      ...session,
      body: save({ choiceGroups: [], allergens: "NoIngredients" }),
    });
    expect(calls).toContain("allergens:DeclareNoIngredients");
    expect(calls).not.toContain("allergens:DeclareDish");
    expect(() => parseOneStoreDishBody(save({ allergens: "Tea" }))).toThrow(
      MerchantOneStoreDishError,
    );
  });

  it("publishes nothing when the menu itself could not be listed (v15 2026-10-29 c)", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    calls.length = 0;
    state.menuRefused = true;
    await expect(
      dishes.command({
        ...session,
        body: listAll(id(102), state),
      }),
    ).rejects.toMatchObject({ code: "OptionRecipeMissing" });
    // A gap carrying choices may fill is checked again after it; still refused, nothing listed.
    expect(calls).toEqual(["menu:Check", "menu:Check"]);
    expect(state.assigned).toBeNull();
  });

  it("WP-2423: a stop while carrying choices to new quantities says nothing was listed", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    calls.length = 0;
    // The check finds choices without their recipes (a group's new quantities): carrying them
    // over stops.
    state.menuRefused = true;
    state.extendFails = new Error("lock timeout");
    const stopped = await dishes
      .command({
        ...session,
        body: listAll(id(103), state),
      })
      .catch((error: unknown) => error);
    expect(stopped).toMatchObject({
      name: "MerchantOneStoreDishError",
      code: "ChoiceRecipesStopped",
    });
    // Checked once, nothing published: the prices sentence would be false.
    expect(calls).toEqual(["menu:Check"]);
    expect(state.assigned).toBeNull();
  });

  it("lists the price book, the waiting choice prices and the menu, alone at the one store", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    calls.length = 0;
    await dishes.command({
      ...session,
      body: listAll(id(101), state),
    });
    expect(calls).toEqual([
      // v15 2026-10-29 c: the menu is checked before any price is published.
      "menu:Check",
      "price:Publish",
      "price:AssignToStore",
      "optionPrice:Publish",
      "menu:List",
    ]);
    expect(state.assigned).toBe(id(20));
    expect(state.offered.get(id(11))).toBe("Available");
    expect(state.optionPrices.get(HOT)).toEqual({ price: "50", pending: null });
    // A price change after listing opens a new draft copied from the charged book.
    calls.length = 0;
    await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(102),
        priceMinor: "1388",
        expectedPriceMinor: "1288",
        allergens: null,
      }),
    });
    expect(calls).toEqual(["product:read", "menu:Revise", "price:CreateDraft", "price:SaveDraft"]);
    expect(state.books[1]?.prices).toEqual([{ sellableReference: id(11), amountMinor: "1388" }]);
  });

  it("publishes a long list of waiting choice prices in steps one publish can take", async () => {
    const { state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    for (let n = 0; n < 230; n++)
      state.optionPrices.set(id(5000 + n), { price: null, pending: "80" });
    await dishes.command({
      ...session,
      body: listAll(id(104), state),
    });
    expect(state.publishedRuleCounts.every((count) => count <= 100)).toBe(true);
    expect([...state.optionPrices.values()].every((v) => v.pending === null)).toBe(true);
  });

  it("WP-2423 M71: lists the menu's own price draft as reviewed, never a Prices-page change", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    // Someone started a price change on the Prices page.
    state.books.push({
      priceBookReference: id(29),
      lifecycle: "Draft",
      createdAt: "2026-10-28T20:00:00.000Z",
      aggregateVersion: 2,
      prices: [{ sellableReference: id(11), amountMinor: "1500" }],
      purpose: "PriceChange",
      startedBy: id(51),
    });
    // Confirmed for an older version of the menu's draft: nothing is checked or listed.
    calls.length = 0;
    await expect(
      dishes.command({
        ...session,
        body: listAll(id(110), state, { priceBookReference: id(20), aggregateVersion: 1 }),
      }),
    ).rejects.toMatchObject({ code: "PricesChangedSinceShown" });
    expect(calls).toEqual([]);
    await dishes.command({ ...session, body: listAll(id(111), state) });
    expect(state.assigned).toBe(id(20));
    expect(state.books.find((b) => b.priceBookReference === id(29))?.lifecycle).toBe("Draft");
    expect(calls.filter((c) => c === "price:Publish")).toHaveLength(1);
  });

  it("WP-2423 M70: a price saved, then the options alone, writes the price once", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save({ choiceGroups: [] }) });
    await dishes.command({ ...session, body: listAll(id(120), state) });
    calls.length = 0;
    // The editor stays open: the price changes (its answer says what the prices are now) …
    const priced = await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(121),
        priceMinor: "1388",
        expectedPriceMinor: "1288",
        choiceGroups: [],
        allergens: null,
      }),
    });
    expect(priced).toMatchObject({
      price: { brandPriceMinor: "1288", pendingBrandPriceMinor: "1388", storePriceMinor: null },
    });
    // … then only a choice changes: no price is sent, so none is written again.
    calls.length = 0;
    await dishes.command({
      ...session,
      body: save({
        productReference: id(10),
        operationReference: id(122),
        priceMinor: null,
        priceScope: null,
        allergens: null,
      }),
    });
    expect(calls.filter((c) => c.startsWith("price:"))).toEqual([]);
    // A price edit against what was there before the first change is refused, not written.
    await expect(
      dishes.command({
        ...session,
        body: save({
          productReference: id(10),
          operationReference: id(123),
          priceMinor: "1488",
          expectedPriceMinor: "1288",
          choiceGroups: [],
          allergens: null,
        }),
      }),
    ).rejects.toMatchObject({ code: "PriceChanged" });
  });

  it("WP-2423 M69: a dish without allergens is refused before anything slow runs", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save({ allergens: null }) });
    state.recipeMissing = true;
    state.extendFails = new Error("must not run");
    calls.length = 0;
    await expect(
      dishes.command({ ...session, body: listAll(id(130), state) }),
    ).rejects.toMatchObject({ code: "ReviewBlocked", problem: { missing: "Recipe" } });
    expect(calls).toEqual(["menu:Check"]);
  });

  it("accepts only a whole dish or a listing", () => {
    expect(parseOneStoreDishBody(save()).action).toBe("SaveDish");
    for (const bad of [
      save({ extra: 1 }),
      save({ name: " " }),
      save({ priceMinor: "12.88" }),
      // WP-2423 M70: a price says where it changes; a new dish's first price is for every Store.
      save({ priceScope: null }),
      save({ priceScope: "ThisStore" }),
      save({
        priceMinor: null,
        priceScope: null,
        expectedPriceMinor: "100",
        productReference: id(10),
      }),
      save({ sectionCode: "noodles" }),
      save({ allergens: [{ allergenReference: PEANUT, classification: "Absent" }] }),
      // WP-2423 (M76): the combo's own "no allergens of its own" is never taken from a request.
      save({ allergens: "ComboParts" }),
      save({ choiceGroups: [{ optionSetReference: SPICE, options: [] }] }),
    ])
      expect(() => parseOneStoreDishBody(bad)).toThrow(MerchantOneStoreDishError);
    // WP-2423 (M76): "No" is an answer, sent for every allergen the dish does not contain.
    expect(
      parseOneStoreDishBody(
        save({ allergens: [{ allergenReference: PEANUT, classification: "None" }] }),
      ).action,
    ).toBe("SaveDish");
  });

  it("lists a dish no one decided at the store as offered, and leaves a hidden one hidden", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    // The size was placed on the menu without being offered (e.g. made on the product page),
    // and another size on the menu was hidden by staff.
    state.offered.delete(id(11));
    state.menu.sections[0]?.items.push({ skuReference: id(12), featured: false });
    calls.length = 0;
    await dishes.command({
      ...session,
      body: listAll(id(103), state),
    });
    expect(calls.filter((c) => c.startsWith("availability"))).toEqual(["availability:Offer"]);
    expect(state.offered.get(id(11))).toBe("Available");
    expect(state.offered.get(id(12))).toBe("Hidden");
  });
});

describe("one-page menu combos (WP-2423 item 8 ⑥ part 4)", () => {
  const combo = (overrides: Record<string, unknown> = {}) => ({
    action: "SaveCombo",
    operationReference: id(60),
    menuReference: MENU,
    bundleReference: null,
    expectedAggregateVersion: null,
    sectionCode: "COMBOS",
    name: "Combo for two (TEST)",
    nameZh: "二人套餐",
    description: "",
    descriptionZh: "",
    taxClassificationReference: TAX,
    priceMinor: "2880",
    slots: [
      {
        code: null,
        name: "Soup",
        nameZh: "汤",
        minimum: 1,
        maximum: 1,
        dishes: [
          { skuReference: id(61), upgradeMinor: "0" },
          { skuReference: id(62), upgradeMinor: "100" },
        ],
      },
    ],
    ...overrides,
  });
  const slot = (overrides: Record<string, unknown>) => ({
    ...combo().slots[0],
    ...overrides,
  });

  it("reads a combo: its slots, how many guests choose and each dish's extra price", () => {
    expect(parseOneStoreDishBody(combo())).toMatchObject({
      action: "SaveCombo",
      bundleReference: null,
      slots: [{ code: null, nameZh: "汤", minimum: 1, maximum: 1 }],
    });
    expect(
      parseOneStoreDishBody(
        combo({
          bundleReference: id(63),
          expectedAggregateVersion: 3,
          slots: [slot({ code: "SLOT-1" }), slot({ code: null, name: "Main" })],
        }),
      ),
    ).toMatchObject({ expectedAggregateVersion: 3, slots: [{ code: "SLOT-1" }, { code: null }] });
  });

  it("refuses a combo guests could not complete or that is not what it says", () => {
    for (const body of [
      combo({ slots: [] }),
      combo({ slots: [slot({ minimum: 2, maximum: 1 })] }),
      // More to choose than dishes offered.
      combo({ slots: [slot({ minimum: 3, maximum: 3 })] }),
      combo({ slots: [slot({ maximum: 0, minimum: 0 })] }),
      // One dish twice in a slot.
      combo({
        slots: [
          slot({
            dishes: [
              { skuReference: id(61), upgradeMinor: "0" },
              { skuReference: id(61), upgradeMinor: "0" },
            ],
          }),
        ],
      }),
      combo({ slots: [slot({ code: "SOUP" })] }),
      combo({ slots: [slot({ code: "SLOT-1" }), slot({ code: "SLOT-1" })] }),
      combo({ priceMinor: "28.80" }),
      combo({ bundleReference: id(63) }),
      combo({ description: "x".repeat(121) }),
      { ...combo(), extra: true },
    ])
      expect(() => parseOneStoreDishBody(body)).toThrow(MerchantOneStoreDishError);
  });

  it("cannot save a combo where combos are not set up", async () => {
    const { dishes } = fakes();
    await expect(
      dishes.command({ sessionCookie: "c", csrf: "x", body: combo() }),
    ).rejects.toMatchObject({ code: "NotFound" });
  });
});

describe("WP-2423 (M166): what a choice adds, answered in the dish save", () => {
  it("reads each answered choice of the dish once; refuses another dish's choice or a No", () => {
    const body = parseOneStoreDishBody(
      save({
        choiceAllergens: [
          {
            optionReference: HOT,
            name: "Hot",
            declared: [{ allergenReference: PEANUT, classification: "Contains" }],
          },
          { optionReference: MILD, name: "Mild", declared: [] },
        ],
      }),
    );
    expect(body.action === "SaveDish" ? body.choiceAllergens : null).toEqual([
      {
        optionReference: HOT,
        name: "Hot",
        declared: [{ allergenReference: PEANUT, classification: "Contains" }],
      },
      { optionReference: MILD, name: "Mild", declared: [] },
    ]);
    for (const choiceAllergens of [
      [{ optionReference: id(999), name: "Other", declared: [] }],
      [
        { optionReference: HOT, name: "Hot", declared: [] },
        { optionReference: HOT, name: "Hot", declared: [] },
      ],
      [
        {
          optionReference: HOT,
          name: "Hot",
          declared: [{ allergenReference: PEANUT, classification: "None" }],
        },
      ],
    ])
      expect(() => parseOneStoreDishBody(save({ choiceAllergens }))).toThrow(
        MerchantOneStoreDishError,
      );
    // An older client sends none: every choice keeps what it adds.
    const older = parseOneStoreDishBody(save());
    expect(older.action === "SaveDish" && "choiceAllergens" in older).toBe(false);
  });
});

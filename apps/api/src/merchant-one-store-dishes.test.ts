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
    }[],
    assigned: null as string | null,
    optionPrices: new Map<string, { price: string | null; pending: string | null }>(),
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
    /** The menu's own check refuses (a choice without a recipe). */
    menuRefused: false,
    // Store availability by size: absent = never decided here (NotOffered).
    offered: new Map<string, string>([[id(12), "Hidden"]]),
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
      query: async () => ({ product: state.product }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("product", body);
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
          return { product: { productReference: id(10) } };
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
        return {};
      },
    },
    prices: {
      query: async ({ priceBookReference }: { priceBookReference: string | null }) => {
        if (priceBookReference === null)
          return {
            books: state.books,
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
    optionPrices: {
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
                      options: [MILD, HOT].map((o) => ({
                        optionReference: o,
                        ruleReference: id(31),
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
        else
          for (const [k, v] of state.optionPrices)
            state.optionPrices.set(k, { price: v.pending ?? v.price, pending: null });
        return {};
      },
    },
    menus: {
      query: async () => ({
        menu: state.menu,
        publication: state.published ? { state: "Published" } : null,
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("menu", body);
        if (body.action === "Check") {
          if (state.menuRefused)
            throw Object.assign(new Error("refused"), { code: "OptionRecipeMissing" });
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
      query: async () => ({
        options: [MILD, HOT].map((o) => {
          const r = state.optionRecipes.get(o);
          return {
            bindingReference: id(30),
            optionReference: o,
            sizes: [{ skuReference: id(11) }],
            covered: r?.published === true,
            change:
              r === undefined
                ? null
                : {
                    changeVersionReference: id(40),
                    version: 1,
                    published: r.published,
                    reviews: r.reviews.map((kind) => ({ kind, decision: "Approved" })),
                  },
          };
        }),
      }),
      command: async ({ body }: { body: Record<string, unknown> }) => {
        record("optionRecipe", body);
        const o = String(body.optionReference ?? "");
        if (body.action === "Save") state.optionRecipes.set(o, { published: false, reviews: [] });
        for (const [k, v] of state.optionRecipes) {
          if (body.action === "Review" && !v.published) v.reviews.push(String(body.kind));
          if (body.action === "Publish" && v.reviews.length === 2)
            state.optionRecipes.set(k, { ...v, published: true });
        }
        return {};
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

describe("WP-2423 item 8 ⑥ one dish saved from the one-page menu", () => {
  it("does each page's step in order, then a retry changes nothing", async () => {
    const { calls, state, dishes } = fakes();
    expect(await dishes.command({ ...session, body: save() })).toMatchObject({
      status: "Saved",
      skuReference: id(11),
    });
    expect(calls).toEqual([
      "product:Create",
      "product:SaveDraft",
      "product:StartSelling",
      "availability:Offer",
      "price:CreateDraft",
      "price:SaveDraft",
      "optionPrice:SetPrices",
      "menu:Revise",
      "menu:SaveDraft",
      "allergens:DeclareDish",
      "optionRecipe:Save",
      "optionRecipe:Review",
      "optionRecipe:Review",
      "optionRecipe:Publish",
      "optionRecipe:Save",
      "optionRecipe:Review",
      "optionRecipe:Review",
      "optionRecipe:Publish",
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
    expect(calls).toEqual(["allergens:DeclareDish"]);
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
        body: { action: "ListAll", operationReference: id(102), menuReference: MENU },
      }),
    ).rejects.toMatchObject({ code: "OptionRecipeMissing" });
    expect(calls).toEqual(["menu:Check"]);
    expect(state.assigned).toBeNull();
  });

  it("lists the price book, the waiting choice prices and the menu, alone at the one store", async () => {
    const { calls, state, dishes } = fakes();
    await dishes.command({ ...session, body: save() });
    calls.length = 0;
    await dishes.command({
      ...session,
      body: { action: "ListAll", operationReference: id(101), menuReference: MENU },
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
        allergens: null,
      }),
    });
    expect(calls).toEqual(["price:CreateDraft", "price:SaveDraft", "menu:Revise"]);
    expect(state.books[1]?.prices).toEqual([{ sellableReference: id(11), amountMinor: "1388" }]);
  });

  it("accepts only a whole dish or a listing", () => {
    expect(parseOneStoreDishBody(save()).action).toBe("SaveDish");
    for (const bad of [
      save({ extra: 1 }),
      save({ name: " " }),
      save({ priceMinor: "12.88" }),
      save({ sectionCode: "noodles" }),
      save({ allergens: [{ allergenReference: PEANUT, classification: "None" }] }),
      save({ choiceGroups: [{ optionSetReference: SPICE, options: [] }] }),
    ])
      expect(() => parseOneStoreDishBody(bad)).toThrow(MerchantOneStoreDishError);
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
      body: { action: "ListAll", operationReference: id(103), menuReference: MENU },
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

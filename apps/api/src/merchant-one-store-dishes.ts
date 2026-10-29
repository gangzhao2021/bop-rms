import { derivedReference } from "./merchant-products.js";
import type { createMerchantAvailability } from "./merchant-availability.js";
import type { ComboSlot, ComboView, createMerchantCombos } from "./merchant-combos.js";
import type { createMerchantDishAllergens } from "./merchant-dish-allergens.js";
import type { createMerchantMenus } from "./merchant-menus.js";
import type { createMerchantOptionPrices } from "./merchant-option-prices.js";
import type { createMerchantOptionRecipes } from "./merchant-option-recipes.js";
import type { createMerchantOptionSets } from "./merchant-option-sets.js";
import type { createMerchantPrices } from "./merchant-prices.js";
import type { createMerchantProducts } from "./merchant-products.js";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decisions 7–8): one dish edited on
 * the one-page menu of a single store, and "List it" for everything edited there. A save does,
 * in order, what staff would otherwise do on six pages, each through that page's own command
 * (its permissions, versions and records unchanged): the product (both names and descriptions,
 * tax class, choice groups), its price in the store's open price book draft, its choice prices
 * (waiting to be published), its place in a menu section, its allergens declared by staff, and
 * a "no change" option recipe for each choice that has none. Each step is skipped when it
 * already holds, so retrying the same save continues where it stopped. Guests see nothing until
 * "List it" publishes the price book (and makes it the store's), the waiting choice prices and the
 * menu — each alone at the Brand's one store, recorded as single-store listings.
 */
export class MerchantOneStoreDishError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "NotFound"
      /** The dish has more than one size; sizes are edited on the product page. */
      | "ManySizes"
      /** The menu has no section with that code. */
      | "NoSection"
      /** Someone else's price changes are waiting; they list them (or discard them) first. */
      | "OthersPending"
      /** A combo offers a dish that is not on the menu (or a combo itself). */
      | "NotADish"
      /** A dish in a combo has no allergens declared yet (guests see them per chosen dish). */
      | "DishAllergensMissing"
      /**
       * A dish in a combo has a real recipe: until the combo's choices carry recipes (and stock),
       * combos offer dishes whose allergens staff declared.
       */
      | "DishHasRecipe",
  ) {
    super(code);
    this.name = "MerchantOneStoreDishError";
  }
}
const fail = (code: MerchantOneStoreDishError["code"]): never => {
  throw new MerchantOneStoreDishError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const amount = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,6})$/u.test(value) ? value : fail("Invalid");
const text = (value: unknown, max: number, required: boolean): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim();
  if ((required && trimmed === "") || trimmed.length > max || /[\p{Cc}\p{Cf}]/u.test(trimmed))
    return fail("Invalid");
  return trimmed;
};

export interface SaveDishBody {
  readonly action: "SaveDish";
  readonly operationReference: string;
  readonly menuReference: string;
  /** null: a new dish (one size). */
  readonly productReference: string | null;
  readonly sectionCode: string;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string;
  readonly priceMinor: string;
  readonly choiceGroups: readonly {
    readonly optionSetReference: string;
    readonly options: readonly { readonly optionReference: string; readonly amountMinor: string }[];
  }[];
  /** null: allergens not declared in this save. */
  readonly allergens:
    | readonly {
        readonly allergenReference: string;
        readonly classification: "Contains" | "CrossContactPossible";
      }[]
    | null;
}
export interface ListAllBody {
  readonly action: "ListAll";
  readonly operationReference: string;
  readonly menuReference: string;
}
/**
 * WP-2423 item 8 ⑥ part 4: a combo saved from the one-page menu — its names, price, tax class,
 * section and slots (each: names, how many guests choose, the dishes offered with any extra price).
 */
export interface SaveComboBody {
  readonly action: "SaveCombo";
  readonly operationReference: string;
  readonly menuReference: string;
  /** null: a new combo. */
  readonly bundleReference: string | null;
  readonly expectedAggregateVersion: number | null;
  readonly sectionCode: string;
  readonly name: string;
  readonly nameZh: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly taxClassificationReference: string;
  readonly priceMinor: string;
  readonly slots: readonly {
    /** null: a new slot. */
    readonly code: string | null;
    readonly name: string;
    readonly nameZh: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly dishes: readonly { readonly skuReference: string; readonly upgradeMinor: string }[];
  }[];
}
const slotCode = /^SLOT-[1-9][0-9]?$/u;
function parseSaveCombo(r: Record<string, unknown>): SaveComboBody {
  if (
    Object.keys(r).sort().join(",") !==
      "action,bundleReference,description,descriptionZh,expectedAggregateVersion,menuReference,name,nameZh,operationReference,priceMinor,sectionCode,slots,taxClassificationReference" ||
    !Array.isArray(r.slots) ||
    r.slots.length < 1 ||
    r.slots.length > 8 ||
    (r.bundleReference === null) !== (r.expectedAggregateVersion === null) ||
    (r.expectedAggregateVersion !== null &&
      (!Number.isSafeInteger(r.expectedAggregateVersion) ||
        (r.expectedAggregateVersion as number) < 1))
  )
    return fail("Invalid");
  const slots = r.slots.map((candidate: unknown) => {
    const g = candidate as Record<string, unknown> | null;
    if (
      g === null ||
      typeof g !== "object" ||
      Object.keys(g).sort().join(",") !== "code,dishes,maximum,minimum,name,nameZh" ||
      (g.code !== null && (typeof g.code !== "string" || !slotCode.test(g.code))) ||
      !Array.isArray(g.dishes) ||
      g.dishes.length < 1 ||
      g.dishes.length > 20 ||
      !Number.isSafeInteger(g.minimum) ||
      !Number.isSafeInteger(g.maximum)
    )
      return fail("Invalid");
    const dishes = g.dishes.map((candidateDish: unknown) => {
      const d = candidateDish as Record<string, unknown> | null;
      if (
        d === null ||
        typeof d !== "object" ||
        Object.keys(d).sort().join(",") !== "skuReference,upgradeMinor"
      )
        return fail("Invalid");
      return { skuReference: ref(d.skuReference), upgradeMinor: amount(d.upgradeMinor) };
    });
    const minimum = g.minimum as number;
    const maximum = g.maximum as number;
    if (
      minimum < 0 ||
      maximum < 1 ||
      minimum > maximum ||
      maximum > dishes.length ||
      new Set(dishes.map((d) => d.skuReference)).size !== dishes.length
    )
      return fail("Invalid");
    return {
      code: g.code as string | null,
      name: text(g.name, 80, true),
      nameZh: text(g.nameZh, 80, false),
      minimum,
      maximum,
      dishes,
    };
  });
  const codes = slots.flatMap((slot) => (slot.code === null ? [] : [slot.code]));
  if (new Set(codes).size !== codes.length) return fail("Invalid");
  const sectionCode = typeof r.sectionCode === "string" ? r.sectionCode : "";
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(sectionCode)) return fail("Invalid");
  return {
    action: "SaveCombo",
    operationReference: ref(r.operationReference),
    menuReference: ref(r.menuReference),
    bundleReference: r.bundleReference === null ? null : ref(r.bundleReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number | null,
    sectionCode,
    name: text(r.name, 80, true),
    nameZh: text(r.nameZh, 80, false),
    // A Bundle description is at most 120 characters.
    description: text(r.description, 120, false),
    descriptionZh: text(r.descriptionZh, 120, false),
    taxClassificationReference: ref(r.taxClassificationReference),
    priceMinor: amount(r.priceMinor),
    slots,
  };
}

export function parseOneStoreDishBody(value: unknown): SaveDishBody | ListAllBody | SaveComboBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (r.action === "SaveCombo") return parseSaveCombo(r);
  const keys = Object.keys(r).sort().join(",");
  if (r.action === "ListAll" && keys === "action,menuReference,operationReference")
    return {
      action: "ListAll",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
    };
  if (
    r.action !== "SaveDish" ||
    keys !==
      "action,allergens,choiceGroups,description,descriptionZh,menuReference,name,nameZh,operationReference,priceMinor,productReference,sectionCode,taxClassificationReference" ||
    !Array.isArray(r.choiceGroups) ||
    r.choiceGroups.length > 12 ||
    (r.allergens !== null && (!Array.isArray(r.allergens) || r.allergens.length > 64))
  )
    return fail("Invalid");
  const choiceGroups = r.choiceGroups.map((candidate: unknown) => {
    const g = candidate as Record<string, unknown> | null;
    if (
      g === null ||
      typeof g !== "object" ||
      Object.keys(g).sort().join(",") !== "optionSetReference,options" ||
      !Array.isArray(g.options) ||
      g.options.length < 1 ||
      g.options.length > 50
    )
      return fail("Invalid");
    return {
      optionSetReference: ref(g.optionSetReference),
      options: g.options.map((candidateOption: unknown) => {
        const o = candidateOption as Record<string, unknown> | null;
        if (
          o === null ||
          typeof o !== "object" ||
          Object.keys(o).sort().join(",") !== "amountMinor,optionReference"
        )
          return fail("Invalid");
        return { optionReference: ref(o.optionReference), amountMinor: amount(o.amountMinor) };
      }),
    };
  });
  if (
    new Set(choiceGroups.map((g) => g.optionSetReference)).size !== choiceGroups.length ||
    new Set(choiceGroups.flatMap((g) => g.options.map((o) => o.optionReference))).size !==
      choiceGroups.reduce((n, g) => n + g.options.length, 0)
  )
    return fail("Invalid");
  const allergens =
    r.allergens === null
      ? null
      : (r.allergens as unknown[]).map((candidate) => {
          const a = candidate as Record<string, unknown> | null;
          if (
            a === null ||
            typeof a !== "object" ||
            Object.keys(a).sort().join(",") !== "allergenReference,classification" ||
            (a.classification !== "Contains" && a.classification !== "CrossContactPossible")
          )
            return fail("Invalid");
          return {
            allergenReference: ref(a.allergenReference),
            classification: a.classification as "Contains" | "CrossContactPossible",
          };
        });
  const sectionCode = typeof r.sectionCode === "string" ? r.sectionCode : "";
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(sectionCode)) return fail("Invalid");
  return {
    action: "SaveDish",
    operationReference: ref(r.operationReference),
    menuReference: ref(r.menuReference),
    productReference: r.productReference === null ? null : ref(r.productReference),
    sectionCode,
    name: text(r.name, 80, true),
    nameZh: text(r.nameZh, 80, false),
    description: text(r.description, 240, false),
    descriptionZh: text(r.descriptionZh, 240, false),
    taxClassificationReference: ref(r.taxClassificationReference),
    priceMinor: amount(r.priceMinor),
    choiceGroups,
    allergens,
  };
}

/** A product code for a new dish, from its save (stable across retries). */
export function newDishCode(operationReference: string): string {
  return "DISH-" + operationReference.replaceAll("-", "").slice(-10).toUpperCase();
}

interface Session {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
}
interface ProductDetail {
  readonly productReference: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly name: string;
  readonly nameZh: string;
  readonly taxClassificationReference: string;
  readonly sizes: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly name: string;
    readonly nameZh: string;
    readonly lifecycle: string;
  }[];
  readonly optionSets: readonly {
    readonly optionSetReference: string;
    readonly enabledOptionReferences: readonly string[];
  }[];
  readonly presentation: {
    readonly description: string;
    readonly descriptionZh: string;
    readonly photo: { readonly imageReference: string; readonly altText: string } | null;
  };
}
interface MenuSection {
  readonly sectionReference: string;
  readonly code: string;
  readonly name: string;
  readonly nameZh?: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
interface MenuBuilder {
  readonly menu: {
    readonly aggregateVersion: number;
    readonly versionReference: string;
    readonly name: string;
    readonly sections: readonly MenuSection[];
  };
  /** The version's review and publication; null while it is being edited. */
  readonly publication: { readonly state: string } | null;
}

export function createMerchantOneStoreDishes(options: {
  readonly products: Pick<ReturnType<typeof createMerchantProducts>, "query" | "command">;
  readonly prices: ReturnType<typeof createMerchantPrices>;
  readonly optionPrices: ReturnType<typeof createMerchantOptionPrices>;
  readonly menus: ReturnType<typeof createMerchantMenus>;
  readonly dishAllergens: ReturnType<typeof createMerchantDishAllergens>;
  readonly optionRecipes: ReturnType<typeof createMerchantOptionRecipes>;
  readonly availability: Pick<ReturnType<typeof createMerchantAvailability>, "query" | "command">;
  /** WP-2423 item 8 ⑥ part 4: combos (absent: combos cannot be saved; "List it" skips them). */
  readonly combos?: Pick<
    ReturnType<typeof createMerchantCombos>,
    "query" | "saveBundle" | "recordDish" | "listDrafts"
  >;
  readonly optionSets?: Pick<ReturnType<typeof createMerchantOptionSets>, "query" | "command">;
  readonly now: () => string;
}) {
  /**
   * v15 2026-10-28 finding d: guests at the store see a size only once it is offered there (an
   * availability rule); a size never decided at the store ("NotOffered", no rule) stays off the
   * guest menu whatever the menu says. A size staff hid keeps its stopped offer (decided here) and
   * is left alone.
   */
  const offerUndecided = async (
    session: Session,
    skuReferences: ReadonlySet<string>,
    step: (purpose: string) => string,
  ) => {
    const items = (
      (await options.availability.query(session)) as unknown as {
        items: readonly { skuReference: string; status: string; decidedHere?: boolean }[];
      }
    ).items;
    for (const item of items)
      if (
        skuReferences.has(item.skuReference) &&
        item.status === "NotOffered" &&
        item.decidedHere === false
      )
        await options.availability.command({
          ...session,
          body: {
            action: "Offer",
            operationReference: step("offer-" + item.skuReference.slice(-12)),
            skuReference: item.skuReference,
          },
        });
  };
  const loadMenu = async (session: Session, menuReference: string) =>
    (await options.menus.query({ ...session, menuReference })) as unknown as MenuBuilder;
  /** Opens the menu's draft when it was listed (the listed one stays for guests). */
  const editableMenu = async (session: Session, menuReference: string, step: string) => {
    let menu = await loadMenu(session, menuReference);
    if (menu.publication !== null) {
      await options.menus.command({
        ...session,
        body: {
          action: "Revise",
          operationReference: step,
          menuReference,
          expectedAggregateVersion: menu.menu.aggregateVersion,
        },
      });
      menu = await loadMenu(session, menuReference);
    }
    return menu;
  };

  /**
   * `choiceItems` (combos): the item each choice adds to the dish's recipe — the chosen dish's
   * staff-declared allergen item — instead of "no change".
   */
  const saveDish = async (
    session: Session,
    body: SaveDishBody,
    choiceItems: ReadonlyMap<string, string> = new Map(),
  ) => {
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    const product = async (productReference: string) =>
      (
        (await options.products.query({ ...session, productReference })) as unknown as {
          product: ProductDetail;
        }
      ).product;

    // 1. The product: names, descriptions, tax class and choice groups (one size).
    let productReference = body.productReference;
    if (productReference === null) {
      const code = newDishCode(body.operationReference);
      const created = (await options.products.command({
        ...session,
        body: {
          action: "Create",
          operationReference: step("product"),
          internalCode: code,
          productType: "PreparedFood",
          name: body.name,
          ...(body.nameZh ? { nameZh: body.nameZh } : {}),
          taxClassificationReference: body.taxClassificationReference,
          sizes: [
            {
              skuReference: null,
              skuCode: code + "-1",
              name: body.name,
              ...(body.nameZh ? { nameZh: body.nameZh } : {}),
            },
          ],
        },
      })) as unknown as { product: { productReference: string } };
      productReference = created.product.productReference;
    }
    let detail = await product(productReference);
    if (detail.sizes.length !== 1) return fail("ManySizes");
    const size = detail.sizes[0] ?? fail("NotFound");
    const groups = body.choiceGroups.map((g) => ({
      optionSetReference: g.optionSetReference,
      enabledOptionReferences: g.options.map((o) => o.optionReference),
    }));
    const same =
      detail.name === body.name &&
      detail.nameZh === body.nameZh &&
      size.name === body.name &&
      size.nameZh === body.nameZh &&
      detail.taxClassificationReference === body.taxClassificationReference &&
      detail.presentation.description === body.description &&
      detail.presentation.descriptionZh === body.descriptionZh &&
      JSON.stringify(detail.optionSets) === JSON.stringify(groups);
    if (!same) {
      await options.products.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: step("product-save"),
          productReference,
          expectedAggregateVersion: detail.aggregateVersion,
          name: body.name,
          nameZh: body.nameZh,
          taxClassificationReference: body.taxClassificationReference,
          sizes: [
            {
              skuReference: size.skuReference,
              skuCode: size.skuCode,
              name: body.name,
              nameZh: body.nameZh,
            },
          ],
          optionSets: groups,
          presentation: {
            description: body.description,
            descriptionZh: body.descriptionZh,
            photo:
              detail.presentation.photo === null
                ? null
                : {
                    imageReference: detail.presentation.photo.imageReference,
                    altText: detail.presentation.photo.altText,
                  },
          },
        },
      });
      detail = await product(productReference);
    }
    if (detail.lifecycle !== "Active" || detail.sizes.some((s) => s.lifecycle !== "Active"))
      await options.products.command({
        ...session,
        body: {
          action: "StartSelling",
          operationReference: step("start"),
          productReference,
          expectedAggregateVersion: detail.aggregateVersion,
        },
      });
    const sku = size.skuReference;
    // A new dish is offered at the store (one store: the store it was made for).
    if (body.productReference === null) await offerUndecided(session, new Set([sku]), step);

    // 2. The price, in the store's open price book draft (published by "List it").
    const books = (await options.prices.query({ ...session, priceBookReference: null })) as {
      books: readonly { priceBookReference: string; lifecycle: string; createdAt: string }[];
      storeAssignment: { priceBookReference: string } | null;
    };
    const charged = async () => {
      if (books.storeAssignment === null) return null;
      const book = (await options.prices.query({
        ...session,
        priceBookReference: books.storeAssignment.priceBookReference,
      })) as { book: { prices: readonly { sellableReference: string; amountMinor: string }[] } };
      return book.book.prices.find((p) => p.sellableReference === sku)?.amountMinor ?? null;
    };
    let draft = [...books.books]
      .filter((book) => book.lifecycle === "Draft")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.priceBookReference;
    if (draft !== undefined || (await charged()) !== body.priceMinor) {
      if (draft === undefined)
        draft = (
          (await options.prices.command({
            ...session,
            body: {
              action: "CreateDraft",
              operationReference: step("price-book"),
              stableCode:
                "MENU-" +
                options.now().slice(0, 10).replaceAll("-", "") +
                "-" +
                step("code").slice(-4).toUpperCase(),
              copyFrom: books.storeAssignment?.priceBookReference ?? null,
            },
          })) as { priceBookReference: string }
        ).priceBookReference;
      const editor = (await options.prices.query({ ...session, priceBookReference: draft })) as {
        book: {
          aggregateVersion: number;
          prices: readonly { sellableReference: string; amountMinor: string }[];
        };
        draftAuthor: string | null;
        viewer: string;
      };
      if (editor.draftAuthor !== null && editor.draftAuthor !== editor.viewer)
        return fail("OthersPending");
      if (
        editor.book.prices.find((p) => p.sellableReference === sku)?.amountMinor !== body.priceMinor
      )
        await options.prices.command({
          ...session,
          body: {
            action: "SaveDraft",
            operationReference: step("price"),
            priceBookReference: draft,
            expectedAggregateVersion: editor.book.aggregateVersion,
            prices: [
              ...editor.book.prices.filter((p) => p.sellableReference !== sku),
              { sellableReference: sku, amountMinor: body.priceMinor },
            ],
          },
        });
    }

    // 3. Choice prices (waiting until "List it").
    const wanted = new Map(
      body.choiceGroups.flatMap((g) => g.options.map((o) => [o.optionReference, o.amountMinor])),
    );
    if (wanted.size > 0) {
      const view = (await options.optionPrices.query(session)) as unknown as {
        products: readonly {
          productReference: string;
          optionSets: readonly {
            bindingReference: string;
            options: readonly {
              optionReference: string;
              aggregateVersion: number | null;
              priceMinor: string | null;
              pending: { priceMinor: string; byViewer: boolean } | null;
            }[];
          }[];
        }[];
      };
      const rows = (
        view.products.find((p) => p.productReference === productReference)?.optionSets ?? []
      ).flatMap((set) =>
        set.options.map((option) => ({ ...option, bindingReference: set.bindingReference })),
      );
      const prices = rows.flatMap((row) => {
        const want = wanted.get(row.optionReference);
        if (want === undefined) return [];
        const current = row.pending?.priceMinor ?? row.priceMinor;
        if (current === want) return [];
        if (row.pending !== null && !row.pending.byViewer) return fail("OthersPending");
        return [
          {
            bindingReference: row.bindingReference,
            optionReference: row.optionReference,
            amountMinor: want,
            expectedAggregateVersion: row.aggregateVersion,
            replacesPending: row.pending !== null,
          },
        ];
      });
      if (prices.length > 0)
        await options.optionPrices.command({
          ...session,
          body: { action: "SetPrices", operationReference: step("choice-prices"), prices },
        });
    }

    // 4. Its place on the menu (moved to the chosen section, last), in an open draft.
    const menu = await editableMenu(session, body.menuReference, step("menu-revise"));
    const target = menu.menu.sections.find((s) => s.code === body.sectionCode);
    if (target === undefined) return fail("NoSection");
    const placed = target.items.some((item) => item.skuReference === sku);
    const elsewhere = menu.menu.sections.some(
      (s) => s.code !== body.sectionCode && s.items.some((item) => item.skuReference === sku),
    );
    if (!placed || elsewhere) {
      await options.menus.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: step("menu"),
          menuReference: body.menuReference,
          expectedAggregateVersion: menu.menu.aggregateVersion,
          name: menu.menu.name,
          sections: menu.menu.sections.map((s) => ({
            sectionReference: s.sectionReference,
            code: s.code,
            name: s.name,
            nameZh: s.nameZh ?? "",
            items: [
              ...s.items.filter((item) => item.skuReference !== sku),
              ...(s.code === body.sectionCode && !placed
                ? [{ skuReference: sku, featured: false }]
                : []),
            ].map((item) => ({ skuReference: item.skuReference, featured: item.featured })),
          })),
        },
      });
    }

    // 5. Its allergens, declared by staff (a generated recipe; a real recipe is kept).
    if (body.allergens !== null)
      await options.dishAllergens.command({
        ...session,
        body: {
          action: "DeclareDish",
          operationReference: step("allergens"),
          skuReference: sku,
          allergens: body.allergens,
        },
      });

    // 6. A "no change" option recipe for each of its choices that has none yet.
    if (wanted.size > 0) {
      const recipes = (await options.optionRecipes.query(session)) as unknown as {
        options: readonly {
          bindingReference: string;
          optionReference: string;
          sizes: readonly { skuReference: string }[];
          covered: boolean;
          change: {
            changeVersionReference: string;
            version: number;
            published: boolean;
            reviews: readonly { kind: string; decision: string }[];
          } | null;
        }[];
      };
      for (const row of recipes.options.filter(
        (candidate) =>
          wanted.has(candidate.optionReference) &&
          candidate.sizes.some((s) => s.skuReference === sku) &&
          !candidate.covered,
      )) {
        const key = row.optionReference.slice(-12);
        let change = row.change;
        if (change === null || change.published) {
          await options.optionRecipes.command({
            ...session,
            body: {
              action: "Save",
              operationReference: step("option-recipe-" + key),
              bindingReference: row.bindingReference,
              optionReference: row.optionReference,
              expectedVersion: change?.version ?? null,
              change: choiceItems.has(row.optionReference)
                ? {
                    kind: "Add",
                    fromItemReference: null,
                    toItemReference: choiceItems.get(row.optionReference) ?? null,
                    quantity: "1",
                    unitCostCents: null,
                    lossPercent: "0",
                  }
                : {
                    kind: "NoChange",
                    fromItemReference: null,
                    toItemReference: null,
                    quantity: null,
                    unitCostCents: null,
                    lossPercent: "0",
                  },
            },
          });
          const again = (await options.optionRecipes.query(session)) as unknown as typeof recipes;
          change =
            again.options.find(
              (o) =>
                o.bindingReference === row.bindingReference &&
                o.optionReference === row.optionReference,
            )?.change ?? null;
          if (change === null) return fail("NotFound");
        }
        for (const kind of ["Cost", "FoodSafety"] as const)
          if (
            !change.reviews.some((review) => review.kind === kind && review.decision === "Approved")
          )
            await options.optionRecipes.command({
              ...session,
              body: {
                action: "Review",
                operationReference: step("option-review-" + kind + "-" + key),
                changeVersionReference: change.changeVersionReference,
                kind,
                decision: "Approved",
                comment: null,
                approvalMode: "SingleStoreListing",
              },
            });
        await options.optionRecipes.command({
          ...session,
          body: {
            action: "Publish",
            operationReference: step("option-publish-" + key),
            changeVersionReference: change.changeVersionReference,
          },
        });
      }
    }
    return { status: "Saved" as const, productReference, skuReference: sku };
  };

  /**
   * WP-2423 item 8 ⑥ part 4: a combo saved from the one-page menu. Each slot becomes a choice
   * group (its own, coded for the combo) whose choices stand for the slot's dishes; the combo is
   * saved as a Bundle draft with which dish each choice stands for; then it is saved as a dish at
   * the combo price with those choice groups (extra prices per choice), through the dish save
   * above. Every step is keyed by the operation, so retrying the same save continues.
   */
  const saveCombo = async (session: Session, body: SaveComboBody) => {
    if (options.combos === undefined || options.optionSets === undefined) return fail("NotFound");
    const { combos, optionSets } = options;
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    const known = (await combos.query(session)).combos;
    const current: ComboView | null =
      body.bundleReference === null
        ? null
        : (known.find((c) => c.bundleReference === body.bundleReference) ?? fail("NotFound"));
    const bundleOperation = step("bundle-save");
    const bundleReference = body.bundleReference ?? derivedReference(bundleOperation, "bundle");
    const menu = (await loadMenu(session, body.menuReference)) as MenuBuilder & {
      sellables: readonly {
        skuReference: string;
        productName: string;
        productNameZh: string;
        sizeName: string;
        active: boolean;
        allergens?: { source: string; itemReference?: string | null };
      }[];
    };
    const comboSkus = new Set(
      known.flatMap((c) => (c.skuReference === null ? [] : [c.skuReference])),
    );
    const dishLabel = (sku: string) => {
      const found = menu.sellables.find((x) => x.skuReference === sku && x.active);
      if (found === undefined || comboSkus.has(sku)) return fail("NotADish");
      // Guests see each dish's allergens in the combo: from what staff declared for the dish.
      if (found.allergens?.source === "Recipe") return fail("DishHasRecipe");
      if (found.allergens?.source !== "StaffDeclared" || !found.allergens.itemReference)
        return fail("DishAllergensMissing");
      const sized = found.sizeName !== "" && found.sizeName !== found.productName;
      return {
        name: sized ? found.productName + " — " + found.sizeName : found.productName,
        nameZh: found.productNameZh,
        itemReference: found.allergens.itemReference,
      };
    };
    const used = new Set(body.slots.flatMap((slot) => (slot.code === null ? [] : [slot.code])));
    const nextCode = () => {
      let n = 1;
      while (used.has("SLOT-" + n)) n++;
      used.add("SLOT-" + n);
      return "SLOT-" + n;
    };
    const slots: ComboSlot[] = [];
    for (const [index, slot] of body.slots.entries()) {
      const code = slot.code ?? nextCode();
      const history = (current?.choiceHistory ?? []).filter((c) => c.groupCode === code);
      const optionSetReference = history[0]?.optionSetReference ?? null;
      const labels = slot.dishes.map((d) => dishLabel(d.skuReference));
      const setBody = {
        name: slot.name,
        nameZh: slot.nameZh,
        kind: slot.maximum === 1 ? ("One" as const) : ("Any" as const),
        minimum: slot.minimum,
        maximum: slot.maximum,
        perOptionMaximum: 1,
        options: slot.dishes.map((dish, i) => ({
          optionReference:
            history.find((c) => c.dishSkuReference === dish.skuReference)?.optionReference ?? null,
          name: labels[i]?.name ?? "",
          nameZh: labels[i]?.nameZh ?? "",
          offered: true,
          // A required slot starts with its first dish(es) chosen (the guest can change them).
          defaultChoice: i < slot.minimum,
        })),
      };
      const saved = (optionSetReference === null
        ? await optionSets.command({
            ...session,
            body: {
              action: "Create",
              operationReference: step("slot-set-" + index),
              internalCode: "COMBO-" + bundleReference.slice(-12).toUpperCase() + "-" + code,
              ...setBody,
            },
          })
        : await (async () => {
            const existing = (await optionSets.query({ ...session, optionSetReference })) as {
              optionSet: { aggregateVersion: number };
            };
            return optionSets.command({
              ...session,
              body: {
                action: "Save",
                operationReference: step("slot-set-" + index),
                optionSetReference,
                expectedAggregateVersion: existing.optionSet.aggregateVersion,
                ...setBody,
              },
            });
          })()) as unknown as {
        optionSet: {
          optionSetReference: string;
          options: readonly { optionReference: string; name: string }[];
        };
      };
      // The listed choices come first, in the order given.
      slots.push({
        code,
        name: slot.name,
        nameZh: slot.nameZh,
        minimum: slot.minimum,
        maximum: slot.maximum,
        optionSetReference: saved.optionSet.optionSetReference,
        dishes: slot.dishes.map((dish, i) => {
          const option = saved.optionSet.options[i];
          if (option === undefined || option.name !== labels[i]?.name) return fail("NotFound");
          return { ...dish, optionReference: option.optionReference };
        }),
      });
    }
    await combos.saveBundle({
      ...session,
      body: {
        operationReference: bundleOperation,
        bundleReference: body.bundleReference,
        expectedAggregateVersion: body.expectedAggregateVersion,
        name: body.name,
        nameZh: body.nameZh,
        description: body.description,
        descriptionZh: body.descriptionZh,
        priceMinor: body.priceMinor,
        slots,
      },
    });
    const dish = await saveDish(
      session,
      {
        action: "SaveDish",
        operationReference: step("dish"),
        menuReference: body.menuReference,
        productReference: current?.productReference ?? null,
        sectionCode: body.sectionCode,
        name: body.name,
        nameZh: body.nameZh,
        description: body.description,
        descriptionZh: body.descriptionZh,
        taxClassificationReference: body.taxClassificationReference,
        priceMinor: body.priceMinor,
        choiceGroups: slots.map((slot) => ({
          optionSetReference: slot.optionSetReference,
          options: slot.dishes.map((d) => ({
            optionReference: d.optionReference,
            amountMinor: d.upgradeMinor,
          })),
        })),
        // The combo itself declares no allergens of its own (its recipe holds the kitchen step);
        // each choice adds its dish's.
        allergens: current?.productReference == null ? [] : null,
      },
      new Map(
        slots.flatMap((slot) =>
          slot.dishes.map((d) => [d.optionReference, dishLabel(d.skuReference).itemReference]),
        ),
      ),
    );
    if (current?.productReference == null)
      await combos.recordDish({
        ...session,
        bundleReference,
        productReference: dish.productReference,
        skuReference: dish.skuReference,
      });
    return {
      status: "Saved" as const,
      bundleReference,
      productReference: dish.productReference,
      skuReference: dish.skuReference,
    };
  };

  /** "List it": the open price book, the waiting choice prices and the menu, alone at one store. */
  const listAll = async (session: Session, body: ListAllBody) => {
    const step = (purpose: string) => derivedReference(body.operationReference, purpose);
    // Combos with saved changes first: each is listed alone at the Brand's one store.
    if (options.combos !== undefined)
      await options.combos.listDrafts({ ...session, operationReference: step("combos") });
    const books = (await options.prices.query({ ...session, priceBookReference: null })) as {
      books: readonly { priceBookReference: string; lifecycle: string; aggregateVersion: number }[];
    };
    for (const book of books.books.filter((b) => b.lifecycle === "Draft")) {
      await options.prices.command({
        ...session,
        body: {
          action: "Publish",
          operationReference: step("publish-" + book.priceBookReference.slice(-12)),
          priceBookReference: book.priceBookReference,
          expectedAggregateVersion: book.aggregateVersion,
          approvalMode: "SingleStoreListing",
        },
      });
      await options.prices.command({
        ...session,
        body: {
          action: "AssignToStore",
          operationReference: step("assign-" + book.priceBookReference.slice(-12)),
          priceBookReference: book.priceBookReference,
        },
      });
    }
    const view = (await options.optionPrices.query(session)) as unknown as {
      products: readonly {
        optionSets: readonly {
          options: readonly {
            ruleReference: string | null;
            aggregateVersion: number | null;
            pending: { byViewer: boolean } | null;
          }[];
        }[];
      }[];
    };
    const waiting = view.products.flatMap((p) =>
      p.optionSets.flatMap((s) => s.options.filter((o) => o.pending !== null)),
    );
    if (waiting.some((o) => o.pending?.byViewer !== true)) return fail("OthersPending");
    if (waiting.length > 0)
      await options.optionPrices.command({
        ...session,
        body: {
          action: "Publish",
          operationReference: step("choice-prices"),
          rules: waiting.map((o) => ({
            ruleReference: o.ruleReference ?? fail("NotFound"),
            expectedAggregateVersion: o.aggregateVersion ?? fail("NotFound"),
          })),
          approvalMode: "SingleStoreListing",
        },
      });
    // Every dish on the menu that was never decided at the store is offered with it.
    const menu = await loadMenu(session, body.menuReference);
    await offerUndecided(
      session,
      new Set(menu.menu.sections.flatMap((s) => s.items.map((item) => item.skuReference))),
      step,
    );
    return options.menus.command({
      ...session,
      body: { action: "List", operationReference: step("menu"), menuReference: body.menuReference },
    });
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOneStoreDishBody(input.body);
    const session = { sessionCookie: input.sessionCookie, csrf: input.csrf };
    return body.action === "SaveDish"
      ? saveDish(session, body)
      : body.action === "SaveCombo"
        ? saveCombo(session, body)
        : listAll(session, body);
  };
  return { command };
}

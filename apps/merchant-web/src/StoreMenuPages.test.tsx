import { describe, expect, it } from "vitest";
import {
  channelText,
  createMenuClient,
  customerViewChangeSummary,
  itemsNotOfferedHere,
  mayDiscardDraft,
  menuDraftFingerprint,
  menuDraftStore,
  parseStoredMenuDraft,
  MenuPageError,
  menuReviewProblemText,
  orderTypeText,
  menuRevisionAction,
  menuStage,
  parseMenuCustomerView,
  parseMenuRouteReference,
  priceText,
  sectionCode,
} from "./store-menu-pages.js";

const status = (state: string) => ({
  lifecycleReference: "l",
  lifecycleVersion: 1,
  state,
  snapshotDigest: "d",
  changedAt: "2026-10-08T00:00:00.000Z",
});
describe("WP-2423 Q31 unsaved menu changes kept on this device", () => {
  const content = {
    name: "Breakfast",
    sections: [
      {
        sectionReference: "a",
        code: "COFFEE",
        name: "Coffee",
        nameZh: "咖啡",
        items: [
          { skuReference: "latte-small", featured: true },
          { skuReference: "mocha", featured: false },
        ],
      },
    ],
  };
  it("compares content only, so the order of items counts and editor keys do not", () => {
    const withKeys = {
      ...content,
      sections: content.sections.map((section) => ({ ...section, key: "s9" })),
    };
    expect(menuDraftFingerprint(withKeys)).toBe(menuDraftFingerprint(content));
    const [coffee] = content.sections;
    if (coffee === undefined) throw new Error("fixture has no section");
    const reordered = {
      ...content,
      sections: [{ ...coffee, items: [...coffee.items].reverse() }],
    };
    expect(menuDraftFingerprint(reordered)).not.toBe(menuDraftFingerprint(content));
  });
  it("reads back only a well-formed kept draft", () => {
    const kept = { ...content, aggregateVersion: 4, keptAt: "2026-10-25T08:00:00.000Z" };
    expect(parseStoredMenuDraft(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
    expect(parseStoredMenuDraft({ ...kept, aggregateVersion: "4" })).toBeNull();
    expect(
      parseStoredMenuDraft({ ...kept, sections: [{ ...content.sections[0], items: [{}] }] }),
    ).toBeNull();
    expect(parseStoredMenuDraft(null)).toBeNull();
  });
  it("keeps nothing and fails quietly where the device has no storage", () => {
    expect(menuDraftStore.read("m")).toBeNull();
    expect(() => {
      menuDraftStore.write("m", { ...content, aggregateVersion: 1, keptAt: "x" });
      menuDraftStore.clear("m");
    }).not.toThrow();
  });
});

describe("WP-2423 menu page helpers", () => {
  it("names channels and order types in plain words", () => {
    expect(channelText(["CUSTOMER_PWA"])).toBe("Customer ordering app");
    expect(orderTypeText(["DINE_IN", "PICKUP"])).toBe("Dine-in, Pickup");
    expect(channelText(["NEW_CHANNEL"])).toBe("New channel");
  });
  it("lists menu items customers at this Store cannot see because they are not offered here", () => {
    const sellable = (skuReference: string, offeredHere?: boolean) => ({
      skuReference,
      skuCode: skuReference.toUpperCase(),
      productName: "Hot Chocolate",
      sizeName: skuReference,
      active: true,
      priceMinor: "400",
      ...(offeredHere === undefined ? {} : { offeredHere }),
    });
    const item = (skuReference: string) => ({
      placementReference: "p-" + skuReference,
      skuReference,
      featured: false,
    });
    const view = {
      sellables: [sellable("small", false), sellable("large", true), sellable("legacy")],
      menu: {
        sections: [
          {
            sectionReference: "a",
            code: "A",
            name: "Drinks",
            items: [item("small"), item("large")],
          },
          {
            sectionReference: "b",
            code: "B",
            name: "Kids",
            items: [item("small"), item("legacy")],
          },
        ],
      },
    } as unknown as Parameters<typeof itemsNotOfferedHere>[0];
    expect(itemsNotOfferedHere(view).map((s) => s.skuReference)).toEqual(["small"]);
  });
  it("derives section codes, stages, prices and route references", () => {
    expect(sectionCode("Café drinks & tea")).toBe("CAFE_DRINKS_TEA");
    expect(sectionCode("2 for 1")).toBe("FOR_1");
    expect(menuStage(null)).toBe("Editing");
    expect(menuStage(status("InReview"))).toBe("InReview");
    expect(menuStage(status("Approved"))).toBe("Approved");
    expect(menuStage(status("Published"))).toBe("Published");
    expect(priceText("525")).toBe("5.25");
    expect(priceText("5")).toBe("0.05");
    expect(priceText(null)).toBeNull();
    expect(parseMenuRouteReference("0190fa20-0000-7000-8000-000000000001")).toBe(
      "0190fa20-0000-7000-8000-000000000001",
    );
    expect(parseMenuRouteReference("all-day")).toBeNull();
  });
  it("offers a revision only where it is the way to change the menu, in words that match the state", () => {
    expect(menuRevisionAction("Editing", true)).toBeNull();
    expect(menuRevisionAction("Published", true)?.label).toBe("Start a revision");
    const inReview = menuRevisionAction("InReview", true);
    expect(inReview?.label).toBe("Withdraw to make changes");
    expect(inReview?.label).not.toMatch(/revision/u);
    expect(inReview?.note).toMatch(/out of review .* submitted for review again/u);
    expect(inReview?.note).toMatch(/Customers keep seeing the published menu/u);
    expect(menuRevisionAction("InReview", false)?.note).not.toMatch(/published menu/u);
    const approved = menuRevisionAction("Approved", false);
    expect(approved?.label).toBe("Withdraw to make changes");
    expect(approved?.note).toMatch(/submitted and approved again\.$/u);
    expect(menuRevisionAction("Archived", false)?.label).toBe("Start a revision");
    expect(menuRevisionAction("Archived", false)?.note).not.toMatch(/published menu/u);
  });
  it("offers discarding only an open draft of a published menu, to someone who may edit menus", () => {
    const release = {
      releaseReference: "r",
      sequence: 1,
      menuVersionReference: "v1",
      createdAt: "2026-10-16T18:05:00.000Z",
    };
    const view = (change: Record<string, unknown> = {}) =>
      ({
        permissions: { mayEdit: true },
        publication: null,
        latestRelease: release,
        menu: { versionReference: "v2" },
        ...change,
      }) as unknown as Parameters<typeof mayDiscardDraft>[0];
    expect(mayDiscardDraft(view())).toBe(true);
    expect(mayDiscardDraft(view({ permissions: { mayEdit: false } }))).toBe(false);
    // Never published: nothing to go back to. In review: withdraw it first.
    expect(mayDiscardDraft(view({ latestRelease: null }))).toBe(false);
    expect(mayDiscardDraft(view({ publication: status("InReview") }))).toBe(false);
    // The published version itself is not a draft.
    expect(mayDiscardDraft(view({ menu: { versionReference: "v1" } }))).toBe(false);
  });
  it("maps server refusals and lost connections to page errors", async () => {
    const refused = createMenuClient("csrf", async () =>
      Response.json({ error: "Frozen" }, { status: 409 }),
    );
    await expect(refused.load(null)).rejects.toMatchObject({ code: "Frozen" });
    const notDiscardable = createMenuClient("csrf", async () =>
      Response.json({ error: "NotDiscardable" }, { status: 409 }),
    );
    await expect(notDiscardable.load(null)).rejects.toMatchObject({ code: "NotDiscardable" });
    const forbidden = createMenuClient("csrf", async () => new Response("", { status: 403 }));
    await expect(forbidden.load(null)).rejects.toMatchObject({ code: "PermissionDenied" });
    const offline = createMenuClient("csrf", async () => {
      throw new TypeError("network");
    });
    await expect(offline.load(null)).rejects.toBeInstanceOf(MenuPageError);
  });
  it("says which item, size, option or ingredient blocked the review, in staff words", async () => {
    const blocked = createMenuClient("csrf", async () =>
      Response.json(
        {
          error: "ReviewBlocked",
          problem: {
            missing: "AllergenDeclaration",
            productName: "Latte",
            sizeName: "Regular",
            optionName: "Hazelnut syrup",
            quantity: 2,
            ingredientName: "Hazelnut syrup",
          },
        },
        { status: 409 },
      ),
    );
    const error = await blocked.command?.({} as never).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ReviewBlocked" });
    const problem = (error as MenuPageError).problem;
    if (problem === null) throw new Error("expected the review problem");
    expect(menuReviewProblemText(problem)).toBe(
      "The ingredient Hazelnut syrup in Latte — Regular with Hazelnut syrup × 2 has no current allergen declaration. Record or renew it under Allergens, then submit again.",
    );
    const base = {
      productName: "Latte",
      sizeName: "Latte",
      optionName: null,
      quantity: null,
      ingredientName: null,
    };
    expect(menuReviewProblemText({ ...base, missing: "Recipe" })).toBe(
      "Latte has no published recipe for this menu's Stores. Publish one under Recipes and assign it to this size, then submit again.",
    );
    expect(
      menuReviewProblemText({
        ...base,
        missing: "OptionRecipe",
        optionName: "Oat milk",
        quantity: 1,
      }),
    ).toBe(
      "Latte: the option Oat milk has no published recipe change. Set, review and publish it under Option recipes, then submit again.",
    );
    // Unknown or malformed details fall back to the general message; codes never reach staff.
    const unknown = createMenuClient("csrf", async () =>
      Response.json({ error: "ReviewBlocked", problem: { missing: "SOMETHING" } }, { status: 409 }),
    );
    expect(
      ((await unknown.command?.({} as never).catch((caught: unknown) => caught)) as MenuPageError)
        .problem,
    ).toBeNull();
  });
  it("reads what customers will see, rendering only public photo paths, and summarizes changes", () => {
    const photo = (url: string) => ({ url, width: 320, height: 240, altText: "Latte in a glass" });
    const good = "/media/images/" + "a".repeat(64) + ".jpg";
    const item = (change: Record<string, unknown>) => ({
      placementReference: "p",
      skuReference: "s",
      sectionName: "Drinks",
      name: "Latte",
      description: "Espresso and steamed milk.",
      photo: photo(good),
      newOnMenu: false,
      descriptionChange: null,
      photoChange: null,
      before: null,
      ...change,
    });
    const view = parseMenuCustomerView({
      frozenAt: "2026-10-17T14:00:00.000Z",
      comparedWithPublishedAt: "2026-10-16T18:05:00.000Z",
      items: [
        item({ newOnMenu: true, photo: photo("https://elsewhere.example/x.jpg") }),
        item({
          descriptionChange: "Changed",
          photoChange: "Replaced",
          before: { description: "Old.", photo: photo(good) },
        }),
        item({ photoChange: "Added" }),
        "not an item",
      ],
      removedFromMenu: [{ skuReference: "r", name: "Scone" }],
    });
    if (view === null) throw new Error("customer view not read");
    expect(view.items).toHaveLength(3);
    expect(view.items[0]?.photo).toBeNull();
    expect(view.items[1]?.before).toEqual({ description: "Old.", photo: photo(good) });
    expect(customerViewChangeSummary(view)).toBe(
      "1 new item, 1 description changed, 2 photos changed, 1 item removed.",
    );
    expect(
      customerViewChangeSummary({ ...view, items: [item({})] as never, removedFromMenu: [] }),
    ).toBe("No changes to items, descriptions or photos.");
    expect(customerViewChangeSummary({ ...view, comparedWithPublishedAt: null })).toBeNull();
    expect(parseMenuCustomerView(undefined)).toBeNull();
  });
});

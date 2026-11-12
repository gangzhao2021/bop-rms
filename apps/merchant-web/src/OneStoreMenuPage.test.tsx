// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { OneStoreMenuPage, listingProgressText } from "./OneStoreMenuPage.js";
import { createMenuClient } from "./store-menu-pages.js";
import { createAvailabilityClient } from "./store-availability-page.js";
import {
  buttonNamed,
  click,
  deferred,
  mount,
  selectValue,
  settle,
  typeInto,
} from "./dom-test-kit.fixture.js";

/** Synthetic, TEST-only one-page menu: two sections, one dish placed in each, one not on the menu. */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-28T19:00:00.000Z";
const MENU = id(1);
const STORE = id(99);
const tax = id(60);
const sellable = (n: number, name: string, price: string | null) => ({
  skuReference: id(n),
  skuCode: "SKU_" + n,
  productName: name,
  productNameZh: "",
  sizeName: name,
  active: true,
  priceMinor: price,
  offeredHere: true,
  productReference: id(n + 100),
  pendingPriceMinor: null,
  allergens: { source: "StaffDeclared", declared: [], noIngredients: true },
});
type Step = "Submit" | "Listed";
const builder = (version: string, step: Step, released: string | null) => ({
  screenId: "CAT-MENU-BUILDER",
  sourceAsOf: at,
  viewer: id(50),
  permissions: {
    mayRead: true,
    mayEdit: true,
    maySubmit: true,
    mayApprove: true,
    mayPublish: true,
  },
  menus: [],
  menu: {
    menuReference: MENU,
    internalCode: "MAIN",
    aggregateVersion: 3,
    versionReference: version,
    name: "TEST menu",
    storeReferences: [STORE],
    channelCodes: ["CUSTOMER_PWA"],
    orderTypeCodes: ["DINE_IN"],
    sections: [
      {
        sectionReference: id(10),
        code: "DIM",
        name: "Dim sum (TEST)",
        nameZh: "点心",
        items: [{ placementReference: id(230), skuReference: id(30), featured: false }],
      },
      {
        sectionReference: id(11),
        code: "NOODLE",
        name: "Noodles (TEST)",
        nameZh: "面",
        items: [{ placementReference: id(232), skuReference: id(32), featured: false }],
      },
    ],
  },
  publication: null,
  latestRelease:
    released === null
      ? null
      : { releaseReference: id(7), sequence: 1, menuVersionReference: released, createdAt: at },
  listingStep: step,
  submittedBy: null,
  soleOperator: null,
  allergenRegistry: false,
  sellables: [
    sellable(30, "Har gow (TEST)", "788"),
    sellable(32, "Dan dan noodles (TEST)", "1288"),
    // Taken off the menu on purpose: priced and declared, in no section.
    sellable(34, "Tea charge (TEST)", "150"),
  ],
  mayOfferHere: true,
  customerView: null,
});
const availability = {
  screenId: "CAT-AVAILABILITY",
  sourceAsOf: at,
  viewer: id(50),
  timeZone: "America/Toronto",
  permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
  items: [30, 32, 34].map((n) => ({
    skuReference: id(n),
    skuCode: "SKU_" + n,
    productName: "x",
    sizeName: "x",
    status: "Available",
    soldOutUntil: null,
  })),
};
const product = (productReference: string) => {
  const sku = Number.parseInt(productReference.slice(-12), 16) - 100;
  const name = builder(id(3), "Listed", null).sellables.find(
    (x) => x.skuReference === id(sku),
  )?.productName;
  return {
    screenId: "CAT-PRODUCT-DETAIL",
    sourceAsOf: at,
    locale: "en-CA",
    permissions: {},
    productTypes: [],
    sellingUnits: [],
    taxClasses: [
      {
        taxClassificationReference: tax,
        rules: [
          {
            orderType: "DineIn",
            taxComponentCode: "TEST_TAX",
            treatment: "Taxable",
            rate: "0.13",
            priceInclusion: "Exclusive",
          },
        ],
      },
    ],
    optionSetChoices: [],
    product: {
      productReference,
      name,
      nameZh: "",
      taxClassificationReference: tax,
      sizes: [{ skuReference: id(sku), skuCode: "SKU_" + sku, name, nameZh: "" }],
      optionSets: [],
      presentation: { description: "", descriptionZh: "", photo: null },
    },
  };
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
/** A fetch for the page's own requests; `menu` answers each menu read (in order). */
function server(
  menu: () => Promise<unknown>,
  /** Answers a one-page command instead of the usual answer (a throw: the answer is lost). */
  answer?: (body: Record<string, unknown>) => Promise<unknown> | undefined,
) {
  const sent: Record<string, unknown>[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/merchant/commerce/menus/query") return json(await menu());
    if (path === "/merchant/commerce/availability/query") return json(availability);
    if (path === "/merchant/commerce/one-store-combos/query") return json({ combos: [] });
    if (path === "/merchant/commerce/one-store-dishes/command") {
      sent.push(body);
      const own = answer?.(body);
      if (own !== undefined) return json(await own);
      return json(
        body.action === "SaveDish"
          ? { status: "Saved", productReference: body.productReference, choicesWaiting: false }
          : { status: "Listed", menuReference: MENU },
      );
    }
    if (
      path === "/merchant/commerce/kitchen-sections/command" ||
      path === "/merchant/commerce/kitchen-not-prepared/command"
    ) {
      const products = (body.productReferences as string[] | undefined) ?? [];
      return json({
        version: 1,
        sections: [],
        products: products.map((productReference) => ({
          productReference,
          sectionReference: null,
          notPrepared: false,
          version: 0,
        })),
      });
    }
    if (path === "/merchant/commerce/products/query")
      return json(product(String(body.productReference)));
    if (path === "/merchant/commerce/option-prices/query")
      return json({ screenId: "PRICE-OPTION-LIST", products: [] });
    if (path.startsWith("/merchant/counter/menu")) return json({ items: [] }, 503);
    return json({ error: "retry_later" }, 503);
  }) as typeof fetch;
  return { fetcher, sent };
}
async function page(
  menu: () => Promise<unknown>,
  answer?: (body: Record<string, unknown>) => Promise<unknown> | undefined,
) {
  const { fetcher, sent } = server(menu, answer);
  const csrf = "a".repeat(43);
  const { container } = await mount(
    <MemoryRouter initialEntries={["/app/commerce/menus"]}>
      <OneStoreMenuPage
        menuReference={MENU}
        client={createMenuClient(csrf, fetcher)}
        availability={createAvailabilityClient(csrf, fetcher)}
        onMultiStore={() => undefined}
      />
    </MemoryRouter>,
  );
  await settle(10);
  return { container, sent };
}
const pendingText = "There are saved changes not listed yet.";
afterEach(() => document.body.replaceChildren());

it("WP-2423 live minors 1/39: right after List it the page never says changes are still waiting", async () => {
  const reads: ReturnType<typeof deferred<unknown>>[] = [];
  const { container, sent } = await page(() => {
    if (reads.length === 0) {
      reads.push(deferred());
      return Promise.resolve(builder(id(3), "Submit", id(2)));
    }
    const next = deferred<unknown>();
    reads.push(next);
    return next.promise;
  });
  expect(container.textContent).toContain(pendingText);
  // WP-2423 M71: "List it" shows what goes live first; confirming it lists exactly that.
  await click(buttonNamed(container, "List it"));
  await settle(5);
  expect(container.textContent).toContain("What goes live");
  expect(sent).toEqual([]);
  await click(buttonNamed(container, "List it"));
  await settle(10);
  expect(sent.map((command) => command.action)).toEqual(["ListAll"]);
  expect(sent[0]).toMatchObject({ confirmedPriceBook: null });
  expect(container.textContent).toContain("Listed. Guests see the menu as it is now.");
  // The menu is being read again (still pending): nothing is said to wait, no List it offered.
  expect(reads.length).toBeGreaterThan(1);
  expect(container.textContent).not.toContain(pendingText);
  expect(buttonNamed(container, "List it")).toBeUndefined();
  // The read answers: the server lists that version (every part Listed). Still nothing waits.
  reads.at(-1)?.resolve(builder(id(3), "Listed", id(3)));
  await settle(10);
  expect(container.textContent).not.toContain(pendingText);
  expect(buttonNamed(container, "List it")).toBeUndefined();
  expect(container.querySelector(".one-menu__pending")).toBeNull();
});

it("WP-2423 live minors 1/39: a read after listing that shows newer saved changes says so again", async () => {
  let reads = 0;
  const { container } = await page(async () => {
    reads += 1;
    // Someone saved another change right after the listing: a newer version waits.
    return reads === 1 ? builder(id(3), "Submit", id(2)) : builder(id(4), "Submit", id(3));
  });
  await click(buttonNamed(container, "List it"));
  await settle(5);
  await click(buttonNamed(container, "List it"));
  await settle(10);
  expect(container.textContent).toContain(pendingText);
  expect(buttonNamed(container, "List it")).toBeDefined();
});

const editDish = async (container: HTMLElement, name: string) => {
  await click(container.querySelector(`button[aria-label="Edit ${name}"]`));
  await settle(10);
  const editor = container.querySelector(".dish-editor");
  if (editor === null) throw new Error("no editor");
  return editor as HTMLElement;
};

it("WP-2423 live minor 7: a read that fails after a save keeps the menu on screen, said out of date", async () => {
  let reads = 0;
  const { container, sent } = await page(async () => {
    reads += 1;
    if (reads === 1) return builder(id(3), "Listed", id(3));
    throw new TypeError("Failed to fetch");
  });
  const editor = await editDish(container, "Har gow (TEST)");
  const price = [...editor.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Price"),
  );
  await typeInto(price?.querySelector("input"), "8.28");
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(sent.map((command) => command.action)).toEqual(["SaveDish"]);
  expect(reads).toBe(2);
  // The device went offline: the menu stays, with what it is and how to read it again.
  expect(container.textContent).not.toContain("Unavailable");
  expect(container.textContent).toContain("Har gow (TEST)");
  expect(container.textContent).toContain(
    "The menu could not be read again. What you see may be out of date.",
  );
  expect(buttonNamed(container, "Read again")).toBeDefined();
});

it("WP-2423 live minor 7: the first read of the page still says it could not be read", async () => {
  const { container } = await page(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(container.textContent).toContain(
    "The menu could not be read. Check the connection and try again.",
  );
});

it("WP-2423 live minor 6: a dish not on the menu opens with no section, and saving places it where staff choose", async () => {
  const { container, sent } = await page(async () => builder(id(3), "Listed", id(3)));
  expect(container.querySelector('[aria-label="Not on the menu"]')?.textContent).toContain(
    "Tea charge (TEST)",
  );
  const editor = await editDish(container, "Tea charge (TEST)");
  const sectionSelect = [...editor.querySelectorAll("select")].find(
    (select) => select.closest("label")?.textContent?.startsWith("Section") === true,
  );
  expect(sectionSelect?.value).toBe("");
  expect(sectionSelect?.selectedOptions[0]?.textContent).toBe("Choose a section");
  expect(editor.textContent).toContain(
    "Not on the menu. Choose its section: saving puts it on the menu there (guests see it once the menu is listed).",
  );
  expect(buttonNamed(editor, "Save dish")?.hasAttribute("disabled")).toBe(true);
  await selectValue(sectionSelect, "NOODLE");
  expect(buttonNamed(editor, "Save dish")?.hasAttribute("disabled")).toBe(false);
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(sent).toEqual([expect.objectContaining({ action: "SaveDish", sectionCode: "NOODLE" })]);
});

it("WP-2423 live minor 6: a dish on the menu opens in its own section", async () => {
  const { container } = await page(async () => builder(id(3), "Listed", id(3)));
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  const sectionSelect = [...editor.querySelectorAll("select")].find(
    (select) => select.closest("label")?.textContent?.startsWith("Section") === true,
  );
  expect(sectionSelect?.value).toBe("NOODLE");
  expect(editor.textContent).not.toContain("Choose a section");
});

it("WP-2423 (M76, Owner decision 16): a dish not declared yet saves only once every allergen is answered", async () => {
  const PEANUT = id(80);
  const EGG = id(81);
  const menu = () => {
    const read = builder(id(3), "Listed", id(3));
    return {
      ...read,
      allergenRegistry: true,
      allergenChoices: [
        { allergenReference: PEANUT, code: "PEANUT", name: "Peanuts", nameZh: "" },
        { allergenReference: EGG, code: "EGG", name: "Eggs", nameZh: "" },
      ],
      sellables: read.sellables.map((sku) =>
        sku.skuReference === id(30)
          ? { ...sku, allergens: { source: "None", declared: [], noIngredients: false } }
          : sku,
      ),
    };
  };
  const { container, sent } = await page(async () => menu());
  const editor = await editDish(container, "Har gow (TEST)");
  const save = () => buttonNamed(editor, "Save dish");
  const answer = async (allergen: string, kind: number) =>
    click(editor.querySelectorAll(`[role="radiogroup"][aria-label="${allergen}"] input`)[kind]);
  // Nothing is chosen for it, and saving waits for every row.
  expect(editor.querySelectorAll('[role="radiogroup"][data-unanswered]').length).toBe(2);
  expect(save()?.hasAttribute("disabled")).toBe(true);
  expect(editor.textContent).toContain("Answer every allergen to save: 2 left.");
  await answer("Peanuts", 1);
  expect(save()?.hasAttribute("disabled")).toBe(true);
  expect(editor.textContent).toContain("Answer every allergen to save: 1 left.");
  await answer("Eggs", 0);
  expect(save()?.hasAttribute("disabled")).toBe(false);
  await click(save());
  await settle(10);
  expect(sent).toEqual([
    expect.objectContaining({
      action: "SaveDish",
      allergens: [
        { allergenReference: PEANUT, classification: "Contains" },
        { allergenReference: EGG, classification: "None" },
      ],
    }),
  ]);
});

it("WP-2423 (M77, M167): a recipe that changed a listed dish's allergens offers List it, and listing sends the menu", async () => {
  const menu = () => {
    const read = builder(id(3), "Listed", id(3));
    return {
      ...read,
      sellables: read.sellables.map((sku) =>
        sku.skuReference === id(30)
          ? {
              ...sku,
              allergens: {
                source: "Recipe",
                declared: [],
                noIngredients: false,
                changedByRecipe: true,
              },
            }
          : sku,
      ),
    };
  };
  const { container, sent } = await page(async () => menu());
  expect(container.textContent).toContain(
    "A recipe changed what some dishes contain. Guests and the kitchen already see those allergens with the listed ones; list the menu to make them the reviewed list.",
  );
  expect(container.textContent).toContain("Allergens changed since this menu was listed.");
  // WP-2423 M71: "List it" shows what goes live first; confirming it lists the menu as it is now.
  await click(buttonNamed(container, "List it"));
  expect(container.textContent).toContain("What goes live");
  await click(buttonNamed(container, "List it"));
  await settle(10);
  expect(sent.map((command) => command.action)).toEqual(["ListAll"]);
});

/** WP-2423 (v15 batch 5): a Brand with several Stores, this person may change this Store's price. */
const severalStores = () => {
  const read = builder(id(3), "Listed", id(3));
  return {
    ...read,
    stores: { severalStores: true, servesHere: true },
    pricePowers: { severalStores: true, mayAllStores: true, mayThisStore: true },
    sellables: read.sellables.map((sku) => ({
      ...sku,
      brandPriceMinor: sku.priceMinor,
      storePriceMinor: null,
      pendingBrandPriceMinor: null,
    })),
  };
};
const storePriceAnswer = (body: Record<string, unknown>, listingNeeded: boolean) => ({
  status: "Saved",
  productReference: body.productReference,
  choicesWaiting: false,
  price: {
    brandPriceMinor: "1288",
    pendingBrandPriceMinor: null,
    storePriceMinor: body.priceMinor,
  },
  listingNeeded,
});
const changeStorePrice = async (editor: HTMLElement, dollars: string) => {
  const price = [...editor.querySelectorAll("input")].find(
    (input) => input.closest("label")?.textContent?.startsWith("Price") === true,
  );
  await typeInto(price, dollars);
  const onlyHere = [...editor.querySelectorAll('input[type="radio"][name="price-scope"]')].find(
    (input) => input.closest("label")?.textContent?.includes("Only at this Store") === true,
  );
  await click(onlyHere);
};

it("WP-2423 (v15 batch 5): a price saved for this Store only says guests pay it from now, and that nothing waits to be listed", async () => {
  const { container, sent } = await page(
    async () => severalStores(),
    (body) =>
      body.action === "SaveDish" ? Promise.resolve(storePriceAnswer(body, false)) : undefined,
  );
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  await changeStorePrice(editor, "13.50");
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(sent).toEqual([
    expect.objectContaining({
      action: "SaveDish",
      priceMinor: "1350",
      priceScope: "ThisStore",
      expectedPriceMinor: "1288",
    }),
  ]);
  expect(container.textContent).toContain(
    "Dan dan noodles (TEST): guests at this Store pay $13.50 from now. Nothing else changed, so there is nothing to list.",
  );
  expect(container.textContent).not.toContain("Guests see it when the menu is listed.");
});

it("WP-2423 (v15 batch 5): a save whose answer was lost goes again unchanged, as the same save", async () => {
  let saves = 0;
  const { container, sent } = await page(
    async () => severalStores(),
    (body) => {
      if (body.action !== "SaveDish") return undefined;
      saves += 1;
      // The first save applied, but its answer never came back.
      if (saves === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(storePriceAnswer(body, false));
    },
  );
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  await changeStorePrice(editor, "13.50");
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(sent).toHaveLength(1);
  expect(container.textContent).not.toContain("guests at this Store pay");
  // Save again with nothing touched: the same save, compared with the price it was sent against.
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(container.textContent).not.toContain("This form changed after saving stopped");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1]).toMatchObject({ priceMinor: "1350", expectedPriceMinor: "1288" });
  expect(container.textContent).toContain("guests at this Store pay $13.50 from now.");
});

it("WP-2423 (v15 batch 5): What goes live names each extra price and the dishes the other Stores do not sell yet", async () => {
  const menu = () => ({
    ...severalStores(),
    listingStep: "Submit",
    choicePriceChanges: [
      {
        productReference: id(132),
        optionReference: id(90),
        optionName: "Garlic (TEST)",
        fromMinor: "50",
        toMinor: "80",
      },
      {
        productReference: id(132),
        optionReference: id(91),
        optionName: "Egg (TEST)",
        fromMinor: null,
        toMinor: "120",
      },
    ],
    otherStores: {
      storeCount: 2,
      notDecided: [id(30), id(32)],
      stores: [
        { storeName: "Midtown (TEST)", notDecided: [id(30), id(32)] },
        { storeName: null, notDecided: [id(30)] },
      ],
      listingOffers: true,
    },
  });
  const { container } = await page(async () => menu());
  await click(buttonNamed(container, "List it"));
  await settle(5);
  const review = container.querySelector('[aria-labelledby="listing-review"]');
  expect(review?.textContent).toContain("Extra prices");
  expect(review?.textContent).toContain(
    "Dan dan noodles (TEST), Garlic (TEST): +$0.50 → +$0.80 (every Store)",
  );
  expect(review?.textContent).toContain("Dan dan noodles (TEST), Egg (TEST): +$1.20 (new)");
  expect(review?.textContent).toContain(
    "New dishes go on sale at the other Stores once listed. A Store that should not sell one hides it there.",
  );
  // Every new dish at each Store, with its count: nothing goes live there unseen.
  const lines = [...(review?.querySelectorAll('[role="note"] li') ?? [])].map(
    (li) => li.textContent,
  );
  expect(lines).toEqual([
    "Midtown (TEST), 2 dishes: Har gow (TEST), Dan dan noodles (TEST)",
    "another Store, 1 dish: Har gow (TEST)",
  ]);
});

it("WP-2423 (v15 batch 5): without the Brand's say over other Stores, the review says the new dish stays hidden there", async () => {
  const { container } = await page(async () => ({
    ...severalStores(),
    listingStep: "Submit",
    otherStores: {
      storeCount: 1,
      notDecided: [id(30)],
      stores: [{ storeName: "Midtown (TEST)", notDecided: [id(30)] }],
      listingOffers: false,
    },
  }));
  await click(buttonNamed(container, "List it"));
  await settle(5);
  expect(container.textContent).toContain(
    "New dishes stay hidden at the other Stores until each Store shows them to guests.",
  );
  expect(container.textContent).toContain("Midtown (TEST), 1 dish: Har gow (TEST)");
});

/** The page as the app shows it, rendered again with a client made anew (the app re-rendering). */
async function pageRenderedAgain(
  menu: () => Promise<unknown>,
  answer?: (body: Record<string, unknown>) => Promise<unknown> | undefined,
) {
  const { fetcher, sent } = server(menu, answer);
  const csrf = "a".repeat(43);
  const node = () => (
    <MemoryRouter initialEntries={["/app/commerce/menus"]}>
      <OneStoreMenuPage
        menuReference={MENU}
        client={createMenuClient(csrf, fetcher)}
        availability={createAvailabilityClient(csrf, fetcher)}
        onMultiStore={() => undefined}
      />
    </MemoryRouter>
  );
  const { container, root } = await mount(node());
  await settle(10);
  const renderAgain = async () => {
    await act(async () => {
      root.render(node());
    });
    await settle(10);
  };
  return { container, sent, renderAgain };
}
const englishName = (editor: HTMLElement) =>
  [...editor.querySelectorAll("input")].find(
    (input) => input.closest("label")?.textContent?.startsWith("English name") === true,
  );

it("WP-2423 (b9): the dish editor keeps what staff typed when the dish is read again", async () => {
  const { container, renderAgain } = await pageRenderedAgain(async () => severalStores());
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  await typeInto(englishName(editor), "Dan dan noodles renamed (TEST)");
  await changeStorePrice(editor, "13.50");
  // The dish is read again (the old name comes back): what staff typed stays.
  await renderAgain();
  const open = container.querySelector(".dish-editor") as HTMLElement;
  expect(englishName(open)?.value).toBe("Dan dan noodles renamed (TEST)");
});

it("WP-2423 (b9): a dropped rename and store price goes again as the same save after the dish is read again", async () => {
  let saves = 0;
  const { container, sent, renderAgain } = await pageRenderedAgain(
    async () => severalStores(),
    (body) => {
      if (body.action !== "SaveDish") return undefined;
      saves += 1;
      if (saves === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(storePriceAnswer(body, true));
    },
  );
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  await typeInto(englishName(editor), "Dan dan noodles renamed (TEST)");
  await changeStorePrice(editor, "13.50");
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  expect(sent).toHaveLength(1);
  await renderAgain();
  const open = container.querySelector(".dish-editor") as HTMLElement;
  expect(englishName(open)?.value).toBe("Dan dan noodles renamed (TEST)");
  await click(buttonNamed(open, "Save dish"));
  await settle(10);
  expect(container.textContent).not.toContain("This form changed after saving stopped");
  expect(container.textContent).not.toContain("there is nothing new to list");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(container.textContent).toContain(
    "Dan dan noodles renamed (TEST): guests at this Store pay $13.50 from now. Its other changes go live when the menu is listed.",
  );
});

it("WP-2423 (b9): what a dish save did is said at that dish, not at the top of the menu", async () => {
  const { container } = await page(
    async () => severalStores(),
    (body) =>
      body.action === "SaveDish" ? Promise.resolve(storePriceAnswer(body, false)) : undefined,
  );
  const editor = await editDish(container, "Dan dan noodles (TEST)");
  await changeStorePrice(editor, "13.50");
  await click(buttonNamed(editor, "Save dish"));
  await settle(10);
  const row = [...container.querySelectorAll(".one-menu__dish")].find((li) =>
    li.textContent?.includes("Dan dan noodles (TEST)"),
  );
  expect(row?.querySelector('[role="status"]')?.textContent).toBe(
    "Dan dan noodles (TEST): guests at this Store pay $13.50 from now. Nothing else changed, so there is nothing to list.",
  );
  expect(
    container.querySelectorAll(".one-menu > .one-menu__message, .one-menu__message"),
  ).toHaveLength(1);
});

it("v15 2026-11-11 b10: a listing says what is usual, and past two minutes that it is taking longer", () => {
  // A busy system took 42–82 s: never promised "up to a minute".
  expect(listingProgressText(null)).not.toContain("up to a minute");
  expect(listingProgressText(45)).toBe(
    "Listing… New prices go live first, then the menu. This usually takes one to two minutes, longer when the system is busy. Guests keep ordering throughout. 45 s",
  );
  expect(listingProgressText(119)).not.toContain("Taking longer");
  expect(listingProgressText(130)).toContain(
    "130 s · Taking longer than usual. Nothing needs doing; this page says when it is listed.",
  );
});

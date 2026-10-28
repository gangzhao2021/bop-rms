import { describe, expect, it } from "vitest";
import {
  listingPending,
  dishMatches,
  dishesNotOnMenu,
  filterRows,
  menuRows,
  orderKey,
  sectionInputs,
} from "./one-store-menu.js";
import { moveTo } from "./reorder.js";
import { allergenSummary } from "./DishAllergenEditor.js";
import type { MenuBuilderView } from "./store-menu-pages.js";
import type { AvailabilityItem } from "./store-availability-page.js";

const id = (n: number) => "01a4d600-0000-7000-8000-" + n.toString(16).padStart(12, "0");
/** Synthetic, TEST-only menu: two sections, four dishes, one dish not on the menu. */
const view = (): MenuBuilderView =>
  ({
    screenId: "CAT-MENU-BUILDER",
    sourceAsOf: "2026-10-28T19:00:00.000Z",
    viewer: id(1),
    permissions: {
      mayRead: true,
      mayEdit: true,
      maySubmit: true,
      mayApprove: true,
      mayPublish: true,
    },
    menus: [],
    menu: {
      menuReference: id(2),
      internalCode: "MAIN",
      aggregateVersion: 4,
      versionReference: id(3),
      name: "TEST menu",
      storeReferences: [id(4)],
      channelCodes: [],
      orderTypeCodes: [],
      sections: [
        {
          sectionReference: id(10),
          code: "DIM",
          name: "Dim sum",
          nameZh: "点心",
          items: [
            { placementReference: id(20), skuReference: id(30), featured: false },
            { placementReference: id(21), skuReference: id(31), featured: true },
          ],
        },
        {
          sectionReference: id(11),
          code: "NOODLE",
          name: "Noodles",
          nameZh: "面",
          items: [
            { placementReference: id(22), skuReference: id(32), featured: false },
            { placementReference: id(23), skuReference: id(33), featured: false },
          ],
        },
      ],
    },
    publication: null,
    latestRelease: null,
    submittedBy: null,
    soleOperator: null,
    allergenRegistry: false,
    sellables: [
      {
        ...sku(30, "Har gow (TEST)", "虾饺", "788"),
        allergens: {
          source: "StaffDeclared",
          declared: [
            { allergenReference: id(90), classification: "Contains" },
            { allergenReference: id(91), classification: "CrossContactPossible" },
          ],
        },
      },
      sku(31, "Siu mai (TEST)", "烧卖", "728"),
      sku(32, "Dan dan noodles (TEST)", "", "1288"),
      {
        ...sku(33, "Beef chow fun (TEST)", "干炒牛河", null),
        offeredHere: false,
        allergens: { source: "Recipe", declared: [] },
      },
      sku(34, "Mango pudding (TEST)", "芒果布丁", "550"),
    ],
  }) as unknown as MenuBuilderView;
function sku(n: number, name: string, nameZh: string, price: string | null) {
  return {
    skuReference: id(n),
    skuCode: "S" + n,
    productName: name,
    productNameZh: nameZh,
    sizeName: name,
    active: true,
    priceMinor: price,
    offeredHere: true,
  };
}
const stock: AvailabilityItem[] = [
  {
    skuReference: id(31),
    skuCode: "S31",
    productName: "Siu mai (TEST)",
    sizeName: "Siu mai (TEST)",
    status: "SoldOut",
    soldOutUntil: "2026-10-29T08:00:00.000Z",
  },
];

describe("WP-2423 item 8 ⑥ one-page menu", () => {
  it("lists sections and dishes in the guests' order, with both names, price, sold out and hidden", () => {
    const rows = menuRows(view(), stock);
    expect(rows.map((row) => [row.name, row.nameZh, row.dishes.map((d) => d.name)])).toEqual([
      ["Dim sum", "点心", ["Har gow (TEST)", "Siu mai (TEST)"]],
      ["Noodles", "面", ["Dan dan noodles (TEST)", "Beef chow fun (TEST)"]],
    ]);
    const [, siuMai] = rows[0]?.dishes ?? [];
    expect([siuMai?.nameZh, siuMai?.soldOut, siuMai?.featured]).toEqual(["烧卖", true, true]);
    const chowFun = rows[1]?.dishes[1];
    expect([chowFun?.hidden, chowFun?.priceMinor, chowFun?.sizeName]).toEqual([true, null, null]);
    expect(dishesNotOnMenu(view(), stock).map((d) => d.nameZh)).toEqual(["芒果布丁"]);
  });

  it("finds a dish by either name and narrows by sold out, no price, hidden or a missing name", () => {
    const rows = menuRows(view(), stock);
    const names = (search: string, filters: string[] = []) =>
      filterRows(rows, search, new Set(filters as never)).flatMap((row) =>
        row.dishes.map((d) => d.name),
      );
    expect(names("虾")).toEqual(["Har gow (TEST)"]);
    expect(names("CHOW")).toEqual(["Beef chow fun (TEST)"]);
    expect(names("", ["SoldOut"])).toEqual(["Siu mai (TEST)"]);
    expect(names("", ["NoPrice"])).toEqual(["Beef chow fun (TEST)"]);
    expect(names("", ["Hidden"])).toEqual(["Beef chow fun (TEST)"]);
    expect(names("", ["MissingName"])).toEqual(["Dan dan noodles (TEST)"]);
    expect(names("", ["NoPrice", "SoldOut"])).toEqual([]);
    // Without a search or filter every section stays, even an empty one.
    expect(
      filterRows([{ ...(rows[0] as (typeof rows)[number]), dishes: [] }], "", new Set()).length,
    ).toBe(1);
    const dish = rows[0]?.dishes[0];
    expect(dish && dishMatches(dish, "  ", new Set())).toBe(true);
  });

  it("saves the order as the draft takes it, and tells a moved order from the read one", () => {
    const rows = menuRows(view(), stock);
    const read = orderKey(rows);
    const moved = moveTo(rows, 1, 0).map((row, index) =>
      index === 1 ? { ...row, dishes: moveTo(row.dishes, 1, 0) } : row,
    );
    expect(orderKey(moved)).not.toBe(read);
    expect(sectionInputs(moved)).toEqual([
      {
        sectionReference: id(11),
        code: "NOODLE",
        name: "Noodles",
        nameZh: "面",
        items: [
          { skuReference: id(32), featured: false },
          { skuReference: id(33), featured: false },
        ],
      },
      {
        sectionReference: id(10),
        code: "DIM",
        name: "Dim sum",
        nameZh: "点心",
        items: [
          { skuReference: id(31), featured: true },
          { skuReference: id(30), featured: false },
        ],
      },
    ]);
  });

  it("says where each dish's allergens come from, and finds dishes still without them", () => {
    const rows = menuRows(view(), stock);
    const choices = [
      { allergenReference: id(90), name: "Crustaceans", nameZh: "甲壳类" },
      { allergenReference: id(91), name: "Soy", nameZh: "大豆" },
    ];
    const [harGow, siuMai] = rows[0]?.dishes ?? [];
    const chowFun = rows[1]?.dishes[1];
    expect(harGow && allergenSummary(harGow, choices)).toBe(
      "Contains Crustaceans · May contain Soy",
    );
    expect(siuMai && allergenSummary(siuMai, choices)).toBe("Allergens not declared");
    expect(chowFun && allergenSummary(chowFun, choices)).toBe("Allergens from its recipe");
    expect(
      filterRows(rows, "", new Set(["NoAllergens"])).flatMap((row) =>
        row.dishes.map((d) => d.name),
      ),
    ).toEqual(["Siu mai (TEST)", "Dan dan noodles (TEST)"]);
  });

  it("takes the server's listing step: listed stays listed whatever version ids the view shows", () => {
    const base = view();
    const released = {
      ...base,
      latestRelease: {
        releaseReference: id(7),
        sequence: 1,
        menuVersionReference: id(8),
        createdAt: "2026-10-28T19:24:48.000Z",
      },
    };
    expect(listingPending({ ...released, listingStep: "Listed" })).toBe(false);
    expect(listingPending({ ...released, listingStep: "Submit" })).toBe(true);
    // Older views without the step compare versions.
    expect(listingPending(released)).toBe(true);
  });
});

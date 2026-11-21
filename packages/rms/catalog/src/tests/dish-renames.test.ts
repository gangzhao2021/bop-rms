import { describe, expect, it } from "vitest";
import {
  dishRenames,
  listPublishedDishChangeDetails,
} from "../infrastructure/persistence/published-menu-query-store.js";

const id = (n: number) => `018f2195-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** v15 2026-11-11 b10: the guest is told which language's name changed, from what to what. */
describe("dish renames", () => {
  it("lists only the languages whose name changed, before and now", () => {
    expect(
      dishRenames(
        JSON.stringify({ "en-CA": "Beef noodles", "zh-Hans-CA": "牛肉面" }),
        JSON.stringify({ "en-CA": "Beef noodles", "zh-Hans-CA": "红烧牛肉面" }),
      ),
    ).toEqual([{ locale: "zh-Hans-CA", from: "牛肉面", to: "红烧牛肉面" }]);
    // A language added or taken away reads as "" on the other side.
    expect(
      dishRenames(
        JSON.stringify({ "en-CA": "Tea" }),
        JSON.stringify({ "en-CA": "Tea", fr: "Thé" }),
      ),
    ).toEqual([{ locale: "fr", from: "", to: "Thé" }]);
    expect(
      dishRenames(JSON.stringify({ "en-CA": "Tea" }), JSON.stringify({ "en-CA": "Tea" })),
    ).toEqual([]);
  });

  it("answers each line's changes with the renamed languages from the two published menus", async () => {
    const rows = [
      {
        menu_version: id(1),
        sellable: id(9),
        product_version: id(5),
        names: JSON.stringify({ "en-CA": "Beef noodles", "zh-Hans-CA": "牛肉面" }),
        disclosure: "{}",
      },
      {
        menu_version: id(2),
        sellable: id(9),
        product_version: id(5),
        names: JSON.stringify({ "en-CA": "Beef noodles", "zh-Hans-CA": "红烧牛肉面" }),
        disclosure: '{"x":1}',
      },
    ];
    const tx = {
      query: async (sql: string) => (sql.includes("FROM rms_catalog") ? { rows } : { rows: [] }),
    };
    const [detail] = await listPublishedDishChangeDetails(
      tx as never,
      { brandReference: id(3), storeReference: id(4) },
      [
        {
          sellableReference: id(9),
          productVersionReference: id(5),
          fromMenuVersionReference: id(1),
          toMenuVersionReference: id(2),
        },
      ],
    );
    expect(detail).toEqual({
      changes: ["Name", "Allergens"],
      renamed: [{ locale: "zh-Hans-CA", from: "牛肉面", to: "红烧牛肉面" }],
    });
  });
});

// @vitest-environment jsdom
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { mount, settle } from "./dom-test-kit.fixture.js";
import { filterRows, menuRows } from "./one-store-menu.js";
import { StoreAvailabilityPage } from "./StoreAvailabilityPage.js";

/** Synthetic, TEST-only: a milk tea whose one required group (Serve) is all sold out here. */
const id = (n: number) => "0190a7c4-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const item = (choicesSoldOut: boolean) => ({
  skuReference: id(2),
  skuCode: "MILK-TEA",
  productName: "Milk tea (TEST)",
  sizeName: "Milk tea (TEST)",
  status: "Available" as const,
  soldOutUntil: null,
  stock: "Unknown" as const,
  ...(choicesSoldOut ? { choicesSoldOut: true as const } : {}),
});
const view = (choicesSoldOut: boolean) => ({
  screenId: "CAT-AVAILABILITY",
  sourceAsOf: "2026-11-06T16:00:00.000Z",
  viewer: id(1),
  timeZone: "America/Toronto",
  permissions: { mayOffer: true, mayMarkSoldOut: true, mayMarkUntilBack: true },
  stockCheck: "Checked",
  items: [item(choicesSoldOut)],
  options: [],
});
afterEach(() => document.body.replaceChildren());

it("WP-2423 (M24): Item availability says a dish whose required choices are all sold out here is sold out to guests", async () => {
  const { container } = await mount(
    <MemoryRouter>
      <StoreAvailabilityPage client={{ load: async () => view(true) }} />
    </MemoryRouter>,
  );
  await settle(10);
  const row = [...container.querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes("Milk tea (TEST)"),
  );
  expect(row?.textContent).toContain("Sold out to guests (choices)");
  expect(row?.textContent).toContain("Bring one back under Extras and choices.");
  expect(row?.textContent).not.toContain("Available to order");
});

it("WP-2423 (M24): the Menu page counts such a dish as sold out to guests", () => {
  const rows = menuRows(
    {
      menu: {
        sections: [
          {
            code: "TEA",
            name: "Tea (TEST)",
            nameZh: "",
            items: [{ skuReference: id(2), featured: false }],
          },
        ],
      },
      sellables: [
        {
          skuReference: id(2),
          productName: "Milk tea (TEST)",
          productNameZh: "",
          sizeName: "Milk tea (TEST)",
          priceMinor: "550",
          offeredHere: true,
          productReference: id(3),
          allergens: { source: "None", declared: [] },
        },
      ],
    } as never,
    [item(true)],
  );
  expect(rows[0]?.dishes[0]?.choicesShort).toBe(true);
  expect(filterRows(rows, "", new Set(["SoldOut"]))[0]?.dishes.map((d) => d.name)).toEqual([
    "Milk tea (TEST)",
  ]);
});

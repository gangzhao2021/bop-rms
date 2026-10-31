import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { StockShortageNotice } from "./StockCountPages.js";
import { createStockCountClient, StockCountPageError } from "./stock-count-pages.js";

const id = (n: number) => "01909a2c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const view = {
  items: [
    { itemReference: id(1), name: "Whole milk" },
    { itemReference: id(2), name: "Espresso beans" },
  ],
  locations: [{ locationReference: id(3), name: "Bar fridge" }],
};
const render = (shortages: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StockShortageNotice view={{ ...view, shortages: shortages as never }} />
    </MemoryRouter>,
  );

// DEC-INV-COUNT-SHORT (2026-10-18): a count below what open orders hold is posted; staff see which
// orders hold the missing stock and what to do, in their words (no codes or identifiers).
it("lists items counted short of open orders with those orders, and items used beyond the count", () => {
  const html = render([
    {
      itemReference: id(1),
      locationReference: id(3),
      lotCode: "TEST-LOT-1017K",
      unitCode: "L",
      onHand: "0.1",
      reserved: "0.26",
      shortQuantity: "0.16",
      usedBeyondCount: "0",
      orders: [
        {
          orderReference: id(10),
          orderNumber: "9",
          orderType: "Pickup",
          businessDate: "2026-10-18",
          quantity: "0.13",
          ended: false,
        },
        {
          orderReference: id(11),
          orderNumber: "11",
          orderType: "DineIn",
          businessDate: "2026-10-18",
          quantity: "0.13",
          ended: true,
        },
      ],
    },
    {
      itemReference: id(2),
      locationReference: id(3),
      lotCode: null,
      unitCode: "KG",
      onHand: "0",
      reserved: "0",
      shortQuantity: "0",
      usedBeyondCount: "0.018",
      orders: [],
    },
  ]);
  expect(html).toContain("Less in stock than open orders need");
  expect(html).toContain("Whole milk (lot TEST-LOT-1017K)</strong> at Bar fridge");
  expect(html).toContain("short by 0.16");
  expect(html).toContain(`href="/operations/orders/${id(10)}"`);
  expect(html).toContain("Order 9</a> (pickup, 0.13");
  expect(html).toContain("already finished — release its ingredients on Orders");
  expect(html).toContain("Used more than was counted");
  expect(html).toContain("Espresso beans</strong> at Bar fridge: used 0.018");
  // What staff read (links aside) names no code or identifier.
  expect(html.replace(/<[^>]*>/gu, "")).not.toMatch(/USED_BEYOND_COUNT|DineIn|01909a2c/u);
});
it("shows nothing when no item is short (or the server is older)", () => {
  expect(render([])).toBe("");
  expect(
    renderToStaticMarkup(
      <MemoryRouter>
        <StockShortageNotice view={view} />
      </MemoryRouter>,
    ),
  ).toBe("");
});
it("tells an unavailable step apart from a count someone else changed", async () => {
  const client = (status: number, error: string) =>
    createStockCountClient("a".repeat(43), async () =>
      Response.json({ error, lineReferences: [] }, { status }),
    );
  const code = async (status: number, error: string) =>
    (
      (await client(status, error)
        .load(null)
        .catch((failure: unknown) => failure)) as StockCountPageError
    ).code;
  expect(await code(503, "Unavailable")).toBe("Unavailable");
  expect(await code(409, "Conflict")).toBe("Conflict");
});

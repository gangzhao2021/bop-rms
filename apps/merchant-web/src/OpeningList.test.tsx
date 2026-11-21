import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OpeningListView, openingSteps, type OpeningFacts } from "./OpeningList.js";

const facts = (overrides: Partial<OpeningFacts> = {}): OpeningFacts => ({
  details: true,
  kitchen: true,
  receipts: true,
  setupPublished: true,
  allergenList: true,
  menuListed: true,
  tableCode: true,
  ...overrides,
});
const render = (value: OpeningFacts) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <OpeningListView steps={openingSteps(value, "store-1")} />
    </MemoryRouter>,
  );

describe("WP-2423 item 13 ③: the Owner's opening list", () => {
  it("shows nothing at a Store that has done everything", () => {
    expect(render(facts())).toBe("");
  });
  it("names the next step and links each one to where it is done", () => {
    const html = render(facts({ setupPublished: false, menuListed: false }));
    expect(html).toContain("Getting ready to open");
    expect(html).toContain("/app/organization/stores/store-1/setup#store-opening");
    expect(html).toContain("/app/commerce/menus");
    expect(html.match(/data-next="true"/gu)).toHaveLength(1);
    expect(html.indexOf("Do this next")).toBeLessThan(html.indexOf("Set this up"));
  });
  it("a Store's details, kitchen, receipts and setup are one row, then allergens, menu and table", () => {
    const all = facts({
      details: false,
      kitchen: false,
      receipts: false,
      setupPublished: false,
      allergenList: false,
      menuListed: false,
      tableCode: false,
    });
    expect(openingSteps(all, "store-1").map((step) => step.key)).toEqual([
      "store",
      "allergenList",
      "menuListed",
      "tableCode",
    ]);
    expect(render(all)).toContain("Store details and settings");
    // Any one of the four still to do keeps the row open.
    for (const key of ["details", "kitchen", "receipts", "setupPublished"] as const)
      expect(render(facts({ [key]: false }))).toContain("Store details and settings");
    expect(render(facts())).toBe("");
  });
  it("says when the next step is BOP support's, not the Owner's", () => {
    const html = render(facts({ setupPublished: false, taxRatesSet: false, menuListed: false }));
    expect(html).toContain("Waiting for BOP support to set your tax rates");
    // The row asks nothing of the Owner, and nothing else is theirs yet: nothing is "next".
    expect(html).not.toContain("setup#store-opening");
    expect(html).not.toContain("Do this next");
    expect(html).not.toContain('data-next="true"');
    // Until they have saved their details the row is still theirs: BOP support needs the province.
    for (const key of ["details", "kitchen", "receipts"] as const)
      expect(render(facts({ [key]: false, setupPublished: false, taxRatesSet: false }))).toContain(
        "setup#store-opening",
      );
    expect(render(facts({ setupPublished: false, taxRatesSet: true }))).toContain(
      "setup#store-opening",
    );
  });
  it("never sends anyone to the allergen list before the store row is done", () => {
    // While BOP support has the tax rates to set, and while the Owner still has the page to fill.
    for (const value of [
      facts({ setupPublished: false, taxRatesSet: false, allergenList: false }),
      facts({ setupPublished: false, allergenList: false }),
      facts({ details: false, allergenList: false }),
    ]) {
      const html = render(value);
      expect(html).toContain("After your store setup");
      expect(html).not.toContain("/app/compliance/allergens");
    }
    // The store row done, it is next, wherever it is the Owner's to do.
    const open = render(facts({ allergenList: false }));
    expect(open).toContain("/app/compliance/allergens");
    expect(open).toContain("Do this next");
    expect(open).not.toContain("After your store setup");
    // Done already: the row says so, whatever the store row says.
    expect(render(facts({ setupPublished: false, allergenList: true }))).not.toContain(
      "After your store setup",
    );
  });
  it("a step that can't be read is neither done nor to do", () => {
    const steps = openingSteps(facts({ tableCode: null }), "store-1");
    expect(steps.map((step) => step.key)).not.toContain("tableCode");
    // Everything readable done, one unknown: nothing to nag about.
    expect(render(facts({ tableCode: null }))).toBe("");
    expect(render(facts({ tableCode: null, kitchen: false }))).toContain(
      "Store details and settings",
    );
    // One unreadable fact of the four, the rest done: not done, not to do.
    expect(openingSteps(facts({ kitchen: null }), "store-1").map((step) => step.key)).not.toContain(
      "store",
    );
  });
});

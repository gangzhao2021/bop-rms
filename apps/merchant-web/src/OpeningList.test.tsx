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
    expect(html).toContain("/app/organization/stores/store-1/setup");
    expect(html).toContain("/app/commerce/menus");
    expect(html.match(/data-next="true"/gu)).toHaveLength(1);
    expect(html.indexOf("Do this next")).toBeLessThan(html.indexOf("Set this up"));
  });
  it("a step that can't be read is neither done nor to do", () => {
    const steps = openingSteps(facts({ tableCode: null }), "store-1");
    expect(steps.map((step) => step.key)).not.toContain("tableCode");
    // Everything readable done, one unknown: nothing to nag about.
    expect(render(facts({ tableCode: null }))).toBe("");
    expect(render(facts({ tableCode: null, kitchen: false }))).toContain("Kitchen line");
  });
});

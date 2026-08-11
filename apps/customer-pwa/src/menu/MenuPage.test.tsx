import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MenuScreen } from "./MenuPage.js";
import type { MenuJourneyContext, MenuSellable, MenuView } from "./types.js";

const context: MenuJourneyContext = Object.freeze({
  publicStoreReference: "018f7500-0000-7000-8000-000000000001",
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
});
const sellable: MenuSellable = Object.freeze({
  sellableReference: "018f7500-0000-7000-8000-000000000007",
  name: "Latte",
  presentationRole: "Standard",
  pinned: false,
  allergens: Object.freeze([
    Object.freeze({ name: "Milk", classification: "Contains" as const }),
    Object.freeze({ name: "Peanuts", classification: "CrossContactPossible" as const }),
  ]),
  optionRules: Object.freeze([
    Object.freeze({
      minimumSelections: 0,
      maximumSelections: 1,
      enabledOptionCount: 1,
      defaultOptionCount: 0,
    }),
  ]),
});
const menu: MenuView = Object.freeze({
  name: "All Day",
  locale: "en-CA",
  effectiveFrom: "2026-08-11T20:00:00.000Z",
  effectiveUntil: null,
  sections: Object.freeze([
    Object.freeze({
      sectionReference: "018f7500-0000-7000-8000-000000000006",
      name: "Drinks",
      sellables: Object.freeze([sellable]),
    }),
  ]),
});

function render(props: Omit<React.ComponentProps<typeof MenuScreen>, "onRetry">): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MenuScreen {...props} onRetry={vi.fn()} />
    </MemoryRouter>,
  );
}

describe("WP-1701 Customer Menu screens", () => {
  it("renders safe published cards without source identifiers or invented price", () => {
    const html = render({ context, mode: "browse", state: { kind: "Found", menu } });
    expect(html).toContain("All Day");
    expect(html).toContain("Drinks");
    expect(html).toContain("Latte");
    expect(html).toContain("Price confirmed in your final quote");
    expect(html).toContain("Contains");
    expect(html).toContain("Cross-contact possible");
    expect(html).not.toContain(context.publicStoreReference);
    expect(html).not.toContain("$0");
  });

  it("renders honest product-detail gaps and no Cart mutation", () => {
    const html = render({
      context,
      detail: sellable,
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(html).toContain("Image not available");
    expect(html).toContain("Confirmed in your final quote");
    expect(html).toContain("No published detail available");
    expect(html).toContain("Configuration and adding this item to Cart are not available");
    expect(html).not.toContain("Add to cart");
  });

  it.each([
    ["MissingContext", "Scan the location QR code", "Return to entry"],
    ["IdleSearch", "Search this menu", "approved search term"],
    ["Loading", "Loading the current menu", "latest published items"],
    ["Offline", "You’re offline", "No cached menu"],
    ["Stale", "Menu is being refreshed", "out-of-date menu"],
    ["Unavailable", "Menu is unavailable", "No item or order was submitted"],
    ["NotFound", "No menu found", "no matching published items"],
  ] as const)("renders the %s recovery state", (kind, heading, copy) => {
    const html = render({ context, mode: "browse", state: { kind } as never });
    expect(html).toContain(heading);
    expect(html).toContain(copy);
  });

  it("never claims allergen absence when the disclosure list is empty", () => {
    const html = render({
      context,
      detail: { ...sellable, allergens: [] },
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(html).toContain("No allergen-free claim is made");
    expect(html).toContain("Ask staff");
  });
});

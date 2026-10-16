import * as pickupClient from "../cart/pickup-cart-client.js";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MenuScreen, SellableConfigurator } from "./MenuPage.js";
import type { ConfigureController } from "./configure-state.js";
import type { MenuJourneyContext, MenuSellable, MenuView } from "./types.js";
import { findInternalText, staticText } from "../../e2e/internal-text-patterns.js";

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
  availability: "Available",
  price: null,
  allergens: Object.freeze([
    Object.freeze({ name: "Milk", classification: "Contains" as const }),
    Object.freeze({ name: "Peanuts", classification: "CrossContactPossible" as const }),
  ]),
  optionRules: Object.freeze([
    Object.freeze({
      name: null,
      minimumSelections: 0,
      maximumSelections: 1,
      options: Object.freeze([
        Object.freeze({
          optionReference: "018f7500-0000-7000-8000-00000000000d",
          name: "Oat beverage",
          maximumQuantity: 1,
          conflictOptionReferences: Object.freeze([]),
          selectedByDefault: false,
          price: null,
        }),
      ]),
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
    expect(html).toContain("Priced at checkout");
    expect(html).toContain("Contains");
    expect(html).toContain("Cross-contact possible");
    expect(html).not.toContain(context.publicStoreReference);
    expect(html).not.toContain("$0");
  });

  it("renders matched search terms and the source menu section on result cards", () => {
    const html = render({
      context,
      mode: "search",
      searchTerm: "iced",
      state: { kind: "Found", menu },
    });
    expect(html).toContain('aria-label="Search results"');
    expect(html).toContain("Matched term · iced");
    expect(html).toContain("Section</span>Drinks");
    expect(html).not.toContain("Image not available");
    expect(html).not.toContain("Dietary filter");
  });

  it("renders an empty published menu as a quiet state without item or order actions", () => {
    const emptyMenu = { ...menu, sections: [] };
    const html = render({
      context,
      mode: "browse",
      state: { kind: "Found", menu: emptyMenu },
    });
    expect(html).toContain('class="menu-state menu-state--empty"');
    expect(html).toContain("No items available");
    expect(html).toContain("The current published menu has no matching items.");
    expect(html).not.toContain("<article");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Add to cart");
  });

  it("renders honest product-detail gaps and a bounded configure intent", () => {
    const html = render({
      context,
      detail: sellable,
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(html).not.toContain("Image not available");
    expect(html).toContain("Priced at checkout");
    expect(html).not.toContain("No published detail available");
    expect(html).toContain("Add to cart");
    expect(html).not.toContain(sellable.optionRules[0]?.options[0]?.optionReference);
  });

  it("WP-2423 8.6: shows the Store price and refuses a sold-out item", () => {
    const priced = { ...sellable, price: { amount: "5.25", currency: "CAD" } };
    const html = render({
      context,
      detail: priced,
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(html).toContain("From $5.25");
    expect(html).toContain("plus tax");
    const soldOut = render({
      context,
      detail: { ...priced, availability: "SoldOut" as const },
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(soldOut).toContain("Sold out at this store right now");
    expect(soldOut).not.toContain("Add to cart");
  });

  it.each([
    ["MissingContext", "Scan the location QR code", "Return to entry"],
    ["IdleSearch", "Search this menu", "item name"],
    ["Loading", "Loading the current menu", "latest published items"],
    ["PermissionDenied", "This menu can’t be opened", "session can’t access this menu"],
    ["Offline", "You’re offline", "No cached menu"],
    ["Stale", "Menu is being refreshed", "out-of-date menu"],
    ["Unavailable", "Menu is unavailable", "No item or order was submitted"],
    ["NotFound", "No menu found", "no matching published items"],
  ] as const)("renders the %s recovery state", (kind, heading, copy) => {
    const html = render({ context, mode: "browse", state: { kind } as never });
    expect(html).toContain(heading);
    expect(html).toContain(copy);
  });

  it("offers re-entry without retrying a denied menu request", () => {
    const html = render({ context, mode: "browse", state: { kind: "PermissionDenied" } });
    expect(html).toContain('href="/"');
    expect(html).toContain("Return to entry");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Allergies or accessibility");
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

  it("renders required-selection, price and sensitive-note boundaries without references", () => {
    const configurable = {
      ...sellable,
      optionRules: [
        {
          name: "Milk",
          minimumSelections: 1,
          maximumSelections: 1,
          options: sellable.optionRules
            .flatMap((rule) => rule.options)
            .map((option) => ({ ...option, price: { amount: "0.75", currency: "CAD" } })),
        },
      ],
    };
    const controller: ConfigureController = {
      getState: () => ({ status: "idle" }),
      retry: vi.fn(),
      setOnline: vi.fn(),
      submit: vi.fn(),
      subscribe: () => () => undefined,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SellableConfigurator sellable={configurable} controller={controller} />
      </MemoryRouter>,
    );
    expect(html).toContain("Milk requires at least 1");
    expect(html).toContain("Milk — choose 1");
    expect(html).toContain('type="radio"');
    expect(html).toContain("+ $0.75");
    expect(html).not.toContain("CAD");
    expect(findInternalText([staticText(html)])).toEqual([]);
    expect(html).toContain("Prices shown are what each choice adds now");
    expect(html).toContain("Oat beverage");
    expect(html).toContain("Do not enter allergy, medical or other sensitive details");
    // Guests ask staff (plain role), never "ask Staff".
    expect(html).toContain("ask staff for assistance.");
    expect(html).not.toContain("Staff");
    expect(html).not.toContain(configurable.optionRules[0]?.options[0]?.optionReference);
  });
});

it("disables Configurator edits and add while keeping unknown-outcome retry", () => {
  const controller: ConfigureController = {
    getState: () => ({
      status: "outcome-unknown",
      issueCodes: [],
      retryAfterSeconds: null,
      canRetry: true,
    }),
    retry: vi.fn(),
    setOnline: vi.fn(),
    submit: vi.fn(),
    subscribe: () => () => undefined,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SellableConfigurator sellable={sellable} controller={controller} />
    </MemoryRouter>,
  );
  expect(html).toContain("Retry");
  expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/u);
  expect(html).toMatch(/<textarea[^>]*disabled=""/u);
});

describe("Pickup configuration client selection", () => {
  it.each(["idle", "offline"] as const)(
    "preserves an injected Pickup controller in %s state",
    (status) => {
      const controller: ConfigureController = {
        getState: () => (status === "idle" ? { status } : { status, canRetry: true }),
        retry: vi.fn(),
        setOnline: vi.fn(),
        submit: vi.fn(),
        subscribe: () => () => undefined,
      };
      const spy = vi.spyOn(pickupClient, "createBrowserPickupCartClient");
      try {
        const html = renderToStaticMarkup(
          <MemoryRouter>
            <SellableConfigurator sellable={sellable} channel="Pickup" controller={controller} />
          </MemoryRouter>,
        );
        expect(spy).not.toHaveBeenCalled();
        if (status === "offline")
          expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retry the same operation<\/button>/u);
      } finally {
        spy.mockRestore();
      }
    },
  );
  it.each(["Pickup", "DineIn", undefined] as const)(
    "uses Pickup composition only for %s",
    (channel) => {
      const spy = vi.spyOn(pickupClient, "createBrowserPickupCartClient");
      try {
        renderToStaticMarkup(
          <MemoryRouter>
            <SellableConfigurator sellable={sellable} channel={channel} />
          </MemoryRouter>,
        );
        expect(spy).toHaveBeenCalledTimes(channel === "Pickup" ? 1 : 0);
      } finally {
        spy.mockRestore();
      }
    },
  );
});

it("renders the published default quantity and hides inactive conditional groups", () => {
  const option = sellable.optionRules[0]?.options[0];
  if (!option) throw new Error("fixture");
  const configured: MenuSellable = {
    ...sellable,
    optionRules: [
      {
        name: "Extra shot",
        minimumSelections: 2,
        maximumSelections: 3,
        activationOptionReferences: [],
        options: [{ ...option, selectedByDefault: true, defaultQuantity: 2, maximumQuantity: 3 }],
      },
      {
        name: null,
        minimumSelections: 1,
        maximumSelections: 1,
        activationOptionReferences: ["not-selected"],
        options: [
          {
            ...option,
            optionReference: "conditional",
            name: "Conditional extra",
            selectedByDefault: true,
            defaultQuantity: 1,
          },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SellableConfigurator sellable={configured} />
    </MemoryRouter>,
  );
  expect(html).toContain('value="2"');
  expect(html).not.toContain("Conditional extra");
});

describe("WP-2423: a table cart that timed out", () => {
  const render = (state: ReturnType<ConfigureController["getState"]>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <SellableConfigurator
          sellable={sellable}
          controller={{
            getState: () => state,
            retry: vi.fn(),
            setOnline: vi.fn(),
            submit: vi.fn(),
            subscribe: () => () => undefined,
          }}
        />
      </MemoryRouter>,
    );
  const added = {
    schemaVersion: 1 as const,
    cart: {
      cartReference: "018f7600-0000-7000-8000-000000000001",
      version: 2,
      orderType: "DineIn" as const,
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active" as const,
        idleExpiresAt: "2026-08-12T00:00:00.000Z",
        absoluteExpiresAt: "2026-08-13T00:00:00.000Z",
      },
      items: [],
      quote: null,
      warnings: [],
    },
  };
  it("says once that unordered items from the earlier cart were cleared", () => {
    const html = render({ status: "added", cart: added, earlierCartCleared: true });
    expect(html).toContain("Added to your cart.");
    expect(html).toContain(
      "Your table&#x27;s earlier cart timed out, so items that hadn&#x27;t been ordered were",
    );
    expect(render({ status: "added", cart: added })).not.toContain("earlier cart timed out");
  });
  it("says the table's last order is still being processed instead of a dropped connection", () => {
    const html = render({
      status: "order-processing",
      issueCodes: [],
      retryAfterSeconds: 10,
      canRetry: false,
    });
    expect(html).toContain(
      "Your table’s last order is still being processed. Try again in a moment.",
    );
    expect(html).not.toContain("connection dropped");
  });
  it("says another guest at the table is checking out instead of a generic failure", () => {
    const html = render({
      status: "checkout-in-progress",
      issueCodes: [],
      retryAfterSeconds: 30,
      canRetry: false,
    });
    expect(html).toContain(
      "Another guest at your table is paying for this order. Try again in a moment.",
    );
    expect(html).not.toContain("We couldn’t add this right now.");
  });
  it("no longer sends the guest to staff when the cart could not be restarted", () => {
    const html = render({
      status: "expired",
      issueCodes: [],
      retryAfterSeconds: null,
      canRetry: false,
    });
    expect(html).toContain("Wait a moment, then add the item again.");
    expect(html).not.toContain("Ask staff for help continuing your order.");
  });
});

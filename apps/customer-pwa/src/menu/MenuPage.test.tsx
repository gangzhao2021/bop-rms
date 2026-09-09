import * as pickupClient from "../cart/pickup-cart-client.js";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MenuScreen, SellableConfigurator } from "./MenuPage.js";
import type { ConfigureController } from "./configure-state.js";
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
      options: Object.freeze([
        Object.freeze({
          optionReference: "018f7500-0000-7000-8000-00000000000d",
          name: "Oat beverage",
          maximumQuantity: 1,
          conflictOptionReferences: Object.freeze([]),
          selectedByDefault: false,
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
    expect(html).toContain("Price confirmed in your final quote");
    expect(html).toContain("Contains");
    expect(html).toContain("Cross-contact possible");
    expect(html).not.toContain(context.publicStoreReference);
    expect(html).not.toContain("$0");
  });

  it("renders honest product-detail gaps and a bounded configure intent", () => {
    const html = render({
      context,
      detail: sellable,
      mode: "detail",
      state: { kind: "Found", menu },
    });
    expect(html).toContain("Image not available");
    expect(html).toContain("Confirmed in your final quote");
    expect(html).toContain("No published detail available");
    expect(html).toContain("Configure and add");
    expect(html).not.toContain(sellable.optionRules[0]?.options[0]?.optionReference);
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

  it("renders required-selection, price and sensitive-note boundaries without references", () => {
    const configurable = {
      ...sellable,
      optionRules: [
        {
          minimumSelections: 1,
          maximumSelections: 1,
          options: sellable.optionRules.flatMap((rule) => rule.options),
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
    expect(html).toContain("Choice group 1 requires at least 1");
    expect(html).toContain("Published choices are confirmed by the server");
    expect(html).toContain("Oat beverage");
    expect(html).toContain("Do not enter allergy, medical or other sensitive details");
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

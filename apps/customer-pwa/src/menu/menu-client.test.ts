import { describe, expect, it, vi } from "vitest";
import { createCustomerMenuClient, normalizeMenuSearch } from "./menu-client.js";
import type { MenuJourneyContext } from "./types.js";

const references = Object.freeze({
  store: "018f7500-0000-7000-8000-000000000001",
  menu: "018f7500-0000-7000-8000-000000000002",
  version: "018f7500-0000-7000-8000-000000000003",
  release: "018f7500-0000-7000-8000-000000000004",
  checkpoint: "018f7500-0000-7000-8000-000000000005",
  section: "018f7500-0000-7000-8000-000000000006",
  sellable: "018f7500-0000-7000-8000-000000000007",
  product: "018f7500-0000-7000-8000-000000000008",
  registry: "018f7500-0000-7000-8000-000000000009",
  allergen: "018f7500-0000-7000-8000-00000000000a",
  binding: "018f7500-0000-7000-8000-00000000000b",
  optionSet: "018f7500-0000-7000-8000-00000000000c",
  option: "018f7500-0000-7000-8000-00000000000d",
});
const at = "2026-08-11T20:00:00.000Z";
const context: MenuJourneyContext = Object.freeze({
  publicStoreReference: references.store,
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
});

function found() {
  return {
    status: "Found",
    schemaVersion: 1,
    projection: {
      name: "catalog_published_menu_v1",
      version: 1,
      asOfUtc: at,
      sourceCheckpoint: references.checkpoint,
      sourceAggregateVersion: 4,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: 5_000,
      stale: false,
      partial: true,
    },
    scope: {
      publicStoreReference: references.store,
      channelCode: "DINE_IN",
      orderTypeCode: "TABLE_SERVICE",
      effectiveAt: at,
    },
    menu: {
      menuReference: references.menu,
      menuVersionReference: references.version,
      releaseReference: references.release,
      locale: "en-CA",
      name: "All Day",
      effectiveFrom: at,
      effectiveUntil: null,
      sections: [
        {
          sectionReference: references.section,
          name: "Drinks",
          sellables: [
            {
              sellableReference: references.sellable,
              productVersionReference: references.product,
              name: "Latte",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [
                {
                  bindingReference: references.binding,
                  optionSetVersionReference: references.optionSet,
                  minimumSelections: 0,
                  maximumSelections: 1,
                  enabledOptionReferences: [references.option],
                  defaultOptionReferences: [],
                },
              ],
              allergenDisclosure: {
                registryVersionReference: references.registry,
                items: [
                  {
                    allergenReference: references.allergen,
                    code: "MILK",
                    name: "Milk",
                    classification: "Contains",
                  },
                ],
                allergenFreeClaim: false,
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              },
              displayPrice: {
                status: "Unavailable",
                amount: null,
                currency: null,
                reason: "PRICING_NOT_INTEGRATED",
              },
              taxDisplayContext: {
                status: "Unavailable",
                taxInclusive: null,
                reason: "FINAL_QUOTE_REQUIRED",
              },
            },
          ],
        },
      ],
    },
  };
}

function response(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

describe("Customer Menu client", () => {
  it("loads the exact QR-established scope with no-store controls", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `/api/v1/public/stores/${references.store}/menu?channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA&q=iced+latte`,
      );
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      return response(200, found());
    });
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    await expect(client.load({ searchTerm: "  iced   latte " })).resolves.toEqual({
      kind: "Found",
      menu: {
        name: "All Day",
        locale: "en-CA",
        effectiveFrom: at,
        effectiveUntil: null,
        sections: [
          {
            sectionReference: references.section,
            name: "Drinks",
            sellables: [
              {
                sellableReference: references.sellable,
                name: "Latte",
                presentationRole: "Standard",
                pinned: false,
                allergens: [{ name: "Milk", classification: "Contains" }],
                optionRules: [
                  {
                    minimumSelections: 0,
                    maximumSelections: 1,
                    enabledOptionCount: 1,
                    defaultOptionCount: 0,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("does not request or expose a cached menu while offline", async () => {
    const fetch = vi.fn();
    const client = createCustomerMenuClient(context, { fetch, online: () => false });
    await expect(client.load()).resolves.toEqual({ kind: "Offline" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous identical reads without retaining a response cache", async () => {
    const fetch = vi.fn(async () => response(200, found()));
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    const [first, second] = await Promise.all([client.load(), client.load()]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.load();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, "menu_not_found", "customer.menu.not_found", "NotFound"],
    [503, "menu_projection_stale", "customer.menu.projection_stale", "Stale"],
    [503, "menu_service_unavailable", "customer.menu.service_unavailable", "Unavailable"],
  ] as const)("maps the bounded %s response", async (status, code, messageKey, kind) => {
    const client = createCustomerMenuClient(context, {
      fetch: async () => response(status, { schemaVersion: 1, error: { code, messageKey } }),
      online: () => true,
    });
    await expect(client.load()).resolves.toEqual({ kind });
  });

  it.each([
    { ...found(), unexpected: "private" },
    { ...found(), projection: { ...found().projection, partial: false } },
    { ...found(), scope: { ...found().scope, publicStoreReference: references.menu } },
    {
      ...found(),
      menu: {
        ...found().menu,
        sections: [
          {
            ...found().menu.sections[0],
            sellables: [
              {
                ...found().menu.sections[0]?.sellables[0],
                allergenDisclosure: {
                  ...found().menu.sections[0]?.sellables[0]?.allergenDisclosure,
                  allergenFreeClaim: true,
                },
              },
            ],
          },
        ],
      },
    },
  ])("fails a malformed or authority-expanding DTO closed", async (body) => {
    const client = createCustomerMenuClient(context, {
      fetch: async () => response(200, body),
      online: () => true,
    });
    await expect(client.load()).resolves.toEqual({ kind: "Unavailable" });
  });

  it("bounds search text before network use", async () => {
    expect(normalizeMenuSearch("  café   latte ")).toBe("café latte");
    expect(normalizeMenuSearch("<script>")).toBeNull();
    expect(normalizeMenuSearch("x".repeat(101))).toBeNull();
    const fetch = vi.fn();
    const client = createCustomerMenuClient(context, { fetch, online: () => true });
    await expect(client.load({ searchTerm: "<script>" })).resolves.toEqual({
      kind: "Unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

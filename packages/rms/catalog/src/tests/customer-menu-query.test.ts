import { describe, expect, it } from "vitest";
import {
  CatalogError,
  createCustomerMenuQueryService,
  type CustomerMenuQueryPorts,
  type PublishedMenuProjection,
} from "../index.js";

const id = (n: number) => `018f7400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";

function projection(overrides: Partial<PublishedMenuProjection> = {}): PublishedMenuProjection {
  return {
    projectionName: "catalog_published_menu_v1",
    projectionVersion: 1,
    generationReference: id(1) as never,
    sourceEventReference: id(2) as never,
    sourceAggregateVersion: 4,
    sourceCheckpoint: id(2) as never,
    lastRebuiltAt: at as never,
    freshnessStatus: "Fresh",
    snapshot: {
      brandReference: id(3) as never,
      menuReference: id(4) as never,
      menuVersionReference: id(5) as never,
      releaseReference: id(6) as never,
      snapshotDigest: `sha256:${"a".repeat(64)}` as never,
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "All Day", "fr-CA": "Toute la journée" },
      storeReferences: [id(7) as never],
      channelCodes: ["DINE_IN" as never],
      orderTypeCodes: ["TABLE_SERVICE" as never],
      timeZone: "America/Toronto",
      effectiveFrom: "2026-08-02T15:00:00.000Z" as never,
      effectiveUntil: "2026-08-02T17:00:00.000Z" as never,
      sections: [
        {
          sectionReference: id(8) as never,
          internalCode: "DRINKS" as never,
          localizedNames: { "en-CA": "Drinks", "fr-CA": "Boissons" },
          sortOrder: 1,
          sellables: [
            {
              placementReference: id(9) as never,
              sellableReference: id(10) as never,
              productVersionReference: id(11) as never,
              localizedNames: { "en-CA": "Latte", "fr-CA": "Café au lait" },
              presentationRole: "Featured",
              sortOrder: 1,
              pinned: true,
              configuredAvailability: "Available",
              optionRules: [
                {
                  bindingReference: id(12) as never,
                  optionSetVersionReference: id(13) as never,
                  minimumSelections: 0,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(14) as never],
                  defaultOptionReferences: [],
                },
              ],
            },
            {
              placementReference: id(15) as never,
              sellableReference: id(16) as never,
              productVersionReference: id(17) as never,
              localizedNames: { "en-CA": "Hidden tea" },
              presentationRole: "Hidden",
              sortOrder: 2,
              pinned: false,
              configuredAvailability: "Available",
              optionRules: [],
            },
            {
              placementReference: id(18) as never,
              sellableReference: id(19) as never,
              productVersionReference: id(20) as never,
              localizedNames: { "en-CA": "Unavailable juice" },
              presentationRole: "Standard",
              sortOrder: 3,
              pinned: false,
              configuredAvailability: "Unavailable",
              optionRules: [],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    publicStoreReference: id(21),
    channelCode: "DINE_IN",
    orderTypeCode: "TABLE_SERVICE",
    locale: "fr-CA",
    requestedAt: at,
    searchTerm: null,
    sectionReference: null,
    ...overrides,
  };
}

function fixture(candidates: readonly PublishedMenuProjection[] = [projection()]) {
  const calls: unknown[] = [];
  const ports: CustomerMenuQueryPorts = {
    stores: {
      async resolvePublic(publicStoreReference) {
        calls.push(publicStoreReference);
        return {
          brandReference: id(3) as never,
          storeReference: id(7) as never,
          status: "Active",
        };
      },
    },
    projections: {
      async loadCandidates(value) {
        calls.push(value);
        return candidates;
      },
    },
  };
  return { service: createCustomerMenuQueryService(ports), calls };
}

describe("WP-1026 Customer Menu Query", () => {
  it("returns only the exact current Store, channel and order-type projection", async () => {
    const { service } = fixture();
    await expect(service.getPublishedMenu(input())).resolves.toMatchObject({
      status: "Found",
      schemaVersion: 1,
      projection: {
        name: "catalog_published_menu_v1",
        freshnessTargetMilliseconds: 5000,
        stale: false,
        partial: true,
      },
      scope: {
        publicStoreReference: id(21),
        channelCode: "DINE_IN",
        orderTypeCode: "TABLE_SERVICE",
      },
      menu: {
        menuVersionReference: id(5),
        locale: "fr-CA",
        name: "Toute la journée",
        sections: [
          {
            name: "Boissons",
            sellables: [
              {
                name: "Café au lait",
                availability: "Available",
                displayPrice: { status: "Unavailable", reason: "PRICING_NOT_INTEGRATED" },
                taxDisplayContext: { status: "Unavailable", reason: "FINAL_QUOTE_REQUIRED" },
                optionRules: [{}],
              },
            ],
          },
        ],
      },
    });
  });

  it("applies bounded localized search without exposing hidden or unavailable Sellables", async () => {
    const { service } = fixture();
    const found = await service.getPublishedMenu(input({ searchTerm: "CAFÉ" }));
    expect(found.status).toBe("Found");
    if (found.status !== "Found") throw new Error("expected menu");
    expect(found.menu.sections.flatMap((section) => section.sellables)).toHaveLength(1);
    await expect(service.getPublishedMenu(input({ searchTerm: "tea" }))).resolves.toMatchObject({
      status: "Found",
      menu: { sections: [] },
    });
  });

  it("fails closed for stale, ambiguous, inactive or out-of-scope projections", async () => {
    await expect(
      fixture([projection({ freshnessStatus: "Stale" })]).service.getPublishedMenu(input()),
    ).resolves.toEqual({ status: "ProjectionStale" });
    await expect(
      fixture([
        projection(),
        projection({ generationReference: id(22) as never }),
      ]).service.getPublishedMenu(input()),
    ).resolves.toEqual({ status: "Unavailable" });
    await expect(
      fixture().service.getPublishedMenu(input({ channelCode: "DELIVERY" })),
    ).resolves.toEqual({ status: "NotFound" });
    await expect(
      fixture().service.getPublishedMenu(input({ requestedAt: "2026-08-02T18:00:00.000Z" })),
    ).resolves.toEqual({ status: "NotFound" });
  });

  it("rejects open or malformed query input before calling dependencies", async () => {
    const state = fixture();
    await expect(serviceCall(state.service, { ...input(), extra: true })).rejects.toBeInstanceOf(
      CatalogError,
    );
    await expect(
      serviceCall(state.service, input({ locale: "../../secret" })),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(state.calls).toEqual([]);
  });
});

async function serviceCall(
  service: ReturnType<typeof createCustomerMenuQueryService>,
  value: unknown,
) {
  return service.getPublishedMenu(value);
}

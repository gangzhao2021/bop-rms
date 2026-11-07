import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it } from "vitest";

import {
  buildReviewedMenuContent,
  createCustomerMenuQueryService,
  normalizeCatalogPlainText,
  parseProductAggregate,
  parseProductCustomerPresentation,
  parseProductVersion,
  parsePublishedMenuProjection,
  parsePublishedSellablePresentation,
  parseReviewedMenuContent,
  type CustomerMenuQueryPorts,
  type MenuAllergenProvenanceSnapshot,
  type PublishedMenuProjection,
  type PublishedSellablePresentation,
} from "../index.js";

const id = (n: number) => `018f7900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-17T14:00:00.000Z";
const hex = (c: string) => c.repeat(64);

function draft(extra: Record<string, unknown> = {}) {
  return {
    versionReference: id(1),
    baseVersionReference: null,
    status: "Draft",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Latte" },
    taxClassificationReference: null,
    skus: [],
    optionBindings: [],
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}
const presentation = {
  localizedDescriptions: { "en-CA": "Espresso with steamed milk." },
  photo: { imageReference: id(2), localizedAltText: { "en-CA": "A latte in a glass cup" } },
};
function renditions() {
  return [320, 640, 1280].flatMap((width, index) => [
    {
      contentType: "image/jpeg" as const,
      width: width as 320 | 640 | 1280,
      height: width * 0.75,
      path: `/media/images/${hex(String(index * 2))}.jpg`,
    },
    {
      contentType: "image/webp" as const,
      width: width as 320 | 640 | 1280,
      height: width * 0.75,
      path: `/media/images/${hex(String(index * 2 + 1))}.webp`,
    },
  ]);
}
function published(): PublishedSellablePresentation {
  return {
    localizedDescriptions: { "en-CA": "Espresso with steamed milk.", "fr-CA": "Espresso et lait." },
    photo: {
      imageReference: id(2) as never,
      localizedAltText: { "en-CA": "A latte in a glass cup" },
      width: 1280,
      height: 960,
      renditions: renditions(),
    },
  };
}

describe("WP-2423 product customer presentation", () => {
  it("normalises plain text and refuses markup, links and control characters", () => {
    expect(normalizeCatalogPlainText("  Rich \n\t espresso  ", 240)).toBe("Rich espresso");
    for (const bad of [
      "",
      "   ",
      "<b>bold</b>",
      "see https://example.com",
      "www.example.com",
      "{x}",
      "zero​width",
      "nul\u0000",
      "x".repeat(241),
    ])
      expect(() => normalizeCatalogPlainText(bad, 240)).toThrow();
    expect(normalizeCatalogPlainText("x".repeat(240), 240)).toHaveLength(240);
  });

  it("parses descriptions and photo alt text, requiring alt text in the default language", () => {
    expect(
      parseProductCustomerPresentation(
        { localizedDescriptions: { "en-CA": "  Espresso   with milk " }, photo: null },
        "en-CA",
      ),
    ).toEqual({ localizedDescriptions: { "en-CA": "Espresso with milk" }, photo: null });
    expect(
      parseProductCustomerPresentation({ localizedDescriptions: {}, photo: null }, "en-CA"),
    ).toEqual({ localizedDescriptions: {}, photo: null });
    expect(parseProductCustomerPresentation(presentation, "en-CA")).toEqual(presentation);
    expect(() =>
      parseProductCustomerPresentation(
        { ...presentation, photo: { ...presentation.photo, localizedAltText: { "fr-CA": "Un" } } },
        "en-CA",
      ),
    ).toThrow();
    expect(() =>
      parseProductCustomerPresentation({ ...presentation, extra: true }, "en-CA"),
    ).toThrow();
    expect(() =>
      parseProductCustomerPresentation(
        { ...presentation, photo: { ...presentation.photo, imageReference: "not-an-id" } },
        "en-CA",
      ),
    ).toThrow();
    expect(() =>
      parseProductCustomerPresentation(
        { localizedDescriptions: { "en-CA": "x".repeat(241) }, photo: null },
        "en-CA",
      ),
    ).toThrow();
  });

  it("keeps a product version without the key unchanged and round trips one with it", () => {
    const legacy = parseProductVersion(draft());
    expect(Object.hasOwn(legacy, "customerPresentation")).toBe(false);
    expect(canonicalizeRfc8785(legacy)).toBe(canonicalizeRfc8785(draft()));
    const withPresentation = parseProductVersion(draft({ customerPresentation: presentation }));
    expect(withPresentation.customerPresentation).toEqual(presentation);
    expect(canonicalizeRfc8785(parseProductVersion(withPresentation))).toBe(
      canonicalizeRfc8785(withPresentation),
    );
    const aggregate = {
      productReference: id(3),
      brandReference: id(4),
      internalCode: "LATTE",
      productType: "NonAlcoholicBeverage",
      lifecycle: "Draft",
      aggregateVersion: 1,
      draft: draft({ customerPresentation: presentation }),
      createdAt: at,
      createdByActorReference: id(5),
      updatedAt: at,
    };
    expect(canonicalizeRfc8785(parseProductAggregate(aggregate))).toBe(
      canonicalizeRfc8785(aggregate),
    );
  });

  it("parses a published presentation strictly", () => {
    const value = published();
    expect(canonicalizeRfc8785(parsePublishedSellablePresentation(value))).toBe(
      canonicalizeRfc8785(value),
    );
    expect(
      parsePublishedSellablePresentation({
        localizedDescriptions: { "en-CA": "Hot" },
        photo: null,
      }),
    ).toEqual({ localizedDescriptions: { "en-CA": "Hot" }, photo: null });
    const photo = value.photo;
    if (photo === null) throw new Error("photo expected");
    const broken: unknown[] = [
      { localizedDescriptions: {}, photo: null },
      { ...value, extra: 1 },
      { ...value, photo: { ...photo, renditions: renditions().slice(0, 5) } },
      { ...value, photo: { ...photo, renditions: [...renditions()].reverse() } },
      {
        ...value,
        photo: {
          ...photo,
          renditions: renditions().map((r, i) =>
            i === 0 ? { ...r, path: "https://cdn.example/x.jpg" } : r,
          ),
        },
      },
      {
        ...value,
        photo: {
          ...photo,
          renditions: renditions().map((r, i) => (i === 0 ? { ...r, path: r.path + "x" } : r)),
        },
      },
      {
        ...value,
        photo: {
          ...photo,
          renditions: renditions().map((r, i) =>
            i === 0 ? { ...r, path: r.path.replace(".jpg", ".webp") } : r,
          ),
        },
      },
      { ...value, photo: { ...photo, width: 0 } },
      { ...value, photo: { ...photo, height: 1.5 } },
      { ...value, photo: { ...photo, localizedAltText: {} } },
    ];
    for (const item of broken) expect(() => parsePublishedSellablePresentation(item)).toThrow();
  });

  function menu() {
    const base = { menuReference: id(20), brandReference: id(4) };
    return {
      ...base,
      internalCode: "ALL_DAY",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(5),
      updatedAt: at,
      draft: {
        versionReference: id(21),
        status: "Draft",
        baseMenuReference: null,
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "All day" },
        storeReferences: [id(22)],
        channelCodes: ["ONLINE"],
        orderTypeCodes: ["PICKUP"],
        createdAt: at,
        updatedAt: at,
        sections: [
          {
            ...base,
            sectionReference: id(23),
            internalCode: "DRINKS",
            localizedNames: { "en-CA": "Drinks" },
            sortOrder: 0,
            categoryReferences: [],
            placements: [24, 25].map((n, index) => ({
              ...base,
              placementReference: id(n),
              sectionReference: id(23),
              sellableReference: id(26 + index),
              sellableType: "Sku",
              presentationRole: "Standard",
              sortOrder: index,
              pinned: false,
              localizedNameOverrides: {},
              createdAt: at,
              createdByActorReference: id(5),
            })),
          },
        ],
      },
    };
  }
  function provenance(): Omit<MenuAllergenProvenanceSnapshot, "snapshotDigest"> {
    return {
      brandReference: id(4) as never,
      menuVersionReference: id(21) as never,
      registryVersionReference: id(30) as never,
      defaultLocale: "en-CA",
      registry: [
        {
          allergenReference: id(31) as never,
          code: "MILK" as never,
          localizedNames: { "en-CA": "Milk" },
        },
      ],
      evidence: [
        {
          evidenceReference: id(32) as never,
          subjectReference: id(33) as never,
          subjectKind: "Recipe",
          sourceVersionReference: id(34) as never,
          supplierReference: null,
          documentDigest: `sha256:${"a".repeat(64)}` as never,
          reviewedAt: at as never,
          validUntil: "2026-10-18T14:00:00.000Z" as never,
          status: "Approved",
          assertions: [{ allergenReference: id(31) as never, classification: "Contains" }],
        },
      ],
      paths: [26, 27].map((n) => ({
        sellableReference: id(n) as never,
        productVersionReference: id(1) as never,
        evidenceReferences: [id(32) as never],
        optionEvidenceReferences: {},
      })),
    };
  }
  function fact(n: number, extra: Record<string, unknown> = {}) {
    return {
      brandReference: id(4) as never,
      sellableReference: id(n) as never,
      productVersionReference: id(1) as never,
      productLifecycle: "Active" as const,
      skuLifecycle: "Active" as const,
      localizedNames: { "en-CA": `Latte ${n}` },
      optionRules: [],
      ...extra,
    };
  }

  it("copies a description/photo into every placement of the sellable and omits empty ones", () => {
    const content = buildReviewedMenuContent({
      menu: menu() as never,
      sellables: [
        fact(26, { presentation: published() }),
        fact(27, { presentation: { localizedDescriptions: {}, photo: null } }),
      ],
      provenance: provenance(),
      checkedAt: at,
      validationEvidenceReference: id(40),
    });
    const [first, second] = content.sections[0]?.sellables ?? [];
    expect(first?.presentation).toEqual(published());
    expect(second !== undefined && Object.hasOwn(second, "presentation")).toBe(false);
    // The stored review content re-parses to itself (menu-review-content-store invariant).
    expect(canonicalizeRfc8785(parseReviewedMenuContent(content))).toBe(
      canonicalizeRfc8785(content),
    );
    const without = buildReviewedMenuContent({
      menu: menu() as never,
      sellables: [fact(26), fact(27)],
      provenance: provenance(),
      checkedAt: at,
      validationEvidenceReference: id(40),
    });
    expect(
      without.sections[0]?.sellables.every((item) => !Object.hasOwn(item, "presentation")),
    ).toBe(true);
  });

  function projection(itemPresentation?: PublishedSellablePresentation): PublishedMenuProjection {
    return {
      projectionName: "catalog_published_menu_v1",
      projectionVersion: 1,
      generationReference: id(50) as never,
      sourceEventReference: id(51) as never,
      sourceAggregateVersion: 2,
      sourceCheckpoint: id(51) as never,
      lastRebuiltAt: at as never,
      freshnessStatus: "Fresh",
      snapshot: {
        brandReference: id(4) as never,
        menuReference: id(20) as never,
        menuVersionReference: id(21) as never,
        releaseReference: id(52) as never,
        snapshotDigest: `sha256:${"b".repeat(64)}` as never,
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "All day", "fr-CA": "Toute la journée" },
        storeReferences: [id(22) as never],
        channelCodes: ["ONLINE" as never],
        orderTypeCodes: ["PICKUP" as never],
        timeZone: "America/Toronto",
        effectiveFrom: "2026-10-17T00:00:00.000Z" as never,
        effectiveUntil: null,
        sections: [
          {
            sectionReference: id(23) as never,
            internalCode: "DRINKS" as never,
            localizedNames: { "en-CA": "Drinks", "fr-CA": "Boissons" },
            sortOrder: 0,
            sellables: [
              {
                placementReference: id(24) as never,
                sellableReference: id(26) as never,
                productVersionReference: id(1) as never,
                localizedNames: { "en-CA": "Latte", "fr-CA": "Café au lait" },
                presentationRole: "Standard",
                sortOrder: 0,
                pinned: false,
                configuredAvailability: "Available",
                optionRules: [],
                allergenDisclosure: {
                  registryVersionReference: id(30) as never,
                  items: [],
                  allergenFreeClaim: false,
                  assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                },
                ...(itemPresentation === undefined ? {} : { presentation: itemPresentation }),
              },
            ],
          },
        ],
      },
    };
  }

  it("keeps the projection with and without a presentation", () => {
    const withPresentation = projection(published());
    expect(canonicalizeRfc8785(parsePublishedMenuProjection(withPresentation))).toBe(
      canonicalizeRfc8785(withPresentation),
    );
    const legacy = projection();
    const parsed = parsePublishedMenuProjection(legacy);
    expect(canonicalizeRfc8785(parsed)).toBe(canonicalizeRfc8785(legacy));
    expect(Object.hasOwn(parsed.snapshot.sections[0]?.sellables[0] ?? {}, "presentation")).toBe(
      false,
    );
  });

  async function customerItem(locale: string, itemPresentation?: PublishedSellablePresentation) {
    const ports: CustomerMenuQueryPorts = {
      stores: {
        async resolvePublic() {
          return {
            brandReference: id(4) as never,
            storeReference: id(22) as never,
            status: "Active",
          };
        },
      },
      projections: {
        async loadCandidates() {
          return [projection(itemPresentation)];
        },
      },
    };
    const found = await createCustomerMenuQueryService(ports).getPublishedMenu({
      publicStoreReference: id(60),
      channelCode: "ONLINE",
      orderTypeCode: "PICKUP",
      locale,
      requestedAt: at,
      searchTerm: null,
      sectionReference: null,
    });
    if (found.status !== "Found") throw new Error("menu expected");
    return found.menu.sections[0]?.sellables[0];
  }

  it("gives customers the description and photo in their language with fallbacks", async () => {
    const french = await customerItem("fr-CA", published());
    expect(french?.description).toBe("Espresso et lait.");
    expect(french?.photo).toEqual({
      altText: "A latte in a glass cup",
      width: 1280,
      height: 960,
      renditions: renditions().map((r) => ({
        url: r.path,
        contentType: r.contentType,
        width: r.width,
        height: r.height,
      })),
    });
    expect((await customerItem("en-CA", published()))?.description).toBe(
      "Espresso with steamed milk.",
    );
    const onlyFrench = await customerItem("en-CA", {
      localizedDescriptions: { "fr-CA": "Espresso et lait." },
      photo: null,
    });
    expect(onlyFrench?.description).toBe("Espresso et lait.");
    expect(onlyFrench?.photo).toBeNull();
    const none = await customerItem("en-CA");
    expect(none?.description).toBeNull();
    expect(none?.photo).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  CatalogError,
  createCustomerMenuQueryService,
  publishedDefaultOptionSelections,
  type CustomerMenuQueryPorts,
  type PublishedOptionRule,
  type PublishedMenuProjection,
} from "../index.js";

const id = (n: number) => `018f7400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const allergenDisclosure = {
  registryVersionReference: id(30) as never,
  items: [
    {
      allergenReference: id(31) as never,
      code: "MILK" as never,
      localizedNames: { "en-CA": "Milk", "fr-CA": "Lait" },
      classification: "Contains" as const,
    },
  ],
  allergenFreeClaim: false as const,
  assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED" as const,
};

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
              allergenDisclosure,
              optionRules: [
                {
                  bindingReference: id(12) as never,
                  optionSetVersionReference: id(13) as never,
                  minimumSelections: 0,
                  maximumSelections: 1,
                  enabledOptionReferences: [id(14) as never],
                  defaultOptionReferences: [],
                  options: [
                    {
                      optionReference: id(14) as never,
                      localizedNames: {
                        "en-CA": "Oat beverage",
                        "fr-CA": "Boisson à l’avoine",
                      },
                      maximumQuantity: 1,
                      conflictOptionReferences: [],
                      selectedByDefault: false,
                    },
                  ],
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
              allergenDisclosure: { ...allergenDisclosure, items: [] },
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
              allergenDisclosure: { ...allergenDisclosure, items: [] },
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
    const { service, calls } = fixture();
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
                allergenDisclosure: {
                  items: [{ name: "Lait", classification: "Contains" }],
                  allergenFreeClaim: false,
                  assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                },
                displayPrice: { status: "Unavailable", reason: "PRICING_NOT_INTEGRATED" },
                taxDisplayContext: { status: "Unavailable", reason: "FINAL_QUOTE_REQUIRED" },
                optionRules: [
                  {
                    options: [
                      {
                        name: "Boisson à l’avoine",
                        maximumQuantity: 1,
                        selectedByDefault: false,
                        incrementalPrice: {
                          status: "Unavailable",
                          reason: "PRICING_NOT_INTEGRATED",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(calls[1]).toEqual({
      brandReference: id(3),
      storeReference: id(7),
      channelCode: input().channelCode,
      orderTypeCode: input().orderTypeCode,
      requestedAt: input().requestedAt,
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

  it("also matches the published customer description, listing name matches first", async () => {
    const base = projection();
    const [section] = base.snapshot.sections;
    if (section === undefined) throw new Error("expected section");
    const [latte, hidden] = section.sellables;
    if (latte === undefined || hidden === undefined) throw new Error("expected sellables");
    const menu = projection({
      snapshot: {
        ...base.snapshot,
        sections: [
          {
            ...section,
            sellables: [
              {
                ...latte,
                sortOrder: 1,
                presentation: {
                  localizedDescriptions: {
                    "en-CA": "Espresso with steamed oat beverage. Vegan on request.",
                    "fr-CA": "Espresso et boisson à l’avoine. Végétalien sur demande.",
                  },
                  photo: null,
                },
              },
              {
                ...latte,
                placementReference: id(40) as never,
                sellableReference: id(41) as never,
                productVersionReference: id(42) as never,
                localizedNames: { "en-CA": "Oat cookie", "fr-CA": "Biscuit à l’avoine" },
                presentationRole: "Standard",
                pinned: false,
                sortOrder: 2,
                optionRules: [],
              },
              {
                ...latte,
                placementReference: id(43) as never,
                sellableReference: id(44) as never,
                productVersionReference: id(45) as never,
                localizedNames: { "en-CA": "Drip coffee", "fr-CA": "Café filtre" },
                presentationRole: "Standard",
                pinned: false,
                sortOrder: 3,
                optionRules: [],
              },
              {
                ...hidden,
                sortOrder: 4,
                presentation: {
                  localizedDescriptions: { "en-CA": "Oat milk chai" },
                  photo: null,
                },
              },
            ],
          },
        ],
      },
    });
    const { service } = fixture([menu]);
    const names = async (searchTerm: string, locale = "en-CA") => {
      const result = await service.getPublishedMenu(input({ searchTerm, locale }));
      if (result.status !== "Found") throw new Error("expected menu");
      return result.menu.sections.flatMap((entry) => entry.sellables.map((item) => item.name));
    };
    // The cookie matches by name and leads, even though the latte sits earlier on the menu.
    await expect(names("OAT")).resolves.toEqual(["Oat cookie", "Latte"]);
    await expect(names("vegan")).resolves.toEqual(["Latte"]);
    // Matches the description in the customer's language; hidden items never surface.
    await expect(names("végétalien", "fr-CA")).resolves.toEqual(["Café au lait"]);
    await expect(names("chai")).resolves.toEqual([]);
    // An item with no published description matches by name only.
    await expect(names("drip")).resolves.toEqual(["Drip coffee"]);
    await expect(names("steamed")).resolves.toEqual(["Latte"]);
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

it("filters versioned option rules by channel and exposes quantity defaults", async () => {
  const value = projection();
  const item = value.snapshot.sections[0]?.sellables[0];
  if (!item) throw new Error("fixture");
  const option = {
    optionReference: id(81),
    localizedNames: { "en-CA": "Extra" },
    maximumQuantity: 3,
    conflictOptionReferences: [],
    selectedByDefault: true,
    defaultQuantity: 2,
  };
  Object.assign(item, {
    optionRules: [
      {
        semanticsVersion: 2,
        activationOptionReferences: [],
        channelCodes: ["DINE_IN"],
        bindingReference: id(80),
        optionSetVersionReference: id(82),
        minimumSelections: 2,
        maximumSelections: 3,
        enabledOptionReferences: [id(81)],
        defaultOptionReferences: [id(81)],
        options: [option],
      },
      {
        semanticsVersion: 2,
        activationOptionReferences: [],
        channelCodes: ["OTHER_CHANNEL"],
        bindingReference: id(83),
        optionSetVersionReference: id(84),
        minimumSelections: 0,
        maximumSelections: 0,
        enabledOptionReferences: [],
        defaultOptionReferences: [],
        options: [],
      },
    ],
  });
  Object.assign(value.snapshot, { channelCodes: ["DINE_IN", "OTHER_CHANNEL"] });
  const { service } = fixture([value]);
  const result = await service.getPublishedMenu(input());
  if (result.status !== "Found") throw new Error("fixture query");
  const rules = result.menu.sections[0]?.sellables[0]?.optionRules;
  expect(rules).toHaveLength(1);
  expect(rules?.[0]?.options[0]?.defaultQuantity).toBe(2);
});

it("WP-2423 8.6: shows the Store's prices and sold-out items and omits items it does not offer", async () => {
  const base = projection();
  const [section] = base.snapshot.sections;
  const [latte] = section?.sellables ?? [];
  if (section === undefined || latte === undefined) throw new Error("fixture");
  const mocha = {
    ...latte,
    placementReference: id(40) as never,
    sellableReference: id(41) as never,
    sortOrder: 4,
  };
  const tea = {
    ...latte,
    placementReference: id(42) as never,
    sellableReference: id(43) as never,
    sortOrder: 5,
  };
  const menu: PublishedMenuProjection = {
    ...base,
    snapshot: { ...base.snapshot, sections: [{ ...section, sellables: [latte, mocha, tea] }] },
  };
  interface Fact {
    availability: "Available" | "SoldOut" | "NotOffered";
    price: { amount: string; currency: string } | null;
  }
  const requested: unknown[] = [];
  const ports: CustomerMenuQueryPorts = {
    stores: {
      resolvePublic: async () => ({
        brandReference: id(3) as never,
        storeReference: id(7) as never,
        status: "Active",
      }),
    },
    projections: { loadCandidates: async () => [menu] },
    storeFacts: {
      async load(value) {
        requested.push(value);
        return new Map<string, Fact>([
          [id(10), { availability: "Available", price: null }],
          [id(41), { availability: "SoldOut", price: { amount: "5.25", currency: "CAD" } }],
          [id(43), { availability: "NotOffered", price: { amount: "3.00", currency: "CAD" } }],
        ]);
      },
    },
  };
  const found = await createCustomerMenuQueryService(ports).getPublishedMenu(
    input({ locale: "en-CA" }),
  );
  if (found.status !== "Found") throw new Error("menu");
  const items = found.menu.sections.flatMap((s) => s.sellables);
  expect(items.map((i) => i.sellableReference)).toEqual([id(10), id(41)]);
  expect(items[0]?.displayPrice).toMatchObject({ status: "Unavailable", reason: "PRICE_NOT_SET" });
  expect(items[1]).toMatchObject({
    availability: "SoldOut",
    displayPrice: { status: "Available", amount: "5.25", currency: "CAD", reason: null },
  });
  expect(requested[0]).toMatchObject({
    storeReference: id(7),
    channelCode: "DINE_IN",
    sellableReferences: [id(10), id(16), id(19), id(41), id(43)].filter((ref) =>
      menu.snapshot.sections[0]?.sellables.some((item) => item.sellableReference === ref),
    ),
  });
  const failing = createCustomerMenuQueryService({
    ...ports,
    storeFacts: {
      load: async () => {
        throw new Error("down");
      },
    },
  });
  await expect(failing.getPublishedMenu(input())).resolves.toEqual({ status: "Unavailable" });
});

it("WP-2423 4.5: names each option group and shows what each option adds at the Store", async () => {
  const base = projection();
  const [section] = base.snapshot.sections;
  const [latte] = section?.sellables ?? [];
  if (section === undefined || latte === undefined) throw new Error("fixture");
  const [rule] = latte.optionRules;
  if (rule === undefined) throw new Error("fixture");
  const menu: PublishedMenuProjection = {
    ...base,
    snapshot: {
      ...base.snapshot,
      sections: [
        {
          ...section,
          sellables: [
            {
              ...latte,
              optionRules: [{ ...rule, localizedNames: { "en-CA": "Milk", "fr-CA": "Lait" } }],
            },
          ],
        },
      ],
    },
  };
  const requested: { options?: unknown }[] = [];
  const query = (optionPrices: Map<string, { amount: string; currency: string }> | undefined) =>
    createCustomerMenuQueryService({
      stores: {
        resolvePublic: async () => ({
          brandReference: id(3) as never,
          storeReference: id(7) as never,
          status: "Active",
        }),
      },
      projections: { loadCandidates: async () => [menu] },
      storeFacts: {
        async load(value) {
          requested.push(value);
          return new Map([
            [
              id(10),
              {
                availability: "Available" as const,
                price: null,
                ...(optionPrices === undefined ? {} : { optionPrices }),
              },
            ],
          ]);
        },
      },
    }).getPublishedMenu(input({ locale: "fr-CA" }));
  const priced = await query(
    new Map([[id(12) + ":" + id(14), { amount: "0.75", currency: "CAD" }]]),
  );
  if (priced.status !== "Found") throw new Error("menu");
  const [found] = priced.menu.sections[0]?.sellables[0]?.optionRules ?? [];
  expect(found?.name).toBe("Lait");
  expect(found?.options[0]?.incrementalPrice).toEqual({
    status: "Available",
    amount: "0.75",
    currency: "CAD",
    reason: null,
  });
  expect(requested[0]?.options).toEqual([
    { sellableReference: id(10), bindingReference: id(12), optionReference: id(14) },
  ]);
  const unpriced = await query(new Map());
  if (unpriced.status !== "Found") throw new Error("menu");
  expect(
    unpriced.menu.sections[0]?.sellables[0]?.optionRules[0]?.options[0]?.incrementalPrice,
  ).toMatchObject({ status: "Unavailable", reason: "PRICE_NOT_SET" });
});

it("WP-2423 Q12: gives the Store's facts each shown item as normally ordered", async () => {
  const value = projection();
  const requested: Parameters<NonNullable<CustomerMenuQueryPorts["storeFacts"]>["load"]>[0][] = [];
  const service = createCustomerMenuQueryService({
    stores: {
      resolvePublic: async () => ({
        brandReference: id(3) as never,
        storeReference: id(7) as never,
        status: "Active",
      }),
    },
    projections: { loadCandidates: async () => [value] },
    storeFacts: {
      async load(input) {
        requested.push(input);
        return new Map();
      },
    },
  });
  await service.getPublishedMenu(input());
  const shown = value.snapshot.sections
    .flatMap((section) => section.sellables)
    .filter(
      (item) => item.configuredAvailability === "Available" && item.presentationRole !== "Hidden",
    );
  expect(requested[0]?.items?.map((item) => item.sellableReference)).toEqual(
    shown.map((item) => item.sellableReference),
  );
  expect(requested[0]?.items?.[0]?.productVersionReference).toBe(shown[0]?.productVersionReference);
});

it("WP-2423 Q12: an item's default choices follow channel, enabled options, quantities and activation", () => {
  const option = (n: number, selectedByDefault: boolean, defaultQuantity?: number) => ({
    optionReference: id(n) as never,
    localizedNames: { "en-CA": "Option" },
    maximumQuantity: 3,
    conflictOptionReferences: [],
    selectedByDefault,
    ...(defaultQuantity === undefined ? {} : { defaultQuantity }),
  });
  const rule = (
    binding: number,
    options: PublishedOptionRule["options"],
    extra: Partial<PublishedOptionRule> = {},
  ): PublishedOptionRule => ({
    semanticsVersion: 2,
    channelCodes: ["DINE_IN" as never],
    activationOptionReferences: [],
    bindingReference: id(binding) as never,
    optionSetVersionReference: id(binding + 1) as never,
    minimumSelections: 0,
    maximumSelections: 3,
    enabledOptionReferences: options.map((o) => o.optionReference),
    defaultOptionReferences: options
      .filter((o) => o.selectedByDefault)
      .map((o) => o.optionReference),
    options,
    ...extra,
  });
  const rules: PublishedOptionRule[] = [
    // Activated by a default further down: still included once the default is known.
    rule(90, [option(91, true, 1)], { activationOptionReferences: [id(81) as never] }),
    rule(80, [option(81, true, 2), option(82, false, 0)]),
    // Activated only by an option that is not a default.
    rule(70, [option(71, true, 1)], { activationOptionReferences: [id(82) as never] }),
    // Another channel.
    rule(60, [option(61, true, 1)], { channelCodes: ["OTHER" as never] }),
    // A default no longer enabled.
    rule(50, [option(51, true, 1)], { enabledOptionReferences: [] }),
    // A rule published before option quantities: a selected default is one.
    {
      bindingReference: id(40) as never,
      optionSetVersionReference: id(41) as never,
      minimumSelections: 0,
      maximumSelections: 1,
      enabledOptionReferences: [id(42) as never, id(43) as never],
      defaultOptionReferences: [id(42) as never],
      options: [option(42, true), option(43, false)],
    },
  ];
  expect(publishedDefaultOptionSelections(rules, "DINE_IN")).toEqual([
    { bindingReference: id(80), optionReference: id(81), quantity: 2 },
    { bindingReference: id(40), optionReference: id(42), quantity: 1 },
    { bindingReference: id(90), optionReference: id(91), quantity: 1 },
  ]);
  expect(publishedDefaultOptionSelections([], "DINE_IN")).toEqual([]);
});

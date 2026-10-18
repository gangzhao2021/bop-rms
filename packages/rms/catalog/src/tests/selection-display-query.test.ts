import { describe, expect, it, vi } from "vitest";
import { createCatalogSelectionDisplayQuery, type PublishedMenuProjection } from "../index.js";
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
    brandReference: id(3),
    storeReference: id(7),
    menuVersionReference: id(5),
    productVersionReference: id(11),
    sellableReference: id(10),
    channelCode: "DINE_IN",
    orderTypeCode: "TABLE_SERVICE",
    ruleEvidence: [{ bindingReference: id(12), optionSetVersionReference: id(13) }],
    optionReferences: [id(14)],
    locale: "fr-CA",
    ...overrides,
  };
}
function fixture(candidates: readonly PublishedMenuProjection[] = [projection()]) {
  const loadVersionCandidates = vi.fn(async () => candidates);
  return {
    loadVersionCandidates,
    query: createCatalogSelectionDisplayQuery({ loadVersionCandidates }),
  };
}
describe("pinned selection display", () => {
  it("returns only historical names and exact references in the requested locale", async () => {
    const f = fixture();
    const result = await f.query.describe(input());
    expect(result).toEqual({
      status: "Found",
      menuVersionReference: id(5),
      productVersionReference: id(11),
      sellableReference: id(10),
      displayName: "Café au lait",
      options: [{ optionReference: id(14), displayName: "Boisson à l’avoine" }],
    });
    expect(f.loadVersionCandidates).toHaveBeenCalledWith({
      brandReference: id(3),
      storeReference: id(7),
      menuVersionReference: id(5),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("uses only the saved default locale when the requested translation is missing", async () => {
    expect(await fixture().query.describe(input({ locale: "es-CA" }))).toMatchObject({
      displayName: "Latte",
      options: [{ displayName: "Oat beverage" }],
    });
  });
  it("does not interpret historical freshness or availability as a sale decision", async () => {
    const p = projection({ freshnessStatus: "Stale" });
    const result = await fixture([p]).query.describe(
      input({
        sellableReference: id(19),
        productVersionReference: id(20),
        ruleEvidence: [],
        optionReferences: [],
      }),
    );
    expect(result).toEqual({
      status: "Found",
      menuVersionReference: id(5),
      productVersionReference: id(20),
      sellableReference: id(19),
      displayName: "Unavailable juice",
      options: [],
    });
  });
  it.each([
    { productVersionReference: id(99) },
    { sellableReference: id(99) },
    { channelCode: "OTHER" },
    { orderTypeCode: "OTHER" },
    { ruleEvidence: [] },
    { ruleEvidence: [{ bindingReference: id(12), optionSetVersionReference: id(99) }] },
    { optionReferences: [id(99)] },
  ])("does not substitute unmatched selection evidence: %j", async (override) => {
    expect(await fixture().query.describe(input(override))).toEqual({ status: "NotFound" });
  });
  it("preserves absence", async () => {
    expect(await fixture([]).query.describe(input())).toEqual({ status: "NotFound" });
  });
  it("accepts identical historical display and denies conflicting names across generations", async () => {
    const one = projection();
    const two = structuredClone(one);
    const good = await fixture([one, two]).query.describe(input());
    expect(good.status).toBe("Found");
    const selected = two.snapshot.sections[0]?.sellables[0];
    if (!selected) throw new Error("fixture missing");
    (selected.localizedNames as Record<string, string>)["fr-CA"] = "Different historical name";
    expect(await fixture([one, two]).query.describe(input())).toEqual({ status: "Unavailable" });
  });
  it.each([
    { brandReference: id(99) },
    { menuVersionReference: id(99) },
    { storeReferences: [id(99)] },
  ])("denies dependency scope/version drift: %j", async (override) => {
    const p = projection();
    expect(
      await fixture([
        { ...p, snapshot: { ...p.snapshot, ...override } } as PublishedMenuProjection,
      ]).query.describe(input()),
    ).toEqual({ status: "Unavailable" });
  });
  it.each([
    null,
    {},
    { ...input(), extra: true },
    input({ locale: "invalid_locale" }),
    input({ optionReferences: [id(14), id(14)] }),
    input({
      ruleEvidence: [
        { bindingReference: id(12), optionSetVersionReference: id(13) },
        { bindingReference: id(12), optionSetVersionReference: id(13) },
      ],
    }),
  ])("rejects malformed input before querying: %j", async (request) => {
    const f = fixture();
    await expect(f.query.describe(request)).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
    expect(f.loadVersionCandidates).not.toHaveBeenCalled();
  });
  it("bounds dependency faults without exposing details", async () => {
    const f = fixture();
    f.loadVersionCandidates.mockRejectedValue(new Error("private dependency details"));
    expect(await f.query.describe(input())).toEqual({ status: "Unavailable" });
    expect(
      await fixture([{ ...projection(), sourceCheckpoint: id(99) as never }]).query.describe(
        input(),
      ),
    ).toEqual({ status: "Unavailable" });
  });
});

it("denies sparse arrays and accessors before querying or invoking getters", async () => {
  const f = fixture();
  const getter = vi.fn(() => id(14));
  const options = Object.defineProperty([], "0", { get: getter, enumerable: true });
  for (const optionReferences of [Array(1), options])
    await expect(f.query.describe(input({ optionReferences }))).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
  expect(getter).not.toHaveBeenCalled();
  expect(f.loadVersionCandidates).not.toHaveBeenCalled();
});

it("resolves the saved active-rule subset without requiring inactive conditional rules", async () => {
  const p = structuredClone(projection());
  const selected = p.snapshot.sections[0]?.sellables[0];
  const originalRule = selected?.optionRules[0];
  if (!selected || !originalRule) throw new Error("fixture missing");
  const additional = {
    ...originalRule,
    bindingReference: id(70) as never,
    optionSetVersionReference: id(71) as never,
  };
  (selected.optionRules as (typeof additional)[]).push(additional);
  expect((await fixture([p]).query.describe(input())).status).toBe("Found");
  expect(
    await fixture([p]).query.describe(
      input({
        ruleEvidence: [
          { bindingReference: id(12), optionSetVersionReference: id(13) },
          { bindingReference: id(70), optionSetVersionReference: id(71) },
        ],
      }),
    ),
  ).toEqual({ status: "Unavailable" });
});

it("denies duplicate active binding evidence even when no option is selected", async () => {
  const p = structuredClone(projection());
  const selected = p.snapshot.sections[0]?.sellables[0];
  const rule = selected?.optionRules[0];
  if (!selected || !rule) throw new Error("fixture missing");
  (selected.optionRules as (typeof rule)[]).push(rule);
  expect(await fixture([p]).query.describe(input({ optionReferences: [] }))).toEqual({
    status: "Unavailable",
  });
});

it("batches names with request-local version reuse and no cross-request cache", async () => {
  const f = fixture();
  const requests = [input(), input({ locale: "en-CA" })];
  const found = await f.query.describeMany(requests);
  expect(found).toHaveLength(2);
  expect(found[0]).toMatchObject({ displayName: "Café au lait" });
  expect(found[1]).toMatchObject({ displayName: "Latte" });
  expect(f.loadVersionCandidates).toHaveBeenCalledTimes(1);
  await f.query.describeMany(requests);
  expect(f.loadVersionCandidates).toHaveBeenCalledTimes(2);
  expect(await f.query.describeMany([])).toEqual([]);
});
it("validates the whole bounded batch before any dependency read", async () => {
  const f = fixture();
  for (const requests of [Array(101).fill(input()), [input(), {}], Array(1)])
    await expect(f.query.describeMany(requests)).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
  expect(f.loadVersionCandidates).not.toHaveBeenCalled();
});

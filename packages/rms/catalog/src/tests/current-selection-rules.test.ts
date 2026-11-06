import { expect, it } from "vitest";
import { resolveCurrentCatalogSelectionRules } from "../application/current-selection-rules.js";
import { createCatalogSelectionValidationService } from "../application/selection-validation-service.js";
import { parseCatalogReference, parseCatalogInstant } from "../domain/product.js";
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function pair(n = 10) {
  const option = (offset: number) => ({
    optionReference: id(n + offset),
    optionSetReference: id(n),
    brandReference: id(1),
    stableCode: "OPTION_" + offset,
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic option" },
    localizedDescriptions: {},
    sortOrder: offset,
    defaultEligible: true,
    triggeredOptionSetReference: null as string | null,
    conflictOptionReferences: [] as string[],
    createdAt: at,
    createdByActorReference: id(2),
  });
  return {
    binding: {
      bindingReference: id(n + 1),
      optionSetReference: id(n),
      optionSetVersionReference: id(n + 2),
      purpose: "CHOICE",
      sortOrder: n,
      enabledOptionReferences: [id(n + 3), id(n + 4)],
      defaultSelections: [{ optionReference: id(n + 3), quantity: 1 }],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
    optionSet: {
      optionSetReference: id(n),
      brandReference: id(1),
      internalCode: "SET_" + n,
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(2),
      updatedAt: at,
      draft: {
        versionReference: id(n + 2),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic set" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 1,
        maximumSelection: 4,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 3,
        maximumTotalQuantity: 4,
        options: [option(3), option(4)] as const,
        createdAt: at,
        updatedAt: at,
      },
    },
  };
}
async function validate(
  pairs: unknown,
  selections: readonly { optionReference: string; quantity: number }[],
) {
  const rules = resolveCurrentCatalogSelectionRules(pairs);
  return createCatalogSelectionValidationService({
    snapshots: {
      resolveCurrent: async ({ observedAt, ...input }) => ({
        ...input,
        availability: "Available",
        freshnessStatus: "Fresh",
        menuVersionReference: parseCatalogReference(id(80)),
        productVersionReference: parseCatalogReference(id(81)),
        catalogChannelCode: "CUSTOMER_PWA",
        catalogOrderTypeCode: "PICKUP",
        effectiveFrom: parseCatalogInstant(at),
        effectiveUntil: null,
        resolvedAt: observedAt,
        rules,
      }),
    },
  }).validateSelection({
    brandReference: id(1),
    storeReference: id(2),
    sourceChannel: "Web",
    orderType: "Pickup",
    sellableReference: id(3),
    optionSelections: selections,
    observedAt: at,
  });
}
it("preserves effective total and per-option limits through selection validation", async () => {
  const p = pair(),
    rules = resolveCurrentCatalogSelectionRules([p]);
  expect(rules[0]).toMatchObject({ minimumQuantity: 1, maximumQuantity: 4 });
  expect((await validate([p], [{ optionReference: id(13), quantity: 3 }])).status).toBe("Accepted");
  expect(await validate([p], [{ optionReference: id(13), quantity: 4 }])).toMatchObject({
    reason: "OPTION_QUANTITY_INVALID",
  });
  expect(
    await validate(
      [p],
      [
        { optionReference: id(13), quantity: 3 },
        { optionReference: id(14), quantity: 2 },
      ],
    ),
  ).toMatchObject({ reason: "RULE_UNSATISFIED" });
});
it("preserves conflicts without inserting default selections", async () => {
  const p = pair();
  p.optionSet.draft.options[1].conflictOptionReferences = [id(13)];
  expect(await validate([p], [])).toMatchObject({ reason: "RULE_UNSATISFIED" });
  expect(
    await validate(
      [p],
      [
        { optionReference: id(13), quantity: 1 },
        { optionReference: id(14), quantity: 1 },
      ],
    ),
  ).toMatchObject({ reason: "OPTION_CONFLICT" });
});
it("refuses a disabled default even when another active choice satisfies capacity", () => {
  const p = pair();
  p.optionSet.draft.options[0].lifecycle = "Inactive";
  expect(() => resolveCurrentCatalogSelectionRules([p])).toThrowError(
    expect.objectContaining({ code: "CATALOG_UNAVAILABLE" }),
  );
  p.binding.defaultSelections = [{ optionReference: id(14), quantity: 1 }];
  expect(
    resolveCurrentCatalogSelectionRules([p])[0]?.options.map((o) => o.optionReference),
  ).toEqual([id(14)]);
});
it("requires triggered child rules only when the triggering option is selected", async () => {
  const root = pair(),
    child = pair(30);
  root.optionSet.draft.options[1].triggeredOptionSetReference = id(30);
  expect(await validate([root, child], [{ optionReference: id(13), quantity: 1 }])).toMatchObject({
    status: "Accepted",
  });
  expect(await validate([root, child], [{ optionReference: id(14), quantity: 1 }])).toMatchObject({
    reason: "RULE_UNSATISFIED",
  });
  expect(
    await validate(
      [root, child],
      [
        { optionReference: id(14), quantity: 1 },
        { optionReference: id(33), quantity: 1 },
      ],
    ),
  ).toMatchObject({ status: "Accepted" });
});
it("prunes unreachable inactive trigger branches while retaining root required rules", async () => {
  const root = pair(),
    child = pair(30);
  root.optionSet.draft.options[1].triggeredOptionSetReference = id(30);
  root.optionSet.draft.options[1].lifecycle = "Inactive";
  expect(resolveCurrentCatalogSelectionRules([root, child])).toHaveLength(1);
  expect(await validate([root, child], [{ optionReference: id(13), quantity: 1 }])).toMatchObject({
    status: "Accepted",
  });
  expect(await validate([root, child], [{ optionReference: id(33), quantity: 1 }])).toMatchObject({
    reason: "OPTION_NOT_ENABLED",
  });
});
it("does not hide cyclic or missing trigger targets through pruning", () => {
  const root = pair(),
    child = pair(30);
  root.optionSet.draft.options[1].triggeredOptionSetReference = id(30);
  expect(() => resolveCurrentCatalogSelectionRules([root])).toThrow();
  child.optionSet.draft.options[1].triggeredOptionSetReference = id(10);
  expect(() => resolveCurrentCatalogSelectionRules([root, child])).toThrow();
});
it("rejects archived sets, ambiguous bindings and unsatisfiable required active counts", () => {
  const p = pair();
  p.optionSet.lifecycle = "Archived";
  expect(() => resolveCurrentCatalogSelectionRules([p])).toThrow();
  const q = pair();
  expect(() => resolveCurrentCatalogSelectionRules([q, q])).toThrow();
  q.optionSet.draft.options.forEach((o) => {
    o.lifecycle = "Inactive";
  });
  expect(() => resolveCurrentCatalogSelectionRules([q])).toThrow();
  expect(resolveCurrentCatalogSelectionRules([])).toEqual([]);
});

it("ignores unavailable required children only when their trigger is unreachable", async () => {
  const root = pair(),
    child = pair(30);
  root.optionSet.draft.options[1].triggeredOptionSetReference = id(30);
  root.optionSet.draft.options[1].lifecycle = "Inactive";
  child.optionSet.draft.options.forEach((option) => {
    option.lifecycle = "Draft";
  });
  expect(await validate([root, child], [{ optionReference: id(13), quantity: 1 }])).toMatchObject({
    status: "Accepted",
  });
  expect(resolveCurrentCatalogSelectionRules([root, child])).toHaveLength(1);
  root.optionSet.draft.options[1].lifecycle = "Active";
  expect(() => resolveCurrentCatalogSelectionRules([root, child])).toThrow();
});
it("WP-2423 (cart-unsellable-dishes): selling ignores a default that is off now and keeps the choices offered", async () => {
  const p = pair();
  p.optionSet.draft.options[0].lifecycle = "Inactive";
  // Listing (List it) still refuses it; selling offers the other choice.
  expect(() => resolveCurrentCatalogSelectionRules([p])).toThrow();
  const rules = resolveCurrentCatalogSelectionRules([p], undefined, { rules: "Sale" });
  expect(rules[0]?.options.map((o) => o.optionReference)).toEqual([id(14)]);
  expect(rules[0]).toMatchObject({ minimumQuantity: 1 });
});
it("WP-2423 (cart-unsellable-dishes): a required group with every choice off is a rule nothing satisfies, not an outage", async () => {
  const p = pair();
  p.optionSet.draft.options[0].lifecycle = "Inactive";
  p.optionSet.draft.options[1].lifecycle = "Inactive";
  const rules = resolveCurrentCatalogSelectionRules([p], undefined, { rules: "Sale" });
  expect(rules[0]).toMatchObject({ minimumQuantity: 1, options: [] });
  const validated = createCatalogSelectionValidationService({
    snapshots: {
      resolveCurrent: async ({ observedAt, ...input }) => ({
        ...input,
        availability: "Available",
        freshnessStatus: "Fresh",
        menuVersionReference: parseCatalogReference(id(80)),
        productVersionReference: parseCatalogReference(id(81)),
        catalogChannelCode: "CUSTOMER_PWA",
        catalogOrderTypeCode: "PICKUP",
        effectiveFrom: parseCatalogInstant(at),
        effectiveUntil: null,
        resolvedAt: observedAt,
        rules,
      }),
    },
  });
  const result = await validated.validateSelection({
    brandReference: id(1),
    storeReference: id(2),
    sourceChannel: "Web",
    orderType: "Pickup",
    sellableReference: id(3),
    optionSelections: [{ optionReference: id(13), quantity: 1 }],
    observedAt: at,
  });
  expect(result).toMatchObject({ status: "Rejected", reason: "OPTION_NOT_ENABLED" });
  expect(
    await validated.validateSelection({
      brandReference: id(1),
      storeReference: id(2),
      sourceChannel: "Web",
      orderType: "Pickup",
      sellableReference: id(3),
      optionSelections: [],
      observedAt: at,
    }),
  ).toMatchObject({ status: "Rejected", reason: "RULE_UNSATISFIED" });
});
it("WP-2423 (cart-unsellable-dishes): limits the enabled choices cannot meet even when all offered stay a setup error", () => {
  const p = pair();
  p.binding.enabledOptionReferences = [id(13)];
  p.binding.minimumSelectionOverride = 4 as never;
  p.optionSet.draft.perOptionMaximumQuantity = 1;
  p.optionSet.draft.allowRepeatedOption = false;
  expect(() => resolveCurrentCatalogSelectionRules([p], undefined, { rules: "Sale" })).toThrow();
});

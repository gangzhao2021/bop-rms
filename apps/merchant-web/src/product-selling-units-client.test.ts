import { expect, it, vi } from "vitest";
import {
  createProductSellingUnitsClient,
  sellingUnitQuantityValid,
  type ProductSellingUnitsRegistration,
} from "./product-selling-units-client.js";
import { newSkuRowsValid, selectedSellingUnitsChanged } from "./ProductNewSkus.js";
import type { ProductVersion } from "./catalog-product-command-values.js";
const id = (n: number) => "019a2421-0018-7000-8000-" + n.toString(16).padStart(12, "0"),
  scope = { brandReference: id(2), storeReference: id(3) },
  csrf = "c".repeat(43),
  at = "2026-10-04T12:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const unit = () => ({
  unitReference: id(4),
  code: "SYNTHETIC_PACK",
  semanticDefinition: "One explicitly described synthetic package",
  quantityDecimalPlaces: 2,
  localizedNames: { "en-CA": "Synthetic package" },
  lifecycle: "Active" as const,
});
const view = () => ({
  profile: "CatalogProductSellingUnitRegistryViewV1" as const,
  ...scope,
  presence: "Present" as const,
  registryVersion: 1,
  defaultLocale: "en-CA",
  units: [unit()],
  assignedHistory: [],
  historyDigest: hash,
  definitionsDigest: hash,
  inspectionDigest: hash,
  observedAt: at,
  validUntil: "2026-10-04T12:00:05.000Z",
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const command = (): ProductSellingUnitsRegistration => ({
  action: "Create",
  operationReference: id(8),
  expectedRegistryVersion: 0,
  defaultLocale: "en-CA",
  units: [{ ...unit(), unitReference: null }],
  bootstrapConfirmation: {
    historyDigest: hash,
    confirmations: [
      { unitCode: unit().code, semanticDefinition: unit().semanticDefinition, confirmed: true },
    ],
  },
});
it("inspects only the actual selected scope and retains actual assignment history when the dictionary is absent", async () => {
  const observed = {
    ...view(),
    presence: "Absent",
    registryVersion: 0,
    defaultLocale: null,
    units: [],
    definitionsDigest: null,
    assignedHistory: [
      {
        unitCode: "LEGACY",
        currentSkuCount: 2,
        historicalAssignmentCount: 3,
        quantities: ["0.25", "1"],
      },
    ],
  };
  const fetcher = vi.fn<typeof fetch>(async () => response(observed)),
    client = createProductSellingUnitsClient(fetcher, () => Date.parse(at));
  await expect(client.inspect("Create", scope, csrf)).resolves.toMatchObject({
    presence: "Absent",
    assignedHistory: observed.assignedHistory,
  });
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/merchant/catalog/products/selling-units/inspect");
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ action: "Create" });
  expect(new Headers(call?.[1]?.headers).get("x-bop-catalog-scope")).toBe(
    btoa(JSON.stringify(scope)).replace(/=+$/u, ""),
  );
});
it("refuses rebound scope, extra caller fields, denial, disabled and expired observations without an empty fallback", async () => {
  const rebound = createProductSellingUnitsClient(
    async () => response({ ...view(), brandReference: id(99) }),
    () => Date.parse(at),
  );
  await expect(rebound.inspect("Create", scope, csrf)).rejects.toThrow();
  const extra = createProductSellingUnitsClient(
    async () => response({ ...view(), actorReference: id(9) }),
    () => Date.parse(at),
  );
  await expect(extra.inspect("Create", scope, csrf)).rejects.toThrow();
  const denied = createProductSellingUnitsClient(async () =>
    response({ error: "request_denied" }, 403),
  );
  await expect(denied.inspect("Create", scope, csrf)).rejects.toMatchObject({ code: "Denied" });
  const disabled = createProductSellingUnitsClient(async () =>
    response({ error: "selling_unit_registry_feature_disabled" }, 409),
  );
  await expect(disabled.inspect("Create", scope, csrf)).rejects.toMatchObject({ code: "Disabled" });
  const stale = createProductSellingUnitsClient(
    async () => response(view()),
    () => Date.parse(at) + 5000,
  );
  await expect(stale.inspect("Create", scope, csrf)).rejects.toMatchObject({ code: "Stale" });
});
it("holds detached original registration and confirmation through lost response and denied retry", async () => {
  const bodies: string[] = [];
  let mode = "Lost";
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    bodies.push(String(options?.body));
    if (mode === "Lost") throw Error("Synthetic reply lost");
    if (mode === "Denied") return response({ error: "request_denied" }, 403);
    return response({
      profile: "CatalogProductSellingUnitRegistryResultV1",
      status: "Replayed",
      operationReference: id(8),
      registryVersion: 1,
      snapshotDigest: hash,
    });
  });
  const proposed = command(),
    prepared = createProductSellingUnitsClient(fetcher).prepare(proposed, scope);
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  Object.assign(proposed, { operationReference: id(99), units: [] });
  mode = "Denied";
  await expect(prepared.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  mode = "Replayed";
  await expect(prepared.execute(csrf)).resolves.toMatchObject({
    status: "Replayed",
    registryVersion: 1,
  });
  expect(new Set(bodies).size).toBe(1);
  const body = JSON.parse(bodies[0] ?? "null");
  expect(body.operationReference).toBe(id(8));
  expect(body.units[0].unitReference).toBeNull();
  expect(body.bootstrapConfirmation).toEqual(command().bootstrapConfirmation);
  expect(body.bootstrapConfirmation).not.toHaveProperty("definitionsDigest");
});
it("a rebound successful registration receipt stays unknown rather than releasing the original", async () => {
  const client = createProductSellingUnitsClient(async () =>
    response({
      profile: "CatalogProductSellingUnitRegistryResultV1",
      status: "Applied",
      operationReference: id(99),
      registryVersion: 1,
      snapshotDigest: hash,
    }),
  );
  await expect(client.prepare(command(), scope).execute(csrf)).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
});
it("validates exact positive decimal precision without binary money arithmetic", () => {
  expect(sellingUnitQuantityValid("0.25", 2)).toBe(true);
  for (const value of ["0", "0.00", "-1", "1e3", "01", "0.001", "1.2345678"])
    expect(sellingUnitQuantityValid(value, 2)).toBe(false);
});
it("preserves a stale observed proposal but requires renewed selected semantics before a write", () => {
  const observed = view(),
    row = {
      reference: id(7),
      code: "SKU_A",
      name: "Synthetic new SKU",
      unit: unit().code,
      quantity: "0.25",
      combination: "",
    },
    rows = [row];
  // A transaction proof expires while a human types. Structural proposal
  // validation does not turn it into permission; pages reread before dispatch.
  expect(newSkuRowsValid(rows, observed, "en-CA")).toBe(true);
  expect(selectedSellingUnitsChanged(rows, observed, { ...observed, registryVersion: 2 })).toBe(
    false,
  );
  for (const change of [
    { unitReference: id(99) },
    { semanticDefinition: "Changed explicit package" },
    { quantityDecimalPlaces: 1 },
    { lifecycle: "Inactive" as const },
  ]) {
    expect(
      selectedSellingUnitsChanged(rows, observed, {
        ...observed,
        units: [{ ...unit(), ...change }],
      }),
    ).toBe(true);
  }
  expect(newSkuRowsValid([{ ...row, unit: "UNREGISTERED" }], observed, "en-CA")).toBe(false);
});
it("admits only an explicitly selected unused recorded combination, with no generated Variant values", () => {
  const observed = view(),
    selection = { dimensionReference: id(20), valueReference: id(21) };
  const draft: ProductVersion = {
    versionReference: id(10),
    baseVersionReference: null,
    status: "Draft",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic existing Product" },
    taxClassificationReference: null,
    skus: [],
    optionBindings: [],
    createdAt: at,
    updatedAt: at,
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: {},
      localizedDescriptions: {},
      preparationNotes: {},
      tagReferences: [],
      attributeValues: [],
      media: [],
      optionRules: [],
      allergenReferences: [],
      nutritionProfile: null,
      variantDimensions: [
        {
          dimensionReference: id(20),
          code: "PORTION",
          localizedNames: { "en-CA": "Synthetic recorded portion" },
          sortOrder: 0,
          selectionRequirement: "Required",
          values: [
            {
              valueReference: id(21),
              code: "RECORDED",
              localizedNames: { "en-CA": "Synthetic recorded value" },
              sortOrder: 0,
              attributeReference: null,
              mediaReference: null,
            },
          ],
        },
      ],
      variantCombinations: [
        { selections: [selection], disposition: "NotGenerated", skuReference: null },
      ],
    },
  };
  const row = {
    reference: id(7),
    code: "SKU_A",
    name: "Synthetic explicitly selected SKU",
    unit: unit().code,
    quantity: "0.25",
    combination: "0",
  };
  expect(newSkuRowsValid([row], observed, "en-CA", draft)).toBe(true);
  expect(newSkuRowsValid([{ ...row, combination: "" }], observed, "en-CA", draft)).toBe(false);
  expect(
    newSkuRowsValid([row, { ...row, reference: id(8), code: "SKU_B" }], observed, "en-CA", draft),
  ).toBe(false);
  const content = draft.editorContent;
  if (!content) throw Error("Synthetic recorded content unavailable");
  expect(
    newSkuRowsValid([row], observed, "en-CA", {
      ...draft,
      editorContent: {
        ...content,
        variantCombinations: [
          { selections: [selection], disposition: "Invalid", skuReference: null },
        ],
      },
    }),
  ).toBe(false);
});

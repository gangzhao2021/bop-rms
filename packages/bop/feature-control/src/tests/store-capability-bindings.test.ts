import { describe, expect, it } from "vitest";
import {
  parseFeatureControlReference,
  parseFeatureControlKey,
  parseFeatureControlVersion,
} from "../contracts/feature-control.js";
import {
  createProductStoreCapabilityBindings,
  createEmptyStoreCapabilityDependencySource,
  productStoreCapabilityBindings,
  createOptionSetStoreCapabilityBindings,
  optionSetStoreCapabilityBindings,
  pricingStoreCapabilityBindings,
  createPricingStoreCapabilityBindings,
  createOrganizationStoreCapabilityBindings,
  organizationStoreCapabilityBindings,
} from "../application/store-capability-bindings.js";
const input = {
  brandReference: "019a0024-2421-7000-8000-000000000010",
  storeReference: "019a0024-2421-7000-8000-000000000020",
  observedAt: "2026-09-29T12:00:00.000Z",
  capabilityKey: "catalog.cat_product_edit",
};
describe("WP-2421 explicit Product/Store capability naming", () => {
  it("holds an immutable explicit binding without a default enable", async () => {
    const result = await createProductStoreCapabilityBindings().withCurrentBinding(
      input,
      async (binding) => {
        expect(Object.isFrozen(binding)).toBe(true);
        expect(binding.controlKey).toBe("catalog.product.edit");
        expect(Object.keys(binding)).not.toContain("enabled");
        return binding;
      },
    );
    expect(result).toBe(productStoreCapabilityBindings[2]);
    expect(new Set(productStoreCapabilityBindings.map((x) => x.mappingReference)).size).toBe(6);
  });
  it("names the canonical Product list without supplying an enablement", async () => {
    const binding = await createProductStoreCapabilityBindings().withCurrentBinding(
      { ...input, capabilityKey: "catalog.cat_product_list" },
      async (value) => value,
    );
    expect(binding).toEqual({
      capabilityKey: "catalog.cat_product_list",
      controlKey: "catalog.product.list",
      mappingReference: "019a0024-2421-7000-8000-000000000005",
      mappingVersion: 1,
      phase: "phase_1",
      commitment: "Committed",
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });
  it("names canonical SKU Detail without granting enablement", async () => {
    const binding = await createProductStoreCapabilityBindings().withCurrentBinding(
      { ...input, capabilityKey: "catalog.cat_sku_detail" },
      async (value) => value,
    );
    expect(binding).toEqual({
      capabilityKey: "catalog.cat_sku_detail",
      controlKey: "catalog.sku.detail",
      mappingReference: "019a0024-2421-7000-8000-000000000006",
      mappingVersion: 1,
      phase: "phase_1",
      commitment: "Committed",
    });
    expect(Object.isFrozen(binding)).toBe(true);
  });
  it("does not invent a binding for an otherwise valid Registry key", async () => {
    let calls = 0;
    await expect(
      createProductStoreCapabilityBindings().withCurrentBinding(
        { ...input, capabilityKey: "catalog.unknown" },
        async () => ++calls,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it.each(["", "not-a-store"])(
    "refuses an invalid current scope %s before work",
    async (storeReference) => {
      await expect(
        createProductStoreCapabilityBindings().withCurrentBinding(
          { ...input, storeReference },
          async () => "bad",
        ),
      ).rejects.toThrow();
    },
  );
  it("handles proven empty dependencies but never supplies a Future Trigger receipt", async () => {
    const source = createEmptyStoreCapabilityDependencySource();
    const base = {
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      observedAt: input.observedAt,
    };
    expect(
      await source.withCurrentEvidence({ ...base, dependencies: [] }, async (evidence) => evidence),
    ).toEqual([]);
    const dependency = {
      dependencyId: parseFeatureControlReference("019a0024-2421-7000-8000-000000000030"),
      kind: "RequiresFutureTrigger" as const,
      targetKey: parseFeatureControlKey("catalog.product.edit"),
      minimumCompatibleVersion: parseFeatureControlVersion(1),
      status: "Satisfied" as const,
      evidenceReference: parseFeatureControlReference("019a0024-2421-7000-8000-000000000031"),
      evidenceVersion: parseFeatureControlVersion(1),
    };
    await expect(
      source.withCurrentEvidence({ ...base, dependencies: [dependency] }, async () => "wrong"),
    ).rejects.toThrow();
  });
});

describe("canonical Option Set page controls", () => {
  it.each([
    ["catalog.cat_optionset_create", "catalog.optionset.create"],
    ["catalog.cat_optionset_detail", "catalog.optionset.detail"],
    ["catalog.cat_optionset_edit", "catalog.optionset.edit"],
    ["catalog.cat_optionset_list", "catalog.optionset.list"],
  ])("resolves %s without borrowing Product controls", async (capabilityKey, controlKey) => {
    const binding = await createOptionSetStoreCapabilityBindings().withCurrentBinding(
      { ...input, capabilityKey },
      async (value) => value,
    );
    expect(binding.controlKey).toBe(controlKey);
    expect(parseFeatureControlKey(binding.controlKey)).toBe(controlKey);
    expect(binding.phase).toBe("phase_1");
    expect(binding.commitment).toBe("Committed");
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding)).not.toContain("enabled");
    await expect(
      createProductStoreCapabilityBindings().withCurrentBinding(
        { ...input, capabilityKey },
        async () => true,
      ),
    ).rejects.toThrow();
  });
  it.each(["catalog.cat_product_edit", "catalog.cat_optionset_publish", "catalog.unknown"])(
    "refuses unsupported %s before the consumer",
    async (capabilityKey) => {
      let calls = 0;
      await expect(
        createOptionSetStoreCapabilityBindings().withCurrentBinding(
          { ...input, capabilityKey },
          async () => ++calls,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
  it("uses distinct immutable mapping identities across both catalogs", () => {
    const all = [...productStoreCapabilityBindings, ...optionSetStoreCapabilityBindings];
    expect(new Set(all.map((binding) => binding.mappingReference)).size).toBe(all.length);
    expect(Object.isFrozen(optionSetStoreCapabilityBindings)).toBe(true);
  });
});

describe("canonical Pricing page controls", () => {
  it.each([
    ["pricing.tax_config", "pricing.taxconfig.authoring"],
    ["pricing.price_book_list", "pricing.pricebook.list"],
    ["pricing.price_book_editor", "pricing.pricebook.editor"],
  ])(
    "holds %s without inventing enablement or a Catalog mapping",
    async (capabilityKey, controlKey) => {
      const value = await createPricingStoreCapabilityBindings().withCurrentBinding(
        { ...input, capabilityKey },
        async (binding) => binding,
      );
      expect(value.controlKey).toBe(controlKey);
      expect(parseFeatureControlKey(value.controlKey)).toBe(controlKey);
      expect(value).not.toHaveProperty("enabled");
      expect(Object.isFrozen(value)).toBe(true);
      await expect(
        createPricingStoreCapabilityBindings().withCurrentBinding(
          { ...input, capabilityKey: "catalog.cat_product_edit" },
          async () => true,
        ),
      ).rejects.toThrow();
      const all = [
        ...productStoreCapabilityBindings,
        ...optionSetStoreCapabilityBindings,
        ...pricingStoreCapabilityBindings,
      ];
      expect(new Set(all.map((row) => row.mappingReference)).size).toBe(all.length);
    },
  );
});

describe("canonical Brand Detail control", () => {
  it("maps phase_1a without inventing enabled definitions or Brand permission", async () => {
    const binding = await createOrganizationStoreCapabilityBindings().withCurrentBinding(
      { ...input, capabilityKey: "organization.org_brand_detail" },
      async (value) => value,
    );
    expect(binding).toEqual({
      capabilityKey: "organization.org_brand_detail",
      controlKey: "organization.brand.detail",
      mappingReference: "019a0024-2421-7000-8000-00000000000e",
      mappingVersion: 1,
      phase: "phase_1a",
      commitment: "Committed",
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding).not.toHaveProperty("enabled");
    const all = [
      ...productStoreCapabilityBindings,
      ...optionSetStoreCapabilityBindings,
      ...pricingStoreCapabilityBindings,
      ...organizationStoreCapabilityBindings,
    ];
    expect(new Set(all.map((row) => row.mappingReference)).size).toBe(all.length);
    await expect(
      createOrganizationStoreCapabilityBindings().withCurrentBinding(
        { ...input, capabilityKey: "organization.store_capability" },
        async () => true,
      ),
    ).rejects.toThrow();
  });
});

it("maps canonical Brand list independently of detail", async () => {
  const binding = await createOrganizationStoreCapabilityBindings().withCurrentBinding(
    { ...input, capabilityKey: "organization.org_brand_list" },
    async (value) => value,
  );
  expect(binding).toEqual({
    capabilityKey: "organization.org_brand_list",
    controlKey: "organization.brand.list",
    mappingReference: "019a0024-2421-7000-8000-00000000000f",
    mappingVersion: 1,
    phase: "phase_1a",
    commitment: "Committed",
  });
  expect(binding).not.toHaveProperty("enabled");
});

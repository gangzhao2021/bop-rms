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
    expect(new Set(productStoreCapabilityBindings.map((x) => x.mappingReference)).size).toBe(4);
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

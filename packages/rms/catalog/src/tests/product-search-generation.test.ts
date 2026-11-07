import { describe, expect, it, vi } from "vitest";
import {
  parseProductSearchBuildRequest,
  parseProductSearchGeneration,
} from "../contracts/product-search-generation.js";
import { createPostgresProductSearchGenerationStore } from "../index.js";
const id = (n: number) => "01902407-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const now = "2026-09-28T05:00:00.000Z";
const header = {
  generationReference: id(1),
  brandReference: id(2),
  sourceRevision: "9007199254740993",
  sourceDigest: "sha256:" + "a".repeat(64),
  projectedAt: now,
  productCount: 201,
  coverage: "CatalogProductDraftV1",
  partial: true,
};
describe("Product search generation contracts", () => {
  it("preserves source bigint revision strings and freezes immutable partial coverage", () => {
    const parsed = parseProductSearchGeneration(header);
    expect(parsed.sourceRevision).toBe("9007199254740993");
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([0, "01", "-1", "9223372036854775808", "1e3"])(
    "rejects invalid source revision %s",
    (sourceRevision) => {
      expect(() => parseProductSearchGeneration({ ...header, sourceRevision })).toThrow();
    },
  );
  it.each([
    { productCount: -1 },
    { partial: false },
    { coverage: "All" },
    { brandReference: "invalid-reference" },
    { extra: true },
  ])("rejects malformed generation %j", (delta) => {
    expect(() => parseProductSearchGeneration({ ...header, ...delta })).toThrow();
  });
  it("never invokes request getters", () => {
    const getter = vi.fn(() => id(1));
    const input = { actorReference: id(3), observedAt: now };
    Object.defineProperty(input, "operationReference", { enumerable: true, get: getter });
    expect(() => parseProductSearchBuildRequest(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("keeps exact current builder Actor independent of the original Product writer", async () => {
    const run = vi.fn();
    const hold = vi.fn();
    const store = createPostgresProductSearchGenerationStore({
      tenantReference: id(2),
      brandReference: id(3),
      actorReference: id(4),
      maximumProducts: 1000,
      transactions: { run },
      authorization: { holdUntilTransactionCompletes: hold },
      clock: { now: () => now },
    });
    await expect(
      store.rebuild({ operationReference: id(5), actorReference: id(6), observedAt: now }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(run).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(store.services).toHaveLength(8);
    expect(
      store.services.every(
        (service) => service.registration.consumerName === "catalog.product-search-projection:v1",
      ),
    ).toBe(true);
  });
});

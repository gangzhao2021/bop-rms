import { describe, expect, it, vi } from "vitest";
import { parseKitchenPreparationRequest } from "@rms/kitchen";
import { createKitchenRecipePreparationSource } from "./kitchen-recipe-preparation-source.js";

const id = (n: number) => "0190dddd-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "a".repeat(64);
function fixture() {
  const query = parseKitchenPreparationRequest({
    actorType: "System",
    actorReference: null,
    action: "ResolveRecipePreparationEvidence",
    purpose: "CreateKitchenWork",
    brandReference: id(1),
    storeReference: id(2),
    effectiveAt: "2026-09-12T00:00:00.000Z",
    sourceEvidenceReference: id(3),
    sourceEvidenceVersion: 1,
    sourceEvidenceDigest: digest,
    items: [
      {
        orderItemReference: id(4),
        ordinal: 1,
        quantity: 1,
        productReference: id(5),
        productVersionReference: id(6),
        skuReference: id(7),
        menuVersionReference: id(8),
        selectedOptions: [],
        sourceLineDigest: digest,
      },
    ],
  });
  const authorize = vi.fn(async () => true);
  const resolve = vi.fn(async () => {
    throw new Error("synthetic private dependency detail");
  });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const source = createKitchenRecipePreparationSource({
    brandReference: id(1),
    storeReference: id(2),
    recipe: { resolve },
    authorize,
    sha256: () => digest,
    deriveReference: () => id(9),
  });
  return { query, authorize, resolve, tx, source };
}
describe("Kitchen Recipe preparation composition", () => {
  it("rejects another Store before authorization or Recipe reads", async () => {
    const f = fixture();
    const query = parseKitchenPreparationRequest({ ...f.query, storeReference: id(99) });
    expect(await f.source.resolve(f.tx, query)).toBeNull();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("denies current authority without reading Recipe or issuing SQL", async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    expect(await f.source.resolve(f.tx, f.query)).toBeNull();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.tx.query).not.toHaveBeenCalled();
  });
  it("passes the same transaction and exact SKU options to Recipe; bounds dependency failure", async () => {
    const f = fixture();
    expect(await f.source.resolve(f.tx, f.query)).toBeNull();
    expect(f.resolve).toHaveBeenCalledWith(f.tx, {
      actorType: "System",
      actorReference: null,
      action: "ResolveConfiguredRecipePreparation",
      purpose: "CreateKitchenWork",
      brandReference: id(1),
      storeReference: id(2),
      skuReference: id(7),
      effectiveAt: f.query.effectiveAt,
      selectedOptions: [],
    });
    expect(f.tx.query).not.toHaveBeenCalled();
  });
  it("rejects unknown request fields and duplicate line identities before reads", async () => {
    const f = fixture();
    expect(
      await f.source.resolve(f.tx, { ...f.query, unexpected: true } as typeof f.query),
    ).toBeNull();
    expect(
      await f.source.resolve(f.tx, { ...f.query, items: [...f.query.items, ...f.query.items] }),
    ).toBeNull();
    expect(f.resolve).not.toHaveBeenCalled();
  });
});

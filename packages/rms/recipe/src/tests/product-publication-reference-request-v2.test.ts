import { describe, expect, it, vi } from "vitest";
import {
  parseRecipeProductPublicationReferenceRequestV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  parseRecipeReferenceSourceRequest,
  parseRecipeInventoryReferenceRequest,
  buildRecipeProductPublicationReferenceSnapshotV2,
  parseRecipeProductPublicationReferenceSnapshotV2,
  buildRecipeInventoryProductPublicationReferenceSnapshotV2,
  parseRecipeInventoryProductPublicationReferenceSnapshotV2,
  buildRecipeReferenceSourceSnapshot,
  parseRecipeReferenceSourceSnapshot,
  buildRecipeInventoryReferenceSnapshot,
  parseRecipeInventoryReferenceSnapshot,
} from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchDigest as digest,
  recipeMatchRaw,
  recipeMatchRequest,
} from "./recipe-catalog-reference-matches.fixture.js";
import { recipeInventoryMatchRaw } from "./recipe-inventory-reference-matches.fixture.js";
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
const common = () => ({
  tenantReference: id(99),
  brandReference: id(1),
  actorReference: id(2),
  actorKind: "User" as const,
  operationReference: id(4),
  productReference: id(3),
  versionReference: id(5),
  originalIntentDigest: digest,
  replacementIntentDigest: digest,
  aggregateSnapshotDigest: digest,
  currentPublicationDigest: null as string | null,
  observedAt: at,
  validUntil: plus(5000),
});
const request = () => ({
  profile: "RecipeProductPublicationReferenceRequestV2" as const,
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ" as const,
  ...common(),
});
const inventoryRequest = () => ({
  profile: "RecipeInventoryProductPublicationReferenceRequestV2" as const,
  purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ" as const,
  ...common(),
});

describe("closed Recipe publication primitive requests", () => {
  it("captures frozen bindings for both purposes and User/System without inventing command authority", () => {
    for (const actorKind of ["User", "System"] as const) {
      const input = { ...request(), actorKind, currentPublicationDigest: digest };
      const parsed = parseRecipeProductPublicationReferenceRequestV2(input);
      expect(parsed).toEqual(input);
      expect(parsed).not.toBe(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      input.originalIntentDigest = "sha256:" + "b".repeat(64);
      expect(parsed.originalIntentDigest).toBe(digest);
      expect(
        parseRecipeInventoryProductPublicationReferenceRequestV2({
          ...inventoryRequest(),
          actorKind,
        }).actorKind,
      ).toBe(actorKind);
    }
  });
  it("keeps both publication purposes and both old lifecycle parsers closed", () => {
    expect(() => parseRecipeProductPublicationReferenceRequestV2(inventoryRequest())).toThrow(
      denied,
    );
    expect(() => parseRecipeInventoryProductPublicationReferenceRequestV2(request())).toThrow(
      denied,
    );
    expect(() => parseRecipeReferenceSourceRequest(request())).toThrow(denied);
    expect(() => parseRecipeInventoryReferenceRequest(inventoryRequest())).toThrow(denied);
    expect(() => parseRecipeProductPublicationReferenceRequestV2(recipeMatchRequest)).toThrow(
      denied,
    );
    expect(() =>
      parseRecipeInventoryProductPublicationReferenceRequestV2({
        ...recipeMatchRequest,
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ",
      }),
    ).toThrow(denied);
  });
  it.each<[string, unknown]>([
    ["tenantReference", "not-a-reference"],
    ["brandReference", "01902409-0000-4000-8000-000000000001"],
    ["actorKind", "Guest"],
    ["operationReference", null],
    ["productReference", ""],
    ["versionReference", 1],
    ["originalIntentDigest", "a".repeat(64)],
    ["replacementIntentDigest", "sha256:" + "A".repeat(64)],
    ["aggregateSnapshotDigest", null],
    ["currentPublicationDigest", ""],
    ["observedAt", "2026-09-29T12:00:00Z"],
    ["validUntil", at],
    ["validUntil", plus(5001)],
    ["profile", "Other"],
    ["purposeCode", "Other"],
  ])("rejects malformed %s without widening the protocol", (key, value) => {
    expect(() =>
      parseRecipeProductPublicationReferenceRequestV2({ ...request(), [key]: value }),
    ).toThrow(denied);
    expect(() =>
      parseRecipeInventoryProductPublicationReferenceRequestV2({
        ...inventoryRequest(),
        [key]: value,
      }),
    ).toThrow(denied);
  });
  it("rejects accessors, inherited/extra/missing/symbol fields without invoking them", () => {
    const getter = vi.fn(() => digest),
      input = { ...request() };
    Object.defineProperty(input, "originalIntentDigest", { enumerable: true, get: getter });
    expect(() => parseRecipeProductPublicationReferenceRequestV2(input)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    for (const value of [
      Object.create(request()),
      { ...request(), command: {} },
      { ...request(), [Symbol("extra")]: true },
    ])
      expect(() => parseRecipeProductPublicationReferenceRequestV2(value)).toThrow(denied);
    const missing: Record<string, unknown> = { ...request() };
    delete missing.validUntil;
    expect(() => parseRecipeProductPublicationReferenceRequestV2(missing)).toThrow(denied);
  });
});

describe("independent Recipe publication source graph envelopes", () => {
  it("binds the actual Recipe SQL observation in V2 digest without changing V1 observation identity", () => {
    const r = request(),
      raw = recipeMatchRaw(),
      source = buildRecipeProductPublicationReferenceSnapshotV2(raw, r, at);
    expect(() =>
      parseRecipeProductPublicationReferenceSnapshotV2(
        { ...source, observedAt: plus(1) },
        r,
        plus(1),
      ),
    ).toThrow(denied);
    const later = buildRecipeProductPublicationReferenceSnapshotV2(
      { ...raw, observedAt: plus(1) },
      r,
      plus(1),
    );
    expect(later.digest).not.toBe(source.digest);
    expect(parseRecipeProductPublicationReferenceSnapshotV2(later, r, plus(1))).toEqual(later);
    expect(buildRecipeReferenceSourceSnapshot(raw, recipeMatchRequest, at).digest).toBe(
      buildRecipeReferenceSourceSnapshot(
        { ...raw, observedAt: plus(1) },
        recipeMatchRequest,
        plus(1),
      ).digest,
    );
  });
  it("binds the actual recursive Recipe SQL observation in V2 digest while retaining V1 bytes", () => {
    const r = inventoryRequest(),
      raw = recipeInventoryMatchRaw(),
      source = buildRecipeInventoryProductPublicationReferenceSnapshotV2(raw, r, at);
    expect(() =>
      parseRecipeInventoryProductPublicationReferenceSnapshotV2(
        { ...source, observedAt: plus(1) },
        r,
        plus(1),
      ),
    ).toThrow(denied);
    const later = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      { ...raw, observedAt: plus(1) },
      r,
      plus(1),
    );
    expect(later.digest).not.toBe(source.digest);
    expect(parseRecipeInventoryProductPublicationReferenceSnapshotV2(later, r, plus(1))).toEqual(
      later,
    );
    const oldRequest = {
      ...recipeMatchRequest,
      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
    };
    expect(buildRecipeInventoryReferenceSnapshot(raw, oldRequest, at).digest).toBe(
      buildRecipeInventoryReferenceSnapshot({ ...raw, observedAt: plus(1) }, oldRequest, plus(1))
        .digest,
    );
  });

  it("retains actual complete stored graphs and original request lease without applicability claims", () => {
    const r = request(),
      i = inventoryRequest();
    const source = buildRecipeProductPublicationReferenceSnapshotV2(recipeMatchRaw(), r, at);
    const recursive = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      recipeInventoryMatchRaw(),
      i,
      at,
    );
    expect(parseRecipeProductPublicationReferenceSnapshotV2(source, r, plus(4999))).toEqual(source);
    expect(
      parseRecipeInventoryProductPublicationReferenceSnapshotV2(recursive, i, plus(4999)),
    ).toEqual(recursive);
    expect(source.request).toEqual(r);
    expect(source.bindings).toHaveLength(3);
    expect(source.applicability).toBe("Unavailable");
    expect(recursive.removalResolution).toBe("Unavailable");
    expect(recursive.conditionalApplicability).toBe("Unavailable");
    expect(recursive.ingredients[0]?.sourceKind).toBe("SubRecipe");
  });
  it.each([
    "tenantReference",
    "brandReference",
    "actorReference",
    "operationReference",
    "productReference",
    "versionReference",
    "actorKind",
    "originalIntentDigest",
    "replacementIntentDigest",
    "aggregateSnapshotDigest",
    "currentPublicationDigest",
    "observedAt",
    "validUntil",
  ] as const)("rejects changed expected %s on both returned source envelopes", (key) => {
    const value = key.endsWith("Digest")
      ? "sha256:" + "b".repeat(64)
      : key === "actorKind"
        ? "System"
        : key === "observedAt"
          ? plus(1)
          : key === "validUntil"
            ? plus(4999)
            : id(999);
    const r = request(),
      i = inventoryRequest();
    expect(() =>
      parseRecipeProductPublicationReferenceSnapshotV2(
        buildRecipeProductPublicationReferenceSnapshotV2(recipeMatchRaw(), r, at),
        parseRecipeProductPublicationReferenceRequestV2({ ...r, [key]: value }),
        plus(2),
      ),
    ).toThrow(denied);
    expect(() =>
      parseRecipeInventoryProductPublicationReferenceSnapshotV2(
        buildRecipeInventoryProductPublicationReferenceSnapshotV2(recipeInventoryMatchRaw(), i, at),
        parseRecipeInventoryProductPublicationReferenceRequestV2({ ...i, [key]: value }),
        plus(2),
      ),
    ).toThrow(denied);
  });
  it("accepts actual empty statements but refuses data without generation or complete counts", () => {
    const empty = {
      generation: null,
      bindingCount: null,
      observedAt: at,
      counts: { recipes: "0", versions: "0", bindings: "0", modifiers: "0" },
      recipes: [],
      versions: [],
      bindings: [],
      modifiers: [],
    };
    expect(buildRecipeProductPublicationReferenceSnapshotV2(empty, request(), at).generation).toBe(
      "0",
    );
    const recursiveEmpty = {
      generation: null,
      observedAt: at,
      counts: { recipes: "0", versions: "0", ingredients: "0", modifiers: "0", changes: "0" },
      recipes: [],
      versions: [],
      ingredients: [],
      modifiers: [],
      changes: [],
    };
    expect(
      buildRecipeInventoryProductPublicationReferenceSnapshotV2(
        recursiveEmpty,
        inventoryRequest(),
        at,
      ).generation,
    ).toBe("0");
    expect(() =>
      buildRecipeProductPublicationReferenceSnapshotV2(
        { ...recipeMatchRaw(), generation: null },
        request(),
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      buildRecipeInventoryProductPublicationReferenceSnapshotV2(
        { ...recipeInventoryMatchRaw(), generation: null },
        inventoryRequest(),
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      buildRecipeProductPublicationReferenceSnapshotV2(
        { ...empty, counts: { ...empty.counts, bindings: "1" } },
        request(),
        at,
      ),
    ).toThrow(denied);
  });
  it("refuses foreign Brand rows, forged hashes and original exclusive deadline", () => {
    const raw = recipeMatchRaw(),
      recursive = recipeInventoryMatchRaw();
    const first = raw.recipes[0],
      recursiveFirst = recursive.recipes[0];
    if (!first || !recursiveFirst) throw new Error("fixture");
    expect(() =>
      buildRecipeProductPublicationReferenceSnapshotV2(
        { ...raw, recipes: [{ ...first, brandReference: id(999) }] },
        request(),
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      buildRecipeInventoryProductPublicationReferenceSnapshotV2(
        { ...recursive, recipes: [{ ...recursiveFirst, brandReference: id(999) }] },
        inventoryRequest(),
        at,
      ),
    ).toThrow(denied);
    const source = buildRecipeProductPublicationReferenceSnapshotV2(raw, request(), at);
    expect(() =>
      parseRecipeProductPublicationReferenceSnapshotV2(
        { ...source, digest: "sha256:" + "b".repeat(64) },
        request(),
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      parseRecipeProductPublicationReferenceSnapshotV2(source, request(), plus(5000)),
    ).toThrow(denied);
    expect(() =>
      buildRecipeInventoryProductPublicationReferenceSnapshotV2(
        recursive,
        inventoryRequest(),
        plus(5000),
      ),
    ).toThrow(denied);
    expect(() =>
      buildRecipeProductPublicationReferenceSnapshotV2(
        raw,
        { ...request(), observedAt: plus(1) },
        plus(1),
      ),
    ).toThrow(denied);
  });
  it("retains V1 round trips and refuses publication snapshots in V1 parsers", () => {
    const old = buildRecipeReferenceSourceSnapshot(recipeMatchRaw(), recipeMatchRequest, at);
    expect(parseRecipeReferenceSourceSnapshot(old, recipeMatchRequest, at)).toEqual(old);
    const i = {
      ...recipeMatchRequest,
      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
    };
    const recursive = buildRecipeInventoryReferenceSnapshot(recipeInventoryMatchRaw(), i, at);
    expect(parseRecipeInventoryReferenceSnapshot(recursive, i, at)).toEqual(recursive);
    expect(() =>
      parseRecipeReferenceSourceSnapshot(
        buildRecipeProductPublicationReferenceSnapshotV2(recipeMatchRaw(), request(), at),
        recipeMatchRequest,
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      parseRecipeInventoryReferenceSnapshot(
        buildRecipeInventoryProductPublicationReferenceSnapshotV2(
          recipeInventoryMatchRaw(),
          inventoryRequest(),
          at,
        ),
        i,
        at,
      ),
    ).toThrow(denied);
  });
});

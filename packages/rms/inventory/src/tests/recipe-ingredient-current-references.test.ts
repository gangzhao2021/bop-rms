import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  assessCurrentRecipeIngredientInventoryReferences as assess,
  buildInventoryConfigurationReferenceSnapshot,
} from "../index.js";
const id = (n: number) => `01902418-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw(inactive = false) {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  return {
    generation: "9",
    observedAt: at,
    counts: { items: "1", versions: "2", operations: "2" },
    items: [
      { ...scope, itemReference: id(10), itemType: "RawMaterial", createdAt: at, precise: true },
    ],
    versions: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      itemType: "RawMaterial",
      lifecycle: v === 2 && !inactive ? "Active" : "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      operationReference: id(v === 1 ? 31 : 32),
      action: v === 1 ? "Create" : inactive ? "Deactivate" : "Activate",
    })),
  };
}

const targets = () => [
  {
    recipeReference: id(20),
    recipeVersionReference: id(21),
    requirementReference: id(51),
    itemReference: id(10),
    operationReference: id(32),
  },
];
const source = (inactive = false) =>
  buildInventoryConfigurationReferenceSnapshot(raw(inactive), request, at);
const activation = "2026-09-30T00:00:00.000Z";
describe("current direct Recipe Ingredient Item configuration", () => {
  it("resolves UUID operation to exact current Active numeric configuration, without stock/units eligibility", () => {
    const s = assess(targets(), source(), request, at, activation);
    expect(s.decision).toBe("PassForDirectInventoryConfigurationReferences");
    expect(s.resolutions[0]).toMatchObject({
      status: "ResolvedCurrentActiveItemConfiguration",
      selectedItemVersion: 2,
      currentItemVersion: 2,
    });
    expect(s.unitsAndConversions).toBe("NotEvaluated");
    expect(s.stock).toBe("NotEvaluated");
    expect(s.eligibility).toBe("NotEvaluated");
    const { digest, ...body } = s;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
  });
  it.each(["item", "operation", "stale", "inactive", "mismatch"])(
    "marks %s hard, never using history as current",
    (key) => {
      const t = targets();
      const first = t[0];
      if (!first) throw new Error("fixture");
      if (key === "item") first.itemReference = id(99);
      if (key === "operation") first.operationReference = id(99);
      if (key === "stale") first.operationReference = id(31);
      let s = raw(key === "inactive");
      if (key === "mismatch") {
        s = {
          ...s,
          counts: { items: "2", versions: "3", operations: "3" },
          items: [
            ...s.items,
            {
              ...s.items[0],
              tenantReference: id(4),
              brandReference: id(1),
              itemReference: id(11),
              itemType: "RawMaterial",
              createdAt: at,
              precise: true,
            },
          ],
          versions: [
            ...s.versions,
            {
              ...s.versions[0],
              tenantReference: id(4),
              brandReference: id(1),
              itemReference: id(11),
              itemVersion: "1",
              itemType: "RawMaterial",
              lifecycle: "Active",
              recordedAt: at,
              precise: true,
            },
          ],
          operations: [
            ...s.operations,
            {
              tenantReference: id(4),
              brandReference: id(1),
              itemReference: id(11),
              itemVersion: "1",
              operationReference: id(33),
              action: "Create",
            },
          ],
        };
        first.operationReference = id(33);
      }
      expect(
        assess(
          t,
          buildInventoryConfigurationReferenceSnapshot(s, request, at),
          request,
          at,
          activation,
        ).decision,
      ).toBe("HardError");
    },
  );
  it("distinguishes zero direct ingredients, and permits distinct requirements for the same current Item", () => {
    expect(assess([], source(), request, at, activation).decision).toBe(
      "NotApplicableForDirectIngredients",
    );
    expect(
      assess(
        [
          ...targets(),
          {
            ...targets()[0],
            recipeReference: id(20),
            recipeVersionReference: id(21),
            requirementReference: id(52),
            itemReference: id(10),
            operationReference: id(32),
          },
        ],
        source(),
        request,
        at,
        activation,
      ).resolutions,
    ).toHaveLength(2);
  });
  it.each(["duplicate", "extra", "accessor", "scope", "intent", "clock", "expiry", "futureSource"])(
    "rejects invalid %s",
    (key) => {
      const t = targets();
      let r = request,
        now = at;
      if (key === "duplicate")
        t.push({
          ...t[0],
          recipeReference: id(20),
          recipeVersionReference: id(21),
          requirementReference: id(51),
          itemReference: id(10),
          operationReference: id(32),
        });
      if (key === "extra") Object.assign(t[0] ?? {}, { active: true });
      if (key === "accessor")
        Object.defineProperty(t[0], "itemReference", {
          get() {
            throw new Error("must not evaluate");
          },
          enumerable: true,
        });
      if (key === "scope") r = { ...request, tenantReference: id(99) };
      if (key === "intent") r = { ...request, catalogIntentDigest: "sha256:" + "b".repeat(64) };
      if (key === "clock") now = "2026-09-29T11:59:59.999Z";
      if (key === "expiry") now = "2026-09-29T12:00:05.000Z";
      if (key === "futureSource") now = "2026-09-28T12:00:00.000Z";
      expect(() => assess(t, source(), r, now, activation)).toThrow();
    },
  );
  it("keeps intended immediate activation while assessing current dependencies later", () => {
    expect(assess(targets(), source(), request, "2026-09-29T12:00:00.001Z", at).decision).toBe(
      "PassForDirectInventoryConfigurationReferences",
    );
  });
});

it("qualifies all4096 complete graph requirements and rejects4097", () => {
  const original = targets()[0];
  if (!original) throw Error("fixture");
  const pins = Array.from({ length: 4096 }, (_, i) => ({
    ...original,
    requirementReference: id(i + 1000),
  }));
  expect(assess(pins, source(), request, at, activation).resolutions).toHaveLength(4096);
  expect(() =>
    assess(
      [...pins, { ...original, requirementReference: id(6000) }],
      source(),
      request,
      at,
      activation,
    ),
  ).toThrow();
});

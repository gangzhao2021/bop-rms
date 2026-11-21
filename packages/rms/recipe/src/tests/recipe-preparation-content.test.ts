import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseRecipePreparationContent,
  createRecipePreparationContentBinding,
  parseRecipePreparationModifierContent,
  createRecipePreparationModifierContentBinding,
  resolveRecipePreparation,
  createRecipePreparationDisplay,
  type RecipePreparationChange,
} from "../domain/recipe-preparation-content.js";
import { parseRecipeModifierRule } from "../domain/recipe-modifier.js";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";

const id = (n: number) => "0190bbbb-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const base = preparationRecipeFixture({ lifecycle: "Published" });
function content() {
  const raw = {
    contentReference: id(1),
    brandReference: base.brandReference,
    recipeVersionReference: base.versionReference,
    preparationVersionReference: base.preparationVersionReference,
    recipeSnapshotDigest: base.snapshotDigest,
    contentDigest: hash("placeholder"),
    steps: base.steps.map((step) => ({
      ...step,
      instructionText: "Mix synthetic ingredients.",
      capabilityReference: id(2),
    })),
  };
  return parseRecipePreparationContent(
    {
      ...raw,
      contentDigest: hash(createRecipePreparationContentBinding(raw, base)),
    },
    base,
  );
}
function modifier(n: number, changes: readonly RecipePreparationChange[] = []) {
  const rule = parseRecipeModifierRule(
    {
      ruleReference: id(n + 1),
      ruleVersionReference: id(n + 2),
      brandReference: base.brandReference,
      recipeVersionReference: base.versionReference,
      ruleDigest: hash("synthetic-rule-" + n),
      selection: { bindingReference: id(n + 3), optionReference: id(n + 4), quantity: 2 },
      changes: [],
    },
    base,
  );
  const raw = {
    contentReference: id(n + 5),
    brandReference: rule.brandReference,
    recipeVersionReference: rule.recipeVersionReference,
    ruleReference: rule.ruleReference,
    ruleVersionReference: rule.ruleVersionReference,
    ruleDigest: rule.ruleDigest,
    selection: rule.selection,
    contentDigest: hash("placeholder"),
    changes,
  };
  return {
    rule,
    content: parseRecipePreparationModifierContent(
      {
        ...raw,
        contentDigest: hash(createRecipePreparationModifierContentBinding(raw, rule, base)),
      },
      rule,
      base,
    ),
  };
}
const added = (n: number) => ({
  stepReference: id(n),
  sequenceGroup: 1,
  instructionCode: "COOK",
  instructionText: "Cook synthetic item.",
  durationSeconds: 120,
  capabilityCode: "HEAT",
  capabilityReference: id(3),
});
const run = (modifiers: ReturnType<typeof modifier>[] = []) =>
  resolveRecipePreparation({
    snapshot: base,
    content: content(),
    selections: modifiers.map((m) => m.rule.selection),
    modifiers,
    sha256: hash,
  });
describe("Recipe-owned preparation content", () => {
  it("preserves explicit instructions, timing, sequence and capabilities without financial or ingredient data", () => {
    const result = run();
    expect(result.steps).toEqual(content().steps);
    expect(result.steps[0]?.durationSeconds).toBe(60);
    expect(result.steps[0]?.sequenceGroup).toBe(0);
    expect(Object.keys(result).sort()).toEqual([
      "appliedModifiers",
      "baseContentDigest",
      "baseContentReference",
      "brandReference",
      "preparationVersionReference",
      "recipeReference",
      "recipeVersionReference",
      "snapshotDigest",
      "steps",
    ]);
    expect(run()).toEqual(result);
    expect(Object.isFrozen(result.steps)).toBe(true);
  });
  it("requires explicit preparation content even for a selected ingredient-only rule", () => {
    const rule = modifier(20);
    expect(run([rule]).steps).toEqual(content().steps);
    expect(() =>
      resolveRecipePreparation({
        snapshot: base,
        content: content(),
        selections: [rule.rule.selection],
        modifiers: [],
        sha256: hash,
      }),
    ).toThrow();
    expect(() => run([{ ...rule, content: undefined as never }])).toThrow();
  });
  it("applies reviewed Add/Remove/Replace definitions without altering original Recipe steps", () => {
    const original = content();
    const first = original.steps[0];
    if (!first) throw new Error("fixture step missing");
    const changed = modifier(30, [
      { action: "Replace", step: { ...first, durationSeconds: 90 } },
      { action: "Add", step: added(500) },
    ]);
    expect(run([changed]).steps.map((s) => s.durationSeconds)).toEqual([90, 120]);
    const removed = modifier(40, [
      { action: "Remove", stepReference: first.stepReference },
      { action: "Add", step: added(501) },
    ]);
    expect(run([removed]).steps).toEqual([added(501)]);
    expect(content()).toEqual(original);
    expect(base.steps[0]?.durationSeconds).toBe(60);
  });
  it("is deterministic across independent option ordering and keeps parallel steps in one group", () => {
    const a = modifier(50, [{ action: "Add", step: added(510) }]);
    const b = modifier(60, [{ action: "Add", step: added(511) }]);
    expect(run([a, b])).toEqual(run([b, a]));
    expect(run([a, b]).steps.map((s) => s.sequenceGroup)).toEqual([0, 1, 1]);
  });
  it("rejects conflicting modifiers instead of choosing the caller's order", () => {
    const first = content().steps[0];
    if (!first) throw new Error("fixture step missing");
    const a = modifier(70, [{ action: "Replace", step: { ...first, durationSeconds: 90 } }]);
    const b = modifier(80, [{ action: "Remove", stepReference: first.stepReference }]);
    expect(() => run([a, b])).toThrow();
    expect(() => run([b, a])).toThrow();
  });
  it.each([
    ["Brand", { brandReference: id(600) }],
    ["Recipe version", { recipeVersionReference: id(600) }],
    ["Preparation version", { preparationVersionReference: id(600) }],
    ["Recipe source digest", { recipeSnapshotDigest: hash("altered") }],
    ["unknown field", { extra: true }],
  ])("rejects mismatched %s content", (_name, patch) => {
    expect(() => parseRecipePreparationContent({ ...content(), ...patch }, base)).toThrow();
  });
  it.each(["durationSeconds", "sequenceGroup", "instructionCode", "capabilityCode"] as const)(
    "cannot change original %s through base text bindings",
    (key) => {
      const original = content();
      const first = original.steps[0];
      const value = key === "durationSeconds" ? 90 : key === "sequenceGroup" ? 2 : "CHANGED";
      expect(() =>
        parseRecipePreparationContent(
          {
            ...original,
            steps: [{ ...first, [key]: value }],
          },
          base,
        ),
      ).toThrow();
    },
  );
  it.each(["", "x".repeat(501), "bad" + String.fromCharCode(10) + "instruction"])(
    "rejects invalid instruction text",
    (instructionText) => {
      const original = content();
      expect(() =>
        parseRecipePreparationContent(
          {
            ...original,
            steps: [{ ...original.steps[0], instructionText }],
          },
          base,
        ),
      ).toThrow();
    },
  );
  it("rejects text changes with a copied digest and hash failures", () => {
    const original = content();
    expect(() =>
      resolveRecipePreparation({
        snapshot: base,
        content: { ...original, steps: [{ ...original.steps[0], instructionText: "altered" }] },
        selections: [],
        modifiers: [],
        sha256: hash,
      }),
    ).toThrow();
    expect(() =>
      resolveRecipePreparation({
        snapshot: base,
        content: original,
        selections: [],
        modifiers: [],
        sha256: () => "invalid",
      }),
    ).toThrow();
  });
  it("binds preparation effects to the exact binding, option and selected quantity", () => {
    const m = modifier(90);
    expect(() =>
      parseRecipePreparationModifierContent(
        {
          ...m.content,
          selection: { ...m.rule.selection, quantity: 1 },
        },
        m.rule,
        base,
      ),
    ).toThrow();
    expect(() => run([m, m])).toThrow();
  });
  it("rejects absent targets, duplicate additions and removal of all executable steps", () => {
    const first = content().steps[0];
    if (!first) throw new Error("fixture step missing");
    expect(() => run([modifier(100, [{ action: "Remove", stepReference: id(800) }])])).toThrow();
    expect(() => run([modifier(110, [{ action: "Add", step: first }])])).toThrow();
    expect(() =>
      run([modifier(120, [{ action: "Remove", stepReference: first.stepReference }])]),
    ).toThrow();
  });
  it("rejects ambiguous capability-code mappings introduced by a modifier", () => {
    const newStep = { ...added(850), capabilityCode: "PREP", capabilityReference: id(99) };
    expect(() => run([modifier(130, [{ action: "Add", step: newStep }])])).toThrow();
  });
  it("does not execute unpublished Recipe snapshots", () => {
    expect(() =>
      resolveRecipePreparation({
        snapshot: preparationRecipeFixture(),
        content: content(),
        selections: [],
        modifiers: [],
        sha256: hash,
      }),
    ).toThrow();
  });
  it("preserves explicitly bound step-specific instructions even when instruction codes repeat", () => {
    const a = modifier(150, [{ action: "Add", step: added(901) }]);
    const b = modifier(160, [
      {
        action: "Add",
        step: { ...added(902), instructionText: "Cook the second synthetic component." },
      },
    ]);
    expect(
      run([a, b])
        .steps.slice(1)
        .map((s) => s.instructionText),
    ).toEqual(["Cook synthetic item.", "Cook the second synthetic component."]);
  });
  it("bounds hashing failures without exposing implementation details", () => {
    expect(() =>
      resolveRecipePreparation({
        snapshot: base,
        content: content(),
        selections: [],
        modifiers: [],
        sha256: () => {
          throw new Error("private hashing dependency detail");
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RECIPE_INPUT_INVALID", message: "Recipe is unavailable" }),
    );
  });
});

describe("Recipe preparation display", () => {
  const resolved = () =>
    resolveRecipePreparation({
      snapshot: base,
      content: content(),
      selections: [],
      modifiers: [],
      sha256: hash,
    });
  it("preserves full authored text, duration and parallel group without truncation", () => {
    const result = resolved();
    const original = result.steps[0];
    if (!original) throw new Error("missing fixture step");
    const longText = "x".repeat(500);
    const display = createRecipePreparationDisplay({
      ...result,
      steps: [{ ...original, instructionText: longText, sequenceGroup: 7, durationSeconds: 90 }],
    });
    expect(display.instructions).toEqual([
      "Sequence group 7 (same group may run in parallel), 90 seconds: " + longText,
    ]);
    expect(display.requiredStationCapabilityReferences).toEqual([original.capabilityReference]);
  });
  it("retains group order and deduplicates required capabilities", () => {
    const result = resolved();
    const original = result.steps[0];
    if (!original) throw new Error("missing fixture step");
    const display = createRecipePreparationDisplay({
      ...result,
      steps: [
        { ...original, sequenceGroup: 2, stepReference: id(901) },
        { ...original, sequenceGroup: 1, stepReference: id(902) },
      ],
    });
    expect(display.instructions[0]).toContain("Sequence group 1 ");
    expect(display.instructions[1]).toContain("Sequence group 2 ");
    expect(display.requiredStationCapabilityReferences).toHaveLength(1);
  });
  it("rejects missing steps and invalid duration instead of supplying defaults", () => {
    const result = resolved();
    expect(() => createRecipePreparationDisplay({ ...result, steps: [] })).toThrow();
    const original = result.steps[0];
    if (!original) throw new Error("missing fixture step");
    expect(() =>
      createRecipePreparationDisplay({
        ...result,
        steps: [{ ...original, durationSeconds: 0 }],
      }),
    ).toThrow();
  });
});

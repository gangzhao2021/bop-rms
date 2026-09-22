import {
  createRecipeSnapshot,
  parseRecipeReference,
  parseRecipeCode,
  parseRecipeDigest,
  RecipeError,
  type RecipeSnapshot,
} from "./recipe.js";
import {
  parseRecipeModifierRule,
  parseRecipeOptionSelection,
  type RecipeModifierRule,
  type RecipeOptionSelection,
} from "./recipe-modifier.js";

export interface RecipeExecutionStep {
  readonly stepReference: string;
  readonly sequenceGroup: number;
  readonly instructionCode: string;
  readonly instructionText: string;
  readonly durationSeconds: number;
  readonly capabilityCode: string;
  readonly capabilityReference: string;
}
export interface RecipePreparationContent {
  readonly contentReference: string;
  readonly brandReference: string;
  readonly recipeVersionReference: string;
  readonly preparationVersionReference: string;
  readonly recipeSnapshotDigest: string;
  readonly contentDigest: string;
  readonly steps: readonly RecipeExecutionStep[];
}
export type RecipePreparationChange =
  | { readonly action: "Add" | "Replace"; readonly step: RecipeExecutionStep }
  | { readonly action: "Remove"; readonly stepReference: string };
export interface RecipePreparationModifierContent {
  readonly contentReference: string;
  readonly brandReference: string;
  readonly recipeVersionReference: string;
  readonly ruleReference: string;
  readonly ruleVersionReference: string;
  readonly selection: RecipeOptionSelection;
  readonly ruleDigest: string;
  readonly contentDigest: string;
  readonly changes: readonly RecipePreparationChange[];
}
function fail(): never {
  throw new RecipeError("RECIPE_INPUT_INVALID");
}
function hashContent(sha256: (value: string) => string, value: string): string {
  try {
    return parseRecipeDigest(sha256(value));
  } catch {
    return fail();
  }
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function array(value: unknown, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    result.push(d.value);
  }
  return result;
}
function instruction(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) return fail();
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0 || [...normalized].length > 500) return fail();
  for (const char of normalized) {
    const n = char.codePointAt(0);
    if (
      n === undefined ||
      n <= 31 ||
      (n >= 127 && n <= 159) ||
      n === 1564 ||
      n === 8206 ||
      n === 8207 ||
      (n >= 8232 && n <= 8238) ||
      (n >= 8294 && n <= 8297)
    )
      return fail();
  }
  return normalized;
}
function step(value: unknown): RecipeExecutionStep {
  const r = object(value, [
    "stepReference",
    "sequenceGroup",
    "instructionCode",
    "instructionText",
    "durationSeconds",
    "capabilityCode",
    "capabilityReference",
  ]);
  if (
    !Number.isSafeInteger(r.sequenceGroup) ||
    (r.sequenceGroup as number) < 0 ||
    !Number.isSafeInteger(r.durationSeconds) ||
    (r.durationSeconds as number) < 1 ||
    (r.durationSeconds as number) > 86400
  )
    return fail();
  return Object.freeze({
    stepReference: parseRecipeReference(r.stepReference),
    sequenceGroup: r.sequenceGroup as number,
    instructionCode: parseRecipeCode(r.instructionCode),
    instructionText: instruction(r.instructionText),
    durationSeconds: r.durationSeconds as number,
    capabilityCode: parseRecipeCode(r.capabilityCode),
    capabilityReference: parseRecipeReference(r.capabilityReference),
  });
}
function ordered(steps: readonly RecipeExecutionStep[]): readonly RecipeExecutionStep[] {
  if (
    steps.length === 0 ||
    steps.length > 128 ||
    new Set(steps.map((s) => s.stepReference)).size !== steps.length
  )
    return fail();
  const capability = new Map<string, string>();
  for (const s of steps) {
    if (
      capability.has(s.capabilityCode) &&
      capability.get(s.capabilityCode) !== s.capabilityReference
    )
      return fail();
    capability.set(s.capabilityCode, s.capabilityReference);
  }
  return Object.freeze(
    [...steps].sort(
      (a, b) =>
        a.sequenceGroup - b.sequenceGroup ||
        (a.stepReference < b.stepReference ? -1 : a.stepReference > b.stepReference ? 1 : 0),
    ),
  );
}

export function parseRecipePreparationContent(
  value: unknown,
  snapshotInput: RecipeSnapshot,
): RecipePreparationContent {
  const snapshot = createRecipeSnapshot(snapshotInput);
  const r = object(value, [
    "contentReference",
    "brandReference",
    "recipeVersionReference",
    "preparationVersionReference",
    "recipeSnapshotDigest",
    "contentDigest",
    "steps",
  ]);
  if (
    r.brandReference !== snapshot.brandReference ||
    r.recipeVersionReference !== snapshot.versionReference ||
    r.preparationVersionReference !== snapshot.preparationVersionReference ||
    r.recipeSnapshotDigest !== snapshot.snapshotDigest
  )
    return fail();
  const steps = ordered(array(r.steps, 128).map(step));
  const originals = new Map(snapshot.steps.map((s) => [String(s.stepReference), s]));
  if (steps.length !== originals.size) return fail();
  for (const materialized of steps) {
    const original = originals.get(materialized.stepReference);
    if (
      !original ||
      original.sequenceGroup !== materialized.sequenceGroup ||
      original.instructionCode !== materialized.instructionCode ||
      original.durationSeconds !== materialized.durationSeconds ||
      original.capabilityCode !== materialized.capabilityCode
    )
      return fail();
  }
  return Object.freeze({
    contentReference: parseRecipeReference(r.contentReference),
    brandReference: snapshot.brandReference,
    recipeVersionReference: snapshot.versionReference,
    preparationVersionReference: snapshot.preparationVersionReference,
    recipeSnapshotDigest: snapshot.snapshotDigest,
    contentDigest: parseRecipeDigest(r.contentDigest),
    steps,
  });
}
export function createRecipePreparationContentBinding(
  value: unknown,
  snapshot: RecipeSnapshot,
): string {
  const content = parseRecipePreparationContent(value, snapshot);
  return JSON.stringify(
    Object.fromEntries(Object.entries(content).filter(([key]) => key !== "contentDigest")),
  );
}
export function parseRecipePreparationModifierContent(
  value: unknown,
  ruleInput: RecipeModifierRule,
  snapshot: RecipeSnapshot,
): RecipePreparationModifierContent {
  const rule = parseRecipeModifierRule(ruleInput, snapshot);
  const r = object(value, [
    "contentReference",
    "brandReference",
    "recipeVersionReference",
    "ruleReference",
    "ruleVersionReference",
    "selection",
    "ruleDigest",
    "contentDigest",
    "changes",
  ]);
  if (
    r.brandReference !== rule.brandReference ||
    r.recipeVersionReference !== rule.recipeVersionReference ||
    r.ruleReference !== rule.ruleReference ||
    r.ruleVersionReference !== rule.ruleVersionReference ||
    r.ruleDigest !== rule.ruleDigest
  )
    return fail();
  const selection = parseRecipeOptionSelection(r.selection);
  if (
    selection.bindingReference !== rule.selection.bindingReference ||
    selection.optionReference !== rule.selection.optionReference ||
    selection.quantity !== rule.selection.quantity
  )
    return fail();
  const changes = array(r.changes, 128).map((value): RecipePreparationChange => {
    const action =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "action")?.value
        : undefined;
    if (action === "Remove") {
      const c = object(value, ["action", "stepReference"]);
      return Object.freeze({ action, stepReference: parseRecipeReference(c.stepReference) });
    }
    if (action !== "Add" && action !== "Replace") return fail();
    const c = object(value, ["action", "step"]);
    return Object.freeze({ action, step: step(c.step) });
  });
  const targets = changes.map((c) =>
    c.action === "Remove" ? c.stepReference : c.step.stepReference,
  );
  if (new Set(targets).size !== targets.length) return fail();
  return Object.freeze({
    contentReference: parseRecipeReference(r.contentReference),
    brandReference: rule.brandReference,
    recipeVersionReference: rule.recipeVersionReference,
    ruleReference: rule.ruleReference,
    ruleVersionReference: rule.ruleVersionReference,
    selection,
    ruleDigest: rule.ruleDigest,
    contentDigest: parseRecipeDigest(r.contentDigest),
    changes: Object.freeze(changes),
  });
}
export function createRecipePreparationModifierContentBinding(
  value: unknown,
  rule: RecipeModifierRule,
  snapshot: RecipeSnapshot,
): string {
  const content = parseRecipePreparationModifierContent(value, rule, snapshot);
  return JSON.stringify(
    Object.fromEntries(Object.entries(content).filter(([key]) => key !== "contentDigest")),
  );
}

/** Pure configured preparation; caller must supply actual authorized/published/reviewed owner records. */
export function resolveRecipePreparation(input: {
  readonly snapshot: RecipeSnapshot;
  readonly content: unknown;
  readonly selections: readonly RecipeOptionSelection[];
  readonly modifiers: readonly { readonly rule: RecipeModifierRule; readonly content: unknown }[];
  readonly sha256: (value: string) => string;
}) {
  const snapshot = createRecipeSnapshot(input.snapshot);
  if (snapshot.lifecycle !== "Published") return fail();
  const content = parseRecipePreparationContent(input.content, snapshot);
  if (
    hashContent(input.sha256, createRecipePreparationContentBinding(content, snapshot)) !==
    content.contentDigest
  )
    return fail();
  const selections = array(input.selections, 256).map(parseRecipeOptionSelection);
  const selectionKey = (s: RecipeOptionSelection) =>
    s.bindingReference + ":" + s.optionReference + ":" + s.quantity;
  if (
    new Set(selections.map((s) => s.bindingReference + ":" + s.optionReference)).size !==
    selections.length
  )
    return fail();
  const required = new Set(selections.map(selectionKey));
  const modifiers = array(input.modifiers, 256)
    .map((value) => {
      const r = object(value, ["rule", "content"]);
      const rule = parseRecipeModifierRule(r.rule, snapshot);
      if (!required.delete(selectionKey(rule.selection))) return fail();
      const prepared = parseRecipePreparationModifierContent(r.content, rule, snapshot);
      if (
        hashContent(
          input.sha256,
          createRecipePreparationModifierContentBinding(prepared, rule, snapshot),
        ) !== prepared.contentDigest
      )
        return fail();
      return { rule, content: prepared };
    })
    .sort((a, b) => (a.rule.ruleVersionReference < b.rule.ruleVersionReference ? -1 : 1));
  if (
    required.size !== 0 ||
    new Set(modifiers.map((m) => m.rule.ruleVersionReference)).size !== modifiers.length ||
    new Set(modifiers.map((m) => m.rule.ruleReference)).size !== modifiers.length ||
    new Set([content.contentReference, ...modifiers.map((m) => m.content.contentReference)])
      .size !==
      modifiers.length + 1
  )
    return fail();
  const targets = new Set<string>();
  const steps = new Map(content.steps.map((s) => [s.stepReference, s]));
  for (const modifier of modifiers) {
    for (const change of modifier.content.changes) {
      const target = change.action === "Remove" ? change.stepReference : change.step.stepReference;
      if (targets.has(target)) return fail();
      targets.add(target);
      if (change.action === "Add" ? steps.has(target) : !steps.has(target)) return fail();
      if (change.action === "Remove") steps.delete(target);
      else steps.set(target, change.step);
    }
  }
  const result = Object.freeze({
    recipeReference: snapshot.recipeReference,
    recipeVersionReference: snapshot.versionReference,
    preparationVersionReference: snapshot.preparationVersionReference,
    brandReference: snapshot.brandReference,
    baseContentReference: content.contentReference,
    baseContentDigest: content.contentDigest,
    appliedModifiers: Object.freeze(
      modifiers.map(({ rule, content: prepared }) =>
        Object.freeze({
          ruleReference: rule.ruleReference,
          ruleVersionReference: rule.ruleVersionReference,
          ruleDigest: rule.ruleDigest,
          contentReference: prepared.contentReference,
          contentDigest: prepared.contentDigest,
          selection: rule.selection,
        }),
      ),
    ),
    steps: ordered([...steps.values()]),
  });
  return Object.freeze({
    ...result,
    snapshotDigest: hashContent(input.sha256, JSON.stringify(result)),
  });
}

/** Readable owner projection; structured steps remain authoritative for execution semantics. */
export function createRecipePreparationDisplay(input: ReturnType<typeof resolveRecipePreparation>) {
  const steps = ordered(array(input.steps, 128).map(step));
  if (steps.length === 0) return fail();
  return Object.freeze({
    instructions: Object.freeze(
      steps.map(
        (item) =>
          "Sequence group " +
          item.sequenceGroup +
          " (same group may run in parallel), " +
          item.durationSeconds +
          " seconds: " +
          item.instructionText,
      ),
    ),
    requiredStationCapabilityReferences: Object.freeze(
      [...new Set(steps.map((item) => item.capabilityReference))].sort(),
    ),
  });
}

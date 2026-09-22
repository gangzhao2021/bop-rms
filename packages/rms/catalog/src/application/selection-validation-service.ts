import {
  type CatalogSelectionAccepted,
  type CatalogSelectionQuantity,
  type CatalogSelectionValidationResult,
  type ValidateCatalogSelectionInput,
} from "../contracts/selection-validation.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogReference,
} from "../domain/product.js";
import type {
  CatalogSelectionValidationPorts,
  CurrentCatalogSelectionSnapshot,
} from "./ports/selection-validation-ports.js";

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}

/** Copy only dense data elements; never dispatch methods supplied on a collection. */
function collection(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 100) return invalid();
  if (Reflect.ownKeys(value).length !== length + 1) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999)
    return invalid();
  return value as number;
}

function references(value: unknown): readonly CatalogReference[] {
  const result = Object.freeze(collection(value).map(parseCatalogReference));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}

function selections(value: unknown): readonly CatalogSelectionQuantity[] {
  const result = Object.freeze(
    collection(value).map((candidate) => {
      const raw = exact(candidate, ["optionReference", "quantity"]);
      return Object.freeze({
        optionReference: parseCatalogReference(raw.optionReference),
        quantity: positive(raw.quantity),
      });
    }),
  );
  if (new Set(result.map((item) => item.optionReference)).size !== result.length) return invalid();
  return result;
}

function input(value: unknown): ValidateCatalogSelectionInput {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "sourceChannel",
    "orderType",
    "sellableReference",
    "optionSelections",
    "observedAt",
  ]);
  if (
    typeof raw.sourceChannel !== "string" ||
    !["Api", "Pos", "Qr", "Web"].includes(raw.sourceChannel) ||
    typeof raw.orderType !== "string" ||
    !["DineIn", "Pickup"].includes(raw.orderType)
  )
    return invalid();
  return Object.freeze({
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    sourceChannel: raw.sourceChannel as ValidateCatalogSelectionInput["sourceChannel"],
    orderType: raw.orderType as ValidateCatalogSelectionInput["orderType"],
    sellableReference: parseCatalogReference(raw.sellableReference),
    optionSelections: selections(raw.optionSelections),
    observedAt: parseCatalogInstant(raw.observedAt),
  });
}

function rule(value: unknown) {
  const raw = exact(value, [
    "bindingReference",
    "optionSetVersionReference",
    "activationOptionReferences",
    "minimumQuantity",
    "maximumQuantity",
    "options",
  ]);
  const minimumQuantity = Number.isSafeInteger(raw.minimumQuantity)
    ? (raw.minimumQuantity as number)
    : invalid();
  const maximumQuantity = Number.isSafeInteger(raw.maximumQuantity)
    ? (raw.maximumQuantity as number)
    : invalid();
  if (minimumQuantity < 0 || maximumQuantity < minimumQuantity || maximumQuantity > 99_900)
    return invalid();
  const options = Object.freeze(
    collection(raw.options).map((option) => {
      const candidate = exact(option, [
        "optionReference",
        "maximumQuantity",
        "conflictOptionReferences",
      ]);
      return Object.freeze({
        optionReference: parseCatalogReference(candidate.optionReference),
        maximumQuantity: positive(candidate.maximumQuantity),
        conflictOptionReferences: references(candidate.conflictOptionReferences),
      });
    }),
  );
  if (
    new Set(options.map((option) => option.optionReference)).size !== options.length ||
    options.some(
      (option) =>
        option.conflictOptionReferences.includes(option.optionReference) ||
        option.maximumQuantity > maximumQuantity,
    )
  )
    return invalid();
  return Object.freeze({
    bindingReference: parseCatalogReference(raw.bindingReference),
    optionSetVersionReference: parseCatalogReference(raw.optionSetVersionReference),
    activationOptionReferences: references(raw.activationOptionReferences),
    minimumQuantity,
    maximumQuantity,
    options,
  });
}

function hasTriggerCycle(rules: readonly ReturnType<typeof rule>[]) {
  const owner = new Map<CatalogReference, CatalogReference>();
  for (const candidate of rules)
    for (const option of candidate.options)
      owner.set(option.optionReference, candidate.bindingReference);
  const graph = new Map<CatalogReference, Set<CatalogReference>>();
  for (const candidate of rules) {
    for (const reference of candidate.activationOptionReferences) {
      const source = owner.get(reference);
      if (source === undefined) return true;
      const targets = graph.get(source) ?? new Set<CatalogReference>();
      targets.add(candidate.bindingReference);
      graph.set(source, targets);
    }
  }
  const visiting = new Set<CatalogReference>();
  const visited = new Set<CatalogReference>();
  const visit = (reference: CatalogReference): boolean => {
    if (visiting.has(reference)) return true;
    if (visited.has(reference)) return false;
    visiting.add(reference);
    for (const target of graph.get(reference) ?? []) if (visit(target)) return true;
    visiting.delete(reference);
    visited.add(reference);
    return false;
  };
  return rules.some((candidate) => visit(candidate.bindingReference));
}

function parsedRules(value: unknown) {
  const rules = Object.freeze(collection(value).map(rule));
  const options = rules.flatMap((candidate) => candidate.options);
  const optionReferences = new Set(options.map((option) => option.optionReference));
  if (
    new Set(rules.map((candidate) => candidate.bindingReference)).size !== rules.length ||
    optionReferences.size !== options.length ||
    hasTriggerCycle(rules) ||
    rules.some((candidate) =>
      candidate.activationOptionReferences.some((reference) => !optionReferences.has(reference)),
    ) ||
    options.some((option) =>
      option.conflictOptionReferences.some((reference) => !optionReferences.has(reference)),
    )
  )
    return invalid();
  return rules;
}

function snapshot(value: CurrentCatalogSelectionSnapshot, expected: ValidateCatalogSelectionInput) {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "sourceChannel",
    "orderType",
    "sellableReference",
    "availability",
    "freshnessStatus",
    "menuVersionReference",
    "productVersionReference",
    "catalogChannelCode",
    "catalogOrderTypeCode",
    "effectiveFrom",
    "effectiveUntil",
    "resolvedAt",
    "rules",
  ]);
  if (raw.availability !== "Available" || raw.freshnessStatus !== "Fresh") return invalid();
  const effectiveFrom = parseCatalogInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseCatalogInstant(raw.effectiveUntil);
  const rules = parsedRules(raw.rules);
  if (
    parseCatalogReference(raw.brandReference) !== expected.brandReference ||
    parseCatalogReference(raw.storeReference) !== expected.storeReference ||
    raw.sourceChannel !== expected.sourceChannel ||
    raw.orderType !== expected.orderType ||
    parseCatalogReference(raw.sellableReference) !== expected.sellableReference ||
    parseCatalogInstant(raw.resolvedAt) !== expected.observedAt ||
    Date.parse(expected.observedAt) < Date.parse(effectiveFrom) ||
    (effectiveUntil !== null && Date.parse(expected.observedAt) >= Date.parse(effectiveUntil))
  )
    return invalid();
  return Object.freeze({
    menuVersionReference: parseCatalogReference(raw.menuVersionReference),
    productVersionReference: parseCatalogReference(raw.productVersionReference),
    catalogChannelCode: parseCatalogCode(raw.catalogChannelCode),
    catalogOrderTypeCode: parseCatalogCode(raw.catalogOrderTypeCode),
    rules,
  });
}

const rejected = (
  reason: Extract<CatalogSelectionValidationResult, { status: "Rejected" }>["reason"],
): CatalogSelectionValidationResult => Object.freeze({ status: "Rejected", reason });

function validate(
  parsed: ValidateCatalogSelectionInput,
  current: ReturnType<typeof snapshot>,
): CatalogSelectionValidationResult {
  const selected = new Map(
    parsed.optionSelections.map((item) => [item.optionReference, item.quantity]),
  );
  const allOptions = current.rules.flatMap((candidate) => candidate.options);
  if (
    [...selected.keys()].some(
      (reference) => !allOptions.some((option) => option.optionReference === reference),
    )
  )
    return rejected("OPTION_NOT_ENABLED");
  if (
    allOptions.some(
      (option) => (selected.get(option.optionReference) ?? 0) > option.maximumQuantity,
    )
  )
    return rejected("OPTION_QUANTITY_INVALID");
  const selectedReferences = new Set(selected.keys());
  if (
    allOptions.some(
      (option) =>
        selectedReferences.has(option.optionReference) &&
        option.conflictOptionReferences.some((reference) => selectedReferences.has(reference)),
    )
  )
    return rejected("OPTION_CONFLICT");
  const activeRules = current.rules.filter(
    (candidate) =>
      candidate.activationOptionReferences.length === 0 ||
      candidate.activationOptionReferences.some((reference) => selectedReferences.has(reference)),
  );
  for (const candidate of current.rules) {
    const total = candidate.options.reduce(
      (sum, option) => sum + (selected.get(option.optionReference) ?? 0),
      0,
    );
    const active = activeRules.includes(candidate);
    if (
      (!active && total !== 0) ||
      (active && (total < candidate.minimumQuantity || total > candidate.maximumQuantity))
    )
      return rejected("RULE_UNSATISFIED");
  }
  const accepted: CatalogSelectionAccepted = Object.freeze({
    status: "Accepted",
    ...parsed,
    menuVersionReference: current.menuVersionReference,
    productVersionReference: current.productVersionReference,
    catalogChannelCode: current.catalogChannelCode,
    catalogOrderTypeCode: current.catalogOrderTypeCode,
    ruleEvidence: Object.freeze(
      activeRules.map((candidate) =>
        Object.freeze({
          bindingReference: candidate.bindingReference,
          optionSetVersionReference: candidate.optionSetVersionReference,
        }),
      ),
    ),
    validatedAt: parsed.observedAt,
  });
  return accepted;
}

export function createCatalogSelectionValidationService(ports: CatalogSelectionValidationPorts) {
  return Object.freeze({
    async validateSelection(value: unknown): Promise<CatalogSelectionValidationResult> {
      const parsed = input(value);
      let resolved: CurrentCatalogSelectionSnapshot | null;
      try {
        resolved = await ports.snapshots.resolveCurrent({
          brandReference: parsed.brandReference,
          storeReference: parsed.storeReference,
          sourceChannel: parsed.sourceChannel,
          orderType: parsed.orderType,
          sellableReference: parsed.sellableReference,
          observedAt: parsed.observedAt,
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
      if (resolved === null) return rejected("SELLABLE_UNAVAILABLE");
      return validate(parsed, snapshot(resolved, parsed));
    },
  });
}

export interface CatalogReviewOptionSelection {
  readonly bindingReference: CatalogReference;
  readonly optionReference: CatalogReference;
  readonly quantity: number;
}

/** Complete review coverage only. Budget exhaustion never returns a partial list.
 * No current publication/availability or customer authorization is inferred.
 */
export function enumerateCatalogReviewSelections(
  rulesInput: unknown,
  budget: {
    maximumConfigurations: number;
    maximumSearchSteps: number;
  },
): readonly (readonly CatalogReviewOptionSelection[])[] {
  if (
    !Number.isSafeInteger(budget.maximumConfigurations) ||
    budget.maximumConfigurations < 1 ||
    budget.maximumConfigurations > 10000 ||
    !Number.isSafeInteger(budget.maximumSearchSteps) ||
    budget.maximumSearchSteps < 1 ||
    budget.maximumSearchSteps > 1000000
  )
    return invalid();
  const rules = parsedRules(rulesInput);
  const owner = new Map(
    rules.flatMap((candidate) =>
      candidate.options.map(
        (option) => [option.optionReference, candidate.bindingReference] as const,
      ),
    ),
  );
  const pending = [...rules].sort((a, b) => a.bindingReference.localeCompare(b.bindingReference));
  const ordered: (typeof rules)[number][] = [];
  const done = new Set<CatalogReference>();
  while (pending.length) {
    const index = pending.findIndex((candidate) =>
      candidate.activationOptionReferences.every((reference) =>
        done.has(owner.get(reference) as CatalogReference),
      ),
    );
    if (index < 0) return invalid();
    const candidate = pending.splice(index, 1)[0];
    if (!candidate) return invalid();
    ordered.push(candidate);
    done.add(candidate.bindingReference);
  }
  const selected = new Map<CatalogReference, CatalogReviewOptionSelection>();
  const options = new Map(
    rules.flatMap((candidate) =>
      candidate.options.map((option) => [option.optionReference, option] as const),
    ),
  );
  const configurations: (readonly CatalogReviewOptionSelection[])[] = [];
  let steps = 0;
  const tick = () => {
    if (++steps > budget.maximumSearchSteps)
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const choices = ordered.map((candidate) =>
    [...candidate.options].sort((a, b) => a.optionReference.localeCompare(b.optionReference)),
  );
  type Task =
    | { kind: "group"; groupIndex: number }
    | { kind: "option"; groupIndex: number; index: number; total: number; quantity: number }
    | { kind: "remove"; reference: CatalogReference };
  const tasks: Task[] = [{ kind: "group", groupIndex: 0 }];
  while (tasks.length) {
    tick();
    const task = tasks.pop();
    if (!task) return invalid();
    if (task.kind === "remove") {
      selected.delete(task.reference);
      continue;
    }
    const candidate = ordered[task.groupIndex];
    if (task.kind === "group") {
      if (!candidate) {
        if (configurations.length >= budget.maximumConfigurations)
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        configurations.push(
          Object.freeze(
            [...selected.values()].sort((a, b) =>
              a.optionReference.localeCompare(b.optionReference),
            ),
          ),
        );
        continue;
      }
      const active =
        candidate.activationOptionReferences.length === 0 ||
        candidate.activationOptionReferences.some((reference) => selected.has(reference));
      tasks.push(
        active
          ? { kind: "option", groupIndex: task.groupIndex, index: 0, total: 0, quantity: 0 }
          : { kind: "group", groupIndex: task.groupIndex + 1 },
      );
      continue;
    }
    if (!candidate) return invalid();
    const groupChoices = choices[task.groupIndex];
    if (!groupChoices) return invalid();
    const option = groupChoices[task.index];
    if (!option) {
      if (task.total >= candidate.minimumQuantity)
        tasks.push({ kind: "group", groupIndex: task.groupIndex + 1 });
      continue;
    }
    const maximum = Math.min(option.maximumQuantity, candidate.maximumQuantity - task.total);
    if (task.quantity < maximum) tasks.push({ ...task, quantity: task.quantity + 1 });
    const remainingMaximum = groupChoices
      .slice(task.index + 1)
      .reduce((sum, item) => sum + item.maximumQuantity, 0);
    if (task.total + task.quantity + remainingMaximum < candidate.minimumQuantity) continue;
    if (task.quantity > 0) {
      // The existing live selection contract permits at most 100 selected options.
      if (
        selected.size >= 100 ||
        [...selected.keys()].some(
          (reference) =>
            option.conflictOptionReferences.includes(reference) ||
            options.get(reference)?.conflictOptionReferences.includes(option.optionReference),
        )
      )
        continue;
      selected.set(
        option.optionReference,
        Object.freeze({
          bindingReference: candidate.bindingReference,
          optionReference: option.optionReference,
          quantity: task.quantity,
        }),
      );
      tasks.push({ kind: "remove", reference: option.optionReference });
    }
    tasks.push({
      kind: "option",
      groupIndex: task.groupIndex,
      index: task.index + 1,
      total: task.total + task.quantity,
      quantity: 0,
    });
  }
  if (!configurations.length) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return Object.freeze(configurations);
}

import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
  type CatalogCode,
  type CatalogInstant,
  type CatalogReference,
  type ProductOptionBinding,
} from "./product.js";

export type OptionSetLifecycle = "Draft" | "Archived";
export type OptionLifecycle = "Draft" | "Active" | "Inactive" | "Archived";
export type OptionSetDisplayStyle = "SingleChoice" | "MultiChoice" | "Quantity";

export interface CatalogOption {
  readonly optionReference: CatalogReference;
  readonly optionSetReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly stableCode: CatalogCode;
  readonly lifecycle: OptionLifecycle;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly localizedDescriptions: Readonly<Record<string, string>>;
  readonly sortOrder: number;
  readonly defaultEligible: boolean;
  readonly triggeredOptionSetReference: CatalogReference | null;
  readonly conflictOptionReferences: readonly CatalogReference[];
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
}

export interface OptionSetDraft {
  readonly versionReference: CatalogReference;
  readonly status: "Draft";
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly localizedDescriptions: Readonly<Record<string, string>>;
  readonly displayStyle: OptionSetDisplayStyle;
  readonly minimumSelection: number;
  readonly maximumSelection: number | null;
  readonly allowRepeatedOption: boolean;
  readonly perOptionMaximumQuantity: number;
  readonly maximumTotalQuantity: number | null;
  readonly options: readonly CatalogOption[];
  readonly createdAt: CatalogInstant;
  readonly updatedAt: CatalogInstant;
}

export interface OptionSetAggregate {
  readonly optionSetReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly lifecycle: OptionSetLifecycle;
  readonly aggregateVersion: number;
  readonly draft: OptionSetDraft;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
  readonly updatedAt: CatalogInstant;
}

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
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function optionalNonnegative(value: unknown): number | null {
  return value === null ? null : nonnegative(value);
}
function descriptions(value: unknown): Readonly<Record<string, string>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const result: Record<string, string> = {};
  for (const [locale, candidate] of Object.entries(value)) {
    parseCatalogLocale(locale);
    if (
      typeof candidate !== "string" ||
      candidate.trim().length < 1 ||
      candidate.trim().length > 500 ||
      /[<>{}]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(candidate)
    )
      return invalid();
    result[locale] = candidate.trim().replace(/\s+/gu, " ");
  }
  return Object.freeze(result);
}
function references(value: unknown): readonly CatalogReference[] {
  if (!Array.isArray(value)) return invalid();
  const result = Object.freeze(value.map(parseCatalogReference));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}

export function parseCatalogOption(value: unknown): CatalogOption {
  const raw = exact(value, [
    "optionReference",
    "optionSetReference",
    "brandReference",
    "stableCode",
    "lifecycle",
    "localizedNames",
    "localizedDescriptions",
    "sortOrder",
    "defaultEligible",
    "triggeredOptionSetReference",
    "conflictOptionReferences",
    "createdAt",
    "createdByActorReference",
  ]);
  if (
    !["Draft", "Active", "Inactive", "Archived"].includes(String(raw.lifecycle)) ||
    typeof raw.defaultEligible !== "boolean"
  )
    return invalid();
  const locale = Object.keys(raw.localizedNames as object)[0];
  if (locale === undefined) return invalid();
  const optionReference = parseCatalogReference(raw.optionReference);
  const conflicts = references(raw.conflictOptionReferences);
  if (conflicts.includes(optionReference)) return invalid();
  return Object.freeze({
    optionReference,
    optionSetReference: parseCatalogReference(raw.optionSetReference),
    brandReference: parseCatalogReference(raw.brandReference),
    stableCode: parseCatalogCode(raw.stableCode),
    lifecycle: raw.lifecycle as OptionLifecycle,
    localizedNames: parseLocalizedNames(raw.localizedNames, locale),
    localizedDescriptions: descriptions(raw.localizedDescriptions),
    sortOrder: nonnegative(raw.sortOrder),
    defaultEligible: raw.defaultEligible,
    triggeredOptionSetReference:
      raw.triggeredOptionSetReference === null
        ? null
        : parseCatalogReference(raw.triggeredOptionSetReference),
    conflictOptionReferences: conflicts,
    createdAt: parseCatalogInstant(raw.createdAt),
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
  });
}

export function parseOptionSetDraft(value: unknown): OptionSetDraft {
  const raw = exact(value, [
    "versionReference",
    "status",
    "defaultLocale",
    "localizedNames",
    "localizedDescriptions",
    "displayStyle",
    "minimumSelection",
    "maximumSelection",
    "allowRepeatedOption",
    "perOptionMaximumQuantity",
    "maximumTotalQuantity",
    "options",
    "createdAt",
    "updatedAt",
  ]);
  if (
    raw.status !== "Draft" ||
    !["SingleChoice", "MultiChoice", "Quantity"].includes(String(raw.displayStyle)) ||
    typeof raw.allowRepeatedOption !== "boolean" ||
    !Array.isArray(raw.options)
  )
    return invalid();
  const minimumSelection = nonnegative(raw.minimumSelection);
  const maximumSelection = optionalNonnegative(raw.maximumSelection);
  const perOptionMaximumQuantity = positive(raw.perOptionMaximumQuantity);
  const maximumTotalQuantity = optionalNonnegative(raw.maximumTotalQuantity);
  if (
    (maximumSelection !== null && maximumSelection < minimumSelection) ||
    (maximumTotalQuantity !== null && maximumTotalQuantity < minimumSelection) ||
    (maximumTotalQuantity !== null && perOptionMaximumQuantity > maximumTotalQuantity) ||
    (!raw.allowRepeatedOption && perOptionMaximumQuantity !== 1)
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  const options = Object.freeze(raw.options.map(parseCatalogOption));
  const optionReferences = new Set(options.map((option) => option.optionReference));
  if (
    new Set(options.map((option) => option.stableCode)).size !== options.length ||
    new Set(options.map((option) => option.sortOrder)).size !== options.length ||
    options.some(
      (option) =>
        !Object.hasOwn(option.localizedNames, defaultLocale) ||
        option.conflictOptionReferences.some((reference) => !optionReferences.has(reference)),
    ) ||
    minimumSelection >
      options.filter((option) => option.lifecycle !== "Archived").length * perOptionMaximumQuantity
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
    versionReference: parseCatalogReference(raw.versionReference),
    status: "Draft",
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    localizedDescriptions: descriptions(raw.localizedDescriptions),
    displayStyle: raw.displayStyle as OptionSetDisplayStyle,
    minimumSelection,
    maximumSelection,
    allowRepeatedOption: raw.allowRepeatedOption,
    perOptionMaximumQuantity,
    maximumTotalQuantity,
    options,
    createdAt,
    updatedAt,
  });
}

export function parseOptionSetAggregate(value: unknown): OptionSetAggregate {
  const raw = exact(value, [
    "optionSetReference",
    "brandReference",
    "internalCode",
    "lifecycle",
    "aggregateVersion",
    "draft",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  if (raw.lifecycle !== "Draft" && raw.lifecycle !== "Archived") return invalid();
  const optionSetReference = parseCatalogReference(raw.optionSetReference);
  const brandReference = parseCatalogReference(raw.brandReference);
  const draft = parseOptionSetDraft(raw.draft);
  if (
    draft.options.some(
      (option) =>
        option.optionSetReference !== optionSetReference ||
        option.brandReference !== brandReference ||
        option.triggeredOptionSetReference === optionSetReference,
    )
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
    optionSetReference,
    brandReference,
    internalCode: parseCatalogCode(raw.internalCode),
    lifecycle: raw.lifecycle,
    aggregateVersion: positive(raw.aggregateVersion),
    draft,
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}

export function validateProductOptionBinding(
  binding: ProductOptionBinding,
  optionSet: OptionSetAggregate,
): void {
  if (
    binding.optionSetReference !== optionSet.optionSetReference ||
    binding.optionSetVersionReference !== optionSet.draft.versionReference ||
    binding.enabledOptionReferences.some(
      (reference) =>
        !optionSet.draft.options.some(
          (option) => option.optionReference === reference && option.lifecycle !== "Archived",
        ),
    )
  )
    return invalid();
  const minimum = binding.minimumSelectionOverride ?? optionSet.draft.minimumSelection;
  const maximum = binding.maximumSelectionOverride ?? optionSet.draft.maximumSelection;
  if (
    minimum < optionSet.draft.minimumSelection ||
    (optionSet.draft.maximumSelection !== null &&
      (maximum === null || maximum > optionSet.draft.maximumSelection)) ||
    (maximum !== null && maximum < minimum)
  )
    return invalid();
  const selected = binding.defaultSelections.reduce((sum, item) => sum + item.quantity, 0);
  const enabledCapacity =
    binding.enabledOptionReferences.length * optionSet.draft.perOptionMaximumQuantity;
  if (
    enabledCapacity < minimum ||
    selected < minimum ||
    (maximum !== null && selected > maximum) ||
    (optionSet.draft.maximumTotalQuantity !== null &&
      selected > optionSet.draft.maximumTotalQuantity) ||
    binding.defaultSelections.some(
      (item) => item.quantity > optionSet.draft.perOptionMaximumQuantity,
    )
  )
    return invalid();
  const selectedReferences = new Set(binding.defaultSelections.map((item) => item.optionReference));
  for (const item of binding.defaultSelections) {
    const option = optionSet.draft.options.find(
      (candidate) => candidate.optionReference === item.optionReference,
    );
    if (
      option === undefined ||
      !option.defaultEligible ||
      option.conflictOptionReferences.some((reference) => selectedReferences.has(reference))
    )
      return invalid();
  }
}

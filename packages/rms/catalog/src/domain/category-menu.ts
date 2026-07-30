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
} from "./product.js";

export type CategoryLifecycle = "Draft" | "Active" | "Inactive" | "Archived";
export type PresentationRole = "Standard" | "Featured" | "Promotional" | "Sponsored" | "Hidden";

export interface CategoryAggregate {
  readonly categoryReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly lifecycle: CategoryLifecycle;
  readonly aggregateVersion: number;
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly localizedDescriptions: Readonly<Record<string, string>>;
  readonly parentCategoryReference: CatalogReference | null;
  readonly level: 1 | 2 | 3;
  readonly sortOrder: number;
  readonly storeReferences: readonly CatalogReference[];
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
  readonly updatedAt: CatalogInstant;
}

export interface SellablePlacement {
  readonly placementReference: CatalogReference;
  readonly menuReference: CatalogReference;
  readonly sectionReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly sellableType: "Sku";
  readonly presentationRole: PresentationRole;
  readonly sortOrder: number;
  readonly pinned: boolean;
  readonly localizedNameOverrides: Readonly<Record<string, string>>;
  readonly createdAt: CatalogInstant;
  readonly createdByActorReference: CatalogReference;
}

export interface MenuSection {
  readonly sectionReference: CatalogReference;
  readonly menuReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly sortOrder: number;
  readonly categoryReferences: readonly CatalogReference[];
  readonly placements: readonly SellablePlacement[];
}

export interface MenuDraft {
  readonly versionReference: CatalogReference;
  readonly status: "Draft";
  readonly baseMenuReference: CatalogReference | null;
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly storeReferences: readonly CatalogReference[];
  readonly channelCodes: readonly CatalogCode[];
  readonly orderTypeCodes: readonly CatalogCode[];
  readonly sections: readonly MenuSection[];
  readonly createdAt: CatalogInstant;
  readonly updatedAt: CatalogInstant;
}

export interface MenuAggregate {
  readonly menuReference: CatalogReference;
  readonly brandReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly aggregateVersion: number;
  readonly draft: MenuDraft;
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

function references(value: unknown): readonly CatalogReference[] {
  if (!Array.isArray(value)) return invalid();
  const parsed = Object.freeze(value.map(parseCatalogReference));
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}

function codes(value: unknown): readonly CatalogCode[] {
  if (!Array.isArray(value)) return invalid();
  const parsed = Object.freeze(value.map(parseCatalogCode));
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}

function plainRecord(
  value: unknown,
  defaultLocale: string,
  maximum: number,
  allowEmpty: boolean,
): Readonly<Record<string, string>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const entries = Object.entries(value);
  if (!allowEmpty && !Object.hasOwn(value, defaultLocale)) return invalid();
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    parseCatalogLocale(key);
    if (
      typeof raw !== "string" ||
      raw.trim().length < 1 ||
      raw.trim().length > maximum ||
      /[<>{}]|\[|\]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(raw)
    )
      return invalid();
    result[key] = raw.trim().replace(/\s+/gu, " ");
  }
  return Object.freeze(result);
}

function categoryLifecycle(value: unknown): CategoryLifecycle {
  if (value !== "Draft" && value !== "Active" && value !== "Inactive" && value !== "Archived")
    return invalid();
  return value;
}

export function parseCategoryAggregate(value: unknown): CategoryAggregate {
  const raw = exact(value, [
    "categoryReference",
    "brandReference",
    "internalCode",
    "lifecycle",
    "aggregateVersion",
    "defaultLocale",
    "localizedNames",
    "localizedDescriptions",
    "parentCategoryReference",
    "level",
    "sortOrder",
    "storeReferences",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  const level = positive(raw.level);
  if (level > 3) return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  const categoryReference = parseCatalogReference(raw.categoryReference);
  const parentCategoryReference =
    raw.parentCategoryReference === null
      ? null
      : parseCatalogReference(raw.parentCategoryReference);
  if (parentCategoryReference === categoryReference) return invalid();
  return Object.freeze({
    categoryReference,
    brandReference: parseCatalogReference(raw.brandReference),
    internalCode: parseCatalogCode(raw.internalCode),
    lifecycle: categoryLifecycle(raw.lifecycle),
    aggregateVersion: positive(raw.aggregateVersion),
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    localizedDescriptions: plainRecord(raw.localizedDescriptions, defaultLocale, 500, true),
    parentCategoryReference,
    level: level as 1 | 2 | 3,
    sortOrder: nonnegative(raw.sortOrder),
    storeReferences: references(raw.storeReferences),
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}

export function transitionCategoryLifecycle(
  current: CategoryLifecycle,
  target: CategoryLifecycle,
): CategoryLifecycle {
  const allowed: Readonly<Record<CategoryLifecycle, readonly CategoryLifecycle[]>> = {
    Draft: ["Active", "Archived"],
    Active: ["Inactive"],
    Inactive: ["Active", "Archived"],
    Archived: ["Draft"],
  };
  if (!allowed[current].includes(target)) throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return target;
}

function role(value: unknown): PresentationRole {
  if (
    value !== "Standard" &&
    value !== "Featured" &&
    value !== "Promotional" &&
    value !== "Sponsored" &&
    value !== "Hidden"
  )
    return invalid();
  return value;
}

export function parseSellablePlacement(value: unknown): SellablePlacement {
  const raw = exact(value, [
    "placementReference",
    "menuReference",
    "sectionReference",
    "brandReference",
    "sellableReference",
    "sellableType",
    "presentationRole",
    "sortOrder",
    "pinned",
    "localizedNameOverrides",
    "createdAt",
    "createdByActorReference",
  ]);
  if (raw.sellableType !== "Sku" || typeof raw.pinned !== "boolean") return invalid();
  return Object.freeze({
    placementReference: parseCatalogReference(raw.placementReference),
    menuReference: parseCatalogReference(raw.menuReference),
    sectionReference: parseCatalogReference(raw.sectionReference),
    brandReference: parseCatalogReference(raw.brandReference),
    sellableReference: parseCatalogReference(raw.sellableReference),
    sellableType: "Sku",
    presentationRole: role(raw.presentationRole),
    sortOrder: nonnegative(raw.sortOrder),
    pinned: raw.pinned,
    localizedNameOverrides: plainRecord(raw.localizedNameOverrides, "en", 120, true),
    createdAt: parseCatalogInstant(raw.createdAt),
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
  });
}

export function parseMenuSection(value: unknown): MenuSection {
  const raw = exact(value, [
    "sectionReference",
    "menuReference",
    "brandReference",
    "internalCode",
    "localizedNames",
    "sortOrder",
    "categoryReferences",
    "placements",
  ]);
  if (!Array.isArray(raw.placements)) return invalid();
  const placements = Object.freeze(raw.placements.map(parseSellablePlacement));
  const sectionReference = parseCatalogReference(raw.sectionReference);
  const menuReference = parseCatalogReference(raw.menuReference);
  const brandReference = parseCatalogReference(raw.brandReference);
  if (
    placements.some(
      (placement) =>
        placement.sectionReference !== sectionReference ||
        placement.menuReference !== menuReference ||
        placement.brandReference !== brandReference,
    ) ||
    new Set(placements.map((placement) => placement.placementReference)).size !==
      placements.length ||
    new Set(placements.map((placement) => placement.sortOrder)).size !== placements.length ||
    new Set(
      placements.map((placement) => `${placement.sellableReference}:${placement.presentationRole}`),
    ).size !== placements.length
  )
    return invalid();
  const localeKey = Object.keys(raw.localizedNames as object)[0];
  if (localeKey === undefined) return invalid();
  return Object.freeze({
    sectionReference,
    menuReference,
    brandReference,
    internalCode: parseCatalogCode(raw.internalCode),
    localizedNames: parseLocalizedNames(raw.localizedNames, localeKey),
    sortOrder: nonnegative(raw.sortOrder),
    categoryReferences: references(raw.categoryReferences),
    placements,
  });
}

export function parseMenuDraft(value: unknown): MenuDraft {
  const raw = exact(value, [
    "versionReference",
    "status",
    "baseMenuReference",
    "defaultLocale",
    "localizedNames",
    "storeReferences",
    "channelCodes",
    "orderTypeCodes",
    "sections",
    "createdAt",
    "updatedAt",
  ]);
  if (raw.status !== "Draft" || !Array.isArray(raw.sections)) return invalid();
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  const sections = Object.freeze(raw.sections.map(parseMenuSection));
  if (
    new Set(sections.map((section) => section.sectionReference)).size !== sections.length ||
    new Set(sections.map((section) => section.internalCode)).size !== sections.length ||
    new Set(sections.map((section) => section.sortOrder)).size !== sections.length ||
    sections.some((section) => !Object.hasOwn(section.localizedNames, defaultLocale))
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
    versionReference: parseCatalogReference(raw.versionReference),
    status: "Draft",
    baseMenuReference:
      raw.baseMenuReference === null ? null : parseCatalogReference(raw.baseMenuReference),
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    storeReferences: references(raw.storeReferences),
    channelCodes: codes(raw.channelCodes),
    orderTypeCodes: codes(raw.orderTypeCodes),
    sections,
    createdAt,
    updatedAt,
  });
}

export function parseMenuAggregate(value: unknown): MenuAggregate {
  const raw = exact(value, [
    "menuReference",
    "brandReference",
    "internalCode",
    "aggregateVersion",
    "draft",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
  ]);
  const menuReference = parseCatalogReference(raw.menuReference);
  const brandReference = parseCatalogReference(raw.brandReference);
  const draft = parseMenuDraft(raw.draft);
  if (
    draft.baseMenuReference === menuReference ||
    draft.sections.some(
      (section) =>
        section.menuReference !== menuReference || section.brandReference !== brandReference,
    )
  )
    return invalid();
  const createdAt = parseCatalogInstant(raw.createdAt);
  const updatedAt = parseCatalogInstant(raw.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  return Object.freeze({
    menuReference,
    brandReference,
    internalCode: parseCatalogCode(raw.internalCode),
    aggregateVersion: positive(raw.aggregateVersion),
    draft,
    createdAt,
    createdByActorReference: parseCatalogReference(raw.createdByActorReference),
    updatedAt,
  });
}

export function validateCategoryMove(input: {
  readonly category: CategoryAggregate;
  readonly parent: CategoryAggregate | null;
  readonly ancestorReferences: readonly CatalogReference[];
  readonly subtreeDepth: number;
}): 1 | 2 | 3 {
  const level = input.parent === null ? 1 : input.parent.level + 1;
  if (
    (input.parent !== null && input.parent.brandReference !== input.category.brandReference) ||
    input.ancestorReferences.includes(input.category.categoryReference) ||
    !Number.isSafeInteger(input.subtreeDepth) ||
    input.subtreeDepth < 1 ||
    level + input.subtreeDepth - 1 > 3
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return level as 1 | 2 | 3;
}

export function validateMenuBase(
  menu: MenuAggregate,
  base: MenuAggregate | null,
  menuIsBase: boolean,
): void {
  if (menu.draft.baseMenuReference === null) return;
  if (
    base === null ||
    base.menuReference !== menu.draft.baseMenuReference ||
    base.brandReference !== menu.brandReference ||
    base.draft.baseMenuReference !== null ||
    menuIsBase
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
}

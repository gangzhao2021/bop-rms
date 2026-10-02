import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
} from "./product.js";
import { parseMenuCategoryBindings, type MenuCategoryBinding } from "./menu-category-bindings.js";
import { parsePublishingDigest } from "@bop/publishing";
import type { PublishingDigest } from "@bop/publishing";
import type { CatalogCode, CatalogInstant, CatalogReference } from "./product.js";
import {
  parseSellableAllergenDisclosure,
  type SellableAllergenDisclosure,
} from "./allergen-provenance.js";

export interface PublishedOptionRule {
  readonly semanticsVersion?: 2;
  readonly activationOptionReferences?: readonly CatalogReference[];
  readonly channelCodes?: readonly CatalogCode[];
  readonly bindingReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly enabledOptionReferences: readonly CatalogReference[];
  readonly defaultOptionReferences: readonly CatalogReference[];
  readonly options: readonly {
    readonly optionReference: CatalogReference;
    readonly localizedNames: Readonly<Record<string, string>>;
    readonly maximumQuantity: number;
    readonly conflictOptionReferences: readonly CatalogReference[];
    readonly selectedByDefault: boolean;
    readonly defaultQuantity?: number;
  }[];
}
export interface PublishedSellableSnapshot {
  readonly placementReference: CatalogReference;
  readonly sellableReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly presentationRole: "Standard" | "Featured" | "Promotional" | "Sponsored" | "Hidden";
  readonly sortOrder: number;
  readonly pinned: boolean;
  readonly configuredAvailability: "Available" | "Unavailable";
  readonly optionRules: readonly PublishedOptionRule[];
  readonly allergenDisclosure: SellableAllergenDisclosure;
}
export interface PublishedMenuSectionSnapshot {
  readonly sectionReference: CatalogReference;
  readonly internalCode: CatalogCode;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly sortOrder: number;
  readonly sellables: readonly PublishedSellableSnapshot[];
}
export interface PublishedMenuSnapshot {
  readonly brandReference: CatalogReference;
  readonly menuReference: CatalogReference;
  readonly menuVersionReference: CatalogReference;
  readonly releaseReference: CatalogReference;
  readonly snapshotDigest: PublishingDigest;
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly storeReferences: readonly CatalogReference[];
  readonly channelCodes: readonly CatalogCode[];
  readonly orderTypeCodes: readonly CatalogCode[];
  readonly timeZone: string;
  readonly effectiveFrom: CatalogInstant;
  readonly effectiveUntil: CatalogInstant | null;
  readonly sections: readonly PublishedMenuSectionSnapshot[];
}
export interface PublishedMenuProjection {
  readonly projectionName: "catalog_published_menu_v1";
  readonly projectionVersion: 1;
  readonly generationReference: CatalogReference;
  readonly sourceEventReference: CatalogReference;
  readonly sourceAggregateVersion: number;
  readonly sourceCheckpoint: CatalogReference;
  readonly lastRebuiltAt: CatalogInstant;
  readonly freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed";
  readonly snapshot: PublishedMenuSnapshot;
}
export interface MenuPublishedFact {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly producerModule: string;
  readonly tenantId: string;
  readonly storeId?: string;
  readonly aggregateId: string;
  readonly aggregateVersion: bigint;
  readonly payload: {
    readonly menuReference: string;
    readonly menuVersionReference: string;
    readonly releaseReference: string;
    readonly snapshotDigest: string;
    readonly effectiveFrom: string;
    readonly effectiveUntil: string | null;
    readonly timeZone: string;
  };
}

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function references(value: unknown) {
  if (!Array.isArray(value)) invalid();
  const parsed = Object.freeze(value.map(parseCatalogReference));
  if (new Set(parsed).size !== parsed.length) invalid();
  return parsed;
}
function codes(value: unknown) {
  if (!Array.isArray(value)) invalid();
  const parsed = Object.freeze(value.map(parseCatalogCode));
  if (new Set(parsed).size !== parsed.length) invalid();
  return parsed;
}
function optionRule(value: PublishedOptionRule, defaultLocale: string): PublishedOptionRule {
  const quantity = value.semanticsVersion === 2;
  if (value.semanticsVersion !== undefined && !quantity) invalid();
  if (
    !quantity &&
    (value.activationOptionReferences !== undefined || value.channelCodes !== undefined)
  )
    invalid();
  const activation = quantity ? references(value.activationOptionReferences) : [];
  const channels = quantity ? codes(value.channelCodes) : [];
  if (quantity && channels.length === 0) invalid();
  const minimumSelections = nonnegative(value.minimumSelections);
  const maximumSelections = nonnegative(value.maximumSelections);
  const enabledOptionReferences = references(value.enabledOptionReferences);
  const defaultOptionReferences = references(value.defaultOptionReferences);
  if (!Array.isArray(value.options)) invalid();
  const options = Object.freeze(
    value.options.map((option) => {
      const optionReference = parseCatalogReference(option.optionReference);
      const conflictOptionReferences = references(option.conflictOptionReferences);
      const defaultQuantity = quantity
        ? nonnegative(option.defaultQuantity)
        : option.selectedByDefault
          ? 1
          : 0;
      if (
        (!quantity && option.defaultQuantity !== undefined) ||
        defaultQuantity > option.maximumQuantity ||
        option.selectedByDefault !== defaultQuantity > 0
      )
        invalid();
      if (
        !Number.isSafeInteger(option.maximumQuantity) ||
        option.maximumQuantity < 1 ||
        option.maximumQuantity > 999 ||
        typeof option.selectedByDefault !== "boolean" ||
        conflictOptionReferences.includes(optionReference)
      )
        invalid();
      return Object.freeze({
        optionReference,
        localizedNames: parseLocalizedNames(option.localizedNames, defaultLocale),
        maximumQuantity: option.maximumQuantity,
        conflictOptionReferences,
        selectedByDefault: option.selectedByDefault,
        ...(quantity ? { defaultQuantity } : {}),
      });
    }),
  );
  if (
    minimumSelections > maximumSelections ||
    maximumSelections >
      (quantity
        ? options.reduce((sum, option) => sum + option.maximumQuantity, 0)
        : enabledOptionReferences.length) ||
    (quantity &&
      (maximumSelections > 99900 ||
        options.reduce((sum, option) => sum + (option.defaultQuantity ?? 0), 0) <
          minimumSelections ||
        options.reduce((sum, option) => sum + (option.defaultQuantity ?? 0), 0) >
          maximumSelections)) ||
    defaultOptionReferences.some((reference) => !enabledOptionReferences.includes(reference)) ||
    options.length !== enabledOptionReferences.length ||
    options.some(
      (option, index) =>
        option.optionReference !== enabledOptionReferences[index] ||
        option.selectedByDefault !== defaultOptionReferences.includes(option.optionReference) ||
        (!quantity &&
          option.conflictOptionReferences.some(
            (reference) => !enabledOptionReferences.includes(reference),
          )),
    )
  )
    invalid();
  return Object.freeze({
    ...(quantity
      ? {
          semanticsVersion: 2 as const,
          activationOptionReferences: activation,
          channelCodes: channels,
        }
      : {}),
    bindingReference: parseCatalogReference(value.bindingReference),
    optionSetVersionReference: parseCatalogReference(value.optionSetVersionReference),
    minimumSelections,
    maximumSelections,
    enabledOptionReferences,
    defaultOptionReferences,
    options,
  });
}
function sellable(value: PublishedSellableSnapshot, defaultLocale: string) {
  if (
    !["Standard", "Featured", "Promotional", "Sponsored", "Hidden"].includes(
      value.presentationRole,
    ) ||
    typeof value.pinned !== "boolean" ||
    (value.configuredAvailability !== "Available" &&
      value.configuredAvailability !== "Unavailable") ||
    !Array.isArray(value.optionRules)
  )
    invalid();
  return Object.freeze({
    placementReference: parseCatalogReference(value.placementReference),
    sellableReference: parseCatalogReference(value.sellableReference),
    productVersionReference: parseCatalogReference(value.productVersionReference),
    localizedNames: parseLocalizedNames(value.localizedNames, defaultLocale),
    presentationRole: value.presentationRole,
    sortOrder: nonnegative(value.sortOrder),
    pinned: value.pinned,
    configuredAvailability: value.configuredAvailability,
    optionRules: Object.freeze(value.optionRules.map((rule) => optionRule(rule, defaultLocale))),
    allergenDisclosure: parseSellableAllergenDisclosure(value.allergenDisclosure, defaultLocale),
  });
}

function validateChannelRules(
  rules: readonly PublishedOptionRule[],
  menuChannels: readonly CatalogCode[],
): void {
  const rich = rules.filter((rule) => rule.semanticsVersion === 2);
  if (!rich.length) return;
  if (
    rich.some((rule) =>
      rule.channelCodes?.some(
        (channel) => menuChannels.length > 0 && !menuChannels.includes(channel),
      ),
    )
  )
    invalid();
  const channels = menuChannels.length
    ? menuChannels
    : [...new Set(rich.flatMap((rule) => rule.channelCodes ?? []))];
  for (const channel of channels) {
    const selected = rules.filter(
      (rule) => rule.semanticsVersion !== 2 || rule.channelCodes?.includes(channel),
    );
    const owner = new Map<string, number>();
    selected.forEach((rule, index) =>
      rule.options.forEach((option) => {
        if (owner.has(option.optionReference)) invalid();
        owner.set(option.optionReference, index);
      }),
    );
    const edges = selected.map((rule, index) => {
      const parents = (rule.activationOptionReferences ?? []).map((reference) => {
        const parent = owner.get(reference);
        if (parent === undefined || parent === index) return invalid();
        return parent;
      });
      if (
        rule.options.some((option) =>
          option.conflictOptionReferences.some((reference) => !owner.has(reference)),
        )
      )
        invalid();
      return parents;
    });
    const visiting = new Set<number>(),
      visited = new Set<number>();
    const visit = (index: number): void => {
      if (visiting.has(index)) invalid();
      if (visited.has(index)) return;
      visiting.add(index);
      for (const parent of edges[index] ?? []) visit(parent);
      visiting.delete(index);
      visited.add(index);
    };
    selected.forEach((_rule, index) => visit(index));
  }
}

export type ReviewedMenuContent = Omit<
  PublishedMenuSnapshot,
  "releaseReference" | "snapshotDigest" | "timeZone" | "effectiveFrom" | "effectiveUntil"
> & { readonly categoryBindings?: readonly MenuCategoryBinding[] };

export function parseReviewedMenuContent(value: ReviewedMenuContent): ReviewedMenuContent {
  const defaultLocale = parseCatalogLocale(value.defaultLocale);
  if (!Array.isArray(value.sections)) invalid();
  const menuReference = parseCatalogReference(value.menuReference);
  const sections = Object.freeze(
    value.sections.map((section: PublishedMenuSectionSnapshot) => ({
      sectionReference: parseCatalogReference(section.sectionReference),
      internalCode: parseCatalogCode(section.internalCode),
      localizedNames: parseLocalizedNames(section.localizedNames, defaultLocale),
      sortOrder: nonnegative(section.sortOrder),
      sellables: Object.freeze(
        section.sellables.map((item: PublishedSellableSnapshot) => sellable(item, defaultLocale)),
      ),
    })),
  );
  if (
    new Set(sections.map((section) => section.sectionReference)).size !== sections.length ||
    new Set(sections.map((section) => section.sortOrder)).size !== sections.length ||
    sections.some(
      (section) =>
        new Set(section.sellables.map((item) => item.placementReference)).size !==
          section.sellables.length ||
        new Set(section.sellables.map((item) => item.sortOrder)).size !== section.sellables.length,
    )
  )
    invalid();
  const channelCodes = codes(value.channelCodes);
  for (const section of sections)
    for (const item of section.sellables) validateChannelRules(item.optionRules, channelCodes);
  return Object.freeze({
    brandReference: parseCatalogReference(value.brandReference),
    menuReference,
    menuVersionReference: parseCatalogReference(value.menuVersionReference),
    defaultLocale,
    localizedNames: parseLocalizedNames(value.localizedNames, defaultLocale),
    storeReferences: references(value.storeReferences),
    channelCodes,
    orderTypeCodes: codes(value.orderTypeCodes),
    sections,
    ...(Object.hasOwn(value, "categoryBindings")
      ? {
          categoryBindings: parseMenuCategoryBindings(
            Object.getOwnPropertyDescriptor(value, "categoryBindings")?.value,
            sections.map((section) => section.sectionReference),
          ),
        }
      : {}),
  });
}

export function parsePublishedMenuSnapshot(value: PublishedMenuSnapshot): PublishedMenuSnapshot {
  const content = parseReviewedMenuContent(value);
  const effectiveFrom = parseCatalogInstant(value.effectiveFrom);
  const effectiveUntil =
    value.effectiveUntil === null ? null : parseCatalogInstant(value.effectiveUntil);
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) invalid();
  if (typeof value.timeZone !== "string") invalid();
  return Object.freeze({
    // Category bindings are internal review evidence, not Customer display fields.
    brandReference: content.brandReference,
    menuReference: content.menuReference,
    menuVersionReference: content.menuVersionReference,
    defaultLocale: content.defaultLocale,
    localizedNames: content.localizedNames,
    storeReferences: content.storeReferences,
    channelCodes: content.channelCodes,
    orderTypeCodes: content.orderTypeCodes,
    sections: content.sections,
    releaseReference: parseCatalogReference(value.releaseReference),
    snapshotDigest: parsePublishingDigest(value.snapshotDigest),
    timeZone: value.timeZone,
    effectiveFrom,
    effectiveUntil,
  });
}

export function parsePublishedMenuProjection(
  value: PublishedMenuProjection,
): PublishedMenuProjection {
  const snapshot = parsePublishedMenuSnapshot(value.snapshot);
  if (
    value.projectionName !== "catalog_published_menu_v1" ||
    value.projectionVersion !== 1 ||
    !Number.isSafeInteger(value.sourceAggregateVersion) ||
    value.sourceAggregateVersion < 1 ||
    !["Fresh", "Stale", "Rebuilding", "Failed"].includes(value.freshnessStatus)
  )
    invalid();
  return Object.freeze({
    projectionName: value.projectionName,
    projectionVersion: value.projectionVersion,
    generationReference: parseCatalogReference(value.generationReference),
    sourceEventReference: parseCatalogReference(value.sourceEventReference),
    sourceAggregateVersion: value.sourceAggregateVersion,
    sourceCheckpoint: parseCatalogReference(value.sourceCheckpoint),
    lastRebuiltAt: parseCatalogInstant(value.lastRebuiltAt),
    freshnessStatus: value.freshnessStatus,
    snapshot,
  });
}

export function buildPublishedMenuProjection(input: {
  readonly envelope: MenuPublishedFact;
  readonly snapshot: PublishedMenuSnapshot;
  readonly generationReference: string;
  readonly projectedAt: string;
}): PublishedMenuProjection {
  const snapshot = parsePublishedMenuSnapshot(input.snapshot);
  const payload = input.envelope.payload;
  if (
    input.envelope.eventType !== "MenuPublished" ||
    input.envelope.schemaVersion !== 1 ||
    input.envelope.producerModule !== "@rms/catalog" ||
    input.envelope.storeId !== undefined ||
    input.envelope.tenantId !== snapshot.brandReference ||
    input.envelope.aggregateId !== snapshot.menuReference ||
    payload.menuReference !== snapshot.menuReference ||
    payload.menuVersionReference !== snapshot.menuVersionReference ||
    payload.releaseReference !== snapshot.releaseReference ||
    payload.snapshotDigest !== snapshot.snapshotDigest ||
    payload.effectiveFrom !== snapshot.effectiveFrom ||
    payload.effectiveUntil !== snapshot.effectiveUntil ||
    payload.timeZone !== snapshot.timeZone ||
    input.envelope.aggregateVersion > BigInt(Number.MAX_SAFE_INTEGER)
  )
    invalid();
  return Object.freeze({
    projectionName: "catalog_published_menu_v1",
    projectionVersion: 1,
    generationReference: parseCatalogReference(input.generationReference),
    sourceEventReference: parseCatalogReference(input.envelope.eventId),
    sourceAggregateVersion: Number(input.envelope.aggregateVersion),
    sourceCheckpoint: parseCatalogReference(input.envelope.eventId),
    lastRebuiltAt: parseCatalogInstant(input.projectedAt),
    freshnessStatus: "Fresh",
    snapshot,
  });
}

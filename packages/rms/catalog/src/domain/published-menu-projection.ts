import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
} from "./product.js";
import { parsePublishingDigest } from "@bop/publishing";
import type { PublishingDigest } from "@bop/publishing";
import type { CatalogCode, CatalogInstant, CatalogReference } from "./product.js";

export interface PublishedOptionRule {
  readonly bindingReference: CatalogReference;
  readonly optionSetVersionReference: CatalogReference;
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly enabledOptionReferences: readonly CatalogReference[];
  readonly defaultOptionReferences: readonly CatalogReference[];
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
function optionRule(value: PublishedOptionRule): PublishedOptionRule {
  const minimumSelections = nonnegative(value.minimumSelections);
  const maximumSelections = nonnegative(value.maximumSelections);
  const enabledOptionReferences = references(value.enabledOptionReferences);
  const defaultOptionReferences = references(value.defaultOptionReferences);
  if (
    minimumSelections > maximumSelections ||
    maximumSelections > enabledOptionReferences.length ||
    defaultOptionReferences.some((reference) => !enabledOptionReferences.includes(reference))
  )
    invalid();
  return Object.freeze({
    bindingReference: parseCatalogReference(value.bindingReference),
    optionSetVersionReference: parseCatalogReference(value.optionSetVersionReference),
    minimumSelections,
    maximumSelections,
    enabledOptionReferences,
    defaultOptionReferences,
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
    optionRules: Object.freeze(value.optionRules.map(optionRule)),
  });
}

export function parsePublishedMenuSnapshot(value: PublishedMenuSnapshot): PublishedMenuSnapshot {
  const defaultLocale = parseCatalogLocale(value.defaultLocale);
  const effectiveFrom = parseCatalogInstant(value.effectiveFrom);
  const effectiveUntil =
    value.effectiveUntil === null ? null : parseCatalogInstant(value.effectiveUntil);
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) invalid();
  if (!Array.isArray(value.sections) || typeof value.timeZone !== "string") invalid();
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
  return Object.freeze({
    brandReference: parseCatalogReference(value.brandReference),
    menuReference,
    menuVersionReference: parseCatalogReference(value.menuVersionReference),
    releaseReference: parseCatalogReference(value.releaseReference),
    snapshotDigest: parsePublishingDigest(value.snapshotDigest),
    defaultLocale,
    localizedNames: parseLocalizedNames(value.localizedNames, defaultLocale),
    storeReferences: references(value.storeReferences),
    channelCodes: codes(value.channelCodes),
    orderTypeCodes: codes(value.orderTypeCodes),
    timeZone: value.timeZone,
    effectiveFrom,
    effectiveUntil,
    sections,
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

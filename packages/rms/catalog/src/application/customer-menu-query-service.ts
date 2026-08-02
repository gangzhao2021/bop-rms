import {
  customerMenuFreshnessTargetMilliseconds,
  type CustomerMenuFound,
  type CustomerMenuQueryInput,
  type CustomerMenuSellableDto,
} from "../contracts/customer-menu-query.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  type CatalogInstant,
  type CatalogReference,
} from "../domain/product.js";
import {
  parsePublishedMenuProjection,
  type PublishedMenuProjection,
} from "../domain/published-menu-projection.js";
import type { CustomerMenuQueryPorts } from "./ports/customer-menu-query-ports.js";

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    return invalid();
  return value as Readonly<Record<string, unknown>>;
}

function parseSearchTerm(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return invalid();
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 100) return invalid();
  return normalized;
}

function parseInput(value: unknown): CustomerMenuQueryInput {
  const input = exact(value, [
    "publicStoreReference",
    "channelCode",
    "orderTypeCode",
    "locale",
    "requestedAt",
    "searchTerm",
    "sectionReference",
  ]);
  return Object.freeze({
    publicStoreReference: parseCatalogReference(input.publicStoreReference),
    channelCode: parseCatalogCode(input.channelCode),
    orderTypeCode: parseCatalogCode(input.orderTypeCode),
    locale: parseCatalogLocale(input.locale),
    requestedAt: parseCatalogInstant(input.requestedAt),
    searchTerm: parseSearchTerm(input.searchTerm),
    sectionReference:
      input.sectionReference === null ? null : parseCatalogReference(input.sectionReference),
  });
}

function dependencyFailure(): never {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}

function effectiveAt(projection: PublishedMenuProjection, at: CatalogInstant): boolean {
  const requested = Date.parse(at);
  const from = Date.parse(projection.snapshot.effectiveFrom);
  const until =
    projection.snapshot.effectiveUntil === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(projection.snapshot.effectiveUntil);
  return from <= requested && requested < until;
}

function scoped(
  projection: PublishedMenuProjection,
  input: CustomerMenuQueryInput,
  brandReference: CatalogReference,
  storeReference: CatalogReference,
): boolean {
  const snapshot = projection.snapshot;
  return (
    snapshot.brandReference === brandReference &&
    snapshot.storeReferences.includes(storeReference) &&
    snapshot.channelCodes.includes(input.channelCode) &&
    snapshot.orderTypeCodes.includes(input.orderTypeCode) &&
    effectiveAt(projection, input.requestedAt)
  );
}

function localized(
  names: Readonly<Record<string, string>>,
  requestedLocale: string,
  defaultLocale: string,
): string {
  const selected = names[requestedLocale] ?? names[defaultLocale];
  if (selected === undefined) return dependencyFailure();
  return selected;
}

function publicSellable(
  item: PublishedMenuProjection["snapshot"]["sections"][number]["sellables"][number],
  locale: string,
  defaultLocale: string,
): CustomerMenuSellableDto {
  return Object.freeze({
    sellableReference: item.sellableReference,
    productVersionReference: item.productVersionReference,
    name: localized(item.localizedNames, locale, defaultLocale),
    presentationRole: item.presentationRole as CustomerMenuSellableDto["presentationRole"],
    pinned: item.pinned,
    availability: "Available",
    optionRules: item.optionRules,
    allergenDisclosure: Object.freeze({
      registryVersionReference: item.allergenDisclosure.registryVersionReference,
      items: Object.freeze(
        item.allergenDisclosure.items.map((allergen) =>
          Object.freeze({
            allergenReference: allergen.allergenReference,
            code: allergen.code,
            name: localized(allergen.localizedNames, locale, defaultLocale),
            classification: allergen.classification,
          }),
        ),
      ),
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
    }),
    displayPrice: Object.freeze({
      status: "Unavailable",
      amount: null,
      currency: null,
      reason: "PRICING_NOT_INTEGRATED",
    }),
    taxDisplayContext: Object.freeze({
      status: "Unavailable",
      taxInclusive: null,
      reason: "FINAL_QUOTE_REQUIRED",
    }),
  });
}

function found(
  projection: PublishedMenuProjection,
  input: CustomerMenuQueryInput,
): CustomerMenuFound {
  const snapshot = projection.snapshot;
  const search = input.searchTerm?.toLocaleLowerCase(input.locale) ?? null;
  const sections = snapshot.sections
    .filter(
      (section) =>
        input.sectionReference === null || section.sectionReference === input.sectionReference,
    )
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((section) => {
      const sellables = section.sellables
        .filter(
          (item) =>
            item.configuredAvailability === "Available" && item.presentationRole !== "Hidden",
        )
        .filter((item) => {
          if (search === null) return true;
          return localized(item.localizedNames, input.locale, snapshot.defaultLocale)
            .toLocaleLowerCase(input.locale)
            .includes(search);
        })
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => publicSellable(item, input.locale, snapshot.defaultLocale));
      return Object.freeze({
        sectionReference: section.sectionReference,
        name: localized(section.localizedNames, input.locale, snapshot.defaultLocale),
        sellables: Object.freeze(sellables),
      });
    })
    .filter((section) => section.sellables.length > 0);
  return Object.freeze({
    status: "Found",
    schemaVersion: 1,
    projection: Object.freeze({
      name: projection.projectionName,
      version: projection.projectionVersion,
      asOfUtc: projection.lastRebuiltAt,
      sourceCheckpoint: projection.sourceCheckpoint,
      sourceAggregateVersion: projection.sourceAggregateVersion,
      freshnessStatus: "Fresh",
      freshnessTargetMilliseconds: customerMenuFreshnessTargetMilliseconds,
      stale: false,
      partial: true,
    }),
    scope: Object.freeze({
      publicStoreReference: input.publicStoreReference,
      channelCode: input.channelCode,
      orderTypeCode: input.orderTypeCode,
      effectiveAt: input.requestedAt,
    }),
    menu: Object.freeze({
      menuReference: snapshot.menuReference,
      menuVersionReference: snapshot.menuVersionReference,
      releaseReference: snapshot.releaseReference,
      locale: input.locale,
      name: localized(snapshot.localizedNames, input.locale, snapshot.defaultLocale),
      effectiveFrom: snapshot.effectiveFrom,
      effectiveUntil: snapshot.effectiveUntil,
      sections: Object.freeze(sections),
    }),
  });
}

export function createCustomerMenuQueryService(ports: CustomerMenuQueryPorts) {
  return Object.freeze({
    async getPublishedMenu(value: unknown) {
      const input = parseInput(value);
      const store = await ports.stores
        .resolvePublic(input.publicStoreReference)
        .catch(dependencyFailure);
      if (store === null || store.status !== "Active")
        return Object.freeze({ status: "NotFound" as const });
      let candidates: readonly PublishedMenuProjection[];
      try {
        candidates = Object.freeze(
          (
            await ports.projections.loadCandidates({
              brandReference: store.brandReference,
              storeReference: store.storeReference,
            })
          ).map(parsePublishedMenuProjection),
        );
      } catch {
        return Object.freeze({ status: "Unavailable" as const });
      }
      const matching = candidates.filter((projection) =>
        scoped(projection, input, store.brandReference, store.storeReference),
      );
      if (matching.length === 0) return Object.freeze({ status: "NotFound" as const });
      if (matching.length !== 1) return Object.freeze({ status: "Unavailable" as const });
      const projection = matching[0];
      if (projection === undefined) return Object.freeze({ status: "Unavailable" as const });
      if (projection.freshnessStatus !== "Fresh")
        return Object.freeze({ status: "ProjectionStale" as const });
      return found(projection, input);
    },
  });
}

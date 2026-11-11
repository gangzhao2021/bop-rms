import {
  customerMenuFreshnessTargetMilliseconds,
  type CustomerMenuFound,
  type CustomerMenuOptionRuleDto,
  type CustomerMenuPhotoDto,
  type CustomerMenuQueryInput,
  type CustomerMenuSellableDto,
} from "../contracts/customer-menu-query.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  type CatalogCode,
  type CatalogInstant,
  type CatalogReference,
} from "../domain/product.js";
import {
  sellableAllergenChangeForChoices,
  sellableAllergenChoiceKey,
  withSellableAllergenChange,
  type SellableAllergenChange,
  type SellableAllergenClassification,
  type SellableAllergenNow,
} from "../domain/sellable-allergen-change.js";
import {
  parsePublishedMenuProjection,
  publishedDefaultOptionSelections,
  type PublishedMenuProjection,
  type PublishedSellablePresentation,
} from "../domain/published-menu-projection.js";
import type {
  CustomerMenuQueryPorts,
  CustomerMenuStoreFact,
} from "./ports/customer-menu-query-ports.js";

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

/** Requested locale, else the menu default, else the first available (sorted) language; null when none. */
function localizedOptional(
  texts: Readonly<Record<string, string>>,
  requestedLocale: string,
  defaultLocale: string,
): string | null {
  const first = Object.keys(texts).sort()[0];
  return (
    texts[requestedLocale] ??
    texts[defaultLocale] ??
    (first === undefined ? null : texts[first]) ??
    null
  );
}

function publicPhoto(
  presentation: PublishedSellablePresentation | undefined,
  locale: string,
  defaultLocale: string,
): CustomerMenuPhotoDto | null {
  const photo = presentation?.photo ?? null;
  if (photo === null) return null;
  const altText = localizedOptional(photo.localizedAltText, locale, defaultLocale);
  if (altText === null) return dependencyFailure();
  return Object.freeze({
    altText,
    width: photo.width,
    height: photo.height,
    renditions: Object.freeze(
      photo.renditions.map((rendition) =>
        Object.freeze({
          url: rendition.path,
          contentType: rendition.contentType,
          width: rendition.width,
          height: rendition.height,
        }),
      ),
    ),
  });
}

/** One option's current price at the Store, when the Store's facts were read. */
function optionPrice(
  fact: CustomerMenuStoreFact | null,
  bindingReference: CatalogReference,
  optionReference: CatalogReference,
): CustomerMenuOptionRuleDto["options"][number]["incrementalPrice"] {
  const price = fact?.optionPrices?.get(bindingReference + ":" + optionReference);
  if (price !== undefined)
    return { status: "Available", amount: price.amount, currency: price.currency, reason: null };
  return {
    status: "Unavailable",
    amount: null,
    currency: null,
    reason:
      fact === null || fact.optionPrices === undefined ? "PRICING_NOT_INTEGRATED" : "PRICE_NOT_SET",
  };
}
type PublishedSellable =
  PublishedMenuProjection["snapshot"]["sections"][number]["sellables"][number];
/** WP-2423 item 8 ⑥ part 4: a rule whose every choice stands for a dish of a combo. */
function comboPartRule(
  rule: PublishedSellable["optionRules"][number],
  fact: CustomerMenuStoreFact | null,
): boolean {
  return (
    fact?.comboChoices !== undefined &&
    rule.options.length > 0 &&
    rule.options.every((option) => fact.comboChoices?.has(option.optionReference))
  );
}
/**
 * WP-2423 (M77, M167): the listed allergens together with those a recipe change brought since the
 * menu was listed — in `items` and in every set of choices — so a guest never reads a list that
 * leaves one out. Said "just updated" when the change adds or strengthens one, or could not be
 * resolved.
 */
export function changedAllergenDisclosure(
  disclosure: CustomerMenuSellableDto["allergenDisclosure"],
  change: SellableAllergenChange | undefined,
  name: (names: Readonly<Record<string, string>>) => string,
  /** b7: the choices guests are offered, so what a staff answer adds is shown under each. */
  offeredOptions: readonly string[] = [],
): CustomerMenuSellableDto["allergenDisclosure"] {
  if (change === undefined) return disclosure;
  const merged = withSellableAllergenChange(disclosure.items, change, (allergen) =>
    Object.freeze({
      allergenReference: allergen.allergenReference as CatalogReference,
      code: allergen.code as CatalogCode,
      name: name(allergen.localizedNames) || allergen.code,
      classification: allergen.classification,
    }),
  );
  const coded = (allergen: SellableAllergenNow) =>
    Object.freeze({
      code: allergen.code as CatalogCode,
      classification: allergen.classification,
    });
  // WP-2423 (M166 with M77, b7): what a staff answer says a choice adds, under that choice.
  let byOption = disclosure.byOption;
  let optionChanged = false;
  let answeredNone = false;
  const choices = change.allergens === null ? undefined : change.choices;
  if (choices !== undefined) {
    const next: Record<
      string,
      readonly { code: CatalogCode; classification: SellableAllergenClassification }[]
    > = { ...(byOption ?? {}) };
    for (const option of offeredOptions) {
      const adds = choices.options[sellableAllergenChoiceKey(option)];
      if (adds === undefined) continue;
      if (adds.length === 0) {
        // Answered "Adds none" (guests are no longer asked to check with staff about it, when no
        // reviewed set of choices says it already). Never removes what the listed menu names.
        if (next[option] === undefined && disclosure.byChoice === undefined) {
          next[option] = Object.freeze([]);
          answeredNone = true;
        }
        continue;
      }
      const found = withSellableAllergenChange(next[option] ?? [], { allergens: adds }, coded);
      if (!found.changed) continue;
      next[option] = found.items;
      optionChanged = true;
    }
    if (optionChanged || answeredNone) byOption = Object.freeze(next);
  }
  if (!merged.changed && !optionChanged)
    // Only answered "Adds none": nothing more to read, so not said "just updated".
    return answeredNone && byOption !== undefined
      ? Object.freeze({ ...disclosure, byOption })
      : disclosure;
  const byChoice = disclosure.byChoice;
  // Each reviewed set of choices takes the dish's own with what its chosen ones add (the whole
  // change when it does not say what each adds).
  let rebuilt: CustomerMenuSellableDto["allergenDisclosure"]["byChoice"];
  if (byChoice !== undefined) {
    const outcomes: (readonly {
      code: CatalogCode;
      classification: SellableAllergenClassification;
    }[])[] = [];
    const index = new Map<string, number>();
    const sets = byChoice.sets.map(([outcome, ...chosen]) => {
      const items = withSellableAllergenChange(
        byChoice.outcomes[outcome as number] ?? [],
        sellableAllergenChangeForChoices(
          change,
          chosen.map((at) => String(byChoice.options[at])),
        ),
        coded,
      ).items;
      const key = JSON.stringify(items);
      let at = index.get(key);
      if (at === undefined) {
        at = outcomes.length;
        index.set(key, at);
        outcomes.push(Object.freeze(items));
      }
      return Object.freeze([at, ...chosen]);
    });
    rebuilt = Object.freeze({
      ...byChoice,
      outcomes: Object.freeze(outcomes),
      sets: Object.freeze(sets),
    });
  }
  return Object.freeze({
    ...disclosure,
    items: merged.items,
    ...(rebuilt === undefined ? {} : { byChoice: rebuilt }),
    ...(byOption === undefined ? {} : { byOption }),
    justUpdated: true as const,
  });
}

function publicSellable(
  item: PublishedSellable,
  locale: string,
  defaultLocale: string,
  channelCode: string,
  fact: CustomerMenuStoreFact | null,
): CustomerMenuSellableDto {
  const offeredRules = item.optionRules.filter(
    (rule) =>
      rule.semanticsVersion !== 2 || rule.channelCodes?.some((channel) => channel === channelCode),
  );
  // WP-2423 item 12: only a combo's dishes show their own allergens; other choices aren't sent.
  const comboDishes = new Set(
    offeredRules
      .filter((rule) => comboPartRule(rule, fact))
      .flatMap((rule) => rule.options.map((option) => String(option.optionReference))),
  );
  // WP-2423 (M166): and any choice that adds allergens of its own (egg in egg fried rice).
  const offeredOptions = new Set(
    offeredRules.flatMap((rule) => rule.options.map((option) => String(option.optionReference))),
  );
  // b7: and a choice answered as adding none (an empty list) when no reviewed set of choices
  // covers the dish, so guests are asked to check with staff only about choices nobody answered.
  const answeredNoneSent = item.allergenDisclosure.byChoice === undefined;
  const byOption = Object.entries(item.allergenDisclosure.byOption ?? {}).filter(
    ([option, items]) =>
      comboDishes.has(option) ||
      (offeredOptions.has(option) && (items.length > 0 || answeredNoneSent)),
  );
  return Object.freeze({
    sellableReference: item.sellableReference,
    productVersionReference: item.productVersionReference,
    name: localized(item.localizedNames, locale, defaultLocale),
    presentationRole: item.presentationRole as CustomerMenuSellableDto["presentationRole"],
    pinned: item.pinned,
    availability: fact?.availability === "SoldOut" ? "SoldOut" : "Available",
    ...(fact?.alcohol === undefined ? {} : { alcohol: fact.alcohol }),
    optionRules: Object.freeze(
      offeredRules.map((rule) =>
        Object.freeze({
          ...rule,
          name:
            rule.localizedNames === undefined
              ? null
              : (rule.localizedNames[locale] ?? rule.localizedNames[defaultLocale] ?? null),
          ...(comboPartRule(rule, fact) ? { comboPart: true as const } : {}),
          options: Object.freeze(
            rule.options.map((option) =>
              Object.freeze({
                optionReference: option.optionReference,
                name: localized(option.localizedNames, locale, defaultLocale),
                maximumQuantity: option.maximumQuantity,
                conflictOptionReferences: option.conflictOptionReferences,
                selectedByDefault: option.selectedByDefault,
                ...(rule.semanticsVersion === 2
                  ? { defaultQuantity: Number(option.defaultQuantity) }
                  : {}),
                // WP-2423 (M22, M24): sold out at the Store today, or not offered now.
                ...(fact?.soldOutOptions?.has(String(option.optionReference)) === true
                  ? { offeredNow: false as const, soldOut: true as const }
                  : fact?.notOfferedOptions?.has(String(option.optionReference)) === true
                    ? { offeredNow: false as const }
                    : {}),
                incrementalPrice: Object.freeze(
                  optionPrice(fact, rule.bindingReference, option.optionReference),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
    description:
      item.presentation === undefined
        ? null
        : localizedOptional(item.presentation.localizedDescriptions, locale, defaultLocale),
    photo: publicPhoto(item.presentation, locale, defaultLocale),
    allergenDisclosure: Object.freeze(
      changedAllergenDisclosure(
        {
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
          ...(item.allergenDisclosure.byChoice === undefined
            ? {}
            : { byChoice: item.allergenDisclosure.byChoice }),
          ...(byOption.length === 0
            ? {}
            : { byOption: Object.freeze(Object.fromEntries(byOption)) }),
        },
        fact?.allergenChange,
        (names) => localizedOptional(names, locale, defaultLocale) ?? "",
        [...offeredOptions].filter((option) => !comboDishes.has(option)),
      ),
    ),
    displayPrice: Object.freeze(
      fact === null
        ? {
            status: "Unavailable" as const,
            amount: null,
            currency: null,
            reason: "PRICING_NOT_INTEGRATED" as const,
          }
        : fact.price === null
          ? {
              status: "Unavailable" as const,
              amount: null,
              currency: null,
              reason: "PRICE_NOT_SET" as const,
            }
          : {
              status: "Available" as const,
              amount: fact.price.amount,
              currency: fact.price.currency,
              reason: null,
            },
    ),
    taxDisplayContext: Object.freeze({
      status: "Unavailable",
      taxInclusive: null,
      reason: "FINAL_QUOTE_REQUIRED",
    }),
  });
}

type PublishedMenuSellable =
  PublishedMenuProjection["snapshot"]["sections"][number]["sellables"][number];

/**
 * Search rank against the text the customer is shown: 0 for a name match, 1 for a match in the
 * published customer description only, null for no match. Without a search everything ranks 0.
 */
function searchRank(
  item: PublishedMenuSellable,
  search: string | null,
  locale: string,
  snapshot: PublishedMenuProjection["snapshot"],
): 0 | 1 | null {
  if (search === null) return 0;
  const name = localized(item.localizedNames, locale, snapshot.defaultLocale);
  if (name.toLocaleLowerCase(locale).includes(search)) return 0;
  const description =
    item.presentation === undefined
      ? null
      : localizedOptional(item.presentation.localizedDescriptions, locale, snapshot.defaultLocale);
  return description !== null && description.toLocaleLowerCase(locale).includes(search) ? 1 : null;
}

function found(
  projection: PublishedMenuProjection,
  input: CustomerMenuQueryInput,
  facts: ReadonlyMap<string, CustomerMenuStoreFact> | null,
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
            item.configuredAvailability === "Available" &&
            item.presentationRole !== "Hidden" &&
            // Items the Store does not offer are not on its menu.
            (facts === null ||
              (facts.get(item.sellableReference)?.availability ?? "NotOffered") !== "NotOffered"),
        )
        .map((item) => ({ item, rank: searchRank(item, search, input.locale, snapshot) }))
        .filter((entry) => entry.rank !== null)
        // Name matches first, then description matches; menu order within each.
        .sort(
          (left, right) =>
            (left.rank ?? 0) - (right.rank ?? 0) || left.item.sortOrder - right.item.sortOrder,
        )
        .map(({ item }) =>
          publicSellable(
            item,
            input.locale,
            snapshot.defaultLocale,
            input.channelCode,
            facts?.get(item.sellableReference) ?? null,
          ),
        );
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
              channelCode: input.channelCode,
              orderTypeCode: input.orderTypeCode,
              requestedAt: input.requestedAt,
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
      let facts: ReadonlyMap<string, CustomerMenuStoreFact> | null = null;
      if (ports.storeFacts !== undefined)
        try {
          facts = await ports.storeFacts.load({
            brandReference: store.brandReference,
            storeReference: store.storeReference,
            channelCode: input.channelCode,
            orderTypeCode: input.orderTypeCode,
            requestedAt: input.requestedAt,
            sellableReferences: Object.freeze(
              projection.snapshot.sections.flatMap((section) =>
                section.sellables.map((item) => item.sellableReference),
              ),
            ),
            menuVersionReference: projection.snapshot.menuVersionReference,
            // The published options offered on this channel, to show what each adds.
            options: Object.freeze(
              projection.snapshot.sections.flatMap((section) =>
                section.sellables.flatMap((item) =>
                  item.optionRules
                    .filter(
                      (rule) =>
                        rule.semanticsVersion !== 2 ||
                        rule.channelCodes?.some((channel) => channel === input.channelCode),
                    )
                    .flatMap((rule) =>
                      rule.options.map((option) => ({
                        sellableReference: item.sellableReference,
                        bindingReference: rule.bindingReference,
                        optionReference: option.optionReference,
                      })),
                    ),
                ),
              ),
            ),
            // Each shown item as normally ordered, so the Store's stock can be observed for it.
            items: Object.freeze(
              projection.snapshot.sections.flatMap((section) =>
                section.sellables
                  .filter(
                    (item) =>
                      item.configuredAvailability === "Available" &&
                      item.presentationRole !== "Hidden",
                  )
                  .map((item) =>
                    Object.freeze({
                      sellableReference: item.sellableReference,
                      productVersionReference: item.productVersionReference,
                      defaultOptionSelections: publishedDefaultOptionSelections(
                        item.optionRules,
                        input.channelCode,
                      ),
                      optionRules: item.optionRules,
                    }),
                  ),
              ),
            ),
          });
        } catch {
          return Object.freeze({ status: "Unavailable" as const });
        }
      return found(projection, input, facts);
    },
  });
}

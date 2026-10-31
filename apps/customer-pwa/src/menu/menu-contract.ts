import type {
  MenuAllergenItem,
  MenuJourneyContext,
  MenuOptionRule,
  MenuPhoto,
  MenuSellable,
  MenuView,
} from "./types.js";

/**
 * The guest menu contract: how the customer PWA reads the public menu the server sends. Pure (no
 * browser, React or translation dependency) so staff screens can run the very same reading on the
 * same payload and say which items guests cannot be shown (WP-2423 item 8 ⑥ part 4).
 */

/** The guest's language; Chinese names the priority allergens in Chinese. */
export type MenuLanguage = "en" | "zh-Hans";

export const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
export const menuLocale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const forbiddenLabel = /[\p{Cc}\p{Cf}<>{}[\]`*_#]/u;
const forbiddenProse = /[\p{Cc}\p{Cf}<>{}]/u;
const imagePath = /^\/media\/images\/[0-9a-f]{64}\.(?:jpg|webp)$/u;

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("closed menu response required");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    throw new TypeError("closed menu response required");
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
  );
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    value !== value.normalize("NFC") ||
    value !== value.trim() ||
    forbiddenLabel.test(value)
  )
    throw new TypeError("safe public text required");
  return value;
}

/** Staff-written plain prose (descriptions, photo alt text); punctuation allowed, markup not. */
function prose(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.normalize("NFC") ||
    value !== value.trim() ||
    forbiddenProse.test(value)
  )
    throw new TypeError("safe public prose required");
  return value;
}

function photo(value: unknown): MenuPhoto | null {
  if (value === null) return null;
  const raw = exact(value, ["altText", "width", "height", "renditions"]);
  if (!Array.isArray(raw.renditions) || raw.renditions.length < 1 || raw.renditions.length > 6)
    throw new TypeError("photo renditions invalid");
  const renditions = Object.freeze(
    raw.renditions.map((candidate) => {
      const rendition = exact(candidate, ["url", "contentType", "width", "height"]);
      if (
        typeof rendition.url !== "string" ||
        !imagePath.test(rendition.url) ||
        (rendition.contentType !== "image/jpeg" && rendition.contentType !== "image/webp") ||
        rendition.url.endsWith(".jpg") !== (rendition.contentType === "image/jpeg")
      )
        throw new TypeError("photo rendition invalid");
      return Object.freeze({
        url: rendition.url,
        contentType: rendition.contentType as "image/jpeg" | "image/webp",
        width: positiveInteger(rendition.width),
        height: positiveInteger(rendition.height),
      });
    }),
  );
  return Object.freeze({
    altText: prose(raw.altText, 160),
    width: positiveInteger(raw.width),
    height: positiveInteger(raw.height),
    renditions,
  });
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuidV7.test(value)) throw new TypeError("reference required");
  return value;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== "string" || !instant.test(value)) throw new TypeError("instant required");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new TypeError("instant required");
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new TypeError("positive integer required");
  return Number(value);
}

function selectionInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new TypeError("selection integer required");
  return Number(value);
}

function referenceList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("reference list required");
  const result = Object.freeze(value.map(reference));
  if (new Set(result).size !== result.length) throw new TypeError("unique references required");
  return result;
}

function optionRule(value: unknown): MenuOptionRule {
  const quantity =
    value !== null &&
    typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "semanticsVersion")?.value === 2;
  // WP-2423 item 8 ⑥ part 4: a combo part (guests start with nothing chosen).
  const comboPart =
    value !== null && typeof value === "object" && Object.hasOwn(value, "comboPart");
  const raw = exact(value, [
    ...(quantity ? ["semanticsVersion", "activationOptionReferences"] : []),
    ...(comboPart ? ["comboPart"] : []),
    "name",
    "bindingReference",
    "optionSetVersionReference",
    "minimumSelections",
    "maximumSelections",
    "enabledOptionReferences",
    "defaultOptionReferences",
    "options",
  ]);
  reference(raw.bindingReference);
  reference(raw.optionSetVersionReference);
  const minimumSelections = selectionInteger(raw.minimumSelections);
  const maximumSelections = selectionInteger(raw.maximumSelections);
  const enabled = referenceList(raw.enabledOptionReferences);
  const defaults = referenceList(raw.defaultOptionReferences);
  if (!Array.isArray(raw.options)) throw new TypeError("options required");
  const options = Object.freeze(
    raw.options.map((candidate) => {
      const option = exact(candidate, [
        ...(quantity ? ["defaultQuantity"] : []),
        "optionReference",
        "name",
        "maximumQuantity",
        "conflictOptionReferences",
        "selectedByDefault",
        "incrementalPrice",
      ]);
      const optionReference = reference(option.optionReference);
      const defaultQuantity = quantity
        ? selectionInteger(option.defaultQuantity)
        : option.selectedByDefault
          ? 1
          : 0;
      if (
        defaultQuantity > Number(option.maximumQuantity) ||
        option.selectedByDefault !== defaultQuantity > 0
      )
        throw new TypeError("default quantity invalid");
      const conflictOptionReferences = referenceList(option.conflictOptionReferences);
      const incrementalPrice = exact(option.incrementalPrice, [
        "status",
        "amount",
        "currency",
        "reason",
      ]);
      if (
        !Number.isSafeInteger(option.maximumQuantity) ||
        Number(option.maximumQuantity) < 1 ||
        Number(option.maximumQuantity) > 999 ||
        typeof option.selectedByDefault !== "boolean" ||
        conflictOptionReferences.includes(optionReference) ||
        !(
          (incrementalPrice.status === "Available" &&
            typeof incrementalPrice.amount === "string" &&
            /^\d{1,9}(\.\d{1,4})?$/u.test(incrementalPrice.amount) &&
            typeof incrementalPrice.currency === "string" &&
            /^[A-Z]{3}$/u.test(incrementalPrice.currency) &&
            incrementalPrice.reason === null) ||
          (incrementalPrice.status === "Unavailable" &&
            incrementalPrice.amount === null &&
            incrementalPrice.currency === null &&
            (incrementalPrice.reason === "PRICING_NOT_INTEGRATED" ||
              incrementalPrice.reason === "PRICE_NOT_SET"))
        )
      )
        throw new TypeError("option invalid");
      return Object.freeze({
        optionReference,
        name: text(option.name),
        maximumQuantity: Number(option.maximumQuantity),
        conflictOptionReferences,
        selectedByDefault: option.selectedByDefault,
        ...(quantity ? { defaultQuantity } : {}),
        price:
          incrementalPrice.status === "Available"
            ? Object.freeze({
                amount: String(incrementalPrice.amount),
                currency: String(incrementalPrice.currency),
              })
            : null,
      });
    }),
  );
  if (
    minimumSelections > maximumSelections ||
    maximumSelections >
      (quantity
        ? options.reduce((sum, option) => sum + option.maximumQuantity, 0)
        : enabled.length) ||
    (quantity &&
      (maximumSelections > 99900 ||
        options.reduce((sum, option) => sum + (option.defaultQuantity ?? 0), 0) <
          minimumSelections ||
        options.reduce((sum, option) => sum + (option.defaultQuantity ?? 0), 0) >
          maximumSelections)) ||
    defaults.some((item) => !enabled.includes(item)) ||
    options.length !== enabled.length ||
    options.some(
      (option, index) =>
        option.optionReference !== enabled[index] ||
        option.selectedByDefault !== defaults.includes(option.optionReference) ||
        (!quantity && option.conflictOptionReferences.some((item) => !enabled.includes(item))),
    )
  )
    throw new TypeError("invalid option rule");
  if (raw.name !== null && typeof raw.name !== "string") throw new TypeError("name invalid");
  // A combo part is choose-N: each dish at most once. The server sends it in whichever form the
  // binding has, the quantity form included (v15 2026-10-29: every guest menu failed on it).
  if (
    comboPart &&
    (raw.comboPart !== true || options.some((option) => option.maximumQuantity !== 1))
  )
    throw new TypeError("combo part invalid");
  return Object.freeze({
    name: raw.name === null ? null : text(raw.name),
    ...(comboPart ? { comboPart: true as const } : {}),
    ...(quantity
      ? { activationOptionReferences: referenceList(raw.activationOptionReferences) }
      : {}),
    minimumSelections,
    maximumSelections,
    // A guest never sends a dish they did not choose: no defaults in a combo part.
    options: comboPart
      ? Object.freeze(
          options.map((option) =>
            Object.freeze({
              ...option,
              selectedByDefault: false,
              ...(quantity ? { defaultQuantity: 0 } : {}),
            }),
          ),
        )
      : options,
  });
}

function allergenDisclosure(value: unknown, language: MenuLanguage) {
  const hasChoices =
    value !== null && typeof value === "object" && Object.hasOwn(value, "byChoice");
  const raw = exact(value, [
    "registryVersionReference",
    "items",
    "allergenFreeClaim",
    "assistanceCode",
    ...(hasChoices ? ["byChoice"] : []),
  ]);
  reference(raw.registryVersionReference);
  if (
    raw.allergenFreeClaim !== false ||
    raw.assistanceCode !== "ALLERGEN_ASSISTANCE_REQUIRED" ||
    !Array.isArray(raw.items)
  )
    throw new TypeError("controlled allergen disclosure required");
  const names = new Map<string, string>();
  const items: readonly MenuAllergenItem[] = Object.freeze(
    raw.items.map((item) => {
      const entry = exact(item, ["allergenReference", "code", "name", "classification"]);
      reference(entry.allergenReference);
      if (
        typeof entry.code !== "string" ||
        !code.test(entry.code) ||
        (entry.classification !== "Contains" && entry.classification !== "CrossContactPossible")
      )
        throw new TypeError("allergen item invalid");
      const name = allergenName(entry.code, text(entry.name), language);
      names.set(entry.code, name);
      return Object.freeze({ name, classification: entry.classification });
    }),
  );
  return { items, byChoice: hasChoices ? allergensByChoice(raw.byChoice, names) : undefined };
}

/**
 * Owner 2026-10-23: the Canadian priority allergens in Simplified Chinese, by registry code. Used
 * while Chinese is chosen unless the Store's registry already names the allergen in Chinese.
 */
const chineseAllergenNames: Readonly<Record<string, string>> = Object.freeze({
  CRUSTACEAN_MOLLUSC: "甲壳类和软体类海鲜",
  EGG: "蛋",
  FISH: "鱼",
  GLUTEN: "麸质来源（大麦、燕麦、黑麦）",
  MILK: "牛奶",
  MUSTARD: "芥末",
  PEANUT: "花生",
  SESAME: "芝麻",
  SOY: "大豆",
  SULPHITES: "亚硫酸盐",
  TREE_NUT: "坚果",
  WHEAT_TRITICALE: "小麦和黑小麦",
});
function allergenName(code: string, name: string, language: MenuLanguage): string {
  if (language !== "zh-Hans" || /\p{Script=Han}/u.test(name)) return name;
  return chineseAllergenNames[code] ?? name;
}

/** WP-2423 ⑪: per-choice allergens, named as in the item's disclosure. */
function allergensByChoice(value: unknown, names: ReadonlyMap<string, string>) {
  const raw = exact(value, ["options", "outcomes", "sets"]);
  const options = referenceList(raw.options);
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length < 1 || !Array.isArray(raw.sets))
    throw new TypeError("allergen choices invalid");
  const outcomes = Object.freeze(
    raw.outcomes.map((outcome) => {
      if (!Array.isArray(outcome)) throw new TypeError("allergen choices invalid");
      return Object.freeze(
        outcome.map((item) => {
          const entry = exact(item, ["code", "classification"]);
          const name = typeof entry.code === "string" ? names.get(entry.code) : undefined;
          if (
            name === undefined ||
            (entry.classification !== "Contains" && entry.classification !== "CrossContactPossible")
          )
            throw new TypeError("allergen choices invalid");
          return Object.freeze({ name, classification: entry.classification });
        }),
      );
    }),
  );
  const sets = Object.freeze(
    raw.sets.map((set) => {
      if (
        !Array.isArray(set) ||
        set.length < 1 ||
        !set.every((n) => Number.isSafeInteger(n) && n >= 0) ||
        (set[0] as number) >= outcomes.length ||
        set.slice(1).some((n) => (n as number) >= options.length)
      )
        throw new TypeError("allergen choices invalid");
      return Object.freeze(set as number[]);
    }),
  );
  return Object.freeze({ options, outcomes, sets });
}

function sellable(value: unknown, language: MenuLanguage): MenuSellable {
  const raw = exact(value, [
    "sellableReference",
    "productVersionReference",
    "name",
    "description",
    "photo",
    "presentationRole",
    "pinned",
    "availability",
    "optionRules",
    "allergenDisclosure",
    "displayPrice",
    "taxDisplayContext",
  ]);
  const productVersionReference = reference(raw.productVersionReference);
  const presentationRoles = ["Standard", "Featured", "Promotional", "Sponsored"] as const;
  if (
    !presentationRoles.includes(raw.presentationRole as never) ||
    typeof raw.pinned !== "boolean" ||
    (raw.availability !== "Available" && raw.availability !== "SoldOut") ||
    !Array.isArray(raw.optionRules)
  )
    throw new TypeError("sellable invalid");
  const price = exact(raw.displayPrice, ["status", "amount", "currency", "reason"]);
  const tax = exact(raw.taxDisplayContext, ["status", "taxInclusive", "reason"]);
  const priced =
    price.status === "Available" &&
    typeof price.amount === "string" &&
    /^\d{1,9}(\.\d{1,4})?$/u.test(price.amount) &&
    typeof price.currency === "string" &&
    /^[A-Z]{3}$/u.test(price.currency) &&
    price.reason === null;
  const unpriced =
    price.status === "Unavailable" &&
    price.amount === null &&
    price.currency === null &&
    (price.reason === "PRICING_NOT_INTEGRATED" || price.reason === "PRICE_NOT_SET");
  if (
    !(priced || unpriced) ||
    tax.status !== "Unavailable" ||
    tax.taxInclusive !== null ||
    tax.reason !== "FINAL_QUOTE_REQUIRED"
  )
    throw new TypeError("unsupported price or tax contract");
  const optionRules = Object.freeze(raw.optionRules.map(optionRule));
  if (optionRules.some((rule) => rule.activationOptionReferences !== undefined)) {
    const owners = new Map<string, number>();
    optionRules.forEach((rule, index) =>
      rule.options.forEach((option) => {
        if (owners.has(option.optionReference)) throw new TypeError("duplicate option");
        owners.set(option.optionReference, index);
      }),
    );
    const edges = optionRules.map((rule, index) => {
      if (
        rule.options.some((option) =>
          option.conflictOptionReferences.some((ref) => !owners.has(ref)),
        )
      )
        throw new TypeError("unknown conflict");
      return (rule.activationOptionReferences ?? []).map((ref) => {
        const parent = owners.get(ref);
        if (parent === undefined || parent === index) throw new TypeError("invalid activation");
        return parent;
      });
    });
    const visiting = new Set<number>(),
      visited = new Set<number>();
    const visit = (index: number): void => {
      if (visiting.has(index)) throw new TypeError("activation cycle");
      if (visited.has(index)) return;
      visiting.add(index);
      for (const parent of edges[index] ?? []) visit(parent);
      visiting.delete(index);
      visited.add(index);
    };
    optionRules.forEach((_rule, index) => visit(index));
  }
  return Object.freeze({
    sellableReference: reference(raw.sellableReference),
    productVersionReference,
    name: text(raw.name),
    description: raw.description === null ? null : prose(raw.description, 240),
    photo: photo(raw.photo),
    presentationRole: raw.presentationRole as MenuSellable["presentationRole"],
    pinned: raw.pinned,
    availability: raw.availability as MenuSellable["availability"],
    price: priced ? { amount: price.amount as string, currency: price.currency as string } : null,
    ...(() => {
      const disclosure = allergenDisclosure(raw.allergenDisclosure, language);
      return {
        allergens: disclosure.items,
        ...(disclosure.byChoice === undefined ? {} : { allergensByChoice: disclosure.byChoice }),
      };
    })(),
    optionRules,
  });
}

export function parseMenuFound(
  value: unknown,
  context: MenuJourneyContext,
  language: MenuLanguage,
): MenuView {
  const root = exact(value, ["status", "schemaVersion", "projection", "scope", "menu"]);
  if (root.status !== "Found" || root.schemaVersion !== 1)
    throw new TypeError("menu result invalid");
  const projection = exact(root.projection, [
    "name",
    "version",
    "asOfUtc",
    "sourceCheckpoint",
    "sourceAggregateVersion",
    "freshnessStatus",
    "freshnessTargetMilliseconds",
    "stale",
    "partial",
  ]);
  if (
    projection.name !== "catalog_published_menu_v1" ||
    projection.version !== 1 ||
    projection.freshnessStatus !== "Fresh" ||
    projection.freshnessTargetMilliseconds !== 5_000 ||
    projection.stale !== false ||
    projection.partial !== true
  )
    throw new TypeError("fresh projection required");
  canonicalInstant(projection.asOfUtc);
  reference(projection.sourceCheckpoint);
  positiveInteger(projection.sourceAggregateVersion);
  const scope = exact(root.scope, [
    "publicStoreReference",
    "channelCode",
    "orderTypeCode",
    "effectiveAt",
  ]);
  const expectedChannel = "CUSTOMER_PWA";
  const expectedOrderType = context.channel === "DineIn" ? "DINE_IN" : "PICKUP";
  if (
    reference(scope.publicStoreReference) !== context.publicStoreReference ||
    scope.channelCode !== expectedChannel ||
    scope.orderTypeCode !== expectedOrderType
  )
    throw new TypeError("menu scope mismatch");
  canonicalInstant(scope.effectiveAt);
  const menu = exact(root.menu, [
    "menuReference",
    "menuVersionReference",
    "releaseReference",
    "locale",
    "name",
    "effectiveFrom",
    "effectiveUntil",
    "sections",
  ]);
  reference(menu.menuReference);
  reference(menu.menuVersionReference);
  reference(menu.releaseReference);
  if (
    menu.locale !== context.locale ||
    !menuLocale.test(context.locale) ||
    !Array.isArray(menu.sections)
  )
    throw new TypeError("menu locale invalid");
  const sections = Object.freeze(
    menu.sections.flatMap((candidate) => {
      const section = exact(candidate, ["sectionReference", "name", "sellables"]);
      if (!Array.isArray(section.sellables)) throw new TypeError("sellables required");
      // Owner 2026-10-29: an item this app cannot read is left out, never the whole menu; staff
      // see which (guestUnreadableItems on the same payload).
      const sellables = Object.freeze(
        section.sellables.flatMap((item) => {
          try {
            return [sellable(item, language)];
          } catch {
            return [];
          }
        }),
      );
      if (new Set(sellables.map((item) => item.sellableReference)).size !== sellables.length)
        throw new TypeError("duplicate sellable");
      const kept = {
        sectionReference: reference(section.sectionReference),
        name: text(section.name),
        sellables,
      };
      // A section whose every item was left out is not shown empty.
      return sellables.length === 0 && section.sellables.length > 0 ? [] : [Object.freeze(kept)];
    }),
  );
  // Nothing at all readable: "Menu is unavailable" (try again), not an empty menu.
  if (
    sections.length === 0 &&
    menu.sections.some(
      (section: unknown) =>
        Array.isArray((section as { sellables?: unknown }).sellables) &&
        (section as { sellables: unknown[] }).sellables.length > 0,
    )
  )
    throw new TypeError("no readable item");
  return Object.freeze({
    name: text(menu.name),
    locale: context.locale,
    effectiveFrom: canonicalInstant(menu.effectiveFrom),
    effectiveUntil: menu.effectiveUntil === null ? null : canonicalInstant(menu.effectiveUntil),
    sections,
  });
}

/**
 * The items of a public menu (the `menu` of a Found result) that guests are not shown because
 * this app cannot read them, by name as staff wrote it (empty when even the name is unreadable).
 */
export function guestUnreadableItems(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") return [];
  const sections = (value as { menu?: { sections?: unknown } }).menu?.sections;
  if (!Array.isArray(sections)) return [];
  return Object.freeze(
    sections.flatMap((section: unknown) => {
      const items = (section as { sellables?: unknown } | null)?.sellables;
      if (!Array.isArray(items)) return [];
      return items.flatMap((item: unknown) => {
        try {
          sellable(item, "en");
          return [];
        } catch {
          const name = (item as { name?: unknown } | null)?.name;
          return [typeof name === "string" ? name.slice(0, 160) : ""];
        }
      });
    }),
  );
}

export function parseMenuError(value: unknown): "NotFound" | "Stale" | "Unavailable" {
  const root = exact(value, ["schemaVersion", "error"]);
  const error = exact(root.error, ["code", "messageKey"]);
  if (root.schemaVersion !== 1) return "Unavailable";
  if (error.code === "menu_not_found" && error.messageKey === "customer.menu.not_found")
    return "NotFound";
  if (
    error.code === "menu_projection_stale" &&
    error.messageKey === "customer.menu.projection_stale"
  )
    return "Stale";
  return "Unavailable";
}

export function normalizeMenuSearch(value: string): string | null {
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return normalized.length >= 1 && normalized.length <= 100 && !forbiddenLabel.test(normalized)
    ? normalized
    : null;
}

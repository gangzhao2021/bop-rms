import type {
  CustomerMenuClient,
  MenuAllergenItem,
  MenuJourneyContext,
  MenuLoadResult,
  MenuOptionRule,
  MenuSellable,
  MenuView,
} from "./types.js";
import { boundedFetch } from "../network/bounded-fetch.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const forbiddenLabel = /[\p{Cc}\p{Cf}<>{}[\]`*_#]/u;

export interface CustomerMenuBoundary {
  readonly fetch: typeof globalThis.fetch;
  readonly online: () => boolean;
}

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
  const raw = exact(value, [
    ...(quantity ? ["semanticsVersion", "activationOptionReferences"] : []),
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
        incrementalPrice.status !== "Unavailable" ||
        incrementalPrice.amount !== null ||
        incrementalPrice.currency !== null ||
        incrementalPrice.reason !== "PRICING_NOT_INTEGRATED"
      )
        throw new TypeError("option invalid");
      return Object.freeze({
        optionReference,
        name: text(option.name),
        maximumQuantity: Number(option.maximumQuantity),
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
  return Object.freeze({
    ...(quantity
      ? { activationOptionReferences: referenceList(raw.activationOptionReferences) }
      : {}),
    minimumSelections,
    maximumSelections,
    options,
  });
}

function allergenDisclosure(value: unknown): readonly MenuAllergenItem[] {
  const raw = exact(value, [
    "registryVersionReference",
    "items",
    "allergenFreeClaim",
    "assistanceCode",
  ]);
  reference(raw.registryVersionReference);
  if (
    raw.allergenFreeClaim !== false ||
    raw.assistanceCode !== "ALLERGEN_ASSISTANCE_REQUIRED" ||
    !Array.isArray(raw.items)
  )
    throw new TypeError("controlled allergen disclosure required");
  return Object.freeze(
    raw.items.map((item) => {
      const entry = exact(item, ["allergenReference", "code", "name", "classification"]);
      reference(entry.allergenReference);
      if (
        typeof entry.code !== "string" ||
        !code.test(entry.code) ||
        (entry.classification !== "Contains" && entry.classification !== "CrossContactPossible")
      )
        throw new TypeError("allergen item invalid");
      return Object.freeze({
        name: text(entry.name),
        classification: entry.classification,
      });
    }),
  );
}

function sellable(value: unknown): MenuSellable {
  const raw = exact(value, [
    "sellableReference",
    "productVersionReference",
    "name",
    "presentationRole",
    "pinned",
    "availability",
    "optionRules",
    "allergenDisclosure",
    "displayPrice",
    "taxDisplayContext",
  ]);
  reference(raw.productVersionReference);
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
    name: text(raw.name),
    presentationRole: raw.presentationRole as MenuSellable["presentationRole"],
    pinned: raw.pinned,
    availability: raw.availability as MenuSellable["availability"],
    price: priced ? { amount: price.amount as string, currency: price.currency as string } : null,
    allergens: allergenDisclosure(raw.allergenDisclosure),
    optionRules,
  });
}

function parseFound(value: unknown, context: MenuJourneyContext): MenuView {
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
    !locale.test(context.locale) ||
    !Array.isArray(menu.sections)
  )
    throw new TypeError("menu locale invalid");
  const sections = Object.freeze(
    menu.sections.map((candidate) => {
      const section = exact(candidate, ["sectionReference", "name", "sellables"]);
      if (!Array.isArray(section.sellables)) throw new TypeError("sellables required");
      const sellables = Object.freeze(section.sellables.map(sellable));
      if (new Set(sellables.map((item) => item.sellableReference)).size !== sellables.length)
        throw new TypeError("duplicate sellable");
      return Object.freeze({
        sectionReference: reference(section.sectionReference),
        name: text(section.name),
        sellables,
      });
    }),
  );
  return Object.freeze({
    name: text(menu.name),
    locale: context.locale,
    effectiveFrom: canonicalInstant(menu.effectiveFrom),
    effectiveUntil: menu.effectiveUntil === null ? null : canonicalInstant(menu.effectiveUntil),
    sections,
  });
}

function parseError(value: unknown): "NotFound" | "Stale" | "Unavailable" {
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

export function createCustomerMenuClient(
  context: MenuJourneyContext,
  boundary: CustomerMenuBoundary,
): CustomerMenuClient {
  const inFlight = new Map<string, Promise<MenuLoadResult>>();
  return Object.freeze({
    async load(
      input: Readonly<{ searchTerm?: string; sectionReference?: string }> = {},
    ): Promise<MenuLoadResult> {
      if (!uuidV7.test(context.publicStoreReference) || !locale.test(context.locale))
        return Object.freeze({ kind: "Unavailable" });
      if (!boundary.online()) return Object.freeze({ kind: "Offline" });
      const parameters = new URLSearchParams({
        channel: "CUSTOMER_PWA",
        orderType: context.channel === "DineIn" ? "DINE_IN" : "PICKUP",
        locale: context.locale,
      });
      let normalizedSearch: string | null = null;
      if (input.searchTerm !== undefined) {
        const searchTerm = normalizeMenuSearch(input.searchTerm);
        if (searchTerm === null) return Object.freeze({ kind: "Unavailable" });
        normalizedSearch = searchTerm;
        parameters.set("q", searchTerm);
      }
      if (input.sectionReference !== undefined) {
        if (!uuidV7.test(input.sectionReference)) return Object.freeze({ kind: "Unavailable" });
        parameters.set("section", input.sectionReference);
      }
      const requestKey = `${normalizedSearch ?? ""}\u0000${input.sectionReference ?? ""}`;
      const pending = inFlight.get(requestKey);
      if (pending !== undefined) return pending;
      const request = (async (): Promise<MenuLoadResult> => {
        try {
          const response = await boundedFetch(
            boundary.fetch,
            `/api/v1/public/stores/${context.publicStoreReference}/menu?${parameters.toString()}`,
            {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              referrerPolicy: "no-referrer",
            },
          );
          if (response.status === 403) return Object.freeze({ kind: "PermissionDenied" });
          const payload: unknown = await response.json();
          if (response.status === 200)
            return Object.freeze({ kind: "Found", menu: parseFound(payload, context) });
          return Object.freeze({ kind: parseError(payload) });
        } catch {
          return Object.freeze({ kind: boundary.online() ? "Unavailable" : "Offline" });
        }
      })();
      inFlight.set(requestKey, request);
      void request.finally(() => {
        if (inFlight.get(requestKey) === request) inFlight.delete(requestKey);
      });
      return request;
    },
  });
}

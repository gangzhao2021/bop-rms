import { parseCartItemPresentationSnapshot } from "./cart-item-presentation-snapshot.js";
import type { CustomerMenuQuery, CustomerMenuQueryInput } from "@rms/catalog";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type { CustomerCartView } from "../contracts/customer-cart-view.js";
import { parseCustomerCartDisplay } from "./customer-cart-view.js";

export interface CustomerCartQuoteStateRequest {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
}
export interface CustomerCartPresentationPorts {
  readonly catalog: Pick<CustomerMenuQuery, "getPublishedMenu">;
  readonly quotes: { resolve(request: CustomerCartQuoteStateRequest): Promise<unknown> };
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, keys: readonly string[]) {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return unavailable();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return unavailable();
    result[key] = field.value;
  }
  return result;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return unavailable();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = descriptors[String(index)];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return unavailable();
    result.push(field.value);
  }
  return result;
}
function label(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return unavailable();
  return value.normalize("NFC").trim();
}
function positive(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return unavailable();
  return Number(value);
}
function noPrice(value: unknown) {
  const price = closed(value, ["status", "amount", "currency", "reason"]);
  if (
    price.status !== "Unavailable" ||
    price.amount !== null ||
    price.currency !== null ||
    price.reason !== "PRICING_NOT_INTEGRATED"
  )
    return unavailable();
}
function menuItems(value: unknown, request: CustomerMenuQueryInput, expectedMenuVersion: string) {
  const root = closed(value, ["status", "schemaVersion", "projection", "scope", "menu"]);
  if (root.status !== "Found" || root.schemaVersion !== 1) return unavailable();
  const projection = closed(root.projection, [
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
  const age =
    Date.parse(request.requestedAt) - Date.parse(parseOrderingInstant(projection.asOfUtc));
  if (
    projection.name !== "catalog_published_menu_v1" ||
    projection.version !== 1 ||
    projection.freshnessStatus !== "Fresh" ||
    projection.freshnessTargetMilliseconds !== 5000 ||
    projection.stale !== false ||
    projection.partial !== true ||
    age < 0 ||
    age > 5000
  )
    return unavailable();
  parseOrderingReference(projection.sourceCheckpoint);
  positive(projection.sourceAggregateVersion);
  const scope = closed(root.scope, [
    "publicStoreReference",
    "channelCode",
    "orderTypeCode",
    "effectiveAt",
  ]);
  if (
    scope.publicStoreReference !== request.publicStoreReference ||
    scope.channelCode !== request.channelCode ||
    scope.orderTypeCode !== request.orderTypeCode ||
    scope.effectiveAt !== request.requestedAt
  )
    return unavailable();
  const menu = closed(root.menu, [
    "menuReference",
    "menuVersionReference",
    "releaseReference",
    "locale",
    "name",
    "effectiveFrom",
    "effectiveUntil",
    "sections",
  ]);
  parseOrderingReference(menu.menuReference);
  parseOrderingReference(menu.releaseReference);
  if (
    menu.menuVersionReference !== expectedMenuVersion ||
    menu.locale !== request.locale ||
    Date.parse(parseOrderingInstant(menu.effectiveFrom)) > Date.parse(request.requestedAt) ||
    (menu.effectiveUntil !== null &&
      Date.parse(parseOrderingInstant(menu.effectiveUntil)) <= Date.parse(request.requestedAt))
  )
    return unavailable();
  return list(menu.sections, 200).flatMap((value) => {
    const section = closed(value, ["sectionReference", "name", "sellables"]);
    parseOrderingReference(section.sectionReference);
    return list(section.sellables, 1000).map((value) =>
      closed(value, [
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
      ]),
    );
  });
}
function sourceLineView(item: CartAggregate["items"][number], source: Record<string, unknown>) {
  const evidence = item.catalogSelectionEvidence ?? unavailable();
  if (
    source.productVersionReference !== evidence.productVersionReference ||
    source.availability !== "Available"
  )
    return unavailable();
  noPrice(source.displayPrice);
  const rules = list(source.optionRules, 100).map((value) =>
    closed(value, [
      "bindingReference",
      "optionSetVersionReference",
      "minimumSelections",
      "maximumSelections",
      "enabledOptionReferences",
      "defaultOptionReferences",
      "options",
    ]),
  );
  for (const pin of evidence.ruleEvidence) {
    const found = rules.filter((rule) => rule.bindingReference === pin.bindingReference);
    if (found.length !== 1 || found[0]?.optionSetVersionReference !== pin.optionSetVersionReference)
      return unavailable();
  }
  const configuration = item.optionSelections.map((selection) => {
    const options = rules.flatMap((rule) => {
      const pin = evidence.ruleEvidence.find(
        (candidate) =>
          candidate.bindingReference === rule.bindingReference &&
          candidate.optionSetVersionReference === rule.optionSetVersionReference,
      );
      if (!pin || !list(rule.enabledOptionReferences, 100).includes(selection.optionReference))
        return [];
      return list(rule.options, 100)
        .map((value) =>
          closed(value, [
            "optionReference",
            "name",
            "maximumQuantity",
            "conflictOptionReferences",
            "selectedByDefault",
            "incrementalPrice",
          ]),
        )
        .filter((option) => option.optionReference === selection.optionReference);
    });
    if (options.length !== 1) return unavailable();
    const option = options[0] ?? unavailable();
    if (selection.quantity > positive(option.maximumQuantity)) return unavailable();
    noPrice(option.incrementalPrice);
    return Object.freeze({
      optionReference: selection.optionReference,
      quantity: selection.quantity,
      displayName: label(option.name),
    });
  });
  // The public menu explicitly has no integrated price. Do not derive a price or a Quote here.
  return Object.freeze({
    cartItemReference: item.cartItemReference,
    sellableReference: item.sellableReference,
    displayName: label(source.name),
    quantity: item.quantity,
    configuration: Object.freeze(configuration),
    customerNote: item.customerNote,
    lineEstimate: Object.freeze({
      status: "Unavailable" as const,
      reasonCode: "PRICE_UNAVAILABLE",
    }),
    warnings: Object.freeze([]),
  });
}
function lineView(
  item: CartAggregate["items"][number],
  sources: readonly Record<string, unknown>[],
) {
  const candidates = sources
    .filter((source) => source.sellableReference === item.sellableReference)
    .map((source) => sourceLineView(item, source));
  const first = candidates[0];
  if (
    first === undefined ||
    candidates.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(first))
  )
    return unavailable();
  return first;
}
async function catalogLines(
  ports: Pick<CustomerCartPresentationPorts, "catalog">,
  cart: CartAggregate,
  display: ReturnType<typeof parseCustomerCartDisplay>,
) {
  let items: CustomerCartView["cart"]["items"] = Object.freeze([]);
  if (cart.items.length > 0) {
    const evidence = cart.items[0]?.catalogSelectionEvidence ?? unavailable();
    if (
      cart.items.some(
        (item) =>
          item.catalogSelectionEvidence?.menuVersionReference !== evidence.menuVersionReference ||
          item.catalogSelectionEvidence.catalogChannelCode !== evidence.catalogChannelCode ||
          item.catalogSelectionEvidence.catalogOrderTypeCode !== evidence.catalogOrderTypeCode,
      )
    )
      return unavailable();
    const query: CustomerMenuQueryInput = Object.freeze({
      publicStoreReference: display.publicStoreReference as never,
      channelCode: evidence.catalogChannelCode as never,
      orderTypeCode: evidence.catalogOrderTypeCode as never,
      locale: display.locale,
      requestedAt: display.evaluatedAt as never,
      searchTerm: null,
      sectionReference: null,
    });
    const source = menuItems(
      await ports.catalog.getPublishedMenu(query),
      query,
      evidence.menuVersionReference,
    );
    items = Object.freeze(cart.items.map((item) => lineView(item, source)));
  }

  return items;
}
export function createCustomerCartPresentationService(ports: CustomerCartPresentationPorts) {
  return Object.freeze({
    async prepareSnapshot(value: unknown, content: ReturnType<typeof parseCustomerCartDisplay>) {
      try {
        const cart = parseCartAggregate(value);
        const display = parseCustomerCartDisplay(content, content);
        if (
          cart.brandReference !== display.brandReference ||
          cart.storeReference !== display.storeReference ||
          cart.orderType !== display.orderType ||
          !["Qr", "Web"].includes(cart.sourceChannel) ||
          Date.parse(cart.updatedAt) > Date.parse(display.evaluatedAt)
        )
          return unavailable();
        // Session binding alone does not establish Host/Participant field visibility for a shared Cart.
        if (cart.orderType === "DineIn" && cart.items.length > 0) return unavailable();
        if (
          cart.items.some(
            (item) =>
              item.quantity > 100 ||
              item.optionSelections.length > 50 ||
              item.optionSelections.some((option) => option.quantity > 100),
          )
        )
          return unavailable();
        assertCartLifecycleActive(cart.lifecycle, parseOrderingInstant(display.evaluatedAt));

        const items = await catalogLines(ports, cart, display);
        return parseCartItemPresentationSnapshot(
          {
            schemaVersion: 1,
            brandName: display.brandName,
            storeName: display.storeName,
            serviceMode: display.serviceMode,
            items: items.map((item) => ({
              cartItemReference: item.cartItemReference,
              displayName: item.displayName,
              configuration: item.configuration.map((option) => ({
                optionReference: option.optionReference,
                displayName: option.displayName,
              })),
            })),
          },
          cart,
        );
      } catch {
        return unavailable();
      }
    },
    async getView(
      value: unknown,
      content: ReturnType<typeof parseCustomerCartDisplay>,
    ): Promise<CustomerCartView> {
      try {
        const cart = parseCartAggregate(value);
        const display = parseCustomerCartDisplay(content, content);
        if (
          cart.brandReference !== display.brandReference ||
          cart.storeReference !== display.storeReference ||
          cart.orderType !== display.orderType ||
          !["Qr", "Web"].includes(cart.sourceChannel) ||
          Date.parse(cart.updatedAt) > Date.parse(display.evaluatedAt)
        )
          return unavailable();
        // Session binding alone does not establish Host/Participant field visibility for a shared Cart.
        if (cart.orderType === "DineIn" && cart.items.length > 0) return unavailable();
        if (
          cart.items.some(
            (item) =>
              item.quantity > 100 ||
              item.optionSelections.length > 50 ||
              item.optionSelections.some((option) => option.quantity > 100),
          )
        )
          return unavailable();
        const lifecycle = assertCartLifecycleActive(
          cart.lifecycle,
          parseOrderingInstant(display.evaluatedAt),
        );
        const request = Object.freeze({
          brandReference: cart.brandReference,
          storeReference: cart.storeReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
        });
        const state = closed(await ports.quotes.resolve(request), [
          ...Object.keys(request),
          "quoteStatus",
        ]);
        if (
          state.quoteStatus !== "None" ||
          Object.entries(request).some(([key, value]) => state[key] !== value)
        )
          return unavailable();
        const items = await catalogLines(ports, cart, display);
        return Object.freeze({
          schemaVersion: 1,
          cart: Object.freeze({
            cartReference: cart.cartReference,
            version: cart.aggregateVersion,
            orderType: cart.orderType,
            serviceMode: display.serviceMode,
            context: Object.freeze({ brandName: display.brandName, storeName: display.storeName }),
            lifecycle: Object.freeze({
              status: lifecycle.status,
              idleExpiresAt: lifecycle.idleExpiresAt,
              absoluteExpiresAt: lifecycle.absoluteExpiresAt,
            }),
            items,
            quote: null,
            warnings: Object.freeze([]),
          }),
        });
      } catch {
        return unavailable();
      }
    },
  });
}

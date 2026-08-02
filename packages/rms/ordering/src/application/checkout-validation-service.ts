import { assertGuestSessionUsable, createGuestSession } from "@bop/identity";
import type { CatalogSelectionAccepted } from "@rms/catalog";
import { parseCartQuoteAttachment } from "../domain/cart-quote-attachment.js";
import {
  CheckoutValidationError,
  parseCheckoutValidationEvidence,
  type CheckoutCatalogLineEvidence,
  type CheckoutFulfillmentAccepted,
  type CheckoutFulfillmentRejectionReason,
  type CheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
import {
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type CartItem,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type { CheckoutValidationPorts } from "./ports/checkout-validation-ports.js";

function fail(code: ConstructorParameters<typeof CheckoutValidationError>[0]): never {
  throw new CheckoutValidationError(code);
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return fail("CHECKOUT_INPUT_INVALID");
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("CHECKOUT_INPUT_INVALID");
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return fail("CHECKOUT_INPUT_INVALID");
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return fail("CHECKOUT_INPUT_INVALID");
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("CHECKOUT_INPUT_INVALID");
  return value as number;
}

function dependency<T>(operation: Promise<T>): Promise<T> {
  return operation.catch(() => fail("CHECKOUT_DEPENDENCY_UNAVAILABLE"));
}

function sessionScope(sessionValue: unknown, cart: CartAggregate, observedAt: OrderingInstant) {
  try {
    const session = assertGuestSessionUsable(createGuestSession(sessionValue as never), observedAt);
    if (
      parseOrderingReference(session.brandReference) !== cart.brandReference ||
      parseOrderingReference(session.storeReference) !== cart.storeReference ||
      !["Qr", "Web"].includes(cart.sourceChannel) ||
      session.channel !== cart.orderType ||
      (cart.orderType === "Pickup" &&
        (parseOrderingReference(session.sessionReference) !== cart.createdByActorReference ||
          session.diningState !== "ContextOnly" ||
          session.diningSessionReference !== null ||
          session.diningParticipantReference !== null)) ||
      (cart.orderType === "DineIn" &&
        (session.diningState !== "DiningBound" ||
          session.diningSessionReference === null ||
          parseOrderingReference(session.diningSessionReference) !== cart.diningSessionReference ||
          session.diningParticipantReference === null))
    )
      throw new Error("denied");
    return session;
  } catch {
    return fail("CHECKOUT_PERMISSION_DENIED");
  }
}

function catalogEvidence(
  result: CatalogSelectionAccepted,
  cart: CartAggregate,
  item: CartItem,
  observedAt: OrderingInstant,
): CheckoutCatalogLineEvidence {
  try {
    const attached = item.catalogSelectionEvidence;
    const resultBrandReference = parseOrderingReference(result.brandReference);
    const resultStoreReference = parseOrderingReference(result.storeReference);
    const resultSellableReference = parseOrderingReference(result.sellableReference);
    const resultValidatedAt = parseOrderingInstant(result.validatedAt);
    const resultMenuVersionReference = parseOrderingReference(result.menuVersionReference);
    const resultProductVersionReference = parseOrderingReference(result.productVersionReference);
    if (
      attached === null ||
      resultBrandReference !== cart.brandReference ||
      resultStoreReference !== cart.storeReference ||
      result.sourceChannel !== cart.sourceChannel ||
      result.orderType !== cart.orderType ||
      resultSellableReference !== item.sellableReference ||
      resultValidatedAt !== observedAt
    )
      return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
    if (
      resultMenuVersionReference !== attached.menuVersionReference ||
      resultProductVersionReference !== attached.productVersionReference ||
      result.catalogChannelCode !== attached.catalogChannelCode ||
      result.catalogOrderTypeCode !== attached.catalogOrderTypeCode ||
      !Array.isArray(result.optionSelections) ||
      result.optionSelections.length !== item.optionSelections.length ||
      result.optionSelections.some(
        (selection, index) =>
          parseOrderingReference(selection.optionReference) !==
            item.optionSelections[index]?.optionReference ||
          selection.quantity !== item.optionSelections[index]?.quantity,
      ) ||
      !Array.isArray(result.ruleEvidence) ||
      result.ruleEvidence.length !== attached.ruleEvidence.length ||
      result.ruleEvidence.some(
        (rule, index) =>
          parseOrderingReference(rule.bindingReference) !==
            attached.ruleEvidence[index]?.bindingReference ||
          parseOrderingReference(rule.optionSetVersionReference) !==
            attached.ruleEvidence[index]?.optionSetVersionReference,
      )
    )
      return fail("CHECKOUT_REQUOTE_REQUIRED");
    return Object.freeze({
      cartItemReference: item.cartItemReference,
      sellableReference: item.sellableReference,
      menuVersionReference: resultMenuVersionReference,
      productVersionReference: resultProductVersionReference,
      validatedAt: resultValidatedAt,
    });
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
  }
}

function fulfillment(
  value: CheckoutFulfillmentAccepted,
  cart: CartAggregate,
  quoteReference: OrderingReference,
  observedAt: OrderingInstant,
): CheckoutFulfillmentAccepted {
  try {
    const expectedFields = [
      "status",
      "brandReference",
      "storeReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "orderType",
      "sourceChannel",
      "evidenceReference",
      "evidenceVersion",
      "evidenceDigest",
      "checkedAt",
      "validUntil",
    ];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== expectedFields.length ||
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !expectedFields.includes(key),
      ) ||
      expectedFields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      })
    )
      throw new Error("invalid");
    const evidenceReference = parseOrderingReference(value.evidenceReference);
    const evidenceDigest = parseOrderingHash(value.evidenceDigest);
    const checkedAt = parseOrderingInstant(value.checkedAt);
    const validUntil = parseOrderingInstant(value.validUntil);
    if (
      value.status !== "Accepted" ||
      parseOrderingReference(value.brandReference) !== cart.brandReference ||
      parseOrderingReference(value.storeReference) !== cart.storeReference ||
      parseOrderingReference(value.cartReference) !== cart.cartReference ||
      value.cartVersion !== cart.aggregateVersion ||
      parseOrderingReference(value.quoteReference) !== quoteReference ||
      value.orderType !== cart.orderType ||
      value.sourceChannel !== cart.sourceChannel ||
      value.evidenceVersion < 1 ||
      !Number.isSafeInteger(value.evidenceVersion) ||
      checkedAt !== observedAt ||
      Date.parse(validUntil) <= Date.parse(observedAt)
    )
      throw new Error("invalid");
    return Object.freeze({
      status: "Accepted",
      brandReference: cart.brandReference,
      storeReference: cart.storeReference,
      cartReference: cart.cartReference,
      cartVersion: cart.aggregateVersion,
      quoteReference,
      orderType: cart.orderType,
      sourceChannel: cart.sourceChannel,
      evidenceReference,
      evidenceVersion: value.evidenceVersion,
      evidenceDigest,
      checkedAt,
      validUntil,
    });
  } catch {
    return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
  }
}

function rejected(reason: CheckoutFulfillmentRejectionReason): never {
  if (reason === "STORE_CLOSED") return fail("CHECKOUT_STORE_CLOSED");
  if (reason === "CAPACITY_UNAVAILABLE") return fail("CHECKOUT_CAPACITY_UNAVAILABLE");
  return fail("CHECKOUT_FULFILLMENT_UNAVAILABLE");
}

function fulfillmentRejection(value: unknown): CheckoutFulfillmentRejectionReason {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(value).length !== 2 ||
      !["status", "reason"].every((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor !== undefined &&
          Object.hasOwn(descriptor, "value") &&
          descriptor.get === undefined &&
          descriptor.set === undefined &&
          descriptor.enumerable
        );
      }) ||
      descriptors.status?.value !== "Rejected" ||
      !["STORE_CLOSED", "CAPACITY_UNAVAILABLE", "FULFILLMENT_UNAVAILABLE"].includes(
        String(descriptors.reason?.value),
      )
    )
      return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
    return descriptors.reason?.value as CheckoutFulfillmentRejectionReason;
  } catch (error) {
    if (error instanceof CheckoutValidationError) throw error;
    return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
  }
}

export function createCheckoutValidationService(ports: CheckoutValidationPorts) {
  return Object.freeze({
    async validate(value: unknown): Promise<CheckoutValidationEvidence> {
      const raw = exact(value, [
        "validationReference",
        "cartReference",
        "expectedCartVersion",
        "quoteReference",
        "requestedAt",
      ]);
      const validationReference = parseOrderingReference(raw.validationReference);
      const cartReference = parseOrderingReference(raw.cartReference);
      const expectedCartVersion = version(raw.expectedCartVersion);
      const quoteReference = parseOrderingReference(raw.quoteReference);
      const requestedAt = parseOrderingInstant(raw.requestedAt);
      let validationIntentHash: ReturnType<typeof parseOrderingHash>;
      try {
        validationIntentHash = parseOrderingHash(
          ports.references.hashIntent(
            `ValidateCheckout:${JSON.stringify({ validationReference, cartReference, expectedCartVersion, quoteReference, requestedAt })}`,
          ),
        );
      } catch {
        return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
      }
      const authorized = await dependency(
        ports.authorization.authorize({
          action: "ValidateCheckout",
          cartReference,
          validationReference,
          observedAt: requestedAt,
        }),
      );
      if (authorized === null) return fail("CHECKOUT_PERMISSION_DENIED");
      const [loadedCart, loadedQuote] = await Promise.all([
        dependency(ports.repository.loadCart(cartReference)),
        dependency(ports.repository.loadQuote(cartReference)),
      ]);
      if (loadedCart === null) return fail("CHECKOUT_CART_UNAVAILABLE");
      let cart: CartAggregate;
      try {
        cart = parseCartAggregate(loadedCart);
      } catch {
        return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
      }
      if (cart.aggregateVersion !== expectedCartVersion)
        return fail("CHECKOUT_CART_VERSION_CONFLICT");
      try {
        assertCartLifecycleActive(cart.lifecycle, requestedAt);
      } catch {
        return fail("CHECKOUT_CART_NOT_ACTIVE");
      }
      const session = sessionScope(authorized.guestSession, cart, requestedAt);
      if (cart.items.length === 0) return fail("CHECKOUT_CART_EMPTY");
      if (loadedQuote === null) return fail("CHECKOUT_QUOTE_MISSING");
      let quote: ReturnType<typeof parseCartQuoteAttachment>;
      try {
        quote = parseCartQuoteAttachment(loadedQuote);
      } catch {
        return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
      }
      if (
        quote.cartReference !== cart.cartReference ||
        quote.brandReference !== cart.brandReference ||
        quote.storeReference !== cart.storeReference ||
        quote.cartVersion !== cart.aggregateVersion ||
        quote.quoteReference !== quoteReference ||
        quote.lines.length !== cart.items.length
      )
        return fail("CHECKOUT_REQUOTE_REQUIRED");
      if (Date.parse(requestedAt) >= Date.parse(quote.quoteExpiresAt))
        return fail("CHECKOUT_QUOTE_EXPIRED");
      const quoteLines = new Map(quote.lines.map((line) => [line.lineReference, line]));
      if (
        quoteLines.size !== cart.items.length ||
        cart.items.some((item) => {
          const line = quoteLines.get(item.cartItemReference);
          return (
            line === undefined ||
            line.sellableReference !== item.sellableReference ||
            line.quantity !== item.quantity ||
            line.menuVersionReference !== item.catalogSelectionEvidence?.menuVersionReference ||
            line.productVersionReference !== item.catalogSelectionEvidence?.productVersionReference
          );
        })
      )
        return fail("CHECKOUT_REQUOTE_REQUIRED");
      const catalogResults = await Promise.all(
        cart.items.map((item) =>
          dependency(
            ports.catalog.validateSelection({
              brandReference: cart.brandReference as never,
              storeReference: cart.storeReference as never,
              sourceChannel: cart.sourceChannel,
              orderType: cart.orderType,
              sellableReference: item.sellableReference as never,
              optionSelections: item.optionSelections as never,
              observedAt: requestedAt as never,
            }),
          ),
        ),
      );
      const catalogLines = Object.freeze(
        catalogResults.map((result, index) => {
          if (result.status === "Rejected")
            return fail(
              result.reason === "SELLABLE_UNAVAILABLE"
                ? "CHECKOUT_ITEM_UNAVAILABLE"
                : "CHECKOUT_SELECTION_INVALID",
            );
          return catalogEvidence(result, cart, cart.items[index] as CartItem, requestedAt);
        }),
      );
      const fulfillmentResult = await dependency(
        ports.fulfillment.validate({
          brandReference: cart.brandReference,
          storeReference: cart.storeReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          quoteReference,
          orderType: cart.orderType,
          sourceChannel: cart.sourceChannel,
          observedAt: requestedAt,
        }),
      );
      if (fulfillmentResult.status === "Rejected")
        return rejected(fulfillmentRejection(fulfillmentResult));
      const acceptedFulfillment = fulfillment(fulfillmentResult, cart, quoteReference, requestedAt);
      const validUntil = parseOrderingInstant(
        new Date(
          Math.min(
            Date.parse(quote.quoteExpiresAt),
            Date.parse(acceptedFulfillment.validUntil),
            Date.parse(cart.lifecycle?.idleExpiresAt ?? quote.quoteExpiresAt),
            Date.parse(cart.lifecycle?.absoluteExpiresAt ?? quote.quoteExpiresAt),
          ),
        ).toISOString(),
      );
      if (Date.parse(validUntil) <= Date.parse(requestedAt))
        return fail("CHECKOUT_DEPENDENCY_UNAVAILABLE");
      return parseCheckoutValidationEvidence({
        validationReference,
        validationIntentHash,
        guestSessionReference: parseOrderingReference(session.sessionReference),
        brandReference: cart.brandReference,
        storeReference: cart.storeReference,
        cartReference: cart.cartReference,
        cartVersion: cart.aggregateVersion,
        quoteReference: quote.quoteReference,
        quoteVersion: 1,
        quoteInputDigest: quote.quoteInputDigest,
        orderType: cart.orderType,
        sourceChannel: cart.sourceChannel,
        catalogLines,
        fulfillment: acceptedFulfillment,
        validatedAt: requestedAt,
        validUntil,
      });
    },
  });
}

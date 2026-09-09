import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import type { PriceQuoteSnapshot } from "@rms/pricing";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
  type CartQuoteLineEvidence,
  type CartQuoteMoney,
} from "../domain/cart-quote-attachment.js";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import type { CartQuoteAttachmentPorts } from "./ports/cart-quote-attachment-ports.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const currencyPattern = /^[A-Z]{3}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const warningPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const minimumMinor = -(2n ** 63n);
const maximumMinor = 2n ** 63n - 1n;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function quoteInvalid(): never {
  throw new CartError("CART_QUOTE_INVALID");
}

function exact(value: unknown, fields: readonly string[], quote = false) {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return quote ? quoteInvalid() : invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return quote ? quoteInvalid() : invalid();
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
        return quote ? quoteInvalid() : invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CartError) throw error;
    return quote ? quoteInvalid() : invalid();
  }
}

function array(value: unknown, maximum = 100): readonly unknown[] {
  try {
    if (!Array.isArray(value) || value.length > maximum) return quoteInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return quoteInvalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CartError) throw error;
    return quoteInvalid();
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function quoteVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return quoteInvalid();
  return value as number;
}

function money(value: unknown, currencyCode: string): CartQuoteMoney {
  const raw = exact(value, ["amountMinor", "currencyCode"], true);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < minimumMinor ||
    raw.amountMinor > maximumMinor ||
    raw.amountMinor < 0n ||
    raw.currencyCode !== currencyCode
  )
    return quoteInvalid();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode });
}

function safeWarnings(value: unknown): readonly string[] {
  return Object.freeze(
    array(value).map((warning) => {
      if (typeof warning !== "string" || !warningPattern.test(warning)) return quoteInvalid();
      return warning;
    }),
  );
}

function sessionScope(
  sessionValue: GuestSession,
  scope: {
    brandReference: OrderingReference;
    storeReference: OrderingReference;
    cartReference: OrderingReference;
    orderType?: CartAggregate["orderType"];
    sourceChannel?: CartAggregate["sourceChannel"];
    createdByActorReference?: OrderingReference;
    diningSessionReference?: OrderingReference | null;
  },
  observedAt: OrderingInstant,
): GuestSession {
  try {
    const session = assertGuestSessionUsable(createGuestSession(sessionValue), observedAt);
    if (
      parseOrderingReference(session.brandReference) !== scope.brandReference ||
      parseOrderingReference(session.storeReference) !== scope.storeReference ||
      !["Qr", "Web"].includes(scope.sourceChannel ?? "Qr") ||
      (scope.orderType !== undefined && session.channel !== scope.orderType) ||
      (scope.orderType === "Pickup" &&
        (parseOrderingReference(session.sessionReference) !== scope.createdByActorReference ||
          session.diningState !== "ContextOnly" ||
          session.diningSessionReference !== null ||
          session.diningParticipantReference !== null)) ||
      (scope.orderType === "DineIn" &&
        (session.diningState !== "DiningBound" ||
          session.diningSessionReference === null ||
          parseOrderingReference(session.diningSessionReference) !== scope.diningSessionReference ||
          session.diningParticipantReference === null))
    )
      throw new Error("denied");
    return session;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function audit(
  evidence: AppendAuditRecordInput,
  scope: {
    brandReference: OrderingReference;
    storeReference: OrderingReference;
    cartReference: OrderingReference;
  },
  at: OrderingInstant,
) {
  try {
    const parsed = validateAuditRecord(evidence, Date.parse(at));
    if (
      parsed.brandId !== scope.brandReference ||
      parsed.storeId !== scope.storeReference ||
      parsed.actor.type !== "System" ||
      parsed.actionCode !== "ORDERING_CART_ATTACH_QUOTE" ||
      parsed.targetType !== "OrderingCart" ||
      parsed.targetId !== scope.cartReference ||
      parsed.beforeSummary !== undefined ||
      parsed.afterSummary !== undefined ||
      parsed.reasonCode !== "AUTHORIZED_CART_QUOTE" ||
      parsed.occurredAt !== at ||
      parsed.sourceChannel !== "CUSTOMER_PWA" ||
      parsed.dataClassification !== "Restricted"
    )
      throw new Error("denied");
    return parsed;
  } catch {
    throw new CartError("CART_PERMISSION_DENIED");
  }
}

function dependency(error: unknown): never {
  if (error instanceof CartError) throw error;
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}

function verifiedLine(value: unknown, currencyCode: string) {
  const raw = exact(
    value,
    [
      "lineReference",
      "sellableReference",
      "productVersionReference",
      "menuVersionReference",
      "quantity",
      "unitPrice",
      "subtotal",
      "discount",
      "tax",
      "fee",
      "total",
      "resolvedPrice",
      "taxResolution",
      "taxLines",
    ],
    true,
  );
  const quantity = quoteVersion(raw.quantity);
  if (quantity > 999) return quoteInvalid();
  const unitPrice = money(raw.unitPrice, currencyCode);
  const subtotal = money(raw.subtotal, currencyCode);
  const discount = money(raw.discount, currencyCode);
  const tax = money(raw.tax, currencyCode);
  const fee = money(raw.fee, currencyCode);
  const total = money(raw.total, currencyCode);
  if (
    unitPrice.amountMinor * BigInt(quantity) !== subtotal.amountMinor ||
    subtotal.amountMinor - discount.amountMinor + tax.amountMinor + fee.amountMinor !==
      total.amountMinor
  )
    return quoteInvalid();
  return Object.freeze({
    evidence: Object.freeze({
      lineReference: parseOrderingReference(raw.lineReference),
      sellableReference: parseOrderingReference(raw.sellableReference),
      productVersionReference: parseOrderingReference(raw.productVersionReference),
      menuVersionReference: parseOrderingReference(raw.menuVersionReference),
      quantity,
    }) satisfies CartQuoteLineEvidence,
    subtotal,
    discount,
    tax,
    fee,
    total,
  });
}

function verifyQuote(
  value: PriceQuoteSnapshot,
  cart: CartAggregate,
  operationReference: OrderingReference,
  intent: ReturnType<typeof parseOrderingHash>,
  guestSessionReference: OrderingReference,
  requestedAt: OrderingInstant,
): CartQuoteAttachment {
  try {
    const raw = exact(
      value,
      [
        "quoteReference",
        "quoteVersion",
        "brandReference",
        "storeReference",
        "cartReference",
        "cartVersion",
        "inputDigest",
        "currencyMetadata",
        "subtotal",
        "discount",
        "tax",
        "fee",
        "total",
        "lines",
        "appliedPromotionReferences",
        "warnings",
        "blockingReasons",
        "createdAt",
        "expiresAt",
      ],
      true,
    );
    const quoteReference = parseOrderingReference(raw.quoteReference);
    const quoteCreatedAt = parseOrderingInstant(raw.createdAt);
    const quoteExpiresAt = parseOrderingInstant(raw.expiresAt);
    if (
      raw.quoteVersion !== 1 ||
      parseOrderingReference(raw.brandReference) !== cart.brandReference ||
      parseOrderingReference(raw.storeReference) !== cart.storeReference ||
      parseOrderingReference(raw.cartReference) !== cart.cartReference ||
      raw.cartVersion !== cart.aggregateVersion ||
      Date.parse(quoteCreatedAt) > Date.parse(requestedAt)
    )
      return quoteInvalid();
    if (Date.parse(requestedAt) >= Date.parse(quoteExpiresAt))
      throw new CartError("CART_QUOTE_EXPIRED");
    if (!digestPattern.test(String(raw.inputDigest))) return quoteInvalid();
    const metadata = exact(
      raw.currencyMetadata,
      [
        "currencyCode",
        "minorUnitExponent",
        "metadataVersion",
        "metadataVersionReference",
        "metadataDigest",
      ],
      true,
    );
    if (
      typeof metadata.currencyCode !== "string" ||
      !currencyPattern.test(metadata.currencyCode) ||
      !Number.isSafeInteger(metadata.minorUnitExponent) ||
      (metadata.minorUnitExponent as number) < 0 ||
      (metadata.minorUnitExponent as number) > 6 ||
      !digestPattern.test(String(metadata.metadataDigest))
    )
      return quoteInvalid();
    const currencyCode = metadata.currencyCode;
    const subtotal = money(raw.subtotal, currencyCode);
    const discount = money(raw.discount, currencyCode);
    const tax = money(raw.tax, currencyCode);
    const fee = money(raw.fee, currencyCode);
    const total = money(raw.total, currencyCode);
    if (
      subtotal.amountMinor - discount.amountMinor + tax.amountMinor + fee.amountMinor !==
      total.amountMinor
    )
      return quoteInvalid();
    if (array(raw.blockingReasons).length !== 0) return quoteInvalid();
    array(raw.appliedPromotionReferences).forEach((reference) => parseOrderingReference(reference));
    const verifiedLines = array(raw.lines).map((line) => verifiedLine(line, currencyCode));
    const lines = verifiedLines.map((line) => line.evidence);
    if (lines.length !== cart.items.length || lines.length === 0) return quoteInvalid();
    const quoteLines = new Map(lines.map((line) => [line.lineReference, line]));
    if (quoteLines.size !== lines.length) return quoteInvalid();
    const sum = (field: "subtotal" | "discount" | "tax" | "fee" | "total") =>
      verifiedLines.reduce((amount, line) => amount + line[field].amountMinor, 0n);
    if (
      sum("subtotal") !== subtotal.amountMinor ||
      sum("discount") !== discount.amountMinor ||
      sum("tax") !== tax.amountMinor ||
      sum("fee") !== fee.amountMinor ||
      sum("total") !== total.amountMinor
    )
      return quoteInvalid();
    for (const item of cart.items) {
      const evidence = item.catalogSelectionEvidence;
      const line = quoteLines.get(item.cartItemReference);
      if (
        evidence === null ||
        line === undefined ||
        line.sellableReference !== item.sellableReference ||
        line.quantity !== item.quantity ||
        line.productVersionReference !== evidence.productVersionReference ||
        line.menuVersionReference !== evidence.menuVersionReference
      )
        return quoteInvalid();
    }
    return parseCartQuoteAttachment({
      operationReference,
      operationIntentHash: intent,
      guestSessionReference,
      cartReference: cart.cartReference,
      brandReference: cart.brandReference,
      storeReference: cart.storeReference,
      cartVersion: cart.aggregateVersion,
      quoteReference,
      quoteVersion: 1,
      quoteInputDigest: raw.inputDigest,
      currencyCode,
      currencyMetadataVersion: quoteVersion(metadata.metadataVersion),
      currencyMetadataVersionReference: metadata.metadataVersionReference,
      subtotal,
      discount,
      tax,
      fee,
      total,
      lines,
      warnings: safeWarnings(raw.warnings),
      quoteCreatedAt,
      quoteExpiresAt,
      attachedAt: requestedAt,
      idempotencyExpiresAt: new Date(Date.parse(requestedAt) + dayMilliseconds).toISOString(),
    });
  } catch (error) {
    if (error instanceof CartError) {
      if (error.code === "CART_QUOTE_EXPIRED") throw error;
      throw new CartError("CART_QUOTE_INVALID");
    }
    throw new CartError("CART_QUOTE_INVALID");
  }
}

export function createCartQuoteAttachmentService(ports: CartQuoteAttachmentPorts) {
  return Object.freeze({
    async attach(value: unknown) {
      const raw = exact(value, [
        "cartReference",
        "expectedCartVersion",
        "operationReference",
        "requestedAt",
      ]);
      const cartReference = parseOrderingReference(raw.cartReference);
      const expectedCartVersion = version(raw.expectedCartVersion);
      const operationReference = parseOrderingReference(raw.operationReference);
      const requestedAt = parseOrderingInstant(raw.requestedAt);
      const intentAt = (at: OrderingInstant) =>
        parseOrderingHash(
          ports.references.hashIntent(
            `AttachQuote:${JSON.stringify({ cartReference, expectedCartVersion, operationReference, requestedAt: at })}`,
          ),
        );
      const intent = intentAt(requestedAt);
      const authorized = await ports.authorization
        .authorize({
          action: "AttachQuote",
          cartReference,
          operationReference,
          observedAt: requestedAt,
        })
        .catch(dependency);
      if (authorized === null) throw new CartError("CART_PERMISSION_DENIED");
      let session: GuestSession;
      try {
        session = assertGuestSessionUsable(
          createGuestSession(authorized.guestSession),
          requestedAt,
        );
      } catch {
        throw new CartError("CART_PERMISSION_DENIED");
      }
      const guestSessionReference = parseOrderingReference(session.sessionReference);
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        try {
          const attachment = parseCartQuoteAttachment(prior);
          sessionScope(session, attachment, requestedAt);
          // Reuse the original observation for the digest, not for authorization or expiry.
          if (
            attachment.operationReference !== operationReference ||
            attachment.cartReference !== cartReference ||
            attachment.cartVersion !== expectedCartVersion ||
            attachment.guestSessionReference !== guestSessionReference ||
            !ports.references.equals(
              attachment.operationIntentHash,
              intentAt(attachment.attachedAt),
            ) ||
            Date.parse(requestedAt) >= Date.parse(attachment.idempotencyExpiresAt)
          )
            throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          audit(authorized.audit, attachment, requestedAt);
          return Object.freeze({ status: "AlreadyAttached" as const, attachment });
        } catch (error) {
          if (error instanceof CartError && error.code === "CART_IDEMPOTENCY_CONFLICT") throw error;
          throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        }
      }
      const loaded = await ports.repository.loadCart(cartReference).catch(dependency);
      if (loaded === null) throw new CartError("CART_UNAVAILABLE");
      const cart = parseCartAggregate(loaded);
      if (cart.cartReference !== cartReference) throw new CartError("CART_UNAVAILABLE");
      sessionScope(session, cart, requestedAt);
      const auditRecord = audit(authorized.audit, cart, requestedAt);
      if (cart.aggregateVersion !== expectedCartVersion)
        throw new CartError("CART_VERSION_CONFLICT");
      assertCartLifecycleActive(cart.lifecycle, requestedAt);
      if (
        cart.items.length === 0 ||
        cart.items.some((item) => item.catalogSelectionEvidence === null)
      )
        throw new CartError("CART_QUOTE_INVALID");
      const quote = await ports.pricing
        .quoteCart({
          brandReference: cart.brandReference,
          storeReference: cart.storeReference,
          cartReference: cart.cartReference,
          cartVersion: cart.aggregateVersion,
          sourceChannel: cart.sourceChannel,
          orderType: cart.orderType,
          lines: Object.freeze(
            cart.items.map((item) => ({
              lineReference: item.cartItemReference,
              sellableReference: item.sellableReference,
              quantity: item.quantity,
              optionSelections: item.optionSelections,
              catalogSelectionEvidence: item.catalogSelectionEvidence as NonNullable<
                typeof item.catalogSelectionEvidence
              >,
            })),
          ),
          requestedAt,
        })
        .catch(dependency);
      const attachment = verifyQuote(
        quote,
        cart,
        operationReference,
        intent,
        guestSessionReference,
        requestedAt,
      );
      const saved = await ports.repository
        .attach({ attachment, expectedCartVersion, audit: auditRecord })
        .catch(dependency);
      try {
        const result = parseCartQuoteAttachment(saved);
        assertCartLifecycleActive(cart.lifecycle, result.attachedAt);
        if (
          result.operationReference !== operationReference ||
          result.brandReference !== cart.brandReference ||
          result.storeReference !== cart.storeReference ||
          result.guestSessionReference !== guestSessionReference ||
          result.cartReference !== cartReference ||
          result.cartVersion !== expectedCartVersion ||
          Date.parse(result.attachedAt) < Date.parse(cart.updatedAt) ||
          Date.parse(requestedAt) >= Date.parse(result.idempotencyExpiresAt) ||
          !ports.references.equals(result.operationIntentHash, intentAt(result.attachedAt)) ||
          result.lines.length !== cart.items.length ||
          cart.items.some((item) => {
            const line = result.lines.find(
              (candidate) => candidate.lineReference === item.cartItemReference,
            );
            return (
              line === undefined ||
              line.quantity !== item.quantity ||
              line.sellableReference !== item.sellableReference ||
              line.productVersionReference !==
                item.catalogSelectionEvidence?.productVersionReference ||
              line.menuVersionReference !== item.catalogSelectionEvidence?.menuVersionReference
            );
          })
        )
          throw new Error("mismatch");
        return Object.freeze({ status: "Attached" as const, attachment: result });
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

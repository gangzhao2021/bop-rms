import { validateAuditRecord } from "@bop/audit";
import {
  assertGuestSessionUsable,
  createGuestSession,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import type { ValidateCatalogSelectionInput } from "@rms/catalog";
import {
  decodeConfiguredPriceQuoteSnapshot,
  encodeConfiguredPriceQuoteSnapshot,
  type ConfiguredPriceQuoteSnapshot,
} from "@rms/pricing";
import {
  CartError,
  parseCartAggregate,
  parseOrderingReference,
  parseOrderingInstant,
  parseOrderingHash,
  type CartAggregate,
} from "../domain/cart.js";
import {
  parseConfiguredCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import { parseOrderCatalogLineSnapshot } from "../domain/order-item-snapshot.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { bindConfiguredCartQuote } from "./configured-cart-quote-binding.js";
import type {
  CartQuoteAttachmentPorts,
  PricingCartInput,
} from "./ports/cart-quote-attachment-ports.js";

export interface ConfiguredCartQuotePorts {
  /** Current Identity/CSRF and Dining participation, not a cached Guest snapshot. */
  readonly authorization: CartQuoteAttachmentPorts["authorization"];
  readonly references: CartQuoteAttachmentPorts["references"];
  readonly pricing: {
    quoteCart(
      input: PricingCartInput,
      identity: {
        readonly operationReference: string;
        readonly guestSessionReference: string;
      },
    ): Promise<ConfiguredPriceQuoteSnapshot>;
  };
  readonly catalog: { capture(input: ValidateCatalogSelectionInput): Promise<unknown> };
  readonly pricingChannelCode: string;
  readonly now: () => string;
  readonly repository: {
    loadCart(reference: string): Promise<unknown>;
    resolveOperation(reference: string): Promise<unknown>;
    attach(input: {
      readonly attachment: CartQuoteAttachment<2>;
      readonly expectedCartVersion: number;
      readonly audit: Parameters<CartQuoteAttachmentPorts["repository"]["attach"]>[0]["audit"];
    }): Promise<unknown>;
  };
}
const fail = (): never => {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
};
const denied = (): never => {
  throw new CartError("CART_PERMISSION_DENIED");
};
const sameSession = (a: GuestSession, b: GuestSession) =>
  (
    [
      "sessionReference",
      "version",
      "brandReference",
      "storeReference",
      "publicStoreReference",
      "publicTableReference",
      "qrReference",
      "qrRevocationVersion",
      "channel",
      "diningState",
      "diningSessionReference",
      "diningParticipantReference",
      "locale",
      "createdAt",
      "absoluteExpiresAt",
    ] as const
  ).every((key) => a[key] === b[key]);
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

export function createConfiguredCartQuoteService(ports: ConfiguredCartQuotePorts) {
  return Object.freeze({
    async attach(value: unknown) {
      let writeAttempted = false;
      try {
        const raw = readClosedRecord(value, [
          "cartReference",
          "expectedCartVersion",
          "operationReference",
          "requestedAt",
        ]);
        const cartReference = parseOrderingReference(raw.cartReference);
        const operationReference = parseOrderingReference(raw.operationReference);
        const requestedAt = parseOrderingInstant(raw.requestedAt);
        if (
          typeof raw.expectedCartVersion !== "number" ||
          !Number.isSafeInteger(raw.expectedCartVersion) ||
          raw.expectedCartVersion < 1 ||
          raw.expectedCartVersion > 2147483647
        )
          throw new CartError("CART_INPUT_INVALID");
        const expectedCartVersion = raw.expectedCartVersion;
        let last = requestedAt;
        const now = () => {
          const at = parseOrderingInstant(ports.now());
          if (at < last) return fail();
          last = at;
          return at;
        };
        let firstSession: GuestSession | undefined;
        async function authorize() {
          const at = now();
          const found = await ports.authorization.authorize({
            action: "AttachQuote",
            cartReference,
            operationReference,
            observedAt: at,
          });
          if (found === null) return denied();
          let session: GuestSession;
          const checkedAt = now();
          try {
            session = assertGuestSessionUsable(createGuestSession(found.guestSession), checkedAt);
            if (String(session.createdAt) > checkedAt || String(session.lastSeenAt) > checkedAt)
              return denied();
          } catch {
            return denied();
          }
          if (firstSession !== undefined && !sameSession(firstSession, session)) return denied();
          firstSession ??= session;
          return { session, audit: found.audit, at };
        }
        const first = await authorize();
        function owned(value: unknown, previous?: CartAggregate) {
          if (value === null) throw new CartError("CART_UNAVAILABLE");
          const cart = parseCartAggregate(value);
          const session = first.session;
          if (
            cart.cartReference !== cartReference ||
            String(session.brandReference) !== cart.brandReference ||
            String(session.storeReference) !== cart.storeReference ||
            session.channel !== cart.orderType ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            (cart.orderType === "Pickup" &&
              (cart.createdByActorReference !== String(session.sessionReference) ||
                session.diningState !== "ContextOnly" ||
                session.diningSessionReference !== null ||
                session.diningParticipantReference !== null)) ||
            (cart.orderType === "DineIn" &&
              (session.diningState !== "DiningBound" ||
                session.diningParticipantReference === null ||
                session.diningSessionReference === null ||
                String(session.diningSessionReference) !== cart.diningSessionReference))
          )
            return denied();
          if (
            cart.updatedAt > now() ||
            (previous &&
              (cart.aggregateVersion < previous.aggregateVersion ||
                cart.updatedAt < previous.updatedAt ||
                cart.createdAt !== previous.createdAt ||
                cart.createdByActorReference !== previous.createdByActorReference ||
                cart.diningSessionReference !== previous.diningSessionReference ||
                cart.sourceChannel !== previous.sourceChannel ||
                (cart.aggregateVersion === previous.aggregateVersion &&
                  json(cart) !== json(previous))))
          )
            return fail();
          return cart;
        }
        const cart = owned(await ports.repository.loadCart(cartReference));
        if (cart.aggregateVersion < expectedCartVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        await authorize();
        const intentAt = (at: string) =>
          parseOrderingHash(
            ports.references.hashIntent(
              "AttachQuote:" +
                JSON.stringify({
                  cartReference,
                  expectedCartVersion,
                  operationReference,
                  requestedAt: at,
                }),
            ),
          );
        function receipt(value: unknown) {
          const saved = parseConfiguredCartQuoteAttachment(value);
          if (
            saved.operationReference !== operationReference ||
            saved.cartReference !== cartReference ||
            saved.brandReference !== cart.brandReference ||
            saved.storeReference !== cart.storeReference ||
            saved.cartVersion !== expectedCartVersion ||
            saved.guestSessionReference !== String(first.session.sessionReference) ||
            !ports.references.equals(saved.operationIntentHash, intentAt(saved.attachedAt)) ||
            now() < saved.attachedAt ||
            now() >= saved.idempotencyExpiresAt
          )
            throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          return saved;
        }
        const historyValue = await ports.repository.resolveOperation(operationReference);
        const history = historyValue === null ? null : receipt(historyValue);
        await authorize();
        if (history !== null) {
          owned(await ports.repository.loadCart(cartReference), cart);
          await authorize();
          return Object.freeze({
            status: "AlreadyAttached" as const,
            attachment: receipt(history),
          });
        }
        if (cart.aggregateVersion !== expectedCartVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        assertCartLifecycleActive(cart.lifecycle, now());
        if (
          cart.items.length === 0 ||
          cart.items.some((item) => item.catalogSelectionEvidence === null)
        )
          throw new CartError("CART_QUOTE_INVALID");
        const quote = decodeConfiguredPriceQuoteSnapshot(
          encodeConfiguredPriceQuoteSnapshot(
            await ports.pricing.quoteCart(
              {
                brandReference: cart.brandReference,
                storeReference: cart.storeReference,
                cartReference,
                cartVersion: expectedCartVersion,
                sourceChannel: cart.sourceChannel,
                orderType: cart.orderType,
                requestedAt: now(),
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
              },
              { operationReference, guestSessionReference: first.session.sessionReference },
            ),
          ),
        );
        await authorize();
        const catalogLines = [];
        for (const item of cart.items) {
          const snapshot = parseOrderCatalogLineSnapshot(
            await ports.catalog.capture({
              brandReference: cart.brandReference as never,
              storeReference: cart.storeReference as never,
              sourceChannel: cart.sourceChannel,
              orderType: cart.orderType,
              sellableReference: item.sellableReference as never,
              optionSelections: item.optionSelections as never,
              observedAt: now() as never,
            }),
          );
          catalogLines.push({ cartItemReference: item.cartItemReference, snapshot });
          await authorize();
        }
        const current = owned(await ports.repository.loadCart(cartReference), cart);
        if (current.aggregateVersion !== expectedCartVersion)
          throw new CartError("CART_VERSION_CONFLICT");
        const admission = await authorize();
        bindConfiguredCartQuote({
          cart: current,
          quote,
          catalogLines,
          pricingChannelCode: ports.pricingChannelCode,
          observedAt: now(),
        });
        const audit = validateAuditRecord(admission.audit, Date.parse(admission.at));
        if (
          audit.brandId !== cart.brandReference ||
          audit.storeId !== cart.storeReference ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_CART_ATTACH_QUOTE" ||
          audit.reasonCode !== "AUTHORIZED_CART_QUOTE" ||
          audit.targetType !== "OrderingCart" ||
          audit.targetId !== cartReference ||
          audit.occurredAt !== admission.at ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return denied();
        const attachment = parseConfiguredCartQuoteAttachment({
          operationReference,
          operationIntentHash: intentAt(admission.at),
          guestSessionReference: first.session.sessionReference,
          cartReference,
          brandReference: cart.brandReference,
          storeReference: cart.storeReference,
          cartVersion: expectedCartVersion,
          quoteReference: quote.quoteReference,
          quoteVersion: 2,
          quoteInputDigest: quote.inputDigest,
          currencyCode: quote.currencyMetadata.currencyCode,
          currencyMetadataVersion: quote.currencyMetadata.metadataVersion,
          currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
          subtotal: quote.subtotal,
          discount: quote.discount,
          tax: quote.tax,
          fee: quote.fee,
          total: quote.total,
          lines: quote.lines.map((line) => ({
            lineReference: line.lineReference,
            sellableReference: line.sellableReference,
            productVersionReference: line.productVersionReference,
            menuVersionReference: line.menuVersionReference,
            quantity: line.quantity,
          })),
          warnings: quote.warnings,
          quoteCreatedAt: quote.createdAt,
          quoteExpiresAt: quote.expiresAt,
          attachedAt: admission.at,
          idempotencyExpiresAt: new Date(Date.parse(admission.at) + 86400000).toISOString(),
        });
        writeAttempted = true;
        const saved = receipt(
          await ports.repository.attach({ attachment, expectedCartVersion, audit }),
        );
        for (const field of [
          "quoteReference",
          "quoteVersion",
          "quoteInputDigest",
          "currencyCode",
          "currencyMetadataVersion",
          "currencyMetadataVersionReference",
          "quoteCreatedAt",
          "quoteExpiresAt",
          "subtotal",
          "discount",
          "tax",
          "fee",
          "total",
          "lines",
          "warnings",
        ] as const)
          if (json(saved[field]) !== json(attachment[field])) return fail();
        owned(await ports.repository.loadCart(cartReference), current);
        await authorize();
        if (now() >= saved.idempotencyExpiresAt) return fail();
        return Object.freeze({ status: "Attached" as const, attachment: saved });
      } catch (error) {
        if (writeAttempted) return fail();
        if (error instanceof CartError) throw error;
        return fail();
      }
    },
  });
}

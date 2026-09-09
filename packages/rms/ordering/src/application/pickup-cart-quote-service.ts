import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  type GuestSession,
} from "@bop/identity";
import type { AppendAuditRecordInput } from "@bop/audit";
import type { PriceQuoteSnapshot } from "@rms/pricing";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { createCartQuoteAttachmentService } from "./cart-quote-attachment-service.js";
import type {
  CartQuoteAttachmentPorts,
  PricingCartInput,
} from "./ports/cart-quote-attachment-ports.js";

export interface PickupCartQuoteIdentity {
  readonly operationReference: OrderingReference;
  readonly guestSessionReference: OrderingReference;
}
export interface PickupCartQuoteOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly sessions: {
    authorize(input: {
      readonly sessionCredential: unknown;
      readonly csrfCredential: unknown;
      readonly observedAt: unknown;
    }): Promise<GuestSession>;
  };
  readonly binding: {
    current(session: GuestSession, observedAt: unknown): Promise<CartAggregate | null>;
  };
  readonly repository: CartQuoteAttachmentPorts["repository"];
  readonly references: CartQuoteAttachmentPorts["references"];
  readonly pricing: {
    quoteCart(
      input: PricingCartInput,
      identity: PickupCartQuoteIdentity,
    ): Promise<PriceQuoteSnapshot>;
  };
  readonly audit: (input: {
    readonly action: "AttachQuote";
    readonly brandReference: OrderingReference;
    readonly storeReference: OrderingReference;
    readonly sessionReference: OrderingReference;
    readonly cartReference: OrderingReference;
    readonly operationReference: OrderingReference;
    readonly observedAt: OrderingInstant;
  }) => AppendAuditRecordInput;
  readonly now: () => string;
}

function input(value: unknown) {
  const fields = [
    "sessionCredential",
    "csrfCredential",
    "cartReference",
    "expectedCartVersion",
    "operationReference",
  ];
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new Error();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      throw new Error();
    const raw: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
      raw[field] = descriptor.value;
    }
    if (
      !Number.isSafeInteger(raw.expectedCartVersion) ||
      Number(raw.expectedCartVersion) < 1 ||
      Number(raw.expectedCartVersion) > 2147483647
    )
      throw new Error();
    return Object.freeze({
      sessionCredential: parseGuestRawCredential(raw.sessionCredential),
      csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      cartReference: parseOrderingReference(raw.cartReference),
      operationReference: parseOrderingReference(raw.operationReference),
      expectedCartVersion: Number(raw.expectedCartVersion),
    });
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
}

/** Owner-internal entry; raw credentials are consumed only by current Session authorization. */
export function createPickupCartQuoteService(options: PickupCartQuoteOptions) {
  const brandReference = parseOrderingReference(options.scope.brandReference);
  const storeReference = parseOrderingReference(options.scope.storeReference);
  const at = () => {
    try {
      return parseOrderingInstant(options.now());
    } catch {
      throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    }
  };
  const authorize = async (raw: ReturnType<typeof input>, observedAt: OrderingInstant) => {
    try {
      const session = assertGuestSessionUsable(
        createGuestSession(
          await options.sessions.authorize({
            sessionCredential: raw.sessionCredential,
            csrfCredential: raw.csrfCredential,
            observedAt,
          }),
        ),
        observedAt,
      );
      if (
        String(session.brandReference) !== brandReference ||
        String(session.storeReference) !== storeReference ||
        session.channel !== "Pickup" ||
        session.diningState !== "ContextOnly" ||
        session.diningSessionReference !== null ||
        session.diningParticipantReference !== null
      )
        throw new Error();
      return session;
    } catch {
      throw new CartError("CART_PERMISSION_DENIED");
    }
  };
  function ownedCart(value: unknown, session: GuestSession, observedAt: OrderingInstant) {
    try {
      const cart = parseCartAggregate(value);
      if (
        cart.brandReference !== brandReference ||
        cart.storeReference !== storeReference ||
        cart.orderType !== "Pickup" ||
        !["Qr", "Web"].includes(cart.sourceChannel) ||
        cart.createdByActorReference !== String(session.sessionReference) ||
        cart.diningSessionReference !== null ||
        cart.updatedAt > observedAt
      )
        throw new Error();
      return cart;
    } catch {
      throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    }
  }
  return Object.freeze({
    async attach(value: unknown) {
      const raw = input(value);
      try {
        const requestedAt = at();
        const session = await authorize(raw, requestedAt);
        const bound = await options.binding.current(session, requestedAt);
        const checkedAt = at();
        if (checkedAt < requestedAt) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        const current = await authorize(raw, checkedAt);
        if (
          current.sessionReference !== session.sessionReference ||
          current.publicStoreReference !== session.publicStoreReference ||
          current.qrReference !== session.qrReference ||
          current.qrRevocationVersion !== session.qrRevocationVersion
        )
          throw new CartError("CART_PERMISSION_DENIED");
        if (bound === null) throw new CartError("CART_UNAVAILABLE");
        const cart = ownedCart(bound, current, checkedAt);
        if (cart.cartReference !== raw.cartReference) throw new CartError("CART_UNAVAILABLE");
        const identity = Object.freeze({
          operationReference: raw.operationReference,
          guestSessionReference: parseOrderingReference(current.sessionReference),
        });
        const audit = options.audit({
          action: "AttachQuote",
          brandReference,
          storeReference,
          sessionReference: identity.guestSessionReference,
          cartReference: raw.cartReference,
          operationReference: raw.operationReference,
          observedAt: checkedAt,
        });
        const service = createCartQuoteAttachmentService({
          authorization: { authorize: async () => ({ guestSession: current, audit }) },
          references: options.references,
          pricing: {
            quoteCart: (pricingInput) => options.pricing.quoteCart(pricingInput, identity),
          },
          repository: {
            resolveOperation: (reference) => options.repository.resolveOperation(reference),
            attach: (command) => options.repository.attach(command),
            loadCart: async (reference) => {
              const loaded = await options.repository.loadCart(reference);
              if (loaded === null) return null;
              const latest = ownedCart(loaded, current, checkedAt);
              if (
                latest.aggregateVersion < cart.aggregateVersion ||
                latest.updatedAt < cart.updatedAt ||
                latest.createdAt !== cart.createdAt ||
                latest.sourceChannel !== cart.sourceChannel ||
                (latest.aggregateVersion === cart.aggregateVersion &&
                  JSON.stringify(latest) !== JSON.stringify(cart))
              )
                throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
              return latest;
            },
          },
        });
        return await service.attach({
          cartReference: raw.cartReference,
          expectedCartVersion: raw.expectedCartVersion,
          operationReference: raw.operationReference,
          requestedAt: checkedAt,
        });
      } catch (error) {
        if (error instanceof CartError) throw error;
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

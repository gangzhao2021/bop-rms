import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  type GuestSession,
} from "@bop/identity";
import type { AppendAuditRecordInput } from "@bop/audit";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { createCartItemCommandService } from "./cart-item-command-service.js";
import type { CartItemCommandPorts } from "./ports/cart-item-command-ports.js";

export interface PickupCartRemovalOptions {
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
  readonly repository: CartItemCommandPorts["repository"];
  readonly references: Pick<CartItemCommandPorts["references"], "hashIntent" | "equals">;
  readonly audit: (input: {
    readonly action: "Remove";
    readonly brandReference: OrderingReference;
    readonly storeReference: OrderingReference;
    readonly sessionReference: OrderingReference;
    readonly cartReference: OrderingReference;
    readonly operationReference: OrderingReference;
    readonly observedAt: OrderingInstant;
  }) => AppendAuditRecordInput;
  readonly now: () => string;
}
export interface PickupCartRemovalResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly cartReference: OrderingReference;
  readonly cartItemReference: OrderingReference;
  readonly aggregateVersion: number;
}
function closed(value: unknown) {
  const fields = [
    "sessionCredential",
    "csrfCredential",
    "cartReference",
    "cartItemReference",
    "expectedAggregateVersion",
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
    return Object.freeze({
      sessionCredential: parseGuestRawCredential(raw.sessionCredential),
      csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      cartReference: parseOrderingReference(raw.cartReference),
      cartItemReference: parseOrderingReference(raw.cartItemReference),
      operationReference: parseOrderingReference(raw.operationReference),
      expectedAggregateVersion: raw.expectedAggregateVersion,
    });
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
}

/** Existing removal rules remain in CartItemCommandService; authorization evidence is request-local. */
export function createPickupCartRemovalService(options: PickupCartRemovalOptions) {
  const brandReference = parseOrderingReference(options.scope.brandReference);
  const storeReference = parseOrderingReference(options.scope.storeReference);
  const at = () => {
    try {
      return parseOrderingInstant(options.now());
    } catch {
      throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    }
  };
  const authorize = async (
    sessionCredential: string,
    csrfCredential: string,
    observedAt: OrderingInstant,
  ) => {
    try {
      const session = assertGuestSessionUsable(
        createGuestSession(
          await options.sessions.authorize({ sessionCredential, csrfCredential, observedAt }),
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
  return Object.freeze({
    async remove(input: unknown): Promise<PickupCartRemovalResult> {
      const raw = closed(input);
      if (
        !Number.isSafeInteger(raw.expectedAggregateVersion) ||
        Number(raw.expectedAggregateVersion) < 1
      )
        throw new CartError("CART_INPUT_INVALID");
      try {
        const requestedAt = at();
        const session = await authorize(raw.sessionCredential, raw.csrfCredential, requestedAt);
        const bound = await options.binding.current(session, requestedAt);
        const checkedAt = at();
        if (checkedAt < requestedAt) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        const current = await authorize(raw.sessionCredential, raw.csrfCredential, checkedAt);
        if (
          current.sessionReference !== session.sessionReference ||
          current.publicStoreReference !== session.publicStoreReference ||
          current.qrReference !== session.qrReference ||
          current.qrRevocationVersion !== session.qrRevocationVersion
        )
          throw new CartError("CART_PERMISSION_DENIED");
        if (bound === null) throw new CartError("CART_UNAVAILABLE");
        let cart: CartAggregate;
        try {
          cart = parseCartAggregate(bound);
          if (
            cart.brandReference !== brandReference ||
            cart.storeReference !== storeReference ||
            cart.orderType !== "Pickup" ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            cart.createdByActorReference !== String(current.sessionReference) ||
            cart.diningSessionReference !== null
          )
            throw new Error();
        } catch {
          throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        }
        if (cart.cartReference !== raw.cartReference) throw new CartError("CART_UNAVAILABLE");
        const audit = options.audit({
          action: "Remove",
          brandReference,
          storeReference,
          sessionReference: parseOrderingReference(current.sessionReference),
          cartReference: raw.cartReference,
          operationReference: raw.operationReference,
          observedAt: checkedAt,
        });
        const service = createCartItemCommandService({
          authorization: { authorize: async () => ({ guestSession: current, audit }) },
          repository: options.repository,
          references: {
            ...options.references,
            generate: () => {
              throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
            },
          },
          catalog: {
            validateSelection: async () => {
              throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
            },
          },
        });
        const result = await service.remove({
          cartReference: raw.cartReference,
          cartItemReference: raw.cartItemReference,
          expectedAggregateVersion: raw.expectedAggregateVersion,
          operationReference: raw.operationReference,
          requestedAt: checkedAt,
        });
        return Object.freeze({
          status: result.status,
          cartReference: result.aggregate.cartReference,
          cartItemReference: result.cartItemReference,
          aggregateVersion: result.aggregate.aggregateVersion,
        });
      } catch (error) {
        if (error instanceof CartError) throw error;
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

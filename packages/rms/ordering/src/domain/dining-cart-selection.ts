import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";
import { assertCartLifecycleActive, createActiveCartLifecycle } from "./cart-lifecycle.js";

export interface DiningCartSelectionDecision {
  readonly action: "Create" | "Select";
  readonly cart: CartAggregate;
  /** Zero requires the writer to prove absence under exact Session serialization. */
  readonly expectedAggregateVersion: number;
  readonly guestSessionReference: OrderingReference;
  readonly participantReference: OrderingReference;
  readonly observedAt: OrderingInstant;
}

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}
function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const captured: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

/**
 * Pure owner decision, not an authorization or commit boundary. History is the bounded complete
 * Customer Cart history for this Session, including expired/terminal/legacy rows, never current-only.
 * Call only behind live Identity/Dining authority and serialize/recheck inside the owning writer.
 */
export function decideInitialDiningCartSelection(value: unknown): DiningCartSelectionDecision {
  try {
    const raw = exact(value, [
      "brandReference",
      "storeReference",
      "diningSessionReference",
      "guestSessionReference",
      "participantReference",
      "observedAt",
      "history",
      "creation",
    ]);
    const brandReference = parseOrderingReference(raw.brandReference);
    const storeReference = parseOrderingReference(raw.storeReference);
    const diningSessionReference = parseOrderingReference(raw.diningSessionReference);
    const guestSessionReference = parseOrderingReference(raw.guestSessionReference);
    const participantReference = parseOrderingReference(raw.participantReference);
    const observedAt = parseOrderingInstant(raw.observedAt);
    if (!Array.isArray(raw.history) || Object.getPrototypeOf(raw.history) !== Array.prototype)
      return invalid();
    const length = Object.getOwnPropertyDescriptor(raw.history, "length")?.value;
    if (length !== 0 && length !== 1) throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
    if (Reflect.ownKeys(raw.history).length !== length + 1) return invalid();
    let cart: CartAggregate;
    let action: "Create" | "Select";
    let expectedAggregateVersion: number;
    if (length === 1) {
      const entry = Object.getOwnPropertyDescriptor(raw.history, "0");
      if (!entry || !("value" in entry) || !entry.enumerable || raw.creation !== null)
        return invalid();
      cart = parseCartAggregate(entry.value);
      if (
        cart.brandReference !== brandReference ||
        cart.storeReference !== storeReference ||
        cart.diningSessionReference !== diningSessionReference ||
        cart.orderType !== "DineIn" ||
        !["Qr", "Web"].includes(cart.sourceChannel) ||
        cart.updatedAt > observedAt
      )
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      assertCartLifecycleActive(cart.lifecycle, observedAt);
      action = "Select";
      expectedAggregateVersion = cart.aggregateVersion;
    } else {
      const creation = exact(raw.creation, ["cartReference", "sourceChannel", "policy"]);
      const cartReference = parseOrderingReference(creation.cartReference);
      if (creation.sourceChannel !== "Qr" && creation.sourceChannel !== "Web") return invalid();
      const policy = exact(creation.policy, [
        "policyVersionReference",
        "policyDigest",
        "idleTimeoutSeconds",
        "absoluteTimeoutSeconds",
        "validFrom",
        "validUntil",
      ]);
      const validFrom = parseOrderingInstant(policy.validFrom);
      const validUntil = parseOrderingInstant(policy.validUntil);
      if (validUntil <= validFrom) return invalid();
      if (observedAt < validFrom || observedAt >= validUntil)
        throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
      const lifecycle = createActiveCartLifecycle({
        policyVersionReference: policy.policyVersionReference,
        policyDigest: policy.policyDigest,
        idleTimeoutSeconds: policy.idleTimeoutSeconds,
        absoluteTimeoutSeconds: policy.absoluteTimeoutSeconds,
        startedAt: observedAt,
      });
      cart = parseCartAggregate({
        cartReference,
        brandReference,
        storeReference,
        orderType: "DineIn",
        sourceChannel: creation.sourceChannel,
        diningSessionReference,
        createdByActorReference: guestSessionReference,
        aggregateVersion: 1,
        createdAt: observedAt,
        updatedAt: observedAt,
        lifecycle,
        items: [],
      });
      action = "Create";
      expectedAggregateVersion = 0;
    }
    return Object.freeze({
      action,
      cart,
      expectedAggregateVersion,
      guestSessionReference,
      participantReference,
      observedAt,
    });
  } catch (error) {
    if (error instanceof CartError) throw error;
    return invalid();
  }
}

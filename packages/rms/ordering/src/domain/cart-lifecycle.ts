import {
  CartError,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "./cart.js";

export type CartLifecycleStatus = "Active" | "Abandoned" | "Expired";
export type CartTerminalReason = "CUSTOMER_ABANDONED" | "IDLE_TIMEOUT" | "ABSOLUTE_TIMEOUT";

export interface CartLifecycle {
  readonly status: CartLifecycleStatus;
  readonly policyVersionReference: OrderingReference;
  readonly policyDigest: OrderingHash;
  readonly idleTimeoutSeconds: number;
  readonly absoluteTimeoutSeconds: number;
  readonly idleExpiresAt: OrderingInstant;
  readonly absoluteExpiresAt: OrderingInstant;
  readonly terminalAt: OrderingInstant | null;
  readonly terminalReason: CartTerminalReason | null;
}

const maximumTimeoutSeconds = 365 * 24 * 60 * 60;

function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const parsed: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      parsed[field] = descriptor.value;
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof CartError) throw error;
    return invalid();
  }
}

function duration(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximumTimeoutSeconds
  )
    return invalid();
  return value as number;
}

function terminalReason(value: unknown): CartTerminalReason | null {
  if (value === null) return null;
  if (!["CUSTOMER_ABANDONED", "IDLE_TIMEOUT", "ABSOLUTE_TIMEOUT"].includes(String(value)))
    return invalid();
  return value as CartTerminalReason;
}

export function parseCartLifecycle(value: unknown): CartLifecycle | null {
  if (value === null) return null;
  const raw = exact(value, [
    "status",
    "policyVersionReference",
    "policyDigest",
    "idleTimeoutSeconds",
    "absoluteTimeoutSeconds",
    "idleExpiresAt",
    "absoluteExpiresAt",
    "terminalAt",
    "terminalReason",
  ]);
  if (!["Active", "Abandoned", "Expired"].includes(String(raw.status))) return invalid();
  const status = raw.status as CartLifecycleStatus;
  const idleTimeoutSeconds = duration(raw.idleTimeoutSeconds);
  const absoluteTimeoutSeconds = duration(raw.absoluteTimeoutSeconds);
  const idleExpiresAt = parseOrderingInstant(raw.idleExpiresAt);
  const absoluteExpiresAt = parseOrderingInstant(raw.absoluteExpiresAt);
  const terminalAt = raw.terminalAt === null ? null : parseOrderingInstant(raw.terminalAt);
  const reason = terminalReason(raw.terminalReason);
  if (
    idleTimeoutSeconds > absoluteTimeoutSeconds ||
    Date.parse(idleExpiresAt) > Date.parse(absoluteExpiresAt) ||
    (status === "Active" && (terminalAt !== null || reason !== null)) ||
    (status === "Abandoned" && (terminalAt === null || reason !== "CUSTOMER_ABANDONED")) ||
    (status === "Expired" &&
      (terminalAt === null || !["IDLE_TIMEOUT", "ABSOLUTE_TIMEOUT"].includes(reason ?? ""))) ||
    (terminalAt !== null &&
      Date.parse(terminalAt) < Date.parse(idleExpiresAt) &&
      status === "Expired")
  )
    return invalid();
  return Object.freeze({
    status,
    policyVersionReference: parseOrderingReference(raw.policyVersionReference),
    policyDigest: parseOrderingHash(raw.policyDigest),
    idleTimeoutSeconds,
    absoluteTimeoutSeconds,
    idleExpiresAt,
    absoluteExpiresAt,
    terminalAt,
    terminalReason: reason,
  });
}

export function createActiveCartLifecycle(value: unknown): CartLifecycle {
  const raw = exact(value, [
    "policyVersionReference",
    "policyDigest",
    "idleTimeoutSeconds",
    "absoluteTimeoutSeconds",
    "startedAt",
  ]);
  const idleTimeoutSeconds = duration(raw.idleTimeoutSeconds);
  const absoluteTimeoutSeconds = duration(raw.absoluteTimeoutSeconds);
  if (idleTimeoutSeconds > absoluteTimeoutSeconds) return invalid();
  const startedAt = parseOrderingInstant(raw.startedAt);
  return parseCartLifecycle({
    status: "Active",
    policyVersionReference: raw.policyVersionReference,
    policyDigest: raw.policyDigest,
    idleTimeoutSeconds,
    absoluteTimeoutSeconds,
    idleExpiresAt: new Date(Date.parse(startedAt) + idleTimeoutSeconds * 1_000).toISOString(),
    absoluteExpiresAt: new Date(
      Date.parse(startedAt) + absoluteTimeoutSeconds * 1_000,
    ).toISOString(),
    terminalAt: null,
    terminalReason: null,
  }) as CartLifecycle;
}

export function assertCartLifecycleActive(
  lifecycle: CartLifecycle | null,
  observedAt: OrderingInstant,
): CartLifecycle {
  if (lifecycle === null) throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
  if (lifecycle.status === "Abandoned") throw new CartError("CART_ABANDONED");
  if (lifecycle.status === "Expired") throw new CartError("CART_EXPIRED");
  if (
    Date.parse(observedAt) >= Date.parse(lifecycle.idleExpiresAt) ||
    Date.parse(observedAt) >= Date.parse(lifecycle.absoluteExpiresAt)
  )
    throw new CartError("CART_EXPIRED");
  return lifecycle;
}

export function advanceCartLifecycle(
  lifecycleValue: CartLifecycle | null,
  observedAt: OrderingInstant,
): CartLifecycle {
  const lifecycle = assertCartLifecycleActive(lifecycleValue, observedAt);
  const idleExpiresAt = new Date(
    Math.min(
      Date.parse(observedAt) + lifecycle.idleTimeoutSeconds * 1_000,
      Date.parse(lifecycle.absoluteExpiresAt),
    ),
  ).toISOString();
  return parseCartLifecycle({ ...lifecycle, idleExpiresAt }) as CartLifecycle;
}

export function terminateCartLifecycle(
  lifecycleValue: CartLifecycle | null,
  input: { readonly status: "Abandoned" | "Expired"; readonly terminalAt: OrderingInstant },
): CartLifecycle {
  const lifecycle = assertCartLifecycleActive(lifecycleValue, input.terminalAt);
  if (input.status === "Expired") throw new CartError("CART_EXPIRATION_NOT_DUE");
  return parseCartLifecycle({
    ...lifecycle,
    status: "Abandoned",
    terminalAt: input.terminalAt,
    terminalReason: "CUSTOMER_ABANDONED",
  }) as CartLifecycle;
}

export function expireCartLifecycle(
  lifecycleValue: CartLifecycle | null,
  evaluatedAt: OrderingInstant,
): CartLifecycle {
  if (lifecycleValue === null) throw new CartError("CART_LIFECYCLE_UNAVAILABLE");
  if (lifecycleValue.status === "Abandoned") throw new CartError("CART_ABANDONED");
  if (lifecycleValue.status === "Expired") throw new CartError("CART_EXPIRED");
  const absoluteDue = Date.parse(evaluatedAt) >= Date.parse(lifecycleValue.absoluteExpiresAt);
  const idleDue = Date.parse(evaluatedAt) >= Date.parse(lifecycleValue.idleExpiresAt);
  if (!absoluteDue && !idleDue) throw new CartError("CART_EXPIRATION_NOT_DUE");
  return parseCartLifecycle({
    ...lifecycleValue,
    status: "Expired",
    terminalAt: evaluatedAt,
    terminalReason: absoluteDue ? "ABSOLUTE_TIMEOUT" : "IDLE_TIMEOUT",
  }) as CartLifecycle;
}

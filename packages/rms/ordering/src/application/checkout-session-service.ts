import {
  parseCheckoutSessionAllocation,
  type CheckoutSessionAllocation,
} from "../domain/checkout-session-allocation.js";
import { readClosedRecord } from "@bop/identity";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import { parseCheckoutSession, type CheckoutSession } from "../domain/checkout-session.js";

export interface CheckoutSessionRequest {
  readonly createOperationReference: string;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
}
export interface CheckoutSessionAuthority {
  readonly guestSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly audit: unknown;
}
export interface CheckoutSessionPorts {
  readonly now: () => string;
  readonly nextReference: () => string;
  readonly authorize: (
    request: CheckoutSessionRequest,
    observedAt: string,
  ) => Promise<CheckoutSessionAuthority | null>;
  readonly validate: (
    request: CheckoutSessionRequest,
    allocation: CheckoutSessionAllocation,
  ) => Promise<unknown>;
  readonly repository: {
    allocate(
      candidate: CheckoutSessionAllocation,
      authority: CheckoutSessionAuthority,
    ): Promise<unknown>;
    resolveOperation(
      request: CheckoutSessionRequest,
      authority: CheckoutSessionAuthority,
    ): Promise<unknown | null>;
    /** Atomic operation uniqueness, current Cart/Quote/access fences and Audit with session.
     * A competing winner returns its original record; never replace IDs or renew validation. */
    create(
      session: CheckoutSession,
      authority: CheckoutSessionAuthority,
    ): Promise<Readonly<{ status: "Created" | "AlreadyCreated"; session: unknown }>>;
  };
}
export class CheckoutSessionServiceError extends Error {
  constructor(
    readonly code:
      "INPUT_INVALID" | "PERMISSION_DENIED" | "INTENT_CONFLICT" | "DEPENDENCY_UNAVAILABLE",
  ) {
    super("checkout session is unavailable");
    this.name = "CheckoutSessionServiceError";
  }
}
const fail = (code: CheckoutSessionServiceError["code"]): never => {
  throw new CheckoutSessionServiceError(code);
};
function request(value: unknown): CheckoutSessionRequest {
  try {
    const raw = readClosedRecord(value, [
      "createOperationReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "quoteVersion",
    ]);
    if (
      !Number.isSafeInteger(raw.cartVersion) ||
      Number(raw.cartVersion) < 1 ||
      Number(raw.cartVersion) > 2147483647 ||
      ![1, 2].includes(Number(raw.quoteVersion)) ||
      typeof raw.quoteVersion !== "number"
    )
      return fail("INPUT_INVALID");
    return Object.freeze({
      createOperationReference: parseOrderingReference(raw.createOperationReference),
      cartReference: parseOrderingReference(raw.cartReference),
      cartVersion: Number(raw.cartVersion),
      quoteReference: parseOrderingReference(raw.quoteReference),
      quoteVersion: raw.quoteVersion as 1 | 2,
    });
  } catch {
    return fail("INPUT_INVALID");
  }
}
export function createCheckoutSessionService(ports: CheckoutSessionPorts) {
  return Object.freeze({
    async create(value: unknown) {
      const input = request(value);
      try {
        let last: string | undefined;
        const now = () => {
          const at = parseOrderingInstant(ports.now());
          if (last !== undefined && at < last) return fail("DEPENDENCY_UNAVAILABLE");
          last = at;
          return at;
        };
        let original: CheckoutSessionAuthority | undefined;
        const authorize = async () => {
          const at = now();
          const found = await ports.authorize(input, at);
          if (!found) return fail("PERMISSION_DENIED");
          const authority = Object.freeze({
            guestSessionReference: parseOrderingReference(found.guestSessionReference),
            brandReference: parseOrderingReference(found.brandReference),
            storeReference: parseOrderingReference(found.storeReference),
            checkedAt: parseOrderingInstant(found.checkedAt),
            validUntil: parseOrderingInstant(found.validUntil),
            audit: found.audit,
          });
          if (
            authority.checkedAt !== at ||
            authority.validUntil <= now() ||
            (original &&
              (original.guestSessionReference !== authority.guestSessionReference ||
                original.brandReference !== authority.brandReference ||
                original.storeReference !== authority.storeReference))
          )
            return fail("PERMISSION_DENIED");
          original ??= authority;
          return authority;
        };
        const bound = (value: unknown, authority: CheckoutSessionAuthority) => {
          const session = parseCheckoutSession(value),
            evidence = session.validation;
          if (
            evidence.guestSessionReference !== authority.guestSessionReference ||
            evidence.brandReference !== authority.brandReference ||
            evidence.storeReference !== authority.storeReference
          )
            return fail("PERMISSION_DENIED");
          if (
            session.createOperationReference !== input.createOperationReference ||
            evidence.cartReference !== input.cartReference ||
            evidence.cartVersion !== input.cartVersion ||
            evidence.quoteReference !== input.quoteReference ||
            evidence.quoteVersion !== input.quoteVersion
          )
            return fail("INTENT_CONFLICT");
          if (session.createdAt > now()) return fail("DEPENDENCY_UNAVAILABLE");
          return session;
        };
        const initial = await authorize();
        const existing = await ports.repository.resolveOperation(input, initial);
        if (existing !== null) {
          const session = bound(existing, await authorize());
          return Object.freeze({ status: "AlreadyCreated" as const, session });
        }
        const proposed = parseCheckoutSessionAllocation({
          ...input,
          brandReference: initial.brandReference,
          storeReference: initial.storeReference,
          guestSessionReference: initial.guestSessionReference,
          checkoutSessionReference: ports.nextReference(),
          submissionReference: ports.nextReference(),
          paymentOperationReference: ports.nextReference(),
          allocatedAt: now(),
        });
        const allocation = parseCheckoutSessionAllocation(
          await ports.repository.allocate(proposed, initial),
        );
        for (const field of [
          "brandReference",
          "storeReference",
          "guestSessionReference",
          "createOperationReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "quoteVersion",
        ] as const)
          if (allocation[field] !== proposed[field]) return fail("INTENT_CONFLICT");
        if (allocation.allocatedAt > now()) return fail("DEPENDENCY_UNAVAILABLE");
        const validation = await ports.validate(input, allocation);
        const authority = await authorize();
        const candidate = bound(
          {
            schemaVersion: 1,
            checkoutSessionReference: allocation.checkoutSessionReference,
            createOperationReference: input.createOperationReference,
            submissionReference: allocation.submissionReference,
            paymentOperationReference: allocation.paymentOperationReference,
            validation,
            createdAt: now(),
          },
          authority,
        );
        const result = await ports.repository.create(candidate, authority);
        if (result.status !== "Created" && result.status !== "AlreadyCreated")
          return fail("DEPENDENCY_UNAVAILABLE");
        const session = bound(result.session, await authorize());
        if (
          session.checkoutSessionReference !== allocation.checkoutSessionReference ||
          session.submissionReference !== allocation.submissionReference ||
          session.paymentOperationReference !== allocation.paymentOperationReference
        )
          return fail("DEPENDENCY_UNAVAILABLE");
        if (result.status === "Created" && JSON.stringify(session) !== JSON.stringify(candidate))
          return fail("DEPENDENCY_UNAVAILABLE");
        return Object.freeze({ status: result.status, session });
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        return fail("DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  GuestSessionError,
  GuestSessionService,
  assertGuestSessionUsable,
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import { createPostgresDiningCheckoutHoldSource } from "@rms/dining";
import {
  CartCheckoutInProgressError,
  CartError,
  chooseDiningCheckoutScope,
  extendDiningCheckoutScope,
  parseOrderingReference,
  returnDiningWaitingLines,
  type DiningCheckoutScopeActor,
} from "@rms/ordering";
import type { RequestHandler, Response } from "express";
import { checkoutHoldRetrySeconds } from "./customer-checkout-hold.js";

/**
 * WP-2423 shared-table-checkout (a), pay first (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账 M38: 默认付全桌,
 * 只付我加的, 选几道菜帮别人付; DEC-DINING-CHECKOUT-SCOPE). The guest paying a round chooses its
 * dishes, from their own bound Guest Session:
 * - Choose: "Mine" (what this phone added) or "Chosen" (dishes and how many of each, anyone's).
 *   The dishes not chosen wait for the next round (Ordering 2000_520); the cart version that is
 *   left is the round, quoted, checked out and paid as always. Every dish chosen: `WholeCart`.
 * - Extend: the payer's "Keep them" before the 5-minute reservation runs out.
 * - Cancel: the payer's "Back to cart": nothing was charged, every dish is back in the cart.
 * - Return: any phone at the table gives the waiting dishes back once nobody is paying for them
 *   (the round was sent, or the reservation ran out); the cart page asks it when it reads that.
 * Another phone paying (its choice or its checkout) is the table's ordinary "someone at your table
 * is checking out" answer with Retry-After; a cart that changed is a version conflict (read it
 * again). The guest cookie, X-CSRF-Token and Idempotency-Key as every guest write; the same key
 * replays the same answer. No dish, guest or reference of another phone is in an answer.
 */
export const customerDiningCheckoutScopeRoute = "/api/v1/dine-in/checkout-scope";

export type CustomerDiningCheckoutScopeResult =
  | {
      readonly status: "Chosen";
      readonly cartVersion: number;
      readonly expiresAt: string;
      readonly setAsideUnits: number;
    }
  | { readonly status: "WholeCart" | "NothingChosen"; readonly cartVersion: number }
  | { readonly status: "Extended"; readonly expiresAt: string }
  | { readonly status: "NotLive" }
  | { readonly status: "Returned"; readonly cartVersion: number; readonly returnedUnits: number }
  | { readonly status: "NothingToReturn"; readonly cartVersion: number | null };

export class CustomerDiningCheckoutScopeError extends Error {
  constructor(
    readonly code: "NotJoined" | "Invalid" | "Changed" | "Unavailable" | "Held",
    readonly heldUntil: string | null = null,
  ) {
    super("dining checkout scope " + code);
    this.name = "CustomerDiningCheckoutScopeError";
  }
}

export interface CustomerDiningCheckoutScopeOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly transactions: {
    run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly credentials: GuestSessionServiceOptions["credentials"];
  binding(transaction: ConsumerTransaction): GuestSessionServiceOptions["binding"];
  newReference(): string;
  now(): string;
}

type Command =
  | {
      readonly action: "Choose";
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly choice: "Mine" | "Chosen";
      readonly lines: readonly { readonly cartItemReference: string; readonly quantity: number }[];
    }
  | { readonly action: "Extend" | "Cancel" | "Return" };

/** The request body, closed: unknown fields, a bad reference or count are refused. */
export function parseCustomerDiningCheckoutScopeCommand(value: unknown): Command {
  const action =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "action")?.value
      : undefined;
  if (action === "Extend" || action === "Cancel" || action === "Return") {
    readClosedRecord(value, ["action"]);
    return Object.freeze({ action });
  }
  if (action !== "Choose") throw new CustomerDiningCheckoutScopeError("Invalid");
  const raw = readClosedRecord(value, [
    "action",
    "cartReference",
    "expectedCartVersion",
    "choice",
    "lines",
  ]);
  if (
    typeof raw.expectedCartVersion !== "number" ||
    !Number.isSafeInteger(raw.expectedCartVersion) ||
    raw.expectedCartVersion < 1 ||
    (raw.choice !== "Mine" && raw.choice !== "Chosen") ||
    !Array.isArray(raw.lines) ||
    raw.lines.length > 100 ||
    (raw.choice === "Mine" && raw.lines.length !== 0) ||
    (raw.choice === "Chosen" && raw.lines.length === 0)
  )
    throw new CustomerDiningCheckoutScopeError("Invalid");
  const lines = raw.lines.map((entry: unknown) => {
    const line = readClosedRecord(entry, ["cartItemReference", "quantity"]);
    if (
      typeof line.quantity !== "number" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 999
    )
      throw new CustomerDiningCheckoutScopeError("Invalid");
    return Object.freeze({
      cartItemReference: String(parseOrderingReference(line.cartItemReference)),
      quantity: line.quantity,
    });
  });
  if (new Set(lines.map((line) => line.cartItemReference)).size !== lines.length)
    throw new CustomerDiningCheckoutScopeError("Invalid");
  return Object.freeze({
    action,
    cartReference: String(parseOrderingReference(raw.cartReference)),
    expectedCartVersion: raw.expectedCartVersion,
    choice: raw.choice,
    lines: Object.freeze(lines),
  });
}

function bound(guest: GuestSession, scope: CustomerDiningCheckoutScopeOptions["scope"]) {
  if (
    String(guest.brandReference) !== scope.brandReference ||
    String(guest.storeReference) !== scope.storeReference ||
    guest.channel !== "DineIn" ||
    guest.diningState !== "DiningBound" ||
    guest.diningSessionReference === null ||
    guest.diningParticipantReference === null
  )
    throw new CustomerDiningCheckoutScopeError("NotJoined");
  return Object.freeze({
    diningSessionReference: String(guest.diningSessionReference),
    guestSessionReference: String(guest.sessionReference),
    participantReference: String(guest.diningParticipantReference),
  }) satisfies DiningCheckoutScopeActor;
}

/**
 * Dining's public checkout-hold read, two ways: `heldByOther` is another participant's hold (the
 * caller's own checkout does not keep it from choosing), `heldByAnyone` counts every guest's hold,
 * the caller's own too (read with a reference that is no participant, as staff read it), so that
 * "Back to cart" or a give-back never moves a cart whose payment is in flight.
 */
export function diningCheckoutHoldReaders(
  holds: {
    read(input: {
      readonly diningSessionReference: string;
      readonly cartReference: string;
      readonly cartVersion: number;
      readonly participantReference: string;
      readonly observedAt: string;
    }): Promise<{ readonly heldUntil: string } | null>;
  },
  input: {
    readonly diningSessionReference: string;
    readonly participantReference: string;
    /** A fresh reference of this request (never a participant's). */
    readonly readerReference: string;
    readonly observedAt: string;
  },
) {
  const read = async (participantReference: string, cartReference: string, cartVersion: number) =>
    (
      await holds.read({
        diningSessionReference: input.diningSessionReference,
        cartReference,
        cartVersion,
        participantReference,
        observedAt: input.observedAt,
      })
    )?.heldUntil ?? null;
  return Object.freeze({
    heldByOther: (cartReference: string, cartVersion: number) =>
      read(input.participantReference, cartReference, cartVersion),
    heldByAnyone: (cartReference: string, cartVersion: number) =>
      read(input.readerReference, cartReference, cartVersion),
  });
}

const hashIntent = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");

export function createCustomerDiningCheckoutScope(options: CustomerDiningCheckoutScopeOptions) {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  return Object.freeze({
    async apply(value: unknown): Promise<CustomerDiningCheckoutScopeResult> {
      let credentials: { sessionCredential: string; csrfCredential: string };
      let operationReference: string;
      let command: Command;
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "operationReference",
          "command",
        ]);
        credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        operationReference = String(parseOrderingReference(raw.operationReference));
        command = parseCustomerDiningCheckoutScopeCommand(raw.command);
      } catch {
        throw new CustomerDiningCheckoutScopeError("Invalid");
      }
      try {
        return await options.transactions.run(async (transaction) => {
          const binding = options.binding(transaction);
          const identity = new GuestSessionService({
            credentials: options.credentials,
            binding,
            store: createPostgresGuestSessionEntryStore(
              { run: <R>(next: (tx: ConsumerTransaction) => Promise<R>) => next(transaction) },
              owner,
            ),
            admission: { consume: async () => null },
            now: options.now,
          });
          const guest = await identity.authorize({
            ...credentials,
            observedAt: parseCanonicalInstant(options.now()),
          });
          const checked = parseCanonicalInstant(options.now());
          assertGuestSessionUsable(guest, checked);
          if ((await binding.validate(guest, checked)) !== "Current")
            throw new CustomerDiningCheckoutScopeError("NotJoined");
          const actor = bound(guest, scope);
          const observedAt = options.now();
          const holds = createPostgresDiningCheckoutHoldSource(
            { run: (work) => work(transaction as never) },
            scope,
          );
          const { heldByOther, heldByAnyone } = diningCheckoutHoldReaders(holds, {
            diningSessionReference: actor.diningSessionReference,
            participantReference: actor.participantReference,
            readerReference: operationReference,
            observedAt,
          });
          const audit = (actionCode: string, cartReference: string) => ({
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" as const },
            actionCode,
            targetType: "OrderingCart",
            targetId: cartReference,
            reasonCode: "AUTHORIZED_CART_MUTATION",
            correlationId: operationReference,
            occurredAt: observedAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted" as const,
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          });
          const tx = transaction as never;
          if (command.action === "Choose")
            return chooseDiningCheckoutScope(tx, owner, {
              operationReference,
              cartReference: command.cartReference,
              expectedCartVersion: command.expectedCartVersion,
              choice: command.choice,
              lines: command.lines,
              actor,
              observedAt,
              hashIntent,
              newReference: options.newReference,
              audit: audit("ORDERING_CART_CHECKOUT_SCOPE", command.cartReference),
              heldByOther: (version) => heldByOther(command.cartReference, version),
            });
          if (command.action === "Extend")
            return extendDiningCheckoutScope(tx, owner, { operationReference, actor, observedAt });
          return returnDiningWaitingLines(tx, owner, {
            operationReference,
            action: command.action,
            actor,
            observedAt,
            newReference: options.newReference,
            audit: (cartReference) => audit("ORDERING_CART_WAITING_RETURN", cartReference),
            // The dishes never move while anyone's checkout holds the cart, the caller's own
            // included: a payment of the round in flight must meet the cart it was taken for.
            heldByOther: heldByAnyone,
          });
        });
      } catch (error) {
        if (error instanceof CustomerDiningCheckoutScopeError) throw error;
        if (error instanceof GuestSessionError)
          throw new CustomerDiningCheckoutScopeError("NotJoined");
        if (error instanceof CartCheckoutInProgressError)
          throw new CustomerDiningCheckoutScopeError("Held", error.heldUntil);
        if (error instanceof CartError) {
          if (error.code === "CART_INPUT_INVALID" || error.code === "CART_IDEMPOTENCY_CONFLICT")
            throw new CustomerDiningCheckoutScopeError("Invalid");
          if (
            error.code === "CART_VERSION_CONFLICT" ||
            error.code === "CART_PERMISSION_DENIED" ||
            error.code === "CART_UNAVAILABLE" ||
            error.code === "CART_ITEM_LIMIT_REACHED"
          )
            throw new CustomerDiningCheckoutScopeError("Changed");
        }
        throw new CustomerDiningCheckoutScopeError("Unavailable");
      }
    },
  });
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function protect(response: Response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}
function fail(
  response: Response,
  status: 400 | 404 | 409 | 503,
  code: string,
  retryAfter: number | null = null,
) {
  protect(response);
  if (status === 503) response.setHeader("Retry-After", "5");
  if (retryAfter !== null) response.setHeader("Retry-After", String(retryAfter));
  response.status(status).json({
    schemaVersion: 1,
    error: { code, messageKey: "customer.cart." + code },
  });
}

/** POST {action, …}; the guest cookie, X-CSRF-Token and Idempotency-Key as every guest write. */
export class CustomerDiningCheckoutScopeHandler {
  readonly #origin: string;
  readonly #port: ReturnType<typeof createCustomerDiningCheckoutScope>;
  readonly #now: () => string;
  constructor(options: {
    allowedOrigin: string;
    port: ReturnType<typeof createCustomerDiningCheckoutScope>;
    now: () => string;
  }) {
    this.#origin = new URL(options.allowedOrigin).origin;
    this.#port = options.port;
    this.#now = options.now;
  }
  handler(): RequestHandler {
    return async (request, response) => {
      let input: Record<string, unknown>;
      try {
        if (
          request.get("origin") !== this.#origin ||
          request.get("sec-fetch-site") !== "same-origin" ||
          Object.keys(request.query).length !== 0
        )
          throw new Error("invalid request");
        const entries = (request.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim().split("="))
          .filter(([name]) => name === "__Host-bop-guest");
        const csrf = request.headers["x-csrf-token"];
        const key = request.get("idempotency-key");
        if (
          entries.length !== 1 ||
          entries[0]?.length !== 2 ||
          !credential.test(entries[0]?.[1] ?? "") ||
          typeof csrf !== "string" ||
          !credential.test(csrf) ||
          typeof key !== "string" ||
          !reference.test(key)
        )
          throw new Error("invalid credentials");
        input = {
          sessionCredential: entries[0]?.[1],
          csrfCredential: csrf,
          operationReference: key,
          command: parseCustomerDiningCheckoutScopeCommand(request.body ?? {}),
        };
      } catch {
        fail(response, 400, "checkout_scope_request_invalid");
        return;
      }
      try {
        const result = await this.#port.apply(input);
        protect(response);
        response.status(200).json({ schemaVersion: 1, ...result });
      } catch (error) {
        const known = error instanceof CustomerDiningCheckoutScopeError ? error : null;
        if (known?.code === "Held")
          return fail(
            response,
            409,
            "cart_checkout_in_progress",
            checkoutHoldRetrySeconds(known.heldUntil ?? this.#now(), this.#now()),
          );
        if (known?.code === "Changed") return fail(response, 409, "cart_version_conflict");
        if (known?.code === "NotJoined") return fail(response, 404, "dining_not_joined");
        if (known?.code === "Invalid") return fail(response, 400, "checkout_scope_request_invalid");
        fail(response, 503, "cart_service_unavailable");
      }
    };
  }
}

export const unavailableCustomerDiningCheckoutScopeHandler: RequestHandler = (_request, response) =>
  fail(response, 503, "cart_service_unavailable");

import type { AppendAuditRecordInput } from "@bop/audit";
import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  decodePriceQuoteSnapshot,
  encodePriceQuoteSnapshot,
  parsePriceQuoteRequestRecord,
  PriceQuoteRequestError,
  type PriceQuoteRequestStore,
  type PriceQuoteSnapshot,
} from "@rms/pricing";
import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
} from "../domain/cart.js";
import {
  parseCartQuoteAttachment,
  type CartQuoteAttachment,
} from "../domain/cart-quote-attachment.js";
import {
  parseCartQuoteExpiryRecord,
  sameCartQuoteExpiryIntent,
  type CartQuoteExpiryRecord,
} from "../domain/cart-quote-expiry.js";
import type { PickupCartQuoteOptions } from "./pickup-cart-quote-service.js";

export type PickupCartQuoteExpiryResult = Readonly<
  | { status: "NoExpiredRequest" }
  | { status: "AlreadyAttached"; attachment: CartQuoteAttachment }
  | { status: "Expired"; record: CartQuoteExpiryRecord }
>;
export interface PickupCartQuoteExpiryOptions {
  readonly scope: PickupCartQuoteOptions["scope"];
  readonly sessions: PickupCartQuoteOptions["sessions"];
  readonly binding: PickupCartQuoteOptions["binding"];
  readonly requests: Pick<PriceQuoteRequestStore, "resolve">;
  readonly expiry: {
    expire(input: {
      readonly record: CartQuoteExpiryRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<unknown>;
  };
  readonly audit: (record: CartQuoteExpiryRecord) => AppendAuditRecordInput;
  readonly now: () => string;
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
const closed = (value: unknown, fields: readonly string[]) =>
  readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
function command(value: unknown) {
  try {
    const raw = closed(value, [
      "sessionCredential",
      "csrfCredential",
      "cartReference",
      "expectedCartVersion",
      "operationReference",
    ]);
    if (
      typeof raw.expectedCartVersion !== "number" ||
      !Number.isInteger(raw.expectedCartVersion) ||
      raw.expectedCartVersion < 1 ||
      raw.expectedCartVersion > 2147483647
    )
      throw new Error();
    return Object.freeze({
      sessionCredential: parseGuestRawCredential(raw.sessionCredential),
      csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      cartReference: parseOrderingReference(raw.cartReference),
      expectedCartVersion: raw.expectedCartVersion,
      operationReference: parseOrderingReference(raw.operationReference),
    });
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
}
function sameSession(a: GuestSession, b: GuestSession) {
  return (
    a.sessionReference === b.sessionReference &&
    a.publicStoreReference === b.publicStoreReference &&
    a.qrReference === b.qrReference &&
    a.qrRevocationVersion === b.qrRevocationVersion
  );
}
export function createPickupCartQuoteExpiryService(options: PickupCartQuoteExpiryOptions) {
  const rawScope = closed(options.scope, ["brandReference", "storeReference"]);
  const brandReference = parseOrderingReference(rawScope.brandReference);
  const storeReference = parseOrderingReference(rawScope.storeReference);
  const at = () => parseOrderingInstant(options.now());
  async function authorize(raw: ReturnType<typeof command>, observedAt: OrderingInstant) {
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
  }
  async function checkpoint(
    raw: ReturnType<typeof command>,
    prior?: { session: GuestSession; cart: CartAggregate; observedAt: OrderingInstant },
  ) {
    const observedAt = at();
    if (prior && observedAt < prior.observedAt) return unavailable();
    const session = await authorize(raw, observedAt);
    if (prior && !sameSession(prior.session, session))
      throw new CartError("CART_PERMISSION_DENIED");
    const value = await options.binding.current(session, observedAt);
    const cart = value === null ? null : parseCartAggregate(value);
    const checkedAt = at();
    if (checkedAt < observedAt) return unavailable();
    const current = await authorize(raw, checkedAt);
    if (!sameSession(session, current)) throw new CartError("CART_PERMISSION_DENIED");
    if (cart === null || cart.cartReference !== raw.cartReference)
      throw new CartError("CART_UNAVAILABLE");
    if (cart.aggregateVersion < raw.expectedCartVersion)
      throw new CartError("CART_VERSION_CONFLICT");
    if (
      cart.brandReference !== brandReference ||
      cart.storeReference !== storeReference ||
      cart.orderType !== "Pickup" ||
      cart.diningSessionReference !== null ||
      !["Qr", "Web"].includes(cart.sourceChannel) ||
      cart.createdByActorReference !== String(current.sessionReference) ||
      cart.updatedAt > checkedAt
    )
      return unavailable();
    if (
      prior &&
      (cart.createdAt !== prior.cart.createdAt ||
        cart.sourceChannel !== prior.cart.sourceChannel ||
        cart.aggregateVersion < prior.cart.aggregateVersion ||
        cart.updatedAt < prior.cart.updatedAt ||
        (cart.aggregateVersion === prior.cart.aggregateVersion &&
          JSON.stringify(cart) !== JSON.stringify(prior.cart)))
    )
      return unavailable();
    return Object.freeze({ session: current, cart, observedAt: checkedAt });
  }
  return Object.freeze({
    async reconcile(value: unknown): Promise<PickupCartQuoteExpiryResult> {
      const raw = command(value);
      let writeAttempted = false;
      try {
        const first = await checkpoint(raw);
        const found = await options.requests.resolve({
          operationReference: raw.operationReference,
          guestSessionReference: first.session.sessionReference,
          cartReference: raw.cartReference,
          cartVersion: raw.expectedCartVersion,
          observedAt: first.observedAt,
        });
        // Own the complete source before the next asynchronous authorization checkpoint.
        const history = found === null ? null : closed(found, ["record", "quote"]);
        const request = history === null ? null : parsePriceQuoteRequestRecord(history.record);
        const quote =
          history === null
            ? null
            : decodePriceQuoteSnapshot(
                encodePriceQuoteSnapshot(history.quote as PriceQuoteSnapshot),
              );
        const before = await checkpoint(raw, first);
        if (request === null || quote === null)
          return Object.freeze({ status: "NoExpiredRequest" });
        if (
          String(request.operationReference) !== raw.operationReference ||
          String(request.guestSessionReference) !== String(first.session.sessionReference) ||
          String(request.brandReference) !== brandReference ||
          String(request.storeReference) !== storeReference ||
          String(request.cartReference) !== raw.cartReference ||
          request.cartVersion !== raw.expectedCartVersion ||
          request.quoteReference !== quote.quoteReference ||
          String(quote.brandReference) !== brandReference ||
          String(quote.storeReference) !== storeReference ||
          String(quote.cartReference) !== raw.cartReference ||
          quote.cartVersion !== raw.expectedCartVersion ||
          quote.createdAt > request.createdAt ||
          request.createdAt >= quote.expiresAt ||
          before.observedAt < request.createdAt ||
          before.observedAt >= request.idempotencyExpiresAt
        )
          return unavailable();
        if (before.observedAt < quote.expiresAt)
          return Object.freeze({ status: "NoExpiredRequest" });
        const record = parseCartQuoteExpiryRecord({
          resolutionVersion: 1,
          brandReference,
          storeReference,
          operationReference: raw.operationReference,
          cartReference: raw.cartReference,
          cartVersion: raw.expectedCartVersion,
          guestSessionReference: first.session.sessionReference,
          quoteReference: quote.quoteReference,
          quoteInputDigest: quote.inputDigest,
          requestIntentDigest: request.intentDigest,
          quoteCreatedAt: quote.createdAt,
          quoteExpiresAt: quote.expiresAt,
          requestCreatedAt: request.createdAt,
          requestExpiresAt: request.idempotencyExpiresAt,
          expiredAt: before.observedAt,
        });
        writeAttempted = true;
        const result = await options.expiry.expire({ record, audit: options.audit(record) });
        const status = closed(result, [
          "status",
          ...(typeof result === "object" &&
          result !== null &&
          Object.getOwnPropertyDescriptor(result, "status")?.value === "Expired"
            ? ["record"]
            : ["attachment"]),
        ]);
        let resolved: PickupCartQuoteExpiryResult;
        if (status.status === "Expired") {
          const saved = parseCartQuoteExpiryRecord(status.record);
          if (!sameCartQuoteExpiryIntent(saved, record) || saved.expiredAt > record.expiredAt)
            return unavailable();
          resolved = Object.freeze({ status: "Expired", record: saved });
        } else if (status.status === "AlreadyAttached") {
          const saved = parseCartQuoteAttachment(status.attachment);
          for (const field of [
            "brandReference",
            "storeReference",
            "operationReference",
            "cartReference",
            "cartVersion",
            "guestSessionReference",
            "quoteReference",
            "quoteInputDigest",
            "quoteCreatedAt",
            "quoteExpiresAt",
          ] as const)
            if (saved[field] !== record[field]) return unavailable();
          for (const field of ["subtotal", "discount", "tax", "fee", "total"] as const)
            if (
              saved[field].amountMinor !== quote[field].amountMinor ||
              saved[field].currencyCode !== quote[field].currencyCode
            )
              return unavailable();
          if (
            saved.currencyCode !== quote.currencyMetadata.currencyCode ||
            saved.lines.length !== quote.lines.length ||
            saved.lines.some(
              (line) =>
                !quote.lines.some(
                  (other) =>
                    String(other.lineReference) === line.lineReference &&
                    String(other.sellableReference) === line.sellableReference &&
                    String(other.productVersionReference) === line.productVersionReference &&
                    String(other.menuVersionReference) === line.menuVersionReference &&
                    other.quantity === line.quantity,
                ),
            )
          )
            return unavailable();
          resolved = Object.freeze({ status: "AlreadyAttached", attachment: saved });
        } else return unavailable();
        const final = await checkpoint(raw, before);
        if (final.observedAt >= request.idempotencyExpiresAt) return unavailable();
        return resolved;
      } catch (error) {
        if (writeAttempted) return unavailable();
        if (error instanceof CartError) throw error;
        if (error instanceof PriceQuoteRequestError && error.code === "QUOTE_REQUEST_CONFLICT")
          throw new CartError("CART_IDEMPOTENCY_CONFLICT");
        return unavailable();
      }
    },
  });
}

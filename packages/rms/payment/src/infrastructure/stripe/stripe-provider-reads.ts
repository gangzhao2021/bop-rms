import { createHash } from "node:crypto";
import {
  createPaymentProviderSnapshot,
  createRetrieveIntentRequest,
  parsePaymentReference,
  parseProviderReference,
} from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import type {
  PaymentProviderSnapshot,
  RetrieveIntentRequest,
} from "../../contracts/payment-provider-adapter.js";
import {
  createStripeOnlineTransport,
  type StripeOnlineReadScope,
  type StripeOnlineTransportOptions,
} from "./stripe-online-transport.js";
import { normalizeStripeOnlineIntentResponse } from "./stripe-online-intent-response.js";

/**
 * DEC-STRIPE-PILOT-WIRING: read-only Stripe facts the pilot needs beyond create/retrieve/cancel/
 * refund — the original time of a terminal outcome, Provider-first capture discovery and the
 * balance-transaction statement of a settlement window. Raw Stripe payloads never leave this
 * module; every result is a closed, normalized value. Never a mutation.
 */
export class StripeProviderReadError extends Error {
  constructor(readonly code: "STRIPE_READ_UNAVAILABLE" | "STRIPE_READ_INVALID") {
    super("stripe provider read unavailable");
    this.name = "StripeProviderReadError";
  }
}
const unavailable = (): never => {
  throw new StripeProviderReadError("STRIPE_READ_UNAVAILABLE");
};
const invalid = (): never => {
  throw new StripeProviderReadError("STRIPE_READ_INVALID");
};
function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  return value as Record<string, unknown>;
}
function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}
const instantOf = (value: unknown) =>
  parsePaymentInstant(new Date(seconds(value) * 1000).toISOString());
const digest = (value: unknown) =>
  "sha256:" +
  createHash("sha256")
    .update(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))
    .digest("hex");

export type StripeTerminalStatus = "Captured" | "Failed" | "Cancelled";
export interface StripeTerminalObservation {
  /** Normalized snapshot; for a terminal outcome observedAt is the outcome's own time. */
  readonly snapshot: PaymentProviderSnapshot;
  readonly occurrence: null | {
    readonly status: StripeTerminalStatus;
    readonly occurredAt: string;
    readonly failureReason: null | "Declined" | "AuthenticationRequired" | "Cancelled";
  };
}

/** Reads one intent and the original time of its terminal outcome (charge or cancellation). */
export function createStripeTerminalObservationReader(
  options: StripeOnlineTransportOptions & { readonly now: () => string },
) {
  const transport = createStripeOnlineTransport(options);
  return Object.freeze({
    /**
     * `failedEventAt` is the signed event time of a verified `payment_intent.payment_failed`
     * webhook: an authentication failure creates no charge, so the event is its only time.
     */
    async read(
      input: RetrieveIntentRequest,
      { failedEventAt = null }: { readonly failedEventAt?: string | null } = {},
    ): Promise<StripeTerminalObservation> {
      const request = createRetrieveIntentRequest(input);
      let response: { status: number; payload: unknown };
      try {
        response = await transport.send(request);
      } catch {
        return unavailable();
      }
      if (response.status !== 200) return unavailable();
      const observedAt = parsePaymentInstant(options.now());
      const current = normalizeStripeOnlineIntentResponse(request, response.payload, observedAt);
      const raw = record(response.payload);
      const charge = raw.latest_charge === null ? null : record(raw.latest_charge);
      const error =
        raw.last_payment_error === null || raw.last_payment_error === undefined
          ? null
          : record(raw.last_payment_error);
      let occurrence: StripeTerminalObservation["occurrence"] = null;
      if (current.status === "Captured" && charge !== null)
        occurrence = {
          status: "Captured",
          occurredAt: instantOf(charge.created),
          failureReason: null,
        };
      else if (current.status === "Cancelled")
        occurrence = {
          status: "Cancelled",
          occurredAt: instantOf(raw.canceled_at),
          failureReason: "Cancelled",
        };
      else if (current.status === "Failed" && charge !== null)
        occurrence = {
          status: "Failed",
          occurredAt: instantOf(charge.created),
          failureReason:
            error?.code === "payment_intent_authentication_failure"
              ? "AuthenticationRequired"
              : "Declined",
        };
      else if (
        failedEventAt !== null &&
        raw.status === "requires_payment_method" &&
        charge === null &&
        error !== null
      )
        occurrence = {
          status: "Failed",
          occurredAt: parsePaymentInstant(failedEventAt),
          failureReason: "AuthenticationRequired",
        };
      if (occurrence === null) return Object.freeze({ snapshot: current, occurrence });
      if (occurrence.occurredAt > observedAt) return invalid();
      // The observation of a terminal outcome carries the outcome's own time (the terminal owner
      // binds a verified webhook to exactly that time).
      const at = occurrence.occurredAt;
      const base =
        current.status === occurrence.status
          ? normalizeStripeOnlineIntentResponse(request, response.payload, at)
          : current;
      const projected = {
        kind: "Snapshot" as const,
        context: base.context,
        providerIntentReference: base.providerIntentReference,
        providerTransactionReference: base.providerTransactionReference,
        paymentMethod: base.paymentMethod,
        captureMode: base.captureMode,
        status: occurrence.status,
        requestedAmount: base.requestedAmount,
        authorizedAmount: base.authorizedAmount,
        capturedAmount: base.capturedAmount,
        refundedAmount: base.refundedAmount,
        observedAt: at,
      };
      const snapshot = createPaymentProviderSnapshot({
        ...projected,
        evidenceDigest: digest(projected) as PaymentProviderSnapshot["evidenceDigest"],
      });
      return Object.freeze({ snapshot, occurrence: Object.freeze(occurrence) });
    },
  });
}

export interface StripeCaptureJournalRecord {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly environment: "Test" | "Live";
  readonly providerIntentReference: string;
  readonly providerTransactionReference: string;
  readonly paymentOperationReference: string;
  readonly paymentAttemptReference: string;
  readonly amount: { readonly amountMinor: bigint; readonly currencyCode: "CAD" };
  readonly createdAt: string;
  readonly occurredAt: string;
}

/**
 * Provider-first capture discovery (DEC-PILOT-PROVIDER-CAPTURE): every intent BOP created in the
 * look-back window that Stripe captured, ordered by intent reference, linked to its Payment
 * operation through the intent's own Payment metadata. Each page re-reads its intents fresh.
 */
export function createStripeCaptureJournal(
  options: StripeOnlineTransportOptions & {
    readonly now: () => string;
    readonly lookbackDays?: number;
    readonly maxListPages?: number;
  },
) {
  const transport = createStripeOnlineTransport(options);
  const lookbackDays = options.lookbackDays ?? 7;
  const maxListPages = options.maxListPages ?? 50;
  if (
    !Number.isSafeInteger(lookbackDays) ||
    lookbackDays < 1 ||
    lookbackDays > 35 ||
    !Number.isSafeInteger(maxListPages) ||
    maxListPages < 1 ||
    maxListPages > 100
  )
    throw new StripeProviderReadError("STRIPE_READ_INVALID");
  const intentReference = /^pi_[A-Za-z0-9]+$/u;
  // One discovery listing per scan cut-off; every returned record is re-read fresh.
  let listing: { cutoff: string; references: readonly string[] } | null = null;
  async function list(scope: StripeOnlineReadScope, cutoff: string) {
    if (listing?.cutoff === cutoff) return listing.references;
    const until = Math.floor(Date.parse(cutoff) / 1000);
    const since = until - lookbackDays * 86_400;
    const found = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < maxListPages; page++) {
      const query = new URLSearchParams({
        "created[gte]": String(since),
        "created[lte]": String(until),
        limit: "100",
      });
      if (after !== null) query.set("starting_after", after);
      const response = await transport.read(scope, "/v1/payment_intents?" + query.toString());
      if (response.status !== 200) return unavailable();
      const body = record(response.payload);
      if (body.object !== "list" || !Array.isArray(body.data) || typeof body.has_more !== "boolean")
        return invalid();
      for (const entry of body.data) {
        const intent = record(entry);
        if (intent.object !== "payment_intent" || typeof intent.id !== "string") return invalid();
        if (!intentReference.test(intent.id)) return invalid();
        after = intent.id;
        if (intent.status !== "succeeded") continue;
        const metadata = intent.metadata === null ? null : record(intent.metadata);
        // An intent without BOP's Payment metadata was not created by this pilot; it can't be
        // linked here and is surfaced by the daily settlement comparison instead.
        if (
          metadata === null ||
          typeof metadata.bop_payment_operation !== "string" ||
          typeof metadata.bop_payment_attempt !== "string"
        )
          continue;
        found.add(intent.id);
      }
      if (!body.has_more) {
        const references = Object.freeze([...found].sort());
        listing = { cutoff, references };
        return references;
      }
      if (body.data.length === 0) return invalid();
    }
    // More intents than the bounded scan allows: fail closed rather than miss captures.
    return unavailable();
  }
  async function fresh(scope: StripeOnlineReadScope, reference: string, cutoff: string) {
    const response = await transport.read(
      scope,
      "/v1/payment_intents/" + reference + "?expand%5B%5D=latest_charge",
    );
    if (response.status !== 200) return unavailable();
    const intent = record(response.payload);
    const metadata = record(intent.metadata);
    const operation = String(parsePaymentReference(metadata.bop_payment_operation));
    const attempt = String(parsePaymentReference(metadata.bop_payment_attempt));
    const snapshot = normalizeStripeOnlineIntentResponse(
      createRetrieveIntentRequest({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: {
          provider: "Stripe",
          environment: scope.environment,
          brandReference: parsePaymentReference(scope.brandReference),
          storeReference: parsePaymentReference(scope.storeReference),
          paymentAttemptReference: parsePaymentReference(attempt),
          operationReference: parsePaymentReference(operation),
        },
        providerIntentReference: parseProviderReference(reference),
      }),
      intent,
      cutoff,
    );
    if (snapshot.status !== "Captured" || snapshot.providerTransactionReference === null)
      return invalid();
    const charge = record(intent.latest_charge);
    const createdAt = instantOf(intent.created),
      occurredAt = instantOf(charge.created);
    if (createdAt > occurredAt || occurredAt > cutoff) return invalid();
    return Object.freeze({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      environment: scope.environment,
      providerIntentReference: reference,
      providerTransactionReference: String(snapshot.providerTransactionReference),
      paymentOperationReference: operation,
      paymentAttemptReference: attempt,
      amount: Object.freeze({
        amountMinor: snapshot.capturedAmount.amountMinor,
        currencyCode: "CAD" as const,
      }),
      createdAt,
      occurredAt,
    }) satisfies StripeCaptureJournalRecord;
  }
  return async (input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly environment: "Test" | "Live";
    readonly observedAt: string;
    readonly afterProviderIntentReference: string | null;
    readonly limit: number;
  }) => {
    try {
      const scope = {
        brandReference: String(parsePaymentReference(input.brandReference)),
        storeReference: String(parsePaymentReference(input.storeReference)),
        environment: input.environment,
      };
      const cutoff = parsePaymentInstant(input.observedAt);
      if (
        scope.environment !== options.environment ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        cutoff > parsePaymentInstant(options.now()) ||
        (input.afterProviderIntentReference !== null &&
          !intentReference.test(input.afterProviderIntentReference))
      )
        return invalid();
      const references = await list(scope, cutoff);
      const after = input.afterProviderIntentReference;
      const remaining = references.filter((reference) => after === null || reference > after);
      const page = remaining.slice(0, input.limit);
      const records: StripeCaptureJournalRecord[] = [];
      for (const reference of page) records.push(await fresh(scope, reference, cutoff));
      return Object.freeze({
        records: Object.freeze(records),
        observedAt: cutoff,
        nextAfterProviderIntentReference:
          remaining.length > input.limit ? (page.at(-1) ?? null) : null,
      });
    } catch (error) {
      if (error instanceof StripeProviderReadError) throw error;
      return unavailable();
    }
  };
}

/**
 * The Stripe balance-transaction statement of one settlement window: gross card charges and
 * refunds (net of failed refunds) by their balance-transaction time. Payout, fee and other
 * account movements are counted separately and never mixed into captured or refunded money.
 */
export function createStripeSettlementWindowSource(
  options: StripeOnlineTransportOptions & {
    readonly now: () => string;
    readonly maxListPages?: number;
  },
) {
  const transport = createStripeOnlineTransport(options);
  const maxListPages = options.maxListPages ?? 100;
  const captureTypes = new Set(["charge", "payment"]);
  const refundTypes = new Set(["refund", "payment_refund"]);
  const refundReversalTypes = new Set(["refund_failure", "payment_failure_refund"]);
  return async (input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly environment: "Test" | "Live";
    readonly startsAt: string;
    readonly endsAt: string;
  }) => {
    try {
      const scope = {
        brandReference: String(parsePaymentReference(input.brandReference)),
        storeReference: String(parsePaymentReference(input.storeReference)),
        environment: input.environment,
      };
      const startsAt = parsePaymentInstant(input.startsAt),
        endsAt = parsePaymentInstant(input.endsAt),
        observedAt = parsePaymentInstant(options.now());
      if (scope.environment !== options.environment || startsAt >= endsAt || endsAt > observedAt)
        return invalid();
      const since = Math.ceil(Date.parse(startsAt) / 1000),
        until = Math.ceil(Date.parse(endsAt) / 1000);
      let capturedAmountMinor = 0n,
        refundedAmountMinor = 0n,
        captureCount = 0,
        refundCount = 0,
        otherCount = 0;
      const events: [string, string, string, number][] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < maxListPages; page++) {
        const query = new URLSearchParams({
          "created[gte]": String(since),
          "created[lt]": String(until),
          limit: "100",
        });
        if (after !== null) query.set("starting_after", after);
        const response = await transport.read(
          scope,
          "/v1/balance_transactions?" + query.toString(),
        );
        if (response.status !== 200) return unavailable();
        const body = record(response.payload);
        if (
          body.object !== "list" ||
          !Array.isArray(body.data) ||
          typeof body.has_more !== "boolean"
        )
          return invalid();
        for (const entry of body.data) {
          const transaction = record(entry);
          const id = transaction.id,
            type = transaction.type,
            amount = transaction.amount,
            created = seconds(transaction.created);
          if (
            transaction.object !== "balance_transaction" ||
            typeof id !== "string" ||
            !/^txn_[A-Za-z0-9]+$/u.test(id) ||
            typeof type !== "string" ||
            typeof amount !== "number" ||
            !Number.isSafeInteger(amount) ||
            seen.has(id) ||
            created < since ||
            created >= until
          )
            return invalid();
          seen.add(id);
          after = id;
          if (transaction.currency !== "cad") return invalid();
          if (captureTypes.has(type)) {
            if (amount <= 0) return invalid();
            capturedAmountMinor += BigInt(amount);
            captureCount++;
          } else if (refundTypes.has(type)) {
            if (amount >= 0) return invalid();
            refundedAmountMinor += BigInt(-amount);
            refundCount++;
          } else if (refundReversalTypes.has(type)) {
            if (amount <= 0) return invalid();
            refundedAmountMinor -= BigInt(amount);
            refundCount++;
          } else {
            otherCount++;
            continue;
          }
          events.push([type, id, String(amount), created]);
        }
        if (!body.has_more) {
          events.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
          return Object.freeze({
            source: "StripeBalanceTransactions" as const,
            ...scope,
            startsAt,
            endsAt,
            observedAt,
            currencyCode: "CAD" as const,
            capturedAmountMinor,
            refundedAmountMinor,
            captureCount,
            refundCount,
            otherCount,
            evidenceDigest: digest([
              "BOP_STRIPE_SETTLEMENT_WINDOW_V1",
              scope,
              startsAt,
              endsAt,
              events,
            ]),
          });
        }
        if (body.data.length === 0) return invalid();
      }
      return unavailable();
    } catch (error) {
      if (error instanceof StripeProviderReadError) throw error;
      return unavailable();
    }
  };
}

export type StripeWebhookPaymentEvent =
  | {
      readonly kind: "IntentOutcome";
      readonly eventType:
        "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled";
      readonly providerIntentReference: string;
      readonly paymentOperationReference: string | null;
      readonly paymentAttemptReference: string | null;
      readonly createdAt: string;
    }
  | { readonly kind: "Ignored"; readonly eventType: string };

/** Closed reading of a verified Stripe event body: which intent, which Payment operation. */
export function parseStripeWebhookPaymentEvent(rawBody: Uint8Array): StripeWebhookPaymentEvent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return invalid();
  }
  const event = record(value);
  if (event.object !== "event" || typeof event.type !== "string") return invalid();
  const type = event.type;
  if (
    type !== "payment_intent.succeeded" &&
    type !== "payment_intent.payment_failed" &&
    type !== "payment_intent.canceled"
  )
    return Object.freeze({ kind: "Ignored", eventType: type.slice(0, 128) });
  const intent = record(record(event.data).object);
  if (
    intent.object !== "payment_intent" ||
    typeof intent.id !== "string" ||
    !/^pi_[A-Za-z0-9]+$/u.test(intent.id)
  )
    return invalid();
  const metadata =
    intent.metadata === null || intent.metadata === undefined ? {} : record(intent.metadata);
  const reference = (field: unknown) => {
    try {
      return String(parsePaymentReference(field));
    } catch {
      return null;
    }
  };
  return Object.freeze({
    kind: "IntentOutcome",
    eventType: type,
    providerIntentReference: intent.id,
    paymentOperationReference: reference(metadata.bop_payment_operation),
    paymentAttemptReference: reference(metadata.bop_payment_attempt),
    createdAt: instantOf(event.created),
  });
}

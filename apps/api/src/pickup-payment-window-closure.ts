import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresAsapCapacityStore } from "@rms/fulfillment";
import {
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentOperationFence,
  createPostgresPaymentTerminalStore,
  parsePaymentIntentCreationRecord,
} from "@rms/payment";
import {
  createPostgresPickupPaymentWindowCandidates,
  createPostgresPickupPaymentWindowClosure,
  parseOrderCapacityLink,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderCapacityLink,
  type PickupPaymentWindowEvidence,
} from "@rms/ordering";
import {
  createSubmissionInventoryRelease,
  type SubmissionInventoryReleaseResult,
} from "./submission-inventory-release.js";

const fail = (): never => {
  throw new Error("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE");
};
export type PickupPaymentWindowClosureOutcome = Readonly<
  | { status: "NotDue"; windowEndsAt: string }
  /** Payment captured (or capacity consumed): the paid-outcome path accepts or refunds it. */
  | { status: "Paid" }
  | { status: "NotEligible"; reason: "Accepted" | "Terminated" | "PaymentRecorded" }
  | {
      status: "Closed" | "AlreadyClosed";
      paymentEvidence: PickupPaymentWindowEvidence | null;
      inventory: SubmissionInventoryReleaseResult;
    }
>;

/**
 * Read-only Payment facts for the pickup payment operation, through Payment's owner stores.
 * A missing intent or terminal is not a failure; the caller already decided the window ended.
 */
async function observePayment(
  transaction: ConsumerTransaction,
  scope: Readonly<{
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  }>,
  link: OrderCapacityLink,
  now: () => string,
): Promise<PickupPaymentWindowEvidence | "Succeeded"> {
  const runner = { run: <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction) };
  const stored = await createPostgresPaymentIntentCreationStore(
    runner,
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
    { now, generateObservationReference: fail },
  ).resolveOperation(link.paymentOperationReference);
  if (stored === null) return "NoPaymentStarted";
  const payment = parsePaymentIntentCreationRecord(stored),
    p = payment.intent.preparation;
  if (
    String(payment.intent.paymentOperationReference) !== String(link.paymentOperationReference) ||
    String(p.brandReference) !== String(link.brandReference) ||
    String(p.storeReference) !== String(link.storeReference) ||
    String(p.orderReference) !== String(link.orderReference) ||
    String(p.orderBatchReference) !== String(link.orderBatchReference) ||
    String(p.submissionReference) !== String(link.submissionReference) ||
    String(p.guestSessionReference) !== String(link.guestSessionReference) ||
    String(p.sourceCartReference) !== String(link.cartReference) ||
    p.sourceCartVersion !== link.cartVersion ||
    String(p.quoteReference) !== String(link.quoteReference) ||
    payment.attempt.providerEnvironment !== scope.environment
  )
    return fail();
  // The terminal store accepts exactly its own scope shape (no tenant), like every Payment port.
  const terminal = await createPostgresPaymentTerminalStore(runner, {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    providerAccountReference: scope.providerAccountReference,
    environment: scope.environment,
  }).read(payment.intent.paymentIntentReference);
  if (terminal === null) return "PaymentUnresolved";
  if (
    terminal.brandReference !== scope.brandReference ||
    terminal.storeReference !== scope.storeReference ||
    terminal.paymentIntentReference !== payment.intent.paymentIntentReference ||
    String(terminal.orderReference) !== String(p.orderReference)
  )
    return fail();
  return terminal.outcome === "Succeeded" ? "Succeeded" : "PaymentFailed";
}

/**
 * WP-2423 Q12: trusted System composition. An unpaid pickup Order whose payment window ended
 * (Fulfillment's capacity expiry: payment request + 30 minutes, or the unsealed preparation
 * validity when payment never started) is closed as Cancelled by Ordering and its reserved stock
 * is released in the same transaction. Payment fences are held throughout, so no payment terminal
 * can be recorded concurrently. A payment that succeeds later is classified by the existing paid
 * outcome path as SubmissionCancelled and refunded; its stock release then finds nothing to do.
 */
export function createPickupPaymentWindowClosure(options: {
  scope: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  systemActorReference: string;
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  now(): string;
  newReference(): string;
  authorize(
    transaction: ConsumerTransaction,
    identity: Readonly<{ orderReference: string; orderBatchReference: string }>,
  ): Promise<boolean>;
  authorizeDiscovery(transaction: ConsumerTransaction, observedAt: string): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
    providerAccountReference: String(
      parseOrderingReference(options.scope.providerAccountReference),
    ),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  const candidates = createPostgresPickupPaymentWindowCandidates({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: options.authorizeDiscovery,
  });
  const release = createSubmissionInventoryRelease({
    scope,
    systemActorReference: options.systemActorReference,
    reasonCode: "PAYMENT_WINDOW_EXPIRED",
    now: options.now,
  });
  return Object.freeze({
    /** Discovery commits before closing, so no scan holds locks while Payment fences are taken. */
    discover: (input: { observedAt: string; after: string | null; limit: number }) =>
      options.transactions.run((tx) => candidates.discover(tx, input)),
    async close(value: unknown): Promise<PickupPaymentWindowClosureOutcome> {
      const candidate = value as { link?: unknown } | null;
      const link = parseOrderCapacityLink(candidate?.link);
      if (
        link.owner !== "Fulfillment" ||
        link.brandReference !== scope.brandReference ||
        link.storeReference !== scope.storeReference
      )
        return fail();
      const identity = Object.freeze({
        orderReference: String(link.orderReference),
        orderBatchReference: String(link.orderBatchReference),
      });
      return options.transactions.run(async (transaction) => {
        const allowed = async (tx: ConsumerTransaction) =>
          tx === transaction && (await options.authorize(tx, identity)) === true;
        if (!(await allowed(transaction))) return fail();
        const started = parseOrderingInstant(options.now());
        await createPostgresPaymentOperationFence({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          now: options.now,
          authorize: async (tx, query) =>
            (tx as unknown) === transaction &&
            query.orderReference === identity.orderReference &&
            query.paymentOperationReference === String(link.paymentOperationReference) &&
            (await allowed(transaction)),
        }).acquire(transaction, {
          orderReference: identity.orderReference,
          paymentOperationReference: link.paymentOperationReference,
        });
        // Fulfillment owns the payment window; read its current commitment under its fence.
        const commitment = await createPostgresAsapCapacityStore(
          { run: async (work) => work(transaction) },
          { brandReference: scope.brandReference, storeReference: scope.storeReference },
          { now: options.now },
        ).withCurrentSubmission(link.submissionReference, async (_, current) => current);
        if (
          commitment === null ||
          String(commitment.allocationReference) !== String(link.commitmentReference) ||
          String(commitment.orderReference) !== identity.orderReference ||
          String(commitment.orderBatchReference) !== identity.orderBatchReference ||
          String(commitment.paymentOperationReference) !== String(link.paymentOperationReference) ||
          String(commitment.guestSessionReference) !== String(link.guestSessionReference) ||
          String(commitment.cartReference) !== String(link.cartReference) ||
          commitment.cartVersion !== link.cartVersion ||
          String(commitment.quoteReference) !== String(link.quoteReference)
        )
          return fail();
        if (commitment.state === "Consumed") return Object.freeze({ status: "Paid" as const });
        const windowEndsAt = String(
          parseOrderingInstant(commitment.capacityExpiresAt ?? commitment.preparationValidUntil),
        );
        const observedAt = parseOrderingInstant(options.now());
        if (observedAt < started) return fail();
        if (observedAt < windowEndsAt)
          return Object.freeze({ status: "NotDue" as const, windowEndsAt });
        const payment = await observePayment(transaction, scope, link, options.now);
        if (payment === "Succeeded") return Object.freeze({ status: "Paid" as const });
        const closedAt = parseOrderingInstant(options.now());
        if (closedAt < observedAt) return fail();
        const closure = await createPostgresPickupPaymentWindowClosure({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          authorize: async (tx) => allowed(tx),
        }).close(transaction, {
          link,
          windowEndedAt: windowEndsAt,
          closedAt,
          paymentEvidence: payment,
          terminationReference: options.newReference(),
          auditReference: options.newReference(),
        });
        if (closure.status === "NotEligible") return closure;
        const record = closure.record;
        const inventory = await release.release(transaction, {
          source: {
            kind: "PickupPaymentWindowClosure/v1",
            reference: record.terminationReference,
            submissionReference: link.submissionReference,
            orderReference: identity.orderReference,
            occurredAt: record.terminatedAt,
          },
          // Same transaction and instant as the closure; a replay verifies the earlier release.
          releasedAt: closure.status === "Closed" ? record.terminatedAt : options.now(),
          authorize: async () => allowed(transaction),
        });
        if (!(await allowed(transaction))) return fail();
        return Object.freeze({
          status: closure.status,
          paymentEvidence: closure.status === "Closed" ? payment : null,
          inventory,
        });
      });
    },
  });
}

/**
 * Polling dispatcher: discovery commits before each closure transaction. A failing Order is
 * reported (without identifiers) and never blocks the others; it is retried with a doubling delay
 * (1 minute up to 1 hour) instead of on every poll, and the delay resets once it stops failing.
 */
export function createPickupPaymentWindowDispatcher(options: {
  closure: Pick<ReturnType<typeof createPickupPaymentWindowClosure>, "discover" | "close">;
  now(): string;
  pageSize: number;
  onOutcome?(outcome: PickupPaymentWindowClosureOutcome): void;
  onFailure?(code: string): void;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("PICKUP_PAYMENT_WINDOW_DISPATCHER_CONFIG_INVALID");
  let cursor: string | null = null,
    stopping = false;
  let inFlight: Promise<number> | undefined;
  const firstRetryMs = 60_000,
    maxRetryMs = 3_600_000;
  /** Per failing Order: its current retry delay and when it is due again. */
  const failing = new Map<string, { waitMs: number; dueAt: number }>();
  const execute = async () => {
    const page = await options.closure.discover({
      observedAt: options.now(),
      after: cursor,
      limit: options.pageSize,
    });
    let processed = 0;
    for (const candidate of page) {
      if (stopping) break;
      const key = String(candidate.orderReference);
      const at = Date.parse(options.now());
      const prior = failing.get(key);
      if (prior !== undefined && at < prior.dueAt) {
        processed++;
        continue;
      }
      try {
        const outcome = await options.closure.close(candidate);
        failing.delete(key);
        options.onOutcome?.(outcome);
      } catch (error) {
        const waitMs = prior === undefined ? firstRetryMs : Math.min(prior.waitMs * 2, maxRetryMs);
        failing.set(key, { waitMs, dueAt: at + waitMs });
        // A coded error (owner or database) reports its code; a plain Error its UPPER_SNAKE message.
        const coded = (error as { code?: unknown } | null)?.code;
        const code =
          typeof coded === "string" ? coded : error instanceof Error ? error.message : "";
        options.onFailure?.(/^[A-Z0-9_]{1,80}$/u.test(code) ? code : "UNAVAILABLE");
      }
      processed++;
    }
    if (!stopping) {
      // A completed full scan forgets Orders that are no longer candidates (closed or paid).
      if (page.length !== options.pageSize && cursor === null) {
        const current = new Set(page.map((candidate) => String(candidate.orderReference)));
        for (const key of failing.keys()) if (!current.has(key)) failing.delete(key);
      }
      cursor = page.length === options.pageSize ? (page.at(-1)?.orderReference ?? null) : null;
    }
    return processed;
  };
  return Object.freeze({
    runOnce(): Promise<number> {
      if (stopping) return Promise.resolve(0);
      if (inFlight) return inFlight;
      inFlight = execute().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async stop() {
      stopping = true;
      await inFlight?.catch(() => undefined);
      return "drained" as const;
    },
  });
}

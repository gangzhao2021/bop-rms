import { createHash } from "node:crypto";

import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it } from "vitest";

import {
  createOrderPaymentDispositionBinding,
  createOrderPaymentOutcomeConsumerService,
  parseOrderConfirmedEnvelope,
  parseOrderPaymentOutcomeDisposition,
  parsePaymentOutcomeEnvelope,
  type OrderPaymentOutcomeConsumerPorts,
  type PaymentSucceededEnvelope,
  type StoredOrderPaymentOutcomeEffect,
} from "../index.js";

const id = (n: number) => `018f6500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const terminalAt = "2026-08-08T15:00:00.000Z";
const confirmedAt = "2026-08-08T15:01:00.000Z";
const evaluatedAt = "2026-08-08T15:02:00.000Z";
const placeholderDigest = `sha256:${"0".repeat(64)}`;
const sourceSnapshotDigest = `sha256:${"a".repeat(64)}`;
const refs = {
  paymentEvent: id(1),
  paymentFailureEvent: id(2),
  brand: id(3),
  store: id(4),
  order: id(5),
  paymentTransaction: id(6),
  paymentIntent: id(7),
  paymentAttempt: id(8),
  correlation: id(9),
  causation: id(10),
  disposition: id(11),
  batch: id(12),
  submission: id(13),
  checkpoint: id(14),
  confirmation: id(15),
  orderConfirmedEvent: id(16),
  failureRecord: id(17),
};

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function succeeded(overrides: Record<string, unknown> = {}) {
  return parsePaymentOutcomeEnvelope({
    eventId: refs.paymentEvent,
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    occurredAt: terminalAt,
    producerModule: "@rms/payment",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "PaymentIntent",
    aggregateId: refs.paymentIntent,
    aggregateVersion: 2n,
    correlationId: refs.correlation,
    causationId: refs.causation,
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: refs.paymentTransaction,
      paymentIntentReference: refs.paymentIntent,
      paymentAttemptReference: refs.paymentAttempt,
      orderReference: refs.order,
      amountMinor: "1130",
      currencyCode: "CAD",
      evidenceKind: "Captured",
      terminalOccurredAt: terminalAt,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
    ...overrides,
  }) as PaymentSucceededEnvelope;
}

function failed(overrides: Record<string, unknown> = {}) {
  return parsePaymentOutcomeEnvelope({
    eventId: refs.paymentFailureEvent,
    eventType: "PaymentFailed",
    schemaVersion: 1,
    occurredAt: terminalAt,
    producerModule: "@rms/payment",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "PaymentIntent",
    aggregateId: refs.paymentIntent,
    aggregateVersion: 2n,
    correlationId: refs.correlation,
    causationId: refs.causation,
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: refs.paymentTransaction,
      paymentIntentReference: refs.paymentIntent,
      paymentAttemptReference: refs.paymentAttempt,
      orderReference: refs.order,
      reason: "Declined",
      retryDisposition: "Never",
      terminalOccurredAt: terminalAt,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
    ...overrides,
  });
}

function disposition(
  event: PaymentSucceededEnvelope,
  kind: "Confirmed" | "AwaitingAcceptance" | "PaidWithoutFulfillableOrder",
  overrides: Record<string, unknown> = {},
) {
  const common = {
    dispositionReference: refs.disposition,
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    submissionReference: refs.submission,
    paymentTransactionReference: refs.paymentTransaction,
    paymentIntentReference: refs.paymentIntent,
    paymentAttemptReference: refs.paymentAttempt,
    paymentEventReference: event.eventId,
    sourceVersion: 3,
    sourceCheckpoint: refs.checkpoint,
    sourceDigest: placeholderDigest,
    evaluatedAt,
  };
  const raw =
    kind === "Confirmed"
      ? {
          ...common,
          disposition: "Confirmed",
          confirmationReference: refs.confirmation,
          sourceSnapshotDigest,
          confirmedAt,
          ...overrides,
        }
      : kind === "AwaitingAcceptance"
        ? {
            ...common,
            disposition: "AwaitingAcceptance",
            reason: "OrderAcceptancePending",
            ...overrides,
          }
        : {
            ...common,
            disposition: "PaidWithoutFulfillableOrder",
            reason: "CapacityExpired",
            kitchenReleaseDisposition: "Blocked",
            ...overrides,
          };
  if (Object.hasOwn(overrides, "sourceDigest")) return raw;
  return {
    ...raw,
    sourceDigest: hash(createOrderPaymentDispositionBinding({ event, disposition: raw })),
  };
}

function transaction() {
  const inbox = new Map<
    string,
    {
      eventType: string;
      schemaVersion: number;
      brandId: string;
      storeId: string | null;
      status: string;
    }
  >();
  const tx: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      const key = `${String(values[0])}:${String(values[1])}`;
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        if (inbox.has(key)) return { rowCount: 0, rows: [] as Row[] };
        inbox.set(key, {
          eventType: String(values[2]),
          schemaVersion: Number(values[3]),
          brandId: String(values[4]),
          storeId: values[5] === null ? null : String(values[5]),
          status: "processing",
        });
        return { rowCount: 1, rows: [{} as Row] };
      }
      if (text.startsWith("SELECT event_type")) {
        const row = inbox.get(key);
        return {
          rowCount: row === undefined ? 0 : 1,
          rows:
            row === undefined
              ? ([] as Row[])
              : ([
                  {
                    event_type: row.eventType,
                    schema_version: row.schemaVersion,
                    brand_id: row.brandId,
                    store_id: row.storeId,
                    status: row.status,
                  } as Row,
                ] as Row[]),
        };
      }
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        const row = inbox.get(key);
        if (row === undefined || row.status !== "processing")
          return { rowCount: 0, rows: [] as Row[] };
        row.status = "completed";
        return { rowCount: 1, rows: [] as Row[] };
      }
      throw new Error("unexpected transaction query");
    },
  };
  return tx;
}

function fixture(
  options: {
    source?: unknown | null;
    authorized?: boolean;
    committedSucceededEffect?: StoredOrderPaymentOutcomeEffect;
    commitSucceededStatus?: "Created" | "AlreadyCommitted";
  } = {},
) {
  const effects = new Map<string, StoredOrderPaymentOutcomeEffect>();
  const calls = {
    authorization: 0,
    loads: 0,
    source: 0,
    succeededCommits: 0,
    failedCommits: 0,
  };
  const trace: string[] = [];
  const ports: OrderPaymentOutcomeConsumerPorts = {
    authorization: {
      async authorize() {
        trace.push("authorize");
        calls.authorization += 1;
        return options.authorized ?? true;
      },
    },
    source: {
      async loadExact() {
        trace.push("source");
        calls.source += 1;
        return options.source ?? null;
      },
    },
    outcomes: {
      async loadByPaymentEvent(input) {
        trace.push("load");
        calls.loads += 1;
        return effects.get(input.paymentEventReference) ?? null;
      },
      async commitSucceeded(input) {
        calls.succeededCommits += 1;
        const existing = effects.get(input.sourceEvent.eventId);
        if (existing !== undefined) return { status: "AlreadyCommitted", effect: existing };
        const effect =
          options.committedSucceededEffect ??
          ({
            record: input.disposition,
            orderConfirmedEvent: input.orderConfirmedEvent,
          } as const);
        effects.set(input.sourceEvent.eventId, effect);
        return { status: options.commitSucceededStatus ?? "Created", effect };
      },
      async commitFailed(input) {
        calls.failedCommits += 1;
        const existing = effects.get(input.sourceEvent.eventId);
        if (existing !== undefined) return { status: "AlreadyCommitted", effect: existing };
        const effect = { record: input.failure, orderConfirmedEvent: null } as const;
        effects.set(input.sourceEvent.eventId, effect);
        return { status: "Created", effect };
      },
    },
    references: {
      generate(purpose) {
        return purpose === "OrderConfirmedEvent" ? refs.orderConfirmedEvent : refs.failureRecord;
      },
    },
    digests: { sha256: hash },
  };
  return {
    service: createOrderPaymentOutcomeConsumerService(ports),
    calls,
    trace,
    effects,
  };
}

describe("WP-1310 Ordering payment outcome", () => {
  it("strictly parses accessor-safe, deeply immutable Payment terminal Events", () => {
    const event = succeeded();
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.actor)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(event.replayMetadata)).toBe(true);

    expect(() =>
      parsePaymentOutcomeEnvelope({
        ...event,
        payload: { ...event.payload, providerObject: "prohibited" },
      }),
    ).toThrowError(expect.objectContaining({ code: "ORDER_PAYMENT_OUTCOME_INPUT_INVALID" }));
    const accessorPayload = { ...event.payload };
    Object.defineProperty(accessorPayload, "amountMinor", {
      enumerable: true,
      get: () => "1130",
    });
    expect(() => parsePaymentOutcomeEnvelope({ ...event, payload: accessorPayload })).toThrowError(
      expect.objectContaining({ code: "ORDER_PAYMENT_OUTCOME_INPUT_INVALID" }),
    );
    expect(() =>
      parsePaymentOutcomeEnvelope(Object.assign(Object.create({ inherited: true }), event)),
    ).toThrowError(expect.objectContaining({ code: "ORDER_PAYMENT_OUTCOME_INPUT_INVALID" }));
  });

  it("atomically confirms once, emits the minimal Ordering Event and conflicts on changed replay", async () => {
    const event = succeeded();
    const state = fixture({ source: disposition(event, "Confirmed") });
    const tx = transaction();

    await expect(state.service.consume(tx, event)).resolves.toMatchObject({
      consumerOutcome: { status: "processed" },
      result: {
        status: "OrderConfirmed",
        orderConfirmedEventReference: refs.orderConfirmedEvent,
      },
    });
    expect(state.calls.authorization).toBe(1);
    await expect(state.service.consume(tx, event)).resolves.toMatchObject({
      consumerOutcome: { status: "duplicate_completed" },
      result: { status: "OrderConfirmed" },
    });
    expect(state.calls.authorization).toBe(2);
    expect(state.calls.succeededCommits).toBe(1);
    expect(state.trace[0]).toBe("authorize");
    const stored = state.effects.get(event.eventId);
    expect(stored?.orderConfirmedEvent?.payload).toEqual({
      confirmationReference: refs.confirmation,
      orderReference: refs.order,
      orderBatchReference: refs.batch,
      sourceSnapshotDigest,
      confirmedAt,
    });
    expect(stored?.orderConfirmedEvent).toMatchObject({
      producerModule: "@rms/ordering",
      aggregateType: "Order",
      aggregateVersion: 3n,
      causationId: event.eventId,
      redactionClassification: "indirect_identifier",
    });
    if (stored?.orderConfirmedEvent === null || stored?.orderConfirmedEvent === undefined)
      throw new Error("OrderConfirmed missing");
    const orderConfirmedEvent = stored.orderConfirmedEvent;
    expect(() =>
      parseOrderConfirmedEnvelope({
        ...orderConfirmedEvent,
        payload: {
          ...orderConfirmedEvent.payload,
          paymentTransactionReference: refs.paymentTransaction,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "ORDER_CONFIRMED_EVENT_INVALID" }));

    const changed = succeeded({ payload: { ...event.payload, amountMinor: "1200" } });
    await expect(state.service.consume(tx, changed)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_CONFLICT",
    });
    expect(state.calls.succeededCommits).toBe(1);
  });

  it("retries AwaitingAcceptance without a disposition effect or OrderConfirmed", async () => {
    const event = succeeded();
    const state = fixture({ source: disposition(event, "AwaitingAcceptance") });
    await expect(state.service.consume(transaction(), event)).rejects.toMatchObject({
      name: "ConsumerTransactionRollback",
      outcome: { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" },
    });
    expect(state.calls.succeededCommits).toBe(0);
    expect(state.effects.size).toBe(0);
  });

  it("publishes one strict blocked paid-without-fulfillable disposition and no confirmation", async () => {
    const event = succeeded();
    const source = disposition(event, "PaidWithoutFulfillableOrder");
    const state = fixture({ source });
    const response = await state.service.consume(transaction(), event);
    expect(response.result).toMatchObject({
      status: "CompensationRequired",
      disposition: {
        disposition: "PaidWithoutFulfillableOrder",
        reason: "CapacityExpired",
        kitchenReleaseDisposition: "Blocked",
      },
    });
    expect(state.effects.get(event.eventId)?.orderConfirmedEvent).toBeNull();
    const parsed = parseOrderPaymentOutcomeDisposition(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.paymentEventReference).toBe(event.eventId);
  });

  it("records PaymentFailed idempotently without source lookup, confirmation or compensation", async () => {
    const event = failed();
    const state = fixture();
    const tx = transaction();
    await expect(state.service.consume(tx, event)).resolves.toMatchObject({
      consumerOutcome: { status: "processed" },
      result: { status: "PaymentFailedRecorded" },
    });
    await expect(state.service.consume(tx, event)).resolves.toMatchObject({
      consumerOutcome: { status: "duplicate_completed" },
      result: { status: "PaymentFailedRecorded" },
    });
    expect(state.calls.source).toBe(0);
    expect(state.calls.failedCommits).toBe(1);
    expect(state.calls.succeededCommits).toBe(0);
    expect(state.effects.get(event.eventId)?.orderConfirmedEvent).toBeNull();

    const changed = failed({
      payload: { ...event.payload, reason: "ProviderRejected", retryDisposition: "Unknown" },
    });
    await expect(state.service.consume(tx, changed)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_CONFLICT",
    });
    expect(state.calls.failedCommits).toBe(1);
  });

  it("authorizes before any Ordering read and fails closed on denied or mismatched source", async () => {
    const event = succeeded();
    const denied = fixture({ authorized: false, source: disposition(event, "Confirmed") });
    await expect(denied.service.consume(transaction(), event)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED",
    });
    expect(denied.trace).toEqual(["authorize"]);

    const mismatched = fixture({
      source: disposition(event, "Confirmed", { storeReference: id(30) }),
    });
    await expect(mismatched.service.consume(transaction(), event)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
    });
    expect(mismatched.calls.succeededCommits).toBe(0);
  });

  it("enforces authorization through direct dispatcher registration handlers", async () => {
    const event = succeeded();
    const denied = fixture({ authorized: false, source: disposition(event, "Confirmed") });
    const direct = denied.service.registrations.find(
      (registration) => registration.eventType === "PaymentSucceeded",
    );
    if (direct === undefined) throw new Error("registration missing");
    await expect(
      direct.handler({ envelope: event, transaction: transaction() }),
    ).rejects.toMatchObject({ code: "ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED" });
    expect(denied.trace).toEqual(["authorize"]);
  });

  it("rejects a terminal fact routed to the wrong direct registration", async () => {
    const state = fixture();
    const successRegistration = state.service.registrations.find(
      (registration) => registration.eventType === "PaymentSucceeded",
    );
    const failureRegistration = state.service.registrations.find(
      (registration) => registration.eventType === "PaymentFailed",
    );
    if (successRegistration === undefined || failureRegistration === undefined)
      throw new Error("registration missing");

    await expect(
      successRegistration.handler({ envelope: failed(), transaction: transaction() }),
    ).rejects.toMatchObject({ code: "ORDER_PAYMENT_OUTCOME_INPUT_INVALID" });
    await expect(
      failureRegistration.handler({ envelope: succeeded(), transaction: transaction() }),
    ).rejects.toMatchObject({ code: "ORDER_PAYMENT_OUTCOME_INPUT_INVALID" });
    expect(state.calls.authorization).toBe(0);
    expect(state.calls.loads).toBe(0);
    expect(state.calls.source).toBe(0);
  });

  it("rejects a Created commit that swaps the exact attempted branch", async () => {
    const event = succeeded();
    const attempted = disposition(event, "Confirmed");
    const swapped = parseOrderPaymentOutcomeDisposition(
      disposition(event, "PaidWithoutFulfillableOrder"),
    );
    const state = fixture({
      source: attempted,
      committedSucceededEffect: { record: swapped, orderConfirmedEvent: null },
    });
    await expect(state.service.consume(transaction(), event)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
    });
    expect(state.calls.succeededCommits).toBe(1);
  });

  it("conflicts when an AlreadyCommitted race swaps branch or source version", async () => {
    const event = succeeded();
    const attempted = disposition(event, "PaidWithoutFulfillableOrder");
    const swappedBranch = parseOrderPaymentOutcomeDisposition(disposition(event, "Confirmed"));
    const branchState = fixture({
      source: attempted,
      committedSucceededEffect: { record: swappedBranch, orderConfirmedEvent: null },
      commitSucceededStatus: "AlreadyCommitted",
    });
    await expect(branchState.service.consume(transaction(), event)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_CONFLICT",
    });

    const changedVersion = parseOrderPaymentOutcomeDisposition(
      disposition(event, "PaidWithoutFulfillableOrder", { sourceVersion: 4 }),
    );
    const versionState = fixture({
      source: attempted,
      committedSucceededEffect: { record: changedVersion, orderConfirmedEvent: null },
      commitSucceededStatus: "AlreadyCommitted",
    });
    await expect(versionState.service.consume(transaction(), event)).rejects.toMatchObject({
      code: "ORDER_PAYMENT_OUTCOME_CONFLICT",
    });
  });

  it("registers both catalog terminal facts under the single Ordering consumer identity", () => {
    const state = fixture();
    expect(state.service.registrations).toEqual([
      expect.objectContaining({
        consumerName: "ordering.payment-outcome:v1",
        consumerVersion: 1,
        eventType: "PaymentSucceeded",
      }),
      expect.objectContaining({
        consumerName: "ordering.payment-outcome:v1",
        consumerVersion: 1,
        eventType: "PaymentFailed",
      }),
    ]);
  });
});

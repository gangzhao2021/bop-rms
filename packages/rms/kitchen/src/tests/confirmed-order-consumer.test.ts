import { createHash } from "node:crypto";

import {
  consumeEventInTransaction,
  ConsumerRegistry,
  ConsumerTransactionRollback,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { describe, expect, it } from "vitest";

import {
  confirmedOrderConsumerName,
  confirmedOrderConsumerVersion,
  ConfirmedOrderIntakeError,
  createConfirmedOrderConsumerService,
  createConfirmedOrderIntakeReceipt,
  createConfirmedOrderSemanticEventBinding,
  type ConfirmedOrderConsumerPorts,
  type ConfirmedOrderIntakeReceipt,
  type ConfirmedOrderIntakeResolution,
  type ConfirmedOrderIntakeCommit,
} from "../index.js";

const refs = {
  event: "018f1f48-7b5d-7cc1-8a1b-123456789a01",
  eventClone: "018f1f48-7b5d-7cc2-8a1b-123456789a02",
  eventOther: "018f1f48-7b5d-7cc3-8a1b-123456789a03",
  brand: "018f1f48-7b5d-7cc4-8a1b-123456789a04",
  store: "018f1f48-7b5d-7cc5-8a1b-123456789a05",
  order: "018f1f48-7b5d-7cc6-8a1b-123456789a06",
  batch: "018f1f48-7b5d-7cc7-8a1b-123456789a07",
  batchOther: "018f1f48-7b5d-7cc8-8a1b-123456789a08",
  confirmation: "018f1f48-7b5d-7cc9-8a1b-123456789a09",
  confirmationOther: "018f1f48-7b5d-7cca-8a1b-123456789a10",
  correlation: "018f1f48-7b5d-7ccb-8a1b-123456789a11",
  causation: "018f1f48-7b5d-7ccc-8a1b-123456789a12",
} as const;
const confirmedAt = "2026-08-08T16:00:00.000Z";
const sourceSnapshotDigest = `sha256:${"a".repeat(64)}`;

function event(
  overrides: Partial<{
    eventId: string;
    aggregateVersion: bigint;
    orderReference: string;
    orderBatchReference: string;
    confirmationReference: string;
    sourceSnapshotDigest: string;
    occurredAt: string;
    confirmedAt: string;
    correlationId: string;
    causationId: string;
  }> = {},
) {
  const orderReference = overrides.orderReference ?? refs.order;
  const occurredAt = overrides.occurredAt ?? confirmedAt;
  return {
    eventId: overrides.eventId ?? refs.event,
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    occurredAt,
    producerModule: "@rms/ordering",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "Order",
    aggregateId: orderReference,
    aggregateVersion: overrides.aggregateVersion ?? 2n,
    correlationId: overrides.correlationId ?? refs.correlation,
    causationId: overrides.causationId ?? refs.causation,
    actor: { type: "System" },
    payload: {
      confirmationReference: overrides.confirmationReference ?? refs.confirmation,
      orderReference,
      orderBatchReference: overrides.orderBatchReference ?? refs.batch,
      sourceSnapshotDigest: overrides.sourceSnapshotDigest ?? sourceSnapshotDigest,
      confirmedAt: overrides.confirmedAt ?? occurredAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function receipt(value: unknown): ConfirmedOrderIntakeReceipt {
  return createConfirmedOrderIntakeReceipt({
    sourceEvent: value,
    semanticEventBindingDigest: sha256(createConfirmedOrderSemanticEventBinding(value)),
  });
}

interface InboxRow {
  readonly event_type: string;
  readonly schema_version: number;
  readonly brand_id: string;
  readonly store_id: string | null;
  readonly correlation_id: string;
  status: "processing" | "completed";
  result_hash: string | null;
}

interface DatabaseState {
  readonly inbox: Map<string, InboxRow>;
  readonly receipts: ConfirmedOrderIntakeReceipt[];
}

function cloneState(state: DatabaseState): DatabaseState {
  return {
    inbox: new Map([...state.inbox].map(([key, row]) => [key, { ...row }])),
    receipts: [...state.receipts],
  };
}

class SyntheticDatabase {
  #committed: DatabaseState = { inbox: new Map(), receipts: [] };
  readonly #working = new WeakMap<ConsumerTransaction, DatabaseState>();
  commitThenThrow = false;

  get inbox(): ReadonlyMap<string, InboxRow> {
    return this.#committed.inbox;
  }

  get receipts(): readonly ConfirmedOrderIntakeReceipt[] {
    return this.#committed.receipts;
  }

  seed(receipts: readonly ConfirmedOrderIntakeReceipt[]): void {
    this.#committed = { inbox: new Map(this.#committed.inbox), receipts: [...receipts] };
  }

  state(transaction: ConsumerTransaction): DatabaseState {
    const state = this.#working.get(transaction);
    if (!state) throw new Error("synthetic transaction is unavailable");
    return state;
  }

  async transaction<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> {
    const staged = cloneState(this.#committed);
    const transaction: ConsumerTransaction = {
      query: async <Row = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[],
      ): Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }> => {
        if (sql.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
          const key = `${String(values[0])}|${String(values[1])}`;
          if (staged.inbox.has(key)) return { rowCount: 0, rows: [] };
          staged.inbox.set(key, {
            event_type: String(values[2]),
            schema_version: Number(values[3]),
            brand_id: String(values[4]),
            store_id: values[5] === null ? null : String(values[5]),
            correlation_id: String(values[6]),
            status: "processing",
            result_hash: null,
          });
          return {
            rowCount: 1,
            rows: [{ consumer_name: String(values[0]) } as Row],
          };
        }
        if (sql.startsWith("SELECT event_type")) {
          const key = `${String(values[0])}|${String(values[1])}`;
          const row = staged.inbox.get(key);
          return {
            rowCount: row ? 1 : 0,
            rows: row ? ([{ ...row } as Row] as readonly Row[]) : [],
          };
        }
        if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
          const key = `${String(values[0])}|${String(values[1])}`;
          const row = staged.inbox.get(key);
          if (!row || row.status !== "processing") return { rowCount: 0, rows: [] };
          row.status = "completed";
          row.result_hash = values[2] === null ? null : String(values[2]);
          return { rowCount: 1, rows: [] };
        }
        throw new Error("unexpected synthetic SQL");
      },
    };
    this.#working.set(transaction, staged);
    const result = await work(transaction);
    this.#committed = staged;
    if (this.commitThenThrow) {
      this.commitThenThrow = false;
      throw new Error("synthetic commit outcome unknown");
    }
    return result;
  }
}

interface HarnessOptions {
  authorization?: "allow" | "deny" | "throw";
  digest?: "normal" | "invalid" | "throw";
  resolution?: (call: number, fallback: ConfirmedOrderIntakeResolution) => unknown;
  commit?: (call: number, fallback: ConfirmedOrderIntakeCommit) => unknown;
}

function harness(options: HarnessOptions = {}) {
  const database = new SyntheticDatabase();
  const calls = { authorization: 0, resolution: 0, accept: 0, digest: 0 };
  const trace: string[] = [];
  const inputs: {
    readonly authorization: Parameters<
      ConfirmedOrderConsumerPorts["authorization"]["authorize"]
    >[0][];
    readonly resolution: Parameters<
      ConfirmedOrderConsumerPorts["intakes"]["resolveByIdentity"]
    >[0][];
    readonly accept: Parameters<ConfirmedOrderConsumerPorts["intakes"]["accept"]>[0][];
  } = { authorization: [], resolution: [], accept: [] };

  function matches(
    candidate: ConfirmedOrderIntakeReceipt,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly sourceEventReference: string;
      readonly confirmationReference: string;
      readonly orderBatchReference: string;
    },
  ): boolean {
    if (
      candidate.brandReference !== input.brandReference ||
      candidate.storeReference !== input.storeReference
    )
      return false;
    return (
      candidate.sourceEventReference === input.sourceEventReference ||
      candidate.confirmationReference === input.confirmationReference ||
      candidate.orderBatchReference === input.orderBatchReference
    );
  }

  const ports: ConfirmedOrderConsumerPorts = {
    authorization: {
      authorize: async (input) => {
        calls.authorization += 1;
        trace.push("authorize");
        inputs.authorization.push(input);
        if (options.authorization === "throw") throw new Error("synthetic authorization outage");
        return options.authorization !== "deny";
      },
    },
    digests: {
      sha256: (value) => {
        calls.digest += 1;
        trace.push("digest");
        if (options.digest === "throw") throw new Error("synthetic digest outage");
        if (options.digest === "invalid") return "not-a-digest";
        return sha256(value);
      },
    },
    intakes: {
      resolveByIdentity: async (input) => {
        calls.resolution += 1;
        trace.push("resolve");
        inputs.resolution.push(input);
        const candidates = database
          .state(input.transaction)
          .receipts.filter((candidate) => matches(candidate, input));
        const fallback: ConfirmedOrderIntakeResolution =
          candidates.length === 0
            ? { status: "NotFound" }
            : candidates.length === 1
              ? { status: "Resolved", receipt: candidates[0] }
              : { status: "Conflict" };
        return (options.resolution?.(calls.resolution, fallback) ??
          fallback) as ConfirmedOrderIntakeResolution;
      },
      accept: async (input) => {
        calls.accept += 1;
        trace.push("accept");
        inputs.accept.push(input);
        const state = database.state(input.transaction);
        const candidates = state.receipts.filter((candidate) => matches(candidate, input.receipt));
        let fallback: ConfirmedOrderIntakeCommit;
        if (candidates.length > 1) fallback = { status: "Conflict" };
        else if (candidates.length === 1)
          fallback = { status: "AlreadyAccepted", receipt: candidates[0] };
        else {
          state.receipts.push(input.receipt);
          fallback = { status: "Created", receipt: input.receipt };
        }
        return (options.commit?.(calls.accept, fallback) ?? fallback) as ConfirmedOrderIntakeCommit;
      },
    },
  };
  return {
    database,
    calls,
    inputs,
    trace,
    ports,
    service: createConfirmedOrderConsumerService(ports),
  };
}

function code(value: unknown): string | undefined {
  return value instanceof ConfirmedOrderIntakeError ? value.code : undefined;
}

function expectedAuthorizationInput() {
  return {
    action: "ConsumeConfirmedOrder",
    purpose: "CreateKitchenIntake",
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    confirmationReference: refs.confirmation,
    sourceEventReference: refs.event,
    observedAt: confirmedAt,
  };
}

describe("confirmed order intake contract", () => {
  it("creates one immutable semantic binding that excludes only eventId", () => {
    const original = event();
    const clone = event({ eventId: refs.eventClone });
    const changed = event({ eventId: refs.eventClone, aggregateVersion: 3n });
    const originalBinding = createConfirmedOrderSemanticEventBinding(original);
    expect(originalBinding).toBe(createConfirmedOrderSemanticEventBinding(clone));
    expect(originalBinding).not.toBe(createConfirmedOrderSemanticEventBinding(changed));
    expect(JSON.parse(originalBinding)).toMatchObject({
      consumerName: confirmedOrderConsumerName,
      consumerVersion: confirmedOrderConsumerVersion,
    });
    const parsed = receipt(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      consumerName: confirmedOrderConsumerName,
      consumerVersion: confirmedOrderConsumerVersion,
      sourceEventReference: refs.event,
      semanticEventBindingDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(
      JSON.stringify(parsed, (_key, value: unknown) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain(refs.causation);
    expect(parsed).not.toHaveProperty("causationReference");
  });

  it.each([
    ["correlationId", { correlationId: refs.eventOther }],
    ["causationId", { causationId: refs.eventOther }],
    [
      "confirmedAt",
      {
        occurredAt: "2026-08-08T16:01:00.000Z",
        confirmedAt: "2026-08-08T16:01:00.000Z",
      },
    ],
    ["sourceSnapshotDigest", { sourceSnapshotDigest: `sha256:${"b".repeat(64)}` }],
  ] as const)(
    "binds %s drift while keeping causation out of the receipt",
    (_field, replacement) => {
      const originalBinding = createConfirmedOrderSemanticEventBinding(event());
      const changedEvent = event(replacement);
      expect(createConfirmedOrderSemanticEventBinding(changedEvent)).not.toBe(originalBinding);
      expect(receipt(changedEvent)).not.toHaveProperty("causationId");
      expect(receipt(changedEvent)).not.toHaveProperty("causationReference");
    },
  );

  it.each([
    ["outer extra field", () => ({ ...event(), extra: true })],
    ["payload extra field", () => ({ ...event(), payload: { ...event().payload, extra: true } })],
    [
      "custom prototype",
      () => Object.assign(Object.create({ inherited: true }) as object, event()),
    ],
    ["symbol field", () => ({ ...event(), [Symbol("unexpected")]: true })],
    [
      "accessor",
      () => {
        const value = { ...event() };
        Object.defineProperty(value, "payload", {
          enumerable: true,
          get: () => event().payload,
        });
        return value;
      },
    ],
  ])("rejects a strict %s before any port observes it", async (_label, factory) => {
    const state = harness();
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, factory())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID",
    );
    expect(state.trace).toEqual([]);
  });

  it.each([
    ["wrong producer", () => ({ ...event(), producerModule: "@rms/payment" })],
    ["wrong Event type", () => ({ ...event(), eventType: "OrderCreated" })],
    ["wrong schema", () => ({ ...event(), schemaVersion: 2 })],
    ["wrong actor", () => ({ ...event(), actor: { type: "User", actorId: refs.eventOther } })],
    [
      "missing Store scope",
      () => {
        const withoutStore: Record<string, unknown> = { ...event() };
        delete withoutStore.storeId;
        return withoutStore;
      },
    ],
    ["non-Store scope", () => ({ ...event(), storeId: undefined })],
    ["aggregate/order mismatch", () => ({ ...event(), aggregateId: refs.batchOther })],
    ["occurred/confirmed mismatch", () => ({ ...event(), occurredAt: "2026-08-08T16:01:00.000Z" })],
    [
      "malformed source digest",
      () => ({ ...event(), payload: { ...event().payload, sourceSnapshotDigest: "sha256:bad" } }),
    ],
  ])("rejects %s before authorization", async (_label, factory) => {
    const state = harness();
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, factory())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_INPUT_INVALID",
    );
    expect(state.calls.authorization).toBe(0);
    expect(state.calls.accept).toBe(0);
    expect(state.database.inbox).toHaveLength(0);
  });
});

describe("confirmed order consumer", () => {
  it("registers the exact Event Catalog consumer declaration", () => {
    const state = harness();
    const registry = new ConsumerRegistry([state.service.registration]);
    expect(state.service.registration).toMatchObject({
      consumerName: "kitchen.confirmed-order:v1",
      consumerVersion: 1,
      eventType: "OrderConfirmed",
      schemaVersions: [1],
      ownerModule: "@rms/kitchen",
      tenantScope: "store",
      ordering: "none",
      sideEffect: "accept_confirmed_order",
      replaySafe: true,
    });
    expect(
      registry.resolve(confirmedOrderConsumerName, event() as DomainEventEnvelope),
    ).toHaveProperty("registration");
    expect(registry.resolve("missing:v1", event() as DomainEventEnvelope)).toEqual({
      errorCode: "CONSUMER_UNKNOWN",
    });
    expect(
      registry.resolve(confirmedOrderConsumerName, {
        ...event(),
        schemaVersion: 2,
      } as DomainEventEnvelope),
    ).toEqual({ errorCode: "EVENT_SCHEMA_VERSION_UNSUPPORTED" });
  });

  it("authorizes once before Inbox and records one null-result-hash receipt", async () => {
    const state = harness();
    const result = await state.database.transaction((transaction) =>
      state.service.consume(transaction, event()),
    );
    expect(result).toMatchObject({
      status: "Accepted",
      receipt: { sourceEventReference: refs.event },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(state.calls).toEqual({ authorization: 1, resolution: 2, accept: 1, digest: 1 });
    expect(state.trace).toEqual(["authorize", "digest", "resolve", "accept", "resolve"]);
    expect(state.inputs.authorization).toEqual([expectedAuthorizationInput()]);
    expect(Object.keys(state.inputs.resolution[0] ?? {}).sort()).toEqual(
      [
        "brandReference",
        "storeReference",
        "sourceEventReference",
        "confirmationReference",
        "orderBatchReference",
        "transaction",
      ].sort(),
    );
    expect(state.inputs.resolution[0]).toMatchObject({
      brandReference: refs.brand,
      storeReference: refs.store,
      sourceEventReference: refs.event,
      confirmationReference: refs.confirmation,
      orderBatchReference: refs.batch,
      transaction: expect.any(Object),
    });
    expect(Object.keys(state.inputs.accept[0] ?? {}).sort()).toEqual(
      ["receipt", "transaction"].sort(),
    );
    expect(state.inputs.accept[0]).not.toHaveProperty("envelope");
    expect(state.inputs.accept[0]?.receipt).not.toHaveProperty("causationId");
    expect(state.inputs.accept[0]?.receipt).not.toHaveProperty("causationReference");
    expect(state.database.receipts).toHaveLength(1);
    expect([...state.database.inbox.values()]).toEqual([
      expect.objectContaining({ status: "completed", result_hash: null }),
    ]);
  });

  it("returns AlreadyAccepted for the same immutable Event without a second accept", async () => {
    const state = harness();
    await state.database.transaction((transaction) => state.service.consume(transaction, event()));
    const replay = await state.database.transaction((transaction) =>
      state.service.consume(transaction, event()),
    );
    expect(replay).toMatchObject({
      status: "AlreadyAccepted",
      receipt: { sourceEventReference: refs.event },
    });
    expect(state.calls.authorization).toBe(2);
    expect(state.calls.accept).toBe(1);
    expect(state.database.receipts).toHaveLength(1);
    expect(state.database.inbox).toHaveLength(1);
  });

  it("lets the raw registration process once and skip its handler on same-ID replay", async () => {
    const state = harness();
    const first = await state.database.transaction((transaction) =>
      consumeEventInTransaction(
        transaction,
        state.service.registration,
        event() as DomainEventEnvelope,
      ),
    );
    const callsAfterFirst = { ...state.calls };
    const second = await state.database.transaction((transaction) =>
      consumeEventInTransaction(
        transaction,
        state.service.registration,
        event() as DomainEventEnvelope,
      ),
    );
    expect(first).toEqual({ status: "processed" });
    expect(second).toEqual({ status: "duplicate_completed" });
    expect(callsAfterFirst).toMatchObject({ authorization: 1, accept: 1 });
    expect(state.calls).toEqual(callsAfterFirst);
    expect(state.inputs.authorization).toEqual([expectedAuthorizationInput()]);
    expect(state.database.receipts).toHaveLength(1);
    expect(state.database.inbox).toHaveLength(1);
    expect([...state.database.inbox.values()]).toEqual([
      expect.objectContaining({ status: "completed", result_hash: null }),
    ]);
  });

  it("replays an otherwise identical different Event ID to the original receipt", async () => {
    const state = harness();
    await state.database.transaction((transaction) => state.service.consume(transaction, event()));
    const replay = await state.database.transaction((transaction) =>
      state.service.consume(transaction, event({ eventId: refs.eventClone })),
    );
    expect(replay).toMatchObject({
      status: "AlreadyAccepted",
      receipt: { sourceEventReference: refs.event },
    });
    expect(state.database.receipts).toHaveLength(1);
    expect(state.database.inbox).toHaveLength(2);
    expect(state.calls.accept).toBe(2);
    expect([...state.database.inbox.values()].every((row) => row.result_hash === null)).toBe(true);
  });

  it("rejects a changed semantic clone before Inbox or a second effect", async () => {
    const state = harness();
    await state.database.transaction((transaction) => state.service.consume(transaction, event()));
    await expect(
      state.database.transaction((transaction) =>
        state.service.consume(
          transaction,
          event({ eventId: refs.eventClone, aggregateVersion: 3n }),
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_CONFLICT");
    expect(state.calls.accept).toBe(1);
    expect(state.database.receipts).toHaveLength(1);
    expect(state.database.inbox).toHaveLength(1);
  });

  it("accepts independent Batches in reverse aggregate-version order", async () => {
    const state = harness();
    await state.database.transaction((transaction) =>
      state.service.consume(
        transaction,
        event({
          eventId: refs.eventOther,
          aggregateVersion: 7n,
          orderBatchReference: refs.batchOther,
          confirmationReference: refs.confirmationOther,
        }),
      ),
    );
    await state.database.transaction((transaction) => state.service.consume(transaction, event()));
    expect(state.database.receipts).toHaveLength(2);
    expect(state.calls.accept).toBe(2);
  });

  it("fails closed when confirmation and Batch resolve to different receipts", async () => {
    const state = harness();
    const first = receipt(event());
    const second = receipt(
      event({
        eventId: refs.eventOther,
        orderBatchReference: refs.batchOther,
        confirmationReference: refs.confirmationOther,
      }),
    );
    state.database.seed([first, second]);
    await expect(
      state.database.transaction((transaction) =>
        state.service.consume(
          transaction,
          event({
            eventId: refs.eventClone,
            orderBatchReference: refs.batchOther,
            confirmationReference: refs.confirmation,
          }),
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_CONFLICT");
    expect(state.calls.accept).toBe(0);
    expect(state.database.inbox).toHaveLength(0);
  });

  it.each(["deny", "throw"] as const)(
    "rolls direct-handler %s authorization back without an effect",
    async (authorization) => {
      const state = harness({ authorization });
      await expect(
        state.database.transaction((transaction) =>
          consumeEventInTransaction(
            transaction,
            state.service.registration,
            event() as DomainEventEnvelope,
          ),
        ),
      ).rejects.toBeInstanceOf(ConsumerTransactionRollback);
      expect(state.calls.authorization).toBe(1);
      expect(state.calls.accept).toBe(0);
      expect(state.database.inbox).toHaveLength(0);
      expect(state.database.receipts).toHaveLength(0);
    },
  );

  it("maps a direct first-delivery dependency failure to retry and rolls back", async () => {
    const state = harness({ digest: "throw" });
    await expect(
      state.database.transaction((transaction) =>
        consumeEventInTransaction(
          transaction,
          state.service.registration,
          event() as DomainEventEnvelope,
        ),
      ),
    ).rejects.toEqual(
      new ConsumerTransactionRollback({
        status: "retry_required",
        errorCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
    );
    expect(state.database.inbox).toHaveLength(0);
    expect(state.calls.accept).toBe(0);
  });

  it("maps a direct first-delivery intake conflict to non-retryable rollback", async () => {
    const state = harness({ commit: () => ({ status: "Conflict" }) });
    await expect(
      state.database.transaction((transaction) =>
        consumeEventInTransaction(
          transaction,
          state.service.registration,
          event() as DomainEventEnvelope,
        ),
      ),
    ).rejects.toEqual(
      new ConsumerTransactionRollback({
        status: "rejected",
        errorCode: "CONSUMER_REJECTED",
      }),
    );
    expect(state.calls.authorization).toBe(1);
    expect(state.calls.accept).toBe(1);
    expect(state.database.inbox).toHaveLength(0);
    expect(state.database.receipts).toHaveLength(0);
  });

  it("reconciles a committed-but-unknown outcome without a second effect", async () => {
    const state = harness();
    state.database.commitThenThrow = true;
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toThrow("synthetic commit outcome unknown");
    expect(state.database.receipts).toHaveLength(1);
    expect(state.database.inbox).toHaveLength(1);
    const replay = await state.database.transaction((transaction) =>
      state.service.consume(transaction, event()),
    );
    expect(replay.status).toBe("AlreadyAccepted");
    expect(state.calls.accept).toBe(1);
  });
});

describe("confirmed order dependency hardening", () => {
  it.each(["resolve", "already"] as const)(
    "rejects a foreign scoped receipt returned by %s",
    async (phase) => {
      const foreign = receipt({
        ...event({
          eventId: refs.eventOther,
          orderReference: refs.batchOther,
          orderBatchReference: refs.confirmationOther,
          confirmationReference: refs.correlation,
        }),
        tenantId: refs.eventOther,
        storeId: refs.eventClone,
      });
      const state = harness({
        resolution: () =>
          phase === "resolve" ? { status: "Resolved", receipt: foreign } : { status: "NotFound" },
        commit: () => ({ status: "AlreadyAccepted", receipt: foreign }),
      });
      await expect(
        state.database.transaction((transaction) => state.service.consume(transaction, event())),
      ).rejects.toSatisfy((error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_CONFLICT");
      expect(state.calls.accept).toBe(phase === "resolve" ? 0 : 1);
      expect(state.database.inbox).toHaveLength(0);
      expect(state.database.receipts).toHaveLength(0);
    },
  );

  it("rejects accessor and varying-descriptor port results from one snapshot", async () => {
    let descriptorReads = 0;
    const varying = new Proxy(
      { status: "NotFound" },
      {
        getOwnPropertyDescriptor: (_target, property) => {
          if (property !== "status") return undefined;
          descriptorReads += 1;
          return descriptorReads === 1
            ? {
                configurable: true,
                enumerable: true,
                get: () => "NotFound",
              }
            : {
                configurable: true,
                enumerable: true,
                writable: true,
                value: "NotFound",
              };
        },
      },
    );
    const state = harness({ resolution: () => varying });
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(descriptorReads).toBe(1);
    expect(state.calls.accept).toBe(0);
  });

  it("rejects an unknown receipt returned by a dependency", async () => {
    const state = harness({
      resolution: () => ({ status: "Resolved", receipt: { secret: "not-a-receipt" } }),
    });
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(state.calls.accept).toBe(0);
  });

  it("rejects a receipt accessor without invoking its getter", async () => {
    let getterCalls = 0;
    const returned = { ...receipt(event()) };
    Object.defineProperty(returned, "sourceEventReference", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return refs.event;
      },
    });
    const state = harness({
      resolution: () => ({ status: "Resolved", receipt: returned }),
    });
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(getterCalls).toBe(0);
    expect(state.calls.accept).toBe(0);
    expect(state.database.inbox).toHaveLength(0);
  });

  it("rejects a custom-prototype receipt returned by a dependency", async () => {
    const returned = Object.assign(Object.create({ foreign: true }) as object, receipt(event()));
    const state = harness({
      resolution: () => ({ status: "Resolved", receipt: returned }),
    });
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(state.calls.accept).toBe(0);
    expect(state.database.inbox).toHaveLength(0);
  });

  it("requires a Created receipt to match every attempted field", async () => {
    const changed = receipt(event({ eventId: refs.eventClone }));
    const state = harness({ commit: () => ({ status: "Created", receipt: changed }) });
    await expect(
      state.database.transaction((transaction) => state.service.consume(transaction, event())),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(state.database.receipts).toHaveLength(0);
    expect(state.database.inbox).toHaveLength(0);
  });

  it("rejects a preflight-to-post source receipt swap despite semantic equality", async () => {
    const original = receipt(event());
    const clone = receipt(event({ eventId: refs.eventClone }));
    const state = harness({
      resolution: (call) =>
        call === 1
          ? { status: "Resolved", receipt: original }
          : { status: "Resolved", receipt: clone },
      commit: () => ({ status: "AlreadyAccepted", receipt: original }),
    });
    await expect(
      state.database.transaction((transaction) =>
        state.service.consume(transaction, event({ eventId: refs.eventClone })),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(state.database.inbox).toHaveLength(0);
  });

  it("requires an AlreadyAccepted receipt and postcondition to be exact", async () => {
    const original = receipt(event());
    const clone = receipt(event({ eventId: refs.eventClone }));
    const state = harness({
      resolution: (call) =>
        call === 1 ? { status: "NotFound" } : { status: "Resolved", receipt: clone },
      commit: () => ({ status: "AlreadyAccepted", receipt: original }),
    });
    await expect(
      state.database.transaction((transaction) =>
        state.service.consume(transaction, event({ eventId: refs.eventClone })),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => code(error) === "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
    );
    expect(state.database.inbox).toHaveLength(0);
  });

  it("keeps public errors bounded and identifier-free", async () => {
    const state = harness({ authorization: "deny" });
    let caught: unknown;
    try {
      await state.database.transaction((transaction) =>
        state.service.consume(transaction, event()),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfirmedOrderIntakeError);
    expect(caught).toMatchObject({
      code: "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED",
      message: "confirmed order intake is unavailable",
    });
    expect(JSON.stringify(caught)).not.toContain(refs.order);
    expect(JSON.stringify(caught)).not.toContain(refs.store);
  });
});

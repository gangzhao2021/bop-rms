import { createHash } from "node:crypto";

import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it, vi } from "vitest";

import {
  createKitchenWorkLifecycleIntentBinding,
  createKitchenReadyWorkItemsBinding,
  KitchenWorkLifecycleError,
  canonicalizeKitchenWorkLifecycle,
  parseKitchenWorkLifecycleCommand,
  parseKitchenWorkLifecycleResult,
  parseKitchenWorkLifecycleSource,
  type KitchenCapturedExpoDecision,
  type KitchenWorkLifecycleCommand,
} from "../contracts/kitchen-work-lifecycle.js";
import {
  createKitchenWorkLifecycleEventSemanticBinding,
  createKitchenWorkLifecycleEnvelope,
  parseKitchenItemCompletedEnvelope,
  parseKitchenItemProgressRecordedEnvelope,
  parseKitchenWorkAcceptedEnvelope,
  parseKitchenWorkLifecycleEnvelope,
  parseKitchenWorkStartedEnvelope,
} from "../application/kitchen-work-lifecycle-events.js";
import {
  parseKitchenItemReadyEnvelope,
  parseKitchenOrderReadyEnvelope,
} from "../application/kitchen-ready-events.js";
import {
  createKitchenWorkLifecycleAuditSemanticBinding,
  createKitchenWorkLifecycleService,
} from "../application/kitchen-work-lifecycle-service.js";
import type {
  KitchenWorkLifecycleEffect,
  KitchenWorkLifecyclePorts,
} from "../application/ports/kitchen-work-lifecycle-ports.js";

function id(value: number): string {
  return `018f4000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const refs = Object.freeze({
  brand: id(1),
  store: id(2),
  ticket: id(3),
  workItem: id(4),
  orderItem: id(5),
  actor: id(6),
  expoActor: id(7),
  correlation: id(8),
  retryCorrelation: id(9),
  acceptedOperation: id(10),
  startedOperation: id(11),
  admission: id(12),
  expo: id(13),
  order: id(14),
  batch: id(15),
  otherOrderItem: id(16),
});

const createdAt = "2026-08-09T11:00:00.000Z";
const acceptedAt = "2026-08-09T11:10:00.000Z";
const startedAt = "2026-08-09T11:20:00.000Z";
const observedAt = "2026-08-09T12:00:00.000Z";
const actionAt = "2026-08-09T12:00:01.000Z";

function predecessor(actionCode: "KITCHEN_WORK_ITEM_ACCEPTED" | "KITCHEN_WORK_ITEM_STARTED") {
  return {
    operationReference:
      actionCode === "KITCHEN_WORK_ITEM_ACCEPTED" ? refs.acceptedOperation : refs.startedOperation,
    actionCode,
    purpose: "KitchenWorkExecution",
    actorReference: refs.actor,
    ticketReference: refs.ticket,
    workItemReference: refs.workItem,
    orderItemReference: refs.orderItem,
    resultTicketVersion: actionCode === "KITCHEN_WORK_ITEM_ACCEPTED" ? 2n : 3n,
    resultWorkItemVersion: actionCode === "KITCHEN_WORK_ITEM_ACCEPTED" ? 2n : 3n,
    occurredAt: actionCode === "KITCHEN_WORK_ITEM_ACCEPTED" ? acceptedAt : startedAt,
  } as const;
}

function source(
  state: "Accept" | "Start" | "Complete" | "MarkReady" = "Accept",
  capturedExpo: KitchenCapturedExpoDecision | null = null,
) {
  const status =
    state === "Accept" || state === "Start"
      ? "Queued"
      : state === "Complete"
        ? "In Progress"
        : "Completed";
  const version = state === "Accept" ? 1n : state === "Start" ? 2n : state === "Complete" ? 3n : 4n;
  const completedQuantity = state === "MarkReady" ? 3 : 0;
  const updatedAt =
    state === "Accept"
      ? createdAt
      : state === "Start"
        ? acceptedAt
        : state === "Complete"
          ? startedAt
          : (capturedExpo?.sourceOccurredAt ?? actionAt);
  const item = {
    workItemReference: refs.workItem,
    orderItemReference: refs.orderItem,
    sourceItemOrdinal: 1,
    splitOrdinal: 1,
    workItemVersion: version,
    workItemStatus: status,
    requiredQuantity: 3,
    completedQuantity,
    createdAt,
    updatedAt,
  } as const;
  return {
    brandReference: refs.brand,
    storeReference: refs.store,
    ticketReference: refs.ticket,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    ticketStatus: "Open",
    ticketVersion: version,
    ticketUpdatedAt: updatedAt,
    target: item,
    siblings: [item],
    acceptedOperation: state === "Accept" ? null : predecessor("KITCHEN_WORK_ITEM_ACCEPTED"),
    startedOperation:
      state === "Complete" || state === "MarkReady"
        ? predecessor("KITCHEN_WORK_ITEM_STARTED")
        : null,
    readyResult: null,
    capturedExpo,
    ticketReadiness: [
      {
        orderItemReference: refs.orderItem,
        requiredQuantity: 3,
        readyResultReference: null,
        readyQuantity: null,
        readyAt: null,
      },
    ],
  };
}

function command(
  action: KitchenWorkLifecycleCommand["action"] = "AcceptKitchenWorkItem",
  overrides: Readonly<Record<string, unknown>> = {},
): KitchenWorkLifecycleCommand {
  const version =
    action === "AcceptKitchenWorkItem"
      ? "1"
      : action === "StartKitchenWorkItem"
        ? "2"
        : action === "CompleteKitchenWorkItem"
          ? "3"
          : "4";
  const value =
    action === "MarkKitchenOrderItemReady"
      ? {
          action,
          idempotencyKey: "kitchen-test-idempotency-0001",
          actorReference: refs.expoActor,
          brandReference: refs.brand,
          storeReference: refs.store,
          ticketReference: refs.ticket,
          orderItemReference: refs.orderItem,
          expectedTicketVersion: version,
          workItems: [{ workItemReference: refs.workItem, expectedWorkItemVersion: version }],
          correlationReference: refs.correlation,
          ...overrides,
        }
      : {
          action,
          idempotencyKey: "kitchen-test-idempotency-0001",
          actorReference: refs.actor,
          brandReference: refs.brand,
          storeReference: refs.store,
          ticketReference: refs.ticket,
          workItemReference: refs.workItem,
          orderItemReference: refs.orderItem,
          expectedTicketVersion: version,
          expectedWorkItemVersion: version,
          correlationReference: refs.correlation,
          ...(action === "CompleteKitchenWorkItem" ? { quantityDelta: 1 } : {}),
          ...overrides,
        };
  return parseKitchenWorkLifecycleCommand(value);
}

function admissionEvidence(
  activeCommand: KitchenWorkLifecycleCommand,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    decisionReference: refs.admission,
    decisionVersion: 1,
    decisionDigest: sha256("admission"),
    producerContractVersion: 1,
    actorReference: activeCommand.actorReference,
    brandReference: activeCommand.brandReference,
    storeReference: activeCommand.storeReference,
    ticketReference: activeCommand.ticketReference,
    workItemReference: refs.workItem,
    acceptedOperationReference: refs.acceptedOperation,
    ticketVersion: 2n,
    workItemVersion: 2n,
    action: "StartKitchenWorkItem",
    purpose: "KitchenWorkExecution",
    outcome: "Allowed",
    evaluatedAt: "2026-08-09T11:30:00.000Z",
    validUntil: "2026-08-09T13:00:00.000Z",
    ...overrides,
  };
}

function expoEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    decisionReference: refs.expo,
    decisionVersion: 1,
    decisionDigest: sha256("expo"),
    producerContractVersion: 1,
    brandReference: refs.brand,
    storeReference: refs.store,
    purpose: "KitchenReadiness",
    mode: "Enabled",
    evaluatedAt: "2026-08-09T11:59:00.000Z",
    validUntil: "2026-08-09T13:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly command?: KitchenWorkLifecycleCommand;
  readonly source?: unknown | null;
  readonly authorization?: boolean;
  readonly expoMode?: "Enabled" | "Disabled";
  readonly admissionOutcome?: "Allowed" | "Blocked";
  readonly now?: string;
  readonly referenceSeed?: number;
}

function harness(options: HarnessOptions = {}) {
  let activeCommand = options.command ?? command();
  let sourceValue: unknown | null = options.source ?? source();
  let stored: KitchenWorkLifecycleEffect | null = null;
  let currentObservedAt = observedAt;
  let currentCorrelation: string = activeCommand.correlationReference;
  let currentNow = options.now ?? actionAt;
  let next = options.referenceSeed ?? 100;
  const calls: string[] = [];
  const transaction = {
    query: vi.fn(async () => ({ rowCount: 1 })),
  } as unknown as ConsumerTransaction;
  const authorize = vi.fn(async () => {
    calls.push("authorize");
    return options.authorization ?? true;
  });
  const resolveAuthority = vi.fn(async () => {
    calls.push("authority");
    return {
      actorReference: activeCommand.actorReference,
      brandReference: activeCommand.brandReference,
      storeReference: activeCommand.storeReference,
      observedAt: currentObservedAt,
    };
  });
  const resolveCorrelation = vi.fn(async () => {
    calls.push("correlation");
    return { correlationReference: currentCorrelation };
  });
  const loadSourceForUpdate = vi.fn(async () => {
    calls.push("source");
    return sourceValue;
  });
  const resolveAdmission = vi.fn(async () => {
    calls.push("admission");
    return admissionEvidence(activeCommand, {
      outcome: options.admissionOutcome ?? "Allowed",
    });
  });
  const resolveExpo = vi.fn(async () => {
    calls.push("expo");
    return expoEvidence({ mode: options.expoMode ?? "Enabled" });
  });
  const withTransaction = async <T>(
    operation: (value: ConsumerTransaction) => Promise<T>,
  ): Promise<T> => operation(transaction);
  const installTenantContext = vi.fn(async () => {
    calls.push("tenant");
  });
  const acquireFence = vi.fn(async () => {
    calls.push("fence");
  });
  const resolveByIdempotency = vi.fn(async () => {
    calls.push("lookup");
    return stored === null
      ? ({ status: "NotFound" } as const)
      : ({ status: "Found", effect: stored } as const);
  });
  const commit = vi.fn(async ({ effect }: { readonly effect: KitchenWorkLifecycleEffect }) => {
    calls.push("commit");
    stored = effect;
    return { status: "Committed" as const, effect };
  });
  const nextReference = vi.fn((purpose: string) => {
    calls.push(`reference:${purpose}`);
    next += 1;
    return id(next);
  });
  const deriveReference = vi.fn((purpose: string) => {
    calls.push(`derive:${purpose}`);
    return purpose === "KitchenAutomaticOrderItemReadyOperation" ? id(900) : id(901);
  });
  const now = vi.fn(() => {
    calls.push("clock");
    return currentNow;
  });
  const computeDigest = vi.fn((value: string) => {
    calls.push("digest");
    return sha256(value);
  });
  const ports: KitchenWorkLifecyclePorts = {
    trustedContext: {
      resolveAuthority,
    },
    correlationContext: {
      resolve: resolveCorrelation,
    },
    authorization: { authorize },
    transactions: {
      withTransaction: async (operation) => {
        calls.push("transaction");
        return withTransaction(operation);
      },
    },
    tenantContext: {
      install: installTenantContext,
    },
    idempotency: {
      acquireFence,
    },
    repository: {
      resolveByIdempotency,
      loadSourceForUpdate,
      commit,
    },
    admission: { resolve: resolveAdmission },
    expo: { resolve: resolveExpo },
    references: {
      next: nextReference,
      derive: deriveReference,
    },
    clock: {
      now,
    },
    digests: { sha256: computeDigest },
  };
  return {
    calls,
    ports,
    service: createKitchenWorkLifecycleService(ports),
    authorize,
    resolveAuthority,
    resolveCorrelation,
    loadSourceForUpdate,
    resolveAdmission,
    resolveExpo,
    withTransaction,
    installTenantContext,
    acquireFence,
    resolveByIdempotency,
    commit,
    nextReference,
    deriveReference,
    now,
    computeDigest,
    effect: () => stored,
    setCommand(value: KitchenWorkLifecycleCommand) {
      activeCommand = value;
    },
    setSource(value: unknown | null) {
      sourceValue = value;
    },
    setCorrelation(value: string) {
      currentCorrelation = value;
    },
    setObservedAt(value: string) {
      currentObservedAt = value;
    },
    setNow(value: string) {
      currentNow = value;
    },
    setStored(value: KitchenWorkLifecycleEffect | null) {
      stored = value;
    },
  };
}

function expectCode(code: string) {
  return expect.objectContaining({ code, message: "kitchen work is unavailable" });
}

function expectThrownCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("expected lifecycle failure");
  } catch (error) {
    expect(error).toEqual(expectCode(code));
  }
}

function rehashEffect(
  effect: KitchenWorkLifecycleEffect,
  replacements: Partial<Omit<KitchenWorkLifecycleEffect, "effectDigest">>,
): KitchenWorkLifecycleEffect {
  const candidate = { ...effect, ...replacements };
  const { effectDigest: _priorDigest, ...binding } = candidate;
  void _priorDigest;
  return {
    ...binding,
    effectDigest: sha256(canonicalizeKitchenWorkLifecycle(binding)),
  };
}

function rebindCapturedExpo(
  value: KitchenCapturedExpoDecision,
  replacements: Readonly<Record<string, unknown>>,
): KitchenCapturedExpoDecision {
  const candidate = { ...value, ...replacements };
  const { capturedExpoBindingDigest: priorDigest, ...binding } = candidate;
  void priorDigest;
  return {
    ...binding,
    capturedExpoBindingDigest: sha256(canonicalizeKitchenWorkLifecycle(binding)),
  } as KitchenCapturedExpoDecision;
}

describe("Kitchen work lifecycle contracts", () => {
  it("strictly parses the four closed commands and excludes idempotency/correlation from intent", () => {
    const first = command("AcceptKitchenWorkItem");
    const second = command("AcceptKitchenWorkItem", {
      idempotencyKey: "kitchen-test-idempotency-9999",
      correlationReference: refs.retryCorrelation,
    });
    expect(createKitchenWorkLifecycleIntentBinding(first)).toBe(
      createKitchenWorkLifecycleIntentBinding(second),
    );
    expect(
      createKitchenWorkLifecycleIntentBinding(
        command("AcceptKitchenWorkItem", { expectedTicketVersion: "2" }),
      ),
    ).not.toBe(createKitchenWorkLifecycleIntentBinding(first));
    const ready = command("MarkKitchenOrderItemReady");
    expect(ready.action === "MarkKitchenOrderItemReady" && ready.workItems).toHaveLength(1);
    expect(() =>
      parseKitchenWorkLifecycleCommand({ ...first, operationReference: id(99) }),
    ).toThrow(KitchenWorkLifecycleError);
    if (ready.action !== "MarkKitchenOrderItemReady") throw new Error("invalid Ready fixture");
    expect(() => parseKitchenWorkLifecycleCommand({ ...ready, workItems: [] })).toThrow();
    expect(() =>
      parseKitchenWorkLifecycleCommand({
        ...ready,
        workItems: [ready.workItems[0], ready.workItems[0]],
      }),
    ).toThrow();
    expect(() =>
      parseKitchenWorkLifecycleCommand({
        ...ready,
        workItems: [{ ...ready.workItems[0], extra: null }],
      }),
    ).toThrow();
  });

  it("never executes command, discriminant or canonicalization accessors/coercions", () => {
    let executions = 0;
    const getter = { ...command() };
    Object.defineProperty(getter, "actorReference", {
      enumerable: true,
      get: () => {
        executions += 1;
        return refs.actor;
      },
    });
    expect(() => parseKitchenWorkLifecycleCommand(getter)).toThrow();
    const coercion = {
      [Symbol.toPrimitive]: () => {
        executions += 1;
        return "AcceptKitchenWorkItem";
      },
    };
    expect(() => parseKitchenWorkLifecycleCommand({ ...command(), action: coercion })).toThrow();
    const canonical = { safe: true };
    Object.defineProperty(canonical, "unsafe", {
      enumerable: true,
      get: () => {
        executions += 1;
        return true;
      },
    });
    expect(() => canonicalizeKitchenWorkLifecycle(canonical)).toThrow();
    expect(executions).toBe(0);
  });

  it("rejects root and nested proxies without invoking their traps", () => {
    let traps = 0;
    const proxy = new Proxy(command(), {
      get: (target, property, receiver) => {
        traps += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor: (target, property) => {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf: (target) => {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => parseKitchenWorkLifecycleCommand(proxy)).toThrow(KitchenWorkLifecycleError);
    const ready = command("MarkKitchenOrderItemReady");
    if (ready.action !== "MarkKitchenOrderItemReady") throw new Error("invalid Ready fixture");
    const nested = {
      ...ready,
      workItems: new Proxy(ready.workItems, {
        get: (target, property, receiver) => {
          traps += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
    };
    expect(() => parseKitchenWorkLifecycleCommand(nested)).toThrow(KitchenWorkLifecycleError);
    expect(traps).toBe(0);
  });

  it("bounds public and stored versions to positive PostgreSQL bigint", () => {
    expectThrownCode(
      () => parseKitchenWorkLifecycleCommand({ ...command(), expectedTicketVersion: "01" }),
      "KITCHEN_WORK_INPUT_INVALID",
    );
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleCommand({
          ...command(),
          expectedTicketVersion: "9223372036854775808",
        }),
      "KITCHEN_WORK_INPUT_INVALID",
    );
    expectThrownCode(
      () => parseKitchenWorkLifecycleCommand({ ...command(), expectedTicketVersion: 2 ** 53 }),
      "KITCHEN_WORK_INPUT_INVALID",
    );
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...source(),
          ticketVersion: 9_223_372_036_854_775_808n,
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
    const arbitraryVersionSource = source("Start");
    const arbitraryVersionTarget = {
      ...arbitraryVersionSource.target,
      workItemVersion: 4n,
    };
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...arbitraryVersionSource,
          ticketVersion: 4n,
          target: arbitraryVersionTarget,
          siblings: [arbitraryVersionTarget],
          acceptedOperation: {
            ...arbitraryVersionSource.acceptedOperation,
            resultTicketVersion: 4n,
            resultWorkItemVersion: 4n,
          },
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...source("Start"),
          ticketVersion: 1n,
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...source("Start"),
          ticketUpdatedAt: createdAt,
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
    const wrongPredecessorSlot = source("Start");
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...wrongPredecessorSlot,
          acceptedOperation: {
            ...wrongPredecessorSlot.acceptedOperation,
            actionCode: "KITCHEN_WORK_ITEM_STARTED",
          },
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
    const aliasedPredecessors = source("Complete");
    expectThrownCode(
      () =>
        parseKitchenWorkLifecycleSource({
          ...aliasedPredecessors,
          startedOperation: {
            ...aliasedPredecessors.startedOperation,
            operationReference: refs.acceptedOperation,
          },
        }),
      "KITCHEN_WORK_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("rejects outcome/status/quantity drift in a public result", () => {
    expect(() =>
      parseKitchenWorkLifecycleResult({
        operationReference: id(20),
        action: "AcceptKitchenWorkItem",
        outcome: "Accepted",
        ticketReference: refs.ticket,
        workItemReference: refs.workItem,
        orderItemReference: refs.orderItem,
        ticketVersion: "2",
        workItemVersion: "2",
        workItemStatus: "Held",
        completedQuantity: 0,
        requiredQuantity: 3,
        occurredAt: actionAt,
        readyResultReference: null,
        readyQuantity: null,
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
        projectionTriggers: ["KitchenLifecycleEvent"],
      }),
    ).toThrow();
  });

  it("accepts quantity 999 and rejects partial completion masquerading as completed", () => {
    const result = parseKitchenWorkLifecycleResult({
      operationReference: id(20),
      action: "CompleteKitchenWorkItem",
      outcome: "ProgressRecorded",
      ticketReference: refs.ticket,
      workItemReference: refs.workItem,
      orderItemReference: refs.orderItem,
      ticketVersion: "2",
      workItemVersion: "2",
      workItemStatus: "In Progress",
      completedQuantity: 998,
      requiredQuantity: 999,
      occurredAt: actionAt,
      readyResultReference: null,
      readyQuantity: null,
      projectionName: "kitchen_work_queue_v1",
      projectionPending: true,
      projectionTriggers: ["KitchenLifecycleEvent"],
    });
    const event = createKitchenWorkLifecycleEnvelope({
      eventReference: id(21),
      operationReference: id(20),
      actorReference: refs.actor,
      correlationReference: refs.correlation,
      brandReference: refs.brand,
      storeReference: refs.store,
      result,
      quantityDelta: 1,
    });
    expect(parseKitchenItemProgressRecordedEnvelope(event).payload.requiredQuantity).toBe(999);
    const semanticBinding = createKitchenWorkLifecycleEventSemanticBinding(event);
    expect(createKitchenWorkLifecycleEventSemanticBinding({ ...event, eventId: id(24) })).toBe(
      semanticBinding,
    );
    expect(
      createKitchenWorkLifecycleEventSemanticBinding({ ...event, correlationId: id(25) }),
    ).not.toBe(semanticBinding);
    expect(() =>
      parseKitchenItemCompletedEnvelope({
        ...event,
        eventType: "KitchenItemCompleted",
        payload: {
          ...event.payload,
          fromStatus: "In Progress",
          toStatus: "Completed",
          completedAt: actionAt,
        },
      }),
    ).toThrow();
    expect(() =>
      parseKitchenItemProgressRecordedEnvelope({
        ...event,
        payload: {
          ...event.payload,
          quantityDelta: 3,
          completedQuantity: 2,
          requiredQuantity: 4,
        },
      }),
    ).toThrow();
    expect(() =>
      createKitchenWorkLifecycleEnvelope({
        eventReference: id(22),
        operationReference: id(23),
        actorReference: refs.actor,
        correlationReference: refs.correlation,
        brandReference: refs.brand,
        storeReference: refs.store,
        result,
        quantityDelta: 1,
      }),
    ).toThrow();
    expect(() =>
      parseKitchenWorkLifecycleEnvelope({
        ...event,
        eventId: event.causationId,
      }),
    ).toThrow();
  });

  it("does not coerce a hostile Event discriminant", () => {
    let coercions = 0;
    expect(() =>
      parseKitchenWorkLifecycleEnvelope({
        eventType: {
          toString: () => {
            coercions += 1;
            return "KitchenWorkAccepted";
          },
        },
      }),
    ).toThrow();
    expect(coercions).toBe(0);
  });
});

describe("Kitchen work lifecycle service", () => {
  it("accepts a queued Work Item with exact authorization/RLS/fence order and atomic effect", async () => {
    const test = harness();
    const result = await test.service.execute(command());
    expect(result).toMatchObject({
      action: "AcceptKitchenWorkItem",
      outcome: "Accepted",
      ticketVersion: "2",
      workItemVersion: "2",
      workItemStatus: "Queued",
      completedQuantity: 0,
      projectionPending: true,
    });
    expect(parseKitchenWorkAcceptedEnvelope(test.effect()?.event).payload.acceptedAt).toBe(
      actionAt,
    );
    expect(test.effect()).toMatchObject({
      operation: {
        actionCode: "KITCHEN_WORK_ITEM_ACCEPTED",
        reasonCode: "WORK_ITEM_ACCEPTED",
        actorType: "User",
      },
      mutation: { beforeStatus: "Queued", afterStatus: "Queued" },
    });
    const effect = test.effect();
    if (effect === null || effect.event === null || effect.audits[0] === undefined)
      throw new Error("missing lifecycle evidence anchors");
    expect(effect.operation.auditSemanticDigest).toBe(
      sha256(createKitchenWorkLifecycleAuditSemanticBinding(effect.audits[0])),
    );
    expect(effect.operation.eventSemanticDigest).toBe(
      sha256(createKitchenWorkLifecycleEventSemanticBinding(effect.event)),
    );
    expect(test.calls.slice(0, 9)).toEqual([
      "authority",
      "correlation",
      "authorize",
      "transaction",
      "tenant",
      "fence",
      "lookup",
      "digest",
      "reference:KitchenWorkLifecycleOperation",
    ]);
    expect(test.calls.indexOf("source")).toBeGreaterThan(test.calls.indexOf("lookup"));
  });

  it("starts only with exact Allowed admission and the accepting claim owner", async () => {
    const start = command("StartKitchenWorkItem");
    const test = harness({ command: start, source: source("Start") });
    const result = await test.service.execute(start);
    expect(result).toMatchObject({ outcome: "Started", workItemStatus: "In Progress" });
    expect(parseKitchenWorkStartedEnvelope(test.effect()?.event).payload).toMatchObject({
      fromStatus: "Queued",
      toStatus: "In Progress",
    });
    expect(test.resolveAdmission).toHaveBeenCalledTimes(1);

    const blocked = harness({
      command: start,
      source: source("Start"),
      admissionOutcome: "Blocked",
    });
    await expect(blocked.service.execute(start)).rejects.toEqual(
      expectCode("KITCHEN_WORK_PRECONDITION_FAILED"),
    );
    expect(blocked.effect()).toBeNull();
    expect(blocked.now).not.toHaveBeenCalled();

    const wrongOwnerSource = source("Start");
    const wrongOwner = harness({
      command: parseKitchenWorkLifecycleCommand({ ...start, actorReference: refs.expoActor }),
      source: wrongOwnerSource,
    });
    await expect(
      wrongOwner.service.execute(
        parseKitchenWorkLifecycleCommand({ ...start, actorReference: refs.expoActor }),
      ),
    ).rejects.toEqual(expectCode("KITCHEN_WORK_PRECONDITION_FAILED"));
  });

  it("publishes progress only for a partial delta and Completed only at full quantity", async () => {
    const partial = command("CompleteKitchenWorkItem");
    const partialTest = harness({ command: partial, source: source("Complete") });
    const partialResult = await partialTest.service.execute(partial);
    expect(partialResult).toMatchObject({
      outcome: "ProgressRecorded",
      completedQuantity: 1,
      workItemStatus: "In Progress",
    });
    expect(
      parseKitchenItemProgressRecordedEnvelope(partialTest.effect()?.event).payload,
    ).toMatchObject({
      quantityDelta: 1,
      completedQuantity: 1,
      requiredQuantity: 3,
    });
    expect(partialTest.resolveExpo).not.toHaveBeenCalled();

    const final = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const finalTest = harness({ command: final, source: source("Complete"), expoMode: "Enabled" });
    const finalResult = await finalTest.service.execute(final);
    expect(finalResult).toMatchObject({ outcome: "Completed", workItemStatus: "Completed" });
    expect(parseKitchenItemCompletedEnvelope(finalTest.effect()?.event).payload).toMatchObject({
      quantityDelta: 3,
      completedQuantity: 3,
    });
    expect(finalTest.effect()?.readyResult).toBeNull();
  });

  it("creates the eventless automatic Ready child only for Expo Disabled", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const test = harness({ command: complete, source: source("Complete"), expoMode: "Disabled" });
    const result = await test.service.execute(complete);
    const effect = test.effect();
    expect(result).toMatchObject({
      outcome: "CompletedAndOrderItemReady",
      readyQuantity: 3,
      projectionTriggers: ["KitchenLifecycleEvent", "KitchenReadyEvent"],
    });
    expect(parseKitchenItemCompletedEnvelope(effect?.event).eventType).toBe("KitchenItemCompleted");
    expect(effect?.automaticReadyOperation).toMatchObject({
      action: "AutomaticKitchenOrderItemReady",
      actionCode: "KITCHEN_ORDER_ITEM_READY",
      reasonCode: "ALL_WORK_ITEMS_COMPLETED",
      actorType: "System",
      eventReference: null,
    });
    expect(effect?.automaticReadyEffectDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(effect?.readyResult?.causalOperationReference).toBe(
      effect?.automaticReadyOperation?.operationReference,
    );
    expect(effect?.audits).toHaveLength(2);
    if (
      effect === null ||
      effect.automaticReadyOperation === null ||
      effect.audits[1] === undefined
    )
      throw new Error("missing automatic Ready evidence anchors");
    expect(effect.automaticReadyOperation.auditSemanticDigest).toBe(
      sha256(createKitchenWorkLifecycleAuditSemanticBinding(effect.audits[1])),
    );
    expect(effect.automaticReadyOperation.eventSemanticDigest).toBeNull();
    expect(parseKitchenItemReadyEnvelope(effect.readyPublication?.itemEvent)).toMatchObject({
      aggregateId: effect.readyResult?.readyResultReference,
      causationId: effect.automaticReadyOperation.operationReference,
      actor: { type: "System" },
      payload: {
        orderReference: refs.order,
        orderBatchReference: refs.batch,
        orderItemReference: refs.orderItem,
        readyQuantity: 3,
        requiredQuantity: 3,
      },
    });
    expect(parseKitchenOrderReadyEnvelope(effect.readyPublication?.orderEvent)).toMatchObject({
      aggregateId: refs.ticket,
      aggregateVersion: 4n,
      payload: { readyItemCount: 1, itemCount: 1 },
    });
  });

  it("allows a different authorized Expo operator to Mark Ready without a current Expo call", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const finalTest = harness({
      command: complete,
      source: source("Complete"),
      expoMode: "Enabled",
    });
    await finalTest.service.execute(complete);
    const captured = finalTest.effect()?.operation.capturedExpo;
    expect(captured).not.toBeNull();

    const ready = command("MarkKitchenOrderItemReady");
    const readyTest = harness({
      command: ready,
      source: source("MarkReady", captured as KitchenCapturedExpoDecision),
      referenceSeed: 200,
    });
    readyTest.setObservedAt("2026-08-09T12:10:00.000Z");
    readyTest.setNow("2026-08-09T12:10:01.000Z");
    const result = await readyTest.service.execute(ready);
    expect(result).toMatchObject({
      outcome: "OrderItemReady",
      workItemStatus: "Completed",
      workItemVersion: "4",
      ticketVersion: "5",
      projectionTriggers: ["KitchenReadyEvent"],
    });
    expect(readyTest.resolveExpo).not.toHaveBeenCalled();
    expect(readyTest.effect()?.event).toBeNull();
    expect(readyTest.effect()?.operation.actorReference).toBe(refs.expoActor);
    expect(readyTest.effect()?.readyPublication).toMatchObject({
      orderReference: refs.order,
      orderBatchReference: refs.batch,
      causationReference: readyTest.effect()?.operation.operationReference,
      itemCount: 1,
    });
    expect(readyTest.effect()?.readyPublication?.itemEvent.actor).toEqual({ type: "System" });

    const advancedReady = command("MarkKitchenOrderItemReady", {
      expectedTicketVersion: "7",
    });
    const advancedSource = {
      ...source("MarkReady", captured as KitchenCapturedExpoDecision),
      ticketVersion: 7n,
      ticketUpdatedAt: "2026-08-09T12:09:00.000Z",
    };
    const advanced = harness({
      command: advancedReady,
      source: advancedSource,
      referenceSeed: 300,
    });
    advanced.setObservedAt("2026-08-09T12:10:00.000Z");
    advanced.setNow("2026-08-09T12:10:01.000Z");
    await expect(advanced.service.execute(advancedReady)).resolves.toMatchObject({
      outcome: "OrderItemReady",
      ticketVersion: "8",
      workItemVersion: "4",
    });

    const futureCaptured = harness({
      command: advancedReady,
      source: {
        ...advancedSource,
        capturedExpo: rebindCapturedExpo(captured as KitchenCapturedExpoDecision, {
          sourceExpectedTicketVersion: 7n,
          sourceCommittedTicketVersion: 8n,
        }),
      },
      referenceSeed: 400,
    });
    futureCaptured.setObservedAt("2026-08-09T12:10:00.000Z");
    futureCaptured.setNow("2026-08-09T12:10:01.000Z");
    await expect(futureCaptured.service.execute(advancedReady)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(futureCaptured.effect()).toBeNull();
    expect(futureCaptured.now).not.toHaveBeenCalled();
  });

  it("publishes Item Ready but not Order Ready while another Ticket Item remains unready", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const base = source("Complete");
    const test = harness({
      command: complete,
      expoMode: "Disabled",
      source: {
        ...base,
        ticketReadiness: [
          base.ticketReadiness[0],
          {
            orderItemReference: refs.otherOrderItem,
            requiredQuantity: 2,
            readyResultReference: null,
            readyQuantity: null,
            readyAt: null,
          },
        ],
      },
    });
    await test.service.execute(complete);
    expect(test.effect()?.readyPublication?.itemEvent.eventType).toBe("KitchenItemReady");
    expect(test.effect()?.readyPublication?.orderEvent).toBeNull();
    expect(test.effect()?.readyPublication?.orderEventSemanticDigest).toBeNull();
    expect(test.effect()?.readyPublication?.itemCount).toBe(2);
  });

  it("replays under a fresh trusted correlation while preserving original durable lineage", async () => {
    const first = command();
    const test = harness({ command: first });
    const original = await test.service.execute(first);
    const stored = test.effect();
    const sourceCalls = test.loadSourceForUpdate.mock.calls.length;
    const referenceCalls = test.calls.filter((entry) => entry.startsWith("reference:")).length;

    const retry = command("AcceptKitchenWorkItem", {
      correlationReference: refs.retryCorrelation,
    });
    test.setCommand(retry);
    test.setCorrelation(refs.retryCorrelation);
    test.setObservedAt("2026-08-09T12:00:02.000Z");
    const replay = await test.service.execute(retry);
    expect(replay).toEqual(original);
    expect(test.effect()).toBe(stored);
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(sourceCalls);
    expect(test.calls.filter((entry) => entry.startsWith("reference:")).length).toBe(
      referenceCalls,
    );
    expect(stored?.operation.correlationReference).toBe(refs.correlation);
  });

  it("reconciles a commit-unknown through the scoped fence without repeating source work", async () => {
    const accept = command();
    const test = harness({ command: accept });
    test.setObservedAt(actionAt);
    const commitImplementation = test.commit.getMockImplementation();
    expect(commitImplementation).toBeDefined();
    test.commit.mockImplementationOnce(async (input) => {
      await commitImplementation?.(input);
      throw new Error("synthetic commit acknowledgement loss");
    });
    const result = await test.service.execute(accept);
    expect(result).toEqual(test.effect()?.result);
    expect(test.resolveByIdempotency).toHaveBeenCalledTimes(2);
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(1);
    expect(test.commit).toHaveBeenCalledTimes(1);
    expect(test.calls.filter((entry) => entry.startsWith("reference:"))).toHaveLength(3);
  });

  it("retries the full fenced path only after commit uncertainty resolves NotFound", async () => {
    const accept = command();
    const test = harness({ command: accept });
    test.commit.mockRejectedValueOnce(new Error("synthetic rollback before commit"));
    const result = await test.service.execute(accept);
    expect(result).toEqual(test.effect()?.result);
    expect(test.resolveByIdempotency).toHaveBeenCalledTimes(2);
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(2);
    expect(test.commit).toHaveBeenCalledTimes(2);
    expect(
      test.calls.filter((entry) => entry === "reference:KitchenWorkLifecycleOperation"),
    ).toHaveLength(2);
  });

  it("makes concurrent same-intent callers adopt the fence winner exactly", async () => {
    const winnerCandidate = command("StartKitchenWorkItem");
    const waiterCandidate = command("StartKitchenWorkItem", {
      correlationReference: refs.retryCorrelation,
    });
    const first = harness({
      command: winnerCandidate,
      source: source("Start"),
      referenceSeed: 100,
    });
    const second = harness({
      command: waiterCandidate,
      source: source("Start"),
      referenceSeed: 200,
    });
    first.setObservedAt(actionAt);
    second.setObservedAt(actionAt);
    second.setCorrelation(refs.retryCorrelation);

    const shared: { effect: KitchenWorkLifecycleEffect | null } = { effect: null };
    let arrivals = 0;
    let openBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    let lockTail = Promise.resolve();
    const releaseByTransaction = new Map<ConsumerTransaction, () => void>();

    const concurrentPorts = (
      base: KitchenWorkLifecyclePorts,
      trace: string[],
    ): KitchenWorkLifecyclePorts => ({
      ...base,
      transactions: {
        withTransaction: async <T>(operation: (transaction: ConsumerTransaction) => Promise<T>) => {
          const transaction = {
            query: vi.fn(async () => ({ rowCount: 1 })),
          } as unknown as ConsumerTransaction;
          try {
            return await operation(transaction);
          } finally {
            releaseByTransaction.get(transaction)?.();
            releaseByTransaction.delete(transaction);
          }
        },
      },
      idempotency: {
        acquireFence: async ({ transaction }) => {
          trace.push("fence");
          arrivals += 1;
          if (arrivals === 2) openBarrier();
          await barrier;
          const previous = lockTail;
          let release: () => void = () => undefined;
          lockTail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          releaseByTransaction.set(transaction, release);
        },
      },
      repository: {
        resolveByIdempotency: async () => (
          trace.push("lookup"),
          shared.effect === null
            ? { status: "NotFound" as const }
            : { status: "Found" as const, effect: shared.effect }
        ),
        loadSourceForUpdate: base.repository.loadSourceForUpdate,
        commit: async ({ effect }) => {
          shared.effect = effect;
          return { status: "Committed" as const, effect };
        },
      },
    });

    const firstService = createKitchenWorkLifecycleService(
      concurrentPorts(first.ports, first.calls),
    );
    const secondService = createKitchenWorkLifecycleService(
      concurrentPorts(second.ports, second.calls),
    );
    const [firstResult, secondResult] = await Promise.all([
      firstService.execute(winnerCandidate),
      secondService.execute(waiterCandidate),
    ]);
    expect(arrivals).toBe(2);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual(shared.effect?.result);
    expect(
      first.loadSourceForUpdate.mock.calls.length + second.loadSourceForUpdate.mock.calls.length,
    ).toBe(1);
    expect(
      first.resolveAdmission.mock.calls.length + second.resolveAdmission.mock.calls.length,
    ).toBe(1);
    expect(
      [...first.calls, ...second.calls].filter(
        (entry) => entry === "reference:KitchenWorkLifecycleOperation",
      ),
    ).toHaveLength(1);
    expect([refs.correlation, refs.retryCorrelation]).toContain(
      shared.effect?.operation.correlationReference,
    );
    for (const trace of [first.calls, second.calls]) {
      expect(trace.indexOf("lookup")).toBeGreaterThan(trace.indexOf("fence"));
      expect(trace.indexOf("digest")).toBeGreaterThan(trace.indexOf("lookup"));
    }
  });

  it("rejects recomputed malformed Found status, version, Audit and Event bundles", async () => {
    const accept = command();
    const test = harness({ command: accept });
    await test.service.execute(accept);
    test.setObservedAt("2026-08-09T12:00:02.000Z");
    const stored = test.effect();
    expect(stored).not.toBeNull();
    if (stored === null || stored.event === null || stored.audits[0] === undefined)
      throw new Error("missing fixture effect");
    const referenceCalls = test.calls.filter((entry) => entry.startsWith("reference:")).length;
    const parentAudit = stored.audits[0];
    const wrongEventResult = parseKitchenWorkLifecycleResult({
      ...stored.result,
      action: "StartKitchenWorkItem",
      outcome: "Started",
      workItemStatus: "In Progress",
    });
    const wrongEvent = createKitchenWorkLifecycleEnvelope({
      eventReference: stored.event.eventId,
      operationReference: stored.operation.operationReference,
      actorReference: accept.actorReference,
      correlationReference: accept.correlationReference,
      brandReference: accept.brandReference,
      storeReference: accept.storeReference,
      result: wrongEventResult,
      quantityDelta: null,
    });
    const drifts = [
      rehashEffect(stored, {
        mutation: { ...stored.mutation, afterStatus: "Held" },
      }),
      rehashEffect(stored, {
        mutation: {
          ...stored.mutation,
          resultTicketVersion: stored.mutation.resultTicketVersion + 1n,
        },
      }),
      rehashEffect(stored, {
        audits: Object.freeze([
          Object.freeze({ ...parentAudit, actionCode: "KITCHEN_WORK_ITEM_STARTED" }),
        ]),
      }),
      rehashEffect(stored, { event: wrongEvent }),
      rehashEffect(stored, {
        operation: {
          ...stored.operation,
          auditSemanticDigest: sha256("drifted audit semantic anchor"),
        },
      }),
      rehashEffect(stored, {
        operation: {
          ...stored.operation,
          eventSemanticDigest: sha256("drifted event semantic anchor"),
        },
      }),
      {
        ...stored,
        effectDigest: sha256("drifted outer effect digest"),
      },
    ];
    for (const drift of drifts) {
      test.resolveByIdempotency.mockResolvedValueOnce({ status: "Found", effect: drift });
      await expect(test.service.execute(accept)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
    }
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(1);
    expect(test.calls.filter((entry) => entry.startsWith("reference:")).length).toBe(
      referenceCalls,
    );
  });

  it("does not retry source work when a malformed Found Event parser fails", async () => {
    const accept = command();
    const test = harness({ command: accept });
    await test.service.execute(accept);
    test.setObservedAt("2026-08-09T12:00:02.000Z");
    const stored = test.effect();
    if (stored === null || stored.event === null) throw new Error("missing Event fixture");
    const malformed = rehashEffect(stored, {
      event: {
        ...stored.event,
        eventType: "MalformedLifecycleEvent",
      } as unknown as typeof stored.event,
    });
    const sourceCalls = test.loadSourceForUpdate.mock.calls.length;
    const referenceCalls = test.calls.filter((entry) => entry.startsWith("reference:")).length;
    test.resolveByIdempotency
      .mockResolvedValueOnce({ status: "Found", effect: malformed })
      .mockResolvedValueOnce({ status: "NotFound" });
    await expect(test.service.execute(accept)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(test.resolveByIdempotency).toHaveBeenCalledTimes(2);
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(sourceCalls);
    expect(test.calls.filter((entry) => entry.startsWith("reference:")).length).toBe(
      referenceCalls,
    );
  });

  it("rejects recomputed Ready bundles with changed causation or child semantic anchors", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const test = harness({ command: complete, source: source("Complete"), expoMode: "Disabled" });
    await test.service.execute(complete);
    test.setObservedAt("2026-08-09T12:00:02.000Z");
    const stored = test.effect();
    expect(stored?.readyResult).not.toBeNull();
    expect(stored?.automaticReadyOperation).not.toBeNull();
    if (
      stored === null ||
      stored.readyResult === null ||
      stored.automaticReadyOperation === null ||
      stored.audits[1] === undefined
    )
      throw new Error("missing automatic Ready fixture");
    const readyResult = {
      ...stored.readyResult,
      causalOperationReference: id(777),
    };
    const changedCausationDigest = sha256(
      canonicalizeKitchenWorkLifecycle({
        operation: stored.automaticReadyOperation,
        readyResult,
        audit: stored.audits[1],
        event: null,
      }),
    );
    const changedChildOperation = {
      ...stored.automaticReadyOperation,
      auditSemanticDigest: sha256("drifted child audit semantic anchor"),
    };
    const changedChildDigest = sha256(
      canonicalizeKitchenWorkLifecycle({
        operation: changedChildOperation,
        readyResult: stored.readyResult,
        audit: stored.audits[1],
        event: null,
      }),
    );
    const driftedCapturedExpo = rebindCapturedExpo(stored.readyResult.capturedExpo, {
      validUntil: stored.readyResult.capturedExpo.sourceOccurredAt,
    });
    const changedCaptureOperation = {
      ...stored.operation,
      capturedExpo: driftedCapturedExpo,
    };
    const changedCaptureReadyResult = {
      ...stored.readyResult,
      capturedExpo: driftedCapturedExpo,
    };
    const changedCaptureChildDigest = sha256(
      canonicalizeKitchenWorkLifecycle({
        operation: stored.automaticReadyOperation,
        readyResult: changedCaptureReadyResult,
        audit: stored.audits[1],
        event: null,
      }),
    );
    const drifts = [
      rehashEffect(stored, {
        readyResult,
        automaticReadyEffectDigest: changedCausationDigest,
      }),
      rehashEffect(stored, {
        automaticReadyOperation: changedChildOperation,
        automaticReadyEffectDigest: changedChildDigest,
      }),
      rehashEffect(stored, {
        operation: changedCaptureOperation,
        readyResult: changedCaptureReadyResult,
        automaticReadyEffectDigest: changedCaptureChildDigest,
      }),
    ];
    for (const drift of drifts) {
      test.resolveByIdempotency.mockResolvedValueOnce({ status: "Found", effect: drift });
      await expect(test.service.execute(complete)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
    }
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(1);
  });

  it("validates a prior Ready proof before returning the duplicate precondition", async () => {
    const ready = command("MarkKitchenOrderItemReady");
    const baseSource = source("MarkReady");
    const readyProof = {
      readyResultReference: id(30),
      ticketReference: refs.ticket,
      orderItemReference: refs.orderItem,
      causalOperationReference: id(31),
      workItemsDigest: sha256(
        createKitchenReadyWorkItemsBinding([
          {
            workItemReference: refs.workItem,
            workItemVersion: 4n,
          },
        ]),
      ),
      readyQuantity: 3,
      requiredQuantity: 3,
      readyAt: actionAt,
    } as const;
    const readinessFor = (proof: {
      readonly readyResultReference: string;
      readonly readyQuantity: number;
      readonly requiredQuantity: number;
      readonly readyAt: string;
    }) => [
      {
        orderItemReference: refs.orderItem,
        requiredQuantity: proof.requiredQuantity,
        readyResultReference: proof.readyResultReference,
        readyQuantity: proof.readyQuantity,
        readyAt: proof.readyAt,
      },
    ];
    const duplicate = harness({
      command: ready,
      source: {
        ...baseSource,
        readyResult: readyProof,
        ticketReadiness: readinessFor(readyProof),
      },
      referenceSeed: 200,
    });
    duplicate.setObservedAt("2026-08-09T12:10:00.000Z");
    await expect(duplicate.service.execute(ready)).rejects.toEqual(
      expectCode("KITCHEN_WORK_PRECONDITION_FAILED"),
    );
    expect(duplicate.effect()).toBeNull();
    expect(duplicate.now).not.toHaveBeenCalled();

    const corruptProofs = [
      { ...readyProof, workItemsDigest: sha256("wrong ready vector") },
      { ...readyProof, readyAt: startedAt },
      { ...readyProof, causalOperationReference: readyProof.readyResultReference },
    ];
    for (const corruptProof of corruptProofs) {
      const corrupt = harness({
        command: ready,
        source: {
          ...baseSource,
          readyResult: corruptProof,
          ticketReadiness: readinessFor(corruptProof),
        },
        referenceSeed: 200,
      });
      corrupt.setObservedAt("2026-08-09T12:10:00.000Z");
      await expect(corrupt.service.execute(ready)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
      expect(corrupt.effect()).toBeNull();
      expect(corrupt.now).not.toHaveBeenCalled();
    }

    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const completed = harness({
      command: complete,
      source: source("Complete"),
      expoMode: "Enabled",
    });
    await completed.service.execute(complete);
    const captured = completed.effect()?.operation.capturedExpo;
    if (captured === null || captured === undefined)
      throw new Error("missing captured Expo fixture");
    const readyAfterManual = command("MarkKitchenOrderItemReady", {
      expectedTicketVersion: "5",
    });
    const priorReadyAt = "2026-08-09T12:10:00.000Z";
    const priorManualSource = {
      ...source("MarkReady", captured),
      ticketVersion: 5n,
      ticketUpdatedAt: priorReadyAt,
      readyResult: { ...readyProof, readyAt: priorReadyAt },
      ticketReadiness: readinessFor({ ...readyProof, readyAt: priorReadyAt }),
    };
    const validCaptured = harness({
      command: readyAfterManual,
      source: priorManualSource,
      referenceSeed: 200,
    });
    validCaptured.setObservedAt("2026-08-09T12:11:00.000Z");
    await expect(validCaptured.service.execute(readyAfterManual)).rejects.toEqual(
      expectCode("KITCHEN_WORK_PRECONDITION_FAILED"),
    );
    const corruptCaptured = harness({
      command: readyAfterManual,
      source: {
        ...priorManualSource,
        capturedExpo: rebindCapturedExpo(captured, {
          validUntil: captured.sourceOccurredAt,
        }),
      },
      referenceSeed: 200,
    });
    corruptCaptured.setObservedAt("2026-08-09T12:11:00.000Z");
    await expect(corruptCaptured.service.execute(readyAfterManual)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(corruptCaptured.effect()).toBeNull();
    expect(corruptCaptured.now).not.toHaveBeenCalled();
  });

  it("maps missing, throwing and drifted Start admission evidence to Dependency", async () => {
    const start = command("StartKitchenWorkItem");
    const cases: readonly unknown[] = [
      null,
      { ...admissionEvidence(start), actorReference: refs.expoActor },
      { ...admissionEvidence(start), storeReference: id(70) },
      { ...admissionEvidence(start), ticketReference: id(71) },
      { ...admissionEvidence(start), workItemReference: id(72) },
      { ...admissionEvidence(start), acceptedOperationReference: id(73) },
      { ...admissionEvidence(start), ticketVersion: 3n },
      { ...admissionEvidence(start), workItemVersion: 3n },
      { ...admissionEvidence(start), action: "AcceptKitchenWorkItem" },
      { ...admissionEvidence(start), purpose: "KitchenReadiness" },
      { ...admissionEvidence(start), decisionDigest: "0".repeat(64) },
      { ...admissionEvidence(start), producerContractVersion: 2 },
      { ...admissionEvidence(start), evaluatedAt: "2026-08-09T11:09:59.999Z" },
      { ...admissionEvidence(start), evaluatedAt: "2026-08-09T12:00:02.000Z" },
      { ...admissionEvidence(start), validUntil: actionAt },
      { ...admissionEvidence(start), extra: null },
    ];
    for (const evidence of cases) {
      const test = harness({ command: start, source: source("Start") });
      test.resolveAdmission.mockResolvedValueOnce(evidence as ReturnType<typeof admissionEvidence>);
      await expect(test.service.execute(start)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
      expect(test.effect()).toBeNull();
    }
    const throwing = harness({ command: start, source: source("Start") });
    throwing.resolveAdmission.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(throwing.service.execute(start)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
  });

  it("validates Blocked admission chronology and current validity before classification", async () => {
    const start = command("StartKitchenWorkItem");
    const cases = [
      admissionEvidence(start, {
        outcome: "Blocked",
        evaluatedAt: "2026-08-09T11:09:59.999Z",
      }),
      admissionEvidence(start, {
        outcome: "Blocked",
        evaluatedAt: "2026-08-09T12:00:00.001Z",
      }),
      admissionEvidence(start, {
        outcome: "Blocked",
        validUntil: observedAt,
      }),
    ] as const;
    for (const evidence of cases) {
      const test = harness({ command: start, source: source("Start") });
      test.resolveAdmission.mockResolvedValueOnce(evidence);
      await expect(test.service.execute(start)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
      expect(test.effect()).toBeNull();
      expect(test.now).not.toHaveBeenCalled();
    }
  });

  it("fails closed on unavailable, stale, future and cross-scope Expo evidence", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const cases: readonly unknown[] = [
      null,
      { ...expoEvidence(), storeReference: id(70) },
      { ...expoEvidence(), producerContractVersion: 2 },
      { ...expoEvidence(), decisionDigest: "0".repeat(64) },
      { ...expoEvidence(), evaluatedAt: "2026-08-09T12:00:02.000Z" },
      { ...expoEvidence(), validUntil: actionAt },
      { ...expoEvidence(), extra: null },
    ];
    for (const evidence of cases) {
      const test = harness({ command: complete, source: source("Complete") });
      test.resolveExpo.mockResolvedValueOnce(evidence as ReturnType<typeof expoEvidence>);
      await expect(test.service.execute(complete)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
      expect(test.effect()).toBeNull();
    }
    const throwing = harness({ command: complete, source: source("Complete") });
    throwing.resolveExpo.mockRejectedValueOnce(new Error("synthetic Store decision failure"));
    await expect(throwing.service.execute(complete)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
  });

  it("rejects drifted captured Expo target, version, time and binding anchors", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const completed = harness({
      command: complete,
      source: source("Complete"),
      expoMode: "Enabled",
    });
    await completed.service.execute(complete);
    const captured = completed.effect()?.operation.capturedExpo;
    if (captured === null || captured === undefined)
      throw new Error("missing captured Expo fixture");
    const baseSource = source("MarkReady", captured);
    const drifts = [
      rebindCapturedExpo(captured, { decisionStoreReference: id(70) }),
      rebindCapturedExpo(captured, {
        sourceExpectedTicketVersion: 4n,
        sourceCommittedTicketVersion: 5n,
      }),
      rebindCapturedExpo(captured, { sourceOccurredAt: "2026-08-09T12:00:02.000Z" }),
      rebindCapturedExpo(captured, { validUntil: captured.sourceOccurredAt }),
      { ...captured, decisionDigest: sha256("drift-without-rebinding") },
    ];
    for (const drift of drifts) {
      const ready = command("MarkKitchenOrderItemReady");
      const test = harness({
        command: ready,
        source: { ...baseSource, capturedExpo: drift },
        referenceSeed: 200,
      });
      test.setObservedAt("2026-08-09T12:10:00.000Z");
      test.setNow("2026-08-09T12:10:01.000Z");
      await expect(test.service.execute(ready)).rejects.toEqual(
        expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
      );
      expect(test.effect()).toBeNull();
      expect(test.resolveExpo).not.toHaveBeenCalled();
    }
  });

  it("fails atomically on regressed/throwing clocks and generated-reference failures", async () => {
    const regressed = harness({ now: "2026-08-09T11:59:59.999Z" });
    await expect(regressed.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(regressed.effect()).toBeNull();

    const throwingClock = harness();
    throwingClock.now.mockImplementationOnce(() => {
      throw new Error("synthetic clock failure");
    });
    await expect(throwingClock.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(throwingClock.effect()).toBeNull();

    const badOperation = harness();
    badOperation.nextReference.mockReturnValueOnce("not-a-reference");
    await expect(badOperation.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(badOperation.loadSourceForUpdate).not.toHaveBeenCalled();

    const operationCollision = harness();
    operationCollision.nextReference.mockReturnValueOnce(refs.actor);
    await expect(operationCollision.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(operationCollision.loadSourceForUpdate).not.toHaveBeenCalled();

    const auditCollision = harness();
    auditCollision.nextReference.mockReturnValueOnce(id(101)).mockReturnValueOnce(id(101));
    await expect(auditCollision.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(auditCollision.effect()).toBeNull();

    const automatic = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const stableCollision = harness({
      command: automatic,
      source: source("Complete"),
      expoMode: "Disabled",
    });
    stableCollision.deriveReference.mockReturnValue(id(900));
    await expect(stableCollision.service.execute(automatic)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(stableCollision.effect()).toBeNull();

    const stableThrow = harness({
      command: automatic,
      source: source("Complete"),
      expoMode: "Disabled",
    });
    stableThrow.deriveReference.mockImplementationOnce(() => {
      throw new Error("synthetic derivation failure");
    });
    await expect(stableThrow.service.execute(automatic)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(stableThrow.effect()).toBeNull();
  });

  it("rejects manual Ready stable-reference malformed output and observed-reference collision", async () => {
    const complete = command("CompleteKitchenWorkItem", { quantityDelta: 3 });
    const completed = harness({
      command: complete,
      source: source("Complete"),
      expoMode: "Enabled",
    });
    await completed.service.execute(complete);
    const captured = completed.effect()?.operation.capturedExpo;
    if (captured === null || captured === undefined)
      throw new Error("missing captured Expo fixture");
    const ready = command("MarkKitchenOrderItemReady");

    const malformed = harness({
      command: ready,
      source: source("MarkReady", captured),
      referenceSeed: 200,
    });
    malformed.setObservedAt("2026-08-09T12:10:00.000Z");
    malformed.setNow("2026-08-09T12:10:01.000Z");
    malformed.deriveReference.mockReturnValueOnce("not-a-reference");
    await expect(malformed.service.execute(ready)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(malformed.effect()).toBeNull();

    const collision = harness({
      command: ready,
      source: source("MarkReady", captured),
      referenceSeed: 200,
    });
    collision.setObservedAt("2026-08-09T12:10:00.000Z");
    collision.setNow("2026-08-09T12:10:01.000Z");
    collision.deriveReference.mockReturnValueOnce(captured.sourceOperationReference);
    await expect(collision.service.execute(ready)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(collision.effect()).toBeNull();
  });

  it("leaves zero durable effect when the atomic repository commit never succeeds", async () => {
    const test = harness();
    test.commit.mockRejectedValue(new Error("synthetic atomic write failure"));
    await expect(test.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(test.effect()).toBeNull();
    expect(test.commit).toHaveBeenCalledTimes(2);
  });

  it("separates changed intent conflicts from cross-scope Found corruption", async () => {
    const first = command();
    const test = harness({ command: first });
    await test.service.execute(first);
    const changed = command("AcceptKitchenWorkItem", { expectedTicketVersion: "2" });
    test.setCommand(changed);
    await expect(test.service.execute(changed)).rejects.toEqual(
      expectCode("KITCHEN_WORK_VERSION_CONFLICT"),
    );

    const crossScope = command("AcceptKitchenWorkItem", {
      brandReference: id(70),
      storeReference: id(71),
    });
    test.setCommand(crossScope);
    await expect(test.service.execute(crossScope)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
  });

  it("maps wrong source identity to dependency and exact-scope version mismatch to conflict", async () => {
    const exactCommand = command();
    const wrongIdentity = harness({
      command: exactCommand,
      source: { ...source(), ticketReference: id(77) },
    });
    await expect(wrongIdentity.service.execute(exactCommand)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );

    const changedVersionSource = source();
    const versionMismatch = harness({
      command: exactCommand,
      source: {
        ...changedVersionSource,
        ticketVersion: 2n,
      },
    });
    await expect(versionMismatch.service.execute(exactCommand)).rejects.toEqual(
      expectCode("KITCHEN_WORK_VERSION_CONFLICT"),
    );
  });

  it("rejects replay clock regression and enforces occurred/expiry boundaries", async () => {
    const first = command();
    const test = harness({ command: first });
    const original = await test.service.execute(first);
    const expiry = test.effect()?.operation.replayExpiresAt;
    expect(expiry).not.toBeNull();

    test.setObservedAt("2026-08-09T12:00:00.999Z");
    await expect(test.service.execute(first)).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    test.setObservedAt(actionAt);
    await expect(test.service.execute(first)).resolves.toEqual(original);
    test.setObservedAt("2026-08-09T12:00:01.001Z");
    await expect(test.service.execute(first)).resolves.toEqual(original);

    test.setObservedAt(expiry as string);
    await expect(test.service.execute(first)).rejects.toEqual(
      expectCode("KITCHEN_WORK_VERSION_CONFLICT"),
    );
    test.setObservedAt(new Date(Date.parse(expiry as string) + 1).toISOString());
    await expect(test.service.execute(first)).rejects.toEqual(
      expectCode("KITCHEN_WORK_VERSION_CONFLICT"),
    );
    expect(test.loadSourceForUpdate).toHaveBeenCalledTimes(1);
    expect(test.now).toHaveBeenCalledTimes(1);
  });

  it("denies before transaction/lookup and rejects forbidden mutation-source fields", async () => {
    const denied = harness({ authorization: false });
    await expect(denied.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_PERMISSION_DENIED"),
    );
    expect(denied.calls).not.toContain("transaction");
    expect(denied.calls).not.toContain("lookup");

    const sourceWithForbiddenField = {
      ...source(),
      customerNote: null,
    };
    const strict = harness({ source: sourceWithForbiddenField });
    await expect(strict.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(strict.effect()).toBeNull();
  });

  it("fails closed before lookup on forged context and dependency failures", async () => {
    const wrongAuthority = harness();
    const switchedAuthority = command("AcceptKitchenWorkItem", {
      actorReference: refs.expoActor,
    });
    wrongAuthority.resolveAuthority.mockResolvedValueOnce({
      actorReference: switchedAuthority.actorReference,
      brandReference: switchedAuthority.brandReference,
      storeReference: switchedAuthority.storeReference,
      observedAt,
    });
    await expect(wrongAuthority.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_PERMISSION_DENIED"),
    );
    expect(wrongAuthority.resolveByIdempotency).not.toHaveBeenCalled();

    const wrongCorrelation = harness();
    const retry = command("AcceptKitchenWorkItem", {
      correlationReference: refs.retryCorrelation,
    });
    wrongCorrelation.resolveCorrelation.mockResolvedValueOnce({
      correlationReference: retry.correlationReference,
    });
    await expect(wrongCorrelation.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(wrongCorrelation.resolveByIdempotency).not.toHaveBeenCalled();

    const authorityThrow = harness();
    authorityThrow.resolveAuthority.mockRejectedValueOnce(new Error("synthetic context failure"));
    await expect(authorityThrow.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );

    const authorizationThrow = harness();
    authorizationThrow.authorize.mockRejectedValueOnce(
      new Error("synthetic authorization failure"),
    );
    await expect(authorizationThrow.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );

    const malformedAuthorization = harness();
    malformedAuthorization.authorize.mockResolvedValueOnce({} as never);
    await expect(malformedAuthorization.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );

    const installFailure = harness();
    installFailure.installTenantContext.mockRejectedValueOnce(new Error("synthetic RLS failure"));
    await expect(installFailure.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(installFailure.resolveByIdempotency).not.toHaveBeenCalled();

    const fenceFailure = harness();
    fenceFailure.acquireFence.mockRejectedValueOnce(new Error("synthetic fence failure"));
    await expect(fenceFailure.service.execute(command())).rejects.toEqual(
      expectCode("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE"),
    );
    expect(fenceFailure.resolveByIdempotency).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";

import type { AppendAuditRecordInput } from "@bop/audit";
import { describe, expect, it } from "vitest";

import {
  createPaymentTerminalCaptureWatchdogService,
  parsePaymentTerminalAuthorizationEvidence,
  parsePaymentTerminalCaptureWatchdogResult,
  PaymentTerminalCaptureWatchdogError,
  type PaymentTerminalCaptureWatchdogOperationRecord,
  type PaymentTerminalCaptureWatchdogPorts,
  type PaymentTerminalWatchdogActionReceipt,
  type PaymentTerminalWatchdogTerminalReceipt,
} from "../index.js";

const id = (suffix: string) => `0198a909-0000-7000-8000-${suffix.padStart(12, "0")}`;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const at = "2026-08-08T14:00:00.000Z";

const refs = {
  operation: id("1"),
  brand: id("2"),
  store: id("3"),
  attempt: id("4"),
  intent: id("5"),
  paymentOperation: id("6"),
  order: id("7"),
  batch: id("8"),
  authorization: id("9"),
  account: id("10"),
  acceptance: id("11"),
  checkpoint: id("12"),
  captureAction: id("13"),
  cancelAction: id("14"),
  observation: id("15"),
  task: id("16"),
  exception: id("17"),
  fence: id("18"),
  transaction: id("19"),
  audit: id("20"),
  queue: id("21"),
  assignment: id("22"),
  assignedBy: id("23"),
  escalation: id("24"),
  terminalCausationCaptured: id("25"),
  observationFailed: id("26"),
  terminalCausationFailed: id("27"),
};

function command(overrides: Record<string, unknown> = {}) {
  return {
    operationReference: refs.operation,
    brandReference: refs.brand,
    storeReference: refs.store,
    paymentAttemptReference: refs.attempt,
    actorReference: null,
    purpose: "WatchTerminalAuthorization",
    scheduledAt: at,
    ...overrides,
  };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    authorizationReference: refs.authorization,
    paymentIntentReference: refs.intent,
    paymentAttemptReference: refs.attempt,
    paymentOperationReference: refs.paymentOperation,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    brandReference: refs.brand,
    storeReference: refs.store,
    providerAccountReference: refs.account,
    providerIntentReference: "pi_terminal_watchdog_123456",
    environment: "Test",
    paymentMethod: "TerminalCard",
    captureMode: "ManualPreferred",
    status: "Authorized",
    requestedAmount: { amountMinor: 2_200n, currencyCode: "CAD" },
    authorizedAmount: { amountMinor: 2_200n, currencyCode: "CAD" },
    capturedAmount: { amountMinor: 0n, currencyCode: "CAD" },
    authorizedAt: at,
    providerCaptureBeforeAt: null,
    sourceVersion: 3,
    evidenceDigest: digest("authorization"),
    ...overrides,
  };
}

function acceptance(overrides: Record<string, unknown> = {}) {
  return {
    acceptanceReference: refs.acceptance,
    checkpointReference: refs.checkpoint,
    sourceVersion: 2,
    sourceDigest: digest("acceptance"),
    brandReference: refs.brand,
    storeReference: refs.store,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    paymentAttemptReference: refs.attempt,
    phase: "Accepted",
    acceptanceKind: "TerminalAuthorization",
    acceptedAt: "2026-08-08T14:01:00.000Z",
    ...overrides,
  };
}

type ProviderStatus = "Authorized" | "Captured" | "Cancelled" | "Failed" | "Pending" | "Unknown";

interface HarnessOptions {
  readonly now?: string;
  readonly evidence?: unknown;
  readonly acceptance?: unknown;
  readonly retrieveStatuses?: readonly ProviderStatus[];
  readonly retrieveObservedAt?: readonly string[];
  readonly captureThrows?: boolean;
  readonly cancelThrows?: boolean;
  readonly commitThrows?: number;
  readonly lease?: unknown;
  readonly taskMalformed?: boolean;
  readonly exceptionThrows?: boolean;
  readonly mutationMalformed?: boolean;
  readonly mutationStatus?: ProviderStatus;
  readonly mutationObservedAt?: string;
  readonly mutationAuthorizedAmountMinor?: bigint;
  readonly mutationCapturedAmountMinor?: bigint;
  readonly mutationRefundedAmountMinor?: bigint;
  readonly malformedRetrieveCalls?: readonly number[];
  readonly denied?: boolean;
  readonly existingCapturePhase?: PaymentTerminalWatchdogActionReceipt["phase"];
  readonly taskCreatedAt?: string;
  readonly leaseReleaseThrowsSynchronously?: boolean;
  readonly claimedReceiptAt?: string;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const observations: unknown[] = [];
  const operationRecords = new Map<string, PaymentTerminalCaptureWatchdogOperationRecord>();
  const actions = new Map<"Capture" | "Cancel", PaymentTerminalWatchdogActionReceipt>();
  const now = options.now ?? "2026-08-08T14:01:00.000Z";
  let clockCalls = 0;
  let captureCalls = 0;
  let cancelCalls = 0;
  let retrieveCalls = 0;
  let taskCalls = 0;
  let exceptionCalls = 0;
  let terminalReceipt: PaymentTerminalWatchdogTerminalReceipt | null = null;
  let commitFailures = options.commitThrows ?? 0;
  let currentAcceptance: unknown =
    options.acceptance === undefined ? acceptance() : options.acceptance;
  const source = options.evidence ?? authorization();
  const sourceDigest = authorization().evidenceDigest;

  function actionReceipt(
    action: "Capture" | "Cancel",
    phase: PaymentTerminalWatchdogActionReceipt["phase"],
    claimDisposition: "Claimed" | "Existing" = "Existing",
    claimedAt = now,
  ): PaymentTerminalWatchdogActionReceipt {
    const actionReference = action === "Capture" ? refs.captureAction : refs.cancelAction;
    const providerIdempotencyKey = providerKey(action);
    const acceptanceDigest = action === "Capture" ? hashAcceptance() : null;
    const actionDigest = hashAction(action, actionReference);
    return Object.freeze({
      action,
      actionReference: actionReference as never,
      brandReference: refs.brand as never,
      storeReference: refs.store as never,
      paymentAttemptReference: refs.attempt as never,
      authorizationDigest: sourceDigest as never,
      acceptanceDigest: acceptanceDigest as never,
      actionDigest: actionDigest as never,
      providerIdempotencyKey: providerIdempotencyKey as never,
      claimedAt: claimedAt as never,
      claimDisposition,
      phase,
    });
  }

  function providerKey(action: "Capture" | "Cancel") {
    return `watchdog:${action.toLowerCase()}:${digest(action).slice(7)}`;
  }

  function hashAction(action: "Capture" | "Cancel", actionReference: string) {
    const acceptanceDigest = action === "Capture" ? hashAcceptance() : null;
    return digest(
      `TerminalWatchdog${action}:v1:${JSON.stringify({
        actionReference,
        environment: "Test",
        brandReference: refs.brand,
        storeReference: refs.store,
        paymentAttemptReference: refs.attempt,
        authorizationDigest: sourceDigest,
        acceptanceDigest,
        amountMinor: "2200",
        currencyCode: "CAD",
      })}`,
    );
  }

  function hashAcceptance() {
    return digest(
      `OrderAcceptanceEvidence:v1:${JSON.stringify({
        acceptanceReference: refs.acceptance,
        checkpointReference: refs.checkpoint,
        sourceVersion: 2,
        sourceDigest: digest("acceptance"),
        brandReference: refs.brand,
        storeReference: refs.store,
        orderReference: refs.order,
        orderBatchReference: refs.batch,
        paymentAttemptReference: refs.attempt,
        phase: "Accepted",
        acceptanceKind: "TerminalAuthorization",
        acceptedAt: "2026-08-08T14:01:00.000Z",
      })}`,
    );
  }

  if (options.existingCapturePhase !== undefined)
    actions.set("Capture", actionReceipt("Capture", options.existingCapturePhase));

  function providerSnapshot(request: {
    readonly context: unknown;
    readonly providerIntentReference: unknown;
  }) {
    const index = retrieveCalls++;
    const status = options.retrieveStatuses?.[index] ?? (index === 0 ? "Authorized" : "Captured");
    const terminal = status === "Captured";
    const zeroState = ["Cancelled", "Failed", "Pending", "Unknown"].includes(status);
    return Object.freeze({
      kind: "Snapshot" as const,
      context: request.context,
      providerIntentReference: request.providerIntentReference,
      providerTransactionReference: terminal ? "ch_watchdog_terminal_123456" : null,
      paymentMethod: "TerminalCard" as const,
      captureMode: "ManualPreferred" as const,
      status,
      requestedAmount: { amountMinor: 2_200n, currencyCode: "CAD" as const },
      authorizedAmount: {
        amountMinor: zeroState ? 0n : 2_200n,
        currencyCode: "CAD" as const,
      },
      capturedAmount: {
        amountMinor: terminal ? 2_200n : 0n,
        currencyCode: "CAD" as const,
      },
      refundedAmount: { amountMinor: 0n, currencyCode: "CAD" as const },
      observedAt: options.retrieveObservedAt?.[index] ?? now,
      evidenceDigest: digest(`provider-${index}`),
    });
  }

  function mutationSnapshot(request: {
    readonly context: unknown;
    readonly providerIntentReference: unknown;
  }) {
    const status = options.mutationStatus ?? "Authorized";
    const terminal = status === "Captured";
    const zeroState = ["Cancelled", "Failed", "Pending", "Unknown"].includes(status);
    return Object.freeze({
      kind: "Snapshot" as const,
      context: request.context,
      providerIntentReference: request.providerIntentReference,
      providerTransactionReference: terminal ? "ch_watchdog_mutation_123456" : null,
      paymentMethod: "TerminalCard" as const,
      captureMode: "ManualPreferred" as const,
      status,
      requestedAmount: { amountMinor: 2_200n, currencyCode: "CAD" as const },
      authorizedAmount: {
        amountMinor: options.mutationAuthorizedAmountMinor ?? (zeroState ? 0n : 2_200n),
        currencyCode: "CAD" as const,
      },
      capturedAmount: {
        amountMinor: options.mutationCapturedAmountMinor ?? (terminal ? 2_200n : 0n),
        currencyCode: "CAD" as const,
      },
      refundedAmount: {
        amountMinor: options.mutationRefundedAmountMinor ?? 0n,
        currencyCode: "CAD" as const,
      },
      observedAt: options.mutationObservedAt ?? now,
      evidenceDigest: digest("mutation-response"),
    });
  }

  function audit(input: {
    readonly action: "Capture" | "Cancel";
    readonly actionReference: string;
    readonly occurredAt: string;
  }): AppendAuditRecordInput {
    return {
      auditId: refs.audit,
      brandId: refs.brand,
      storeId: refs.store,
      actor: { type: "System" },
      actionCode: `PAYMENT_TERMINAL_${input.action.toUpperCase()}_CLAIM`,
      targetType: "PaymentAttempt",
      targetId: refs.attempt,
      reasonCode: "WATCH_TERMINAL_AUTHORIZATION",
      correlationId: input.actionReference,
      occurredAt: input.occurredAt,
      sourceChannel: "PAYMENT_WATCHDOG",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_STANDARD",
      retentionPolicyVersion: 1,
    };
  }

  const ports: PaymentTerminalCaptureWatchdogPorts = {
    authorization: {
      authorize: async () => {
        calls.push("authorize");
        return options.denied !== true;
      },
    },
    repository: {
      resolveOperation: async ({ operationReference }) => {
        calls.push("replay");
        return operationRecords.get(operationReference) ?? null;
      },
      commit: async ({ record }) => {
        calls.push("commit");
        if (commitFailures > 0) {
          commitFailures -= 1;
          throw new Error("commit unknown");
        }
        const existing = operationRecords.get(record.command.operationReference);
        if (existing !== undefined)
          return Object.freeze({ status: "Duplicate" as const, record: existing });
        operationRecords.set(record.command.operationReference, record);
        return Object.freeze({ status: "Created" as const, record });
      },
    },
    lease: {
      claim: async (input) => {
        calls.push("lease");
        if (options.lease !== undefined) return options.lease as never;
        return Object.freeze({
          paymentAttemptReference: input.paymentAttemptReference,
          operationReference: input.operationReference,
          jobName: input.jobName,
          fenceReference: refs.fence,
          fenceVersion: 7,
          claimedAt: now,
          expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
          status: "Claimed" as const,
        }) as never;
      },
      release: () => {
        calls.push("release");
        if (options.leaseReleaseThrowsSynchronously === true)
          throw new Error("raw lease release failure");
        return Promise.resolve();
      },
    },
    clock: {
      now: () => {
        calls.push("clock");
        clockCalls += 1;
        return now;
      },
    },
    source: {
      resolveAuthorization: async () => {
        calls.push("source");
        return source as never;
      },
    },
    ordering: {
      resolveAcceptance: async () => {
        calls.push("ordering");
        return currentAcceptance as never;
      },
    },
    audit: { createAction: async (input) => audit(input) },
    actions: {
      resolve: async ({ action }) => {
        calls.push(`resolve-${action}`);
        return actions.get(action) ?? null;
      },
      claim: async (input) => {
        calls.push(`claim-${input.action}`);
        const existing = actions.get(input.action);
        if (existing !== undefined)
          return Object.freeze({ ...existing, claimDisposition: "Existing" as const });
        const receipt = actionReceipt(
          input.action,
          "Claimed",
          "Claimed",
          options.claimedReceiptAt ?? input.claimedAt,
        );
        actions.set(input.action, receipt);
        return receipt;
      },
      recordOutcome: async (input) => {
        calls.push(`phase-${input.nextPhase}`);
        const action = input.actionReference === refs.captureAction ? "Capture" : "Cancel";
        const current = actions.get(action);
        if (current === undefined || current.phase !== input.expectedPhase)
          throw new Error("phase conflict");
        const next = Object.freeze({ ...current, phase: input.nextPhase });
        actions.set(action, next);
        return next;
      },
    },
    provider: {
      createIntent: async () => {
        throw new Error("not used");
      },
      refundPayment: async () => {
        throw new Error("not used");
      },
      captureIntent: async (request) => {
        calls.push("capture");
        captureCalls += 1;
        if (options.captureThrows === true) throw new Error("unknown");
        if (options.mutationMalformed === true)
          return Object.freeze({ not: "terminal truth" }) as never;
        return mutationSnapshot(request) as never;
      },
      cancelIntent: async (request) => {
        calls.push("cancel");
        cancelCalls += 1;
        if (options.cancelThrows === true) throw new Error("unknown");
        if (options.mutationMalformed === true)
          return Object.freeze({ not: "terminal truth" }) as never;
        return mutationSnapshot(request) as never;
      },
      retrieveIntent: async (request) => {
        calls.push("retrieve");
        if (options.malformedRetrieveCalls?.includes(retrieveCalls) === true) {
          retrieveCalls += 1;
          return Object.freeze({ not: "provider truth" }) as never;
        }
        return providerSnapshot(request) as never;
      },
    },
    terminal: {
      resolve: async () => terminalReceipt as never,
      record: async (observation) => {
        calls.push("terminal");
        observations.push(observation);
        const receipt = Object.freeze({
          paymentTransactionReference: refs.transaction,
          paymentIntentReference: observation.paymentIntentReference,
          paymentAttemptReference: observation.paymentAttemptReference,
          orderReference: refs.order,
          brandReference: observation.brandReference,
          storeReference: observation.storeReference,
          outcome: observation.status,
          amount: observation.amount,
          failureReason: observation.failureReason,
          observationReference: observation.observationReference,
          causationReference: observation.causationReference,
          source: observation.source,
          evidenceDigest: observation.evidenceDigest,
          occurredAt: observation.occurredAt,
        });
        terminalReceipt = receipt as never;
        return receipt as never;
      },
    },
    tasks: {
      ensure: async (input) => {
        calls.push("task");
        taskCalls += 1;
        if (options.taskMalformed === true) return Object.freeze({ status: "Assigned" }) as never;
        const createdAt = options.taskCreatedAt ?? input.evaluatedAt;
        const dueAt = new Date(
          Math.max(Date.parse(input.hardDeadline), Date.parse(createdAt)),
        ).toISOString();
        const assignment = {
          assignmentReference: refs.assignment,
          target: { kind: "Queue", reference: refs.queue },
          assignedBy: refs.assignedBy,
          assignedAt: createdAt,
          reasonCode: "WATCHDOG_ALERT",
        };
        return Object.freeze({
          taskReference: input.taskReference,
          scope: {
            kind: "Store",
            brandReference: input.brandReference,
            storeReference: input.storeReference,
          },
          source: {
            sourceType: input.sourceType,
            sourceReference: input.sourceReference,
            snapshotDigest: input.sourceDigest,
          },
          taskType: input.taskType,
          severityCode: input.severityCode,
          priorityCode: input.priorityCode,
          status: "Assigned",
          assignmentHistory: [assignment],
          currentAssignment: assignment,
          claimHistory: [],
          currentClaim: null,
          dueAt,
          escalationPolicyReference: refs.escalation,
          escalationHistory: [],
          terminalOutcome: null,
          version: 2,
          createdAt,
          updatedAt: createdAt,
        }) as never;
      },
    },
    exceptions: {
      ensure: async (input) => {
        calls.push("exception");
        exceptionCalls += 1;
        if (options.exceptionThrows === true) throw new Error("exception unavailable");
        return input;
      },
    },
    references: {
      hash: (value) => digest(value),
      equals: (left, right) => left === right,
      actionFor: ({ action }) => (action === "Capture" ? refs.captureAction : refs.cancelAction),
      providerIdempotencyKey: ({ action }) => providerKey(action),
      observationFor: ({ outcome }) =>
        outcome === "Captured" ? refs.observation : refs.observationFailed,
      terminalCausationFor: ({ outcome }) =>
        outcome === "Captured" ? refs.terminalCausationCaptured : refs.terminalCausationFailed,
      taskFor: () => refs.task,
      exceptionFor: () => refs.exception,
    },
  };

  const service = createPaymentTerminalCaptureWatchdogService(ports);
  return {
    service,
    calls,
    observations,
    actions,
    operationRecords,
    setAcceptance(value: unknown) {
      currentAcceptance = value;
    },
    counts() {
      return {
        clockCalls,
        captureCalls,
        cancelCalls,
        retrieveCalls,
        taskCalls,
        exceptionCalls,
      };
    },
  };
}

function rejectsWith(promise: Promise<unknown>, code: PaymentTerminalCaptureWatchdogError["code"]) {
  return expect(promise).rejects.toMatchObject({
    name: "PaymentTerminalCaptureWatchdogError",
    code,
    message: "payment terminal capture watchdog is unavailable",
  });
}

describe("Terminal authorization capture watchdog contracts", () => {
  it("accepts exactly card authorization and single-message Interac evidence", () => {
    const card = parsePaymentTerminalAuthorizationEvidence(authorization());
    expect(card.paymentMethod).toBe("TerminalCard");
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.requestedAmount)).toBe(true);

    const interac = parsePaymentTerminalAuthorizationEvidence(
      authorization({
        paymentMethod: "TerminalInterac",
        status: "Captured",
        capturedAmount: { amountMinor: 2_200n, currencyCode: "CAD" },
      }),
    );
    expect(interac.status).toBe("Captured");
  });

  it("rejects impossible card/Interac state, extra/accessor data and policy-corrupt results", () => {
    expect(() =>
      parsePaymentTerminalAuthorizationEvidence(
        authorization({
          status: "Captured",
          capturedAmount: { amountMinor: 2_200n, currencyCode: "CAD" },
        }),
      ),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
    expect(() =>
      parsePaymentTerminalAuthorizationEvidence(
        authorization({ paymentMethod: "TerminalInterac" }),
      ),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
    expect(() =>
      parsePaymentTerminalAuthorizationEvidence({ ...authorization(), providerObject: {} }),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
    const accessor = { ...authorization() };
    Object.defineProperty(accessor, "status", { enumerable: true, get: () => "Authorized" });
    expect(() => parsePaymentTerminalAuthorizationEvidence(accessor)).toThrow(
      PaymentTerminalCaptureWatchdogError,
    );
    expect(() =>
      parsePaymentTerminalCaptureWatchdogResult({
        status: "PendingCapture",
        evaluatedAt: "2026-08-08T14:20:00.000Z",
        alertAt: "2026-08-08T14:10:00.000Z",
        targetCaptureAt: "2026-08-08T14:15:00.000Z",
        hardDeadline: "2026-08-08T14:20:00.000Z",
        taskReference: null,
        exceptionReference: null,
      }),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
    expect(() =>
      parsePaymentTerminalCaptureWatchdogResult({
        status: "AwaitingOrderAcceptance",
        evaluatedAt: "2026-08-08T14:10:00.000Z",
        alertAt: "2026-08-08T14:10:00.000Z",
        targetCaptureAt: "2026-08-08T14:15:00.000Z",
        hardDeadline: "2026-08-08T14:20:00.000Z",
        taskReference: null,
        exceptionReference: null,
      }),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
    expect(() =>
      parsePaymentTerminalCaptureWatchdogResult({
        status: "CaptureConfirmed",
        evaluatedAt: "2026-08-08T14:19:59.999Z",
        alertAt: "2026-08-08T14:10:00.000Z",
        targetCaptureAt: "2026-08-08T14:15:00.000Z",
        hardDeadline: "2026-08-08T14:20:00.000Z",
        taskReference: null,
        exceptionReference: refs.exception,
      }),
    ).toThrow(PaymentTerminalCaptureWatchdogError);
  });
});

describe("Terminal authorization capture watchdog service", () => {
  it("orders authorization/replay/fence/clock/source and confirms only retrieved truth", async () => {
    const test = harness({ retrieveStatuses: ["Authorized", "Captured"] });
    const result = await test.service.process(command());
    expect(result).toMatchObject({
      status: "CaptureConfirmed",
      evaluatedAt: "2026-08-08T14:01:00.000Z",
      alertAt: "2026-08-08T14:10:00.000Z",
      targetCaptureAt: "2026-08-08T14:15:00.000Z",
      hardDeadline: "2026-08-08T14:20:00.000Z",
    });
    expect(test.calls.slice(0, 6)).toEqual([
      "authorize",
      "replay",
      "lease",
      "clock",
      "source",
      "ordering",
    ]);
    expect(test.calls.indexOf("retrieve")).toBeLessThan(test.calls.indexOf("capture"));
    expect(test.calls.lastIndexOf("retrieve")).toBeLessThan(test.calls.indexOf("terminal"));
    expect(test.observations).toHaveLength(1);
    expect(test.observations[0]).toMatchObject({ source: "ProviderRetrieval", status: "Captured" });
    expect(test.counts()).toMatchObject({ clockCalls: 1, captureCalls: 1, taskCalls: 0 });
  });

  it("waits for exact acceptance and raises one stable alert at the inclusive ten-minute boundary", async () => {
    const before = harness({
      now: "2026-08-08T14:09:59.999Z",
      acceptance: null,
    });
    await expect(before.service.process(command())).resolves.toMatchObject({
      status: "AwaitingOrderAcceptance",
      taskReference: null,
    });
    expect(before.counts()).toMatchObject({ taskCalls: 0, captureCalls: 0, retrieveCalls: 0 });

    const boundary = harness({ now: "2026-08-08T14:10:00.000Z", acceptance: null });
    const result = await boundary.service.process(command());
    expect(result).toMatchObject({
      status: "AwaitingOrderAcceptance",
      taskReference: refs.task,
    });
    expect(boundary.counts()).toMatchObject({ taskCalls: 1, captureCalls: 0, retrieveCalls: 0 });
  });

  it("captures immediately after acceptance rather than waiting for the fifteen-minute target", async () => {
    const test = harness({ now: "2026-08-08T14:01:00.000Z" });
    const result = await test.service.process(command({ scheduledAt: "2099-01-01T00:00:00.000Z" }));
    expect(result.status).toBe("CaptureConfirmed");
    expect(test.counts()).toMatchObject({ captureCalls: 1, clockCalls: 1 });
  });

  it("handles both evidence arrival orders with a new exact scheduler operation", async () => {
    const test = harness({
      acceptance: null,
      retrieveStatuses: ["Authorized", "Captured"],
    });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "AwaitingOrderAcceptance",
    });
    test.setAcceptance(acceptance());
    await expect(
      test.service.process(command({ operationReference: id("101") })),
    ).resolves.toMatchObject({ status: "CaptureConfirmed" });
    expect(test.counts().captureCalls).toBe(1);
  });

  it("short-circuits Interac before Ordering, mutation, Provider, Task or exception work", async () => {
    const test = harness({
      evidence: authorization({
        paymentMethod: "TerminalInterac",
        status: "Captured",
        capturedAmount: { amountMinor: 2_200n, currencyCode: "CAD" },
      }),
    });
    const result = await test.service.process(command());
    expect(result).toEqual({
      status: "InteracSingleMessage",
      evaluatedAt: "2026-08-08T14:01:00.000Z",
      alertAt: null,
      targetCaptureAt: null,
      hardDeadline: null,
      taskReference: null,
      exceptionReference: null,
    });
    expect(test.calls).not.toContain("ordering");
    expect(test.counts()).toMatchObject({
      captureCalls: 0,
      cancelCalls: 0,
      retrieveCalls: 0,
      taskCalls: 0,
      exceptionCalls: 0,
    });
  });

  it("at twenty minutes retrieves first, cancels an orphan authorization, then alerts and excepts", async () => {
    const test = harness({
      now: "2026-08-08T14:20:00.000Z",
      acceptance: null,
      retrieveStatuses: ["Authorized", "Cancelled"],
    });
    const result = await test.service.process(command());
    expect(result).toMatchObject({
      status: "CancelConfirmed",
      taskReference: refs.task,
      exceptionReference: refs.exception,
    });
    expect(test.calls.indexOf("retrieve")).toBeLessThan(test.calls.indexOf("cancel"));
    expect(test.calls).not.toContain("ordering");
    expect(test.counts()).toMatchObject({
      captureCalls: 0,
      cancelCalls: 1,
      retrieveCalls: 2,
      taskCalls: 1,
      exceptionCalls: 1,
    });
  });

  it("clamps alert, target and inclusive hard stop to a verified shorter Provider deadline", async () => {
    const evidence = authorization({ providerCaptureBeforeAt: "2026-08-08T14:08:00.000Z" });
    const before = harness({
      now: "2026-08-08T14:07:59.999Z",
      evidence,
      retrieveStatuses: ["Authorized", "Captured"],
    });
    await before.service.process(command());
    expect(before.counts().captureCalls).toBe(1);

    const hard = harness({
      now: "2026-08-08T14:08:00.000Z",
      evidence,
      retrieveStatuses: ["Authorized", "Cancelled"],
    });
    const result = await hard.service.process(command());
    expect(result).toMatchObject({
      alertAt: "2026-08-08T14:08:00.000Z",
      targetCaptureAt: "2026-08-08T14:08:00.000Z",
      hardDeadline: "2026-08-08T14:08:00.000Z",
    });
    expect(hard.counts()).toMatchObject({ captureCalls: 0, cancelCalls: 1 });
  });

  it("retains Unknown and marks an invocation throw without treating a response as truth", async () => {
    const test = harness({
      now: "2026-08-08T14:11:00.000Z",
      captureThrows: true,
      retrieveStatuses: ["Authorized", "Unknown"],
    });
    const result = await test.service.process(command());
    expect(result).toMatchObject({ status: "PendingCapture", taskReference: refs.task });
    expect(test.actions.get("Capture")?.phase).toBe("InvocationUnknown");
    expect(test.observations).toHaveLength(0);
  });

  it("retries a pre-deadline Claimed/InvocationUnknown capture with the same permanent key", async () => {
    const test = harness({
      existingCapturePhase: "InvocationUnknown",
      retrieveStatuses: ["Authorized", "Captured"],
    });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
    });
    expect(test.counts().captureCalls).toBe(1);
    expect(test.actions.get("Capture")?.phase).toBe("TerminalObserved");
  });

  it("keeps a valid non-Authorized mutation response unresolved when retrieval is Authorized", async () => {
    const test = harness({
      mutationStatus: "Captured",
      retrieveStatuses: ["Authorized", "Authorized"],
    });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "PendingCapture",
    });
    expect(test.actions.get("Capture")?.phase).toBe("InvocationUnknown");
  });

  it("strictly rejects mismatched mutation amounts after still retrieving Provider truth", async () => {
    const cases: readonly HarnessOptions[] = [
      {
        mutationAuthorizedAmountMinor: 2_100n,
        retrieveStatuses: ["Authorized", "Authorized"],
      },
      {
        mutationStatus: "Captured",
        mutationCapturedAmountMinor: 2_100n,
        retrieveStatuses: ["Authorized", "Captured"],
      },
      {
        mutationStatus: "Captured",
        mutationRefundedAmountMinor: 100n,
        retrieveStatuses: ["Authorized", "Captured"],
      },
    ];
    for (const options of cases) {
      const test = harness(options);
      await rejectsWith(
        test.service.process(command()),
        "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
      );
      expect(test.counts().retrieveCalls).toBe(2);
    }
  });

  it("requires post-mutation retrieval to be no older than the mutation observation", async () => {
    const test = harness({
      mutationObservedAt: "2026-08-08T14:01:02.000Z",
      retrieveStatuses: ["Authorized", "Authorized"],
      retrieveObservedAt: ["2026-08-08T14:01:00.000Z", "2026-08-08T14:01:01.999Z"],
    });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(test.actions.get("Capture")?.phase).toBe("Claimed");
  });

  it("retrieves after a malformed mutation response, records terminal truth, then fails closed", async () => {
    const test = harness({
      mutationMalformed: true,
      retrieveStatuses: ["Authorized", "Captured"],
    });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(test.calls.indexOf("capture")).toBeLessThan(test.calls.lastIndexOf("retrieve"));
    expect(test.calls).toContain("terminal");
  });

  it("maps a pre-deadline retrieved terminal failure to reconciliation rather than Pending", async () => {
    const test = harness({
      now: "2026-08-08T14:05:00.000Z",
      retrieveStatuses: ["Failed"],
    });
    const result = await test.service.process(command());
    expect(result).toMatchObject({
      status: "ReconciliationRequired",
      exceptionReference: null,
    });
    expect(test.counts().captureCalls).toBe(0);
    expect(test.observations[0]).toMatchObject({ status: "Failed" });
  });

  it("does not cancel across a durable unresolved Capture mutation race", async () => {
    const test = harness({
      now: "2026-08-08T14:20:00.000Z",
      existingCapturePhase: "InvocationUnknown",
      retrieveStatuses: ["Authorized"],
    });
    const result = await test.service.process(command());
    expect(result).toMatchObject({
      status: "ReconciliationRequired",
      taskReference: refs.task,
      exceptionReference: refs.exception,
    });
    expect(test.counts()).toMatchObject({ captureCalls: 0, cancelCalls: 0 });
  });

  it("does not cancel when the durable Capture action digest is corrupt", async () => {
    const test = harness({
      now: "2026-08-08T14:20:00.000Z",
      existingCapturePhase: "ResolvedAuthorized",
      retrieveStatuses: ["Authorized"],
    });
    const existing = test.actions.get("Capture");
    if (existing === undefined) throw new Error("capture action fixture is missing");
    test.actions.set(
      "Capture",
      Object.freeze({ ...existing, actionDigest: digest("corrupt-action") as never }),
    );
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT",
    );
    expect(test.counts().cancelCalls).toBe(0);
  });

  it("requires a newly claimed action receipt to use the current evaluated instant", async () => {
    const test = harness({
      claimedReceiptAt: "2026-08-08T14:00:30.000Z",
      retrieveStatuses: ["Authorized"],
    });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT",
    );
    expect(test.counts().captureCalls).toBe(0);
  });

  it("conflicts when the exact Ordering checkpoint changes for an existing Capture action", async () => {
    const test = harness({ retrieveStatuses: ["Authorized", "Unknown", "Authorized"] });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "PendingCapture",
    });
    test.setAcceptance(acceptance({ checkpointReference: id("104") }));
    await rejectsWith(
      test.service.process(command({ operationReference: id("102") })),
      "PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT",
    );
    expect(test.counts().captureCalls).toBe(1);
  });

  it("rejects stale initial and post-mutation Provider observations without authorizing cancel", async () => {
    const initial = harness({
      now: "2026-08-08T14:05:00.000Z",
      retrieveStatuses: ["Authorized"],
      retrieveObservedAt: ["2026-08-08T14:04:59.999Z"],
    });
    await rejectsWith(
      initial.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(initial.counts()).toMatchObject({ captureCalls: 0, cancelCalls: 0 });

    const afterMutation = harness({
      retrieveStatuses: ["Authorized", "Authorized"],
      retrieveObservedAt: ["2026-08-08T14:01:00.000Z", "2026-08-08T14:00:59.999Z"],
    });
    await rejectsWith(
      afterMutation.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(afterMutation.actions.get("Capture")?.phase).toBe("Claimed");

    const staleMutation = harness({
      retrieveStatuses: ["Authorized", "Authorized"],
      mutationObservedAt: "2026-08-08T14:00:59.999Z",
    });
    await rejectsWith(
      staleMutation.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(staleMutation.actions.get("Capture")?.phase).toBe("InvocationUnknown");

    const hardStop = harness({
      now: "2026-08-08T14:20:00.000Z",
      retrieveStatuses: ["Authorized"],
      retrieveObservedAt: ["2026-08-08T14:19:59.999Z"],
    });
    await rejectsWith(
      hardStop.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(hardStop.counts().cancelCalls).toBe(0);
  });

  it("recovers commit-unknown by retrieving before any repeated financial mutation", async () => {
    const test = harness({
      retrieveStatuses: ["Authorized", "Captured", "Captured"],
      commitThrows: 1,
    });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    const firstRetryCall = test.calls.length;
    const result = await test.service.process(command());
    expect(result.status).toBe("CaptureConfirmed");
    expect(test.counts()).toMatchObject({ captureCalls: 1, retrieveCalls: 3 });
    expect(test.calls.slice(firstRetryCall).indexOf("retrieve")).toBeGreaterThanOrEqual(0);
    expect(test.calls.slice(firstRetryCall)).not.toContain("capture");
  });

  it("reuses one Attempt-stable terminal receipt across fresh scheduler operations and evidence", async () => {
    const test = harness({ retrieveStatuses: ["Authorized", "Captured", "Captured"] });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
    });
    await expect(
      test.service.process(command({ operationReference: id("103") })),
    ).resolves.toMatchObject({ status: "CaptureConfirmed" });
    expect(test.observations).toHaveLength(1);
    expect(test.counts().captureCalls).toBe(1);
  });

  it("accepts post-evaluation Provider and Task receipts only within the active fence", async () => {
    const provider = harness({
      retrieveStatuses: ["Authorized", "Captured"],
      retrieveObservedAt: ["2026-08-08T14:01:01.000Z", "2026-08-08T14:01:02.000Z"],
      mutationObservedAt: "2026-08-08T14:01:01.000Z",
    });
    await expect(provider.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
    });

    const task = harness({
      now: "2026-08-08T14:10:00.000Z",
      acceptance: null,
      taskCreatedAt: "2026-08-08T14:10:01.000Z",
    });
    await expect(task.service.process(command())).resolves.toMatchObject({
      status: "AwaitingOrderAcceptance",
      taskReference: refs.task,
    });

    const expired = harness({
      retrieveStatuses: ["Authorized"],
      retrieveObservedAt: ["2026-08-08T14:06:00.001Z"],
    });
    await rejectsWith(
      expired.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(expired.counts().captureCalls).toBe(0);
  });

  it("surfaces alert and deadline crossings observed during one fenced Provider call", async () => {
    const alertCrossing = harness({
      now: "2026-08-08T14:09:59.999Z",
      retrieveStatuses: ["Authorized", "Unknown"],
      retrieveObservedAt: ["2026-08-08T14:09:59.999Z", "2026-08-08T14:10:00.001Z"],
    });
    await expect(alertCrossing.service.process(command())).resolves.toMatchObject({
      status: "PendingCapture",
      evaluatedAt: "2026-08-08T14:09:59.999Z",
      taskReference: refs.task,
      exceptionReference: null,
    });

    const deadlineCrossing = harness({
      now: "2026-08-08T14:19:59.999Z",
      retrieveStatuses: ["Authorized", "Captured"],
      retrieveObservedAt: ["2026-08-08T14:19:59.999Z", "2026-08-08T14:20:00.001Z"],
    });
    await expect(deadlineCrossing.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
      evaluatedAt: "2026-08-08T14:19:59.999Z",
      taskReference: refs.task,
      exceptionReference: refs.exception,
    });

    const initialDeadlineCrossing = harness({
      now: "2026-08-08T14:19:59.999Z",
      retrieveStatuses: ["Authorized"],
      retrieveObservedAt: ["2026-08-08T14:20:00.001Z"],
    });
    await expect(initialDeadlineCrossing.service.process(command())).resolves.toMatchObject({
      status: "ReconciliationRequired",
      taskReference: refs.task,
      exceptionReference: refs.exception,
    });
    expect(initialDeadlineCrossing.counts()).toMatchObject({
      captureCalls: 0,
      cancelCalls: 0,
    });

    const exactDeadlineCapture = harness({
      now: "2026-08-08T14:19:59.999Z",
      retrieveStatuses: ["Authorized", "Captured"],
      retrieveObservedAt: ["2026-08-08T14:19:59.999Z", "2026-08-08T14:20:00.000Z"],
    });
    await expect(exactDeadlineCapture.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
      taskReference: null,
      exceptionReference: null,
    });
  });

  it("records a deadline exception when cancel reconciliation discovers a late capture", async () => {
    const test = harness({
      now: "2026-08-08T14:21:00.000Z",
      retrieveStatuses: ["Authorized", "Captured"],
      retrieveObservedAt: ["2026-08-08T14:21:00.000Z", "2026-08-08T14:21:01.000Z"],
    });
    const result = await test.service.process(command());
    expect(result).toMatchObject({
      status: "CaptureConfirmed",
      taskReference: refs.task,
      exceptionReference: refs.exception,
    });
    expect(test.counts()).toMatchObject({ cancelCalls: 1, exceptionCalls: 1 });
  });

  it("preserves due Task and exception intents when Provider retrieval is malformed", async () => {
    const alert = harness({
      now: "2026-08-08T14:10:00.000Z",
      malformedRetrieveCalls: [0],
    });
    await rejectsWith(
      alert.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(alert.counts()).toMatchObject({
      captureCalls: 0,
      taskCalls: 1,
      exceptionCalls: 0,
    });

    const deadline = harness({
      now: "2026-08-08T14:20:00.000Z",
      malformedRetrieveCalls: [0],
    });
    await rejectsWith(
      deadline.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(deadline.counts()).toMatchObject({
      captureCalls: 0,
      cancelCalls: 0,
      taskCalls: 1,
      exceptionCalls: 1,
    });
  });

  it("attempts both operational receipts only after the financial hard-stop path", async () => {
    const test = harness({
      now: "2026-08-08T14:20:00.000Z",
      retrieveStatuses: ["Authorized", "Cancelled"],
      taskMalformed: true,
      exceptionThrows: true,
    });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_DEPENDENCY_UNAVAILABLE",
    );
    expect(test.calls.indexOf("cancel")).toBeLessThan(test.calls.indexOf("task"));
    expect(test.calls).toContain("exception");
  });

  it("fails closed on malformed fence and changed operation replay before source work", async () => {
    const malformedFence = harness({
      lease: Object.freeze({
        paymentAttemptReference: refs.attempt,
        operationReference: refs.operation,
        jobName: "payment-terminal-capture-watchdog:v1",
        fenceReference: refs.fence,
        fenceVersion: 0,
        claimedAt: at,
        expiresAt: "2026-08-08T14:05:00.000Z",
        status: "Claimed",
      }),
    });
    await rejectsWith(
      malformedFence.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_LEASE_UNAVAILABLE",
    );
    expect(malformedFence.calls).not.toContain("source");

    const replay = harness();
    await replay.service.process(command());
    await rejectsWith(
      replay.service.process(command({ scheduledAt: "2026-08-08T14:00:01.000Z" })),
      "PAYMENT_TERMINAL_WATCHDOG_OPERATION_CONFLICT",
    );
    expect(replay.calls.filter((call) => call === "lease")).toHaveLength(1);
  });

  it("authorizes before all reads and exposes one bounded permission error", async () => {
    const test = harness({ denied: true });
    await rejectsWith(
      test.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_PERMISSION_DENIED",
    );
    expect(test.calls).toEqual(["authorize"]);
  });

  it("rejects cross-scope Payment and Ordering evidence before financial or Task work", async () => {
    const source = harness({ evidence: authorization({ storeReference: id("201") }) });
    await rejectsWith(
      source.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_SOURCE_UNAVAILABLE",
    );
    expect(source.calls).not.toContain("ordering");
    expect(source.counts()).toMatchObject({ captureCalls: 0, taskCalls: 0 });

    const ordering = harness({ acceptance: acceptance({ brandReference: id("202") }) });
    await rejectsWith(
      ordering.service.process(command()),
      "PAYMENT_TERMINAL_WATCHDOG_SOURCE_UNAVAILABLE",
    );
    expect(ordering.calls).not.toContain("retrieve");
    expect(ordering.counts()).toMatchObject({ captureCalls: 0, taskCalls: 0 });
  });

  it("does not let a synchronous lease-release failure replace a committed bounded result", async () => {
    const test = harness({
      leaseReleaseThrowsSynchronously: true,
      retrieveStatuses: ["Authorized", "Captured"],
    });
    await expect(test.service.process(command())).resolves.toMatchObject({
      status: "CaptureConfirmed",
    });
    expect(test.calls.at(-1)).toBe("release");
  });
});

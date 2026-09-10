import type { AppendAuditRecordInput } from "@bop/audit";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createPaymentIntentCreationService,
  createPaymentProviderSnapshot,
  PaymentIntentCreationError,
  paymentProviderAdmissionKillSwitchKey,
  type PaymentIntentCreationPorts,
  type PaymentIntentCreationRecord,
} from "../index.js";

const id = (n: number) => `0198a003-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const at = "2026-08-03T15:00:00.000Z";
const refs = {
  operation: id(1),
  submission: id(2),
  cart: id(3),
  quote: id(4),
  session: id(5),
  brand: id(6),
  store: id(7),
  preparation: id(8),
  order: id(9),
  batch: id(10),
  capacity: id(11),
  intent: id(12),
  attempt: id(13),
  control: id(14),
};

function killSwitchEvaluation(
  options: {
    reason?: "KILL_INACTIVE" | "KILL_ACTIVE" | "KILL_RECOVERY_ALLOWED" | "KILL_RECOVERY_BLOCKED";
    killMode?: "BlockNew" | "SafePause" | "Terminate";
    evaluatedAt?: string;
  } = {},
) {
  const reason = options.reason ?? "KILL_INACTIVE";
  const backendExecution =
    reason === "KILL_INACTIVE" || reason === "KILL_RECOVERY_ALLOWED" ? "Allow" : "Deny";
  const frontendVisibility = backendExecution === "Allow" ? "Show" : "Hide";
  const killMode = options.killMode ?? "BlockNew";
  const scope = Object.freeze({
    kind: "Store" as const,
    brandReference: refs.brand,
    storeReference: refs.store,
  });
  return Object.freeze({
    effectiveControl: Object.freeze({ controlId: refs.control, version: 1, scope }),
    backendExecution,
    frontendVisibility,
    reason,
    killMode,
    inFlightPolicy: "AllowToComplete" as const,
    record: Object.freeze({
      key: paymentProviderAdmissionKillSwitchKey,
      kind: "KillSwitch" as const,
      version: 1,
      scopeKind: "Store" as const,
      backendExecution,
      frontendVisibility,
      reason,
      killMode,
      evaluatedAt: options.evaluatedAt ?? at,
    }),
  });
}

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    preparationReference: refs.preparation,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    submissionReference: refs.submission,
    sourceCartReference: refs.cart,
    sourceCartVersion: 3,
    brandReference: refs.brand,
    storeReference: refs.store,
    guestSessionReference: refs.session,
    quoteReference: refs.quote,
    capacityAllocationReference: refs.capacity,
    readiness: "PaymentPending",
    transactionBoundary: "OrderSubmissionPaymentPreparation",
    orderAllocation: { amountMinor: 2_000n, currencyCode: "CAD" },
    tip: { amountMinor: 200n, currencyCode: "CAD" },
    total: { amountMinor: 2_200n, currencyCode: "CAD" },
    committedAt: "2026-08-03T14:59:00.000Z",
    capacityExpiresAt: "2026-08-03T15:30:00.000Z",
    sourceDigest: digest("a"),
    ...overrides,
  };
}

function audit(intentReference: string): AppendAuditRecordInput {
  return {
    auditId: id(20),
    brandId: refs.brand,
    storeId: refs.store,
    actor: { type: "System" },
    actionCode: "PAYMENT_INTENT_CREATE",
    targetType: "PaymentIntent",
    targetId: intentReference,
    reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
    correlationId: id(21),
    occurredAt: at,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    paymentOperationReference: refs.operation,
    submissionReference: refs.submission,
    cartReference: refs.cart,
    expectedCartVersion: 3,
    quoteReference: refs.quote,
    tipSelectionReference: null,
    requestedAt: at,
    ...overrides,
  };
}

function harness(
  options: {
    denied?: boolean;
    prior?: PaymentIntentCreationRecord | null;
    prepared?: unknown;
    claimStatus?: "Claimed" | "Existing";
    claimExisting?: PaymentIntentCreationRecord;
    providerThrows?: boolean;
    providerScopeMismatch?: boolean;
    killSwitchEvaluation?: unknown;
    killSwitchThrows?: boolean;
    clockNow?: string;
    advanceAfter?: Partial<Record<"prepare" | "audit" | "claim" | "provider", string | Error>>;
    authorizationResult?: unknown;
  } = {},
) {
  let stored = options.prior ?? null;
  let currentClock: string | Error = options.clockNow ?? at;
  const advance = (phase: "prepare" | "audit" | "claim" | "provider") => {
    currentClock = options.advanceAfter?.[phase] ?? currentClock;
  };
  const calls: string[] = [];
  let providerCalls = 0;
  let referenceIndex = 0;
  const generated = [refs.intent, refs.attempt];
  const killSwitchInputs: unknown[] = [];
  const ports: PaymentIntentCreationPorts = {
    providerEnvironment: "Test",
    clock: {
      now() {
        calls.push("read-clock");
        if (currentClock instanceof Error) throw currentClock;
        return currentClock;
      },
    },
    killSwitch: {
      async evaluate(input) {
        calls.push("evaluate-kill-switch");
        killSwitchInputs.push(input);
        if (options.killSwitchThrows) throw new Error("synthetic control dependency failure");
        return (
          options.killSwitchEvaluation === undefined
            ? killSwitchEvaluation({ evaluatedAt: input.evaluatedAt })
            : options.killSwitchEvaluation
        ) as never;
      },
    },
    authorization: {
      async authorize() {
        calls.push("authorize");
        if (Object.hasOwn(options, "authorizationResult"))
          return options.authorizationResult as never;
        return options.denied
          ? null
          : {
              action: "CreatePaymentIntent",
              guestSessionReference: refs.session,
              brandReference: refs.brand,
              storeReference: refs.store,
            };
      },
    },
    ordering: {
      async preparePayment() {
        calls.push("prepare-order");
        advance("prepare");
        return (options.prepared ?? preparation()) as never;
      },
    },
    audit: {
      async create(input) {
        calls.push("audit");
        advance("audit");
        return audit(input.paymentIntentReference);
      },
    },
    references: {
      generate() {
        return generated[referenceIndex++] ?? id(99);
      },
      hash(value) {
        return `sha256:${createHash("sha256").update(value).digest("hex")}`;
      },
      equals(left, right) {
        return left === right;
      },
      providerIdempotencyKey(input) {
        return `BOP:${input.environment}:${input.paymentOperationReference}:${input.paymentAttemptReference}`;
      },
    },
    repository: {
      async resolveOperation() {
        calls.push("resolve-operation");
        return stored;
      },
      async claim(input) {
        calls.push("claim");
        advance("claim");
        if (options.claimStatus === "Existing" && options.claimExisting !== undefined)
          return { status: "Existing", record: options.claimExisting };
        stored = input.record;
        return { status: "Claimed", record: input.record };
      },
      async recordObservation(input) {
        calls.push("record-observation");
        stored = input.record;
        return input.record;
      },
    },
    provider: {
      async createIntent(request) {
        calls.push("provider-create");
        providerCalls += 1;
        advance("provider");
        if (options.providerThrows) throw new Error("synthetic transport failure");
        return createPaymentProviderSnapshot({
          kind: "Snapshot",
          context: {
            ...request.context,
            storeReference: options.providerScopeMismatch
              ? (id(90) as never)
              : request.context.storeReference,
          },
          providerIntentReference: "pi_SYNTHETIC_1302" as never,
          providerTransactionReference: null,
          paymentMethod: "OnlineCard",
          captureMode: "Automatic",
          status: "RequiresCustomerAction",
          requestedAmount: request.amount,
          authorizedAmount: { amountMinor: 0n, currencyCode: "CAD" as never },
          capturedAmount: { amountMinor: 0n, currencyCode: "CAD" as never },
          refundedAmount: { amountMinor: 0n, currencyCode: "CAD" as never },
          observedAt: at,
          evidenceDigest: digest("c") as never,
        });
      },
      async retrieveIntent() {
        throw new Error("not used");
      },
      async cancelIntent() {
        throw new Error("not used");
      },
      async captureIntent() {
        throw new Error("not used");
      },
      async refundPayment() {
        throw new Error("not used");
      },
    },
  };
  return {
    calls,
    ports,
    providerCalls: () => providerCalls,
    killSwitchInputs,
    stored: () => stored,
  };
}

function expectCode(action: () => Promise<unknown>, code: PaymentIntentCreationError["code"]) {
  return expect(action()).rejects.toMatchObject({ code });
}

describe("Payment Intent creation service", () => {
  it("authorizes, proves durable Ordering readiness, claims locally, then invokes Provider once", async () => {
    const test = harness();
    const result = await createPaymentIntentCreationService(test.ports).create(command());
    expect(result.status).toBe("Created");
    expect(result.record.providerOutcome?.kind).toBe("Snapshot");
    expect(test.providerCalls()).toBe(1);
    expect(test.calls).toEqual([
      "authorize",
      "resolve-operation",
      "read-clock",
      "evaluate-kill-switch",
      "prepare-order",
      "read-clock",
      "audit",
      "read-clock",
      "claim",
      "read-clock",
      "provider-create",
      "record-observation",
    ]);
    expect(test.killSwitchInputs).toEqual([
      {
        key: "payment.provider.admission",
        action: "CreatePaymentIntent",
        brandReference: refs.brand,
        storeReference: refs.store,
        evaluatedAt: at,
      },
    ]);
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it("denies before any Ordering, Payment repository, audit, or Provider read", async () => {
    const test = harness({ denied: true });
    await expectCode(
      () => createPaymentIntentCreationService(test.ports).create(command()),
      "PAYMENT_INTENT_PERMISSION_DENIED",
    );
    expect(test.calls).toEqual(["authorize"]);
  });

  it("rejects malformed authorization evidence before clock, control, or Domain reads", async () => {
    const test = harness({
      authorizationResult: {
        action: "CreatePaymentIntent",
        guestSessionReference: refs.session,
        brandReference: refs.brand,
        storeReference: refs.store,
        injectedAuthority: true,
      },
    });
    await expectCode(
      () => createPaymentIntentCreationService(test.ports).create(command()),
      "PAYMENT_INTENT_PERMISSION_DENIED",
    );
    expect(test.calls).toEqual(["authorize"]);
    expect(test.killSwitchInputs).toHaveLength(0);
    expect(test.providerCalls()).toBe(0);
  });

  it("returns exact replay without another preparation, Attempt, or Provider call", async () => {
    const first = harness();
    const initial = await createPaymentIntentCreationService(first.ports).create(command());
    const replay = harness({ prior: initial.record });
    const result = await createPaymentIntentCreationService(replay.ports).create(command());
    expect(result.status).toBe("AlreadyCreated");
    expect(replay.providerCalls()).toBe(0);
    expect(replay.calls).toEqual(["authorize", "resolve-operation"]);
  });

  it("keeps an exact replay visible while the new-work switch is active", async () => {
    const first = harness();
    const initial = await createPaymentIntentCreationService(first.ports).create(command());
    const replay = harness({
      prior: initial.record,
      killSwitchEvaluation: killSwitchEvaluation({ reason: "KILL_ACTIVE" }),
    });
    const result = await createPaymentIntentCreationService(replay.ports).create(command());
    expect(result.status).toBe("AlreadyCreated");
    expect(replay.calls).toEqual(["authorize", "resolve-operation"]);
    expect(replay.killSwitchInputs).toHaveLength(0);
    expect(replay.providerCalls()).toBe(0);
  });

  it("rejects changed replay intent under the permanent operation reference", async () => {
    const first = harness();
    const initial = await createPaymentIntentCreationService(first.ports).create(command());
    const replay = harness({ prior: initial.record });
    await expectCode(
      () =>
        createPaymentIntentCreationService(replay.ports).create(
          command({ expectedCartVersion: 4 }),
        ),
      "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT",
    );
    expect(replay.providerCalls()).toBe(0);
    expect(replay.killSwitchInputs).toHaveLength(0);
  });

  it("maps active, recovery-blocked and unavailable evaluation to one disabled error", async () => {
    for (const evaluation of [
      killSwitchEvaluation({ reason: "KILL_ACTIVE", killMode: "BlockNew" }),
      killSwitchEvaluation({ reason: "KILL_ACTIVE", killMode: "SafePause" }),
      killSwitchEvaluation({ reason: "KILL_ACTIVE", killMode: "Terminate" }),
      killSwitchEvaluation({ reason: "KILL_RECOVERY_BLOCKED" }),
      null,
    ]) {
      const test = harness({ killSwitchEvaluation: evaluation });
      await expectCode(
        () => createPaymentIntentCreationService(test.ports).create(command()),
        "PAYMENT_INTENT_PROVIDER_DISABLED",
      );
      expect(test.calls).toEqual([
        "authorize",
        "resolve-operation",
        "read-clock",
        "evaluate-kill-switch",
      ]);
      expect(test.calls).not.toContain("prepare-order");
      expect(test.calls).not.toContain("claim");
      expect(test.providerCalls()).toBe(0);
    }

    const unavailable = harness({ killSwitchThrows: true });
    await expect(
      createPaymentIntentCreationService(unavailable.ports).create(command()),
    ).rejects.toMatchObject({
      code: "PAYMENT_INTENT_PROVIDER_DISABLED",
      message: "payment intent creation is unavailable",
    });
    await expect(
      createPaymentIntentCreationService(
        harness({ killSwitchEvaluation: killSwitchEvaluation({ reason: "KILL_ACTIVE" }) }).ports,
      ).create(command()),
    ).rejects.toBeInstanceOf(PaymentIntentCreationError);
  });

  it("uses a current server instant when a new operation was submitted before activation", async () => {
    const afterActivation = "2026-08-03T15:05:00.000Z";
    const test = harness({
      clockNow: afterActivation,
      killSwitchEvaluation: killSwitchEvaluation({
        reason: "KILL_ACTIVE",
        evaluatedAt: afterActivation,
      }),
    });
    await expectCode(
      () => createPaymentIntentCreationService(test.ports).create(command({ requestedAt: at })),
      "PAYMENT_INTENT_PROVIDER_DISABLED",
    );
    expect(test.killSwitchInputs).toEqual([
      {
        key: "payment.provider.admission",
        action: "CreatePaymentIntent",
        brandReference: refs.brand,
        storeReference: refs.store,
        evaluatedAt: afterActivation,
      },
    ]);
    expect(test.calls).toEqual([
      "authorize",
      "resolve-operation",
      "read-clock",
      "evaluate-kill-switch",
    ]);
    expect(test.providerCalls()).toBe(0);
  });

  it("stops malformed, scope-mismatched, or expired Ordering evidence before claim/Provider", async () => {
    for (const prepared of [
      { ...preparation(), readiness: "Submitted" },
      preparation({ quoteReference: id(80) }),
      preparation({ capacityExpiresAt: at, committedAt: "2026-08-03T14:30:00.000Z" }),
    ]) {
      const test = harness({ prepared });
      await expect(
        createPaymentIntentCreationService(test.ports).create(command()),
      ).rejects.toBeInstanceOf(PaymentIntentCreationError);
      expect(test.calls).not.toContain("claim");
      expect(test.providerCalls()).toBe(0);
    }
  });

  it("keeps a concurrently claimed record Processing and never blindly recreates it", async () => {
    const seed = harness();
    const first = await createPaymentIntentCreationService(seed.ports).create(command());
    const pending = { ...first.record, providerOutcome: null } as PaymentIntentCreationRecord;
    const test = harness({ prior: null, claimStatus: "Existing", claimExisting: pending });
    const result = await createPaymentIntentCreationService(test.ports).create(command());
    expect(result.status).toBe("Processing");
    expect(test.providerCalls()).toBe(0);
  });

  it("records thrown or scope-mismatched Provider results as safe Unknown", async () => {
    for (const options of [{ providerThrows: true }, { providerScopeMismatch: true }]) {
      const test = harness(options);
      const result = await createPaymentIntentCreationService(test.ports).create(command());
      expect(result.record.providerOutcome).toMatchObject({
        kind: "Failure",
        code: "Unknown",
        retryDisposition: "Unknown",
        safeReasonCode: "CREATE_RESULT_UNKNOWN",
      });
      expect(test.stored()?.providerOutcome).toEqual(result.record.providerOutcome);
    }
  });

  it("rejects client money/status/raw fields, accessors, and custom prototypes", async () => {
    for (const value of [
      command({ amount: 2_200 }),
      command({ status: "Captured" }),
      command({ providerPayload: { id: "pi_raw" } }),
      command({ killSwitchKey: "attacker.control.override" }),
      Object.create(command()),
    ]) {
      const test = harness();
      await expectCode(
        () => createPaymentIntentCreationService(test.ports).create(value),
        "PAYMENT_INTENT_INPUT_INVALID",
      );
      expect(test.calls).toEqual([]);
    }
    let evaluated = false;
    const accessor = command();
    Object.defineProperty(accessor, "providerPayload", {
      enumerable: true,
      get() {
        evaluated = true;
        return "raw";
      },
    });
    const test = harness();
    await expectCode(
      () => createPaymentIntentCreationService(test.ports).create(accessor),
      "PAYMENT_INTENT_INPUT_INVALID",
    );
    expect(evaluated).toBe(false);
  });
});

describe("WP-2341 current capacity expiry around Payment creation waits", () => {
  const expiry = "2026-08-03T15:30:00.000Z";
  const lastLive = "2026-08-03T15:29:59.999Z";
  it.each(["prepare", "audit"] as const)(
    "stops capacity expiry during %s before claim",
    async (stage) => {
      const test = harness({ advanceAfter: { [stage]: expiry } });
      await expect(
        createPaymentIntentCreationService(test.ports).create(command()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_PREPARATION_EXPIRED" });
      expect(test.calls).not.toContain("claim");
      expect(test.providerCalls()).toBe(0);
    },
  );
  it("rejects a preparation already expired by current server time", async () => {
    const test = harness({ clockNow: expiry });
    await expect(
      createPaymentIntentCreationService(test.ports).create(command()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_PREPARATION_EXPIRED" });
    expect(test.calls).not.toContain("claim");
    expect(test.providerCalls()).toBe(0);
  });
  it("rejects a future requestedAt instead of shifting the allocation window", async () => {
    const test = harness({ clockNow: "2026-08-03T14:59:59.999Z" });
    await expect(
      createPaymentIntentCreationService(test.ports).create(command()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_NOT_READY" });
    expect(test.calls).not.toContain("prepare-order");
    expect(test.providerCalls()).toBe(0);
  });
  it.each(["prepare", "audit"] as const)("rejects reversed clocks after %s", async (stage) => {
    const test = harness({ advanceAfter: { [stage]: "2026-08-03T14:59:59.999Z" } });
    await expect(
      createPaymentIntentCreationService(test.ports).create(command()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
    expect(test.calls).not.toContain("claim");
    expect(test.providerCalls()).toBe(0);
  });
  it.each(["prepare", "audit"] as const)("rejects a lost clock after %s", async (stage) => {
    const test = harness({ advanceAfter: { [stage]: new Error("private clock failure") } });
    await expect(
      createPaymentIntentCreationService(test.ports).create(command()),
    ).rejects.toMatchObject({
      code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
      message: "payment intent creation is unavailable",
    });
    expect(test.calls).not.toContain("claim");
    expect(test.providerCalls()).toBe(0);
  });
  it.each([
    expiry,
    "2026-08-03T15:30:00.001Z",
    "invalid",
    "2026-08-03T14:59:59.999Z",
    new Error("private clock failure"),
  ])(
    "retains a committed claim without new Provider work when its clock is no longer usable",
    async (time) => {
      const test = harness({ advanceAfter: { claim: time } });
      const result = await createPaymentIntentCreationService(test.ports).create(command());
      expect(result.status).toBe("Processing");
      expect(result.record.providerOutcome).toBeNull();
      expect(result.record.intent.createdAt).toBe(at);
      expect(result.record.intent.preparation.capacityExpiresAt).toBe(expiry);
      expect(test.calls).toContain("claim");
      expect(test.calls).not.toContain("record-observation");
      expect(test.providerCalls()).toBe(0);
      const replay = harness({ prior: result.record, clockNow: expiry });
      expect(
        (await createPaymentIntentCreationService(replay.ports).create(command())).status,
      ).toBe("Processing");
      expect(replay.calls).toEqual(["authorize", "resolve-operation"]);
      expect(replay.providerCalls()).toBe(0);
    },
  );
  it("admits at the last live millisecond without rewriting the original creation/expiry", async () => {
    const test = harness({ advanceAfter: { prepare: lastLive, audit: lastLive, claim: lastLive } });
    const result = await createPaymentIntentCreationService(test.ports).create(command());
    expect(result.status).toBe("Created");
    expect(test.providerCalls()).toBe(1);
    expect(result.record.intent.createdAt).toBe(at);
    expect(result.record.attempt.createdAt).toBe(at);
    expect(result.record.intent.preparation.capacityExpiresAt).toBe(expiry);
  });
  it("returns a concurrently Existing claim after expiry without re-invoking Provider", async () => {
    const original = await createPaymentIntentCreationService(harness().ports).create(command());
    const pending = { ...original.record, providerOutcome: null };
    const test = harness({
      claimStatus: "Existing",
      claimExisting: pending,
      advanceAfter: { claim: expiry },
    });
    const result = await createPaymentIntentCreationService(test.ports).create(command());
    expect(result.status).toBe("Processing");
    expect(result.record).toEqual(pending);
    expect(test.providerCalls()).toBe(0);
  });
  it("retains the normalized result of a Provider call that was admitted before expiry", async () => {
    const test = harness({ advanceAfter: { claim: lastLive, provider: expiry } });
    const result = await createPaymentIntentCreationService(test.ports).create(command());
    expect(result.status).toBe("Created");
    expect(result.record.providerOutcome?.kind).toBe("Snapshot");
    expect(test.providerCalls()).toBe(1);
    expect(test.calls).toContain("record-observation");
  });
  it.each(["creation", "attempt", "preparation", "identity", "digest"] as const)(
    "rejects substitution of %s in a newly Claimed record",
    async (changed) => {
      const test = harness();
      const original = test.ports.repository.claim;
      const ports: PaymentIntentCreationPorts = {
        ...test.ports,
        repository: {
          ...test.ports.repository,
          async claim(input) {
            const result = await original(input);
            const record = structuredClone(result.record);
            const forged =
              changed === "creation"
                ? { ...record, intent: { ...record.intent, createdAt: "2026-08-03T15:01:00.000Z" } }
                : changed === "attempt"
                  ? {
                      ...record,
                      attempt: { ...record.attempt, createdAt: "2026-08-03T15:01:00.000Z" },
                    }
                  : changed === "preparation"
                    ? {
                        ...record,
                        intent: {
                          ...record.intent,
                          preparation: {
                            ...record.intent.preparation,
                            capacityExpiresAt: "2026-08-03T15:31:00.000Z",
                          },
                        },
                      }
                    : changed === "identity"
                      ? {
                          ...record,
                          intent: { ...record.intent, paymentIntentReference: id(90) },
                          attempt: { ...record.attempt, paymentIntentReference: id(90) },
                        }
                      : {
                          ...record,
                          intent: {
                            ...record.intent,
                            preparation: {
                              ...record.intent.preparation,
                              sourceDigest: digest("f"),
                            },
                          },
                        };
            return { status: "Claimed", record: forged as PaymentIntentCreationRecord };
          },
        },
      };
      await expect(
        createPaymentIntentCreationService(ports).create(command()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
      expect(test.providerCalls()).toBe(0);
    },
  );
});

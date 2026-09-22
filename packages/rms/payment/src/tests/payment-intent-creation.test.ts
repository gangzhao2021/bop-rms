import { describe, expect, it } from "vitest";

import {
  createPaymentIntentCreationService,
  PaymentIntentCreationError,
  type PaymentIntentCreationPorts,
  type PaymentIntentCreationRecord,
} from "../index.js";

import {
  id,
  digest,
  at,
  refs,
  killSwitchEvaluation,
  preparation,
  command,
  harness,
} from "./payment-intent-creation.fixture.js";

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
      "read-clock",
      "authorize",
      "resolve-operation",
      "read-clock",
      "evaluate-kill-switch",
      "prepare-order",
      "read-clock",
      "audit",
      "read-clock",
      "authorize",
      "read-clock",
      "claim",
      "read-clock",
      "authorize",
      "read-clock",
      "provider-create",
      "record-observation",
      "read-clock",
      "authorize",
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
    expect(test.calls).toEqual(["read-clock", "authorize"]);
  });

  it("rejects malformed authorization evidence before control or Domain reads", async () => {
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
    expect(test.calls).toEqual(["read-clock", "authorize"]);
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
    expect(replay.calls).toEqual([
      "read-clock",
      "authorize",
      "resolve-operation",
      "read-clock",
      "authorize",
    ]);
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
    expect(replay.calls).toEqual([
      "read-clock",
      "authorize",
      "resolve-operation",
      "read-clock",
      "authorize",
    ]);
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
        "read-clock",
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
      "read-clock",
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
  it.each([expiry, "2026-08-03T15:30:00.001Z"])(
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
      expect(replay.calls).toEqual([
        "read-clock",
        "authorize",
        "resolve-operation",
        "read-clock",
        "authorize",
      ]);
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

describe("current authorization around durable payment effects", () => {
  it.each(["prepare", "audit", "claim", "provider", "observation"] as const)(
    "denies revocation during %s while preserving already committed facts",
    async (phase) => {
      const f = harness();
      let allowed = true;
      const authorize = f.ports.authorization.authorize;
      f.ports.authorization.authorize = async (input) => (allowed ? authorize(input) : null);
      if (phase === "prepare") {
        const original = f.ports.ordering.preparePayment;
        f.ports.ordering.preparePayment = async (input) => {
          const result = await original(input);
          allowed = false;
          return result;
        };
      }
      if (phase === "audit") {
        const original = f.ports.audit.create;
        f.ports.audit.create = async (input) => {
          const result = await original(input);
          allowed = false;
          return result;
        };
      }
      if (phase === "claim") {
        const original = f.ports.repository.claim;
        f.ports.repository.claim = async (input) => {
          const result = await original(input);
          allowed = false;
          return result;
        };
      }
      if (phase === "provider") {
        const original = f.ports.provider.createIntent;
        f.ports.provider.createIntent = async (input) => {
          const result = await original(input);
          allowed = false;
          return result;
        };
      }
      if (phase === "observation") {
        const original = f.ports.repository.recordObservation;
        f.ports.repository.recordObservation = async (input) => {
          const result = await original(input);
          allowed = false;
          return result;
        };
      }
      await expect(
        createPaymentIntentCreationService(f.ports).create(command()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_PERMISSION_DENIED" });
      if (phase === "prepare" || phase === "audit") {
        expect(f.stored()).toBeNull();
        expect(f.providerCalls()).toBe(0);
      } else if (phase === "claim") {
        expect(f.stored()?.providerOutcome).toBeNull();
        expect(f.providerCalls()).toBe(0);
      } else {
        expect(f.stored()?.providerOutcome?.kind).toBe("Snapshot");
        expect(f.providerCalls()).toBe(1);
      }
    },
  );
  it("reauthorizes recovered history after its read completes", async () => {
    const first = await createPaymentIntentCreationService(harness().ports).create(command());
    const f = harness({ prior: first.record });
    const original = f.ports.repository.resolveOperation;
    f.ports.repository.resolveOperation = async (input) => {
      const result = await original(input);
      f.ports.authorization.authorize = async () => null;
      return result;
    };
    await expect(
      createPaymentIntentCreationService(f.ports).create(command()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_PERMISSION_DENIED" });
    expect(f.providerCalls()).toBe(0);
  });
  it("uses current time for authorization but preserves original payment time", async () => {
    const current = "2026-08-03T15:01:00.000Z",
      f = harness({ clockNow: current });
    const observations: string[] = [],
      original = f.ports.authorization.authorize;
    f.ports.authorization.authorize = async (input) => {
      observations.push(input.observedAt);
      return original(input);
    };
    const result = await createPaymentIntentCreationService(f.ports).create(command());
    expect(observations.length).toBeGreaterThan(1);
    expect(observations.every((at) => at === current)).toBe(true);
    expect(result.record.intent.createdAt).toBe(at);
  });
  it.each(["invalid", "2026-08-03T14:59:59.999Z", new Error("synthetic clock failure")])(
    "keeps the claim but refuses disclosure if current authorization time cannot be established",
    async (time) => {
      const f = harness({ advanceAfter: { claim: time } });
      await expect(
        createPaymentIntentCreationService(f.ports).create(command()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
      expect(f.stored()?.providerOutcome).toBeNull();
      expect(f.providerCalls()).toBe(0);
    },
  );
});

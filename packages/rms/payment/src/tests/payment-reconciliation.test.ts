import { createMoney, parseCurrencyCode } from "@rms/pricing";
import { describe, expect, it } from "vitest";

import {
  createPaymentProviderFailure,
  createPaymentProviderSnapshot,
  createPaymentReconciliationQueryService,
  createPaymentReconciliationService,
  parsePaymentReference,
  PaymentReconciliationError,
  type PaymentOperationalReconciliationCandidate,
  type PaymentProviderOutcome,
  type PaymentReconciliationPorts,
  type PaymentReconciliationQueryPorts,
  type PaymentReconciliationRunResult,
  type PaymentSettlementReconciliationCandidate,
} from "../index.js";

const id = (n: number) => `0198a107-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scheduledAt = "2026-08-03T18:00:00.000Z";
const checkedAt = "2026-08-03T18:01:00.000Z";
const observedAt = "2026-08-03T17:58:00.000Z";
const money = (minor: bigint) =>
  createMoney({ amountMinor: minor, currencyCode: parseCurrencyCode("CAD") });

function run(mode: "Operational" | "DailySettlement" = "Operational") {
  return {
    runReference: id(1),
    mode,
    brandReference: id(2),
    storeReference: id(3),
    actorReference: null,
    purpose: "ReconcilePayments",
    scheduledAt,
    cutoffAt: "2026-08-03T17:59:00.000Z",
    maxCandidates: 10,
  } as const;
}

function operational(
  overrides: Partial<PaymentOperationalReconciliationCandidate> = {},
): PaymentOperationalReconciliationCandidate {
  return {
    candidateReference: parsePaymentReference(id(10)),
    brandReference: parsePaymentReference(id(2)),
    storeReference: parsePaymentReference(id(3)),
    paymentIntentReference: parsePaymentReference(id(11)),
    paymentAttemptReference: parsePaymentReference(id(12)),
    orderReference: parsePaymentReference(id(13)),
    providerAccountReference: parsePaymentReference(id(14)),
    providerIntentReference: "pi_SYNTHETIC_13070001" as never,
    environment: "Test",
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    internalStatus: "Pending",
    requestedAmount: money(1_250n),
    capturedAmount: money(0n),
    refundedAmount: money(0n),
    lastObservedAt: "2026-08-03T17:45:00.000Z" as never,
    dueAt: "2026-08-03T17:50:00.000Z" as never,
    ...overrides,
  };
}

function provider(
  status: "Pending" | "Captured" = "Pending",
  overrides: Record<string, unknown> = {},
): PaymentProviderOutcome {
  return createPaymentProviderSnapshot({
    kind: "Snapshot",
    context: {
      provider: "Stripe",
      environment: "Test",
      brandReference: id(2) as never,
      storeReference: id(3) as never,
      paymentAttemptReference: id(12) as never,
      operationReference: id(1) as never,
    },
    providerIntentReference: "pi_SYNTHETIC_13070001" as never,
    providerTransactionReference: status === "Captured" ? ("ch_SYNTHETIC_13070001" as never) : null,
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    status,
    requestedAmount: money(1_250n),
    authorizedAmount: money(status === "Captured" ? 1_250n : 0n),
    capturedAmount: money(status === "Captured" ? 1_250n : 0n),
    refundedAmount: money(0n),
    observedAt,
    evidenceDigest: `sha256:${"a".repeat(64)}` as never,
    ...overrides,
  } as never);
}

function settlement(providerCaptured = 1_250n): PaymentSettlementReconciliationCandidate {
  return {
    candidateReference: parsePaymentReference(id(20)),
    brandReference: parsePaymentReference(id(2)),
    storeReference: parsePaymentReference(id(3)),
    settlementReference: "set_SYNTHETIC_13070001" as never,
    businessDate: "2026-08-02",
    internalCapturedAmount: money(1_250n),
    providerCapturedAmount: money(providerCaptured),
    internalRefundedAmount: money(100n),
    providerRefundedAmount: money(100n),
    evidenceObservedAt: observedAt as never,
  };
}

function fixture(
  options: {
    deny?: boolean;
    lease?: boolean;
    existing?: PaymentReconciliationRunResult;
    operational?: readonly PaymentOperationalReconciliationCandidate[];
    settlements?: readonly PaymentSettlementReconciliationCandidate[];
    provider?: PaymentProviderOutcome;
    providerThrows?: boolean;
    terminalReference?: string;
    conflict?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const terminal: unknown[] = [];
  let generated = 100;
  const ports: PaymentReconciliationPorts = {
    authorization: {
      authorize: async () => {
        calls.push("authorize");
        return !options.deny;
      },
    },
    lease: {
      claim: async () => {
        calls.push("claim");
        return options.lease !== false;
      },
      release: async () => {
        calls.push("release");
      },
    },
    repository: {
      loadRun: async () => {
        calls.push("loadRun");
        return options.existing ?? null;
      },
      commit: async (result) => {
        calls.push("commit");
        return options.conflict
          ? { status: "Conflict" as const, result }
          : { status: "Created" as const, result };
      },
    },
    candidates: {
      claimOperational: async (input) => {
        calls.push(`claimOperational:${input.runReference}`);
        return options.operational ?? [operational()];
      },
      claimDailySettlement: async (input) => {
        calls.push(`claimSettlement:${input.runReference}`);
        return options.settlements ?? [settlement()];
      },
    },
    provider: {
      retrieveIntent: async () => {
        calls.push("provider");
        if (options.providerThrows) throw new Error("raw provider failure detail");
        return options.provider ?? provider();
      },
    },
    terminal: {
      record: async (observation) => {
        calls.push("terminal");
        terminal.push(observation);
        return {
          status: "Created",
          paymentTransactionReference: options.terminalReference ?? id(90),
        };
      },
    },
    references: {
      generate: () => id(generated++),
      exceptionFor: () => id(80),
    },
    clock: { now: () => checkedAt },
  };
  return { service: createPaymentReconciliationService(ports), calls, terminal };
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentReconciliationError);
    return (error as PaymentReconciliationError).code;
  }
  throw new Error("expected PaymentReconciliationError");
}

describe("WP-1307 Payment reconciliation job", () => {
  it("authorizes, leases and preserves a Provider Pending attempt as unresolved", async () => {
    const value = fixture();
    const result = await value.service.run(run());
    expect(result.result.checks[0]).toMatchObject({
      outcome: "Unresolved",
      providerStatus: "Pending",
      exceptionReference: null,
    });
    expect(result.result.counts.Unresolved).toBe(1);
    expect(value.calls).toEqual([
      "authorize",
      "claim",
      "loadRun",
      `claimOperational:${id(1)}`,
      "provider",
      "commit",
      "release",
    ]);
  });

  it("hands exact retrieved terminal truth to WP-1305 with no webhook identifiers", async () => {
    const value = fixture({ provider: provider("Captured") });
    const result = await value.service.run(run());
    expect(result.result.checks[0]?.outcome).toBe("Healed");
    expect(value.terminal).toHaveLength(1);
    expect(value.terminal[0]).toMatchObject({
      causationReference: id(1),
      webhookReceiptReference: null,
      providerEventReference: null,
      source: "ProviderRetrieval",
      status: "Captured",
      amount: { amountMinor: 1_250n },
    });
  });

  it("fails closed when the WP-1305 terminal bridge returns malformed identity", async () => {
    const value = fixture({
      provider: provider("Captured"),
      terminalReference: "not-a-transaction-reference",
    });
    expect(await code(value.service.run(run()))).toBe(
      "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
    );
    expect(value.calls).not.toContain("commit");
  });

  it("opens a stable exception for amount or terminal conflicts without terminal mutation", async () => {
    const amount = fixture({
      provider: provider("Pending", { requestedAmount: money(1_251n) }),
    });
    const amountResult = await amount.service.run(run());
    expect(amountResult.result.checks[0]).toMatchObject({
      outcome: "Difference",
      differenceReason: "AmountMismatch",
      exceptionReference: id(80),
    });
    expect(amountResult.result.exceptions[0]).toMatchObject({ status: "Open", severity: "Error" });
    const terminalConflict = fixture({
      operational: [
        operational({
          internalStatus: "Failed",
          capturedAmount: money(0n),
        }),
      ],
      provider: provider("Captured"),
    });
    const conflictResult = await terminalConflict.service.run(run());
    expect(conflictResult.result.checks[0]?.differenceReason).toBe("TerminalConflict");
    expect(conflictResult.result.exceptions[0]?.severity).toBe("Critical");
    expect(terminalConflict.terminal).toHaveLength(0);
  });

  it("records normalized Provider failures and thrown dependencies as unavailable", async () => {
    const failure = fixture({
      provider: createPaymentProviderFailure({
        kind: "Failure",
        context: provider().context,
        code: "Unavailable",
        retryDisposition: "SameOperation",
        safeReasonCode: "PROVIDER_TEMPORARILY_UNAVAILABLE" as never,
      }),
    });
    expect((await failure.service.run(run())).result.checks[0]).toMatchObject({
      outcome: "Unavailable",
      safeCode: "PROVIDER_TEMPORARILY_UNAVAILABLE",
    });
    const thrown = fixture({ providerThrows: true });
    const result = await thrown.service.run(run());
    expect(result.result.checks[0]).toMatchObject({
      outcome: "Unavailable",
      safeCode: "PROVIDER_DEPENDENCY_UNAVAILABLE",
    });
    expect(
      JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("raw provider failure detail");
  });

  it("reconciles daily settlement totals and never invents a match", async () => {
    const matched = await fixture().service.run(run("DailySettlement"));
    expect(matched.result.checks[0]).toMatchObject({
      mode: "DailySettlement",
      outcome: "Matched",
      settlementReference: "set_SYNTHETIC_13070001",
    });
    const mismatch = await fixture({ settlements: [settlement(1_249n)] }).service.run(
      run("DailySettlement"),
    );
    expect(mismatch.result.checks[0]).toMatchObject({
      outcome: "Difference",
      differenceReason: "AmountMismatch",
    });
    const missing = fixture({ settlements: [] });
    expect(await code(missing.service.run(run("DailySettlement")))).toBe(
      "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
    );
    expect(missing.calls).not.toContain("commit");
    const impossible = fixture({
      settlements: [{ ...settlement(), internalRefundedAmount: money(1_251n) }],
    });
    expect(await code(impossible.service.run(run("DailySettlement")))).toBe(
      "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
    );
  });

  it("returns an identical duplicate and rejects run conflict before candidate/provider reads", async () => {
    const first = await fixture().service.run(run());
    const duplicate = fixture({ existing: first.result });
    expect((await duplicate.service.run(run())).status).toBe("Duplicate");
    expect(duplicate.calls).toEqual(["authorize", "claim", "loadRun", "release"]);
    expect(
      await code(
        fixture({ existing: first.result }).service.run({
          ...run(),
          cutoffAt: "2026-08-03T17:58:00.000Z",
        }),
      ),
    ).toBe("PAYMENT_RECONCILIATION_RUN_CONFLICT");
  });

  it("denies before lease/read and fails closed on lease or atomic commit conflict", async () => {
    const denied = fixture({ deny: true });
    expect(await code(denied.service.run(run()))).toBe("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    expect(denied.calls).toEqual(["authorize"]);
    const lease = fixture({ lease: false });
    expect(await code(lease.service.run(run()))).toBe("PAYMENT_RECONCILIATION_LEASE_UNAVAILABLE");
    expect(lease.calls).toEqual(["authorize", "claim"]);
    expect(await code(fixture({ conflict: true }).service.run(run()))).toBe(
      "PAYMENT_RECONCILIATION_RUN_CONFLICT",
    );
  });
});

function queryInput() {
  return {
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    observedAt: checkedAt,
    exactReference: null,
    outcome: null,
    hasException: null,
    checkedFrom: null,
    checkedUntil: null,
    afterCheckedAt: null,
    afterCheckReference: null,
    limit: 10,
  };
}

describe("WP-1307 Payment reconciliation queries", () => {
  it("authorizes before a bounded exact-scope read and returns safe normalized checks", async () => {
    const result = (await fixture().service.run(run())).result;
    const calls: string[] = [];
    const ports: PaymentReconciliationQueryPorts = {
      authorization: {
        authorize: async () => {
          calls.push("authorize");
          return true;
        },
      },
      checks: {
        list: async () => {
          calls.push("list");
          return result.checks;
        },
      },
    };
    const rows = await createPaymentReconciliationQueryService(ports).list(queryInput());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "Unresolved", providerStatus: "Pending" });
    expect(calls).toEqual(["authorize", "list"]);
  });

  it("denies before reading and rejects cursor or dependency filter violations", async () => {
    const result = (await fixture().service.run(run())).result;
    const calls: string[] = [];
    const denied = createPaymentReconciliationQueryService({
      authorization: {
        authorize: async () => {
          calls.push("authorize");
          return false;
        },
      },
      checks: {
        list: async () => {
          calls.push("list");
          return result.checks;
        },
      },
    });
    expect(await code(denied.list(queryInput()))).toBe("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    expect(calls).toEqual(["authorize"]);
    const service = createPaymentReconciliationQueryService({
      authorization: { authorize: async () => true },
      checks: { list: async () => result.checks },
    });
    expect(await code(service.list({ ...queryInput(), afterCheckedAt: checkedAt }))).toBe(
      "PAYMENT_RECONCILIATION_INPUT_INVALID",
    );
    expect(await code(service.list({ ...queryInput(), outcome: "Matched" }))).toBe(
      "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
    );
  });
});

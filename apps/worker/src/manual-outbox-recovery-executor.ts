import {
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
  type OutboxTransportAdapter,
} from "@bop/eventing";
import type { AuthorizedDispatchScope } from "./outbox-dispatcher.js";

export interface ManualOutboxRecoveryClaim {
  readonly recoveryReference: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly registryDigest: string;
  readonly envelope: DomainEventEnvelope;
}
export type ManualOutboxRecoveryOutcome =
  | { readonly outcome: "acknowledged"; readonly safeCode: "ACKNOWLEDGED" }
  | {
      readonly outcome: "failed";
      readonly safeCode: "TRANSPORT_UNAVAILABLE" | "TRANSPORT_TIMEOUT" | "TRANSPORT_REJECTED";
    }
  | { readonly outcome: "unknown"; readonly safeCode: "COMMIT_OUTCOME_UNKNOWN" };
export interface ManualOutboxRecoveryExecutionPort {
  /** Commits a unique immutable invocation record; never reclaims a started operation. */
  claim(
    scope: AuthorizedDispatchScope,
    recoveryReference: string,
  ): Promise<ManualOutboxRecoveryClaim | null>;
  /** Must fence lease/registry/current authority and persist evidence before acknowledging completion. */
  record(
    scope: AuthorizedDispatchScope,
    input: {
      readonly recoveryReference: string;
      readonly leaseToken: string;
      readonly result: ManualOutboxRecoveryOutcome;
    },
  ): Promise<"recorded" | "lost_lease">;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const unknown: ManualOutboxRecoveryOutcome = Object.freeze({
  outcome: "unknown",
  safeCode: "COMMIT_OUTCOME_UNKNOWN",
});
export function createManualOutboxRecoveryExecutor(options: {
  readonly scope: AuthorizedDispatchScope;
  readonly registryDigest: string;
  readonly execution: ManualOutboxRecoveryExecutionPort;
  readonly adapter: OutboxTransportAdapter;
  readonly adapterTimeoutMs: number;
  now(): number;
}) {
  const scope = Object.freeze({ ...options.scope }),
    digest = options.registryDigest;
  if (
    !uuid.test(scope.brandId) ||
    (scope.storeId !== undefined && !uuid.test(scope.storeId)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
    !Number.isInteger(options.adapterTimeoutMs) ||
    options.adapterTimeoutMs < 1 ||
    options.adapterTimeoutMs > 25000
  )
    throw new TypeError("MANUAL_RECOVERY_EXECUTOR_CONFIG_INVALID");
  const active = new Map<string, Promise<"recorded" | "lost_lease" | "not_claimed">>();
  async function execute(reference: string): Promise<"recorded" | "lost_lease" | "not_claimed"> {
    let claim: ManualOutboxRecoveryClaim | null;
    try {
      claim = await options.execution.claim(scope, reference);
    } catch {
      throw new Error("MANUAL_RECOVERY_CLAIM_UNAVAILABLE");
    }
    if (claim === null) return "not_claimed";
    // Never expose or deliver malformed/cross-scope envelopes. A persisted claim
    // with invalid metadata requires owner reconciliation, not a guessed finish.
    let leaseDeadline: number;
    try {
      if (
        claim.recoveryReference !== reference ||
        !uuid.test(claim.leaseToken) ||
        claim.registryDigest !== digest
      )
        throw new Error();
      validateDomainEventEnvelope(claim.envelope);
      if (claim.envelope.tenantId !== scope.brandId || claim.envelope.storeId !== scope.storeId)
        throw new Error();
      leaseDeadline = Date.parse(claim.leaseExpiresAt);
      if (
        !Number.isFinite(leaseDeadline) ||
        new Date(leaseDeadline).toISOString() !== claim.leaseExpiresAt
      )
        throw new Error();
    } catch {
      throw new Error("MANUAL_RECOVERY_CLAIM_INVALID");
    }
    const start = options.now();
    if (!Number.isFinite(start)) throw new Error("MANUAL_RECOVERY_CLOCK_INVALID");
    const budget = Math.min(options.adapterTimeoutMs, leaseDeadline - start);
    let result: ManualOutboxRecoveryOutcome = unknown;
    if (budget > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Timeout does not cancel a transport already in flight. Its eventual
        // acknowledgement must never overwrite the durable unknown outcome.
        const published = Promise.resolve().then(() =>
          options.adapter.publish(claim.envelope, { attemptCount: 1 }),
        );
        const response = await Promise.race([
          published,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), budget);
          }),
        ]);
        const end = options.now();
        if (Number.isFinite(end) && end >= start && end < leaseDeadline) {
          if (response?.status === "acknowledged")
            result = { outcome: "acknowledged", safeCode: "ACKNOWLEDGED" };
          else if (
            response?.status === "failed" &&
            ["TRANSPORT_UNAVAILABLE", "TRANSPORT_REJECTED"].includes(response.errorCode)
          )
            result = {
              outcome: "failed",
              safeCode: response.errorCode as
                "TRANSPORT_UNAVAILABLE" | "TRANSPORT_TIMEOUT" | "TRANSPORT_REJECTED",
            };
        }
      } catch {
        result = unknown;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    try {
      const recorded = await options.execution.record(scope, {
        recoveryReference: reference,
        leaseToken: claim.leaseToken,
        result,
      });
      if (recorded !== "recorded" && recorded !== "lost_lease") throw new Error();
      return recorded;
    } catch {
      throw new Error("MANUAL_RECOVERY_OUTCOME_UNCONFIRMED");
    }
  }
  return Object.freeze({
    run(recoveryReference: string) {
      if (!uuid.test(recoveryReference))
        return Promise.reject(new Error("MANUAL_RECOVERY_REFERENCE_INVALID"));
      const existing = active.get(recoveryReference);
      if (existing) return existing;
      const flight = execute(recoveryReference);
      active.set(recoveryReference, flight);
      void flight.then(
        () => active.delete(recoveryReference),
        () => active.delete(recoveryReference),
      );
      return flight;
    },
  });
}

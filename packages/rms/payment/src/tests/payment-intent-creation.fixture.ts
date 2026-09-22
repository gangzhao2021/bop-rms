import type { AppendAuditRecordInput } from "@bop/audit";
import { createHash } from "node:crypto";

import {
  createPaymentProviderSnapshot,
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

export { id, digest, at, refs, killSwitchEvaluation, preparation, audit, command, harness };

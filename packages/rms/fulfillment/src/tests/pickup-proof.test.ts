import { foldPickupProofHistory } from "../application/pickup-proof-history.js";
import { parseFulfillmentReadinessSource } from "../contracts/fulfillment-readiness.js";
import { describe, expect, it } from "vitest";

import {
  PickupProofError,
  parsePickupProofSource,
  planPickupProofIssue,
  validatePickupProof,
} from "../contracts/pickup-proof.js";

import {
  encodePickupProofIssueRecord,
  decodePickupProofIssueRecord,
  encodePickupProofVerificationRecord,
  decodePickupProofVerificationRecord,
} from "../application/pickup-proof-record.js";

const ids = {
  fulfillment: "018f1000-0000-7000-8000-000000000001",
  brand: "018f1000-0000-7000-8000-000000000002",
  store: "018f1000-0000-7000-8000-000000000003",
  item: "018f1000-0000-7000-8000-000000000004",
  first: "018f1000-0000-7000-8000-000000000005",
  second: "018f1000-0000-7000-8000-000000000006",
  operation: "018f1000-0000-7000-8000-000000000007",
  invalidation: "018f1000-0000-7000-8000-000000000008",
  idempotency: "018f1000-0000-7000-8000-000000000009",
  correlation: "018f1000-0000-7000-8000-00000000000a",
  verification: "018f1000-0000-7000-8000-00000000000b",
  verifyOperation: "018f1000-0000-7000-8000-00000000000c",
  verifyIdempotency: "018f1000-0000-7000-8000-00000000000d",
  verifyCorrelation: "018f1000-0000-7000-8000-00000000000e",
} as const;

const readyAt = "2026-08-11T12:00:00.000Z";
const firstSelector = "1".repeat(64);
const secondSelector = "2".repeat(64);

const item = Object.freeze({
  fulfillmentItemReference: ids.item,
  orderedQuantity: 2,
  readyQuantity: 2,
  handedOverQuantity: 0,
  state: "Ready",
});

function source(current: null | { generation: number; capabilityReference: string } = null) {
  return Object.freeze({
    fulfillmentReference: ids.fulfillment,
    brandReference: ids.brand,
    storeReference: ids.store,
    fulfillmentType: "Pickup",
    canonicalPhase: "Ready",
    aggregateVersion: current === null ? 3n : 4n,
    readyAt,
    currentProofGeneration: current?.generation ?? null,
    currentProofCapabilityReference: current?.capabilityReference ?? null,
    lockedAt: "2026-08-11T12:05:00.000Z",
    items: Object.freeze([item]),
  });
}

function capability(
  input: {
    reference?: string;
    generation?: number;
    selector?: string;
    capabilityReadyAt?: string;
    expiresAt?: string;
  } = {},
) {
  return Object.freeze({
    capabilityReference: input.reference ?? ids.first,
    purpose: "PickupHandoff",
    kind: "HumanCode",
    storeReference: ids.store,
    fulfillmentReference: ids.fulfillment,
    publicOrderReference: "AAAAAAAAAAAAAAAAAAAAAA",
    selectorHash: input.selector ?? firstSelector,
    pepperVersion: 1,
    generation: input.generation ?? 1,
    status: "Active",
    version: 1,
    readyAt: input.capabilityReadyAt ?? readyAt,
    expiresAt: input.expiresAt ?? "2026-08-11T13:00:00.000Z",
    revokedAt: null,
  });
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    source: source(),
    candidate: capability(),
    previous: null,
    expectedAggregateVersion: 3n,
    observedAt: "2026-08-11T12:01:00.000Z",
    operationReference: ids.operation,
    invalidationReference: null,
    idempotencyReference: ids.idempotency,
    correlationReference: ids.correlation,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: PickupProofError["code"]): void {
  expect(action).toThrowError(PickupProofError);
  try {
    action();
  } catch (error) {
    expect((error as PickupProofError).code).toBe(code);
  }
}

describe("WP-1602 Pickup Proof", () => {
  it("plans generation one only for an exact Ready Fulfillment without raw proof material", () => {
    const effect = planPickupProofIssue(issueInput());
    expect(effect.operation.operationKind).toBe("Issue");
    expect(effect.operation.aggregateVersionAfter).toBe(4n);
    expect(effect.generation.generation).toBe(1);
    expect(effect.invalidation).toBeNull();
    expect(effect.generation.selectorHash).toBe(firstSelector);
    expect(
      JSON.stringify(effect, (_, entry) => (typeof entry === "bigint" ? String(entry) : entry)),
    ).not.toContain("123456");
    expect(Object.isFrozen(effect)).toBe(true);
  });

  it("rejects Pending, partial quantity, stale version, cross-Store and expired issuance", () => {
    expectCode(
      () =>
        parsePickupProofSource({
          ...source(),
          canonicalPhase: "Pending",
        }),
      "PICKUP_PROOF_NOT_READY",
    );
    expectCode(
      () =>
        parsePickupProofSource({
          ...source(),
          items: [{ ...item, readyQuantity: 1 }],
        }),
      "PICKUP_PROOF_NOT_READY",
    );
    expectCode(
      () => planPickupProofIssue(issueInput({ expectedAggregateVersion: 2n })),
      "PICKUP_PROOF_VERSION_CONFLICT",
    );
    expectCode(
      () =>
        planPickupProofIssue(
          issueInput({ candidate: { ...capability(), storeReference: ids.brand } }),
        ),
      "PICKUP_PROOF_UNAVAILABLE",
    );
    expectCode(
      () => planPickupProofIssue(issueInput({ observedAt: "2026-08-11T13:00:00.000Z" })),
      "PICKUP_PROOF_UNAVAILABLE",
    );
  });

  it("regenerates with exact next generation and an append-only prior invalidation", () => {
    const previous = capability();
    const replacement = capability({
      reference: ids.second,
      generation: 2,
      selector: secondSelector,
      capabilityReadyAt: "2026-08-11T12:10:00.000Z",
    });
    const effect = planPickupProofIssue({
      ...issueInput(),
      source: source({ generation: 1, capabilityReference: ids.first }),
      candidate: replacement,
      previous,
      expectedAggregateVersion: 4n,
      observedAt: "2026-08-11T12:10:00.000Z",
      invalidationReference: ids.invalidation,
    });
    expect(effect.operation.operationKind).toBe("Regenerate");
    expect(effect.invalidation).toEqual(
      expect.objectContaining({
        priorCapabilityReference: ids.first,
        replacementCapabilityReference: ids.second,
        priorGeneration: 1,
        replacementGeneration: 2,
      }),
    );
  });

  it("rejects reused selector, skipped generation and lifetime reset beyond original Ready window", () => {
    const currentSource = source({ generation: 1, capabilityReference: ids.first });
    const base = {
      ...issueInput(),
      source: currentSource,
      previous: capability(),
      expectedAggregateVersion: 4n,
      observedAt: "2026-08-11T12:10:00.000Z",
      invalidationReference: ids.invalidation,
    };
    for (const candidate of [
      capability({
        reference: ids.second,
        generation: 2,
        capabilityReadyAt: "2026-08-11T12:10:00.000Z",
      }),
      capability({
        reference: ids.second,
        generation: 3,
        selector: secondSelector,
        capabilityReadyAt: "2026-08-11T12:10:00.000Z",
      }),
      capability({
        reference: ids.second,
        generation: 2,
        selector: secondSelector,
        capabilityReadyAt: "2026-08-11T12:10:00.000Z",
        expiresAt: "2026-08-11T13:10:00.000Z",
      }),
    ])
      expectCode(() => planPickupProofIssue({ ...base, candidate }), "PICKUP_PROOF_UNAVAILABLE");
  });

  it("validates only the current exact proof and returns no completion authority", () => {
    const verification = validatePickupProof({
      source: source({ generation: 1, capabilityReference: ids.first }),
      capability: capability(),
      selectorHash: firstSelector,
      generation: 1,
      expectedCapabilityVersion: 1,
      observedAt: "2026-08-11T12:20:00.000Z",
      verificationReference: ids.verification,
      operationReference: ids.verifyOperation,
      idempotencyReference: ids.verifyIdempotency,
      correlationReference: ids.verifyCorrelation,
    });
    expect(verification).toEqual(
      expect.objectContaining({
        validationStatus: "Validated",
        verificationMethod: "HumanCode",
        grantsCompletionAuthority: false,
      }),
    );
    expect(verification).not.toHaveProperty("selectorHash");
  });

  it("fails closed for stale generation, wrong selector, wrong version and expiry", () => {
    const base = {
      source: source({ generation: 1, capabilityReference: ids.first }),
      capability: capability(),
      selectorHash: firstSelector,
      generation: 1,
      expectedCapabilityVersion: 1,
      observedAt: "2026-08-11T12:20:00.000Z",
      verificationReference: ids.verification,
      operationReference: ids.verifyOperation,
      idempotencyReference: ids.verifyIdempotency,
      correlationReference: ids.verifyCorrelation,
    };
    for (const overrides of [
      { generation: 2 },
      { selectorHash: secondSelector },
      { expectedCapabilityVersion: 2 },
      { observedAt: "2026-08-11T13:00:00.000Z" },
      { source: source({ generation: 2, capabilityReference: ids.second }) },
    ])
      expectCode(() => validatePickupProof({ ...base, ...overrides }), "PICKUP_PROOF_UNAVAILABLE");
  });

  it("rejects extra, accessor, prototype and aliased operation references", () => {
    expectCode(
      () => planPickupProofIssue({ ...issueInput(), rawProof: "123456" }),
      "PICKUP_PROOF_INPUT_INVALID",
    );
    const accessor = issueInput();
    Object.defineProperty(accessor, "candidate", { enumerable: true, get: () => capability() });
    expectCode(() => planPickupProofIssue(accessor), "PICKUP_PROOF_INPUT_INVALID");
    expectCode(
      () => planPickupProofIssue(Object.assign(Object.create(null), issueInput())),
      "PICKUP_PROOF_INPUT_INVALID",
    );
    expectCode(
      () => planPickupProofIssue(issueInput({ idempotencyReference: ids.operation })),
      "PICKUP_PROOF_INPUT_INVALID",
    );
  });
});

describe("WP-2402 immutable pickup proof records", () => {
  it("recovers issue and regeneration with exact bigint versions", () => {
    const issue = planPickupProofIssue(issueInput());
    const regenerate = planPickupProofIssue({
      ...issueInput(),
      source: source({ generation: 1, capabilityReference: ids.first }),
      previous: capability(),
      candidate: capability({
        reference: ids.second,
        generation: 2,
        selector: secondSelector,
        capabilityReadyAt: "2026-08-11T12:10:00.000Z",
      }),
      expectedAggregateVersion: 4n,
      observedAt: "2026-08-11T12:10:00.000Z",
      invalidationReference: ids.invalidation,
    });
    for (const effect of [issue, regenerate]) {
      const recovered = decodePickupProofIssueRecord(encodePickupProofIssueRecord(effect));
      expect(recovered).toEqual(effect);
      expect(Object.isFrozen(recovered.operation)).toBe(true);
    }
    const record = JSON.parse(encodePickupProofIssueRecord(regenerate));
    for (const change of [
      { priorGeneration: 2 },
      { replacementCapabilityReference: ids.first },
      { invalidatedAt: readyAt },
      { fulfillmentReference: ids.item },
    ]) {
      expect(() =>
        decodePickupProofIssueRecord(
          JSON.stringify({
            ...record,
            effect: {
              ...record.effect,
              invalidation: { ...record.effect.invalidation, ...change },
            },
          }),
        ),
      ).toThrow(PickupProofError);
    }
  });

  it("rejects tampered scope, operation, lifetime and raw credential fields", () => {
    const record = JSON.parse(encodePickupProofIssueRecord(planPickupProofIssue(issueInput())));
    for (const change of [
      { storeReference: ids.brand },
      { generation: 2 },
      { capabilityReference: ids.second },
      { occurredAt: readyAt },
      { operationKind: "Regenerate" },
      { aggregateVersionAfter: "5" },
      { operationReference: ids.first },
    ]) {
      expect(() =>
        decodePickupProofIssueRecord(
          JSON.stringify({
            ...record,
            effect: { ...record.effect, operation: { ...record.effect.operation, ...change } },
          }),
        ),
      ).toThrow(PickupProofError);
    }
    for (const change of [
      { rawProof: "synthetic-forbidden-value" },
      { issuedAt: "2026-08-11T13:00:00.000Z" },
      { issuedAt: "2026-08-11T11:59:00.000Z" },
      { selectorHash: "invalid" },
    ]) {
      expect(() =>
        decodePickupProofIssueRecord(
          JSON.stringify({
            ...record,
            effect: { ...record.effect, generation: { ...record.effect.generation, ...change } },
          }),
        ),
      ).toThrow(PickupProofError);
    }
  });

  it("rejects lossy or oversized versions and unsupported record envelopes", () => {
    const record = JSON.parse(encodePickupProofIssueRecord(planPickupProofIssue(issueInput())));
    for (const key of ["aggregateVersionBefore", "aggregateVersionAfter"]) {
      for (const version of [3, "03", "0", "-1", "3e0", "9223372036854775808", null]) {
        expect(() =>
          decodePickupProofIssueRecord(
            JSON.stringify({
              ...record,
              effect: {
                ...record.effect,
                operation: { ...record.effect.operation, [key]: version },
              },
            }),
          ),
        ).toThrow(PickupProofError);
      }
    }
    for (const value of [
      null,
      "invalid",
      "{}",
      JSON.stringify({ ...record, recordVersion: 2 }),
      JSON.stringify({ ...record, extra: true }),
    ]) {
      expect(() => decodePickupProofIssueRecord(value)).toThrow(PickupProofError);
    }
  });

  it("preserves verification without granting completion or retaining the selector", () => {
    const verification = validatePickupProof({
      source: source({ generation: 1, capabilityReference: ids.first }),
      capability: capability(),
      selectorHash: firstSelector,
      generation: 1,
      expectedCapabilityVersion: 1,
      observedAt: "2026-08-11T12:20:00.000Z",
      verificationReference: ids.verification,
      operationReference: ids.verifyOperation,
      idempotencyReference: ids.verifyIdempotency,
      correlationReference: ids.verifyCorrelation,
    });
    const encoded = encodePickupProofVerificationRecord(verification);
    expect(decodePickupProofVerificationRecord(encoded)).toEqual(verification);
    expect(encoded).not.toContain(firstSelector);
    for (const change of [
      { grantsCompletionAuthority: true },
      { validationStatus: "Allowed" },
      { selectorHash: firstSelector },
      { generation: 0 },
      { verificationMethod: "Bypass" },
      { verificationReference: ids.first },
      { operationReference: ids.verifyIdempotency },
    ]) {
      expect(() =>
        decodePickupProofVerificationRecord(
          JSON.stringify({
            recordVersion: 1,
            effect: { ...verification, ...change },
          }),
        ),
      ).toThrow(PickupProofError);
    }
  });
});

describe("WP-2402 current proof history", () => {
  const readiness = () =>
    parseFulfillmentReadinessSource({
      fulfillmentReference: ids.fulfillment,
      brandReference: ids.brand,
      storeReference: ids.store,
      orderReference: ids.operation,
      orderBatchReference: ids.correlation,
      canonicalPhase: "Ready",
      aggregateVersion: 3n,
      lockedAt: "2026-08-11T12:30:00.000Z",
      items: [{ ...item, orderItemReference: ids.idempotency }],
    });
  it("folds issue versions while keeping the original all-ready lifetime", () => {
    const first = planPickupProofIssue(issueInput());
    const second = planPickupProofIssue({
      ...issueInput(),
      source: source({ generation: 1, capabilityReference: ids.first }),
      previous: capability(),
      candidate: capability({
        reference: ids.second,
        generation: 2,
        selector: secondSelector,
        capabilityReadyAt: "2026-08-11T12:10:00.000Z",
      }),
      expectedAggregateVersion: 4n,
      observedAt: "2026-08-11T12:10:00.000Z",
      invalidationReference: ids.invalidation,
    });
    const result = foldPickupProofHistory(readiness(), readyAt, {
      issues: [first, second],
      verifications: [],
    });
    expect(result.source.aggregateVersion).toBe(5n);
    expect(result.source.readyAt).toBe(readyAt);
    expect(result.source.currentProofCapabilityReference).toBe(ids.second);
    expect(result.lastIssuedAt).toBe("2026-08-11T12:10:00.000Z");
    for (const issues of [[second], [first, first], [second, first]]) {
      expect(() =>
        foldPickupProofHistory(readiness(), readyAt, { issues, verifications: [] }),
      ).toThrow(PickupProofError);
    }
  });
  it("rejects history inconsistent with actual Ready instant, scope or observation time", () => {
    const first = planPickupProofIssue(issueInput());
    const history = { issues: [first], verifications: [] };
    expect(() => foldPickupProofHistory(readiness(), "2026-08-11T12:02:00.000Z", history)).toThrow(
      PickupProofError,
    );
    expect(() =>
      foldPickupProofHistory(
        parseFulfillmentReadinessSource({
          ...readiness(),
          lockedAt: "2026-08-11T11:59:00.000Z",
        }),
        readyAt,
        history,
      ),
    ).toThrow(PickupProofError);
    expect(() =>
      foldPickupProofHistory(
        {
          ...readiness(),
          storeReference: parseFulfillmentReadinessSource({
            ...readiness(),
            storeReference: ids.brand,
          }).storeReference,
        },
        readyAt,
        history,
      ),
    ).toThrow(PickupProofError);
  });
});

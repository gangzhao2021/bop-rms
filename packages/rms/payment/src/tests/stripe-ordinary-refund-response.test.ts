import { deriveOrdinaryRefundConfirmedPosition as position } from "../application/ordinary-refund-confirmed-position.js";
import { bindOrdinaryRefundProviderOutcome } from "../application/ordinary-refund-provider-result.js";
import { parseOrdinaryRefundProviderResult } from "../application/ordinary-refund-provider-result.js";
import { createOrdinaryRefundDispatch } from "../application/ordinary-refund-dispatch.js";
import {
  createOrdinaryRefundObservation,
  encodeOrdinaryRefundObservation,
  decodeOrdinaryRefundObservation,
} from "../application/ordinary-refund-observation.js";
import { expect, it } from "vitest";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
import { createOrdinaryRefundProviderRequest } from "../application/ordinary-refund-provider-request.js";
import { stripeOrdinaryRefundBinding as binding } from "../infrastructure/stripe/stripe-ordinary-refund-request.js";
import { normalizeStripeOrdinaryRefundResponse as normalize } from "../infrastructure/stripe/stripe-ordinary-refund-response.js";
function fixture() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    requestReference: id(5),
    operationReference: id(6),
    providerOperationReference: id(7),
    paymentTransactionReference: id(8),
    paymentIntentReference: id(9),
    paymentAttemptReference: id(10),
    firstCaptureReference: id(11),
    providerAccountReference: id(12),
    executorReference: id(13),
    auditReference: id(14),
    approvalReference: null,
    claimVersion: 1,
    claimsDigest: "sha256:" + "a".repeat(64),
    allocationDigest: "sha256:" + "b".repeat(64),
    preparedAt: "2026-09-13T12:00:00.000Z",
    environment: "Test",
    currencyCode: "CAD",
    amountMinor: 6000n,
    policyVersion: "PILOT_ORDINARY_REFUND_V1",
    status: "Prepared",
  };
}
function source() {
  const op = fixture();
  return {
    tenantReference: op.tenantReference,
    brandReference: op.brandReference,
    storeReference: op.storeReference,
    orderReference: op.orderReference,
    paymentTransactionReference: op.paymentTransactionReference,
    paymentIntentReference: op.paymentIntentReference,
    paymentAttemptReference: op.paymentAttemptReference,
    firstCaptureReference: op.firstCaptureReference,
    providerAccountReference: op.providerAccountReference,
    environment: "Test",
    providerIntentReference: "pi_syntheticRefund",
    originalPaymentMethod: "OnlineCard",
  };
}

const request = () => createOrdinaryRefundProviderRequest(fixture(), source());

const at = "2026-09-13T12:00:02.000Z";
function payload() {
  return {
    object: "refund",
    id: "re_syntheticRefund",
    payment_intent: request().providerIntentReference,
    amount: 6000,
    currency: "cad",
    created: Date.parse("2026-09-13T12:00:01.000Z") / 1000,
    status: "succeeded",
    metadata: { bop_refund_binding: binding(request()) },
  };
}
it.each(["pending", "requires_action", "succeeded", "failed", "canceled"])(
  "retains individual Provider status %s without asserting local settlement",
  (status) => {
    const record = normalize(request(), { ...payload(), status }, at);
    expect(record.kind).toBe("RefundObservation");
    expect(record.status).toBe(status);
    expect(record.providerRefundReference).toBe("re_syntheticRefund");
    expect(record.amount.amountMinor).toBe(6000n);
    expect(record.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(record).not.toHaveProperty("settled");
  },
);
it.each([
  { amount: 6001 },
  { amount: 5999 },
  { amount: 6000.5 },
  { amount: "6000" },
  { currency: "usd" },
  { payment_intent: "pi_foreignIntent" },
  { id: "re_bad/path" },
  { status: null },
  { status: "unknown" },
  { created: 1.5 },
  { created: Date.parse(at) / 1000 + 1 },
  { metadata: null },
  { metadata: { bop_refund_binding: "sha256:" + "0".repeat(64) } },
])("rejects mismatched or invalid refund facts", (patch) => {
  expect(() => normalize(request(), { ...payload(), ...patch }, at)).toThrow(
    "STRIPE_ORDINARY_REFUND_RESPONSE_INVALID",
  );
});
it("projects away raw customer and destination data, including from digest", () => {
  const clean = normalize(request(), payload(), at);
  const extra = normalize(
    request(),
    {
      ...payload(),
      description: "synthetic private description",
      instructions_email: "synthetic@example.invalid",
      destination_details: { card: { reference: "synthetic private reference" } },
      metadata: { ...payload().metadata, ignored: "synthetic private metadata" },
    },
    at,
  );
  expect(extra).toEqual(clean);
  expect(
    JSON.stringify(extra, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  ).not.toContain("private");
});
it("rejects required accessors without invoking them", () => {
  let reads = 0;
  const raw = { ...payload() };
  Object.defineProperty(raw, "amount", {
    get() {
      reads++;
      return 6000;
    },
  });
  expect(() => normalize(request(), raw, at)).toThrow();
  expect(reads).toBe(0);
});
it("changes evidence for a different refund identity or state", () => {
  const first = normalize(request(), payload(), at);
  expect(normalize(request(), { ...payload(), id: "re_otherRefund" }, at).evidenceDigest).not.toBe(
    first.evidenceDigest,
  );
  expect(normalize(request(), { ...payload(), status: "pending" }, at).evidenceDigest).not.toBe(
    first.evidenceDigest,
  );
});

it("rejects changed normalized content or digest before persistence", () => {
  const record = normalize(request(), payload(), at);
  for (const patch of [
    { status: "pending" },
    { evidenceDigest: "sha256:" + "0".repeat(64) },
    { providerRefundReference: "re_changedRefund" },
    { extra: "unexpected" },
  ])
    expect(() => parseOrdinaryRefundProviderResult({ ...record, ...patch })).toThrow();
});
it("roundtrips individual evidence and respects second-precision dispatch creation bounds", () => {
  const operation = fixture();
  const dispatch = (startedAt: string) =>
    createOrdinaryRefundDispatch({
      operation,
      providerBinding: source(),
      startedAt,
      approvalReference: null,
      claimVersion: operation.claimVersion,
      claimsDigest: operation.claimsDigest,
      dispatchReference: id(70),
      auditReference: id(71),
    });
  const make = (startedAt: string) =>
    createOrdinaryRefundObservation({
      dispatch: dispatch(startedAt),
      request: request(),
      outcome: normalize(request(), payload(), at),
      observationReference: id(80),
      auditReference: id(81),
      recordedAt: at,
    });
  const record = make("2026-09-13T12:00:01.999Z");
  expect(decodeOrdinaryRefundObservation(encodeOrdinaryRefundObservation(record))).toEqual(record);
  expect(record.state).toBe("NeedsReconciliation");
  expect(() => make("2026-09-13T12:00:02.000Z")).toThrow();
});

it("preserves a bound individual result through the send outcome boundary", () => {
  const record = normalize(request(), payload(), at);
  expect(bindOrdinaryRefundProviderOutcome(request(), record)).toEqual(record);
});
it("sanitizes malformed, unresolved or changed channel evidence to Unknown", () => {
  const record = normalize(request(), payload(), at);
  for (const value of [
    null,
    { kind: "Unresolved", private: "synthetic private" },
    { ...record, providerRefundReference: "re_changed" },
  ]) {
    expect(bindOrdinaryRefundProviderOutcome(request(), value)).toEqual({
      kind: "Failure",
      context: request().context,
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "PROVIDER_OUTCOME_UNKNOWN",
    });
  }
});
it("rejects valid evidence bound to another scoped request", () => {
  const original = request();
  const other = { ...original, context: { ...original.context, storeReference: id(99) as never } };
  const record = normalize(
    other,
    { ...payload(), metadata: { bop_refund_binding: binding(other) } },
    at,
  );
  expect(bindOrdinaryRefundProviderOutcome(original, record)).toHaveProperty("code", "Unknown");
});

function positionInput(statuses: readonly string[]) {
  const operation = fixture();
  const dispatch = createOrdinaryRefundDispatch({
    operation,
    providerBinding: source(),
    approvalReference: null,
    claimVersion: operation.claimVersion,
    claimsDigest: operation.claimsDigest,
    startedAt: operation.preparedAt,
    dispatchReference: id(70),
    auditReference: id(71),
  });
  return {
    dispatch,
    request: request(),
    observedAt: "2026-09-13T13:00:00.000Z",
    observations: statuses.map((status, index) => {
      const time = new Date(Date.parse(at) + index * 1000).toISOString();
      return createOrdinaryRefundObservation({
        dispatch,
        request: request(),
        outcome:
          status === "unknown"
            ? {
                kind: "Failure",
                context: request().context,
                code: "Unknown",
                retryDisposition: "Unknown",
                safeReasonCode: "PROVIDER_OUTCOME_UNKNOWN",
              }
            : normalize(request(), { ...payload(), status }, time),
        observationReference: id(100 + index),
        auditReference: id(200 + index),
        recordedAt: time,
      });
    }),
  };
}
it.each([[], ["unknown"], ["pending"], ["requires_action"], ["failed"], ["canceled"]])(
  "retains full occupancy without individual success: %j",
  (...statuses) => {
    const result = position(positionInput(statuses));
    expect(result).toMatchObject({
      state: "NeedsReconciliation",
      confirmedMinor: 0n,
      pendingMinor: 6000n,
      releasedMinor: 0n,
      confirmedAt: null,
      providerCreatedAt: null,
    });
  },
);
it("counts success once across repeated observations, replay and out-of-order delivery", () => {
  const input = positionInput(["pending", "succeeded", "unknown", "succeeded"]);
  const expected = position(input);
  expect(expected).toMatchObject({
    state: "Confirmed",
    confirmedMinor: 6000n,
    pendingMinor: 0n,
    releasedMinor: 0n,
    confirmedAt: "2026-09-13T12:00:03.000Z",
    providerCreatedAt: "2026-09-13T12:00:01.000Z",
    observationCount: 4,
  });
  expect(position({ ...input, observations: [...input.observations].reverse() })).toEqual(expected);
  expect(
    position({ ...input, observations: [...input.observations, ...input.observations] }),
  ).toEqual(expected);
});
it.each([
  ["failed", "succeeded"],
  ["succeeded", "canceled"],
  ["canceled", "failed"],
])("rejects conflicting terminal evidence %s then %s", (first, second) => {
  expect(() => position(positionInput([first, second]))).toThrow(
    "ORDINARY_REFUND_CONFIRMATION_HISTORY_INVALID",
  );
});
it("rejects foreign, future, conflicting observation and Audit identities", () => {
  const input = positionInput(["pending", "succeeded"]);
  const first = input.observations[0];
  const second = input.observations[1];
  if (!first || !second) throw new Error("FIXTURE_MISSING");
  for (const observations of [
    [{ ...first, tenantReference: id(900) }],
    [{ ...first, recordedAt: "2026-09-14T12:00:00.000Z" }],
    [first, { ...second, observationReference: first.observationReference }],
    [first, { ...second, auditReference: first.auditReference }],
  ])
    expect(() => position({ ...input, observations })).toThrow();
  expect(() =>
    position({
      ...input,
      observations: [],
      dispatch: { ...input.dispatch, providerRequestDigest: "sha256:" + "f".repeat(64) },
    }),
  ).toThrow();
});
it("rejects a second Provider refund identity for the same operation", () => {
  const input = positionInput(["succeeded"]);
  const second = createOrdinaryRefundObservation({
    dispatch: input.dispatch,
    request: input.request,
    outcome: normalize(request(), { ...payload(), id: "re_otherRefund" }, at),
    observationReference: id(800),
    auditReference: id(801),
    recordedAt: at,
  });
  expect(() => position({ ...input, observations: [...input.observations, second] })).toThrow(
    "ORDINARY_REFUND_CONFIRMATION_HISTORY_INVALID",
  );
});

it("retains Provider creation date when success is first observed on a later day", () => {
  const input = positionInput([]);
  const later = "2026-09-14T12:00:00.000Z";
  const observation = createOrdinaryRefundObservation({
    dispatch: input.dispatch,
    request: input.request,
    outcome: normalize(input.request, { ...payload(), status: "succeeded" }, later),
    observationReference: id(810),
    auditReference: id(811),
    recordedAt: later,
  });
  expect(position({ ...input, observedAt: later, observations: [observation] })).toMatchObject({
    state: "Confirmed",
    confirmedMinor: 6000n,
    providerCreatedAt: "2026-09-13T12:00:01.000Z",
    confirmedAt: later,
  });
});
it("rejects conflicting creation times for the same Provider refund identity", () => {
  const input = positionInput(["succeeded"]);
  const changed = createOrdinaryRefundObservation({
    dispatch: input.dispatch,
    request: input.request,
    outcome: normalize(
      input.request,
      { ...payload(), created: payload().created + 1, status: "succeeded" },
      at,
    ),
    observationReference: id(812),
    auditReference: id(813),
    recordedAt: at,
  });
  expect(() => position({ ...input, observations: [...input.observations, changed] })).toThrow(
    "ORDINARY_REFUND_CONFIRMATION_HISTORY_INVALID",
  );
});

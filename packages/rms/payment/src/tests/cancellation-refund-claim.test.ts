import { expect, it } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  decodeOrdinaryRefundRequest,
  encodeOrdinaryRefundRequest,
  ordinaryRefundClaimKind,
  parseOrdinaryRefundRequest,
} from "../application/ordinary-refund-request.js";
import { evaluateOrdinaryRefundEscalation } from "../application/ordinary-refund-escalation.js";
import { createPostgresOrdinaryRefundEscalationSource } from "../infrastructure/persistence/ordinary-refund-request-store.js";
import {
  cancellationClaimFixture,
  cancellationRequestFixture,
  ordinaryRefundRequestFixture,
  must,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";

const claim = () => cancellationClaimFixture();

it("keeps legacy Ordinary records byte-identical and without a claim key", () => {
  const legacy = ordinaryRefundRequestFixture();
  const encoded = encodeOrdinaryRefundRequest(legacy);
  expect(encoded).not.toContain('"claim"');
  const decoded = decodeOrdinaryRefundRequest(encoded);
  expect(Object.prototype.hasOwnProperty.call(decoded, "claim")).toBe(false);
  expect(ordinaryRefundClaimKind(decoded)).toBe("Ordinary");
  expect(encodeOrdinaryRefundRequest(decoded)).toBe(encoded);
  // Frozen expected prefix/suffix: claim never changes the legacy layout.
  expect(encoded.startsWith('{"tenantReference":')).toBe(true);
  expect(encoded.endsWith("]}]}")).toBe(true);
});

it("round-trips a Cancellation claim exactly", () => {
  const request = parseOrdinaryRefundRequest(cancellationRequestFixture());
  expect(ordinaryRefundClaimKind(request)).toBe("Cancellation");
  expect(request.claim).toEqual(claim());
  const encoded = encodeOrdinaryRefundRequest(request);
  expect(encoded.endsWith(',"claim":' + JSON.stringify(claim()) + "}")).toBe(true);
  const decoded = decodeOrdinaryRefundRequest(encoded);
  expect(decoded).toEqual(request);
  expect(encodeOrdinaryRefundRequest(decoded)).toBe(encoded);
});

it.each([
  ["other kind", { ...claim(), kind: "Ordinary" }],
  ["extra key", { ...claim(), approverReference: id(41) }],
  ["missing digest", { kind: "Cancellation", cancellationReference: id(40) }],
  ["bad digest", { ...claim(), cancellationDigest: "sha256:" + "C".repeat(64) }],
  ["non-v7 reference", { ...claim(), cancellationReference: "not-a-uuid" }],
  ["null", null],
])("rejects a malformed claim: %s", (_name, value) => {
  expect(() =>
    parseOrdinaryRefundRequest({ ...cancellationRequestFixture(), claim: value }),
  ).toThrow("ORDINARY_REFUND_REQUEST_INVALID");
});

it("DEC-TIP-REFUND-PROPORTIONAL: a Cancellation claim carries the items' tip share", () => {
  const value = cancellationRequestFixture();
  const item = value.payments[0]?.items[0];
  if (!item) throw new Error("FIXTURE_MISSING");
  item.components.tipAmountMinor = 1n;
  value.amountMinor = 5501n;
  expect(parseOrdinaryRefundRequest(value).amountMinor).toBe(5501n);
  // The same allocation is a valid Ordinary claim.
  const ordinary: Record<string, unknown> = { ...value };
  delete ordinary.claim;
  expect(parseOrdinaryRefundRequest(ordinary).amountMinor).toBe(5501n);
  // The total still has to be exactly the components.
  value.amountMinor = 5500n;
  expect(() => parseOrdinaryRefundRequest(value)).toThrow("ORDINARY_REFUND_REQUEST_INVALID");
});

it("binds a Cancellation claim to exactly one batch payment", () => {
  const value = cancellationRequestFixture();
  const first = value.payments[0];
  if (!first) throw new Error("FIXTURE_MISSING");
  value.payments.push({
    ...first,
    paymentAttemptReference: id(50),
    items: [{ ...must(first.items[0]), orderItemReference: id(51) }],
  });
  value.amountMinor = 11000n;
  expect(() => parseOrdinaryRefundRequest(value)).toThrow("ORDINARY_REFUND_REQUEST_INVALID");
  const ordinary: Record<string, unknown> = { ...value };
  delete ordinary.claim;
  expect(parseOrdinaryRefundRequest(ordinary).payments).toHaveLength(2);
});

const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
};
function escalationInput(requestReference: string) {
  return {
    ...scope,
    requestReference,
    observedAt: "2026-09-15T04:10:00.000Z",
    businessDate: "2026-09-14",
    manualAllocationOverride: false,
    selectedCaptures: [
      {
        ...scope,
        paymentReference: id(6),
        firstCaptureReference: id(7),
        firstCapturedAt: "2026-09-13T03:50:00.000Z",
        businessDate: "2026-09-12",
      },
    ],
    claims: [
      {
        ...scope,
        requestReference: id(20),
        kind: "Cancellation",
        status: "Requested",
        amountMinor: 50000n,
        currencyCode: "CAD",
        noProviderEffectReference: null,
      },
      {
        ...scope,
        requestReference: id(21),
        kind: "Ordinary",
        status: "Requested",
        amountMinor: 10000n,
        currencyCode: "CAD",
        noProviderEffectReference: null,
      },
    ],
  };
}

it("never escalates a Cancellation claim even above CAD100, after 24h, on another business date", () => {
  const decision = evaluateOrdinaryRefundEscalation(escalationInput(id(20)));
  expect(decision.requiresIndependentApproval).toBe(false);
  expect(decision.reasons).toEqual([]);
  expect(decision.cumulativeOrdinaryAmountMinor).toBe(10000n);
});

it("excludes Cancellation claims from a later Ordinary request's cumulative headroom", () => {
  const input = escalationInput(id(21));
  must(input.selectedCaptures[0]).firstCapturedAt = "2026-09-15T04:00:00.000Z";
  must(input.selectedCaptures[0]).businessDate = "2026-09-14";
  const decision = evaluateOrdinaryRefundEscalation(input);
  expect(decision.cumulativeOrdinaryAmountMinor).toBe(10000n);
  expect(decision.requiresIndependentApproval).toBe(false);
  must(input.claims[1]).amountMinor = 10001n;
  expect(evaluateOrdinaryRefundEscalation(input).reasons).toEqual([
    "OrderOrdinaryTotalAboveCad100",
  ]);
});

it("keeps Ordinary escalation unchanged for the requested Ordinary claim", () => {
  const input = escalationInput(id(21));
  expect(evaluateOrdinaryRefundEscalation(input).reasons).toEqual([
    "DifferentBusinessDate",
    "MoreThan24Hours",
  ]);
  must(input.claims[0]).kind = "Compensation";
  expect(evaluateOrdinaryRefundEscalation(input).cumulativeOrdinaryAmountMinor).toBe(10000n);
  must(input.claims[0]).kind = "Unknown";
  expect(() => evaluateOrdinaryRefundEscalation(input)).toThrow();
});

it("passes each persisted claim's real kind from the escalation source", async () => {
  const at = "2026-09-13T10:00:00.000Z";
  const cancellation = cancellationRequestFixture(at);
  const big = must(must(cancellation.payments[0]).items[0]).components;
  big.netAmountMinor = 49500n;
  cancellation.amountMinor = 50000n;
  const ordinary = {
    ...ordinaryRefundRequestFixture(at),
    requestReference: id(30),
    operationReference: id(31),
    auditReference: id(32),
    expectedClaimVersion: 1,
  };
  must(must(ordinary.payments[0]).items[0]).orderItemReference = id(33);
  const records = [cancellation, ordinary].map((value) => encodeOrdinaryRefundRequest(value));
  const tx = {
    async query(sql: string) {
      if (sql.includes("clock_timestamp")) return { rows: [{ now: "2026-09-13T10:05:00.000Z" }] };
      if (sql.includes("FROM rms_payment.ordinary_refund_request"))
        return {
          rows: records.map((record, index) => ({ version: String(index + 1), record })),
        };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as ConsumerTransaction;
  const source = createPostgresOrdinaryRefundEscalationSource({
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    authorize: async () => true,
    captures: async (_tx, { request }) =>
      request.payments.map((payment) => ({
        paymentAttemptReference: payment.paymentAttemptReference,
        firstCapturedAt: "2026-09-13T09:00:00.000Z",
      })),
    businessDate: async () => "2026-09-13",
  });
  const later = await source(tx, { orderReference: id(4), requestReference: id(30) });
  expect(later.decision.cumulativeOrdinaryAmountMinor).toBe(6000n);
  expect(later.decision.requiresIndependentApproval).toBe(false);
  const own = await source(tx, { orderReference: id(4), requestReference: id(5) });
  expect(own.decision.requiresIndependentApproval).toBe(false);
  expect(own.decision.reasons).toEqual([]);
});

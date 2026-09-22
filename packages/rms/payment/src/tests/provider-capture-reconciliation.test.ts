import { expect, it } from "vitest";
import {
  parseProviderCaptureReconciliationEvidence,
  reviewProviderCaptureOperationBinding,
} from "../application/provider-capture-reconciliation.js";
const ref = (n: number) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
const evidence = {
  brandReference: ref(1),
  storeReference: ref(2),
  providerAccountReference: ref(3),
  environment: "Test",
  providerIntentReference: "pi_test01",
  providerTransactionReference: "ch_test01",
  paymentOperationReference: ref(4),
  paymentAttemptReference: ref(5),
  amount: { amountMinor: 2260n, currencyCode: "CAD" },
  occurredAt: "2026-09-20T03:35:37.236Z",
  observedAt: "2026-09-22T00:00:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
};
const binding = {
  brandReference: evidence.brandReference,
  storeReference: evidence.storeReference,
  providerAccountReference: evidence.providerAccountReference,
  environment: evidence.environment,
  providerIntentReference: evidence.providerIntentReference,
  paymentOperationReference: evidence.paymentOperationReference,
  paymentAttemptReference: evidence.paymentAttemptReference,
  paymentIntentReference: ref(6),
  amount: evidence.amount,
};
it("preserves original capture evidence when no internal operation exists", () => {
  const result = reviewProviderCaptureOperationBinding(evidence, null);
  expect(result.status).toBe("MissingInternalOperation");
  expect(result.paymentIntentReference).toBeNull();
  expect(result.evidence.amount.amountMinor).toBe(2260n);
  expect(result.evidence.occurredAt).toBe(evidence.occurredAt);
});
it("a verified identity link does not fabricate an internal terminal", () => {
  const result = reviewProviderCaptureOperationBinding(evidence, binding);
  expect(result.status).toBe("Linked");
  expect(result.paymentIntentReference).toBe(ref(6));
  expect(result).not.toHaveProperty("paymentTransactionReference");
});
it.each([
  "brandReference",
  "storeReference",
  "providerAccountReference",
  "paymentOperationReference",
  "paymentAttemptReference",
  "providerIntentReference",
  "environment",
])("rejects conflicting %s instead of declaring it missing", (field) => {
  expect(() =>
    reviewProviderCaptureOperationBinding(evidence, {
      ...binding,
      [field]:
        field === "environment"
          ? "Live"
          : field === "providerIntentReference"
            ? "pi_other"
            : ref(9),
    }),
  ).toThrow();
});
it("rejects amount mismatch, floating point, missing digest and reversed chronology", () => {
  expect(() =>
    reviewProviderCaptureOperationBinding(evidence, {
      ...binding,
      amount: { amountMinor: 2261n, currencyCode: "CAD" },
    }),
  ).toThrow();
  for (const value of [
    { ...evidence, amount: { amountMinor: 22.6, currencyCode: "CAD" } },
    { ...evidence, evidenceDigest: null },
    { ...evidence, observedAt: "2026-09-19T00:00:00.000Z" },
    { ...evidence, extra: true },
  ])
    expect(() => parseProviderCaptureReconciliationEvidence(value)).toThrow();
});

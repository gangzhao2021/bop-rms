import { expect, it } from "vitest";
import { evaluateOrdinaryRefundEscalation } from "../application/ordinary-refund-escalation.js";
const id = (n: number) => "01909983-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
};
function fixture() {
  return {
    ...scope,
    requestReference: id(5),
    observedAt: "2026-09-13T04:10:00.000Z",
    businessDate: "2026-09-12",
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
        requestReference: id(5),
        kind: "Ordinary",
        status: "Requested",
        amountMinor: 6000n,
        currencyCode: "CAD",
        noProviderEffectReference: null as string | null,
      },
    ],
  };
}
it("uses Business Date rather than UTC midnight and includes exact CAD100 without escalation", () => {
  const f = fixture();
  firstClaim(f).amountMinor = 10000n;
  expect(evaluateOrdinaryRefundEscalation(f).requiresIndependentApproval).toBe(false);
});
it.each([0, 1])("separates exact24h from24h+%ims", (extra) => {
  const f = fixture();
  firstCapture(f).firstCapturedAt = new Date(
    Date.parse(f.observedAt) - 86400000 - extra,
  ).toISOString();
  expect(evaluateOrdinaryRefundEscalation(f).reasons.includes("MoreThan24Hours")).toBe(extra === 1);
});
it("escalates a changed Business Date even after20 minutes", () => {
  const f = fixture();
  f.businessDate = "2026-09-13";
  expect(evaluateOrdinaryRefundEscalation(f).reasons).toEqual(["DifferentBusinessDate"]);
});
it.each([
  "Requested",
  "Approved",
  "Processing",
  "Pending",
  "Unknown",
  "Confirmed",
  "Rejected",
  "Cancelled",
])("counts %s until durable no-effect release", (status) => {
  const f = fixture();
  f.claims.push({ ...firstClaim(f), requestReference: id(8), status });
  expect(evaluateOrdinaryRefundEscalation(f).cumulativeOrdinaryAmountMinor).toBe(12000n);
  expect(evaluateOrdinaryRefundEscalation(f).requiresIndependentApproval).toBe(true);
});
it("excludes compensation from Manager threshold and releases only proven no-effect claims", () => {
  const f = fixture();
  f.claims.push({ ...firstClaim(f), requestReference: id(8), kind: "Compensation" });
  f.claims.push({
    ...firstClaim(f),
    requestReference: id(9),
    status: "Cancelled",
    noProviderEffectReference: id(10),
  });
  expect(evaluateOrdinaryRefundEscalation(f).cumulativeOrdinaryAmountMinor).toBe(6000n);
  const released = f.claims[2];
  if (!released) throw new Error("fixture");
  released.status = "Unknown";
  expect(() => evaluateOrdinaryRefundEscalation(f)).toThrow();
});
it("rejects foreign-order, duplicate, future-capture and missing target facts", () => {
  const f = fixture();
  firstClaim(f).orderReference = id(99);
  expect(() => evaluateOrdinaryRefundEscalation(f)).toThrow();
  const duplicate = fixture();
  duplicate.claims.push({ ...firstClaim(duplicate) });
  expect(() => evaluateOrdinaryRefundEscalation(duplicate)).toThrow();
  const future = fixture();
  firstCapture(future).firstCapturedAt = "2026-09-14T00:00:00.000Z";
  expect(() => evaluateOrdinaryRefundEscalation(future)).toThrow();
  expect(() =>
    evaluateOrdinaryRefundEscalation({ ...fixture(), requestReference: id(99) }),
  ).toThrow();
});
it("escalates manual allocation override without changing claim amount", () => {
  const f = fixture();
  f.manualAllocationOverride = true;
  expect(evaluateOrdinaryRefundEscalation(f).reasons).toEqual(["ManualAllocationOverride"]);
});

function firstClaim(f: ReturnType<typeof fixture>) {
  const result = f.claims[0];
  if (!result) throw new Error("fixture");
  return result;
}
function firstCapture(f: ReturnType<typeof fixture>) {
  const result = f.selectedCaptures[0];
  if (!result) throw new Error("fixture");
  return result;
}

it("rejects non-CAD claims and invalid calendar dates", () => {
  const f = fixture();
  firstClaim(f).currencyCode = "USD";
  expect(() => evaluateOrdinaryRefundEscalation(f)).toThrow();
  expect(() =>
    evaluateOrdinaryRefundEscalation({ ...fixture(), businessDate: "2026-02-30" }),
  ).toThrow();
});

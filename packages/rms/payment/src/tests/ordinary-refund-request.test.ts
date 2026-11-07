import { expect, it } from "vitest";
import {
  decodeOrdinaryRefundRequest,
  encodeOrdinaryRefundRequest,
  parseOrdinaryRefundRequest,
} from "../application/ordinary-refund-request.js";
import {
  ordinaryRefundRequestFixture,
  refundRequestId as id,
} from "./ordinary-refund-request.fixture.js";
it("round trips immutable component amounts and original unit positions", () => {
  const f = ordinaryRefundRequestFixture();
  expect(decodeOrdinaryRefundRequest(encodeOrdinaryRefundRequest(f))).toEqual(f);
  expect(
    Object.isFrozen(parseOrdinaryRefundRequest(f).payments[0]?.items[0]?.refundUnitOrdinals),
  ).toBe(true);
});
it("records one request across multiple captured payments", () => {
  const f = ordinaryRefundRequestFixture(),
    payment = f.payments[0];
  if (!payment) throw Error("fixture");
  f.payments.push({
    ...payment,
    paymentTransactionReference: id(20),
    paymentIntentReference: id(21),
    paymentAttemptReference: id(22),
    firstCaptureReference: id(23),
    sourceReference: id(24),
    items: payment.items.map((item) => ({ ...item, orderItemReference: id(25) })),
  });
  f.amountMinor *= 2n;
  expect(parseOrdinaryRefundRequest(f).amountMinor).toBe(12000n);
});
it("rejects changed totals, floating money, obsolete versions and duplicate attempts", () => {
  const f = ordinaryRefundRequestFixture();
  for (const input of [
    { ...f, amountMinor: 5999n },
    { ...f, amountMinor: 6000 },
    { ...f, policyVersion: "OLD" },
    { ...f, allocationVersion: "OLD" },
    { ...f, payments: [...f.payments, ...f.payments], amountMinor: 12000n },
  ])
    expect(() => parseOrdinaryRefundRequest(input)).toThrow();
});
it.each([[0], [1, 1], [1000], [1.5]].map((positions) => ({ positions })))(
  "rejects invalid unit positions %j",
  ({ positions }) => {
    const f = ordinaryRefundRequestFixture();
    f.payments = f.payments.map((payment) => ({
      ...payment,
      items: payment.items.map((item) => ({ ...item, refundUnitOrdinals: positions })),
    }));
    expect(() => parseOrdinaryRefundRequest(f)).toThrow();
  },
);
it("canonicalizes order for stable replay and rejects wire numeric amounts", () => {
  const f = ordinaryRefundRequestFixture();
  const item = f.payments[0]?.items[0];
  if (!item) throw Error("fixture");
  item.refundUnitOrdinals = [3, 1];
  const encoded = encodeOrdinaryRefundRequest(f);
  expect(decodeOrdinaryRefundRequest(encoded).payments[0]?.items[0]?.refundUnitOrdinals).toEqual([
    1, 3,
  ]);
  expect(() =>
    decodeOrdinaryRefundRequest(encoded.replace('"amountMinor":"6000"', '"amountMinor":6000')),
  ).toThrow();
});

it("rejects sparse or accessor arrays before durable encoding", () => {
  const f = ordinaryRefundRequestFixture();
  const sparse = new Array<unknown>(2);
  sparse[1] = f.payments[0];
  expect(() => encodeOrdinaryRefundRequest({ ...f, payments: sparse })).toThrow();
  let accessed = false;
  const accessor = new Array<unknown>(1);
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      accessed = true;
      return f.payments[0];
    },
  });
  expect(() => parseOrdinaryRefundRequest({ ...f, payments: accessor })).toThrow();
  expect(accessed).toBe(false);
});

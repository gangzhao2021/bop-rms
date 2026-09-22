import { afterEach, expect, it } from "vitest";
import {
  setCustomerCsrfCredential,
  setPaymentOperationReference,
  getPaymentOperationReference,
  setCheckoutSessionReference,
  getCheckoutSessionReference,
  setCheckoutTipSelection,
  getCheckoutTipSelection,
} from "./customer-transaction-context.js";
afterEach(() => setCustomerCsrfCredential(null));
it("keeps only a validated checkout reference in the current credential context", () => {
  const id = "01909999-0000-7000-8000-000000000001";
  setCustomerCsrfCredential("c".repeat(43));
  setCheckoutSessionReference(id);
  expect(getCheckoutSessionReference()).toBe(id);
  setCustomerCsrfCredential("d".repeat(43));
  expect(getCheckoutSessionReference()).toBeNull();
  expect(() => setCheckoutSessionReference("invalid")).toThrow();
});

it("retains immutable tip identity across payment remounts and clears it on context replacement", () => {
  const session = "01909999-0000-7000-8000-000000000001";
  const selection = "01909999-0000-7000-8000-000000000002";
  setCustomerCsrfCredential("c".repeat(43));
  setCheckoutSessionReference(session);
  const tip = {
    checkoutSessionReference: session,
    selectionReference: selection,
    amountMinor: "123",
  };
  setCheckoutTipSelection(tip);
  tip.amountMinor = "456";
  expect(getCheckoutTipSelection()?.amountMinor).toBe("123");
  expect(getCheckoutTipSelection()?.selectionReference).toBe(selection);
  expect(() => setCheckoutTipSelection(tip)).toThrow();
  setCheckoutSessionReference(session);
  expect(getCheckoutTipSelection()?.amountMinor).toBe("123");
  setCustomerCsrfCredential("d".repeat(43));
  expect(getCheckoutTipSelection()).toBeNull();
  expect(() => setCheckoutTipSelection(tip)).toThrow();
});
it("rejects cross-session selection and invalid money, and clears selection when session changes", () => {
  const session = "01909999-0000-7000-8000-000000000001";
  const other = "01909999-0000-7000-8000-000000000002";
  setCustomerCsrfCredential("c".repeat(43));
  setCheckoutSessionReference(session);
  const tip = { checkoutSessionReference: session, selectionReference: other, amountMinor: "0" };
  for (const amountMinor of ["-1", "1.0", "01", "9223372036854775808"])
    expect(() => setCheckoutTipSelection({ ...tip, amountMinor })).toThrow();
  expect(() => setCheckoutTipSelection({ ...tip, checkoutSessionReference: other })).toThrow();
  setCheckoutTipSelection(tip);
  setCheckoutSessionReference(other);
  expect(getCheckoutTipSelection()).toBeNull();
});

it("clears legacy payment operation on credential replacement and logout", () => {
  setCustomerCsrfCredential("c".repeat(43));
  setPaymentOperationReference("01909999-0000-7000-8000-000000000099");
  expect(getPaymentOperationReference()).not.toBeNull();
  setCustomerCsrfCredential("d".repeat(43));
  expect(getPaymentOperationReference()).toBeNull();
  setCustomerCsrfCredential(null);
  expect(getPaymentOperationReference()).toBeNull();
});

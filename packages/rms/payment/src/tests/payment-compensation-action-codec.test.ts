import { expect, it } from "vitest";
import {
  encodePaymentCompensationAction,
  decodePaymentCompensationAction,
} from "../application/payment-compensation-action-codec.js";
const id = (n: number) => "0190ed10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = "sha256:" + "a".repeat(64);
const receipt = {
  actionReference: id(1),
  compensationCaseReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  paymentTransactionReference: id(5),
  paymentAttemptReference: id(6),
  originalPaymentMethod: "OnlineCard",
  amount: { amountMinor: 9223372036854775807n, currencyCode: "CAD" },
  interacEvidenceReference: null,
  interacEvidenceDigest: null,
  dispositionDigest: digest,
  terminalEvidenceDigest: digest,
  sourceVersion: 1,
  sourceSnapshotDigest: digest,
  providerObservationDigest: digest,
  actionDigest: digest,
  providerIdempotencyKey: "WP1310:" + "a".repeat(64),
  claimedAt: "2026-09-12T12:00:00.000Z",
  claimDisposition: "Claimed",
  phase: "Claimed",
};
it("round-trips the maximum bigint refund amount without floating point", () => {
  const encoded = encodePaymentCompensationAction(receipt);
  expect(encoded).toContain('"amountMinor":"9223372036854775807"');
  expect(decodePaymentCompensationAction(encoded)).toEqual(receipt);
  expect(() =>
    encodePaymentCompensationAction({
      ...receipt,
      amount: { ...receipt.amount, amountMinor: 9223372036854775808n },
    }),
  ).toThrow();
});
it.each(["0", "01", "-1", "1e2", "9223372036854775808", 1, null])(
  "rejects noncanonical or out-of-range money %s",
  (amountMinor) => {
    const raw = JSON.parse(encodePaymentCompensationAction(receipt));
    raw.amount.amountMinor = amountMinor;
    expect(() => decodePaymentCompensationAction(JSON.stringify(raw))).toThrow();
  },
);
it("rejects oversized or extended action payloads", () => {
  expect(() => decodePaymentCompensationAction(" ".repeat(65537))).toThrow();
  expect(() => encodePaymentCompensationAction({ ...receipt, extra: true })).toThrow();
});

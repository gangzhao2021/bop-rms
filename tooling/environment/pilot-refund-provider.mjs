import process from "node:process";
import { randomUUID, createHash } from "node:crypto";
import { createRefundPaymentRequest } from "../../packages/rms/payment/src/index.ts";
import { parseOrdinaryRefundProviderResult } from "../../packages/rms/payment/src/application/ordinary-refund-provider-result.ts";
const hash = (value) =>
  "sha256:" +
  createHash("sha256")
    .update(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)))
    .digest("hex");
/** Internal simulator only. This journal is never evidence of a real Provider refund. */
export function createInternalSimulatedRefunds(db, { rowFor, atomic }) {
  if (process.env.NODE_ENV !== "development") throw new Error("SIMULATION_ONLY");
  db.exec(
    "CREATE TABLE IF NOT EXISTS refund (reference TEXT PRIMARY KEY, intent_reference TEXT NOT NULL REFERENCES intent(reference), idempotency TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, amount TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;",
  );
  const parse = (value) => {
    const request = createRefundPaymentRequest(value);
    if (
      request.context.environment !== "Test" ||
      request.originalPaymentMethod !== "OnlineCard" ||
      request.amount.currencyCode !== "CAD" ||
      request.amount.amountMinor <= 0n ||
      request.amount.amountMinor > 99999999n ||
      !["ordinary-refund:", "compensation-refund:"].some(
        (prefix) => request.idempotencyKey === prefix + request.context.operationReference,
      )
    )
      throw new Error("SIMULATION_REFUND_REQUEST_INVALID");
    rowFor(request);
    return request;
  };
  const total = (reference) =>
    db
      .prepare("SELECT amount FROM refund WHERE intent_reference=?")
      .all(reference)
      .reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const observe = (request, row) => {
    if (
      row.fingerprint !== hash(request) ||
      row.intent_reference !== request.providerIntentReference
    )
      throw new Error("SIMULATION_IDEMPOTENCY_CONFLICT");
    const facts = {
      kind: "RefundObservation",
      context: request.context,
      providerRefundReference: row.reference,
      providerIntentReference: row.intent_reference,
      amount: request.amount,
      status: "succeeded",
      createdAt: row.created_at,
      observedAt: new Date().toISOString(),
      providerRequestDigest: row.fingerprint,
    };
    return parseOrdinaryRefundProviderResult({ ...facts, evidenceDigest: hash(facts) });
  };
  return Object.freeze({
    total,
    async refundPayment(value) {
      const request = parse(value);
      const row = atomic(() => {
        const prior = db
          .prepare("SELECT * FROM refund WHERE idempotency=?")
          .get(request.idempotencyKey);
        if (prior) {
          if (prior.fingerprint !== hash(request))
            throw new Error("SIMULATION_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        const intent = rowFor(request),
          capture = db
            .prepare("SELECT status FROM outcome WHERE reference=?")
            .get(intent.reference);
        if (
          capture?.status !== "Captured" ||
          total(intent.reference) + request.amount.amountMinor > BigInt(intent.amount)
        )
          throw new Error("SIMULATION_REFUND_BALANCE_UNAVAILABLE");
        const reference = "re_DEMO" + randomUUID().replaceAll("-", ""),
          createdAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
        db.prepare("INSERT INTO refund VALUES(?,?,?,?,?,?)").run(
          reference,
          intent.reference,
          request.idempotencyKey,
          hash(request),
          request.amount.amountMinor.toString(),
          createdAt,
        );
        return db.prepare("SELECT * FROM refund WHERE reference=?").get(reference);
      });
      return observe(request, row);
    },
    async lookupRefund(value) {
      const request = parse(value),
        row = db.prepare("SELECT * FROM refund WHERE idempotency=?").get(request.idempotencyKey);
      if (!row) throw new Error("SIMULATION_REFUND_UNKNOWN");
      return observe(request, row);
    },
  });
}

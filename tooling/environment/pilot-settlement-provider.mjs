import process from "node:process";
import { createHash } from "node:crypto";
import {
  parsePaymentInstant,
  parsePaymentReference,
} from "../../packages/rms/payment/src/index.ts";

/** Local simulator journal evidence only; never a real Provider settlement statement. */
export function createInternalSettlementWindowSource(
  db,
  { authorize, now = () => new Date().toISOString() },
) {
  const fail = () => {
    throw Error("SIMULATION_SETTLEMENT_UNAVAILABLE");
  };
  const instant = (value) => {
    const parsed = parsePaymentInstant(value);
    if (new Date(parsed).toISOString() !== parsed) return fail();
    return parsed;
  };
  return async (input) => {
    try {
      if (process.env.NODE_ENV !== "development") return fail();
      const scope = {
        brandReference: String(parsePaymentReference(input.brandReference)),
        storeReference: String(parsePaymentReference(input.storeReference)),
        environment: input.environment,
      };
      const startsAt = instant(input.startsAt),
        endsAt = instant(input.endsAt),
        observedAt = instant(now());
      if (scope.environment !== "Test" || startsAt >= endsAt || endsAt > observedAt) return fail();
      if ((await authorize(scope)) !== true) return fail();
      // A single statement retains one SQLite read snapshot across both journals.
      const rows = db
        .prepare(
          `
        SELECT 'Capture' AS kind, o.transaction_reference AS reference, i.amount AS amount,
               o.occurred_at AS occurred_at
        FROM outcome o JOIN intent i ON i.reference=o.reference
        WHERE i.brand=? AND i.store=? AND o.status='Captured'
        UNION ALL
        SELECT 'Refund' AS kind, r.reference AS reference, r.amount AS amount, r.created_at AS occurred_at
        FROM refund r JOIN intent i ON i.reference=r.intent_reference
        WHERE i.brand=? AND i.store=?
        ORDER BY kind, reference LIMIT 100001
      `,
        )
        .all(
          scope.brandReference,
          scope.storeReference,
          scope.brandReference,
          scope.storeReference,
        );
      if (rows.length > 100000) return fail();
      let capturedAmountMinor = 0n,
        refundedAmountMinor = 0n,
        captureCount = 0,
        refundCount = 0;
      const events = [],
        seen = new Set();
      for (const row of rows) {
        const occurredAt = instant(row.occurred_at);
        if (
          typeof row.amount !== "string" ||
          !/^[1-9][0-9]{0,7}$/u.test(row.amount) ||
          typeof row.reference !== "string" ||
          !/^(ch|re)_[A-Za-z0-9_]+$/u.test(row.reference) ||
          (row.kind === "Capture"
            ? !row.reference.startsWith("ch_")
            : row.kind !== "Refund" || !row.reference.startsWith("re_"))
        )
          return fail();
        const key = row.kind + ":" + row.reference;
        if (seen.has(key)) return fail();
        seen.add(key);
        if (occurredAt < startsAt || occurredAt >= endsAt) continue;
        events.push([row.kind, row.reference, row.amount, occurredAt]);
        if (row.kind === "Capture") {
          capturedAmountMinor += BigInt(row.amount);
          captureCount++;
        } else {
          refundedAmountMinor += BigInt(row.amount);
          refundCount++;
        }
      }
      if ((await authorize(scope)) !== true) return fail();
      const evidenceDigest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify(["BOP_INTERNAL_SETTLEMENT_WINDOW_V1", scope, startsAt, endsAt, events]),
          )
          .digest("hex");
      return Object.freeze({
        source: "InternalTestSimulator",
        ...scope,
        startsAt,
        endsAt,
        observedAt,
        currencyCode: "CAD",
        capturedAmountMinor,
        refundedAmountMinor,
        captureCount,
        refundCount,
        evidenceDigest,
      });
    } catch {
      return fail();
    }
  };
}

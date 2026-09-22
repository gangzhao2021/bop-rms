import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import type { CapturedBatchPaymentScope } from "./captured-batch-payment-source.js";
const fail = (): never => {
  throw new Error("ORDER_PAYMENT_ATTEMPT_POSITION_UNAVAILABLE");
};
const reference = (value: unknown) => String(parsePaymentReference(value));
function instant(value: unknown) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail();
  return String(parsePaymentInstant(value.toISOString()));
}
function amount(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return fail();
  const result = BigInt(value);
  if (result > 9223372036854775807n) return fail();
  return result;
}
/** Complete current Payment attempt inventory, not receivable or financial finality.
 * Existing Order creation fence protects absent intents; each existing Terminal fence
 * protects its outcome. Caller retains all fences until the enclosing commit. */
export function createPostgresOrderPaymentAttemptPosition(options: {
  scope: CapturedBatchPaymentScope;
  authorize(
    tx: ConsumerTransaction,
    query: { orderReference: string; observedAt: string },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: reference(options.scope.brandReference),
    storeReference: reference(options.scope.storeReference),
    providerAccountReference: reference(options.scope.providerAccountReference),
    environment: options.scope.environment,
  });
  if (!["Test", "Live"].includes(scope.environment)) return fail();
  return Object.freeze({
    async load(tx: ConsumerTransaction, input: { orderReference: string; observedAt: string }) {
      try {
        const raw = exactPaymentObject(input, ["orderReference", "observedAt"]),
          query = Object.freeze({
            orderReference: reference(raw.orderReference),
            observedAt: String(parsePaymentInstant(raw.observedAt)),
          });
        if ((await options.authorize(tx, query)) !== true) return fail();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReceiptOrder:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            query.orderReference,
        ]);
        const inventory = await tx.query<{ payment_intent_id: string }>(
          "SELECT payment_intent_id::text FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY payment_intent_id LIMIT 1001",
          [scope.brandReference, scope.storeReference, query.orderReference],
        );
        if (inventory.rows.length > 1000) return fail();
        const intentReferences: string[] = [];
        for (const row of inventory.rows) {
          const intent = reference(row.payment_intent_id),
            prior = intentReferences.at(-1);
          if (prior !== undefined && intent <= prior) return fail();
          intentReferences.push(intent);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentTerminal:" + scope.brandReference + ":" + scope.storeReference + ":" + intent,
          ]);
        }
        const result = await tx.query<Record<string, unknown>>(
          `SELECT i.payment_intent_id::text,i.order_batch_id::text,i.total_minor::text,i.order_allocation_minor::text,i.tip_minor::text,i.currency_code,i.created_at,
        a.payment_attempt_id::text,a.provider_environment,a.created_at AS attempt_created_at,
        f.payment_transaction_id::text,f.terminal_outcome,f.amount_minor::text,f.currency_code AS terminal_currency,
        f.recorded_at,f.provider_account_id::text,f.provider_environment AS terminal_environment,
        (f.order_id=i.order_id AND f.payment_attempt_id=a.payment_attempt_id) AS terminal_bound
        FROM rms_payment.payment_intent i
        LEFT JOIN rms_payment.payment_attempt a ON a.brand_id=i.brand_id AND a.store_id=i.store_id AND a.payment_intent_id=i.payment_intent_id
        LEFT JOIN rms_payment.payment_terminal_fact f ON f.brand_id=i.brand_id AND f.store_id=i.store_id AND f.payment_intent_id=i.payment_intent_id
        WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 ORDER BY i.payment_intent_id LIMIT 1001`,
          [scope.brandReference, scope.storeReference, query.orderReference],
        );
        if (
          result.rows.length !== intentReferences.length ||
          result.rows.some((row, index) => row.payment_intent_id !== intentReferences[index])
        )
          return fail();
        let previous: string | null = null,
          capturedMinor = 0n,
          unresolvedCount = 0,
          failedCount = 0;
        const seen = new Set<string>();
        const attempts = result.rows.map((row) => {
          const intent = reference(row.payment_intent_id),
            attempt = reference(row.payment_attempt_id),
            batch = reference(row.order_batch_id);
          const createdAt = instant(row.created_at),
            attemptAt = instant(row.attempt_created_at);
          if (
            (previous !== null && intent <= previous) ||
            seen.has(attempt) ||
            createdAt > attemptAt ||
            attemptAt > query.observedAt ||
            row.currency_code !== "CAD" ||
            row.provider_environment !== scope.environment
          )
            return fail();
          previous = intent;
          seen.add(attempt);
          const total = amount(row.total_minor);
          const allocation = amount(row.order_allocation_minor);
          if (typeof row.tip_minor !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(row.tip_minor))
            return fail();
          const tip = BigInt(row.tip_minor);
          if (allocation + tip !== total) return fail();
          let outcome: "Succeeded" | "Failed" | "Unresolved",
            terminalReference: string | null = null;
          if (row.payment_transaction_id === null) {
            if (row.terminal_outcome !== null || row.recorded_at !== null) return fail();
            outcome = "Unresolved";
            unresolvedCount++;
          } else {
            terminalReference = reference(row.payment_transaction_id);
            const recordedAt = instant(row.recorded_at);
            if (
              row.terminal_bound !== true ||
              reference(row.provider_account_id) !== scope.providerAccountReference ||
              row.terminal_environment !== scope.environment ||
              recordedAt < attemptAt ||
              recordedAt > query.observedAt
            )
              return fail();
            if (row.terminal_outcome === "Succeeded") {
              if (amount(row.amount_minor) !== total || row.terminal_currency !== "CAD")
                return fail();
              outcome = "Succeeded";
              capturedMinor += total;
            } else if (
              row.terminal_outcome === "Failed" &&
              row.amount_minor === null &&
              row.terminal_currency === null
            ) {
              outcome = "Failed";
              failedCount++;
            } else return fail();
          }
          return Object.freeze({
            paymentIntentReference: intent,
            paymentAttemptReference: attempt,
            orderBatchReference: batch,
            terminalReference,
            outcome,
            totalMinor: total.toString(),
            orderAllocationMinor: allocation.toString(),
            tipMinor: tip.toString(),
          });
        });
        if (capturedMinor > 9223372036854775807n || (await options.authorize(tx, query)) !== true)
          return fail();
        return Object.freeze({
          ...scope,
          ...query,
          attempts: Object.freeze(attempts),
          capturedMinor,
          unresolvedCount,
          failedCount,
          snapshotDigest:
            "sha256:" +
            createHash("sha256")
              .update(JSON.stringify([scope, query.orderReference, attempts]))
              .digest("hex"),
        });
      } catch {
        return fail();
      }
    },
  });
}

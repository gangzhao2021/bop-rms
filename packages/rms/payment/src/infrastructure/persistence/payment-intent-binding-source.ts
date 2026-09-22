import type { ConsumerTransaction } from "@bop/eventing";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
const fail = (): never => {
  throw new Error("PAYMENT_INTENT_BINDING_UNAVAILABLE");
};
interface Scope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly environment: "Test" | "Live";
}
interface Query {
  readonly paymentIntentReference: string;
  readonly observedAt: string;
}
/** Internal routing identity only, not a payment status or refund eligibility assertion.
 * Caller retains current staff/scope authorization through its enclosing transaction. */
export function createPostgresPaymentIntentBindingSource(options: {
  scope: Scope;
  authorize(tx: ConsumerTransaction, query: Scope & Query): Promise<boolean>;
}) {
  const ref = (value: unknown) => String(parsePaymentReference(value));
  const scope = Object.freeze({
    tenantReference: ref(options.scope.tenantReference),
    brandReference: ref(options.scope.brandReference),
    storeReference: ref(options.scope.storeReference),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  return async (tx: ConsumerTransaction, value: Query) => {
    const raw = exactPaymentObject(value, ["paymentIntentReference", "observedAt"]);
    const query = Object.freeze({
      ...scope,
      paymentIntentReference: ref(raw.paymentIntentReference),
      observedAt: parsePaymentInstant(raw.observedAt),
    });
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const found = await tx.query(
      "SELECT payment_operation_id::text AS operation FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3",
      [scope.brandReference, scope.storeReference, query.paymentIntentReference],
    );
    if (found.rows.length !== 1) return fail();
    const operation = ref(found.rows[0]?.operation);
    const owner = createPostgresPaymentIntentCreationStore(
      { run: (work) => work(tx) },
      { brandReference: scope.brandReference, storeReference: scope.storeReference },
      { now: () => query.observedAt, generateObservationReference: fail },
    );
    const record = await owner.resolveOperation(operation);
    if (
      !record ||
      record.intent.paymentOperationReference !== operation ||
      record.intent.paymentIntentReference !== query.paymentIntentReference ||
      record.attempt.paymentIntentReference !== query.paymentIntentReference ||
      record.attempt.providerEnvironment !== scope.environment ||
      String(record.intent.preparation.brandReference) !== scope.brandReference ||
      String(record.intent.preparation.storeReference) !== scope.storeReference ||
      String(record.intent.preparation.committedAt) > String(query.observedAt) ||
      record.intent.createdAt > query.observedAt ||
      record.attempt.createdAt > query.observedAt
    )
      return fail();
    await authorize();
    return Object.freeze({
      paymentIntentReference: query.paymentIntentReference,
      paymentAttemptReference: ref(record.attempt.paymentAttemptReference),
      orderReference: ref(record.intent.preparation.orderReference),
      orderBatchReference: ref(record.intent.preparation.orderBatchReference),
    });
  };
}

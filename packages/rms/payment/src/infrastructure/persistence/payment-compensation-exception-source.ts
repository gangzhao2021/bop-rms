import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPaidWithoutFulfillableExceptionSource,
  parsePaymentCompensationCase,
  PaymentCompensationError,
} from "../../application/paid-without-fulfillable-order.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";

/** Safe owner query for Operations projection; no financial/private evidence fields escape. */
export function createPostgresPaymentCompensationExceptionSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly caseReference: string;
      readonly purpose: "ProjectOrderException";
    },
  ): Promise<boolean>;
}) {
  const brandReference = parsePaymentReference(options.scope.brandReference);
  const storeReference = parsePaymentReference(options.scope.storeReference);
  return async (tx: ConsumerTransaction, value: string) => {
    try {
      const caseReference = parsePaymentReference(value);
      const access = {
        brandReference,
        storeReference,
        caseReference,
        purpose: "ProjectOrderException" as const,
      };
      const authorize = async () => {
        if ((await options.authorize(tx, access)) !== true)
          throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      const result = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 ORDER BY version DESC LIMIT 1",
        [brandReference, storeReference, caseReference],
      );
      if (result.rows.length === 0) {
        await authorize();
        return null;
      }
      const raw = result.rows[0]?.record;
      if (result.rows.length !== 1 || typeof raw !== "string" || raw.length > 65536)
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      const current = parsePaymentCompensationCase(JSON.parse(raw));
      if (
        current.brandReference !== brandReference ||
        current.storeReference !== storeReference ||
        current.caseReference !== caseReference
      )
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      const projection = Object.freeze({
        source: createPaidWithoutFulfillableExceptionSource(current),
        sourceVersion: current.version,
        resolutionEvidenceReference:
          current.state === "Closed" ? current.operationsReceiptReference : null,
      });
      await authorize();
      return projection;
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
    }
  };
}

/** Recovery discovery includes closed cases so a missing final projection can be repaired.
 * Each reference must still be read through the authoritative single-case source.
 */
export function createPostgresPaymentCompensationExceptionCandidates(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose: "DiscoverOrderExceptions";
    },
  ): Promise<boolean>;
}) {
  const brandReference = parsePaymentReference(options.scope.brandReference);
  const storeReference = parsePaymentReference(options.scope.storeReference);
  const access = Object.freeze({
    brandReference,
    storeReference,
    purpose: "DiscoverOrderExceptions" as const,
  });
  return async (
    tx: ConsumerTransaction,
    input: {
      readonly afterCaseReference: string | null;
      readonly limit: number;
    },
  ) => {
    try {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      const after =
        input.afterCaseReference === null ? null : parsePaymentReference(input.afterCaseReference);
      const authorize = async () => {
        if ((await options.authorize(tx, access)) !== true)
          throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      const result = await tx.query(
        "SELECT DISTINCT case_id::text AS case_reference FROM rms_payment.payment_compensation_case_history WHERE brand_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR case_id>$3::uuid) ORDER BY case_reference LIMIT $4",
        [brandReference, storeReference, after, input.limit + 1],
      );
      if (!Array.isArray(result.rows) || result.rows.length > input.limit + 1)
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      let previous = after;
      const references = result.rows.map((row) => {
        const reference = parsePaymentReference(row.case_reference);
        if (previous !== null && reference <= previous)
          throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
        previous = reference;
        return reference;
      });
      const items = Object.freeze(references.slice(0, input.limit));
      await authorize();
      return Object.freeze({
        items,
        nextAfterCaseReference: references.length > input.limit ? (items.at(-1) ?? null) : null,
      });
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
    }
  };
}

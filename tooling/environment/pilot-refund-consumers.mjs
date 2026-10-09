import process from "node:process";
import { createHash } from "node:crypto";
import {
  createPaymentRefundStatusConsumer,
  createPostgresPaymentCompensationExceptionSource,
  createPostgresPaymentRefundStatusStore,
} from "../../packages/rms/payment/src/index.ts";
import { createPostgresOrderExceptionSourceStore } from "../../packages/bop/projection/src/index.ts";
import { createPaymentOrderExceptionConsumer } from "../../apps/api/dist/payment-order-exception-consumer.js";
import { createPaymentOrderExceptionSource } from "../../apps/api/dist/payment-order-exception-source.js";

/**
 * WP-2423: the two catalogued consumers of PaymentRefunded for the pilot Store. Without them the
 * local transport rejected every refund event and dead-lettered it.
 * - payment.status-projection:v1 records the Provider-confirmed refund status.
 * - operations.order-exception:v1 refreshes the Order exception from the owning compensation Case
 *   (the same source the in-process compensation projection writes, so its write is idempotent).
 */
export function createInternalRefundConsumers(resources) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_REFUND_CONSUMERS_ONLY");
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const scope = {
    brandReference: resources.scope.brandReference,
    storeReference: resources.scope.storeReference,
  };
  const inScope = (value) =>
    active() &&
    value.brandReference === scope.brandReference &&
    value.storeReference === scope.storeReference;
  const refundStatus = createPaymentRefundStatusConsumer({
    scope,
    authorize: async (_tx, event) =>
      active() && event.tenantId === scope.brandReference && event.storeId === scope.storeReference,
    projections: createPostgresPaymentRefundStatusStore({
      scope,
      authorize: async (_tx, input) => inScope(input),
    }),
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const tenantReference = resources.publicProfile.binding.tenantReference;
  const owner = createPostgresPaymentCompensationExceptionSource({
    scope,
    authorize: async (_tx, input) => inScope(input) && input.purpose === "ProjectOrderException",
  });
  const exceptions = createPaymentOrderExceptionConsumer({
    source: createPaymentOrderExceptionSource({
      tenantReference,
      ...scope,
      load: owner,
      authorize: async () => active(),
    }),
    projections: createPostgresOrderExceptionSourceStore({
      scope: { tenantReference, ...scope },
      authorize: async () => active(),
      // The projected version must be the owning Case's current one.
      validateSource: async (tx, source) => {
        const current = await owner(tx, source.sourceReference);
        return current !== null && BigInt(current.sourceVersion) === source.sourceVersion;
      },
    }),
  });
  return [
    { registration: refundStatus.registration, consume: refundStatus.consume },
    { registration: exceptions.registration, consume: exceptions.consume },
  ];
}

import process from "node:process";
import { createHash } from "node:crypto";
import {
  createPostgresPickupOrderCompletionLookup,
  createPostgresOrderPaymentOutcomeStore,
} from "../../packages/rms/ordering/src/index.ts";
import { createPostgresCapturedBatchPaymentSource } from "../../packages/rms/payment/src/index.ts";
export function createInternalOrderConfirmation(resources, { providerAccountReference }) {
  const scope = resources.scope,
    active = () =>
      process.env.NODE_ENV === "development" &&
      resources.now() < resources.publicProfile.binding.validUntil;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  return async (transaction, orderReference) => {
    if (!active()) throw new Error("INTERNAL_CONFIRMATION_DENIED");
    const lookup = await createPostgresPickupOrderCompletionLookup({
      ...scope,
      authorize: async () => active(),
    }).loadByOrder({ transaction, orderReference });
    if (!lookup) throw new Error("INTERNAL_CONFIRMATION_UNAVAILABLE");
    const captured = await createPostgresCapturedBatchPaymentSource({
      scope: { ...scope, providerAccountReference: providerAccountReference, environment: "Test" },
      authorize: async () => active(),
    }).load(transaction, {
      orderReference,
      orderBatchReference: lookup.orderBatchReference,
      observedAt: resources.now(),
    });
    if (!captured) throw new Error("INTERNAL_CONFIRMATION_UNAVAILABLE");
    const outcome = await createPostgresOrderPaymentOutcomeStore({
      ...scope,
      sha256: hash,
      audit: async () => {
        throw new Error("READ_ONLY");
      },
    }).loadByPaymentEvent({ transaction, paymentEventReference: captured.paymentEvent.eventId });
    const event = outcome?.orderConfirmedEvent;
    if (
      !event ||
      event.tenantId !== scope.brandReference ||
      event.storeId !== scope.storeReference ||
      event.payload.orderReference !== orderReference ||
      event.payload.orderBatchReference !== lookup.orderBatchReference ||
      !active()
    )
      throw new Error("INTERNAL_CONFIRMATION_UNAVAILABLE");
    return event;
  };
}

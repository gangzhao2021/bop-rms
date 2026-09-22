import { createCustomerOrderStatusRead } from "./customer-order-status-read.js";
import type { CustomerOrderStatusInput } from "./customer-order-status.js";
import {
  createPostgresFulfillmentReadinessStore,
  parseReadinessReference,
  parseFulfillmentReadinessSource,
  createPostgresPickupProofStore,
  type createPickupCredentialProvider,
  PickupProofError,
} from "@rms/fulfillment";

export interface CustomerPickupCodeReadOptions {
  readonly status: Parameters<typeof createCustomerOrderStatusRead>[0];
  readonly readiness: Parameters<typeof createPostgresFulfillmentReadinessStore>[0];
  readonly proof: Parameters<typeof createPostgresPickupProofStore>[0];
  readonly credentials: Pick<ReturnType<typeof createPickupCredentialProvider>, "recoverOpaque">;
  readonly storeDisplayName: string;
  readonly pickupInstruction: string;
}

/** Foreground read only: current Guest ownership and owner history share one transaction. */
export function createCustomerPickupCodeRead(options: CustomerPickupCodeReadOptions) {
  const scope = {
    brandReference: parseReadinessReference(options.status.scope.brandReference),
    storeReference: parseReadinessReference(options.status.scope.storeReference),
  };
  for (const source of [options.readiness, options.proof]) {
    if (
      source.brandReference !== scope.brandReference ||
      source.storeReference !== scope.storeReference
    )
      throw new Error("CUSTOMER_PICKUP_SCOPE_INVALID");
  }
  for (const [text, maximum] of [
    [options.storeDisplayName, 160],
    [options.pickupInstruction, 500],
  ] as const) {
    if (!text || text !== text.normalize("NFC").trim() || text.length > maximum)
      throw new Error("CUSTOMER_PICKUP_PRESENTATION_INVALID");
  }
  const readiness = createPostgresFulfillmentReadinessStore(options.readiness);
  const proof = createPostgresPickupProofStore(options.proof);
  return {
    async read(input: CustomerOrderStatusInput) {
      return options.status.transactions.run(async (transaction) => {
        const status = createCustomerOrderStatusRead({
          ...options.status,
          transactions: { run: (work) => work(transaction) },
        });
        const before = await status.read(input);
        if (before.order.orderType !== "Pickup")
          throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
        const notReady = {
          schemaVersion: 1 as const,
          status: "NotReady" as const,
          orderReference: input.orderReference,
        };
        if (before.order.fulfillmentStatus === "Completed") return notReady;
        const source = await readiness.lockByOrder({
          ...scope,
          transaction,
          orderReference: parseReadinessReference(input.orderReference),
        });
        if (source === null || parseFulfillmentReadinessSource(source).canonicalPhase !== "Ready")
          return notReady;
        const current = await proof.lockByOrder({
          transaction,
          orderReference: input.orderReference,
        });
        if (current.capability === null) return notReady;
        const after = await status.read(input);
        if (
          after.order.orderNumber !== before.order.orderNumber ||
          after.order.fulfillmentStatus === "Completed"
        )
          throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
        const observedAt = options.status.now();
        const proofValue = options.credentials.recoverOpaque({
          brandReference: scope.brandReference,
          capability: current.capability,
          observedAt,
        });
        return {
          schemaVersion: 1 as const,
          status: "Ready" as const,
          orderReference: input.orderReference,
          orderNumber: after.order.orderNumber,
          storeDisplayName: options.storeDisplayName,
          pickupInstruction: options.pickupInstruction,
          generation: current.capability.generation,
          proofKind: "Opaque" as const,
          proofValue,
          observedAt,
          expiresAt: current.capability.expiresAt,
        };
      });
    },
  };
}

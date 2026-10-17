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
import { listStoreCounterOrders } from "@rms/ordering";

/**
 * WP-2423: why a Ready pickup order has no code to show. `CounterOrder`: staff took it at the
 * counter, so none is issued; `CodePending`: the code is being issued (normally seconds);
 * `CodeUnavailable`: its 1-hour window ended or code checks locked after wrong tries. In every
 * case staff hand the order over in person after checking the guest's name or phone number.
 */
export type CustomerPickupWithoutCodeReason = "CounterOrder" | "CodePending" | "CodeUnavailable";

export interface CustomerPickupCodeReadOptions {
  readonly status: Parameters<typeof createCustomerOrderStatusRead>[0];
  readonly readiness: Parameters<typeof createPostgresFulfillmentReadinessStore>[0];
  readonly proof: Parameters<typeof createPostgresPickupProofStore>[0];
  readonly credentials: Pick<
    ReturnType<typeof createPickupCredentialProvider>,
    "recoverOpaque" | "recoverCounterCode"
  >;
  /**
   * Fallback only. WP-2423 DEC-STORE-CUSTOMER-NAME: the panel shows the name from the Store's
   * current published profile (the same read as the order page's store contact) whenever the
   * status read has one; this configured name is used only when no profile is published.
   */
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
        // WP-2423 (v15 2026-10-17): no kitchen ticket yet means the Store has not accepted the
        // order, so nothing is made and nothing can be ready. Fulfillment readiness only exists
        // for a confirmed order (its source check refused this one and the guest saw 503 "can't
        // be shown right now"); the guest is told the code appears once the order is ready.
        if (before.sources.kitchen === null) return notReady;
        const source = await readiness.lockByOrder({
          ...scope,
          transaction,
          orderReference: parseReadinessReference(input.orderReference),
        });
        if (source === null || parseFulfillmentReadinessSource(source).canonicalPhase !== "Ready")
          return notReady;
        const observedAt = options.status.now();
        // WP-2423: a Ready order is never reported as not ready. Without a usable code the guest
        // is told the order is ready and how staff hand it over in person.
        let withoutCode: CustomerPickupWithoutCodeReason | null = null;
        const counterOrders = await listStoreCounterOrders(transaction, scope, [
          input.orderReference,
        ]);
        const current = counterOrders.has(input.orderReference)
          ? null
          : await proof.lockByOrder({ transaction, orderReference: input.orderReference });
        if (current === null) withoutCode = "CounterOrder";
        else if (current.capability === null) withoutCode = "CodePending";
        else if (
          Date.parse(observedAt) >= Date.parse(current.capability.expiresAt) ||
          (await proof.codeChecks({ transaction, orderReference: input.orderReference })).locked
        )
          withoutCode = "CodeUnavailable";
        const after = await status.read(input);
        if (
          after.order.orderNumber !== before.order.orderNumber ||
          after.order.fulfillmentStatus === "Completed"
        )
          throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
        if (withoutCode !== null || current?.capability == null)
          return {
            schemaVersion: 1 as const,
            status: "ReadyWithoutCode" as const,
            orderReference: input.orderReference,
            orderNumber: after.order.orderNumber,
            reason: withoutCode ?? ("CodePending" as const),
          };
        const proofValue = options.credentials.recoverOpaque({
          brandReference: scope.brandReference,
          capability: current.capability,
          observedAt,
        });
        // WP-2423 (DEC-PICKUP-COUNTER-CODE): the six-digit code the guest reads to staff. A proof
        // issued before short codes existed has none; the long code still works then.
        const saved = await proof.currentCounterCode({
          transaction,
          orderReference: input.orderReference,
        });
        const counterCode = saved
          ? options.credentials.recoverCounterCode({
              brandReference: scope.brandReference,
              capability: current.capability,
              counterCode: saved,
              observedAt,
            })
          : null;
        return {
          schemaVersion: 1 as const,
          status: "Ready" as const,
          orderReference: input.orderReference,
          orderNumber: after.order.orderNumber,
          storeDisplayName:
            after.sources.storeContact?.storeDisplayName ?? options.storeDisplayName,
          pickupInstruction: options.pickupInstruction,
          generation: current.capability.generation,
          proofKind: "Opaque" as const,
          proofValue,
          counterCode,
          observedAt,
          expiresAt: current.capability.expiresAt,
        };
      });
    },
  };
}

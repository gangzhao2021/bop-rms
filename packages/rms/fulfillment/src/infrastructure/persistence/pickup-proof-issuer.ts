import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePickupProofReference,
  planPickupProofIssue,
  PickupProofError,
} from "../../contracts/pickup-proof.js";
import { createPostgresPickupProofStore } from "./pickup-proof-store.js";
import type { createPickupCredentialProvider } from "../crypto/pickup-credential-provider.js";
type StoreOptions = Parameters<typeof createPostgresPickupProofStore>[0];
/** Explicit readiness command, never called by a Customer refresh/query. Caller owns transaction. */
export function createPostgresPickupProofIssuer(options: {
  readonly store: StoreOptions;
  readonly credentials: ReturnType<typeof createPickupCredentialProvider>;
  readonly pepperVersion: number;
  readonly nextReference: () => string;
  readonly publicOrderReference: () => string;
}) {
  const store = createPostgresPickupProofStore(options.store);
  return Object.freeze({
    async ensureIssued(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      idempotencyReference: string;
      correlationReference: string;
    }) {
      const orderReference = parsePickupProofReference(input.orderReference),
        idempotencyReference = parsePickupProofReference(input.idempotencyReference),
        correlationReference = parsePickupProofReference(input.correlationReference);
      if (!(await options.store.authorize(input.transaction, { access: "Issue", orderReference })))
        throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
      const current = await store.lockByOrder({ ...input, orderReference });
      const prior = await store.resolveByIdempotency({
        ...input,
        orderReference,
        idempotencyReference,
      });
      if (
        prior &&
        (prior.kind !== "Issue" ||
          prior.effect.operation.correlationReference !== correlationReference ||
          String(prior.effect.generation.capabilityReference) !==
            String(current.capability?.capabilityReference))
      )
        throw new PickupProofError("PICKUP_PROOF_VERSION_CONFLICT");
      if (current.capability) {
        options.credentials.recoverOpaque({
          brandReference: options.store.brandReference,
          capability: current.capability,
          observedAt: options.store.now(),
        });
        if (
          !(await options.store.authorize(input.transaction, { access: "Issue", orderReference }))
        )
          throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
        return Object.freeze({
          status: "AlreadyAvailable" as const,
          capabilityReference: String(current.capability.capabilityReference),
          generation: current.capability.generation,
        });
      }
      const source = current.source,
        capabilityReference = parsePickupProofReference(options.nextReference());
      const selected = {
        brandReference: source.brandReference,
        storeReference: source.storeReference,
        fulfillmentReference: source.fulfillmentReference,
        pepperVersion: options.pepperVersion,
      };
      const credential = options.credentials.deriveOpaque({
        ...selected,
        capabilityReference,
        generation: 1,
      });
      const effect = planPickupProofIssue({
        source,
        previous: null,
        expectedAggregateVersion: source.aggregateVersion,
        candidate: {
          capabilityReference,
          purpose: "PickupHandoff",
          kind: "Opaque",
          storeReference: source.storeReference,
          fulfillmentReference: source.fulfillmentReference,
          publicOrderReference: options.publicOrderReference(),
          selectorHash: options.credentials.hashCredential({
            ...selected,
            purpose: "PickupHandoff",
            kind: "Opaque",
            credential,
          }),
          pepperVersion: options.pepperVersion,
          generation: 1,
          status: "Active",
          version: 1,
          readyAt: source.readyAt,
          expiresAt: new Date(Date.parse(source.readyAt) + 3600000).toISOString(),
          revokedAt: null,
        },
        observedAt: options.store.now(),
        operationReference: options.nextReference(),
        invalidationReference: null,
        idempotencyReference,
        correlationReference,
      });
      const result = await store.issue({ transaction: input.transaction, orderReference, effect });
      if (result.status === "Conflict") throw new PickupProofError("PICKUP_PROOF_VERSION_CONFLICT");
      return Object.freeze({ status: "Issued" as const, capabilityReference, generation: 1 });
    },
  });
}

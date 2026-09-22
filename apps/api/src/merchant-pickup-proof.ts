import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import { Buffer } from "node:buffer";
import {
  createPostgresPickupProofStore,
  parsePickupProofReference,
  validatePickupProof,
  PickupProofError,
  PickupHandoffError,
  completePickupHandoffPermission,
} from "@rms/fulfillment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type StoreOptions = Parameters<typeof createPostgresPickupProofStore>[0];
function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
export function createMerchantPickupProof(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  store: Pick<StoreOptions, "sha256" | "validateCurrentSource">;
  appendAudit(
    transaction: ConsumerTransaction,
    fact: Parameters<StoreOptions["appendAudit"]>[1],
    actorReference: string,
  ): Promise<void>;
  installContext(
    transaction: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
  /** Must commit independently: a rejected proof must not roll back its attempt budget. */
  consumeAttempt(input: {
    actorReference: string;
    brandReference: string;
    storeReference: string;
    orderReference: string;
  }): Promise<boolean>;
  hashCredential(input: {
    purpose: "PickupHandoff";
    kind: "Opaque" | "HumanCode";
    brandReference: string;
    storeReference: string;
    fulfillmentReference: string;
    pepperVersion: number;
    credential: string;
  }): Promise<string>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    let raw: Readonly<Record<string, unknown>>;
    try {
      raw = readClosedRecord(input.command, [
        "orderReference",
        "storeReference",
        "fulfillmentReference",
        "generation",
        "kind",
        "credential",
        "idempotencyReference",
        "correlationReference",
      ]);
    } catch {
      return unavailable();
    }
    const orderReference = parsePickupProofReference(raw.orderReference),
      fulfillmentReference = parsePickupProofReference(raw.fulfillmentReference),
      idempotencyReference = parsePickupProofReference(raw.idempotencyReference),
      correlationReference = parsePickupProofReference(raw.correlationReference);
    if (
      typeof raw.credential !== "string" ||
      !Number.isSafeInteger(raw.generation) ||
      Number(raw.generation) < 1
    )
      return unavailable();
    const credential = raw.credential,
      kind = raw.kind;
    if (kind === "HumanCode") {
      if (!/^[0-9]{6}$/.test(credential)) return unavailable();
    } else if (kind === "Opaque") {
      if (
        !/^[A-Za-z0-9_-]{22}$/.test(credential) ||
        Buffer.from(credential, "base64url").toString("base64url") !== credential
      )
        return unavailable();
    } else return unavailable();
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        completePickupHandoffPermission,
        session.sessionReference,
      );
      if (raw.storeReference !== scope.store.storeReference || !(await scope.allowed()))
        throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object") return unavailable();
          const rows = Object.getOwnPropertyDescriptor(result, "rows"),
            count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
          )
            return unavailable();
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      const selected = {
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
      };
      if (
        !(await options.consumeAttempt({
          ...selected,
          actorReference: scope.actorReference,
          orderReference,
        }))
      )
        return unavailable();
      await options.installContext(tx, selected);
      const store = createPostgresPickupProofStore({
        ...options.store,
        ...selected,
        now: options.persistence.now,
        appendAudit: (transaction, fact) =>
          options.appendAudit(transaction, fact, scope.actorReference),
        authorize: async (_tx, access) =>
          access.access !== "Issue" &&
          access.orderReference === orderReference &&
          (await scope.allowed()),
      });
      const current = await store.lockByOrder({ transaction: tx, orderReference });
      if (
        !current.capability ||
        current.source.fulfillmentReference !== fulfillmentReference ||
        current.capability.kind !== kind
      )
        return unavailable();
      const selectorHash = await options.hashCredential({
        ...selected,
        purpose: "PickupHandoff",
        kind,
        fulfillmentReference,
        pepperVersion: current.capability.pepperVersion,
        credential,
      });
      const prior = await store.resolveByIdempotency({
        transaction: tx,
        orderReference,
        idempotencyReference,
      });
      if (prior && prior.kind !== "Verify")
        throw new PickupProofError("PICKUP_PROOF_VERSION_CONFLICT");
      const record = validatePickupProof({
        source: current.source,
        capability: current.capability,
        selectorHash,
        generation: raw.generation,
        expectedCapabilityVersion: 1,
        observedAt: options.persistence.now(),
        verificationReference: prior?.record.verificationReference ?? options.nextReference(),
        operationReference: prior?.record.operationReference ?? options.nextReference(),
        idempotencyReference,
        correlationReference,
      });
      const result = await store.verify({
        transaction: tx,
        orderReference,
        selectorHash,
        record: prior ? { ...record, verifiedAt: prior.record.verifiedAt } : record,
      });
      if (result.status === "Conflict") throw new PickupProofError("PICKUP_PROOF_VERSION_CONFLICT");
      return Object.freeze({
        status: result.status,
        verificationReference: result.record.verificationReference,
        fulfillmentReference: result.record.fulfillmentReference,
        expectedAggregateVersion: current.source.aggregateVersion.toString(),
        generation: result.record.generation,
        grantsCompletionAuthority: false as const,
      });
    });
  };
}

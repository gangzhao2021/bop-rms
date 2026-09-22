import type { ConsumerTransaction } from "@bop/eventing";
import { parseReadinessReference } from "../../contracts/fulfillment-readiness.js";
import {
  parsePickupProofReference,
  parsePickupProofIssueEffect,
  parsePickupProofVerificationRecord,
  planPickupProofIssue,
  validatePickupProof,
  PickupProofError,
  type PickupProofIssueEffect,
  type PickupProofVerificationRecord,
} from "../../contracts/pickup-proof.js";
import {
  encodePickupProofIssueRecord,
  encodePickupProofVerificationRecord,
} from "../../application/pickup-proof-record.js";
import { pickupProofCapabilityFromGeneration } from "../../application/pickup-proof-history.js";
import { createPostgresFulfillmentReadinessStore } from "./fulfillment-readiness-store.js";
import { readPickupProofHistory } from "./pickup-proof-history.js";

function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
type ProofFact =
  | { readonly kind: "Issue"; readonly effect: PickupProofIssueEffect }
  | { readonly kind: "Verify"; readonly record: PickupProofVerificationRecord };
interface Query {
  readonly transaction: ConsumerTransaction;
  readonly orderReference: string;
  readonly idempotencyReference: string;
}
interface AuditFact {
  readonly kind: "Issue" | "Regenerate" | "Verify";
  readonly fulfillmentReference: string;
  readonly operationReference: string;
  readonly correlationReference: string;
  readonly occurredAt: string;
}
/** Caller owns tenant context and transaction; authorization and Audit hooks are mandatory. */
export function createPostgresPickupProofStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sha256: (value: string) => string;
  readonly now: () => string;
  readonly authorize: (
    tx: ConsumerTransaction,
    access: {
      readonly access: "Current" | "Recover" | "Issue" | "Verify";
      readonly orderReference: string;
    },
  ) => Promise<boolean>;
  readonly validateCurrentSource: (
    tx: ConsumerTransaction,
    orderReference: string,
  ) => Promise<boolean>;
  readonly appendAudit: (tx: ConsumerTransaction, fact: AuditFact) => Promise<void>;
}) {
  const brand = parsePickupProofReference(options.brandReference),
    store = parsePickupProofReference(options.storeReference);
  const readiness = createPostgresFulfillmentReadinessStore({
    brandReference: brand,
    storeReference: store,
    sha256: options.sha256,
    now: options.now,
    authorize: (tx, access) =>
      access.access === "Current"
        ? options.authorize(tx, { access: "Current", orderReference: access.orderReference })
        : Promise.resolve(false),
    validateCurrentSource: options.validateCurrentSource,
  });
  async function authorize(
    tx: ConsumerTransaction,
    order: string,
    access: "Current" | "Recover" | "Issue" | "Verify",
  ) {
    parsePickupProofReference(order);
    if ((await options.authorize(tx, { access, orderReference: order })) !== true)
      return unavailable();
  }
  async function recover(input: Query): Promise<ProofFact | null> {
    const key = parsePickupProofReference(input.idempotencyReference);
    const rows = (
      await input.transaction.query(
        "SELECT o.fulfillment_id,f.order_id FROM rms_fulfillment.pickup_proof_operation o " +
          "JOIN rms_fulfillment.fulfillment f ON f.brand_id=o.brand_id AND f.store_id=o.store_id AND f.fulfillment_id=o.fulfillment_id " +
          "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.idempotency_id=$3",
        [brand, store, key],
      )
    ).rows;
    if (rows.length === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.order_id !== input.orderReference) return unavailable();
    const fulfillment = parsePickupProofReference(row.fulfillment_id);
    const history = await readPickupProofHistory(input.transaction, brand, store, fulfillment);
    const effect = history.issues.find((e) => e.operation.idempotencyReference === key);
    if (effect) return { kind: "Issue", effect };
    const record = history.verifications.find((e) => e.idempotencyReference === key);
    if (record) return { kind: "Verify", record };
    return unavailable();
  }
  async function current(tx: ConsumerTransaction, order: string) {
    const proof = await readiness.lockPickupProofByOrder({
      brandReference: parseReadinessReference(brand),
      storeReference: parseReadinessReference(store),
      orderReference: parseReadinessReference(order),
      transaction: tx,
    });
    if (!proof) return unavailable();
    return proof;
  }
  async function insert(
    tx: ConsumerTransaction,
    table:
      | "pickup_proof_generation"
      | "pickup_proof_invalidation"
      | "pickup_proof_operation"
      | "pickup_proof_verification",
    row: Readonly<Record<string, unknown>>,
  ) {
    const columns = Object.keys(row);
    await tx.query(
      "INSERT INTO rms_fulfillment." +
        table +
        " (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_, i) => "$" + (i + 1)).join(",") +
        ")",
      columns.map((key) => row[key]),
    );
  }
  function scope(fact: { brandReference: string; storeReference: string }) {
    if (fact.brandReference !== brand || fact.storeReference !== store) return unavailable();
  }
  async function write(tx: ConsumerTransaction, fact: ProofFact) {
    await tx.query("SAVEPOINT pickup_proof_write", []);
    try {
      const common = {
        brand_id: brand,
        store_id: store,
        data_classification: "IndirectIdentifier",
      };
      if (fact.kind === "Issue") {
        const { generation: g, invalidation: i, operation: o } = fact.effect;
        await insert(tx, "pickup_proof_generation", {
          ...common,
          capability_id: g.capabilityReference,
          fulfillment_id: g.fulfillmentReference,
          proof_kind: g.kind,
          public_order_reference: g.publicOrderReference,
          selector_hash: g.selectorHash,
          pepper_version: g.pepperVersion,
          generation: g.generation,
          ready_at: g.readyAt,
          expires_at: g.expiresAt,
          issued_at: g.issuedAt,
          data_classification: "RestrictedCredential",
        });
        if (i)
          await insert(tx, "pickup_proof_invalidation", {
            ...common,
            pickup_proof_invalidation_id: i.invalidationReference,
            fulfillment_id: i.fulfillmentReference,
            prior_capability_id: i.priorCapabilityReference,
            replacement_capability_id: i.replacementCapabilityReference,
            prior_generation: i.priorGeneration,
            replacement_generation: i.replacementGeneration,
            invalidated_at: i.invalidatedAt,
            reason: i.reason,
          });
        await insert(tx, "pickup_proof_operation", {
          ...common,
          pickup_proof_operation_id: o.operationReference,
          fulfillment_id: o.fulfillmentReference,
          capability_id: o.capabilityReference,
          verification_id: null,
          idempotency_id: o.idempotencyReference,
          correlation_id: o.correlationReference,
          operation_kind: o.operationKind,
          generation: o.generation,
          aggregate_version_before: String(o.aggregateVersionBefore),
          aggregate_version_after: String(o.aggregateVersionAfter),
          occurred_at: o.occurredAt,
        });
        await options.appendAudit(tx, {
          kind: o.operationKind,
          fulfillmentReference: o.fulfillmentReference,
          operationReference: o.operationReference,
          correlationReference: o.correlationReference,
          occurredAt: o.occurredAt,
        });
      } else {
        const v = fact.record;
        await insert(tx, "pickup_proof_verification", {
          ...common,
          pickup_proof_verification_id: v.verificationReference,
          fulfillment_id: v.fulfillmentReference,
          capability_id: v.capabilityReference,
          generation: v.generation,
          verification_method: v.verificationMethod,
          validation_status: v.validationStatus,
          verified_at: v.verifiedAt,
          correlation_id: v.correlationReference,
        });
        await insert(tx, "pickup_proof_operation", {
          ...common,
          pickup_proof_operation_id: v.operationReference,
          fulfillment_id: v.fulfillmentReference,
          capability_id: v.capabilityReference,
          verification_id: v.verificationReference,
          idempotency_id: v.idempotencyReference,
          correlation_id: v.correlationReference,
          operation_kind: "Verify",
          generation: v.generation,
          aggregate_version_before: null,
          aggregate_version_after: null,
          occurred_at: v.verifiedAt,
        });
        await options.appendAudit(tx, {
          kind: "Verify",
          fulfillmentReference: v.fulfillmentReference,
          operationReference: v.operationReference,
          correlationReference: v.correlationReference,
          occurredAt: v.verifiedAt,
        });
      }
      await tx.query("RELEASE SAVEPOINT pickup_proof_write", []);
    } catch {
      try {
        await tx.query("ROLLBACK TO SAVEPOINT pickup_proof_write", []);
        await tx.query("RELEASE SAVEPOINT pickup_proof_write", []);
      } catch {
        /* Caller must roll back a failed transaction. */
      }
      return unavailable();
    }
  }
  return {
    async lockByOrder(input: { transaction: ConsumerTransaction; orderReference: string }) {
      await authorize(input.transaction, input.orderReference, "Current");
      return current(input.transaction, input.orderReference);
    },
    async resolveByIdempotency(input: Query) {
      await authorize(input.transaction, input.orderReference, "Recover");
      return recover(input);
    },
    async issue(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      effect: unknown;
    }) {
      const effect = parsePickupProofIssueEffect(input.effect),
        tx = input.transaction;
      scope(effect.operation);
      await authorize(tx, input.orderReference, "Issue");
      const query = { ...input, idempotencyReference: effect.operation.idempotencyReference };
      function recovered(prior: ProofFact) {
        return prior.kind === "Issue" &&
          encodePickupProofIssueRecord(prior.effect) === encodePickupProofIssueRecord(effect)
          ? { status: "AlreadyApplied" as const, effect: prior.effect }
          : { status: "Conflict" as const };
      }
      let prior = await recover(query);
      if (prior) return recovered(prior);
      const {
        source,
        capability: previous,
        lastIssuedAt,
      } = await current(tx, input.orderReference);
      prior = await recover(query);
      if (prior) return recovered(prior);
      if (
        source.lockedAt >= effect.generation.expiresAt ||
        effect.generation.issuedAt > source.lockedAt ||
        effect.generation.issuedAt < lastIssuedAt
      )
        return unavailable();
      const planned = planPickupProofIssue({
        source,
        candidate: pickupProofCapabilityFromGeneration(effect.generation),
        previous,
        expectedAggregateVersion: effect.operation.aggregateVersionBefore,
        observedAt: effect.generation.issuedAt,
        operationReference: effect.operation.operationReference,
        invalidationReference: effect.invalidation?.invalidationReference ?? null,
        idempotencyReference: effect.operation.idempotencyReference,
        correlationReference: effect.operation.correlationReference,
      });
      if (encodePickupProofIssueRecord(planned) !== encodePickupProofIssueRecord(effect))
        return unavailable();
      await write(tx, { kind: "Issue", effect });
      return { status: "Applied" as const, effect };
    },
    async verify(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      record: unknown;
      selectorHash: unknown;
    }) {
      const record = parsePickupProofVerificationRecord(input.record),
        tx = input.transaction;
      scope(record);
      await authorize(tx, input.orderReference, "Verify");
      const query = { ...input, idempotencyReference: record.idempotencyReference };
      async function recovered(prior: ProofFact) {
        if (
          prior.kind !== "Verify" ||
          encodePickupProofVerificationRecord(prior.record) !==
            encodePickupProofVerificationRecord(record)
        )
          return { status: "Conflict" as const };
        const history = await readPickupProofHistory(tx, brand, store, record.fulfillmentReference);
        const generation = history.issues.find(
          (e) => e.generation.capabilityReference === record.capabilityReference,
        )?.generation;
        if (!generation || input.selectorHash !== generation.selectorHash) return unavailable();
        return { status: "AlreadyApplied" as const, record: prior.record };
      }
      let prior = await recover(query);
      if (prior) return recovered(prior);
      const { source, capability, lastIssuedAt } = await current(tx, input.orderReference);
      prior = await recover(query);
      if (prior) return recovered(prior);
      if (
        !capability ||
        String(source.lockedAt) >= String(capability.expiresAt) ||
        record.verifiedAt > source.lockedAt ||
        record.verifiedAt < lastIssuedAt
      )
        return unavailable();
      const planned = validatePickupProof({
        source,
        capability,
        selectorHash: input.selectorHash,
        generation: record.generation,
        expectedCapabilityVersion: 1,
        observedAt: record.verifiedAt,
        verificationReference: record.verificationReference,
        operationReference: record.operationReference,
        idempotencyReference: record.idempotencyReference,
        correlationReference: record.correlationReference,
      });
      if (
        encodePickupProofVerificationRecord(planned) !== encodePickupProofVerificationRecord(record)
      )
        return unavailable();
      await write(tx, { kind: "Verify", record });
      return { status: "Applied" as const, record };
    },
  };
}

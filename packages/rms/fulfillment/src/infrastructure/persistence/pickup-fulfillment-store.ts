import type { ConsumerTransaction } from "@bop/eventing";
import type { PickupFulfillmentPorts } from "../../application/ports/pickup-fulfillment-ports.js";
import {
  decodePickupFulfillmentRecord,
  encodePickupFulfillmentRecord,
  validatePickupFulfillmentRecordEffect,
} from "../../application/pickup-fulfillment-record.js";
import {
  parseFulfillmentReference,
  PickupFulfillmentError,
  type PickupFulfillmentCreationEffect,
} from "../../contracts/pickup-fulfillment.js";

function unavailable(): never {
  throw new PickupFulfillmentError("PICKUP_FULFILLMENT_DEPENDENCY_UNAVAILABLE");
}

/** Caller installs tenant context and owns mandatory Audit/Inbox plus rollback on any failure. */
export function createPostgresPickupFulfillmentStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sha256: (value: string) => string;
  readonly authorize: (tx: ConsumerTransaction, orderReference: string) => Promise<boolean>;
  /** Acquire current Ordering fences before the Fulfillment fence; never grant authority here. */
  readonly validateCurrentSource: (
    tx: ConsumerTransaction,
    effect: PickupFulfillmentCreationEffect,
  ) => Promise<boolean>;
}): PickupFulfillmentPorts["repository"] {
  const brand = parseFulfillmentReference(options.brandReference);
  const store = parseFulfillmentReference(options.storeReference);
  async function authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
    },
  ) {
    if (input.brandReference !== brand || input.storeReference !== store) return unavailable();
    const order = parseFulfillmentReference(input.orderReference);
    if ((await options.authorize(tx, order)) !== true) return unavailable();
    return order;
  }
  async function read(tx: ConsumerTransaction, order: string) {
    const result = await tx.query(
      "SELECT f.fulfillment_id,f.confirmation_id,f.source_event_id,o.fulfillment_creation_operation_id," +
        "o.semantic_binding_digest,o.creation_record_json::text AS record " +
        "FROM rms_fulfillment.fulfillment f LEFT JOIN rms_fulfillment.fulfillment_creation_operation o " +
        "ON o.brand_id=f.brand_id AND o.store_id=f.store_id AND o.fulfillment_id=f.fulfillment_id " +
        "WHERE f.brand_id=$1 AND f.store_id=$2 AND f.order_id=$3",
      [brand, store, order],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) return unavailable();
    const effect = decodePickupFulfillmentRecord(row.record, options.sha256);
    const a = effect.aggregate;
    if (
      a.brandReference !== brand ||
      a.storeReference !== store ||
      a.orderReference !== order ||
      a.fulfillmentReference !== row.fulfillment_id ||
      a.confirmationReference !== row.confirmation_id ||
      a.sourceEventReference !== row.source_event_id ||
      effect.operation.operationReference !== row.fulfillment_creation_operation_id ||
      effect.operation.semanticBindingDigest !== row.semantic_binding_digest
    )
      return unavailable();
    return effect;
  }
  async function insert(
    tx: ConsumerTransaction,
    table: "fulfillment" | "fulfillment_item" | "fulfillment_creation_operation",
    row: Readonly<Record<string, unknown>>,
  ) {
    const columns = Object.keys(row);
    await tx.query(
      "INSERT INTO rms_fulfillment." +
        table +
        " (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_, index) => "$" + (index + 1)).join(",") +
        ")",
      columns.map((key) => row[key]),
    );
  }
  return {
    async resolveByOrder(input) {
      const order = await authorize(input.transaction, input);
      const effect = await read(input.transaction, order);
      return effect ? { status: "Resolved", effect } : { status: "NotFound" };
    },
    async create(input) {
      const effect = validatePickupFulfillmentRecordEffect(input.effect, options.sha256);
      const record = encodePickupFulfillmentRecord(effect, options.sha256);
      const a = effect.aggregate;
      const tx = input.transaction;
      const order = await authorize(tx, a);
      let prior = await read(tx, order);
      if (!prior) {
        if ((await options.validateCurrentSource(tx, effect)) !== true) return unavailable();
        // All competing identities use sorted owner fences, including another Order reusing an event.
        const keys = [
          "order:" + order,
          "confirmation:" + a.confirmationReference,
          "event:" + a.sourceEventReference,
        ].sort();
        for (const key of keys)
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "fulfillment:" + brand + ":" + store + ":" + key,
          ]);
        prior = await read(tx, order);
      }
      if (prior)
        return prior.operation.semanticBindingDigest === effect.operation.semanticBindingDigest
          ? { status: "AlreadyCreated", effect: prior }
          : { status: "Conflict" };
      const collisions = await tx.query(
        "SELECT fulfillment_id FROM rms_fulfillment.fulfillment WHERE brand_id=$1 AND store_id=$2 " +
          "AND (confirmation_id=$3 OR source_event_id=$4)",
        [brand, store, a.confirmationReference, a.sourceEventReference],
      );
      if (collisions.rows.length !== 0) return { status: "Conflict" };
      await tx.query("SAVEPOINT pickup_fulfillment_create", []);
      try {
        await insert(tx, "fulfillment", {
          fulfillment_id: a.fulfillmentReference,
          brand_id: brand,
          store_id: store,
          order_id: a.orderReference,
          order_batch_id: a.orderBatchReference,
          confirmation_id: a.confirmationReference,
          source_event_id: a.sourceEventReference,
          source_aggregate_version: a.sourceAggregateVersion.toString(),
          source_snapshot_digest: a.sourceSnapshotDigest,
          source_evidence_id: a.sourceEvidenceReference,
          source_evidence_version: a.sourceEvidenceVersion,
          source_evidence_digest: a.sourceEvidenceDigest,
          fulfillment_type: a.fulfillmentType,
          canonical_phase: a.canonicalPhase,
          aggregate_version: a.aggregateVersion,
          created_at: a.createdAt,
          correlation_id: a.correlationReference,
          data_classification: "IndirectIdentifier",
        });
        for (const item of a.items)
          await insert(tx, "fulfillment_item", {
            fulfillment_item_id: item.fulfillmentItemReference,
            brand_id: brand,
            store_id: store,
            fulfillment_id: a.fulfillmentReference,
            order_item_id: item.orderItemReference,
            ordinal: item.ordinal,
            ordered_quantity: item.orderedQuantity,
            ready_quantity: item.readyQuantity,
            handed_over_quantity: item.handedOverQuantity,
            item_state: item.state,
            source_line_digest: item.sourceLineDigest,
            data_classification: "IndirectIdentifier",
          });
        const o = effect.operation;
        await insert(tx, "fulfillment_creation_operation", {
          fulfillment_creation_operation_id: o.operationReference,
          brand_id: brand,
          store_id: store,
          fulfillment_id: o.fulfillmentReference,
          source_event_id: o.sourceEventReference,
          confirmation_id: o.confirmationReference,
          order_id: o.orderReference,
          source_evidence_digest: o.sourceEvidenceDigest,
          semantic_binding_digest: o.semanticBindingDigest,
          occurred_at: o.occurredAt,
          data_classification: "IndirectIdentifier",
          creation_record_json: record,
        });
        await tx.query("RELEASE SAVEPOINT pickup_fulfillment_create", []);
        return { status: "Created", effect };
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT pickup_fulfillment_create", []);
        await tx.query("RELEASE SAVEPOINT pickup_fulfillment_create", []);
        return unavailable();
      }
    },
  };
}

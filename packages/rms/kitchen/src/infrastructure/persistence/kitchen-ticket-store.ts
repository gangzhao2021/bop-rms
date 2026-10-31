import { appendAuditRecordInTransaction } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import {
  kitchenCreationEffectsMatchSemantic,
  parseKitchenTicketCreationEffect,
} from "../../application/kitchen-ticket-creation.js";
import {
  decodeKitchenTicketCreationRecord,
  encodeKitchenTicketCreationRecord,
} from "../../application/kitchen-ticket-creation-record.js";
import type {
  KitchenTicketCreationEffect,
  KitchenTicketCreationPorts,
  KitchenTicketEffectValidationPorts,
  KitchenTicketSemanticIdentity,
} from "../../application/ports/kitchen-ticket-ports.js";
import { KitchenTicketCreationError } from "../../contracts/kitchen-ticket.js";
import { parseKitchenTicketReference } from "../../domain/kitchen-ticket.js";

type Identity = Omit<KitchenTicketSemanticIdentity, "transaction">;
type Resolution =
  | { readonly status: "NotFound" }
  | { readonly status: "Conflict" }
  | { readonly status: "Resolved"; readonly effect: KitchenTicketCreationEffect };

function unavailable(): never {
  throw new KitchenTicketCreationError("KITCHEN_TICKET_DEPENDENCY_UNAVAILABLE");
}

/**
 * Uses the caller's ConsumerTransaction. No connection, COMMIT or private foreign SQL.
 * Current owner fences must be acquired by validateCurrentSource before Kitchen fences.
 */
export function createPostgresKitchenTicketStore(
  options: KitchenTicketEffectValidationPorts & {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly authorize: (
      transaction: ConsumerTransaction,
      input: Identity & {
        readonly actorType: "System";
        readonly purposeCode: "CREATE_KITCHEN_TICKET";
      },
    ) => Promise<boolean>;
    readonly validateCurrentSource: (
      transaction: ConsumerTransaction,
      effect: KitchenTicketCreationEffect,
    ) => Promise<boolean>;
  },
): KitchenTicketCreationPorts["repository"] {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);

  function identity(input: Identity): Identity {
    const result = {
      brandReference: parseKitchenTicketReference(input.brandReference),
      storeReference: parseKitchenTicketReference(input.storeReference),
      sourceEventReference: parseKitchenTicketReference(input.sourceEventReference),
      confirmationReference: parseKitchenTicketReference(input.confirmationReference),
      orderBatchReference: parseKitchenTicketReference(input.orderBatchReference),
    };
    if (result.brandReference !== brand || result.storeReference !== store) return unavailable();
    return Object.freeze(result);
  }

  async function authorize(tx: ConsumerTransaction, key: Identity) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    if (
      (await options.authorize(tx, {
        ...key,
        actorType: "System",
        purposeCode: "CREATE_KITCHEN_TICKET",
      })) !== true
    )
      return unavailable();
  }

  async function read(tx: ConsumerTransaction, key: Identity): Promise<Resolution> {
    const { rows } = await tx.query(
      "SELECT t.kitchen_ticket_id,t.confirmation_id,t.order_batch_id,t.source_event_id," +
        "r.creation_record_json::text AS record,r.effect_digest FROM rms_kitchen.kitchen_ticket t " +
        "LEFT JOIN rms_kitchen.kitchen_creation_record r ON r.brand_id=t.brand_id " +
        "AND r.store_id=t.store_id AND r.kitchen_ticket_id=t.kitchen_ticket_id " +
        "WHERE t.brand_id=$1 AND t.store_id=$2 AND " +
        "(t.source_event_id=$3 OR t.confirmation_id=$4 OR t.order_batch_id=$5) LIMIT 3",
      [brand, store, key.sourceEventReference, key.confirmationReference, key.orderBatchReference],
    );
    if (rows.length === 0) return { status: "NotFound" };
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.record === null ||
      row.confirmation_id !== key.confirmationReference ||
      row.order_batch_id !== key.orderBatchReference
    )
      return { status: "Conflict" };
    const effect = decodeKitchenTicketCreationRecord(row.record, options);
    if (
      effect.ticket.brandReference !== brand ||
      effect.ticket.storeReference !== store ||
      effect.ticket.ticketReference !== row.kitchen_ticket_id ||
      effect.ticket.sourceEventReference !== row.source_event_id ||
      effect.ticket.confirmationReference !== row.confirmation_id ||
      effect.ticket.orderBatchReference !== row.order_batch_id ||
      effect.effectDigest !== row.effect_digest
    )
      return unavailable();
    return { status: "Resolved", effect };
  }

  async function fence(tx: ConsumerTransaction, key: Identity) {
    const keys = [
      "Batch:" + key.orderBatchReference,
      "Confirmation:" + key.confirmationReference,
      "Event:" + key.sourceEventReference,
    ].sort();
    for (const part of keys)
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "KitchenTicket:" + brand + ":" + store + ":" + part,
      ]);
  }

  async function insert(
    tx: ConsumerTransaction,
    table:
      "kitchen_ticket" | "kitchen_work_item" | "kitchen_action_record" | "kitchen_creation_record",
    row: Readonly<Record<string, unknown>>,
  ) {
    const entries = Object.entries(row);
    const result = await tx.query(
      "INSERT INTO rms_kitchen." +
        table +
        " (" +
        entries.map(([key]) => key).join(",") +
        ") VALUES (" +
        entries.map((_entry, i) => "$" + (i + 1)).join(",") +
        ")",
      entries.map(([, value]) => (typeof value === "bigint" ? value.toString() : value)),
    );
    if (result.rowCount !== 1) return unavailable();
  }

  async function persist(tx: ConsumerTransaction, effect: KitchenTicketCreationEffect) {
    const { ticket: t, action: a } = effect;
    const actorAndTime = {
      created_by_actor_type: "System",
      created_by_actor_id: null,
      updated_by_actor_type: "System",
      updated_by_actor_id: null,
      created_at: t.createdAt,
      updated_at: t.createdAt,
    };
    await insert(tx, "kitchen_ticket", {
      brand_id: brand,
      store_id: store,
      kitchen_ticket_id: t.ticketReference,
      order_id: t.orderReference,
      order_batch_id: t.orderBatchReference,
      confirmation_id: t.confirmationReference,
      consumer_name: t.consumerName,
      consumer_version: t.consumerVersion,
      source_event_id: t.sourceEventReference,
      source_aggregate_version: t.sourceAggregateVersion,
      source_snapshot_digest: t.sourceSnapshotDigest,
      confirmed_at: t.confirmedAt,
      correlation_id: t.correlationReference,
      semantic_event_binding_digest: t.semanticEventBindingDigest,
      source_evidence_id: t.sourceEvidenceReference,
      source_evidence_version: t.sourceEvidenceVersion,
      source_evidence_digest: t.sourceEvidenceDigest,
      source_evidence_captured_at: t.sourceEvidenceCapturedAt,
      work_plan_id: t.planReference,
      work_plan_version: t.planVersion,
      work_plan_digest: t.planDigest,
      work_plan_generated_at: t.planGeneratedAt,
      aggregate_version: t.aggregateVersion,
      status: t.status,
      ...actorAndTime,
    });
    for (const item of t.workItems)
      await insert(tx, "kitchen_work_item", {
        brand_id: brand,
        store_id: store,
        kitchen_work_item_id: item.workItemReference,
        kitchen_ticket_id: t.ticketReference,
        order_id: t.orderReference,
        order_batch_id: t.orderBatchReference,
        order_item_id: item.orderItemReference,
        source_evidence_id: t.sourceEvidenceReference,
        work_plan_id: t.planReference,
        source_item_ordinal: item.sourceOrdinal,
        split_ordinal: item.splitOrdinal,
        version: 1n,
        status: item.status,
        required_quantity: item.requiredQuantity,
        completed_quantity: item.completedQuantity,
        product_id: item.productReference,
        product_version_id: item.productVersionReference,
        sku_id: item.skuReference,
        menu_version_id: item.menuVersionReference,
        localized_display_names_json: JSON.stringify(item.localizedDisplayNames),
        selected_options_json: JSON.stringify(item.selectedOptions),
        customer_note: item.customerNote,
        source_line_digest: item.sourceLineDigest,
        station_id: item.stationRouting.stationReference,
        routing_rule_id: item.stationRouting.routingRuleReference,
        routing_rule_version: item.stationRouting.routingRuleVersion,
        routing_rule_digest: item.stationRouting.routingRuleDigest,
        preparation_id: item.preparation.preparationReference,
        preparation_version: item.preparation.preparationVersion,
        preparation_digest: item.preparation.preparationDigest,
        preparation_instructions_json: JSON.stringify(item.preparation.instructions),
        execution_snapshot_digest: item.executionSnapshotDigest,
        ...actorAndTime,
      });
    await insert(tx, "kitchen_action_record", {
      brand_id: brand,
      store_id: store,
      kitchen_action_record_id: a.actionReference,
      kitchen_ticket_id: t.ticketReference,
      source_event_id: t.sourceEventReference,
      work_plan_id: t.planReference,
      correlation_id: t.correlationReference,
      action_version: a.actionVersion,
      action_code: a.actionCode,
      purpose: a.purpose,
      reason_code: a.reasonCode,
      actor_type: a.actorType,
      actor_id: a.actorReference,
      source_channel: a.sourceChannel,
      data_classification: a.dataClassification,
      work_item_count: a.workItemCount,
      effect_digest: effect.effectDigest,
      occurred_at: a.occurredAt,
    });
    await appendAuditRecordInTransaction(tx, effect.audit);
    await appendEventInTransaction(tx, effect.event);
    // Last: service-level recovery must never see a success before mandatory effects exist.
    await insert(tx, "kitchen_creation_record", {
      brand_id: brand,
      store_id: store,
      kitchen_ticket_id: t.ticketReference,
      kitchen_action_record_id: a.actionReference,
      source_event_id: t.sourceEventReference,
      confirmation_id: t.confirmationReference,
      order_batch_id: t.orderBatchReference,
      audit_id: effect.audit.auditId,
      outbox_event_id: effect.event.eventId,
      effect_digest: effect.effectDigest,
      creation_record_json: encodeKitchenTicketCreationRecord(effect, options),
      created_at: t.createdAt,
    });
  }

  return Object.freeze({
    async resolveBySemanticKeys(input) {
      try {
        const key = identity(input);
        await authorize(input.transaction, key);
        return await read(input.transaction, key);
      } catch {
        return unavailable();
      }
    },
    async commit(input) {
      try {
        const effect = parseKitchenTicketCreationEffect(input.effect, options);
        // Check supported persistent representation before any write.
        encodeKitchenTicketCreationRecord(effect, options);
        const key = identity(effect.receipt);
        const tx = input.transaction;
        await authorize(tx, key);
        let prior = await read(tx, key);
        if (prior.status === "NotFound") {
          if ((await options.validateCurrentSource(tx, effect)) !== true) return unavailable();
          await fence(tx, key);
          prior = await read(tx, key);
        }
        if (prior.status === "Conflict") return { status: "Conflict", effect };
        if (prior.status === "Resolved")
          return {
            status: kitchenCreationEffectsMatchSemantic(prior.effect, effect)
              ? "AlreadyCreated"
              : "Conflict",
            effect: prior.effect,
          };
        await persist(tx, effect);
        return { status: "Created", effect };
      } catch {
        return unavailable();
      }
    },
  });
}

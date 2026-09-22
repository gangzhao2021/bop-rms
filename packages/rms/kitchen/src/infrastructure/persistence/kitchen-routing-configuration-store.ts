import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import type { ResolveKitchenStationRoutingEvidenceInput } from "../../application/ports/kitchen-work-plan-ports.js";
import {
  parseKitchenRoutingConfigurationRecord,
  rebindKitchenRoutingEvidence,
  assertKitchenRoutingRevision,
  routingObject,
  kitchenRoutingUnavailable,
  KitchenRoutingConfigurationError,
  type KitchenRoutingConfigurationRecord,
} from "../../domain/station-routing-configuration.js";
import {
  parseKitchenTicketReference,
  parseKitchenTicketInstant,
} from "../../domain/kitchen-ticket.js";

export function createPostgresKitchenRoutingConfigurationStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sha256: (value: string) => string;
  readonly authorizeRead: (
    tx: ConsumerTransaction,
    input: ResolveKitchenStationRoutingEvidenceInput,
  ) => Promise<boolean>;
  readonly authorizeWrite: (
    tx: ConsumerTransaction,
    record: KitchenRoutingConfigurationRecord,
  ) => Promise<boolean>;
  readonly validateConfiguration: (
    tx: ConsumerTransaction,
    record: KitchenRoutingConfigurationRecord,
  ) => Promise<boolean>;
  readonly audit: (record: KitchenRoutingConfigurationRecord) => Promise<unknown>;
}) {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  async function scoped(tx: ConsumerTransaction) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  }
  async function fence(tx: ConsumerTransaction) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "KitchenRoutingConfiguration:" + brand + ":" + store,
    ]);
  }
  function bind(value: unknown) {
    const record = parseKitchenRoutingConfigurationRecord(value, options.sha256);
    if (
      record.configuration.brandReference !== brand ||
      record.configuration.storeReference !== store
    )
      return kitchenRoutingUnavailable();
    return record;
  }
  async function load(tx: ConsumerTransaction, operation?: string) {
    const result = await tx.query(
      "SELECT record_json AS record FROM rms_kitchen.kitchen_routing_configuration " +
        "WHERE brand_id=$1 AND store_id=$2 " +
        (operation ? "AND operation_id=$3" : "ORDER BY version_number DESC") +
        " LIMIT 1",
      operation ? [brand, store, operation] : [brand, store],
    );
    return result.rows[0] ? bind(result.rows[0].record) : null;
  }
  return Object.freeze({
    async commit(input: { readonly transaction: ConsumerTransaction; readonly record: unknown }) {
      try {
        const record = bind(input.record);
        const tx = input.transaction;
        await scoped(tx);
        if ((await options.authorizeWrite(tx, record)) !== true) return kitchenRoutingUnavailable();
        await fence(tx);
        const original = await load(tx, record.operationReference);
        if (original) {
          if (JSON.stringify(original) !== JSON.stringify(record))
            return kitchenRoutingUnavailable(true);
          return { status: "AlreadyCommitted" as const, record: original };
        }
        const candidate = record.configuration.candidates[0];
        async function lastIdentity(kind: "stationReference" | "routingRuleReference") {
          if (!candidate) return undefined;
          const result = await tx.query(
            "SELECT record_json AS record FROM rms_kitchen.kitchen_routing_configuration " +
              "WHERE brand_id=$1 AND store_id=$2 AND record_json #>> '{configuration,candidates,0," +
              kind +
              "}'=$3 ORDER BY version_number DESC LIMIT 1",
            [brand, store, candidate[kind]],
          );
          return result.rows[0]
            ? bind(result.rows[0].record).configuration.candidates[0]
            : undefined;
        }
        assertKitchenRoutingRevision(
          await load(tx),
          record,
          await lastIdentity("stationReference"),
          await lastIdentity("routingRuleReference"),
        );
        if ((await options.validateConfiguration(tx, record)) !== true)
          return kitchenRoutingUnavailable();
        const audit = validateAuditRecord(await options.audit(record));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== record.actorReference ||
          audit.actionCode !== "KITCHEN_ROUTING_CONFIGURATION_RECORDED" ||
          audit.targetType !== "KitchenRoutingConfiguration" ||
          audit.targetId !== record.configuration.evidenceReference ||
          audit.correlationId !== record.operationReference ||
          audit.reasonCode !== record.reasonCode ||
          audit.occurredAt !== record.recordedAt ||
          audit.beforeSummary !== undefined ||
          audit.dataClassification !== "Restricted" ||
          JSON.stringify(audit.afterSummary) !==
            JSON.stringify({ version: record.configuration.evidenceVersion })
        )
          return kitchenRoutingUnavailable();
        await appendAuditRecordInTransaction(tx, audit);
        const result = await tx.query(
          "INSERT INTO rms_kitchen.kitchen_routing_configuration " +
            "(brand_id,store_id,version_id,version_number,operation_id,actor_id,audit_id,effective_from,recorded_at,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            brand,
            store,
            record.configuration.evidenceReference,
            record.configuration.evidenceVersion,
            record.operationReference,
            record.actorReference,
            audit.auditId,
            record.configuration.effectiveAt,
            record.recordedAt,
            JSON.stringify(record),
          ],
        );
        if (result.rowCount !== 1) return kitchenRoutingUnavailable();
        return { status: "Committed" as const, record };
      } catch (error) {
        if (error instanceof KitchenRoutingConfigurationError) throw error;
        return kitchenRoutingUnavailable();
      }
    },
    async resolve(input: { readonly transaction: ConsumerTransaction; readonly query: unknown }) {
      try {
        const raw = routingObject(input.query, [
          "actorType",
          "actorReference",
          "action",
          "purpose",
          "brandReference",
          "storeReference",
          "effectiveAt",
        ]);
        if (
          raw.actorType !== "System" ||
          raw.actorReference !== null ||
          raw.action !== "ResolveKitchenStationRoutingEvidence" ||
          raw.purpose !== "CreateKitchenWork" ||
          raw.brandReference !== brand ||
          raw.storeReference !== store
        )
          return kitchenRoutingUnavailable();
        const query: ResolveKitchenStationRoutingEvidenceInput = {
          actorType: "System",
          actorReference: null,
          action: "ResolveKitchenStationRoutingEvidence",
          purpose: "CreateKitchenWork",
          brandReference: brand,
          storeReference: store,
          effectiveAt: parseKitchenTicketInstant(raw.effectiveAt),
        };
        const tx = input.transaction;
        await scoped(tx);
        if ((await options.authorizeRead(tx, query)) !== true) return kitchenRoutingUnavailable();
        await fence(tx);
        const result = await tx.query(
          "SELECT record_json AS record FROM rms_kitchen.kitchen_routing_configuration " +
            "WHERE brand_id=$1 AND store_id=$2 AND effective_from<=$3::timestamptz " +
            "ORDER BY version_number DESC LIMIT 1",
          [brand, store, query.effectiveAt],
        );
        if (!result.rows[0]) return null;
        const record = bind(result.rows[0].record);
        if (record.configuration.effectiveAt > query.effectiveAt)
          return kitchenRoutingUnavailable();
        return rebindKitchenRoutingEvidence(
          record.configuration,
          query.effectiveAt,
          options.sha256,
        );
      } catch {
        return kitchenRoutingUnavailable();
      }
    },
  });
}

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
import { parseKitchenStationRoutingCandidateSetEvidence } from "../../domain/station-routing.js";

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

/**
 * WP-2423 / DEC-RECIPE-AUTHORING: the Store's current kitchen stations and the station capabilities a
 * recipe step may require, from the latest recorded routing configuration. Caller authorizes.
 */
export async function listKitchenStationCapabilities(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<
  readonly {
    readonly stationReference: string;
    readonly stationActive: boolean;
    readonly selectorKind: string;
    readonly capabilityReferences: readonly string[];
  }[]
> {
  const brand = parseKitchenTicketReference(scope.brandReference);
  const store = parseKitchenTicketReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const row = (
    await tx.query(
      "SELECT record_json->'configuration' AS configuration FROM rms_kitchen.kitchen_routing_configuration " +
        "WHERE brand_id=$1 AND store_id=$2 ORDER BY version_number DESC LIMIT 1",
      [brand, store],
    )
  ).rows[0];
  if (!row) return [];
  const configuration = parseKitchenStationRoutingCandidateSetEvidence(row.configuration);
  return configuration.candidates.map((candidate) =>
    Object.freeze({
      stationReference: candidate.stationReference,
      stationActive: candidate.stationStatus === "Active",
      selectorKind: candidate.selector.kind,
      capabilityReferences: Object.freeze([...candidate.stationCapabilityReferences]),
    }),
  );
}

/**
 * v15 2026-11-01 (WP-2423 item 11): whether this Store's kitchen routing is in effect at `at`. The
 * kitchen routes an order by the routing in effect when it was confirmed and a routing is never
 * back-dated, so a Store takes no order before this is true. Caller authorizes.
 */
export async function storeKitchenRoutingInEffect(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  at: string,
): Promise<boolean> {
  const brand = parseKitchenTicketReference(scope.brandReference);
  const store = parseKitchenTicketReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const { rows } = await tx.query(
    "SELECT 1 FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 AND effective_from<=$3::timestamptz LIMIT 1",
    [brand, store, parseKitchenTicketInstant(at)],
  );
  return rows.length === 1;
}

export interface StoreKitchenLine {
  /** 0: this Store's kitchen has never been set up. */
  readonly version: number;
  readonly effectiveFrom: string | null;
  readonly capabilityReferences: readonly string[];
}
/** The Store's one kitchen line as last recorded. Caller authorizes. */
export async function readStoreKitchenLine(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<StoreKitchenLine> {
  const brand = parseKitchenTicketReference(scope.brandReference);
  const store = parseKitchenTicketReference(scope.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const row = (
    await tx.query(
      "SELECT version_number,record_json->'configuration' AS configuration FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 ORDER BY version_number DESC LIMIT 1",
      [brand, store],
    )
  ).rows[0] as { version_number: number; configuration: unknown } | undefined;
  if (row === undefined)
    return Object.freeze({ version: 0, effectiveFrom: null, capabilityReferences: [] });
  const configuration = parseKitchenStationRoutingCandidateSetEvidence(row.configuration);
  return Object.freeze({
    version: row.version_number,
    effectiveFrom: configuration.effectiveAt,
    capabilityReferences: Object.freeze(
      configuration.candidates.flatMap((candidate) => [...candidate.stationCapabilityReferences]),
    ),
  });
}

/**
 * v15 2026-11-01 (WP-2423 item 11; Owner 取舍 5, 9: one kitchen screen per Store): records the Store's
 * one kitchen line, which takes every dish that needs no capability it lacks, in effect from
 * `recordedAt` (never earlier: orders already confirmed keep the routing they were confirmed under).
 * The same line is kept when capabilities are added. Through this owner's own store, with its
 * audit; the same operation again returns what it recorded.
 */
export async function recordStoreKitchenLine(
  tx: ConsumerTransaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly operationReference: string;
    readonly auditReference: string;
    readonly expectedVersion: number;
    readonly recordedAt: string;
    readonly capabilityReferences: readonly string[];
    readonly sha256: (value: string) => string;
    readonly nextReference: () => string;
    /** False: a new operation with nothing to change records nothing (NoChange). */
    readonly onlyIfChanged: boolean;
    /** Who the change is under when it isn't the Store's own staff (platform support). */
    readonly purposeCode?: string;
    readonly permissionCode?: string;
    readonly reasonCode?: string;
    authorize(tx: ConsumerTransaction): Promise<boolean>;
  },
): Promise<{
  readonly status: "Recorded" | "AlreadyRecorded" | "NoChange";
  readonly version: number;
}> {
  const brand = parseKitchenTicketReference(input.brandReference);
  const store = parseKitchenTicketReference(input.storeReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "KitchenRoutingConfiguration:" + brand + ":" + store,
  ]);
  const prior = (
    await tx.query(
      "SELECT version_number FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, parseKitchenTicketReference(input.operationReference)],
    )
  ).rows[0] as { version_number: number } | undefined;
  if (prior !== undefined)
    return Object.freeze({ status: "AlreadyRecorded", version: prior.version_number });
  if (!input.onlyIfChanged)
    return Object.freeze({ status: "NoChange", version: input.expectedVersion });
  const latest = (
    await tx.query(
      "SELECT record_json AS record FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 ORDER BY version_number DESC LIMIT 1",
      [brand, store],
    )
  ).rows[0] as { record: unknown } | undefined;
  const previous =
    latest === undefined
      ? null
      : parseKitchenRoutingConfigurationRecord(latest.record, input.sha256);
  const line = previous?.configuration.candidates[0];
  const capabilities = [...new Set(input.capabilityReferences)].sort();
  const stationChanged =
    line !== undefined &&
    JSON.stringify([...line.stationCapabilityReferences].sort()) !== JSON.stringify(capabilities);
  const version = (previous?.configuration.evidenceVersion ?? 0) + 1;
  const record = {
    operationReference: input.operationReference,
    actorReference: input.actorReference,
    purposeCode: input.purposeCode ?? "StoreKitchenSetup",
    permissionCode: input.permissionCode ?? "organization.store.update",
    reasonCode: input.reasonCode ?? "STORE_KITCHEN_SETUP",
    recordedAt: input.recordedAt,
    expectedVersion: input.expectedVersion,
    configuration: rebindKitchenRoutingEvidence(
      {
        brandReference: brand,
        storeReference: store,
        evidenceReference: input.nextReference(),
        evidenceVersion: version,
        effectiveAt: input.recordedAt,
        evidenceDigest: input.sha256("placeholder"),
        candidates: [
          {
            stationReference: line?.stationReference ?? input.nextReference(),
            stationVersion:
              (line?.stationVersion ?? 0) + (line === undefined || stationChanged ? 1 : 0),
            stationStatus: "Active",
            stationCapabilityReferences: capabilities,
            routingRuleReference: line?.routingRuleReference ?? input.nextReference(),
            routingRuleVersion: line?.routingRuleVersion ?? 1,
            routingRuleStatus: "Active",
            selector: { kind: "AllPreparedItems" },
            targetStationReference: "",
            routingRuleDigest: input.sha256("placeholder"),
          },
        ].map((candidate) => ({
          ...candidate,
          targetStationReference: candidate.stationReference,
        })),
      },
      input.recordedAt,
      input.sha256,
    ),
  };
  const committed = await createPostgresKitchenRoutingConfigurationStore({
    brandReference: brand,
    storeReference: store,
    sha256: input.sha256,
    authorizeRead: async () => false,
    authorizeWrite: (t) => input.authorize(t),
    validateConfiguration: async () => true,
    audit: async (value) => ({
      auditId: input.auditReference,
      brandId: brand,
      storeId: store,
      actor: { type: "User", reference: value.actorReference },
      actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
      targetType: "KitchenRoutingConfiguration",
      targetId: value.configuration.evidenceReference,
      correlationId: value.operationReference,
      reasonCode: value.reasonCode,
      occurredAt: value.recordedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { version: value.configuration.evidenceVersion },
      dataClassification: "Restricted",
      retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
      retentionPolicyVersion: 1,
    }),
  }).commit({ transaction: tx, record });
  return Object.freeze({
    status: committed.status === "Committed" ? "Recorded" : "AlreadyRecorded",
    version,
  });
}

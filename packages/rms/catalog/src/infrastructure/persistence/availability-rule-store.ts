import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction, validateDomainEventEnvelope } from "@bop/eventing";
import type {
  AvailabilityOperationRecord,
  AvailabilityPorts,
} from "../../application/ports/availability-ports.js";
import {
  parseAvailabilityRule,
  type AvailabilityRuleAggregate,
} from "../../domain/availability.js";
import { CatalogError, parseCatalogHash, parseCatalogReference } from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

/**
 * WP-2423 8.5: Availability rule repository for `availability-service`. Rules are Brand-scoped
 * configuration (a Store overlay carries its Store); each operation appends its record, the exact
 * result snapshot, an Audit and its Event in the caller's transaction, in the Brand scope.
 */
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const columns = `r.availability_rule_id::text rule,r.brand_id::text brand,r.internal_code,r.aggregate_version,
  r.lifecycle,r.sellable_type,coalesce(r.sku_id,r.product_id,r.bundle_id)::text sellable,r.store_id::text store,
  r.channel_codes_json,r.order_type_codes_json,${iso("r.effective_from")} effective_from,
  ${iso("r.effective_until")} effective_until,r.decision,r.priority,r.reason_code,${iso("r.created_at")} created_at,
  r.created_by_actor_id::text created_by,${iso("r.updated_at")} updated_at`;
const aggregateOf = (row: Record<string, unknown>): AvailabilityRuleAggregate =>
  parseAvailabilityRule({
    ruleReference: row.rule,
    brandReference: row.brand,
    internalCode: row.internal_code,
    aggregateVersion: Number(row.aggregate_version),
    lifecycle: row.lifecycle,
    sellableReference: row.sellable,
    sellableType: row.sellable_type,
    storeReference: row.store ?? null,
    channelCodes: row.channel_codes_json,
    orderTypeCodes: row.order_type_codes_json,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until ?? null,
    decision: row.decision,
    priority: Number(row.priority),
    reasonCode: row.reason_code,
    createdAt: row.created_at,
    createdByActorReference: row.created_by,
    updatedAt: row.updated_at,
  });
const brandScope = (tx: ProductLifecycleTransaction, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);

/** Every non-archived rule that can apply at the Store: its own overlays and Brand-wide rules. */
export async function listStoreAvailabilityRules(
  tx: ProductLifecycleTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<readonly AvailabilityRuleAggregate[]> {
  const brand = parseCatalogReference(scope.brandReference);
  const store = parseCatalogReference(scope.storeReference);
  await brandScope(tx, brand);
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ${columns} FROM rms_catalog.availability_rule r
      WHERE r.brand_id=$1 AND (r.store_id=$2 OR r.store_id IS NULL) AND r.lifecycle<>'Archived'
      ORDER BY r.created_at,r.availability_rule_id`,
    [brand, store],
  );
  return Object.freeze(rows.map(aggregateOf));
}

/** The SKU is the Brand's and still sellable; other targets are not managed here. */
export async function availabilityTargetExists(
  tx: ProductLifecycleTransaction,
  input: { readonly brandReference: string; readonly sellableReference: string },
): Promise<boolean> {
  const brand = parseCatalogReference(input.brandReference);
  await brandScope(tx, brand);
  const { rows } = await tx.query(
    `SELECT 1 FROM rms_catalog.sku s JOIN rms_catalog.product p
       ON p.product_id=s.product_id AND p.brand_id=s.brand_id
      WHERE s.brand_id=$1 AND s.sku_id=$2 AND s.lifecycle='Active' AND p.lifecycle='Active'`,
    [brand, parseCatalogReference(input.sellableReference)],
  );
  return rows.length === 1;
}

export function createPostgresAvailabilityRuleRepository(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  references: { generate(): string };
  /** Current authority for the write, checked before every read and write. */
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}): AvailabilityPorts["repository"] {
  const brand = parseCatalogReference(options.brandReference);
  const scoped = <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) =>
    options.transactions.run(async (tx) => {
      if (!(await options.authorize(tx))) fail("CATALOG_PERMISSION_DENIED");
      await brandScope(tx, brand);
      return work(tx);
    });
  const load = async (tx: ProductLifecycleTransaction, rule: string) => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT ${columns} FROM rms_catalog.availability_rule r WHERE r.brand_id=$1 AND r.availability_rule_id=$2`,
      [brand, rule],
    );
    const row = rows[0];
    return row === undefined ? null : aggregateOf(row);
  };
  const readOperation = async (
    tx: ProductLifecycleTransaction,
    operation: string,
  ): Promise<AvailabilityOperationRecord | null> => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT o.action_code,o.intent_digest,o.result_aggregate_version,o.availability_rule_id::text rule,
          s.record_json FROM rms_catalog.availability_rule_operation_record o
          LEFT JOIN rms_catalog.availability_rule_operation_snapshot s ON s.operation_id=o.operation_id
        WHERE o.brand_id=$1 AND o.operation_id=$2`,
      [brand, operation],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const record = row.record_json as AvailabilityOperationRecord | null;
    if (record === null || typeof record !== "object") return fail();
    const aggregate = parseAvailabilityRule(record.aggregate);
    if (
      record.operationReference !== operation ||
      record.action !== row.action_code ||
      "sha256:" + record.operationIntentHash !== row.intent_digest ||
      aggregate.ruleReference !== row.rule ||
      aggregate.aggregateVersion !== Number(row.result_aggregate_version) ||
      aggregate.brandReference !== brand
    )
      return fail();
    return Object.freeze({
      action: record.action,
      operationReference: parseCatalogReference(record.operationReference),
      operationIntentHash: parseCatalogHash(record.operationIntentHash),
      aggregate,
      // Snapshots are canonical JSON; the event is rebuilt in its domain field order.
      event: Object.freeze({
        eventType: record.event.eventType,
        aggregateReference: parseCatalogReference(record.event.aggregateReference),
        aggregateVersion: record.event.aggregateVersion,
        brandReference: parseCatalogReference(record.event.brandReference),
        sellableType: record.event.sellableType,
        lifecycle: record.event.lifecycle,
        occurredAt: record.event.occurredAt,
      }),
    });
  };
  const lock = (tx: ProductLifecycleTransaction, key: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
  const checkAudit = (audit: AppendAuditRecordInput, record: AvailabilityOperationRecord) => {
    const valid = validateAuditRecord(audit, Date.parse(record.aggregate.updatedAt));
    if (
      valid.brandId !== brand ||
      valid.targetType !== "CatalogAvailabilityRule" ||
      valid.targetId !== record.aggregate.ruleReference ||
      valid.actionCode !== `CATALOG_AVAILABILITY_${record.action.toUpperCase()}` ||
      valid.actor.type === "System"
    )
      return fail("CATALOG_PERMISSION_DENIED");
    return valid;
  };
  const append = async (
    tx: ProductLifecycleTransaction,
    record: AvailabilityOperationRecord,
    audit: AppendAuditRecordInput,
  ) => {
    const { aggregate, event } = record;
    await tx.query(
      "INSERT INTO rms_catalog.availability_rule_operation_record(operation_id,brand_id,availability_rule_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        record.operationReference,
        brand,
        aggregate.ruleReference,
        record.action,
        "sha256:" + record.operationIntentHash,
        aggregate.aggregateVersion,
        aggregate.updatedAt,
      ],
    );
    await tx.query(
      "INSERT INTO rms_catalog.availability_rule_operation_snapshot(operation_id,brand_id,availability_rule_id,record_json) VALUES($1,$2,$3,$4::jsonb)",
      [
        record.operationReference,
        brand,
        aggregate.ruleReference,
        canonicalizeRfc8785(JSON.parse(JSON.stringify(record)) as never),
      ],
    );
    // A Store manager's change is audited in that Store's scope; the rule stays Brand configuration.
    if (audit.storeId !== undefined)
      await tx.query("SELECT set_config('bop.store_id',$1,true)", [audit.storeId]);
    await appendAuditRecordInTransaction(tx, audit);
    if (audit.storeId !== undefined) await brandScope(tx, brand);
    if (audit.actor.type === "System") return fail();
    await appendEventInTransaction(
      {
        query: async (sql, values) => {
          const result = await tx.query(sql, values);
          return { rowCount: result.rowCount ?? 0 };
        },
      },
      validateDomainEventEnvelope({
        eventId: parseCatalogReference(options.references.generate()),
        eventType: event.eventType,
        schemaVersion: 1,
        occurredAt: event.occurredAt,
        producerModule: "@rms/catalog",
        tenantId: brand,
        aggregateType: "AvailabilityRule",
        aggregateId: aggregate.ruleReference,
        aggregateVersion: BigInt(aggregate.aggregateVersion),
        correlationId: parseCatalogReference(audit.correlationId),
        causationId: record.operationReference,
        actor: { type: "Actor", actorId: parseCatalogReference(audit.actor.reference) },
        payload: {
          availabilityRuleReference: aggregate.ruleReference,
          aggregateVersion: String(aggregate.aggregateVersion),
          sellableType: aggregate.sellableType,
          lifecycle: aggregate.lifecycle,
          occurredAt: event.occurredAt,
        },
        redactionClassification: "none",
        replayMetadata: { replaySafe: true },
      }),
    );
  };
  const target = (aggregate: AvailabilityRuleAggregate) => ({
    sku: aggregate.sellableType === "Sku" ? aggregate.sellableReference : null,
    product: aggregate.sellableType === "Product" ? aggregate.sellableReference : null,
    bundle: aggregate.sellableType === "Bundle" ? aggregate.sellableReference : null,
  });
  const confirm = async (
    tx: ProductLifecycleTransaction,
    record: AvailabilityOperationRecord,
  ): Promise<AvailabilityOperationRecord> => {
    const saved = await readOperation(tx, record.operationReference);
    const current = await load(tx, record.aggregate.ruleReference);
    if (
      saved === null ||
      current === null ||
      JSON.stringify(current) !== JSON.stringify(record.aggregate) ||
      JSON.stringify(saved.aggregate) !== JSON.stringify(record.aggregate)
    )
      return fail();
    return saved;
  };
  return Object.freeze({
    resolveOperation: (operation) =>
      scoped((tx) => readOperation(tx, parseCatalogReference(operation))),
    load: (rule) => scoped((tx) => load(tx, parseCatalogReference(rule))),
    codeAvailable: (input) =>
      scoped(async (tx) => {
        if (input.brandReference !== brand) return fail("CATALOG_PERMISSION_DENIED");
        const { rows } = await tx.query(
          "SELECT 1 FROM rms_catalog.availability_rule WHERE brand_id=$1 AND internal_code=$2 AND ($3::uuid IS NULL OR availability_rule_id<>$3::uuid)",
          [brand, input.internalCode, input.excludingRuleReference],
        );
        return rows.length === 0;
      }),
    create: (input) =>
      scoped(async (tx) => {
        const { record } = input;
        const { aggregate } = record;
        if (
          record.action !== "Create" ||
          aggregate.brandReference !== brand ||
          aggregate.aggregateVersion !== 1
        )
          return fail();
        const audit = checkAudit(input.audit, record);
        await lock(tx, "CatalogAvailabilityOperation:" + brand + ":" + record.operationReference);
        if ((await readOperation(tx, record.operationReference)) !== null)
          return fail("CATALOG_IDEMPOTENCY_CONFLICT");
        const t = target(aggregate);
        await tx.query(
          `INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,
            lifecycle,sellable_type,sku_id,product_id,bundle_id,store_id,channel_codes_json,order_type_codes_json,
            effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            aggregate.ruleReference,
            brand,
            aggregate.internalCode,
            aggregate.aggregateVersion,
            aggregate.lifecycle,
            aggregate.sellableType,
            t.sku,
            t.product,
            t.bundle,
            aggregate.storeReference,
            JSON.stringify(aggregate.channelCodes),
            JSON.stringify(aggregate.orderTypeCodes),
            aggregate.effectiveFrom,
            aggregate.effectiveUntil,
            aggregate.decision,
            aggregate.priority,
            aggregate.reasonCode,
            aggregate.createdAt,
            aggregate.createdByActorReference,
            aggregate.updatedAt,
          ],
        );
        await append(tx, record, audit);
        return confirm(tx, record);
      }),
    commit: (input) =>
      scoped(async (tx) => {
        const { record } = input;
        const { aggregate } = record;
        if (
          record.action === "Create" ||
          aggregate.brandReference !== brand ||
          aggregate.aggregateVersion !== input.expectedAggregateVersion + 1
        )
          return fail();
        const audit = checkAudit(input.audit, record);
        await lock(tx, "CatalogAvailabilityOperation:" + brand + ":" + record.operationReference);
        if ((await readOperation(tx, record.operationReference)) !== null)
          return fail("CATALOG_IDEMPOTENCY_CONFLICT");
        const t = target(aggregate);
        const updated = await tx.query(
          `UPDATE rms_catalog.availability_rule SET aggregate_version=$3,lifecycle=$4,sellable_type=$5,sku_id=$6,
            product_id=$7,bundle_id=$8,store_id=$9,channel_codes_json=$10::jsonb,order_type_codes_json=$11::jsonb,
            effective_from=$12,effective_until=$13,decision=$14,priority=$15,reason_code=$16,updated_at=$17
           WHERE brand_id=$1 AND availability_rule_id=$2 AND aggregate_version=$18`,
          [
            brand,
            aggregate.ruleReference,
            aggregate.aggregateVersion,
            aggregate.lifecycle,
            aggregate.sellableType,
            t.sku,
            t.product,
            t.bundle,
            aggregate.storeReference,
            JSON.stringify(aggregate.channelCodes),
            JSON.stringify(aggregate.orderTypeCodes),
            aggregate.effectiveFrom,
            aggregate.effectiveUntil,
            aggregate.decision,
            aggregate.priority,
            aggregate.reasonCode,
            aggregate.updatedAt,
            input.expectedAggregateVersion,
          ],
        );
        if (updated.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
        await append(tx, record, audit);
        return confirm(tx, record);
      }),
  });
}

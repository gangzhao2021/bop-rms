import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction, type DomainEventEnvelope } from "@bop/eventing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  contentRegistryFields,
  parseCatalogContentRegistryCommand,
  parseCatalogContentRegistryObservation,
  parseCatalogProductContentRegistry,
  catalogProductContentRegistryDigest,
  assertCatalogProductContentRegistrySuccessor,
  catalogContentRegistryRequest,
  catalogContentRegistryEventId,
  type CatalogContentRegistryCommand,
  type CatalogContentRegistryObservation,
  type CatalogProductContentRegistry,
} from "../../contracts/product-content-registry.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
export interface CatalogContentRegistryAuthority {
  /** Mandatory current active Brand/locale/field policy, Actor fine action and
   * complete purpose scope held through outer COMMIT; no client permission fact. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User" | "System";
      readonly purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY";
      readonly permission: "catalog.manage";
      readonly action: "catalog.content-registry.manage" | "catalog.content-registry.read";
      readonly registry: CatalogProductContentRegistry | null;
      readonly requiredFields: typeof contentRegistryFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
interface RecordRow {
  readonly command: unknown;
  readonly registry: unknown;
  readonly intent_digest: string;
  readonly snapshot_digest: string;
  readonly event_id: string;
  readonly coherent: boolean;
}
const rowsSql = `SELECT command_json command,snapshot_json registry,intent_digest,snapshot_digest,event_id::text event_id,
 (command_json->>'tenantReference'=tenant_id::text AND command_json->>'brandReference'=brand_id::text AND command_json->>'actorReference'=actor_id::text AND command_json->>'operationReference'=operation_id::text AND command_json->>'occurredAt'=to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND command_json->'expectedRegistryVersion'=to_jsonb(registry_version-1) AND snapshot_json->>'registryReference'=registry_id::text AND snapshot_json->>'versionReference'=version_id::text AND snapshot_json->'registryVersion'=to_jsonb(registry_version) AND command_json->'registry'=snapshot_json AND data_classification='ConfigurationMetadata') coherent
 FROM rms_catalog.product_content_registry_record WHERE tenant_id=$1 AND brand_id=$2`;
function decode(row: RecordRow, tenant: string, brand: string) {
  const command = parseCatalogContentRegistryCommand(row.command),
    registry = parseCatalogProductContentRegistry(row.registry);
  if (
    row.coherent !== true ||
    command.tenantReference !== tenant ||
    command.brandReference !== brand ||
    canonicalizeRfc8785(registry) !== canonicalizeRfc8785(command.registry) ||
    row.intent_digest !== command.intentDigest ||
    row.snapshot_digest !== command.snapshotDigest ||
    row.event_id !== catalogContentRegistryEventId(command)
  )
    return fail();
  return command;
}
export function createPostgresProductContentRegistryStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CatalogContentRegistryAuthority;
  readonly audit?: { create(command: CatalogContentRegistryCommand): AppendAuditRecordInput };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    (options.audit !== undefined && typeof options.audit.create !== "function")
  )
    return fail();
  const key = "CatalogContentRegistry:" + tenant + ":" + brand;
  const hold = (
    tx: Transaction,
    action: "catalog.content-registry.manage" | "catalog.content-registry.read",
    registry: CatalogProductContentRegistry | null,
  ) =>
    options.authority.holdUntilTransactionCompletes(
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: kind,
        purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
        permission: "catalog.manage",
        action,
        registry,
        requiredFields: contentRegistryFields,
        observedAt: parseCatalogInstant(options.clock.now()),
      }),
    );
  const context = async (tx: Transaction) => {
    await requireCategoryCurrentReads(tx);
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
      [tenant, brand],
    );
  };
  const history = async (tx: Transaction) => {
    const count = await tx.query<{ n: string; bytes: string }>(
        "SELECT count(*)::text n,COALESCE(sum(octet_length(snapshot_json::text)+octet_length(command_json::text)),0)::text bytes FROM rms_catalog.product_content_registry_record WHERE tenant_id=$1 AND brand_id=$2",
        [tenant, brand],
      ),
      r = count.rows[0];
    if (
      count.rows.length !== 1 ||
      !r ||
      !/^(0|[1-9][0-9]*)$/.test(r.n) ||
      !/^(0|[1-9][0-9]*)$/.test(r.bytes) ||
      BigInt(r.n) > 1000n ||
      BigInt(r.bytes) > 8388608n
    )
      return fail();
    const rows = await tx.query<RecordRow>(rowsSql + " ORDER BY registry_version LIMIT 1001", [
      tenant,
      brand,
    ]);
    if (rows.rows.length !== Number(r.n)) return fail();
    let previous: CatalogProductContentRegistry | null = null;
    for (const row of rows.rows) {
      const command = decode(row, tenant, brand);
      assertCatalogProductContentRegistrySuccessor(previous, command.registry);
      previous = command.registry;
    }
    return { current: previous, bytes: BigInt(r.bytes), count: Number(r.n) };
  };
  return Object.freeze({
    async execute(value: unknown) {
      const command = parseCatalogContentRegistryCommand(value);
      if (typeof options.audit?.create !== "function") return fail();
      const createAudit = options.audit.create.bind(options.audit);
      if (
        kind !== "User" ||
        command.tenantReference !== tenant ||
        command.brandReference !== brand ||
        command.actorReference !== actor
      )
        return fail("CATALOG_PERMISSION_DENIED");
      let calls = 0;
      try {
        return await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          await hold(tx, "catalog.content-registry.manage", command.registry);
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
          if (command.occurredAt > parseCatalogInstant(options.clock.now())) return fail();
          const recovered = await tx.query<RecordRow>(rowsSql + " AND operation_id=$3", [
            tenant,
            brand,
            command.operationReference,
          ]);
          if (recovered.rows.length > 1) return fail();
          const row = recovered.rows[0];
          if (row) {
            const original = decode(row, tenant, brand);
            if (original.intentDigest !== command.intentDigest)
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            await hold(tx, "catalog.content-registry.manage", original.registry);
            return Object.freeze({
              status: "Replayed" as const,
              registry: original.registry,
              snapshotDigest: original.snapshotDigest,
              operationReference: original.operationReference,
            });
          }
          const currentTime = parseCatalogInstant(options.clock.now());
          if (Date.parse(currentTime) - Date.parse(command.occurredAt) >= 30000) return fail();
          const source = await history(tx);
          if ((source.current?.registryVersion ?? 0) !== command.expectedRegistryVersion)
            return fail("CATALOG_VERSION_CONFLICT");
          if (source.count >= 1000) return fail();
          const commandJson = canonicalizeRfc8785(catalogContentRegistryRequest(command)),
            registryJson = canonicalizeRfc8785(command.registry),
            size = await tx.query<{ bytes: string }>(
              "SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text))::text bytes",
              [commandJson, registryJson],
            ),
            serializedBytes = size.rows[0]?.bytes;
          if (
            size.rows.length !== 1 ||
            typeof serializedBytes !== "string" ||
            !/^[1-9][0-9]*$/.test(serializedBytes) ||
            source.bytes + BigInt(serializedBytes) > 8388608n
          )
            return fail();
          assertCatalogProductContentRegistrySuccessor(source.current, command.registry);
          const audit = validateAuditRecord(copyCategoryPersistenceValue(createAudit(command)));
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type !== "User" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_CONTENT_REGISTRY_RECORDED" ||
            audit.targetType !== "CatalogContentRegistry" ||
            audit.targetId !== command.registry.registryReference ||
            audit.reasonCode !== command.reasonCode ||
            audit.occurredAt !== command.occurredAt ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();
          const eventId = catalogContentRegistryEventId(command);
          const inserted = await tx.query(
            "INSERT INTO rms_catalog.product_content_registry_record(operation_id,tenant_id,brand_id,registry_id,version_id,registry_version,actor_id,intent_digest,snapshot_digest,occurred_at,command_json,snapshot_json,event_id,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)",
            [
              command.operationReference,
              tenant,
              brand,
              command.registry.registryReference,
              command.registry.versionReference,
              command.registry.registryVersion,
              actor,
              command.intentDigest,
              command.snapshotDigest,
              command.occurredAt,
              commandJson,
              registryJson,
              eventId,
              audit.auditId,
            ],
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(tx, audit);
          const envelope: DomainEventEnvelope = {
            eventId,
            eventType: "ProductContentRegistryVersionRecorded",
            schemaVersion: 1,
            occurredAt: command.occurredAt,
            producerModule: "@rms/catalog",
            tenantId: brand,
            aggregateType: "CatalogContentRegistry",
            aggregateId: command.registry.registryReference,
            aggregateVersion: BigInt(command.registry.registryVersion),
            correlationId: audit.correlationId,
            actor: { type: "Actor", actorId: actor },
            payload: {
              tenantReference: tenant,
              registryReference: command.registry.registryReference,
              versionReference: command.registry.versionReference,
              registryVersion: command.registry.registryVersion,
              operationReference: command.operationReference,
              snapshotDigest: command.snapshotDigest,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: {
              operationReference: command.operationReference,
              registryVersion: command.registry.registryVersion,
            },
          };
          await appendEventInTransaction(
            {
              query: async (sql, values) => {
                const r = await tx.query(sql, values);
                return { rowCount: r.rowCount ?? null };
              },
            },
            envelope,
          );
          await hold(tx, "catalog.content-registry.manage", command.registry);
          const finalTime = parseCatalogInstant(options.clock.now());
          if (
            command.occurredAt > finalTime ||
            Date.parse(finalTime) - Date.parse(command.occurredAt) >= 30000
          )
            return fail();
          return Object.freeze({
            status: "Applied" as const,
            registry: command.registry,
            snapshotDigest: command.snapshotDigest,
            operationReference: command.operationReference,
          });
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
    async withCurrentRegistry<T>(
      value: unknown,
      work: (
        source: {
          readonly registry: CatalogProductContentRegistry;
          readonly snapshotDigest: string;
          readonly observation: CatalogContentRegistryObservation;
          readonly eligibility: "NotEvaluated";
        },
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      const observation = parseCatalogContentRegistryObservation(value);
      let calls = 0;
      try {
        return await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const check = () => {
            const current = parseCatalogInstant(options.clock.now());
            if (current < observation.observedAt || current >= observation.validUntil)
              return fail();
          };
          check();
          await hold(tx, "catalog.content-registry.read", null);
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [key]);
          const source = await history(tx),
            registry = source.current;
          if (!registry || registry.registeredAt > observation.observedAt) return fail();
          await hold(tx, "catalog.content-registry.read", registry);
          check();
          const result = await work(
            Object.freeze({
              registry,
              snapshotDigest: catalogProductContentRegistryDigest(registry),
              observation,
              eligibility: "NotEvaluated",
            }),
            tx,
          );
          check();
          await hold(tx, "catalog.content-registry.read", registry);
          check();
          return result;
        });
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}

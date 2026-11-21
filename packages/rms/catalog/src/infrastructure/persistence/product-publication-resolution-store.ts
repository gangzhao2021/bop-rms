import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductAggregate,
} from "../../contracts/product.js";
import { recoverCatalogProductPublication } from "../../contracts/product-publication.js";
import { recoverCatalogProductPublicationV2 } from "../../contracts/product-publication-v2.js";
import {
  parseCatalogProductPublicationResolutionCommand,
  parseCatalogProductPublicationResolution,
  buildCatalogProductPublicationResolution,
  catalogProductPublicationResolutionNamespace,
  type CatalogProductPublicationResolutionCommand,
  type CatalogProductPublicationResolution,
} from "../../contracts/product-publication-resolution.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
import { recoverProductPublicationWarningAcknowledgement } from "./product-publication-warning-acknowledgement-record.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";

export const productPublicationResolutionFields = Object.freeze([
  "productReference",
  "versionReference",
  "originalKind",
  "originalCommand",
  "operationReference",
  "originalIntentDigest",
  "operationHistory",
  "operationResolution",
] as const);
const permissions = Object.freeze([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.product.history.read",
] as const);
export interface ProductPublicationResolutionStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    asyncGuard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly actorKind: "User";
        readonly command: CatalogProductPublicationResolutionCommand;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION";
        readonly permission: "catalog.manage";
        readonly requiredPermissions: typeof permissions;
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof productPublicationResolutionFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly audit: {
    create(input: {
      readonly command: CatalogProductPublicationResolutionCommand;
      readonly resolution: CatalogProductPublicationResolution;
    }): AppendAuditRecordInput;
  };
}
export interface ProductPublicationResolutionWriteResult {
  readonly resolution: CatalogProductPublicationResolution;
  /** Current read revision only; never part of the immutable original outcome. */
  readonly currentAggregateVersion: number;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[field] = descriptor.value;
  }
  return result;
}
function rows(value: unknown): readonly unknown[] {
  const descriptor =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    Object.getPrototypeOf(descriptor.value) !== Array.prototype ||
    descriptor.value.length > 1 ||
    Reflect.ownKeys(descriptor.value).length !== descriptor.value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < descriptor.value.length; i++) {
    const row = Object.getOwnPropertyDescriptor(descriptor.value, String(i));
    if (!row?.enumerable || !("value" in row)) return fail();
    result.push(row.value);
  }
  return result;
}

/** Private owning fence shared by the original writers. Their original receipt
 * branch precedes this call. Never filter on Actor/digest: a changed late intent
 * must not reinterpret a permanently abandoned operation as absent. */
export async function assertProductPublicationOperationNotAbandoned(
  tx: ProductLifecycleTransaction,
  namespace: "CatalogProductOperation" | "CatalogProductWarningAcknowledgement",
  brandReference: string,
  operationReference: string,
): Promise<void> {
  const original = tx.query;
  const found = rows(
    await original.call(
      tx,
      "SELECT operation_id FROM rms_catalog.product_publication_operation_abandonment WHERE operation_namespace=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2",
      [namespace, brandReference, operationReference],
    ),
  );
  if (tx.query !== original) return fail();
  if (found.length !== 0) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
}

const publicationSql = `SELECT o.action_code,o.intent_digest,r.snapshot_json publication,s.snapshot_json aggregate,
 (o.product_id=$4 AND r.tenant_id=$1 AND r.brand_id=o.brand_id AND r.product_id=o.product_id
 AND r.product_version_id=$5 AND r.action_code=$6 AND r.intent_digest=o.intent_digest
 AND r.result_aggregate_version=o.result_aggregate_version AND r.occurred_at=o.occurred_at
 AND s.brand_id=o.brand_id AND s.product_id=o.product_id
 AND s.result_aggregate_version=o.result_aggregate_version AND s.occurred_at=o.occurred_at
 AND s.data_classification='ConfigurationMetadata' AND r.data_classification='ConfigurationMetadata') IS TRUE coherent
 FROM rms_catalog.product_operation_record o
 LEFT JOIN rms_catalog.product_publication_revision r ON r.operation_id=o.operation_id AND r.tenant_id=$1
 LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=o.operation_id
 WHERE o.brand_id=$2 AND o.operation_id=$3 LIMIT 2`;
async function recoverCommitted(
  tx: ProductLifecycleTransaction,
  command: CatalogProductPublicationResolutionCommand,
): Promise<string | null> {
  const c = command.originalCommand;
  if (command.originalKind === "WarningAcknowledgementV1") {
    const receipt = await recoverProductPublicationWarningAcknowledgement(tx, c);
    return receipt?.recordedAt ?? null;
  }
  const found = rows(
    await tx.query(publicationSql, [
      c.tenantReference,
      c.brandReference,
      c.operationReference,
      c.productReference,
      c.versionReference,
      c.action,
    ]),
  );
  if (found.length === 0) return null;
  const row = closed(found[0], [
    "action_code",
    "intent_digest",
    "publication",
    "aggregate",
    "coherent",
  ]);
  if (row.action_code !== "ProductPublication" || row.intent_digest !== hash(c))
    return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  if (row.coherent !== true || row.publication === null || row.aggregate === null) return fail();
  const publication =
    command.originalKind === "PublicationV2"
      ? recoverCatalogProductPublicationV2(c, row.publication)
      : recoverCatalogProductPublication(c, row.publication);
  const aggregate = parseProductAggregate(copyCategoryPersistenceValue(row.aggregate));
  if (
    publication.actorReference !== c.actorReference ||
    publication.actorKind !== "User" ||
    publication.productAggregateVersion !== c.expectedProductAggregateVersion ||
    aggregate.productReference !== c.productReference ||
    aggregate.brandReference !== c.brandReference ||
    aggregate.aggregateVersion !== publication.productAggregateVersion + 1 ||
    aggregate.updatedAt !== publication.occurredAt
  )
    return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  return publication.occurredAt;
}
const fenceSql = `SELECT command_json command,snapshot_json resolution,
 (original_kind=command_json->>'originalKind' AND operation_namespace=$1
 AND tenant_id=$4 AND brand_id=$2 AND operation_id=$3
 AND product_id::text=snapshot_json->>'productReference' AND product_version_id::text=snapshot_json->>'versionReference'
 AND actor_id::text=snapshot_json->>'actorReference' AND intent_digest=snapshot_json->>'originalIntentDigest'
 AND resolution_digest=snapshot_json->>'digest' AND snapshot_json->>'outcome'='Abandoned'
 AND recorded_at= (snapshot_json->>'recordedAt')::timestamptz AND data_classification='ConfigurationMetadata') IS TRUE coherent
 FROM rms_catalog.product_publication_operation_abandonment
 WHERE operation_namespace=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2`;

/** Authenticated original-outcome resolution. It never executes an original
 * command, refreshes qualification, or changes a Product root/head/report. */
export function createPostgresProductPublicationResolutionStore(
  options: ProductPublicationResolutionStoreOptions,
) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.audit?.create !== "function"
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    auditFor = options.audit.create.bind(options.audit),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    async execute(value: unknown): Promise<ProductPublicationResolutionWriteResult> {
      let command: CatalogProductPublicationResolutionCommand | undefined, captureError: unknown;
      try {
        command = parseCatalogProductPublicationResolutionCommand(value);
      } catch (error) {
        captureError = error;
      }
      let transaction: ProductLifecycleTransaction | undefined,
        entered = false,
        calls = 0,
        completed: ProductPublicationResolutionWriteResult | undefined;
      try {
        const result = await run(async (tx) => {
          if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return fail();
          transaction = tx;
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
            failed.add(tx);
            return fail();
          }
          active.add(tx);
          entered = true;
          const originalQuery = tx.query,
            capturedQuery = originalQuery.bind(tx);
          let ready = false,
            guardCalls = 0,
            observedAt = "",
            latest = "",
            deadline = "";
          const poison = (): never => {
            failed.add(tx);
            return fail();
          };
          const check = (): string => {
            try {
              const now = parseCatalogInstant(clock());
              if (
                failed.has(tx) ||
                tx.query !== originalQuery ||
                !deadline ||
                now < latest ||
                now >= deadline
              )
                return poison();
              latest = now;
              return now;
            } catch {
              return poison();
            }
          };
          const query: ProductLifecycleTransaction["query"] = async <Row>(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            try {
              const result = await capturedQuery<Row>(sql, values);
              check();
              return result;
            } catch (error) {
              failed.add(tx);
              throw error;
            }
          };
          const authorize = async () => {
            if (!command) return poison();
            check();
            if (
              (await hold(
                tx,
                Object.freeze({
                  tenantReference,
                  brandReference,
                  actorReference,
                  actorKind: "User" as const,
                  command,
                  purposeCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_RESOLUTION" as const,
                  permission: "catalog.manage" as const,
                  requiredPermissions: permissions,
                  requiredScope: "FullBrandScope" as const,
                  requiredFields: productPublicationResolutionFields,
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          try {
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1 || !ready) return poison();
                    await authorize();
                    check();
                  } catch (error) {
                    failed.add(tx);
                    throw error;
                  }
                },
                () => {
                  if (guardCalls !== 1 || !ready) return poison();
                  check();
                },
              )) !== undefined
            )
              return poison();
            if (!command) throw captureError;
            observedAt = latest = parseCatalogInstant(clock());
            deadline = new Date(Date.parse(observedAt) + 5000).toISOString();
            const c = command.originalCommand;
            if (
              c.tenantReference !== tenantReference ||
              c.brandReference !== brandReference ||
              c.actorReference !== actorReference ||
              c.actorKind !== "User"
            )
              return fail("CATALOG_PERMISSION_DENIED");
            await authorize();
            const isolation = rows(
              await query("SELECT current_setting('transaction_isolation') AS isolation", []),
            );
            if (
              isolation.length !== 1 ||
              closed(isolation[0], ["isolation"]).isolation !== "read committed"
            )
              return poison();
            await query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
              [tenantReference, brandReference],
            );
            await holdProductSourceBarrier({ query }, brandReference);
            const namespace = catalogProductPublicationResolutionNamespace(command.originalKind);
            await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              namespace + ":" + brandReference + ":" + c.operationReference,
            ]);
            const current = rows(
              await query(
                "SELECT aggregate_version FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2 FOR SHARE",
                [brandReference, c.productReference],
              ),
            );
            if (current.length !== 1) return fail("CATALOG_UNAVAILABLE");
            const currentAggregateVersion = closed(current[0], [
              "aggregate_version",
            ]).aggregate_version;
            if (
              typeof currentAggregateVersion !== "number" ||
              !Number.isInteger(currentAggregateVersion) ||
              currentAggregateVersion < 1 ||
              currentAggregateVersion > 2147483647
            )
              return poison();
            const committedAt = await recoverCommitted({ query }, command);
            check();
            if (committedAt !== null) {
              const resolution = buildCatalogProductPublicationResolution(
                command,
                "Committed",
                committedAt,
              );
              await authorize();
              ready = true;
              completed = Object.freeze({ resolution, currentAggregateVersion });
              return completed;
            }
            const found = rows(
              await query(fenceSql, [
                namespace,
                brandReference,
                c.operationReference,
                tenantReference,
              ]),
            );
            if (found.length !== 0) {
              const row = closed(found[0], ["command", "resolution", "coherent"]);
              if (row.coherent !== true) return poison();
              const original = parseCatalogProductPublicationResolutionCommand(row.command),
                resolution = parseCatalogProductPublicationResolution(row.resolution);
              if (
                canonicalizeRfc8785(original) !== canonicalizeRfc8785(command) ||
                canonicalizeRfc8785(
                  buildCatalogProductPublicationResolution(
                    command,
                    "Abandoned",
                    resolution.recordedAt,
                  ),
                ) !== canonicalizeRfc8785(resolution)
              )
                return fail("CATALOG_IDEMPOTENCY_CONFLICT");
              await authorize();
              ready = true;
              completed = Object.freeze({ resolution, currentAggregateVersion });
              return completed;
            }
            const resolution = buildCatalogProductPublicationResolution(
                command,
                "Abandoned",
                check(),
              ),
              audit = validateAuditRecord(
                copyCategoryPersistenceValue(auditFor({ command, resolution })),
                Date.parse(check()),
              );
            if (
              audit.actor.type !== "User" ||
              audit.actor.reference !== actorReference ||
              audit.brandId !== brandReference ||
              audit.storeId !== undefined ||
              audit.actionCode !== "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED" ||
              audit.targetType !== "ProductPublicationOperation" ||
              audit.targetId !== c.operationReference ||
              audit.reasonCode !== "ORIGINAL_OPERATION_ABANDONED" ||
              audit.occurredAt !== resolution.recordedAt
            )
              return poison();
            await authorize();
            await query("SAVEPOINT catalog_product_publication_resolution", []);
            try {
              const inserted = await query(
                `INSERT INTO rms_catalog.product_publication_operation_abandonment
 (operation_namespace,operation_id,tenant_id,brand_id,product_id,product_version_id,actor_id,original_kind,intent_digest,resolution_digest,recorded_at,command_json,snapshot_json,audit_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
                [
                  namespace,
                  c.operationReference,
                  tenantReference,
                  brandReference,
                  c.productReference,
                  c.versionReference,
                  actorReference,
                  command.originalKind,
                  resolution.originalIntentDigest,
                  resolution.digest,
                  resolution.recordedAt,
                  canonicalizeRfc8785(command),
                  canonicalizeRfc8785(resolution),
                  audit.auditId,
                ],
              );
              if (Object.getOwnPropertyDescriptor(inserted, "rowCount")?.value !== 1)
                return poison();
              await appendAuditRecordInTransaction({ query }, audit);
              check();
              await authorize();
              check();
            } catch (error) {
              failed.add(tx);
              await capturedQuery(
                "ROLLBACK TO SAVEPOINT catalog_product_publication_resolution",
                [],
              );
              await capturedQuery("RELEASE SAVEPOINT catalog_product_publication_resolution", []);
              throw error;
            }
            await query("RELEASE SAVEPOINT catalog_product_publication_resolution", []);
            ready = true;
            completed = Object.freeze({ resolution, currentAggregateVersion });
            return completed;
          } catch (error) {
            failed.add(tx);
            throw error;
          }
        });
        if (
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !transaction ||
          failed.has(transaction)
        )
          return fail();
        return result;
      } catch (error) {
        if (transaction) failed.add(transaction);
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        if (transaction && entered) active.delete(transaction);
      }
    },
  });
}

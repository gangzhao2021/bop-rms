import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { appendEventInTransaction, type DomainEventEnvelope } from "@bop/eventing";
import {
  categorySourceRevision,
  categorySourceEventDigest,
  parseCategorySourceEvent,
} from "../../contracts/category-source.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogCode,
  type CatalogReference,
} from "../../contracts/product.js";
import {
  copyCategoryPersistenceValue,
  parseCategoryOperationRecord,
  validateCategoryPersistenceWrite,
  validateCategoryTreeSnapshot,
  parseCategoryPersistenceWrite,
} from "../../contracts/category-persistence.js";
import { parseCategoryAggregate, type CategoryAggregate } from "../../domain/category-menu.js";
import type {
  CategoryRepositoryPort,
  CategoryOperationRecord,
} from "../../application/ports/category-menu-ports.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";

export const categoryPersistenceFields = Object.freeze([
  "categoryReference",
  "brandReference",
  "internalCode",
  "lifecycle",
  "aggregateVersion",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "parentCategoryReference",
  "level",
  "sortOrder",
  "storeReferences",
  "createdAt",
  "createdByActorReference",
  "updatedAt",
] as const);
export interface CategoryPersistenceAuthority {
  /** ALL current Tenant/Brand/Actor/purpose/field/Phase fences held through outer
   * COMMIT, including current public Store validation for record.storeReferences.
   * This callback cannot grant facts or infer Store membership from a record. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_CATEGORY_PERSISTENCE";
      readonly permission: "catalog.manage";
      readonly domainPermission: "catalog.category.manage";
      readonly capability: "catalog.cat_category_tree";
      readonly requiredFields: typeof categoryPersistenceFields;
      readonly observedAt: string;
      readonly categoryReference: string | null;
      readonly record: CategoryOperationRecord | null;
    },
  ): Promise<void>;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const categorySnapshotSelectSql = `SELECT jsonb_build_object(
 'categoryReference',c.category_id,'brandReference',c.brand_id,'internalCode',c.internal_code,
 'lifecycle',c.lifecycle,'aggregateVersion',c.aggregate_version,'defaultLocale',c.default_locale,
 'localizedNames',c.localized_names_json,'localizedDescriptions',c.localized_descriptions_json,
 'parentCategoryReference',c.parent_category_id,'level',c.tree_level,'sortOrder',c.sort_order,
 'storeReferences',c.store_ids_json,'createdAt',${utc("c.created_at")},'createdByActorReference',c.created_by_actor_id,'updatedAt',${utc("c.updated_at")}) snapshot,
 (date_trunc('milliseconds',c.created_at)=c.created_at AND date_trunc('milliseconds',c.updated_at)=c.updated_at) precise
 FROM rms_catalog.category c WHERE c.brand_id=$1`;
/** A snapshot established before waiting for the Brand barrier is stale under
 * repeatable-read/serializable. Require statement-current owner reads. */
export async function requireCategoryCurrentReads(tx: Transaction): Promise<void> {
  const result = await rows(tx, "SELECT current_setting('transaction_isolation') isolation", []);
  if (result.length !== 1 || result[0]?.isolation !== "read committed") return fail();
}
export async function holdCategorySourceBarrier(
  tx: Transaction,
  brandReference: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "CatalogCategorySource:" + parseCatalogReference(brandReference),
  ]);
}
async function rows(tx: Transaction, sql: string, values: readonly unknown[]) {
  const result = await tx.query(sql, values),
    descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) return fail();
  return descriptor.value as readonly Record<string, unknown>[];
}
const ensureOne = async (tx: Transaction, sql: string, values: readonly unknown[]) => {
  const result = await tx.query(sql, values);
  if (result.rowCount !== 1) return fail();
};
function snapshot(value: unknown, brand: string, at: string): CategoryAggregate {
  try {
    const r = copyCategoryPersistenceValue(value) as Record<string, unknown>;
    if (!r || Object.keys(r).length !== 2 || r.precise !== true) return fail();
    const node = parseCategoryAggregate(r.snapshot);
    if (
      node.brandReference !== brand ||
      node.updatedAt > at ||
      canonicalizeRfc8785(node) !== canonicalizeRfc8785(r.snapshot)
    )
      return fail();
    return node;
  } catch {
    return fail();
  }
}
function readInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = copyCategoryPersistenceValue(value);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    return fail("CATALOG_INPUT_INVALID");
  return input as Record<string, unknown>;
}
function mapFailure(error: unknown): never {
  if (error instanceof CatalogError) throw error;
  if (error && typeof error === "object") {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value,
      constraint = Object.getOwnPropertyDescriptor(error, "constraint")?.value;
    if (code === "23505" && constraint === "category_brand_code_unique")
      return fail("CATALOG_CODE_CONFLICT");
    if (
      code === "23505" &&
      (constraint === "category_root_sort_unique" || constraint === "category_child_sort_unique")
    )
      return fail("CATALOG_LIFECYCLE_CONFLICT");
    if (code === "23505" && constraint === "category_operation_record_pkey")
      return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  }
  return fail();
}
/** Only owner tables, with real current authority and original result replay.
 * Full public source feed and normal route activation are separate consumers. */
export function createPostgresCategoryRepository(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CategoryPersistenceAuthority;
  readonly clock: { now(): string };
  readonly eventReference: () => string;
  readonly maximumCategoryNodes: number;
}): CategoryRepositoryPort {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    !Number.isSafeInteger(options.maximumCategoryNodes) ||
    options.maximumCategoryNodes < 1 ||
    options.maximumCategoryNodes > 1_000_000
  )
    return fail("CATALOG_INPUT_INVALID");
  const authorize = async (
    tx: Transaction,
    category: string | null,
    record: CategoryOperationRecord | null = null,
  ) => {
    const at = parseCatalogInstant(options.clock.now());
    await options.authority.holdUntilTransactionCompletes(
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        purposeCode: "CATALOG_CATEGORY_PERSISTENCE",
        permission: "catalog.manage",
        domainPermission: "catalog.category.manage",
        capability: "catalog.cat_category_tree",
        requiredFields: categoryPersistenceFields,
        observedAt: at,
        categoryReference: category,
        record,
      }),
    );
    await tx.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
      [brand],
    );
    await holdCategorySourceBarrier(tx, brand);
    await requireCategoryCurrentReads(tx);
    return at;
  };
  const run = async <T>(
    category: string | null,
    work: (tx: Transaction, at: string) => Promise<T>,
    finalCheck = true,
  ) => {
    try {
      return await options.transactions.run(async (tx) => {
        const at = await authorize(tx, category),
          result = await work(tx, at);
        if (finalCheck) await authorize(tx, category);
        return result;
      });
    } catch (error) {
      return mapFailure(error);
    }
  };
  const load = async (tx: Transaction, category: string, at: string) => {
    const found = await rows(tx, categorySnapshotSelectSql + " AND c.category_id=$2", [
      brand,
      category,
    ]);
    if (found.length === 0) return null;
    if (found.length !== 1) return fail();
    const node = snapshot(found[0], brand, at);
    if (node.categoryReference !== category) return fail();
    return node;
  };
  const tree = async (tx: Transaction, at: string) => {
    const found = await rows(tx, categorySnapshotSelectSql + " ORDER BY c.category_id LIMIT $2", [
      brand,
      options.maximumCategoryNodes + 1,
    ]);
    try {
      return validateCategoryTreeSnapshot(
        found.map((value) => snapshot(value, brand, at)),
        brand,
        options.maximumCategoryNodes,
      );
    } catch {
      return fail();
    }
  };
  const replay = async (
    tx: Transaction,
    operation: string,
    at: string,
  ): Promise<CategoryOperationRecord | null> => {
    const found = await rows(
      tx,
      `SELECT r.category_id,r.action_code,r.intent_digest,r.result_aggregate_version,${utc("r.occurred_at")} occurred_at,
      s.snapshot_json,s.snapshot_digest,c.source_revision::text source_revision,c.event_id,c.event_type,c.actor_id,c.correlation_id,c.event_digest,
      (date_trunc('milliseconds',r.occurred_at)=r.occurred_at) precise
      FROM rms_catalog.category_operation_record r
      LEFT JOIN rms_catalog.category_operation_snapshot s ON s.operation_id=r.operation_id AND s.brand_id=r.brand_id
      LEFT JOIN rms_catalog.category_source_commit c ON c.operation_id=s.operation_id AND c.brand_id=s.brand_id
      WHERE r.brand_id=$1 AND r.operation_id=$2`,
      [brand, operation],
    );
    if (found.length === 0) return null;
    if (found.length !== 1 || !found[0]) return fail();
    const r = copyCategoryPersistenceValue(found[0]) as Record<string, unknown>;
    if (
      r.precise !== true ||
      typeof r.intent_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(r.intent_digest)
    )
      return fail();
    let prior: CategoryOperationRecord;
    try {
      prior = parseCategoryOperationRecord({
        action: r.action_code,
        operationReference: operation,
        operationIntentHash: r.intent_digest.slice(7),
        aggregate: r.snapshot_json,
      });
    } catch {
      return fail();
    }
    if (
      prior.aggregate.brandReference !== brand ||
      prior.aggregate.categoryReference !== r.category_id ||
      prior.aggregate.aggregateVersion !== r.result_aggregate_version ||
      prior.aggregate.updatedAt !== r.occurred_at ||
      prior.aggregate.updatedAt > at ||
      digest(prior.aggregate) !== r.snapshot_digest ||
      categorySourceRevision(r.source_revision) === "0"
    )
      return fail();
    const sourceRevision = categorySourceRevision(r.source_revision);
    const event = parseCategorySourceEvent({
      eventId: parseCatalogReference(r.event_id),
      eventType: String(r.event_type),
      schemaVersion: 1,
      occurredAt: prior.aggregate.updatedAt,
      producerModule: "@rms/catalog",
      tenantId: brand,
      aggregateType: "Category",
      aggregateId: prior.aggregate.categoryReference,
      aggregateVersion: BigInt(prior.aggregate.aggregateVersion),
      correlationId: parseCatalogReference(r.correlation_id),
      causationId: prior.operationReference,
      actor: { type: "Actor", actorId: parseCatalogReference(r.actor_id) },
      payload: {
        categoryReference: prior.aggregate.categoryReference,
        aggregateVersion: String(prior.aggregate.aggregateVersion),
        lifecycle: prior.aggregate.lifecycle,
        operationReference: prior.operationReference,
        sourceRevision,
        snapshotDigest: digest(prior.aggregate),
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    if (
      ![
        "CategoryCreated",
        "CategoryUpdated",
        "CategoryMoved",
        "CategoryReordered",
        "CategoryDeactivated",
        "CategoryArchived",
        "CategoryRestored",
      ].includes(event.eventType) ||
      categorySourceEventDigest(event) !== r.event_digest
    )
      return fail();
    await authorize(tx, prior.aggregate.categoryReference);
    return prior;
  };
  const inspect = (
    nodes: readonly CategoryAggregate[],
    category: string,
    parent: string | null,
    sortOrder: number,
  ) => {
    const node = nodes.find((item) => item.categoryReference === category),
      parentNode =
        parent === null ? null : (nodes.find((item) => item.categoryReference === parent) ?? null);
    if (parent !== null && parentNode === null) return fail("CATALOG_LIFECYCLE_CONFLICT");
    const ancestors: CatalogReference[] = [];
    let ancestor = parentNode;
    while (ancestor) {
      ancestors.push(ancestor.categoryReference);
      ancestor =
        ancestor.parentCategoryReference === null
          ? null
          : (nodes.find((item) => item.categoryReference === ancestor?.parentCategoryReference) ??
            null);
    }
    const descendants = new Set([category]);
    let maximumLevel: number = node?.level ?? 1;
    for (let depth = 0; depth < 3; depth++)
      for (const item of nodes)
        if (
          item.parentCategoryReference !== null &&
          descendants.has(item.parentCategoryReference)
        ) {
          descendants.add(item.categoryReference);
          maximumLevel = Math.max(maximumLevel, item.level);
        }
    return Object.freeze({
      parent: parentNode,
      ancestorReferences: Object.freeze(ancestors),
      subtreeDepth: node ? maximumLevel - node.level + 1 : 1,
      siblingSortAvailable: !nodes.some(
        (item) =>
          item.categoryReference !== category &&
          item.parentCategoryReference === parent &&
          item.sortOrder === sortOrder,
      ),
      hasActiveChildren: nodes.some(
        (item) => item.parentCategoryReference === category && item.lifecycle === "Active",
      ),
    });
  };
  const write = async (value: unknown, create: boolean): Promise<CategoryOperationRecord> => {
    let input: Record<string, unknown>, record: CategoryOperationRecord;
    try {
      input = copyCategoryPersistenceValue(value) as Record<string, unknown>;
      if (
        !input ||
        Object.keys(input).length !== (create ? 2 : 3) ||
        !Object.hasOwn(input, "record") ||
        !Object.hasOwn(input, "audit") ||
        (!create && !Object.hasOwn(input, "expectedAggregateVersion"))
      )
        return fail("CATALOG_INPUT_INVALID");
      record = parseCategoryOperationRecord(input.record);
      if (create !== (record.action === "Create")) return fail("CATALOG_INPUT_INVALID");
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return fail("CATALOG_INPUT_INVALID");
    }
    if (record.aggregate.brandReference !== brand) return fail("CATALOG_PERMISSION_DENIED");
    return run(
      record.aggregate.categoryReference,
      async (tx, at) => {
        await tx.query("SAVEPOINT wp2408_category_write", []);
        try {
          await authorize(tx, record.aggregate.categoryReference, record);
          parseCategoryPersistenceWrite(
            {
              record,
              expectedAggregateVersion: create ? null : input.expectedAggregateVersion,
              audit: input.audit,
            },
            { brandReference: brand, actorReference: actor, observedAt: at },
          );
          const previous = await replay(tx, record.operationReference, at);
          if (previous) {
            if (
              previous.action !== record.action ||
              previous.operationIntentHash !== record.operationIntentHash ||
              (!create &&
                previous.aggregate.categoryReference !== record.aggregate.categoryReference)
            )
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            await authorize(tx, previous.aggregate.categoryReference, previous);
            await tx.query("RELEASE SAVEPOINT wp2408_category_write", []);
            return previous;
          }
          const nodes = await tree(tx, at),
            current =
              nodes.find((item) => item.categoryReference === record.aggregate.categoryReference) ??
              null;
          const validated = validateCategoryPersistenceWrite(
            {
              record,
              expectedAggregateVersion: create ? null : input.expectedAggregateVersion,
              audit: input.audit,
            },
            current,
            { brandReference: brand, actorReference: actor, observedAt: at },
          );
          const next = validated.record.aggregate,
            view = inspect(
              nodes,
              next.categoryReference,
              next.parentCategoryReference,
              next.sortOrder,
            );
          if (
            !view.siblingSortAvailable ||
            view.ancestorReferences.includes(next.categoryReference) ||
            (current &&
              validated.record.action === "Move" &&
              view.subtreeDepth > 1 &&
              next.level !== current.level)
          )
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          if (
            nodes.some(
              (node) =>
                node.categoryReference !== next.categoryReference &&
                node.internalCode === next.internalCode,
            )
          )
            return fail("CATALOG_CODE_CONFLICT");
          const nextNodes = [
            ...nodes.filter((node) => node.categoryReference !== next.categoryReference),
            next,
          ];
          if (nextNodes.length > options.maximumCategoryNodes) return fail();
          try {
            validateCategoryTreeSnapshot(nextNodes, brand, options.maximumCategoryNodes);
          } catch {
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          }
          if (create)
            await ensureOne(
              tx,
              "INSERT INTO rms_catalog.category(category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,localized_names_json,localized_descriptions_json,parent_category_id,tree_level,sort_order,store_ids_json,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15)",
              [
                next.categoryReference,
                brand,
                next.internalCode,
                next.lifecycle,
                next.aggregateVersion,
                next.defaultLocale,
                JSON.stringify(next.localizedNames),
                JSON.stringify(next.localizedDescriptions),
                next.parentCategoryReference,
                next.level,
                next.sortOrder,
                JSON.stringify(next.storeReferences),
                next.createdAt,
                next.createdByActorReference,
                next.updatedAt,
              ],
            );
          else {
            const result = await tx.query(
              "UPDATE rms_catalog.category SET lifecycle=$3,parent_category_id=$4,tree_level=$5,sort_order=$6,aggregate_version=$7,updated_at=$8 WHERE brand_id=$1 AND category_id=$2 AND aggregate_version=$9",
              [
                brand,
                next.categoryReference,
                next.lifecycle,
                next.parentCategoryReference,
                next.level,
                next.sortOrder,
                next.aggregateVersion,
                next.updatedAt,
                validated.expectedAggregateVersion,
              ],
            );
            if (result.rowCount !== 1) return fail("CATALOG_VERSION_CONFLICT");
          }
          await ensureOne(
            tx,
            "INSERT INTO rms_catalog.category_operation_record(operation_id,brand_id,category_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              record.operationReference,
              brand,
              next.categoryReference,
              record.action,
              "sha256:" + record.operationIntentHash,
              next.aggregateVersion,
              next.updatedAt,
            ],
          );
          await ensureOne(
            tx,
            "INSERT INTO rms_catalog.category_operation_snapshot(operation_id,brand_id,category_id,result_aggregate_version,occurred_at,snapshot_json,snapshot_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
            [
              record.operationReference,
              brand,
              next.categoryReference,
              next.aggregateVersion,
              next.updatedAt,
              JSON.stringify(next),
              validated.snapshotDigest,
            ],
          );
          await appendAuditRecordInTransaction(tx, validated.audit);
          const revisionRows = await rows(
            tx,
            "INSERT INTO rms_catalog.category_source_head(brand_id,source_revision) VALUES($1,1) ON CONFLICT(brand_id) DO UPDATE SET source_revision=rms_catalog.category_source_head.source_revision+1 RETURNING source_revision::text source_revision",
            [brand],
          );
          if (revisionRows.length !== 1) return fail();
          const revision = categorySourceRevision(revisionRows[0]?.source_revision);
          if (revision === "0") return fail();
          const event: DomainEventEnvelope = parseCategorySourceEvent({
            eventId: parseCatalogReference(options.eventReference()),
            eventType: validated.eventType,
            schemaVersion: 1,
            occurredAt: next.updatedAt,
            producerModule: "@rms/catalog",
            tenantId: brand,
            aggregateType: "Category",
            aggregateId: next.categoryReference,
            aggregateVersion: BigInt(next.aggregateVersion),
            correlationId: validated.audit.correlationId,
            causationId: record.operationReference,
            actor: { type: "Actor", actorId: actor },
            payload: {
              categoryReference: next.categoryReference,
              aggregateVersion: String(next.aggregateVersion),
              lifecycle: next.lifecycle,
              operationReference: record.operationReference,
              sourceRevision: revision,
              snapshotDigest: validated.snapshotDigest,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: { replaySafe: true },
          });
          await appendEventInTransaction(
            {
              query: async (sql, values) => {
                const result = await tx.query(sql, values);
                return { rowCount: result.rowCount ?? null };
              },
            },
            event,
          );
          await ensureOne(
            tx,
            "INSERT INTO rms_catalog.category_source_commit(operation_id,brand_id,category_id,result_aggregate_version,occurred_at,snapshot_digest,source_revision,event_id,event_type,actor_id,correlation_id,event_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            [
              record.operationReference,
              brand,
              next.categoryReference,
              next.aggregateVersion,
              next.updatedAt,
              validated.snapshotDigest,
              revision,
              event.eventId,
              event.eventType,
              actor,
              event.correlationId,
              categorySourceEventDigest(event),
            ],
          );
          await authorize(tx, next.categoryReference, record);
          await tx.query("RELEASE SAVEPOINT wp2408_category_write", []);
          return record;
        } catch (error) {
          try {
            await tx.query("ROLLBACK TO SAVEPOINT wp2408_category_write", []);
            await tx.query("RELEASE SAVEPOINT wp2408_category_write", []);
          } catch {
            return fail();
          }
          return mapFailure(error);
        }
      },
      false,
    );
  };
  const repository: CategoryRepositoryPort = {
    async resolveOperation(operation) {
      return run(null, (tx, at) => replay(tx, parseCatalogReference(operation), at));
    },
    async load(category) {
      const ref = parseCatalogReference(category);
      return run(ref, (tx, at) => load(tx, ref, at));
    },
    async codeAvailable(rawValue) {
      const value = readInput(rawValue, [
        "brandReference",
        "internalCode",
        "excludingCategoryReference",
      ]);
      const brandValue = parseCatalogReference(value.brandReference),
        code = parseCatalogCode(value.internalCode),
        except =
          value.excludingCategoryReference === null
            ? null
            : parseCatalogReference(value.excludingCategoryReference);
      if (brandValue !== brand) return fail("CATALOG_PERMISSION_DENIED");
      return run(
        except,
        async (tx, at) =>
          !(await tree(tx, at)).some(
            (node) => node.internalCode === code && node.categoryReference !== except,
          ),
      );
    },
    async inspectMove(rawValue) {
      const value = readInput(rawValue, [
        "categoryReference",
        "brandReference",
        "parentCategoryReference",
        "sortOrder",
      ]);
      const category = parseCatalogReference(value.categoryReference),
        parent =
          value.parentCategoryReference === null
            ? null
            : parseCatalogReference(value.parentCategoryReference);
      if (parseCatalogReference(value.brandReference) !== brand)
        return fail("CATALOG_PERMISSION_DENIED");
      if (
        !Number.isSafeInteger(value.sortOrder) ||
        typeof value.sortOrder !== "number" ||
        value.sortOrder < 0 ||
        value.sortOrder > 2147483647
      )
        return fail("CATALOG_INPUT_INVALID");
      const sortOrder = value.sortOrder as number;
      return run(category, async (tx, at) =>
        inspect(await tree(tx, at), category, parent, sortOrder),
      );
    },
    create: (value) => write(value, true),
    commit: (value) => write(value, false),
  };
  return Object.freeze(repository);
}

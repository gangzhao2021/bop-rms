import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  copyCategoryPersistenceValue,
  parseCategoryOperationRecord,
  validateCategoryTreeSnapshot,
} from "../../contracts/category-persistence.js";
import {
  categorySourceDigest,
  categorySourceRevision,
  categorySourceEventDigest,
  parseCategorySourceEvent,
  type CategorySourcePort,
  type CategorySourceSnapshot,
} from "../../contracts/category-source.js";
import {
  parseCategoryAggregate,
  transitionCategoryLifecycle,
  type CategoryAggregate,
} from "../../domain/category-menu.js";
import {
  categoryPersistenceFields,
  categorySnapshotSelectSql,
  holdCategorySourceBarrier,
  requireCategoryCurrentReads,
} from "./category-repository.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
/** Hold current Tenant/Brand/Actor/purpose/permission, full-field and Phase
 * leases through outer COMMIT. Include current Store-context membership for
 * Brand authority; never infer a grant from caller-supplied source facts. */
export type CategorySourceReadCapability =
  "catalog.cat_category_tree" | "catalog.cat_product_create" | "catalog.cat_product_edit";
export interface CategorySourceAuthority {
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_CATEGORY_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly capability: CategorySourceReadCapability;
      readonly requiredFields: typeof categoryPersistenceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
async function rows(
  tx: Transaction,
  sql: string,
  values: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  const result = await tx.query(sql, values),
    d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value)) return fail();
  return d.value as readonly Record<string, unknown>[];
}
const historySql = `SELECT r.operation_id,r.category_id,r.action_code,r.intent_digest,r.result_aggregate_version,
 to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') occurred_at,
 (date_trunc('milliseconds',r.occurred_at)=r.occurred_at) precise,s.snapshot_json,s.snapshot_digest,
 c.source_revision::text source_revision,c.event_id,c.event_type,c.actor_id,c.correlation_id,c.event_digest
 FROM rms_catalog.category_operation_record r
 LEFT JOIN rms_catalog.category_operation_snapshot s ON s.operation_id=r.operation_id AND s.brand_id=r.brand_id
 LEFT JOIN rms_catalog.category_source_commit c ON c.operation_id=s.operation_id AND c.brand_id=s.brand_id
 WHERE r.brand_id=$1 ORDER BY c.source_revision NULLS FIRST LIMIT $2`;
/** Complete owner source, never a filtered UI list. No public generation can be
 * claimed while legacy or missing original receipts exist. Every participating
 * writer and reader holds the same Brand barrier through outer COMMIT. */
export function createPostgresCategorySourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CategorySourceAuthority;
  readonly readCapability?: CategorySourceReadCapability;
  readonly clock: { now(): string };
  readonly maximumCategoryNodes: number;
  readonly maximumSourceCommits: number;
}): CategorySourcePort {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  const readCapability =
    options.readCapability === undefined ? "catalog.cat_category_tree" : options.readCapability;
  if (
    ![
      "catalog.cat_category_tree",
      "catalog.cat_product_create",
      "catalog.cat_product_edit",
    ].includes(readCapability)
  )
    return fail();
  for (const maximum of [options.maximumCategoryNodes, options.maximumSourceCommits])
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) return fail();
  const authorize = async (tx: Transaction) => {
    const at = parseCatalogInstant(options.clock.now());
    await options.authority.holdUntilTransactionCompletes(
      tx,
      Object.freeze({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        purposeCode: "CATALOG_CATEGORY_SOURCE_READ",
        permission: "catalog.manage",
        capability: readCapability,
        requiredFields: categoryPersistenceFields,
        observedAt: at,
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
  const read = async (tx: Transaction, at: string) => {
    const headRows = await rows(
      tx,
      "SELECT source_revision::text source_revision FROM rms_catalog.category_source_head WHERE brand_id=$1",
      [brand],
    );
    if (headRows.length > 1) return fail();
    const revision =
      headRows.length === 0 ? "0" : categorySourceRevision(headRows[0]?.source_revision);
    if (headRows.length !== 0 && revision === "0") return fail();
    const rootRows = await rows(
      tx,
      categorySnapshotSelectSql + " ORDER BY c.category_id LIMIT $2",
      [brand, options.maximumCategoryNodes + 1],
    );
    if (rootRows.length > options.maximumCategoryNodes) return fail();
    const categories = validateCategoryTreeSnapshot(
      rootRows.map((value) => {
        const r = copyCategoryPersistenceValue(value) as Record<string, unknown>;
        if (Object.keys(r).length !== 2 || r.precise !== true) return fail();
        const node = parseCategoryAggregate(r.snapshot);
        if (node.updatedAt > at || !equal(node, r.snapshot)) return fail();
        return node;
      }),
      brand,
      options.maximumCategoryNodes,
    );
    const records = await rows(tx, historySql, [brand, options.maximumSourceCommits + 1]);
    if (
      records.length > options.maximumSourceCommits ||
      BigInt(records.length) !== BigInt(revision)
    )
      return fail();
    const latest = new Map<string, CategoryAggregate>(),
      proofs = new Map<
        string,
        { sourceRevision: string; snapshotDigest: string; eventDigest: string }
      >();
    for (let index = 0; index < records.length; index++) {
      const r = copyCategoryPersistenceValue(records[index]) as Record<string, unknown>;
      if (
        r.precise !== true ||
        r.source_revision !== String(index + 1) ||
        typeof r.intent_digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(r.intent_digest)
      )
        return fail();
      const operation = parseCategoryOperationRecord({
          action: r.action_code,
          operationReference: r.operation_id,
          operationIntentHash: r.intent_digest.slice(7),
          aggregate: r.snapshot_json,
        }),
        next = operation.aggregate,
        prior = latest.get(next.categoryReference);
      if (
        next.brandReference !== brand ||
        next.categoryReference !== r.category_id ||
        next.aggregateVersion !== r.result_aggregate_version ||
        next.updatedAt !== r.occurred_at ||
        next.updatedAt > at ||
        !equal(next, r.snapshot_json) ||
        categorySourceDigest(next) !== r.snapshot_digest
      )
        return fail();
      let expectedEvent: string;
      if (operation.action === "Create") {
        if (
          prior ||
          next.aggregateVersion !== 1 ||
          next.lifecycle !== "Draft" ||
          next.createdAt !== next.updatedAt ||
          next.createdByActorReference !== r.actor_id
        )
          return fail();
        expectedEvent = "CategoryCreated";
      } else {
        if (
          !prior ||
          next.aggregateVersion !== prior.aggregateVersion + 1 ||
          next.updatedAt < prior.updatedAt
        )
          return fail();
        const mutable = new Set([
          "aggregateVersion",
          "updatedAt",
          ...(operation.action === "Move"
            ? ["parentCategoryReference", "level", "sortOrder"]
            : ["lifecycle"]),
        ]);
        for (const key of Object.keys(prior) as (keyof CategoryAggregate)[])
          if (!mutable.has(key) && !equal(prior[key], next[key])) return fail();
        if (operation.action === "Move")
          expectedEvent =
            prior.parentCategoryReference === next.parentCategoryReference
              ? "CategoryReordered"
              : "CategoryMoved";
        else {
          transitionCategoryLifecycle(prior.lifecycle, next.lifecycle);
          expectedEvent =
            next.lifecycle === "Inactive"
              ? "CategoryDeactivated"
              : next.lifecycle === "Archived"
                ? "CategoryArchived"
                : prior.lifecycle === "Archived"
                  ? "CategoryRestored"
                  : "CategoryUpdated";
        }
      }
      if (expectedEvent !== r.event_type) return fail();
      const event = parseCategorySourceEvent({
        eventId: r.event_id,
        eventType: r.event_type,
        schemaVersion: 1,
        occurredAt: next.updatedAt,
        producerModule: "@rms/catalog",
        tenantId: brand,
        aggregateType: "Category",
        aggregateId: next.categoryReference,
        aggregateVersion: BigInt(next.aggregateVersion),
        correlationId: r.correlation_id,
        causationId: operation.operationReference,
        actor: { type: "Actor", actorId: r.actor_id },
        payload: {
          categoryReference: next.categoryReference,
          aggregateVersion: String(next.aggregateVersion),
          lifecycle: next.lifecycle,
          operationReference: operation.operationReference,
          sourceRevision: r.source_revision,
          snapshotDigest: r.snapshot_digest,
        },
        redactionClassification: "indirect_identifier",
        replayMetadata: { replaySafe: true },
      });
      if (categorySourceEventDigest(event) !== r.event_digest || proofs.has(event.eventId))
        return fail();
      latest.set(next.categoryReference, next);
      proofs.set(event.eventId, {
        sourceRevision: String(index + 1),
        snapshotDigest: categorySourceDigest(next),
        eventDigest: categorySourceEventDigest(event),
      });
    }
    if (
      latest.size !== categories.length ||
      categories.some(
        (category) => !equal(category, latest.get(category.categoryReference) ?? null),
      )
    )
      return fail();
    const snapshot: CategorySourceSnapshot = Object.freeze({
      brandReference: brand,
      sourceRevision: revision,
      observedAt: at,
      categories,
      sourceDigest: categorySourceDigest({
        brandReference: brand,
        sourceRevision: revision,
        categories,
      }),
    });
    return { snapshot, proofs };
  };
  const run = async <T>(work: (tx: Transaction, at: string) => Promise<T>): Promise<T> => {
    try {
      return await options.transactions.run(async (tx) => {
        const at = await authorize(tx),
          result = await work(tx, at);
        await authorize(tx);
        return result;
      });
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  };
  const source: CategorySourcePort = {
    loadSnapshot: () => run(async (tx, at) => (await read(tx, at)).snapshot),
    async proveEvent(value) {
      const event = parseCategorySourceEvent(value);
      if (event.tenantId !== brand) return fail();
      return run(async (tx, at) => {
        const proof = (await read(tx, at)).proofs.get(event.eventId);
        if (!proof || proof.eventDigest !== categorySourceEventDigest(event)) return fail();
        return Object.freeze({
          sourceRevision: proof.sourceRevision,
          snapshotDigest: proof.snapshotDigest,
        });
      });
    },
  };
  return Object.freeze(source);
}

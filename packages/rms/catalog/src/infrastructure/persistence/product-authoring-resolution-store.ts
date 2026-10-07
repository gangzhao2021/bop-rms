import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
} from "../../contracts/product.js";
import {
  buildCatalogProductAuthoringResolution,
  parseCatalogProductAuthoringResolution,
  parseCatalogProductAuthoringResolutionCommand,
  type CatalogProductAuthoringResolutionCommand,
  type CatalogProductAuthoringResolution,
} from "../../contracts/product-authoring-resolution.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";

export const productAuthoringResolutionFields = Object.freeze([
  "operationReference",
  "operationHistory",
  "operationResolution",
  "productReference",
  "versionReference",
  "aggregateVersion",
] as const);
const permissions = Object.freeze([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.product.history.read",
] as const);
export interface ProductAuthoringResolutionStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: ProductLifecycleTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: CatalogProductAuthoringResolutionCommand;
        readonly purposeCode: "CATALOG_PRODUCT_AUTHORING_OPERATION_RESOLUTION";
        readonly permission: "catalog.manage";
        readonly requiredPermissions: typeof permissions;
        readonly requiredFields: typeof productAuthoringResolutionFields;
        readonly requiredScope: "FullBrandScope";
        readonly actorKind: "User";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly audit: {
    create(input: {
      command: CatalogProductAuthoringResolutionCommand;
      resolution: CatalogProductAuthoringResolution;
    }): AppendAuditRecordInput;
  };
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return fail();
  return d.value.map((v: unknown) => {
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return fail();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      const field = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== "string" || !field?.enumerable || !("value" in field)) return fail();
      result[key] = field.value;
    }
    return result;
  });
}
const committedSql = `SELECT r.action_code,r.intent_digest,r.product_id,r.result_aggregate_version,r.occurred_at,c.actor_id,c.snapshot_digest,
 CASE WHEN octet_length(s.snapshot_json::text)<=8388608 THEN s.snapshot_json END aggregate,
 (s.brand_id=r.brand_id AND s.product_id=r.product_id AND s.result_aggregate_version=r.result_aggregate_version AND s.occurred_at=r.occurred_at
 AND c.brand_id=r.brand_id AND c.product_id=r.product_id AND c.result_aggregate_version=r.result_aggregate_version AND c.occurred_at=r.occurred_at
 AND c.event_type=CASE r.action_code WHEN 'Create' THEN 'ProductCreated' WHEN 'ReplaceDraft' THEN 'ProductDraftUpdated' ELSE '' END) coherent
 FROM rms_catalog.product_operation_record r
 LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=r.operation_id
 LEFT JOIN rms_catalog.product_source_commit c ON c.operation_id=r.operation_id
 WHERE r.brand_id=$1 AND r.operation_id=$2 LIMIT 2`;
/** Resolution consumes only an immutable original receipt. It never executes,
 * renews source qualification or mutates a Product root. Absence is terminal
 * only after the same owning operation fence and durable abandonment write. */
export function createPostgresProductAuthoringResolutionStore(
  options: ProductAuthoringResolutionStoreOptions,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.audit?.create !== "function"
  )
    return fail();
  const clock = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    register = options.registerBeforeCommit.bind(options),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    auditFor = options.audit.create.bind(options.audit),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async execute(value: unknown): Promise<CatalogProductAuthoringResolution> {
      const command = parseCatalogProductAuthoringResolutionCommand(value);
      if (
        command.tenantReference !== tenant ||
        command.brandReference !== brand ||
        command.actorReference !== actor
      )
        return fail("CATALOG_PERMISSION_DENIED");
      let calls = 0,
        completed: CatalogProductAuthoringResolution | undefined,
        txRef: ProductLifecycleTransaction | undefined;
      const result = await run(async (tx) => {
        txRef = tx;
        if (++calls !== 1 || active.has(tx) || failed.has(tx)) {
          failed.add(tx);
          return fail();
        }
        active.add(tx);
        const query = tx.query;
        let latest = Date.parse(parseCatalogInstant(clock()));
        const deadline = latest + 5000;
        let ready = false,
          finished = false;
        const check = () => {
          const at = Date.parse(parseCatalogInstant(clock()));
          if (
            failed.has(tx) ||
            tx.query !== query ||
            !Number.isFinite(at) ||
            at < latest ||
            at >= deadline
          ) {
            failed.add(tx);
            return fail();
          }
          latest = at;
        };
        const authorize = async () => {
          check();
          if (
            (await hold(tx, {
              command,
              purposeCode: "CATALOG_PRODUCT_AUTHORING_OPERATION_RESOLUTION",
              permission: "catalog.manage",
              requiredPermissions: permissions,
              requiredFields: productAuthoringResolutionFields,
              requiredScope: "FullBrandScope",
              actorKind: "User",
              observedAt: new Date(latest).toISOString(),
            })) !== undefined
          )
            return fail();
          check();
        };
        try {
          await register(
            tx,
            async () => {
              check();
              if (!ready || finished) return fail();
              await authorize();
            },
            () => {
              check();
              if (!ready || finished) return fail();
              finished = true;
            },
          );
          await authorize();
          const isolation = rows(
            await query.call(
              tx,
              "SELECT current_setting('transaction_isolation') AS isolation",
              [],
            ),
          );
          if (isolation.length !== 1 || isolation[0]?.isolation !== "read committed") return fail();
          await query.call(
            tx,
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenant, brand],
          );
          await holdProductSourceBarrier(tx, brand);
          await query.call(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogProductOperation:" + brand + ":" + command.operationReference,
          ]);
          check();
          const committed = rows(
            await query.call(tx, committedSql, [brand, command.operationReference]),
          );
          let resolution: CatalogProductAuthoringResolution;
          if (committed.length === 1) {
            const row = committed[0];
            if (
              !row ||
              row.coherent !== true ||
              row.actor_id !== actor ||
              row.action_code !== command.action
            )
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            const aggregate = parseProductAggregate(row.aggregate);
            if (
              aggregate.brandReference !== brand ||
              aggregate.productReference !== row.product_id ||
              aggregate.aggregateVersion !== row.result_aggregate_version ||
              !(row.occurred_at instanceof Date) ||
              aggregate.updatedAt !== row.occurred_at.toISOString() ||
              hash(aggregate) !== row.snapshot_digest
            )
              return fail();
            resolution = buildCatalogProductAuthoringResolution({
              outcome: "Committed",
              command,
              productReference: aggregate.productReference,
              versionReference: aggregate.draft.versionReference,
              aggregateVersion: aggregate.aggregateVersion,
              originalIntentDigest:
                typeof row.intent_digest === "string" ? row.intent_digest : null,
              recordedAt: aggregate.updatedAt,
            });
          } else {
            const fences = rows(
              await query.call(
                tx,
                "SELECT command_json command,snapshot_json resolution FROM rms_catalog.product_authoring_operation_abandonment WHERE brand_id=$1 AND operation_id=$2 LIMIT 2",
                [brand, command.operationReference],
              ),
            );
            if (fences.length === 1) {
              const stored = fences[0];
              if (!stored || canonicalizeRfc8785(stored.command) !== canonicalizeRfc8785(command))
                return fail("CATALOG_IDEMPOTENCY_CONFLICT");
              resolution = parseCatalogProductAuthoringResolution(stored.resolution);
              if (
                resolution.outcome !== "Abandoned" ||
                canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(command)
              )
                return fail();
            } else {
              resolution = buildCatalogProductAuthoringResolution({
                outcome: "Abandoned",
                command,
                productReference: command.productReference,
                versionReference: null,
                aggregateVersion: null,
                originalIntentDigest: null,
                recordedAt: new Date(latest).toISOString(),
              });
              const audit = validateAuditRecord(auditFor({ command, resolution }), latest);
              if (
                audit.brandId !== brand ||
                audit.storeId !== undefined ||
                audit.actor.type === "System" ||
                audit.actor.reference !== actor ||
                audit.actionCode !== "CATALOG_PRODUCT_AUTHORING_OPERATION_ABANDONED" ||
                audit.targetType !== "ProductAuthoringOperation" ||
                audit.targetId !== command.operationReference ||
                audit.reasonCode !== "ORIGINAL_OPERATION_ABANDONED" ||
                audit.occurredAt !== resolution.recordedAt
              )
                return fail("CATALOG_PERMISSION_DENIED");
              await authorize();
              const inserted = await query.call(
                tx,
                "INSERT INTO rms_catalog.product_authoring_operation_abandonment(operation_id,tenant_id,brand_id,actor_id,action_code,product_id,expected_aggregate_version,command_json,snapshot_json,resolution_digest,recorded_at,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)",
                [
                  command.operationReference,
                  tenant,
                  brand,
                  actor,
                  command.action,
                  command.productReference,
                  command.expectedAggregateVersion,
                  canonicalizeRfc8785(command),
                  canonicalizeRfc8785(resolution),
                  resolution.digest,
                  resolution.recordedAt,
                  audit.auditId,
                ],
              );
              if (Object.getOwnPropertyDescriptor(inserted, "rowCount")?.value !== 1) return fail();
              await appendAuditRecordInTransaction(tx, audit);
            }
          }
          await authorize();
          ready = true;
          completed = resolution;
          return resolution;
        } catch (error) {
          failed.add(tx);
          throw error;
        } finally {
          active.delete(tx);
        }
      });
      if (!completed || result !== completed || calls !== 1 || !txRef || failed.has(txRef))
        return fail();
      return parseCatalogProductAuthoringResolution(result);
    },
  });
}

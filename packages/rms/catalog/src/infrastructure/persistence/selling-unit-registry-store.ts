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
  parseCatalogHash,
  parseCatalogCode,
  parseCatalogDecimal,
  parseProductAggregate,
  type ProductAggregate,
} from "../../contracts/product.js";
import {
  parseCatalogSellingUnitRegistryCommand,
  parseCatalogSellingUnitRegistry,
  catalogSellingUnitRegistryDigest,
  assertCatalogSellingUnitRegistrySuccessor,
  assertCatalogRegisteredSellingUnitQuantity,
  assertCatalogSellingUnitRegistryBootstrap,
  buildCatalogSellingUnitRegistrationResolution,
  parseCatalogSellingUnitRegistrationResolution,
  parseCatalogSellingUnitRegistrationResolutionCommand,
  type CatalogSellingUnitRegistrationResolutionCommand,
  type CatalogSellingUnitRegistrationResolution,
  type CatalogSellingUnitRegistryCommand,
  type CatalogSellingUnitRegistry,
} from "../../contracts/selling-unit-registry.js";
import { sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return value as Record<string, unknown>;
}
export interface CatalogSellingUnitCandidateRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly operationReference: string;
  readonly purposeCode: "CATALOG_PRODUCT_CREATE" | "CATALOG_PRODUCT_DRAFT_REPLACE";
  readonly aggregate: unknown;
  readonly originalIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export const sellingUnitRegistryFields = Object.freeze([
  "registryReference",
  "registryVersion",
  "versionReference",
  "defaultLocale",
  "units",
  "operationHistory",
  "assignedUnitHistory",
  "bootstrapConfirmation",
] as const);
function parseSellingUnitRegistryObservation(value: unknown) {
  const r = readClosedRecord(copyCategoryPersistenceValue(value), [
    "originalIntentDigest",
    "observedAt",
    "validUntil",
  ]);
  const observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (
    typeof r.originalIntentDigest !== "string" ||
    !r.originalIntentDigest.startsWith("sha256:") ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 30000
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return Object.freeze({
    originalIntentDigest: "sha256:" + parseCatalogHash(r.originalIntentDigest.slice(7)),
    observedAt,
    validUntil,
  });
}
export type SellingUnitRegistryObservation = ReturnType<typeof parseSellingUnitRegistryObservation>;
function sellingUnitRegistryRequest(command: CatalogSellingUnitRegistryCommand) {
  const { intentDigest, snapshotDigest, ...request } = command;
  void intentDigest;
  void snapshotDigest;
  return request;
}
function sellingUnitRegistryEventId(command: CatalogSellingUnitRegistryCommand) {
  const digest = sha256Hex(
    "CatalogSellingUnitRegistryEvent:v1:" +
      command.tenantReference +
      ":" +
      command.brandReference +
      ":" +
      command.operationReference,
  );
  return parseCatalogReference(
    command.operationReference.slice(0, 14) +
      "7" +
      digest.slice(0, 3) +
      "-8" +
      digest.slice(3, 6) +
      "-" +
      digest.slice(6, 18),
  );
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
type Action = "catalog.manage";
export const sellingUnitRegistrationResolutionFields = Object.freeze([
  "operationReference",
  "operationHistory",
  "operationResolution",
  "registryReference",
  "versionReference",
  "registryVersion",
] as const);
type Mode = "Intent" | "Register" | "Replay" | "Read" | "Inspect" | "Resolve";
export interface CatalogSellingUnitRegistryAuthority {
  /** Hold current Brand scope, Actor catalog.manage and complete field policy through
   * outer COMMIT. Replay authorizes recovery, without requalifying old definitions. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User" | "System";
      readonly purposeCode: "CATALOG_SELLING_UNIT_REGISTRY";
      readonly permission: "catalog.manage";
      readonly action: Action;
      readonly mode: Mode;
      readonly requiredPermissions: readonly string[];
      readonly registry: CatalogSellingUnitRegistry | null;
      readonly requiredFields:
        typeof sellingUnitRegistryFields | typeof sellingUnitRegistrationResolutionFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
export interface SellingUnitRegistryStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CatalogSellingUnitRegistryAuthority;
  readonly audit?: {
    create(command: CatalogSellingUnitRegistryCommand): AppendAuditRecordInput;
    createAbandonment?(input: {
      command: CatalogSellingUnitRegistrationResolutionCommand;
      resolution: CatalogSellingUnitRegistrationResolution;
    }): AppendAuditRecordInput;
  };
  /** Required server UoW hook: run every async guard, then all final assertions
   * synchronously without yielding before COMMIT. Preserve the original lease. */
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface CatalogCurrentSellingUnitRegistry {
  readonly registry: CatalogSellingUnitRegistry;
  readonly snapshotDigest: string;
  readonly observation: SellingUnitRegistryObservation;
  readonly sourceAuthority: "CurrentTransactionHeld";
}
export interface CatalogSellingUnitAssignment {
  readonly source: "CurrentSku" | "OperationSnapshot";
  readonly productReference: string;
  readonly versionReference: string;
  readonly skuReference: string;
  readonly operationReference: string | null;
  readonly aggregateVersion: number;
  readonly unitCode: string;
  readonly unitQuantity: string;
}
export interface CatalogSellingUnitInspection {
  readonly profile: "CatalogSellingUnitInspectionV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly presence: "Absent" | "Present";
  readonly registry: CatalogSellingUnitRegistry | null;
  readonly assignments: readonly CatalogSellingUnitAssignment[];
  readonly historyDigest: string;
  readonly inspectionDigest: string;
  readonly observation: SellingUnitRegistryObservation;
  readonly sourceAuthority: "CurrentTransactionHeld";
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
 FROM rms_catalog.selling_unit_registry_record WHERE tenant_id=$1 AND brand_id=$2`;
function decode(row: RecordRow, tenant: string, brand: string) {
  const command = parseCatalogSellingUnitRegistryCommand(row.command),
    registry = parseCatalogSellingUnitRegistry(row.registry);
  if (
    row.coherent !== true ||
    command.tenantReference !== tenant ||
    command.brandReference !== brand ||
    canonicalizeRfc8785(registry) !== canonicalizeRfc8785(command.registry) ||
    row.intent_digest !== command.intentDigest ||
    row.snapshot_digest !== command.snapshotDigest ||
    row.event_id !== sellingUnitRegistryEventId(command)
  )
    return fail();
  return command;
}
function parseRecordRow(value: unknown): RecordRow {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const fields = [
    "command",
    "registry",
    "intent_digest",
    "snapshot_digest",
    "event_id",
    "coherent",
  ];
  if (Reflect.ownKeys(value).length !== fields.length) return fail();
  const captured: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    captured[field] = descriptor.value;
  }
  const digest = (input: unknown) => {
    if (typeof input !== "string" || !input.startsWith("sha256:")) return fail();
    return "sha256:" + parseCatalogHash(input.slice(7));
  };
  if (typeof captured.coherent !== "boolean") return fail();
  // The immutable command includes its own registry. Each persisted payload
  // keeps the same independent parser budget it had when first accepted.
  return Object.freeze({
    command: copyCategoryPersistenceValue(captured.command),
    registry: copyCategoryPersistenceValue(captured.registry),
    intent_digest: digest(captured.intent_digest),
    snapshot_digest: digest(captured.snapshot_digest),
    event_id: parseCatalogReference(captured.event_id),
    coherent: captured.coherent,
  });
}
function rows<T>(
  result: unknown,
  parseRow: (value: unknown) => T = (value) => copyCategoryPersistenceValue(value) as T,
): readonly T[] {
  if (!result || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value)) return fail();
  const source = d.value;
  if (
    Object.getPrototypeOf(source) !== Array.prototype ||
    source.length > 1001 ||
    Reflect.ownKeys(source).length !== source.length + 1
  )
    return fail();
  // Count and PostgreSQL byte budgets bound the full history. Descriptor-copy
  // each independently bounded row so accepted revisions do not consume one
  // shared parser node budget and make a later complete history unreadable.
  return Object.freeze(
    Array.from({ length: source.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(source, String(index));
      if (!item?.enumerable || !("value" in item)) return fail();
      return parseRow(item.value);
    }),
  );
}
interface Held {
  readonly tx: Transaction;
  check(): string;
  setDeadline(until: string): void;
  query: Transaction["query"];
  rollbackWrite(): Promise<void>;
  hold(action: Action, mode: Mode, registry: CatalogSellingUnitRegistry | null): Promise<void>;
  register(action: Action, mode: Mode, registry: CatalogSellingUnitRegistry | null): Promise<void>;
}
export function createPostgresSellingUnitRegistryStore(options: SellingUnitRegistryStoreOptions) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    (options.audit !== undefined && typeof options.audit.create !== "function")
  )
    return fail();
  // Capture trusted composition once, including each receiver. Later mutation of
  // a configured port cannot change the authorization or clock for a lease.
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    authorize = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    beforeCommit = options.registerBeforeCommit.bind(options),
    createAudit = options.audit?.create.bind(options.audit),
    key = "CatalogSellingUnitRegistry:" + tenant + ":" + brand,
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  const time = () => {
    try {
      return parseCatalogInstant(now());
    } catch {
      return fail();
    }
  };
  const runHeld = async <T>(
    observedAt: string,
    validUntil: string,
    work: (held: Held) => Promise<T>,
  ): Promise<T> => {
    let calls = 0,
      completed: { value: T } | undefined,
      transaction: Transaction | undefined,
      poisoned = false,
      finalCheck: (() => string) | undefined;
    const poison = (): never => {
      poisoned = true;
      if (transaction) failed.add(transaction);
      return fail();
    };
    try {
      const result = await run(async (tx) => {
        if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return poison();
        transaction = tx;
        // A rejected nested call must poison this shared transaction even when
        // its caller catches the rejection and continues the outer consumer.
        if (++calls !== 1 || active.has(tx) || failed.has(tx)) return poison();
        active.add(tx);
        const originalQuery = tx.query,
          capturedQuery = originalQuery.bind(tx);
        let latest = observedAt,
          deadline = validUntil,
          binding:
            | {
                readonly action: Action;
                readonly mode: Mode;
                readonly registry: CatalogSellingUnitRegistry | null;
              }
            | undefined,
          ready = false,
          guardCalls = 0;
        const check = () => {
          let at: string;
          try {
            at = time();
          } catch {
            return poison();
          }
          if (
            poisoned ||
            failed.has(tx) ||
            tx.query !== originalQuery ||
            at < latest ||
            at >= deadline
          )
            return poison();
          latest = at;
          return at;
        };
        finalCheck = check;
        const query: Transaction["query"] = async <Row = Record<string, unknown>>(
          sql: string,
          values: readonly unknown[],
        ) => {
          check();
          const result = await capturedQuery<Row>(sql, values);
          check();
          return result;
        };
        const hold: Held["hold"] = async (action, mode, registry) => {
          const at = check();
          if (
            (await authorize(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                actorKind: kind,
                purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
                permission: "catalog.manage",
                action,
                mode,
                requiredPermissions: Object.freeze(
                  mode === "Read" || mode === "Replay" || mode === "Intent" || mode === "Resolve"
                    ? ["catalog.manage"]
                    : [
                        "catalog.manage",
                        "catalog.product.read",
                        "catalog.product.history.read",
                        "catalog.sku.read",
                      ],
                ),
                registry,
                requiredFields:
                  mode === "Resolve"
                    ? sellingUnitRegistrationResolutionFields
                    : sellingUnitRegistryFields,
                observedAt: at,
              }),
            )) !== undefined
          )
            return poison();
          check();
        };
        const register: Held["register"] = async (action, mode, registry) => {
          if (binding) return poison();
          check();
          binding = Object.freeze({ action, mode, registry });
        };
        try {
          // Install the poison guard before any holder, clock or history read can
          // fail. A borrowed transaction must not commit if its caller swallows
          // an early source refusal. The actual authority tuple is bound later.
          if (
            (await beforeCommit(
              tx,
              async () => {
                try {
                  if (++guardCalls !== 1 || !ready || !binding) return poison();
                  check();
                  await hold(binding.action, binding.mode, binding.registry);
                  check();
                } catch (error) {
                  poisoned = true;
                  failed.add(tx);
                  throw error;
                }
              },
              () => {
                check();
              },
            )) !== undefined
          )
            return poison();
          check();
          const value = await work({
            tx,
            query,
            check,
            hold,
            register,
            async rollbackWrite() {
              await capturedQuery("ROLLBACK TO SAVEPOINT catalog_selling_unit_write", []);
              await capturedQuery("RELEASE SAVEPOINT catalog_selling_unit_write", []);
            },
            setDeadline(until) {
              deadline = [deadline, parseCatalogInstant(until)].sort()[0] ?? poison();
              check();
            },
          });
          if (!binding) return poison();
          check();
          ready = true;
          completed = { value };
          return completed;
        } catch (error) {
          poisoned = true;
          failed.add(tx);
          throw error;
        } finally {
          active.delete(tx);
        }
      });
      if (
        poisoned ||
        calls !== 1 ||
        !completed ||
        result !== completed ||
        !transaction ||
        failed.has(transaction)
      )
        return poison();
      if (!finalCheck) return poison();
      finalCheck();
      return completed.value;
    } catch (error) {
      if (transaction) failed.add(transaction);
      if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID") throw error;
      return fail();
    }
  };
  const context = async (h: Held) => {
    h.check();
    await requireCategoryCurrentReads(h.tx);
    h.check();
    await h.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
      [tenant, brand],
    );
  };
  const history = async (h: Held) => {
    const count = rows<{ n: string; bytes: string }>(
        await h.query(
          "SELECT count(*)::text n,COALESCE(sum(octet_length(snapshot_json::text)+octet_length(command_json::text)),0)::text bytes FROM rms_catalog.selling_unit_registry_record WHERE tenant_id=$1 AND brand_id=$2",
          [tenant, brand],
        ),
      ),
      r = count[0];
    if (
      count.length !== 1 ||
      !r ||
      !/^(0|[1-9][0-9]*)$/.test(r.n) ||
      !/^(0|[1-9][0-9]*)$/.test(r.bytes) ||
      BigInt(r.n) > 1000n ||
      BigInt(r.bytes) > 8388608n
    )
      return fail();
    const all = rows<RecordRow>(
      await h.query(rowsSql + " ORDER BY registry_version LIMIT 1001", [tenant, brand]),
      parseRecordRow,
    );
    if (all.length !== Number(r.n)) return fail();
    let previous: CatalogSellingUnitRegistry | null = null;
    const versionIds = new Set<string>(),
      operationIds = new Set<string>();
    for (const row of all) {
      const command = decode(row, tenant, brand);
      if (
        versionIds.has(command.registry.versionReference) ||
        operationIds.has(command.operationReference)
      )
        return fail();
      versionIds.add(command.registry.versionReference);
      operationIds.add(command.operationReference);
      // Historical assignment-at-time is not invented. Validate immutable chain
      // provenance here; actual current assignments are checked on each new write.
      if (
        command.registry.previousSnapshotDigest !==
          (previous === null ? null : catalogSellingUnitRegistryDigest(previous)) ||
        command.registry.registryVersion !== (previous?.registryVersion ?? 0) + 1 ||
        (previous !== null &&
          (command.registry.registryReference !== previous.registryReference ||
            command.registry.registeredAt < previous.registeredAt))
      )
        return fail();
      if (previous !== null) {
        const units = new Map(command.registry.units.map((unit) => [unit.unitReference, unit]));
        for (const old of previous.units) {
          const next = units.get(old.unitReference);
          if (
            !next ||
            next.code !== old.code ||
            (old.lifecycle === "Retired" && next.lifecycle !== "Retired")
          )
            return fail();
        }
      }
      previous = command.registry;
    }
    return { current: previous, bytes: BigInt(r.bytes), count: Number(r.n) };
  };
  const assignedHistory = async (h: Held) => {
    const integrity = rows<{ invalid: boolean }>(
      await h.query(
        "SELECT EXISTS(SELECT 1 FROM rms_catalog.product_operation_record o LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=o.operation_id WHERE o.brand_id=$1 AND (s.operation_id IS NULL OR s.brand_id<>o.brand_id OR s.product_id<>o.product_id OR s.result_aggregate_version<>o.result_aggregate_version OR s.occurred_at<>o.occurred_at OR s.occurred_at>$2::timestamptz OR s.snapshot_json->>'updatedAt' IS DISTINCT FROM to_char(s.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') OR s.snapshot_json->>'brandReference' IS DISTINCT FROM o.brand_id::text OR s.snapshot_json->>'productReference' IS DISTINCT FROM o.product_id::text OR s.snapshot_json->'aggregateVersion' IS DISTINCT FROM to_jsonb(o.result_aggregate_version) OR jsonb_typeof(s.snapshot_json#>'{draft,skus}') IS DISTINCT FROM 'array')) OR EXISTS(SELECT 1 FROM rms_catalog.product p WHERE p.brand_id=$1 AND (p.updated_at>$2::timestamptz OR (SELECT count(*) FROM rms_catalog.product_operation_record o WHERE o.brand_id=p.brand_id AND o.product_id=p.product_id)<>p.aggregate_version OR (SELECT count(*) FROM rms_catalog.product_operation_snapshot s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id)<>p.aggregate_version OR (SELECT min(s.result_aggregate_version) FROM rms_catalog.product_operation_snapshot s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id) IS DISTINCT FROM 1 OR (SELECT max(s.result_aggregate_version) FROM rms_catalog.product_operation_snapshot s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id) IS DISTINCT FROM p.aggregate_version)) invalid",
        [brand, h.check()],
      ),
    );
    if (integrity.length !== 1 || integrity[0]?.invalid !== false) return fail();
    const budget = rows<{ current_count: string; snapshot_count: string; snapshot_bytes: string }>(
      await h.query(
        "SELECT (SELECT count(*)::text FROM rms_catalog.sku WHERE brand_id=$1) current_count,(SELECT count(*)::text FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1) snapshot_count,(SELECT COALESCE(sum(octet_length(snapshot_json::text)),0)::text FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1) snapshot_bytes",
        [brand],
      ),
    );
    const limits = budget[0];
    if (
      budget.length !== 1 ||
      !limits ||
      [limits.current_count, limits.snapshot_count, limits.snapshot_bytes].some(
        (v) => typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v),
      ) ||
      BigInt(limits.current_count) > 1000n ||
      BigInt(limits.snapshot_count) > 1000n ||
      BigInt(limits.snapshot_bytes) > 8388608n
    )
      return fail();
    const current = rows<Record<string, unknown>>(
      await h.query(
        "SELECT s.sku_id::text sku_reference,s.product_id::text product_reference,s.product_version_id::text version_reference,p.aggregate_version,s.unit_of_sale unit_code,s.unit_quantity::text unit_quantity FROM rms_catalog.sku s JOIN rms_catalog.product p ON p.product_id=s.product_id AND p.brand_id=s.brand_id WHERE s.brand_id=$1 ORDER BY s.sku_id LIMIT 1001",
        [brand],
      ),
    );
    const snapshots = rows<Record<string, unknown>>(
      await h.query(
        "SELECT operation_id::text operation_reference,product_id::text product_reference,result_aggregate_version aggregate_version,snapshot_json aggregate FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 ORDER BY operation_id LIMIT 1001",
        [brand],
      ),
    );
    if (
      current.length !== Number(limits.current_count) ||
      snapshots.length !== Number(limits.snapshot_count)
    )
      return fail();
    const assignments: CatalogSellingUnitAssignment[] = [],
      completeHistory: {
        readonly operationReference: string;
        readonly aggregate: ProductAggregate;
      }[] = [];
    const version = (v: unknown) => {
      if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647)
        return fail();
      return v as number;
    };
    for (const row of current) {
      assignments.push(
        Object.freeze({
          source: "CurrentSku",
          productReference: parseCatalogReference(row.product_reference),
          versionReference: parseCatalogReference(row.version_reference),
          skuReference: parseCatalogReference(row.sku_reference),
          operationReference: null,
          aggregateVersion: version(row.aggregate_version),
          unitCode: parseCatalogCode(row.unit_code),
          unitQuantity: parseCatalogDecimal(row.unit_quantity),
        }),
      );
    }
    for (const row of snapshots) {
      const aggregate = parseProductAggregate(row.aggregate),
        operationReference = parseCatalogReference(row.operation_reference);
      if (
        aggregate.brandReference !== brand ||
        aggregate.productReference !== row.product_reference ||
        aggregate.aggregateVersion !== row.aggregate_version
      )
        return fail();
      completeHistory.push(Object.freeze({ operationReference, aggregate }));
      for (const sku of aggregate.draft.skus)
        assignments.push(
          Object.freeze({
            source: "OperationSnapshot",
            productReference: aggregate.productReference,
            versionReference: aggregate.draft.versionReference,
            skuReference: sku.skuReference,
            operationReference,
            aggregateVersion: aggregate.aggregateVersion,
            unitCode: sku.unitOfSale,
            unitQuantity: sku.unitQuantity,
          }),
        );
    }
    assignments.sort((a, b) => {
      const left = canonicalizeRfc8785(a),
        right = canonicalizeRfc8785(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (
      assignments.length > 10000 ||
      new TextEncoder().encode(canonicalizeRfc8785(assignments)).byteLength > 8388608
    )
      return fail();
    const frozen = Object.freeze(assignments),
      historyDigest =
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            profile: "CatalogSellingUnitAssignmentHistoryV1",
            tenantReference: tenant,
            brandReference: brand,
            assignments: frozen,
            completeHistory: Object.freeze(completeHistory),
          }),
        );
    return { assignments: frozen, historyDigest };
  };
  const withCurrentInspection = async <T>(
    value: unknown,
    work: (source: CatalogSellingUnitInspection, tx: Transaction) => Promise<T>,
  ): Promise<T> => {
    const observation = parseSellingUnitRegistryObservation(value);
    if (typeof work !== "function") return fail();
    return runHeld(observation.observedAt, observation.validUntil, async (h) => {
      await h.hold("catalog.manage", "Inspect", null);
      await context(h);
      await h.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
        "CatalogProductSource:" + brand,
      ]);
      await h.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [key]);
      const registry = (await history(h)).current,
        coverage = await assignedHistory(h);
      if (registry && registry.registeredAt > observation.observedAt) return fail();
      await h.hold("catalog.manage", "Inspect", registry);
      await h.register("catalog.manage", "Inspect", registry);
      const body = {
        profile: "CatalogSellingUnitInspectionV1" as const,
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        presence: registry === null ? ("Absent" as const) : ("Present" as const),
        registry,
        ...coverage,
        observation,
        sourceAuthority: "CurrentTransactionHeld" as const,
      };
      const source = Object.freeze({
        ...body,
        inspectionDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
      });
      const result = await work(source, h.tx);
      h.check();
      await h.hold("catalog.manage", "Inspect", registry);
      h.check();
      return result;
    });
  };
  // Preparation/recovery takes exclusive locks from the outset. The caller may
  // execute after this returns on the same borrowed transaction, without a
  // shared-to-exclusive Product source lock upgrade or a new original clock.
  const withRegistrationOperation = async <T>(
    value: unknown,
    work: (
      original: CatalogSellingUnitRegistryCommand | null,
      current: CatalogSellingUnitRegistry | null,
      tx: Transaction,
    ) => Promise<T>,
  ): Promise<T> => {
    const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
        "operationReference",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]),
      operationReference = parseCatalogReference(raw.operationReference),
      observation = parseSellingUnitRegistryObservation({
        originalIntentDigest: raw.originalIntentDigest,
        observedAt: raw.observedAt,
        validUntil: raw.validUntil,
      });
    if (kind !== "User" || typeof work !== "function") return fail("CATALOG_PERMISSION_DENIED");
    return runHeld(observation.observedAt, observation.validUntil, async (h) => {
      await h.hold("catalog.manage", "Intent", null);
      await context(h);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogProductSource:" + brand,
      ]);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogSellingUnitOperation:" + operationReference,
      ]);
      const abandoned = rows<Record<string, unknown>>(
        await h.query(
          "SELECT operation_id FROM rms_catalog.selling_unit_registration_abandonment WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2",
          [tenant, brand, operationReference],
        ),
      );
      if (abandoned.length !== 0) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
      const recovered = rows<RecordRow>(
        await h.query(rowsSql + " AND operation_id=$3", [tenant, brand, operationReference]),
        parseRecordRow,
      );
      if (recovered.length > 1) return fail();
      const original = recovered[0] ? decode(recovered[0], tenant, brand) : null;
      if (original && original.actorReference !== actor) return fail("CATALOG_PERMISSION_DENIED");
      const current = original?.registry ?? (await history(h)).current,
        mode = original ? ("Replay" as const) : ("Intent" as const);
      if (current && current.registeredAt > observation.observedAt) return fail();
      await h.hold("catalog.manage", mode, current);
      await h.register("catalog.manage", mode, current);
      const result = await work(original, current, h.tx);
      h.check();
      await h.hold("catalog.manage", mode, current);
      h.check();
      return result;
    });
  };
  const resolveRegistrationOperation = async (
    value: unknown,
  ): Promise<CatalogSellingUnitRegistrationResolution> => {
    const command = parseCatalogSellingUnitRegistrationResolutionCommand(value);
    if (
      kind !== "User" ||
      command.tenantReference !== tenant ||
      command.brandReference !== brand ||
      command.actorReference !== actor
    )
      return fail("CATALOG_PERMISSION_DENIED");
    const startedAt = time(),
      createAbandonment = options.audit?.createAbandonment?.bind(options.audit);
    return runHeld(startedAt, new Date(Date.parse(startedAt) + 5000).toISOString(), async (h) => {
      await h.hold("catalog.manage", "Resolve", null);
      await context(h);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogProductSource:" + brand,
      ]);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogSellingUnitOperation:" + command.operationReference,
      ]);
      const recorded = rows<RecordRow>(
        await h.query(rowsSql + " AND operation_id=$3", [
          tenant,
          brand,
          command.operationReference,
        ]),
        parseRecordRow,
      );
      if (recorded.length > 1) return fail();
      let resolution: CatalogSellingUnitRegistrationResolution;
      if (recorded[0]) {
        const original = decode(recorded[0], tenant, brand);
        if (original.actorReference !== actor) return fail("CATALOG_PERMISSION_DENIED");
        if (
          original.expectedRegistryVersion !== command.expectedRegistryVersion ||
          original.reasonCode !==
            (command.action === "Create" ? "PRODUCT_CREATE_UNITS" : "PRODUCT_DRAFT_UNITS")
        )
          return fail("CATALOG_IDEMPOTENCY_CONFLICT");
        resolution = buildCatalogSellingUnitRegistrationResolution({
          outcome: "Committed",
          command,
          registryReference: original.registry.registryReference,
          versionReference: original.registry.versionReference,
          registryVersion: original.registry.registryVersion,
          originalIntentDigest: original.intentDigest,
          snapshotDigest: original.snapshotDigest,
          recordedAt: original.occurredAt,
        });
      } else {
        const fences = rows<Record<string, unknown>>(
          await h.query(
            "SELECT command_json command,snapshot_json resolution FROM rms_catalog.selling_unit_registration_abandonment WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2",
            [tenant, brand, command.operationReference],
          ),
        );
        if (fences.length > 1) return fail();
        if (fences[0]) {
          const originalCommand = parseCatalogSellingUnitRegistrationResolutionCommand(
            fences[0].command,
          );
          if (originalCommand.actorReference !== actor) return fail("CATALOG_PERMISSION_DENIED");
          if (canonicalizeRfc8785(originalCommand) !== canonicalizeRfc8785(command))
            return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          resolution = parseCatalogSellingUnitRegistrationResolution(fences[0].resolution);
          if (
            resolution.outcome !== "Abandoned" ||
            canonicalizeRfc8785(resolution.command) !== canonicalizeRfc8785(command)
          )
            return fail();
        } else {
          resolution = buildCatalogSellingUnitRegistrationResolution({
            outcome: "Abandoned",
            command,
            registryReference: null,
            versionReference: null,
            registryVersion: null,
            originalIntentDigest: null,
            snapshotDigest: null,
            recordedAt: h.check(),
          });
          if (typeof createAbandonment !== "function") return fail();
          const audit = validateAuditRecord(
            createAbandonment({ command, resolution }),
            Date.parse(h.check()),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type === "System" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_SELLING_UNIT_REGISTRATION_ABANDONED" ||
            audit.targetType !== "SellingUnitRegistrationOperation" ||
            audit.targetId !== command.operationReference ||
            audit.reasonCode !== "ORIGINAL_OPERATION_ABANDONED" ||
            audit.occurredAt !== resolution.recordedAt
          )
            return fail("CATALOG_PERMISSION_DENIED");
          await h.hold("catalog.manage", "Resolve", null);
          const inserted = await h.query(
            "INSERT INTO rms_catalog.selling_unit_registration_abandonment(operation_id,tenant_id,brand_id,actor_id,action_code,expected_registry_version,command_json,snapshot_json,resolution_digest,recorded_at,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)",
            [
              command.operationReference,
              tenant,
              brand,
              actor,
              command.action,
              command.expectedRegistryVersion,
              canonicalizeRfc8785(command),
              canonicalizeRfc8785(resolution),
              resolution.digest,
              resolution.recordedAt,
              audit.auditId,
            ],
          );
          if (inserted.rowCount !== 1) return fail();
          await appendAuditRecordInTransaction(h.tx, audit);
        }
      }
      await h.hold("catalog.manage", "Resolve", null);
      await h.register("catalog.manage", "Resolve", null);
      h.check();
      return resolution;
    });
  };
  const withCurrentRegistry = async <T>(
    value: unknown,
    work: (source: CatalogCurrentSellingUnitRegistry, tx: Transaction) => Promise<T>,
  ): Promise<T> => {
    const observation = parseSellingUnitRegistryObservation(value);
    if (typeof work !== "function") return fail();
    return runHeld(observation.observedAt, observation.validUntil, async (h) => {
      await h.hold("catalog.manage", "Read", null);
      await context(h);
      await h.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [key]);
      const registry = (await history(h)).current;
      if (!registry || registry.registeredAt > observation.observedAt) return fail();
      await h.hold("catalog.manage", "Read", registry);
      await h.register("catalog.manage", "Read", registry);
      const source = Object.freeze({
        registry,
        snapshotDigest: catalogSellingUnitRegistryDigest(registry),
        observation,
        sourceAuthority: "CurrentTransactionHeld" as const,
      });
      h.check();
      const result = await work(source, h.tx);
      h.check();
      await h.hold("catalog.manage", "Read", registry);
      h.check();
      return result;
    });
  };
  return Object.freeze({
    async execute(value: unknown) {
      const command = parseCatalogSellingUnitRegistryCommand(value);
      if (!createAudit) return fail();
      if (
        kind !== "User" ||
        command.tenantReference !== tenant ||
        command.brandReference !== brand ||
        command.actorReference !== actor
      )
        return fail("CATALOG_PERMISSION_DENIED");
      const startedAt = time();
      return runHeld(
        startedAt,
        new Date(Date.parse(startedAt) + 30000).toISOString(),
        async (h) => {
          await h.hold("catalog.manage", "Intent", null);
          await context(h);
          // Match owning Product writer lock order before inspecting its complete
          // current/history facts; no registry-first/source-second deadlock.
          await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogProductSource:" + brand,
          ]);
          await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
          await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogSellingUnitOperation:" + command.operationReference,
          ]);
          const abandoned = rows<Record<string, unknown>>(
            await h.query(
              "SELECT operation_id FROM rms_catalog.selling_unit_registration_abandonment WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2",
              [tenant, brand, command.operationReference],
            ),
          );
          if (abandoned.length !== 0) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
          if (command.occurredAt > h.check()) return fail();
          const recovered = rows<RecordRow>(
            await h.query(rowsSql + " AND operation_id=$3", [
              tenant,
              brand,
              command.operationReference,
            ]),
            parseRecordRow,
          );
          if (recovered.length > 1) return fail();
          if (recovered[0]) {
            const original = decode(recovered[0], tenant, brand);
            if (original.intentDigest !== command.intentDigest)
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            await h.hold("catalog.manage", "Replay", original.registry);
            await h.register("catalog.manage", "Replay", original.registry);
            return Object.freeze({
              status: "Replayed" as const,
              registry: original.registry,
              snapshotDigest: original.snapshotDigest,
              operationReference: original.operationReference,
            });
          }
          h.setDeadline(new Date(Date.parse(command.occurredAt) + 30000).toISOString());
          const source = await history(h);
          if ((source.current?.registryVersion ?? 0) !== command.expectedRegistryVersion)
            return fail("CATALOG_VERSION_CONFLICT");
          if (source.count >= 1000) return fail();
          await h.hold("catalog.manage", "Register", command.registry);
          const coverage = await assignedHistory(h),
            assigned = [...new Set(coverage.assignments.map((item) => item.unitCode))];
          if (source.current === null && assigned.length > 0) {
            if (command.bootstrapConfirmation === undefined)
              return fail("CATALOG_LIFECYCLE_CONFLICT");
            assertCatalogSellingUnitRegistryBootstrap(
              command.registry,
              coverage.assignments,
              command.bootstrapConfirmation,
              coverage.historyDigest,
            );
          } else {
            if (command.bootstrapConfirmation !== undefined)
              return fail("CATALOG_LIFECYCLE_CONFLICT");
            assertCatalogSellingUnitRegistrySuccessor(source.current, command.registry, assigned);
          }
          await h.hold("catalog.manage", "Register", command.registry);
          await h.register("catalog.manage", "Register", command.registry);
          const commandJson = canonicalizeRfc8785(sellingUnitRegistryRequest(command)),
            registryJson = canonicalizeRfc8785(command.registry);
          const size = rows<{ bytes: string; snapshot_bytes: string; command_bytes: string }>(
              await h.query(
                "SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text))::text bytes,octet_length($1::jsonb::text)::text command_bytes,octet_length($2::jsonb::text)::text snapshot_bytes",
                [commandJson, registryJson],
              ),
            ),
            bytes = size[0]?.bytes;
          if (
            size.length !== 1 ||
            typeof bytes !== "string" ||
            !/^[1-9][0-9]*$/.test(bytes) ||
            !/^[1-9][0-9]*$/.test(size[0]?.command_bytes ?? "") ||
            !/^[1-9][0-9]*$/.test(size[0]?.snapshot_bytes ?? "") ||
            BigInt(size[0]?.command_bytes ?? "0") > 2228224n ||
            BigInt(size[0]?.snapshot_bytes ?? "0") > 2097152n ||
            source.bytes + BigInt(bytes) > 8388608n
          )
            return fail();
          const audit = validateAuditRecord(
            copyCategoryPersistenceValue(createAudit(command)),
            Date.parse(h.check()),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== undefined ||
            audit.actor.type !== "User" ||
            audit.actor.reference !== actor ||
            audit.actionCode !== "CATALOG_SELLING_UNIT_REGISTRY_RECORDED" ||
            audit.targetType !== "CatalogSellingUnitRegistry" ||
            audit.targetId !== command.registry.registryReference ||
            audit.reasonCode !== command.reasonCode ||
            audit.occurredAt !== command.occurredAt ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();
          const eventId = sellingUnitRegistryEventId(command);
          // A local savepoint also removes tentative rows if a borrowed runner's
          // caller catches this operation's error. Outer guards still poison COMMIT.
          await h.query("SAVEPOINT catalog_selling_unit_write", []);
          try {
            const inserted = await h.query(
              "INSERT INTO rms_catalog.selling_unit_registry_record(operation_id,tenant_id,brand_id,registry_id,version_id,registry_version,actor_id,intent_digest,snapshot_digest,occurred_at,command_json,snapshot_json,event_id,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)",
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
            if (Object.getOwnPropertyDescriptor(inserted, "rowCount")?.value !== 1) return fail();
            h.check();
            await appendAuditRecordInTransaction({ query: h.query }, audit);
            h.check();
            const envelope: DomainEventEnvelope = {
              eventId,
              eventType: "SellingUnitRegistryVersionRecorded",
              schemaVersion: 1,
              occurredAt: command.occurredAt,
              producerModule: "@rms/catalog",
              tenantId: brand,
              aggregateType: "CatalogSellingUnitRegistry",
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
                  const r = await h.query(sql, values);
                  return { rowCount: r.rowCount ?? null };
                },
              },
              envelope,
            );
            await h.hold("catalog.manage", "Register", command.registry);
            h.check();
          } catch (error) {
            // Cleanup must remain possible after the lease/authority failed. It
            // uses the captured query only and never permits another business read.
            await h.rollbackWrite();
            throw error;
          }
          await h.query("RELEASE SAVEPOINT catalog_selling_unit_write", []);
          return Object.freeze({
            status: "Applied" as const,
            registry: command.registry,
            snapshotDigest: command.snapshotDigest,
            operationReference: command.operationReference,
          });
        },
      );
    },
    withCurrentRegistry,
    withCurrentInspection,
    withRegistrationOperation,
    resolveRegistrationOperation,
    async withRegisteredProductSkuQuantities<T>(
      value: CatalogSellingUnitCandidateRequest,
      work: (
        source: CatalogCurrentSellingUnitRegistry & {
          readonly request: Omit<CatalogSellingUnitCandidateRequest, "aggregate"> & {
            readonly aggregate: ProductAggregate;
          };
        },
        tx: Transaction,
      ) => Promise<T>,
    ): Promise<T> {
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
        "tenantReference",
        "brandReference",
        "productReference",
        "operationReference",
        "purposeCode",
        "aggregate",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]);
      const observation = parseSellingUnitRegistryObservation({
        originalIntentDigest: raw.originalIntentDigest,
        observedAt: raw.observedAt,
        validUntil: raw.validUntil,
      });
      const aggregate = parseProductAggregate(raw.aggregate);
      const request = Object.freeze({
        tenantReference: parseCatalogReference(raw.tenantReference),
        brandReference: parseCatalogReference(raw.brandReference),
        productReference: parseCatalogReference(raw.productReference),
        operationReference: parseCatalogReference(raw.operationReference),
        purposeCode: raw.purposeCode as CatalogSellingUnitCandidateRequest["purposeCode"],
        aggregate,
        ...observation,
      });
      if (
        typeof work !== "function" ||
        !["CATALOG_PRODUCT_CREATE", "CATALOG_PRODUCT_DRAFT_REPLACE"].includes(
          request.purposeCode,
        ) ||
        request.tenantReference !== tenant ||
        request.brandReference !== brand ||
        aggregate.brandReference !== brand ||
        aggregate.productReference !== request.productReference
      )
        return fail("CATALOG_PERMISSION_DENIED");
      if (Date.parse(request.validUntil) - Date.parse(request.observedAt) !== 5000)
        return fail("CATALOG_INPUT_INVALID");
      if (
        request.purposeCode === "CATALOG_PRODUCT_CREATE" &&
        (aggregate.aggregateVersion !== 1 ||
          aggregate.lifecycle !== "Draft" ||
          aggregate.createdByActorReference !== actor)
      )
        return fail("CATALOG_LIFECYCLE_CONFLICT");
      // Acquire once under the same Brand shared barrier as ordinary current reads.
      // The callback retains this exact original immutable candidate/registry proof;
      // repeated own-write checks must use it, never requalify after their own CAS.
      return withCurrentRegistry(observation, async (source, tx) => {
        for (const sku of aggregate.draft.skus)
          assertCatalogRegisteredSellingUnitQuantity(
            source.registry,
            brand,
            sku.unitOfSale,
            sku.unitQuantity,
          );
        return work(Object.freeze({ ...source, request }), tx);
      });
    },
  });
}

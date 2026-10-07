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
} from "../../contracts/product.js";
import {
  taxClassificationRegistryFields,
  parseCatalogTaxClassificationRegistryCommand,
  parseCatalogTaxClassificationRegistryObservation,
  parseCatalogProductTaxClassificationRegistry,
  catalogProductTaxClassificationRegistryDigest,
  assertCatalogProductTaxClassificationRegistrySuccessor,
  catalogTaxClassificationRegistryRequest,
  catalogTaxClassificationRegistryEventId,
  parseCatalogProductTaxClassificationResolutionRequest,
  resolveCatalogProductTaxClassification,
  type CatalogTaxClassificationRegistryCommand,
  type CatalogTaxClassificationRegistryObservation,
  type CatalogProductTaxClassificationRegistry,
  type CatalogProductTaxClassificationResolution,
} from "../../contracts/product-tax-classification-registry.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
type Action = "catalog.tax-classification.manage" | "catalog.tax-classification.read";
type Mode = "Intent" | "Register" | "Replay" | "Read";
export interface CatalogTaxClassificationRegistryAuthority {
  /** Hold current Brand scope, Actor fine action and complete field policy through
   * outer COMMIT. Replay authorizes recovery, without requalifying old definitions. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly actorKind: "User" | "System";
      readonly purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY";
      readonly permission: "catalog.manage";
      readonly action: Action;
      readonly mode: Mode;
      readonly registry: CatalogProductTaxClassificationRegistry | null;
      readonly requiredFields: typeof taxClassificationRegistryFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
export interface ProductTaxClassificationRegistryStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: CatalogTaxClassificationRegistryAuthority;
  readonly audit?: {
    create(command: CatalogTaxClassificationRegistryCommand): AppendAuditRecordInput;
  };
  /** Required server UoW hook: run every async guard, then all final assertions
   * synchronously without yielding before COMMIT. Preserve the original lease. */
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
export interface CatalogCurrentTaxClassificationRegistry {
  readonly registry: CatalogProductTaxClassificationRegistry;
  readonly snapshotDigest: string;
  readonly observation: CatalogTaxClassificationRegistryObservation;
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
 FROM rms_catalog.product_tax_classification_registry_record WHERE tenant_id=$1 AND brand_id=$2`;
function decode(row: RecordRow, tenant: string, brand: string) {
  const command = parseCatalogTaxClassificationRegistryCommand(row.command),
    registry = parseCatalogProductTaxClassificationRegistry(row.registry);
  if (
    row.coherent !== true ||
    command.tenantReference !== tenant ||
    command.brandReference !== brand ||
    canonicalizeRfc8785(registry) !== canonicalizeRfc8785(command.registry) ||
    row.intent_digest !== command.intentDigest ||
    row.snapshot_digest !== command.snapshotDigest ||
    row.event_id !== catalogTaxClassificationRegistryEventId(command)
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
  hold(
    action: Action,
    mode: Mode,
    registry: CatalogProductTaxClassificationRegistry | null,
  ): Promise<void>;
  register(
    action: Action,
    mode: Mode,
    registry: CatalogProductTaxClassificationRegistry,
  ): Promise<void>;
}
export function createPostgresProductTaxClassificationRegistryStore(
  options: ProductTaxClassificationRegistryStoreOptions,
) {
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
    key = "CatalogTaxClassificationRegistry:" + tenant + ":" + brand,
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
                readonly registry: CatalogProductTaxClassificationRegistry;
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
                purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
                permission: "catalog.manage",
                action,
                mode,
                registry,
                requiredFields: taxClassificationRegistryFields,
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
              await capturedQuery("ROLLBACK TO SAVEPOINT catalog_tax_classification_write", []);
              await capturedQuery("RELEASE SAVEPOINT catalog_tax_classification_write", []);
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
          "SELECT count(*)::text n,COALESCE(sum(octet_length(snapshot_json::text)+octet_length(command_json::text)),0)::text bytes FROM rms_catalog.product_tax_classification_registry_record WHERE tenant_id=$1 AND brand_id=$2",
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
    let previous: CatalogProductTaxClassificationRegistry | null = null;
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
      assertCatalogProductTaxClassificationRegistrySuccessor(previous, command.registry);
      previous = command.registry;
    }
    return { current: previous, bytes: BigInt(r.bytes), count: Number(r.n) };
  };
  const withCurrentRegistry = async <T>(
    value: unknown,
    work: (source: CatalogCurrentTaxClassificationRegistry, tx: Transaction) => Promise<T>,
  ): Promise<T> => {
    const observation = parseCatalogTaxClassificationRegistryObservation(value);
    if (typeof work !== "function") return fail();
    return runHeld(observation.observedAt, observation.validUntil, async (h) => {
      await h.hold("catalog.tax-classification.read", "Read", null);
      await context(h);
      await h.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [key]);
      const registry = (await history(h)).current;
      if (!registry || registry.registeredAt > observation.observedAt) return fail();
      await h.hold("catalog.tax-classification.read", "Read", registry);
      await h.register("catalog.tax-classification.read", "Read", registry);
      const source = Object.freeze({
        registry,
        snapshotDigest: catalogProductTaxClassificationRegistryDigest(registry),
        observation,
        sourceAuthority: "CurrentTransactionHeld" as const,
      });
      h.check();
      const result = await work(source, h.tx);
      h.check();
      await h.hold("catalog.tax-classification.read", "Read", registry);
      h.check();
      return result;
    });
  };
  return Object.freeze({
    async execute(value: unknown) {
      const command = parseCatalogTaxClassificationRegistryCommand(value);
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
          await h.hold("catalog.tax-classification.manage", "Intent", null);
          await context(h);
          await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
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
            await h.hold("catalog.tax-classification.manage", "Replay", original.registry);
            await h.register("catalog.tax-classification.manage", "Replay", original.registry);
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
          assertCatalogProductTaxClassificationRegistrySuccessor(source.current, command.registry);
          await h.hold("catalog.tax-classification.manage", "Register", command.registry);
          await h.register("catalog.tax-classification.manage", "Register", command.registry);
          const commandJson = canonicalizeRfc8785(catalogTaxClassificationRegistryRequest(command)),
            registryJson = canonicalizeRfc8785(command.registry);
          const size = rows<{ bytes: string }>(
              await h.query(
                "SELECT (octet_length($1::jsonb::text)+octet_length($2::jsonb::text))::text bytes",
                [commandJson, registryJson],
              ),
            ),
            bytes = size[0]?.bytes;
          if (
            size.length !== 1 ||
            typeof bytes !== "string" ||
            !/^[1-9][0-9]*$/.test(bytes) ||
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
            audit.actionCode !== "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED" ||
            audit.targetType !== "CatalogTaxClassificationRegistry" ||
            audit.targetId !== command.registry.registryReference ||
            audit.reasonCode !== command.reasonCode ||
            audit.occurredAt !== command.occurredAt ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined ||
            audit.correctsAuditId !== undefined
          )
            return fail();
          const eventId = catalogTaxClassificationRegistryEventId(command);
          // A local savepoint also removes tentative rows if a borrowed runner's
          // caller catches this operation's error. Outer guards still poison COMMIT.
          await h.query("SAVEPOINT catalog_tax_classification_write", []);
          try {
            const inserted = await h.query(
              "INSERT INTO rms_catalog.product_tax_classification_registry_record(operation_id,tenant_id,brand_id,registry_id,version_id,registry_version,actor_id,intent_digest,snapshot_digest,occurred_at,command_json,snapshot_json,event_id,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)",
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
              eventType: "ProductTaxClassificationRegistryVersionRecorded",
              schemaVersion: 1,
              occurredAt: command.occurredAt,
              producerModule: "@rms/catalog",
              tenantId: brand,
              aggregateType: "CatalogTaxClassificationRegistry",
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
            await h.hold("catalog.tax-classification.manage", "Register", command.registry);
            h.check();
          } catch (error) {
            // Cleanup must remain possible after the lease/authority failed. It
            // uses the captured query only and never permits another business read.
            await h.rollbackWrite();
            throw error;
          }
          await h.query("RELEASE SAVEPOINT catalog_tax_classification_write", []);
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
    async withCurrentResolution<T>(
      value: unknown,
      work: (resolution: CatalogProductTaxClassificationResolution, tx: Transaction) => Promise<T>,
    ): Promise<T> {
      const request = parseCatalogProductTaxClassificationResolutionRequest(value);
      if (typeof work !== "function") return fail();
      return withCurrentRegistry(
        {
          originalIntentDigest: request.originalIntentDigest,
          observedAt: request.observedAt,
          validUntil: request.validUntil,
        },
        async (source, tx) =>
          work(resolveCatalogProductTaxClassification(source.registry, request), tx),
      );
    },
  });
}

import {
  appendOptionSetAuthoringIdentity,
  prepareOptionSetAuthoringIdentityIntent,
} from "./option-set-authoring-identity.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import {
  parseCatalogOptionSetEditorContent,
  type OptionSetEditorContent,
} from "../../contracts/option-set-editor-content.js";
import {
  createCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringIdentity,
  parseCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringResolutionCommand,
  type CatalogOptionSetAuthoringResolutionCommand,
  type CatalogOptionSetAuthoringResolution,
  type CatalogOptionSetAuthoringIdentity,
} from "../../contracts/option-set-authoring-resolution.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
export const optionSetAuthoringResolutionFields = Object.freeze([
  "operationReference",
  "originalActor",
  "reasonCode",
  "originalOccurredAt",
  "auditReference",
  "originalIntentDigest",
  "sourceAggregate",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
] as const);
export type OptionSetOriginalOperation =
  | Readonly<{ outcome: "Absent" }>
  | Readonly<{
      outcome: "Committed";
      identity: CatalogOptionSetAuthoringIdentity;
      content: OptionSetEditorContent;
    }>
  | Readonly<{ outcome: "Abandoned"; resolution: CatalogOptionSetAuthoringResolution }>;
export interface OptionSetAuthoringResolutionStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly registerBeforeCommit: (
    tx: Transaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: Readonly<{
        command: CatalogOptionSetAuthoringResolutionCommand;
        mode: "Write" | "Resolve";
        permission: "catalog.manage";
        requiredPermissions: readonly string[];
        requiredFields: typeof optionSetAuthoringResolutionFields;
        purposeCode: "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION";
        actorKind: "User";
        requiredScope: "FullBrandScope";
        observedAt: string;
      }>,
    ): Promise<Readonly<{ observedAt: string; validUntil: string }>>;
  };
  readonly audit: {
    create(
      input: Readonly<{
        command: CatalogOptionSetAuthoringResolutionCommand;
        resolution: CatalogOptionSetAuthoringResolution;
      }>,
    ): AppendAuditRecordInput;
  };
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
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
  return d.value.map((raw: unknown) => {
    const v = copyCategoryPersistenceValue(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
    return v as Record<string, unknown>;
  });
}
const identitySql = `SELECT i.identity_json,s.snapshot_json,
 (i.source_operation_id=s.operation_id AND i.tenant_id=s.tenant_id AND i.brand_id=s.brand_id
 AND i.option_set_id=s.option_set_id AND i.option_set_version_id=s.option_set_version_id
 AND i.source_action_code=s.action_code AND i.intent_digest=s.intent_digest AND i.result_aggregate_version=s.result_aggregate_version
 AND i.original_occurred_at=s.occurred_at AND i.source_digest=s.source_digest AND i.content_digest=s.content_digest AND i.configuration_digest=s.configuration_digest
 AND i.identity_json->>'digest'=i.identity_digest AND i.data_classification='ConfigurationMetadata') coherent
 FROM rms_catalog.option_set_authoring_identity i LEFT JOIN rms_catalog.option_set_draft_content_snapshot s ON s.operation_id=i.source_operation_id
 WHERE i.tenant_id=$1 AND i.brand_id=$2 AND i.operation_id=$3 LIMIT 2`;
/** Same original host and global operation fence. Recovery never qualifies today's
 * Draft or calls another Domain's private tables. No reference eligibility is asserted. */
export function createPostgresOptionSetAuthoringResolutionStore(
  options: OptionSetAuthoringResolutionStoreOptions,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    originalDeadline = parseCatalogInstant(options.originalValidUntil);
  if (
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function" ||
    typeof options.audit?.create !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    run = options.transactions.run.bind(options.transactions),
    auditFor = options.audit.create.bind(options.audit),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>(),
    recording = new WeakSet<object>(),
    finalized = new WeakSet<object>(),
    bindings = new WeakMap<object, { command: string; query: unknown }>();
  function command(value: unknown) {
    const c = parseCatalogOptionSetAuthoringResolutionCommand(value);
    if (c.tenantReference !== tenant || c.brandReference !== brand || c.actorReference !== actor)
      return fail("CATALOG_PERMISSION_DENIED");
    return c;
  }
  async function held<T>(
    tx: Transaction,
    c: CatalogOptionSetAuthoringResolutionCommand,
    mode: "Write" | "Resolve",
    work: () => Promise<T>,
    record = false,
  ): Promise<T> {
    const entered = record ? recording : active;
    if (entered.has(tx) || failed.has(tx) || finalized.has(tx)) {
      failed.add(tx);
      return fail();
    }
    entered.add(tx);
    const query = Object.getOwnPropertyDescriptor(tx, "query");
    if (!query || !("value" in query) || typeof query.value !== "function") {
      failed.add(tx);
      return fail();
    }
    const bound = bindings.get(tx),
      fingerprint = canonicalizeRfc8785(c);
    if (bound && (bound.command !== fingerprint || bound.query !== query.value)) {
      failed.add(tx);
      return fail();
    }
    if (!bound) bindings.set(tx, { command: fingerprint, query: query.value });
    let latest = parseCatalogInstant(now()),
      deadline = originalDeadline,
      ready = false,
      guardCalls = 0,
      guardComplete = false,
      finalCalls = 0,
      closed = false;
    if (deadline <= latest || Date.parse(deadline) - Date.parse(latest) > 5000) {
      failed.add(tx);
      return fail();
    }
    const check = () => {
      const at = parseCatalogInstant(now());
      if (
        failed.has(tx) ||
        closed ||
        Object.getOwnPropertyDescriptor(tx, "query")?.value !== query.value ||
        at < latest ||
        at >= deadline
      ) {
        failed.add(tx);
        return fail();
      }
      latest = at;
      return at;
    };
    const authorize = async () => {
      const observedAt = check(),
        result = await hold(tx, {
          command: c,
          mode,
          permission: "catalog.manage",
          requiredPermissions: Object.freeze([
            "catalog.manage",
            mode === "Resolve"
              ? "catalog.option_set.read"
              : c.action === "Create"
                ? "catalog.option_set.create"
                : "catalog.option_set.update",
          ]),
          requiredFields: optionSetAuthoringResolutionFields,
          purposeCode: "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION",
          actorKind: "User",
          requiredScope: "FullBrandScope",
          observedAt,
        });
      const detached = copyCategoryPersistenceValue(result);
      if (
        !detached ||
        typeof detached !== "object" ||
        Array.isArray(detached) ||
        Object.keys(detached).length !== 2 ||
        !("observedAt" in detached) ||
        !("validUntil" in detached) ||
        detached.observedAt !== observedAt
      )
        return fail();
      const until = parseCatalogInstant(detached.validUntil);
      if (until <= observedAt) return fail();
      if (until < deadline) deadline = until;
      check();
    };
    try {
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [tenant, brand],
      );
      check();
      await authorize();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CatalogFullOptionOperation:" + c.operationReference,
      ]);
      check();
      const registration = await register(
        tx,
        async () => {
          try {
            if (!ready || ++guardCalls !== 1) return fail();
            await authorize();
            guardComplete = true;
          } catch (error) {
            failed.add(tx);
            if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID")
              throw error;
            return fail();
          }
        },
        () => {
          check();
          if (!ready || !guardComplete || guardCalls !== 1 || ++finalCalls !== 1) {
            failed.add(tx);
            return fail();
          }
          closed = true;
          finalized.add(tx);
        },
      );
      if (registration !== undefined) return fail();
      const result = await work();
      check();
      await authorize();
      ready = true;
      return result;
    } catch (error) {
      failed.add(tx);
      if (error instanceof CatalogError && error.code !== "CATALOG_INPUT_INVALID") throw error;
      return fail();
    } finally {
      entered.delete(tx);
    }
  }
  function exact(
    c: CatalogOptionSetAuthoringResolutionCommand,
    other: CatalogOptionSetAuthoringResolutionCommand,
  ) {
    if (other.actorReference !== actor) return fail("CATALOG_PERMISSION_DENIED");
    if (!equal(c, other)) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  }
  async function inspect(
    tx: Transaction,
    c: CatalogOptionSetAuthoringResolutionCommand,
  ): Promise<OptionSetOriginalOperation> {
    const originals = rows(await tx.query(identitySql, [tenant, brand, c.operationReference])),
      original = originals[0];
    const fences = rows(
        await tx.query(
          "SELECT command_json,snapshot_json FROM rms_catalog.option_set_authoring_abandonment WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3 LIMIT 2",
          [tenant, brand, c.operationReference],
        ),
      ),
      fence = fences[0];
    if (original && fence) return fail();
    if (original) {
      if (original.coherent !== true) return fail();
      const identity = parseCatalogOptionSetAuthoringIdentity(original.identity_json);
      exact(c, identity.command);
      const content = copyCategoryPersistenceValue(original.snapshot_json);
      if (!content || typeof content !== "object" || Array.isArray(content)) return fail();
      const { sourceAggregate, ...additional } = content as Record<string, unknown>,
        prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
        root = prepared.content.sourceAggregate;
      if (
        root.brandReference !== brand ||
        root.optionSetReference !== identity.optionSetReference ||
        root.draft.versionReference !== identity.versionReference ||
        root.aggregateVersion !== identity.aggregateVersion ||
        root.updatedAt !== identity.originalOccurredAt ||
        prepared.sourceDigest !== identity.sourceDigest ||
        prepared.contentDigest !== identity.contentDigest ||
        prepared.configurationDigest !== identity.configurationDigest
      )
        return fail();
      return Object.freeze({ outcome: "Committed" as const, identity, content: prepared.content });
    }
    if (fence) {
      const resolution = parseCatalogOptionSetAuthoringResolution(fence.snapshot_json);
      exact(c, resolution.command);
      if (resolution.outcome !== "Abandoned" || !equal(fence.command_json, c)) return fail();
      return Object.freeze({ outcome: "Abandoned" as const, resolution });
    }
    const available = rows(
      await tx.query("SELECT rms_catalog.option_set_authoring_operation_available($1) available", [
        c.operationReference,
      ]),
    );
    if (available[0]?.available !== true) return fail("CATALOG_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ outcome: "Absent" as const });
  }
  async function resolveHeld(
    tx: Transaction,
    c: CatalogOptionSetAuthoringResolutionCommand,
  ): Promise<
    Readonly<{
      resolution: CatalogOptionSetAuthoringResolution;
      content: OptionSetEditorContent | null;
    }>
  > {
    return held(tx, c, "Resolve", async () => {
      const original = await inspect(tx, c);
      if (original.outcome === "Committed") {
        return Object.freeze({
          resolution: createCatalogOptionSetAuthoringResolution({
            outcome: "Committed",
            command: c,
            identity: original.identity,
            recordedAt: original.identity.originalOccurredAt,
          }),
          content: original.content,
        });
      }
      if (original.outcome === "Abandoned") {
        return Object.freeze({ resolution: original.resolution, content: null });
      }
      const resolution = createCatalogOptionSetAuthoringResolution({
          outcome: "Abandoned",
          command: c,
          identity: null,
          recordedAt: parseCatalogInstant(now()),
        }),
        audit = validateAuditRecord(
          copyCategoryPersistenceValue(auditFor({ command: c, resolution })),
        );
      if (
        audit.actor.type !== "User" ||
        audit.actor.reference !== actor ||
        audit.brandId !== brand ||
        audit.storeId !== undefined ||
        audit.actionCode !== "CATALOG_OPTION_SET_AUTHORING_ABANDONED" ||
        audit.targetType !== "CatalogOptionSetAuthoringOperation" ||
        audit.targetId !== c.operationReference ||
        audit.correlationId !== c.operationReference ||
        audit.reasonCode !== c.reasonCode ||
        audit.occurredAt !== resolution.recordedAt
      )
        return fail();
      await appendAuditRecordInTransaction(tx, audit);
      const inserted = await tx.query(
        "INSERT INTO rms_catalog.option_set_authoring_abandonment(operation_id,tenant_id,brand_id,actor_id,action_code,reason_code,requested_option_set_id,expected_aggregate_version,command_json,snapshot_json,resolution_digest,recorded_at,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)",
        [
          c.operationReference,
          tenant,
          brand,
          actor,
          c.action,
          c.reasonCode,
          c.optionSetReference,
          c.expectedAggregateVersion,
          canonicalizeRfc8785(c),
          canonicalizeRfc8785(resolution),
          resolution.digest,
          resolution.recordedAt,
          audit.auditId,
        ],
      );
      if (inserted.rowCount !== 1) return fail();
      return Object.freeze({ resolution, content: null });
    });
  }
  return Object.freeze({
    withOriginalOperation: <T>(
      tx: Transaction,
      value: unknown,
      work: (original: OptionSetOriginalOperation) => Promise<T>,
    ) => {
      const c = command(value);
      if (typeof work !== "function") return fail();
      return held(tx, c, "Write", async () => {
        const original = await inspect(tx, c);
        return work(original);
      });
    },
    /** Writer-only metadata append after its actual source snapshot and verified
     * Audit input exist in this original transaction. SQL requires the owning source
     * and operation xmin to be this transaction: legacy backfill is refused.
     * This is not an API request port and does not append Audit again. */
    async recordCommitted(
      tx: Transaction,
      value: unknown,
      sourceValue: unknown,
      auditValue: AppendAuditRecordInput,
    ): Promise<CatalogOptionSetAuthoringIdentity> {
      const prepared = prepareOptionSetAuthoringIdentityIntent(
        { tenantReference: tenant, brandReference: brand, actorReference: actor },
        value,
      );
      const c = command(prepared.command);
      return held(
        tx,
        c,
        "Write",
        () =>
          appendOptionSetAuthoringIdentity(
            tx,
            { tenantReference: tenant, brandReference: brand, actorReference: actor },
            value,
            sourceValue,
            auditValue,
          ),
        true,
      );
    },
    /** Result is tentative until the caller's original host runs these final guards. */
    resolveInTransaction: (tx: Transaction, value: unknown) => resolveHeld(tx, command(value)),
    async resolve(value: unknown): Promise<
      Readonly<{
        resolution: CatalogOptionSetAuthoringResolution;
        content: OptionSetEditorContent | null;
      }>
    > {
      const c = command(value);
      let calls = 0,
        txRef: Transaction | undefined;
      const result = await run(async (tx) => {
        txRef = tx;
        if (++calls !== 1) return fail();
        return resolveHeld(tx, c);
      });
      if (calls !== 1 || !txRef || !finalized.has(txRef) || failed.has(txRef)) return fail();
      return result;
    },
  });
}

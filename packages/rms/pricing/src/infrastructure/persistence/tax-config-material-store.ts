import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  appendEventInTransaction,
  loadOutboxEnvelope,
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { revalidateTenantContext, type PermissionDecision } from "@bop/permission";
import { parseCanonicalInstant, type TenantContext } from "@bop/tenant";
import { TaxConfigWorkflowError } from "../../application/tax-config-service.js";
import {
  parsePricingReference,
  parsePricingDigest,
  type PricingReference,
} from "../../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringScope,
  type TaxConfigAuthoringScope,
} from "../../contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialSummary,
  parseTaxConfigMaterialRoster,
  taxConfigMaterialContentDigest,
  taxConfigMaterialIntentDigest,
  taxConfigMaterialRequiredFields,
  type TaxConfigMaterialKind,
  type TaxConfigMaterialCommand,
  type TaxConfigMaterialResolve,
  type TaxConfigMaterialVersion,
  type TaxConfigMaterialOperation,
} from "../../contracts/tax-config-material.js";
import type { TaxConfigAuthoringTransaction } from "./tax-config-authoring-store.js";
export type TaxConfigMaterialTransaction = TaxConfigAuthoringTransaction;
type MaterialPins = Omit<TaxConfigMaterialCommand, "content">;
export interface TaxConfigMaterialStoreOptions {
  readonly transaction: TaxConfigMaterialTransaction;
  readonly scope: TaxConfigAuthoringScope;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: TaxConfigMaterialTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: TaxConfigMaterialTransaction,
      input: {
        scope: TaxConfigAuthoringScope;
        mode: "Read" | "Write" | "Resolve";
        permission: "pricing.tax-config.manage";
        purposeCode: "PRICING_TAX_CONFIG_MATERIAL";
        requiredFields: typeof taxConfigMaterialRequiredFields;
        command: MaterialPins | null;
        observedAt: string;
        validUntil: string;
      },
    ): Promise<{
      scope: TaxConfigAuthoringScope;
      tenantContext: TenantContext;
      permission: PermissionDecision;
      validUntil: string;
    }>;
  };
  readonly facts: {
    validateMaterial(
      tx: TaxConfigMaterialTransaction,
      input: {
        command: TaxConfigMaterialCommand;
        version: TaxConfigMaterialVersion;
        observedAt: string;
        validUntil: string;
      },
    ): Promise<void>;
  };
  readonly references: { generate(kind: "Material" | "Version" | "Audit" | "Event"): string };
  readonly audit: {
    create(input: {
      scope: TaxConfigAuthoringScope;
      command: MaterialPins;
      mode: "Write" | "Abandon";
      auditReference: string;
      materialReference: string | null;
      intentDigest: string;
      occurredAt: string;
    }): AppendAuditRecordInput;
  };
}
const digest = (v: unknown) => parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(v)));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const fail = (
  code: TaxConfigWorkflowError["code"] = "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new TaxConfigWorkflowError(code);
};
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return fail();
  return Object.fromEntries(
    keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d?.enumerable || !("value" in d)) return fail();
      return [k, d.value];
    }),
  );
}
const rootColumns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "material_id",
  "material_kind",
  "revision",
  "current_version_id",
  "created_at",
  "updated_at",
  "data_classification",
];
const versionColumns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "material_id",
  "version_id",
  "material_kind",
  "revision",
  "previous_version_id",
  "operation_id",
  "actor_id",
  "version_json",
  "version_text",
  "version_digest",
  "content_digest",
  "recorded_at",
  "data_classification",
];
const operationColumns = [
  "operation_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "actor_id",
  "action_code",
  "requested_material_id",
  "expected_revision",
  "material_kind",
  "intent_digest",
  "outcome",
  "result_material_id",
  "result_version_id",
  "result_revision",
  "receipt_json",
  "receipt_text",
  "receipt_digest",
  "audit_id",
  "audit_json",
  "event_id",
  "occurred_at",
  "data_classification",
];
const time = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ${column}`;
const rootSelect = `SELECT tenant_id::text,brand_id::text,store_id::text,material_id::text,material_kind,revision,current_version_id::text,${time("created_at")},${time("updated_at")},data_classification FROM rms_pricing.tax_config_material`;
const versionSelect = `SELECT tenant_id::text,brand_id::text,store_id::text,material_id::text,version_id::text,material_kind,revision,previous_version_id::text,operation_id::text,actor_id::text,version_json,version_text,version_digest,content_digest,${time("recorded_at")},data_classification FROM rms_pricing.tax_config_material_version`;
const originalSelect = `SELECT operation_id::text,tenant_id::text,brand_id::text,store_id::text,actor_id::text,action_code,requested_material_id::text,expected_revision,material_kind,intent_digest,outcome,result_material_id::text,result_version_id::text,result_revision,receipt_json,receipt_text,receipt_digest,audit_id::text,audit_json,event_id::text,${time("occurred_at")},data_classification FROM rms_pricing.tax_config_material_operation`;
/** Per actual host transaction: Confidential recorded materials are never qualification evidence. */
export function createPostgresTaxConfigMaterialStore(options: TaxConfigMaterialStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    scope = parseTaxConfigAuthoringScope(options.scope),
    scopeOwner = options.scope;
  const clock = options.clock,
    clockPort = clock.now,
    authority = options.authority,
    authorityPort = authority.holdUntilTransactionCompletes,
    facts = options.facts,
    factsPort = facts.validateMaterial,
    refs = options.references,
    referencePort = refs.generate,
    auditOwner = options.audit,
    auditPort = auditOwner.create,
    registerPort = options.registerBeforeCommit;
  const origin = String(parseCanonicalInstant(options.originalObservedAt)),
    initialUntil = String(parseCanonicalInstant(options.originalValidUntil));
  let deadline = initialUntil,
    latest = origin,
    phase: "Work" | "Checks" | "Final" = "Work",
    active = false,
    failed = false,
    registered = false,
    guardDone = false,
    guardCalls = 0,
    finalCalls = 0;
  const records: { receipt: TaxConfigMaterialOperation; write: boolean }[] = [],
    reads: {
      reference: string | null;
      kind: TaxConfigMaterialKind;
      version: TaxConfigMaterialVersion | null;
      historical: boolean;
    }[] = [],
    pages: {
      kind: TaxConfigMaterialKind;
      after: string | null;
      page: Awaited<ReturnType<typeof roster>>;
    }[] = [];
  if (
    Date.parse(initialUntil) <= Date.parse(origin) ||
    Date.parse(initialUntil) - Date.parse(origin) > 5000 ||
    [queryPort, clockPort, authorityPort, factsPort, referencePort, auditPort, registerPort].some(
      (p) => typeof p !== "function",
    )
  )
    return fail();
  function check(): string {
    if (
      failed ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.scope !== scopeOwner ||
      !equal(parseTaxConfigAuthoringScope(scopeOwner), scope) ||
      options.clock !== clock ||
      clock.now !== clockPort ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== authorityPort ||
      options.facts !== facts ||
      facts.validateMaterial !== factsPort ||
      options.references !== refs ||
      refs.generate !== referencePort ||
      options.audit !== auditOwner ||
      auditOwner.create !== auditPort ||
      options.registerBeforeCommit !== registerPort ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== initialUntil
    ) {
      failed = true;
      return fail();
    }
    const at = String(parseCanonicalInstant(clockPort.call(clock)));
    if (at < latest || at < origin || at >= deadline) {
      failed = true;
      return fail();
    }
    latest = at;
    return at;
  }
  function tighten(until: unknown) {
    const parsed = String(parseCanonicalInstant(until));
    if (parsed < deadline) deadline = parsed;
    check();
  }
  async function query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ) {
    const at = check(),
      remaining = Date.parse(deadline) - Date.parse(at);
    await queryPort.call(
      tx,
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
      [String(remaining)],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    if (
      !result ||
      !Array.isArray(result.rows) ||
      (result.rowCount !== null && (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0))
    )
      return fail();
    return result as { rows: readonly Row[]; rowCount: number | null };
  }
  async function restore() {
    await query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
  }
  async function hold(mode: "Read" | "Write" | "Resolve", command: MaterialPins | null) {
    const value = await authorityPort.call(authority, tx, {
      scope,
      mode,
      permission: "pricing.tax-config.manage",
      purposeCode: "PRICING_TAX_CONFIG_MATERIAL",
      requiredFields: taxConfigMaterialRequiredFields,
      command,
      observedAt: check(),
      validUntil: deadline,
    });
    check();
    const packet = closed(value, ["scope", "tenantContext", "permission", "validUntil"]);
    if (!equal(parseTaxConfigAuthoringScope(packet.scope), scope))
      return fail("TAX_CONFIG_PERMISSION_DENIED");
    const context = revalidateTenantContext(value.tenantContext),
      decision = closed(packet.permission, [
        "effect",
        "reason",
        "source",
        "action",
        "scopeKind",
        "policySnapshotReference",
        "policyVersion",
        "audit",
      ]);
    const permissionAudit = closed(decision.audit, ["effect", "reason", "source"]);
    if (
      context.scopeKind !== "Store" ||
      context.actor.actorReference === null ||
      parsePricingReference(String(context.actor.actorReference)) !== scope.actorReference ||
      parsePricingReference(String(context.brand.brandReference)) !== scope.brandReference ||
      context.store === null ||
      parsePricingReference(String(context.store.storeReference)) !== scope.storeReference ||
      String(context.resolvedAt) > check() ||
      String(context.resolvedAt) < origin ||
      decision.effect !== "Allow" ||
      decision.action !== "pricing.tax-config.manage" ||
      decision.scopeKind !== "Store" ||
      !(
        (decision.reason === "ROLE_PERMISSION" && decision.source === "RolePermission") ||
        (decision.reason === "EXPLICIT_ALLOW" && decision.source === "ExplicitAllow")
      ) ||
      !Number.isSafeInteger(decision.policyVersion) ||
      Number(decision.policyVersion) < 1 ||
      permissionAudit.effect !== decision.effect ||
      permissionAudit.reason !== decision.reason ||
      permissionAudit.source !== decision.source
    )
      return fail("TAX_CONFIG_PERMISSION_DENIED");
    parsePricingReference(decision.policySnapshotReference);
    tighten(packet.validUntil);
    await restore();
    return { tenantContext: context, permission: value.permission };
  }
  function scoped(row: Record<string, unknown>) {
    if (
      row.tenant_id !== scope.tenantReference ||
      row.brand_id !== scope.brandReference ||
      row.store_id !== scope.storeReference ||
      row.data_classification !== "Confidential"
    )
      return fail();
  }
  async function rootLock(reference: string, write: boolean) {
    await restore();
    await query(
      `SELECT ${write ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('PricingTaxMaterialRoot:'||$1||':'||$2||':'||$3||':'||$4,0))`,
      [scope.tenantReference, scope.brandReference, scope.storeReference, reference],
    );
  }
  function reference(kind: Parameters<TaxConfigMaterialStoreOptions["references"]["generate"]>[0]) {
    check();
    const v = parsePricingReference(referencePort.call(refs, kind));
    check();
    return v;
  }
  function pins(c: TaxConfigMaterialCommand | TaxConfigMaterialResolve): MaterialPins {
    return {
      action: c.action,
      operationReference: c.operationReference,
      materialReference: c.materialReference,
      expectedRevision: c.expectedRevision,
      materialKind: c.materialKind,
    };
  }
  function eventFor(r: TaxConfigMaterialOperation): DomainEventEnvelope {
    const v = r.version;
    if (!v || !r.eventReference) return fail();
    return {
      eventId: r.eventReference,
      eventType:
        r.action === "CreateMaterial" ? "TaxConfigMaterialCreated" : "TaxConfigMaterialReplaced",
      schemaVersion: 1,
      occurredAt: r.occurredAt,
      producerModule: "@rms/pricing",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "PricingTaxConfigMaterial",
      aggregateId: v.materialReference,
      aggregateVersion: BigInt(v.revision),
      correlationId: r.operationReference,
      causationId: r.operationReference,
      actor: { type: "Actor", actorId: r.actorReference },
      payload: {
        materialReference: v.materialReference,
        versionReference: v.versionReference,
        materialKind: v.materialKind,
        revision: v.revision,
        contentDigest: v.contentDigest,
        recordedAt: v.recordedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { auditReference: r.auditReference, originalIntentDigest: r.intentDigest },
    };
  }
  function auditMatches(
    value: AppendAuditRecordInput,
    r: Pick<
      TaxConfigMaterialOperation,
      | "actorReference"
      | "operationReference"
      | "action"
      | "outcome"
      | "occurredAt"
      | "auditReference"
      | "intentDigest"
    > & { version: Pick<TaxConfigMaterialVersion, "materialReference"> | null },
  ) {
    if (
      value.auditId !== r.auditReference ||
      value.brandId !== scope.brandReference ||
      value.storeId !== scope.storeReference ||
      value.actor.type !== "User" ||
      value.actor.reference !== r.actorReference ||
      value.correlationId !== r.operationReference ||
      value.occurredAt !== r.occurredAt ||
      !equal(value.afterSummary, { intentDigest: r.intentDigest }) ||
      value.beforeSummary !== undefined ||
      value.dataClassification !== "Confidential" ||
      value.reasonCode !== "AUTHORIZED_OPERATION" ||
      value.targetType !==
        (r.outcome === "Abandoned" ? "PricingTaxMaterialOperation" : "PricingTaxConfigMaterial") ||
      value.targetId !== (r.version?.materialReference ?? r.operationReference) ||
      value.actionCode !==
        (r.outcome === "Abandoned"
          ? "PRICING_TAX_MATERIAL_RESOLVE"
          : "PRICING_TAX_MATERIAL_" + r.action.toUpperCase())
    )
      return fail();
  }
  function createAudit(
    command: TaxConfigMaterialCommand | TaxConfigMaterialResolve,
    mode: "Write" | "Abandon",
    material: string | null,
    intent: string,
    at: string,
  ) {
    const auditReference = reference("Audit"),
      audit = validateAuditRecord(
        auditPort.call(auditOwner, {
          scope,
          command: pins(command),
          mode,
          auditReference,
          materialReference: material,
          intentDigest: intent,
          occurredAt: at,
        }),
        Date.parse(check()),
      );
    check();
    auditMatches(audit, {
      actorReference: scope.actorReference,
      operationReference: command.operationReference,
      action: command.action,
      outcome: mode === "Write" ? "Committed" : "Abandoned",
      occurredAt: at,
      auditReference,
      intentDigest: parsePricingDigest(intent),
      version: material === null ? null : { materialReference: parsePricingReference(material) },
    });
    return audit;
  }
  async function loadRoot(material: string) {
    await restore();
    const result = await query(
      rootSelect + " WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND material_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, material],
    );
    if (result.rows.length > 1) return fail();
    if (!result.rows.length) return null;
    const row = closed(result.rows[0], rootColumns);
    scoped(row);
    if (row.material_id !== material || !Number.isInteger(row.revision) || Number(row.revision) < 1)
      return fail();
    parsePricingReference(row.current_version_id);
    parseCanonicalInstant(row.created_at);
    parseCanonicalInstant(row.updated_at);
    return row;
  }
  async function loadVersion(version: string): Promise<TaxConfigMaterialVersion | null> {
    await restore();
    const result = await query(
      versionSelect + " WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND version_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, version],
    );
    if (result.rows.length > 1) return fail();
    if (!result.rows.length) return null;
    const row = closed(result.rows[0], versionColumns);
    scoped(row);
    let v: TaxConfigMaterialVersion;
    try {
      v = parseTaxConfigMaterialVersion(row.version_json);
    } catch {
      return fail();
    }
    if (
      row.version_text !== canonicalizeRfc8785(v) ||
      row.version_digest !== digest(v) ||
      row.version_id !== v.versionReference ||
      row.material_id !== v.materialReference ||
      row.material_kind !== v.materialKind ||
      row.revision !== v.revision ||
      row.previous_version_id !== v.previousVersionReference ||
      row.actor_id !== v.recordedByActorReference ||
      row.content_digest !== v.contentDigest ||
      row.recorded_at !== v.recordedAt ||
      v.tenantReference !== scope.tenantReference ||
      v.brandReference !== scope.brandReference ||
      v.storeReference !== scope.storeReference
    )
      return fail();
    parsePricingReference(row.operation_id);
    const root = await loadRoot(v.materialReference);
    if (
      !root ||
      root.material_kind !== v.materialKind ||
      Number(root.revision) < v.revision ||
      root.created_at !== v.createdAt
    )
      return fail();
    return v;
  }
  async function current(material: string, kind: TaxConfigMaterialKind, lock = true) {
    if (lock) await rootLock(material, false);
    const root = await loadRoot(material);
    if (!root) return null;
    if (root.material_kind !== kind) return fail("TAX_CONFIG_INPUT_INVALID");
    const v = await loadVersion(String(root.current_version_id));
    if (!v || v.revision !== root.revision || v.recordedAt !== root.updated_at) return fail();
    await verifyVersion(v);
    return v;
  }
  async function original(
    op: string,
    requireActor = true,
  ): Promise<TaxConfigMaterialOperation | null> {
    await restore();
    const result = await query(originalSelect + " WHERE operation_id=$1", [op]);
    if (result.rows.length > 1) return fail();
    if (!result.rows.length) return null;
    const row = closed(result.rows[0], operationColumns);
    scoped(row);
    let r: TaxConfigMaterialOperation;
    try {
      r = parseTaxConfigMaterialOperation(row.receipt_json);
    } catch {
      return fail();
    }
    if (
      r.tenantReference !== scope.tenantReference ||
      r.brandReference !== scope.brandReference ||
      r.storeReference !== scope.storeReference ||
      (requireActor && r.actorReference !== scope.actorReference)
    )
      return fail("TAX_CONFIG_PERMISSION_DENIED");
    if (
      row.operation_id !== op ||
      r.operationReference !== op ||
      row.actor_id !== r.actorReference ||
      row.action_code !== r.action ||
      row.requested_material_id !== r.materialReference ||
      row.expected_revision !== r.expectedRevision ||
      row.material_kind !== r.materialKind ||
      row.intent_digest !== r.intentDigest ||
      row.outcome !== r.outcome ||
      row.receipt_text !== canonicalizeRfc8785(r) ||
      row.receipt_digest !== digest(r) ||
      row.audit_id !== r.auditReference ||
      row.event_id !== r.eventReference ||
      row.occurred_at !== r.occurredAt
    )
      return fail();
    auditMatches(validateAuditRecord(row.audit_json, Date.parse(r.occurredAt)), r);
    if (r.version) {
      const v = await loadVersion(r.version.versionReference);
      if (
        !v ||
        !equal(v, r.version) ||
        row.result_material_id !== v.materialReference ||
        row.result_version_id !== v.versionReference ||
        row.result_revision !== v.revision
      )
        return fail();
      const versionRows = await query(
        "SELECT operation_id::text FROM rms_pricing.tax_config_material_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND version_id=$4",
        [scope.tenantReference, scope.brandReference, scope.storeReference, v.versionReference],
      );
      if (
        versionRows.rows.length !== 1 ||
        closed(versionRows.rows[0], ["operation_id"]).operation_id !== op
      )
        return fail();
      if (!r.eventReference) return fail();
      const envelope = await loadOutboxEnvelope({ query }, r.eventReference);
      check();
      if (!envelope) return fail();
      validateDomainEventEnvelope(envelope);
      const expected = eventFor(r);
      if (
        !equal(
          { ...envelope, aggregateVersion: String(envelope.aggregateVersion) },
          { ...expected, aggregateVersion: String(expected.aggregateVersion) },
        )
      )
        return fail();
    } else if (
      row.result_material_id !== null ||
      row.result_version_id !== null ||
      row.result_revision !== null
    )
      return fail();
    return r;
  }
  async function verifyVersion(v: TaxConfigMaterialVersion) {
    const result = await query(
      "SELECT operation_id::text FROM rms_pricing.tax_config_material_version WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND version_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, v.versionReference],
    );
    if (result.rows.length !== 1) return fail();
    const op = parsePricingReference(closed(result.rows[0], ["operation_id"]).operation_id),
      r = await original(op, false);
    if (!r?.version || !equal(r.version, v)) return fail();
  }
  async function historical(ref: string) {
    const v = await loadVersion(ref);
    if (v) await verifyVersion(v);
    return v;
  }
  async function lockOriginal(op: string) {
    await restore();
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended('PricingTaxMaterialOriginal:'||$1,0))",
      [op],
    );
    const r = await original(op);
    if (r) return r;
    const available = await query(
      "SELECT rms_pricing.tax_config_material_operation_available($1) available",
      [op],
    );
    if (available.rows.length !== 1 || closed(available.rows[0], ["available"]).available !== true)
      return fail();
    return null;
  }
  function match(
    r: TaxConfigMaterialOperation,
    c: TaxConfigMaterialCommand | TaxConfigMaterialResolve,
    intent: string,
  ) {
    if (!equal(pins(r), pins(c)) || r.intentDigest !== intent)
      return fail("TAX_CONFIG_IDEMPOTENCY_CONFLICT");
  }
  async function appendOriginal(r: TaxConfigMaterialOperation, audit: AppendAuditRecordInput) {
    await restore();
    const v = r.version,
      text = canonicalizeRfc8785(r),
      values = [
        r.operationReference,
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        scope.actorReference,
        r.action,
        r.materialReference,
        r.expectedRevision,
        r.materialKind,
        r.intentDigest,
        r.outcome,
        v?.materialReference ?? null,
        v?.versionReference ?? null,
        v?.revision ?? null,
        text,
        text,
        digest(r),
        r.auditReference,
        canonicalizeRfc8785(audit),
        r.eventReference,
        r.occurredAt,
        "Confidential",
      ];
    const result = await query(
      `INSERT INTO rms_pricing.tax_config_material_operation(${operationColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21,$22)`,
      values,
    );
    if (result.rowCount !== 1) return fail();
    const actual = await original(r.operationReference);
    if (!actual || !equal(actual, r)) return fail();
    return actual;
  }
  async function validate(command: TaxConfigMaterialCommand, version: TaxConfigMaterialVersion) {
    if (
      (await factsPort.call(facts, tx, {
        command,
        version,
        observedAt: check(),
        validUntil: deadline,
      })) !== undefined
    )
      return fail();
    check();
    await restore();
  }
  async function write(command: TaxConfigMaterialCommand, intent: string) {
    await hold("Write", pins(command));
    const material = command.materialReference ?? reference("Material");
    await rootLock(material, true);
    const prior = await current(material, command.materialKind, false);
    if ((prior?.revision ?? null) !== command.expectedRevision)
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    const at = check(),
      version = parseTaxConfigMaterialVersion({
        profile: "TaxConfigMaterialVersionV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        materialReference: material,
        versionReference: reference("Version"),
        revision: (prior?.revision ?? 0) + 1,
        previousVersionReference: prior?.versionReference ?? null,
        materialKind: command.materialKind,
        content: command.content,
        contentDigest: taxConfigMaterialContentDigest(command.content, command.materialKind),
        recordedByActorReference: scope.actorReference,
        createdAt: prior?.createdAt ?? at,
        recordedAt: at,
        dataClassification: "Confidential",
        status: "Recorded",
        qualification: "NotEvaluated",
      });
    await validate(command, version);
    await hold("Write", pins(command));
    const audit = createAudit(command, "Write", material, intent, at);
    await appendAuditRecordInTransaction({ query }, audit);
    check();
    await restore();
    if (!prior) {
      const inserted = await query(
        `INSERT INTO rms_pricing.tax_config_material(${rootColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          material,
          command.materialKind,
          version.revision,
          version.versionReference,
          version.createdAt,
          version.recordedAt,
          "Confidential",
        ],
      );
      if (inserted.rowCount !== 1) return fail();
    }
    const text = canonicalizeRfc8785(version),
      inserted = await query(
        `INSERT INTO rms_pricing.tax_config_material_version(${versionColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)`,
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          material,
          version.versionReference,
          version.materialKind,
          version.revision,
          version.previousVersionReference,
          command.operationReference,
          scope.actorReference,
          text,
          text,
          digest(version),
          version.contentDigest,
          at,
          "Confidential",
        ],
      );
    if (inserted.rowCount !== 1) return fail();
    if (prior) {
      const updated = await query(
        "UPDATE rms_pricing.tax_config_material SET revision=$1,current_version_id=$2,updated_at=$3 WHERE tenant_id=$4 AND brand_id=$5 AND store_id=$6 AND material_id=$7 AND revision=$8 AND current_version_id=$9",
        [
          version.revision,
          version.versionReference,
          at,
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          material,
          prior.revision,
          prior.versionReference,
        ],
      );
      if (updated.rowCount !== 1) return fail("TAX_CONFIG_VERSION_CONFLICT");
    }
    const receipt = parseTaxConfigMaterialOperation({
      profile: "TaxConfigMaterialOperationV1",
      ...scope,
      ...pins(command),
      command,
      intentDigest: intent,
      outcome: "Committed",
      version,
      auditReference: audit.auditId,
      eventReference: reference("Event"),
      occurredAt: at,
    });
    const event = eventFor(receipt);
    validateDomainEventEnvelope(event);
    await appendEventInTransaction({ query }, event);
    check();
    const actual = await appendOriginal(receipt, audit);
    await hold("Write", pins(command));
    records.push({ receipt: actual, write: true });
    return actual;
  }
  async function roster(kind: TaxConfigMaterialKind, after: string | null) {
    await restore();
    const result = await query(
      "SELECT material_id::text FROM rms_pricing.tax_config_material WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND material_kind=$4 AND ($5::uuid IS NULL OR material_id>$5) ORDER BY material_id LIMIT 51",
      [scope.tenantReference, scope.brandReference, scope.storeReference, kind, after],
    );
    if (result.rows.length > 51) return fail();
    const ids = result.rows.map((r) =>
      parsePricingReference(closed(r, ["material_id"]).material_id),
    );
    if (ids.some((ref, i) => ref <= (i === 0 ? (after ?? "") : (ids[i - 1] ?? "")))) return fail();
    const entries = [];
    for (const id of ids.slice(0, 50)) {
      const v = await current(id, kind);
      if (!v) return fail();
      entries.push(
        parseTaxConfigMaterialSummary({
          tenantReference: v.tenantReference,
          brandReference: v.brandReference,
          storeReference: v.storeReference,
          materialReference: v.materialReference,
          versionReference: v.versionReference,
          revision: v.revision,
          materialKind: v.materialKind,
          contentDigest: v.contentDigest,
          recordedAt: v.recordedAt,
          status: v.status,
          qualification: v.qualification,
        }),
      );
    }
    const last = entries.at(-1);
    return {
      entries: Object.freeze(entries),
      next: ids.length > 50 ? (last?.materialReference ?? fail()) : null,
    };
  }
  async function register() {
    if (registered) return;
    registered = true;
    const result = await registerPort(
      tx,
      async () => {
        if (phase !== "Work" || active || ++guardCalls !== 1) {
          failed = true;
          return fail();
        }
        phase = "Checks";
        try {
          for (const record of records) {
            await hold(
              record.write ? "Write" : record.receipt.outcome === "Abandoned" ? "Resolve" : "Read",
              pins(record.receipt),
            );
            const actual = await original(record.receipt.operationReference);
            if (!actual || !equal(actual, record.receipt)) return fail();
            if (record.write) {
              if (!record.receipt.command || !record.receipt.version) return fail();
              await validate(record.receipt.command, record.receipt.version);
            }
          }
          for (const r of reads) {
            await hold("Read", null);
            const v =
              r.reference === null
                ? null
                : r.historical
                  ? await historical(r.reference)
                  : await current(r.reference, r.kind);
            if (!equal(v, r.version)) return fail("TAX_CONFIG_VERSION_CONFLICT");
          }
          for (const p of pages) {
            await hold("Read", null);
            if (!equal(await roster(p.kind, p.after), p.page))
              return fail("TAX_CONFIG_VERSION_CONFLICT");
          }
          await hold("Read", null);
          await restore();
          await query(
            "SET CONSTRAINTS rms_pricing.tax_config_material_version_coherence,rms_pricing.tax_config_material_operation_coherence,rms_pricing.tax_config_material_root_coherence IMMEDIATE",
          );
          check();
          guardDone = true;
        } catch (error) {
          failed = true;
          if (error instanceof TaxConfigWorkflowError) throw error;
          return fail();
        }
      },
      () => {
        if (phase !== "Checks" || !guardDone || active || ++finalCalls !== 1) {
          failed = true;
          return fail();
        }
        check();
        phase = "Final";
      },
    );
    if (result !== undefined) return fail();
    check();
  }
  async function run<T>(work: () => Promise<T>) {
    if (active || phase !== "Work") {
      failed = true;
      return fail();
    }
    active = true;
    try {
      check();
      if (records.length + reads.length + pages.length >= 64) return fail();
      await register();
      return await work();
    } catch (error) {
      failed = true;
      if (error instanceof TaxConfigWorkflowError) throw error;
      return fail();
    } finally {
      active = false;
    }
  }
  function readInput(
    value: unknown,
    field: "materialReference" | "versionReference" | "afterMaterial",
  ): { kind: TaxConfigMaterialKind; reference: PricingReference | null } {
    const r = closed(value, ["materialKind", field]);
    if (
      r.materialKind !== "RegistrationApplicability" &&
      r.materialKind !== "ProfessionalReport" &&
      r.materialKind !== "FixtureSuite"
    )
      return fail("TAX_CONFIG_INPUT_INVALID");
    return {
      kind: r.materialKind,
      reference:
        r[field] === null && field !== "versionReference" ? null : parsePricingReference(r[field]),
    };
  }
  return Object.freeze({
    readCurrent(value: unknown) {
      return run(async () => {
        const input = readInput(value, "materialReference");
        await hold("Read", null);
        const v = input.reference === null ? null : await current(input.reference, input.kind);
        await hold("Read", null);
        reads.push({ reference: input.reference, kind: input.kind, version: v, historical: false });
        return parseTaxConfigMaterialCurrent({
          profile: "TaxConfigMaterialCurrentV1",
          ...scope,
          materialReference: input.reference,
          materialKind: input.kind,
          version: v,
          observedAt: check(),
          validUntil: deadline,
          qualification: "NotEvaluated",
        });
      });
    },
    readVersion(value: unknown) {
      return run(async () => {
        const input = readInput(value, "versionReference");
        await hold("Read", null);
        if (input.reference === null) return fail();
        const v = await loadVersion(input.reference);
        if (!v || v.materialKind !== input.kind) return fail("TAX_CONFIG_VERSION_CONFLICT");
        await rootLock(v.materialReference, false);
        const again = await historical(input.reference);
        if (!equal(v, again)) return fail();
        await hold("Read", null);
        reads.push({ reference: input.reference, kind: input.kind, version: v, historical: true });
        return parseTaxConfigMaterialCurrent({
          profile: "TaxConfigMaterialCurrentV1",
          ...scope,
          materialReference: v.materialReference,
          materialKind: input.kind,
          version: v,
          observedAt: check(),
          validUntil: deadline,
          qualification: "NotEvaluated",
        });
      });
    },
    readRoster(value: unknown) {
      return run(async () => {
        const input = readInput(value, "afterMaterial");
        await hold("Read", null);
        const page = await roster(input.kind, input.reference);
        await hold("Read", null);
        pages.push({ kind: input.kind, after: input.reference, page });
        return parseTaxConfigMaterialRoster({
          profile: "TaxConfigMaterialRosterV1",
          ...scope,
          materialKind: input.kind,
          afterMaterial: input.reference,
          entries: page.entries,
          nextAfterMaterial: page.next,
          observedAt: check(),
          validUntil: deadline,
          qualification: "NotEvaluated",
        });
      });
    },
    execute(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigMaterialCommand(value),
          intent = taxConfigMaterialIntentDigest(scope, command);
        await hold("Read", pins(command));
        const replay = await lockOriginal(command.operationReference);
        if (replay) {
          match(replay, command, intent);
          records.push({ receipt: replay, write: false });
          return replay;
        }
        return write(command, intent);
      });
    },
    resolveOriginal(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigMaterialResolve(value);
        await hold("Resolve", pins(command));
        const replay = await lockOriginal(command.operationReference);
        if (replay) {
          match(replay, command, command.intentDigest);
          records.push({ receipt: replay, write: false });
          return replay;
        }
        if (command.materialReference) await rootLock(command.materialReference, true);
        const at = check(),
          audit = createAudit(command, "Abandon", null, command.intentDigest, at);
        await appendAuditRecordInTransaction({ query }, audit);
        check();
        const r = parseTaxConfigMaterialOperation({
          profile: "TaxConfigMaterialOperationV1",
          ...scope,
          ...pins(command),
          command: null,
          intentDigest: command.intentDigest,
          outcome: "Abandoned",
          version: null,
          auditReference: audit.auditId,
          eventReference: null,
          occurredAt: at,
        });
        const actual = await appendOriginal(r, audit);
        await hold("Resolve", pins(command));
        records.push({ receipt: actual, write: false });
        return actual;
      });
    },
    assertFinalized() {
      if (
        active ||
        phase !== "Final" ||
        !registered ||
        !guardDone ||
        guardCalls !== 1 ||
        finalCalls !== 1
      ) {
        failed = true;
        return fail();
      }
      check();
      return deadline;
    },
  });
}

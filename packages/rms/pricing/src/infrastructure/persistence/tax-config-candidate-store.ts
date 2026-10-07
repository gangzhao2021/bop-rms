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
import { parsePricingReference, parsePricingDigest } from "../../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringScope,
  type TaxConfigAuthoringScope,
} from "../../contracts/tax-config-authoring.js";
import {
  createPostgresTaxConfigAuthoringStore,
  type TaxConfigAuthoringStoreOptions,
  type TaxConfigAuthoringTransaction,
} from "./tax-config-authoring-store.js";
import {
  createPostgresTaxConfigMaterialStore,
  type TaxConfigMaterialStoreOptions,
} from "./tax-config-material-store.js";
import { createTaxPublicationCandidate } from "../../contracts/tax-config-publication-candidate.js";
import {
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateRecord,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateSummary,
  parseTaxConfigCandidateRoster,
  createTaxConfigCandidateRecord,
  assertTaxConfigCandidateSources,
  taxConfigCandidateIntentDigest,
  taxConfigCandidateRequiredFields,
  type TaxConfigCandidateCommand,
  type TaxConfigCandidateResolve,
  type TaxConfigCandidateRecord,
  type TaxConfigCandidateOperation,
} from "../../contracts/tax-config-candidate-authoring.js";
export type TaxConfigCandidateTransaction = TaxConfigAuthoringTransaction;
export interface TaxConfigCandidateStoreOptions {
  readonly transaction: TaxConfigCandidateTransaction;
  readonly scope: TaxConfigAuthoringScope;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: TaxConfigCandidateTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: TaxConfigCandidateTransaction,
      input: {
        scope: TaxConfigAuthoringScope;
        mode: "Read" | "Write" | "Resolve";
        permission: "pricing.tax-config.manage";
        purposeCode: "PRICING_TAX_CONFIG_CANDIDATE";
        requiredFields: typeof taxConfigCandidateRequiredFields;
        command: TaxConfigCandidateCommand | null;
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
  readonly draftSource: TaxConfigAuthoringStoreOptions;
  readonly materialSource: TaxConfigMaterialStoreOptions;
  readonly references: { generate(kind: "Version" | "Rule" | "Audit" | "Event"): string };
  readonly audit: {
    create(input: {
      scope: TaxConfigAuthoringScope;
      command: TaxConfigCandidateCommand;
      mode: "Write" | "Abandon";
      auditReference: string;
      targetVersionReference: string | null;
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
const recordColumns = [
  "target_version_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "configuration_id",
  "actor_id",
  "operation_id",
  "base_version_id",
  "base_snapshot_digest",
  "base_aggregate_version",
  "base_version_number",
  "target_aggregate_version",
  "target_version_number",
  "registration_material_id",
  "registration_version_id",
  "registration_content_digest",
  "content_digest",
  "record_json",
  "record_text",
  "record_digest",
  "audit_id",
  "event_id",
  "prepared_at",
  "data_classification",
];
const operationColumns = [
  "operation_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "actor_id",
  "action_code",
  "configuration_id",
  "expected_base_version_id",
  "expected_base_snapshot_digest",
  "expected_base_aggregate_version",
  "expected_base_version_number",
  "registration_material_id",
  "registration_version_id",
  "registration_content_digest",
  "intent_digest",
  "outcome",
  "result_target_version_id",
  "receipt_json",
  "receipt_text",
  "receipt_digest",
  "audit_id",
  "audit_json",
  "event_id",
  "occurred_at",
  "data_classification",
];
const ruleColumns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "configuration_id",
  "base_version_id",
  "target_version_id",
  "source_rule_id",
  "target_rule_id",
  "rule_ordinal",
];
const time = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ${column}`;
const selection = (columns: readonly string[], json: readonly string[], times: readonly string[]) =>
  columns
    .map((c) =>
      times.includes(c)
        ? time(c)
        : json.includes(c) ||
            c.endsWith("_digest") ||
            c.endsWith("_text") ||
            c.endsWith("_version") ||
            c.endsWith("_number") ||
            c === "action_code" ||
            c === "outcome" ||
            c === "rule_ordinal" ||
            c === "data_classification"
          ? c
          : `${c}::text`,
    )
    .join(",");
const recordSelect = `SELECT ${selection(recordColumns, ["record_json"], ["prepared_at"])} FROM rms_pricing.tax_config_publication_candidate`;
const originalSelect = `SELECT ${selection(operationColumns, ["receipt_json", "audit_json"], ["occurred_at"])} FROM rms_pricing.tax_config_candidate_operation`;
const ruleSelect = `SELECT ${selection(ruleColumns, [], [])} FROM rms_pricing.tax_config_candidate_rule`;
/** A recorded, immutable candidate uses actual owning Draft/material packets, not qualified claims. */
export function createPostgresTaxConfigCandidateStore(options: TaxConfigCandidateStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    scope = parseTaxConfigAuthoringScope(options.scope),
    scopeOwner = options.scope;
  const clock = options.clock,
    clockPort = clock.now,
    authority = options.authority,
    authorityPort = authority.holdUntilTransactionCompletes,
    refs = options.references,
    referencePort = refs.generate,
    auditOwner = options.audit,
    auditPort = auditOwner.create,
    registerPort = options.registerBeforeCommit;
  const origin = String(parseCanonicalInstant(options.originalObservedAt)),
    initialUntil = String(parseCanonicalInstant(options.originalValidUntil));
  const draftOptions = options.draftSource,
    materialOptions = options.materialSource;
  const draftScope = draftOptions.scope,
    materialScope = materialOptions.scope;
  const draftAuthority = draftOptions.authority,
    draftAuthorityPort = draftAuthority.holdUntilTransactionCompletes,
    draftCurrency = draftOptions.currency,
    draftCurrencyPort = draftCurrency.readCurrent,
    draftFacts = draftOptions.facts,
    draftFactsPort = draftFacts.validateDraft,
    draftRefs = draftOptions.references,
    draftRefsPort = draftRefs.generate,
    draftAudit = draftOptions.audit,
    draftAuditPort = draftAudit.create;
  const materialAuthority = materialOptions.authority,
    materialAuthorityPort = materialAuthority.holdUntilTransactionCompletes,
    materialFacts = materialOptions.facts,
    materialFactsPort = materialFacts.validateMaterial,
    materialRefs = materialOptions.references,
    materialRefsPort = materialRefs.generate,
    materialAudit = materialOptions.audit,
    materialAuditPort = materialAudit.create;
  const draftSource = createPostgresTaxConfigAuthoringStore(draftOptions),
    materialSource = createPostgresTaxConfigMaterialStore(materialOptions);
  let deadline = initialUntil,
    latest = origin,
    phase: "Work" | "Checks" | "Final" = "Work",
    active = false,
    failed = false,
    registered = false,
    guardDone = false,
    guardCalls = 0,
    finalCalls = 0,
    draftUsed = false,
    materialUsed = false,
    sourceReads = 0;
  const records: { receipt: TaxConfigCandidateOperation; write: boolean }[] = [],
    reads: {
      configuration: string;
      target: string | null;
      record: TaxConfigCandidateRecord | null;
    }[] = [],
    pages: {
      configuration: string;
      after: string | null;
      page: Awaited<ReturnType<typeof roster>>;
    }[] = [];
  if (
    Date.parse(initialUntil) <= Date.parse(origin) ||
    Date.parse(initialUntil) - Date.parse(origin) > 5000 ||
    [queryPort, clockPort, authorityPort, referencePort, auditPort, registerPort].some(
      (p) => typeof p !== "function",
    )
  )
    return fail();
  function childrenCurrent() {
    if (
      options.draftSource !== draftOptions ||
      options.materialSource !== materialOptions ||
      draftOptions.transaction !== tx ||
      materialOptions.transaction !== tx ||
      draftOptions.scope !== draftScope ||
      materialOptions.scope !== materialScope ||
      !equal(parseTaxConfigAuthoringScope(draftScope), scope) ||
      !equal(parseTaxConfigAuthoringScope(materialScope), scope) ||
      draftOptions.clock !== clock ||
      materialOptions.clock !== clock ||
      draftOptions.originalObservedAt !== origin ||
      materialOptions.originalObservedAt !== origin ||
      draftOptions.originalValidUntil !== initialUntil ||
      materialOptions.originalValidUntil !== initialUntil ||
      draftOptions.registerBeforeCommit !== registerPort ||
      materialOptions.registerBeforeCommit !== registerPort ||
      draftOptions.authority !== draftAuthority ||
      draftAuthority.holdUntilTransactionCompletes !== draftAuthorityPort ||
      draftOptions.currency !== draftCurrency ||
      draftCurrency.readCurrent !== draftCurrencyPort ||
      draftOptions.facts !== draftFacts ||
      draftFacts.validateDraft !== draftFactsPort ||
      draftOptions.references !== draftRefs ||
      draftRefs.generate !== draftRefsPort ||
      draftOptions.audit !== draftAudit ||
      draftAudit.create !== draftAuditPort ||
      materialOptions.authority !== materialAuthority ||
      materialAuthority.holdUntilTransactionCompletes !== materialAuthorityPort ||
      materialOptions.facts !== materialFacts ||
      materialFacts.validateMaterial !== materialFactsPort ||
      materialOptions.references !== materialRefs ||
      materialRefs.generate !== materialRefsPort ||
      materialOptions.audit !== materialAudit ||
      materialAudit.create !== materialAuditPort
    ) {
      failed = true;
      return fail();
    }
  }
  function portsCurrent() {
    try {
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
      childrenCurrent();
    } catch (error) {
      failed = true;
      if (error instanceof TaxConfigWorkflowError) throw error;
      return fail();
    }
  }
  function check(): string {
    portsCurrent();
    let at: string;
    try {
      at = String(parseCanonicalInstant(clockPort.call(clock)));
    } catch {
      failed = true;
      return fail();
    }
    portsCurrent();
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
  async function hold(
    mode: "Read" | "Write" | "Resolve",
    command: TaxConfigCandidateCommand | null,
  ) {
    const value = await authorityPort.call(authority, tx, {
      scope,
      mode,
      permission: "pricing.tax-config.manage",
      purposeCode: "PRICING_TAX_CONFIG_CANDIDATE",
      requiredFields: taxConfigCandidateRequiredFields,
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
  async function rootLock(configuration: string, write: boolean) {
    await restore();
    await query(
      `SELECT ${write ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('PricingTaxConfigRoot:'||$1||':'||$2||':'||$3,0))`,
      [scope.brandReference, scope.storeReference, configuration],
    );
  }
  function reference(
    kind: Parameters<TaxConfigCandidateStoreOptions["references"]["generate"]>[0],
  ) {
    check();
    const v = parsePricingReference(referencePort.call(refs, kind));
    check();
    return v;
  }
  function pins(
    c: TaxConfigCandidateCommand | TaxConfigCandidateResolve,
  ): TaxConfigCandidateCommand {
    return parseTaxConfigCandidateCommand({
      action: c.action,
      operationReference: c.operationReference,
      configurationReference: c.configurationReference,
      expectedDraft: c.expectedDraft,
      registrationMaterial: c.registrationMaterial,
    });
  }
  function eventFor(r: TaxConfigCandidateOperation): DomainEventEnvelope {
    const record = r.result;
    if (!record || !r.eventReference) return fail();
    const c = record.candidate.content;
    return {
      eventId: r.eventReference,
      eventType: "TaxConfigCandidatePrepared",
      schemaVersion: 1,
      occurredAt: r.occurredAt,
      producerModule: "@rms/pricing",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "PricingTaxConfigCandidate",
      aggregateId: c.targetVersionReference,
      aggregateVersion: BigInt(c.targetAggregateVersion),
      correlationId: r.operationReference,
      causationId: r.operationReference,
      actor: { type: "Actor", actorId: r.actorReference },
      payload: {
        configurationReference: c.configurationReference,
        targetVersionReference: c.targetVersionReference,
        contentDigest: record.candidate.contentDigest,
        preparedAt: record.preparedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { auditReference: r.auditReference, originalIntentDigest: r.intentDigest },
    };
  }
  function auditMatches(
    value: AppendAuditRecordInput,
    r: Pick<
      TaxConfigCandidateOperation,
      | "actorReference"
      | "operationReference"
      | "outcome"
      | "occurredAt"
      | "auditReference"
      | "intentDigest"
      | "result"
    >,
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
        (r.outcome === "Abandoned"
          ? "PricingTaxCandidateOperation"
          : "PricingTaxConfigCandidate") ||
      value.targetId !==
        (r.result?.candidate.content.targetVersionReference ?? r.operationReference) ||
      value.actionCode !==
        (r.outcome === "Abandoned"
          ? "PRICING_TAX_CANDIDATE_RESOLVE"
          : "PRICING_TAX_CANDIDATE_PREPARE")
    )
      return fail();
  }
  function createAudit(
    command: TaxConfigCandidateCommand,
    mode: "Write" | "Abandon",
    target: string | null,
    intent: string,
    at: string,
  ) {
    const auditReference = reference("Audit"),
      audit = validateAuditRecord(
        auditPort.call(auditOwner, {
          scope,
          command,
          mode,
          auditReference,
          targetVersionReference: target,
          intentDigest: intent,
          occurredAt: at,
        }),
        Date.parse(check()),
      );
    check();
    if (
      audit.auditId !== auditReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== scope.actorReference ||
      audit.targetId !== (target ?? command.operationReference) ||
      audit.targetType !==
        (mode === "Write" ? "PricingTaxConfigCandidate" : "PricingTaxCandidateOperation") ||
      audit.actionCode !==
        (mode === "Write" ? "PRICING_TAX_CANDIDATE_PREPARE" : "PRICING_TAX_CANDIDATE_RESOLVE") ||
      audit.brandId !== scope.brandReference ||
      audit.storeId !== scope.storeReference ||
      audit.correlationId !== command.operationReference ||
      audit.occurredAt !== at ||
      audit.dataClassification !== "Confidential" ||
      audit.reasonCode !== "AUTHORIZED_OPERATION" ||
      audit.beforeSummary !== undefined ||
      !equal(audit.afterSummary, { intentDigest: intent })
    )
      return fail();
    return audit;
  }
  async function sources(command: TaxConfigCandidateCommand, current: boolean) {
    if (++sourceReads > 60) return fail();
    check();
    draftUsed = true;
    const draft = current
      ? await draftSource.readCurrent(command.configurationReference)
      : await draftSource.readVersion({
          configurationReference: command.configurationReference,
          versionReference: command.expectedDraft.versionReference,
        });
    check();
    tighten(draft.validUntil);
    if (
      !draft.state ||
      draft.state.snapshot.configurationReference !== command.configurationReference ||
      !equal(
        {
          versionReference: draft.state.snapshot.versionReference,
          snapshotDigest: draft.state.snapshot.snapshotDigest,
          aggregateVersion: draft.state.snapshot.aggregateVersion,
          versionNumber: draft.state.snapshot.versionNumber,
        },
        command.expectedDraft,
      )
    )
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    materialUsed = true;
    const registration = await materialSource.readVersion({
      materialKind: "RegistrationApplicability",
      versionReference: command.registrationMaterial.versionReference,
    });
    check();
    tighten(registration.validUntil);
    if (
      !registration.version ||
      registration.version.materialKind !== "RegistrationApplicability" ||
      registration.version.materialReference !== command.registrationMaterial.materialReference ||
      registration.version.contentDigest !== command.registrationMaterial.contentDigest
    )
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    await restore();
    return { draft: draft.state, registration: registration.version };
  }
  async function loadRecord(target: string): Promise<TaxConfigCandidateRecord | null> {
    await restore();
    const found = await query(
      recordSelect + " WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND target_version_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, target],
    );
    if (found.rows.length > 1) return fail();
    if (!found.rows.length) return null;
    const row = closed(found.rows[0], recordColumns);
    scoped(row);
    let r: TaxConfigCandidateRecord;
    try {
      r = parseTaxConfigCandidateRecord(row.record_json);
    } catch {
      return fail();
    }
    const c = r.candidate.content;
    if (
      row.target_version_id !== target ||
      c.targetVersionReference !== target ||
      r.tenantReference !== scope.tenantReference ||
      r.brandReference !== scope.brandReference ||
      r.storeReference !== scope.storeReference ||
      row.configuration_id !== c.configurationReference ||
      row.actor_id !== r.preparedByActorReference ||
      row.operation_id !== r.operationReference ||
      row.base_version_id !== c.baseDraft.versionReference ||
      row.base_snapshot_digest !== c.baseDraft.snapshotDigest ||
      row.base_aggregate_version !== c.baseDraft.aggregateVersion ||
      row.base_version_number !== c.baseDraft.versionNumber ||
      row.target_aggregate_version !== c.targetAggregateVersion ||
      row.target_version_number !== c.targetVersionNumber ||
      row.registration_material_id !== c.registrationMaterial.materialReference ||
      row.registration_version_id !== c.registrationMaterial.versionReference ||
      row.registration_content_digest !== c.registrationMaterial.contentDigest ||
      row.content_digest !== r.candidate.contentDigest ||
      row.record_text !== canonicalizeRfc8785(r) ||
      row.record_digest !== digest(r) ||
      row.audit_id !== r.auditReference ||
      row.event_id !== r.eventReference ||
      row.prepared_at !== r.preparedAt
    )
      return fail();
    const rules = await query(
      ruleSelect +
        " WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND target_version_id=$4 ORDER BY rule_ordinal LIMIT 257",
      [scope.tenantReference, scope.brandReference, scope.storeReference, target],
    );
    if (rules.rows.length !== c.sourceRuleBindings.length || rules.rows.length > 256) return fail();
    for (const [i, value] of rules.rows.entries()) {
      const v = closed(value, ruleColumns),
        binding = c.sourceRuleBindings[i];
      if (
        !binding ||
        v.tenant_id !== scope.tenantReference ||
        v.brand_id !== scope.brandReference ||
        v.store_id !== scope.storeReference ||
        v.configuration_id !== c.configurationReference ||
        v.base_version_id !== c.baseDraft.versionReference ||
        v.target_version_id !== target ||
        v.source_rule_id !== binding.sourceRuleReference ||
        v.target_rule_id !== binding.targetRuleReference ||
        v.rule_ordinal !== i + 1
      )
        return fail();
    }
    return r;
  }
  async function original(
    op: string,
    requireActor = true,
  ): Promise<TaxConfigCandidateOperation | null> {
    await restore();
    const found = await query(originalSelect + " WHERE operation_id=$1", [op]);
    if (found.rows.length > 1) return fail();
    if (!found.rows.length) return null;
    const row = closed(found.rows[0], operationColumns);
    scoped(row);
    let r: TaxConfigCandidateOperation;
    try {
      r = parseTaxConfigCandidateOperation(row.receipt_json);
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
    const c = pins(r),
      b = c.expectedDraft,
      m = c.registrationMaterial;
    if (
      row.operation_id !== op ||
      r.operationReference !== op ||
      row.actor_id !== r.actorReference ||
      row.action_code !== r.action ||
      row.configuration_id !== r.configurationReference ||
      row.expected_base_version_id !== b.versionReference ||
      row.expected_base_snapshot_digest !== b.snapshotDigest ||
      row.expected_base_aggregate_version !== b.aggregateVersion ||
      row.expected_base_version_number !== b.versionNumber ||
      row.registration_material_id !== m.materialReference ||
      row.registration_version_id !== m.versionReference ||
      row.registration_content_digest !== m.contentDigest ||
      row.intent_digest !== r.intentDigest ||
      row.outcome !== r.outcome ||
      row.receipt_text !== canonicalizeRfc8785(r) ||
      row.receipt_digest !== digest(r) ||
      row.audit_id !== r.auditReference ||
      row.event_id !== r.eventReference ||
      row.occurred_at !== r.occurredAt
    )
      return fail();
    if (r.occurredAt > check()) return fail();
    auditMatches(validateAuditRecord(row.audit_json, Date.parse(r.occurredAt)), r);
    if (r.result) {
      const actual = await loadRecord(r.result.candidate.content.targetVersionReference);
      if (
        !actual ||
        !equal(actual, r.result) ||
        row.result_target_version_id !== actual.candidate.content.targetVersionReference
      )
        return fail();
      const actualSources = await sources(c, false);
      try {
        assertTaxConfigCandidateSources(actual, actualSources.draft, actualSources.registration);
      } catch {
        return fail();
      }
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
    } else if (row.result_target_version_id !== null) return fail();
    return r;
  }
  async function historical(target: string, configuration: string) {
    const r = await loadRecord(target);
    if (!r) return null;
    if (r.candidate.content.configurationReference !== configuration)
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    const receipt = await original(r.operationReference, false);
    if (!receipt?.result || !equal(receipt.result, r)) return fail();
    return r;
  }
  async function latestRecord(configuration: string, expectedTarget?: string | null) {
    await restore();
    const found = await query(
      "SELECT target_version_id::text FROM rms_pricing.tax_config_publication_candidate WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND configuration_id=$4 ORDER BY prepared_at DESC,target_version_id DESC LIMIT 1",
      [scope.tenantReference, scope.brandReference, scope.storeReference, configuration],
    );
    if (found.rows.length > 1) return fail();
    const target =
      found.rows.length === 0
        ? null
        : parsePricingReference(closed(found.rows[0], ["target_version_id"]).target_version_id);
    if (expectedTarget !== undefined && target !== expectedTarget)
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    if (target === null) return null;
    const record = await historical(target, configuration);
    if (!record) return fail();
    return record;
  }
  async function lockOriginal(op: string) {
    await restore();
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended('PricingTaxCandidateOriginal:'||$1,0))",
      [op],
    );
    const r = await original(op);
    if (r) return r;
    const available = await query(
      "SELECT rms_pricing.tax_config_candidate_operation_available($1) available",
      [op],
    );
    if (available.rows.length !== 1 || closed(available.rows[0], ["available"]).available !== true)
      return fail();
    return null;
  }
  function match(
    r: TaxConfigCandidateOperation,
    c: TaxConfigCandidateCommand | TaxConfigCandidateResolve,
    intent: string,
  ) {
    if (!equal(pins(r), pins(c)) || r.intentDigest !== intent)
      return fail("TAX_CONFIG_IDEMPOTENCY_CONFLICT");
  }
  async function appendOriginal(r: TaxConfigCandidateOperation, audit: AppendAuditRecordInput) {
    await restore();
    const c = pins(r),
      b = c.expectedDraft,
      m = c.registrationMaterial,
      text = canonicalizeRfc8785(r),
      values = [
        r.operationReference,
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        scope.actorReference,
        r.action,
        r.configurationReference,
        b.versionReference,
        b.snapshotDigest,
        b.aggregateVersion,
        b.versionNumber,
        m.materialReference,
        m.versionReference,
        m.contentDigest,
        r.intentDigest,
        r.outcome,
        r.result?.candidate.content.targetVersionReference ?? null,
        text,
        text,
        digest(r),
        r.auditReference,
        canonicalizeRfc8785(audit),
        r.eventReference,
        r.occurredAt,
        "Confidential",
      ];
    const inserted = await query(
      `INSERT INTO rms_pricing.tax_config_candidate_operation(${operationColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22::jsonb,$23,$24,$25)`,
      values,
    );
    if (inserted.rowCount !== 1) return fail();
    const actual = await original(r.operationReference);
    if (!actual || !equal(actual, r)) return fail();
    return actual;
  }
  async function reserveIdentities(record: TaxConfigCandidateRecord) {
    const identities = [
      record.candidate.content.targetVersionReference,
      ...record.candidate.content.sourceRuleBindings.map((b) => b.targetRuleReference),
    ].sort();
    if (new Set(identities).size !== identities.length) return fail();
    for (const identity of identities) {
      const result = await query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('PricingTaxCandidateIdentity:'||$1::text,0)) admitted",
        [identity],
      );
      if (result.rows.length !== 1 || closed(result.rows[0], ["admitted"]).admitted !== true)
        return fail();
    }
  }
  async function save(command: TaxConfigCandidateCommand, intent: string) {
    await rootLock(command.configurationReference, true);
    await hold("Write", command);
    const source = await sources(command, true),
      target = reference("Version"),
      bindings = source.draft.snapshot.rules.map((rule) => ({
        sourceRuleReference: rule.ruleReference,
        targetRuleReference: reference("Rule"),
      })),
      candidate = createTaxPublicationCandidate({
        draft: source.draft,
        targetVersionReference: target,
        sourceRuleBindings: bindings,
        registrationMaterial: command.registrationMaterial,
      }),
      at = check(),
      audit = createAudit(command, "Write", target, intent, at),
      record = createTaxConfigCandidateRecord({
        scope,
        command,
        candidate,
        draft: source.draft,
        registrationMaterial: source.registration,
        preparedAt: at,
        auditReference: audit.auditId,
        eventReference: reference("Event"),
      });
    await reserveIdentities(record);
    await restore();
    const c = record.candidate.content,
      b = c.baseDraft,
      m = c.registrationMaterial,
      text = canonicalizeRfc8785(record),
      inserted = await query(
        `INSERT INTO rms_pricing.tax_config_publication_candidate(${recordColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24)`,
        [
          target,
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          c.configurationReference,
          scope.actorReference,
          command.operationReference,
          b.versionReference,
          b.snapshotDigest,
          b.aggregateVersion,
          b.versionNumber,
          c.targetAggregateVersion,
          c.targetVersionNumber,
          m.materialReference,
          m.versionReference,
          m.contentDigest,
          record.candidate.contentDigest,
          text,
          text,
          digest(record),
          record.auditReference,
          record.eventReference,
          at,
          "Confidential",
        ],
      );
    if (inserted.rowCount !== 1) return fail();
    for (const [i, binding] of c.sourceRuleBindings.entries()) {
      const child = await query(
        `INSERT INTO rms_pricing.tax_config_candidate_rule(${ruleColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          c.configurationReference,
          c.baseDraft.versionReference,
          target,
          binding.sourceRuleReference,
          binding.targetRuleReference,
          i + 1,
        ],
      );
      if (child.rowCount !== 1) return fail();
    }
    const receipt = parseTaxConfigCandidateOperation({
        profile: "TaxConfigCandidateOperationV1",
        ...scope,
        ...command,
        command,
        intentDigest: intent,
        outcome: "Committed",
        result: record,
        auditReference: record.auditReference,
        eventReference: record.eventReference,
        occurredAt: at,
      }),
      event = eventFor(receipt);
    validateDomainEventEnvelope(event);
    await appendAuditRecordInTransaction({ query }, audit);
    check();
    await appendEventInTransaction({ query }, event);
    check();
    await hold("Write", command);
    const actual = await appendOriginal(receipt, audit);
    records.push({ receipt: actual, write: true });
    return actual;
  }
  async function abandon(command: TaxConfigCandidateResolve) {
    await rootLock(command.configurationReference, true);
    await hold("Resolve", pins(command));
    const at = check(),
      audit = createAudit(pins(command), "Abandon", null, command.intentDigest, at),
      receipt = parseTaxConfigCandidateOperation({
        profile: "TaxConfigCandidateOperationV1",
        ...scope,
        ...pins(command),
        command: null,
        intentDigest: command.intentDigest,
        outcome: "Abandoned",
        result: null,
        auditReference: audit.auditId,
        eventReference: null,
        occurredAt: at,
      });
    await appendAuditRecordInTransaction({ query }, audit);
    check();
    const actual = await appendOriginal(receipt, audit);
    records.push({ receipt: actual, write: false });
    return actual;
  }
  async function roster(configuration: string, after: string | null) {
    await rootLock(configuration, false);
    if (after !== null && !(await historical(after, configuration)))
      return fail("TAX_CONFIG_VERSION_CONFLICT");
    const found = await query(
      "SELECT target_version_id::text FROM rms_pricing.tax_config_publication_candidate WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND configuration_id=$4 AND ($5::uuid IS NULL OR target_version_id>$5) ORDER BY target_version_id LIMIT 21",
      [scope.tenantReference, scope.brandReference, scope.storeReference, configuration, after],
    );
    if (found.rows.length > 21) return fail();
    const ids = found.rows.map((v) =>
      parsePricingReference(closed(v, ["target_version_id"]).target_version_id),
    );
    if (ids.some((id, i) => (after !== null && id <= after) || (i > 0 && id <= String(ids[i - 1]))))
      return fail();
    const selected = ids.slice(0, 20),
      entries = [];
    for (const target of selected) {
      const r = await historical(target, configuration);
      if (!r) return fail();
      const c = r.candidate.content;
      entries.push(
        parseTaxConfigCandidateSummary({
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          configurationReference: configuration,
          targetVersionReference: target,
          targetAggregateVersion: c.targetAggregateVersion,
          targetVersionNumber: c.targetVersionNumber,
          contentDigest: r.candidate.contentDigest,
          baseDraft: c.baseDraft,
          registrationMaterial: c.registrationMaterial,
          preparedByActorReference: r.preparedByActorReference,
          operationReference: r.operationReference,
          preparedAt: r.preparedAt,
          status: "Recorded",
          qualification: "NotEvaluated",
        }),
      );
    }
    return { entries, next: ids.length > 20 ? (selected[selected.length - 1] ?? null) : null };
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
              if (!record.receipt.result) return fail();
              const source = await sources(pins(record.receipt), true);
              assertTaxConfigCandidateSources(
                record.receipt.result,
                source.draft,
                source.registration,
              );
            }
          }
          for (const r of reads) {
            await hold("Read", null);
            const actual =
              r.target === null
                ? await latestRecord(
                    r.configuration,
                    r.record?.candidate.content.targetVersionReference ?? null,
                  )
                : await historical(r.target, r.configuration);
            if (!equal(actual, r.record)) return fail("TAX_CONFIG_VERSION_CONFLICT");
          }
          for (const p of pages) {
            await hold("Read", null);
            if (!equal(await roster(p.configuration, p.after), p.page))
              return fail("TAX_CONFIG_VERSION_CONFLICT");
          }
          await hold("Read", null);
          await restore();
          if (records.length)
            await query(
              "SET CONSTRAINTS rms_pricing.tax_config_candidate_record_coherence,rms_pricing.tax_config_candidate_operation_coherence,rms_pricing.tax_config_candidate_rule_coherence IMMEDIATE",
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
      if (records.length + reads.length + pages.length >= 24) return fail();
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
  function readInput(value: unknown, field: "targetVersionReference" | "afterCandidate") {
    let r: Record<string, unknown>;
    try {
      r = closed(value, ["configurationReference", field]);
      return {
        configuration: parsePricingReference(r.configurationReference),
        target: r[field] === null ? null : parsePricingReference(r[field]),
      };
    } catch {
      return fail("TAX_CONFIG_INPUT_INVALID");
    }
  }
  return Object.freeze({
    prepare(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigCandidateCommand(value),
          intent = taxConfigCandidateIntentDigest(scope, command);
        await hold("Read", command);
        const prior = await lockOriginal(command.operationReference);
        if (prior) {
          match(prior, command, intent);
          await hold("Read", command);
          records.push({ receipt: prior, write: false });
          return prior;
        }
        return save(command, intent);
      });
    },
    resolveOriginal(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigCandidateResolve(value);
        await hold("Read", pins(command));
        if (taxConfigCandidateIntentDigest(scope, pins(command)) !== command.intentDigest)
          return fail("TAX_CONFIG_IDEMPOTENCY_CONFLICT");
        const prior = await lockOriginal(command.operationReference);
        if (prior) {
          match(prior, command, command.intentDigest);
          await hold("Read", pins(command));
          records.push({ receipt: prior, write: false });
          return prior;
        }
        return abandon(command);
      });
    },
    readCurrent(value: unknown) {
      return run(async () => {
        const input = readInput(value, "targetVersionReference");
        await hold("Read", null);
        await rootLock(input.configuration, false);
        const record =
          input.target === null
            ? await latestRecord(input.configuration)
            : await historical(input.target, input.configuration);
        if (input.target !== null && !record) return fail("TAX_CONFIG_VERSION_CONFLICT");
        await hold("Read", null);
        reads.push({ configuration: input.configuration, target: input.target, record });
        return parseTaxConfigCandidateCurrent({
          profile: "TaxConfigCandidateCurrentV1",
          ...scope,
          configurationReference: input.configuration,
          targetVersionReference: record?.candidate.content.targetVersionReference ?? null,
          record,
          observedAt: check(),
          validUntil: deadline,
          qualification: "NotEvaluated",
        });
      });
    },
    readRoster(value: unknown) {
      return run(async () => {
        const input = readInput(value, "afterCandidate");
        await hold("Read", null);
        const page = await roster(input.configuration, input.target);
        await hold("Read", null);
        pages.push({ configuration: input.configuration, after: input.target, page });
        return parseTaxConfigCandidateRoster({
          profile: "TaxConfigCandidateRosterV1",
          ...scope,
          configurationReference: input.configuration,
          afterCandidate: input.target,
          entries: page.entries,
          nextAfterCandidate: page.next,
          observedAt: check(),
          validUntil: deadline,
          qualification: "NotEvaluated",
        });
      });
    },
    assertFinalized() {
      if (phase !== "Final" || active || !guardDone || guardCalls !== 1 || finalCalls !== 1) {
        failed = true;
        return fail();
      }
      check();
      if (draftUsed) tighten(draftSource.assertFinalized());
      if (materialUsed) tighten(materialSource.assertFinalized());
      check();
      return deadline;
    },
  });
}

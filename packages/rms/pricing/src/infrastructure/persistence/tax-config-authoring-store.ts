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
import {
  createTaxConfigService,
  TaxConfigWorkflowError,
  type ExecuteTaxConfigInput,
} from "../../application/tax-config-service.js";
import type { TaxConfigOperationRecord } from "../../application/ports/tax-config-ports.js";
import {
  createTaxConfigurationSnapshot,
  type TaxConfigurationSnapshot,
} from "../../domain/tax-configuration.js";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  parsePricingCode,
  parsePricingDigest,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringState,
  taxConfigAuthoringIntentDigest,
  taxConfigAuthoringRequiredFields,
  type TaxConfigAuthoringScope,
  type TaxConfigAuthoringCommand,
  type TaxConfigAuthoringResolve,
  type TaxConfigAuthoringOperation,
  type TaxConfigAuthoringState,
} from "../../contracts/tax-config-authoring.js";

export interface TaxConfigAuthoringTransaction {
  query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }>;
}
export interface TaxConfigAuthoringStoreOptions {
  readonly transaction: TaxConfigAuthoringTransaction;
  readonly scope: TaxConfigAuthoringScope;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: TaxConfigAuthoringTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: TaxConfigAuthoringTransaction,
      input: {
        readonly scope: TaxConfigAuthoringScope;
        readonly mode: "Read" | "Write" | "Resolve";
        readonly permission: "pricing.tax-config.manage";
        readonly purposeCode: "PRICING_TAX_CONFIG_AUTHORING";
        readonly requiredFields: typeof taxConfigAuthoringRequiredFields;
        readonly command: Pick<
          TaxConfigAuthoringCommand,
          "action" | "operationReference" | "configurationReference" | "expectedAggregateVersion"
        > | null;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<{
      readonly scope: TaxConfigAuthoringScope;
      readonly tenantContext: TenantContext;
      readonly permission: PermissionDecision;
      readonly validUntil: string;
    }>;
  };
  readonly currency: {
    readCurrent(tx: TaxConfigAuthoringTransaction): Promise<CurrencyMetadataSnapshot>;
  };
  readonly facts: {
    validateDraft(
      tx: TaxConfigAuthoringTransaction,
      input: {
        readonly command: TaxConfigAuthoringCommand;
        readonly snapshot: TaxConfigurationSnapshot;
        readonly observedAt: string;
        readonly validUntil: string;
      },
    ): Promise<void>;
  };
  readonly references: {
    generate(kind: "Configuration" | "Version" | "Rule" | "Audit" | "Event"): string;
  };
  readonly audit: {
    create(input: {
      readonly scope: TaxConfigAuthoringScope;
      readonly command: Pick<
        TaxConfigAuthoringCommand,
        "action" | "operationReference" | "configurationReference" | "expectedAggregateVersion"
      >;
      readonly mode: "Write" | "Abandon";
      readonly auditReference: string;
      readonly configurationReference: string | null;
      readonly intentDigest: string;
      readonly occurredAt: string;
    }): AppendAuditRecordInput;
  };
}
const digest = (value: unknown) =>
  parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(value)));
const bytesDigest = (value: string) => parsePricingDigest("sha256:" + sha256Hex(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
const fail = (
  code: TaxConfigWorkflowError["code"] = "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new TaxConfigWorkflowError(code);
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    out[key] = d.value;
  }
  return out;
}
const originalColumns = [
  "operation_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "actor_id",
  "action_code",
  "requested_configuration_id",
  "expected_aggregate_version",
  "intent_digest",
  "outcome",
  "result_configuration_id",
  "result_version_id",
  "result_aggregate_version",
  "service_intent_digest",
  "service_input_json",
  "receipt_json",
  "receipt_digest",
  "audit_id",
  "audit_json",
  "event_id",
  "occurred_at",
  "data_classification",
] as const;
const originalSelect = `SELECT operation_id::text,tenant_id::text,brand_id::text,store_id::text,actor_id::text,action_code,requested_configuration_id::text,expected_aggregate_version,result_configuration_id::text,result_version_id::text,result_aggregate_version,intent_digest,outcome,service_intent_digest,service_input_json,receipt_json,receipt_digest,audit_id::text,audit_json,event_id::text,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') occurred_at,data_classification FROM rms_pricing.tax_config_authoring_operation`;
const sourceSelect = `SELECT jsonb_build_object('configurationReference',r.tax_configuration_id,'brandReference',r.brand_id,'storeReference',r.store_id,'stableCode',r.stable_code,'aggregateVersion',r.aggregate_version,'currentVersionReference',r.current_version_id,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'createdByActorReference',r.created_by_actor_id,'updatedAt',to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) root,
jsonb_build_object('configurationReference',v.tax_configuration_id,'versionReference',v.tax_configuration_version_id,'brandReference',v.brand_id,'storeReference',v.store_id,'versionNumber',v.version_number,'snapshotDigest',v.snapshot_digest,'lifecycle',v.lifecycle,'jurisdictionCode',v.jurisdiction_code,'currencyCode',v.currency_code,'currencyMetadataVersion',v.currency_metadata_version,'currencyMetadataVersionReference',v.currency_metadata_version_id,'currencyMetadataDigest',v.currency_metadata_digest,'effectiveFrom',to_char(v.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'effectiveUntil',CASE WHEN v.effective_until IS NULL THEN NULL ELSE to_char(v.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'timeZone',v.effective_time_zone,'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authoringOperationReference',v.authoring_operation_id,
'noEvidence',v.registration_applicability_id IS NULL AND v.operating_entity_tax_reference_id IS NULL AND v.jurisdiction_profile_id IS NULL AND v.registration_evidence_valid_until IS NULL AND v.professional_evidence_id IS NULL AND v.professional_review_reference_id IS NULL AND v.fixture_suite_reference_id IS NULL AND v.fixture_suite_digest IS NULL AND v.professional_evidence_valid_until IS NULL) version,
jsonb_build_object('operationReference',o.operation_id,'configurationReference',o.tax_configuration_id,'brandReference',o.brand_id,'storeReference',o.store_id,'action',o.action_code,'intentDigest',o.intent_digest,'aggregateVersion',o.result_aggregate_version,'versionReference',o.result_version_id,'occurredAt',to_char(o.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'eventReference',o.outbox_event_id) operation,
COALESCE((SELECT jsonb_agg(jsonb_build_object('ruleReference',t.tax_configuration_rule_id,'taxClassificationReference',t.tax_classification_id,'orderType',t.order_type,'chargeType',t.charge_type,'taxComponentCode',t.tax_component_code,'treatment',t.treatment,'rate',trim_scale(t.tax_rate)::text,'priceInclusion',t.price_inclusion,'roundingMode',t.rounding_mode,'calculationOrder',t.calculation_order,'compoundOnPriorTax',t.compound_on_prior_tax,'exceptionEvidenceReference',t.exception_evidence_id,'receiptPresentationCode',t.receipt_presentation_code) ORDER BY t.tax_configuration_rule_id) FROM rms_pricing.tax_configuration_rule t WHERE t.tax_configuration_version_id=v.tax_configuration_version_id AND t.tax_configuration_id=v.tax_configuration_id AND t.brand_id=v.brand_id AND t.store_id=v.store_id),'[]'::jsonb) rules,
NOT EXISTS(SELECT 1 FROM (VALUES(r.created_at),(r.updated_at),(v.created_at),(v.effective_from),(v.effective_until),(o.occurred_at)) times(value) WHERE date_trunc('milliseconds',value)<>value) precise
FROM rms_pricing.tax_configuration r JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_id=r.tax_configuration_id AND v.brand_id=r.brand_id AND v.store_id=r.store_id JOIN rms_pricing.tax_configuration_operation_record o ON o.result_version_id=v.tax_configuration_version_id AND o.tax_configuration_id=v.tax_configuration_id AND o.brand_id=v.brand_id AND o.store_id=v.store_id
WHERE r.brand_id=$1 AND r.store_id=$2 AND v.tax_configuration_version_id=$3 AND o.operation_id=$4`;

/** One actual borrowed transaction. Original records retain complete source facts;
 * no Domain constructor, currency source, or professional approval is synthesized for legacy rows. */
export function createPostgresTaxConfigAuthoringStore(options: TaxConfigAuthoringStoreOptions) {
  const tx = options.transaction,
    queryPort = tx.query,
    scope = parseTaxConfigAuthoringScope(options.scope),
    scopeOwner = options.scope;
  const clock = options.clock,
    clockPort = clock.now,
    authority = options.authority,
    authorityPort = authority.holdUntilTransactionCompletes,
    currency = options.currency,
    currencyPort = currency.readCurrent,
    facts = options.facts,
    factsPort = facts.validateDraft,
    refs = options.references,
    referencePort = refs.generate,
    auditOwner = options.audit,
    auditPort = auditOwner.create,
    registerPort = options.registerBeforeCommit;
  const origin = parseCanonicalInstant(options.originalObservedAt),
    initialUntil = parseCanonicalInstant(options.originalValidUntil);
  let deadline: string = initialUntil,
    latest: string = origin,
    phase: "Work" | "Checks" | "Final" = "Work",
    active = false,
    failed = false,
    registered = false,
    guardDone = false,
    guardCalls = 0,
    finalCalls = 0;
  const records: { receipt: TaxConfigAuthoringOperation; intent: string; write: boolean }[] = [];
  const currentReads: { reference: string | null; state: TaxConfigAuthoringState | null }[] = [];
  const historicalReads: {
    reference: string;
    version: string;
    state: TaxConfigAuthoringState;
  }[] = [];
  const rosterReads: {
    after: string | null;
    states: readonly TaxConfigAuthoringState[];
    next: string | null;
  }[] = [];
  if (
    Date.parse(initialUntil) <= Date.parse(origin) ||
    Date.parse(initialUntil) - Date.parse(origin) > 5000 ||
    [
      queryPort,
      clockPort,
      authorityPort,
      currencyPort,
      factsPort,
      referencePort,
      auditPort,
      registerPort,
    ].some((p) => typeof p !== "function")
  )
    fail();
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
      options.currency !== currency ||
      currency.readCurrent !== currencyPort ||
      options.facts !== facts ||
      facts.validateDraft !== factsPort ||
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
  async function hold(
    mode: "Read" | "Write" | "Resolve",
    command: Pick<
      TaxConfigAuthoringCommand,
      "action" | "operationReference" | "configurationReference" | "expectedAggregateVersion"
    > | null,
  ) {
    const value = await authorityPort.call(authority, tx, {
      scope,
      mode,
      permission: "pricing.tax-config.manage",
      purposeCode: "PRICING_TAX_CONFIG_AUTHORING",
      requiredFields: taxConfigAuthoringRequiredFields,
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
  async function rootLock(reference: string, write: boolean) {
    await restore();
    await query(
      "SELECT " +
        (write ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared") +
        "(hashtextextended('PricingTaxConfigRoot:'||$1||':'||$2||':'||$3,0))",
      [scope.brandReference, scope.storeReference, reference],
    );
  }
  function ref(kind: Parameters<TaxConfigAuthoringStoreOptions["references"]["generate"]>[0]) {
    check();
    const value = parsePricingReference(referencePort.call(refs, kind));
    check();
    return value;
  }
  function eventFor(receipt: TaxConfigAuthoringOperation): DomainEventEnvelope {
    const s = receipt.snapshot;
    if (!s || !receipt.eventReference) return fail();
    return {
      eventId: receipt.eventReference,
      eventType:
        receipt.action === "CreateDraft" ? "TaxConfigDraftCreated" : "TaxConfigDraftReplaced",
      schemaVersion: 1,
      occurredAt: receipt.occurredAt,
      producerModule: "@rms/pricing",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "PricingTaxConfiguration",
      aggregateId: s.configurationReference,
      aggregateVersion: BigInt(s.aggregateVersion),
      correlationId: receipt.operationReference,
      causationId: receipt.operationReference,
      actor: { type: "Actor", actorId: receipt.actorReference },
      payload: {
        configurationReference: s.configurationReference,
        versionReference: s.versionReference,
        aggregateVersion: String(s.aggregateVersion),
        lifecycle: s.lifecycle,
        jurisdictionCode: s.jurisdictionCode,
        snapshotDigest: s.snapshotDigest,
        occurredAt: receipt.occurredAt,
      },
      redactionClassification: "none",
      replayMetadata: {
        auditReference: receipt.auditReference,
        originalIntentDigest: receipt.intentDigest,
      },
    };
  }
  function auditFor(
    command: TaxConfigAuthoringCommand | TaxConfigAuthoringResolve,
    mode: "Write" | "Abandon",
    configurationReference: string | null,
    intentDigest: string,
    at: string,
  ) {
    const id = ref("Audit");
    const value = validateAuditRecord(
      auditPort.call(auditOwner, {
        scope,
        command,
        mode,
        auditReference: id,
        configurationReference,
        intentDigest,
        occurredAt: at,
      }),
      Date.parse(check()),
    );
    check();
    if (
      value.auditId !== id ||
      value.brandId !== scope.brandReference ||
      value.storeId !== scope.storeReference ||
      value.actor.type !== "User" ||
      value.actor.reference !== scope.actorReference ||
      value.occurredAt !== at ||
      value.correlationId !== command.operationReference ||
      value.reasonCode !== "AUTHORIZED_OPERATION" ||
      value.actionCode !==
        (mode === "Abandon"
          ? "PRICING_TAX_CONFIG_RESOLVE"
          : "PRICING_TAX_CONFIG_" + command.action.toUpperCase()) ||
      value.targetType !==
        (mode === "Abandon" ? "PricingTaxAuthoringOperation" : "PricingTaxConfiguration") ||
      value.targetId !== (mode === "Abandon" ? command.operationReference : configurationReference)
    )
      return fail();
    return value;
  }
  async function original(
    operation: string,
    requireActor = true,
  ): Promise<TaxConfigAuthoringOperation | null> {
    await restore();
    const result = await query(originalSelect + " WHERE operation_id=$1", [operation]);
    if (result.rows.length > 1) return fail();
    if (!result.rows.length) return null;
    const row = closed(result.rows[0], originalColumns),
      receipt = parseTaxConfigAuthoringOperation(row.receipt_json);
    if (
      receipt.tenantReference !== scope.tenantReference ||
      receipt.brandReference !== scope.brandReference ||
      receipt.storeReference !== scope.storeReference ||
      (requireActor && receipt.actorReference !== scope.actorReference)
    )
      return fail("TAX_CONFIG_PERMISSION_DENIED");
    if (
      receipt.operationReference !== operation ||
      row.operation_id !== operation ||
      row.tenant_id !== scope.tenantReference ||
      row.brand_id !== scope.brandReference ||
      row.store_id !== scope.storeReference ||
      row.actor_id !== receipt.actorReference ||
      row.action_code !== receipt.action ||
      row.requested_configuration_id !== receipt.configurationReference ||
      row.expected_aggregate_version !== receipt.expectedAggregateVersion ||
      row.intent_digest !== receipt.intentDigest ||
      row.outcome !== receipt.outcome ||
      row.service_intent_digest !== receipt.serviceIntentDigest ||
      row.receipt_digest !== digest(receipt) ||
      row.audit_id !== receipt.auditReference ||
      row.event_id !== receipt.eventReference ||
      row.occurred_at !== receipt.occurredAt ||
      row.data_classification !== "ConfigurationMetadata"
    )
      return fail();
    const audit = validateAuditRecord(row.audit_json, Date.parse(receipt.occurredAt));
    if (
      audit.auditId !== receipt.auditReference ||
      audit.brandId !== scope.brandReference ||
      audit.storeId !== scope.storeReference ||
      audit.actor.type !== "User" ||
      audit.actor.reference !== receipt.actorReference ||
      audit.correlationId !== operation ||
      audit.occurredAt !== receipt.occurredAt ||
      audit.reasonCode !== "AUTHORIZED_OPERATION" ||
      audit.targetType !==
        (receipt.outcome === "Committed"
          ? "PricingTaxConfiguration"
          : "PricingTaxAuthoringOperation") ||
      audit.targetId !== (receipt.snapshot?.configurationReference ?? operation) ||
      audit.actionCode !==
        (receipt.outcome === "Committed"
          ? "PRICING_TAX_CONFIG_" + receipt.action.toUpperCase()
          : "PRICING_TAX_CONFIG_RESOLVE")
    )
      return fail();
    if (receipt.snapshot) {
      if (
        row.result_configuration_id !== receipt.snapshot.configurationReference ||
        row.result_version_id !== receipt.snapshot.versionReference ||
        row.result_aggregate_version !== receipt.snapshot.aggregateVersion ||
        typeof row.service_input_json !== "string" ||
        bytesDigest(row.service_input_json) !== receipt.serviceIntentDigest
      )
        return fail();
      const input = closed(JSON.parse(row.service_input_json), [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "occurredAt",
      ]);
      if (
        input.action !== receipt.action ||
        input.operationReference !== operation ||
        input.expectedAggregateVersion !== receipt.expectedAggregateVersion ||
        input.occurredAt !== receipt.occurredAt ||
        !equal(
          createTaxConfigurationSnapshot(input.candidate as TaxConfigurationSnapshot),
          receipt.snapshot,
        )
      )
        return fail();
      await verifySource(receipt);
      const eventReference = receipt.eventReference;
      if (eventReference === null) return fail();
      const envelope = await loadOutboxEnvelope({ query }, eventReference);
      check();
      if (!envelope) return fail();
      validateDomainEventEnvelope(envelope);
      const expected = eventFor(receipt);
      if (
        !equal(
          { ...envelope, aggregateVersion: String(envelope.aggregateVersion) },
          { ...expected, aggregateVersion: String(expected.aggregateVersion) },
        )
      )
        return fail();
    } else if (
      row.result_configuration_id !== null ||
      row.result_version_id !== null ||
      row.result_aggregate_version !== null ||
      row.service_input_json !== null
    )
      return fail();
    return receipt;
  }
  async function verifySource(receipt: TaxConfigAuthoringOperation) {
    const s = receipt.snapshot;
    if (!s) return fail();
    const { snapshotDigest, ...snapshotBody } = s;
    if (digest(snapshotBody) !== snapshotDigest) return fail();
    const result = await query(sourceSelect, [
      scope.brandReference,
      scope.storeReference,
      s.versionReference,
      receipt.operationReference,
    ]);
    if (result.rows.length !== 1) return fail();
    const row = closed(result.rows[0], ["root", "version", "operation", "rules", "precise"]);
    if (row.precise !== true) return fail();
    const root = closed(row.root, [
      "configurationReference",
      "brandReference",
      "storeReference",
      "stableCode",
      "aggregateVersion",
      "currentVersionReference",
      "createdAt",
      "createdByActorReference",
      "updatedAt",
    ]);
    if (
      root.configurationReference !== s.configurationReference ||
      root.brandReference !== scope.brandReference ||
      root.storeReference !== scope.storeReference ||
      root.stableCode !== s.stableCode ||
      !Number.isSafeInteger(root.aggregateVersion) ||
      Number(root.aggregateVersion) < s.aggregateVersion ||
      String(parseCanonicalInstant(root.createdAt)) > s.createdAt ||
      String(parseCanonicalInstant(root.updatedAt)) < s.createdAt ||
      String(parseCanonicalInstant(root.updatedAt)) > check()
    )
      return fail();
    parsePricingReference(root.createdByActorReference);
    parsePricingReference(root.currentVersionReference);
    parsePricingCode(root.stableCode);
    const expectedVersion = {
      configurationReference: s.configurationReference,
      versionReference: s.versionReference,
      brandReference: s.brandReference,
      storeReference: s.storeReference,
      versionNumber: s.versionNumber,
      snapshotDigest: s.snapshotDigest,
      lifecycle: s.lifecycle,
      jurisdictionCode: s.jurisdictionCode,
      currencyCode: s.currencyMetadata.currencyCode,
      currencyMetadataVersion: s.currencyMetadata.metadataVersion,
      currencyMetadataVersionReference: s.currencyMetadata.metadataVersionReference,
      currencyMetadataDigest: s.currencyMetadata.metadataDigest,
      effectiveFrom: s.effectivePeriod.effectiveFrom.instant,
      effectiveUntil: s.effectivePeriod.effectiveUntil?.instant ?? null,
      timeZone: s.effectivePeriod.timeZone,
      createdAt: s.createdAt,
      authoringOperationReference: receipt.operationReference,
      noEvidence: true,
    };
    const expectedOperation = {
      operationReference: receipt.operationReference,
      configurationReference: s.configurationReference,
      brandReference: s.brandReference,
      storeReference: s.storeReference,
      action: receipt.action,
      intentDigest: receipt.serviceIntentDigest,
      aggregateVersion: s.aggregateVersion,
      versionReference: s.versionReference,
      occurredAt: receipt.occurredAt,
      eventReference: receipt.eventReference,
    };
    if (
      !equal(row.version, expectedVersion) ||
      !equal(row.operation, expectedOperation) ||
      !equal(
        row.rules,
        [...s.rules].sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
      )
    )
      return fail();
  }
  async function state(reference: string, lock = true): Promise<TaxConfigAuthoringState | null> {
    if (lock) await rootLock(reference, false);
    const row = await query(
      `SELECT r.aggregate_version,r.current_version_id::text,v.authoring_operation_id::text FROM rms_pricing.tax_configuration r LEFT JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=r.current_version_id AND v.tax_configuration_id=r.tax_configuration_id AND v.brand_id=r.brand_id AND v.store_id=r.store_id WHERE r.brand_id=$1 AND r.store_id=$2 AND r.tax_configuration_id=$3` +
        (lock ? " FOR SHARE OF r" : ""),
      [scope.brandReference, scope.storeReference, reference],
    );
    if (row.rows.length > 1) return fail();
    if (!row.rows.length) return null;
    const root = closed(row.rows[0], [
      "aggregate_version",
      "current_version_id",
      "authoring_operation_id",
    ]);
    const op = parsePricingReference(root.authoring_operation_id),
      receipt = await original(op, false);
    if (
      !receipt?.snapshot ||
      receipt.snapshot.configurationReference !== reference ||
      receipt.snapshot.versionReference !== root.current_version_id ||
      receipt.snapshot.aggregateVersion !== root.aggregate_version
    )
      return fail();
    return parseTaxConfigAuthoringState({
      profile: "TaxConfigAuthoringStateV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      draftAuthorActorReference: receipt.actorReference,
      snapshot: receipt.snapshot,
    });
  }
  async function historicalState(
    reference: string,
    version: string,
  ): Promise<TaxConfigAuthoringState> {
    await rootLock(reference, false);
    const rows = await query(
      "SELECT v.authoring_operation_id::text FROM rms_pricing.tax_configuration_version v JOIN rms_pricing.tax_configuration r ON r.tax_configuration_id=v.tax_configuration_id AND r.brand_id=v.brand_id AND r.store_id=v.store_id WHERE v.brand_id=$1 AND v.store_id=$2 AND v.tax_configuration_id=$3 AND v.tax_configuration_version_id=$4 FOR SHARE OF r",
      [scope.brandReference, scope.storeReference, reference, version],
    );
    if (rows.rows.length === 0) return fail("TAX_CONFIG_VERSION_CONFLICT");
    if (rows.rows.length !== 1) return fail();
    const row = closed(rows.rows[0], ["authoring_operation_id"]);
    // A legacy version without a full owning original cannot supply facts that
    // the old summary columns never recorded (including full Currency Metadata).
    if (row.authoring_operation_id === null) return fail();
    const receipt = await original(parsePricingReference(row.authoring_operation_id), false);
    if (
      !receipt?.snapshot ||
      receipt.snapshot.configurationReference !== reference ||
      receipt.snapshot.versionReference !== version
    )
      return fail();
    return parseTaxConfigAuthoringState({
      profile: "TaxConfigAuthoringStateV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      draftAuthorActorReference: receipt.actorReference,
      snapshot: receipt.snapshot,
    });
  }
  async function roster(after: string | null) {
    await restore();
    const rows = await query(
      "SELECT r.tax_configuration_id::text FROM rms_pricing.tax_configuration r JOIN rms_pricing.tax_configuration_version v ON v.tax_configuration_version_id=r.current_version_id AND v.tax_configuration_id=r.tax_configuration_id AND v.brand_id=r.brand_id AND v.store_id=r.store_id WHERE r.brand_id=$1 AND r.store_id=$2 AND v.lifecycle='Draft' AND ($3::uuid IS NULL OR r.tax_configuration_id>$3::uuid) ORDER BY r.tax_configuration_id LIMIT 51",
      [scope.brandReference, scope.storeReference, after],
    );
    if (rows.rows.length > 51) return fail();
    const refs = rows.rows.map((r) =>
      parsePricingReference(closed(r, ["tax_configuration_id"]).tax_configuration_id),
    );
    for (let i = 0; i < refs.length; i++) {
      const reference = refs[i];
      const previous = i > 0 ? refs[i - 1] : null;
      if (
        reference === undefined ||
        (after !== null && reference <= after) ||
        (i > 0 && (previous === undefined || previous === null || reference <= previous))
      )
        return fail();
    }
    const entries: TaxConfigAuthoringState[] = [];
    for (const r of refs.slice(0, 50)) {
      const current = await state(r);
      if (!current) return fail();
      entries.push(current);
    }
    const next = refs.length > 50 ? refs[49] : null;
    if (next === undefined) return fail();
    return { states: Object.freeze(entries), next };
  }
  async function legacyAbsent(op: string) {
    await restore();
    const result = await query(
      "SELECT rms_pricing.tax_config_authoring_operation_available($1) available",
      [op],
    );
    if (result.rows.length !== 1 || closed(result.rows[0], ["available"]).available !== true)
      return fail();
  }
  async function lockOriginal(op: string) {
    await restore();
    await query(
      "SELECT pg_advisory_xact_lock(hashtextextended('PricingTaxConfigOriginal:'||$1,0))",
      [op],
    );
    const result = await original(op);
    if (!result) await legacyAbsent(op);
    return result;
  }
  function match(
    receipt: TaxConfigAuthoringOperation,
    command: TaxConfigAuthoringCommand | TaxConfigAuthoringResolve,
    intent: string,
  ) {
    if (
      receipt.action !== command.action ||
      receipt.configurationReference !== command.configurationReference ||
      receipt.expectedAggregateVersion !== command.expectedAggregateVersion ||
      receipt.intentDigest !== intent
    )
      return fail("TAX_CONFIG_IDEMPOTENCY_CONFLICT");
  }
  async function appendOriginal(
    receipt: TaxConfigAuthoringOperation,
    audit: AppendAuditRecordInput,
    serviceInput: string | null,
  ) {
    await restore();
    const s = receipt.snapshot;
    const result = await query(
      `INSERT INTO rms_pricing.tax_config_authoring_operation(${originalColumns.join(",")}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20,$21,$22)`,
      [
        receipt.operationReference,
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        scope.actorReference,
        receipt.action,
        receipt.configurationReference,
        receipt.expectedAggregateVersion,
        receipt.intentDigest,
        receipt.outcome,
        s?.configurationReference ?? null,
        s?.versionReference ?? null,
        s?.aggregateVersion ?? null,
        receipt.serviceIntentDigest,
        serviceInput,
        JSON.stringify(receipt),
        digest(receipt),
        receipt.auditReference,
        JSON.stringify(audit),
        receipt.eventReference,
        receipt.occurredAt,
        "ConfigurationMetadata",
      ],
    );
    if (result.rowCount !== 1) return fail();
    const actual = await original(receipt.operationReference);
    if (!actual || !equal(actual, receipt)) return fail();
    return actual;
  }
  async function persist(
    record: TaxConfigOperationRecord,
    audit: AppendAuditRecordInput,
    command: TaxConfigAuthoringCommand,
    intent: string,
    serviceInput: string,
  ) {
    // Public fact holders may temporarily use Brand scope on this borrowed
    // transaction. Restore this owner's captured Store scope before writing.
    await restore();
    const s = record.aggregate,
      at = s.createdAt;
    if (command.action === "CreateDraft") {
      const r = await query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$6)",
        [
          s.configurationReference,
          scope.brandReference,
          scope.storeReference,
          s.stableCode,
          s.aggregateVersion,
          at,
          scope.actorReference,
        ],
      );
      if (r.rowCount !== 1) return fail();
    }
    const version = await query(
      `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,created_at,authoring_operation_id) VALUES($1,$2,$3,$4,$5,$6,'Draft','CA-ON',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        s.versionReference,
        s.configurationReference,
        scope.brandReference,
        scope.storeReference,
        s.versionNumber,
        s.snapshotDigest,
        s.currencyMetadata.currencyCode,
        s.currencyMetadata.metadataVersion,
        s.currencyMetadata.metadataVersionReference,
        s.currencyMetadata.metadataDigest,
        s.effectivePeriod.effectiveFrom.instant,
        s.effectivePeriod.effectiveUntil?.instant ?? null,
        s.effectivePeriod.timeZone,
        at,
        command.operationReference,
      ],
    );
    if (version.rowCount !== 1) return fail();
    for (const rule of s.rules) {
      const result = await query(
        `INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          rule.ruleReference,
          s.versionReference,
          s.configurationReference,
          scope.brandReference,
          scope.storeReference,
          rule.taxClassificationReference,
          rule.orderType,
          rule.chargeType,
          rule.taxComponentCode,
          rule.treatment,
          rule.rate,
          rule.priceInclusion,
          rule.roundingMode,
          rule.calculationOrder,
          rule.compoundOnPriorTax,
          rule.exceptionEvidenceReference,
          rule.receiptPresentationCode,
        ],
      );
      if (result.rowCount !== 1) return fail();
    }
    const update = await query(
      "UPDATE rms_pricing.tax_configuration SET aggregate_version=$1,current_version_id=$2,stable_code=$3,updated_at=$4 WHERE tax_configuration_id=$5 AND brand_id=$6 AND store_id=$7 AND aggregate_version=$8",
      [
        s.aggregateVersion,
        s.versionReference,
        s.stableCode,
        at,
        s.configurationReference,
        scope.brandReference,
        scope.storeReference,
        command.expectedAggregateVersion ?? 1,
      ],
    );
    if (update.rowCount !== 1) return fail("TAX_CONFIG_VERSION_CONFLICT");
    await appendAuditRecordInTransaction({ query }, audit);
    check();
    const receipt = parseTaxConfigAuthoringOperation({
      profile: "TaxConfigAuthoringOperationV1",
      ...scope,
      action: command.action,
      operationReference: command.operationReference,
      configurationReference: command.configurationReference,
      expectedAggregateVersion: command.expectedAggregateVersion,
      command,
      intentDigest: intent,
      serviceIntentDigest: record.operationIntentHash,
      outcome: "Committed",
      snapshot: s,
      auditReference: audit.auditId,
      eventReference: ref("Event"),
      occurredAt: at,
    });
    const event = eventFor(receipt);
    validateDomainEventEnvelope(event);
    await appendEventInTransaction({ query }, event);
    check();
    const old = await query(
      "INSERT INTO rms_pricing.tax_configuration_operation_record(operation_id,tax_configuration_id,brand_id,store_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at,outbox_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        command.operationReference,
        s.configurationReference,
        scope.brandReference,
        scope.storeReference,
        command.action,
        record.operationIntentHash,
        s.aggregateVersion,
        s.versionReference,
        at,
        receipt.eventReference,
      ],
    );
    if (old.rowCount !== 1) return fail();
    await appendOriginal(receipt, audit, serviceInput);
    return record;
  }
  async function write(
    command: TaxConfigAuthoringCommand,
    intent: string,
    current: TaxConfigAuthoringState | null,
  ) {
    if (current && current.snapshot.stableCode !== command.content.stableCode)
      return fail("TAX_CONFIG_INPUT_INVALID");
    await hold("Write", command);
    const metadata = createCurrencyMetadataSnapshot(await currencyPort.call(currency, tx));
    check();
    const at = check(),
      configuration = command.configurationReference ?? ref("Configuration"),
      version = ref("Version");
    const base = {
      configurationReference: configuration,
      versionReference: version,
      brandReference: parsePricingReference(scope.brandReference),
      storeReference: parsePricingReference(scope.storeReference),
      stableCode: command.content.stableCode,
      aggregateVersion: (command.expectedAggregateVersion ?? 0) + 1,
      versionNumber: (current?.snapshot.versionNumber ?? 0) + 1,
      lifecycle: "Draft" as const,
      jurisdictionCode: parsePricingCode("CA-ON"),
      currencyMetadata: metadata,
      effectivePeriod: command.content.effectivePeriod,
      registrationEvidence: null,
      professionalEvidence: null,
      rules: Object.freeze(
        command.content.rules.map((r) => Object.freeze({ ruleReference: ref("Rule"), ...r })),
      ),
      createdAt: at,
    };
    const candidate = createTaxConfigurationSnapshot({ ...base, snapshotDigest: digest(base) });
    if (
      (await factsPort.call(facts, tx, {
        command,
        snapshot: candidate,
        observedAt: check(),
        validUntil: deadline,
      })) !== undefined
    )
      return fail();
    check();
    await rootLock(configuration, true);
    await query(
      "LOCK TABLE rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.tax_configuration_operation_record IN SHARE ROW EXCLUSIVE MODE",
    );
    const locked = await state(configuration, false);
    if (!equal(locked, current)) return fail("TAX_CONFIG_VERSION_CONFLICT");
    let serviceInput = "";
    const audit = auditFor(command, "Write", configuration, intent, at);
    const service = createTaxConfigService({
      authorization: {
        async authorize() {
          const fresh = await hold("Write", command);
          return {
            ...fresh,
            approvalPermission: null,
            draftAuthorActorReference: current?.draftAuthorActorReference ?? null,
            audit,
          };
        },
      },
      references: {
        hashIntent(text) {
          serviceInput = text;
          return bytesDigest(text);
        },
        equals: (a, b) => a === b,
      },
      facts: {
        async validate(s) {
          if (!equal(s, candidate)) return fail();
          if (
            (await factsPort.call(facts, tx, {
              command,
              snapshot: s,
              observedAt: check(),
              validUntil: deadline,
            })) !== undefined
          )
            return fail();
          check();
          return true;
        },
        async validateApprovedFixtures() {
          return fail();
        },
        async requiredCoverage() {
          return fail();
        },
      },
      repository: {
        async resolveOperation(reference) {
          if (reference !== command.operationReference) return fail();
          await legacyAbsent(reference);
          return null;
        },
        async load() {
          return current?.snapshot ?? null;
        },
        async create(input) {
          return persist(input.record, input.audit, command, intent, serviceInput);
        },
        async commit(input) {
          if (input.expectedAggregateVersion !== command.expectedAggregateVersion) return fail();
          return persist(input.record, input.audit, command, intent, serviceInput);
        },
      },
    });
    const input: ExecuteTaxConfigInput = {
      action: command.action,
      operationReference: command.operationReference,
      expectedAggregateVersion: command.expectedAggregateVersion,
      candidate,
      occurredAt: at,
    };
    const applied = await service.execute(input);
    if (applied.status !== "Applied" || !equal(applied.aggregate, candidate)) return fail();
    const receipt = await original(command.operationReference);
    if (!receipt) return fail();
    await hold("Write", command);
    records.push({ receipt, intent, write: true });
    return receipt;
  }
  async function register() {
    if (registered) return;
    registered = true;
    if (
      (await registerPort(
        tx,
        async () => {
          if (phase !== "Work" || active || ++guardCalls !== 1) {
            failed = true;
            return fail();
          }
          phase = "Checks";
          try {
            for (const r of records) {
              await hold(
                r.write ? "Write" : r.receipt.outcome === "Abandoned" ? "Resolve" : "Read",
                r.receipt,
              );
              const current = await original(r.receipt.operationReference);
              if (!current || !equal(current, r.receipt)) return fail();
              if (r.write) {
                if (!r.receipt.command || !r.receipt.snapshot) return fail();
                if (
                  (await factsPort.call(facts, tx, {
                    command: r.receipt.command,
                    snapshot: r.receipt.snapshot,
                    observedAt: check(),
                    validUntil: deadline,
                  })) !== undefined
                )
                  return fail();
                check();
                const metadata = createCurrencyMetadataSnapshot(
                  await currencyPort.call(currency, tx),
                );
                check();
                if (!equal(metadata, r.receipt.snapshot.currencyMetadata)) return fail();
              }
            }
            for (const r of currentReads) {
              await hold("Read", null);
              const actual = r.reference === null ? null : await state(r.reference);
              if (!equal(actual, r.state)) return fail("TAX_CONFIG_VERSION_CONFLICT");
            }
            for (const r of historicalReads) {
              await hold("Read", null);
              if (!equal(await historicalState(r.reference, r.version), r.state)) return fail();
            }
            for (const r of rosterReads) {
              await hold("Read", null);
              const actual = await roster(r.after);
              if (!equal(actual.states, r.states) || actual.next !== r.next)
                return fail("TAX_CONFIG_VERSION_CONFLICT");
            }
            await hold("Read", null);
            await restore();
            await query(
              "SET CONSTRAINTS rms_pricing.tax_config_version_original_coherence,rms_pricing.tax_config_authoring_terminal_coherence IMMEDIATE",
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
      )) !== undefined
    )
      return fail();
    check();
  }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active || phase !== "Work") {
      failed = true;
      return fail();
    }
    active = true;
    try {
      check();
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
  return Object.freeze({
    readCurrent(value: unknown) {
      return run(async () => {
        const reference = value === null ? null : parsePricingReference(value);
        await hold("Read", null);
        const current = reference === null ? null : await state(reference);
        await hold("Read", null);
        currentReads.push({ reference, state: current });
        return parseTaxConfigAuthoringCurrent(
          {
            profile: "TaxConfigAuthoringCurrentV1",
            ...scope,
            configurationReference: reference,
            state: current,
            observedAt: check(),
            validUntil: deadline,
            referenceEligibility: "NotEvaluated",
          },
          reference,
        );
      });
    },
    readVersion(value: unknown) {
      return run(async () => {
        let reference: string;
        let version: string;
        try {
          const request = closed(value, ["configurationReference", "versionReference"]);
          reference = parsePricingReference(request.configurationReference);
          version = parsePricingReference(request.versionReference);
        } catch {
          return fail("TAX_CONFIG_INPUT_INVALID");
        }
        await hold("Read", null);
        const saved = await historicalState(reference, version);
        await hold("Read", null);
        historicalReads.push({ reference, version, state: saved });
        return parseTaxConfigAuthoringCurrent(
          {
            profile: "TaxConfigAuthoringCurrentV1",
            ...scope,
            configurationReference: reference,
            state: saved,
            observedAt: check(),
            validUntil: deadline,
            referenceEligibility: "NotEvaluated",
          },
          reference,
        );
      });
    },
    readRoster(value: unknown) {
      return run(async () => {
        const after = value === null ? null : parsePricingReference(value);
        await hold("Read", null);
        const page = await roster(after);
        await hold("Read", null);
        rosterReads.push({ after, states: page.states, next: page.next });
        return parseTaxConfigAuthoringRoster(
          {
            profile: "TaxConfigAuthoringRosterV1",
            ...scope,
            afterConfiguration: after,
            entries: page.states,
            nextAfterConfiguration: page.next,
            observedAt: check(),
            validUntil: deadline,
            referenceEligibility: "NotEvaluated",
          },
          after,
        );
      });
    },
    execute(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigAuthoringCommand(value),
          intent = taxConfigAuthoringIntentDigest(scope, command);
        await hold("Read", command);
        const replay = await lockOriginal(command.operationReference);
        if (replay) {
          match(replay, command, intent);
          records.push({ receipt: replay, intent, write: false });
          return replay;
        }
        // Phase 1 owning persistence is CA-ON/CAD with the canonical Toronto
        // effective zone. Refuse unsupported fresh input before allocating or
        // appending; historical originals retain their immutable recovery path.
        if (command.content.effectivePeriod.timeZone !== "America/Toronto")
          return fail("TAX_CONFIG_INPUT_INVALID");
        const current =
          command.configurationReference === null
            ? null
            : await state(command.configurationReference, false);
        if (
          (current?.snapshot.aggregateVersion ?? null) !== command.expectedAggregateVersion ||
          (command.action === "ReplaceDraft" && !current)
        )
          return fail("TAX_CONFIG_VERSION_CONFLICT");
        return write(command, intent, current);
      });
    },
    resolve(value: unknown) {
      return run(async () => {
        const command = parseTaxConfigAuthoringResolve(value);
        await hold("Resolve", command);
        const replay = await lockOriginal(command.operationReference);
        if (replay) {
          match(replay, command, command.intentDigest);
          records.push({ receipt: replay, intent: command.intentDigest, write: false });
          return replay;
        }
        if (command.configurationReference) await rootLock(command.configurationReference, true);
        const at = check(),
          audit = auditFor(command, "Abandon", null, command.intentDigest, at);
        await appendAuditRecordInTransaction({ query }, audit);
        check();
        const receipt = parseTaxConfigAuthoringOperation({
          profile: "TaxConfigAuthoringOperationV1",
          ...scope,
          action: command.action,
          operationReference: command.operationReference,
          configurationReference: command.configurationReference,
          expectedAggregateVersion: command.expectedAggregateVersion,
          command: null,
          intentDigest: command.intentDigest,
          serviceIntentDigest: null,
          outcome: "Abandoned",
          snapshot: null,
          auditReference: audit.auditId,
          eventReference: null,
          occurredAt: at,
        });
        const actual = await appendOriginal(receipt, audit, null);
        await hold("Resolve", command);
        records.push({ receipt: actual, intent: command.intentDigest, write: false });
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
      )
        return fail();
      check();
      return deadline;
    },
  });
}

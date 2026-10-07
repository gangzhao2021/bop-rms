import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, type AppendAuditRecordInput } from "@bop/audit";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import {
  createPostgresTaxConfigMaterialStore,
  type TaxConfigMaterialStoreOptions,
} from "../infrastructure/persistence/tax-config-material-store.js";
import {
  createPostgresTaxConfigCandidateStore,
  type TaxConfigCandidateStoreOptions,
} from "../infrastructure/persistence/tax-config-candidate-store.js";
import {
  parseTaxConfigCandidateCommand,
  taxConfigCandidateIntentDigest,
} from "../contracts/tax-config-candidate-authoring.js";
import { parseTaxConfigMaterialCommand } from "../contracts/tax-config-material.js";
import { input } from "./price-quote.fixture.js";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringScope,
  taxConfigAuthoringIntentDigest,
} from "../contracts/tax-config-authoring.js";
import {
  createPostgresTaxConfigAuthoringStore,
  type TaxConfigAuthoringStoreOptions,
  type TaxConfigAuthoringTransaction,
} from "../infrastructure/persistence/tax-config-authoring-store.js";

// Controlled SQL transport, real Tax service, Domain constructors, Audit chain append
// and Eventing append/read. This fixture does not assert native SQL or IAM acceptance.
const id = (n: number) => `018ff700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const columns = [
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
];
type Row = Record<string, unknown>;
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing controlled fixture fact");
  return value;
}
const materialRootColumns = [
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
const materialVersionColumns = [
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
const materialOperationColumns = [
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

const candidateColumns = [
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
const candidateOriginalColumns = [
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
const candidateRuleColumns = [
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
function database() {
  return {
    serial: 100,
    materialRoots: new Map<string, Row>(),
    materialVersions: new Map<string, Row>(),
    materialOriginals: new Map<string, Row>(),
    candidates: new Map<string, Row>(),
    candidateRules: new Map<string, Row[]>(),
    candidateOriginals: new Map<string, Row>(),
    busyIdentities: new Set<string>(),
    roots: new Map<string, Row>(),
    versions: new Map<string, Row>(),
    rules: new Map<string, Row[]>(),
    legacy: new Map<string, Row>(),
    originals: new Map<string, Row>(),
    events: new Map<string, Row>(),
    hidden: new Set<string>(),
    audits: [] as (readonly unknown[])[],
    sequence: 1,
    previous: null as string | null,
  };
}
function fixture(db = database(), actor = id(4)) {
  const q = input(),
    scope = parseTaxConfigAuthoringScope({
      tenantReference: id(1),
      brandReference: q.brandReference,
      storeReference: q.storeReference,
      actorReference: actor,
    });
  let now = at,
    allowed = true,
    lease = "2026-08-02T16:00:05.000Z";
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  let sourceDrift: ((row: Row) => Row) | null = null;
  const query: TaxConfigAuthoringTransaction["query"] = async <R>(
    sql: string,
    values: readonly unknown[],
  ) => {
    queries.push({ sql, values });
    let rows: Row[] = [];
    let rowCount = 1;
    const mapped = (cols: readonly string[], json: readonly number[] = []) =>
      Object.fromEntries(
        cols.map((c, i) => [c, json.includes(i) ? JSON.parse(String(values[i])) : values[i]]),
      );
    if (sql.includes("tax_config_candidate_operation_available"))
      rows = [
        {
          available:
            !db.candidateOriginals.has(String(values[0])) && !db.hidden.has(String(values[0])),
        },
      ];
    else if (sql.includes("pg_try_advisory_xact_lock"))
      rows = [{ admitted: !db.busyIdentities.has(String(values[0])) }];
    else if (
      sql.startsWith("SELECT operation_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_candidate_operation")
    ) {
      const r = db.candidateOriginals.get(String(values[0]));
      rows = r ? [copy(r)] : [];
    } else if (
      sql.startsWith("SELECT target_version_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_publication_candidate")
    ) {
      if (sql.includes("record_json")) {
        const r = db.candidates.get(String(values[3]));
        rows = r ? [copy(r)] : [];
      } else if (sql.includes("ORDER BY prepared_at DESC,target_version_id DESC LIMIT 1")) {
        rows = [...db.candidates.values()]
          .filter(
            (r) =>
              r.tenant_id === values[0] &&
              r.brand_id === values[1] &&
              r.store_id === values[2] &&
              r.configuration_id === values[3],
          )
          .sort(
            (a, b) =>
              String(b.prepared_at).localeCompare(String(a.prepared_at)) ||
              String(b.target_version_id).localeCompare(String(a.target_version_id)),
          )
          .slice(0, 1)
          .map((r) => ({ target_version_id: r.target_version_id }));
      } else
        rows = [...db.candidates.values()]
          .filter(
            (r) =>
              r.configuration_id === values[3] &&
              (values[4] === null || String(r.target_version_id) > String(values[4])),
          )
          .sort((a, b) => String(a.target_version_id).localeCompare(String(b.target_version_id)))
          .slice(0, 21)
          .map((r) => ({ target_version_id: r.target_version_id }));
    } else if (sql.includes("FROM rms_pricing.tax_config_candidate_rule")) {
      rows = copy(db.candidateRules.get(String(values[3])) ?? []);
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_publication_candidate")) {
      if (db.candidates.has(String(values[0]))) throw new Error("controlled identity collision");
      db.candidates.set(String(values[0]), mapped(candidateColumns, [17]));
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_candidate_rule")) {
      const list = db.candidateRules.get(String(values[5])) ?? [];
      list.push(mapped(candidateRuleColumns));
      db.candidateRules.set(String(values[5]), list);
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_candidate_operation")) {
      if (db.candidateOriginals.has(String(values[0])) || db.hidden.has(String(values[0])))
        throw new Error("controlled terminal collision");
      db.candidateOriginals.set(String(values[0]), mapped(candidateOriginalColumns, [17, 21]));
    } else if (sql.includes("tax_config_material_operation_available"))
      rows = [
        {
          available:
            !db.hidden.has(String(values[0])) && !db.materialOriginals.has(String(values[0])),
        },
      ];
    else if (
      sql.startsWith("SELECT operation_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material_operation")
    ) {
      const r = db.materialOriginals.get(String(values[0]));
      rows = r ? [copy(r)] : [];
    } else if (
      sql.startsWith("SELECT operation_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material_version")
    ) {
      const r = db.materialVersions.get(String(values[3]));
      rows = r ? [{ operation_id: r.operation_id }] : [];
    } else if (
      sql.startsWith("SELECT tenant_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material_version")
    ) {
      const r = db.materialVersions.get(String(values[3]));
      rows = r ? [copy(r)] : [];
    } else if (
      sql.startsWith("SELECT tenant_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material")
    ) {
      const r = db.materialRoots.get(String(values[3]));
      rows = r ? [copy(r)] : [];
    } else if (
      sql.startsWith("SELECT material_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material")
    ) {
      rows = [...db.materialRoots.values()]
        .filter(
          (r) =>
            r.material_kind === values[3] &&
            (values[4] === null || String(r.material_id) > String(values[4])),
        )
        .sort((a, b) => String(a.material_id).localeCompare(String(b.material_id)))
        .slice(0, 51)
        .map((r) => ({ material_id: r.material_id }));
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material_operation")) {
      if (db.hidden.has(String(values[0]))) throw new Error("controlled hidden original collision");
      db.materialOriginals.set(String(values[0]), mapped(materialOperationColumns, [14, 18]));
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material_version"))
      db.materialVersions.set(String(values[4]), mapped(materialVersionColumns, [10]));
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material("))
      db.materialRoots.set(String(values[3]), mapped(materialRootColumns));
    else if (sql.startsWith("UPDATE rms_pricing.tax_config_material")) {
      const r = db.materialRoots.get(String(values[6]));
      if (!r || r.revision !== values[7] || r.current_version_id !== values[8]) rowCount = 0;
      else
        Object.assign(r, {
          revision: values[0],
          current_version_id: values[1],
          updated_at: values[2],
        });
    } else if (sql.includes("tax_config_authoring_operation_available"))
      rows = [
        {
          available:
            !db.originals.has(String(values[0])) &&
            !db.legacy.has(String(values[0])) &&
            !db.hidden.has(String(values[0])),
        },
      ];
    else if (sql.startsWith("SELECT operation_id::text")) {
      const row = db.originals.get(String(values[0]));
      rows = row ? [copy(row)] : [];
    } else if (sql.startsWith("SELECT jsonb_build_object")) {
      const version = db.versions.get(String(values[2])),
        op = db.legacy.get(String(values[3]));
      const root = version ? db.roots.get(String(version.configurationReference)) : null;
      if (root && version && op) {
        let row = {
          root: copy(root),
          version: copy(version),
          operation: copy(op),
          rules: copy(db.rules.get(String(values[2])) ?? []).sort((a, b) =>
            String(a.ruleReference).localeCompare(String(b.ruleReference)),
          ),
          precise: true,
        };
        if (sourceDrift) row = sourceDrift(row) as typeof row;
        rows = [row];
      }
    } else if (sql.startsWith("SELECT v.authoring_operation_id::text")) {
      const version = db.versions.get(String(values[3]));
      rows =
        version &&
        version.configurationReference === values[2] &&
        version.brandReference === values[0] &&
        version.storeReference === values[1]
          ? [{ authoring_operation_id: version.authoringOperationReference }]
          : [];
    } else if (sql.startsWith("SELECT r.aggregate_version")) {
      const root = db.roots.get(String(values[2]));
      const v = root ? db.versions.get(String(root.currentVersionReference)) : null;
      rows = root
        ? [
            {
              aggregate_version: root.aggregateVersion,
              current_version_id: root.currentVersionReference,
              authoring_operation_id: v?.authoringOperationReference ?? null,
            },
          ]
        : [];
    } else if (sql.startsWith("SELECT r.tax_configuration_id"))
      rows = [...db.roots.values()]
        .filter((r) => values[2] === null || String(r.configurationReference) > String(values[2]))
        .sort((a, b) =>
          String(a.configurationReference).localeCompare(String(b.configurationReference)),
        )
        .slice(0, 51)
        .map((r) => ({ tax_configuration_id: r.configurationReference }));
    else if (sql.includes("FROM platform_eventing.outbox_event")) {
      const row = db.events.get(String(values[0]));
      rows = row ? [copy(row)] : [];
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_authoring_operation")) {
      const row = Object.fromEntries(columns.map((key, i) => [key, values[i]]));
      row.receipt_json = JSON.parse(String(row.receipt_json));
      row.audit_json = JSON.parse(String(row.audit_json));
      if (db.originals.has(String(values[0])) || db.hidden.has(String(values[0])))
        throw new Error("controlled unique failure");
      db.originals.set(String(values[0]), row);
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration("))
      db.roots.set(String(values[0]), {
        configurationReference: values[0],
        brandReference: values[1],
        storeReference: values[2],
        stableCode: values[3],
        aggregateVersion: values[4],
        currentVersionReference: null,
        createdAt: values[5],
        createdByActorReference: values[6],
        updatedAt: values[5],
      });
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_version"))
      db.versions.set(String(values[0]), {
        versionReference: values[0],
        configurationReference: values[1],
        brandReference: values[2],
        storeReference: values[3],
        versionNumber: values[4],
        snapshotDigest: values[5],
        lifecycle: "Draft",
        jurisdictionCode: "CA-ON",
        currencyCode: values[6],
        currencyMetadataVersion: values[7],
        currencyMetadataVersionReference: values[8],
        currencyMetadataDigest: values[9],
        effectiveFrom: values[10],
        effectiveUntil: values[11],
        timeZone: values[12],
        createdAt: values[13],
        authoringOperationReference: values[14],
        noEvidence: true,
      });
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_rule")) {
      const list = db.rules.get(String(values[1])) ?? [];
      list.push({
        ruleReference: values[0],
        taxClassificationReference: values[5],
        orderType: values[6],
        chargeType: values[7],
        taxComponentCode: values[8],
        treatment: values[9],
        rate: values[10],
        priceInclusion: values[11],
        roundingMode: values[12],
        calculationOrder: values[13],
        compoundOnPriorTax: values[14],
        exceptionEvidenceReference: values[15],
        receiptPresentationCode: values[16],
      });
      db.rules.set(String(values[1]), list);
    } else if (sql.startsWith("UPDATE rms_pricing.tax_configuration")) {
      const root = db.roots.get(String(values[4]));
      if (!root || root.aggregateVersion !== values[7]) rowCount = 0;
      else
        Object.assign(root, {
          aggregateVersion: values[0],
          currentVersionReference: values[1],
          stableCode: values[2],
          updatedAt: values[3],
        });
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_operation_record"))
      db.legacy.set(String(values[0]), {
        operationReference: values[0],
        configurationReference: values[1],
        brandReference: values[2],
        storeReference: values[3],
        action: values[4],
        intentDigest: values[5],
        aggregateVersion: values[6],
        versionReference: values[7],
        occurredAt: values[8],
        eventReference: values[9],
      });
    else if (sql.includes("FROM platform_audit.audit_chain_head"))
      rows = [{ next_sequence: String(db.sequence), previous_hash: db.previous, recorded_at: now }];
    else if (sql.startsWith("INSERT INTO platform_audit.audit_record"))
      db.audits = [...db.audits, values];
    else if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
      db.sequence++;
      db.previous = (values[2] as Buffer).toString("hex");
      rows = [{ next_sequence: String(db.sequence) }];
    } else if (sql.startsWith("INSERT INTO platform_eventing.outbox_event"))
      db.events.set(
        String(values[0]),
        Object.fromEntries(
          [
            "event_id",
            "event_type",
            "schema_version",
            "producer_module",
            "brand_id",
            "store_id",
            "aggregate_type",
            "aggregate_id",
            "aggregate_version",
            "correlation_id",
            "causation_id",
            "actor_type",
            "actor_id",
            "payload_json",
            "redaction_classification",
            "replay_metadata_json",
            "occurred_at",
          ].map((key, i) => [
            key,
            i === 13 || i === 15 ? JSON.parse(String(values[i])) : values[i],
          ]),
        ),
      );
    return { rows: rows as R[], rowCount };
  };
  const transaction: TaxConfigAuthoringTransaction = { query };
  const brand = createBrand({
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Controlled Tax",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: scope.storeReference,
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Controlled Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const currentAuthority = async () => {
    const actorInput = {
      actorType: "User",
      actorReference: actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as Parameters<typeof createTenantContext>[0];
    const tenantContext = createTenantContext(actorInput, brand, store, now);
    const actorReference = tenantContext.actor.actorReference;
    if (actorReference === null) throw new Error("controlled workforce Actor required");
    const action = parseBusinessAction("pricing.tax-config.manage");
    const permission = evaluatePermission({
      tenantContext,
      action,
      resourceScope: {
        kind: "Store",
        brandReference: brand.brandReference,
        storeReference: store.storeReference,
      },
      policySnapshotReference: parsePolicyReference(id(9)),
      policyVersion: parsePolicyVersion(1),
      evidence: allowed
        ? [
            {
              source: "RolePermission",
              evidenceReference: parseEvidenceReference(id(10)),
              action,
              actorReference,
              roleReference: parseRoleReference(id(11)),
              brandReference: brand.brandReference,
              storeReference: store.storeReference,
              effectiveFrom: parseCanonicalInstant(at),
              effectiveUntil: null,
            },
          ]
        : [],
    });
    return { scope, tenantContext, permission, validUntil: lease };
  };
  const authority: TaxConfigAuthoringStoreOptions["authority"] = {
    holdUntilTransactionCompletes: vi.fn(currentAuthority),
  };
  const options: TaxConfigAuthoringStoreOptions = {
    transaction,
    scope,
    originalObservedAt: at,
    originalValidUntil: lease,
    clock: { now: () => now },
    registerBeforeCommit: (tx, guard, final) => {
      expect(tx).toBe(transaction);
      hooks.push({ guard, final });
    },
    authority,
    currency: { readCurrent: vi.fn(async () => q.currencyMetadata) },
    facts: { validateDraft: vi.fn(async () => undefined) },
    references: { generate: vi.fn(() => id(++db.serial)) },
    audit: {
      create: vi.fn(
        ({
          mode,
          auditReference,
          command,
          configurationReference,
          intentDigest,
          occurredAt,
        }): AppendAuditRecordInput => ({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode:
            mode === "Abandon"
              ? "PRICING_TAX_CONFIG_RESOLVE"
              : "PRICING_TAX_CONFIG_" + command.action.toUpperCase(),
          targetType:
            mode === "Abandon" ? "PricingTaxAuthoringOperation" : "PricingTaxConfiguration",
          targetId: mode === "Abandon" ? command.operationReference : must(configurationReference),
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: command.operationReference,
          occurredAt,
          sourceChannel: "API",
          dataClassification: "Internal" as const,
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          afterSummary: { intentDigest },
        }),
      ),
    },
  };
  const materialOptions: TaxConfigMaterialStoreOptions = {
    transaction,
    scope,
    originalObservedAt: at,
    originalValidUntil: options.originalValidUntil,
    clock: options.clock,
    registerBeforeCommit: options.registerBeforeCommit,
    authority: { holdUntilTransactionCompletes: vi.fn(currentAuthority) },
    facts: { validateMaterial: vi.fn(async () => undefined) },
    references: { generate: vi.fn(() => id(++db.serial)) },
    audit: {
      create: vi.fn(
        ({
          mode,
          auditReference,
          command,
          materialReference,
          intentDigest,
          occurredAt,
        }): AppendAuditRecordInput => ({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode:
            mode === "Abandon"
              ? "PRICING_TAX_MATERIAL_RESOLVE"
              : "PRICING_TAX_MATERIAL_" + command.action.toUpperCase(),
          targetType:
            mode === "Abandon" ? "PricingTaxMaterialOperation" : "PricingTaxConfigMaterial",
          targetId: materialReference ?? command.operationReference,
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: command.operationReference,
          occurredAt,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          afterSummary: { intentDigest },
        }),
      ),
    },
  };
  const candidateOptions: TaxConfigCandidateStoreOptions = {
    transaction,
    scope,
    originalObservedAt: at,
    originalValidUntil: options.originalValidUntil,
    clock: options.clock,
    registerBeforeCommit: options.registerBeforeCommit,
    authority: { holdUntilTransactionCompletes: vi.fn(currentAuthority) },
    draftSource: options,
    materialSource: materialOptions,
    references: { generate: vi.fn(() => id(++db.serial)) },
    audit: {
      create: vi.fn(
        ({
          mode,
          auditReference,
          command,
          targetVersionReference,
          intentDigest,
          occurredAt,
        }): AppendAuditRecordInput => ({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode:
            mode === "Abandon" ? "PRICING_TAX_CANDIDATE_RESOLVE" : "PRICING_TAX_CANDIDATE_PREPARE",
          targetType:
            mode === "Abandon" ? "PricingTaxCandidateOperation" : "PricingTaxConfigCandidate",
          targetId: targetVersionReference ?? command.operationReference,
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: command.operationReference,
          occurredAt,
          sourceChannel: "API",
          dataClassification: "Confidential",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          afterSummary: { intentDigest },
        }),
      ),
    },
  };
  const source = createPostgresTaxConfigAuthoringStore(options);
  const command = parseTaxConfigAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(20),
    configurationReference: null,
    expectedAggregateVersion: null,
    content: {
      stableCode: "SYNTHETIC_TAX",
      effectivePeriod: q.taxConfiguration.effectivePeriod,
      rules: [
        {
          taxClassificationReference: id(8),
          orderType: "Pickup",
          chargeType: "Sellable",
          taxComponentCode: "SYNTHETIC_TAX",
          treatment: "Taxable",
          rate: "0.13",
          priceInclusion: "Exclusive",
          roundingMode: "HalfUp",
          calculationOrder: 1,
          compoundOnPriorTax: false,
          exceptionEvidenceReference: null,
          receiptPresentationCode: "SYNTHETIC_TAX",
        },
      ],
    },
  });
  const resolve = {
    action: command.action,
    operationReference: command.operationReference,
    configurationReference: null,
    expectedAggregateVersion: null,
    intentDigest: taxConfigAuthoringIntentDigest(scope, command),
  };
  async function finalize() {
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final();
    return source.assertFinalized();
  }
  return {
    db,
    scope,
    materialOptions,
    candidateOptions,
    source,
    options,
    command,
    resolve,
    queries,
    hooks,
    finalize,
    setNow: (value: string) => {
      now = value;
    },
    deny: () => {
      allowed = false;
    },
    shorten: (value: string) => {
      lease = value;
    },
    drift: (fn: (row: Row) => Row) => {
      sourceDrift = fn;
    },
  };
}

const unavailable = { code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" },
  denied = { code: "TAX_CONFIG_PERMISSION_DENIED" },
  conflict = { code: "TAX_CONFIG_VERSION_CONFLICT" };
async function seeded() {
  const db = database(),
    draft = fixture(db),
    draftReceipt = await draft.source.execute(draft.command);
  await draft.finalize();
  const material = fixture(db),
    materialSource = createPostgresTaxConfigMaterialStore(material.materialOptions),
    materialCommand = parseTaxConfigMaterialCommand({
      action: "CreateMaterial",
      operationReference: id(30),
      materialReference: null,
      expectedRevision: null,
      materialKind: "RegistrationApplicability",
      content: {
        operatingEntityProfileVersionReference: id(31),
        operatingEntityTaxReference: null,
        jurisdictionCode: "CA-ON",
        applicability: "NotApplicable",
        sourceIssuedAt: at,
        effectiveFrom: at,
        effectiveUntil: null,
        declaredSourceDigest: null,
      },
    }),
    materialReceipt = await materialSource.execute(materialCommand);
  for (const h of material.hooks) await h.guard();
  for (const h of material.hooks) h.final();
  materialSource.assertFinalized();
  const d = must(draftReceipt.snapshot),
    m = must(materialReceipt.version),
    command = parseTaxConfigCandidateCommand({
      action: "PrepareCandidate",
      operationReference: id(40),
      configurationReference: d.configurationReference,
      expectedDraft: {
        versionReference: d.versionReference,
        snapshotDigest: d.snapshotDigest,
        aggregateVersion: d.aggregateVersion,
        versionNumber: d.versionNumber,
      },
      registrationMaterial: {
        materialReference: m.materialReference,
        versionReference: m.versionReference,
        contentDigest: m.contentDigest,
      },
    });
  return { db, command, draftReceipt, materialReceipt };
}
function candidateFixture(db: ReturnType<typeof database>, actor = id(4)) {
  const f = fixture(db, actor);
  const source = createPostgresTaxConfigCandidateStore(f.candidateOptions);
  async function finish() {
    for (const h of f.hooks) await h.guard();
    for (const h of f.hooks) h.final();
    return source.assertFinalized();
  }
  async function atomic<T>(work: () => Promise<T>) {
    const backup = {
      candidates: new Map([...db.candidates].map(([k, v]) => [k, copy(v)])),
      candidateRules: new Map([...db.candidateRules].map(([k, v]) => [k, copy(v)])),
      candidateOriginals: new Map([...db.candidateOriginals].map(([k, v]) => [k, copy(v)])),
      events: new Map(db.events),
      audits: [...db.audits],
      sequence: db.sequence,
      previous: db.previous,
    };
    try {
      const result = await work();
      await finish();
      return result;
    } catch (error) {
      Object.assign(db, backup);
      throw error;
    }
  }
  return { ...f, source, finish, atomic };
}
const counts = (db: ReturnType<typeof database>) => ({
  records: db.candidates.size,
  rules: [...db.candidateRules.values()].reduce((n, v) => n + v.length, 0),
  originals: db.candidateOriginals.size,
  audits: db.audits.length,
  events: db.events.size,
});
it("persists actual Draft and Registration source joins, server identities, Audit and minimal event atomically", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db),
    r = await f.atomic(() => f.source.prepare(s.command)),
    record = must(r.result),
    c = record.candidate.content;
  expect(record.qualification).toBe("NotEvaluated");
  expect(record.status).toBe("Recorded");
  expect(c.rules[0]?.rate).toBe("0.13");
  expect(c.targetVersionReference).not.toBe(c.baseDraft.versionReference);
  expect(c.sourceRuleBindings[0]?.targetRuleReference).not.toBe(
    c.sourceRuleBindings[0]?.sourceRuleReference,
  );
  expect(counts(s.db)).toEqual({
    records: 1,
    rules: 1,
    originals: 1,
    audits: before.audits + 1,
    events: before.events + 1,
  });
  const event = must(s.db.events.get(record.eventReference));
  expect(event.aggregate_type).toBe("PricingTaxConfigCandidate");
  expect(Object.keys(event.payload_json as object).sort()).toEqual(
    ["configurationReference", "targetVersionReference", "contentDigest", "preparedAt"].sort(),
  );
  expect(event.redaction_classification).toBe("indirect_identifier");
  expect(f.options.currency.readCurrent).not.toHaveBeenCalled();
  expect(f.options.facts.validateDraft).not.toHaveBeenCalled();
  expect(f.materialOptions.facts.validateMaterial).not.toHaveBeenCalled();
  const original = f.queries.findIndex((q) => q.sql.includes("PricingTaxCandidateOriginal:")),
    root = f.queries.findIndex((q) => q.sql.includes("PricingTaxConfigRoot:")),
    material = f.queries.findIndex((q) => q.sql.includes("PricingTaxMaterialRoot:")),
    ids = f.queries
      .filter((q) => q.sql.includes("pg_try_advisory_xact_lock"))
      .map((q) => String(q.values[0]));
  expect(original).toBeGreaterThanOrEqual(0);
  expect(root).toBeGreaterThan(original);
  expect(material).toBeGreaterThan(root);
  expect(ids).toEqual([...ids].sort());
  expect(f.hooks).toHaveLength(3);
  const flush = must(
    f.queries.find((q) =>
      q.sql.includes("SET CONSTRAINTS rms_pricing.tax_config_candidate_record_coherence"),
    ),
  );
  expect(flush.sql).not.toContain("ALL");
});
it("replays immutable original after real Draft and material replacements without today's facts or allocations", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    original = await f.atomic(() => f.source.prepare(s.command));
  const writer = fixture(s.db),
    d = must(s.draftReceipt.snapshot);
  await writer.source.execute({
    ...writer.command,
    action: "ReplaceDraft",
    operationReference: id(41),
    configurationReference: d.configurationReference,
    expectedAggregateVersion: 1,
    content: {
      ...writer.command.content,
      rules: writer.command.content.rules.map((r) => ({ ...r, rate: "0.14" })),
    },
  });
  await writer.finalize();
  const mw = fixture(s.db),
    m = must(s.materialReceipt.version),
    ms = createPostgresTaxConfigMaterialStore(mw.materialOptions);
  await ms.execute({
    action: "ReplaceMaterial",
    operationReference: id(42),
    materialReference: m.materialReference,
    expectedRevision: 1,
    materialKind: "RegistrationApplicability",
    content: { ...m.content, declaredSourceDigest: `sha256:${"a".repeat(64)}` },
  });
  for (const h of mw.hooks) await h.guard();
  for (const h of mw.hooks) h.final();
  ms.assertFinalized();
  const replay = candidateFixture(s.db),
    before = counts(s.db);
  const r = await replay.atomic(() => replay.source.prepare(s.command));
  expect(r).toEqual(original);
  expect(counts(s.db)).toEqual(before);
  expect(replay.candidateOptions.references.generate).not.toHaveBeenCalled();
  expect(replay.options.currency.readCurrent).not.toHaveBeenCalled();
  expect(replay.options.facts.validateDraft).not.toHaveBeenCalled();
  expect(replay.materialOptions.facts.validateMaterial).not.toHaveBeenCalled();
  expect(r.result?.candidate.content.rules[0]?.rate).toBe("0.13");
});
it("durably abandons exact absent original and refuses late preparation without source reads or extra event", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    resolve = { ...s.command, intentDigest: taxConfigCandidateIntentDigest(f.scope, s.command) },
    before = counts(s.db),
    r = await f.atomic(() => f.source.resolveOriginal(resolve));
  expect(r.outcome).toBe("Abandoned");
  expect(r.command).toBeNull();
  expect(r.result).toBeNull();
  expect(counts(s.db)).toEqual({ ...before, originals: 1, audits: before.audits + 1 });
  const late = candidateFixture(s.db);
  expect(await late.atomic(() => late.source.prepare(s.command))).toEqual(r);
  expect(late.candidateOptions.references.generate).not.toHaveBeenCalled();
  expect(
    late.queries.some(
      (q) =>
        q.sql.includes("SELECT v.authoring_operation_id") ||
        q.sql.includes("FROM rms_pricing.tax_config_material_version"),
    ),
  ).toBe(false);
});
it("refuses same-original altered pins and foreign original Actor while current history admits a different authorized reader", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    r = await f.atomic(() => f.source.prepare(s.command)),
    before = counts(s.db),
    bad = candidateFixture(s.db);
  await expect(
    bad.source.prepare({
      ...s.command,
      expectedDraft: { ...s.command.expectedDraft, snapshotDigest: `sha256:${"a".repeat(64)}` },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_IDEMPOTENCY_CONFLICT" });
  const foreign = candidateFixture(s.db, id(50));
  await expect(foreign.source.prepare(s.command)).rejects.toMatchObject(denied);
  const reader = candidateFixture(s.db, id(50));
  const view = await reader.atomic(() =>
    reader.source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: must(r.result).candidate.content.targetVersionReference,
    }),
  );
  expect(view.actorReference).toBe(id(50));
  expect(view.record?.preparedByActorReference).toBe(id(4));
  expect(counts(s.db)).toEqual(before);
});
it("refuses stale current Draft CAS or wrong immutable material hash before target allocation", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db);
  await expect(
    f.source.prepare({
      ...s.command,
      expectedDraft: { ...s.command.expectedDraft, aggregateVersion: 2 },
    }),
  ).rejects.toMatchObject(conflict);
  expect(f.candidateOptions.references.generate).not.toHaveBeenCalled();
  const other = candidateFixture(s.db);
  await expect(
    other.source.prepare({
      ...s.command,
      registrationMaterial: {
        ...s.command.registrationMaterial,
        contentDigest: `sha256:${"a".repeat(64)}`,
      },
    }),
  ).rejects.toMatchObject(conflict);
  expect(other.candidateOptions.references.generate).not.toHaveBeenCalled();
  expect(counts(s.db)).toEqual(before);
});
it("current metadata roster never exports confidential rule or material body", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    r = await f.atomic(() => f.source.prepare(s.command)),
    reader = candidateFixture(s.db, id(50)),
    view = await reader.atomic(() =>
      reader.source.readRoster({
        configurationReference: s.command.configurationReference,
        afterCandidate: null,
      }),
    );
  expect(view.entries).toHaveLength(1);
  expect(view.entries[0]?.targetVersionReference).toBe(
    r.result?.candidate.content.targetVersionReference,
  );
  expect(canonicalizeRfc8785(view)).not.toContain('"rules"');
  expect(canonicalizeRfc8785(view)).not.toContain("operatingEntityTaxReference");
  expect(view.qualification).toBe("NotEvaluated");
});
it("keeps true current permission and shortest lease through all actual child and parent hooks", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db);
  await expect(
    f.atomic(async () => {
      const r = await f.source.prepare(s.command);
      f.deny();
      return r;
    }),
  ).rejects.toMatchObject(denied);
  expect(counts(s.db)).toEqual(before);
  const short = candidateFixture(s.db);
  short.shorten("2026-08-02T16:00:01.000Z");
  await short.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  expect(await short.finish()).toBe("2026-08-02T16:00:01.000Z");
});
it("refuses identity contention before own rows and leaves no committed candidate, Audit or event", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db),
    next = id(s.db.serial + 1);
  s.db.busyIdentities.add(next);
  await expect(f.atomic(() => f.source.prepare(s.command))).rejects.toMatchObject(unavailable);
  expect(counts(s.db)).toEqual(before);
  expect(
    f.queries.some((q) =>
      q.sql.startsWith("INSERT INTO rms_pricing.tax_config_publication_candidate"),
    ),
  ).toBe(false);
});
it("refuses hidden global-original collision without claiming Abandoned", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db);
  s.db.hidden.add(s.command.operationReference);
  await expect(
    f.atomic(() =>
      f.source.resolveOriginal({
        ...s.command,
        intentDigest: taxConfigCandidateIntentDigest(f.scope, s.command),
      }),
    ),
  ).rejects.toMatchObject(unavailable);
  expect(counts(s.db)).toEqual(before);
  expect(f.candidateOptions.audit.create).not.toHaveBeenCalled();
});
it("detects noncanonical record text and changed source-rule reservation, even if JSON is unchanged", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    r = await f.atomic(() => f.source.prepare(s.command)),
    target = must(r.result).candidate.content.targetVersionReference,
    row = must(s.db.candidates.get(target));
  row.record_text = " " + String(row.record_text);
  await expect(
    candidateFixture(s.db).source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: target,
    }),
  ).rejects.toMatchObject(unavailable);
  row.record_text = canonicalizeRfc8785(row.record_json);
  const rules = must(s.db.candidateRules.get(target)),
    first = must(rules[0]);
  first.source_rule_id = id(99);
  await expect(
    candidateFixture(s.db).source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: target,
    }),
  ).rejects.toMatchObject(unavailable);
});
it("refuses late source tampering and late own current Draft head change at actual beforeCommit", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db),
    before = counts(s.db);
  await expect(
    f.atomic(async () => {
      const r = await f.source.prepare(s.command),
        row = must(s.db.candidates.get(must(r.result).candidate.content.targetVersionReference));
      row.content_digest = `sha256:${"a".repeat(64)}`;
      return r;
    }),
  ).rejects.toMatchObject(unavailable);
  expect(counts(s.db)).toEqual(before);
  const next = candidateFixture(s.db);
  await expect(
    next.atomic(async () => {
      const r = await next.source.prepare(s.command),
        root = must(s.db.roots.get(s.command.configurationReference));
      root.aggregateVersion = 2;
      return r;
    }),
  ).rejects.toThrow();
  expect(counts(s.db)).toEqual(before);
});
it("requires true hook completion, poisons query/child port replacement and rejects malformed input", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db);
  await f.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  expect(() => f.source.assertFinalized()).toThrow();
  const query = f.candidateOptions.transaction.query;
  f.candidateOptions.transaction.query = async <R>(sql: string, values: readonly unknown[]) =>
    query<R>(sql, values);
  await expect(f.finish()).rejects.toMatchObject(unavailable);
  const child = candidateFixture(s.db);
  child.options.facts.validateDraft = vi.fn(async () => undefined);
  await expect(child.source.prepare(s.command)).rejects.toMatchObject(unavailable);
  await expect(
    candidateFixture(s.db).source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: null,
      extra: true,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
});
it("poisons swallowed reentry and retains actual original deadline with monotonic time", async () => {
  const s = await seeded(),
    f = fixture(s.db),
    base = f.candidateOptions.authority.holdUntilTransactionCompletes;
  f.candidateOptions.authority.holdUntilTransactionCompletes = vi.fn(async (tx, input) => {
    try {
      await source.readCurrent({
        configurationReference: s.command.configurationReference,
        targetVersionReference: null,
      });
    } catch {
      /* swallowed adversarial callback */
    }
    return base(tx, input);
  });
  const source = createPostgresTaxConfigCandidateStore(f.candidateOptions);
  await expect(source.prepare(s.command)).rejects.toMatchObject(unavailable);
  expect(() => source.assertFinalized()).toThrow();
  const clock = candidateFixture(s.db);
  await clock.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  clock.setNow("2026-08-02T16:00:05.000Z");
  await expect(clock.finish()).rejects.toMatchObject(unavailable);
  const backward = candidateFixture(s.db);
  backward.setNow("2026-08-02T16:00:00.002Z");
  await backward.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  backward.setNow("2026-08-02T16:00:00.001Z");
  await expect(backward.finish()).rejects.toMatchObject(unavailable);
});
it("refuses premature or repeated host guards and unexpected registration return", async () => {
  const s = await seeded(),
    f = candidateFixture(s.db);
  await f.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  const first = must(f.hooks[0]);
  await first.guard();
  await expect(first.guard()).rejects.toMatchObject(unavailable);
  const malformed = fixture(s.db),
    register = new Proxy(malformed.options.registerBeforeCommit, {
      apply(target, thisArg, args) {
        Reflect.apply(target, thisArg, args);
        return false;
      },
    });
  const opts = {
    ...malformed.candidateOptions,
    registerBeforeCommit: register,
    draftSource: { ...malformed.options, registerBeforeCommit: register },
    materialSource: { ...malformed.materialOptions, registerBeforeCommit: register },
  };
  await expect(
    createPostgresTaxConfigCandidateStore(opts).prepare(s.command),
  ).rejects.toMatchObject(unavailable);
});
it("rejects a missing selected candidate or a fabricated roster cursor instead of returning a false current packet", async () => {
  const s = await seeded();
  await expect(
    candidateFixture(s.db).source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: id(999),
    }),
  ).rejects.toMatchObject(conflict);
  await expect(
    candidateFixture(s.db).source.readRoster({
      configurationReference: s.command.configurationReference,
      afterCandidate: id(999),
    }),
  ).rejects.toMatchObject(conflict);
});
it("rejects audit classification drift before actual append and catches clock-side port mutation at the final boundary", async () => {
  const s = await seeded(),
    f = fixture(s.db),
    base = f.candidateOptions.audit.create;
  f.candidateOptions.audit.create = vi.fn((packet) => ({
    ...base(packet),
    dataClassification: "Internal" as const,
  }));
  const source = createPostgresTaxConfigCandidateStore(f.candidateOptions),
    before = counts(s.db);
  await expect(source.prepare(s.command)).rejects.toMatchObject(unavailable);
  expect(counts(s.db)).toEqual(before);
  const last = fixture(s.db),
    clock = last.options.clock.now,
    originalQuery = last.options.transaction.query;
  let mutate = false;
  last.options.clock.now = () => {
    if (mutate) {
      last.candidateOptions.transaction.query = async <R>(
        sql: string,
        values: readonly unknown[],
      ) => originalQuery<R>(sql, values);
    }
    return clock();
  };
  const held = createPostgresTaxConfigCandidateStore(last.candidateOptions);
  await held.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  for (const h of last.hooks) await h.guard();
  for (const h of last.hooks) h.final();
  mutate = true;
  expect(() => held.assertFinalized()).toThrow();
});
it("pages twenty actual immutable candidates and retains full child guards without exporting source contents", async () => {
  const s = await seeded();
  for (let i = 0; i < 21; i++) {
    const writer = candidateFixture(s.db);
    await writer.atomic(() =>
      writer.source.prepare({ ...s.command, operationReference: id(1000 + i) }),
    );
  }
  const reader = candidateFixture(s.db, id(50)),
    first = await reader.atomic(() =>
      reader.source.readRoster({
        configurationReference: s.command.configurationReference,
        afterCandidate: null,
      }),
    );
  expect(first.entries).toHaveLength(20);
  const last = must(first.entries[19]);
  expect(first.nextAfterCandidate).toBe(last.targetVersionReference);
  expect(first.entries.map((e) => e.targetVersionReference)).toEqual(
    [...first.entries.map((e) => e.targetVersionReference)].sort(),
  );
  expect(reader.hooks).toHaveLength(3);
  expect(canonicalizeRfc8785(first)).not.toContain('"rules"');
  const next = candidateFixture(s.db, id(50)),
    tail = await next.atomic(() =>
      next.source.readRoster({
        configurationReference: s.command.configurationReference,
        afterCandidate: last.targetVersionReference,
      }),
    );
  expect(tail.entries).toHaveLength(1);
  expect(tail.nextAfterCandidate).toBeNull();
  expect(must(tail.entries[0]).targetVersionReference > last.targetVersionReference).toBe(true);
});

it("reads the actual latest candidate for a null selector while retaining exact selected history and scoped absence", async () => {
  const s = await seeded(),
    empty = candidateFixture(s.db);
  const absent = await empty.atomic(() =>
    empty.source.readCurrent({
      configurationReference: s.command.configurationReference,
      targetVersionReference: null,
    }),
  );
  expect(absent.record).toBeNull();
  expect(absent.targetVersionReference).toBeNull();
  const first = candidateFixture(s.db),
    one = await first.atomic(() => first.source.prepare(s.command));
  const second = candidateFixture(s.db),
    two = await second.atomic(() =>
      second.source.prepare({ ...s.command, operationReference: id(1000) }),
    );
  const latest = candidateFixture(s.db),
    current = await latest.atomic(() =>
      latest.source.readCurrent({
        configurationReference: s.command.configurationReference,
        targetVersionReference: null,
      }),
    );
  expect(current.record).toEqual(two.result);
  expect(current.targetVersionReference).toBe(
    must(two.result).candidate.content.targetVersionReference,
  );
  expect(
    latest.queries.filter((q) =>
      q.sql.includes("ORDER BY prepared_at DESC,target_version_id DESC LIMIT 1"),
    ),
  ).toHaveLength(2);
  const historical = candidateFixture(s.db),
    old = await historical.atomic(() =>
      historical.source.readCurrent({
        configurationReference: s.command.configurationReference,
        targetVersionReference: must(one.result).candidate.content.targetVersionReference,
      }),
    );
  expect(old.record).toEqual(one.result);
  const other = candidateFixture(s.db),
    scoped = await other.atomic(() =>
      other.source.readCurrent({ configurationReference: id(999), targetVersionReference: null }),
    );
  expect(scoped.record).toBeNull();
  await expect(
    candidateFixture(s.db).source.readCurrent({
      configurationReference: id(999),
      targetVersionReference: must(one.result).candidate.content.targetVersionReference,
    }),
  ).rejects.toMatchObject(conflict);
});
it("refuses a changed latest candidate and an absence that becomes present at the actual final guard", async () => {
  const s = await seeded(),
    empty = candidateFixture(s.db);
  await empty.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  const first = candidateFixture(s.db);
  await first.atomic(() => first.source.prepare(s.command));
  await expect(empty.finish()).rejects.toMatchObject(conflict);
  const reader = candidateFixture(s.db);
  await reader.source.readCurrent({
    configurationReference: s.command.configurationReference,
    targetVersionReference: null,
  });
  const next = candidateFixture(s.db);
  await next.atomic(() => next.source.prepare({ ...s.command, operationReference: id(1000) }));
  await expect(reader.finish()).rejects.toMatchObject(conflict);
});

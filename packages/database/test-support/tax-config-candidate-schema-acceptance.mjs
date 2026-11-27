import assert from "node:assert/strict";
import pg from "pg";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { appendEventInTransaction, loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createBrand,
  createStore,
  createTenantContext,
  parseCanonicalInstant,
} from "../../bop/tenant/src/index.ts";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "../../bop/permission/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createPostgresTaxConfigAuthoringStore } from "../../rms/pricing/src/infrastructure/persistence/tax-config-authoring-store.ts";
import { createPostgresTaxConfigCandidateStore } from "../../rms/pricing/src/infrastructure/persistence/tax-config-candidate-store.ts";
import { createPostgresTaxConfigMaterialStore } from "../../rms/pricing/src/infrastructure/persistence/tax-config-material-store.ts";
import { parseTaxConfigAuthoringCommand } from "../../rms/pricing/src/contracts/tax-config-authoring.ts";
import { parseTaxConfigMaterialCommand } from "../../rms/pricing/src/contracts/tax-config-material.ts";
import { createTaxPublicationCandidate } from "../../rms/pricing/src/contracts/tax-config-publication-candidate.ts";
import {
  parseTaxConfigCandidateCommand,
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateRecord,
  parseTaxConfigCandidateSummary,
  taxConfigCandidateIntentDigest,
  assertTaxConfigCandidateSources,
} from "../../rms/pricing/src/contracts/tax-config-candidate-authoring.ts";

const id = (n) => "01902421-1217-7000-8000-" + n.toString(16).padStart(12, "0");
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const flush =
  "SET CONSTRAINTS rms_pricing.tax_config_candidate_record_coherence,rms_pricing.tax_config_candidate_operation_coherence,rms_pricing.tax_config_candidate_rule_coherence IMMEDIATE";
const recordColumns =
  "target_version_id,tenant_id,brand_id,store_id,configuration_id,actor_id,operation_id,base_version_id,base_snapshot_digest,base_aggregate_version,base_version_number,target_aggregate_version,target_version_number,registration_material_id,registration_version_id,registration_content_digest,content_digest,record_json,record_text,record_digest,audit_id,event_id,prepared_at,data_classification";
const originalColumns =
  "operation_id,tenant_id,brand_id,store_id,actor_id,action_code,configuration_id,expected_base_version_id,expected_base_snapshot_digest,expected_base_aggregate_version,expected_base_version_number,registration_material_id,registration_version_id,registration_content_digest,intent_digest,outcome,result_target_version_id,receipt_json,receipt_text,receipt_digest,audit_id,audit_json,event_id,occurred_at,data_classification";
const params = (count) => Array.from({ length: count }, (_, i) => "$" + (i + 1)).join(",");

/** Actual PG, public Draft/Material sources, Audit and Outbox. Candidate rows are
 * also supplied directly for schema attack checks; ordinary candidate methods
 * use the actual candidate owner and parent/child guards. Authority
 * is controlled evaluatePermission evidence, not Session/IAM, professional
 * qualification, Core review, or ordinary HTTP workflow acceptance. */
export async function verifyTaxConfigCandidateSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_tax_candidate_" + context.runId;
  assert.match(role, /^wp2421_tax_candidate_[a-f0-9]+$/u);
  await admin.connect();
  const q = input(),
    scope = {
      tenantReference: id(1),
      brandReference: q.brandReference,
      storeReference: q.storeReference,
      actorReference: id(4),
    };
  let roleCreated = false,
    serial = 1000;
  const generate = () => id(++serial);
  const restore = async (client, selected = scope) => {
    await client.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [selected.tenantReference, selected.brandReference, selected.storeReference],
    );
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_pricing.tax_configuration_version) drafts,(SELECT count(*)::int FROM rms_pricing.tax_config_publication_candidate) candidates,(SELECT count(*)::int FROM rms_pricing.tax_config_candidate_rule) reservations,(SELECT count(*)::int FROM rms_pricing.tax_config_candidate_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
      )
    ).rows[0];
  const raw = async (work, { selected = scope, commit = false, privileged = false } = {}) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      if (!privileged) await admin.query("SET LOCAL ROLE " + role);
      await restore(admin, selected);
      const result = await work(admin);
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const unchanged = async (work, code) => {
    const before = await counts();
    await assert.rejects(work, (error) => error.code === code);
    assert.deepEqual(await counts(), before);
  };
  const held = async (work, { selected = scope, after = null } = {}) => {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL ROLE " + role);
      await restore(client, selected);
      const at = new Date().toISOString(),
        until = new Date(Date.parse(at) + 5000).toISOString(),
        hooks = [],
        owners = [],
        state = { allowed: true, lease: until };
      const tx = Object.freeze({ query: (sql, values) => client.query(sql, values) });
      const brand = createBrand({
        brandReference: selected.brandReference,
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
        storeReference: selected.storeReference,
        brandReference: selected.brandReference,
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
      const sourceClock = { now: () => new Date().toISOString() };
      const sourceRegister = (actual, guard, final) => {
        assert.equal(actual, tx);
        hooks.push({ guard, final });
      };
      const optionsFor = (kind) => {
        const common = {
          transaction: tx,
          scope: selected,
          originalObservedAt: at,
          originalValidUntil: until,
          clock: sourceClock,
          registerBeforeCommit: sourceRegister,
          references: { generate },
          authority: {
            async holdUntilTransactionCompletes(actual, request) {
              assert.equal(actual, tx);
              assert.deepEqual(request.scope, selected);
              assert.equal(request.permission, "pricing.tax-config.manage");
              assert.equal(
                request.purposeCode,
                kind === "Draft"
                  ? "PRICING_TAX_CONFIG_AUTHORING"
                  : kind === "Candidate"
                    ? "PRICING_TAX_CONFIG_CANDIDATE"
                    : "PRICING_TAX_CONFIG_MATERIAL",
              );
              const tenantContext = createTenantContext(
                  {
                    actorType: "User",
                    actorReference: selected.actorReference,
                    accountKind: "Workforce",
                    status: "Active",
                    authenticationMethod: "Oidc",
                    verificationLevel: "SingleFactor",
                    authenticatedAt: at,
                    recentMfaAt: null,
                  },
                  brand,
                  store,
                  new Date().toISOString(),
                ),
                action = parseBusinessAction(request.permission);
              const permission = evaluatePermission({
                tenantContext,
                action,
                resourceScope: {
                  kind: "Store",
                  brandReference: selected.brandReference,
                  storeReference: selected.storeReference,
                },
                policySnapshotReference: parsePolicyReference(id(9)),
                policyVersion: parsePolicyVersion(1),
                evidence: state.allowed
                  ? [
                      {
                        source: "RolePermission",
                        evidenceReference: parseEvidenceReference(id(10)),
                        action,
                        actorReference: tenantContext.actor.actorReference,
                        roleReference: parseRoleReference(id(11)),
                        brandReference: selected.brandReference,
                        storeReference: selected.storeReference,
                        effectiveFrom: parseCanonicalInstant(at),
                        effectiveUntil: null,
                      },
                    ]
                  : [],
              });
              return { scope: selected, tenantContext, permission, validUntil: state.lease };
            },
          },
          audit: {
            create({
              mode,
              auditReference,
              command,
              configurationReference,
              materialReference,
              targetVersionReference,
              intentDigest,
              occurredAt,
            }) {
              const target =
                kind === "Draft"
                  ? configurationReference
                  : kind === "Candidate"
                    ? targetVersionReference
                    : materialReference;
              return {
                auditId: auditReference,
                brandId: selected.brandReference,
                storeId: selected.storeReference,
                actor: { type: "User", reference: selected.actorReference },
                actionCode:
                  kind === "Candidate"
                    ? mode === "Abandon"
                      ? "PRICING_TAX_CANDIDATE_RESOLVE"
                      : "PRICING_TAX_CANDIDATE_PREPARE"
                    : mode === "Abandon"
                      ? kind === "Draft"
                        ? "PRICING_TAX_CONFIG_RESOLVE"
                        : "PRICING_TAX_MATERIAL_RESOLVE"
                      : (kind === "Draft" ? "PRICING_TAX_CONFIG_" : "PRICING_TAX_MATERIAL_") +
                        command.action.toUpperCase(),
                targetType:
                  kind === "Candidate"
                    ? mode === "Abandon"
                      ? "PricingTaxCandidateOperation"
                      : "PricingTaxConfigCandidate"
                    : mode === "Abandon"
                      ? kind === "Draft"
                        ? "PricingTaxAuthoringOperation"
                        : "PricingTaxMaterialOperation"
                      : kind === "Draft"
                        ? "PricingTaxConfiguration"
                        : "PricingTaxConfigMaterial",
                targetId: mode === "Abandon" ? command.operationReference : target,
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: command.operationReference,
                occurredAt,
                sourceChannel: "API",
                dataClassification: kind === "Draft" ? "Internal" : "Confidential",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
                afterSummary: { intentDigest },
              };
            },
          },
        };
        return kind === "Draft"
          ? {
              ...common,
              currency: {
                async readCurrent(actual) {
                  assert.equal(actual, tx);
                  return q.currencyMetadata;
                },
              },
              facts: {
                async validateDraft(actual, packet) {
                  assert.equal(actual, tx);
                  assert.equal(packet.snapshot.lifecycle, "Draft");
                  assert.equal(packet.snapshot.professionalEvidence, null);
                },
              },
            }
          : {
              ...common,
              facts: {
                async validateMaterial(actual, packet) {
                  assert.equal(actual, tx);
                  assert.equal(packet.version.qualification, "NotEvaluated");
                },
              },
            };
      };
      const owner = (kind) => {
        const source =
          kind === "Draft"
            ? createPostgresTaxConfigAuthoringStore(optionsFor(kind))
            : kind === "Material"
              ? createPostgresTaxConfigMaterialStore(optionsFor(kind))
              : createPostgresTaxConfigCandidateStore({
                  ...optionsFor(kind),
                  draftSource: optionsFor("Draft"),
                  materialSource: optionsFor("Material"),
                });
        owners.push(source);
        return source;
      };
      const result = await work({ tx, owner, at, until, selected, state, hooks });
      if (after) await after(state, tx);
      for (const hook of hooks) await hook.guard();
      for (const hook of hooks) hook.final();
      await restore(client, selected);
      await client.query("COMMIT");
      for (const source of owners) assert(Date.parse(source.assertFinalized()) > Date.now());
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  };
  const draftCommand = (op, code = "SYNTHETIC_TAX") =>
    parseTaxConfigAuthoringCommand({
      action: "CreateDraft",
      operationReference: id(op),
      configurationReference: null,
      expectedAggregateVersion: null,
      content: {
        stableCode: code,
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
  const commandFor = (draft, material, op) =>
    parseTaxConfigCandidateCommand({
      action: "PrepareCandidate",
      operationReference: op,
      configurationReference: draft.snapshot.configurationReference,
      expectedDraft: {
        versionReference: draft.snapshot.versionReference,
        snapshotDigest: draft.snapshot.snapshotDigest,
        aggregateVersion: draft.snapshot.aggregateVersion,
        versionNumber: draft.snapshot.versionNumber,
      },
      registrationMaterial: {
        materialReference: material.materialReference,
        versionReference: material.versionReference,
        contentDigest: material.contentDigest,
      },
    });
  const makePacket = (draft, material, op, target = generate(), selected = scope) => {
    const command = commandFor(draft, material, op),
      at = new Date().toISOString(),
      auditReference = generate(),
      eventReference = generate(),
      candidate = createTaxPublicationCandidate({
        draft,
        targetVersionReference: target,
        sourceRuleBindings: draft.snapshot.rules.map((rule) => ({
          sourceRuleReference: rule.ruleReference,
          targetRuleReference: generate(),
        })),
        registrationMaterial: command.registrationMaterial,
      });
    const record = createTaxConfigCandidateRecord({
      scope: selected,
      command,
      candidate,
      draft,
      registrationMaterial: material,
      preparedAt: at,
      auditReference,
      eventReference,
    });
    const receipt = parseTaxConfigCandidateOperation({
      profile: "TaxConfigCandidateOperationV1",
      ...selected,
      ...command,
      command,
      intentDigest: taxConfigCandidateIntentDigest(selected, command),
      outcome: "Committed",
      result: record,
      auditReference,
      eventReference,
      occurredAt: at,
    });
    return { command, record, receipt };
  };
  const auditFor = (receipt) => ({
    auditId: receipt.auditReference,
    brandId: receipt.brandReference,
    storeId: receipt.storeReference,
    actor: { type: "User", reference: receipt.actorReference },
    actionCode:
      receipt.outcome === "Committed"
        ? "PRICING_TAX_CANDIDATE_PREPARE"
        : "PRICING_TAX_CANDIDATE_RESOLVE",
    targetType:
      receipt.outcome === "Committed"
        ? "PricingTaxConfigCandidate"
        : "PricingTaxCandidateOperation",
    targetId:
      receipt.result?.candidate.content.targetVersionReference ?? receipt.operationReference,
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: receipt.operationReference,
    occurredAt: receipt.occurredAt,
    sourceChannel: "API",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    afterSummary: { intentDigest: receipt.intentDigest },
  });
  const insertRecord = async (tx, record) => {
    const c = record.candidate.content,
      b = c.baseDraft,
      m = c.registrationMaterial;
    await tx.query(
      "INSERT INTO rms_pricing.tax_config_publication_candidate(" +
        recordColumns +
        ") VALUES(" +
        params(23) +
        ",'Confidential')",
      [
        c.targetVersionReference,
        record.tenantReference,
        record.brandReference,
        record.storeReference,
        c.configurationReference,
        record.preparedByActorReference,
        record.operationReference,
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
        record,
        canonicalizeRfc8785(record),
        hash(record),
        record.auditReference,
        record.eventReference,
        record.preparedAt,
      ],
    );
  };
  const insertRules = async (tx, record) => {
    const c = record.candidate.content;
    for (const [i, b] of c.sourceRuleBindings.entries())
      await tx.query(
        "INSERT INTO rms_pricing.tax_config_candidate_rule(tenant_id,brand_id,store_id,configuration_id,base_version_id,target_version_id,source_rule_id,target_rule_id,rule_ordinal) VALUES(" +
          params(9) +
          ")",
        [
          record.tenantReference,
          record.brandReference,
          record.storeReference,
          c.configurationReference,
          c.baseDraft.versionReference,
          c.targetVersionReference,
          b.sourceRuleReference,
          b.targetRuleReference,
          i + 1,
        ],
      );
  };
  const insertOriginal = async (tx, receipt, audit = auditFor(receipt)) => {
    const b = receipt.expectedDraft,
      m = receipt.registrationMaterial;
    await tx.query(
      "INSERT INTO rms_pricing.tax_config_candidate_operation(" +
        originalColumns +
        ") VALUES(" +
        params(24) +
        ",'Confidential')",
      [
        receipt.operationReference,
        receipt.tenantReference,
        receipt.brandReference,
        receipt.storeReference,
        receipt.actorReference,
        receipt.action,
        receipt.configurationReference,
        b.versionReference,
        b.snapshotDigest,
        b.aggregateVersion,
        b.versionNumber,
        m.materialReference,
        m.versionReference,
        m.contentDigest,
        receipt.intentDigest,
        receipt.outcome,
        receipt.result?.candidate.content.targetVersionReference ?? null,
        receipt,
        canonicalizeRfc8785(receipt),
        hash(receipt),
        receipt.auditReference,
        audit,
        receipt.eventReference,
        receipt.occurredAt,
      ],
    );
  };
  const appendPacket = async (tx, packet, { publicHistory = true } = {}) => {
    const { record, receipt } = packet,
      identities = [
        record.candidate.content.targetVersionReference,
        ...record.candidate.content.sourceRuleBindings.map((b) => b.targetRuleReference),
      ].sort();
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('PricingTaxCandidateOriginal:'||$1,0))",
      [receipt.operationReference],
    );
    for (const identity of identities)
      assert.equal(
        (
          await tx.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('PricingTaxCandidateIdentity:'||$1,0)) admitted",
            [identity],
          )
        ).rows[0].admitted,
        true,
      );
    const audit = auditFor(receipt);
    if (publicHistory) {
      await appendAuditRecordInTransaction(tx, audit);
      await appendEventInTransaction(tx, {
        eventId: receipt.eventReference,
        eventType: "TaxConfigCandidatePrepared",
        schemaVersion: 1,
        occurredAt: receipt.occurredAt,
        producerModule: "@rms/pricing",
        tenantId: receipt.brandReference,
        storeId: receipt.storeReference,
        aggregateType: "PricingTaxConfigCandidate",
        aggregateId: record.candidate.content.targetVersionReference,
        aggregateVersion: BigInt(record.candidate.content.targetAggregateVersion),
        correlationId: receipt.operationReference,
        causationId: receipt.operationReference,
        actor: { type: "Actor", actorId: receipt.actorReference },
        payload: {
          configurationReference: receipt.configurationReference,
          targetVersionReference: record.candidate.content.targetVersionReference,
          contentDigest: record.candidate.contentDigest,
          preparedAt: record.preparedAt,
        },
        redactionClassification: "indirect_identifier",
        replayMetadata: {
          auditReference: receipt.auditReference,
          originalIntentDigest: receipt.intentDigest,
        },
      });
    }
    await restore(tx, receipt);
    await insertRecord(tx, record);
    await insertRules(tx, record);
    await insertOriginal(tx, receipt, audit);
    await tx.query(flush);
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    roleCreated = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_pricing,platform_helpers,platform_audit,platform_eventing TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_pricing.tax_config_authoring_operation_available(platform_helpers.uuid_v7),rms_pricing.tax_config_material_operation_available(platform_helpers.uuid_v7),rms_pricing.tax_config_candidate_operation_available(platform_helpers.uuid_v7) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.tax_configuration_operation_record,rms_pricing.tax_config_material,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_pricing.tax_config_authoring_operation,rms_pricing.tax_config_material_version,rms_pricing.tax_config_material_operation,platform_audit.audit_record,platform_eventing.outbox_event TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_pricing.tax_config_publication_candidate,rms_pricing.tax_config_candidate_operation,rms_pricing.tax_config_candidate_rule TO " +
        role,
    );
    const first = await held(({ owner }) => owner("Draft").execute(draftCommand(20))),
      other = await held(({ owner }) => owner("Draft").execute(draftCommand(21, "OTHER_TAX")));
    const issued = new Date().toISOString(),
      material = await held(({ owner }) =>
        owner("Material").execute(
          parseTaxConfigMaterialCommand({
            action: "CreateMaterial",
            operationReference: id(22),
            materialReference: null,
            expectedRevision: null,
            materialKind: "RegistrationApplicability",
            content: {
              operatingEntityProfileVersionReference: id(30),
              operatingEntityTaxReference: null,
              jurisdictionCode: "CA-ON",
              applicability: "Applicable",
              sourceIssuedAt: issued,
              effectiveFrom: issued,
              effectiveUntil: null,
              declaredSourceDigest: null,
            },
          }),
        ),
      );
    const prepared = await held(async ({ tx, owner }) => {
      const draft = (await owner("Draft").readCurrent(first.snapshot.configurationReference)).state,
        registration = await owner("Material").readVersion({
          materialKind: "RegistrationApplicability",
          versionReference: material.version.versionReference,
        });
      const packet = makePacket(draft, registration.version, id(40));
      await appendPacket(tx, packet);
      return { packet, draft, registration: registration.version };
    });
    assert.equal(prepared.packet.record.qualification, "NotEvaluated");
    assert.equal(prepared.registration.content.operatingEntityTaxReference, null);
    const baseline = await counts();
    assert.deepEqual(baseline, {
      drafts: 2,
      candidates: 1,
      reservations: 1,
      originals: 1,
      audits: 4,
      events: 4,
    });
    await held(
      async ({ tx, owner }) => {
        const stored = (
            await tx.query(
              "SELECT record_json,record_text,record_digest FROM rms_pricing.tax_config_publication_candidate WHERE target_version_id=$1",
              [prepared.packet.record.candidate.content.targetVersionReference],
            )
          ).rows[0],
          record = parseTaxConfigCandidateRecord(stored.record_json);
        assert.equal(stored.record_text, canonicalizeRfc8785(record));
        assert.equal(stored.record_digest, hash(record));
        const draft = (
            await owner("Draft").readVersion({
              configurationReference: record.candidate.content.configurationReference,
              versionReference: record.candidate.content.baseDraft.versionReference,
            })
          ).state,
          reg = await owner("Material").readVersion({
            materialKind: "RegistrationApplicability",
            versionReference: record.candidate.content.registrationMaterial.versionReference,
          });
        assert.deepEqual(
          assertTaxConfigCandidateSources(record, draft, reg.version),
          prepared.packet.record,
        );
        const original = parseTaxConfigCandidateOperation(
          (
            await tx.query(
              "SELECT receipt_json FROM rms_pricing.tax_config_candidate_operation WHERE operation_id=$1",
              [record.operationReference],
            )
          ).rows[0].receipt_json,
        );
        assert.deepEqual(original, prepared.packet.receipt);
        assert.equal(
          (await loadOutboxEnvelope(tx, record.eventReference)).eventId,
          record.eventReference,
        );
        const c = record.candidate.content,
          summary = parseTaxConfigCandidateSummary({
            tenantReference: record.tenantReference,
            brandReference: record.brandReference,
            storeReference: record.storeReference,
            configurationReference: c.configurationReference,
            targetVersionReference: c.targetVersionReference,
            targetAggregateVersion: c.targetAggregateVersion,
            targetVersionNumber: c.targetVersionNumber,
            contentDigest: record.candidate.contentDigest,
            baseDraft: c.baseDraft,
            registrationMaterial: c.registrationMaterial,
            preparedByActorReference: record.preparedByActorReference,
            operationReference: record.operationReference,
            preparedAt: record.preparedAt,
            status: record.status,
            qualification: record.qualification,
          });
        assert.equal(Object.hasOwn(summary, "rules"), false);
        assert.equal(Object.hasOwn(summary, "content"), false);
      },
      { selected: { ...scope, actorReference: id(5) } },
    );
    assert.deepEqual(await counts(), baseline);

    await held(async ({ tx, owner }) => {
      await owner("Draft").readCurrent(first.snapshot.configurationReference);
      const rows = (
        await tx.query(
          "SELECT target_version_id::text,tenant_id::text,brand_id::text,store_id::text,configuration_id::text,actor_id::text,operation_id::text,base_version_id::text,base_snapshot_digest,base_aggregate_version,base_version_number,target_aggregate_version,target_version_number,registration_material_id::text,registration_version_id::text,registration_content_digest,content_digest,prepared_at FROM rms_pricing.tax_config_publication_candidate WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND configuration_id=$4 AND ($5::uuid IS NULL OR target_version_id>$5::uuid) ORDER BY target_version_id LIMIT 21",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            first.snapshot.configurationReference,
            null,
          ],
        )
      ).rows;
      assert.equal(rows.length, 1);
      const r = rows[0];
      const summary = parseTaxConfigCandidateSummary({
        tenantReference: r.tenant_id,
        brandReference: r.brand_id,
        storeReference: r.store_id,
        configurationReference: r.configuration_id,
        targetVersionReference: r.target_version_id,
        targetAggregateVersion: r.target_aggregate_version,
        targetVersionNumber: r.target_version_number,
        contentDigest: r.content_digest,
        baseDraft: {
          versionReference: r.base_version_id,
          snapshotDigest: r.base_snapshot_digest,
          aggregateVersion: r.base_aggregate_version,
          versionNumber: r.base_version_number,
        },
        registrationMaterial: {
          materialReference: r.registration_material_id,
          versionReference: r.registration_version_id,
          contentDigest: r.registration_content_digest,
        },
        preparedByActorReference: r.actor_id,
        operationReference: r.operation_id,
        preparedAt: r.prepared_at.toISOString(),
        status: "Recorded",
        qualification: "NotEvaluated",
      });
      assert.equal(
        summary.targetVersionReference,
        prepared.packet.record.candidate.content.targetVersionReference,
      );
      assert.equal(Object.hasOwn(r, "record_json"), false);
      assert.equal(Object.hasOwn(summary, "candidate"), false);
      assert.equal(
        (
          await tx.query(
            "SELECT target_version_id FROM rms_pricing.tax_config_publication_candidate WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND configuration_id=$4 AND target_version_id>$5 ORDER BY target_version_id LIMIT 21",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              first.snapshot.configurationReference,
              r.target_version_id,
            ],
          )
        ).rows.length,
        0,
      );
    });
    await unchanged(
      () =>
        held(
          async ({ tx, owner }) => {
            const draft = (await owner("Draft").readCurrent(first.snapshot.configurationReference))
                .state,
              reg = (
                await owner("Material").readVersion({
                  materialKind: "RegistrationApplicability",
                  versionReference: material.version.versionReference,
                })
              ).version;
            await appendPacket(tx, makePacket(draft, reg, generate()));
          },
          {
            after: (state) => {
              state.allowed = false;
            },
          },
        ),
      "TAX_CONFIG_PERMISSION_DENIED",
    );
    const packet = () => copy(makePacket(prepared.draft, prepared.registration, generate()));
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          await insertRecord(tx, p.record);
          await tx.query(flush);
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          await insertOriginal(tx, p.receipt);
          await tx.query(flush);
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          await insertRecord(tx, p.record);
          await insertOriginal(tx, p.receipt);
          await tx.query(flush);
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          delete p.record.qualification;
          p.receipt.result = p.record;
          await appendPacket(tx, p, { publicHistory: false });
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          p.record.extraAuthority = true;
          p.receipt.result = p.record;
          await appendPacket(tx, p, { publicHistory: false });
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          p.record.candidate.content.rules[0].rate = "0.14";
          p.record.candidate.contentDigest = hash(p.record.candidate.content);
          p.receipt.result = p.record;
          await appendPacket(tx, p, { publicHistory: false });
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          p.record.preparedByActorReference = id(5);
          p.receipt.result = p.record;
          await appendPacket(tx, p, { publicHistory: false });
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          p.receipt.result = prepared.packet.record;
          await insertRecord(tx, p.record);
          await insertRules(tx, p.record);
          await insertOriginal(tx, p.receipt);
          await tx.query(flush);
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          await insertRecord(tx, p.record);
          await insertRules(tx, p.record);
          await insertOriginal(tx, { ...p.receipt, result: null });
          await tx.query(flush);
        }),
      "23514",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          await insertRecord(tx, p.record);
          await tx.query(
            "UPDATE rms_pricing.tax_config_publication_candidate SET prepared_at=prepared_at+interval '1 microsecond' WHERE target_version_id=$1",
            [p.record.candidate.content.targetVersionReference],
          );
        }),
      "55000",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          const c = p.record.candidate.content,
            b = c.baseDraft,
            m = c.registrationMaterial;
          await tx.query(
            "INSERT INTO rms_pricing.tax_config_publication_candidate(" +
              recordColumns +
              ") VALUES(" +
              params(23) +
              ",'Confidential')",
            [
              c.targetVersionReference,
              p.record.tenantReference,
              p.record.brandReference,
              p.record.storeReference,
              c.configurationReference,
              p.record.preparedByActorReference,
              p.record.operationReference,
              b.versionReference,
              b.snapshotDigest,
              b.aggregateVersion,
              b.versionNumber,
              c.targetAggregateVersion,
              c.targetVersionNumber,
              m.materialReference,
              m.versionReference,
              m.contentDigest,
              p.record.candidate.contentDigest,
              p.record,
              canonicalizeRfc8785(p.record),
              hash(p.record),
              p.record.auditReference,
              p.record.eventReference,
              new Date(Date.parse(p.record.preparedAt)).toISOString().replace("Z", "1Z"),
            ],
          );
        }),
      "23514",
    );
    for (const changed of [
      { tenantReference: id(61) },
      { brandReference: id(62) },
      { storeReference: id(63) },
    ]) {
      const selected = { ...scope, ...changed };
      await raw(
        async (tx) => {
          for (const table of [
            "tax_config_publication_candidate",
            "tax_config_candidate_rule",
            "tax_config_candidate_operation",
          ])
            assert.equal(
              (await tx.query("SELECT count(*)::int n FROM rms_pricing." + table)).rows[0].n,
              0,
            );
        },
        { selected },
      );
      await unchanged(() => raw((tx) => insertRecord(tx, packet().record), { selected }), "42501");
    }
    await unchanged(
      () =>
        raw((tx) =>
          appendPacket(
            tx,
            makePacket(
              prepared.draft,
              prepared.registration,
              generate(),
              other.snapshot.versionReference,
            ),
            { publicHistory: false },
          ),
        ),
      "23505",
    );
    await unchanged(
      () =>
        raw(async (tx) => {
          const p = packet();
          const target = other.snapshot.rules[0].ruleReference;
          p.record.candidate.content.rules[0].ruleReference = target;
          p.record.candidate.content.sourceRuleBindings[0].targetRuleReference = target;
          p.record.candidate.contentDigest = hash(p.record.candidate.content);
          p.receipt.result = p.record;
          await appendPacket(tx, p, { publicHistory: false });
        }),
      "23505",
    );
    await unchanged(
      () =>
        raw((tx) =>
          appendPacket(
            tx,
            makePacket(
              prepared.draft,
              prepared.registration,
              generate(),
              prepared.packet.record.candidate.content.targetVersionReference,
            ),
            { publicHistory: false },
          ),
        ),
      "23505",
    );
    await unchanged(
      () =>
        raw((tx) =>
          tx.query(
            "INSERT INTO rms_pricing.tax_config_candidate_rule(tenant_id,brand_id,store_id,configuration_id,base_version_id,target_version_id,source_rule_id,target_rule_id,rule_ordinal) VALUES(" +
              params(9) +
              ")",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              first.snapshot.configurationReference,
              first.snapshot.versionReference,
              prepared.packet.record.candidate.content.targetVersionReference,
              first.snapshot.rules[0].ruleReference,
              generate(),
              2,
            ],
          ),
        ),
      "23514",
    );
    const versionRow = (
      await admin.query(
        "SELECT to_jsonb(v) body FROM rms_pricing.tax_configuration_version v WHERE tax_configuration_version_id=$1",
        [first.snapshot.versionReference],
      )
    ).rows[0].body;
    const ruleRow = (
      await admin.query(
        "SELECT to_jsonb(r) body FROM rms_pricing.tax_configuration_rule r WHERE tax_configuration_rule_id=$1",
        [first.snapshot.rules[0].ruleReference],
      )
    ).rows[0].body;
    const cloneVersion = async (tx, identity, extra = {}) =>
      tx.query(
        "INSERT INTO rms_pricing.tax_configuration_version SELECT (jsonb_populate_record(NULL::rms_pricing.tax_configuration_version,$1::jsonb)).*",
        [
          {
            ...versionRow,
            tax_configuration_version_id: identity,
            version_number: 99,
            authoring_operation_id: null,
            ...extra,
          },
        ],
      );
    const cloneRule = async (tx, identity) =>
      tx.query(
        "INSERT INTO rms_pricing.tax_configuration_rule SELECT (jsonb_populate_record(NULL::rms_pricing.tax_configuration_rule,$1::jsonb)).*",
        [{ ...ruleRow, tax_configuration_rule_id: identity }],
      );
    await unchanged(
      () =>
        raw((tx) =>
          cloneVersion(tx, prepared.packet.record.candidate.content.targetVersionReference),
        ),
      "23514",
    );
    await unchanged(
      () =>
        raw((tx) =>
          cloneVersion(
            tx,
            prepared.packet.record.candidate.content.sourceRuleBindings[0].targetRuleReference,
          ),
        ),
      "23505",
    );
    await unchanged(
      () =>
        raw((tx) =>
          cloneRule(
            tx,
            prepared.packet.record.candidate.content.sourceRuleBindings[0].targetRuleReference,
          ),
        ),
      "23514",
    );
    await unchanged(
      () =>
        raw((tx) => cloneRule(tx, prepared.packet.record.candidate.content.targetVersionReference)),
      "23505",
    );
    await unchanged(
      () =>
        raw((tx) =>
          cloneVersion(tx, generate(), {
            publication_candidate_version_id: generate(),
            publication_candidate_profile: "UnknownCandidateV2",
            publication_candidate_tenant_id: scope.tenantReference,
          }),
        ),
      "23514",
    );

    // A real concurrent identity holder makes both the new reservation and the
    // legacy 001 insertion refuse 55P03 immediately, with no original append.
    const peer = new pg.Client(context.clientConfig);
    await peer.connect();
    const contested = packet();
    try {
      await peer.query("BEGIN");
      await peer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('PricingTaxCandidateIdentity:'||$1,0))",
        [contested.record.candidate.content.targetVersionReference],
      );
      await unchanged(() => raw((tx) => insertRecord(tx, contested.record)), "55P03");
      await unchanged(
        () =>
          raw((tx) => cloneVersion(tx, contested.record.candidate.content.targetVersionReference)),
        "55P03",
      );
      await peer.query("COMMIT");
      await raw((tx) => appendPacket(tx, contested, { publicHistory: false }));
      assert.deepEqual(await counts(), baseline);
    } finally {
      await peer.query("ROLLBACK");
      await peer.end();
    }

    const absentCommand = parseTaxConfigCandidateCommand({
        action: "PrepareCandidate",
        operationReference: generate(),
        configurationReference: generate(),
        expectedDraft: {
          versionReference: generate(),
          snapshotDigest: "sha256:" + "a".repeat(64),
          aggregateVersion: 1,
          versionNumber: 1,
        },
        registrationMaterial: {
          materialReference: generate(),
          versionReference: generate(),
          contentDigest: "sha256:" + "b".repeat(64),
        },
      }),
      abandoned = parseTaxConfigCandidateOperation({
        profile: "TaxConfigCandidateOperationV1",
        ...scope,
        ...absentCommand,
        command: null,
        intentDigest: taxConfigCandidateIntentDigest(scope, absentCommand),
        outcome: "Abandoned",
        result: null,
        auditReference: generate(),
        eventReference: null,
        occurredAt: new Date().toISOString(),
      });
    await raw(
      async (tx) => {
        const audit = auditFor(abandoned);
        await appendAuditRecordInTransaction(tx, audit);
        await restore(tx);
        await insertOriginal(tx, abandoned, audit);
        await tx.query(flush);
      },
      { commit: true },
    );
    const withAbandoned = await counts();
    assert.deepEqual(withAbandoned, { ...baseline, originals: 2, audits: 5 });
    await raw(async (tx) => {
      const row = (
        await tx.query(
          "SELECT receipt_json FROM rms_pricing.tax_config_candidate_operation WHERE operation_id=$1",
          [abandoned.operationReference],
        )
      ).rows[0];
      assert.deepEqual(parseTaxConfigCandidateOperation(row.receipt_json), abandoned);
      assert.equal(
        (
          await tx.query(
            "SELECT rms_pricing.tax_config_candidate_operation_available($1) available",
            [abandoned.operationReference],
          )
        ).rows[0].available,
        false,
      );
    });
    // A late Prepare reuses the durable Abandoned global nonce. Its attempted
    // replacement terminal must fail the original PK before deferred coherence.
    await unchanged(
      () =>
        raw((tx) =>
          appendPacket(
            tx,
            makePacket(prepared.draft, prepared.registration, abandoned.operationReference),
            { publicHistory: false },
          ),
        ).catch((error) => {
          assert.equal(error.constraint, "tax_config_candidate_operation_pkey");
          throw error;
        }),
      "23505",
    );
    const foreign = { ...scope, storeReference: id(63) },
      foreignCommand = { ...absentCommand, operationReference: generate() },
      foreignAbandoned = parseTaxConfigCandidateOperation({
        ...abandoned,
        ...foreign,
        ...foreignCommand,
        auditReference: generate(),
        intentDigest: taxConfigCandidateIntentDigest(foreign, foreignCommand),
      });
    await raw(
      async (tx) => {
        await insertOriginal(tx, foreignAbandoned);
        await tx.query(flush);
      },
      { selected: foreign, commit: true },
    );
    await raw(async (tx) => {
      assert.equal(
        (
          await tx.query(
            "SELECT receipt_json FROM rms_pricing.tax_config_candidate_operation WHERE operation_id=$1",
            [foreignAbandoned.operationReference],
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await tx.query(
            "SELECT rms_pricing.tax_config_candidate_operation_available($1) available",
            [foreignAbandoned.operationReference],
          )
        ).rows[0].available,
        false,
      );
    });
    await unchanged(
      () =>
        raw((tx) =>
          insertOriginal(tx, {
            ...foreignAbandoned,
            ...scope,
            intentDigest: taxConfigCandidateIntentDigest(scope, foreignCommand),
          }),
        ),
      "23505",
    );

    // Immutable original basis remains readable after the actual ordinary Draft
    // producer advances the head. A fresh preparation cannot silently reuse it.
    const manager = { ...scope, actorReference: id(5) },
      replacement = parseTaxConfigAuthoringCommand({
        ...draftCommand(23),
        action: "ReplaceDraft",
        configurationReference: first.snapshot.configurationReference,
        expectedAggregateVersion: 1,
        content: {
          ...draftCommand(23).content,
          rules: [{ ...draftCommand(23).content.rules[0], rate: "0.14" }],
        },
      });
    const successor = await held(({ owner }) => owner("Draft").execute(replacement), {
      selected: manager,
    });
    assert.equal(successor.snapshot.aggregateVersion, 2);
    await held(
      async ({ tx, owner }) => {
        const draft = (
            await owner("Draft").readVersion({
              configurationReference: first.snapshot.configurationReference,
              versionReference: first.snapshot.versionReference,
            })
          ).state,
          reg = (
            await owner("Material").readVersion({
              materialKind: "RegistrationApplicability",
              versionReference: material.version.versionReference,
            })
          ).version;
        assert.deepEqual(
          assertTaxConfigCandidateSources(prepared.packet.record, draft, reg),
          prepared.packet.record,
        );
        assert.equal(
          (
            await tx.query(
              "SELECT receipt_json FROM rms_pricing.tax_config_candidate_operation WHERE operation_id=$1",
              [prepared.packet.receipt.operationReference],
            )
          ).rows[0].receipt_json.actorReference,
          scope.actorReference,
        );
      },
      { selected: manager },
    );
    await unchanged(
      () => raw((tx) => appendPacket(tx, packet(), { publicHistory: false })),
      "23514",
    );
    for (const table of [
      "tax_config_publication_candidate",
      "tax_config_candidate_operation",
      "tax_config_candidate_rule",
    ]) {
      await unchanged(
        () => raw((tx) => tx.query("UPDATE rms_pricing." + table + " SET tenant_id=tenant_id")),
        "55000",
      );
      await unchanged(() => raw((tx) => tx.query("DELETE FROM rms_pricing." + table)), "55000");
    }
    await unchanged(
      () => raw((tx) => tx.query("TRUNCATE rms_pricing.tax_config_candidate_rule")),
      "55000",
    );
    await unchanged(
      () =>
        raw((tx) => tx.query("TRUNCATE rms_pricing.tax_config_publication_candidate CASCADE"), {
          privileged: true,
        }),
      "55000",
    );
    const final = await counts();
    assert.deepEqual(final, {
      drafts: 3,
      candidates: 1,
      reservations: 1,
      originals: 3,
      audits: 6,
      events: 5,
    });

    // The actual Candidate writer now consumes the real child option packets.
    // Every parent async guard runs before the consumed child owner guards;
    // all synchronous guards run before COMMIT and owner assertions follow it.
    const actualCommand = commandFor(
      { ...prepared.draft, snapshot: successor.snapshot },
      material.version,
      generate(),
    );
    const actual = await held(async ({ owner, hooks }) => {
      const source = owner("Candidate"),
        result = await source.prepare(actualCommand);
      assert.equal(hooks.length, 3);
      assert.equal(result.result.status, "Recorded");
      assert.equal(result.result.qualification, "NotEvaluated");
      assert.equal(result.result.candidate.content.rules[0].rate, "0.14");
      return result;
    });
    const target = actual.result.candidate.content.targetVersionReference;
    await held(
      async ({ owner }) => {
        const current = await owner("Candidate").readCurrent({
          configurationReference: actual.configurationReference,
          targetVersionReference: target,
        });
        assert.deepEqual(current.record, actual.result);
        assert.equal(current.actorReference, manager.actorReference);
        assert.equal(current.record.preparedByActorReference, scope.actorReference);
      },
      { selected: manager },
    );
    await held(async ({ owner }) => {
      const roster = await owner("Candidate").readRoster({
        configurationReference: actual.configurationReference,
        afterCandidate: null,
      });
      assert.equal(roster.entries.length, 2);
      assert.equal(roster.nextAfterCandidate, null);
      assert.equal(
        roster.entries.some((entry) => entry.targetVersionReference === target),
        true,
      );
      assert.equal(JSON.stringify(roster).includes('"rules"'), false);
      assert.equal(JSON.stringify(roster).includes("operatingEntityTaxReference"), false);
    });
    const nextDraft = await held(
      ({ owner }) =>
        owner("Draft").execute({
          ...replacement,
          operationReference: generate(),
          expectedAggregateVersion: 2,
          content: {
            ...replacement.content,
            rules: [{ ...replacement.content.rules[0], rate: "0.15" }],
          },
        }),
      { selected: manager },
    );
    const beforeReplay = await counts();
    const replay = await held(({ owner }) => owner("Candidate").prepare(actualCommand));
    assert.deepEqual(replay, actual);
    const resolved = await held(({ owner }) =>
      owner("Candidate").resolveOriginal({
        ...actualCommand,
        intentDigest: actual.intentDigest,
      }),
    );
    assert.deepEqual(resolved, actual);
    assert.deepEqual(await counts(), beforeReplay);
    await held(
      async ({ owner }) => {
        const historical = await owner("Candidate").readCurrent({
          configurationReference: actual.configurationReference,
          targetVersionReference: target,
        });
        assert.equal(historical.record.candidate.content.rules[0].rate, "0.14");
        assert.equal(
          historical.record.candidate.content.baseDraft.versionReference,
          successor.snapshot.versionReference,
        );
      },
      { selected: manager },
    );
    const absent = commandFor(
      { ...prepared.draft, snapshot: nextDraft.snapshot },
      material.version,
      generate(),
    );
    const abandonedActual = await held(({ owner }) =>
      owner("Candidate").resolveOriginal({
        ...absent,
        intentDigest: taxConfigCandidateIntentDigest(scope, absent),
      }),
    );
    assert.equal(abandonedActual.outcome, "Abandoned");
    assert.equal(abandonedActual.result, null);
    assert.equal(abandonedActual.eventReference, null);
    const beforeLate = await counts();
    assert.deepEqual(
      await held(({ owner }) => owner("Candidate").prepare(absent)),
      abandonedActual,
    );
    assert.deepEqual(await counts(), beforeLate);
    await unchanged(
      () =>
        held(
          ({ owner }) => owner("Candidate").prepare({ ...absent, operationReference: generate() }),
          {
            after: (state) => {
              state.allowed = false;
            },
          },
        ),
      "TAX_CONFIG_PERMISSION_DENIED",
    );
    const completed = await counts();
    assert.deepEqual(completed, {
      drafts: 4,
      candidates: 2,
      reservations: 2,
      originals: 5,
      audits: 9,
      events: 7,
    });
    return {
      actualCandidateOwner: true,
      currentAndRoster: true,
      historicalReplay: true,
      durableAbandoned: true,
      parentChildGuards: true,
    };
  } finally {
    if (roleCreated) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}

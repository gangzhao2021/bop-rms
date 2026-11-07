import assert from "node:assert/strict";
import pg from "pg";
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
import { createPostgresTaxConfigMaterialStore } from "../../rms/pricing/src/infrastructure/persistence/tax-config-material-store.ts";
import {
  parseTaxConfigMaterialCommand,
  taxConfigMaterialIntentDigest,
} from "../../rms/pricing/src/contracts/tax-config-material.ts";

const id = (n) => "01902421-1215-7000-8000-" + n.toString(16).padStart(12, "0");
const flush =
  "SET CONSTRAINTS rms_pricing.tax_config_material_root_coherence,rms_pricing.tax_config_material_version_coherence,rms_pricing.tax_config_material_operation_coherence IMMEDIATE";

/** Real PostgreSQL/material/Audit/Eventing protocol. Scope/permission/source eligibility
 * are controlled InternalTest fixtures, not actual IAM or professional qualification. */
export async function verifyTaxConfigMaterialSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_tax_material_" + context.runId;
  assert.match(role, /^wp2421_tax_material_[a-f0-9]+$/u);
  await admin.connect();
  const q = input(),
    scope = {
      tenantReference: id(1),
      brandReference: q.brandReference,
      storeReference: q.storeReference,
      actorReference: id(4),
    };
  let createdRole = false,
    serial = 1000;
  const reference = () => id(++serial);
  const scoped = async (client, selected) => {
    await client.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [selected.tenantReference, selected.brandReference, selected.storeReference],
    );
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_pricing.tax_config_material) roots,(SELECT count(*)::int FROM rms_pricing.tax_config_material_version) versions,(SELECT count(*)::int FROM rms_pricing.tax_config_material_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
      )
    ).rows[0];
  const raw = async (work, selected = scope, commit = false) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      await scoped(admin, selected);
      const result = await work(admin);
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const run = async (work, { selected = scope, after = null } = {}) => {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      await scoped(client, selected);
      const at = new Date().toISOString(),
        until = new Date(Date.parse(at) + 5000).toISOString();
      const hooks = [],
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
      const source = createPostgresTaxConfigMaterialStore({
        transaction: tx,
        scope: selected,
        originalObservedAt: at,
        originalValidUntil: until,
        clock: { now: () => new Date().toISOString() },
        registerBeforeCommit(actual, guard, final) {
          assert.equal(actual, tx);
          hooks.push({ guard, final });
        },
        authority: {
          async holdUntilTransactionCompletes(actual, request) {
            assert.equal(actual, tx);
            assert.deepEqual(request.scope, selected);
            assert.equal(request.permission, "pricing.tax-config.manage");
            assert.equal(request.purposeCode, "PRICING_TAX_CONFIG_MATERIAL");
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
            );
            const action = parseBusinessAction(request.permission);
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
              evidence: state.allowed
                ? [
                    {
                      source: "RolePermission",
                      evidenceReference: parseEvidenceReference(id(10)),
                      action,
                      actorReference: tenantContext.actor.actorReference,
                      roleReference: parseRoleReference(id(11)),
                      brandReference: brand.brandReference,
                      storeReference: store.storeReference,
                      effectiveFrom: parseCanonicalInstant(at),
                      effectiveUntil: null,
                    },
                  ]
                : [],
            });
            return { scope: selected, tenantContext, permission, validUntil: state.lease };
          },
        },
        facts: {
          async validateMaterial(actual, packet) {
            assert.equal(actual, tx);
            assert.equal(packet.version.status, "Recorded");
            assert.equal(packet.version.qualification, "NotEvaluated");
          },
        },
        references: { generate: reference },
        audit: {
          create({ mode, auditReference, command, materialReference, intentDigest, occurredAt }) {
            return {
              auditId: auditReference,
              brandId: selected.brandReference,
              storeId: selected.storeReference,
              actor: { type: "User", reference: selected.actorReference },
              actionCode:
                mode === "Abandon"
                  ? "PRICING_TAX_MATERIAL_RESOLVE"
                  : "PRICING_TAX_MATERIAL_" + command.action.toUpperCase(),
              targetType:
                mode === "Abandon" ? "PricingTaxMaterialOperation" : "PricingTaxConfigMaterial",
              targetId: mode === "Abandon" ? command.operationReference : materialReference,
              reasonCode: "AUTHORIZED_OPERATION",
              correlationId: command.operationReference,
              occurredAt,
              sourceChannel: "API",
              dataClassification: "Confidential",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
              afterSummary: { intentDigest },
            };
          },
        },
      });
      const result = await work(source, state, tx);
      if (after) await after(state, tx);
      assert.equal(hooks.length, 1);
      for (const hook of hooks) await hook.guard();
      for (const hook of hooks) hook.final();
      await client.query("COMMIT");
      assert(Date.parse(source.assertFinalized()) > Date.now());
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  };
  const at = new Date().toISOString();
  const initial = parseTaxConfigMaterialCommand({
    action: "CreateMaterial",
    operationReference: id(20),
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content: {
      operatingEntityProfileVersionReference: id(21),
      operatingEntityTaxReference: id(22),
      jurisdictionCode: "CA-ON",
      applicability: "Applicable",
      sourceIssuedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      declaredSourceDigest: null,
    },
  });
  const resolve = (command, selected = scope) => ({
    action: command.action,
    operationReference: command.operationReference,
    materialReference: command.materialReference,
    expectedRevision: command.expectedRevision,
    materialKind: command.materialKind,
    intentDigest: taxConfigMaterialIntentDigest(selected, command),
  });
  async function refusedUnchanged(work, predicate) {
    const before = await counts();
    await assert.rejects(work, predicate);
    assert.deepEqual(await counts(), before);
  }
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_pricing,platform_helpers,platform_audit,platform_eventing TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_pricing.tax_config_material_operation_available(platform_helpers.uuid_v7) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_pricing.tax_config_material,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_pricing.tax_config_material_version,rms_pricing.tax_config_material_operation,platform_audit.audit_record,platform_eventing.outbox_event TO " +
        role,
    );
    const first = await run((source) => source.execute(initial));
    assert.equal(first.outcome, "Committed");
    assert.equal(first.version.qualification, "NotEvaluated");
    assert.deepEqual(await run((source) => source.execute(initial)), first);
    assert.deepEqual(await run((source) => source.resolveOriginal(resolve(initial))), first);
    assert.deepEqual(await counts(), { roots: 1, versions: 1, originals: 1, audits: 1, events: 1 });
    const manager = { ...scope, actorReference: id(5) };
    const current = await run(
      (source) =>
        source.readCurrent({
          materialKind: initial.materialKind,
          materialReference: first.version.materialReference,
        }),
      { selected: manager },
    );
    assert.deepEqual(current.version, first.version);
    assert.equal(current.actorReference, manager.actorReference);
    const roster = await run((source) =>
      source.readRoster({ materialKind: initial.materialKind, afterMaterial: null }),
    );
    assert.equal(roster.entries.length, 1);
    assert.equal(Object.hasOwn(roster.entries[0], "content"), false);
    assert.equal(Object.hasOwn(roster.entries[0], "recordedByActorReference"), false);
    const replacement = parseTaxConfigMaterialCommand({
      ...initial,
      action: "ReplaceMaterial",
      operationReference: id(24),
      materialReference: first.version.materialReference,
      expectedRevision: 1,
      content: { ...initial.content, declaredSourceDigest: "sha256:" + "a".repeat(64) },
    });
    const second = await run((source) => source.execute(replacement), { selected: manager });
    assert.equal(second.version.revision, 2);
    assert.equal(second.version.previousVersionReference, first.version.versionReference);
    assert.equal(second.version.createdAt, first.version.createdAt);
    assert.deepEqual(await run((source) => source.resolveOriginal(resolve(initial))), first);
    const historical = await run((source) =>
      source.readVersion({
        materialKind: initial.materialKind,
        versionReference: first.version.versionReference,
      }),
    );
    assert.deepEqual(historical.version, first.version);
    await refusedUnchanged(
      () => run((source) => source.execute({ ...replacement, operationReference: id(25) })),
      (error) => error.code === "TAX_CONFIG_VERSION_CONFLICT",
    );
    await refusedUnchanged(
      () =>
        run((source) => source.execute(initial), {
          after: (state) => {
            state.allowed = false;
          },
        }),
      (error) => error.code === "TAX_CONFIG_PERMISSION_DENIED",
    );
    const lost = { ...initial, operationReference: id(26) };
    const abandoned = await run((source) => source.resolveOriginal(resolve(lost)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.version, null);
    const beforeLate = await counts();
    assert.deepEqual(await run((source) => source.execute(lost)), abandoned);
    assert.deepEqual(await counts(), beforeLate);
    const hidden = await raw(
      (tx) => tx.query("SELECT material_id FROM rms_pricing.tax_config_material"),
      {
        ...scope,
        storeReference: id(99),
      },
    );
    assert.equal(hidden.rows.length, 0);
    await admin.query("GRANT DELETE,TRUNCATE ON rms_pricing.tax_config_material TO " + role);
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_pricing.tax_config_material_version,rms_pricing.tax_config_material_operation TO " +
        role,
    );
    // TRUNCATE ... CASCADE checks privileges on every table that references these (including later
    // ones) before any trigger runs; grant them so the append-only trigger is what refuses.
    const cascaded = (
      await admin.query(
        "WITH RECURSIVE d(t) AS (SELECT unnest($1::regclass[]) UNION SELECT c.conrelid FROM pg_constraint c JOIN d ON c.confrelid=d.t WHERE c.contype='f') SELECT string_agg(DISTINCT t::text, ',') AS tables FROM d",
        [["rms_pricing.tax_config_material_version", "rms_pricing.tax_config_material_operation"]],
      )
    ).rows[0].tables;
    await admin.query("GRANT TRUNCATE ON " + cascaded + " TO " + role);
    for (const table of ["tax_config_material_version", "tax_config_material_operation"]) {
      // Adversarial test role deliberately has extra mutation privileges; triggers still refuse.
      for (const statement of [
        "UPDATE rms_pricing." + table + " SET data_classification=data_classification",
        "DELETE FROM rms_pricing." + table,
        "TRUNCATE rms_pricing." + table + " CASCADE",
      ])
        await refusedUnchanged(
          () => raw((tx) => tx.query(statement)),
          (error) => error.code === "55000",
        );
    }
    await refusedUnchanged(
      () =>
        raw(async (tx) => {
          await tx.query("UPDATE rms_pricing.tax_config_material SET revision=revision+1");
          await tx.query(flush);
        }),
      (error) => ["55000", "23503", "23514"].includes(error.code),
    );
  } finally {
    if (createdRole) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}

import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
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
import {
  parseTaxConfigAuthoringCommand,
  taxConfigAuthoringIntentDigest,
} from "../../rms/pricing/src/contracts/tax-config-authoring.ts";

const id = (n) => "01902421-1215-7000-8000-" + n.toString(16).padStart(12, "0");
const flush =
  "SET CONSTRAINTS rms_pricing.tax_config_version_original_coherence,rms_pricing.tax_config_authoring_terminal_coherence IMMEDIATE";
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Actual PostgreSQL/Tax/Audit/Eventing execution. Currency, scope, permission
 * evidence and reference eligibility below are explicitly controlled fixtures,
 * not persisted IAM, professional review, registration or Publish qualification. */
export async function verifyTaxConfigAuthoringSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_tax_author_" + context.runId;
  assert.match(role, /^wp2421_tax_author_[a-f0-9]+$/u);
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
        "SELECT (SELECT count(*)::int FROM rms_pricing.tax_configuration) roots,(SELECT count(*)::int FROM rms_pricing.tax_configuration_version) versions,(SELECT count(*)::int FROM rms_pricing.tax_configuration_rule) rules,(SELECT count(*)::int FROM rms_pricing.tax_configuration_operation_record) legacy,(SELECT count(*)::int FROM rms_pricing.tax_config_authoring_operation) originals,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
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
      const source = createPostgresTaxConfigAuthoringStore({
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
            assert.equal(request.purposeCode, "PRICING_TAX_CONFIG_AUTHORING");
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
            assert.equal(packet.snapshot.registrationEvidence, null);
          },
        },
        references: { generate: reference },
        audit: {
          create({
            mode,
            auditReference,
            command,
            configurationReference,
            intentDigest,
            occurredAt,
          }) {
            return {
              auditId: auditReference,
              brandId: selected.brandReference,
              storeId: selected.storeReference,
              actor: { type: "User", reference: selected.actorReference },
              actionCode:
                mode === "Abandon"
                  ? "PRICING_TAX_CONFIG_RESOLVE"
                  : "PRICING_TAX_CONFIG_" + command.action.toUpperCase(),
              targetType:
                mode === "Abandon" ? "PricingTaxAuthoringOperation" : "PricingTaxConfiguration",
              targetId: mode === "Abandon" ? command.operationReference : configurationReference,
              reasonCode: "AUTHORIZED_OPERATION",
              correlationId: command.operationReference,
              occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
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
  const command = (operation, overrides = {}) =>
    parseTaxConfigAuthoringCommand({
      action: "CreateDraft",
      operationReference: id(operation),
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
      ...overrides,
    });
  const resolve = (cmd, selected = scope) => ({
    action: cmd.action,
    operationReference: cmd.operationReference,
    configurationReference: cmd.configurationReference,
    expectedAggregateVersion: cmd.expectedAggregateVersion,
    intentDigest: taxConfigAuthoringIntentDigest(selected, cmd),
  });
  const rejectUnchanged = async (work, predicate) => {
    const before = await counts();
    await assert.rejects(work, predicate);
    assert.deepEqual(await counts(), before);
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_pricing,platform_helpers,platform_audit,platform_eventing TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_pricing.tax_config_authoring_operation_available(platform_helpers.uuid_v7) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule,rms_pricing.tax_configuration_operation_record,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON rms_pricing.tax_config_authoring_operation TO " +
        role,
    );
    const initial = command(20),
      first = await run((source) => source.execute(initial));
    assert.equal(first.outcome, "Committed");
    assert.equal(first.snapshot.lifecycle, "Draft");
    assert.deepEqual(await counts(), {
      roots: 1,
      versions: 1,
      rules: 1,
      legacy: 1,
      originals: 1,
      audits: 1,
      events: 1,
    });
    assert.deepEqual(await run((source) => source.execute(initial)), first);
    assert.deepEqual(await run((source) => source.resolve(resolve(initial))), first);
    await rejectUnchanged(
      () =>
        run((source) => source.resolve(resolve(initial, { ...scope, actorReference: id(5) })), {
          selected: { ...scope, actorReference: id(5) },
        }),
      (error) => error.code === "TAX_CONFIG_PERMISSION_DENIED",
    );
    const manager = { ...scope, actorReference: id(5) },
      replace = command(21, {
        action: "ReplaceDraft",
        configurationReference: first.snapshot.configurationReference,
        expectedAggregateVersion: 1,
        content: { ...initial.content, rules: [{ ...initial.content.rules[0], rate: "0.14" }] },
      });
    const second = await run((source) => source.execute(replace), { selected: manager });
    assert.equal(second.snapshot.aggregateVersion, 2);
    assert.notEqual(second.snapshot.versionReference, first.snapshot.versionReference);
    assert.deepEqual(await counts(), {
      roots: 1,
      versions: 2,
      rules: 2,
      legacy: 2,
      originals: 2,
      audits: 2,
      events: 2,
    });
    assert.deepEqual(
      await run((source) => source.execute(initial)),
      first,
      "Original replay must not require the old root to remain current",
    );
    const current = await run((source) =>
      source.readCurrent(first.snapshot.configurationReference),
    );
    assert.deepEqual(current.state.snapshot, second.snapshot);
    assert.equal(current.state.draftAuthorActorReference, manager.actorReference);
    const beforeHistory = await counts();
    const historicalRequest = {
      configurationReference: first.snapshot.configurationReference,
      versionReference: first.snapshot.versionReference,
    };
    const historical = await run((source) => source.readVersion(historicalRequest), {
      selected: manager,
    });
    assert.equal(historical.actorReference, manager.actorReference);
    assert.equal(historical.state.draftAuthorActorReference, scope.actorReference);
    assert.deepEqual(historical.state.snapshot, first.snapshot);
    assert.equal(historical.state.snapshot.rules[0].rate, "0.13");
    assert.equal(current.state.snapshot.rules[0].rate, "0.14");
    assert.equal(historical.referenceEligibility, "NotEvaluated");
    assert.deepEqual(await counts(), beforeHistory, "Historical reads must append no facts");
    for (const requested of [
      { ...historicalRequest, configurationReference: id(701) },
      { ...historicalRequest, versionReference: id(702) },
    ]) {
      await rejectUnchanged(
        () => run((source) => source.readVersion(requested), { selected: manager }),
        (error) => error.code === "TAX_CONFIG_VERSION_CONFLICT",
      );
    }
    await rejectUnchanged(
      () =>
        run((source) => source.readVersion(historicalRequest), {
          selected: manager,
          after(state) {
            state.allowed = false;
          },
        }),
      (error) => error.code === "TAX_CONFIG_PERMISSION_DENIED",
    );
    await rejectUnchanged(
      () =>
        run((source) => source.readVersion(historicalRequest), {
          selected: manager,
          after(state) {
            state.lease = new Date(Date.now() - 1).toISOString();
          },
        }),
      (error) => error.code === "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    );
    const roster = await run((source) => source.readRoster(null));
    assert.equal(roster.entries.length, 1);
    assert.equal(roster.nextAfterConfiguration, null);
    assert.deepEqual(roster.entries[0].snapshot, second.snapshot);
    assert.equal(
      (await run((source) => source.readRoster(second.snapshot.configurationReference))).entries
        .length,
      0,
    );
    const absent = command(22, { content: { ...initial.content, stableCode: "ABANDONED_TAX" } });
    const abandoned = await run((source) => source.resolve(resolve(absent)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.snapshot, null);
    assert.deepEqual(await run((source) => source.resolve(resolve(absent))), abandoned);
    assert.deepEqual(await counts(), {
      roots: 1,
      versions: 2,
      rules: 2,
      legacy: 2,
      originals: 3,
      audits: 3,
      events: 2,
    });
    const beforeLateExecute = await counts();
    assert.deepEqual(await run((source) => source.execute(absent)), abandoned);
    assert.deepEqual(await counts(), beforeLateExecute);
    await rejectUnchanged(
      () =>
        run((source) => source.execute({ ...replace, operationReference: id(23) }), {
          selected: manager,
        }),
      (error) => error.code === "TAX_CONFIG_VERSION_CONFLICT",
    );
    await rejectUnchanged(
      () =>
        run(
          (source) =>
            source.execute(
              command(24, { content: { ...initial.content, stableCode: "ROLLBACK_TAX" } }),
            ),
          {
            after: async () => {
              throw new Error("controlled outer rollback");
            },
          },
        ),
      /controlled outer rollback/u,
    );
    await rejectUnchanged(
      () =>
        run(
          (source) =>
            source.execute(
              command(25, { content: { ...initial.content, stableCode: "DENIED_TAX" } }),
            ),
          {
            after: async (state) => {
              state.allowed = false;
            },
          },
        ),
      (error) => error.code === "TAX_CONFIG_PERMISSION_DENIED",
    );
    await rejectUnchanged(
      () =>
        run((source) => source.readCurrent(first.snapshot.configurationReference), {
          after: async (state) => {
            state.lease = new Date(Date.now() - 1).toISOString();
          },
        }),
      (error) => error.code === "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    );
    for (const field of ["tenantReference", "brandReference", "storeReference"]) {
      const foreign = {
        ...scope,
        [field]: id(200 + ["tenantReference", "brandReference", "storeReference"].indexOf(field)),
      };
      await raw(async (client) => {
        assert.equal(
          (
            await client.query(
              "SELECT operation_id FROM rms_pricing.tax_config_authoring_operation",
            )
          ).rows.length,
          0,
        );
      }, foreign);
      await rejectUnchanged(
        () => run((source) => source.resolve(resolve(initial, foreign)), { selected: foreign }),
        (error) => error.code === "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
      );
    }
    // A real legacy record without a new original remains non-recoverable. No
    // historical author/audit is fabricated or backfilled into the new source.
    const legacyOperation = id(50);
    await raw(
      async (client) => {
        await client.query(
          "INSERT INTO rms_pricing.tax_configuration_operation_record(operation_id,tax_configuration_id,brand_id,store_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at) SELECT $1,tax_configuration_id,brand_id,store_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at FROM rms_pricing.tax_configuration_operation_record WHERE operation_id=$2",
          [legacyOperation, initial.operationReference],
        );
      },
      scope,
      true,
    );
    const legacyCommand = command(50);
    await rejectUnchanged(
      () => run((source) => source.resolve(resolve(legacyCommand))),
      (error) => error.code === "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    );
    const foreignBrand = { ...scope, brandReference: id(205) };
    await rejectUnchanged(
      () =>
        run((source) => source.resolve(resolve(legacyCommand, foreignBrand)), {
          selected: foreignBrand,
        }),
      (error) => error.code === "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    );
    for (const sql of [
      "UPDATE rms_pricing.tax_config_authoring_operation SET occurred_at=occurred_at",
      "DELETE FROM rms_pricing.tax_config_authoring_operation",
    ]) {
      await rejectUnchanged(
        () => raw((client) => client.query(sql)),
        (error) => error.code === "55000",
      );
    }
    await rejectUnchanged(
      () =>
        raw((client) =>
          client.query("TRUNCATE rms_pricing.tax_config_authoring_operation CASCADE"),
        ),
      (error) => error.code === "42501",
    );
    // The low role above is stopped by cascade ACLs. Separately reach the own
    // immutable trigger as the isolated database administrator, without grants.
    await rejectUnchanged(
      async () => {
        await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        try {
          await scoped(admin, scope);
          await admin.query("TRUNCATE rms_pricing.tax_config_authoring_operation CASCADE");
        } finally {
          await admin.query("ROLLBACK");
        }
      },
      (error) => error.code === "55000",
    );
    const abandonedRow = (
      await admin.query(
        "SELECT * FROM rms_pricing.tax_config_authoring_operation WHERE operation_id=$1",
        [absent.operationReference],
      )
    ).rows[0];
    const abandonedAudit = abandonedRow.audit_json;
    const cloneAbandoned = async (
      client,
      {
        op = id(60),
        receiptPatch = {},
        occurred = abandoned.occurredAt,
        resultRevision = null,
      } = {},
    ) => {
      const receipt = {
        ...copy(abandoned),
        operationReference: op,
        auditReference: id(600),
        ...receiptPatch,
      };
      const audit = { ...copy(abandonedAudit), auditId: id(600), correlationId: op, targetId: op };
      await client.query(
        "INSERT INTO rms_pricing.tax_config_authoring_operation(operation_id,tenant_id,brand_id,store_id,actor_id,action_code,requested_configuration_id,expected_aggregate_version,intent_digest,outcome,result_configuration_id,result_version_id,result_aggregate_version,service_intent_digest,service_input_json,receipt_json,receipt_digest,audit_id,audit_json,event_id,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20,$21,$22)",
        [
          op,
          abandonedRow.tenant_id,
          abandonedRow.brand_id,
          abandonedRow.store_id,
          abandonedRow.actor_id,
          abandonedRow.action_code,
          abandonedRow.requested_configuration_id,
          abandonedRow.expected_aggregate_version,
          abandonedRow.intent_digest,
          abandonedRow.outcome,
          abandonedRow.result_configuration_id,
          abandonedRow.result_version_id,
          resultRevision,
          abandonedRow.service_intent_digest,
          abandonedRow.service_input_json,
          JSON.stringify(receipt),
          "sha256:" + sha256Hex(canonicalizeRfc8785(receipt)),
          id(600),
          JSON.stringify(audit),
          abandonedRow.event_id,
          occurred,
          abandonedRow.data_classification,
        ],
      );
      await client.query(flush);
    };
    await rejectUnchanged(
      () => raw((client) => cloneAbandoned(client, { receiptPatch: { actorReference: id(601) } })),
      (error) => error.code === "23514",
    );
    await rejectUnchanged(
      () => raw((client) => cloneAbandoned(client, { receiptPatch: { injected: true } })),
      (error) => error.code === "23514",
    );
    await rejectUnchanged(
      () => raw((client) => cloneAbandoned(client, { resultRevision: 1 })),
      (error) => error.code === "23514",
    );
    await rejectUnchanged(
      () =>
        raw((client) =>
          cloneAbandoned(client, { occurred: abandoned.occurredAt.replace("Z", "001Z") }),
        ),
      (error) => error.code === "23514",
    );
    await rejectUnchanged(
      () => raw((client) => cloneAbandoned(client), { ...scope, storeReference: id(202) }),
      (error) => error.code === "42501",
    );
    for (const originalReference of [id(71), initial.operationReference])
      await rejectUnchanged(
        () =>
          raw(async (client) => {
            await client.query(
              "INSERT INTO rms_pricing.tax_configuration_version SELECT $1,tax_configuration_id,brand_id,store_id,3,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at,$2 FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=$3",
              [id(70), originalReference, first.snapshot.versionReference],
            );
            await client.query(flush);
          }),
        (error) => ["23514", "23503"].includes(error.code),
      );
    const finalCounts = await counts();
    assert.deepEqual(finalCounts, {
      roots: 1,
      versions: 2,
      rules: 2,
      legacy: 3,
      originals: 3,
      audits: 3,
      events: 2,
    });
    const audits = (
      await admin.query(
        "SELECT after_summary_json FROM platform_audit.audit_record ORDER BY occurred_at,audit_id",
      )
    ).rows;
    assert.equal(audits.length, 3);
    for (const row of audits)
      assert.deepEqual(Object.keys(row.after_summary_json), ["intentDigest"]);
  } finally {
    if (createdRole) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}

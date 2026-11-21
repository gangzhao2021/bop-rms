import assert from "node:assert/strict";
import pg from "pg";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import {
  createStoreConfigurationVersion,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
  parseStoreConfigurationOrdinaryReceipt,
  createPostgresStoreConfigurationOriginalStore,
  StoreConfigurationOriginalError,
} from "../../rms/store/src/index.ts";
const id = (n) => "01902421-1013-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (text) => "sha256:" + sha256Hex(text);
const digest = (value) => hash(canonicalizeRfc8785(value));
const fixed = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const historicalAt = "2026-10-05T10:00:00.000Z";
function configuration(overrides = {}) {
  return createStoreConfigurationVersion({
    configurationReference: id(10),
    brandReference: fixed.brandReference,
    storeReference: fixed.storeReference,
    configurationVersion: 1,
    lifecycle: "Draft",
    source: "StoreOverride",
    brandBaseVersionReference: id(11),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(12),
    contactReference: id(13),
    receiptReference: id(14),
    taxConfigurationReference: id(15),
    paymentConfigurationReference: id(16),
    capacityConfigurationReference: null,
    enabledServiceModes: ["Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
    exceptions: [],
    effectiveFrom: historicalAt,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(4),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    createdAt: historicalAt,
    updatedAt: historicalAt,
    dataClassification: "ConfigurationMetadata",
    ...overrides,
  });
}
const base = configuration();
const command = (operation, scope = fixed) =>
  parseStoreConfigurationOrdinaryCommand({
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope,
    operationReference: operation,
    action: "Validate",
    expectedHead: {
      configurationReference: base.configurationReference,
      configurationVersion: 1,
      contentDigest: digest(base),
    },
  });
const resolve = (c) =>
  parseStoreConfigurationOrdinaryResolve({
    ...c,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: digest(c),
  });
/** Real PG, public original source and Audit writer. Authority and full-config
 * qualification below are controlled inputs, not Session/IAM/Core/LiveGate proof. */
export async function verifyStoreConfigurationOriginal(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_store_original_" + context.runId;
  assert.match(role, /^wp2421_store_original_[a-f0-9]+$/u);
  await admin.connect();
  let roleCreated = false,
    serial = 1000;
  const next = () => id(++serial);
  const scoped = (client, scope = fixed) =>
    client.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [scope.tenantReference, scope.brandReference, scope.storeReference],
    );
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_store.store_configuration_original_operation) originals,(SELECT count(*)::int FROM rms_store.store_configuration_authoring_operation) legacy,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
      )
    ).rows[0];
  const raw = async (work, { scope = fixed, commit = false, privileged = false } = {}) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      if (!privileged) await admin.query("SET LOCAL ROLE " + role);
      await scoped(admin, scope);
      const value = await work(admin);
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return value;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const audit = async (tx, input) => {
    await scoped(tx, input);
    await appendAuditRecordInTransaction(tx, {
      auditId: input.auditReference,
      brandId: input.brandReference,
      storeId: input.storeReference,
      actor: { type: "User", reference: input.actorReference },
      actionCode: input.abandoned
        ? "STORE_CONFIGURATION_ORIGINAL_ABANDONED"
        : "STORE_CONFIGURATION_VALIDATE",
      targetType: "StoreConfigurationOriginal",
      targetId: input.operationReference,
      correlationId: input.operationReference,
      reasonCode: "AUTHORIZED_OPERATION",
      occurredAt: input.occurredAt,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
      afterSummary: { intentDigest: input.intentDigest },
    });
  };
  const legacyInsert = async (tx, c, input, result) => {
    await scoped(tx, c);
    const oldDigest = hash(
      JSON.stringify({
        command: "Validate",
        operationReference: input.operationReference,
        actorReference: input.actorReference,
        purposeCode: input.purposeCode,
        auditReference: input.auditReference,
        expectedVersion: input.expectedVersion,
        configuration: input.configuration,
      }),
    );
    await tx.query(
      "INSERT INTO rms_store.store_configuration_authoring_operation(operation_id,brand_id,store_id,sequence_number,configuration_id,configuration_version,command_type,lifecycle,expected_version,intent_digest,configuration_json,actor_reference,purpose_code,audit_reference,occurred_at,data_classification) SELECT $1,$2,$3,coalesce(max(sequence_number),0)+1,$4,$5,'Validate','Draft',$5,$6,$7::jsonb,$8,'STORE_CONFIGURATION',$9,$10,'ConfigurationMetadata' FROM rms_store.store_configuration_authoring_operation WHERE brand_id=$2::platform_helpers.uuid_v7 AND store_id=$3::platform_helpers.uuid_v7",
      [
        c.operationReference,
        c.brandReference,
        c.storeReference,
        result.configurationReference,
        result.configurationVersion,
        oldDigest,
        canonicalizeRfc8785(result),
        c.actorReference,
        input.auditReference,
        input.occurredAt,
      ],
    );
    return oldDigest;
  };
  const run = async (work, { scope = fixed, after = null, failAudit = false } = {}) => {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL statement_timeout='5s'");
      await scoped(client, scope);
      const observedAt = new Date().toISOString(),
        validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
        hooks = [];
      const tx = Object.freeze({ query: (sql, values) => client.query(sql, values) });
      const state = { allowed: true };
      const source = createPostgresStoreConfigurationOriginalStore({
        ...scope,
        transaction: tx,
        clock: { now: () => new Date().toISOString() },
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        registerBeforeCommit(actual, guard, final) {
          assert.equal(actual, tx);
          hooks.push({ guard, final });
        },
        authority: {
          async holdUntilTransactionCompletes(actual, request) {
            assert.equal(actual, tx);
            for (const [key, value] of Object.entries(scope)) assert.equal(request[key], value);
            assert.equal(request.purposeCode, "STORE_CONFIGURATION");
            if (!state.allowed)
              throw new StoreConfigurationOriginalError(
                "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
              );
            return { validUntil: request.validUntil };
          },
        },
        references: { canonicalize: canonicalizeRfc8785, hashIntent: hash, nextReference: next },
        appendAbandonedAudit: async (actual, input) => {
          await audit(actual, { ...input, abandoned: true });
          if (failAudit) throw new Error("Synthetic post-Audit failure");
        },
      });
      const result = await work({ source, tx, observedAt, state });
      if (after) await after({ source, tx, state });
      for (const hook of hooks) await hook.guard();
      for (const hook of hooks) hook.final();
      await client.query("COMMIT");
      assert(Date.parse(source.assertFinalized(tx)) > Date.now());
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  };
  const unchanged = async (work, predicate) => {
    const before = await counts();
    await assert.rejects(work, predicate);
    assert.deepEqual(await counts(), before);
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_store,platform_helpers,platform_audit TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_original_operation,platform_audit.audit_record TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    // Attack-only grants are isolated to this temporary role, never production ACL.
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_store.store_configuration_original_operation TO " + role,
    );
    const committedCommand = command(next());
    const committed = await run(async ({ source, tx, observedAt }) => {
      assert.equal(await source.readOriginal(committedCommand), null);
      const input = {
        operationReference: committedCommand.operationReference,
        actorReference: fixed.actorReference,
        purposeCode: "STORE_CONFIGURATION",
        auditReference: next(),
        expectedVersion: 1,
        occurredAt: observedAt,
        configuration: base,
      };
      const prepared = configuration({ updatedAt: observedAt });
      await audit(tx, { ...fixed, ...input, intentDigest: digest(committedCommand) });
      await legacyInsert(tx, committedCommand, input, prepared);
      const receipt = await source.recordCommitted(committedCommand, input);
      assert.equal(receipt.operation.configuration.updatedAt, observedAt);
      assert.notEqual(receipt.operation.configuration.updatedAt, input.configuration.updatedAt);
      assert.notEqual(receipt.intentDigest, receipt.operation.intentDigest);
      return receipt;
    });
    assert.deepEqual(await counts(), { originals: 1, legacy: 1, audits: 1 });
    assert.deepEqual(
      await run(({ source }) => source.resolve(resolve(committedCommand))),
      committed,
    );
    const abandonedCommand = command(next());
    const abandoned = await run(({ source }) => source.resolve(resolve(abandonedCommand)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.operation, null);
    assert.deepEqual(await run(({ source }) => source.readOriginal(abandonedCommand)), abandoned);
    assert.deepEqual(await counts(), { originals: 2, legacy: 1, audits: 2 });
    await unchanged(
      () =>
        raw(async (tx) => {
          const at = new Date().toISOString();
          await legacyInsert(
            tx,
            abandonedCommand,
            {
              operationReference: abandonedCommand.operationReference,
              actorReference: fixed.actorReference,
              purposeCode: "STORE_CONFIGURATION",
              auditReference: next(),
              expectedVersion: 1,
              occurredAt: at,
              configuration: base,
            },
            base,
          );
        }),
      (error) => error.code === "23514",
    );
    await unchanged(
      () => run(({ source }) => source.resolve(resolve(command(next()))), { failAudit: true }),
      (error) => error.code === "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    );
    await unchanged(
      () =>
        run(({ source }) => source.resolve(resolve(command(next()))), {
          after: ({ state }) => {
            state.allowed = false;
          },
        }),
      (error) => error.code === "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
    );
    const anotherActor = { ...fixed, actorReference: id(50) };
    await unchanged(
      () =>
        run(
          ({ source }) =>
            source.readOriginal(command(committedCommand.operationReference, anotherActor)),
          { scope: anotherActor },
        ),
      (error) => error.code === "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
    );
    const foreign = {
      ...fixed,
      tenantReference: id(51),
      brandReference: id(52),
      storeReference: id(53),
      actorReference: id(54),
    };
    for (const selected of [
      { ...fixed, tenantReference: foreign.tenantReference },
      { ...fixed, brandReference: foreign.brandReference },
      { ...fixed, storeReference: foreign.storeReference },
    ])
      await raw(
        async (tx) =>
          assert.equal(
            (await tx.query("SELECT * FROM rms_store.store_configuration_original_operation")).rows
              .length,
            0,
          ),
        { scope: selected },
      );
    await unchanged(
      () =>
        run(
          ({ source }) =>
            source.resolve(resolve(command(committedCommand.operationReference, foreign))),
          { scope: foreign },
        ),
      (error) => error.code === "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    );
    const stored = (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_original_operation WHERE operation_id=$1",
        [committedCommand.operationReference],
      )
    ).rows[0];
    assert(stored);
    const terminalInsert = async (tx, row) =>
      tx.query(
        "INSERT INTO rms_store.store_configuration_original_operation(operation_id,tenant_id,brand_id,store_id,actor_id,action_code,intent_digest,command_json,outcome,committed_operation_id,legacy_input_json,legacy_intent_digest,receipt_json,receipt_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17)",
        [
          row.operation_id,
          row.tenant_id,
          row.brand_id,
          row.store_id,
          row.actor_id,
          row.action_code,
          row.intent_digest,
          JSON.stringify(row.command_json),
          row.outcome,
          row.committed_operation_id,
          row.legacy_input_json === null ? null : JSON.stringify(row.legacy_input_json),
          row.legacy_intent_digest,
          JSON.stringify(row.receipt_json),
          row.receipt_digest,
          row.audit_reference,
          row.occurred_at,
          row.data_classification,
        ],
      );
    const foreignCommand = command(abandonedCommand.operationReference, foreign),
      foreignReceipt = parseStoreConfigurationOrdinaryReceipt({
        ...foreignCommand,
        profile: "StoreConfigurationOrdinaryReceiptV1",
        intentDigest: digest(foreignCommand),
        outcome: "Abandoned",
        operation: null,
        auditReference: next(),
        occurredAt: new Date().toISOString(),
        dataClassification: "ConfigurationMetadata",
      });
    const foreignTerminal = {
      operation_id: foreignCommand.operationReference,
      tenant_id: foreign.tenantReference,
      brand_id: foreign.brandReference,
      store_id: foreign.storeReference,
      actor_id: foreign.actorReference,
      action_code: "Validate",
      intent_digest: foreignReceipt.intentDigest,
      command_json: foreignCommand,
      outcome: "Abandoned",
      committed_operation_id: null,
      legacy_input_json: null,
      legacy_intent_digest: null,
      receipt_json: foreignReceipt,
      receipt_digest: digest(foreignReceipt),
      audit_reference: foreignReceipt.auditReference,
      occurred_at: foreignReceipt.occurredAt,
      data_classification: "ConfigurationMetadata",
    };
    await unchanged(
      () => raw((tx) => terminalInsert(tx, foreignTerminal), { scope: foreign }),
      (error) => error.code === "23505",
    );
    // Borrowing yesterday's real005 record cannot create a fresh Committed terminal.
    const oldOnly = command(next());
    await raw(
      async (tx) => {
        const occurredAt = new Date().toISOString();
        await legacyInsert(
          tx,
          oldOnly,
          {
            operationReference: oldOnly.operationReference,
            actorReference: fixed.actorReference,
            purposeCode: "STORE_CONFIGURATION",
            auditReference: next(),
            expectedVersion: 1,
            occurredAt,
            configuration: base,
          },
          base,
        );
      },
      { commit: true },
    );
    await unchanged(
      () => run(({ source }) => source.resolve(resolve(oldOnly))),
      (error) => error.code === "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
    );
    const oldRow = (
      await admin.query(
        "SELECT * FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
        [oldOnly.operationReference],
      )
    ).rows[0];
    assert(oldRow);
    const borrowed = {
      ...stored,
      operation_id: oldOnly.operationReference,
      committed_operation_id: oldOnly.operationReference,
      audit_reference: oldRow.audit_reference,
      occurred_at: oldRow.occurred_at,
      legacy_intent_digest: oldRow.intent_digest,
      command_json: oldOnly,
      legacy_input_json: {
        ...stored.legacy_input_json,
        operationReference: oldOnly.operationReference,
        auditReference: oldRow.audit_reference,
      },
      receipt_json: {
        ...committed,
        operationReference: oldOnly.operationReference,
        intentDigest: digest(oldOnly),
        auditReference: oldRow.audit_reference,
        occurredAt: oldRow.occurred_at.toISOString(),
        operation: {
          ...committed.operation,
          operationReference: oldOnly.operationReference,
          intentDigest: oldRow.intent_digest,
          configuration: base,
        },
      },
      intent_digest: digest(oldOnly),
    };
    borrowed.receipt_digest = digest(borrowed.receipt_json);
    await unchanged(
      () => raw((tx) => terminalInsert(tx, borrowed)),
      (error) => error.code === "23514",
    );
    // Each attack starts from a genuinely same-TX 005 row, so old-xmin cannot
    // conceal the specific changed scope, receipt, clock or terminal guard.
    const rawFresh = async (mutate) =>
      raw(async (tx) => {
        const c = command(next()),
          occurredAt = new Date().toISOString(),
          auditReference = next();
        const input = {
          operationReference: c.operationReference,
          actorReference: fixed.actorReference,
          purposeCode: "STORE_CONFIGURATION",
          auditReference,
          expectedVersion: 1,
          occurredAt,
          configuration: base,
        };
        const legacyDigest = await legacyInsert(tx, c, input, base);
        const receipt = parseStoreConfigurationOrdinaryReceipt({
          ...c,
          profile: "StoreConfigurationOrdinaryReceiptV1",
          intentDigest: digest(c),
          outcome: "Committed",
          operation: {
            command: "Validate",
            operationReference: c.operationReference,
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            intentDigest: legacyDigest,
            resultingVersion: 1,
            configuration: base,
          },
          auditReference,
          occurredAt,
          dataClassification: "ConfigurationMetadata",
        });
        const row = {
          operation_id: c.operationReference,
          tenant_id: fixed.tenantReference,
          brand_id: fixed.brandReference,
          store_id: fixed.storeReference,
          actor_id: fixed.actorReference,
          action_code: "Validate",
          intent_digest: receipt.intentDigest,
          command_json: c,
          outcome: "Committed",
          committed_operation_id: c.operationReference,
          legacy_input_json: {
            command: "Validate",
            operationReference: c.operationReference,
            actorReference: fixed.actorReference,
            purposeCode: "STORE_CONFIGURATION",
            auditReference,
            expectedVersion: 1,
            configuration: base,
          },
          legacy_intent_digest: legacyDigest,
          receipt_json: receipt,
          receipt_digest: digest(receipt),
          audit_reference: auditReference,
          occurred_at: occurredAt,
          data_classification: "ConfigurationMetadata",
        };
        await terminalInsert(tx, mutate(row));
      });
    for (const mutate of [
      (row) => ({ ...row, tenant_id: id(60) }),
      (row) => ({ ...row, actor_id: id(61) }),
      (row) => ({ ...row, occurred_at: row.occurred_at.replace("Z", "1Z") }),
      (row) => ({ ...row, receipt_json: { ...row.receipt_json, permission: true } }),
      (row) => ({ ...row, legacy_intent_digest: hash("wrong original") }),
      (row) => ({
        ...row,
        outcome: "Abandoned",
        committed_operation_id: null,
        legacy_input_json: null,
        legacy_intent_digest: null,
        receipt_json: { ...row.receipt_json, outcome: "Abandoned", operation: null },
      }),
    ])
      await unchanged(
        () => rawFresh(mutate),
        (error) => ["23514", "42501"].includes(error.code),
      );
    for (const statement of [
      "UPDATE rms_store.store_configuration_original_operation SET intent_digest=intent_digest",
      "DELETE FROM rms_store.store_configuration_original_operation",
      "TRUNCATE rms_store.store_configuration_original_operation",
    ])
      await unchanged(
        () => raw((tx) => tx.query(statement)),
        (error) => error.code === "55000",
      );
    // Contending legacy writer must fail nonblocking, preserving lock-order safety.
    const holder = new pg.Client(context.clientConfig);
    await holder.connect();
    const conflict = command(next());
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "StoreConfigurationOriginal:" + conflict.operationReference,
      ]);
      await unchanged(
        () =>
          raw((tx) =>
            legacyInsert(
              tx,
              conflict,
              {
                operationReference: conflict.operationReference,
                actorReference: fixed.actorReference,
                purposeCode: "STORE_CONFIGURATION",
                auditReference: next(),
                expectedVersion: 1,
                occurredAt: new Date().toISOString(),
                configuration: base,
              },
              base,
            ),
          ),
        (error) => error.code === "55P03",
      );
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    const summaries = (
      await admin.query(
        "SELECT after_summary_json FROM platform_audit.audit_record WHERE brand_id=$1 ORDER BY occurred_at,audit_id",
        [fixed.brandReference],
      )
    ).rows;
    assert.equal(summaries.length, 2);
    for (const row of summaries)
      assert.deepEqual(Object.keys(row.after_summary_json), ["intentDigest"]);
    assert.deepEqual(await counts(), { originals: 2, legacy: 2, audits: 2 });
  } finally {
    if (roleCreated) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}

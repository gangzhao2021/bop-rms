import assert from "node:assert/strict";
import pg from "pg";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { createPostgresBrandConfigurationAuthoringStore } from "../../bop/tenant/src/infrastructure/persistence/brand-configuration-authoring-store.ts";
import { createBrandConfigurationVersion } from "../../bop/tenant/src/contracts/brand-administration.ts";
import {
  BrandConfigurationOperationError,
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  brandConfigurationOperationRequiredFields,
} from "../../bop/tenant/src/contracts/brand-configuration-operation.ts";

const id = (n) => `01902504-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z";
const syntheticReviewValidUntil = "2026-10-06T11:00:00.000Z";
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const fields = () => ({
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(4),
  platformTemplateReference: id(5),
  overrideAllowedFieldCodes: [],
  hardRequirementFieldCodes: [],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "SYNTHETIC_CONFIGURATION",
});
const head = (receipt) => {
  assert.ok(receipt.snapshot);
  return {
    revision: receipt.snapshot.revision,
    configurationVersionReference: receipt.snapshot.configuration.configurationVersionReference,
    sourceDigest: receipt.snapshot.sourceDigest,
  };
};
const command = (
  operation,
  expectedHead = null,
  actorReference = scope.actorReference,
  action = "SaveConfigurationDraft",
  configuration = fields(),
) =>
  parseBrandConfigurationCommand({
    profile: "TenantBrandConfigurationCommandV1",
    ...scope,
    actorReference,
    command: action,
    operationReference: id(operation),
    expectedBrandVersion: 1,
    expectedHead,
    purposeCode: "BRAND_CONFIGURATION",
    configuration: action === "SaveConfigurationDraft" ? configuration : null,
    reviewValidUntil: action === "SubmitConfiguration" ? syntheticReviewValidUntil : null,
  });
const resolve = (input) => {
  const { configuration, reviewValidUntil, ...identity } = input;
  void configuration;
  void reviewValidUntil;
  return parseBrandConfigurationResolve({
    ...identity,
    profile: "TenantBrandConfigurationResolveV1",
    intentDigest: hash(input),
  });
};

/** Genuine owning PostgreSQL persistence and public Audit acceptance. Authority,
 * references and Core preparation are explicitly controlled synthetic component
 * ports; this is not ordinary Session/IAM or Publishing qualification evidence. */
export async function exerciseBrandConfigurationAuthoringPersistence(context) {
  const admin = new pg.Client(context.clientConfig);
  const role = `brand_config_${context.runId}`;
  let allocated = 1000;
  let clockMs = Date.parse(at);
  let allowed = true;
  let prepareCalls = 0;
  let auditCalls = 0;
  let failAudit = false;
  let withdrawAtGuard = false;
  let lateExpiry = false;
  await admin.connect();
  try {
    await admin.query(
      "INSERT INTO bop_tenant.brand VALUES($1,'CONFIG_BRAND','Synthetic configuration Brand','en-CA','CAD','Active',1,$2,$2)",
      [scope.brandReference, at],
    );
    const legacy = createBrandConfigurationVersion({
      ...fields(),
      configurationVersionReference: id(10),
      brandReference: scope.brandReference,
      configurationVersion: 1,
      lifecycle: "Published",
      supersedesVersionReference: null,
      authoredByReference: id(20),
      approvedByReference: id(21),
      approvalEvidenceReference: id(22),
      publicationReference: id(23),
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    });
    const legacyKeys = [
      "configuration_version_id",
      "brand_id",
      "configuration_version",
      "lifecycle",
      "default_locale",
      "supported_locales",
      "media_theme_reference",
      "catalog_source_reference",
      "platform_template_reference",
      "override_allowed_field_codes",
      "hard_requirement_field_codes",
      "effective_from",
      "effective_until",
      "supersedes_version_reference",
      "reason_code",
      "authored_by_reference",
      "approved_by_reference",
      "approval_evidence_reference",
      "publication_reference",
      "created_at",
      "updated_at",
      "data_classification",
    ];
    const configurationValues = (c) => [
      c.configurationVersionReference,
      c.brandReference,
      c.configurationVersion,
      c.lifecycle,
      c.defaultLocale,
      c.supportedLocales,
      c.mediaThemeReference,
      c.catalogSourceReference,
      c.platformTemplateReference,
      c.overrideAllowedFieldCodes,
      c.hardRequirementFieldCodes,
      c.effectiveFrom,
      c.effectiveUntil,
      c.supersedesVersionReference,
      c.reasonCode,
      c.authoredByReference,
      c.approvedByReference,
      c.approvalEvidenceReference,
      c.publicationReference,
      c.createdAt,
      c.updatedAt,
      c.dataClassification,
    ];
    const materializeSql = `INSERT INTO bop_tenant.brand_configuration_version(${legacyKeys.join(",")}) VALUES(${legacyKeys.map((_, i) => "$" + (i + 1)).join(",")})`;
    await admin.query(materializeSql, configurationValues(legacy));
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(
      `GRANT USAGE ON SCHEMA bop_tenant,platform_helpers,platform_audit TO ${role}`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT,INSERT ON bop_tenant.brand_configuration_authoring_revision,bop_tenant.brand_configuration_authoring_operation,bop_tenant.brand_configuration_version TO ${role}`,
    );
    await admin.query(`GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_revision) revisions,(SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_operation) operations,(SELECT count(*)::int FROM bop_tenant.brand_configuration_version) published,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
        )
      ).rows[0];
    const audit = async (tx, input) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [scope.brandReference],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: input.auditReference,
        brandId: scope.brandReference,
        actor: { type: "User", reference: input.actorReference },
        actionCode:
          input.mode === "Abandon"
            ? "BRAND_CONFIGURATION_ORIGINAL_ABANDONED"
            : "BRAND_CONFIGURATION_RECORDED",
        targetType: "BrandConfiguration",
        targetId: input.configurationVersionReference ?? scope.brandReference,
        correlationId: input.operationReference,
        reasonCode: "BRAND_CONFIGURATION",
        occurredAt: input.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
        afterSummary: { intentDigest: input.intentDigest },
      });
      auditCalls++;
      if (failAudit) throw new Error("Synthetic Audit transport failure");
    };
    async function run(work, actorReference = scope.actorReference, controls = {}) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      clockMs += 10;
      const origin = clockMs;
      const started = Date.now();
      const observedAt = new Date(origin).toISOString();
      const validUntil = new Date(origin + 5000).toISOString();
      const clock = {
        now: () =>
          new Date(lateExpiry ? origin + 5000 : origin + Date.now() - started).toISOString(),
      };
      const guards = [],
        finals = [];
      let committed = false;
      const tx = {
        query: async (sql, values) => {
          if (
            controls.capture &&
            sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_")
          )
            controls.capture.push({ sql, values: [...values] });
          try {
            if (
              controls.revisionOnly &&
              sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_operation")
            )
              await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            return await client.query(sql, [...values]);
          } catch (error) {
            if (
              controls.sqlStates &&
              typeof error.code === "string" &&
              /^[0-9A-Z]{5}$/u.test(error.code)
            )
              controls.sqlStates.push(error.code);
            throw error;
          }
        },
      };
      const source = createPostgresBrandConfigurationAuthoringStore({
        ...scope,
        actorReference,
        transaction: tx,
        clock,
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        registerBeforeCommit: async (actual, guard, final) => {
          assert.equal(actual, tx);
          guards.push(guard);
          finals.push(final);
        },
        authority: {
          holdUntilTransactionCompletes: async (actual, request) => {
            assert.equal(actual, tx);
            assert.equal(request.tenantReference, scope.tenantReference);
            assert.equal(request.brandReference, scope.brandReference);
            assert.equal(request.actorReference, actorReference);
            assert.equal(request.permission, "organization.manage");
            assert.equal(request.purposeCode, "BRAND_CONFIGURATION");
            assert.deepEqual(request.requiredFields, brandConfigurationOperationRequiredFields);
            if (!allowed)
              throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_PERMISSION_DENIED");
            return { validUntil: request.validUntil };
          },
        },
        references: {
          canonicalize: canonicalizeRfc8785,
          hashIntent: (text) => "sha256:" + sha256Hex(text),
          nextReference: (kind) => {
            assert.ok(["ConfigurationVersion", "Audit"].includes(kind));
            return id(allocated++);
          },
        },
        appendAudit: async (actual, input) => {
          assert.equal(actual, tx);
          controls.auditInputs?.push(input);
          await audit(actual, input);
        },
        prepareFresh: async (actual, input) => {
          assert.equal(actual, tx);
          prepareCalls++;
          const occurredAt = clock.now();
          if (input.command.command === "SaveConfigurationDraft")
            return {
              configuration: createBrandConfigurationVersion({
                ...input.configuration,
                updatedAt: occurredAt,
              }),
              submittedByReference: null,
              publishing: null,
              occurredAt,
            };
          assert.ok(input.current);
          const action = input.command.command;
          const previous = input.current;
          const publishing = {
            familyReference: previous.publishing?.familyReference ?? id(100),
            lifecycleReference: previous.publishing?.lifecycleReference ?? id(101),
            lifecycleVersion: (previous.publishing?.lifecycleVersion ?? 1) + 1,
            mutationOperationReference: input.command.operationReference,
            validationEvidenceReference:
              previous.publishing?.validationEvidenceReference ?? id(102),
            approvalEvidenceReference:
              action === "SubmitConfiguration"
                ? null
                : (previous.publishing?.approvalEvidenceReference ?? id(103)),
            publicationReference: action === "PublishConfiguration" ? id(104) : null,
          };
          return {
            configuration: createBrandConfigurationVersion({
              ...input.configuration,
              lifecycle:
                action === "SubmitConfiguration"
                  ? "PendingApproval"
                  : action === "ApproveConfiguration"
                    ? "Approved"
                    : "Published",
              approvedByReference:
                action === "SubmitConfiguration"
                  ? null
                  : (input.configuration.approvedByReference ?? actorReference),
              approvalEvidenceReference: publishing.approvalEvidenceReference,
              publicationReference: publishing.publicationReference,
              updatedAt: occurredAt,
            }),
            submittedByReference:
              action === "SubmitConfiguration" ? actorReference : previous.submittedByReference,
            publishing,
            occurredAt,
          };
        },
      });
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [scope.tenantReference, scope.brandReference],
        );
        const result = await work(source, tx, clock);
        if (withdrawAtGuard) allowed = false;
        for (const guard of guards) await guard();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        // Production sourceHost seals all current leases synchronously after
        // asynchronous checks, before returning work to the COMMIT owner.
        for (const final of finals) final();
        await client.query("COMMIT");
        committed = true;
        controls.phases?.push("Committed");
        source.assertFinalized();
        controls.phases?.push("Finalized");
        if (controls.failAfterCommit) throw new Error("Synthetic post-COMMIT reply failure");
        return result;
      } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
      } finally {
        clockMs = Math.max(clockMs, Date.parse(clock.now()));
        await client.end();
      }
    }
    const initial = await counts();
    assert.equal((await run((source) => source.readCurrent())).current, null);
    const firstCommand = command(200);
    const first = await run(async (source) => {
      const result = await source.execute(firstCommand);
      const contender = new pg.Client(context.clientConfig);
      await contender.connect();
      try {
        await contender.query("BEGIN");
        const original = await contender.query(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) held",
          ["BrandConfigurationOriginal:" + firstCommand.operationReference],
        );
        const admission = await contender.query(
          "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) held",
          [`BrandConfigurationSource:${scope.tenantReference}:${scope.brandReference}`],
        );
        assert.equal(original.rows[0].held, false);
        assert.equal(admission.rows[0].held, false);
      } finally {
        await contender.query("ROLLBACK");
        await contender.end();
      }
      return result;
    });
    assert.equal(first.snapshot.revision, 1);
    assert.equal(first.snapshot.configuration.configurationVersion, 2);
    assert.equal(
      first.snapshot.configuration.supersedesVersionReference,
      legacy.configurationVersionReference,
    );
    assert.equal(first.snapshot.configuration.lifecycle, "Draft");
    assert.equal(first.outcome, "Committed");
    assert.deepEqual(await counts(), {
      revisions: initial.revisions + 1,
      operations: initial.operations + 1,
      published: initial.published,
      audits: initial.audits + 1,
    });
    const replayCounts = await counts();
    const replayPreparation = prepareCalls,
      replayAllocations = allocated;
    assert.deepEqual(await run((source) => source.execute(firstCommand)), first);
    assert.deepEqual(await run((source) => source.resolve(resolve(firstCommand))), first);
    assert.deepEqual(await run((source) => source.readOriginal(resolve(firstCommand))), first);
    assert.equal(prepareCalls, replayPreparation);
    assert.equal(allocated, replayAllocations);
    assert.deepEqual(await counts(), replayCounts);
    await assert.rejects(
      run((source) =>
        source.execute(
          command(200, null, scope.actorReference, "SaveConfigurationDraft", {
            ...fields(),
            reasonCode: "CHANGED",
          }),
        ),
      ),
      { code: "BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT" },
    );
    await assert.rejects(
      run((source) => source.resolve({ ...resolve(firstCommand), actorReference: id(6) }), id(6)),
      { code: "BRAND_CONFIGURATION_PERMISSION_DENIED" },
    );
    assert.deepEqual(await counts(), replayCounts);
    const current = await run((source) => source.readCurrent(), id(6));
    assert.equal(current.actorReference, id(6));
    assert.equal(current.current.actorReference, scope.actorReference);
    assert.deepEqual(current.current, first.snapshot);
    const submitCommand = command(201, head(first), id(7), "SubmitConfiguration");
    const submitted = await run((source) => source.execute(submitCommand), id(7));
    assert.equal(submitted.snapshot.submittedByReference, id(7));
    await assert.rejects(
      run(
        (source) => source.execute(command(202, head(submitted), id(7), "ApproveConfiguration")),
        id(7),
      ),
      { code: "BRAND_CONFIGURATION_PERMISSION_DENIED" },
    );
    await assert.rejects(
      run((source) =>
        source.execute(command(203, head(submitted), scope.actorReference, "ApproveConfiguration")),
      ),
      { code: "BRAND_CONFIGURATION_PERMISSION_DENIED" },
    );
    const approved = await run(
      (source) => source.execute(command(204, head(submitted), id(8), "ApproveConfiguration")),
      id(8),
    );
    const beforePublication = await counts();
    const publicationCaptured = [],
      publicationAudits = [];
    await assert.rejects(
      run(
        async (source) => {
          await source.execute(command(213, head(approved), id(8), "PublishConfiguration"));
          throw new Error("Synthetic rollback after actual publication append");
        },
        id(8),
        { capture: publicationCaptured, auditInputs: publicationAudits },
      ),
      /Synthetic rollback after actual publication append/u,
    );
    assert.deepEqual(await counts(), beforePublication);
    assert.equal(publicationAudits.length, 1);
    assert.equal(publicationCaptured.length, 2);
    // Omit only the already rolled-back legacy materialization when replaying
    // genuine owning INSERTs. Deferred Publish coherence must reject both rows.
    await assert.rejects(
      raw(async (tx) => {
        await audit(tx, publicationAudits[0]);
        for (const entry of publicationCaptured) await tx.query(entry.sql, entry.values);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE", []);
      }),
      (error) => error.code === "23514",
    );
    assert.deepEqual(await counts(), beforePublication);
    const publishCommand = command(205, head(approved), id(8), "PublishConfiguration");
    const published = await run((source) => source.execute(publishCommand), id(8));
    assert.equal(published.snapshot.configuration.lifecycle, "Published");
    const stored = (
      await admin.query(
        "SELECT configuration_version::text version,configuration_version_id,approved_by_reference,publication_reference FROM bop_tenant.brand_configuration_version WHERE brand_id=$1 ORDER BY configuration_version DESC",
        [scope.brandReference],
      )
    ).rows;
    assert.equal(stored.length, 2);
    assert.equal(stored[0].version, "2");
    assert.equal(
      stored[0].configuration_version_id,
      first.snapshot.configuration.configurationVersionReference,
    );
    assert.equal(stored[0].approved_by_reference, id(8));
    assert.equal(stored[0].publication_reference, id(104));
    const pages = await run(
      async (source) => ({
        first: await source.readHistory({ beforeRevision: null }),
        second: await source.readHistory({ beforeRevision: 3 }),
      }),
      id(6),
    );
    assert.deepEqual(
      pages.first.entries.map((entry) => entry.revision),
      [4, 3],
    );
    assert.equal(pages.first.nextBeforeRevision, 3);
    assert.deepEqual(
      pages.second.entries.map((entry) => entry.revision),
      [2, 1],
    );
    assert.equal(pages.second.nextBeforeRevision, null);
    assert.equal(pages.first.actorReference, id(6));
    const abandonedCommand = command(206, head(published));
    const beforeAbandon = await counts();
    const abandoned = await run((source) => source.resolve(resolve(abandonedCommand)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.snapshot, null);
    const beforeLate = await counts(),
      callsBeforeLate = prepareCalls,
      allocationsBeforeLate = allocated;
    assert.deepEqual(await run((source) => source.execute(abandonedCommand)), abandoned);
    assert.deepEqual(await run((source) => source.resolve(resolve(abandonedCommand))), abandoned);
    assert.deepEqual(await counts(), beforeLate);
    assert.equal(prepareCalls, callsBeforeLate);
    assert.equal(allocated, allocationsBeforeLate);
    assert.deepEqual(beforeLate, {
      ...beforeAbandon,
      operations: beforeAbandon.operations + 1,
      audits: beforeAbandon.audits + 1,
    });
    const stable = await counts();
    const beforeConflictAllocations = allocated,
      beforeConflictPreparation = prepareCalls;
    await assert.rejects(
      run((source) => source.execute(command(214, head(first)))),
      { code: "BRAND_CONFIGURATION_VERSION_CONFLICT" },
    );
    await assert.rejects(
      run((source) =>
        source.execute({ ...command(215, head(published)), expectedBrandVersion: 2 }),
      ),
      { code: "BRAND_CONFIGURATION_VERSION_CONFLICT" },
    );
    assert.equal(allocated, beforeConflictAllocations);
    assert.equal(prepareCalls, beforeConflictPreparation);
    assert.deepEqual(await counts(), stable);
    withdrawAtGuard = true;
    await assert.rejects(
      run((source) => source.execute(command(207, head(published)))),
      { code: "BRAND_CONFIGURATION_PERMISSION_DENIED" },
    );
    withdrawAtGuard = false;
    allowed = true;
    assert.deepEqual(await counts(), stable);
    failAudit = true;
    await assert.rejects(
      run((source) => source.execute(command(208, head(published)))),
      { code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE" },
    );
    failAudit = false;
    assert.deepEqual(await counts(), stable);
    await assert.rejects(
      run(async (source) => {
        await source.execute(command(209, head(published)));
        lateExpiry = true;
      }),
      { code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE" },
    );
    lateExpiry = false;
    assert.deepEqual(await counts(), stable);
    // A genuine revision exists in this transaction when its missing terminal
    // is checked. PostgreSQL deferred coherence must reject and roll it back.
    const standaloneSqlStates = [];
    await assert.rejects(
      run((source) => source.execute(command(210, head(published))), scope.actorReference, {
        revisionOnly: true,
        sqlStates: standaloneSqlStates,
      }),
      { code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE" },
    );
    assert.equal(standaloneSqlStates.length, 1);
    assert.ok(["23503", "23514"].includes(standaloneSqlStates[0]));
    assert.deepEqual(await counts(), stable);
    // Capture a genuine fresh owner append in a transaction then roll it back;
    // replay only its original terminal INSERT to test the reverse SQL relation.
    const captured = [],
      auditInputs = [];
    await assert.rejects(
      run(
        async (source) => {
          await source.execute(command(211, head(published)));
          throw new Error("Synthetic rollback after actual append");
        },
        scope.actorReference,
        { capture: captured, auditInputs },
      ),
      /Synthetic rollback after actual append/u,
    );
    const terminal = captured.find((entry) =>
      entry.sql.startsWith("INSERT INTO bop_tenant.brand_configuration_authoring_operation"),
    );
    assert.ok(terminal);
    assert.equal(auditInputs.length, 1);
    async function raw(work) {
      await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [scope.tenantReference, scope.brandReference],
        );
        return await work({ query: (sql, values) => admin.query(sql, [...values]) });
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await assert.rejects(
      raw(async (tx) => {
        await audit(tx, auditInputs[0]);
        await tx.query(terminal.sql, terminal.values);
        await tx.query("SET CONSTRAINTS ALL IMMEDIATE", []);
      }),
      (error) => ["23503", "23514"].includes(error.code),
    );
    assert.deepEqual(await counts(), stable);
    await raw(async (tx) => {
      for (const [tenant, brand, store] of [
        [id(99), scope.brandReference, ""],
        [scope.tenantReference, id(99), ""],
        [scope.tenantReference, scope.brandReference, id(9)],
      ]) {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        assert.equal(
          (await tx.query("SELECT * FROM bop_tenant.brand_configuration_authoring_revision", []))
            .rowCount,
          0,
        );
        assert.equal(
          (await tx.query("SELECT * FROM bop_tenant.brand_configuration_authoring_operation", []))
            .rowCount,
          0,
        );
      }
    });
    // A malformed legacy timestamp is inserted in the same actual owning
    // transaction. No history trigger is disabled or existing row rewritten.
    await assert.rejects(
      run(async (source, tx, clock) => {
        const precision = createBrandConfigurationVersion({
          ...published.snapshot.configuration,
          configurationVersionReference: id(300),
          configurationVersion: 3,
          supersedesVersionReference:
            published.snapshot.configuration.configurationVersionReference,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const values = configurationValues(precision);
        values[20] = precision.updatedAt.replace("Z", "001Z");
        await tx.query(materializeSql, values);
        await source.execute(command(212, head(published)));
      }),
      { code: "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE" },
    );
    assert.deepEqual(await counts(), stable);
    // Ordinary role lacks mutation privileges; owning append-only guards are
    // separately exercised as the isolated administrator, without granting them.
    for (const table of [
      "brand_configuration_authoring_revision",
      "brand_configuration_authoring_operation",
    ]) {
      await assert.rejects(
        admin.query(`UPDATE bop_tenant.${table} SET data_classification='ConfigurationMetadata'`),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        admin.query(`DELETE FROM bop_tenant.${table}`),
        (error) => error.code === "55000",
      );
    }
    await assert.rejects(
      admin.query(
        "TRUNCATE bop_tenant.brand_configuration_authoring_revision,bop_tenant.brand_configuration_authoring_operation",
      ),
      (error) => error.code === "55000",
    );
    assert.deepEqual(await counts(), stable);
    const postCommitCommand = command(220, head(published));
    const phases = [];
    await assert.rejects(
      run((source) => source.execute(postCommitCommand), scope.actorReference, {
        phases,
        failAfterCommit: true,
      }),
      /Synthetic post-COMMIT reply failure/u,
    );
    assert.deepEqual(phases, ["Committed", "Finalized"]);
    const committedCounts = await counts();
    assert.deepEqual(committedCounts, {
      ...stable,
      revisions: stable.revisions + 1,
      operations: stable.operations + 1,
      audits: stable.audits + 1,
    });
    const recoveryCalls = prepareCalls,
      recoveryAllocations = allocated;
    const recovered = await run((source) => source.resolve(resolve(postCommitCommand)));
    assert.equal(recovered.outcome, "Committed");
    assert.deepEqual(recovered.originalCommand, postCommitCommand);
    assert.equal(recovered.snapshot.revision, 5);
    assert.equal(prepareCalls, recoveryCalls);
    assert.equal(allocated, recoveryAllocations);
    assert.deepEqual(await counts(), committedCounts);
    // Advance only between independent requests. The original Submit is both
    // expired and superseded; recovery must retain its actual old receipt,
    // without fresh qualification, CAS, allocation or business-period renewal.
    clockMs = Math.max(clockMs, Date.parse(syntheticReviewValidUntil) + 1);
    const expiredReplayPreparation = prepareCalls,
      expiredReplayAllocations = allocated;
    assert.deepEqual(await run((source) => source.execute(submitCommand), id(7)), submitted);
    assert.deepEqual(
      await run((source) => source.resolve(resolve(submitCommand)), id(7)),
      submitted,
    );
    assert.equal(prepareCalls, expiredReplayPreparation);
    assert.equal(allocated, expiredReplayAllocations);
    assert.deepEqual(await counts(), committedCounts);
    assert.ok(auditCalls > 0);
  } finally {
    try {
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    } finally {
      await admin.end();
    }
  }
}

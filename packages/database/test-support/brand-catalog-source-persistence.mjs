import assert from "node:assert/strict";
import pg from "pg";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { CatalogError } from "../../rms/catalog/src/contracts/product.ts";
import {
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceRegister,
} from "../../rms/catalog/src/contracts/brand-catalog-source.ts";
import {
  createPostgresBrandCatalogSourceStore,
  brandCatalogSourceRequiredFields,
} from "../../rms/catalog/src/infrastructure/persistence/brand-catalog-source-store.ts";

const id = (n) => `01902507-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const command = (operation = 40, actual = scope, label = "Synthetic Catalogue") =>
  parseBrandCatalogSourceRegister({
    profile: "BrandCatalogSourceRegisterV1",
    ...actual,
    operationReference: id(operation),
    code: "CATALOGUE",
    label,
  });
const resolve = (original) => ({
  profile: "BrandCatalogSourceResolveV1",
  tenantReference: original.tenantReference,
  brandReference: original.brandReference,
  actorReference: original.actorReference,
  operationReference: original.operationReference,
  intentDigest: brandCatalogSourceIntentDigest(original),
});

/** Actual PG/minimal-role/public Audit component evidence. Parent Brand/IAM admission
 * is explicitly controlled; this does not prove ordinary Session or register/picker UI. */
export async function exerciseBrandCatalogSourcePersistence(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `brand_catalog_${context.runId}`;
  let allocated = 1000,
    clockMs = Date.parse(at),
    auditCalls = 0;
  await admin.connect();
  try {
    for (const n of [2, 6, 7, 8, 9, 10])
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES($1,$2,'Synthetic Catalogue Brand','en-CA','CAD','Active',1,$3,$3)",
        [id(n), "CATALOG_" + n, at],
      );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(
      `GRANT USAGE ON SCHEMA rms_catalog,bop_tenant,platform_helpers,platform_audit TO ${role}`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
    );
    await admin.query(
      `GRANT EXECUTE ON FUNCTION rms_catalog.brand_catalog_source_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT,INSERT ON rms_catalog.brand_catalog_source,rms_catalog.brand_catalog_source_operation TO ${role}`,
    );
    // PostgreSQL requires UPDATE privilege for the controlled parent SHARE lock;
    // no Brand mutation is performed by this source or this admission callback.
    await admin.query(`GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.brand_catalog_source) sources,(SELECT count(*)::int FROM rms_catalog.brand_catalog_source_operation) operations,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
        )
      ).rows[0];
    for (const table of ["brand_catalog_source", "brand_catalog_source_operation"]) {
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
        assert.equal(
          (
            await admin.query("SELECT has_table_privilege($1,$2,$3) allowed", [
              role,
              "rms_catalog." + table,
              privilege,
            ])
          ).rows[0].allowed,
          false,
        );
    }
    for (const signature of [
      "rms_catalog.brand_catalog_source_insert_guard()",
      "rms_catalog.brand_catalog_source_coherence_guard()",
    ])
      assert.equal(
        (
          await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
            role,
            signature,
          ])
        ).rows[0].allowed,
        false,
      );
    const audit = async (tx, input) => {
      await appendAuditRecordInTransaction(tx, {
        auditId: input.auditReference,
        brandId: input.brandReference,
        actor: { type: "User", reference: input.actorReference },
        actionCode:
          input.mode === "Abandon"
            ? "BRAND_CATALOG_SOURCE_ABANDONED"
            : "BRAND_CATALOG_SOURCE_REGISTERED",
        targetType: "BrandCatalogSource",
        targetId: input.sourceReference ?? input.brandReference,
        correlationId: input.operationReference,
        reasonCode: "BRAND_CATALOG_SOURCE",
        occurredAt: input.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
        afterSummary: { intentDigest: input.intentDigest },
      });
      auditCalls++;
    };
    async function run(work, actual = scope, controls = {}) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      clockMs += 10;
      const origin = clockMs,
        started = Date.now(),
        observedAt = new Date(origin).toISOString(),
        validUntil = new Date(origin + 5000).toISOString();
      let expired = false,
        allowed = controls.allowed !== false,
        committed = false,
        calls = 0;
      const clock = {
        now: () => new Date(expired ? origin + 5000 : origin + Date.now() - started).toISOString(),
      };
      const guards = [],
        finals = [];
      const tx = {
        query: async (sql, values) => {
          calls++;
          if (sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source"))
            controls.capture?.push({ sql, values: [...values] });
          return client.query(sql, [...values]);
        },
      };
      const store = createPostgresBrandCatalogSourceStore({
        ...actual,
        transaction: tx,
        clock,
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        nextReference: (kind) => {
          assert.ok(["Source", "Audit"].includes(kind));
          return id(allocated++);
        },
        registerBeforeCommit: (host, guard, final) => {
          assert.equal(host, tx);
          guards.push(guard);
          finals.push(final);
        },
        authority: {
          holdUntilTransactionCompletes: async (host, request) => {
            assert.equal(host, tx);
            for (const field of ["tenantReference", "brandReference", "actorReference"])
              assert.equal(request[field], actual[field]);
            assert.equal(request.permission, "catalog.manage");
            assert.equal(request.purposeCode, "BRAND_CATALOG_SOURCE");
            assert.deepEqual(request.requiredFields, brandCatalogSourceRequiredFields);
            if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
              [actual.tenantReference, actual.brandReference],
            );
            const parent = await tx.query(
              "SELECT brand_id,lifecycle FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE",
              [actual.brandReference],
            );
            assert.equal(parent.rowCount, 1);
            assert.equal(parent.rows[0].lifecycle, "Active");
            return { validUntil: request.validUntil };
          },
        },
        appendAudit: async (host, input) => {
          assert.equal(host, tx);
          controls.auditInputs?.push(input);
          await audit(host, input);
          if (controls.failAudit) throw new Error("Synthetic Audit transport failure");
        },
      });
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        const result = await work(store, tx);
        if (controls.failWork) throw new Error("Synthetic rollback after owning write");
        if (controls.withdrawAtGuard) allowed = false;
        if (controls.expireAtGuard) expired = true;
        for (const guard of guards) await guard();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        // Match the real sourceHost: all asynchronous guards finish before the
        // synchronous final seals, with no yield from those seals to COMMIT.
        if (controls.expireAtFinal) expired = true;
        for (const final of finals) final();
        await client.query("COMMIT");
        committed = true;
        controls.phases?.push("Committed");
        const before = calls;
        // Only the post-COMMIT assertion sees expiry; it must remain pure.
        expired = true;
        store.assertFinalized();
        assert.equal(calls, before);
        controls.phases?.push("Finalized");
        if (controls.failAfterCommit) throw new Error("Synthetic post-COMMIT reply failure");
        return result;
      } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
      } finally {
        clockMs = Math.max(clockMs, origin + Date.now() - started);
        await client.end();
      }
    }
    const initial = await counts();
    assert.equal((await run((source) => source.current())).source, null);
    const original = command();
    const first = await run(async (source) => {
      const result = await source.register(original);
      const contender = new pg.Client(context.clientConfig);
      await contender.connect();
      try {
        await contender.query("BEGIN");
        assert.equal(
          (
            await contender.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) held", [
              "BrandCatalogSourceOperation:" + original.operationReference,
            ])
          ).rows[0].held,
          false,
        );
        assert.equal(
          (
            await contender.query(
              "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) held",
              [`BrandCatalogSource:${scope.tenantReference}:${scope.brandReference}`],
            )
          ).rows[0].held,
          false,
        );
        await contender.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(
          contender.query(
            "UPDATE bop_tenant.brand SET display_name='Synthetic contested',version=2,updated_at=$1 WHERE brand_id=$2",
            [at, scope.brandReference],
          ),
          (error) => error.code === "55P03",
        );
      } finally {
        await contender.query("ROLLBACK");
        await contender.end();
      }
      return result;
    });
    assert.equal(first.outcome, "Committed");
    assert.deepEqual(first.originalCommand, original);
    assert.deepEqual(await counts(), {
      sources: initial.sources + 1,
      operations: initial.operations + 1,
      audits: initial.audits + 1,
    });
    const stable = await counts(),
      beforeReplay = allocated,
      beforeAudit = auditCalls;
    assert.deepEqual(await run((source) => source.register(original)), first);
    assert.deepEqual(await run((source) => source.resolve(resolve(original))), first);
    assert.equal(allocated, beforeReplay);
    assert.equal(auditCalls, beforeAudit);
    const reader = { ...scope, actorReference: id(4) };
    const current = await run((source) => source.current(), reader);
    assert.equal(current.actorReference, reader.actorReference);
    assert.equal(current.source.registeredByReference, scope.actorReference);
    assert.deepEqual(current.source, first.source);
    assert.equal(current.publicationStatus, "NotEvaluated");
    assert.equal(current.referenceEligibility, "NotEvaluated");
    assert.deepEqual(
      (await run((source) => source.exact(first.source.sourceReference), reader)).source,
      first.source,
    );
    assert.equal((await run((source) => source.exact(id(99)), reader)).source, null);
    await assert.rejects(
      run((source) => source.register({ ...original, label: "Changed" })),
      { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      run((source) => source.register(command(41))),
      { code: "CATALOG_CODE_CONFLICT" },
    );
    for (const hidden of [
      { ...scope, actorReference: id(4) },
      { ...scope, tenantReference: id(5) },
      { ...scope, brandReference: id(6) },
    ])
      await assert.rejects(
        run((source) => source.resolve({ ...resolve(original), ...hidden }), hidden),
        { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
      );
    assert.equal(allocated, beforeReplay);
    assert.deepEqual(await counts(), stable);
    const absent = command(42),
      abandoned = await run((source) => source.resolve(resolve(absent)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.originalCommand, null);
    assert.equal(abandoned.source, null);
    const afterAbandoned = await counts(),
      absentAllocations = allocated;
    assert.deepEqual(await run((source) => source.resolve(resolve(absent))), abandoned);
    await assert.rejects(
      run((source) => source.register(absent)),
      { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
    );
    assert.equal(allocated, absentAllocations);
    assert.deepEqual(afterAbandoned, {
      ...stable,
      operations: stable.operations + 1,
      audits: stable.audits + 1,
    });
    assert.deepEqual(await counts(), afterAbandoned);

    // Genuine production writer output is retained across rollback for exact SQL
    // storage attacks. These raw cases do not supply extra business authority.
    const alternative = { ...scope, brandReference: id(6) },
      captured = [],
      auditInputs = [];
    await assert.rejects(
      run((source) => source.register(command(60, alternative)), alternative, {
        capture: captured,
        auditInputs,
        failWork: true,
      }),
      /Synthetic rollback/u,
    );
    assert.equal(captured.length, 2);
    assert.equal(auditInputs.length, 1);
    assert.deepEqual(await counts(), afterAbandoned);
    const sourceInsert = captured.find((entry) =>
      entry.sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source("),
    );
    const terminalInsert = captured.find((entry) =>
      entry.sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source_operation("),
    );
    assert.ok(sourceInsert);
    assert.ok(terminalInsert);
    async function raw(work, actual = alternative, commit = false) {
      await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [actual.tenantReference, actual.brandReference],
        );
        const result = await work(admin);
        await admin.query("SET CONSTRAINTS ALL IMMEDIATE");
        await admin.query(commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    await assert.rejects(
      raw((client) => client.query(sourceInsert.sql, sourceInsert.values)),
      (error) => error.code === "23514" || error.code === "23503",
    );
    await assert.rejects(
      raw((client) => client.query(terminalInsert.sql, terminalInsert.values)),
      (error) => error.code === "23514" || error.code === "23503",
    );
    const preciseValues = [...sourceInsert.values];
    preciseValues[8] = String(preciseValues[8]).replace("Z", "001Z");
    await assert.rejects(
      raw((client) => client.query(sourceInsert.sql, preciseValues)),
      (error) =>
        error.code === "23514" && error.constraint === "brand_catalog_source_registered_at_check",
    );
    for (const invalid of ["😀".repeat(101), "\u0085bad", "\u00A0bad", "bad\uFEFF"]) {
      const values = [...sourceInsert.values],
        identity = JSON.parse(values[9]);
      values[7] = invalid;
      identity.label = invalid;
      values[9] = JSON.stringify(identity);
      await assert.rejects(
        raw((client) => client.query(sourceInsert.sql, values)),
        (error) =>
          error.code === "23514" && error.constraint === "brand_catalog_source_label_check",
      );
    }
    const mismatchedTerminal = [...terminalInsert.values],
      mismatchedReceipt = JSON.parse(mismatchedTerminal[8]);
    mismatchedTerminal[10] = id(990);
    mismatchedReceipt.auditReference = id(990);
    mismatchedTerminal[8] = JSON.stringify(mismatchedReceipt);
    await assert.rejects(
      raw(async (client) => {
        await client.query(sourceInsert.sql, sourceInsert.values);
        await client.query(terminalInsert.sql, mismatchedTerminal);
      }),
      (error) => error.code === "23514" || error.code === "23503",
    );
    const mismatchedSource = [...sourceInsert.values],
      mismatchedIdentity = JSON.parse(mismatchedSource[9]);
    mismatchedSource[2] = id(991);
    mismatchedIdentity.sourceReference = id(991);
    mismatchedSource[9] = JSON.stringify(mismatchedIdentity);
    await assert.rejects(
      raw(async (client) => {
        await client.query(terminalInsert.sql, terminalInsert.values);
        await client.query(sourceInsert.sql, mismatchedSource);
      }),
      (error) => error.code === "23514" || error.code === "23503",
    );
    // Opposite insertion order also succeeds in the same true transaction and
    // the actual Audit operation is part of that transaction.
    await raw(
      async (client) => {
        await audit({ query: (sql, values) => client.query(sql, [...values]) }, auditInputs[0]);
        await client.query(terminalInsert.sql, terminalInsert.values);
        await client.query(sourceInsert.sql, sourceInsert.values);
      },
      alternative,
      true,
    );
    const afterReverse = await counts();
    assert.deepEqual(afterReverse, {
      sources: afterAbandoned.sources + 1,
      operations: afterAbandoned.operations + 1,
      audits: afterAbandoned.audits + 1,
    });
    assert.equal(
      (await run((source) => source.current(), alternative)).source.sourceReference,
      JSON.parse(sourceInsert.values[9]).sourceReference,
    );
    // Raw callers may arrive holding the singleton before the global operation.
    // The INSERT guard must use try-admission and refuse immediately, rather
    // than waiting in an inverse lock order until a timeout or a deadlock.
    const inverseHolder = new pg.Client(context.clientConfig);
    await inverseHolder.connect();
    try {
      await inverseHolder.query("BEGIN");
      await inverseHolder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "BrandCatalogSourceOperation:" + terminalInsert.values[0],
      ]);
      await assert.rejects(
        raw(async (client) => {
          await client.query("SET LOCAL lock_timeout='0'");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `BrandCatalogSource:${alternative.tenantReference}:${alternative.brandReference}`,
          ]);
          await client.query(sourceInsert.sql, sourceInsert.values);
        }),
        (error) =>
          error.code === "55P03" && error.message === "BRAND_CATALOG_SOURCE_ADMISSION_UNAVAILABLE",
      );
    } finally {
      await inverseHolder.query("ROLLBACK");
      await inverseHolder.end();
    }
    assert.deepEqual(await counts(), afterReverse);

    // A source cannot bind to an already committed original in another top
    // transaction: its original tuple remains globally immutable and unique.
    await assert.rejects(
      raw((client) => client.query(sourceInsert.sql, sourceInsert.values)),
      (error) => error.code === "23505" || error.code === "23514",
    );
    for (const actual of [
      { ...scope, tenantReference: id(5) },
      { ...scope, brandReference: id(7) },
    ]) {
      await raw(async (client) => {
        assert.equal(
          (await client.query("SELECT * FROM rms_catalog.brand_catalog_source")).rowCount,
          0,
        );
        assert.equal(
          (await client.query("SELECT * FROM rms_catalog.brand_catalog_source_operation")).rowCount,
          0,
        );
      }, actual);
    }
    await assert.rejects(
      raw(async (client) => {
        await client.query("SELECT set_config('bop.store_id',$1,true)", [id(98)]);
        assert.equal(
          (await client.query("SELECT * FROM rms_catalog.brand_catalog_source")).rowCount,
          0,
        );
        assert.equal(
          (await client.query("SELECT * FROM rms_catalog.brand_catalog_source_operation")).rowCount,
          0,
        );
        await client.query("SELECT rms_catalog.brand_catalog_source_operation_admit($1,$2)", [
          id(90),
          scope.actorReference,
        ]);
      }, scope),
      (error) => error.code === "55000",
    );
    for (const table of ["brand_catalog_source", "brand_catalog_source_operation"]) {
      for (const sql of [
        `UPDATE rms_catalog.${table} SET data_classification='ConfigurationMetadata'`,
        `DELETE FROM rms_catalog.${table}`,
        // Include the reciprocal FK table so PostgreSQL reaches the owning
        // no-TRUNCATE trigger instead of stopping at its earlier FK check.
        `TRUNCATE rms_catalog.${table} CASCADE`,
      ])
        await assert.rejects(admin.query(sql), (error) => error.code === "55000");
    }
    assert.deepEqual(await counts(), afterReverse);
    const rollbackScope = { ...scope, brandReference: id(7) };
    for (const [controls, code] of [
      [{ allowed: false }, "CATALOG_PERMISSION_DENIED"],
      [{ withdrawAtGuard: true }, "CATALOG_PERMISSION_DENIED"],
      [{ expireAtGuard: true }, "CATALOG_DEPENDENCY_UNAVAILABLE"],
      [{ expireAtFinal: true }, "CATALOG_DEPENDENCY_UNAVAILABLE"],
      [{ failAudit: true }, "CATALOG_DEPENDENCY_UNAVAILABLE"],
    ]) {
      await assert.rejects(
        run((source) => source.register(command(70, rollbackScope)), rollbackScope, controls),
        { code },
      );
      assert.deepEqual(await counts(), afterReverse);
    }
    const lostScope = { ...scope, brandReference: id(8) },
      lost = command(80, lostScope),
      phases = [];
    await assert.rejects(
      run((source) => source.register(lost), lostScope, { failAfterCommit: true, phases }),
      /Synthetic post-COMMIT reply failure/u,
    );
    assert.deepEqual(phases, ["Committed", "Finalized"]);
    const committedCounts = await counts(),
      recoveryAllocation = allocated,
      recoveryAudit = auditCalls;
    const recovered = await run((source) => source.resolve(resolve(lost)), lostScope);
    assert.equal(recovered.outcome, "Committed");
    assert.deepEqual(recovered.originalCommand, lost);
    assert.equal(allocated, recoveryAllocation);
    assert.equal(auditCalls, recoveryAudit);
    assert.deepEqual(await counts(), committedCounts);
    // Exactly 200 UTF-16 units of supplementary characters is valid through SQL.
    const unicodeScope = { ...scope, brandReference: id(9) };
    assert.equal(
      (
        await run(
          (source) => source.register(command(90, unicodeScope, "😀".repeat(100))),
          unicodeScope,
        )
      ).source.label.length,
      200,
    );
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

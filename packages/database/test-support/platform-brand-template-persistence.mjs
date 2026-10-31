import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  verifyPlatformAuditChain,
} from "../../bop/audit/src/index.ts";
import {
  createPostgresPlatformBrandTemplateStore,
  platformBrandTemplateRequiredFields,
  parsePlatformBrandTemplateSave,
  platformBrandTemplateIntentDigest,
  platformBrandTemplateSemanticContent,
} from "../../bop/tenant/src/index.ts";

const id = (n) => `01902627-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const purposeCode = "PLATFORM_BRAND_TEMPLATE";
const author = { kind: "Platform", actorReference: id(1), purposeCode };
const reader = { ...author, actorReference: id(2) };
const codec = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
};
const resolve = (command) => ({
  profile: "PlatformBrandTemplateResolveV1",
  kind: command.kind,
  actorReference: command.actorReference,
  purposeCode: command.purposeCode,
  operationReference: command.operationReference,
  intentDigest: platformBrandTemplateIntentDigest(command, codec),
});
const rawConstraint = (error) => ["23514", "23503"].includes(error.code);

/** Actual migrated PostgreSQL, non-owner ACLs, public Template/Audit writers and
 * reconstructed Audit chain. The Platform authority port and clock are controlled
 * InternalTest inputs, not real Platform Session/IAM/Provider or publication proof. */
export async function exercisePlatformBrandTemplatePersistence(context) {
  const admin = new pg.Client(context.clientConfig),
    role = `platform_template_${context.runId}`;
  assert.match(role, /^[a-z0-9_]+$/u);
  let allocated = 1000,
    auditCalls = 0,
    createdRole = false,
    stage = "Setup",
    sqlState = "none";
  const mark = (value) => {
    stage = value;
    sqlState = "none";
  };
  const track = async (client, sql, values = []) => {
    try {
      return await client.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  await admin.connect();
  try {
    const databaseClock = async () =>
      (
        await track(
          admin,
          "SELECT to_char((date_trunc('milliseconds',clock_timestamp()) - interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') at",
        )
      ).rows[0].at;
    const content = {
      code: "PLATFORM_STANDARD",
      name: "Synthetic Platform standard",
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA", "fr-CA"],
      overrideAllowedFieldCodes: ["CONTACT"],
      hardRequirementFieldCodes: ["SECURITY.REAUTH"],
      effectiveFrom: await databaseClock(),
      effectiveUntil: null,
      reasonCode: "ADMIN_CONFIGURATION",
    };
    const command = (operation, previous = null, fields = content, scope = author) =>
      parsePlatformBrandTemplateSave({
        profile: "PlatformBrandTemplateSaveV1",
        ...scope,
        operationReference: id(operation),
        templateReference: previous?.templateReference ?? null,
        expectedHead: previous
          ? {
              revision: previous.revision,
              templateVersionReference: previous.templateVersionReference,
              sourceDigest: previous.sourceDigest,
            }
          : null,
        content: fields,
      });
    await track(
      admin,
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    createdRole = true;
    await track(
      admin,
      `GRANT USAGE ON SCHEMA bop_tenant,platform_audit,platform_helpers TO ${role}`,
    );
    // The uuid_v7 domain CHECK invokes this one primitive; no generic helper grant.
    await track(admin, `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    await track(
      admin,
      `GRANT EXECUTE ON FUNCTION bop_tenant.platform_brand_template_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ${role}`,
    );
    await track(
      admin,
      `GRANT SELECT,INSERT ON bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation TO ${role}`,
    );
    await track(
      admin,
      `GRANT SELECT,INSERT ON platform_audit.platform_actor_audit_record TO ${role}`,
    );
    await track(
      admin,
      `GRANT SELECT,INSERT,UPDATE ON platform_audit.platform_actor_audit_chain_head TO ${role}`,
    );
    const state = async () =>
      (
        await track(
          admin,
          "SELECT (SELECT count(*)::int FROM bop_tenant.brand) brands,(SELECT count(*)::int FROM bop_tenant.platform_brand_template_revision) revisions,(SELECT count(*)::int FROM bop_tenant.platform_brand_template_operation) operations,(SELECT count(*)::int FROM platform_audit.platform_actor_audit_record) audits,(SELECT coalesce(jsonb_agg(jsonb_build_array(next_sequence,encode(last_record_hash,'hex')) ORDER BY actor_id,purpose_code),'[]'::jsonb) FROM platform_audit.platform_actor_audit_chain_head) heads",
        )
      ).rows[0];
    assert.equal((await state()).brands, 0);
    const audit = async (tx, input) => {
      await appendPlatformAuditRecordInTransaction(tx, {
        auditReference: input.auditReference,
        actorReference: input.actorReference,
        purposeCode: input.purposeCode,
        actionCode:
          input.mode === "Abandon"
            ? "PLATFORM_BRAND_TEMPLATE_ABANDONED"
            : "PLATFORM_BRAND_TEMPLATE_SAVED",
        targetType:
          input.mode === "Abandon" ? "PlatformBrandTemplateOperation" : "PlatformBrandTemplate",
        targetReference: input.templateReference ?? input.operationReference,
        operationReference: input.operationReference,
        intentDigest: input.intentDigest,
        occurredAt: input.occurredAt,
        reasonCode: "ADMIN_CONFIGURATION",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      auditCalls++;
    };
    const setScope = (client, scope) =>
      track(
        client,
        "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true),set_config('bop.tenant_id','',true),set_config('bop.brand_id','',true),set_config('bop.store_id','',true)",
        [scope.actorReference, scope.purposeCode],
      );
    async function run(work, scope = author, controls = {}) {
      const client = new pg.Client(context.clientConfig);
      await client.connect();
      const origin = Date.parse(await databaseClock()),
        started = Date.now(),
        guards = [],
        finals = [];
      let expired = false,
        allowed = controls.allowed !== false,
        committed = false,
        calls = 0;
      const observedAt = new Date(origin).toISOString(),
        validUntil = new Date(origin + 5000).toISOString();
      const tx = {
        query: async (sql, values) => {
          calls++;
          if (sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_"))
            controls.capture?.push({ sql, values: [...values] });
          return track(client, sql, values);
        },
      };
      const store = createPostgresPlatformBrandTemplateStore({
        ...scope,
        transaction: tx,
        clock: {
          now: () =>
            new Date(expired ? origin + 5000 : origin + Date.now() - started).toISOString(),
        },
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        references: {
          ...codec,
          nextReference: (kind) => {
            assert.ok(["Template", "Version", "Audit"].includes(kind));
            return id(allocated++);
          },
        },
        registerBeforeCommit: (host, guard, final) => {
          assert.equal(host, tx);
          guards.push(guard);
          finals.push(final);
        },
        authority: {
          holdUntilTransactionCompletes: async (host, request) => {
            assert.equal(host, tx);
            assert.equal(request.kind, "Platform");
            assert.equal(request.actorReference, scope.actorReference);
            assert.equal(request.purposeCode, purposeCode);
            assert.equal(
              request.permission,
              request.mode === "Read"
                ? "platform.brand-template.read"
                : "platform.brand-template.manage",
            );
            assert.deepEqual(request.requiredFields, platformBrandTemplateRequiredFields);
            assert.equal(Object.hasOwn(request, "brandReference"), false);
            assert.equal(Object.hasOwn(request, "storeReference"), false);
            if (request.original)
              assert.equal(request.original.actorReference, scope.actorReference);
            if (!allowed) throw new Error("CONTROLLED_PLATFORM_AUTHORITY_DENIED");
            return { validUntil: request.validUntil };
          },
        },
        appendAudit: async (host, input) => {
          assert.equal(host, tx);
          assert.equal(input.actorReference, scope.actorReference);
          controls.auditInputs?.push(input);
          await audit(host, input);
          if (controls.failAudit) throw new Error("CONTROLLED_AUDIT_REPLY_FAILURE");
        },
      });
      try {
        await track(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
        await track(client, "SET LOCAL ROLE " + role);
        const result = await work(store, tx);
        if (controls.failWork) throw new Error("CONTROLLED_SOURCE_ROLLBACK");
        if (controls.withdrawAtGuard) allowed = false;
        if (controls.expireAtGuard) expired = true;
        for (const guard of guards) await guard();
        await track(client, "SET CONSTRAINTS ALL IMMEDIATE");
        if (controls.expireAtFinal) expired = true;
        for (const final of finals) final();
        await track(client, "COMMIT");
        committed = true;
        const priorCalls = calls;
        expired = true;
        store.assertFinalized();
        assert.equal(calls, priorCalls);
        return result;
      } catch (error) {
        if (!committed) await track(client, "ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    async function raw(work, scope = author, operation = null, commit = false, admitted = true) {
      await track(admin, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await track(admin, "SET LOCAL ROLE " + role);
        await setScope(admin, scope);
        if (admitted)
          await track(admin, "SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)", [
            scope.actorReference,
            operation,
          ]);
        const result = await work(admin);
        await track(admin, "SET CONSTRAINTS ALL IMMEDIATE");
        await track(admin, commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        await track(admin, "ROLLBACK");
        throw error;
      }
    }

    mark("MinimumPrivileges");
    const roles = (
      await track(
        admin,
        "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1",
        [role],
      )
    ).rows[0];
    assert.deepEqual(roles, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    for (const table of [
      "bop_tenant.platform_brand_template_revision",
      "bop_tenant.platform_brand_template_operation",
      "platform_audit.platform_actor_audit_record",
    ])
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
        assert.equal(
          (
            await track(admin, "SELECT has_table_privilege($1,$2,$3) allowed", [
              role,
              table,
              privilege,
            ])
          ).rows[0].allowed,
          false,
        );
    for (const table of ["bop_tenant.brand", "bop_tenant.store", "platform_audit.audit_record"])
      assert.equal(
        (await track(admin, "SELECT has_table_privilege($1,$2,'SELECT') allowed", [role, table]))
          .rows[0].allowed,
        false,
      );
    for (const signature of [
      "bop_tenant.platform_brand_template_insert_admit()",
      "bop_tenant.platform_brand_template_coherence()",
      "bop_tenant.platform_brand_template_immutable()",
      "platform_audit.platform_actor_audit_head_guard()",
      "platform_audit.platform_actor_audit_record_guard()",
    ])
      assert.equal(
        (
          await track(admin, "SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
            role,
            signature,
          ])
        ).rows[0].allowed,
        false,
      );
    assert.equal(
      (
        await track(
          admin,
          "SELECT bool_or(c.relowner=r.oid) owns FROM pg_class c CROSS JOIN pg_roles r WHERE r.rolname=$1 AND c.oid IN ('bop_tenant.platform_brand_template_revision'::regclass,'bop_tenant.platform_brand_template_operation'::regclass,'platform_audit.platform_actor_audit_record'::regclass,'platform_audit.platform_actor_audit_chain_head'::regclass)",
          [role],
        )
      ).rows[0].owns,
      false,
    );

    mark("SaveAndOriginal");
    const original = command(10),
      first = await run(async (store) => {
        const receipt = await store.save(original);
        const contender = new pg.Client(context.clientConfig);
        await contender.connect();
        try {
          await track(contender, "BEGIN");
          await track(contender, "SET LOCAL ROLE " + role);
          await setScope(contender, author);
          assert.equal(
            (
              await track(
                contender,
                "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) held",
                [
                  "PlatformBrandTemplateOperation:" +
                    author.actorReference +
                    ":" +
                    purposeCode +
                    ":" +
                    original.operationReference,
                ],
              )
            ).rows[0].held,
            false,
          );
          await track(contender, "SET LOCAL lock_timeout='100ms'");
          await assert.rejects(
            track(contender, "SELECT bop_tenant.platform_brand_template_operation_admit($1,$2)", [
              author.actorReference,
              id(900),
            ]),
            { code: "55P03" },
          );
        } finally {
          await track(contender, "ROLLBACK");
          await contender.end();
        }
        return receipt;
      });
    assert.equal(first.outcome, "Committed");
    assert.equal(first.snapshot.recordKind, "AuthoredContent");
    assert.equal(Object.hasOwn(first.snapshot, "brandReference"), false);
    const stable = await state(),
      allocationBeforeReplay = allocated,
      auditsBeforeReplay = auditCalls;
    assert.deepEqual(await run((store) => store.save(original)), first);
    assert.deepEqual(await run((store) => store.resolve(resolve(original))), first);
    assert.equal(allocated, allocationBeforeReplay);
    assert.equal(auditCalls, auditsBeforeReplay);
    assert.deepEqual(await state(), stable);
    mark("ExactIntentAndCas");
    await assert.rejects(
      run((store) =>
        store.save({ ...original, content: { ...content, name: "Different intent" } }),
      ),
      { code: "PLATFORM_TEMPLATE_INTENT_CONFLICT" },
    );
    await assert.rejects(
      run((store) => store.save(command(11))),
      { code: "PLATFORM_TEMPLATE_VERSION_CONFLICT" },
    );
    await assert.rejects(
      run((store) =>
        store.save({
          ...command(12, first.snapshot),
          expectedHead: {
            ...command(12, first.snapshot).expectedHead,
            sourceDigest: "sha256:" + "a".repeat(64),
          },
        }),
      ),
      { code: "PLATFORM_TEMPLATE_VERSION_CONFLICT" },
    );
    assert.equal(allocated, allocationBeforeReplay);
    assert.deepEqual(await state(), stable);
    const second = await run((store) =>
      store.save(command(13, first.snapshot, { ...content, name: "Second revision" })),
    );
    const third = await run((store) =>
      store.save(command(14, second.snapshot, { ...content, name: "Third revision" })),
    );
    mark("CurrentExactHistoryAcrossActors");
    // A read needs no INSERT rights and no UPDATE privilege for row-lock syntax.
    await track(
      admin,
      `REVOKE INSERT ON bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation FROM ${role}`,
    );
    try {
      const current = await run(
        (store) => store.current({ templateReference: first.snapshot.templateReference }),
        reader,
      );
      assert.equal(current.actorReference, reader.actorReference);
      assert.deepEqual(current.current, third.snapshot);
      assert.equal(current.publication, "NotEvaluated");
      assert.deepEqual(
        (
          await run(
            (store) =>
              store.exact({ templateVersionReference: first.snapshot.templateVersionReference }),
            reader,
          )
        ).snapshot,
        first.snapshot,
      );
      const history = await run(
        (store) =>
          store.history({
            templateReference: first.snapshot.templateReference,
            beforeRevision: null,
          }),
        reader,
      );
      assert.deepEqual(
        history.entries.map((r) => r.revision),
        [3, 2],
      );
      assert.equal(history.nextBeforeRevision, 2);
      const tail = await run(
        (store) =>
          store.history({
            templateReference: first.snapshot.templateReference,
            beforeRevision: history.nextBeforeRevision,
          }),
        reader,
      );
      assert.deepEqual(
        tail.entries.map((r) => r.revision),
        [1],
      );
      assert.equal(tail.nextBeforeRevision, null);
      assert.equal(
        (await run((store) => store.current({ templateReference: id(999) }), reader)).current,
        null,
      );
    } finally {
      await track(
        admin,
        `GRANT INSERT ON bop_tenant.platform_brand_template_revision,bop_tenant.platform_brand_template_operation TO ${role}`,
      );
    }
    await assert.rejects(
      run((store) => store.resolve(resolve(original)), reader),
      { code: "PLATFORM_TEMPLATE_PERMISSION_DENIED" },
    );
    mark("AbandonedAndHiddenOriginal");
    const absent = command(20, null, { ...content, code: "ABANDONED_STANDARD" });
    const abandoned = await run((store) => store.resolve(resolve(absent)));
    assert.equal(abandoned.outcome, "Abandoned");
    assert.equal(abandoned.snapshot, null);
    assert.equal(abandoned.originalCommand, null);
    const abandonedState = await state(),
      abandonedIds = allocated,
      abandonedAudits = auditCalls;
    assert.deepEqual(await run((store) => store.resolve(resolve(absent))), abandoned);
    await assert.rejects(
      run((store) => store.save(absent)),
      { code: "PLATFORM_TEMPLATE_VERSION_CONFLICT" },
    );
    assert.equal(allocated, abandonedIds);
    assert.equal(auditCalls, abandonedAudits);
    await raw(async (client) => {
      assert.equal(
        (
          await track(
            client,
            "SELECT count(*)::int n FROM bop_tenant.platform_brand_template_operation WHERE actor_id=$1 AND outcome='Committed'",
            [author.actorReference],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await track(
            client,
            "SELECT count(*)::int n FROM bop_tenant.platform_brand_template_operation WHERE actor_id=$1 AND outcome='Abandoned'",
            [author.actorReference],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await track(
            client,
            "SELECT count(*)::int n FROM platform_audit.platform_actor_audit_record",
          )
        ).rows[0].n,
        0,
      );
    }, reader);
    for (const scope of [
      { ...reader, actorReference: "" },
      { ...reader, purposeCode: "WRONG_PURPOSE" },
    ])
      await raw(
        async (client) => {
          assert.equal(
            (
              await track(
                client,
                "SELECT count(*)::int n FROM bop_tenant.platform_brand_template_revision",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await track(
                client,
                "SELECT count(*)::int n FROM bop_tenant.platform_brand_template_operation",
              )
            ).rows[0].n,
            0,
          );
        },
        scope,
        null,
        false,
        false,
      );
    assert.deepEqual(await state(), abandonedState);

    for (const [name, controls] of [
      ["DeniedBeforeWrite", { allowed: false }],
      ["PermissionWithdrawal", { withdrawAtGuard: true }],
      ["LeaseAtGuard", { expireAtGuard: true }],
      ["LeaseAtFinal", { expireAtFinal: true }],
      ["AuditReplyFailure", { failAudit: true }],
    ]) {
      mark(name);
      const baseline = await state();
      await assert.rejects(
        run(
          (store) =>
            store.save(command(30, third.snapshot, { ...content, name: "Rolled back update" })),
          author,
          controls,
        ),
      );
      assert.deepEqual(await state(), baseline);
    }
    mark("CaptureRealStatementsForStorageRefusals");
    const captured = [],
      auditInputs = [],
      rawCommand = command(40, null, { ...content, code: "RAW_STANDARD" });
    await assert.rejects(
      run((store) => store.save(rawCommand), author, {
        capture: captured,
        auditInputs,
        failWork: true,
      }),
      /CONTROLLED_SOURCE_ROLLBACK/u,
    );
    assert.deepEqual(await state(), abandonedState);
    assert.equal(captured.length, 2);
    assert.equal(auditInputs.length, 1);
    const revisionInsert = captured.find((r) =>
      r.sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_revision("),
    );
    const operationInsert = captured.find((r) =>
      r.sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_operation("),
    );
    assert.ok(revisionInsert);
    assert.ok(operationInsert);
    mark("ActualAdmissionAndBidirectionalCoherence");
    await assert.rejects(
      raw(
        (client) => track(client, revisionInsert.sql, revisionInsert.values),
        author,
        null,
        false,
        false,
      ),
      { code: "23514" },
    );
    for (const insertion of [revisionInsert, operationInsert])
      await assert.rejects(
        raw(
          (client) => track(client, insertion.sql, insertion.values),
          author,
          rawCommand.operationReference,
        ),
        rawConstraint,
      );
    const mismatched = [...operationInsert.values],
      mismatchedReceipt = JSON.parse(mismatched[10]);
    mismatched[8] = id(700);
    mismatchedReceipt.auditReference = id(700);
    mismatched[10] = JSON.stringify(mismatchedReceipt);
    for (const reversed of [false, true])
      await assert.rejects(
        raw(
          async (client) => {
            if (reversed) await track(client, operationInsert.sql, mismatched);
            await track(client, revisionInsert.sql, revisionInsert.values);
            if (!reversed) await track(client, operationInsert.sql, mismatched);
          },
          author,
          rawCommand.operationReference,
        ),
        rawConstraint,
      );
    mark("JsonNumericTypesAndPrecision");
    const stringRevision = [...revisionInsert.values],
      invalidSnapshot = JSON.parse(stringRevision[9]);
    invalidSnapshot.revision = String(invalidSnapshot.revision);
    stringRevision[9] = JSON.stringify(invalidSnapshot);
    await assert.rejects(
      raw(
        (client) => track(client, revisionInsert.sql, stringRevision),
        author,
        rawCommand.operationReference,
      ),
      { code: "23514" },
    );
    const imprecise = [...revisionInsert.values];
    imprecise[11] = String(imprecise[11]).replace("Z", "001Z");
    await assert.rejects(
      raw(
        (client) => track(client, revisionInsert.sql, imprecise),
        author,
        rawCommand.operationReference,
      ),
      { code: "23514" },
    );
    const edited = [],
      editCommand = command(41, third.snapshot);
    await assert.rejects(
      run((store) => store.save(editCommand), author, { capture: edited, failWork: true }),
      /CONTROLLED_SOURCE_ROLLBACK/u,
    );
    const editRevision = edited.find((r) =>
        r.sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_revision("),
      ),
      editOperation = edited.find((r) =>
        r.sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_operation("),
      );
    assert.ok(editRevision);
    assert.ok(editOperation);
    const invalidHeadValues = [...editOperation.values],
      invalidCommand = JSON.parse(invalidHeadValues[9]),
      invalidReceipt = JSON.parse(invalidHeadValues[10]);
    invalidCommand.expectedHead.revision = String(invalidCommand.expectedHead.revision);
    invalidReceipt.originalCommand = invalidCommand;
    invalidHeadValues[9] = JSON.stringify(invalidCommand);
    invalidHeadValues[10] = JSON.stringify(invalidReceipt);
    await assert.rejects(
      raw(
        async (client) => {
          await track(client, editRevision.sql, editRevision.values);
          await track(client, editOperation.sql, invalidHeadValues);
        },
        author,
        editCommand.operationReference,
      ),
      { code: "23514" },
    );
    assert.deepEqual(await state(), abandonedState);
    const invalidTimes = [
      { name: "PositiveInfinity", stored: "infinity", wire: null },
      { name: "NegativeInfinity", stored: "-infinity", wire: null },
      {
        name: "BeforeFirstYear",
        stored: "0001-01-01 00:00:00+00 BC",
        wire: "0001-01-01T00:00:00.000Z",
      },
      {
        name: "AfterLastYear",
        stored: "10000-01-01T00:00:00.000Z",
        wire: "10000-01-01T00:00:00.000Z",
      },
    ];
    const genuineSemanticContent = platformBrandTemplateSemanticContent(
      JSON.parse(revisionInsert.values[9]),
    );
    const hashValue = (value) => codec.hashIntent(codec.canonicalize(value));
    const assertTimePremise = async (client, boundary) => {
      const actual = (
        await track(
          client,
          "SELECT $1::timestamptz=date_trunc('milliseconds',$1::timestamptz) exact,to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') formatted",
          [boundary.stored],
        )
      ).rows[0];
      assert.deepEqual(actual, { exact: true, formatted: boundary.wire });
    };
    for (const boundary of invalidTimes) {
      const revisionValues = [...revisionInsert.values],
        operationValues = [...operationInsert.values],
        snapshot = JSON.parse(revisionValues[9]),
        receipt = JSON.parse(operationValues[10]);
      // Preserve the genuine original Actor/operation/command and both directions
      // of receipt binding. Only the three persisted times and their exact JSON
      // copies change; even content/source/receipt digests remain coherent.
      snapshot.createdAt = boundary.wire;
      snapshot.recordedAt = boundary.wire;
      snapshot.contentDigest = hashValue({ ...genuineSemanticContent, createdAt: boundary.wire });
      const source = { ...snapshot };
      delete source.sourceDigest;
      snapshot.sourceDigest = hashValue(source);
      revisionValues[7] = snapshot.contentDigest;
      revisionValues[8] = snapshot.sourceDigest;
      revisionValues[9] = codec.canonicalize(snapshot);
      revisionValues[10] = boundary.stored;
      revisionValues[11] = boundary.stored;
      receipt.snapshot = snapshot;
      receipt.occurredAt = boundary.wire;
      operationValues[10] = codec.canonicalize(receipt);
      operationValues[11] = hashValue(receipt);
      operationValues[12] = boundary.stored;
      for (const reversed of [false, true]) {
        mark("CommittedTime" + boundary.name + (reversed ? "OperationFirst" : "RevisionFirst"));
        await assert.rejects(
          raw(
            async (client) => {
              await assertTimePremise(client, boundary);
              if (reversed) await track(client, operationInsert.sql, operationValues);
              await track(client, revisionInsert.sql, revisionValues);
              if (!reversed) await track(client, operationInsert.sql, operationValues);
            },
            author,
            rawCommand.operationReference,
          ),
          { code: "23514" },
        );
        assert.deepEqual(await state(), abandonedState);
      }
    }
    mark("CaptureRealAbandonedStatementForTimeRefusals");
    const abandonedInserts = [],
      abandonedCommand = command(42, null, { ...content, code: "RAW_ABANDONED_STANDARD" });
    await assert.rejects(
      run((store) => store.resolve(resolve(abandonedCommand)), author, {
        capture: abandonedInserts,
        failWork: true,
      }),
      /CONTROLLED_SOURCE_ROLLBACK/u,
    );
    assert.equal(abandonedInserts.length, 1);
    const abandonedInsert = abandonedInserts[0];
    assert.ok(
      abandonedInsert.sql.startsWith("INSERT INTO bop_tenant.platform_brand_template_operation("),
    );
    assert.equal(abandonedInsert.values[4], "Abandoned");
    for (const boundary of invalidTimes) {
      mark("AbandonedTime" + boundary.name);
      const values = [...abandonedInsert.values],
        receipt = JSON.parse(values[10]);
      assert.equal(receipt.originalCommand, null);
      assert.equal(receipt.snapshot, null);
      receipt.occurredAt = boundary.wire;
      values[10] = codec.canonicalize(receipt);
      values[11] = hashValue(receipt);
      values[12] = boundary.stored;
      await assert.rejects(
        raw(
          async (client) => {
            await assertTimePremise(client, boundary);
            await track(client, abandonedInsert.sql, values);
          },
          author,
          abandonedCommand.operationReference,
        ),
        { code: "23514" },
      );
      assert.deepEqual(await state(), abandonedState);
    }
    mark("ReverseOrderAtomicCommitWithActualAudit");
    await raw(
      async (client) => {
        await audit({ query: (sql, values) => track(client, sql, values) }, auditInputs[0]);
        await track(client, operationInsert.sql, operationInsert.values);
        await track(client, revisionInsert.sql, revisionInsert.values);
      },
      author,
      rawCommand.operationReference,
      true,
    );
    const rawSnapshot = JSON.parse(revisionInsert.values[9]);
    assert.deepEqual(
      (await run((store) => store.current({ templateReference: rawSnapshot.templateReference })))
        .current,
      rawSnapshot,
    );

    mark("ImmutableHistoryAndRoleDenials");
    for (const table of [
      "bop_tenant.platform_brand_template_revision",
      "bop_tenant.platform_brand_template_operation",
      "platform_audit.platform_actor_audit_record",
    ])
      for (const sql of [
        `UPDATE ${table} SET actor_id=actor_id`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ])
        await assert.rejects(
          raw((client) => track(client, sql)),
          { code: "42501" },
        );
    for (const table of [
      "bop_tenant.platform_brand_template_revision",
      "bop_tenant.platform_brand_template_operation",
      "platform_audit.platform_actor_audit_record",
    ])
      for (const sql of [`UPDATE ${table} SET actor_id=actor_id`, `DELETE FROM ${table}`])
        await assert.rejects(track(admin, sql), { code: "23514" });
    await assert.rejects(
      raw((client) =>
        track(
          client,
          "UPDATE platform_audit.platform_actor_audit_chain_head SET next_sequence=next_sequence+1",
        ),
      ),
      { code: "23514" },
    );
    mark("ReconstructAndVerifyActualAuditChain");
    const storedAudit = (
      await track(
        admin,
        "SELECT audit_id,actor_id,purpose_code,action_code,target_type,target_id,operation_id,encode(intent_digest,'hex') intent_digest,occurred_at,reason_code,retention_policy_code,retention_policy_version,chain_profile,chain_sequence::text sequence,CASE WHEN previous_record_hash IS NULL THEN NULL ELSE encode(previous_record_hash,'hex') END previous_hash,encode(record_hash,'hex') record_hash,recorded_at FROM platform_audit.platform_actor_audit_record ORDER BY actor_id,purpose_code,chain_sequence",
      )
    ).rows;
    const chain = storedAudit.map((r) => ({
      profile: r.chain_profile,
      sequence: Number(r.sequence),
      previousHash: r.previous_hash,
      recordHash: r.record_hash,
      recordedAt: r.recorded_at.toISOString(),
      content: {
        auditReference: r.audit_id,
        actorReference: r.actor_id,
        purposeCode: r.purpose_code,
        actionCode: r.action_code,
        targetType: r.target_type,
        targetReference: r.target_id,
        operationReference: r.operation_id,
        intentDigest: "sha256:" + r.intent_digest,
        occurredAt: r.occurred_at.toISOString(),
        reasonCode: r.reason_code,
        retentionPolicyCode: r.retention_policy_code,
        retentionPolicyVersion: r.retention_policy_version,
      },
    }));
    assert.equal(chain.length, 5);
    assert.equal(verifyPlatformAuditChain(chain), true);
    const head = (
      await track(
        admin,
        "SELECT next_sequence::text next_sequence,encode(last_record_hash,'hex') last_hash FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$1 AND purpose_code=$2",
        [author.actorReference, purposeCode],
      )
    ).rows[0];
    assert.equal(head.next_sequence, String(chain.length + 1));
    assert.equal(head.last_hash, chain.at(-1).recordHash);
    assert.equal(verifyPlatformAuditChain(chain.slice(1)), false);
    assert.equal((await state()).brands, 0);
    assert.equal(
      (
        await track(
          admin,
          "SELECT count(*)::int n FROM platform_audit.platform_actor_audit_record a JOIN bop_tenant.platform_brand_template_operation o ON o.audit_id=a.audit_id AND o.actor_id=a.actor_id AND o.purpose_code=a.purpose_code AND o.operation_id=a.operation_id WHERE encode(a.intent_digest,'hex')=substring(o.intent_digest FROM 8)",
        )
      ).rows[0].n,
      5,
    );
  } catch (error) {
    const assertion = error?.code === "ERR_ASSERTION" ? "Assertion" : "Refusal";
    throw new Error(
      `PLATFORM_BRAND_TEMPLATE_NATIVE_FAILED stage=${stage} SQLSTATE=${sqlState} class=${assertion}`,
      { cause: error },
    );
  } finally {
    try {
      await admin.query("ROLLBACK");
      await admin.query("RESET ROLE");
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
    } finally {
      await admin.end();
    }
  }
}

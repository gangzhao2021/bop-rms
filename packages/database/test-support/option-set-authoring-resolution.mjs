import assert from "node:assert/strict";
import pg from "pg";
import { setTimeout, clearTimeout } from "node:timers";
import { createPostgresFullOptionSetDraftStore } from "../../rms/catalog/src/infrastructure/persistence/option-set-full-draft-store.ts";
import { createPostgresOptionSetAuthoringResolutionStore } from "../../rms/catalog/src/infrastructure/persistence/option-set-authoring-resolution-store.ts";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import { createCatalogOptionSetAuthoringIdentity } from "../../rms/catalog/src/contracts/option-set-authoring-resolution.ts";
import { CatalogError } from "../../rms/catalog/src/contracts/product.ts";
const id = (n) => "01902421-7300-7000-8000-" + n.toString(16).padStart(12, "0");
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Synthetic Option recovery race timed out")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const settled = (start) =>
  start().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
/** Controlled synthetic User/permission inputs, not native IAM evidence.
 * Actual owning Create/Edit, original metadata, PostgreSQL contention, Audit,
 * Outbox, forced RLS and original host guards execute in an isolated database. */
export async function exerciseOptionSetAuthoringResolution(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_opt_recovery_" + context.runId;
  assert.match(role, /^wp2421_opt_recovery_[a-f0-9]+$/u);
  await admin.connect();
  const tenant = id(1),
    brand = id(2),
    actor = id(3),
    editor = id(4),
    at = new Date(Date.now() - 1000).toISOString();
  const guards = new WeakMap(),
    auditInputs = new Map();
  let sequence = 100,
    allowed = true,
    afterWork = null,
    raceCapture = null,
    createdRole = false,
    lastSqlState = null,
    lastSqlReason = null;
  const reference = () => id(++sequence),
    now = () => at;
  const lease = (observedAt) => ({
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
  });
  const transactions = {
    async run(work) {
      const race = raceCapture,
        slot = race ? race.started++ : null;
      const client = new pg.Client({
        ...context.clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
      });
      await client.connect();
      if (race) race.pids[slot] = client.processID;
      let tx;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL ROLE " + role);
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenant, brand],
        );
        tx = {
          async query(sql, values = []) {
            try {
              return await client.query(sql, [...values]);
            } catch (error) {
              lastSqlState = /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : null;
              lastSqlReason = [
                "OPTION_SET_AUTHORING_SOURCE_INVALID",
                "OPTION_SET_AUTHORING_LEGACY_SOURCE_REFUSED",
              ].includes(error.message)
                ? error.message
                : null;
              throw error;
            }
          },
        };
        const entries = [];
        guards.set(tx, entries);
        const result = await work(tx);
        if (afterWork) {
          const hook = afterWork;
          afterWork = null;
          await hook(tx);
        }
        for (const entry of entries) await entry.guard();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        for (const entry of entries) entry.finalAssert();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        if (tx) guards.delete(tx);
        await client.end();
      }
    },
  };
  const register = async (tx, guard, finalAssert) => {
    const entries = guards.get(tx);
    assert(entries);
    entries.push({ guard, finalAssert });
  };
  const audit = (who, operation, actionCode, targetType, targetId, reasonCode, occurredAt) => {
    const record = {
      auditId: reference(),
      brandId: brand,
      actor: { type: "User", reference: who },
      actionCode,
      targetType,
      targetId,
      reasonCode,
      correlationId: operation,
      occurredAt,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "OPERATIONAL",
      retentionPolicyVersion: 1,
    };
    auditInputs.set(operation, record);
    return record;
  };
  const permit = (who) => async (tx, input) => {
    assert.equal(input.tenantReference, tenant);
    assert.equal(input.brandReference, brand);
    assert.equal(input.actorReference, who);
    assert.equal(input.actorKind, "User");
    assert.equal(input.permission, "catalog.manage");
    assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
    assert(
      [
        "catalog.option_set.create",
        "catalog.option_set.update",
        "catalog.option_set.read",
      ].includes(input.action),
    );
    assert(input.requiredFields.length > 0);
    if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    // This controlled authority owns an outer transaction hold, just as the
    // real runtime holder does; the owning writer cannot itself manufacture IAM.
    await register(
      tx,
      async () => {
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return undefined;
      },
      () => {
        if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    );
    return lease(input.observedAt);
  };
  const writer = (who = actor) =>
    createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: who,
      clock: { now },
      transactions,
      authority: { holdUntilTransactionCompletes: permit(who) },
      creation: {
        authority: { holdUntilTransactionCompletes: permit(who) },
        references: { generate: reference },
      },
      editing: {
        authority: { holdUntilTransactionCompletes: permit(who) },
        references: { generateOption: reference },
        registerBeforeCommit: register,
      },
      audit: {
        create: (input) =>
          audit(
            who,
            input.operationReference,
            input.result.sourceAggregate.aggregateVersion === 1
              ? "CATALOG_OPTION_SET_CREATE"
              : "CATALOG_OPTION_SET_REPLACEDRAFT",
            "CatalogOptionSet",
            input.result.sourceAggregate.optionSetReference,
            input.reasonCode,
            input.occurredAt,
          ),
      },
      events: { generateReference: reference },
    });
  const resolution = (who = actor, selectedTenant = tenant, selectedBrand = brand) =>
    createPostgresOptionSetAuthoringResolutionStore({
      tenantReference: selectedTenant,
      brandReference: selectedBrand,
      actorReference: who,
      clock: { now },
      originalValidUntil: lease(at).validUntil,
      transactions,
      registerBeforeCommit: register,
      authority: {
        holdUntilTransactionCompletes: async (_tx, input) => {
          assert.equal(input.command.tenantReference, selectedTenant);
          assert.equal(input.command.brandReference, selectedBrand);
          assert.equal(input.command.actorReference, who);
          assert.equal(input.permission, "catalog.manage");
          assert.equal(input.actorKind, "User");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.equal(input.purposeCode, "CATALOG_OPTION_SET_AUTHORING_OPERATION_RESOLUTION");
          assert.deepEqual(input.requiredPermissions, [
            "catalog.manage",
            input.mode === "Resolve"
              ? "catalog.option_set.read"
              : input.command.action === "Create"
                ? "catalog.option_set.create"
                : "catalog.option_set.update",
          ]);
          if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          return lease(input.observedAt);
        },
      },
      audit: {
        create: ({ command, resolution: receipt }) => {
          assert.equal(selectedBrand, brand);
          return audit(
            who,
            command.operationReference,
            "CATALOG_OPTION_SET_AUTHORING_ABANDONED",
            "CatalogOptionSetAuthoringOperation",
            command.operationReference,
            command.reasonCode,
            receipt.recordedAt,
          );
        },
      },
    });
  const command = (
    full,
    who = actor,
    action = "Create",
    selectedTenant = tenant,
    selectedBrand = brand,
  ) => ({
    profile: "CatalogOptionSetAuthoringResolutionCommandV1",
    tenantReference: selectedTenant,
    brandReference: selectedBrand,
    actorReference: who,
    action,
    reasonCode: full.reasonCode,
    operationReference: full.operationReference,
    optionSetReference: action === "Create" ? null : full.optionSetReference,
    expectedAggregateVersion: action === "Create" ? null : full.expectedAggregateVersion,
  });
  const create = (code) => ({
    internalCode: code,
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic recovery choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic one" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: false,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "ONE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: reference(),
    occurredAt: at,
    reasonCode: "SYNTHETIC_OPTION_RECOVERY",
  });
  const counts = async () =>
    (
      await admin.query(`SELECT
    (SELECT count(*)::int FROM rms_catalog.option_set) sets,
    (SELECT count(*)::int FROM rms_catalog.option_set_version) versions,
    (SELECT count(*)::int FROM rms_catalog.option) options,
    (SELECT count(*)::int FROM rms_catalog.option_set_operation_record) operations,
    (SELECT count(*)::int FROM rms_catalog.option_set_draft_content_snapshot) snapshots,
    (SELECT count(*)::int FROM rms_catalog.option_set_authoring_identity) identities,
    (SELECT count(*)::int FROM rms_catalog.option_set_authoring_abandonment) fences,
    (SELECT count(*)::int FROM platform_audit.audit_record) audit,
    (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.option_set_id),'[]'::jsonb) FROM rms_catalog.option_set s) roots,
    (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`)
    ).rows[0];
  const resolve = (c) =>
    resolution(c.actorReference, c.tenantReference, c.brandReference).resolve(c);
  const publicRefusal = (error) =>
    ["CATALOG_PERMISSION_DENIED", "CATALOG_IDEMPOTENCY_CONFLICT"].includes(error.code);
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid),rms_catalog.option_set_authoring_operation_available(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_audit.audit_chain_head TO " +
        role,
    );
    await admin.query("GRANT DELETE ON rms_catalog.option_conflict TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event,rms_catalog.option_set_authoring_identity,rms_catalog.option_set_authoring_abandonment TO " +
        role,
    );
    await admin.query(
      "GRANT UPDATE,DELETE,TRUNCATE ON rms_catalog.option_set_authoring_identity,rms_catalog.option_set_authoring_abandonment TO " +
        role,
    );
    const original = create("RECOVERY_ORIGINAL");
    // Metadata is produced exclusively by the real owning writer, not by a fixture callback.
    afterWork = async (tx) => {
      const row = (
        await tx.query(
          `SELECT i.identity_json,i.xmin::text identity_xid,s.xmin::text source_xid,o.xmin::text operation_xid,mod(pg_current_xact_id()::text::numeric,4294967296)::text current_xid FROM rms_catalog.option_set_authoring_identity i JOIN rms_catalog.option_set_draft_content_snapshot s ON s.operation_id=i.operation_id JOIN rms_catalog.option_set_operation_record o ON o.operation_id=i.operation_id WHERE i.operation_id=$1`,
          [original.operationReference],
        )
      ).rows[0];
      assert(row);
      assert.equal(row.identity_xid, row.current_xid);
      assert.equal(row.source_xid, row.current_xid);
      assert.equal(row.operation_xid, row.current_xid);
      assert.equal(
        row.identity_json.auditReference,
        auditInputs.get(original.operationReference).auditId,
      );
    };
    const created = await writer().create(original),
      set = created.content.sourceAggregate.optionSetReference;
    const old = created.content.sourceAggregate.draft.options[0];
    assert(old);
    const edit = {
      optionSetReference: set,
      expectedAggregateVersion: 1,
      draft: {
        ...original.draft,
        options: [{ ...original.draft.options[0], stableCode: "TWO", identity: { kind: "New" } }],
      },
      additionalContent: {
        ...original.additionalContent,
        optionDetails: [{ ...original.additionalContent.optionDetails[0], stableCode: "TWO" }],
      },
      archiveOptionReferences: [old.optionReference],
      operationReference: reference(),
      occurredAt: at,
      reasonCode: "SYNTHETIC_OTHER_ACTOR",
    };
    const changed = await writer(editor).edit(edit),
      added = changed.content.sourceAggregate.draft.options.find((o) => o.stableCode === "TWO");
    assert(added);
    const next = {
      ...edit,
      expectedAggregateVersion: 2,
      operationReference: reference(),
      draft: { ...edit.draft, options: [{ ...edit.draft.options[0], stableCode: "THREE" }] },
      additionalContent: {
        ...edit.additionalContent,
        optionDetails: [{ ...edit.additionalContent.optionDetails[0], stableCode: "THREE" }],
      },
      archiveOptionReferences: [old.optionReference, added.optionReference],
    };
    const latest = await writer(editor).edit(next);
    const baseline = await counts();
    for (const [full, who, action, expected] of [
      [original, actor, "Create", created],
      [edit, editor, "Edit", changed],
    ]) {
      const c = command(full, who, action),
        receipt = await resolve(c);
      assert.equal(receipt.resolution.outcome, "Committed");
      assert.deepEqual(receipt.content, expected.content);
      assert.equal(receipt.resolution.recordedAt, full.occurredAt);
      assert.equal(
        receipt.resolution.identity.auditReference,
        auditInputs.get(full.operationReference).auditId,
      );
      assert.equal(receipt.resolution.identity.command.actorReference, who);
      const originalRead = await transactions.run((tx) =>
        resolution(who).withOriginalOperation(tx, c, async (packet) => packet),
      );
      assert.equal(originalRead.outcome, "Committed");
      assert.deepEqual(originalRead.identity, receipt.resolution.identity);
      assert.deepEqual(originalRead.content, expected.content);
      const replay = await writer(who)[action === "Create" ? "create" : "edit"](full);
      assert.equal(replay.status, "Replayed");
      assert.deepEqual(replay.content, expected.content);
      assert.deepEqual(await resolve(c), receipt);
      await assert.rejects(
        resolve({ ...c, actorReference: who === actor ? editor : actor }),
        publicRefusal,
      );
      await assert.rejects(resolve({ ...c, reasonCode: "SYNTHETIC_CHANGED" }), publicRefusal);
      if (action === "Edit")
        await assert.rejects(resolve({ ...c, expectedAggregateVersion: 2 }), publicRefusal);
    }
    assert.deepEqual(await counts(), baseline);
    // Fresh current-authority withdrawal rolls back source, identity, Audit and Outbox.
    afterWork = async () => {
      allowed = false;
    };
    await assert.rejects(
      writer().create(create("LATE_DENIED")),
      (error) => error.code === "CATALOG_PERMISSION_DENIED",
    );
    allowed = true;
    assert.deepEqual(await counts(), baseline);
    afterWork = async () => {
      allowed = false;
    };
    await assert.rejects(
      resolve(command(create("LATE_RESOLVE_DENIED"))),
      (error) => error.code === "CATALOG_PERMISSION_DENIED",
    );
    allowed = true;
    assert.deepEqual(await counts(), baseline);
    // A visible original in another Tenant or Brand is not an empty operation.
    for (const [selectedTenant, selectedBrand] of [
      [id(900), brand],
      [tenant, id(901)],
    ]) {
      await assert.rejects(
        resolve(command(original, actor, "Create", selectedTenant, selectedBrand)),
        publicRefusal,
      );
    }
    assert.deepEqual(await counts(), baseline);
    for (const writerFirst of [true, false]) {
      const full = create(writerFirst ? "WRITER_FIRST" : "RESOLVER_FIRST"),
        c = command(full),
        before = await counts();
      const held = Promise.withResolvers(),
        release = Promise.withResolvers(),
        capture = { started: 0, pids: [] };
      let first, second;
      const primaryFailures = [],
        cleanupFailures = [];
      raceCapture = capture;
      afterWork = async () => {
        held.resolve();
        await bounded(release.promise);
      };
      try {
        first = settled(writerFirst ? () => writer().create(full) : () => resolve(c));
        await bounded(held.promise);
        second = settled(writerFirst ? () => resolve(c) : () => writer().create(full));
        let blocked = false;
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !blocked) {
          const observation = await admin.query({
            text: "SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1",
            values: [capture.pids[1] ?? 0],
            query_timeout: 10000,
          });
          const row = observation.rows[0];
          blocked = row?.wait_event_type === "Lock" && row.blockers.includes(capture.pids[0]);
        }
        assert.equal(capture.started, 2);
        assert.equal(blocked, true, "Contender must block on the actual winner backend");
        release.resolve();
        const winner = await bounded(first);
        if (winner.error) throw winner.error;
        const loser = await bounded(second);
        raceCapture = null;
        if (writerFirst) {
          if (loser.error) throw loser.error;
          assert.equal(loser.value.resolution.outcome, "Committed");
          assert.deepEqual(loser.value.content, winner.value.content);
          assert.equal(
            loser.value.resolution.identity.auditReference,
            auditInputs.get(full.operationReference).auditId,
          );
          assert.deepEqual(await resolve(c), loser.value);
        } else {
          assert.equal(winner.value.resolution.outcome, "Abandoned");
          assert.equal(winner.value.content, null);
          assert(loser.error);
          assert.equal(loser.error.code, "CATALOG_IDEMPOTENCY_CONFLICT");
          assert.deepEqual(await resolve(c), winner.value);
          await assert.rejects(writer().create(full), publicRefusal);
        }
        const after = await counts();
        for (const key of [
          "sets",
          "versions",
          "options",
          "operations",
          "snapshots",
          "identities",
          "outbox",
        ])
          assert.equal(after[key], before[key] + (writerFirst ? 1 : 0), key);
        assert.equal(after.fences, before.fences + (writerFirst ? 0 : 1));
        assert.equal(after.audit, before.audit + 1);
        if (!writerFirst) assert.deepEqual(after.roots, before.roots);
      } catch (error) {
        primaryFailures.push(error);
      } finally {
        release.resolve();
        try {
          await bounded(Promise.all([first, second].filter(Boolean)));
        } catch (error) {
          cleanupFailures.push(error);
          // Only the two backends opened by this race are eligible for cleanup.
          // Attempt every cleanup even when one termination itself fails.
          for (const pid of capture.pids) {
            try {
              await admin.query({
                text: "SELECT pg_terminate_backend($1)",
                values: [pid],
                query_timeout: 10000,
              });
            } catch (terminationError) {
              cleanupFailures.push(terminationError);
            }
          }
          try {
            await bounded(Promise.all([first, second].filter(Boolean)));
          } catch (settlementError) {
            cleanupFailures.push(settlementError);
          }
        } finally {
          raceCapture = null;
          afterWork = null;
        }
      }
      const failures = [...primaryFailures, ...cleanupFailures];
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Synthetic Option recovery race and cleanup failed");
    }
    const absentFull = create("PERMANENT_ABSENCE"),
      absent = command(absentFull),
      beforeContext = await counts();
    assert.deepEqual(
      await transactions.run((tx) =>
        resolution().withOriginalOperation(tx, absent, async (packet) => packet),
      ),
      { outcome: "Absent" },
    );
    assert.deepEqual(await counts(), beforeContext);
    const abandoned = await resolve(absent),
      fenced = await counts();
    assert.equal(abandoned.resolution.outcome, "Abandoned");
    await assert.rejects(writer().create(absentFull), publicRefusal);
    await assert.rejects(resolve({ ...absent, actorReference: editor }), publicRefusal);
    await assert.rejects(resolve({ ...absent, reasonCode: "SYNTHETIC_CHANGED" }), publicRefusal);
    await assert.rejects(resolve({ ...absent, brandReference: id(901) }), publicRefusal);
    assert.deepEqual(await counts(), fenced);
    // Direct negative attacks operate on real original rows; no fabricated successful identity.
    for (const table of ["option_set_authoring_identity", "option_set_authoring_abandonment"]) {
      const op = table.endsWith("identity")
        ? original.operationReference
        : absent.operationReference;
      for (const statement of [
        "UPDATE rms_catalog." + table + " SET reason_code='SYNTHETIC_TAMPER' WHERE operation_id=$1",
        "DELETE FROM rms_catalog." + table + " WHERE operation_id=$1",
        "TRUNCATE rms_catalog." + table,
      ]) {
        await assert.rejects(
          transactions.run(async (tx) => {
            assert.equal(
              (
                await tx.query(
                  "SELECT operation_id FROM rms_catalog." + table + " WHERE operation_id=$1",
                  [op],
                )
              ).rowCount,
              1,
            );
            await tx.query(statement, statement.startsWith("TRUNCATE") ? [] : [op]);
          }),
          (error) => error.code === "55000",
        );
      }
      for (const [selectedTenant, selectedBrand, store] of [
        [id(900), brand, ""],
        [tenant, id(901), ""],
        [tenant, brand, id(902)],
      ]) {
        await transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [selectedTenant, selectedBrand, store],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT operation_id FROM rms_catalog." + table + " WHERE operation_id=$1",
                [op],
              )
            ).rowCount,
            0,
          );
        });
      }
    }
    await assert.rejects(
      transactions.run(async (tx) => {
        assert.equal(
          (
            await tx.query(
              "SELECT operation_id FROM rms_catalog.option_set_authoring_identity WHERE operation_id=$1",
              [original.operationReference],
            )
          ).rowCount,
          1,
        );
        await tx.query(
          "INSERT INTO rms_catalog.option_set_authoring_identity SELECT * FROM rms_catalog.option_set_authoring_identity WHERE operation_id=$1",
          [original.operationReference],
        );
      }),
      (error) =>
        error.code === "23514" && error.message === "OPTION_SET_AUTHORING_LEGACY_SOURCE_REFUSED",
    );
    const beforeTamper = await counts(),
      tampered = create("SAME_TX_TAMPER");
    afterWork = async (tx) => {
      assert.equal(
        (
          await tx.query(
            "SELECT operation_id FROM rms_catalog.option_set_authoring_identity WHERE operation_id=$1",
            [tampered.operationReference],
          )
        ).rowCount,
        1,
      );
      await tx.query(
        `INSERT INTO rms_catalog.option_set_authoring_identity(operation_id,tenant_id,brand_id,actor_id,action_code,reason_code,requested_option_set_id,expected_aggregate_version,audit_id,data_classification,option_set_id,option_set_version_id,source_operation_id,source_action_code,result_aggregate_version,original_occurred_at,intent_digest,source_digest,content_digest,configuration_digest,identity_digest,identity_json)
        SELECT operation_id,tenant_id,brand_id,actor_id,action_code,reason_code,requested_option_set_id,expected_aggregate_version,$2,data_classification,option_set_id,option_set_version_id,source_operation_id,source_action_code,result_aggregate_version,original_occurred_at,intent_digest,source_digest,content_digest,$3,identity_digest,jsonb_set(identity_json,'{configurationDigest}',to_jsonb($3::text))
        FROM rms_catalog.option_set_authoring_identity WHERE operation_id=$1`,
        [tampered.operationReference, reference(), "sha256:" + "f".repeat(64)],
      );
    };
    await assert.rejects(
      writer().create(tampered),
      (error) => error.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    assert.equal(lastSqlState, "23514");
    assert.equal(lastSqlReason, "OPTION_SET_AUTHORING_SOURCE_INVALID");
    assert.deepEqual(await counts(), beforeTamper);
    // Existing low-level replace deliberately has no ordinary authoring identity.
    const { sourceAggregate: latestSource, ...latestDetails } = latest.content;
    const legacy = {
      optionSetReference: set,
      expectedAggregateVersion: 3,
      draft: latestSource.draft,
      additionalContent: latestDetails,
      operationReference: reference(),
      occurredAt: at,
      reasonCode: "SYNTHETIC_LEGACY_REPLACE",
    };
    await writer().replace(legacy);
    const legacyCounts = await counts();
    assert.equal(
      (
        await admin.query(
          "SELECT operation_id FROM rms_catalog.option_set_authoring_identity WHERE operation_id=$1",
          [legacy.operationReference],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(resolve(command(legacy, actor, "Edit")), publicRefusal);
    assert.deepEqual(await counts(), legacyCounts);
    const originalLegacyAudit = auditInputs.get(legacy.operationReference);
    assert(originalLegacyAudit);
    await assert.rejects(
      transactions.run(async (tx) => {
        const snapshot = (
          await tx.query(
            "SELECT * FROM rms_catalog.option_set_draft_content_snapshot WHERE operation_id=$1",
            [legacy.operationReference],
          )
        ).rows[0];
        assert(snapshot);
        assert.equal(snapshot.action_code, "ReplaceDraft");
        // Deliberately attempted legacy backfill from the actual source and retained
        // actual Audit input. This raw negative attack must never produce identity.
        const attempted = createCatalogOptionSetAuthoringIdentity({
          command: command(legacy, actor, "Edit"),
          sourceOperationReference: legacy.operationReference,
          optionSetReference: set,
          versionReference: snapshot.option_set_version_id,
          aggregateVersion: snapshot.result_aggregate_version,
          originalOccurredAt: legacy.occurredAt,
          auditReference: originalLegacyAudit.auditId,
          originalIntentDigest: snapshot.intent_digest,
          sourceDigest: snapshot.source_digest,
          contentDigest: snapshot.content_digest,
          configurationDigest: snapshot.configuration_digest,
        });
        await tx.query(
          `INSERT INTO rms_catalog.option_set_authoring_identity(operation_id,tenant_id,brand_id,actor_id,action_code,reason_code,requested_option_set_id,expected_aggregate_version,option_set_id,option_set_version_id,source_operation_id,source_action_code,intent_digest,result_aggregate_version,original_occurred_at,audit_id,source_digest,content_digest,configuration_digest,identity_json,identity_digest)
        VALUES($1,$2,$3,$4,'Edit',$5,$6,3,$6,$7,$1,'ReplaceDraft',$8,4,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
          [
            legacy.operationReference,
            tenant,
            brand,
            actor,
            legacy.reasonCode,
            set,
            snapshot.option_set_version_id,
            snapshot.intent_digest,
            at,
            originalLegacyAudit.auditId,
            snapshot.source_digest,
            snapshot.content_digest,
            snapshot.configuration_digest,
            canonicalizeRfc8785(attempted),
            attempted.digest,
          ],
        );
      }),
      (error) =>
        error.code === "23514" && error.message === "OPTION_SET_AUTHORING_LEGACY_SOURCE_REFUSED",
    );
    assert.deepEqual(await counts(), legacyCounts);
  } finally {
    afterWork = null;
    raceCapture = null;
    try {
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

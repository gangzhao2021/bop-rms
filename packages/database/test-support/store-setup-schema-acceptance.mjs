import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseStoreSetupDraft, storeSetupDraftContentFields } from "../../rms/store/src/index.ts";

const id = (n) => "01902421-1009-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T14:00:00.000Z";
const later = "2026-10-05T14:00:01.000Z";
const scope = { tenant: id(1), brand: id(2), store: id(3) };
const tables = "rms_store.store_setup_draft_revision,rms_store.store_setup_draft_operation";
const flush =
  "SET CONSTRAINTS rms_store.store_setup_revision_coherence,rms_store.store_setup_operation_coherence IMMEDIATE";

/** Controlled metadata exercises the actual schema only. No IAM, Audit append,
 * business-reference eligibility or ordinary workflow is asserted by this fixture. */
export async function verifyStoreSetupSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_setup_" + context.runId;
  let roleCreated = false;
  await admin.connect();
  const setScope = async (selected = scope) => {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [selected.tenant, selected.brand, selected.store],
    );
  };
  const transaction = async (work, { selected = scope, commit = false } = {}) => {
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query("SET LOCAL statement_timeout='5s'");
      await admin.query("SET LOCAL lock_timeout='5s'");
      await setScope(selected);
      const result = await work();
      await admin.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  const snapshot = (revision, actor = id(4)) =>
    parseStoreSetupDraft({
      profile: "StoreSetupDraftV1",
      setupDraftReference: id(5),
      tenantReference: scope.tenant,
      brandReference: scope.brand,
      storeReference: scope.store,
      revision,
      authoredByReference: actor,
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: null,
      content: Object.fromEntries(
        storeSetupDraftContentFields.map((field) => [field, { state: "Unconfigured" }]),
      ),
      createdAt: at,
      updatedAt: revision === 1 ? at : later,
      purposeCode: "STORE_SETUP_DRAFT",
      dataClassification: "ConfigurationMetadata",
    });
  const state = (revision, operation, actor = id(4)) => {
    const value = snapshot(revision, actor);
    return {
      snapshot: value,
      operation: id(operation),
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
      actor,
    };
  };
  const insertRevision = async (value, overrides = {}) => {
    const s = value.snapshot;
    const row = {
      tenant: scope.tenant,
      brand: scope.brand,
      store: scope.store,
      setup: s.setupDraftReference,
      revision: s.revision,
      operation: value.operation,
      actor: value.actor,
      snapshot: s,
      digest: value.digest,
      created: s.createdAt,
      updated: s.updatedAt,
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_store.store_setup_draft_revision(tenant_id,brand_id,store_id,setup_draft_id,revision,operation_id,actor_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'ConfigurationMetadata')",
      [
        row.tenant,
        row.brand,
        row.store,
        row.setup,
        row.revision,
        row.operation,
        row.actor,
        JSON.stringify(row.snapshot),
        row.digest,
        row.created,
        row.updated,
      ],
    );
  };
  const insertOperation = async (value, overrides = {}) => {
    const s = value.snapshot;
    const row = {
      operation: value.operation,
      tenant: scope.tenant,
      brand: scope.brand,
      store: scope.store,
      actor: value.actor,
      expectedSetup: s.revision === 1 ? null : s.setupDraftReference,
      expectedRevision: s.revision - 1,
      outcome: "Committed",
      resultSetup: s.setupDraftReference,
      resultRevision: s.revision,
      digest: value.digest,
      audit: id(Number.parseInt(value.operation.slice(-12), 16) + 10000),
      occurred: s.updatedAt,
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_store.store_setup_draft_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_setup_id,expected_revision,outcome,result_setup_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ConfigurationMetadata')",
      [
        row.operation,
        row.tenant,
        row.brand,
        row.store,
        row.actor,
        "sha256:" + "a".repeat(64),
        row.expectedSetup,
        row.expectedRevision,
        row.outcome,
        row.resultSetup,
        row.resultRevision,
        row.digest,
        row.audit,
        row.occurred,
      ],
    );
  };
  const pair = async (value, revisionOverrides = {}, operationOverrides = {}) => {
    await insertRevision(value, revisionOverrides);
    await insertOperation(value, operationOverrides);
    await admin.query(flush);
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_store.store_setup_draft_revision) AS revisions,(SELECT count(*)::text FROM rms_store.store_setup_draft_operation) AS operations",
      )
    ).rows[0];
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await counts();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.deepEqual(
      await counts(),
      before,
      "Rejected raw Store Setup transaction left an artifact",
    );
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_store,platform_helpers TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT ON " + tables + " TO " + role);
    const first = state(1, 101),
      second = state(2, 102, id(6));
    await transaction(() => pair(first), { commit: true });
    await transaction(() => pair(second), { commit: true });
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT snapshot_json FROM rms_store.store_setup_draft_revision ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => parseStoreSetupDraft(row.snapshot_json)),
        [first.snapshot, second.snapshot],
      );
      assert.equal(
        rows[1].snapshot_json.setupDraftReference,
        rows[0].snapshot_json.setupDraftReference,
      );
      assert.equal(rows[1].snapshot_json.createdAt, rows[0].snapshot_json.createdAt);
      assert.notEqual(
        rows[1].snapshot_json.authoredByReference,
        rows[0].snapshot_json.authoredByReference,
      );
    });
    let next = 200;
    const candidate = () => state(3, ++next);
    await rejected(async () => {
      await insertOperation(candidate());
      await admin.query(flush);
    });
    await rejected(async () => {
      await insertRevision(candidate());
      await admin.query(flush);
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { resultRevision: null });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { actor: id(99) });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { digest: "sha256:" + "b".repeat(64) });
    });
    for (const mutate of [
      (value) => ({ ...value, content: { ...value.content, addressReference: { value: id(77) } } }),
      (value) => ({ ...value, contactEmail: "Synthetic forbidden metadata" }),
      (value) => ({
        ...value,
        content: { ...value.content, contactEmail: { state: "Unconfigured" } },
      }),
    ])
      await rejected(async () => {
        const v = candidate();
        await pair(v, { snapshot: mutate(v.snapshot) });
      });
    await rejected(async () => {
      const v = candidate();
      await pair(v, { updated: "2026-10-05T14:00:01.000123Z" });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { occurred: "2026-10-05T14:00:01.000123Z" });
    });
    await rejected(async () => {
      const v = candidate(),
        changed = { ...v.snapshot, setupDraftReference: id(88) };
      await pair({ ...v, snapshot: changed }, {}, { expectedSetup: id(88) });
    });
    await rejected(async () => {
      const v = candidate(),
        skipped = { ...v.snapshot, revision: 4 };
      await pair({ ...v, snapshot: skipped });
    });
    await rejected(async () => {
      const v = candidate();
      await pair({ ...v, operation: first.operation });
    }, ["23505", "23514"]);
    for (const key of ["tenant", "brand", "store"]) {
      const selected = { ...scope, [key]: id(90) };
      await transaction(
        async () => {
          assert.deepEqual(
            (await admin.query("SELECT operation_id FROM rms_store.store_setup_draft_operation"))
              .rows,
            [],
          );
          assert.deepEqual(
            (await admin.query("SELECT operation_id FROM rms_store.store_setup_draft_revision"))
              .rows,
            [],
          );
        },
        { selected },
      );
      await rejected(async () => pair(candidate()), ["55000", "42501"], { selected });
    }
    await rejected(async () => {
      const v = candidate();
      await insertRevision(v);
      await insertOperation(v);
      await setScope({ ...scope, store: id(90) });
      await admin.query(flush);
    }, ["55000"]);
    await transaction(async () => {
      const v = candidate();
      await insertRevision(v);
      await insertOperation(v);
      await setScope({ ...scope, store: id(90) });
      await setScope();
      await admin.query(flush);
    });
    const abandoned = candidate();
    await transaction(
      async () => {
        await insertOperation(abandoned, {
          outcome: "Abandoned",
          resultSetup: null,
          resultRevision: null,
          digest: null,
        });
        await admin.query(flush);
      },
      { commit: true },
    );
    await rejected(async () => pair(abandoned), ["23505", "23514"]);
    await rejected(
      async () => {
        await insertOperation(candidate(), {
          operation: first.operation,
          tenant: id(90),
          brand: id(91),
          store: id(92),
          outcome: "Abandoned",
          resultSetup: null,
          resultRevision: null,
          digest: null,
        });
        await admin.query(flush);
      },
      ["23505"],
      { selected: { tenant: id(90), brand: id(91), store: id(92) } },
    );
    // The attack grant is isolated fixture-only; ordinary callers receive SELECT/INSERT.
    await admin.query("GRANT UPDATE,DELETE,TRUNCATE ON " + tables + " TO " + role);
    for (const table of ["store_setup_draft_revision", "store_setup_draft_operation"]) {
      for (const statement of [
        "UPDATE rms_store." + table + " SET data_classification='ConfigurationMetadata'",
        "DELETE FROM rms_store." + table,
        "TRUNCATE rms_store." + table + " CASCADE",
      ]) {
        await rejected(async () => {
          assert.ok(
            (await admin.query("SELECT operation_id FROM rms_store." + table)).rows.length > 0,
          );
          await admin.query(statement);
        }, ["55000"]);
      }
    }
    assert.deepEqual(await counts(), { revisions: "2", operations: "3" });

    // 011: controlled classification UUIDs are syntactically valid metadata,
    // not Catalog registration, IAM admission, effective fees or Tax eligibility.
    const historicalV1 = (
      await admin.query(
        "SELECT snapshot_json::text AS bytes,snapshot_digest FROM rms_store.store_setup_draft_revision WHERE revision IN (1,2) ORDER BY revision",
      )
    ).rows;
    const feeContexts = () => ({
      state: "Configured",
      value: [
        {
          chargeType: "ServiceCharge",
          state: "Enabled",
          taxClassificationReference: id(501),
          orderTypes: ["DineIn", "Pickup"],
        },
        {
          chargeType: "DeliveryFee",
          state: "Enabled",
          taxClassificationReference: id(502),
          orderTypes: ["Delivery"],
        },
        {
          chargeType: "Tip",
          state: "Enabled",
          taxClassificationReference: id(503),
          orderTypes: ["DineIn", "Pickup", "Delivery"],
        },
      ],
    });
    const v2State = (revision, operation, fees = feeContexts()) => {
      const value = parseStoreSetupDraft({
        ...snapshot(revision, id(7)),
        profile: "StoreSetupDraftV2",
        content: { ...snapshot(revision, id(7)).content, feeContexts: fees },
      });
      return {
        snapshot: value,
        operation: id(operation),
        actor: id(7),
        digest: "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
      };
    };
    const v2 = v2State(3, 401);
    await transaction(() => pair(v2), { commit: true });
    await transaction(async () => {
      const rows = (
        await admin.query(
          "SELECT snapshot_json,snapshot_digest FROM rms_store.store_setup_draft_revision WHERE revision=3",
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(parseStoreSetupDraft(rows[0].snapshot_json), v2.snapshot);
      assert.equal(rows[0].snapshot_digest, v2.digest);
      const originals = (
        await admin.query(
          "SELECT result_setup_id,result_revision::text,actor_id,snapshot_digest FROM rms_store.store_setup_draft_operation WHERE operation_id=$1",
          [v2.operation],
        )
      ).rows;
      assert.equal(originals.length, 1);
      assert.equal(originals[0].result_setup_id, v2.snapshot.setupDraftReference);
      assert.equal(originals[0].result_revision, "3");
      assert.equal(originals[0].actor_id, v2.actor);
      assert.equal(originals[0].snapshot_digest, v2.digest);
    });
    let feeOperation = 410;
    const malformedFees = [
      null,
      { state: "Configured", value: null },
      { state: "Unconfigured", value: [] },
      { state: "Inherited" },
      { state: "Configured", value: [] },
      { state: "Configured", value: feeContexts().value.slice().reverse() },
      { state: "Configured", value: [null, ...feeContexts().value.slice(1)] },
      {
        state: "Configured",
        value: [{ chargeType: "ServiceCharge", state: "Unknown" }, ...feeContexts().value.slice(1)],
      },
      {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Disabled", rate: "0" },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Enabled", orderTypes: ["Pickup"] },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [
          { ...feeContexts().value[0], taxClassificationReference: null },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [
          { ...feeContexts().value[0], taxClassificationReference: "not-a-reference" },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [{ ...feeContexts().value[0], orderTypes: [] }, ...feeContexts().value.slice(1)],
      },
      {
        state: "Configured",
        value: [
          { ...feeContexts().value[0], orderTypes: ["Pickup", "Pickup"] },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [
          { ...feeContexts().value[0], orderTypes: ["Pickup", "DineIn"] },
          ...feeContexts().value.slice(1),
        ],
      },
      {
        state: "Configured",
        value: [
          { ...feeContexts().value[0], orderTypes: ["Unknown"] },
          ...feeContexts().value.slice(1),
        ],
      },
      { ...feeContexts(), professionalStatus: "Approved" },
    ];
    for (const fees of malformedFees)
      await rejected(async () => {
        const raw = v2State(4, ++feeOperation);
        const changed = {
          ...raw.snapshot,
          content: { ...raw.snapshot.content, feeContexts: fees },
        };
        await pair({
          ...raw,
          snapshot: changed,
          digest: "sha256:" + sha256Hex(canonicalizeRfc8785(changed)),
        });
      });
    await rejected(async () => {
      const raw = v2State(4, ++feeOperation);
      const { feeContexts: ignored, ...content } = raw.snapshot.content;
      void ignored;
      const changed = { ...raw.snapshot, content };
      await pair({
        ...raw,
        snapshot: changed,
        digest: "sha256:" + sha256Hex(canonicalizeRfc8785(changed)),
      });
    });
    await rejected(async () => {
      const raw = v2State(4, ++feeOperation);
      const changed = { ...raw.snapshot, profile: "StoreSetupDraftV1" };
      await pair({
        ...raw,
        snapshot: changed,
        digest: "sha256:" + sha256Hex(canonicalizeRfc8785(changed)),
      });
    });
    // A formerly valid exact V1 revision cannot discard the committed V2 field.
    await rejected(async () => pair(state(4, ++feeOperation)));
    await rejected(async () => pair(v2State(4, ++feeOperation), {}, { actor: id(99) }));
    await rejected(async () =>
      pair(v2State(4, ++feeOperation), {}, { digest: "sha256:" + "b".repeat(64) }),
    );
    await transaction(async () => {
      const explicit = v2State(4, ++feeOperation, {
        state: "Configured",
        value: [
          { chargeType: "ServiceCharge", state: "Disabled" },
          { chargeType: "DeliveryFee", state: "Unconfigured" },
          { chargeType: "Tip", state: "Disabled" },
        ],
      });
      await pair(explicit);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT snapshot_json->'content'->'feeContexts' AS fees FROM rms_store.store_setup_draft_revision WHERE revision=4",
          )
        ).rows[0].fees,
        explicit.snapshot.content.feeContexts,
      );
    });
    assert.deepEqual(
      (
        await admin.query(
          "SELECT snapshot_json::text AS bytes,snapshot_digest FROM rms_store.store_setup_draft_revision WHERE revision IN (1,2) ORDER BY revision",
        )
      ).rows,
      historicalV1,
      "011 altered historical V1 bytes or digests",
    );
    assert.deepEqual(await counts(), { revisions: "3", operations: "4" });
  } finally {
    await admin.query("ROLLBACK");
    await admin.query("RESET ROLE");
    if (roleCreated) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}

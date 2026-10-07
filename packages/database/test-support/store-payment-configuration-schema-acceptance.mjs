import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseStorePaymentConfigurationVersion } from "../../rms/payment/src/contracts/store-payment-configuration.ts";

const id = (n) => "01902421-1424-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T14:00:00.000Z";
const later = "2026-10-05T14:00:01.000Z";
const scope = { tenant: id(1), brand: id(2), store: id(3) };
const tables =
  "rms_payment.store_payment_configuration_version,rms_payment.store_payment_configuration_operation";
const flush =
  "SET CONSTRAINTS rms_payment.store_payment_configuration_version_coherence,rms_payment.store_payment_configuration_operation_coherence IMMEDIATE";

/** Controlled metadata exercises the actual schema only. No IAM, Audit append,
 * Provider account/readiness, business-reference eligibility or ordinary workflow
 * is asserted by this fixture. */
export async function verifyStorePaymentConfigurationSchema(context) {
  const admin = new pg.Client(context.clientConfig),
    role = "wp2421_payment_cfg_" + context.runId;
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
    parseStorePaymentConfigurationVersion({
      profile: "StorePaymentConfigurationV1",
      configurationReference: id(50 + revision),
      tenantReference: scope.tenant,
      brandReference: scope.brand,
      storeReference: scope.store,
      revision,
      authoredByReference: actor,
      previousConfigurationReference: revision === 1 ? null : id(50 + revision - 1),
      content: {
        customerOnlineCardEnabled: revision === 1,
        staffTerminalCardPresentEnabled: false,
        staffTerminalInteracEnabled: false,
      },
      currencyCode: "CAD",
      createdAt: at,
      updatedAt: revision === 1 ? at : later,
      dataClassification: "Internal",
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
  const insertVersion = async (value, overrides = {}) => {
    const s = value.snapshot;
    const row = {
      tenant: scope.tenant,
      brand: scope.brand,
      store: scope.store,
      reference: s.configurationReference,
      previous: s.previousConfigurationReference,
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
      "INSERT INTO rms_payment.store_payment_configuration_version(tenant_id,brand_id,store_id,configuration_id,revision,operation_id,actor_id,previous_configuration_id,snapshot_json,snapshot_digest,created_at,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'Internal')",
      [
        row.tenant,
        row.brand,
        row.store,
        row.reference,
        row.revision,
        row.operation,
        row.actor,
        row.previous,
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
      expectedReference: s.previousConfigurationReference,
      expectedRevision: s.revision - 1,
      outcome: "Committed",
      resultReference: s.configurationReference,
      resultRevision: s.revision,
      digest: value.digest,
      audit: id(Number.parseInt(value.operation.slice(-12), 16) + 10000),
      occurred: s.updatedAt,
      ...overrides,
    };
    await admin.query(
      "INSERT INTO rms_payment.store_payment_configuration_operation(operation_id,tenant_id,brand_id,store_id,actor_id,intent_digest,expected_configuration_id,expected_revision,outcome,result_configuration_id,result_revision,snapshot_digest,audit_reference,occurred_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Internal')",
      [
        row.operation,
        row.tenant,
        row.brand,
        row.store,
        row.actor,
        "sha256:" + "a".repeat(64),
        row.expectedReference,
        row.expectedRevision,
        row.outcome,
        row.resultReference,
        row.resultRevision,
        row.digest,
        row.audit,
        row.occurred,
      ],
    );
  };
  const pair = async (value, revisionOverrides = {}, operationOverrides = {}) => {
    await insertVersion(value, revisionOverrides);
    await insertOperation(value, operationOverrides);
    await admin.query(flush);
  };
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::text FROM rms_payment.store_payment_configuration_version) AS revisions,(SELECT count(*)::text FROM rms_payment.store_payment_configuration_operation) AS operations",
      )
    ).rows[0];
  const rejected = async (work, codes = ["23514"], options = {}) => {
    const before = await counts();
    await assert.rejects(transaction(work, options), (error) => codes.includes(error.code));
    assert.deepEqual(
      await counts(),
      before,
      "Rejected raw Store Payment Configuration transaction left an artifact",
    );
  };
  try {
    await admin.query("CREATE ROLE " + role + " NOLOGIN");
    roleCreated = true;
    await admin.query("GRANT USAGE ON SCHEMA rms_payment,platform_helpers TO " + role);
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
          "SELECT snapshot_json FROM rms_payment.store_payment_configuration_version ORDER BY revision",
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => parseStorePaymentConfigurationVersion(row.snapshot_json)),
        [first.snapshot, second.snapshot],
      );
      assert.notEqual(
        rows[1].snapshot_json.configurationReference,
        rows[0].snapshot_json.configurationReference,
      );
      assert.equal(
        rows[1].snapshot_json.previousConfigurationReference,
        rows[0].snapshot_json.configurationReference,
      );
      assert.equal(rows[1].snapshot_json.createdAt, rows[0].snapshot_json.createdAt);
      assert.notEqual(
        rows[1].snapshot_json.authoredByReference,
        rows[0].snapshot_json.authoredByReference,
      );
    });
    assert.deepEqual(
      second.snapshot.content,
      {
        customerOnlineCardEnabled: false,
        staffTerminalCardPresentEnabled: false,
        staffTerminalInteracEnabled: false,
      },
      "All-false saved configuration does not manufacture Provider readiness",
    );
    // New immutable configuration IDs cannot borrow any existing scope's ID.
    await rejected(async () => {
      const value = state(3, 191),
        reused = {
          ...value.snapshot,
          configurationReference: first.snapshot.configurationReference,
        };
      await pair({ ...value, snapshot: reused });
    }, ["23505"]);
    await rejected(async () => {
      await insertOperation(first, { operation: id(192), audit: id(10192) });
      await admin.query(flush);
    });
    let next = 200;
    const candidate = () => state(3, ++next);
    await rejected(async () => {
      await insertOperation(candidate());
      await admin.query(flush);
    });
    await rejected(async () => {
      await insertVersion(candidate());
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
      await pair(v, {
        previous: null,
        snapshot: { ...v.snapshot, previousConfigurationReference: null },
      });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { digest: "sha256:" + "b".repeat(64) });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, {}, { expectedReference: first.snapshot.configurationReference });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, { snapshot: { ...v.snapshot, authoredByReference: id(99) } });
    });
    await rejected(async () => {
      const v = candidate();
      await pair(v, { created: later, snapshot: { ...v.snapshot, createdAt: later } });
    });
    for (const mutate of [
      (value) => ({ ...value, content: { ...value.content, customerOnlineCardEnabled: null } }),
      (value) => ({
        ...value,
        content: { ...value.content, staffTerminalCardPresentEnabled: "false" },
      }),
      (value) => ({
        ...value,
        content: { customerOnlineCardEnabled: true, staffTerminalCardPresentEnabled: false },
      }),
      (value) => ({ ...value, content: { ...value.content, staffTerminalInteracEnabled: 1 } }),
      (value) => ({ ...value, content: { ...value.content, cashEnabled: true } }),
      (value) => ({
        ...value,
        content: { ...value.content, providerCredential: "Synthetic forbidden metadata" },
      }),
      (value) => ({ ...value, providerReady: true }),
      (value) => ({ ...value, currencyCode: "USD" }),
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
      const v = candidate();
      await pair(
        v,
        { previous: id(88), snapshot: { ...v.snapshot, previousConfigurationReference: id(88) } },
        { expectedReference: id(88) },
      );
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
            (
              await admin.query(
                "SELECT operation_id FROM rms_payment.store_payment_configuration_operation",
              )
            ).rows,
            [],
          );
          assert.deepEqual(
            (
              await admin.query(
                "SELECT operation_id FROM rms_payment.store_payment_configuration_version",
              )
            ).rows,
            [],
          );
        },
        { selected },
      );
      await rejected(async () => pair(candidate()), ["55000", "42501"], { selected });
    }
    await rejected(async () => {
      const v = candidate();
      await insertVersion(v);
      await insertOperation(v);
      await setScope({ ...scope, store: id(90) });
      await admin.query(flush);
    }, ["55000"]);
    await transaction(async () => {
      const v = candidate();
      await insertVersion(v);
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
          resultReference: null,
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
          resultReference: null,
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
    for (const table of [
      "store_payment_configuration_version",
      "store_payment_configuration_operation",
    ]) {
      for (const statement of [
        "UPDATE rms_payment." + table + " SET data_classification='Internal'",
        "DELETE FROM rms_payment." + table,
        "TRUNCATE rms_payment." + table + " CASCADE",
      ]) {
        await rejected(async () => {
          assert.ok(
            (await admin.query("SELECT operation_id FROM rms_payment." + table)).rows.length > 0,
          );
          await admin.query(statement);
        }, ["55000"]);
      }
    }
    assert.deepEqual(await counts(), { revisions: "2", operations: "3" });
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

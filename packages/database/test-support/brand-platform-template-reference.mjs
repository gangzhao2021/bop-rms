import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { createBrand, createBrandAdministrationContext } from "../../bop/tenant/src/index.ts";
import { createPostgresPlatformTemplateBrandReferenceSource } from "../../bop/publishing/src/index.ts";

const id = (n) => `01903019-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const functions = [
  {
    signature: "bop_tenant.platform_brand_template_reference_read(uuid,uuid,uuid)",
    owner: "tenant",
  },
  {
    signature: "bop_publishing.brand_template_publication_read(uuid,uuid,uuid)",
    owner: "publishing",
  },
  {
    signature: "bop_publishing.brand_template_publication_hold(uuid,uuid,uuid)",
    owner: "publishing",
  },
  {
    signature: "bop_publishing.brand_template_publication_list(uuid,uuid,uuid,integer,boolean)",
    owner: "publishing",
  },
];
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

/** Actual Template/Publication records are supplied by the parent public-writer
 * journey. Only this consumer's Brand administrative authority is controlled:
 * it proves the owning read composition/ACLs, not a Merchant login or IAM grant.
 * The original Platform Directory/Session/Permission producers remain genuine
 * in that parent journey. No Template, Publication, Brand or permission seed. */
export async function createBrandPlatformTemplateReferenceNative(context, { admin, now }) {
  const names = {
    tenant: `brand_template_tenant_${context.runId}`,
    publishing: `brand_template_publish_${context.runId}`,
    consumer: `brand_template_consumer_${context.runId}`,
  };
  const roles = [],
    originals = [],
    password = randomBytes(32).toString("hex");
  let client,
    consumerPid,
    closed = false,
    connected = false,
    stage = "Setup",
    sqlState = "none";
  const mark = (next) => {
    stage = next;
    sqlState = "none";
  };
  const query = async (connection, sql, values = []) => {
    try {
      return await connection.query(sql, [...values]);
    } catch (error) {
      if (/^[0-9A-Z]{5}$/u.test(error.code ?? "")) sqlState = error.code;
      throw error;
    }
  };
  const failure = () =>
    new Error(`Brand template reference native failed at ${stage}; SQLSTATE=${sqlState}`);
  const close = async () => {
    if (closed) return;
    closed = true;
    let failed = false;
    if (client) {
      if (connected) await client.query("ROLLBACK").catch(() => undefined);
      try {
        await client.end();
      } catch {
        failed = true;
      }
    }
    // Restore owning objects before dropping test principals, including when
    // setup failed after transferring only some functions.
    for (const original of originals.reverse()) {
      try {
        await admin.query(`ALTER FUNCTION ${original.signature} OWNER TO ${quote(original.owner)}`);
      } catch {
        failed = true;
      }
    }
    for (const role of roles.reverse()) {
      try {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("BRAND_TEMPLATE_REFERENCE_CLEANUP_UNAVAILABLE");
  };
  try {
    for (const [kind, role] of Object.entries(names)) {
      assert.match(role, /^[a-z][a-z0-9_]{0,62}$/u);
      await query(
        admin,
        `CREATE ROLE ${role} ${kind === "consumer" ? "LOGIN PASSWORD '" + password + "'" : "NOLOGIN"} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      roles.push(role);
      await query(
        admin,
        `GRANT USAGE ON SCHEMA bop_tenant,bop_publishing,platform_helpers TO ${role}`,
      );
    }
    // MAINTAIN is the exact PG18 lock privilege for owning SHARE admission; no
    // INSERT/UPDATE/DELETE is supplied to these non-bypass function owners.
    await query(
      admin,
      `GRANT SELECT,MAINTAIN ON bop_tenant.platform_brand_template_revision TO ${names.tenant}`,
    );
    await query(
      admin,
      `GRANT SELECT ON bop_tenant.platform_brand_template_operation TO ${names.tenant}`,
    );
    await query(
      admin,
      `GRANT SELECT,MAINTAIN ON bop_publishing.platform_template_publishing_head TO ${names.publishing}`,
    );
    await query(
      admin,
      `GRANT SELECT ON bop_publishing.platform_template_publishing_operation TO ${names.publishing}`,
    );
    for (const role of [names.tenant, names.publishing])
      await query(admin, `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    for (const item of functions) {
      const original = (
        await query(
          admin,
          "SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=$1::regprocedure",
          [item.signature],
        )
      ).rows[0];
      assert(original);
      originals.push({ signature: item.signature, owner: original.owner });
      await query(admin, `ALTER FUNCTION ${item.signature} OWNER TO ${names[item.owner]}`);
      await query(admin, `GRANT EXECUTE ON FUNCTION ${item.signature} TO ${names.consumer}`);
    }
    const acl = (
      await query(
        admin,
        `SELECT rolsuper,rolbypassrls,rolcreaterole,
      has_table_privilege($1,'bop_tenant.platform_brand_template_revision','SELECT') template_read,
      has_table_privilege($1,'bop_tenant.platform_brand_template_operation','SELECT') template_original,
      has_table_privilege($1,'bop_publishing.platform_template_publishing_head','SELECT') publication_head,
      has_table_privilege($1,'bop_publishing.platform_template_publishing_operation','SELECT') publication_history,
      has_function_privilege($1,'bop_publishing.platform_template_publishing_family_admit(uuid,uuid,boolean)','EXECUTE') platform_fence,
      has_function_privilege($1,'bop_publishing.platform_template_publishing_head_advance(uuid,uuid,uuid,integer,boolean,boolean,boolean)','EXECUTE') platform_write
      FROM pg_roles WHERE rolname=$1`,
        [names.consumer],
      )
    ).rows[0];
    assert.deepEqual(acl, {
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      template_read: false,
      template_original: false,
      publication_head: false,
      publication_history: false,
      platform_fence: false,
      platform_write: false,
    });
    const owners = (
      await query(
        admin,
        "SELECT rolname,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname",
        [[names.tenant, names.publishing]],
      )
    ).rows;
    assert.equal(owners.length, 2);
    assert(
      owners.every(
        (r) => r.rolsuper === false && r.rolbypassrls === false && r.rolcanlogin === false,
      ),
    );
    const tableFlags = (
      await query(
        admin,
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY($1::regclass[])",
        [
          [
            "bop_tenant.platform_brand_template_revision",
            "bop_tenant.platform_brand_template_operation",
            "bop_publishing.platform_template_publishing_head",
            "bop_publishing.platform_template_publishing_operation",
          ],
        ],
      )
    ).rows;
    assert.equal(tableFlags.length, 4);
    assert(tableFlags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
    client = new pg.Client({ ...context.clientConfig, user: names.consumer, password });
    await client.connect();
    connected = true;
    consumerPid = (await query(client, "SELECT pg_backend_pid() pid")).rows[0].pid;
    for (const table of [
      "bop_tenant.platform_brand_template_revision",
      "bop_tenant.platform_brand_template_operation",
      "bop_publishing.platform_template_publishing_head",
      "bop_publishing.platform_template_publishing_operation",
    ])
      await assert.rejects(
        query(client, `SELECT * FROM ${table}`),
        (error) => error.code === "42501",
      );
    await assert.rejects(
      query(
        client,
        "SELECT bop_publishing.platform_template_publishing_family_admit($1,$2,false)",
        [id(1), id(2)],
      ),
      (error) => error.code === "42501",
    );
    for (const mode of ["Missing", "WrongActor", "Store", "WrongTenant", "WrongPurpose"]) {
      await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        if (mode !== "Missing")
          await query(
            client,
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true),set_config('bop.brand_template_actor_id',$4,true),set_config('bop.brand_template_purpose',$5,true)",
            [
              mode === "WrongTenant" ? id(3) : id(2),
              id(2),
              mode === "Store" ? id(3) : "",
              mode === "WrongActor" ? id(3) : id(1),
              mode === "WrongPurpose" ? "PLATFORM_BRAND_TEMPLATE" : "BRAND_ADMINISTRATION",
            ],
          );
        await assert.rejects(
          query(client, "SELECT * FROM bop_publishing.brand_template_publication_read($1,$2,$3)", [
            id(1),
            id(2),
            id(99),
          ]),
          (error) => error.code === "23514",
        );
      } finally {
        await query(client, "ROLLBACK");
      }
    }
  } catch {
    const error = failure();
    await close();
    throw error;
  }
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(1),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: now(),
    recentMfaAt: null,
  });
  const brand = createBrand({
    brandReference: id(2),
    code: "SYNTHETIC_REFERENCE",
    displayName: "Controlled Brand reference authority",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  });
  async function transaction(work, controls = {}) {
    const observedAt = controls.observedAt ?? now(),
      validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
      guards = [],
      finals = [],
      trace = [];
    let time = observedAt,
      active = true,
      allowed = true,
      authorityCalls = 0;
    const tx = {
      query: async (sql, values) => {
        assert(active);
        trace.push(sql);
        return query(client, sql, values);
      },
    };
    const source = createPostgresPlatformTemplateBrandReferenceSource({
      transaction: tx,
      scope: { tenantReference: id(2), brandReference: id(2), actorReference: id(1) },
      clock: { now: () => time },
      originalObservedAt: observedAt,
      originalValidUntil: validUntil,
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.equal(input.permission, "organization.manage");
          assert.equal(input.purposeCode, "BRAND_ADMINISTRATION");
          authorityCalls++;
          if (!allowed) throw new Error("CONTROLLED_BRAND_ADMINISTRATION_DENIED");
          return {
            administrationContext: createBrandAdministrationContext(actor, brand, time),
            validUntil,
          };
        },
      },
      registerBeforeCommit: async (actual, guard, final) => {
        assert.equal(actual, tx);
        guards.push(guard);
        finals.push(final);
      },
    });
    await query(client, "BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await query(client, "SET LOCAL statement_timeout='5s'");
      await query(client, "SET LOCAL lock_timeout='2s'");
      await query(client, "SET LOCAL idle_in_transaction_session_timeout='5s'");
      const result = await work(source, { trace, consumerPid });
      await controls.beforeGuards?.();
      if (controls.denyBeforeCommit) allowed = false;
      if (controls.backwardsClock) time = new Date(Date.parse(observedAt) - 1).toISOString();
      assert.equal(guards.length, 1);
      for (const guard of guards) await guard();
      assert(authorityCalls > 0);
      if (controls.expireAtFinal) time = validUntil;
      for (const final of finals) final();
      active = false;
      await query(client, "COMMIT");
      time = validUntil;
      source.assertFinalized();
      return result;
    } catch (error) {
      active = false;
      await query(client, "ROLLBACK");
      throw error;
    }
  }
  const expected = (snapshot, source) => ({
    template: snapshot,
    releaseReference: source.command.release.releaseId,
    releaseSequence: source.command.release.sequence,
    publishedAt: source.command.release.createdAt,
    publicationSourceDigest: source.sourceDigest,
  });
  const current = (snapshot, controls) =>
    transaction(
      (source) => source.current({ templateVersionReference: snapshot.templateVersionReference }),
      controls,
    );
  const list = (controls) =>
    transaction((source) => source.list({ afterTemplateReference: null, limit: 20 }), controls);
  const protect =
    (work) =>
    async (...args) => {
      try {
        return await work(...args);
      } catch {
        throw failure();
      }
    };
  return Object.freeze({
    async close() {
      await close();
    },
    verifyPublished: protect(
      async ({
        snapshot,
        source,
        unpublishedVersionReference,
        unpublishedFamilyVersionReference,
      }) => {
        mark("Published immutable source under nonbypass definer");
        assert.deepEqual((await current(snapshot)).reference, expected(snapshot, source));
        const page = await list();
        assert.deepEqual(
          page.items.find((item) => item.template.templateReference === snapshot.templateReference),
          expected(snapshot, source),
        );
        assert(
          !page.items.some(
            (item) => item.template.templateVersionReference === unpublishedVersionReference,
          ),
        );
        assert.equal(
          (await current({ templateVersionReference: unpublishedVersionReference })).reference,
          null,
        );
        const noHead = await transaction(async (reader, { trace }) => {
          const value = await reader.current({
            templateVersionReference: unpublishedFamilyVersionReference,
          });
          assert.equal(value.reference, null);
          return trace;
        });
        assert(noHead.filter((sql) => sql.includes("brand_template_publication_read")).length >= 2);
        const absent = await transaction(async (reader, { trace }) => {
          const value = await reader.current({ templateVersionReference: id(999999) });
          assert.equal(value.reference, null);
          return trace;
        });
        assert(
          absent.filter((sql) => sql.includes("platform_brand_template_reference_read")).length >=
            2,
        );
        assert(snapshot.content.effectiveUntil);
        mark("Actual persisted business period expiration");
        assert.equal(
          (await current(snapshot, { observedAt: snapshot.content.effectiveUntil })).reference,
          null,
        );
        assert(
          !(await list({ observedAt: snapshot.content.effectiveUntil })).items.some(
            (item) => item.template.templateReference === snapshot.templateReference,
          ),
        );
        for (const controls of [
          { denyBeforeCommit: true },
          { expireAtFinal: true },
          { backwardsClock: true },
        ]) {
          mark("Late administrative authority or lease refusal");
          let observed = false;
          await assert.rejects(
            transaction(async (reader) => {
              const packet = await reader.current({
                templateVersionReference: snapshot.templateVersionReference,
              });
              assert(packet.reference);
              observed = true;
              return packet;
            }, controls),
          );
          assert.equal(observed, true);
        }
        assert.deepEqual((await current(snapshot)).reference, expected(snapshot, source));
      },
    ),
    verifyReplaced: protect(async ({ snapshot, source, previousVersionReference }) => {
      mark("Real replacement qualifies only current immutable version");
      assert.deepEqual((await current(snapshot)).reference, expected(snapshot, source));
      assert.equal(
        (await current({ templateVersionReference: previousVersionReference })).reference,
        null,
      );
      const matches = (await list()).items.filter(
        (item) => item.template.templateReference === snapshot.templateReference,
      );
      assert.deepEqual(matches, [expected(snapshot, source)]);
    }),
    verifyArchived: protect(async ({ snapshot }) => {
      mark("Real Archive removes current eligibility");
      assert.equal((await current(snapshot)).reference, null);
      assert(
        !(await list()).items.some(
          (item) => item.template.templateReference === snapshot.templateReference,
        ),
      );
    }),
    withWriterFence: protect(async ({ mode, snapshot, writerPid }, work) => {
      mark(
        mode === "Current"
          ? "Current family shared fence blocks actual publisher"
          : "List table SHARE blocks actual archive",
      );
      assert(["Current", "List"].includes(mode));
      let release, entered;
      const ready = new Promise((resolve) => {
          entered = resolve;
        }),
        gate = new Promise((resolve) => {
          release = resolve;
        });
      const read = transaction(async (source) => {
        if (mode === "Current")
          assert(
            (await source.current({ templateVersionReference: snapshot.templateVersionReference }))
              .reference,
          );
        else
          assert(
            (await source.list({ afterTemplateReference: null, limit: 20 })).items.some(
              (item) => item.template.templateReference === snapshot.templateReference,
            ),
          );
        entered();
        await gate;
      }).then(
        () => ({ ok: true }),
        (error) => ({ error }),
      );
      let writer, interleaveError;
      try {
        await Promise.race([
          ready,
          read.then((result) => {
            throw result.error ?? new Error("REFERENCE_FENCE_NOT_HELD");
          }),
        ]);
        writer = Promise.resolve()
          .then(work)
          .then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
        let waiting = false;
        const limit = Date.now() + 1500;
        while (!waiting && Date.now() < limit) {
          const check = await query(
            admin,
            "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) blocked",
            [writerPid, consumerPid],
          );
          waiting = check.rows[0].blocked;
        }
        assert.equal(waiting, true);
      } catch (error) {
        interleaveError = error;
      } finally {
        release();
      }
      const readResult = await read;
      if (interleaveError) {
        if (writer) await writer;
        throw interleaveError;
      }
      if (readResult.error) {
        if (writer) await writer;
        throw readResult.error;
      }
      assert(writer);
      const written = await writer;
      if (written.error) throw written.error;
      return written.result;
    }),
  });
}

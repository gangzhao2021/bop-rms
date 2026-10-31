import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { exerciseInitialBrandLifecycle } from "./brand-initial-lifecycle.mjs";
import { createAuthenticationSession, createIdentityActor } from "../../bop/identity/src/index.ts";
import { createPostgresMembershipBrandDiscoverySource } from "../../bop/membership/src/index.ts";

const signature = "bop_membership.membership_brand_discovery_read(uuid,timestamptz,uuid,integer)";
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const readSql = "SELECT * FROM bop_membership.membership_brand_discovery_read($1,$2,$3,$4)";

/** No successful Brand or Membership is seeded here. Both accounts and their
 * finite Memberships come from the preceding independently approved producers.
 * Only the isolated owning-source Session packet below is controlled; the HTTP
 * journey uses genuine signed Cognito exchange, encrypted Session and current IAM.
 * One real Brand proves bounded terminal/cursor behavior, not multi-Brand paging. */
export async function exerciseBrandDiscovery(
  f,
  {
    context,
    plan,
    merchantRole,
    send,
    challenge,
    cookie,
    verifySaved,
    participantState,
    reviewerSubject,
    allocationCount,
  },
) {
  const owner = `brand_discovery_owner_${context.runId}`,
    consumer = `brand_discovery_reader_${context.runId}`;
  const password = randomBytes(32).toString("hex"),
    actor = plan.recipients[0].actorReference,
    reviewer = plan.recipients[1].actorReference,
    brand = plan.brand.brandReference;
  const original = (
    await f.admin.query(
      "SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=$1::regprocedure",
      [signature],
    )
  ).rows[0];
  assert(original);
  const owningCounts = async () =>
    (
      await f.admin.query(
        "SELECT (SELECT count(*)::int FROM bop_membership.membership) memberships,(SELECT count(*)::int FROM bop_permission.permission_grant) grants,(SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_revision) configurations,(SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations",
      )
    ).rows[0];
  const beforeCounts = await owningCounts();
  let client,
    writer,
    transferred = false;
  const sensitive = [],
    selectedSessions = [];
  let primaryFailed = false,
    primaryError,
    cleanupFailed = false;
  const scope = async (
    connection,
    namedActor = actor,
    purpose = "BRAND_DISCOVERY",
    selected = "",
  ) =>
    connection.query(
      "SELECT set_config('bop.membership_discovery_actor_id',$1,true),set_config('bop.membership_discovery_purpose',$2,true),set_config('bop.tenant_id',$3,true),set_config('bop.brand_id',$3,true),set_config('bop.store_id','',true)",
      [namedActor, purpose, selected],
    );
  try {
    f.mark("Discovery nonbypass function owner and EXECUTE-only consumer");
    for (const [name, login] of [
      [owner, false],
      [consumer, true],
    ]) {
      await f.admin.query(
        `CREATE ROLE ${name} ${login ? "LOGIN PASSWORD '" + password + "'" : "NOLOGIN"} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
      f.extraRoles.push(name);
      await f.admin.query(`GRANT USAGE ON SCHEMA bop_membership,platform_helpers TO ${name}`);
    }
    await f.admin.query(`GRANT SELECT,MAINTAIN ON bop_membership.membership TO ${owner}`);
    await f.admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.is_uuid_v7(uuid) TO ${owner}`,
    );
    await f.admin.query(`ALTER FUNCTION ${signature} OWNER TO ${owner}`);
    transferred = true;
    await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${consumer},${merchantRole}`);
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT rolsuper,rolbypassrls,has_table_privilege($1,'bop_membership.membership','SELECT') raw_read,has_table_privilege($1,'bop_membership.membership','INSERT') raw_write FROM pg_roles WHERE rolname=$1",
          [consumer],
        )
      ).rows[0],
      { rolsuper: false, rolbypassrls: false, raw_read: false, raw_write: false },
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT relforcerowsecurity forced FROM pg_class WHERE oid='bop_membership.membership'::regclass",
        )
      ).rows[0].forced,
      true,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT rolsuper,rolbypassrls,has_table_privilege($1,'bop_membership.membership','UPDATE') writes FROM pg_roles WHERE rolname=$1",
          [owner],
        )
      ).rows[0],
      { rolsuper: false, rolbypassrls: false, writes: false },
    );
    client = new pg.Client({ ...context.clientConfig, user: consumer, password });
    f.clients.add(client);
    await client.connect();
    const at = f.clock.now();
    for (const namedActor of [actor, reviewer]) {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await scope(client, namedActor);
      const row = (await client.query(readSql, [namedActor, at, null, 1])).rows[0];
      assert.deepEqual(row.brand_references, [brand]);
      assert.deepEqual(
        (await client.query(readSql, [namedActor, at, brand, 1])).rows[0].brand_references,
        [],
      );
      const period = (
        await f.admin.query(
          "SELECT effective_from,effective_until FROM bop_membership.membership WHERE actor_id=$1 AND brand_id=$2",
          [namedActor, brand],
        )
      ).rows[0];
      assert(period?.effective_until instanceof Date);
      assert.equal(row.transition_at, period.effective_until.toISOString());
      const beforeEnd = (
        await client.query(readSql, [
          namedActor,
          new Date(period.effective_until.getTime() - 1).toISOString(),
          null,
          20,
        ])
      ).rows[0];
      assert.deepEqual(beforeEnd.brand_references, [brand]);
      assert.equal(beforeEnd.transition_at, period.effective_until.toISOString());
      assert.deepEqual(
        (await client.query(readSql, [namedActor, period.effective_until.toISOString(), null, 20]))
          .rows[0].brand_references,
        [],
      );
      assert.deepEqual(
        (
          await client.query(readSql, [
            namedActor,
            new Date(period.effective_from.getTime() - 1).toISOString(),
            null,
            20,
          ])
        ).rows[0].brand_references,
        [],
      );
      await client.query("ROLLBACK");
    }
    for (const values of [
      [actor, "OTHER", "", actor],
      [actor, "BRAND_DISCOVERY", brand, actor],
      [actor, "BRAND_DISCOVERY", "", reviewer],
    ]) {
      await client.query("BEGIN");
      await scope(client, values[0], values[1], values[2]);
      await assert.rejects(
        client.query(readSql, [values[3], at, null, 20]),
        (error) => error.code === "23514",
      );
      await client.query("ROLLBACK");
    }
    await client.query("BEGIN");
    await assert.rejects(
      client.query("SELECT membership_id FROM bop_membership.membership"),
      (error) => error.code === "42501",
    );
    await client.query("ROLLBACK");
    f.mark("Discovery SHARE fence blocks a real late Membership writer");
    await client.query("BEGIN");
    await scope(client);
    await client.query(readSql, [actor, at, null, 20]);
    writer = new pg.Client(context.clientConfig);
    f.clients.add(writer);
    await writer.connect();
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(
      writer.query(
        "UPDATE bop_membership.membership SET version=version WHERE actor_id=$1 AND brand_id=$2",
        [actor, brand],
      ),
      (error) => error.code === "55P03",
    );
    await writer.query("ROLLBACK");
    await client.query("ROLLBACK");
    f.mark("Discovery source restores neutral scope and seals the original lease");
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await scope(client, actor, "OTHER", brand);
    const guards = [],
      finals = [],
      deadline = new Date(Date.parse(at) + 5000).toISOString();
    const identity = createIdentityActor({
      actorType: "User",
      actorReference: actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "RecentMfa",
      authenticatedAt: at,
      recentMfaAt: at,
    });
    const session = createAuthenticationSession({
      sessionReference: plan.operationReference,
      actor: identity,
      status: "Active",
      policyCode: "WorkforceStandard",
      maxActiveSessions: 5,
      idleTimeoutMinutes: 30,
      absoluteTimeoutMinutes: 720,
      version: 1,
      authenticatedAt: at,
      createdAt: at,
      lastSeenAt: at,
      idleExpiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(at) + 43200000).toISOString(),
      rotatedFromSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    });
    const tx = { query: (sql, values) => client.query(sql, [...values]) };
    const source = createPostgresMembershipBrandDiscoverySource({
      transaction: tx,
      actorReference: actor,
      clock: f.clock,
      originalObservedAt: at,
      originalValidUntil: deadline,
      authority: {
        async holdUntilTransactionCompletes(actual) {
          assert.equal(actual, tx);
          return { session, validUntil: deadline };
        },
      },
      registerBeforeCommit(actual, g, s) {
        assert.equal(actual, tx);
        guards.push(g);
        finals.push(s);
      },
    });
    const page = await source.holdPage({ afterBrandReference: null, limit: 1 });
    assert.deepEqual(page.brandReferences, [brand]);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextAfterBrandReference, null);
    assert.deepEqual(
      (
        await client.query(
          "SELECT current_setting('bop.brand_id') brand,current_setting('bop.tenant_id') tenant,current_setting('bop.store_id') store",
        )
      ).rows[0],
      { brand: "", tenant: "", store: "" },
    );
    for (const guard of guards) await guard();
    for (const final of finals) final();
    await client.query("COMMIT");
    source.assertFinalized();

    f.mark("Unselected genuine Workforce Session discovers and deliberately selects");
    const prefix = "/merchant/organization/brands";
    for (const [expectedActor, subject] of [
      [actor, undefined],
      [reviewer, reviewerSubject],
    ]) {
      const start = await send(`${prefix}/login`),
        auth = challenge(start, subject),
        callback = await send(auth.path, auth);
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.location, "/app/organization/brands");
      const rawCookie = cookie(callback, "__Host-bop-merchant"),
        saved = await verifySaved(rawCookie, expectedActor, null);
      const bootstrap = await send(`${prefix}/discovery/session`, { cookie: rawCookie });
      assert.equal(bootstrap.status, 200);
      const body = JSON.parse(bootstrap.body);
      sensitive.push(rawCookie, body.csrf);
      assert.equal(body.actorReference, expectedActor);
      assert.equal(body.selectedBrandReference, null);
      assert.equal(body.csrf, saved.secrets.csrf);
      assert.equal((await send(`${prefix}/session`, { cookie: rawCookie })).status, 409);
      const request = { method: "POST", cookie: rawCookie, csrf: body.csrf };
      const listing = await send(`${prefix}/discovery/list`, {
        ...request,
        body: { afterBrandReference: null },
      });
      assert.equal(listing.status, 200);
      const listed = JSON.parse(listing.body);
      assert.equal(listed.actorReference, expectedActor);
      assert.deepEqual(
        listed.items.map((item) => item.brandReference),
        [brand],
      );
      assert.equal(listed.items[0].lifecycle, "Draft");
      assert.equal(listed.hasMore, false);
      assert.equal(listed.nextAfterBrandReference, null);
      assert.deepEqual(
        JSON.parse(
          (
            await send(`${prefix}/discovery/list`, {
              ...request,
              body: { afterBrandReference: brand },
            })
          ).body,
        ).items,
        [],
      );
      const selectionCount = async () =>
        Number(
          (
            await f.admin.query(
              "SELECT count(*)::int n FROM bop_identity.browser_brand_session_selection WHERE session_id=$1",
              [saved.row.session_id],
            )
          ).rows[0].n,
        );
      assert.equal(
        (
          await send(`${prefix}/discovery/select`, {
            ...request,
            csrf: "wrong-csrf",
            body: { brandReference: brand, expectedSelectedBrandReference: null },
          })
        ).status,
        403,
      );
      assert.equal(await selectionCount(), 0);
      // SDK withdrawal happens after actual candidate observation, at the genuine
      // current-account transport boundary re-read before COMMIT.
      const previous = f.state.afterQuery;
      let withdrew = false;
      const disabledBefore = participantState.disabledMemberCalls;
      f.state.afterQuery = async (input) => {
        if (previous) await previous(input);
        if (
          !withdrew &&
          (input.sql.includes("membership_brand_discovery_read") ||
            input.sql.includes("FROM bop_membership.membership"))
        ) {
          withdrew = true;
          participantState.membersEnabled = false;
        }
      };
      try {
        const denied = await send(`${prefix}/discovery/select`, {
          ...request,
          body: { brandReference: brand, expectedSelectedBrandReference: null },
        });
        assert.notEqual(denied.status, 200);
        assert.equal(withdrew, true);
        assert(participantState.disabledMemberCalls > disabledBefore);
        assert.equal(await selectionCount(), 0);
      } finally {
        f.state.afterQuery = previous;
        participantState.membersEnabled = true;
      }
      const selectBody = { brandReference: brand, expectedSelectedBrandReference: null };
      // Treat the first reply as lost; actual bootstrap and exact retry confirm
      // the same immutable choice, never a new selection or a new Session.
      const selected = await send(`${prefix}/discovery/select`, { ...request, body: selectBody });
      assert.equal(selected.status, 200);
      assert.deepEqual(JSON.parse(selected.body), {
        actorReference: expectedActor,
        brandReference: brand,
        href: `/app/organization/brands/${brand}`,
      });
      assert.equal(await selectionCount(), 1);
      const retry = await send(`${prefix}/discovery/select`, { ...request, body: selectBody });
      assert.equal(retry.status, 200);
      assert.equal(await selectionCount(), 1);
      assert.equal(
        JSON.parse((await send(`${prefix}/discovery/session`, { cookie: rawCookie })).body)
          .selectedBrandReference,
        brand,
      );
      const conflict = await send(`${prefix}/discovery/select`, {
        ...request,
        body: { brandReference: plan.operationReference, expectedSelectedBrandReference: brand },
      });
      assert.equal(conflict.status, 409);
      assert.equal(await selectionCount(), 1);
      const detail = await send(`${prefix}/session`, { cookie: rawCookie });
      assert.equal(detail.status, 200);
      assert.equal(JSON.parse(detail.body).workspace.selectedScope.brandReference, brand);
      await verifySaved(rawCookie, expectedActor, brand);
      selectedSessions.push({
        actorReference: expectedActor,
        cookie: rawCookie,
        csrf: body.csrf,
        sessionReference: saved.row.session_id,
      });
      const configuration = await send(`${prefix}/configuration/current`, {
        ...request,
        body: { brandReference: brand },
      });
      assert.equal(configuration.status, 200);
      assert.equal(JSON.parse(configuration.body).current.configuration.lifecycle, "Published");
    }
    assert.deepEqual(await owningCounts(), beforeCounts);
    await exerciseInitialBrandLifecycle(f, {
      send,
      brandReference: brand,
      merchantRole,
      sessions: selectedSessions,
      participantState,
      allocationCount,
    });
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  } finally {
    participantState.membersEnabled = true;
    for (const connection of [writer, client])
      if (connection) {
        await connection.query("ROLLBACK").catch(() => undefined);
        try {
          await connection.end();
        } catch {
          cleanupFailed = true;
        } finally {
          f.clients.delete(connection);
        }
      }
    if (transferred) {
      try {
        await f.admin.query(`ALTER FUNCTION ${signature} OWNER TO ${quote(original.owner)}`);
      } catch {
        cleanupFailed = true;
      }
    }
    // Existing fixture owns role cleanup after all ordinary connections close.
    // Function ownership is restored here before those principals are dropped.
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw new Error("BRAND_DISCOVERY_NATIVE_CLEANUP_UNAVAILABLE");
  return sensitive;
}

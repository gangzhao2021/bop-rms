import assert from "node:assert/strict";
import { verifyPersistedBrowserSessionService } from "./browser-session-service.mjs";
import { Buffer } from "node:buffer";
import {
  createPostgresBrowserSessionStore,
  createIdentityActor,
  assertSessionUsable,
  createPostgresBrowserSessionSelectionStore,
} from "../../bop/identity/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

export async function verifyBrowserSessionStore({ admin, client, role }) {
  await admin.query("GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session TO " + role);
  const actor = createIdentityActor({ ...f.actor, actorReference: f.uuid("110") });
  let currentActor = actor;
  function store(connection, onSessionCreated) {
    return createPostgresBrowserSessionStore({
      onSessionCreated,
      environment: "synthetic",
      redirectUri: "https://merchant.example.test/callback",
      allowedPostLoginPaths: ["/operations/order-exceptions"],
      now: () => f.AT,
      currentActor: async () => currentActor,
      transactions: {
        async run(work) {
          await connection.query("BEGIN");
          try {
            await connection.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: (sql, values) => connection.query(sql, [...values]),
            });
            await connection.query("COMMIT");
            return result;
          } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
          }
        },
      },
    });
  }
  const first = store(client),
    second = store(admin);
  const hash = (n) => n.toString(16).padStart(64, "0");
  const envelope = (reference) => ({
    algorithm: "SYNTHETIC_AES_256_GCM",
    keyReference: "synthetic-key",
    ciphertext: Buffer.alloc(40, 19).toString("base64url"),
    encryptionContext: "synthetic:session:" + reference + ":" + actor.actorReference,
  });
  const command = (n) => ({
    sessionReference: f.uuid(String(n)),
    actor,
    policyCode: "WorkforceStandard",
    sessionSelectorHash: hash(n),
    csrfSelectorHash: hash(n + 100),
    encryptedSecrets: envelope(f.uuid(String(n))),
    observedAt: f.AT,
  });
  for (let n = 120; n < 126; n += 2) {
    await Promise.all([first.createSession(command(n)), second.createSession(command(n + 1))]);
  }
  const counts = await admin.query(
    "SELECT status,count(*)::int AS count FROM bop_identity.authentication_session WHERE actor_id=$1 GROUP BY status",
    [actor.actorReference],
  );
  assert.equal(counts.rows.find((r) => r.status === "Active").count, 5);
  assert.equal(counts.rows.find((r) => r.status === "Revoked").count, 1);
  const restarted = store(client);
  assert.equal(await restarted.resolveSession(hash(999)), null);
  const original = await restarted.resolveSession(hash(125));
  assert.deepEqual(original.encryptedSecrets, command(125).encryptedSecrets);
  const rotation = {
    currentSelectorHash: hash(125),
    expectedVersion: 1,
    nextSessionReference: f.uuid("130"),
    nextSelectorHash: hash(130),
    nextCsrfSelectorHash: hash(230),
    nextEncryptedSecrets: envelope(f.uuid("130")),
    reason: "StoreContextElevation",
    observedAt: f.AT,
  };
  const outcomes = await Promise.allSettled([
    first.rotateSession(rotation),
    second.rotateSession(rotation),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const old = await restarted.resolveSession(hash(125));
  assert.equal(old.session.status, "Revoked");
  assert.throws(() => assertSessionUsable(old.session, f.AT));
  const next = await restarted.resolveSession(hash(130));
  assert.equal(next.session.rotatedFromSessionReference, original.session.sessionReference);
  assert.equal(next.session.version, 2);
  await assert.rejects(
    first.revokeSession({
      selectorHash: hash(130),
      expectedVersion: 1,
      reason: "Logout",
      observedAt: f.AT,
    }),
    { code: "BROWSER_SESSION_VERSION_CONFLICT" },
  );
  assert.equal(
    (
      await first.revokeSession({
        selectorHash: hash(130),
        expectedVersion: 2,
        reason: "Logout",
        observedAt: f.AT,
      })
    ).status,
    "Revoked",
  );
  const revoked = await restarted.resolveSession(hash(130));
  assert.equal(revoked.session.revocationReason, "Logout");
  assert.throws(() => assertSessionUsable(revoked.session, f.AT));
  await admin.query("GRANT SELECT,INSERT ON bop_identity.browser_session_selection TO " + role);
  const selectedScope = {
    tenantReference: f.uuid("90"),
    brandReference: f.BRAND,
    storeReference: f.STORE,
  };
  const selections = createPostgresBrowserSessionSelectionStore({
    validate: async (_tx, session, scope) =>
      session.actor.actorReference === actor.actorReference &&
      scope.tenantReference === selectedScope.tenantReference &&
      scope.brandReference === f.BRAND &&
      scope.storeReference === f.STORE,
  });
  const bind = async (tx, record) => {
    await selections.write(tx, record.session, selectedScope, f.AT);
  };
  const selectedStore = store(client, bind);
  const selected = await selectedStore.createSession(command(150));
  const scopedRead = await selections.read(
    { query: (sql, values) => admin.query(sql, [...values]) },
    selected.session,
    f.AT,
  );
  assert.deepEqual(scopedRead, selectedScope);
  // Actual least-privileged pre-Tenant lookup; selected Brand/Store are not yet bound.
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE " + role);
    const tx = { query: (sql, values) => client.query(sql, [...values]) };
    const count = async () =>
      (
        await client.query(
          "SELECT count(*)::int AS count FROM bop_identity.browser_session_selection",
        )
      ).rows[0].count;
    assert.equal(await count(), 0);
    assert.deepEqual(await selections.read(tx, selected.session, f.AT), selectedScope);
    assert.equal(await count(), 0, "owner scope must not escape the operation");
    const setScope = (session, who) =>
      client.query(
        "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
        [session, who],
      );
    await setScope(selected.session.sessionReference, actor.actorReference);
    assert.equal(await count(), 1);
    await setScope(f.uuid("999"), actor.actorReference);
    assert.equal(await count(), 0);
    await setScope(selected.session.sessionReference, f.uuid("999"));
    assert.equal(await count(), 0);
    await setScope(selected.session.sessionReference, "");
    assert.equal(await count(), 0);
    await setScope("", actor.actorReference);
    assert.equal(await count(), 0);
    await setScope(f.uuid("998"), f.uuid("999"));
    const priorScope = async () =>
      (
        await client.query(
          "SELECT current_setting('bop.identity_session_id',true) session_scope,current_setting('bop.identity_actor_id',true) actor_scope",
        )
      ).rows[0];
    const prior = await priorScope();
    assert.deepEqual(await selections.read(tx, selected.session, f.AT), selectedScope);
    assert.deepEqual(await priorScope(), prior);
    const revokedValidation = createPostgresBrowserSessionSelectionStore({
      validate: async () => false,
    });
    await assert.rejects(revokedValidation.read(tx, selected.session, f.AT));
    assert.deepEqual(await priorScope(), prior, "failed association validation must restore scope");
    await assert.rejects(revokedValidation.write(tx, selected.session, selectedScope, f.AT));
    assert.deepEqual(await priorScope(), prior);
  } finally {
    await client.query("ROLLBACK");
  }

  await bind({ query: (sql, values) => admin.query(sql, [...values]) }, selected);
  const conflictStore = createPostgresBrowserSessionSelectionStore({ validate: async () => true });
  await assert.rejects(
    conflictStore.write(
      { query: (sql, values) => admin.query(sql, [...values]) },
      selected.session,
      { ...selectedScope, storeReference: f.uuid("99") },
      f.AT,
    ),
  );
  assert.deepEqual(
    await selections.read(
      { query: (sql, values) => admin.query(sql, [...values]) },
      selected.session,
      f.AT,
    ),
    selectedScope,
  );
  const failedRotation = {
    currentSelectorHash: hash(150),
    expectedVersion: 1,
    nextSessionReference: f.uuid("151"),
    nextSelectorHash: hash(151),
    nextCsrfSelectorHash: hash(251),
    nextEncryptedSecrets: envelope(f.uuid("151")),
    reason: "StoreContextElevation",
    observedAt: f.AT,
  };
  await assert.rejects(
    store(client, async (tx, record) => {
      await bind(tx, record);
      throw new Error("synthetic selection failure");
    }).rotateSession(failedRotation),
  );
  assert.equal((await first.resolveSession(hash(150))).session.status, "Active");
  assert.equal(await first.resolveSession(hash(151)), null);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM bop_identity.browser_session_selection WHERE session_id=$1",
        [f.uuid("151")],
      )
    ).rows[0].count,
    0,
  );
  const switched = await selectedStore.rotateSession({
    ...failedRotation,
    nextSessionReference: f.uuid("152"),
    nextSelectorHash: hash(152),
    nextCsrfSelectorHash: hash(252),
    nextEncryptedSecrets: envelope(f.uuid("152")),
  });
  assert.deepEqual(
    await selections.read(
      { query: (sql, values) => admin.query(sql, [...values]) },
      switched.session,
      f.AT,
    ),
    selectedScope,
  );
  assert.equal(
    (
      await admin.query(
        "UPDATE bop_identity.browser_session_selection SET store_id=$2 WHERE session_id=$1",
        [f.uuid("152"), f.uuid("99")],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query("DELETE FROM bop_identity.browser_session_selection WHERE session_id=$1", [
        f.uuid("152"),
      ])
    ).rowCount,
    0,
  );
  const unbound = await first.createSession(command(155));
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE " + role);
    await client.query(
      "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
      [switched.session.sessionReference, actor.actorReference],
    );
    await assert.rejects(
      client.query(
        "INSERT INTO bop_identity.browser_session_selection VALUES ($1,$2,$3,$4,$5,$6)",
        [
          unbound.session.sessionReference,
          actor.actorReference,
          selectedScope.tenantReference,
          f.BRAND,
          f.STORE,
          f.AT,
        ],
      ),
      { code: "42501" },
    );
  } finally {
    await client.query("ROLLBACK");
  }

  await assert.rejects(
    admin.query("INSERT INTO bop_identity.browser_session_selection VALUES ($1,$2,$3,$4,$5,$6)", [
      unbound.session.sessionReference,
      f.uuid("111"),
      selectedScope.tenantReference,
      f.BRAND,
      f.STORE,
      f.AT,
    ]),
    { code: "23503" },
  );
  await verifyPersistedBrowserSessionService({ store: () => store(client), actor, admin });
  currentActor = createIdentityActor({ ...actor, actorReference: f.uuid("111") });
  await assert.rejects(restarted.resolveSession(hash(124)));
}

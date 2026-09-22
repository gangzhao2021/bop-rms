import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPostgresBrowserSessionStore } from "../../bop/identity/src/index.ts";
import { createMerchantSessionSelection } from "../../../apps/api/src/merchant-session-selection.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

export async function verifyMerchantSessionSelection({ admin, client, role }) {
  await admin.query("GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session TO " + role);
  await admin.query("GRANT SELECT,INSERT ON bop_identity.browser_session_selection TO " + role);
  const scope = { tenantReference: f.uuid("90"), brandReference: f.BRAND, storeReference: f.STORE };
  const target = { ...scope, storeReference: f.uuid("610") };
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_2','Synthetic Second Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [target.storeReference, f.BRAND, f.FROM],
  );
  let associationActive = true;
  function store(selected, previousSessionReference) {
    return createPostgresBrowserSessionStore({
      environment: "synthetic",
      redirectUri: "https://merchant.example.test/callback",
      allowedPostLoginPaths: ["/operations/order-exceptions"],
      now: () => f.AT,
      currentActor: async () => f.actor,
      onSessionCreated: createMerchantSessionSelection({
        scope: selected,
        actorReference: f.ACTOR,
        previousSessionReference,
        now: () => f.AT,
        // Explicit synthetic association only; owner organization/membership are real SQL.
        validateAssociation: async (_tx, session, choice) =>
          associationActive &&
          session.actor.actorReference === f.ACTOR &&
          choice.tenantReference === scope.tenantReference &&
          choice.brandReference === f.BRAND &&
          [f.STORE, target.storeReference].includes(choice.storeReference),
      }),
      transactions: {
        async run(work) {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        },
      },
    });
  }
  const hash = (n) => n.toString(16).padStart(64, "0");
  const envelope = (n) => ({
    algorithm: "SYNTHETIC_AES_256_GCM",
    keyReference: "synthetic-key",
    ciphertext: Buffer.alloc(40, 19).toString("base64url"),
    encryptionContext: "synthetic:session:" + f.uuid(String(n)) + ":" + f.ACTOR,
  });
  const original = store(scope, null);
  await original.createSession({
    sessionReference: f.uuid("600"),
    actor: f.actor,
    policyCode: "WorkforceStandard",
    sessionSelectorHash: hash(600),
    csrfSelectorHash: hash(700),
    encryptedSecrets: envelope(600),
    observedAt: f.AT,
  });
  const rotation = (n) => ({
    currentSelectorHash: hash(600),
    expectedVersion: 1,
    nextSessionReference: f.uuid(String(n)),
    nextSelectorHash: hash(n),
    nextCsrfSelectorHash: hash(n + 100),
    nextEncryptedSecrets: envelope(n),
    reason: "StoreContextElevation",
    observedAt: f.AT,
  });
  const targetStore = store(target, f.uuid("600"));
  // Target exists but has no active assignment: nothing from the failed rotation persists.
  await assert.rejects(targetStore.rotateSession(rotation(601)));
  assert.equal((await original.resolveSession(hash(600))).session.status, "Active");
  assert.equal(await original.resolveSession(hash(601)), null);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM bop_identity.browser_session_selection WHERE session_id=$1",
        [f.uuid("601")],
      )
    ).rows[0].count,
    0,
  );
  await admin.query(
    "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("611"), f.MEMBERSHIP, f.ACTOR, f.BRAND, target.storeReference, f.FROM, f.UNTIL],
  );
  associationActive = false;
  await assert.rejects(targetStore.rotateSession(rotation(602)));
  assert.equal((await original.resolveSession(hash(600))).session.status, "Active");
  assert.equal(await original.resolveSession(hash(602)), null);
  associationActive = true;
  await assert.rejects(store(target, f.uuid("699")).rotateSession(rotation(603)));
  assert.equal((await original.resolveSession(hash(600))).session.status, "Active");
  const switched = await targetStore.rotateSession(rotation(604));
  assert.equal(switched.session.rotatedFromSessionReference, f.uuid("600"));
  assert.equal((await original.resolveSession(hash(600))).session.status, "Revoked");
  const rows = (
    await admin.query(
      "SELECT session_id,store_id FROM bop_identity.browser_session_selection WHERE session_id=ANY($1::uuid[]) ORDER BY session_id",
      [[f.uuid("600"), f.uuid("604")]],
    )
  ).rows;
  assert.deepEqual(rows, [
    { session_id: f.uuid("600"), store_id: f.STORE },
    { session_id: f.uuid("604"), store_id: target.storeReference },
  ]);
}

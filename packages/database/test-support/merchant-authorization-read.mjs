import { verifyPersistentMerchantBff } from "./persistent-merchant-bff.mjs";
import { verifyMerchantSessionSelection } from "./merchant-session-selection.mjs";
import assert from "node:assert/strict";
import { verifyMerchantExceptionHttp } from "./merchant-exception-http.mjs";
import { createMerchantSelectedContext } from "../../../apps/api/src/merchant-selected-context.ts";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createPostgresCurrentBrowserSessionSource,
  parseSelectorHash,
} from "../../bop/identity/src/index.ts";
import { createPostgresCurrentMembershipSource } from "../../bop/membership/src/index.ts";
import { createMerchantOrderExceptionAuthorization } from "../../../apps/api/src/merchant-order-exception-authorization.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

/** Isolated synthetic Actor/Tenant facts; session, membership and policy are real SQL. */
export async function verifyMerchantAuthorizationRead({
  admin,
  client,
  role,
  fixtureClock,
  pickupReady,
  existingOrganizationFacts = false,
}) {
  const clock = fixtureClock ?? { from: f.FROM, at: f.AT, until: f.UNTIL };
  const sessionId = f.uuid("91");
  const cookie = Buffer.alloc(32, 7).toString("base64url");
  const key = Buffer.alloc(32, 92);
  const hasher = {
    hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
    equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  };
  await admin.query(
    "INSERT INTO bop_membership.membership VALUES ($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
    [f.MEMBERSHIP, f.ACTOR, f.BRAND, f.WORKFORCE, clock.from, clock.until],
  );
  await admin.query(
    "INSERT INTO bop_membership.store_assignment VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.STORE_ASSIGNMENT, f.MEMBERSHIP, f.ACTOR, f.BRAND, f.STORE, clock.from, clock.until],
  );
  await admin.query(
    "INSERT INTO bop_identity.authentication_session (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version) VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),'WorkforceStandard','Active',$5,'SYNTHETIC_AES_256_GCM','synthetic-test-key','synthetic-test-context',$6,$6,$7,$8,$9,1)",
    [
      sessionId,
      f.ACTOR,
      hasher.hash(cookie),
      "b".repeat(64),
      Buffer.alloc(29, 1),
      clock.from,
      clock.at,
      new Date(Date.parse(clock.at) + 30 * 60 * 1000).toISOString(),
      new Date(Date.parse(clock.from) + 12 * 60 * 60 * 1000).toISOString(),
    ],
  );
  await admin.query("GRANT USAGE ON SCHEMA bop_identity,bop_membership TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON bop_identity.authentication_session,bop_membership.membership,bop_membership.store_assignment TO " +
      role,
  );
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code=$1 WHERE permission_id=$2",
    ["operations.order-exception.manage", f.PERMISSION],
  );
  for (const action of [
    "operations.order--exception.manage",
    "operations.-order.manage",
    "Operations.order.manage",
    "operations.order.manage\\n",
  ]) {
    await assert.rejects(
      admin.query(
        "UPDATE bop_permission.permission_definition SET action_code=$1 WHERE permission_id=$2",
        [action, f.PERMISSION],
      ),
      { code: "23514" },
    );
  }
  if (!existingOrganizationFacts) {
    await admin.query(
      "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC','Synthetic Brand','en-CA','CAD','Active',1,$2,$2)",
      [f.BRAND, clock.from],
    );
    await admin.query(
      "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_1','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
      [f.STORE, f.BRAND, clock.from],
    );
  }
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  await admin.query("GRANT SELECT,UPDATE ON bop_tenant.brand,bop_tenant.store TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON bop_identity.oidc_authorization_transaction TO " + role,
  );
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  await verifyMerchantSessionSelection({ admin, client, role, fixtureClock: clock });
  await verifyPersistentMerchantBff({ admin, client, role, fixtureClock, pickupReady });
  if (pickupReady) return;
  const source = createPostgresCurrentBrowserSessionSource({
    now: () => clock.at,
    hasher,
    currentActor: async () => f.actor,
  });
  let associationActive = true;
  const authorize = createMerchantOrderExceptionAuthorization({
    now: () => clock.at,
    session: source,
    context: createMerchantSelectedContext({
      now: () => clock.at,
      validateSelection: async (_tx, session, scope) =>
        associationActive &&
        session.actor.actorReference === f.ACTOR &&
        scope.tenantReference === f.uuid("90") &&
        scope.brandReference === f.BRAND &&
        scope.storeReference === f.STORE,
    }),
    membership: (tx, context) => createPostgresCurrentMembershipSource(tx, context),
  });
  async function evaluate(credential = cookie, during) {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE " + role);
      const result = await authorize(
        {
          query: (sql, values) => client.query(sql, [...values]),
        },
        { sessionCookie: credential, permission: "operations.order-exception.manage" },
      );
      if (during) await during(result);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  assert.equal(await evaluate(), null);
  await admin.query(
    "INSERT INTO bop_identity.browser_session_selection VALUES ($1,$2,$3,$4,$5,$6)",
    [sessionId, f.ACTOR, f.uuid("90"), f.BRAND, f.STORE, clock.at],
  );
  const allowed = await evaluate(cookie, async (result) => {
    assert.equal(result?.sessionReference, sessionId);
    for (const [sql, values] of [
      [
        "SELECT session_id FROM bop_identity.authentication_session WHERE session_id=$1 FOR UPDATE NOWAIT",
        [sessionId],
      ],
      ["SELECT brand_id FROM bop_tenant.brand WHERE brand_id=$1 FOR UPDATE NOWAIT", [f.BRAND]],
      ["SELECT store_id FROM bop_tenant.store WHERE store_id=$1 FOR UPDATE NOWAIT", [f.STORE]],
      ["LOCK TABLE bop_membership.membership IN ROW EXCLUSIVE MODE NOWAIT", []],
      ["LOCK TABLE bop_membership.store_assignment IN ROW EXCLUSIVE MODE NOWAIT", []],
    ]) {
      await admin.query("BEGIN");
      try {
        await assert.rejects(admin.query(sql, values), {
          code: "55P03",
        });
      } finally {
        await admin.query("ROLLBACK");
      }
    }
  });
  assert.equal(allowed?.storeReference, f.STORE);
  associationActive = false;
  assert.equal(await evaluate(), null);
  associationActive = true;

  for (const [table, column, reference] of [
    ["brand", "brand_id", f.BRAND],
    ["store", "store_id", f.STORE],
  ]) {
    await assert.rejects(
      admin.query("UPDATE bop_tenant." + table + " SET version=version WHERE " + column + "=$1", [
        reference,
      ]),
      { code: "55000" },
    );
    await assert.rejects(
      admin.query(
        "UPDATE bop_tenant." +
          table +
          " SET code='CHANGED',version=version+1 WHERE " +
          column +
          "=$1",
        [reference],
      ),
      { code: "55000" },
    );
  }

  await admin.query(
    "UPDATE bop_tenant.store SET lifecycle='Suspended',version=2 WHERE store_id=$1",
    [f.STORE],
  );
  assert.equal(await evaluate(), null);
  await admin.query("UPDATE bop_tenant.store SET lifecycle='Active',version=3 WHERE store_id=$1", [
    f.STORE,
  ]);
  await admin.query(
    "UPDATE bop_tenant.brand SET lifecycle='Suspended',version=2 WHERE brand_id=$1",
    [f.BRAND],
  );
  assert.equal(await evaluate(), null);
  await admin.query("UPDATE bop_tenant.brand SET lifecycle='Active',version=3 WHERE brand_id=$1", [
    f.BRAND,
  ]);
  assert.equal((await evaluate())?.storeReference, f.STORE);

  assert.equal(await evaluate(Buffer.alloc(32, 8).toString("base64url")), null);
  await admin.query(
    "UPDATE bop_membership.membership SET lifecycle='Suspended',version=2 WHERE membership_id=$1",
    [f.MEMBERSHIP],
  );
  assert.equal(await evaluate(), null);
  await admin.query(
    "UPDATE bop_membership.membership SET lifecycle='Active',version=3 WHERE membership_id=$1",
    [f.MEMBERSHIP],
  );
  assert.equal((await evaluate())?.storeReference, f.STORE);
  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("92"),
      f.PERMISSION,
      f.ACTOR,
      f.BRAND,
      f.STORE,
      f.REASON,
      f.CORRELATION,
      clock.from,
      clock.until,
    ],
  );
  assert.equal(await evaluate(), null);
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("92")],
  );
  assert.equal((await evaluate())?.storeReference, f.STORE);
  await verifyMerchantExceptionHttp({
    admin,
    client,
    role,
    cookie,
    authorize,
    sessionSource: source,
    revoke: async () => {
      await admin.query(
        "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='Logout',revoked_at=$1,version=2 WHERE session_id=$2",
        [clock.at, sessionId],
      );
    },
  });
  assert.equal(await evaluate(), null);
  await admin.query(
    "UPDATE bop_permission.permission_definition SET action_code=$1 WHERE permission_id=$2",
    [f.ACTION, f.PERMISSION],
  );
}

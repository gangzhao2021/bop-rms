import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  BrowserSessionService,
  createCognitoStoreWorkforceProvider,
  createCognitoWorkforceInvitation,
  createPostgresBrowserSessionSelectionStore,
  createPostgresBrowserSessionStore,
} from "../../bop/identity/src/index.ts";
import { isActiveStoreMember } from "../../bop/membership/src/index.ts";
import { listRoleAdministration } from "../../bop/permission/src/index.ts";
import { createStoreStaffSignIn } from "../../../apps/api/src/store-staff-sign-in.ts";
import { createMerchantStaffAdministration } from "../../../apps/api/src/merchant-staff-administration.ts";
import { createMerchantProviderStepUp } from "../../../apps/api/src/merchant-provider-step-up.ts";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { startCognitoTestProvider } from "../../../tooling/environment/cognito-test-provider.mjs";
import { inviteThroughOperator } from "../../../tooling/environment/store-staff-sign-in.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { openSyntheticStoreRoles } from "../test-support/store-role-provisioning.mjs";

// WP-2423 DEC-COGNITO-STORE-STAFF. Only the selected-Store and Brand permission resolution is a
// test double (a cookie names a person with the listed permissions at the Store). Invitations,
// Memberships, role requests, Cognito accounts, sessions, Store selections, step-ups and audits are
// the real owners over real rows, run as a restricted NOBYPASSRLS role holding exactly the rendered
// pilot API grants, against the TEST-ONLY local Cognito stand-in over HTTP (no AWS call).
const signedIn = vi.hoisted(() => ({ scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action, expected) =>
    signedIn.scopeFor(tx, cookie, action, expected),
}));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope: () => async () => {
    throw new Error("NO_BRAND_SCOPE_IN_THIS_TEST");
  },
}));
const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
const { Client } = pg;
const id = (n) => "0190c4b0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store] = [1, 2, 3].map(id);
const [owner, manager, cashier] = [10, 11, 12].map(id);
const origin = "https://staff.example.test";
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

it("WP-2423 Cognito store staff: invite, first sign-in, sessions, step-up, resend, revoke and refusals", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cognito_staff" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_cog_api_" + context.runId,
      worker = "wp2423_cog_w_" + context.runId;
    const fake = await startCognitoTestProvider({
      callbackUrls: [origin + "/merchant/callback", origin + "/merchant/identity/step-up/callback"],
    });
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));

      // ── Fixtures (owner client): Brand, Store, an Owner and a manager with names and roles.
      const from = new Date(Date.now() - 86_400_000).toISOString();
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'COG','Cognito Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'COG_STORE','Cognito Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store, brand, from],
      );
      let n = 100;
      const next = () => id(++n);
      const members = {};
      for (const [actor, name] of [
        [owner, "Olivia"],
        [manager, "Mia"],
        [cashier, "Cam"],
      ]) {
        const membership = next(),
          assignment = next();
        members[actor] = { membership, assignment };
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, next(), from],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
          [assignment, membership, actor, brand, store, from],
        );
        await admin.query(
          "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
          [membership, brand, actor, name, next(), from],
        );
      }
      await openSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store,
        operator: id(20),
        approver: id(21),
        at: from,
        next,
        owner: {
          actorReference: owner,
          membershipReference: members[owner].membership,
          storeAssignmentReference: members[owner].assignment,
        },
      });
      const roles = new Map(
        (
          await listRoleAdministration(
            admin,
            { brandReference: brand, storeReference: store },
            from,
          )
        ).map((item) => [item.record.code, item.record.roleReference]),
      );

      const transactionsAs = (name) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + name);
            await client.query("SET LOCAL lock_timeout='2s'");
            await client.query("SET LOCAL statement_timeout='15s'");
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      });
      const api = transactionsAs(role);
      const clock = () => new Date().toISOString();
      const key = randomBytes(32);
      const envelopes = {
        async encrypt(plaintext, encryptionContext) {
          const nonce = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(encryptionContext));
          const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference: "acceptance-key",
            encryptionContext,
            ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url"),
          };
        },
        async decrypt(envelope, expected) {
          if (envelope.encryptionContext !== expected) throw new Error("CONTEXT");
          const raw = Buffer.from(envelope.ciphertext, "base64url");
          const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
          decipher.setAAD(Buffer.from(expected));
          decipher.setAuthTag(raw.subarray(12, 28));
          return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
        },
      };
      const pepper = randomBytes(32).toString("hex");
      const hasher = {
        hash: (value) =>
          createHash("sha256")
            .update(pepper + ":" + value)
            .digest("hex"),
        equals: (a, b) => a === b,
      };
      const pool = { environment: "acceptance", issuer: fake.issuer, clientId: fake.clientId };
      // The stand-in answers for both AWS hosts; nothing leaves this machine.
      const http = async (input, init) => {
        const url = new URL(String(input));
        assert.ok(
          url.origin === fake.managedLoginOrigin ||
            url.origin === "https://cognito-idp.ca-central-1.amazonaws.com",
        );
        const response = await globalThis.fetch(fake.origin + url.pathname + url.search, init);
        return new globalThis.Response(
          response.status === 204 ? null : await response.arrayBuffer(),
          {
            status: response.status,
            headers: response.headers,
          },
        );
      };
      const invitation = createCognitoWorkforceInvitation({
        configuration: { ...pool },
        clock: { now: clock },
        hasher,
        markEmailVerified: true,
        providerEndpoint: {
          url: fake.origin + "/",
          credentials: { accessKeyId: "TESTONLY", secretAccessKey: "TESTONLY" },
        },
      });
      const people = createStoreStaffSignIn({
        transactions: api,
        pool,
        hasher,
        now: clock,
        nextReference: next,
        inspector: invitation,
      });
      const provider = createCognitoStoreWorkforceProvider({
        configuration: {
          issuer: fake.issuer,
          clientId: fake.clientId,
          clientSecret: fake.clientSecret,
          managedLoginOrigin: fake.managedLoginOrigin,
          redirectUri: origin + "/merchant/callback",
          logoutReturnUri: origin + "/app",
        },
        stepUpRedirectUri: origin + "/merchant/identity/step-up/callback",
        clock: { now: clock },
        nextReference: next,
        resolveSubject: people.resolveSubject,
        http,
      });
      const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
      const validateAssociation = async (tx, session, selected, at = clock()) =>
        selected.storeReference === store &&
        (await isActiveStoreMember(tx, {
          brandReference: brand,
          storeReference: store,
          actorReference: session.actor.actorReference,
          at,
        }));
      const selection = createPostgresBrowserSessionSelectionStore({
        validate: validateAssociation,
      });
      const identity = {
        configuration: {
          issuer: fake.issuer,
          clientId: fake.clientId,
          redirectUri: origin + "/merchant/callback",
          environment: "acceptance",
          allowedPostLoginPaths: ["/app", "/operations/kitchen/start"],
        },
        hasher,
        envelopes,
        credentials: {
          generate: () => randomBytes(32).toString("base64url"),
          generateUuidV7: next,
        },
        provider,
        pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
        postLoginPolicies: { "/operations/kitchen/start": "NamedKdsOperator" },
      };
      const sessionStore = createPostgresBrowserSessionStore({
        ...identity.configuration,
        transactions: api,
        now: clock,
        currentActor: people.currentActor,
        onSessionCreated: async (tx, record) => {
          await selection.write(tx, record.session, scope, clock());
          await people.recordSignInVerification(tx, {
            brandReference: brand,
            storeReference: store,
            actorReference: record.session.actor.actorReference,
            sessionReference: record.session.sessionReference,
            authenticatedAt: record.session.authenticatedAt,
          });
        },
      });
      const service = new BrowserSessionService({ ...identity, store: sessionStore, now: clock });

      // Permission resolution double: fixed cookies for administrators, otherwise the session row.
      const permissions = {
        [owner]: new Set([
          "merchant.access",
          "organization.staff.read",
          "organization.staff.manage",
          "identity.role.approve",
        ]),
        [manager]: new Set([
          "merchant.access",
          "organization.staff.read",
          "organization.staff.manage",
        ]),
        [cashier]: new Set(["merchant.access", "organization.staff.read"]),
      };
      const fixed = { "owner-cookie": owner, "manager-cookie": manager, "cashier-cookie": cashier };
      signedIn.scopeFor = async (tx, cookie, action, expected) => {
        let actor = fixed[cookie],
          session = actor === undefined ? undefined : sha(cookie).slice(0, 8);
        if (actor === undefined) {
          const found = (
            await tx.query(
              "SELECT session_id::text AS session,actor_id::text AS actor FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex') AND status='Active'",
              [hasher.hash(cookie)],
            )
          ).rows[0];
          if (!found) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
          actor = found.actor;
          session = found.session;
        }
        if (expected !== undefined && session !== expected && fixed[cookie] === undefined)
          throw new Error("STORE_SERVICE_PERMISSION_DENIED");
        const held = permissions[actor] ?? new Set(["merchant.access"]);
        return {
          context: { brand: { brandReference: brand }, resolvedAt: clock() },
          store: { storeReference: store },
          actorReference: actor,
          sessionReference: session,
          allowed: async () => held.has(action),
          authorizeAction: async (requested) => ({
            effect: held.has(requested) ? "Allow" : "Deny",
          }),
        };
      };
      const staff = createMerchantStaffAdministration({
        persistence: { transactions: api, now: clock },
        authentication: {
          authorize: async ({ sessionCookie }) => ({
            sessionReference: sha(sessionCookie).slice(0, 8),
          }),
        },
        references: { next },
        invitations: { pool, provider: invitation },
      });
      const command = (cookie, body) => staff.command({ sessionCookie: cookie, csrf: "c", body });
      const list = (cookie = "owner-cookie") =>
        staff.query({ sessionCookie: cookie, csrf: "c", actorReference: null });
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── 1. Invite with a required name, work email and role (Owner 2026-10-18 "必填").
      const op = () => next();
      await assert.rejects(
        command("owner-cookie", {
          operation: "Invite",
          displayName: "   ",
          email: "sam.lee@example.test",
          roleReference: roles.get("front_of_house"),
          operationReference: op(),
        }),
        { code: "Invalid" },
      );
      await assert.rejects(
        command("cashier-cookie", {
          operation: "Invite",
          displayName: "Sam Lee",
          email: "sam.lee@example.test",
          roleReference: roles.get("front_of_house"),
          operationReference: op(),
        }),
        { code: "PermissionDenied" },
      );
      assert.equal(fake.users.size, 0, "nothing reaches Cognito for a refused invitation");
      assert.equal(
        (await rows("SELECT count(*)::int n FROM bop_identity.store_staff_invitation"))[0].n,
        0,
      );
      const samOp = op();
      const invited = await command("owner-cookie", {
        operation: "Invite",
        displayName: "Sam Lee",
        email: " Sam.Lee@Example.test ",
        roleReference: roles.get("front_of_house"),
        operationReference: samOp,
      });
      assert.equal(invited.status, "Invited");
      assert.equal(invited.delivery, "Sent");
      const sam = invited.actorReference;
      // A retried request answers from the record and creates no second account.
      const retried = await command("owner-cookie", {
        operation: "Invite",
        displayName: "Sam Lee",
        email: "sam.lee@example.test",
        roleReference: roles.get("front_of_house"),
        operationReference: samOp,
      });
      assert.deepEqual(retried, {
        status: "AlreadyApplied",
        actorReference: sam,
        delivery: "Sent",
      });
      await assert.rejects(
        command("manager-cookie", {
          operation: "Invite",
          displayName: "Sam Again",
          email: "SAM.LEE@example.test",
          roleReference: roles.get("front_of_house"),
          operationReference: op(),
        }),
        { code: "AlreadyInvited" },
      );
      assert.equal(fake.users.size, 1);
      const samUser = fake.users.get("bop_" + sam);
      assert.equal(samUser.email, "sam.lee@example.test");
      assert.equal(samUser.emailVerified, true);
      assert.match(samUser.custom["custom:bop_invitation_intent"], /^sha256:[a-f0-9]{64}$/u);
      assert.equal(fake.invitations.length, 1);
      const [invitationRow] = await rows(
        "SELECT status,delivery,email_hint,email_digest,send_count,invitation_kind FROM bop_identity.store_staff_invitation WHERE actor_id=$1",
        [sam],
      );
      assert.deepEqual(
        { ...invitationRow, email_digest: /^[a-f0-9]{64}$/u.test(invitationRow.email_digest) },
        {
          status: "Pending",
          delivery: "Sent",
          email_hint: "s•••@example.test",
          email_digest: true,
          send_count: 1,
          invitation_kind: "Staff",
        },
      );
      assert.deepEqual(
        (
          await rows(
            "SELECT m.lifecycle m,s.lifecycle s,p.display_name FROM bop_membership.membership m JOIN bop_membership.store_assignment s USING (membership_id) JOIN bop_membership.member_profile_version p USING (membership_id) WHERE m.actor_id=$1",
            [sam],
          )
        )[0],
        { m: "PendingActivation", s: "Active", display_name: "Sam Lee" },
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int n FROM bop_permission.role_assignment_change WHERE actor_id=$1 AND requested_by=$2",
            [sam, owner],
          )
        )[0].n,
        1,
      );
      const view = await list();
      assert.equal(view.viewer.mayInvite, true);
      assert.ok(view.roles.some((item) => item.roleReference === roles.get("front_of_house")));
      const listed = view.staff.find((item) => item.actorReference === sam);
      assert.equal(listed.membershipStatus, "PendingActivation");
      assert.equal(listed.invitation.status, "Pending");
      assert.equal(listed.invitation.emailHint, "s•••@example.test");
      assert.equal(listed.invitation.mayResend, true);
      assert.equal(listed.pending[0].mayDecide, false, "a role starts only after they join");
      assert.equal(listed.mayRemove, false);

      // ── 2. First sign-in: temporary password, new password and authenticator at Cognito.
      async function signIn(person, path = "/app") {
        const started = await service.start(path);
        const callback = new URL(fake.signIn(started.authorizationUrl, person));
        assert.equal(callback.origin + callback.pathname, origin + "/merchant/callback");
        return service.callback({
          code: callback.searchParams.get("code"),
          state: callback.searchParams.get("state"),
          authCookie: started.cookie.value,
        });
      }
      const samPassword = { email: "sam.lee@example.test", password: "Sam-Real-Password-1" };
      const first = await signIn({
        email: "sam.lee@example.test",
        password: samUser.temporaryPassword,
        newPassword: samPassword.password,
      });
      assert.equal(first.postLoginPath, "/app");
      assert.equal(first.session.actor.actorReference, sam);
      assert.equal(first.session.policy.code, "WorkforceStandard");
      assert.match(
        first.cookies.find((item) => item.descriptor.name === "__Host-bop-merchant").value,
        /^[A-Za-z0-9_-]{43}$/u,
      );
      const [account] = await rows(
        "SELECT subject_hash,invitation_id::text FROM bop_identity.store_staff_account WHERE actor_id=$1",
        [sam],
      );
      assert.notEqual(account.subject_hash, samUser.sub);
      assert.ok(!account.subject_hash.includes(samUser.sub.replace(/-/gu, "")));
      assert.deepEqual(
        (
          await rows(
            "SELECT i.status,m.lifecycle,m.workforce_relationship_reference::text rel,f.status mfa FROM bop_identity.store_staff_invitation i JOIN bop_membership.membership m ON m.membership_id=i.membership_id JOIN bop_identity.workforce_mfa_status f ON f.actor_id=i.actor_id WHERE i.actor_id=$1",
            [sam],
          )
        )[0],
        {
          status: "Accepted",
          lifecycle: "Active",
          rel: account.invitation_id,
          mfa: "TotpVerified",
        },
      );
      assert.deepEqual(
        await rows(
          "SELECT method,purpose_code,outcome FROM bop_identity.workforce_mfa_step_up WHERE session_id=$1",
          [first.session.sessionReference],
        ),
        [
          {
            method: "CognitoReauthentication",
            purpose_code: "IDENTITY_SIGN_IN",
            outcome: "Verified",
          },
        ],
      );
      // Audit never holds the name, email or Cognito subject.
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [brand, store],
      );
      const audit = await rows(
        "SELECT action_code,(before_summary_json::text||after_summary_json::text) body FROM platform_audit.audit_record WHERE action_code LIKE 'IDENTITY_STAFF_INVITATION%' OR action_code LIKE 'MEMBER_INVIT%'",
      );
      assert.ok(audit.length >= 4);
      for (const item of audit)
        assert.doesNotMatch(item.body, /sam|example\.test|Sam Lee|[0-9a-f]{8}-[0-9a-f]{4}-4/iu);

      // ── 3. Later sign-ins resolve the bound account; a kitchen display start opens a kitchen session.
      // Cognito authentication times are whole seconds; each sign-in here gets its own second.
      const tick = () => new Promise((resolve) => globalThis.setTimeout(resolve, 1100));
      await tick();
      const second = await signIn({ ...samPassword });
      await tick();
      assert.equal(second.session.actor.actorReference, sam);
      const kitchen = await signIn({ ...samPassword }, "/operations/kitchen/start");
      assert.equal(kitchen.session.policy.code, "NamedKdsOperator");
      assert.equal(kitchen.postLoginPath, "/operations/kitchen/start");

      // ── 4. Refusals: no invitation, someone else's invitation, expired, a failing Provider.
      fake.users.set("stranger", {
        username: "stranger",
        sub: "00000000-0000-4000-8000-00000000abcd",
        email: "stranger@example.test",
        emailVerified: true,
        custom: {},
        enabled: true,
        status: "CONFIRMED",
        password: "Stranger-1",
        temporaryPassword: null,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
      });
      await assert.rejects(signIn({ email: "stranger@example.test", password: "Stranger-1" }));
      const patOp = op();
      const pat = (
        await command("manager-cookie", {
          operation: "Invite",
          displayName: "Pat Doe",
          email: "pat@example.test",
          roleReference: roles.get("kitchen"),
          operationReference: patOp,
        })
      ).actorReference;
      // Cognito does not answer while the first sign-in is checked: refused, nothing written.
      const patUser = fake.users.get("bop_" + pat);
      fake.fail("admin:AdminGetUser", "hang");
      await assert.rejects(
        signIn({
          email: "pat@example.test",
          password: patUser.temporaryPassword,
          newPassword: "Pat-Real-1",
        }),
      );
      // Pat has set her password at Cognito but is not bound yet. The stranger presents a signed
      // username naming Pat: Cognito's account for Pat has another subject, so nothing is bound.
      fake.setNextClaims({ id: { "cognito:username": "bop_" + pat } });
      await assert.rejects(signIn({ email: "stranger@example.test", password: "Stranger-1" }));
      assert.equal(
        (
          await rows("SELECT status FROM bop_identity.store_staff_invitation WHERE actor_id=$1", [
            pat,
          ])
        )[0].status,
        "Pending",
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int n FROM bop_identity.store_staff_account WHERE actor_id=$1",
            [pat],
          )
        )[0].n,
        0,
      );
      // The token endpoint fails: no session.
      fake.fail("token", "status-500");
      await assert.rejects(signIn({ email: "pat@example.test", password: "Pat-Real-1" }));
      // An invitation that expired is refused even with the right account.
      const quinn = id(700),
        quinnMembership = id(701),
        quinnAssignment = id(702),
        quinnInvitation = id(703),
        old = new Date(Date.now() - 8 * 86_400_000).toISOString();
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await admin.query(
        "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,NULL,'PendingActivation',$4,NULL,1,$4,$4)",
        [quinnMembership, quinn, brand, old],
      );
      await admin.query(
        "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Active',$6,NULL,1,$6,$6)",
        [quinnAssignment, quinnMembership, quinn, brand, store, old],
      );
      await admin.query(
        "INSERT INTO bop_identity.store_staff_invitation(brand_id,store_id,invitation_id,actor_id,membership_id,store_assignment_id,invited_by_actor_id,invitation_kind,environment,issuer,client_id,intent_digest,email_digest,email_hint,status,delivery,send_count,created_at,last_sent_at,expires_at,version,updated_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,'Staff',$8,$9,$10,$11,$12,'q•••@example.test','Pending','Sent',1,$13,$13,$14,1,$13,'PersonalData')",
        [
          brand,
          store,
          quinnInvitation,
          quinn,
          quinnMembership,
          quinnAssignment,
          owner,
          "acceptance",
          fake.issuer,
          fake.clientId,
          "sha256:" + "c".repeat(64),
          invitation.digestCorporateEmail("quinn@example.test"),
          old,
          new Date(Date.parse(old) + 7 * 86_400_000).toISOString(),
        ],
      );
      await admin.query("COMMIT");
      fake.users.set("bop_" + quinn, {
        ...fake.users.get("stranger"),
        username: "bop_" + quinn,
        sub: "00000000-0000-4000-8000-0000000000aa",
        email: "quinn@example.test",
        password: "Quinn-1",
        custom: { "custom:bop_invitation_intent": "sha256:" + "c".repeat(64) },
      });
      await assert.rejects(signIn({ email: "quinn@example.test", password: "Quinn-1" }));
      assert.equal(
        (await list()).staff.find((item) => item.actorReference === quinn).invitation.status,
        "Expired",
      );

      // Pat's next attempt works once Cognito answers again.
      const patFirst = await signIn({ email: "pat@example.test", password: "Pat-Real-1" });
      assert.equal(patFirst.session.actor.actorReference, pat);

      // ── 5. Resend: an unconfirmed send is resent; a lost account needs the email again.
      fake.fail("admin:AdminCreateUser", "lost-reply");
      const rae = await command("owner-cookie", {
        operation: "Invite",
        displayName: "Rae Kim",
        email: "rae@example.test",
        roleReference: roles.get("front_of_house"),
        operationReference: op(),
      });
      assert.equal(rae.delivery, "Unknown");
      let raeView = (await list()).staff.find((item) => item.actorReference === rae.actorReference);
      const resent = await command("owner-cookie", {
        operation: "ResendInvitation",
        actorReference: rae.actorReference,
        expectedVersion: raeView.invitation.version,
        operationReference: op(),
      });
      assert.deepEqual(resent, { status: "Resent", delivery: "Sent", emailNeeded: false });
      assert.ok(
        fake.invitations.some(
          (item) => item.username === "bop_" + rae.actorReference && item.resent,
        ),
      );
      fake.fail("admin:AdminCreateUser", "status-500");
      const lee = await command("owner-cookie", {
        operation: "Invite",
        displayName: "Lee Park",
        email: "lee@example.test",
        roleReference: roles.get("front_of_house"),
        operationReference: op(),
      });
      assert.equal(lee.delivery, "Unknown");
      assert.equal(fake.users.has("bop_" + lee.actorReference), false);
      const leeVersion = async () =>
        (await list()).staff.find((item) => item.actorReference === lee.actorReference).invitation
          .version;
      assert.deepEqual(
        await command("owner-cookie", {
          operation: "ResendInvitation",
          actorReference: lee.actorReference,
          expectedVersion: await leeVersion(),
          operationReference: op(),
        }),
        { status: "Resent", delivery: "Unknown", emailNeeded: true },
      );
      await assert.rejects(
        command("owner-cookie", {
          operation: "ResendInvitation",
          actorReference: lee.actorReference,
          expectedVersion: await leeVersion(),
          operationReference: op(),
          email: "someone-else@example.test",
        }),
        { code: "EmailMismatch" },
      );
      assert.deepEqual(
        await command("owner-cookie", {
          operation: "ResendInvitation",
          actorReference: lee.actorReference,
          expectedVersion: await leeVersion(),
          operationReference: op(),
          email: "LEE@example.test",
        }),
        { status: "Resent", delivery: "Sent", emailNeeded: false },
      );
      await assert.rejects(
        command("owner-cookie", {
          operation: "ResendInvitation",
          actorReference: lee.actorReference,
          expectedVersion: 1,
          operationReference: op(),
        }),
        { code: "Conflict" },
      );

      // ── 6. Revoke: the waiting Membership ends, the role request closes, the account goes.
      raeView = (await list()).staff.find((item) => item.actorReference === rae.actorReference);
      const revoked = await command("manager-cookie", {
        operation: "RevokeInvitation",
        actorReference: rae.actorReference,
        expectedVersion: raeView.invitation.version,
        operationReference: op(),
      });
      assert.deepEqual(revoked, { status: "Applied", accountRemoved: true });
      assert.equal(fake.users.has("bop_" + rae.actorReference), false);
      assert.equal(
        (await list()).staff.some((item) => item.actorReference === rae.actorReference),
        false,
      );
      assert.deepEqual(
        (
          await rows(
            "SELECT m.lifecycle m,s.lifecycle s,i.status FROM bop_identity.store_staff_invitation i JOIN bop_membership.membership m ON m.membership_id=i.membership_id JOIN bop_membership.store_assignment s ON s.membership_id=i.membership_id WHERE i.actor_id=$1",
            [rae.actorReference],
          )
        )[0],
        { m: "Ended", s: "Ended", status: "Revoked" },
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int n FROM bop_permission.role_assignment_change c WHERE c.actor_id=$1 AND NOT EXISTS (SELECT 1 FROM bop_permission.role_assignment_change_decision d WHERE d.change_id=c.change_id)",
            [rae.actorReference],
          )
        )[0].n,
        0,
      );
      // The same email can be invited again.
      const raeAgain = await command("owner-cookie", {
        operation: "Invite",
        displayName: "Rae Kim",
        email: "rae@example.test",
        roleReference: roles.get("front_of_house"),
        operationReference: op(),
      });
      assert.equal(raeAgain.delivery, "Sent");

      // ── 7. Step-up by signing in again: recorded for this session, single use, own person only.
      const stepUp = createMerchantProviderStepUp({
        persistence: { transactions: api, now: clock, identity },
        authentication: { bootstrap: (cookie) => service.bootstrap(cookie) },
        provider: provider.stepUp,
        issuer: fake.issuer,
        clientId: fake.clientId,
        environment: "acceptance",
        boundActor: people.boundActor,
        newReference: next,
      });
      const stepCallback = async (cookie, person, purpose = "RefundApproval") => {
        const started = await stepUp.start({
          sessionCookie: cookie,
          purpose,
          returnTo: "/app/payments/refunds",
        });
        const location = new URL(fake.signIn(started.authorizationUrl, person));
        assert.equal(location.pathname, "/merchant/identity/step-up/callback");
        const input = {
          code: location.searchParams.get("code"),
          state: location.searchParams.get("state"),
          error: undefined,
          stepUpCookie: started.cookie,
          sessionCookie: cookie,
        };
        return { result: await stepUp.callback(input), input };
      };
      const samSession = second.cookies.find(
        (item) => item.descriptor.name === "__Host-bop-merchant",
      ).value;
      const verified = await stepCallback(samSession, samPassword);
      assert.deepEqual(verified.result, { result: "verified", returnTo: "/app/payments/refunds" });
      assert.deepEqual(
        await rows(
          "SELECT method,purpose_code FROM bop_identity.workforce_mfa_step_up WHERE session_id=$1 ORDER BY attempted_at",
          [second.session.sessionReference],
        ),
        [
          { method: "CognitoReauthentication", purpose_code: "IDENTITY_SIGN_IN" },
          { method: "CognitoReauthentication", purpose_code: "PAYMENT_REFUND_APPROVAL" },
        ],
      );
      assert.notEqual((await stepUp.status({ sessionCookie: samSession })).validUntil, null);
      assert.deepEqual(await stepUp.callback(verified.input), {
        result: "failed",
        returnTo: "/app",
      });
      // Sam's session, but Pat signs in at Cognito: refused, nothing recorded for Sam.
      const before = (
        await rows("SELECT count(*)::int n FROM bop_identity.workforce_mfa_step_up")
      )[0].n;
      const wrong = await stepCallback(samSession, {
        email: "pat@example.test",
        password: "Pat-Real-1",
      });
      assert.equal(wrong.result.result, "failed");
      assert.equal(
        (await rows("SELECT count(*)::int n FROM bop_identity.workforce_mfa_step_up"))[0].n,
        before,
      );
      const cancelledStart = await stepUp.start({
        sessionCookie: samSession,
        purpose: "RefundRequest",
        returnTo: "/app",
      });
      const cancelledState = new URL(cancelledStart.authorizationUrl).searchParams.get("state");
      assert.deepEqual(
        await stepUp.callback({
          code: undefined,
          state: cancelledState,
          error: "access_denied",
          stepUpCookie: cancelledStart.cookie,
          sessionCookie: samSession,
        }),
        { result: "cancelled", returnTo: "/app" },
      );
      await assert.rejects(
        stepUp.start({ sessionCookie: samSession, purpose: "Everything", returnTo: "/app" }),
      );
      // Signing out ends the session and revokes its Cognito refresh token.
      const revokedBefore = fake.revoked.length;
      await service.logout(samSession);
      assert.equal(fake.revoked.length, revokedBefore + 1);
      await assert.rejects(service.bootstrap(samSession));

      // ── 8. Operator paths: a first Owner only for a Store without one; an existing member's own
      // sign-in keeps their Membership and history.
      const operatorInput = {
        scope: { brandReference: brand, storeReference: store },
        pool,
        provider: invitation,
        operatorReference: id(20),
        at: clock(),
        next,
      };
      await assert.rejects(
        inviteThroughOperator(admin, {
          ...operatorInput,
          kind: "FirstOwner",
          displayName: "Second Owner",
          email: "owner2@example.test",
        }),
        { code: "STORE_HAS_OWNER" },
      );
      // A new Store of the Brand with its template roles but no Owner yet.
      const store2 = id(800);
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'COG_STORE_2','Second Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [store2, brand, from],
      );
      await openSyntheticStoreRoles(admin, {
        tenant,
        brand,
        store: store2,
        operator: id(20),
        approver: id(21),
        at: from,
        next,
      });
      const firstOwner = await inviteThroughOperator(admin, {
        ...operatorInput,
        scope: { brandReference: brand, storeReference: store2 },
        kind: "FirstOwner",
        displayName: "Nora Owner",
        email: "nora@example.test",
      });
      assert.equal(firstOwner.delivery, "Sent");
      assert.equal(fake.users.has("bop_" + firstOwner.actorReference), true);
      const [ownerRequest] = await rows(
        "SELECT r.role_code,c.requested_by::text requested_by FROM bop_permission.role_assignment_change c JOIN bop_permission.role r ON r.role_id=c.role_id WHERE c.change_id=$1",
        [firstOwner.ownerRoleChange],
      );
      assert.deepEqual(ownerRequest, { role_code: "store_owner", requested_by: id(20) });
      await assert.rejects(
        inviteThroughOperator(admin, {
          ...operatorInput,
          scope: { brandReference: brand, storeReference: store2 },
          kind: "FirstOwner",
          displayName: "Another Owner",
          email: "other@example.test",
        }),
        { code: "STORE_OWNER_REQUEST_OPEN" },
      );
      const linked = await inviteThroughOperator(admin, {
        ...operatorInput,
        kind: "ExistingMember",
        actorReference: cashier,
        email: "cam@example.test",
      });
      assert.equal(linked.delivery, "Sent");
      await assert.rejects(
        inviteThroughOperator(admin, {
          ...operatorInput,
          kind: "ExistingMember",
          actorReference: cashier,
          email: "cam@example.test",
        }),
      );
      await tick();
      const cam = await signIn({
        email: "cam@example.test",
        password: fake.users.get("bop_" + cashier).temporaryPassword,
        newPassword: "Cam-Real-1",
      });
      assert.equal(cam.session.actor.actorReference, cashier);
      assert.deepEqual(
        (
          await rows(
            "SELECT m.lifecycle,m.version,i.status,i.invitation_kind FROM bop_membership.membership m JOIN bop_identity.store_staff_invitation i ON i.membership_id=m.membership_id WHERE m.actor_id=$1",
            [cashier],
          )
        )[0],
        { lifecycle: "Active", version: 1, status: "Accepted", invitation_kind: "ExistingMember" },
      );
      await assert.rejects(
        inviteThroughOperator(admin, {
          ...operatorInput,
          kind: "ExistingMember",
          actorReference: cashier,
          email: "cam2@example.test",
        }),
        { code: "STORE_MEMBER_HAS_SIGN_IN" },
      );

      // ── 9. The merchant routes over HTTP: sign-in, callback, step-up window, sign-out.
      const minimal = {
        start: (path) => service.start(path),
        callback: (input) => service.callback(input),
        authorize: (input) => service.authorize(input),
        recordActivity: (input, extend) => service.recordActivity(input, extend),
        logout: (cookie) => service.logout(cookie),
        bootstrap: async (cookie) => ({ ...(await service.bootstrap(cookie)), workspace: null }),
        switchStore: async () => {
          throw new Error("NOT_USED");
        },
      };
      const app = express();
      app.use(
        "/merchant",
        createMerchantBffRouter({
          service: minimal,
          exactOrigin: origin,
          acceptedHost: "staff.example.test",
          signInEntry: { path: "/operations/sign-in", testOnly: false },
          providerStepUp: stepUp,
        }),
      );
      const server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      const send = (path, { cookie, method = "GET", headers = {} } = {}) =>
        new Promise((resolve, reject) => {
          const call = httpRequest(
            {
              host: "127.0.0.1",
              port: server.address().port,
              path,
              method,
              headers: {
                Host: "staff.example.test",
                "Sec-Fetch-Site": "same-origin",
                ...(cookie ? { Cookie: cookie } : {}),
                ...headers,
              },
            },
            (response) => {
              let text = "";
              response.setEncoding("utf8");
              response.on("data", (value) => (text += value));
              response.on("end", () =>
                resolve({ status: response.statusCode, headers: response.headers, text }),
              );
            },
          );
          call.on("error", reject);
          call.end();
        });
      const cookieOf = (response, name) =>
        (response.headers["set-cookie"] ?? [])
          .find((item) => item.startsWith(name + "=") && !item.includes("Max-Age=0"))
          ?.split(";")[0];
      try {
        const login = await send("/merchant/login?returnTo=/app");
        assert.equal(login.status, 303);
        assert.ok(
          login.headers.location.startsWith(fake.managedLoginOrigin + "/oauth2/authorize?"),
        );
        const back = new URL(fake.signIn(login.headers.location, samPassword));
        const callback = await send(back.pathname + back.search, {
          cookie: cookieOf(login, "__Host-bop-auth"),
          headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" },
        });
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.location, "/app");
        const session = cookieOf(callback, "__Host-bop-merchant");
        assert.ok(session);
        const status = await send("/merchant/identity/step-up", { cookie: session });
        assert.equal(status.status, 200);
        assert.equal(JSON.parse(status.text).method, "SignIn");
        await tick();
        const start = await send(
          "/merchant/identity/step-up/start?purpose=RefundRequest&returnTo=%2Fapp%2Fpayments",
          {
            cookie: session,
          },
        );
        assert.equal(start.status, 303);
        const windowCookie = cookieOf(start, "__Host-bop-step-up");
        assert.match(start.headers["set-cookie"].join(";"), /HttpOnly; SameSite=Lax; Max-Age=600/u);
        const stepBack = new URL(fake.signIn(start.headers.location, samPassword));
        const done = await send(stepBack.pathname + stepBack.search, {
          cookie: session + "; " + windowCookie,
          headers: { "Sec-Fetch-Site": "cross-site" },
        });
        assert.equal(done.status, 303);
        assert.equal(
          done.headers.location,
          "/app/identity/step-up-complete?result=verified&returnTo=%2Fapp%2Fpayments",
        );
        // A refused sign-in sends the person to the sign-in page that says so.
        const refused = await send("/merchant/callback?code=x&state=" + "s".repeat(43), {
          cookie: "__Host-bop-auth=" + "a".repeat(43),
          headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" },
        });
        assert.equal(refused.status, 303);
        assert.equal(refused.headers.location, "/operations/sign-in?signIn=failed");
        const csrf = (await service.bootstrap(session.split("=")[1])).csrf;
        const out = await send("/merchant/logout", {
          cookie: session,
          method: "POST",
          headers: { Origin: origin, "X-BOP-CSRF": csrf },
        });
        assert.equal(out.status, 204);
        const after = await send("/merchant/identity/step-up/start?purpose=RefundRequest", {
          cookie: session,
        });
        assert.equal(
          after.headers.location,
          "/app/identity/step-up-complete?result=failed&returnTo=%2Fapp",
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await fake.close();
      await admin.end();
    }
  });
});

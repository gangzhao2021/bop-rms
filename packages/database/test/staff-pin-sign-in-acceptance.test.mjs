import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createArgon2idStaffPinKdf,
  createIdentityActor,
  createPostgresBrowserSessionStore,
  createStoreDeviceSecretHasher,
  setStaffPin,
} from "../../bop/identity/src/index.ts";
import { createMerchantStaffPin } from "../../../apps/api/src/merchant-staff-pin.ts";
import {
  installMerchantStaffPinRoutes,
  staffPinFullSignInGate,
} from "../../../apps/api/src/merchant-staff-pin-http.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// Only the selected-Store resolution is a test double (the cookie names a real session row whose
// actor holds the listed permissions at the Store). Sessions, tablets, PINs, PIN checks, PIN
// sessions, step-ups, memberships and audits are the real owners over real rows, run as a
// restricted NOBYPASSRLS role holding exactly the rendered pilot API grants.
const signedIn = vi.hoisted(() => ({ scopeFor: null }));
vi.mock("../../../apps/api/src/merchant-store-scope.ts", () => ({
  createMerchantStoreScope: () => async (tx, cookie, action, expected) =>
    signedIn.scopeFor(tx, cookie, action, expected),
}));
const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);

const { Client } = pg;
const id = (n) => "0190b3a0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const minutes = (n) => n * 60_000;
const [brand, store, otherStore] = [1, 2, 3].map(id);
const [manager, ava, cole, former, otherManager] = [10, 11, 12, 13, 14].map(id);
const names = { [manager]: "Mia", [ava]: "Ava", [cole]: "Cole", [former]: "Finn" };
const managerActions = new Set([
  "merchant.access",
  "identity.store_device.manage",
  "identity.staff_pin.reset",
]);
const staffActions = new Set(["merchant.access"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 Q18 option A (DEC-STAFF-SESSION-CONTINUITY section 5, Owner 2026-10-14): device-bound
 * six-digit staff PIN on a shared Store tablet.
 */
it("WP-2423 staff PIN: tablets, PINs, lockout, tablet limit, reset, switch and step-up gate", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_pin" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_pin_api_" + context.runId,
      worker = "wp2423_pin_w_" + context.runId;
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

      // ── Fixtures (owner): Brand, two Stores, members with names. Former left the Store.
      const dbNow = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      // The scenario runs over the last two hours so audit times are never in the future.
      const base = dbNow - minutes(120);
      const T = (offset) => new Date(base + minutes(offset)).toISOString();
      let clock = T(0);
      const from = T(-600);
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'PIN','Pin Brand','en-CA','CAD','Active',1,$2,$2)",
        [brand, from],
      );
      for (const [s, code] of [
        [store, "PIN_STORE"],
        [otherStore, "PIN_OTHER"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store VALUES ($1,$2,$3,'Pin Store','America/Toronto','en-CA','CAD','Active',1,$4,$4)",
          [s, brand, code, from],
        );
      let n = 100;
      async function member(actor, at, lifecycle = "Active", name = names[actor]) {
        const membership = id(n++),
          assignment = id(n++);
        await admin.query(
          "INSERT INTO bop_membership.membership(membership_id,actor_id,brand_id,workforce_relationship_reference,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'Active',$5,NULL,1,$5,$5)",
          [membership, actor, brand, id(n++), from],
        );
        await admin.query(
          "INSERT INTO bop_membership.store_assignment(assignment_id,membership_id,actor_id,brand_id,store_id,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,1,$7,$7)",
          [assignment, membership, actor, brand, at, lifecycle, from],
        );
        if (name !== undefined)
          await admin.query(
            "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) VALUES ($1,1,$2,$3,$4,$5,$3,$6,'PersonalData')",
            [membership, brand, actor, name, id(n++), from],
          );
      }
      await member(manager, store);
      await member(ava, store);
      await member(cole, store);
      await member(former, store, "Ended");
      await member(otherManager, otherStore, "Active", "Omar");

      const transactionsAs = (name) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + name);
            await client.query("SET LOCAL lock_timeout='2s'");
            await client.query("SET LOCAL statement_timeout='10s'");
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
      let next = 1000;
      const reference = () => id(next++);
      const actorAt = (reference, authenticatedAt) =>
        createIdentityActor({
          actorType: "User",
          actorReference: reference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt,
          recentMfaAt: null,
        });
      const finalizers = new Map();
      const sessionStore = createPostgresBrowserSessionStore({
        transactions: api,
        environment: "internal-test",
        redirectUri: "https://127.0.0.1:4443/merchant/callback",
        allowedPostLoginPaths: ["/operations/orders"],
        now: () => clock,
        currentActor: async (_tx, actor, authenticatedAt) => actorAt(actor, authenticatedAt),
        onSessionCreated: async (tx, record) => {
          const finalize = finalizers.get(record.session.sessionReference);
          if (finalize !== undefined) await finalize(tx, record.session);
        },
      });
      const hasher = { hash: sha, equals: (a, b) => a === b };
      /** A full sign-in (or, with finalize, the PIN sign-in) of one person; returns its cookie. */
      async function signIn(actor, finalize) {
        const sessionReference = reference(),
          cookie = randomBytes(32).toString("base64url"),
          csrf = randomBytes(32).toString("base64url");
        if (finalize !== undefined) finalizers.set(sessionReference, finalize);
        try {
          await sessionStore.createSession({
            sessionReference,
            actor: actorAt(actor, clock),
            policyCode: "WorkforceStandard",
            sessionSelectorHash: sha(cookie),
            csrfSelectorHash: sha(csrf),
            encryptedSecrets: {
              algorithm: "SYNTHETIC_AES_256_GCM",
              keyReference: "internal-test-key",
              ciphertext: Buffer.alloc(48, 7).toString("base64url"),
              encryptionContext: "internal-test:session:" + sessionReference + ":" + actor,
            },
            observedAt: clock,
          });
        } finally {
          finalizers.delete(sessionReference);
        }
        return cookie;
      }
      const sessionRow = async (cookie) =>
        (
          await admin.query(
            "SELECT session_id::text AS session,actor_id::text AS actor,status,revocation_reason FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex')",
            [sha(cookie)],
          )
        ).rows[0];
      const authentication = {
        async authorize({ sessionCookie }) {
          const record = await sessionStore.resolveSession(sha(String(sessionCookie)));
          if (
            !record ||
            record.session.status !== "Active" ||
            record.session.idleExpiresAt <= clock ||
            record.session.absoluteExpiresAt <= clock
          )
            throw new Error("BROWSER_SESSION_DENIED");
          return record.session;
        },
      };
      const permissions = { [manager]: managerActions, [otherManager]: managerActions };
      const storeOf = { [otherManager]: otherStore };
      signedIn.scopeFor = async (tx, cookie, action, expected) => {
        const found = (
          await tx.query(
            "SELECT session_id::text AS session,actor_id::text AS actor FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex') AND status='Active' AND idle_expires_at>$2 AND absolute_expires_at>$2",
            [sha(String(cookie)), clock],
          )
        ).rows[0];
        if (!found || (expected !== undefined && expected !== found.session))
          throw new Error("STORE_SERVICE_PERMISSION_DENIED");
        const held = permissions[found.actor] ?? staffActions;
        return {
          context: { brand: { brandReference: brand }, resolvedAt: clock },
          store: { storeReference: storeOf[found.actor] ?? store },
          actorReference: found.actor,
          sessionReference: found.session,
          allowed: async () => held.has(action),
          authorizeAction: async (requested) => ({
            effect: held.has(requested) ? "Allow" : "Deny",
          }),
        };
      };
      const pepper = randomBytes(32);
      const kdf = createArgon2idStaffPinKdf({
        peppers: new Map([[1, pepper]]),
        currentPepperVersion: 1,
      });
      const deviceHasher = createStoreDeviceSecretHasher(randomBytes(32));
      const staffPin = createMerchantStaffPin({
        persistence: {
          transactions: api,
          now: () => clock,
          identity: { hasher },
        },
        authentication,
        deviceHasher,
        kdf,
        newReference: reference,
        describeStore: async (_tx, scope) => ({
          label: scope.storeReference === store ? "Pin Store" : "Other Store",
          timeZone: "America/Toronto",
        }),
        issueSession: async (actor, finalize) => ({ sessionCookie: await signIn(actor, finalize) }),
        retentionPolicyCode: "SECURITY_AUDIT",
        retentionPolicyVersion: 1,
      });
      const csrf = "c".repeat(43);
      const at = async (offset, work) => {
        clock = T(offset);
        return work();
      };
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => {
          assert.equal(error?.code, code);
          return true;
        });

      // ── 1. The manager (full sign-in) registers this tablet; the cookie is the only secret.
      const mia = await at(0, () => signIn(manager));
      const registered = await at(1, () =>
        staffPin.registerDevice({
          sessionCookie: mia,
          csrf,
          deviceCookie: null,
          label: "  Front counter ",
        }),
      );
      assert.equal(registered.status, "Registered");
      assert.match(registered.deviceCookie, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(registered.device.label, "Front counter");
      assert.equal(registered.device.registeredBy, "Mia");
      const tablet = registered.deviceCookie;
      assert.equal(await staffPin.isRegisteredDevice(tablet), true);
      assert.equal(await staffPin.isRegisteredDevice(randomBytes(32).toString("base64url")), false);
      await rejects(
        at(1, () =>
          staffPin.registerDevice({
            sessionCookie: mia,
            csrf,
            deviceCookie: tablet,
            label: "Again",
          }),
        ),
        "AlreadyRegistered",
      );
      assert.equal(
        (
          await at(1, () =>
            staffPin.registerDevice({
              sessionCookie: mia,
              csrf,
              deviceCookie: null,
              label: "\u0007",
            }),
          )
        ).status,
        "LabelInvalid",
      );
      const deviceRow = (
        await admin.query(
          "SELECT row_to_json(d)::text AS raw,encode(device_selector_hash,'hex') AS hash FROM bop_identity.store_sign_in_device d",
        )
      ).rows;
      assert.equal(deviceRow.length, 1);
      assert.ok(!deviceRow[0].raw.includes(tablet), "the tablet secret is never stored");
      assert.equal(deviceRow[0].hash, deviceHasher.hash(tablet));
      // Staff without the permission cannot register or list tablets.
      const avaFull = await at(2, () => signIn(ava));
      await rejects(
        staffPin.registerDevice({
          sessionCookie: avaFull,
          csrf,
          deviceCookie: null,
          label: "Mine",
        }),
        "Denied",
      );
      await rejects(staffPin.overview({ sessionCookie: avaFull, deviceCookie: tablet }), "Denied");

      // ── 2. Each staff member sets their own PIN after a full sign-in (twice, not trivial).
      const set = (cookie, pin, confirmation = pin) =>
        staffPin.setOwnPin({ sessionCookie: cookie, csrf, pin, confirmation });
      assert.deepEqual(await at(3, () => set(avaFull, "48291")), { problem: "Format" });
      assert.deepEqual(await at(3, () => set(avaFull, "482913", "482914")), {
        problem: "Mismatch",
      });
      for (const trivial of ["000000", "123456", "654321", "121212", "123123"])
        assert.deepEqual(await at(3, () => set(avaFull, trivial)), { problem: "TooSimple" });
      assert.deepEqual(await at(3, () => set(avaFull, "482913")), {
        state: "Set",
        changedAt: T(3),
        lockedUntil: null,
      });
      const coleFull = await at(3, () => signIn(cole));
      await at(3, () => set(coleFull, "730418"));
      const miaPin = await at(3, () => set(mia, "905172"));
      assert.equal(miaPin.state, "Set");
      // Former's PIN was set while they still worked here (owner-side fixture of an old PIN).
      await at(3, () =>
        api.run((tx) =>
          setStaffPin(
            tx,
            {
              brandReference: brand,
              storeReference: store,
              actorReference: former,
              sessionReference: reference(),
              pin: "381904",
              confirmation: "381904",
              at: T(3),
              auditReference: reference(),
            },
            kdf,
            { retentionPolicyCode: "SECURITY_AUDIT", retentionPolicyVersion: 1 },
          ),
        ),
      );
      const credentials = (
        await admin.query(
          "SELECT actor_id::text AS actor,credential_version,status,kdf_algorithm,kdf_memory_kib,kdf_passes,kdf_parallelism,octet_length(pin_hash) AS bytes,row_to_json(c)::text AS raw FROM bop_identity.staff_pin_credential c ORDER BY actor_id",
        )
      ).rows;
      assert.equal(credentials.length, 4);
      for (const row of credentials) {
        assert.deepEqual(
          [
            row.status,
            row.kdf_algorithm,
            row.kdf_memory_kib,
            row.kdf_passes,
            row.kdf_parallelism,
            row.bytes,
          ],
          ["Active", "argon2id", 19456, 2, 1, 32],
        );
        for (const pin of ["482913", "730418", "905172", "381904"])
          assert.ok(!row.raw.includes(pin), "no PIN is stored");
      }

      // ── 3. The lock screen lists active members with a PIN (names only); Former is not listed.
      const screen = await at(4, () => staffPin.switchScreen(tablet));
      assert.deepEqual(screen, {
        storeLabel: "Pin Store",
        timeZone: "America/Toronto",
        staff: [
          { choice: ava, name: "Ava" },
          { choice: cole, name: "Cole" },
          { choice: manager, name: "Mia" },
        ],
      });
      await rejects(
        staffPin.switchScreen(randomBytes(32).toString("base64url")),
        "DeviceNotRegistered",
      );
      await rejects(staffPin.switchScreen(null), "DeviceNotRegistered");

      // ── 4. Switch: a correct PIN starts the person's ordinary session and ends the tablet's
      //       previous session (here Mia's full sign-in held by this browser).
      const unlock = (choice, pin, sessionCookie = null, deviceCookie = tablet) =>
        staffPin.unlock({ deviceCookie, sessionCookie, choice, pin });
      const avaSwitch = await at(5, () => unlock(ava, "482913", mia));
      assert.equal(avaSwitch.status, "SignedIn");
      const avaPin = avaSwitch.sessionCookie;
      assert.deepEqual(await sessionRow(mia), {
        session: (await sessionRow(mia)).session,
        actor: manager,
        status: "Revoked",
        revocation_reason: "Logout",
      });
      const avaPinRow = await sessionRow(avaPin);
      assert.equal(avaPinRow.actor, ava);
      assert.equal(avaPinRow.status, "Active");
      const policy = (
        await admin.query(
          "SELECT policy_code FROM bop_identity.authentication_session WHERE session_id=$1",
          [avaPinRow.session],
        )
      ).rows[0].policy_code;
      assert.equal(policy, "WorkforceStandard");
      assert.deepEqual(await at(5, () => staffPin.ownPin({ sessionCookie: avaPin })), {
        pin: { state: "Set", changedAt: T(3), lockedUntil: null },
        signIn: "Pin",
        verifiedUntil: null,
      });
      // The next person on the same tablet ends Ava's PIN session, even without her cookie.
      const coleSwitch = await at(6, () => unlock(cole, "730418"));
      assert.equal(coleSwitch.status, "SignedIn");
      assert.equal((await sessionRow(avaPin)).status, "Revoked");
      assert.equal((await sessionRow(avaPin)).revocation_reason, "Logout");
      const colePin = coleSwitch.sessionCookie;
      // A verified check is single use: it cannot back a second session.
      const verified = (
        await admin.query(
          "SELECT attempt_id::text AS attempt,device_id::text AS device FROM bop_identity.staff_pin_session WHERE actor_id=$1",
          [cole],
        )
      ).rows[0];
      const avaFull2 = await at(6, () => signIn(ava));
      await assert.rejects(
        api.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await tx.query(
            "INSERT INTO bop_identity.staff_pin_session (brand_id,store_id,session_id,attempt_id,device_id,actor_id,issued_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,'IndirectIdentifier')",
            [
              brand,
              store,
              (await sessionRow(avaFull2)).session,
              verified.attempt,
              verified.device,
              ava,
              T(6),
            ],
          );
        }),
        /STAFF_PIN_SESSION_UNVERIFIED|staff_pin_session_attempt_unique/u,
      );

      // ── 5. An unverified PIN session cannot do sensitive actions; a step-up in it can.
      assert.equal(
        await at(7, () => staffPin.requiresFullSignIn({ sessionCookie: colePin, csrf })),
        true,
      );
      assert.equal(
        await at(7, () => staffPin.requiresFullSignIn({ sessionCookie: coleFull, csrf })),
        false,
      );
      await rejects(
        at(7, () => set(colePin, "730419")),
        "FullSignInRequired",
      );
      // Through HTTP: the BFF gate refuses a refund request of the PIN session.
      const app = express();
      const router = express.Router();
      const routeOptions = {
        exactOrigin: "https://127.0.0.1:4443",
        staffPin,
        fullSignIn: { path: "/internal-test/staff", testOnly: true },
      };
      router.use(staffPinFullSignInGate(routeOptions));
      installMerchantStaffPinRoutes(router, routeOptions);
      router.post("/payments/refunds/request", (_request, response) =>
        response.json({ reached: true }),
      );
      app.use("/merchant", router);
      const server = createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const call = (path, { cookies = {}, method = "POST", body } = {}) =>
        globalThis.fetch("http://127.0.0.1:" + port + "/merchant" + path, {
          method,
          headers: {
            origin: "https://127.0.0.1:4443",
            "sec-fetch-site": "same-origin",
            "x-bop-csrf": csrf,
            "content-type": "application/json",
            cookie: Object.entries(cookies)
              .map(([name, value]) => name + "=" + value)
              .join("; "),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      try {
        clock = T(7);
        const refused = await call("/payments/refunds/request", {
          cookies: { "__Host-bop-merchant": colePin },
          body: {},
        });
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: "full_sign_in_required" });
        const allowed = await call("/payments/refunds/request", {
          cookies: { "__Host-bop-merchant": coleFull },
          body: {},
        });
        assert.equal(allowed.status, 200);
        // The lock screen over HTTP: no session, the tablet cookie only; wrong PIN is 401.
        const lock = await call("/staff-switch", {
          method: "GET",
          cookies: { "__Host-bop-store-device": tablet },
        });
        assert.equal(lock.status, 200);
        const lockBody = await lock.json();
        assert.deepEqual(
          lockBody.staff.map((item) => item.name),
          ["Ava", "Cole", "Mia"],
        );
        assert.deepEqual(lockBody.fullSignIn, { path: "/internal-test/staff", testOnly: true });
        const unknownTablet = await call("/staff-switch", {
          method: "GET",
          cookies: { "__Host-bop-store-device": randomBytes(32).toString("base64url") },
        });
        assert.equal(unknownTablet.status, 404);
        assert.match(unknownTablet.headers.get("set-cookie") ?? "", /Max-Age=0/u);
        clock = T(7.5);
        const wrong = await call("/staff-switch/unlock", {
          cookies: { "__Host-bop-store-device": tablet },
          body: { choice: cole, pin: "111112" },
        });
        assert.equal(wrong.status, 401);
        assert.deepEqual(await wrong.json(), { error: "pin_rejected" });
        const crossSite = await globalThis.fetch(
          "http://127.0.0.1:" + port + "/merchant/staff-switch/unlock",
          {
            method: "POST",
            headers: {
              origin: "https://evil.example",
              "sec-fetch-site": "cross-site",
              "content-type": "application/json",
              cookie: "__Host-bop-store-device=" + tablet,
            },
            body: JSON.stringify({ choice: cole, pin: "730418" }),
          },
        );
        assert.equal(crossSite.status, 403);
        clock = T(7.6);
        const right = await call("/staff-switch/unlock", {
          cookies: { "__Host-bop-store-device": tablet },
          body: { choice: cole, pin: "730418" },
        });
        assert.equal(right.status, 200);
        assert.deepEqual(await right.json(), { status: "SignedIn", next: "/operations/orders" });
        assert.match(
          right.headers.get("set-cookie") ?? "",
          /^__Host-bop-merchant=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/u,
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      const colePin2 = (
        await admin.query(
          "SELECT s.session_id::text AS session FROM bop_identity.staff_pin_session p JOIN bop_identity.authentication_session s USING (session_id) WHERE p.actor_id=$1 AND s.status='Active'",
          [cole],
        )
      ).rows;
      assert.equal(colePin2.length, 1, "only the latest PIN session on the tablet stays active");
      // A step-up (second factor) made in the PIN session lets it act for 15 minutes.
      const colePinNow = colePin;
      assert.equal((await sessionRow(colePinNow)).status, "Revoked");
      const coleSwitch2 = await at(8, () => unlock(cole, "730418"));
      const colePin3 = coleSwitch2.sessionCookie;
      const colePin3Row = await sessionRow(colePin3);
      // (Owner-side fixture of the Q5 step-up record: a verified second factor in this session.)
      await admin.query(
        "INSERT INTO bop_identity.workforce_mfa_step_up (step_up_id,brand_id,store_id,actor_id,session_id,method,purpose_code,outcome,rejection_reason,time_step,attempted_at,audit_id) VALUES ($1,$2,$3,$4,$5,'InternalTestTotp','IDENTITY_PIN_SESSION_ELEVATION','Verified',NULL,1,$6,$7)",
        [reference(), brand, store, cole, colePin3Row.session, T(8.5), reference()],
      );
      assert.equal(
        await at(9, () => staffPin.requiresFullSignIn({ sessionCookie: colePin3, csrf })),
        false,
      );
      assert.equal(
        (await at(9, () => staffPin.ownPin({ sessionCookie: colePin3 }))).verifiedUntil,
        T(23.5),
      );
      assert.equal((await at(9, () => set(colePin3, "730419"))).state, "Set");
      // Fifteen minutes after the step-up the PIN session is restricted again (read only).
      clock = new Date(Date.parse(T(23.5)) + 1).toISOString();
      assert.equal(await staffPin.requiresFullSignIn({ sessionCookie: colePin3, csrf }), true);

      // ── 6. Five consecutive wrong PINs lock Ava for 15 minutes; the sixth try (even right) is
      //       refused; after 15 minutes the right PIN works again.
      const second = await at(9, async () =>
        staffPin.registerDevice({
          sessionCookie: await signIn(manager),
          csrf,
          deviceCookie: null,
          label: "Kitchen pass",
        }),
      );
      const kitchenTablet = second.deviceCookie;
      for (const [k, wrongPin] of ["111111", "222223", "333334", "444445"].entries())
        assert.deepEqual(await at(10 + k, () => unlock(ava, wrongPin, null, kitchenTablet)), {
          status: "Rejected",
        });
      assert.deepEqual(await at(14, () => unlock(ava, "555556", null, kitchenTablet)), {
        status: "Locked",
        lockedUntil: T(29),
      });
      assert.deepEqual(await at(15, () => unlock(ava, "482913", null, kitchenTablet)), {
        status: "Locked",
        lockedUntil: T(29),
      });
      // The lock is per person: Cole still switches on the same tablet.
      assert.equal(
        (await at(16, () => unlock(cole, "730419", null, kitchenTablet))).status,
        "SignedIn",
      );
      const managerFull = await at(16, () => signIn(manager));
      const lockedView = await at(16, () =>
        staffPin.overview({ sessionCookie: managerFull, deviceCookie: kitchenTablet }),
      );
      assert.deepEqual(
        lockedView.staffPins.find((item) => item.staff === ava),
        { staff: ava, name: "Ava", state: "Set", changedAt: T(3), lockedUntil: T(29) },
      );
      assert.deepEqual(lockedView.thisDevice, {
        device: second.device.device,
        label: "Kitchen pass",
      });
      assert.deepEqual(
        lockedView.devices.map((item) => [item.label, item.registeredBy]),
        [
          ["Front counter", "Mia"],
          ["Kitchen pass", "Mia"],
        ],
      );
      assert.deepEqual(await at(28.99, () => unlock(ava, "482913", null, kitchenTablet)), {
        status: "Locked",
        lockedUntil: T(29),
      });
      assert.equal(
        (await at(29, () => unlock(ava, "482913", null, kitchenTablet))).status,
        "SignedIn",
      );
      const failureNumbers = (
        await admin.query(
          "SELECT outcome,failure_number FROM bop_identity.staff_pin_attempt WHERE actor_id=$1 AND device_id=$2 ORDER BY attempted_at",
          [ava, second.device.device],
        )
      ).rows.map((row) => [row.outcome, row.failure_number]);
      assert.deepEqual(failureNumbers, [
        ["Rejected", 1],
        ["Rejected", 2],
        ["Rejected", 3],
        ["Rejected", 4],
        ["Rejected", 5],
        ["Verified", null],
      ]);
      // The database refuses a check recorded while the PIN is locked or numbered wrongly.
      await assert.rejects(
        api.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await tx.query(
            "INSERT INTO bop_identity.staff_pin_attempt (brand_id,store_id,attempt_id,device_id,actor_id,credential_version,outcome,rejection_reason,failure_number,attempted_at,audit_id,data_classification) VALUES ($1,$2,$3,$4,$5,1,'Rejected','PinMismatch',3,$6,$7,'IndirectIdentifier')",
            [brand, store, reference(), second.device.device, ava, T(29.5), reference()],
          );
        }),
        /STAFF_PIN_FAILURE_NUMBER/u,
      );

      // ── 7. A tablet pauses after ten rejected checks in 15 minutes, whoever they name.
      const third = await at(30, async () =>
        staffPin.registerDevice({
          sessionCookie: await signIn(manager),
          csrf,
          deviceCookie: null,
          label: "Patio",
        }),
      );
      const patio = third.deviceCookie;
      const spray = [
        [cole, "100001"],
        [cole, "100002"],
        [cole, "100003"],
        [cole, "100004"],
        [manager, "100005"],
        [manager, "100006"],
        [manager, "100007"],
        [manager, "100008"],
        [former, "381904"],
        [id(999), "100009"],
      ];
      for (const [k, [who, pin]] of spray.entries())
        assert.deepEqual(await at(31 + k * 0.5, () => unlock(who, pin, null, patio)), {
          status: "Rejected",
        });
      assert.deepEqual(await at(36, () => unlock(cole, "730419", null, patio)), {
        status: "Throttled",
        retryAfterSeconds: 600,
      });
      // Other tablets keep working; this one frees up 15 minutes after its first rejection.
      assert.equal(
        (await at(36, () => unlock(cole, "730419", null, kitchenTablet))).status,
        "SignedIn",
      );
      assert.equal((await at(46, () => unlock(cole, "730419", null, patio))).status, "SignedIn");
      // Former (no longer at this Store) is refused with their old, correct PIN; nobody's
      // existence is revealed beyond the list: the same answer as a wrong PIN.
      assert.deepEqual(await at(47, () => unlock(former, "381904", null, patio)), {
        status: "Rejected",
      });
      const formerRows = (
        await admin.query(
          "SELECT outcome,rejection_reason,credential_version FROM bop_identity.staff_pin_attempt WHERE actor_id=$1",
          [former],
        )
      ).rows;
      assert.ok(formerRows.every((row) => row.rejection_reason === "NoActivePin"));

      // ── 8. A manager resets Ava's PIN: her PIN sessions end, the PIN stops working, she sets a
      //       new one after a full sign-in. A PIN session of the manager cannot reset.
      const miaPinSwitch = await at(48, () => unlock(manager, "905172", null, kitchenTablet));
      await rejects(
        at(48, () =>
          staffPin.resetPin({ sessionCookie: miaPinSwitch.sessionCookie, csrf, staff: ava }),
        ),
        "FullSignInRequired",
      );
      await rejects(
        at(48, () =>
          staffPin.registerDevice({
            sessionCookie: miaPinSwitch.sessionCookie,
            csrf,
            deviceCookie: null,
            label: "Bar",
          }),
        ),
        "FullSignInRequired",
      );
      const avaOnFront = await at(49, () => unlock(ava, "482913"));
      assert.equal(avaOnFront.status, "SignedIn");
      const avaFull3 = await at(49.5, () => signIn(ava));
      const miaFull3 = await at(50, () => signIn(manager));
      const coleFull2 = await at(50, () => signIn(cole));
      await rejects(
        at(50, () => staffPin.resetPin({ sessionCookie: coleFull2, csrf, staff: ava })),
        "Denied",
      );
      assert.deepEqual(
        await at(50, () => staffPin.resetPin({ sessionCookie: miaFull3, csrf, staff: ava })),
        { state: "Reset", changedAt: T(50), lockedUntil: null },
      );
      assert.deepEqual(await sessionRow(avaOnFront.sessionCookie), {
        session: (await sessionRow(avaOnFront.sessionCookie)).session,
        actor: ava,
        status: "Revoked",
        revocation_reason: "CredentialReset",
      });
      assert.equal((await sessionRow(avaFull3)).status, "Active", "her full sign-in is kept");
      await rejects(
        at(50, () => staffPin.resetPin({ sessionCookie: miaFull3, csrf, staff: ava })),
        "NotSet",
      );
      await rejects(
        at(50, () => staffPin.resetPin({ sessionCookie: miaFull3, csrf, staff: id(998) })),
        "NotFound",
      );
      assert.deepEqual(await at(51, () => unlock(ava, "482913")), { status: "Rejected" });
      assert.deepEqual(
        (await at(51, () => staffPin.switchScreen(tablet))).staff.map((item) => item.name),
        ["Cole", "Mia"],
      );
      assert.equal(
        (await at(52, () => staffPin.ownPin({ sessionCookie: avaFull3 }))).pin.state,
        "Reset",
      );
      assert.equal((await at(52, () => set(avaFull3, "604827"))).state, "Set");
      assert.equal((await at(53, () => unlock(ava, "604827"))).status, "SignedIn");
      const avaCredential = (
        await admin.query(
          "SELECT credential_version,status FROM bop_identity.staff_pin_credential WHERE actor_id=$1",
          [ava],
        )
      ).rows[0];
      assert.deepEqual(avaCredential, { credential_version: 3, status: "Active" });

      // ── 9. Revoking a tablet ends its PIN sessions; it then opens nothing.
      const onKitchen = (
        await admin.query(
          "SELECT count(*)::int AS n FROM bop_identity.staff_pin_session p JOIN bop_identity.authentication_session s USING (session_id) WHERE p.device_id=$1 AND s.status='Active'",
          [second.device.device],
        )
      ).rows[0].n;
      assert.equal(onKitchen, 1);
      assert.deepEqual(
        await at(54, () =>
          staffPin.revokeDevice({
            sessionCookie: miaFull3,
            csrf,
            deviceCookie: kitchenTablet,
            device: second.device.device,
          }),
        ),
        { signedOut: 1, thisDevice: true },
      );
      assert.equal(
        (await sessionRow(miaPinSwitch.sessionCookie)).revocation_reason,
        "Administrative",
      );
      await rejects(
        at(54, () =>
          staffPin.revokeDevice({
            sessionCookie: miaFull3,
            csrf,
            deviceCookie: null,
            device: second.device.device,
          }),
        ),
        "NotFound",
      );
      assert.equal(await staffPin.isRegisteredDevice(kitchenTablet), false);
      await rejects(
        at(55, () => staffPin.switchScreen(kitchenTablet)),
        "DeviceNotRegistered",
      );
      await rejects(
        at(55, () => unlock(cole, "730419", null, kitchenTablet)),
        "DeviceNotRegistered",
      );

      // ── 10. Another Store's tablet: lists that Store's people only; Ava's PIN does not work there.
      const omar = await at(56, () => signIn(otherManager));
      const other = await at(56, () =>
        staffPin.registerDevice({ sessionCookie: omar, csrf, deviceCookie: null, label: "Other" }),
      );
      assert.deepEqual((await at(57, () => staffPin.switchScreen(other.deviceCookie))).staff, []);
      assert.deepEqual(await at(57, () => unlock(ava, "604827", null, other.deviceCookie)), {
        status: "Rejected",
      });
      // Omar's overview at the other Store does not see this Store's tablets.
      const omarView = await at(57, () =>
        staffPin.overview({ sessionCookie: omar, deviceCookie: tablet }),
      );
      assert.equal(omarView.thisDevice, null);
      assert.deepEqual(
        omarView.devices.map((item) => item.label),
        ["Other"],
      );
      await rejects(
        at(57, () =>
          staffPin.revokeDevice({
            sessionCookie: omar,
            csrf,
            deviceCookie: null,
            device: third.device.device,
          }),
        ),
        "NotFound",
      );

      // ── 11. Row security, append-only history and the worker role.
      const counts = await api.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, otherStore],
        );
        return (
          await tx.query(
            "SELECT (SELECT count(*)::int FROM bop_identity.store_sign_in_device) AS d,(SELECT count(*)::int FROM bop_identity.staff_pin_credential) AS c,(SELECT count(*)::int FROM bop_identity.staff_pin_attempt) AS a,(SELECT count(*)::int FROM bop_identity.staff_pin_session) AS s",
            [],
          )
        ).rows[0];
      });
      assert.deepEqual(
        counts,
        { d: 1, c: 0, a: 1, s: 0 },
        "the other Store sees only its own rows",
      );
      const unscoped = await api.run(
        async (tx) =>
          (
            await tx.query(
              "SELECT (SELECT count(*)::int FROM bop_identity.store_sign_in_device) AS d,(SELECT count(*)::int FROM bop_identity.staff_pin_session) AS s",
              [],
            )
          ).rows[0],
      );
      assert.deepEqual(unscoped, { d: 0, s: 0 }, "no Store selected: no rows");
      for (const statement of [
        "UPDATE bop_identity.staff_pin_attempt SET failure_number=1",
        "DELETE FROM bop_identity.staff_pin_attempt",
        "UPDATE bop_identity.staff_pin_session SET issued_at=issued_at",
        "DELETE FROM bop_identity.staff_pin_session",
        "DELETE FROM bop_identity.store_sign_in_device",
        "UPDATE bop_identity.store_sign_in_device SET label='Renamed'",
        "DELETE FROM bop_identity.staff_pin_credential",
        "TRUNCATE bop_identity.staff_pin_attempt CASCADE",
      ])
        await assert.rejects(
          admin.query(statement),
          /append-only staff PIN history|only ever revoked once|55000/u,
          statement,
        );
      await assert.rejects(
        admin.query(
          "UPDATE bop_identity.staff_pin_credential SET changed_at=changed_at WHERE actor_id=$1",
          [ava],
        ),
        /next version/u,
      );
      for (const table of [
        "store_sign_in_device",
        "staff_pin_credential",
        "staff_pin_attempt",
        "staff_pin_session",
      ])
        await assert.rejects(
          transactionsAs(worker).run((tx) =>
            tx.query("SELECT count(*) FROM bop_identity." + table, []),
          ),
          (error) => error?.code === "42501",
          table,
        );
      await assert.rejects(
        api.run((tx) => tx.query("DELETE FROM bop_identity.staff_pin_attempt", [])),
        (error) => error?.code === "42501",
      );

      // ── 12. Audits name people, tablets and sessions; never a PIN, hash or tablet secret.
      const audits = (
        await admin.query(
          "SELECT action_code,count(*)::int AS n FROM platform_audit.audit_record WHERE action_code LIKE 'IDENTITY_STAFF_PIN%' OR action_code LIKE 'IDENTITY_STORE_DEVICE%' GROUP BY action_code ORDER BY action_code",
        )
      ).rows;
      const byCode = Object.fromEntries(audits.map((row) => [row.action_code, row.n]));
      assert.equal(byCode.IDENTITY_STORE_DEVICE_REGISTERED, 4);
      assert.equal(byCode.IDENTITY_STORE_DEVICE_REVOKED, 1);
      assert.equal(byCode.IDENTITY_STAFF_PIN_SET, 6);
      assert.equal(byCode.IDENTITY_STAFF_PIN_RESET, 1);
      assert.equal(byCode.IDENTITY_STAFF_PIN_LOCKED, 1);
      const attempts = (
        await admin.query(
          "SELECT outcome,count(*)::int AS n FROM bop_identity.staff_pin_attempt GROUP BY outcome ORDER BY outcome",
        )
      ).rows;
      const attemptCount = Object.fromEntries(attempts.map((row) => [row.outcome, row.n]));
      assert.equal(byCode.IDENTITY_STAFF_PIN_REJECTED, attemptCount.Rejected);
      assert.equal(byCode.IDENTITY_STAFF_PIN_VERIFIED, attemptCount.Verified);
      assert.equal(byCode.IDENTITY_STAFF_PIN_SIGNED_IN, attemptCount.Verified);
      const auditText = (
        await admin.query(
          "SELECT string_agg(row_to_json(a)::text,'') AS raw FROM platform_audit.audit_record a WHERE action_code LIKE 'IDENTITY_STAFF_PIN%' OR action_code LIKE 'IDENTITY_STORE_DEVICE%'",
        )
      ).rows[0].raw;
      for (const secret of [
        "482913",
        "730418",
        "730419",
        "905172",
        "604827",
        "381904",
        tablet,
        kitchenTablet,
        patio,
        deviceHasher.hash(tablet),
        pepper.toString("hex"),
      ])
        assert.ok(!auditText.includes(secret), "audits never carry a PIN or secret");
    } finally {
      await admin.end();
    }
  });
});

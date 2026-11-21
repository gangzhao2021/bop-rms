import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createIdentityActor,
  createPostgresBrowserSessionStore,
  revokeActorSessions,
} from "../../bop/identity/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "018fc000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (n) => n.toString(16).padStart(64, "0");
const AT = "2026-09-10T10:00:00.000Z";

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: one person's fence replaces the lock on the whole session table.
 * Before it, a sign-in held up by anything (its workspace read waited on a listing) stopped every
 * merchant's sign-ins and session writes. Under the restricted API role with the rendered pilot ACL
 * and the live 2 s lock_timeout, through the real store:
 * - another person's sign-in does not wait for a sign-in in flight;
 * - the same person's second device does not wait for a business transaction on their first;
 * - the session limit holds beside a rotation, and "sign out everywhere" ends a sign-in in flight;
 * - none of these pairs deadlocks.
 */
it("a person's sign-in only ever waits for that person", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_session_fence" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const clients = new Set();
    const connect = async () => {
      const client = new Client(context.clientConfig);
      await client.connect();
      clients.add(client);
      return client;
    };
    const release = async (client) => {
      clients.delete(client);
      await client.end().catch(() => undefined);
    };
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_sf");
      const conflicts = [];
      const open = async () => {
        const client = await connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='2s'");
        return client;
      };
      const tracked = (client) => ({
        query: async (sql, values) => {
          try {
            return await client.query(sql, [...values]);
          } catch (error) {
            conflicts.push(error.code);
            throw error;
          }
        },
      });
      const transactions = {
        async run(work) {
          const client = await open();
          try {
            const result = await work(tracked(client));
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await release(client);
          }
        },
      };
      const actorOf = (reference) =>
        createIdentityActor({
          actorType: "User",
          actorReference: reference,
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: AT,
          recentMfaAt: null,
        });
      const store = (onSessionCreated) =>
        createPostgresBrowserSessionStore({
          onSessionCreated,
          environment: "synthetic",
          redirectUri: "https://merchant.example.test/callback",
          allowedPostLoginPaths: ["/orders"],
          now: () => AT,
          currentActor: async (_tx, reference) => actorOf(reference),
          transactions,
        });
      const envelope = (session, actor) => ({
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic-key",
        ciphertext: Buffer.alloc(40, 19).toString("base64url"),
        encryptionContext: "synthetic:session:" + session + ":" + actor,
      });
      let next = 100;
      const signIn = (actor, onSessionCreated) => {
        const n = next++;
        return store(onSessionCreated).createSession({
          sessionReference: id(n),
          actor: actorOf(actor),
          policyCode: "WorkforceStandard",
          sessionSelectorHash: hash(n),
          csrfSelectorHash: hash(n + 100000),
          encryptedSecrets: envelope(id(n), actor),
          observedAt: AT,
        });
      };
      const rotate = (selector, actor, expectedVersion, onSessionCreated) => {
        const n = next++;
        return store(onSessionCreated).rotateSession({
          currentSelectorHash: selector,
          expectedVersion,
          nextSessionReference: id(n),
          nextSelectorHash: hash(n),
          nextCsrfSelectorHash: hash(n + 100000),
          nextEncryptedSecrets: envelope(id(n), actor),
          reason: "StoreContextElevation",
          observedAt: AT,
        });
      };
      const activeCount = async (actor) =>
        (
          await admin.query(
            "SELECT count(*)::int n FROM bop_identity.authentication_session WHERE actor_id=$1 AND status='Active'",
            [actor],
          )
        ).rows[0].n;
      const timed = async (promise) => {
        const started = Date.now();
        const result = await promise;
        return { result, ms: Date.now() - started };
      };
      /** A hold a sign-in sits in, with its fences, until released. */
      const held = () => {
        let reached, proceed;
        const at = new Promise((resolve) => (reached = resolve));
        const until = new Promise((resolve) => (proceed = resolve));
        return {
          at,
          go: () => proceed(),
          onSessionCreated: async () => {
            reached();
            await until;
          },
        };
      };
      const advisoryWaiter = async () => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const { rows } = await admin.query(
            "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          );
          if (rows[0].n > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return false;
      };

      // Another person's sign-in beside a sign-in in flight (a merchant's, held by its workspace).
      const alice = id(1),
        bob = id(2),
        carol = id(3),
        dan = id(4);
      const inFlight = held();
      const aliceSignIn = signIn(alice, inFlight.onSessionCreated);
      await inFlight.at;
      const beside = await timed(signIn(bob));
      assert.equal(beside.result.session.actor.actorReference, bob);
      assert.ok(beside.ms < 1000, "another person's sign-in took " + beside.ms + " ms");
      inFlight.go();
      await aliceSignIn;

      // The same person on a second device, while a business transaction holds their first session.
      const business = await open();
      const first = (
        await business.query(
          "SELECT session_id FROM bop_identity.authentication_session WHERE actor_id=$1 FOR SHARE",
          [alice],
        )
      ).rows[0];
      assert.ok(first);
      const secondDevice = await timed(signIn(alice));
      assert.equal(secondDevice.result.session.status, "Active");
      assert.ok(secondDevice.ms < 1000, "the second device took " + secondDevice.ms + " ms");
      await business.query("ROLLBACK");
      await release(business);

      // The limit is still kept: sign-ins side by side never go over it, the oldest ends.
      const many = await Promise.all(Array.from({ length: 8 }, () => signIn(carol)));
      assert.equal(many.length, 8);
      assert.equal(await activeCount(carol), 5);
      const ended = (
        await admin.query(
          "SELECT count(*)::int n FROM bop_identity.authentication_session WHERE actor_id=$1 AND status='Revoked' AND revocation_reason='ConcurrentLimit'",
          [carol],
        )
      ).rows[0].n;
      assert.equal(ended, 3);

      // A sign-in beside a rotation of the same person: both or neither, the count stays at the limit.
      const rotating = held();
      const newest = many.at(-1);
      const rotation = rotate(newest.sessionSelectorHash, carol, 1, rotating.onSessionCreated);
      await rotating.at;
      const fresh = signIn(carol);
      assert.equal(await advisoryWaiter(), true, "the sign-in waits for the rotation");
      rotating.go();
      await Promise.all([rotation, fresh]);
      assert.equal(await activeCount(carol), 5);

      // "Sign out everywhere" beside a sign-in in flight ends that session too.
      for (let n = 0; n < 2; n += 1) await signIn(dan);
      const flying = held();
      const flyingIn = signIn(dan, flying.onSessionCreated);
      await flying.at;
      const everywhere = transactions.run((tx) =>
        revokeActorSessions(tx, { actorReference: dan, reason: "MembershipDisabled", at: AT }),
      );
      assert.equal(await advisoryWaiter(), true, "signing out everywhere waits for the sign-in");
      flying.go();
      await flyingIn;
      assert.equal(await everywhere, 3);
      assert.equal(await activeCount(dan), 0);

      // None of these pairs deadlocks, in any order, for one person at full speed.
      const erin = id(5);
      const seeded = [];
      for (let n = 0; n < 5; n += 1) seeded.push(await signIn(erin));
      conflicts.length = 0;
      const outcomes = await Promise.allSettled([
        signIn(erin),
        rotate(seeded[4].sessionSelectorHash, erin, 1),
        signIn(erin),
        store().revokeSession({
          selectorHash: seeded[3].sessionSelectorHash,
          expectedVersion: 1,
          reason: "Logout",
          observedAt: AT,
        }),
        transactions.run((tx) =>
          revokeActorSessions(tx, { actorReference: erin, reason: "MembershipDisabled", at: AT }),
        ),
        signIn(erin),
      ]);
      assert.ok(outcomes.length === 6);
      assert.equal(
        conflicts.filter((code) => code === "40P01").length,
        0,
        "no deadlock among a person's sign-ins, rotations and sign-outs",
      );
      assert.ok((await activeCount(erin)) <= 5);
    } finally {
      for (const client of clients) await client.end().catch(() => undefined);
      await admin.end();
    }
  });
});

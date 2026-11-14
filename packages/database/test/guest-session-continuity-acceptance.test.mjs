import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  issueGuestSessionContinuity,
} from "../../bop/identity/src/index.ts";
import {
  createDiningTable,
  isDiningGuestSessionSuperseded,
  listDiningParticipantGuestSessions,
  parseDiningIdentityAdmission,
  parseDiningParticipant,
  parseDiningSession,
} from "../../rms/dining/src/index.ts";
import {
  chooseDiningCheckoutScope,
  extendDiningCheckoutScope,
} from "../../rms/ordering/src/index.ts";
import { createCustomerDiningContinuity } from "../../../apps/api/src/customer-dining-continuity.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createHash } from "node:crypto";

const { Client } = pg;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 shared-table-checkout (b), lost cookie, 2000_523 + 2000_525, as the restricted pilot API
 * role (rendered pilot ACL, NOBYPASSRLS): phone A is seated and holds a continuity token; its cookie
 * is lost and it scans again with the token. The token finds A's seat; the readmission rotates A's
 * old session into a new one for the same participant in one transaction (Identity's rotation and
 * single use, Dining's readmission, a fresh token), so "Only what I added" on the new session still
 * finds A's dish. The same token is never used twice, also when two scans race; a phone staff
 * removed (participant Left) or another Store's token finds no seat; the old session is no longer
 * the participant's phone; the history can't be changed.
 */
it("WP-2423 (shared-table-checkout): a phone that lost its cookie comes back as the same participant and still pays only what it added", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_continuity" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cont_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            const value = await work({
              query: (sql, values) => client.query(sql, [...(values ?? [])]),
            });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const at0 = new Date(Date.now() - 60_000).toISOString();
      // The table cart with phone A's dish (the fixture's line, participant id(601)) and one of B's,
      // one version before the fixture's round (A's dish alone).
      const f = orderWriteFixture({ namespace: "01902523", at: at0, dineIn: true });
      const id = (n) => "01902523-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      await seedSubmissionCart(admin, {
        ...f,
        cart: {
          ...f.cart,
          aggregateVersion: f.cart.aggregateVersion - 1,
          items: [
            f.cart.items[0],
            {
              ...f.cart.items[0],
              cartItemReference: id(0x6b3),
              addedByActorReference: id(0x6b4),
              addedByParticipantReference: id(0x602),
            },
          ],
        },
      });
      const scope = { tenantReference: id(0xeee), ...f.scope };
      const diningSession = String(f.cart.diningSessionReference);
      const phoneA = String(f.cart.items[0].addedByParticipantReference);
      const phoneB = id(0x602),
        removed = id(0x603);
      const table = id(0x700),
        publicTable = id(0x701),
        publicStore = id(0x702),
        qr = id(0x703);
      const startedAt = new Date(Date.now() - 3_600_000).toISOString();
      const session = parseDiningSession({
        diningSessionReference: diningSession,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        tableReference: table,
        tableAssignmentVersion: 1,
        phase: "Active",
        version: 2,
        startedByActorReference: id(0x704),
        startedAt,
        hostParticipantReference: phoneA,
      });
      const diningTable = createDiningTable({
        ...scope,
        tableReference: table,
        stableLabel: "SYNTHETIC-CONTINUITY",
        areaReference: id(0x705),
        areaCode: "ROOM",
        capacity: 4,
        accessibilityAttributes: [],
        lifecycle: "Published",
        qrStatus: "Active",
        qrVersion: 1,
        operationalState: "Available",
        blockReasonCode: null,
        activeDiningSessionReference: diningSession,
        aggregateVersion: 1,
        createdAt: startedAt,
        observedAt: startedAt,
      });
      await admin.query(
        "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
        [
          table,
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          JSON.stringify(diningTable),
          startedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
        [
          diningSession,
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          table,
          JSON.stringify(session),
          startedAt,
        ],
      );
      for (const [participant, left] of [
        [phoneA, false],
        [phoneB, false],
        [removed, true],
      ]) {
        const snapshot = parseDiningParticipant({
          participantReference: participant,
          diningSessionReference: diningSession,
          status: left ? "Left" : "Active",
          version: left ? 2 : 1,
          joinedAt: startedAt,
          leftAt: left ? new Date(Date.now() - 600_000).toISOString() : null,
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
          [
            participant,
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            diningSession,
            left ? 2 : 1,
            left ? "Left" : "Active",
            JSON.stringify(snapshot),
          ],
        );
      }
      // Each phone joined with its admission (consumed), as Dining records every seated phone.
      let admissions = 0xd00;
      for (const participant of [phoneA, phoneB, removed]) {
        const admission = parseDiningIdentityAdmission({
          admissionReference: id(++admissions),
          diningSessionReference: diningSession,
          participantReference: participant,
          storeReference: scope.storeReference,
          tableReference: table,
          tableAssignmentVersion: 1,
          operationReference: id(++admissions),
          operationIntentHash: "a".repeat(64),
          status: "Consumed",
          version: 2,
          issuedAt: startedAt,
          consumedAt: startedAt,
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,2,'Consumed',$7::jsonb)",
          [
            admission.admissionReference,
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            diningSession,
            participant,
            JSON.stringify(admission),
          ],
        );
      }
      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      let n = 0;
      const cookies = new Map();
      const seat = async (participant) => {
        n += 1;
        const reference = id(0x800 + n);
        const cookie = credentials.generateCredential("Session");
        cookies.set(reference, cookie);
        await admin.query(
          `INSERT INTO bop_identity.guest_session (guest_session_id,session_selector_hash,
            csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,
            public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,
            created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,dining_session_id,
            dining_participant_id)
           VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,$9,'DineIn',
            'zh-Hans',$10,2,'DiningBound','Active',$11,$11,$11::timestamptz + interval '4 hours',
            $11::timestamptz + interval '24 hours',1,$12,$13)`,
          [
            reference,
            credentials.hashCredential("Session", cookie),
            credentials.hashCredential("Csrf", credentials.deriveForegroundCsrf(cookie)),
            id(0x900 + n),
            credentials.hashOperationIntent("seed" + n),
            scope.brandReference,
            scope.storeReference,
            publicStore,
            publicTable,
            qr,
            startedAt,
            diningSession,
            participant,
          ],
        );
        return reference;
      };
      const sessionA = await seat(phoneA);
      const sessionB = await seat(phoneB);
      const sessionRemoved = await seat(removed);
      let refs = 0xa00;
      const next = () => id(++refs);
      const issue = async (guestSessionReference) => {
        const token = credentials.generateCredential("Session");
        await runner.run((tx) =>
          issueGuestSessionContinuity(tx, f.scope, {
            continuityReference: next(),
            operationReference: next(),
            guestSessionReference,
            tokenHash: sha256(token),
            observedAt: new Date().toISOString(),
          }),
        );
        return token;
      };
      const continuity = createCustomerDiningContinuity({
        scope,
        transactions: runner,
        credentials,
        binding: () => ({ validate: async () => "Current" }),
        newReference: next,
        now: () => new Date().toISOString(),
      });
      // A's own cookie asks for its token (as the PWA does once seated).
      const { continuityToken: tokenA } = await continuity.issue({
        sessionCredential: cookies.get(sessionA),
        csrfCredential: credentials.deriveForegroundCsrf(cookies.get(sessionA)),
      });
      const tokenB = await issue(sessionB);
      const tokenRemoved = await issue(sessionRemoved);
      const now = () => new Date().toISOString();

      // A's token finds A's seat; the removed phone's finds none; a made-up token finds none.
      assert.deepEqual(await continuity.table(tokenA, now()), {
        publicStoreReference: publicStore,
        publicTableReference: publicTable,
        qrReference: qr,
        qrRevocationVersion: 2,
      });
      assert.equal(await continuity.table(tokenRemoved, now()), null);
      assert.equal(await continuity.table(credentials.generateCredential("Session"), now()), null);
      // Another Store sees no token.
      const elsewhere = createCustomerDiningContinuity({
        scope: { ...scope, storeReference: id(0xbad) },
        transactions: runner,
        credentials,
        binding: () => ({ validate: async () => "Current" }),
        newReference: next,
        now,
      });
      assert.equal(await elsewhere.table(tokenA, now()), null);
      assert.equal(await elsewhere.readmit(tokenA, next(), now()), null);

      // The re-scan: A comes back on a new session, same participant.
      const back = await continuity.readmit(tokenA, next(), now());
      assert.ok(back !== null);
      assert.notEqual(back.continuityToken, tokenA);
      const sessions = (
        await admin.query(
          `SELECT guest_session_id::text AS id, status, revocation_reason, dining_participant_id::text AS participant,
             rotated_from_guest_session_id::text AS rotated_from, dining_state
           FROM bop_identity.guest_session WHERE dining_participant_id=$1 ORDER BY created_at`,
          [phoneA],
        )
      ).rows;
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        { status: sessions[0].status, reason: sessions[0].revocation_reason },
        { status: "Revoked", reason: "Rotated" },
      );
      const newSession = sessions[1];
      assert.deepEqual(
        {
          status: newSession.status,
          participant: newSession.participant,
          from: newSession.rotated_from,
          state: newSession.dining_state,
        },
        { status: "Active", participant: phoneA, from: sessionA, state: "DiningBound" },
      );
      // The new cookie is that session.
      const selected = (
        await admin.query(
          "SELECT guest_session_id::text AS id FROM bop_identity.guest_session WHERE session_selector_hash=decode($1,'hex')",
          [credentials.hashCredential("Session", back.sessionCredential)],
        )
      ).rows;
      assert.deepEqual(selected, [{ id: newSession.id }]);
      // Dining: A's old session is no longer A's phone, the new one is.
      assert.equal(
        await runner.run((tx) => isDiningGuestSessionSuperseded(tx, scope, sessionA)),
        true,
      );
      assert.equal(
        await runner.run((tx) => isDiningGuestSessionSuperseded(tx, scope, newSession.id)),
        false,
      );
      // v15 batch 8 (member points): both sessions are A's phone, so a payment A made on its own
      // card before the cookie was lost is still A's to earn on, never another phone's.
      assert.deepEqual(
        [
          ...(await runner.run((tx) => listDiningParticipantGuestSessions(tx, scope, phoneA))),
        ].sort(),
        [sessionA, newSession.id].sort(),
      );
      // "Only what I added" on the new session finds A's dish.
      const chosenAt = new Date().toISOString();
      const mine = await runner.run((tx) =>
        chooseDiningCheckoutScope(tx, f.scope, {
          operationReference: next(),
          cartReference: String(f.cart.cartReference),
          expectedCartVersion: f.cart.aggregateVersion - 1,
          choice: "Mine",
          lines: [],
          actor: {
            diningSessionReference: diningSession,
            guestSessionReference: newSession.id,
            participantReference: phoneA,
          },
          observedAt: chosenAt,
          hashIntent: (value) => "sha256:" + sha256(value),
          newReference: next,
          audit: {
            auditId: next(),
            brandId: f.scope.brandReference,
            storeId: f.scope.storeReference,
            actor: { type: "System" },
            actionCode: "ORDERING_CART_CHECKOUT_SCOPE",
            targetType: "OrderingCart",
            targetId: String(f.cart.cartReference),
            reasonCode: "AUTHORIZED_CART_MUTATION",
            correlationId: next(),
            occurredAt: chosenAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
          heldByOther: async () => null,
        }),
      );
      // A's dish is found under A: B's waits, the round is A's dish alone.
      assert.deepEqual(mine, {
        status: "Chosen",
        cartVersion: f.cart.aggregateVersion,
        expiresAt: new Date(Date.parse(chosenAt) + 5 * 60_000).toISOString(),
        setAsideUnits: f.cart.items[0].quantity,
      });

      // The used token again: no seat, no readmission. The new token works next time.
      assert.equal(await continuity.table(tokenA, now()), null);
      assert.equal(await continuity.readmit(tokenA, next(), now()), null);
      assert.ok((await continuity.table(back.continuityToken, now())) !== null);

      // A loses the cookie again while paying: the choice goes with A's next session, which the
      // database accepts as the payer (details, "Keep them") as the API does; B is still fenced.
      const tryDetails = async (guestSessionReference) => {
        try {
          await runner.run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [f.scope.brandReference, f.scope.storeReference],
            );
            const details = next();
            await tx.query(
              `INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,
                 operation_id,guest_session_id,cart_id,snapshot_json,recorded_at)
               VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8)`,
              [
                f.scope.brandReference,
                f.scope.storeReference,
                details,
                next(),
                guestSessionReference,
                String(f.cart.cartReference),
                JSON.stringify({
                  brandReference: f.scope.brandReference,
                  storeReference: f.scope.storeReference,
                  detailsReference: details,
                  detailsVersion: 1,
                  guestSessionReference,
                  cartReference: String(f.cart.cartReference),
                  recordedAt: chosenAt,
                }),
                chosenAt,
              ],
            );
            throw new Error("written");
          });
        } catch (error) {
          return error.message;
        }
      };
      const again = await continuity.readmit(back.continuityToken, next(), now());
      assert.ok(again !== null);
      const third = (
        await admin.query(
          "SELECT guest_session_id::text AS id FROM bop_identity.guest_session WHERE session_selector_hash=decode($1,'hex')",
          [credentials.hashCredential("Session", again.sessionCredential)],
        )
      ).rows[0].id;
      assert.deepEqual(
        (
          await admin.query(
            "SELECT from_guest_session_id::text AS from, participant_id::text AS participant FROM rms_ordering.dining_checkout_scope_payer_session WHERE guest_session_id=$1",
            [third],
          )
        ).rows,
        [{ from: newSession.id, participant: phoneA }],
      );
      assert.equal(await tryDetails(third), "written");
      assert.match(await tryDetails(sessionB), /CHECKOUT_SCOPE_HELD/u);
      const kept = await runner.run((tx) =>
        extendDiningCheckoutScope(tx, f.scope, {
          operationReference: next(),
          actor: {
            diningSessionReference: diningSession,
            guestSessionReference: third,
            participantReference: phoneA,
          },
          observedAt: now(),
        }),
      );
      assert.equal(kept.status, "Extended");

      // Two scans with B's token at once: one readmission, the other an ordinary entry.
      const raced = await Promise.all([
        continuity.readmit(tokenB, next(), now()),
        continuity.readmit(tokenB, next(), now()),
      ]);
      assert.equal(raced.filter((answer) => answer !== null).length, 1);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_dining.dining_participant_readmission WHERE participant_id=$1",
            [phoneB],
          )
        ).rows[0].n,
        1,
      );
      // A removed phone's token is never readmitted, even straight to the write.
      assert.equal(await continuity.readmit(tokenRemoved, next(), now()), null);
      assert.equal(
        (
          await admin.query(
            "SELECT status FROM bop_identity.guest_session WHERE guest_session_id=$1",
            [sessionRemoved],
          )
        ).rows[0].status,
        "Active",
      );
      // Append-only: the pilot role holds no UPDATE or DELETE, and even the owner is refused.
      for (const target of [
        "bop_identity.guest_session_continuity",
        "bop_identity.guest_session_continuity_use",
        "rms_dining.dining_participant_readmission",
        "rms_ordering.dining_checkout_scope_payer_session",
      ]) {
        await assert.rejects(
          runner.run((tx) =>
            tx.query(`DELETE FROM ${target} WHERE brand_id=$1`, [scope.brandReference]),
          ),
          /permission denied/u,
        );
        await assert.rejects(
          admin.query(`DELETE FROM ${target} WHERE brand_id=$1`, [scope.brandReference]),
          /append-only/u,
        );
      }
    } finally {
      await admin.end();
    }
  });
});

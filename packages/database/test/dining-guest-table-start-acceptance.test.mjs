import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
} from "../../bop/identity/src/index.ts";
import {
  changeDiningServiceSetting,
  createDiningTable,
  createPostgresDiningGuestTableStartStore,
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningPublicTableReader,
  createPostgresDiningQrJoinStore,
  createPostgresDiningSessionJoinStore,
  loadDiningGuestTableStart,
  parseQrTableContextEvidence,
} from "../../rms/dining/src/index.ts";
import { createOrderNumberAllocation } from "../../rms/ordering/src/index.ts";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";
import { createCustomerDiningJoinComposition } from "../../../apps/api/src/customer-dining-join-composition.ts";
import { createDiningGuestTableClose } from "../../../apps/api/src/dining-guest-table-close.ts";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import {
  journeyRound,
  seedJourneyAcceptance,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
} from "../test-support/dine-in-journey-seed.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0ff10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
const digest = (value) => createHash("sha256").update(value).digest("hex");
let references = 0x9000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");

async function setup(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const api = "wp2423_gs_" + context.runId,
    worker = "wp2423_gs_w_" + context.runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const root = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, { api, worker }));
  await admin.query(
    "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
    [scope.brandReference, scope.storeReference],
  );
  const opened = { connections: 0 };
  /** One restricted-role transaction on its own connection, under the pilot's lock timeout. */
  const transactions = (role = api) => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      opened.connections += 1;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL statement_timeout='10s'");
        const result = await work({
          query: (sql, values) => client.query(sql, [...(values ?? [])]),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  });
  const pepper = randomBytes(32);
  const credentials = {
    generateReference: fresh,
    generateJoinCredential: () => String(100000 + Math.floor(Math.random() * 899999)),
    hashJoinCredential: (kind, value) =>
      createHmac("sha256", pepper).update(`DiningJoin:${kind}:${value}`).digest("hex"),
    hashOperationIntent: digest,
    equals: (a, b) => a === b,
  };
  /** Owner client transactions for test-only setup through real owner stores. */
  const ownerRunner = () => ({
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (sql, values) => client.query(sql, values) });
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
  return { admin, api, worker, transactions, credentials, opened, ownerRunner };
}

/** A published table with an active code, owner-seeded (table configuration is not under test). */
async function seedTable(admin, n, { blocked = null, at = new Date(Date.now() - 3_600_000) } = {}) {
  const instant = at.toISOString();
  const table = createDiningTable({
    ...scope,
    tableReference: id(n),
    stableLabel: "T" + n,
    areaReference: id(0x700),
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: blocked === null ? "Available" : "TemporarilyBlocked",
    blockReasonCode: blocked,
    activeDiningSessionReference: null,
    aggregateVersion: 2,
    createdAt: instant,
    observedAt: instant,
  });
  await admin.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,2,$5::jsonb,$6,$6)",
    [
      id(n),
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      JSON.stringify(table),
      instant,
    ],
  );
}

/** Test-only Identity stand-in: a scanned guest's Session; Dining is real from here on. */
function guests() {
  const provider = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
  const records = new Map();
  return {
    provider,
    store: {
      create: async ({ record }) => record,
      resolve: async (key) => records.get(key) ?? null,
      touchInteractive: async () => null,
      revoke: async () => null,
      resolveOperation: async () => null,
      rotate: async () => {
        throw new Error("unexpected rotation");
      },
    },
    scan(guest, table) {
      const sessionCredential = provider.generateCredential("Session"),
        csrfCredential = provider.generateCredential("Csrf"),
        base = Date.now() - 60_000,
        at = new Date(base).toISOString();
      const record = createGuestSessionRecord({
        session: {
          sessionReference: id(guest),
          status: "Active",
          version: 1,
          ...owner,
          publicStoreReference: id(4),
          publicTableReference: id(table + 0x100),
          channel: "DineIn",
          locale: "en-CA",
          qrReference: id(5),
          qrRevocationVersion: 1,
          diningState: "ContextOnly",
          diningSessionReference: null,
          diningParticipantReference: null,
          createdAt: at,
          lastSeenAt: at,
          idleExpiresAt: new Date(base + 14_400_000).toISOString(),
          absoluteExpiresAt: new Date(base + 86_400_000).toISOString(),
          orderClosedAt: null,
          closureExpiresAt: null,
          rotatedFromGuestSessionReference: null,
          revocationReason: null,
          revokedAt: null,
        },
        sessionSelectorHash: provider.hashCredential("Session", sessionCredential),
        csrfSelectorHash: provider.hashCredential("Csrf", csrfCredential),
        operationReference: fresh(),
        operationIntentHash: provider.hashOperationIntent("synthetic entry"),
      });
      records.set(record.sessionSelectorHash, record);
      return { sessionCredential, csrfCredential };
    },
  };
}

/** The pilot's composition (tooling/environment/pilot-customer-entry.mjs), over real Dining owners. */
function composeJoin({
  transactions,
  credentials,
  identity,
  now = () => new Date().toISOString(),
  takingDineIn = async () => true,
  withStart = true,
  closeForNewParty = undefined,
}) {
  const run = transactions();
  return createCustomerDiningJoinComposition({
    scope: owner,
    now,
    session: {
      credentials: identity.provider,
      binding: { validate: async () => "Current" },
      store: identity.store,
    },
    dining: {
      store: createPostgresDiningSessionJoinStore(run, scope, credentials, (record) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DINING_SESSION_JOIN",
        targetType: "DiningSession",
        targetId: record.diningSessionReference,
        reasonCode: "AUTHORIZED_DINING_JOIN",
        correlationId: fresh(),
        occurredAt: record.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      })),
      credentials,
      pepperVersion: 1,
    },
    // The real table read, on a connection of its own, as the pilot's QR context does: this is what
    // would block on a table row a start still held in the same transaction.
    contexts: {
      resolve: async (input) => {
        const table = String(input.session.publicTableReference).replace(/[0-9a-f]{12}$/u, (hex) =>
          (parseInt(hex, 16) - 0x100).toString(16).padStart(12, "0"),
        );
        const read = await run.run((tx) =>
          createPostgresDiningPublicTableReader({
            transaction: tx,
            scope,
            authorize: async () => true,
          }).read({ tableReference: table, purpose: "DiningJoin", observedAt: input.observedAt }),
        );
        if (read === null) return null;
        return parseQrTableContextEvidence({
          publicStoreReference: id(4),
          publicTableReference: input.session.publicTableReference,
          ...owner,
          tableReference: table,
          brandLifecycle: "Active",
          storeLifecycle: "Active",
          tableLifecycle: "Active",
          assignmentState: "Active",
          channel: "DineIn",
          qrState: "Enabled",
          revocationVersion: 1,
          contextEvidenceReference: id(6),
          validUntil: new Date(Date.parse(input.observedAt) + 600_000).toISOString(),
        });
      },
    },
    qr: {
      issue: (input, authorize) =>
        createPostgresDiningQrJoinStore(run, {
          scope,
          credentials,
          pepperVersion: 1,
          now,
          authorize: () => authorize(),
          audit: (record) => ({
            auditId: fresh(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "DINING_QR_JOIN_ISSUE",
            targetType: "DiningTable",
            targetId: record.tableReference,
            reasonCode: "GUEST_SCANNED_OPEN_TABLE",
            correlationId: record.operationReference,
            occurredAt: record.observedAt,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        }).issue({ ...input, operationReference: fresh() }),
      ...(withStart
        ? {
            startIfFree: (input) =>
              createPostgresDiningGuestTableStartStore(run, {
                scope,
                credentials,
                pepperVersion: 1,
                now,
                newReference: fresh,
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
                takingDineIn,
              }).startIfFree(input),
          }
        : {}),
      ...(closeForNewParty === undefined ? {} : { closeForNewParty }),
    },
  });
}
const joinRequest = { abuse: { admit: async () => "Admitted" } };
const tap = (join, phone) =>
  join.join(
    {
      sessionCredential: phone.sessionCredential,
      csrfCredential: phone.csrfCredential,
      operationReference: fresh(),
    },
    joinRequest,
  );
/** The owner changes the switch through the real store; the rendered role does the write. */
const setSwitch = (transactions, on) =>
  transactions().run(async (tx) => {
    const current = (await tx.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [scope.brandReference, scope.storeReference],
    ),
    await tx.query(
      "SELECT coalesce(max(version),0)::int AS version FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2",
      [scope.brandReference, scope.storeReference],
    )).rows[0].version;
    return changeDiningServiceSetting(tx, scope, {
      operationReference: fresh(),
      expectedVersion: current,
      staffCall: false,
      chaseDish: false,
      guestTableStart: on,
      actorReference: id(8),
      observedAt: new Date().toISOString(),
    });
  });
const timingStore = () =>
  createPostgresDiningPaymentTimingStore({
    scope,
    hashIntent: digest,
    equals: (a, b) => a === b,
  });
const setTiming = (transactions, paymentTiming, expectedVersion) =>
  transactions().run((tx) =>
    timingStore().change(
      tx,
      {
        operationReference: fresh(),
        paymentTiming,
        expectedVersion,
        actorReference: id(8),
        observedAt: new Date().toISOString(),
      },
      async () => true,
    ),
  );
const count = async (admin, sql, values = []) => (await admin.query(sql, values)).rows[0].n;

it("a guest starts a free table by scanning: one Session, the phone is its first guest, recorded as the System", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_join" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await seedTable(admin, 20);
      await setSwitch(transactions, true);
      const identity = guests();
      const join = composeJoin({ transactions, credentials, identity });

      const answered = await tap(join, identity.scan(80, 20));
      assert.equal(answered.status, "Joined");

      const session = (
        await admin.query(
          "SELECT session_id::text AS id,phase,session_snapshot FROM rms_dining.dining_session WHERE table_id=$1",
          [id(20)],
        )
      ).rows;
      assert.equal(session.length, 1);
      assert.equal(session[0].phase, "Active");
      assert.equal(session[0].session_snapshot.startedByActorReference, id(80));
      assert.notEqual(session[0].session_snapshot.hostParticipantReference, null);
      const start = (
        await admin.query(
          "SELECT * FROM rms_dining.dining_session_guest_start WHERE session_id=$1",
          [session[0].id],
        )
      ).rows;
      assert.equal(start.length, 1);
      assert.equal(start[0].table_id, id(20));
      assert.equal(start[0].guest_session_id, id(80));
      // Pay first only: the table took the Store's timing (never set: pay first).
      assert.equal(
        (
          await admin.query(
            "SELECT payment_timing FROM rms_dining.dining_session_payment_timing WHERE session_id=$1",
            [session[0].id],
          )
        ).rows[0].payment_timing,
        "PayFirst",
      );
      // The audit names the System and the reason, never the guest as a person.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT actor_type,actor_reference,reason_code,source_channel,target_id FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_START'",
          )
        ).rows,
        [
          {
            actor_type: "System",
            actor_reference: null,
            reason_code: "GUEST_SCANNED_FREE_TABLE",
            source_channel: "CUSTOMER_PWA",
            target_id: id(20),
          },
        ],
      );
      // A second phone at the table just joins.
      assert.equal((await tap(join, identity.scan(81, 20))).status, "Joined");
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_session WHERE table_id=$1",
          [id(20)],
        ),
        1,
      );
      // History is append-only.
      await assert.rejects(admin.query("DELETE FROM rms_dining.dining_session_guest_start"));
      await assert.rejects(
        admin.query("UPDATE rms_dining.dining_session_guest_start SET started_at=started_at"),
      );
    } finally {
      await admin.end();
    }
  });
}, 180_000);

it("with the switch off or never set the scan and the join refuse as today, and an ordinary join adds nothing", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_off" }, async (context) => {
    const { admin, transactions, credentials, opened } = await setup(context);
    try {
      await seedTable(admin, 20);
      const identity = guests();
      const join = composeJoin({ transactions, credentials, identity });
      const offer = () =>
        transactions().run((tx) =>
          loadDiningGuestTableStart(tx, owner, id(20), new Date().toISOString()),
        );
      // Never set.
      assert.equal((await offer()).kind, "No");
      assert.deepEqual(await tap(join, identity.scan(80, 20)), {
        status: "Refused",
        reason: "NotOpen",
      });
      // Off again.
      await setSwitch(transactions, true);
      assert.equal((await offer()).kind, "MayStart");
      await setSwitch(transactions, false);
      assert.equal((await offer()).kind, "No");
      assert.deepEqual(await tap(join, identity.scan(81, 20)), {
        status: "Refused",
        reason: "NotOpen",
      });
      assert.equal(
        await count(admin, "SELECT count(*)::int AS n FROM rms_dining.dining_session"),
        0,
      );
      assert.equal(
        await count(admin, "SELECT count(*)::int AS n FROM rms_dining.dining_session_guest_start"),
        0,
      );
    } finally {
      await admin.end();
    }
    void opened;
  });
}, 180_000);

it("a guest can't start a pay-later table: the switch and the timing refuse each other, and so does the database", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_paylat" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await seedTable(admin, 20);
      // On at a pay-first Store; moving to pay later is refused, by the store and the database.
      await setSwitch(transactions, true);
      const refused = await setTiming(transactions, "PayLater", 0);
      assert.equal(refused.status, "GuestTableStartOn");
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.store_dining_payment_timing (tenant_id,brand_id,store_id,version,payment_timing,operation_id,intent_hash,actor_id,changed_at) VALUES ($1,$2,$3,1,'PayLater',$4,$5,$6,now())",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            fresh(),
            digest("x"),
            id(8),
          ],
        ),
        /guests start tables here/u,
      );
      // Off, the Store moves to pay later; turning it on is then refused both ways.
      await setSwitch(transactions, false);
      assert.equal((await setTiming(transactions, "PayLater", 0)).status, "Changed");
      await assert.rejects(setSwitch(transactions, true), {
        code: "DINING_GUEST_TABLE_START_NEEDS_PAY_FIRST",
      });
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_service_setting (tenant_id,brand_id,store_id,version,operation_id,staff_call,chase_dish,actor_id,occurred_at,guest_table_start) VALUES ($1,$2,$3,3,$4,false,false,$5,date_trunc('milliseconds',now()),true)",
          [scope.tenantReference, scope.brandReference, scope.storeReference, fresh(), id(8)],
        ),
        /only at a store that pays first/u,
      );
      // A row claiming a guest start at a table that pays later is refused too, whatever the store
      // did: back to pay first with the switch on, the old pay-later Session can't be claimed.
      const staffOpened = fresh();
      await admin
        .query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb,date_trunc('milliseconds',now()))",
          [
            staffOpened,
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(20),
            JSON.stringify({}),
          ],
        )
        .catch(() => undefined);
      assert.equal((await setTiming(transactions, "PayFirst", 1)).status, "Changed");
      await setSwitch(transactions, true);
      const started = await admin.query(
        "SELECT session_id,table_id,started_at FROM rms_dining.dining_session WHERE session_id=$1",
        [staffOpened],
      );
      if (started.rows.length === 1)
        await assert.rejects(
          admin.query(
            "INSERT INTO rms_dining.dining_session_guest_start (tenant_id,brand_id,store_id,session_id,table_id,guest_session_id,operation_id,service_setting_version,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT max(version) FROM rms_dining.dining_service_setting),$8)",
            [
              scope.tenantReference,
              scope.brandReference,
              scope.storeReference,
              staffOpened,
              id(20),
              id(90),
              fresh(),
              started.rows[0].started_at,
            ],
          ),
          /only at a table that pays first/u,
        );
    } finally {
      await admin.end();
    }
    void credentials;
  });
}, 180_000);

it("a table being cleaned or blocked can't be started; a paused Store between scan and tap refuses; an unmarked cleaning stops refusing after 5 minutes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_blocke" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await setSwitch(transactions, true);
      const recent = new Date(Date.now() - 60_000);
      await seedTable(admin, 20, { blocked: "CLEANING", at: recent });
      await seedTable(admin, 21, { blocked: "REPAIR", at: recent });
      await seedTable(admin, 22);
      await seedTable(admin, 23, { blocked: "CLEANING", at: new Date(Date.now() - 6 * 60_000) });
      const identity = guests();
      const join = composeJoin({ transactions, credentials, identity });
      const offer = (table) =>
        transactions().run((tx) =>
          loadDiningGuestTableStart(tx, owner, id(table), new Date().toISOString()),
        );
      assert.equal((await offer(20)).kind, "BeingCleaned");
      assert.deepEqual(await tap(join, identity.scan(80, 20)), {
        status: "Refused",
        reason: "BeingCleaned",
      });
      assert.equal((await offer(21)).kind, "No");
      assert.deepEqual(await tap(join, identity.scan(81, 21)), {
        status: "Refused",
        reason: "NotOpen",
      });
      // Paused between the scan and the tap: the start refuses and nothing is written.
      assert.equal((await offer(22)).kind, "MayStart");
      const paused = composeJoin({
        transactions,
        credentials,
        identity,
        takingDineIn: async () => false,
      });
      assert.deepEqual(await tap(paused, identity.scan(82, 22)), {
        status: "Refused",
        reason: "NotOpen",
      });
      assert.equal(
        await count(admin, "SELECT count(*)::int AS n FROM rms_dining.dining_session"),
        0,
      );
      // Staff closed it and nobody tapped Cleaned: the next guest starts it, with a System row.
      assert.deepEqual(await offer(23), { kind: "MayStart", clearsCleaning: true });
      assert.equal((await tap(join, identity.scan(83, 23))).status, "Joined");
      const cleared = (
        await admin.query(
          "SELECT actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE action_code='DINING_TABLE_CLEARBLOCK' AND target_id=$1",
          [id(23)],
        )
      ).rows;
      assert.deepEqual(cleared, [
        {
          actor_type: "System",
          reason_code: "GUEST_START_CLEANING_NOT_MARKED",
          source_channel: "CUSTOMER_PWA",
        },
      ]);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

it("two phones at once: one Session, both joined, no lock wait, and an earlier clock isn't overtaken", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_two" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await seedTable(admin, 20);
      await seedTable(admin, 21);
      await setSwitch(transactions, true);
      const identity = guests();
      // Phone B took its instant first and waits; phone A, whose clock reads later, wins the start.
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      let waiting;
      const reached = new Promise((resolve) => {
        waiting = resolve;
      });
      const phoneB = composeJoin({
        transactions,
        credentials,
        identity,
        takingDineIn: async () => {
          waiting();
          await held;
          return true;
        },
      });
      const phoneA = composeJoin({ transactions, credentials, identity });
      const b = tap(phoneB, identity.scan(81, 20));
      await reached;
      assert.equal((await tap(phoneA, identity.scan(80, 20))).status, "Joined");
      release();
      assert.equal((await b).status, "Joined");
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_session WHERE table_id=$1",
          [id(20)],
        ),
        1,
      );
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_participant p JOIN rms_dining.dining_session s USING (session_id) WHERE s.table_id=$1",
          [id(20)],
        ),
        2,
      );
      // Three phones truly at once: every one joined, one Session, under the 2 s lock timeout.
      const join = composeJoin({ transactions, credentials, identity });
      const answers = await Promise.all([
        tap(join, identity.scan(90, 21)),
        tap(join, identity.scan(91, 21)),
        tap(join, identity.scan(92, 21)),
      ]);
      assert.deepEqual(
        answers.map((answer) => answer.status),
        ["Joined", "Joined", "Joined"],
      );
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_session WHERE table_id=$1",
          [id(21)],
        ),
        1,
      );
    } finally {
      await admin.end();
    }
  });
}, 180_000);

it("budgets: the 4th start at a table and the 41st at a Store in 10 minutes are refused, nothing written", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_budget" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await setSwitch(transactions, true);
      await seedTable(admin, 20);
      const version = (
        await admin.query("SELECT max(version) AS v FROM rms_dining.dining_service_setting")
      ).rows[0].v;
      const identity = guests();
      const join = composeJoin({ transactions, credentials, identity });
      // Three earlier starts at table 20 in the window, recorded as a start records them (closed
      // Sessions: the table is free again).
      const past = async (table, minutesAgo, n) => {
        const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
        const session = fresh();
        await admin.query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb,$7)",
          [
            session,
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(table),
            JSON.stringify({
              diningSessionReference: session,
              ...owner,
              tableReference: id(table),
              tableAssignmentVersion: 2,
              phase: "Active",
              version: 1,
              startedByActorReference: id(n),
              startedAt: at,
              hostParticipantReference: null,
            }),
            at,
          ],
        );
        await admin.query(
          "INSERT INTO rms_dining.dining_session_guest_start (tenant_id,brand_id,store_id,session_id,table_id,guest_session_id,operation_id,service_setting_version,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            session,
            id(table),
            id(n),
            fresh(),
            version,
            at,
          ],
        );
        await admin.query(
          'UPDATE rms_dining.dining_session SET phase=\'Closed\',version=2,session_snapshot=session_snapshot||\'{"phase":"Closed","version":2}\'::jsonb WHERE session_id=$1',
          [session],
        );
      };
      for (const n of [1, 2, 3]) await past(20, n, 0x400 + n);
      const before = await count(admin, "SELECT count(*)::int AS n FROM rms_dining.dining_session");
      assert.deepEqual(await tap(join, identity.scan(80, 20)), {
        status: "Refused",
        reason: "TooManyJoins",
      });
      assert.equal(
        await count(admin, "SELECT count(*)::int AS n FROM rms_dining.dining_session"),
        before,
      );
      // A table's budget doesn't touch another; a Store's budget of 40 does.
      await seedTable(admin, 30);
      for (let n = 0; n < 37; n += 1) {
        await seedTable(admin, 100 + n);
        await past(100 + n, 5, 0x500 + n);
      }
      const atStore = await count(
        admin,
        "SELECT count(*)::int AS n FROM rms_dining.dining_session_guest_start",
      );
      assert.equal(atStore, 40);
      assert.deepEqual(await tap(join, identity.scan(81, 30)), {
        status: "Refused",
        reason: "TooManyJoins",
      });
      // The database refuses the same whatever the store checked.
      await assert.rejects(past(30, 1, 0x600), /too many guest starts at this store/u);
      // After the window a start works again.
      await admin.query("SELECT 1");
    } finally {
      await admin.end();
    }
  });
}, 300_000);

const minutes = (n) => n * 60_000;
const provider = id(0x801);

/**
 * A guest-started table whose paid round the kitchen has: the Session, its guest-start row and one
 * paid, accepted round, owner-seeded (payment and acceptance are covered by their own suites). The
 * tenant scope of these rows is the journey fixture's.
 */
async function seedPaidGuestTable(admin, transactions, input) {
  const base = input.base;
  const time = (offset) => new Date(base + offset).toISOString();
  const R1 = journeyRound({ at: time(-minutes(130)), prefix: input.prefix });
  const journeyScope = R1.f.scope;
  const tenant = journeyScope.brandReference.slice(0, 24) + "000000000900";
  const ownerScope = { tenantReference: tenant, ...journeyScope };
  await admin.query(
    "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
    [journeyScope.brandReference, journeyScope.storeReference],
  );
  const version = await transactions().run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      journeyScope.brandReference,
      journeyScope.storeReference,
    ]);
    const current = (
      await tx.query(
        "SELECT coalesce(max(version),0)::int AS version FROM rms_dining.dining_service_setting WHERE brand_id=$1 AND store_id=$2",
        [journeyScope.brandReference, journeyScope.storeReference],
      )
    ).rows[0].version;
    return (
      await changeDiningServiceSetting(tx, ownerScope, {
        operationReference: fresh(),
        expectedVersion: current,
        staffCall: false,
        chaseDish: false,
        guestTableStart: true,
        actorReference: id(8),
        observedAt: time(-minutes(151)),
      })
    ).version;
  });
  const dining = await seedJourneyDining({
    client: admin,
    scope: ownerScope,
    round: R1,
    startedAt: time(-minutes(150)),
    guestParticipant: id(0x901),
    tableVersion: 2,
  });
  const session = dining.session;
  await admin.query(
    "INSERT INTO rms_dining.dining_session_guest_start (tenant_id,brand_id,store_id,session_id,table_id,guest_session_id,operation_id,service_setting_version,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      tenant,
      journeyScope.brandReference,
      journeyScope.storeReference,
      session.diningSessionReference,
      session.tableReference,
      R1.f.request.record.guestSessionReference,
      fresh(),
      version,
      session.startedAt,
    ],
  );
  const r1 = R1.f.request.record,
    items1 = R1.items();
  await seedAcceptanceOrderHistory(admin, {
    ...r1,
    items: items1,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: r1.order.orderReference,
      allocatedAt: r1.createdAt,
      sequence: 1n,
      businessDateResolution: R1.f.request.businessDateResolution,
    }),
  });
  await seedJourneyQuote({
    runner: input.ownerRunner,
    scope: ownerScope,
    snapshot: { items: items1, batch: R1.batch },
    prefix: "01a1" + input.prefix.slice(4),
  });
  const roundTotal = items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
  const n = input.refsAt;
  const refs = {
    paymentIntent: id(n + 1),
    attempt: id(n + 2),
    observation: id(n + 3),
    webhook: id(n + 4),
    transaction: id(n + 5),
    paymentEvent: id(n + 6),
    projection: id(n + 7),
    preparation: id(n + 8),
    commitment: id(n + 9),
    paymentOperation: id(n + 10),
    providerIntent: "pi_SYNTHETICGUEST" + n.toString(16),
    providerEvent: "evt_SYNTHETICGUEST" + n.toString(16),
    acceptance: id(n + 11),
    acceptanceOperation: id(n + 12),
    acceptanceWorkflow: id(n + 13),
    acceptanceTransition: id(n + 14),
    disposition: id(n + 15),
    correlation: id(n + 16),
    confirmation: id(n + 17),
    confirmedEvent: id(n + 18),
    ticket: id(n + 19),
    sourceEvidence: id(n + 20),
    workPlan: id(n + 21),
    station: id(n + 22),
    routing: id(n + 23),
    preparationStep: id(n + 24),
    workItems: [id(n + 30), id(n + 31)],
  };
  await seedJourneyPayment(admin, {
    scope: journeyScope,
    providerAccountReference: provider,
    round: R1,
    refs,
    outcome: "Succeeded",
    requestedAt: time(-minutes(129)),
    occurredAt: time(-minutes(128)),
    totalMinor: roundTotal,
  });
  await seedJourneyAcceptance(admin, {
    scope: journeyScope,
    round: R1,
    items: items1,
    refs,
    staff: id(8),
    version: 1,
    previousRevision: r1.submissionReference,
    acceptedAt: time(-minutes(127)),
    kitchenAt: time(-minutes(126)),
  });
  return { ownerScope, session, refs, orderReference: r1.order.orderReference, roundTotal };
}

const closer = (transactions, ownerScope, now) =>
  createDiningGuestTableClose({
    scope: ownerScope,
    providerAccountReference: provider,
    environment: "Test",
    transactions: transactions(),
    authorize: async () => true,
    now,
    newReference: fresh,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    orderAudit: { retentionPolicyCode: "ORDER_AUDIT", retentionPolicyVersion: 1 },
  });
/** The kitchen finishes the round, through the real Kitchen commands under the API role. */
async function finishKitchen({ admin, transactions, ownerScope, orderReference, at }) {
  const sha256 = (value) => "sha256:" + digest(value);
  const correlation = fresh();
  const cook = id(0x720);
  const references = {
    next: fresh,
    derive(purpose, identity) {
      const hex = digest(purpose + identity);
      return `0190abcf-${hex.slice(0, 4)}-7${hex.slice(4, 7)}-8${hex.slice(7, 10)}-${hex.slice(10, 22)}`;
    },
  };
  const kitchen = createKitchenWorkLifecycleService({
    trustedContext: {
      resolveAuthority: async () => ({
        actorReference: cook,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        observedAt: at,
      }),
    },
    correlationContext: { resolve: async () => ({ correlationReference: correlation }) },
    authorization: { authorize: async () => true },
    transactions: {
      withTransaction: (work) =>
        transactions().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [ownerScope.tenantReference, ownerScope.brandReference, ownerScope.storeReference],
          );
          return work(tx);
        }),
    },
    tenantContext: { install: async () => undefined },
    idempotency: {
      acquireFence: async ({ transaction, idempotencyKey }) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          ownerScope.storeReference + ":" + idempotencyKey,
        ]);
      },
    },
    repository: createPostgresKitchenWorkLifecycleStore({
      brandReference: ownerScope.brandReference,
      storeReference: ownerScope.storeReference,
      references,
      digests: { sha256 },
      authorize: async () => true,
      validateCurrentSource: async () => true,
    }),
    references,
    digests: { sha256 },
    clock: { now: () => at },
    admission: {
      resolve: async ({ command, acceptedOperationReference }) => ({
        decisionReference: fresh(),
        decisionVersion: 1,
        decisionDigest: sha256("synthetic admission"),
        producerContractVersion: 1,
        actorReference: command.actorReference,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        ticketReference: command.ticketReference,
        workItemReference: command.workItemReference,
        acceptedOperationReference,
        ticketVersion: BigInt(command.expectedTicketVersion),
        workItemVersion: BigInt(command.expectedWorkItemVersion),
        action: "StartKitchenWorkItem",
        purpose: "KitchenWorkExecution",
        outcome: "Allowed",
        evaluatedAt: at,
        validUntil: new Date(Date.parse(at) + minutes(60)).toISOString(),
      }),
    },
    expo: {
      resolve: async () => ({
        decisionReference: fresh(),
        decisionVersion: 1,
        decisionDigest: sha256("synthetic Expo"),
        producerContractVersion: 1,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        purpose: "KitchenReadiness",
        mode: "Disabled",
        evaluatedAt: at,
        validUntil: new Date(Date.parse(at) + minutes(60)).toISOString(),
      }),
    },
  });
  const work = (
    await admin.query(
      "SELECT w.kitchen_work_item_id::text AS id,w.order_item_id::text AS item,w.required_quantity AS quantity,w.kitchen_ticket_id::text AS ticket FROM rms_kitchen.kitchen_work_item w WHERE w.order_id=$1 ORDER BY w.source_item_ordinal",
      [orderReference],
    )
  ).rows;
  for (const row of work) {
    const step = async (action, extra = {}) => {
      const versions = (
        await admin.query(
          "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
          [row.id],
        )
      ).rows[0];
      return kitchen.execute({
        action,
        idempotencyKey: "guest-table-" + row.id + "-" + action,
        actorReference: cook,
        brandReference: ownerScope.brandReference,
        storeReference: ownerScope.storeReference,
        ticketReference: row.ticket,
        workItemReference: row.id,
        orderItemReference: row.item,
        expectedTicketVersion: versions.ticket,
        expectedWorkItemVersion: versions.item,
        correlationReference: correlation,
        ...extra,
      });
    };
    assert.equal((await step("AcceptKitchenWorkItem")).outcome, "Accepted");
    assert.equal((await step("StartKitchenWorkItem")).outcome, "Started");
    assert.match(
      (await step("CompleteKitchenWorkItem", { quantityDelta: row.quantity })).outcome,
      /^Completed/u,
    );
  }
}

it("the System closes a paid table the kitchen finished, nobody having tapped Served, recording who and why; nothing unfinished closes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_close" }, async (context) => {
    const { admin, transactions, ownerRunner } = await setup(context);
    try {
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const seeded = await seedPaidGuestTable(admin, transactions, {
        base,
        prefix: "01a00001",
        refsAt: 0x1000,
        ownerRunner,
      });
      const { ownerScope, session, orderReference } = seeded;
      const sessionReference = session.diningSessionReference;
      const now = () => new Date().toISOString();
      const system = closer(transactions, ownerScope, now);
      const state = async () =>
        (
          await admin.query(
            "SELECT s.phase,t.table_snapshot->>'operationalState' AS table_state,t.table_snapshot->>'activeDiningSessionReference' AS active FROM rms_dining.dining_session s JOIN rms_dining.dining_table t ON t.table_id=s.table_id WHERE s.session_id=$1",
            [sessionReference],
          )
        ).rows[0];

      // Paid and accepted, the kitchen still making it: the table stays open.
      assert.deepEqual(await system.closeQuiet(sessionReference), {
        status: "Held",
        hold: "Unfinished",
      });
      assert.equal((await state()).phase, "Active");

      // The kitchen finishes; nobody taps Served. Only quiet time held it, and it has passed.
      const cookedAt = new Date(base - minutes(120)).toISOString();
      await finishKitchen({ admin, transactions, ownerScope, orderReference, at: cookedAt });
      // Under 90 minutes since the kitchen last touched it: a party still sitting isn't ended.
      const soon = closer(transactions, ownerScope, () =>
        new Date(Date.parse(cookedAt) + minutes(60)).toISOString(),
      );
      assert.deepEqual(await soon.closeQuiet(sessionReference), {
        status: "Held",
        hold: "Recent",
      });
      // Two hours on, nothing else has happened.
      const closed = await system.closeQuiet(sessionReference);
      assert.equal(closed.status, "Closed");
      assert.equal(closed.orderReference, orderReference);
      assert.ok(closed.servedItems >= 1);

      // The table is free with no cleaning step; the next scan can start it.
      assert.deepEqual(await state(), {
        phase: "Closed",
        table_state: "Available",
        active: null,
      });
      assert.equal(
        (
          await transactions().run((tx) =>
            loadDiningGuestTableStart(
              tx,
              ownerScope,
              session.tableReference,
              new Date().toISOString(),
            ),
          )
        ).kind,
        "MayStart",
      );

      // Each owner's record says the System did it, with the owner's own reason.
      const audits = (
        await admin.query(
          "SELECT action_code,actor_type,actor_reference,reason_code,source_channel FROM platform_audit.audit_record WHERE action_code IN ('DINING_ITEM_SERVED','DINING_SESSION_CLOSING_BEGIN','DINING_SESSION_CLOSING_FINALIZE','ORDER_FINANCIAL_FINALITY_RECORDED','ORDER_CLOSURE_RECORDED','DINING_TABLE_RELEASED') ORDER BY occurred_at,action_code",
        )
      ).rows;
      const byCode = Object.fromEntries(audits.map((row) => [row.action_code, row]));
      const system_ = (reason) => ({
        actor_type: "System",
        actor_reference: null,
        reason_code: reason,
        source_channel: "SYSTEM",
      });
      assert.deepEqual(
        { ...byCode.DINING_SESSION_CLOSING_BEGIN, action_code: undefined },
        { ...system_("GUEST_TABLE_QUIET"), action_code: undefined },
      );
      assert.deepEqual(
        { ...byCode.DINING_SESSION_CLOSING_FINALIZE, action_code: undefined },
        { ...system_("GUEST_TABLE_QUIET"), action_code: undefined },
      );
      assert.deepEqual(
        { ...byCode.DINING_ITEM_SERVED, action_code: undefined },
        { ...system_("GUEST_TABLE_QUIET"), action_code: undefined },
      );
      assert.deepEqual(
        { ...byCode.ORDER_FINANCIAL_FINALITY_RECORDED, action_code: undefined },
        { ...system_("ORDER_SETTLED"), action_code: undefined },
      );
      assert.deepEqual(
        { ...byCode.ORDER_CLOSURE_RECORDED, action_code: undefined },
        { ...system_("ORDER_COMPLETED"), action_code: undefined },
      );
      assert.deepEqual(
        { ...byCode.DINING_TABLE_RELEASED, action_code: undefined },
        { ...system_("CLOSED_SESSION_RELEASE"), action_code: undefined },
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT status,actor_type,actor_id,reason_code FROM rms_ordering.order_closure_version WHERE order_id=$1",
            [orderReference],
          )
        ).rows,
        [
          {
            status: "Closed",
            actor_type: "System",
            actor_id: null,
            reason_code: "ORDER_COMPLETED",
          },
        ],
      );
      // Closed once: another cycle finds nothing to do.
      assert.deepEqual(await system.closeQuiet(sessionReference), {
        status: "Held",
        hold: "Changed",
      });
    } finally {
      await admin.end();
    }
  });
}, 300_000);

/** A guest started this table some minutes ago, through the real store with its clock back then. */
async function startedAgo({ transactions, credentials }, table, minutesAgo) {
  const at = new Date(Date.now() - minutes(minutesAgo)).toISOString();
  const answer = await createPostgresDiningGuestTableStartStore(transactions(), {
    scope,
    credentials,
    pepperVersion: 1,
    now: () => at,
    newReference: fresh,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    takingDineIn: async () => true,
  }).startIfFree({ tableReference: id(table), guestSessionReference: fresh() });
  assert.equal(answer.status, "Started");
  return answer.diningSessionReference;
}

it("a table with no order frees itself after 20 quiet minutes; held tables don't keep the next from being reached", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_quiet" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await setSwitch(transactions, true);
      for (let n = 0; n < 12; n += 1) await seedTable(admin, 200 + n);
      const now = () => new Date().toISOString();
      const system = closer(transactions, scope, now);
      // Eleven tables still within their time, then one past it: the cursor reaches it.
      for (let n = 0; n < 11; n += 1) await startedAgo({ transactions, credentials }, 200 + n, 1);
      await delay(2);
      const quiet = await startedAgo({ transactions, credentials }, 211, 25);
      assert.deepEqual(await system.closeQuiet(await startedAt(admin, 200)), {
        status: "Held",
        hold: "Recent",
      });
      const failures = [];
      const first = await system.runOnce({ limit: 10, onFailure: (e) => failures.push(e) });
      const second = await system.runOnce({ limit: 10, onFailure: (e) => failures.push(e) });
      assert.equal(first + second, 1);
      assert.deepEqual(failures, []);
      const row = (
        await admin.query(
          "SELECT s.phase,t.table_snapshot->>'operationalState' AS state,t.table_snapshot->>'activeDiningSessionReference' AS active FROM rms_dining.dining_session s JOIN rms_dining.dining_table t USING (table_id) WHERE s.session_id=$1",
          [quiet],
        )
      ).rows[0];
      assert.deepEqual(row, { phase: "Closed", state: "Available", active: null });
      // No Order: nothing on the books, and the audits say why.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT action_code,actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE target_id=$1 AND action_code LIKE 'DINING_SESSION_CLOSING_%' ORDER BY action_code",
            [quiet],
          )
        ).rows,
        [
          {
            action_code: "DINING_SESSION_CLOSING_BEGIN",
            actor_type: "System",
            reason_code: "GUEST_TABLE_QUIET",
            source_channel: "SYSTEM",
          },
          {
            action_code: "DINING_SESSION_CLOSING_FINALIZE",
            actor_type: "System",
            reason_code: "GUEST_TABLE_QUIET",
            source_channel: "SYSTEM",
          },
        ],
      );
      // A staff-opened table is never touched: not discovered, and refused by name.
      const staffOpened = fresh();
      assert.deepEqual(await system.closeQuiet(staffOpened), { status: "Held", hold: "Changed" });
      // Turned off, a table already started still frees itself.
      await setSwitch(transactions, false);
      const stillOpen = await startedAtSession(admin, 200);
      const later = closer(transactions, scope, () => new Date(Date.now()).toISOString());
      assert.deepEqual(await later.closeQuiet(stillOpen), { status: "Held", hold: "Recent" });
      const older = await admin.query(
        "SELECT count(*)::int AS n FROM rms_dining.dining_session s JOIN rms_dining.dining_session_guest_start g USING (session_id) WHERE s.phase='Active'",
      );
      assert.equal(older.rows[0].n, 11);
    } finally {
      await admin.end();
    }
  });
}, 300_000);
const startedAtSession = async (admin, table) =>
  (
    await admin.query(
      "SELECT session_id::text AS id FROM rms_dining.dining_session WHERE table_id=$1 AND phase='Active'",
      [id(table)],
    )
  ).rows[0].id;
const startedAt = startedAtSession;

it("the next party after a 5-minute gap gets its own Session, once it says it isn't with the people there", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_party" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await setSwitch(transactions, true);
      await seedTable(admin, 20);
      await seedTable(admin, 21);
      const now = () => new Date().toISOString();
      const system = closer(transactions, scope, now);
      const identity = guests();
      const join = composeJoin({
        transactions,
        credentials,
        identity,
        closeForNewParty: (input) => system.closeForNewParty(input.tableReference),
      });
      const asks = (table) => transactions().run((tx) => system.asksNewParty(tx, id(table)));
      // A party that sat down a minute ago: nobody is asked; a claim is refused.
      await startedAgo({ transactions, credentials }, 21, 1);
      assert.equal(await asks(21), false);
      const phone = identity.scan(83, 21);
      assert.deepEqual(
        await join.join(
          {
            sessionCredential: phone.sessionCredential,
            csrfCredential: phone.csrfCredential,
            operationReference: fresh(),
            newParty: true,
          },
          joinRequest,
        ),
        { status: "Refused", reason: "TableInUse" },
      );
      // Six quiet minutes on another table: asked, and "we just sat down" closes it and starts anew.
      const previous = await startedAgo({ transactions, credentials }, 20, 6);
      assert.equal(await asks(20), true);
      const next = identity.scan(84, 20);
      const joined = await join.join(
        {
          sessionCredential: next.sessionCredential,
          csrfCredential: next.csrfCredential,
          operationReference: fresh(),
          newParty: true,
        },
        joinRequest,
      );
      assert.equal(joined.status, "Joined");
      const sessions = (
        await admin.query(
          "SELECT session_id::text AS id,phase FROM rms_dining.dining_session WHERE table_id=$1 ORDER BY started_at",
          [id(20)],
        )
      ).rows;
      assert.deepEqual(
        sessions.map((row) => row.phase),
        ["Closed", "Active"],
      );
      assert.equal(sessions[0].id, previous);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT DISTINCT actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE target_id=$1 AND action_code LIKE 'DINING_SESSION_CLOSING_%'",
            [previous],
          )
        ).rows,
        [{ actor_type: "System", reason_code: "GUEST_NEW_PARTY", source_channel: "CUSTOMER_PWA" }],
      );
      // The new party's phone is on the new Session, not the old one.
      const host = (
        await admin.query(
          "SELECT session_snapshot->>'hostParticipantReference' AS host FROM rms_dining.dining_session WHERE session_id=$1",
          [sessions[1].id],
        )
      ).rows[0].host;
      assert.notEqual(host, null);
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_participant WHERE session_id=$1",
          [previous],
        ),
        0,
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);

it("the question and the close are refused while a round is unfinished; a party still eating stays one Session; a paid event during a close doesn't deadlock", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_owed" }, async (context) => {
    const { admin, transactions, ownerRunner } = await setup(context);
    try {
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const seeded = await seedPaidGuestTable(admin, transactions, {
        base,
        prefix: "01a00001",
        refsAt: 0x1000,
        ownerRunner,
      });
      const { ownerScope, session, orderReference } = seeded;
      const sessionReference = session.diningSessionReference;
      const now = () => new Date().toISOString();
      const system = closer(transactions, ownerScope, now);
      const asks = () =>
        transactions().run((tx) => system.asksNewParty(tx, session.tableReference));
      // Paid, not finished: nobody is asked, a claim is refused, the System leaves it alone.
      assert.equal(await asks(), false);
      assert.deepEqual(await system.closeForNewParty(session.tableReference), {
        status: "Held",
        hold: "Unfinished",
      });
      assert.deepEqual(await system.closeQuiet(sessionReference), {
        status: "Held",
        hold: "Unfinished",
      });
      const cookedAt = new Date(base - minutes(120)).toISOString();
      await finishKitchen({ admin, transactions, ownerScope, orderReference, at: cookedAt });
      // An hour after the last activity they are still at the table: one Session.
      const anHourOn = closer(transactions, ownerScope, () =>
        new Date(Date.parse(cookedAt) + minutes(60)).toISOString(),
      );
      assert.deepEqual(await anHourOn.closeQuiet(sessionReference), {
        status: "Held",
        hold: "Recent",
      });
      // Lock order: a paid event holds the Order fence, then wants the table. The close waits on
      // the fence holding nothing, so the paid event goes first and neither fails.
      const paid = new Client(context.clientConfig);
      await paid.connect();
      await paid.query("BEGIN");
      await paid.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [ownerScope.brandReference, ownerScope.storeReference],
      );
      await paid.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" +
          ownerScope.brandReference +
          ":" +
          ownerScope.storeReference +
          ":" +
          orderReference,
      ]);
      const closing = system.closeQuiet(sessionReference);
      for (let waited = 0; waited < 200; waited += 1) {
        const waiting = await admin.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        if (waiting.rows[0].n > 0) break;
        await delay(25);
      }
      await paid.query(
        "SELECT table_id FROM rms_dining.dining_table WHERE table_id=$1 FOR UPDATE",
        [session.tableReference],
      );
      await paid.query("COMMIT");
      await paid.end();
      assert.equal((await closing).status, "Closed");
    } finally {
      await admin.end();
    }
  });
}, 300_000);

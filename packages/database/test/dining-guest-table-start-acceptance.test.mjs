import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createGuestDiningBindingCredentialProvider,
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestDiningBindingStore,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import {
  changeDiningServiceSetting,
  createDiningTable,
  createPostgresDiningGuestTableStartStore,
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningPublicTableReader,
  createDiningCartParticipationQuery,
  createDiningGuestBindingQuery,
  createDiningParticipantSubmissionQuery,
  createPostgresDiningAdmissionConsumptionStore,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningParticipationStore,
  createPostgresDiningQrJoinStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningSessionStartStore,
  buildDiningSessionStartRecord,
  loadDiningGuestTableOffer,
  loadDiningGuestTableStart,
  loadDiningGuestTableStartPage,
  parseQrTableContextEvidence,
} from "../../rms/dining/src/index.ts";
import { listStoreKitchenOrderProgress } from "../../rms/kitchen/src/index.ts";
import { readPaymentRemainingRefundable } from "../../rms/payment/src/index.ts";
import { createCustomerDiningBindingComposition } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { createCustomerDiningJoinComposition } from "../../../apps/api/src/customer-dining-join-composition.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { journeyRound } from "../test-support/dine-in-journey-seed.mjs";
import {
  closer,
  digest,
  finishKitchen,
  fresh,
  id,
  minutes,
  owner,
  provider,
  scope,
  seedPaidGuestTable,
  setup,
} from "../test-support/dining-guest-table-fixture.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;

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

/**
 * The real table read, on a connection of its own, as the pilot's QR context does: this is what
 * would block on a table row a start still held in the same transaction.
 */
const tableContexts = (run) => ({
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
});

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
    contexts: tableContexts(run),
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
      // Staff opening the table at the same moment hold the version from before: a plain conflict
      // the page answers with "changed, refresh", never a failure.
      const staffAt = new Date().toISOString();
      const staffStart = buildDiningSessionStartRecord({
        credentials,
        pepperVersion: 1,
        ...owner,
        tableReference: id(20),
        assignmentVersion: 2,
        actorReference: id(8),
        operationReference: fresh(),
        joinKind: "HumanCode",
        requestedAt: staffAt,
      });
      await assert.rejects(
        createPostgresDiningSessionStartStore(transactions(), scope, credentials).start({
          record: staffStart.record,
          expectedAssignmentVersion: 2,
          audit: {
            auditId: fresh(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: id(8) },
            actionCode: "DINING_SESSION_START",
            targetType: "DiningTable",
            targetId: id(20),
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: fresh(),
            occurredAt: staffAt,
            sourceChannel: "API",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        }),
        { code: "DINING_SESSION_VERSION_CONFLICT" },
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

it("a phone with a real Guest Session starts the table, joins and binds: it is seated and can order", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_bind" }, async (context) => {
    const { admin, transactions, credentials } = await setup(context);
    try {
      await seedTable(admin, 20);
      await setSwitch(transactions, true);
      // Real Identity from the scan on, under the rendered pilot grants.
      const store = createPostgresGuestSessionEntryStore(transactions(), owner);
      const guestCredentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
      const sessionCredential = guestCredentials.generateCredential("Session"),
        csrfCredential = guestCredentials.generateCredential("Csrf"),
        base = Date.now() - 60_000,
        at = new Date(base).toISOString();
      await store.create({
        record: createGuestSessionRecord({
          session: {
            sessionReference: id(80),
            status: "Active",
            version: 1,
            ...owner,
            publicStoreReference: id(4),
            publicTableReference: id(20 + 0x100),
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
          sessionSelectorHash: guestCredentials.hashCredential("Session", sessionCredential),
          csrfSelectorHash: guestCredentials.hashCredential("Csrf", csrfCredential),
          operationReference: fresh(),
          operationIntentHash: guestCredentials.hashOperationIntent("synthetic entry"),
        }),
      });
      const joined = await tap(
        composeJoin({
          transactions,
          credentials,
          identity: { provider: guestCredentials, store },
        }),
        { sessionCredential, csrfCredential },
      );
      assert.equal(joined.status, "Joined");
      const session = (
        await admin.query(
          "SELECT session_id::text AS id,version,session_snapshot FROM rms_dining.dining_session WHERE table_id=$1",
          [id(20)],
        )
      ).rows[0];
      const auditOf = (actionCode, targetType, targetId, occurredAt, reasonCode) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode,
        targetType,
        targetId,
        reasonCode,
        correlationId: fresh(),
        occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const binding = createCustomerDiningBindingComposition({
        scope: owner,
        session: {
          store,
          credentials: guestCredentials,
          binding: { validate: async () => "Current" },
        },
        bindings: createPostgresGuestDiningBindingStore(
          transactions(),
          owner,
          {
            append: (tx, descriptor) =>
              appendAuditRecordInTransaction(
                tx,
                auditOf(
                  "IDENTITY_GUEST_DINING_BINDING_" + descriptor.action.toUpperCase(),
                  "GuestDiningBindingPreparation",
                  descriptor.operationReference,
                  descriptor.occurredAt,
                  "AUTHORIZED_OPERATION",
                ),
              ),
          },
          guestCredentials.equals,
        ),
        dining: {
          credentials,
          store: createPostgresDiningAdmissionConsumptionStore(
            transactions(),
            scope,
            credentials,
            (descriptor) =>
              auditOf(
                "DINING_IDENTITY_ADMISSION_CONSUME",
                "DiningIdentityAdmission",
                descriptor.admissionReference,
                descriptor.occurredAt,
                "AUTHORIZED_DINING_ADMISSION_CONSUMPTION",
              ),
          ),
          binding: createPostgresDiningGuestBindingStore(transactions(), scope),
        },
        contexts: tableContexts(transactions()),
        recovery: createGuestDiningBindingCredentialProvider(new Uint8Array(32).fill(11)),
        preparationLifetimeSeconds: 300,
        now: () => new Date().toISOString(),
      });
      const operationReference = fresh();
      const prepared = await binding.prepare({
        sessionCredential,
        csrfCredential,
        operationReference,
        admissionReference: joined.admissionReference,
      });
      await binding.activate({
        sessionCredential,
        csrfCredential,
        operationReference,
        candidateSessionCredential: prepared.sessionCredential,
        candidateCsrfCredential: prepared.csrfCredential,
        recoveryProof: prepared.recoveryProof,
      });
      const completed = await binding.complete({
        operationReference,
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      });
      assert.equal(completed.status, "Activated");
      // The phone's visit now names the table a guest started, and the gates every round goes through
      // answer as at a table staff opened.
      const bound = (
        await store.resolve(guestCredentials.hashCredential("Session", prepared.sessionCredential))
      ).session;
      assert.equal(bound.diningSessionReference, session.id);
      const hostReference = session.session_snapshot.hostParticipantReference;
      assert.equal(bound.diningParticipantReference, hostReference);
      const seat = { diningSessionReference: session.id, participantReference: hostReference };
      const clock = () => new Date().toISOString();
      assert.ok(
        await createDiningGuestBindingQuery({
          scope: owner,
          now: clock,
          repository: createPostgresDiningGuestBindingStore(transactions(), scope),
        }).resolve({ purpose: "GuestSessionBinding", ...seat, tableReference: id(20) }),
      );
      assert.ok(
        await createDiningParticipantSubmissionQuery({
          scope: owner,
          now: clock,
          repository: createPostgresDiningGuestBindingStore(transactions(), scope),
        }).resolve({ purpose: "DiningParticipantSubmission", ...seat, tableReference: id(20) }),
      );
      assert.ok(
        await createDiningCartParticipationQuery({
          scope: owner,
          now: clock,
          repository: createPostgresDiningParticipationStore(transactions(), scope),
        }).resolve({ purpose: "Cart", ...seat }),
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);

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
      // With the switch off nothing takes the row guests and round commits share: a read holding it
      // FOR SHARE doesn't slow this answer, and it isn't a lock timeout.
      const holder = new Client(context.clientConfig);
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(
        "SELECT table_id FROM rms_dining.dining_table WHERE table_id=$1 FOR SHARE",
        [id(20)],
      );
      const started = Date.now();
      assert.deepEqual(await tap(join, identity.scan(81, 20)), {
        status: "Refused",
        reason: "NotOpen",
      });
      assert.ok(Date.now() - started < 8000);
      await holder.query("COMMIT");
      await holder.end();
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
      // A scan offers no start it couldn't give: the guest is told what a guest at any table
      // nobody opened is told, rather than tapping Start and being refused.
      const offer = (table, at = new Date().toISOString()) =>
        transactions().run((tx) => loadDiningGuestTableOffer(tx, owner, id(table), at));
      assert.deepEqual(await offer(20), { kind: "Spent" });
      assert.deepEqual(await offer(20, new Date(Date.now() + minutes(11)).toISOString()), {
        kind: "MayStart",
        clearsCleaning: false,
      });
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
      assert.deepEqual(await offer(30), { kind: "MayStart", clearsCleaning: false });
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
      assert.deepEqual(await offer(30), { kind: "Spent" });
      // Tables tells staff why guests at free tables are coming to them; a window later it clears.
      const page = (at) =>
        transactions().run((tx) => loadDiningGuestTableStartPage(tx, owner, [], at));
      assert.equal((await page(new Date().toISOString())).storeBudgetSpent, true);
      assert.equal(
        (await page(new Date(Date.now() + minutes(11)).toISOString())).storeBudgetSpent,
        false,
      );
      // The database refuses the same whatever the store checked.
      await assert.rejects(past(30, 1, 0x600), /too many guest starts at this store/u);
      // After the window a start works again.
      await admin.query("SELECT 1");
    } finally {
      await admin.end();
    }
  });
}, 300_000);

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
      // Tables reads the same kitchen fact for a whole page, as the pilot's role.
      const progress = () =>
        transactions().run(async (tx) =>
          (await listStoreKitchenOrderProgress(tx, ownerScope, [orderReference])).get(
            orderReference,
          ),
        );
      assert.equal((await progress())?.stillMaking, true);

      // The kitchen finishes; nobody taps Served. Only quiet time held it, and it has passed.
      const cookedAt = new Date(base - minutes(120)).toISOString();
      await finishKitchen({ admin, transactions, ownerScope, orderReference, at: cookedAt });
      assert.deepEqual(await progress(), { lastChangedAt: cookedAt, stillMaking: false });
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
      // The money record is the same one a staff close writes: settled for exactly what was paid.
      const finality = (
        await admin.query(
          "SELECT classification,captured_minor::text AS captured,priced_order_total_minor::text AS priced FROM rms_payment.order_settled_finality WHERE order_id=$1",
          [orderReference],
        )
      ).rows;
      assert.deepEqual(finality, [
        {
          classification: "Settled",
          captured: String(seeded.roundTotal),
          priced: String(seeded.roundTotal),
        },
      ]);
      // An ordinary refund has no closure gate: after the System's close the whole round can still
      // be refunded (the refund commands read this same owner fact).
      const refundable = await transactions().run((tx) =>
        readPaymentRemainingRefundable(tx, {
          scope: {
            ...ownerScope,
            providerAccountReference: provider,
            environment: "Test",
          },
          orderReference,
          paymentTransactionReference: seeded.refs.transaction,
          paymentIntentReference: seeded.refs.paymentIntent,
          paymentAttemptReference: seeded.refs.attempt,
          observedAt: new Date().toISOString(),
          authorize: async () => true,
        }),
      );
      assert.equal(refundable.remainingMinor, seeded.roundTotal);
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
      const asks = (table) => system.asksNewParty(id(table));
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
      // The new start names the visit it ended, and Tables says so on that table only.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT ended_session_id::text AS ended FROM rms_dining.dining_session_guest_start WHERE session_id=$1",
            [sessions[1].id],
          )
        ).rows,
        [{ ended: previous }],
      );
      const sittingDown = await startedAtSession(admin, 21);
      const page = await transactions().run((tx) =>
        loadDiningGuestTableStartPage(tx, owner, [sessions[1].id, sittingDown], now()),
      );
      assert.equal(page.started.get(sessions[1].id)?.endedLastParty, true);
      assert.equal(page.started.get(sittingDown)?.endedLastParty, false);
      // The database takes that name only for a visit that closed at the same table.
      await seedTable(admin, 22);
      const startNaming = (endedSessionReference) =>
        createPostgresDiningGuestTableStartStore(transactions(), {
          scope,
          credentials,
          pepperVersion: 1,
          now,
          newReference: fresh,
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          takingDineIn: async () => true,
        }).startIfFree({
          tableReference: id(22),
          guestSessionReference: fresh(),
          endedSessionReference,
        });
      await assert.rejects(startNaming(sittingDown), { code: "23514" });
      await assert.rejects(startNaming(previous), { code: "23514" });
      assert.equal(
        await count(
          admin,
          "SELECT count(*)::int AS n FROM rms_dining.dining_session WHERE table_id=$1",
          [id(22)],
        ),
        0,
      );

      // Staff paused scanning at a quiet table: nobody new is asked, and "we just sat down" from a
      // phone that was asked before the pause ends nothing.
      await seedTable(admin, 23);
      const quietTable = await startedAgo({ transactions, credentials }, 23, 6);
      assert.equal(await asks(23), true);
      const asked = identity.scan(85, 23);
      const paused = await createPostgresDiningQrJoinStore(transactions(), {
        scope,
        credentials,
        pepperVersion: 1,
        now,
        authorize: async () => true,
        audit: (record) => ({
          auditId: fresh(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: id(8) },
          actionCode: "DINING_QR_JOIN_PAUSE",
          targetType: "DiningTable",
          targetId: record.tableReference,
          reasonCode: "STAFF_TABLE_CONTROL",
          correlationId: record.operationReference,
          occurredAt: record.observedAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      }).setPaused({
        operationReference: fresh(),
        diningSessionReference: quietTable,
        paused: true,
        actorReference: id(8),
        observedAt: now(),
      });
      assert.equal(paused.status, "Applied");
      assert.equal(await asks(23), false);
      assert.deepEqual(
        await join.join(
          {
            sessionCredential: asked.sessionCredential,
            csrfCredential: asked.csrfCredential,
            operationReference: fresh(),
            newParty: true,
          },
          joinRequest,
        ),
        { status: "Refused", reason: "Paused" },
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT phase FROM rms_dining.dining_session WHERE table_id=$1 ORDER BY started_at",
            [id(23)],
          )
        ).rows,
        [{ phase: "Active" }],
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);

it("the question and the close are refused while a round is unfinished; a party still eating stays one Session; a paid event during a close doesn't deadlock", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_owed" }, async (context) => {
    const { admin, api, transactions, ownerRunner } = await setup(context);
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
      const asks = () => system.asksNewParty(session.tableReference);
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
      // Other facts hold a table the rule would otherwise free. Each is set up inside the attempt
      // only and rolled back, so the next starts from the same table.
      const withFacts = (before) => {
        const runner = () => ({
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN");
              await client.query(
                "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
                [ownerScope.brandReference, ownerScope.storeReference],
              );
              await before(client);
              await client.query("SET LOCAL ROLE " + api);
              return await work({
                query: (sql, values) => client.query(sql, [...(values ?? [])]),
              });
            } finally {
              await client.query("ROLLBACK").catch(() => undefined);
              await client.end();
            }
          },
        });
        runner.snapshot = runner;
        return runner;
      };
      const longAgo = new Date(base - minutes(119)).toISOString();
      const heldBy = async (before) =>
        closer(withFacts(before), ownerScope, now).closeQuiet(sessionReference);
      assert.deepEqual(
        await heldBy((client) =>
          client.query(
            "INSERT INTO rms_dining.dining_staff_call (tenant_id,brand_id,store_id,call_id,session_id,participant_id,reason,intent_hash,called_at) VALUES ($1,$2,$3,$4,$5,$6,'Question',$7,$8)",
            [
              ownerScope.tenantReference,
              ownerScope.brandReference,
              ownerScope.storeReference,
              fresh(),
              sessionReference,
              seeded.host.participantReference,
              digest("call"),
              longAgo,
            ],
          ),
        ),
        { status: "Held", hold: "StaffCall" },
      );
      const cartRound = journeyRound({
        at: new Date(Date.now() - minutes(1)).toISOString(),
        prefix: "01a00002",
      });
      assert.deepEqual(await heldBy((client) => seedSubmissionCart(client, cartRound.f)), {
        status: "Held",
        hold: "CartInUse",
      });
      // Another table was merged into this one: its people and its rounds are staff's to sort out.
      assert.deepEqual(
        await heldBy(async (client) => {
          const [source, sourceTable, operation] = [fresh(), fresh(), fresh()];
          // Test-only: the merged-away Session is synthetic, so its keys and checks are off here.
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(
            "INSERT INTO rms_dining.dining_session_merge_operation (operation_id,tenant_id,brand_id,store_id,source_session_id,target_session_id,source_table_id,target_table_id,expected_source_session_version,expected_target_session_version,expected_source_table_version,expected_target_table_version,source_party_size,target_party_size,merged_party_size,intent_digest,actor_id,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,1,1,1,1,2,$9,$10,$11,$12::jsonb)",
            [
              operation,
              ownerScope.tenantReference,
              ownerScope.brandReference,
              ownerScope.storeReference,
              source,
              sessionReference,
              sourceTable,
              session.tableReference,
              "sha256:" + digest("merge"),
              id(8),
              longAgo,
              JSON.stringify({
                sourceSession: { diningSessionReference: source, phase: "Closed", version: 2 },
                targetSession: {
                  diningSessionReference: sessionReference,
                  phase: "Active",
                  tableReference: session.tableReference,
                  version: 2,
                },
                sourceTable: {
                  tableReference: sourceTable,
                  stableLabel: "T2",
                  activeDiningSessionReference: null,
                  aggregateVersion: 2,
                },
                audit: {
                  actionCode: "DINING_SESSION_MERGE_TABLE",
                  targetId: source,
                  correlationId: operation,
                  actor: { type: "User", reference: id(8) },
                },
              }),
            ],
          );
          await client.query("SET LOCAL session_replication_role = origin");
        }),
        { status: "Held", hold: "Merged" },
      );

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

it("a phone scanning or tapping while the System closes that table isn't failed: it gets the free table", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gs_during" }, async (context) => {
    const { admin, transactions, credentials, opened } = await setup(context);
    try {
      await setSwitch(transactions, true);
      await seedTable(admin, 20);
      const previous = await startedAgo({ transactions, credentials }, 20, 25);
      const system = closer(transactions, scope, () => new Date().toISOString());
      const identity = guests();
      const join = composeJoin({ transactions, credentials, identity });
      const scan = () =>
        transactions().run((tx) =>
          loadDiningGuestTableStart(tx, owner, id(20), new Date().toISOString()),
        );
      // The close stops right after its fence took the table, until the phones are on their way.
      let holding, release;
      const held = new Promise((resolve) => (holding = resolve));
      const released = new Promise((resolve) => (release = resolve));
      let armed = true;
      opened.after = async (sql) => {
        if (armed && /FROM rms_dining\.dining_session\b[^;]*FOR UPDATE/su.test(sql)) {
          armed = false;
          holding();
          await released;
        }
      };
      const closing = system.closeQuiet(previous);
      await held;
      // The scan reads what is committed and waits for nothing.
      assert.equal((await scan()).kind, "No");
      const tapping = tap(join, identity.scan(85, 20));
      await delay(300);
      release();
      assert.equal((await closing).status, "Closed");
      assert.equal((await tapping).status, "Joined");
      opened.after = null;
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
    } finally {
      await admin.end();
    }
  });
}, 300_000);

it.each(["Unpaid", "Paying"])(
  "a round %s holds the table: nobody is asked, nothing closes, nothing is written",
  async (stage) => {
    await withIsolatedDatabase({ caseId: "wp2423_gs_" + stage.toLowerCase() }, async (context) => {
      const { admin, transactions, ownerRunner } = await setup(context);
      try {
        const base = Date.parse(
          (
            await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
          ).rows[0].at.toISOString(),
        );
        const { ownerScope, session, orderReference } = await seedPaidGuestTable(
          admin,
          transactions,
          { base, prefix: "01a00001", refsAt: 0x1000, ownerRunner, stage },
        );
        const system = closer(transactions, ownerScope, () => new Date().toISOString());
        const written = async () =>
          (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM rms_ordering.order_closure_version WHERE order_id=$1) AS closures,(SELECT count(*)::int FROM rms_payment.order_settled_finality WHERE order_id=$1) AS finalities,(SELECT count(*)::int FROM rms_dining.dining_item_service_record WHERE order_id=$1) AS served",
              [orderReference],
            )
          ).rows[0];
        const nothing = { closures: 0, finalities: 0, served: 0 };
        assert.equal(await system.asksNewParty(session.tableReference), false);
        assert.deepEqual(await system.closeQuiet(session.diningSessionReference), {
          status: "Held",
          hold: "Unfinished",
        });
        assert.deepEqual(await system.closeForNewParty(session.tableReference), {
          status: "Held",
          hold: "Unfinished",
        });
        assert.equal(await system.runOnce({ limit: 10 }), 0);
        assert.deepEqual(await written(), nothing);
        assert.equal(
          (
            await admin.query("SELECT phase FROM rms_dining.dining_session WHERE session_id=$1", [
              session.diningSessionReference,
            ])
          ).rows[0].phase,
          "Active",
        );
      } finally {
        await admin.end();
      }
    });
  },
  300_000,
);

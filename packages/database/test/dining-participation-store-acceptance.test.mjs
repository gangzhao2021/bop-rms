import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createDiningTable,
  transitionDiningTable,
  createDiningTableService,
  createDiningSessionService,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningParticipationStore,
  createDiningCartParticipationQuery,
  createPostgresDiningCartParticipationStore,
  createPostgresDiningGuestBindingStore,
} from "../../rms/dining/src/index.ts";
import {
  createDiningCartReadService,
  createPostgresDiningCartReadStore,
} from "../../rms/ordering/src/index.ts";
import { cartParticipation } from "../../../apps/api/src/customer-dining-cart-composition.ts";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902280-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("reads coherent current Dining participation without writing authority or history", async () => {
  await withIsolatedDatabase({ caseId: "wp2280_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2280_${context.runId}`;
    assert.match(role, /^wp2280_[a-f0-9]+$/u);
    let active = 0;
    let sequence = 1000;
    const audit = (action, target, instant) => ({
      auditId: id(++sequence),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(8) },
      actionCode: action,
      targetType: "DiningTable",
      targetId: target,
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: id(9),
      occurredAt: instant,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_dining,platform_audit,platform_helpers TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_table TO ${role}`);
      await admin.query(
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,rms_dining.dining_join_regeneration_operation,rms_dining.dining_participant,rms_dining.dining_identity_admission,rms_dining.dining_session_join_operation,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      await admin.query(
        `GRANT UPDATE ON rms_dining.dining_join_capability,rms_dining.dining_session TO ${role}`,
      );
      function runner({ readOnly = false, failAudit = false, loseAck = false } = {}) {
        return {
          async run(action) {
            const client = new Client({
              ...context.clientConfig,
              query_timeout: 5000,
              connectionTimeoutMillis: 2000,
            });
            await client.connect();
            active++;
            let committed = false;
            try {
              await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
              await client.query(`SET LOCAL ROLE ${role}`);
              await client.query("SET LOCAL lock_timeout='5s'");
              await client.query("SET LOCAL statement_timeout='5s'");
              const result = await action({
                query: async (sql, values) => {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              const cleared = await client.query(
                "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
              );
              assert(!cleared.rows[0].brand && !cleared.rows[0].store);
              if (loseAck) throw new Error("synthetic lost commit acknowledgement");
              return result;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
              active--;
            }
          },
        };
      }
      const credentials = {
        generateReference: () => id(++sequence),
        generateJoinCredential: () =>
          Buffer.alloc(16, (++sequence % 254) + 1).toString("base64url"),
        hashJoinCredential: (kind, value) =>
          createHmac("sha256", "synthetic-test-only-pepper")
            .update(`DiningJoin:${kind}:${value}`)
            .digest("hex"),
        hashOperationIntent: digest,
        equals: (a, b) => a === b,
      };
      const tableReader = createPostgresDiningTableStore(
        runner({ readOnly: true }),
        scope,
        tableReferences,
      );
      const tableWriter = createPostgresDiningTableStore(runner(), scope, tableReferences);
      const reader = createPostgresDiningSessionStartStore(
        runner({ readOnly: true }),
        scope,
        credentials,
      );
      const writer = createPostgresDiningSessionStartStore(runner(), scope, credentials);
      const tableService = createDiningTableService({
        references: tableReferences,
        authorization: {
          authorize: async (input) => ({
            ...scope,
            actorReference: id(8),
            purpose: "dining-table",
            permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
            audit: audit(
              `DINING_TABLE_${input.action.toUpperCase()}`,
              input.targetReference,
              input.observedAt,
            ),
          }),
        },
        repository: {
          ...tableWriter,
          loadSession: reader.loadSession,
          resolveMoveOperation: async () => null,
          commitMove: async () => {
            throw new Error("synthetic unconfigured Move");
          },
        },
      });
      async function configure(n) {
        const draft = createDiningTable({
          ...scope,
          tableReference: id(n),
          stableLabel: `T-${n}`,
          areaReference: id(10),
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle: "Draft",
          qrStatus: "Inactive",
          qrVersion: 0,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: null,
          aggregateVersion: 1,
          createdAt: at(0),
          observedAt: at(0),
        });
        await tableService.executeTable({
          action: "CreateDraft",
          operationReference: id(++sequence),
          candidate: draft,
          expectedAggregateVersion: null,
          observedAt: at(0),
        });
        const published = transitionDiningTable(draft, "Publish", at(0));
        await tableService.executeTable({
          action: "Publish",
          operationReference: id(++sequence),
          candidate: published,
          expectedAggregateVersion: 1,
          observedAt: at(0),
        });
        return published;
      }
      const brand = createBrand({
        brandReference: id(2),
        code: "DINING",
        displayName: "Synthetic Dining",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at(0),
        updatedAt: at(0),
      });
      const store = createStore({
        storeReference: id(3),
        brandReference: id(2),
        code: "DINING-1",
        displayName: "Synthetic Store",
        timeZone: "America/Toronto",
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at(0),
        updatedAt: at(0),
      });
      const regenerationReader = createPostgresDiningJoinRegenerationStore(
        runner({ readOnly: true }),
        scope,
        credentials,
      );
      const regenerationWriter = createPostgresDiningJoinRegenerationStore(
        runner(),
        scope,
        credentials,
      );
      const joinAudit = (descriptor) => ({
        ...audit("DINING_SESSION_JOIN", descriptor.diningSessionReference, descriptor.occurredAt),
        actor: { type: "System" },
        targetType: "DiningSession",
        reasonCode: "AUTHORIZED_DINING_JOIN",
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
      });
      const joinReader = createPostgresDiningSessionJoinStore(
        runner({ readOnly: true }),
        scope,
        credentials,
        joinAudit,
      );
      const joinWriter = createPostgresDiningSessionJoinStore(
        runner(),
        scope,
        credentials,
        joinAudit,
      );
      function service(selectedWriter = joinWriter, beforeWrite = async () => undefined) {
        return createDiningSessionService({
          pepperVersion: 1,
          credentials,
          staff: {
            async authorize(input) {
              const table = await tableReader.loadTable(input.tableReference);
              if (table === null) return null;
              const session =
                table.activeDiningSessionReference === null
                  ? null
                  : await reader.loadSession(table.activeDiningSessionReference);
              return {
                tenantContext: createTenantContext(
                  {
                    actorType: "User",
                    actorReference: id(8),
                    accountKind: "Workforce",
                    status: "Active",
                    authenticationMethod: "Oidc",
                    verificationLevel: "SingleFactor",
                    authenticatedAt: input.observedAt,
                    recentMfaAt: null,
                  },
                  brand,
                  store,
                  input.observedAt,
                ),
                permission: Object.freeze({
                  effect: "Allow",
                  scopeKind: "Store",
                  action: "dining.session.manage",
                }),
                table: {
                  brandReference: id(2),
                  storeReference: id(3),
                  tableReference: table.tableReference,
                  assignmentVersion: session?.tableAssignmentVersion ?? table.aggregateVersion,
                  tableState:
                    table.lifecycle === "Published" && table.operationalState === "Available"
                      ? "Eligible"
                      : "Unavailable",
                  activeDiningSessionReference: table.activeDiningSessionReference,
                  observedAt: input.observedAt,
                },
                audit: audit(
                  input.operation === "StartSession"
                    ? "DINING_SESSION_START"
                    : "DINING_JOIN_CREDENTIAL_REGENERATE",
                  input.tableReference,
                  input.observedAt,
                ),
              };
            },
          },
          guests: {
            resolve: async (input) => ({
              guestSessionReference: input.guestSessionReference,
              diningState: "ContextOnly",
              channel: "DineIn",
              storeReference: id(3),
              tableReference: id(20),
              observedAt: input.observedAt,
            }),
          },
          abuse: { admit: async () => "Admitted" },
          store: {
            ...reader,
            start: writer.start,
            ...regenerationReader,
            ...joinReader,
            regenerate: regenerationWriter.regenerate,
            join: async (input) => {
              await beforeWrite();
              return selectedWriter.join(input);
            },
          },
        });
      }
      const command = (table, operation) => ({
        tableReference: id(table),
        expectedAssignmentVersion: 2,
        operationReference: id(operation),
        joinKind: "Invitation",
        requestedAt: at(1),
      });
      let nowValue = at(3);
      const participation = createPostgresDiningParticipationStore(
        runner({ readOnly: true }),
        scope,
      );
      const query = createDiningCartParticipationQuery({
        scope: { brandReference: id(2), storeReference: id(3) },
        repository: participation,
        now: () => nowValue,
      });
      await configure(20);
      const started = await service().start(command(20, 30));
      const sessionId = started.session.diningSessionReference;
      const resolve = (participant, session = sessionId) =>
        query.resolve({
          purpose: "Cart",
          diningSessionReference: session,
          participantReference: participant,
        });
      assert.equal(await resolve(id(999)), null);
      const joined = await service().join({
        guestSessionReference: id(80),
        joinCredential: started.joinCredential,
        expectedSessionVersion: 1,
        expectedCapabilityVersion: 1,
        operationReference: id(40),
        requestedAt: at(2),
      });
      assert.equal(joined.status, "Joined");
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_session) AS sessions,
        (SELECT count(*)::integer FROM rms_dining.dining_participant) AS participants,
        (SELECT count(*)::integer FROM rms_dining.dining_identity_admission) AS admissions,
        (SELECT count(*)::integer FROM rms_dining.dining_session_join_operation) AS joins,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const before = await counts();
      const initial = await resolve(joined.participant.participantReference);
      assert.deepEqual(initial, {
        schemaVersion: 1,
        brandReference: id(2),
        storeReference: id(3),
        diningSessionReference: sessionId,
        participantReference: joined.participant.participantReference,
        tableReference: id(20),
        tableAssignmentVersion: 2,
        diningSessionVersion: 2,
        participantVersion: 1,
        observedAt: at(3),
      });
      assert(Object.isFrozen(initial));
      assert.equal((await tableReader.loadTable(id(20))).aggregateVersion, 3);
      assert.equal(await resolve(id(999)), null);
      assert.equal(await resolve(joined.participant.participantReference, id(999)), null);
      assert.deepEqual(await counts(), before);
      const regenerated = await service().regenerate({
        diningSessionReference: sessionId,
        tableReference: id(20),
        expectedAssignmentVersion: 2,
        expectedSessionVersion: 2,
        expectedCapabilityVersion: 2,
        expectedGeneration: 1,
        operationReference: id(41),
        requestedAt: at(3),
      });
      const second = await service().join({
        guestSessionReference: id(81),
        joinCredential: regenerated.joinCredential,
        expectedSessionVersion: 2,
        expectedCapabilityVersion: 1,
        operationReference: id(42),
        requestedAt: at(4),
      });
      assert.equal(second.status, "Joined");
      nowValue = at(5);
      const afterJoins = await counts();
      const firstCurrent = await resolve(joined.participant.participantReference),
        secondCurrent = await resolve(second.participant.participantReference);
      assert.equal(firstCurrent.diningSessionVersion, 3);
      assert.equal(firstCurrent.participantReference, initial.participantReference);
      assert.equal(secondCurrent.diningSessionVersion, 3);
      assert.equal(secondCurrent.participantVersion, 1);
      assert.notEqual(firstCurrent.participantReference, secondCurrent.participantReference);
      assert.deepEqual(await counts(), afterJoins);
      const other = createDiningCartParticipationQuery({
        scope: { brandReference: id(2), storeReference: id(90) },
        repository: createPostgresDiningParticipationStore(runner({ readOnly: true }), {
          ...scope,
          storeReference: id(90),
        }),
        now: () => at(5),
      });
      assert.equal(
        await other.resolve({
          purpose: "Cart",
          diningSessionReference: sessionId,
          participantReference: joined.participant.participantReference,
        }),
        null,
      );
      await runner({ readOnly: true }).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(90)],
        );
        assert.equal(
          (await tx.query("SELECT participant_id FROM rms_dining.dining_participant", [])).rows
            .length,
          0,
        );
      });
      // Synthetic owner-state transitions test read denial, not Leave/Closing command implementation.
      const table = await tableReader.loadTable(id(20));
      const blocked = {
        ...table,
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "MAINTENANCE",
        aggregateVersion: 4,
        observedAt: at(6),
      };
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=4,table_snapshot=$2::jsonb,observed_at=$3 WHERE table_id=$1",
        [id(20), JSON.stringify(blocked), at(6)],
      );
      nowValue = at(6);
      assert.equal(await resolve(joined.participant.participantReference), null);
      const available = {
        ...blocked,
        operationalState: "Available",
        blockReasonCode: null,
        aggregateVersion: 5,
        observedAt: at(7),
      };
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=5,table_snapshot=$2::jsonb,observed_at=$3 WHERE table_id=$1",
        [id(20), JSON.stringify(available), at(7)],
      );
      assert.equal(await resolve(joined.participant.participantReference), null); // mutation is newer than observation
      nowValue = at(7);
      assert.equal(
        (await resolve(joined.participant.participantReference)).tableAssignmentVersion,
        2,
      );
      const left = { ...joined.participant, status: "Left", version: 2, leftAt: at(8) };
      await admin.query(
        "UPDATE rms_dining.dining_participant SET version=2,status='Left',participant_snapshot=$2::jsonb WHERE participant_id=$1",
        [left.participantReference, JSON.stringify(left)],
      );
      nowValue = at(8);
      assert.equal(await resolve(joined.participant.participantReference), null);
      // M126 I.2: the guest cart's own read (the pilot's) says the phone left, or staff removed
      // it, rather than that its visit expired.
      await assert.rejects(
        createDiningCartParticipationQuery({
          scope: { brandReference: id(2), storeReference: id(3) },
          repository: createPostgresDiningCartParticipationStore(runner({ readOnly: true }), scope),
          now: () => nowValue,
        }).resolve({
          purpose: "Cart",
          diningSessionReference: sessionId,
          participantReference: joined.participant.participantReference,
        }),
        { name: "DiningParticipationEndedError", reason: "Left" },
      );
      // WP-2423 (same-table-ordering): Dining's recorded departures, read as the restricted pilot
      // API role (rendered pilot ACL, NOBYPASSRLS): the removed phone is Left, the other is still
      // Present, each with the current QR of the table it joined at; an unknown participant is left
      // out; another Store's scope is refused and sees no rows. Nothing is written.
      const pilot = `wp2423_dep_${context.runId}`;
      await admin.query(
        `CREATE ROLE ${pilot} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await grantPilotApiAcl(admin, pilot);
      const pilotRunner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${pilot}`);
            const result = await action({
              query: (sql, values) => client.query(sql, [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const beforeDepartures = await counts();
      const departures = createPostgresDiningGuestBindingStore(pilotRunner, scope);
      const joinedTable = await tableReader.loadTable(id(20));
      const facts = await departures.readDepartures({
        brandReference: id(2),
        storeReference: id(3),
        diningSessionReference: sessionId,
        participantReferences: [
          joined.participant.participantReference,
          second.participant.participantReference,
          id(999),
        ],
      });
      assert.deepEqual(
        [...facts].sort((a, b) => a.participantReference.localeCompare(b.participantReference)),
        [
          {
            participantReference: joined.participant.participantReference,
            departure: "Left",
            joinedTableQr: {
              version: joinedTable.qrVersion,
              active: joinedTable.qrStatus === "Active",
            },
          },
          {
            participantReference: second.participant.participantReference,
            departure: "Present",
            joinedTableQr: {
              version: joinedTable.qrVersion,
              active: joinedTable.qrStatus === "Active",
            },
          },
        ].sort((a, b) => a.participantReference.localeCompare(b.participantReference)),
      );
      await assert.rejects(
        departures.readDepartures({
          brandReference: id(2),
          storeReference: id(90),
          diningSessionReference: sessionId,
          participantReferences: [second.participant.participantReference],
        }),
      );
      assert.deepEqual(
        await createPostgresDiningGuestBindingStore(pilotRunner, {
          ...scope,
          storeReference: id(90),
        }).readDepartures({
          brandReference: id(2),
          storeReference: id(90),
          diningSessionReference: sessionId,
          participantReferences: [second.participant.participantReference],
        }),
        [],
      );
      assert.deepEqual(await counts(), beforeDepartures);
      assert.equal(
        (await resolve(second.participant.participantReference)).participantReference,
        second.participant.participantReference,
      );
      const current = await reader.loadSession(sessionId);
      await admin.query(
        "UPDATE rms_dining.dining_session SET version=4,phase='Closing',session_snapshot=$2::jsonb WHERE session_id=$1",
        [sessionId, JSON.stringify({ ...current, phase: "Closing", version: 4 })],
      );
      nowValue = at(9);
      assert.equal(await resolve(second.participant.participantReference), null);
      assert.deepEqual(await counts(), afterJoins);
      // Batch 65 (v15 b64 live, guest-split-own-payment): a guest's Cart opened or reloaded after
      // staff pressed Start checkout named no unsent dish: its read was refused (409) like a change.
      // Read as the restricted pilot API role (rendered pilot ACL, NOBYPASSRLS, read-only): Dining's
      // own cart participation still refuses every change ("Cart") of the table checking out, and
      // lets the Cart be read ("CartView", tableCheckingOut). Ordering's read of the table's Cart
      // then gives its lines as they are, only when asked to read at checkout. Nothing is written.
      const pilotCart = createDiningCartParticipationQuery({
        scope: { brandReference: id(2), storeReference: id(3) },
        repository: createPostgresDiningCartParticipationStore(pilotRunner, scope),
        now: () => nowValue,
      });
      const seat = {
        diningSessionReference: sessionId,
        participantReference: second.participant.participantReference,
      };
      await assert.rejects(pilotCart.resolve({ purpose: "Cart", ...seat }), {
        name: "DiningTableCheckingOutError",
      });
      assert.deepEqual(await pilotCart.resolve({ purpose: "CartView", ...seat }), {
        schemaVersion: 1,
        brandReference: id(2),
        storeReference: id(3),
        ...seat,
        tableReference: id(20),
        tableAssignmentVersion: 2,
        diningSessionVersion: 4,
        participantVersion: 1,
        observedAt: at(9),
        tableCheckingOut: true,
      });
      // The table's Cart, as two phones left it: one Beef noodles each, neither sent.
      await admin.query(
        `INSERT INTO rms_ordering.cart(cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
        VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6,'Active',$7,$8,7200,86400,$9,$10)`,
        [
          id(600),
          id(2),
          id(3),
          sessionId,
          id(80),
          at(8),
          id(601),
          `sha256:${"a".repeat(64)}`,
          "2026-09-09T12:00:00.000Z",
          "2026-09-10T09:00:00.000Z",
        ],
      );
      for (const [line, actor, participant] of [
        [602, 80, joined.participant.participantReference],
        [603, 81, second.participant.participantReference],
      ])
        await admin.query(
          `INSERT INTO rms_ordering.cart_line(cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at) VALUES($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8)`,
          [id(line), id(600), id(2), id(3), id(604), id(actor), participant, at(8)],
        );
      const cartRows = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::integer FROM rms_ordering.cart) AS carts,(SELECT count(*)::integer FROM rms_ordering.cart_line) AS lines,(SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1) AS version",
            [id(600)],
          )
        ).rows[0];
      const beforeReads = { dining: await counts(), cart: await cartRows() };
      // Identity's Guest Session is a bounded synthetic fixture (its lifetimes as Identity's own).
      const cartReads = createDiningCartReadService({
        scope: { brandReference: id(2), storeReference: id(3) },
        now: () => nowValue,
        carts: createPostgresDiningCartReadStore(pilotRunner, {
          brandReference: id(2),
          storeReference: id(3),
        }),
        participation: cartParticipation(pilotCart),
        sessions: {
          resolve: async () => ({
            sessionReference: id(81),
            status: "Active",
            version: 1,
            brandReference: id(2),
            storeReference: id(3),
            publicStoreReference: id(82),
            publicTableReference: id(83),
            channel: "DineIn",
            locale: "en-CA",
            qrReference: id(84),
            qrRevocationVersion: 1,
            diningState: "DiningBound",
            diningSessionReference: sessionId,
            diningParticipantReference: second.participant.participantReference,
            createdAt: at(1),
            lastSeenAt: at(8),
            idleExpiresAt: "2026-09-09T13:08:00.000Z",
            absoluteExpiresAt: "2026-09-10T09:01:00.000Z",
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          }),
        },
      });
      const credential = { sessionCredential: "b".repeat(43) };
      await assert.rejects(cartReads.read(credential), { code: "CART_TABLE_CHECKING_OUT" });
      const atCheckout = await cartReads.read(credential, { atCheckout: true });
      assert.equal(atCheckout.tableCheckingOut, true);
      assert.equal(atCheckout.cart.cartReference, id(600));
      assert.deepEqual(
        atCheckout.cart.items.map((item) => [
          item.cartItemReference,
          item.quantity,
          item.addedByParticipantReference,
        ]),
        [
          [id(602), 1, joined.participant.participantReference],
          [id(603), 1, second.participant.participantReference],
        ],
      );
      assert.equal(atCheckout.viewer.participantReference, second.participant.participantReference);
      // Read-only: no Dining or Cart row was added or changed, and the pilot role can't write it.
      assert.deepEqual({ dining: await counts(), cart: await cartRows() }, beforeReads);
      await assert.rejects(
        pilotRunner.run((tx) =>
          tx.query("UPDATE rms_ordering.cart SET aggregate_version=2 WHERE cart_id=$1", [id(600)]),
        ),
        (error) => ["25006", "42501"].includes(error.code),
      );
      // Staff cancel checkout: the same read says nothing of checkout, and changes are allowed again.
      const closing = await reader.loadSession(sessionId);
      await admin.query(
        "UPDATE rms_dining.dining_session SET version=5,phase='Active',session_snapshot=$2::jsonb WHERE session_id=$1",
        [sessionId, JSON.stringify({ ...closing, phase: "Active", version: 5 })],
      );
      const reopened = await cartReads.read(credential, { atCheckout: true });
      assert.equal(Object.hasOwn(reopened, "tableCheckingOut"), false);
      assert.equal((await pilotCart.resolve({ purpose: "Cart", ...seat })).diningSessionVersion, 5);
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

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
} from "../../rms/dining/src/index.ts";
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
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

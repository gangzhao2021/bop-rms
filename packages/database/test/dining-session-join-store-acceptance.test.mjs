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
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902278-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("consumes Join credentials and creates Participant, Host and admission atomically", async () => {
  await withIsolatedDatabase({ caseId: "wp2278_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2278_${context.runId}`;
    assert.match(role, /^wp2278_[a-f0-9]+$/u);
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
      const counts = async () =>
        (
          await admin.query(`SELECT
       (SELECT count(*)::integer FROM rms_dining.dining_participant) AS participants,
       (SELECT count(*)::integer FROM rms_dining.dining_identity_admission) AS admissions,
       (SELECT count(*)::integer FROM rms_dining.dining_session_join_operation) AS operations,
       (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_JOIN') AS audits`)
        ).rows[0];
      const equalCounts = (n) => ({ participants: n, admissions: n, operations: n, audits: n });
      await configure(20);
      const started = await service().start(command(20, 30));
      assert.equal(started.status, "Issued");
      const sessionId = started.session.diningSessionReference;
      const joinCommand = (credential, guest, operation, version, minute) => ({
        guestSessionReference: id(guest),
        joinCredential: credential,
        expectedSessionVersion: version,
        expectedCapabilityVersion: 1,
        operationReference: id(operation),
        requestedAt: at(minute),
      });
      const first = joinCommand(started.joinCredential, 80, 40, 1, 2);
      const joined = await service().join(first);
      assert.equal(joined.status, "Joined");
      assert.equal(
        joined.session.hostParticipantReference,
        joined.participant.participantReference,
      );
      assert.equal(joined.session.version, 2);
      assert.deepEqual(await counts(), equalCounts(1));
      assert.equal((await service().join(first)).status, "AlreadyApplied");
      assert.equal(
        (await service().join({ ...first, operationReference: id(90) })).status,
        "DiningJoinUnavailable",
      );
      const original = await joinReader.resolveJoinOperation(id(40));
      assert.equal(original.capability.status, "Consumed");
      assert.equal(original.admission.status, "Active");
      const regenerate = async (operation, minute) => {
        const state = await regenerationReader.resolveActiveJoin(sessionId);
        return service().regenerate({
          diningSessionReference: sessionId,
          tableReference: id(20),
          expectedAssignmentVersion: 2,
          expectedSessionVersion: state.session.version,
          expectedCapabilityVersion: state.capability.version,
          operationReference: id(operation),
          requestedAt: at(minute),
        });
      };
      const secondCredential = await regenerate(41, 3);
      assert.equal(secondCredential.status, "Issued");
      const second = await service().join(
        joinCommand(secondCredential.joinCredential, 81, 42, 2, 4),
      );
      assert.equal(second.status, "Joined");
      assert.equal(
        second.session.hostParticipantReference,
        joined.participant.participantReference,
      );
      assert.notEqual(
        second.participant.participantReference,
        joined.participant.participantReference,
      );
      assert.equal(second.session.version, 3);
      assert.deepEqual(await counts(), equalCounts(2));
      assert.deepEqual(await joinReader.resolveJoinOperation(id(40)), original);
      assert.equal((await service().join(first)).status, "AlreadyApplied");
      const thirdCredential = await regenerate(43, 5);
      const third = joinCommand(thirdCredential.joinCredential, 82, 45, 3, 6);
      await assert.rejects(
        service().join({ ...third, guestSessionReference: id(80), operationReference: id(44) }),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      const before = await regenerationReader.resolveActiveJoin(sessionId);
      const broken = createPostgresDiningSessionJoinStore(
        runner({ failAudit: true }),
        scope,
        credentials,
        joinAudit,
      );
      await assert.rejects(
        service(broken).join(third),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await regenerationReader.resolveActiveJoin(sessionId), before);
      assert.deepEqual(await counts(), equalCounts(2));
      const readonly = createPostgresDiningSessionJoinStore(
        runner({ readOnly: true }),
        scope,
        credentials,
        joinAudit,
      );
      await assert.rejects(
        service(readonly).join(third),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      const lost = createPostgresDiningSessionJoinStore(
        runner({ loseAck: true }),
        scope,
        credentials,
        joinAudit,
      );
      await assert.rejects(
        service(lost).join(third),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal((await service().join(third)).status, "AlreadyApplied");
      assert.deepEqual(await counts(), equalCounts(3));
      function barrier() {
        let arrived = 0;
        let release;
        const ready = new Promise((resolve) => {
          release = resolve;
        });
        return async () => {
          if (++arrived === 2) release();
          await ready;
        };
      }
      const fourthCredential = await regenerate(50, 7);
      const fourth = joinCommand(fourthCredential.joinCredential, 83, 51, 4, 8);
      let wait = barrier();
      const same = await Promise.all([
        service(joinWriter, wait).join(fourth),
        service(joinWriter, wait).join(fourth),
      ]);
      assert.deepEqual(same.map((x) => x.status).sort(), ["AlreadyApplied", "Joined"]);
      assert.deepEqual(await counts(), equalCounts(4));
      const fifthCredential = await regenerate(52, 9);
      wait = barrier();
      const competition = await Promise.allSettled([
        service(joinWriter, wait).join(joinCommand(fifthCredential.joinCredential, 84, 53, 5, 10)),
        service(joinWriter, wait).join(joinCommand(fifthCredential.joinCredential, 85, 54, 5, 10)),
      ]);
      assert.equal(competition.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        competition.find((x) => x.status === "rejected").reason.code,
        "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), equalCounts(5));
      const sixthCredential = await regenerate(55, 11);
      const sixth = joinCommand(sixthCredential.joinCredential, 86, 56, 6, 12);
      const beforeFences = await regenerationReader.resolveActiveJoin(sessionId);
      await assert.rejects(
        service(joinWriter, async () => {
          const table = await tableReader.loadTable(id(20));
          const blocked = {
            ...table,
            operationalState: "TemporarilyBlocked",
            blockReasonCode: "MAINTENANCE",
            aggregateVersion: table.aggregateVersion + 1,
            observedAt: at(12),
          };
          await admin.query(
            "UPDATE rms_dining.dining_table SET version=$2,table_snapshot=$3::jsonb,observed_at=$4 WHERE table_id=$1",
            [id(20), blocked.aggregateVersion, JSON.stringify(blocked), at(12)],
          );
        }).join(sixth),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      const blocked = await tableReader.loadTable(id(20));
      const available = {
        ...blocked,
        operationalState: "Available",
        blockReasonCode: null,
        aggregateVersion: blocked.aggregateVersion + 1,
      };
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=$2,table_snapshot=$3::jsonb WHERE table_id=$1",
        [id(20), available.aggregateVersion, JSON.stringify(available)],
      );
      assert.deepEqual(await regenerationReader.resolveActiveJoin(sessionId), beforeFences);
      await assert.rejects(
        service(joinWriter, async () => {
          const session = await reader.loadSession(sessionId);
          await admin.query(
            "UPDATE rms_dining.dining_session SET version=7,phase='Closing',session_snapshot=$2::jsonb WHERE session_id=$1",
            [sessionId, JSON.stringify({ ...session, phase: "Closing", version: 7 })],
          );
        }).join(sixth),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.equal(
        await joinReader.resolveJoinState(
          credentials.hashJoinCredential("Invitation", sixthCredential.joinCredential),
        ),
        null,
      );
      assert.deepEqual(await counts(), equalCounts(5));
      const foreign = createPostgresDiningSessionJoinStore(
        runner({ readOnly: true }),
        { ...scope, storeReference: id(99) },
        credentials,
        joinAudit,
      );
      assert.equal(await foreign.resolveJoinOperation(id(40)), null);
      for (const table of [
        "dining_participant",
        "dining_identity_admission",
        "dining_session_join_operation",
      ]) {
        assert.equal((await admin.query(`DELETE FROM rms_dining.${table}`)).rowCount, 0);
        await runner({ readOnly: true }).run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(99)],
          );
          assert.equal((await tx.query(`SELECT * FROM rms_dining.${table}`, [])).rows.length, 0);
        });
      }
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_session_join_operation SET intent_hash=repeat('b',64)",
          )
        ).rowCount,
        0,
      );
      const raw = {
        ...original,
        operationReference: id(95),
        admission: { ...original.admission, operationReference: id(95) },
        capability: { ...original.capability, rawCredential: "synthetic-forbidden" },
      };
      const insert =
        "INSERT INTO rms_dining.dining_session_join_operation (operation_id,tenant_id,brand_id,store_id,session_id,guest_session_id,participant_id,admission_id,capability_id,intent_hash,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)";
      const values = [
        id(95),
        id(1),
        id(2),
        id(3),
        sessionId,
        id(80),
        original.participant.participantReference,
        original.admission.admissionReference,
        original.capability.capabilityReference,
        original.operationIntentHash,
        JSON.stringify(raw),
      ];
      await assert.rejects(admin.query(insert, values), (e) => e.code === "23514");
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(99)],
          );
          await tx.query(insert, [
            ...values.slice(0, -1),
            JSON.stringify({
              ...original,
              operationReference: id(95),
              admission: { ...original.admission, operationReference: id(95) },
            }),
          ]);
        }),
        (e) => e.code === "42501",
      );
      for (const [table, column, snapshot, identifier] of [
        ["dining_participant", "participant_snapshot", original.participant, "participant_id"],
        ["dining_identity_admission", "admission_snapshot", original.admission, "admission_id"],
      ]) {
        const isParticipant = table === "dining_participant";
        const reference = isParticipant
          ? snapshot.participantReference
          : snapshot.admissionReference;
        const columns = isParticipant ? "" : ",participant_id";
        const placeholder = isParticipant ? "" : ",$7";
        const sql = `INSERT INTO rms_dining.${table} (${identifier},tenant_id,brand_id,store_id,session_id,version,status,${column}${columns}) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb${placeholder})`;
        const parameters = [
          reference,
          id(1),
          id(2),
          id(3),
          sessionId,
          JSON.stringify({ ...snapshot, rawCredential: "synthetic-forbidden" }),
          ...(isParticipant ? [] : [original.participant.participantReference]),
        ];
        await assert.rejects(admin.query(sql, parameters), (e) => e.code === "23514");
        await assert.rejects(
          runner().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(2), id(99)],
            );
            await tx.query(
              sql,
              parameters.map((x, i) => (i === 5 ? JSON.stringify(snapshot) : x)),
            );
          }),
          (e) => e.code === "42501",
        );
      }
      // Synthetic selector collision: never choose an arbitrary matching generation.
      await configure(21);
      const ambiguousStart = await service().start(command(21, 97));
      const duplicate = {
        ...ambiguousStart.capability,
        capabilityReference: id(98),
        generation: 2,
        status: "Consumed",
        version: 2,
        consumedAt: at(1),
      };
      await admin.query(
        "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,2,'Consumed',$6::jsonb)",
        [
          id(98),
          id(1),
          id(2),
          id(3),
          ambiguousStart.session.diningSessionReference,
          JSON.stringify(duplicate),
        ],
      );
      assert.equal(await joinReader.resolveJoinState(duplicate.selectorHash), null);
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

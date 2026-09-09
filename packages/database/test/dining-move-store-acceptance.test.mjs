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
  createPostgresDiningClosingStore,
  createDiningClosingService,
  createPostgresDiningSessionMoveStore,
  createPostgresDiningParticipationStore,
  createDiningCartParticipationQuery,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902284-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("moves Dining Session and both Tables atomically with original commit receipts", async () => {
  await withIsolatedDatabase({ caseId: "wp2284_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2284_${context.runId}`;
    assert.match(role, /^wp2284_[a-f0-9]+$/u);
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,rms_dining.dining_join_regeneration_operation,rms_dining.dining_participant,rms_dining.dining_identity_admission,rms_dining.dining_session_join_operation,rms_dining.dining_closing_operation,rms_dining.dining_session_move_operation,platform_audit.audit_record TO ${role}`,
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
            audit: {
              ...audit(
                input.action === "MoveSession"
                  ? "DINING_SESSION_MOVE_TABLE"
                  : `DINING_TABLE_${input.action.toUpperCase()}`,
                input.targetReference,
                input.observedAt,
              ),
              targetType: input.action === "MoveSession" ? "DiningSession" : "DiningTable",
            },
          }),
        },
        repository: {
          ...tableWriter,
          loadSession: reader.loadSession,
          resolveMoveOperation: (operation) => moveReader.resolveMoveOperation(operation),
          commitMove: async (record) => {
            await beforeMove();
            return selectedMoveWriter.commitMove(record);
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
      await configure(20);
      const started = await service().start(command(20, 30));
      const sessionId = started.session.diningSessionReference;
      const joined = await service().join({
        guestSessionReference: id(80),
        joinCredential: started.joinCredential,
        expectedSessionVersion: 1,
        expectedCapabilityVersion: 1,
        operationReference: id(40),
        requestedAt: at(2),
      });
      const hashes = { hashIntent: digest, equals: (left, right) => left === right };
      const closingReader = createPostgresDiningClosingStore(
        runner({ readOnly: true }),
        scope,
        hashes,
      );
      const closingWriter = createPostgresDiningClosingStore(runner(), scope, hashes);
      const moveReader = createPostgresDiningSessionMoveStore(
        runner({ readOnly: true }),
        scope,
        tableReferences,
      );
      const moveWriter = createPostgresDiningSessionMoveStore(runner(), scope, tableReferences);
      let selectedMoveWriter = moveWriter;
      let beforeMove = async () => undefined;
      await configure(21);
      await configure(22);
      await configure(23);
      await configure(24);
      await configure(25);
      const moveRequest = async (
        source,
        target,
        operation,
        minute = 3,
        selectedSession = sessionId,
      ) => {
        const current = await reader.loadSession(selectedSession);
        return {
          operationReference: id(operation),
          diningSessionReference: selectedSession,
          sourceTableReference: id(source),
          targetTableReference: id(target),
          expectedSessionVersion: current.version,
          expectedSourceTableVersion: (await tableReader.loadTable(id(source))).aggregateVersion,
          expectedTargetTableVersion: (await tableReader.loadTable(id(target))).aggregateVersion,
          partySize: 2,
          observedAt: at(minute),
        };
      };
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_session_move_operation) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_MOVE_TABLE') AS audits`)
        ).rows[0];
      const first = await moveRequest(20, 21, 90);
      const sameOperation = await Promise.all([
        tableService.moveSession(first),
        tableService.moveSession(first),
      ]);
      assert(sameOperation.every((value) => value.result.session.tableReference === id(21)));
      assert.equal(sameOperation[0].result.audit.auditId, sameOperation[1].result.audit.auditId);
      assert.deepEqual(await counts(), { operations: 1, audits: 1 });
      assert.equal((await tableReader.loadTable(id(20))).activeDiningSessionReference, null);
      assert.equal((await tableReader.loadTable(id(21))).activeDiningSessionReference, sessionId);
      assert.equal((await reader.loadSession(sessionId)).version, 3);
      assert.equal(first.expectedSourceTableVersion, 3);
      assert.equal(joined.session.tableAssignmentVersion, 2);
      const participation = createDiningCartParticipationQuery({
        scope: { brandReference: id(2), storeReference: id(3) },
        repository: createPostgresDiningParticipationStore(runner({ readOnly: true }), scope),
        now: () => at(4),
      });
      const participantInput = {
        purpose: "Cart",
        diningSessionReference: sessionId,
        participantReference: joined.participant.participantReference,
      };
      const currentParticipant = await participation.resolve(participantInput);
      assert.equal(currentParticipant.tableReference, id(21));
      assert.equal(currentParticipant.tableAssignmentVersion, 3);
      assert.equal(
        currentParticipant.participantReference,
        joined.participant.participantReference,
      );
      await assert.rejects(
        service().regenerate({
          diningSessionReference: sessionId,
          tableReference: id(21),
          expectedAssignmentVersion: 3,
          expectedSessionVersion: 3,
          expectedCapabilityVersion: 2,
          operationReference: id(89),
          requestedAt: at(4),
        }),
        { code: "DINING_SESSION_UNAVAILABLE" },
      );
      await tableService.moveSession(await moveRequest(21, 20, 91, 4));
      const original = await tableService.moveSession(first);
      assert.equal(original.status, "AlreadyApplied");
      assert.equal(original.result.audit.auditId, sameOperation[0].result.audit.auditId);
      const competitorRequests = await Promise.all([
        moveRequest(20, 21, 92, 5),
        moveRequest(20, 22, 93, 5),
      ]);
      const competitors = await Promise.allSettled(
        competitorRequests.map((value) => tableService.moveSession(value)),
      );
      assert.equal(competitors.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(
        competitors.find((value) => value.status === "rejected").reason.code,
        "DINING_TABLE_VERSION_CONFLICT",
      );
      const winner = competitors.find((value) => value.status === "fulfilled").value.result;
      const sourceNumber = winner.targetTable.tableReference === id(21) ? 21 : 22;
      const snapshot = async () => ({
        session: await reader.loadSession(sessionId),
        source: await tableReader.loadTable(id(sourceNumber)),
        target: await tableReader.loadTable(id(20)),
        counts: await counts(),
      });
      const beforeFailed = await snapshot();
      await assert.rejects(tableService.moveSession(await moveRequest(sourceNumber, 20, 87, 2)), {
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await snapshot(), beforeFailed);
      assert.equal(await moveReader.resolveMoveOperation(id(87)), null);
      selectedMoveWriter = createPostgresDiningSessionMoveStore(
        runner({ failAudit: true }),
        scope,
        tableReferences,
      );
      await assert.rejects(tableService.moveSession(await moveRequest(sourceNumber, 20, 94, 6)), {
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await snapshot(), beforeFailed);
      assert.equal(await moveReader.resolveMoveOperation(id(94)), null);
      selectedMoveWriter = createPostgresDiningSessionMoveStore(
        runner({ loseAck: true }),
        scope,
        tableReferences,
      );
      const lostRequest = await moveRequest(sourceNumber, 20, 95, 6);
      await assert.rejects(tableService.moveSession(lostRequest), {
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      });
      selectedMoveWriter = moveWriter;
      const recovered = await tableService.moveSession(lostRequest);
      assert.equal(recovered.status, "AlreadyApplied");
      assert.equal(recovered.result.session.tableReference, id(20));
      assert.equal(recovered.result.session.version, 6);
      const beforeReadOnly = await snapshot();
      selectedMoveWriter = moveReader;
      await assert.rejects(tableService.moveSession(await moveRequest(20, 21, 96, 7)), {
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await snapshot(), beforeReadOnly);
      selectedMoveWriter = moveWriter;
      const another = await service().start(command(23, 70));
      await assert.rejects(tableService.moveSession(await moveRequest(20, 23, 97, 7)), {
        code: "DINING_TABLE_LIFECYCLE_CONFLICT",
      });
      const targetRequests = await Promise.all([
        moveRequest(20, 24, 98, 7),
        moveRequest(23, 24, 99, 7, another.session.diningSessionReference),
      ]);
      const targetRace = await Promise.allSettled(
        targetRequests.map((value) => tableService.moveSession(value)),
      );
      assert.equal(targetRace.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(
        targetRace.find((value) => value.status === "rejected").reason.code,
        "DINING_TABLE_VERSION_CONFLICT",
      );
      const current = await reader.loadSession(sessionId);
      const currentTableNumber = current.tableReference === id(20) ? 20 : 24;
      const closingService = createDiningClosingService({
        store: {
          load: closingReader.load,
          resolveOperation: closingReader.resolveOperation,
          commit: closingWriter.commit,
        },
        hashes,
        authorization: {
          authorize: async (input) => ({
            kind: "Host",
            guestSessionReference: id(80),
            participantReference: joined.participant.participantReference,
            diningSessionReference: sessionId,
            storeReference: id(3),
            status: "CurrentHost",
            observedAt: input.observedAt,
            audit: {
              ...audit("DINING_SESSION_CLOSING_BEGIN", sessionId, input.observedAt),
              targetType: "DiningSession",
              actor: { type: "System" },
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
            },
          }),
        },
        reversibility: { evaluate: async () => "Unavailable" },
        closureEvidence: { resolve: async () => null },
        tasks: {
          ensure: async () => {
            throw new Error("unconfigured synthetic task");
          },
        },
      });
      beforeMove = async () => {
        await closingService.begin({
          diningSessionReference: sessionId,
          expectedSessionVersion: current.version,
          operationReference: id(101),
          requestedAt: at(8),
        });
      };
      const sourceBeforeClosing = await tableReader.loadTable(current.tableReference),
        targetBeforeClosing = await tableReader.loadTable(id(25));
      await assert.rejects(
        tableService.moveSession(await moveRequest(currentTableNumber, 25, 100, 8)),
        { code: "DINING_TABLE_VERSION_CONFLICT" },
      );
      beforeMove = async () => undefined;
      assert.deepEqual(await tableReader.loadTable(current.tableReference), sourceBeforeClosing);
      assert.deepEqual(await tableReader.loadTable(id(25)), targetBeforeClosing);
      assert.equal((await reader.loadSession(sessionId)).phase, "Closing");
      assert.equal(await participation.resolve(participantInput), null);
      assert.equal((await tableService.moveSession(first)).status, "AlreadyApplied");
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      const foreign = createPostgresDiningSessionMoveStore(
        runner({ readOnly: true }),
        { ...scope, storeReference: id(999) },
        tableReferences,
      );
      assert.equal(await foreign.resolveMoveOperation(id(90)), null);
      const otherTenant = createPostgresDiningSessionMoveStore(
        runner({ readOnly: true }),
        { ...scope, tenantReference: id(999) },
        tableReferences,
      );
      assert.equal(await otherTenant.resolveMoveOperation(id(90)), null);
      const prior = (
        await admin.query(
          "SELECT * FROM rms_dining.dining_session_move_operation WHERE operation_id=$1",
          [id(90)],
        )
      ).rows[0];
      await admin.query(
        `GRANT UPDATE,DELETE ON rms_dining.dining_session_move_operation TO ${role}`,
      );
      await runner().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(3)],
        );
        assert.equal(
          (
            await tx.query(
              "UPDATE rms_dining.dining_session_move_operation SET intent_digest=$1 WHERE operation_id=$2",
              [`sha256:${"a".repeat(64)}`, id(90)],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await tx.query(
              "DELETE FROM rms_dining.dining_session_move_operation WHERE operation_id=$1",
              [id(90)],
            )
          ).rowCount,
          0,
        );
      });
      const insert = (tx, operation, value) => {
        const command = { ...value.command, operationReference: operation };
        const intent = tableReferences.hashIntent(
          JSON.stringify(Object.fromEntries(Object.keys(first).map((key) => [key, command[key]]))),
        );
        return tx.query(
          "INSERT INTO rms_dining.dining_session_move_operation (operation_id,tenant_id,brand_id,store_id,session_id,source_table_id,target_table_id,intent_digest,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            operation,
            id(1),
            id(2),
            id(3),
            sessionId,
            id(20),
            id(21),
            intent,
            at(3),
            JSON.stringify({
              ...value,
              command,
              operationReference: operation,
              intentDigest: intent,
            }),
          ],
        );
      };
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(999)],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT operation_id FROM rms_dining.dining_session_move_operation",
                [],
              )
            ).rows.length,
            0,
          );
          await insert(tx, id(++sequence), prior.record_json);
        }),
        { code: "42501" },
      );
      for (const field of ["command", "session", "sourceTable", "targetTable", "audit", "event"])
        await assert.rejects(
          insert(admin, id(++sequence), {
            ...prior.record_json,
            [field]: { ...prior.record_json[field], rawCredential: "synthetic-forbidden" },
          }),
          { code: "23514" },
        );
      await assert.rejects(
        insert(admin, id(++sequence), {
          ...prior.record_json,
          rawCredential: "synthetic-forbidden",
        }),
        { code: "23514" },
      );
      assert.equal(
        (await moveReader.resolveMoveOperation(id(90))).audit.auditId,
        sameOperation[0].result.audit.auditId,
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

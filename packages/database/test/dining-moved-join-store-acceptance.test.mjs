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
  createPostgresDiningMovedJoinStore,
  createPostgresDiningParticipationStore,
  createDiningCartParticipationQuery,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902286-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("reissues a fresh Join generation after committed Move with current Staff and atomic persistence", async () => {
  await withIsolatedDatabase({ caseId: "wp2286_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2286_${context.runId}`;
    assert.match(role, /^wp2286_[a-f0-9]+$/u);
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
      const movedReader = createPostgresDiningMovedJoinStore(
        runner({ readOnly: true }),
        scope,
        credentials,
        tableReferences,
      );
      const movedWriter = createPostgresDiningMovedJoinStore(
        runner(),
        scope,
        credentials,
        tableReferences,
      );
      let selectedReissueWriter = movedWriter;
      let beforeReissue = async () => undefined;
      let guestTable = id(20);
      let pepperVersion = 1;
      let staffAllowed = true;
      function service(selectedWriter = joinWriter, beforeWrite = async () => undefined) {
        return createDiningSessionService({
          pepperVersion,
          movedJoin: {
            references: tableReferences,
            resolveMovedJoinState: movedReader.resolveMovedJoinState,
            reissueAfterMove: async (input) => {
              await beforeReissue();
              return selectedReissueWriter.reissueAfterMove(input);
            },
          },
          credentials,
          staff: {
            async authorize(input) {
              if (!staffAllowed) return null;
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
              tableReference: guestTable,
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
      const selectedMoveWriter = moveWriter;
      const beforeMove = async () => undefined;
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
      const regenerationRequest = async (operation, minute, selectedSession = sessionId) => {
        const session = await reader.loadSession(selectedSession);
        const state =
          (await regenerationReader.resolveActiveJoin(selectedSession)) ??
          (await movedReader.resolveMovedJoinState(selectedSession));
        assert(state);
        return {
          diningSessionReference: selectedSession,
          tableReference: session.tableReference,
          expectedAssignmentVersion: session.tableAssignmentVersion,
          expectedSessionVersion: session.version,
          expectedCapabilityVersion: state.capability.version,
          operationReference: id(operation),
          requestedAt: at(minute),
        };
      };
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_join_regeneration_operation) AS operations,
        (SELECT count(*)::integer FROM rms_dining.dining_join_regeneration_operation WHERE move_operation_id IS NOT NULL) AS linked,
        (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_JOIN_CREDENTIAL_REGENERATE') AS audits`)
        ).rows[0];
      await tableService.moveSession(await moveRequest(20, 21, 90));
      assert.equal(await regenerationReader.resolveActiveJoin(sessionId), null);
      pepperVersion = 2;
      const firstRequest = await regenerationRequest(91, 4);
      const firstResults = await Promise.all([
        service().regenerate(firstRequest),
        service().regenerate(firstRequest),
      ]);
      assert(
        firstResults.every(
          (value) =>
            value.capability.capabilityReference === firstResults[0].capability.capabilityReference,
        ),
      );
      const firstIssued = firstResults.find((value) => value.status === "Issued");
      assert(firstIssued);
      assert.equal(firstIssued.capability.pepperVersion, 2);
      assert.deepEqual(await counts(), { operations: 1, linked: 1, audits: 1 });
      assert.equal(await movedReader.resolveMovedJoinState(sessionId), null);
      assert.deepEqual(
        (await regenerationReader.resolveRegenerationOperation(id(91))).capability,
        firstIssued.capability,
      );
      staffAllowed = false;
      await assert.rejects(service().regenerate(firstRequest), {
        code: "DINING_SESSION_PERMISSION_DENIED",
      });
      staffAllowed = true;
      guestTable = id(21);
      assert.deepEqual(
        await service().join({
          guestSessionReference: id(81),
          joinCredential: started.joinCredential,
          expectedSessionVersion: 3,
          expectedCapabilityVersion: 2,
          operationReference: id(41),
          requestedAt: at(5),
        }),
        { status: "DiningJoinUnavailable" },
      );
      const secondJoin = await service().join({
        guestSessionReference: id(81),
        joinCredential: firstIssued.joinCredential,
        expectedSessionVersion: 3,
        expectedCapabilityVersion: 1,
        operationReference: id(42),
        requestedAt: at(5),
      });
      assert.equal(
        secondJoin.session.hostParticipantReference,
        joined.participant.participantReference,
      );
      assert.notEqual(
        secondJoin.participant.participantReference,
        joined.participant.participantReference,
      );
      let participationAt = at(5);
      const participation = createDiningCartParticipationQuery({
        scope: { brandReference: id(2), storeReference: id(3) },
        repository: createPostgresDiningParticipationStore(runner({ readOnly: true }), scope),
        now: () => participationAt,
      });
      const participantInput = {
        purpose: "Cart",
        diningSessionReference: sessionId,
        participantReference: joined.participant.participantReference,
      };
      assert.equal((await participation.resolve(participantInput)).tableReference, id(21));
      const normal = await service().regenerate(await regenerationRequest(92, 6));
      assert.equal(normal.status, "Issued");
      assert.equal(normal.capability.generation, 3);
      assert.deepEqual(await counts(), { operations: 2, linked: 1, audits: 2 });
      await tableService.moveSession(await moveRequest(21, 22, 93, 7));
      await tableService.moveSession(await moveRequest(22, 21, 94, 8));
      const beforeFault = await movedReader.resolveMovedJoinState(sessionId);
      const retryRequest = await regenerationRequest(95, 9);
      selectedReissueWriter = createPostgresDiningMovedJoinStore(
        runner({ readOnly: true }),
        scope,
        credentials,
        tableReferences,
      );
      await assert.rejects(service().regenerate(retryRequest), {
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
      selectedReissueWriter = createPostgresDiningMovedJoinStore(
        runner({ failAudit: true }),
        scope,
        credentials,
        tableReferences,
      );
      await assert.rejects(service().regenerate(retryRequest), {
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await movedReader.resolveMovedJoinState(sessionId), beforeFault);
      assert.deepEqual(await counts(), { operations: 2, linked: 1, audits: 2 });
      selectedReissueWriter = movedWriter;
      const returned = await service().regenerate(retryRequest);
      assert.equal(returned.status, "Issued");
      assert.equal(returned.capability.tableReference, normal.capability.tableReference);
      assert(returned.capability.assignmentVersion > normal.capability.assignmentVersion);
      assert.equal(
        (
          await admin.query(
            "SELECT status FROM rms_dining.dining_join_capability WHERE capability_id=$1",
            [normal.capability.capabilityReference],
          )
        ).rows[0].status,
        "Revoked",
      );
      await tableService.moveSession(await moveRequest(21, 22, 96, 10));
      const lostRequest = await regenerationRequest(97, 11);
      selectedReissueWriter = createPostgresDiningMovedJoinStore(
        runner({ loseAck: true }),
        scope,
        credentials,
        tableReferences,
      );
      await assert.rejects(service().regenerate(lostRequest), {
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
      selectedReissueWriter = movedWriter;
      const recovered = await service().regenerate(lostRequest);
      assert.equal(recovered.status, "AlreadyApplied");
      assert(!Object.hasOwn(recovered, "joinCredential"));
      assert.deepEqual(await counts(), { operations: 4, linked: 3, audits: 4 });
      await tableService.moveSession(await moveRequest(22, 21, 98, 12));
      const competing = await regenerationRequest(99, 13);
      let arrive = 0,
        release;
      const barrier = new Promise((resolve) => {
        release = resolve;
      });
      beforeReissue = async () => {
        if (++arrive === 2) release();
        await barrier;
      };
      const raced = await Promise.allSettled([
        service().regenerate(competing),
        service().regenerate({ ...competing, operationReference: id(100) }),
      ]);
      beforeReissue = async () => undefined;
      assert.equal(raced.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(
        raced.find((value) => value.status === "rejected").reason.code,
        "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), { operations: 5, linked: 4, audits: 5 });
      await tableService.moveSession(await moveRequest(21, 22, 101, 14));
      const pending = await regenerationRequest(102, 15);
      beforeReissue = async () => {
        await tableService.moveSession(await moveRequest(22, 21, 103, 15));
      };
      await assert.rejects(service().regenerate(pending), {
        code: "DINING_SESSION_VERSION_CONFLICT",
      });
      beforeReissue = async () => undefined;
      assert.equal(await regenerationReader.resolveRegenerationOperation(id(102)), null);
      await service().regenerate(await regenerationRequest(104, 16));
      await tableService.moveSession(await moveRequest(21, 22, 105, 17));
      const current = await reader.loadSession(sessionId);
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
      const closingPending = await regenerationRequest(106, 18);
      beforeReissue = async () => {
        await closingService.begin({
          diningSessionReference: sessionId,
          expectedSessionVersion: current.version,
          operationReference: id(107),
          requestedAt: at(18),
        });
      };
      await assert.rejects(service().regenerate(closingPending), {
        code: "DINING_SESSION_VERSION_CONFLICT",
      });
      beforeReissue = async () => undefined;
      assert.equal(await movedReader.resolveMovedJoinState(sessionId), null);
      assert.equal(await regenerationReader.resolveRegenerationOperation(id(106)), null);
      participationAt = at(18);
      assert.equal(await participation.resolve(participantInput), null);
      const other = await service().start(command(23, 110));
      await tableService.moveSession(
        await moveRequest(23, 24, 111, 19, other.session.diningSessionReference),
      );
      const expired = await service().start(command(25, 112));
      await tableService.moveSession(
        await moveRequest(25, 23, 113, 30, expired.session.diningSessionReference),
      );
      const freshAfterExpiry = await service().regenerate(
        await regenerationRequest(114, 40, expired.session.diningSessionReference),
      );
      assert.equal(freshAfterExpiry.status, "Issued");
      assert.equal(
        (
          await admin.query(
            "SELECT status FROM rms_dining.dining_join_capability WHERE capability_id=$1",
            [expired.capability.capabilityReference],
          )
        ).rows[0].status,
        "Revoked",
      );
      assert.deepEqual(await counts(), { operations: 7, linked: 6, audits: 7 });
      const row = (
        await admin.query(
          "SELECT record_json FROM rms_dining.dining_join_regeneration_operation WHERE operation_id=$1",
          [id(91)],
        )
      ).rows[0];
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_join_regeneration_operation SET move_operation_id=NULL WHERE operation_id=$1",
            [id(91)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "DELETE FROM rms_dining.dining_join_regeneration_operation WHERE operation_id=$1",
            [id(91)],
          )
        ).rowCount,
        0,
      );
      const insertHistory = (tx, record, moveId) =>
        tx.query(
          "INSERT INTO rms_dining.dining_join_regeneration_operation (operation_id,tenant_id,brand_id,store_id,session_id,capability_id,actor_id,intent_hash,record_json,occurred_at,move_operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)",
          [
            record.operationReference,
            id(1),
            id(2),
            id(3),
            record.capability.diningSessionReference,
            record.capability.capabilityReference,
            id(8),
            record.operationIntentHash,
            JSON.stringify(record),
            record.capability.issuedAt,
            moveId,
          ],
        );
      await admin.query("BEGIN");
      try {
        const negative = {
          ...row.record_json,
          operationReference: id(120),
          capability: {
            ...row.record_json.capability,
            capabilityReference: id(121),
            generation: 99,
          },
        };
        await admin.query(
          "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,2,'Consumed',$6::jsonb)",
          [
            id(121),
            id(1),
            id(2),
            id(3),
            sessionId,
            JSON.stringify({
              ...negative.capability,
              version: 2,
              status: "Consumed",
              consumedAt: at(5),
            }),
          ],
        );
        await assert.rejects(insertHistory(admin, negative, id(111)), { code: "23503" });
      } finally {
        await admin.query("ROLLBACK");
      }
      await runner().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(999)],
        );
        assert.equal(
          (
            await tx.query(
              "SELECT operation_id FROM rms_dining.dining_join_regeneration_operation",
              [],
            )
          ).rows.length,
          0,
        );
      });
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(999)],
          );
          await insertHistory(tx, { ...row.record_json, operationReference: id(122) }, id(90));
        }),
        { code: "42501" },
      );
      for (const field of ["tenantReference", "storeReference"]) {
        const foreign = createPostgresDiningMovedJoinStore(
          runner({ readOnly: true }),
          { ...scope, [field]: id(999) },
          credentials,
          tableReferences,
        );
        assert.equal(
          await foreign.resolveMovedJoinState(other.session.diningSessionReference),
          null,
        );
      }
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createTaskRecord } from "../../bop/task/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createDiningTable,
  transitionDiningTable,
  createDiningTableService,
  createDiningSessionService,
  createDiningClosingService,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningSessionMoveStore,
  createPostgresDiningClosingStore,
  createPostgresDiningStaffCallStore,
} from "../../rms/dining/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-10-17T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};

// WP-2423 Q28 DEC-DINING-STAFF-CALL: the store and every Dining command run as a restricted
// NOBYPASSRLS role holding exactly the rendered pilot api grants; the owner client only reads
// counts and attempts the forbidden writes.
it("lets a seated guest call staff once at a time, within a budget, and staff answer it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_call" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423sc_${context.runId}`,
      worker = `wp2423sc_w_${context.runId}`,
      staffRole = `wp2423sc_s_${context.runId}`;
    assert.match(role, /^wp2423sc_[a-f0-9]+$/u);
    let active = 0;
    let sequence = 1000;
    let code = 100000;
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
      // Exactly the rendered pilot grants (matrix plus approved additions) for the api role.
      await admin.query(
        `CREATE ROLE ${worker} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      // Test setup only: table configuration and the table Move run as a separate staff role,
      // because the pilot api grants have no table Move (dining_session_move_operation).
      await admin.query(
        `CREATE ROLE ${staffRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_dining,platform_audit,platform_helpers TO ${staffRole}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${staffRole}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${staffRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_table,rms_dining.dining_session TO ${staffRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session_move_operation,platform_audit.audit_record TO ${staffRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${staffRole}`,
      );
      function runner({ readOnly = false, failAudit = false, as = role } = {}) {
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
              await client.query(`SET LOCAL ROLE ${as}`);
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
        // Six-digit table codes, as the pilot issues (HumanCode); distinct per issuance.
        generateJoinCredential: () => String(++code),
        hashJoinCredential: (kind, value) =>
          createHmac("sha256", "synthetic-test-only-pepper")
            .update(`DiningJoin:${kind}:${value}`)
            .digest("hex"),
        hashOperationIntent: digest,
        equals: (a, b) => a === b,
      };
      const tableReader = createPostgresDiningTableStore(
        runner({ readOnly: true, as: staffRole }),
        scope,
        tableReferences,
      );
      const tableWriter = createPostgresDiningTableStore(
        runner({ as: staffRole }),
        scope,
        tableReferences,
      );
      const reader = createPostgresDiningSessionStartStore(
        runner({ readOnly: true }),
        scope,
        credentials,
      );
      const writer = createPostgresDiningSessionStartStore(runner(), scope, credentials);
      const moveReader = createPostgresDiningSessionMoveStore(
        runner({ readOnly: true, as: staffRole }),
        scope,
        tableReferences,
      );
      const moveWriter = createPostgresDiningSessionMoveStore(
        runner({ as: staffRole }),
        scope,
        tableReferences,
      );
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
          commitMove: (record) => moveWriter.commitMove(record),
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
        await tableService.executeTable({
          action: "Publish",
          operationReference: id(++sequence),
          candidate: transitionDiningTable(draft, "Publish", at(0)),
          expectedAggregateVersion: 1,
          observedAt: at(0),
        });
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
      // The joining guest's verified table context (their own scan of the table's QR code).
      let guestTable = id(20);
      const sessions = createDiningSessionService({
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
                action: "dining.operate",
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
          join: joinWriter.join,
        },
      });
      let authorized = true;
      const hashes = { hashIntent: digest, equals: (left, right) => left === right };
      const calls = (selected = runner()) =>
        createPostgresDiningStaffCallStore(selected, {
          scope,
          ...hashes,
          // The API proves the caller's own current Guest identity and binding here.
          authorize: async () => authorized,
        });
      const asGuest = (participantReference, sessionId, operation, minute) => ({
        operationReference: id(operation),
        ...scope,
        diningSessionReference: sessionId,
        participantReference,
        observedAt: at(minute),
      });
      // Staff reads and answers borrow one authorized merchant transaction.
      const staff = (work) => runner().run((tx) => work(calls({ run: (next) => next(tx) }), tx));
      const allowed = () => true;
      const join = (credential, guest, operation, minute) =>
        sessions.joinCurrent({
          guestSessionReference: id(guest),
          joinCredential: credential,
          operationReference: id(operation),
          requestedAt: at(minute),
        });
      const staffRegenerate = async (sessionId, table, operation, minute) => {
        const state = await regenerationReader.resolveActiveJoin(sessionId);
        return sessions.regenerate({
          diningSessionReference: sessionId,
          tableReference: id(table),
          expectedAssignmentVersion: state.session.tableAssignmentVersion,
          expectedSessionVersion: state.session.version,
          expectedCapabilityVersion: state.capability.version,
          expectedGeneration: state.capability.generation,
          operationReference: id(operation),
          requestedAt: at(minute),
        });
      };
      const counts = async () =>
        (
          await admin.query(`SELECT
       (SELECT count(*)::integer FROM rms_dining.dining_staff_call) AS calls,
       (SELECT count(*)::integer FROM rms_dining.dining_staff_call_closure) AS closures`)
        ).rows[0];

      await configure(20);
      await configure(21);
      await configure(22);
      const started = await sessions.start({
        tableReference: id(20),
        expectedAssignmentVersion: 2,
        operationReference: id(30),
        joinKind: "HumanCode",
        requestedAt: at(1),
      });
      assert.equal(started.status, "Issued");
      const sessionId = started.session.diningSessionReference;
      // The first guest joins with the staff code and becomes the Host (Handoff 6.11).
      const hostJoin = await join(started.joinCredential, 80, 40, 2);
      assert.equal(hostJoin.status, "Joined");
      const host = hostJoin.participant.participantReference;
      assert.equal(hostJoin.session.hostParticipantReference, host);
      const staffCode = await staffRegenerate(sessionId, 20, 31, 3);
      const guestJoin = await join(staffCode.joinCredential, 81, 41, 4);
      assert.equal(guestJoin.status, "Joined");
      const guest = guestJoin.participant.participantReference;

      // A guest who is not seated here, or a caller the API did not authorize, cannot call.
      assert.deepEqual(await calls().call(asGuest(id(999), sessionId, 50, 5), "Question"), {
        status: "Refused",
        reason: "NotSeated",
        retryAt: null,
      });
      authorized = false;
      await assert.rejects(calls().call(asGuest(guest, sessionId, 51, 5), "Question"), {
        code: "DINING_SESSION_PERMISSION_DENIED",
      });
      authorized = true;
      await assert.rejects(calls().call(asGuest(guest, sessionId, 51, 5), "Coffee please"), {
        code: "DINING_SESSION_INPUT_INVALID",
      });
      assert.deepEqual(await counts(), { calls: 0, closures: 0 });

      // A guest calls; the replay of the same request answers the same call, and a second guest's
      // call at the same table is told staff are already asked (one open call per table).
      const first = await calls().call(asGuest(guest, sessionId, 52, 6), "TableNeeds");
      assert.equal(first.status, "Called");
      assert.equal(first.call.callReference, id(52));
      assert.equal(first.call.reason, "TableNeeds");
      assert.deepEqual(await calls().call(asGuest(guest, sessionId, 52, 6), "TableNeeds"), first);
      await assert.rejects(calls().call(asGuest(guest, sessionId, 52, 6), "Question"), {
        code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      });
      const again = await calls().call(asGuest(host, sessionId, 53, 7), "Question");
      assert.equal(again.status, "AlreadyOpen");
      assert.equal(again.call.callReference, id(52));
      assert.deepEqual(await counts(), { calls: 1, closures: 0 });
      const seen = await calls(runner({ readOnly: true })).status(asGuest(host, sessionId, 54, 7));
      assert.equal(seen.seated, true);
      assert.equal(seen.open?.callReference, id(52));
      assert.equal(seen.nextCallAt, null);

      // Staff see it on the Tables page and in the navigation count, and answer it once.
      const listed = await staff((store, tx) => store.listOpen(tx, [sessionId, id(998)], allowed));
      assert.deepEqual([...listed.keys()], [sessionId]);
      assert.equal(await staff((store, tx) => store.countOpen(tx, allowed)), 1);
      const answer = (operation, minute, callReference = id(52)) =>
        staff((store, tx) =>
          store.answer(
            tx,
            {
              operationReference: id(operation),
              callReference,
              actorReference: id(8),
              observedAt: at(minute),
            },
            allowed,
          ),
        );
      assert.deepEqual(await answer(60, 8), { status: "Closed", kind: "Answered" });
      assert.deepEqual(await answer(60, 8), { status: "Closed", kind: "Answered" });
      assert.deepEqual(await answer(61, 8), { status: "AlreadyClosed", kind: "Answered" });
      assert.equal(await staff((store, tx) => store.countOpen(tx, allowed)), 0);
      const afterAnswer = await calls(runner({ readOnly: true })).status(
        asGuest(guest, sessionId, 55, 9),
      );
      assert.equal(afterAnswer.open, null);
      assert.deepEqual(afterAnswer.recentlyClosed, { kind: "Answered", closedAt: at(8) });

      // A guest withdraws the next call; only a guest seated in that Session can.
      const second = await calls().call(asGuest(host, sessionId, 62, 10), "OrderProblem");
      assert.equal(second.status, "Called");
      assert.deepEqual(await calls().withdraw(asGuest(id(997), sessionId, 63, 11), id(62)), {
        status: "NotSeated",
      });
      assert.deepEqual(await calls().withdraw(asGuest(guest, sessionId, 64, 11), id(62)), {
        status: "Closed",
        kind: "Withdrawn",
      });
      assert.deepEqual(await calls().withdraw(asGuest(guest, sessionId, 65, 11), id(62)), {
        status: "AlreadyClosed",
        kind: "Withdrawn",
      });

      // At most 6 calls in any 30 minutes: the 7th is refused with when the next one is admitted.
      for (const [index, minute] of [12, 13, 14, 15].entries()) {
        const made = await calls().call(asGuest(guest, sessionId, 70 + index, minute), "Question");
        assert.equal(made.status, "Called");
        assert.deepEqual(await answer(80 + index, minute, id(70 + index)), {
          status: "Closed",
          kind: "Answered",
        });
      }
      assert.deepEqual(await calls().call(asGuest(guest, sessionId, 79, 16), "Question"), {
        status: "Refused",
        reason: "TooManyCalls",
        retryAt: at(36),
      });
      assert.equal(
        (await calls(runner({ readOnly: true })).status(asGuest(guest, sessionId, 56, 16)))
          .nextCallAt,
        at(36),
      );
      assert.deepEqual(await counts(), { calls: 6, closures: 6 });

      // The database refuses what the store would never write: a second open call, a call for a
      // guest not seated, a closure that does not match, edits and deletes of the history.
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(3)],
          );
          await tx.query(
            "INSERT INTO rms_dining.dining_staff_call (tenant_id,brand_id,store_id,call_id,session_id,participant_id,reason,intent_hash,called_at) VALUES ($1,$2,$3,$4,$5,$6,'Question',$7,$8)",
            [id(1), id(2), id(3), id(90), sessionId, id(996), digest("x"), at(40)],
          );
        }),
        /staff call source mismatch|violates foreign key/u,
      );
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(3)],
          );
          await tx.query(
            "INSERT INTO rms_dining.dining_staff_call_closure (tenant_id,brand_id,store_id,call_id,operation_id,kind,actor_id,participant_id,intent_hash,closed_at) VALUES ($1,$2,$3,$4,$5,'Answered',NULL,$6,$7,$8)",
            [id(1), id(2), id(3), id(70), id(91), guest, digest("y"), at(40)],
          );
        }),
        /dining_staff_call_closure_actor|duplicate key/u,
      );
      for (const sql of [
        "UPDATE rms_dining.dining_staff_call SET reason='Question'",
        "DELETE FROM rms_dining.dining_staff_call_closure",
        "TRUNCATE rms_dining.dining_staff_call_closure",
      ])
        await assert.rejects(
          runner().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(2), id(3)],
            );
            await tx.query(sql, []);
          }),
          /append-only staff call history|permission denied/u,
        );
      for (const sql of [
        "UPDATE rms_dining.dining_staff_call SET reason='Question'",
        "DELETE FROM rms_dining.dining_staff_call_closure",
      ])
        await assert.rejects(admin.query(sql), /append-only staff call history/u);
      assert.deepEqual(await counts(), { calls: 6, closures: 6 });

      // Another Store sees nothing and cannot answer this Store's calls.
      const other = createPostgresDiningStaffCallStore(runner(), {
        scope: { ...scope, storeReference: id(90) },
        ...hashes,
        authorize: async () => true,
      });
      await assert.rejects(other.call(asGuest(guest, sessionId, 92, 41), "Question"), {
        code: "DINING_SESSION_PERMISSION_DENIED",
      });
      assert.equal(
        await runner().run((tx) =>
          createPostgresDiningStaffCallStore(
            { run: (next) => next(tx) },
            { scope: { ...scope, storeReference: id(90) }, ...hashes, authorize: async () => true },
          ).countOpen(tx, allowed),
        ),
        0,
      );

      // DEC-DINING-STAFF-CALL (coordinator 2026-10-30, Owner-authorized): a table checking out still
      // calls staff — its open call stays open and counted, and a guest may call "ready to pay";
      // once the table is closed, no one is seated for calls.
      const open = await calls().call(asGuest(guest, sessionId, 93, 47), "Question");
      assert.equal(open.status, "Called");
      assert.equal(await staff((store, tx) => store.countOpen(tx, allowed)), 1);
      const closingReader = createPostgresDiningClosingStore(
        runner({ readOnly: true }),
        scope,
        hashes,
      );
      const closingWriter = createPostgresDiningClosingStore(runner(), scope, hashes);
      const closing = createDiningClosingService({
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
            participantReference: host,
            diningSessionReference: sessionId,
            storeReference: id(3),
            status: "CurrentHost",
            observedAt: input.observedAt,
            audit: {
              ...audit(
                `DINING_SESSION_CLOSING_${input.operation.toUpperCase()}`,
                sessionId,
                input.observedAt,
              ),
              targetType: "DiningSession",
              actor: { type: "System" },
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
            },
          }),
        },
        reversibility: { evaluate: async () => "Reversible" },
        closureEvidence: {
          resolve: async (input) => ({
            diningSessionReference: sessionId,
            brandReference: id(2),
            storeReference: id(3),
            evidenceVersion: 1,
            evidenceDigest: digest("synthetic-empty-finality"),
            observedAt: input.observedAt,
            orders: [
              {
                orderReference: id(201),
                orderClosureStatus: "Open",
                batches: [{ batchReference: id(202), executionState: "Fulfilled" }],
                financialClass: "Unpaid",
                ownerFinalityReference: null,
                ownerDecidedAt: null,
              },
            ],
          }),
        },
        tasks: {
          ensure: async (input) => {
            const assignment = {
              assignmentReference: id(204),
              target: { kind: "Queue", reference: id(205) },
              assignedBy: id(8),
              assignedAt: input.requestedAt,
              reasonCode: "MANAGER_QUEUE_ASSIGNMENT",
            };
            return {
              orderReference: input.orderReference,
              evidenceVersion: input.evidenceVersion,
              intentHash: input.intentHash,
              task: createTaskRecord({
                taskReference: id(203),
                scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
                source: {
                  sourceType: "DINING_SESSION",
                  sourceReference: sessionId,
                  snapshotDigest: `sha256:${input.evidenceDigest}`,
                },
                taskType: "DINING_UNPAID_BATCH_EXCEPTION",
                severityCode: "CRITICAL",
                priorityCode: "CRITICAL",
                status: "Assigned",
                assignmentHistory: [assignment],
                currentAssignment: assignment,
                claimHistory: [],
                currentClaim: null,
                dueAt: at(59),
                escalationPolicyReference: id(206),
                escalationHistory: [],
                terminalOutcome: null,
                version: 2,
                createdAt: input.requestedAt,
                updatedAt: input.requestedAt,
              }),
            };
          },
        },
      });
      const closedSession = await closing.begin({
        diningSessionReference: sessionId,
        operationReference: id(181),
        expectedSessionVersion: (await reader.loadSession(sessionId)).version,
        requestedAt: at(48),
      });
      assert.equal(closedSession.session.phase, "Closing");
      assert.equal(await staff((store, tx) => store.countOpen(tx, allowed)), 1);
      const checkingOut = await calls(runner({ readOnly: true })).status(
        asGuest(guest, sessionId, 57, 49),
      );
      assert.equal(checkingOut.seated, true);
      assert.notEqual(checkingOut.open, null);
      assert.deepEqual(await calls().withdraw(asGuest(guest, sessionId, 94, 49), id(93)), {
        status: "Closed",
        kind: "Withdrawn",
      });
      const ready = await calls().call(asGuest(guest, sessionId, 95, 50), "ReadyToPay");
      assert.equal(ready.status, "Called", JSON.stringify(ready));
      assert.equal(ready.call.reason, "ReadyToPay");
      assert.equal(await staff((store, tx) => store.countOpen(tx, allowed)), 1);
      // The table closed (TEST-only owner fixture standing in for the closing command): no one is
      // seated for calls any more.
      await admin.query(
        "UPDATE rms_dining.dining_session SET phase='Closed',version=version+1,session_snapshot=jsonb_set(jsonb_set(session_snapshot,'{phase}','\"Closed\"'),'{version}',to_jsonb(version+1)) WHERE session_id=$1",
        [sessionId],
      );
      const late = await calls(runner({ readOnly: true })).status(
        asGuest(guest, sessionId, 58, 51),
      );
      assert.equal(late.seated, false);
      assert.deepEqual(await calls().call(asGuest(guest, sessionId, 96, 51), "Question"), {
        status: "Refused",
        reason: "NotSeated",
        retryAt: null,
      });
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

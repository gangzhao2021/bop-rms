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
  createPostgresDiningQrJoinStore,
  createPostgresDiningParticipantFence,
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

// WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN: the QR-join store and every Dining command run as a
// restricted NOBYPASSRLS role holding exactly the rendered pilot api grants; the owner client only
// reads counts and attempts the forbidden writes.
it("lets a guest join an open table by its QR code, with staff pause, removal and limits", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_qr_join" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423qj_${context.runId}`,
      worker = `wp2423qj_w_${context.runId}`,
      staffRole = `wp2423qj_s_${context.runId}`;
    assert.match(role, /^wp2423qj_[a-f0-9]+$/u);
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
      let clock = at(0);
      let authorized = true;
      const qrAudit = (input) => ({
        auditId: id(++sequence),
        brandId: id(2),
        storeId: id(3),
        actor:
          input.actorReference === null
            ? { type: "System" }
            : { type: "User", reference: input.actorReference },
        actionCode: `DINING_QR_JOIN_${input.action.toUpperCase()}`,
        targetType: "DiningTable",
        targetId: input.tableReference,
        reasonCode:
          input.actorReference === null ? "GUEST_SCANNED_OPEN_TABLE" : "STAFF_TABLE_CONTROL",
        correlationId: input.operationReference,
        occurredAt: input.observedAt,
        sourceChannel: input.actorReference === null ? "CUSTOMER_PWA" : "API",
        dataClassification: input.actorReference === null ? "Restricted" : "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const qr = (selected = runner(), storeScope = scope) =>
        createPostgresDiningQrJoinStore(selected, {
          scope: storeScope,
          credentials,
          pepperVersion: 1,
          now: () => clock,
          // The API proves the scanning guest's own current identity and table context here.
          authorize: async () => authorized,
          audit: qrAudit,
        });
      const issue = (table, guest, operation, minute, selected) => {
        clock = at(minute);
        guestTable = id(table);
        return qr(selected).issue({
          operationReference: id(operation),
          guestSessionReference: id(guest),
          tableReference: id(table),
          observedAt: at(minute),
        });
      };
      const join = (credential, guest, operation, minute) =>
        sessions.joinCurrent({
          guestSessionReference: id(guest),
          joinCredential: credential,
          operationReference: id(operation),
          requestedAt: at(minute),
        });
      // Scan, tap "Join this table": issue for this guest, then the ordinary join.
      const scanAndJoin = async (table, guest, operation, minute) => {
        const issued = await issue(table, guest, operation, minute);
        if (issued.status !== "Issued") return issued;
        return join(issued.joinCredential, guest, operation + 500, minute);
      };
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
       (SELECT count(*)::integer FROM rms_dining.dining_qr_join_issue) AS issues,
       (SELECT count(*)::integer FROM rms_dining.dining_qr_join_control) AS controls,
       (SELECT count(*)::integer FROM rms_dining.dining_participant_removal) AS removals,
       (SELECT count(*)::integer FROM rms_dining.dining_participant) AS participants,
       (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code LIKE 'DINING_QR_JOIN_%') AS audits`)
        ).rows[0];
      const fence = createPostgresDiningParticipantFence(runner(), scope);
      const atTable = (sessionId, participant, minute) =>
        fence.readCurrent({
          brandReference: id(2),
          storeReference: id(3),
          diningSessionReference: sessionId,
          participantReference: participant,
          observedAt: at(minute),
        });

      await configure(20);
      await configure(21);
      await configure(22);

      // A table that is not open cannot be joined by its QR code, and nothing is written.
      assert.deepEqual(await issue(21, 79, 100, 1), { status: "Refused", reason: "NotOpen" });
      assert.deepEqual(await counts(), {
        issues: 0,
        controls: 0,
        removals: 0,
        participants: 0,
        audits: 0,
      });

      const started = await sessions.start({
        tableReference: id(20),
        expectedAssignmentVersion: 2,
        operationReference: id(30),
        joinKind: "HumanCode",
        requestedAt: at(1),
      });
      assert.equal(started.status, "Issued");
      const sessionId = started.session.diningSessionReference;

      // Decision 1: two phones scan and join directly; the first is the Host.
      const first = await scanAndJoin(20, 80, 101, 2);
      assert.equal(first.status, "Joined");
      assert.equal(first.session.hostParticipantReference, first.participant.participantReference);
      const second = await scanAndJoin(20, 81, 102, 3);
      assert.equal(second.status, "Joined");
      const phone2 = second.participant.participantReference;
      assert.notEqual(second.session.hostParticipantReference, phone2);
      // The issued code is used once: a second join with it is refused.
      const issued = await issue(20, 82, 103, 4);
      assert.equal(issued.status, "Issued");
      assert.equal((await join(issued.joinCredential, 82, 603, 4)).status, "Joined");
      assert.deepEqual(await join(issued.joinCredential, 83, 604, 4), {
        status: "DiningJoinRefused",
        reason: "CodeUsed",
      });
      // The record never holds the code; the audit names the table, not the guest.
      const record = (
        await admin.query("SELECT * FROM rms_dining.dining_qr_join_issue WHERE operation_id=$1", [
          id(103),
        ])
      ).rows[0];
      assert.equal(record.guest_session_id, id(82));
      assert.equal(JSON.stringify(record).includes(issued.joinCredential), false);
      const issueAudit = (
        await admin.query(
          "SELECT actor_type,source_channel,target_id FROM platform_audit.audit_record WHERE action_code='DINING_QR_JOIN_ISSUE' AND correlation_id=$1",
          [id(103)],
        )
      ).rows[0];
      assert.deepEqual(issueAudit, {
        actor_type: "System",
        source_channel: "CUSTOMER_PWA",
        target_id: id(20),
      });
      // An unauthorized caller writes nothing.
      authorized = false;
      const beforeDenied = await counts();
      await assert.rejects(issue(20, 84, 104, 5), { code: "DINING_SESSION_PERMISSION_DENIED" });
      authorized = true;
      assert.deepEqual(await counts(), beforeDenied);

      // Decision 3: the phones in the order they joined.
      clock = at(5);
      const state = await qr(runner({ readOnly: true })).state(sessionId);
      assert.equal(state.paused, false);
      assert.deepEqual(
        state.phones.map((phone) => [phone.phoneNumber, phone.left, phone.removed]),
        [
          [1, false, false],
          [2, false, false],
          [3, false, false],
        ],
      );
      assert.equal(state.phones[1].participantReference, phone2);

      // Decision 2: staff pause; a QR scan is refused and a staff code still works; resume.
      // (A code issued just before the pause stays outstanding; the database check uses it.)
      assert.equal((await issue(20, 84, 109, 6)).status, "Issued");
      clock = at(6);
      assert.deepEqual(
        await qr().setPaused({
          operationReference: id(110),
          diningSessionReference: sessionId,
          paused: true,
          actorReference: id(8),
          observedAt: at(6),
        }),
        { status: "Applied" },
      );
      // A replay of the same staff action applies nothing new; the opposite one is a conflict.
      assert.deepEqual(
        await qr().setPaused({
          operationReference: id(110),
          diningSessionReference: sessionId,
          paused: true,
          actorReference: id(8),
          observedAt: at(6),
        }),
        { status: "Applied" },
      );
      await assert.rejects(
        qr().setPaused({
          operationReference: id(110),
          diningSessionReference: sessionId,
          paused: false,
          actorReference: id(8),
          observedAt: at(6),
        }),
        { code: "DINING_SESSION_IDEMPOTENCY_CONFLICT" },
      );
      assert.deepEqual(await issue(20, 85, 111, 7), { status: "Refused", reason: "Paused" });
      // The database refuses a QR issue while paused even if the store's check were skipped.
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_qr_join_issue (tenant_id,brand_id,store_id,operation_id,session_id,guest_session_id,capability_id,intent_hash,occurred_at) SELECT tenant_id,brand_id,store_id,$1,session_id,$2,capability_id,'sha256:x',$3 FROM rms_dining.dining_join_capability WHERE session_id=$4 AND status='Active'",
          [id(112), id(85), at(7), sessionId],
        ),
        /QR joining is paused/u,
      );
      const staffCode = await staffRegenerate(sessionId, 20, 31, 7);
      assert.equal(staffCode.status, "Issued");
      guestTable = id(20);
      assert.equal((await join(staffCode.joinCredential, 85, 605, 7)).status, "Joined");
      clock = at(8);
      assert.deepEqual(
        await qr().setPaused({
          operationReference: id(113),
          diningSessionReference: sessionId,
          paused: false,
          actorReference: id(8),
          observedAt: at(8),
        }),
        { status: "Applied" },
      );
      assert.equal((await scanAndJoin(20, 86, 114, 8)).status, "Joined");

      // Decision 3: staff take phone 2 off the table; it can no longer act for the table.
      assert.notEqual(await atTable(sessionId, phone2, 9), null);
      clock = at(9);
      assert.deepEqual(
        await qr().remove({
          operationReference: id(120),
          diningSessionReference: sessionId,
          participantReference: phone2,
          actorReference: id(8),
          observedAt: at(9),
        }),
        { status: "Removed" },
      );
      assert.equal(await atTable(sessionId, phone2, 9), null);
      assert.deepEqual(
        await qr().remove({
          operationReference: id(121),
          diningSessionReference: sessionId,
          participantReference: phone2,
          actorReference: id(8),
          observedAt: at(9),
        }),
        { status: "AlreadyRemoved" },
      );
      const afterRemoval = await qr(runner({ readOnly: true })).state(sessionId);
      assert.deepEqual(
        afterRemoval.phones.map((phone) => [phone.phoneNumber, phone.left, phone.removed]),
        [
          [1, false, false],
          [2, true, true],
          [3, false, false],
          [4, false, false],
          [5, false, false],
        ],
      );
      const removalAudit = (
        await admin.query(
          "SELECT actor_type,actor_reference FROM platform_audit.audit_record WHERE action_code='DINING_QR_JOIN_REMOVE'",
        )
      ).rows;
      assert.equal(removalAudit.length, 1);

      // Decision 8: at most 12 QR joins per table in any 10 minutes (5 so far, from minute 2).
      for (let n = 0; n < 7; n += 1)
        assert.equal((await issue(20, 130 + n, 130 + n, 10)).status, "Issued");
      assert.deepEqual(await issue(20, 140, 140, 11), {
        status: "Refused",
        reason: "TooManyJoins",
      });
      // Once the window has passed, joining works again.
      assert.equal((await scanAndJoin(20, 141, 141, 13)).status, "Joined");

      // A table that is checking out cannot be joined by QR.
      guestTable = id(22);
      const closingStart = await sessions.start({
        tableReference: id(22),
        expectedAssignmentVersion: 2,
        operationReference: id(34),
        joinKind: "HumanCode",
        requestedAt: at(20),
      });
      const closingId = closingStart.session.diningSessionReference;
      const closingHost = (await scanAndJoin(22, 90, 150, 21)).participant.participantReference;
      const hashes = { hashIntent: digest, equals: (left, right) => left === right };
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
            guestSessionReference: id(90),
            participantReference: closingHost,
            diningSessionReference: closingId,
            storeReference: id(3),
            status: "CurrentHost",
            observedAt: input.observedAt,
            audit: {
              ...audit(
                `DINING_SESSION_CLOSING_${input.operation.toUpperCase()}`,
                closingId,
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
            diningSessionReference: closingId,
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
                  sourceReference: closingId,
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
      const closed = await closing.begin({
        diningSessionReference: closingId,
        operationReference: id(181),
        expectedSessionVersion: (await reader.loadSession(closingId)).version,
        requestedAt: at(22),
      });
      assert.equal(closed.session.phase, "Closing");
      assert.deepEqual(await issue(22, 91, 151, 23), { status: "Refused", reason: "CheckingOut" });

      // History is append-only and scoped to its Store.
      for (const table of [
        "dining_qr_join_issue",
        "dining_qr_join_control",
        "dining_participant_removal",
      ]) {
        await assert.rejects(admin.query(`UPDATE rms_dining.${table} SET occurred_at=occurred_at`));
        await assert.rejects(admin.query(`DELETE FROM rms_dining.${table}`));
      }
      clock = at(24);
      await assert.rejects(
        qr(runner(), { ...scope, storeReference: id(90) })
          .state(sessionId)
          .then((other) => {
            if (other.phones.length !== 0) throw new Error("another store saw this table's phones");
            throw Object.assign(new Error("empty"), { code: "EMPTY" });
          }),
        { code: "EMPTY" },
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

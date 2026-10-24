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
  createPostgresDiningGuestInvitationStore,
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

// WP-2423 DEC-DINING-GUEST-INVITATION: the store and every Dining command run as a restricted
// NOBYPASSRLS role holding exactly the rendered pilot api grants; the owner client only reads
// counts and attempts the forbidden writes.
it("lets the table Host invite the next guest with a one-time, scoped, expiring code", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_guest_invite" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423gi_${context.runId}`,
      worker = `wp2423gi_w_${context.runId}`,
      staffRole = `wp2423gi_s_${context.runId}`;
    assert.match(role, /^wp2423gi_[a-f0-9]+$/u);
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
      const invitationAudit = (input) => ({
        auditId: id(++sequence),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "System" },
        actionCode: "DINING_JOIN_INVITATION_ISSUE",
        targetType: "DiningTable",
        targetId: input.tableReference,
        reasonCode: "HOST_INVITED_GUEST",
        correlationId: input.command.operationReference,
        occurredAt: input.command.observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const invitations = (selected = runner()) =>
        createPostgresDiningGuestInvitationStore(selected, {
          scope,
          credentials,
          pepperVersion: 1,
          now: () => clock,
          // The API proves the caller's own current Guest identity and binding here.
          authorize: async () => authorized,
          audit: invitationAudit,
        });
      const invite = (participantReference, sessionId, operation, minute, selected) => {
        clock = at(minute);
        return invitations(selected).issue({
          operationReference: id(operation),
          ...scope,
          diningSessionReference: sessionId,
          participantReference,
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
       (SELECT count(*)::integer FROM rms_dining.dining_join_capability) AS capabilities,
       (SELECT count(*)::integer FROM rms_dining.dining_guest_invitation_operation) AS invitations,
       (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_JOIN_INVITATION_ISSUE') AS audits`)
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

      // Only the Host may invite: another participant, a stranger or an unauthorized caller cannot.
      const before = await counts();
      assert.deepEqual(await invite(guest, sessionId, 50, 5), {
        status: "Refused",
        reason: "NotHost",
        retryAt: null,
      });
      assert.deepEqual(await invite(id(999), sessionId, 51, 5), {
        status: "Refused",
        reason: "NotHost",
        retryAt: null,
      });
      authorized = false;
      await assert.rejects(invite(host, sessionId, 52, 5), {
        code: "DINING_SESSION_PERMISSION_DENIED",
      });
      authorized = true;
      clock = at(5);
      assert.equal(
        await invitations().eligibility({
          operationReference: id(53),
          ...scope,
          diningSessionReference: sessionId,
          participantReference: guest,
          observedAt: at(5),
        }),
        "NotHost",
      );
      assert.equal(
        await invitations(runner({ readOnly: true })).eligibility({
          operationReference: id(53),
          ...scope,
          diningSessionReference: sessionId,
          participantReference: host,
          observedAt: at(5),
        }),
        "Allowed",
      );
      assert.deepEqual(await counts(), before);

      // Issue -> join once -> reuse refused.
      const first = await invite(host, sessionId, 100, 6);
      assert.equal(first.status, "Issued");
      assert.match(first.joinCredential, /^[0-9]{6}$/u);
      assert.equal(first.capability.generation, 3);
      assert.equal(first.capability.expiresAt, "2026-10-17T09:21:00.000Z");
      assert.deepEqual(await counts(), {
        capabilities: before.capabilities + 1,
        invitations: 1,
        audits: 1,
      });
      const stored = (
        await admin.query(
          "SELECT record_json,participant_id FROM rms_dining.dining_guest_invitation_operation WHERE operation_id=$1",
          [id(100)],
        )
      ).rows[0];
      assert.equal(stored.participant_id, host);
      assert.equal(JSON.stringify(stored.record_json).includes(first.joinCredential), false);
      const auditRow = (
        await admin.query(
          "SELECT actor_type,source_channel,target_id FROM platform_audit.audit_record WHERE action_code='DINING_JOIN_INVITATION_ISSUE'",
        )
      ).rows[0];
      assert.deepEqual(auditRow, {
        actor_type: "System",
        source_channel: "CUSTOMER_PWA",
        target_id: id(20),
      });
      // Replay returns the original issuance without the code; another Host is a conflict.
      assert.deepEqual(await invite(host, sessionId, 100, 6), {
        status: "AlreadyApplied",
        capability: first.capability,
      });
      await assert.rejects(invite(guest, sessionId, 100, 6), {
        code: "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      });
      assert.equal((await join(first.joinCredential, 82, 42, 7)).status, "Joined");
      assert.deepEqual(await join(first.joinCredential, 83, 43, 7), {
        status: "DiningJoinRefused",
        reason: "CodeUsed",
      });

      // Regeneration: a newer code (from the Host) invalidates the earlier one.
      const replaced = await invite(host, sessionId, 101, 8);
      const current = await invite(host, sessionId, 102, 9);
      assert.equal(current.status, "Issued");
      assert.deepEqual(await join(replaced.joinCredential, 83, 44, 9), {
        status: "DiningJoinRefused",
        reason: "CodeNotAccepted",
      });
      assert.equal((await join(current.joinCredential, 83, 45, 9)).status, "Joined");

      // Staff replacement still works and replaces the Host's outstanding code.
      const hostOutstanding = await invite(host, sessionId, 103, 10);
      const staffReplacement = await staffRegenerate(sessionId, 20, 32, 11);
      assert.equal(staffReplacement.status, "Issued");
      assert.deepEqual(await join(hostOutstanding.joinCredential, 84, 46, 11), {
        status: "DiningJoinRefused",
        reason: "CodeNotAccepted",
      });
      assert.equal((await join(staffReplacement.joinCredential, 84, 47, 11)).status, "Joined");
      // ... and the Host can invite after staff did.
      const afterStaff = await invite(host, sessionId, 104, 12);
      assert.equal(afterStaff.status, "Issued");

      // Expiry: an unused code stops working after 15 minutes.
      assert.deepEqual(await join(afterStaff.joinCredential, 85, 48, 28), {
        status: "DiningJoinRefused",
        reason: "CodeNotAccepted",
      });

      // A failed audit write leaves no code, record or audit behind.
      const beforeFailure = await counts();
      await assert.rejects(invite(host, sessionId, 105, 29, runner({ failAudit: true })), {
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), beforeFailure);

      // Issuance budget: ten guest-issued codes per Session in any ten minutes.
      for (let minute = 30; minute < 40; minute++)
        assert.equal((await invite(host, sessionId, 110 + minute, minute)).status, "Issued");
      assert.deepEqual(await invite(host, sessionId, 160, 39), {
        status: "Refused",
        reason: "TooManyInvitations",
        retryAt: at(40),
      });
      // Staff are not limited by the guest budget.
      assert.equal((await staffRegenerate(sessionId, 20, 33, 39)).status, "Issued");
      const afterWindow = await invite(host, sessionId, 161, 40);
      assert.equal(afterWindow.status, "Issued");

      // Table reassignment: the Move invalidates the code and the Host's next invitation waits
      // for staff to issue the moved table's code.
      const moved = await tableService.moveSession({
        operationReference: id(170),
        diningSessionReference: sessionId,
        sourceTableReference: id(20),
        targetTableReference: id(21),
        expectedSessionVersion: (await reader.loadSession(sessionId)).version,
        expectedSourceTableVersion: (await tableReader.loadTable(id(20))).aggregateVersion,
        expectedTargetTableVersion: (await tableReader.loadTable(id(21))).aggregateVersion,
        partySize: 4,
        observedAt: at(41),
      });
      assert.equal(moved.status, "Applied");
      guestTable = id(21);
      assert.deepEqual(await join(afterWindow.joinCredential, 86, 49, 41), {
        status: "DiningJoinRefused",
        reason: "CodeNotAccepted",
      });
      assert.deepEqual(await invite(host, sessionId, 171, 42), {
        status: "Refused",
        reason: "TableChanged",
        retryAt: null,
      });

      // Session closure: a second table whose Host starts closing.
      guestTable = id(22);
      const second = await sessions.start({
        tableReference: id(22),
        expectedAssignmentVersion: 2,
        operationReference: id(34),
        joinKind: "HumanCode",
        requestedAt: at(43),
      });
      const secondId = second.session.diningSessionReference;
      const secondHost = (await join(second.joinCredential, 90, 60, 44)).participant
        .participantReference;
      const pending = await invite(secondHost, secondId, 180, 45);
      assert.equal(pending.status, "Issued");
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
            participantReference: secondHost,
            diningSessionReference: secondId,
            storeReference: id(3),
            status: "CurrentHost",
            observedAt: input.observedAt,
            audit: {
              ...audit(
                `DINING_SESSION_CLOSING_${input.operation.toUpperCase()}`,
                secondId,
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
            diningSessionReference: secondId,
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
                  sourceReference: secondId,
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
        diningSessionReference: secondId,
        operationReference: id(181),
        expectedSessionVersion: (await reader.loadSession(secondId)).version,
        requestedAt: at(46),
      });
      assert.equal(closed.session.phase, "Closing");
      assert.deepEqual(await join(pending.joinCredential, 91, 61, 46), {
        status: "DiningJoinRefused",
        reason: "CodeNotAccepted",
      });
      assert.deepEqual(await invite(secondHost, secondId, 182, 47), {
        status: "Refused",
        reason: "NotHost",
        retryAt: null,
      });

      // History is append-only, scoped to its Store and guarded at the database.
      await assert.rejects(
        admin.query("UPDATE rms_dining.dining_guest_invitation_operation SET intent_hash=$1", [
          "b".repeat(64),
        ]),
        (e) => e.code === "55000",
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_dining.dining_guest_invitation_operation"),
        (e) => e.code === "55000",
      );
      const forged = (
        await admin.query(
          "SELECT * FROM rms_dining.dining_guest_invitation_operation WHERE operation_id=$1",
          [id(100)],
        )
      ).rows[0];
      // A non-Host participant can never be recorded as the issuer.
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_guest_invitation_operation (tenant_id,brand_id,store_id,operation_id,session_id,participant_id,capability_id,intent_hash,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            id(1),
            id(2),
            id(3),
            id(190),
            sessionId,
            guest,
            forged.capability_id,
            forged.intent_hash,
            forged.occurred_at,
            JSON.stringify({
              ...forged.record_json,
              operationReference: id(190),
              participantReference: guest,
            }),
          ],
        ),
        (e) => e.code === "23514",
      );
      await runner({ readOnly: true }).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(90)],
        );
        assert.equal(
          (await tx.query("SELECT 1 FROM rms_dining.dining_guest_invitation_operation", [])).rows
            .length,
          0,
        );
      });
      clock = at(48);
      await assert.rejects(
        createPostgresDiningGuestInvitationStore(runner(), {
          scope: { ...scope, storeReference: id(90) },
          credentials,
          pepperVersion: 1,
          now: () => clock,
          authorize: async () => true,
          audit: invitationAudit,
        }).issue({
          operationReference: id(191),
          ...scope,
          diningSessionReference: sessionId,
          participantReference: host,
          observedAt: at(48),
        }),
        { code: "DINING_SESSION_PERMISSION_DENIED" },
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

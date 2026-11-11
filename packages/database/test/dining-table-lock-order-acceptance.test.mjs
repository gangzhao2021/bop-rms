import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { setTimeout } from "node:timers";
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
  createPostgresDiningSessionMoveStore,
  createPostgresDiningStaffCallStore,
  createPostgresDiningPublicTableReader,
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

// WP-2423 M68 (c) DEC-DATABASE-RESILIENCE: every Dining command and the guest's table read
// run as a restricted NOBYPASSRLS role holding exactly the rendered pilot api grants (table setup
// as a separate staff role, as in dining-staff-call); the owner client only reads counts and locks.
it("two guests calling staff at one table at once never deadlock: one call, one already asked", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_lock_order" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423lo_${context.runId}`,
      worker = `wp2423lo_w_${context.runId}`,
      staffRole = `wp2423lo_s_${context.runId}`;
    assert.match(role, /^wp2423lo_[a-f0-9]+$/u);
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
        // The guest's table context needs the table's QR code live.
        await tableService.executeTable({
          action: "IssueQr",
          operationReference: id(++sequence),
          candidate: transitionDiningTable(
            transitionDiningTable(draft, "Publish", at(0)),
            "IssueQr",
            at(0),
          ),
          expectedAggregateVersion: 2,
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
      const hashes = { hashIntent: digest, equals: (left, right) => left === right };
      const asGuest = (participantReference, sessionId, operation, minute) => ({
        operationReference: id(operation),
        ...scope,
        diningSessionReference: sessionId,
        participantReference,
        observedAt: at(minute),
      });
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
        expectedAssignmentVersion: 3,
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

      // WP-2423 M68 (c): two guests at one table tap "call staff" at the same moment. In the pilot
      // each call's own transaction first proves the guest's current table context (the Dining
      // public table read, lent this transaction by the guest binding), then the staff call takes
      // its advisory key and locks the table row. The read used to lock the row FOR SHARE, so
      // guest 2 held a share and waited for guest 1's advisory key while guest 1 waited on guest
      // 2's share for its FOR UPDATE: PostgreSQL broke the cycle (40P01) and a guest saw "try
      // again". With the one lock order (advisory key, then table row; the guest read locks
      // nothing) one call is made and the other is told staff are already asked.
      const deadlocks = async () =>
        Number(
          (
            await admin.query(
              "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
            )
          ).rows[0].deadlocks,
        );
      const before = await deadlocks();
      let openGate;
      const gate = new Promise((resolve) => {
        openGate = resolve;
      });
      const guestContext = async (tx, observedAt) =>
        (await createPostgresDiningPublicTableReader({
          transaction: tx,
          scope,
          authorize: async () => true,
        }).read({ tableReference: id(20), purpose: "DiningAdmission", observedAt })) !== null;
      const fenced = (first) => {
        let calls = 0;
        return createPostgresDiningStaffCallStore(runner(), {
          scope,
          ...hashes,
          authorize: async (tx, command) => {
            calls += 1;
            const current = await guestContext(tx, command.observedAt);
            // The first guest's proof is held open until the second guest's call is underway.
            if (first && calls === 1) await gate;
            return current;
          },
        });
      };
      const firstCall = fenced(true).call(asGuest(guest, sessionId, 300, 6), "Question");
      const secondCall = fenced(false).call(asGuest(host, sessionId, 301, 6), "TableNeeds");
      // Deterministic barrier: the second call is waiting on a lock, or already answered.
      let secondDone = false;
      const settled = secondCall.then(
        () => (secondDone = true),
        () => (secondDone = true),
      );
      for (let attempt = 0; attempt < 200 && !secondDone; attempt += 1) {
        const waiting = await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND pid<>pg_backend_pid()",
        );
        if (waiting.rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      openGate();
      const results = await Promise.allSettled([firstCall, secondCall, settled]);
      assert.deepEqual(
        results.slice(0, 2).map((result) => result.status),
        ["fulfilled", "fulfilled"],
        JSON.stringify(results.map((result) => result.reason?.code ?? result.reason?.message)),
      );
      const statuses = results
        .slice(0, 2)
        .map((result) => result.value.status)
        .sort();
      assert.deepEqual(statuses, ["AlreadyOpen", "Called"]);
      assert.equal(await deadlocks(), before);
      assert.deepEqual(await counts(), { calls: 1, closures: 0 });
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

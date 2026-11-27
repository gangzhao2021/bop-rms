import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
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
  createPostgresDiningSessionMoveStore,
  createPostgresDiningQrJoinStore,
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

/**
 * WP-2423 (join-code-unique, batch 46): a table code is six digits, so two open tables of a Store
 * could be given the same code at once; the guest presenting it then matched two visits and was
 * told the code was not accepted. No table is ever issued a code that another open table's guest
 * could present now, nor its own previous code: opening a table, staff's new code and a guest's
 * QR scan each draw again under the table's lock, and only after the bound is it an outage. The
 * code generator is injected to force each collision. Every Dining command runs as a restricted
 * NOBYPASSRLS role holding exactly the rendered pilot api grants; table configuration runs as a
 * separate staff role (as in dining-qr-join). Synthetic TEST references.
 */
it("never gives an open table a code another open table's guest could present now", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_join_code" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423jcu_${context.runId}`,
      worker = `wp2423jcu_w_${context.runId}`,
      staffRole = `wp2423jcu_s_${context.runId}`;
    assert.match(role, /^wp2423jcu_[a-f0-9]+$/u);
    let active = 0;
    let sequence = 1000;
    let code = 700000;
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
      // Injected six-digit generator (HumanCode, as the pilot issues): the next queued codes, then
      // fresh distinct ones.
      const queued = [];
      const credentials = {
        generateReference: () => id(++sequence),
        generateJoinCredential: () => queued.shift() ?? String(++code),
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
      const open = (table, operation, minute) =>
        sessions.start({
          tableReference: id(table),
          expectedAssignmentVersion: 2,
          operationReference: id(operation),
          joinKind: "HumanCode",
          requestedAt: at(minute),
        });
      const sessionCount = async () =>
        (await admin.query("SELECT count(*)::integer AS n FROM rms_dining.dining_session")).rows[0]
          .n;
      // Every code a guest could present now: one current visit each, never shared.
      const activeCodes = async () =>
        (
          await admin.query(
            "SELECT c.capability_snapshot->>'selectorHash' AS selector, count(*)::integer AS n FROM rms_dining.dining_join_capability c JOIN rms_dining.dining_session s ON s.session_id=c.session_id WHERE c.status='Active' AND s.phase='Active' GROUP BY 1",
          )
        ).rows;

      await configure(20);
      await configure(21);
      await configure(22);
      await configure(23);
      await configure(24);

      // Staff open table 20: its code is 111111.
      queued.push("111111");
      const first = await open(20, 30, 1);
      assert.equal(first.status, "Issued");
      assert.equal(first.joinCredential, "111111");
      const firstSession = first.session.diningSessionReference;

      // Staff open table 21; the first draw is table 20's code, so table 21 is given another.
      queued.push("111111", "222222");
      const second = await open(21, 31, 2);
      assert.equal(second.status, "Issued");
      assert.equal(second.joinCredential, "222222");
      const secondSession = second.session.diningSessionReference;

      // Staff give table 21 a new code: never table 20's current code, never its own previous one.
      queued.push("111111", "222222", "333333");
      const regenerated = await staffRegenerate(secondSession, 21, 40, 3);
      assert.equal(regenerated.status, "Issued");
      assert.equal(regenerated.joinCredential, "333333");

      // A guest scans table 20's QR code: never table 21's current code.
      queued.push("333333", "444444");
      const scanned = await issue(20, 80, 100, 4);
      assert.equal(scanned.status, "Issued");
      assert.equal(scanned.joinCredential, "444444");
      assert.deepEqual(queued, []);
      assert.ok((await activeCodes()).every((row) => row.n === 1));

      // Each guest holding the right code joins the right table.
      guestTable = id(20);
      const atTwenty = await join("444444", 80, 600, 4);
      assert.equal(atTwenty.status, "Joined", JSON.stringify(atTwenty));
      assert.equal(atTwenty.session.diningSessionReference, firstSession);
      guestTable = id(21);
      const atTwentyOne = await join("333333", 81, 601, 4);
      assert.equal(atTwentyOne.status, "Joined", JSON.stringify(atTwentyOne));
      assert.equal(atTwentyOne.session.diningSessionReference, secondSession);

      // Table 20's next guest is waiting with 933333. Staff open table 22 while every draw is that
      // code: an outage (never a refusal), and nothing is written.
      queued.push("933333");
      assert.equal((await staffRegenerate(firstSession, 20, 41, 5)).joinCredential, "933333");
      const inUse = (await regenerationReader.resolveActiveJoin(firstSession)).capability;
      const sessionsBefore = await sessionCount();
      for (let n = 0; n < 8; n += 1) queued.push("933333");
      await assert.rejects(open(22, 32, 6), { code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(queued, []);
      assert.equal(await sessionCount(), sessionsBefore);
      assert.equal((await tableReader.loadTable(id(22))).activeDiningSessionReference, null);
      assert.equal(
        (await regenerationReader.resolveActiveJoin(firstSession)).capability.capabilityReference,
        inUse.capabilityReference,
      );
      // Staff try again (a new attempt, as the screen's retry): table 22 opens with a free code.
      queued.push("555555");
      assert.equal((await open(22, 33, 6)).joinCredential, "555555");

      // Two tables opened at the same moment drawing the same code: one keeps it, the other draws
      // again (the code's lock serializes the two checks).
      queued.push("666666", "666666", "777777", "777777");
      const together = await Promise.all([open(23, 34, 7), open(24, 35, 7)]);
      assert.deepEqual(together.map((result) => result.status).sort(), ["Issued", "Issued"]);
      assert.notEqual(together[0].joinCredential, together[1].joinCredential);
      assert.ok((await activeCodes()).every((row) => row.n === 1));

      // The records never hold a code.
      const stored = JSON.stringify(
        (await admin.query("SELECT capability_snapshot FROM rms_dining.dining_join_capability"))
          .rows,
      );
      for (const value of ["111111", "222222", "333333", "444444", "555555", "933333"])
        assert.equal(stored.includes(value), false);
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 180_000);

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
  createPostgresDiningPaymentTimingStore,
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

// WP-2423 DEC-DINE-IN-PAY-LATER: the Store's dine-in payment timing and the timing each table is
// opened with. The store and every Dining command run as a restricted NOBYPASSRLS role holding
// exactly the rendered pilot api grants; the owner client only reads and attempts forbidden writes.
it("records the Store's dine-in payment timing and the timing each table is opened with", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pay_timing" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2423pt_${context.runId}`,
      worker = `wp2423pt_w_${context.runId}`,
      staffRole = `wp2423pt_s_${context.runId}`;
    assert.match(role, /^wp2423pt_[a-f0-9]+$/u);
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
      const timing = createPostgresDiningPaymentTimingStore({
        scope,
        hashIntent: digest,
        equals: (a, b) => a === b,
      });
      let authorized = true;
      const guard = () => authorized;
      // Staff reads and changes borrow one authorized merchant transaction, as the API does.
      const staff = (work) => runner().run((tx) => work(tx));
      const change = (operation, paymentTiming, expectedVersion, minute) =>
        staff((tx) =>
          timing.change(
            tx,
            {
              operationReference: id(operation),
              paymentTiming,
              expectedVersion,
              actorReference: id(8),
              observedAt: at(minute),
            },
            guard,
          ),
        );
      const sessionTiming = async (sessionId) =>
        (await staff((tx) => timing.loadSessionTimings(tx, [sessionId]))).get(sessionId);
      const start = (table, operation, minute) =>
        sessions.start({
          tableReference: id(table),
          expectedAssignmentVersion: 2,
          operationReference: id(operation),
          joinKind: "HumanCode",
          requestedAt: at(minute),
        });

      await configure(20);
      await configure(21);
      await configure(22);
      // A Store that never chose pays first; a table opened then is PayFirst.
      assert.deepEqual(await staff((tx) => timing.load(tx, guard)), {
        paymentTiming: "PayFirst",
        version: 0,
        changedAt: null,
        changedByActorReference: null,
      });
      const before = await start(20, 30, 1);
      assert.equal(await sessionTiming(before.session.diningSessionReference), "PayFirst");

      // The Owner or a Store Manager chooses pay later: a new version naming who and when.
      const first = await change(40, "PayLater", 0, 2);
      assert.equal(first.status, "Changed");
      assert.deepEqual(first.timing, {
        paymentTiming: "PayLater",
        version: 1,
        changedAt: at(2),
        changedByActorReference: id(8),
      });
      // The same operation again is the same change; another made from a stale read is refused.
      assert.equal((await change(40, "PayLater", 0, 2)).status, "AlreadyChanged");
      const stale = await change(41, "PayFirst", 0, 3);
      assert.equal(stale.status, "Conflict");
      assert.equal(stale.timing.version, 1);
      await assert.rejects(
        change(40, "PayFirst", 0, 3),
        (error) => error?.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      );

      // A table opened now is pay later; the one already open keeps paying first.
      const after = await start(21, 31, 4);
      assert.equal(await sessionTiming(after.session.diningSessionReference), "PayLater");
      assert.equal(await sessionTiming(before.session.diningSessionReference), "PayFirst");
      const recorded = await admin.query(
        "SELECT payment_timing,timing_version,recorded_at FROM rms_dining.dining_session_payment_timing WHERE session_id=$1",
        [after.session.diningSessionReference],
      );
      assert.deepEqual(recorded.rows, [
        { payment_timing: "PayLater", timing_version: "1", recorded_at: new Date(at(4)) },
      ]);

      // Back to pay first: only tables opened after it.
      assert.equal((await change(42, "PayFirst", 1, 5)).status, "Changed");
      const later = await start(22, 32, 6);
      assert.equal(await sessionTiming(later.session.diningSessionReference), "PayFirst");
      assert.equal(await sessionTiming(after.session.diningSessionReference), "PayLater");

      // The merchant guard is checked: nothing is read or written without it.
      authorized = false;
      await assert.rejects(
        change(43, "PayLater", 2, 7),
        (error) => error?.code === "DINING_SESSION_PERMISSION_DENIED",
      );
      await assert.rejects(
        staff((tx) => timing.load(tx, guard)),
        (error) => error?.code === "DINING_SESSION_PERMISSION_DENIED",
      );
      authorized = true;
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_dining.store_dining_payment_timing"))
          .rows[0].n,
        2,
      );

      // Another Store sees none of it.
      const other = createPostgresDiningPaymentTimingStore({
        scope: { ...scope, storeReference: id(4) },
        hashIntent: digest,
        equals: (a, b) => a === b,
      });
      assert.equal((await staff((tx) => other.load(tx, guard))).version, 0);
      assert.equal(
        (
          await staff((tx) => other.loadSessionTimings(tx, [after.session.diningSessionReference]))
        ).get(after.session.diningSessionReference),
        "PayFirst",
      );

      // Append-only: the api role cannot change or remove history, nor write a table's timing.
      for (const sql of [
        "UPDATE rms_dining.store_dining_payment_timing SET payment_timing='PayFirst'",
        "DELETE FROM rms_dining.store_dining_payment_timing",
        `INSERT INTO rms_dining.dining_session_payment_timing (tenant_id,brand_id,store_id,session_id,payment_timing,timing_version,recorded_at) VALUES ('${id(1)}','${id(2)}','${id(3)}','${later.session.diningSessionReference}','PayLater',1,now())`,
      ])
        await assert.rejects(
          runner().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(2), id(3)],
            );
            return tx.query(sql, []);
          }),
        );
      // Even the owner cannot rewrite it.
      await assert.rejects(
        admin.query(
          "UPDATE rms_dining.dining_session_payment_timing SET payment_timing='PayFirst'",
        ),
        /append-only/u,
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
});

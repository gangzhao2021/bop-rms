import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
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
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902275-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("starts Session, occupies Table and records capability/history/Audit atomically", async () => {
  await withIsolatedDatabase({ caseId: "wp2275_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2275_${context.runId}`;
    assert.match(role, /^wp2275_[a-f0-9]+$/u);
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
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
      function service(selectedWriter = writer, beforeWrite = async () => undefined) {
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
                audit: audit("DINING_SESSION_START", input.tableReference, input.observedAt),
              };
            },
          },
          guests: { resolve: async () => null },
          abuse: { admit: async () => "Cooldown" },
          store: {
            ...reader,
            start: async (input) => {
              await beforeWrite();
              return selectedWriter.start(input);
            },
            resolveJoinState: async () => null,
            resolveActiveJoin: async () => null,
            resolveJoinOperation: async () => null,
            resolveRegenerationOperation: async () => null,
            join: async () => {
              throw new Error("synthetic unconfigured Join");
            },
            regenerate: async () => {
              throw new Error("synthetic unconfigured regeneration");
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
        (SELECT count(*)::integer FROM rms_dining.dining_session) AS sessions,
        (SELECT count(*)::integer FROM rms_dining.dining_join_capability) AS capabilities,
        (SELECT count(*)::integer FROM rms_dining.dining_session_start_operation) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_START') AS audits`)
        ).rows[0];
      const equalCounts = (n) => ({ sessions: n, capabilities: n, operations: n, audits: n });
      await configure(20);
      const initial = command(20, 30);
      const issued = await service().start(initial);
      assert.equal(issued.status, "Issued");
      assert.equal(issued.session.tableAssignmentVersion, 2);
      assert.equal((await tableReader.loadTable(id(20))).aggregateVersion, 3);
      assert.equal(
        (await tableReader.loadTable(id(20))).activeDiningSessionReference,
        issued.session.diningSessionReference,
      );
      assert.deepEqual(await counts(), equalCounts(1));
      const replay = await service().start(initial);
      assert.equal(replay.status, "AlreadyApplied");
      assert(!("joinCredential" in replay));
      assert.deepEqual(replay.session, issued.session);
      assert.deepEqual(await counts(), equalCounts(1));
      await assert.rejects(
        service().start({ ...initial, joinKind: "HumanCode" }),
        (e) => e.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT",
      );
      const serialized = (
        await admin.query(
          "SELECT record_json::text AS record FROM rms_dining.dining_session_start_operation",
        )
      ).rows[0].record;
      assert(!serialized.includes(issued.joinCredential));
      const occupied = await tableReader.loadTable(id(20));
      await tableService.executeTable({
        action: "IssueQr",
        operationReference: id(31),
        candidate: transitionDiningTable(occupied, "IssueQr", at(2)),
        expectedAggregateVersion: 3,
        observedAt: at(2),
      });
      assert.equal(
        (await reader.loadSession(issued.session.diningSessionReference)).tableAssignmentVersion,
        2,
      );
      assert.deepEqual((await service().start(initial)).session, issued.session);
      await configure(21);
      const lost = command(21, 32);
      await assert.rejects(
        service(
          createPostgresDiningSessionStartStore(runner({ loseAck: true }), scope, credentials),
        ).start(lost),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await counts(), equalCounts(2));
      assert.equal((await service().start(lost)).status, "AlreadyApplied");
      await configure(22);
      await assert.rejects(
        service(
          createPostgresDiningSessionStartStore(runner({ failAudit: true }), scope, credentials),
        ).start(command(22, 33)),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await counts(), equalCounts(2));
      assert.equal((await tableReader.loadTable(id(22))).aggregateVersion, 2);
      assert.equal((await tableReader.loadTable(id(22))).activeDiningSessionReference, null);
      assert.equal(await reader.resolveStartOperation(id(33)), null);
      async function race(commands) {
        let arrivals = 0;
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const timer = setTimeout(() => release(), 3000);
        const racing = service(writer, async () => {
          if (++arrivals === commands.length) release();
          await gate;
        });
        try {
          const results = await Promise.allSettled(commands.map((value) => racing.start(value)));
          assert.equal(arrivals, commands.length);
          return results;
        } finally {
          clearTimeout(timer);
        }
      }
      const competing = await race([command(22, 34), command(22, 35)]);
      assert.equal(competing.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(
        competing.find((value) => value.status === "rejected").reason.code,
        "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), equalCounts(3));
      await configure(23);
      const same = await race([command(23, 36), command(23, 36)]);
      assert(same.every((value) => value.status === "fulfilled"));
      assert.deepEqual(same.map((value) => value.value.status).sort(), [
        "AlreadyApplied",
        "Issued",
      ]);
      assert.deepEqual(same[0].value.session, same[1].value.session);
      assert.deepEqual(await counts(), equalCounts(4));
      await configure(24);
      await assert.rejects(
        service(writer, async () => {
          const table = await tableReader.loadTable(id(24));
          await tableService.executeTable({
            action: "IssueQr",
            operationReference: id(38),
            candidate: transitionDiningTable(table, "IssueQr", at(1)),
            expectedAggregateVersion: 2,
            observedAt: at(1),
          });
        }).start(command(24, 37)),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), equalCounts(4));
      assert.equal((await tableReader.loadTable(id(24))).activeDiningSessionReference, null);
      for (const field of ["tenantReference", "brandReference", "storeReference"]) {
        const foreign = createPostgresDiningSessionStartStore(
          runner({ readOnly: true }),
          { ...scope, [field]: id(90) },
          credentials,
        );
        assert.equal(await foreign.loadSession(issued.session.diningSessionReference), null);
        assert.equal(await foreign.resolveStartOperation(id(30)), null);
      }
      await assert.rejects(
        runner({ readOnly: true }).run((tx) =>
          tx.query("UPDATE rms_dining.dining_table SET version=version+1", []),
        ),
        (e) => ["25006", "42501"].includes(e.code),
      );
      for (const table of [
        "dining_session",
        "dining_join_capability",
        "dining_session_start_operation",
      ])
        assert.equal((await admin.query(`DELETE FROM rms_dining.${table}`)).rowCount, 0);
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_session_start_operation SET intent_hash=intent_hash",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("UPDATE rms_dining.dining_session SET version=version+2")).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("UPDATE rms_dining.dining_join_capability SET version=version+2"))
          .rowCount,
        0,
      );
      assert.deepEqual(await counts(), equalCounts(4));
      const duplicateSession = { ...issued.session, diningSessionReference: id(90) };
      const insertSession = (client, snapshot, sessionId = id(90), storeId = id(3)) =>
        client.query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb,$7)",
          [sessionId, id(1), id(2), storeId, id(20), JSON.stringify(snapshot), at(1)],
        );
      await assert.rejects(
        insertSession(admin, duplicateSession),
        (error) => error.code === "23505",
      );
      await assert.rejects(
        insertSession(admin, { ...duplicateSession, brandReference: null }),
        (error) => error.code === "23514",
      );
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(3)],
          );
          return insertSession(tx, { ...duplicateSession, storeReference: id(91) }, id(90), id(91));
        }),
        (error) => error.code === "42501",
      );
      const duplicateCapability = { ...issued.capability, capabilityReference: id(92) };
      const insertCapability = (snapshot) =>
        admin.query(
          "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
          [
            id(92),
            id(1),
            id(2),
            id(3),
            issued.session.diningSessionReference,
            JSON.stringify(snapshot),
          ],
        );
      await assert.rejects(
        insertCapability(duplicateCapability),
        (error) => error.code === "23505",
      );
      await assert.rejects(
        insertCapability({ ...duplicateCapability, joinCredential: "synthetic-forbidden-field" }),
        (error) => error.code === "23514",
      );
      assert.deepEqual(await counts(), equalCounts(4));
      const originalStart = await reader.resolveStartOperation(id(30));
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_session_start_operation (operation_id,tenant_id,brand_id,store_id,session_id,intent_hash,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            id(93),
            id(1),
            id(2),
            id(3),
            issued.session.diningSessionReference,
            originalStart.operationIntentHash,
            JSON.stringify({
              ...originalStart,
              operationReference: id(93),
              capability: {
                ...originalStart.capability,
                joinCredential: "synthetic-forbidden-field",
              },
            }),
          ],
        ),
        (error) => error.code === "23514",
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

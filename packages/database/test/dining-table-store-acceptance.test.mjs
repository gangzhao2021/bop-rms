import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createDiningTable,
  createDiningTableService,
  createPostgresDiningTableStore,
  replaceDiningTableDraft,
  transitionDiningTable,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902272-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const references = {
  hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  equals: (a, b) => a === b,
};
it("persists Dining Table commands, immutable history and Audit atomically", async () => {
  await withIsolatedDatabase({ caseId: "wp2272_dining" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2272_${context.runId}`;
    assert.match(role, /^wp2272_[a-f0-9]+$/u);
    let active = 0;
    let sequence = 100;
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,platform_audit.audit_record TO ${role}`,
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
      const reader = createPostgresDiningTableStore(runner({ readOnly: true }), scope, references);
      const writer = createPostgresDiningTableStore(runner(), scope, references);
      function service(selectedWriter = writer) {
        return createDiningTableService({
          references,
          authorization: {
            async authorize(input) {
              return {
                ...scope,
                actorReference: id(8),
                purpose: "dining-table",
                permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
                audit: {
                  auditId: id(++sequence),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "User", reference: id(8) },
                  actionCode: `DINING_TABLE_${input.action.toUpperCase()}`,
                  targetType: "DiningTable",
                  targetId: input.targetReference,
                  reasonCode: "AUTHORIZED_OPERATION",
                  correlationId: id(9),
                  occurredAt: input.observedAt,
                  sourceChannel: "API",
                  dataClassification: "Internal",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          repository: {
            loadTable: reader.loadTable,
            resolveTableOperation: reader.resolveTableOperation,
            commitTable: selectedWriter.commitTable,
            loadSession: async () => null,
            resolveMoveOperation: async () => null,
            commitMove: async () => {
              throw new Error("synthetic unconfigured Move");
            },
          },
        });
      }
      const command = (action, operation, candidate, expected) => ({
        action,
        operationReference: id(operation),
        candidate,
        expectedAggregateVersion: expected,
        observedAt: candidate.observedAt,
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_table_operation) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const initial = createDiningTable({
        ...scope,
        tableReference: id(4),
        stableLabel: "T01",
        areaReference: id(5),
        areaCode: "MAIN",
        capacity: 4,
        accessibilityAttributes: ["STEP_FREE"],
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
      const create = command("CreateDraft", 20, initial, null);
      await service().executeTable(create);
      const original = await reader.resolveTableOperation(id(20));
      assert.deepEqual(original.table, initial);
      let current = replaceDiningTableDraft(initial, {
        stableLabel: "T01A",
        areaReference: id(5),
        areaCode: "MAIN",
        capacity: 6,
        accessibilityAttributes: ["STEP_FREE"],
        observedAt: at(1),
      });
      await service().executeTable(command("ReplaceDraft", 21, current, 1));
      for (const [action, minute] of [
        ["Publish", 2],
        ["IssueQr", 3],
        ["RevokeQr", 4],
        ["SetBlock", 5],
        ["ClearBlock", 6],
      ]) {
        const next = transitionDiningTable(
          current,
          action,
          at(minute),
          action === "SetBlock" ? "CLEANING" : null,
        );
        await service().executeTable(command(action, 20 + minute, next, current.aggregateVersion));
        current = next;
        assert.deepEqual(await reader.loadTable(id(4)), current);
      }
      assert.equal(current.aggregateVersion, 7);
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });
      const originalRetry = await service().executeTable(create);
      assert.equal(originalRetry.status, "AlreadyApplied");
      assert.deepEqual(originalRetry.table, initial);
      assert.deepEqual(await reader.resolveTableOperation(id(20)), original);
      assert.deepEqual(await reader.loadTable(id(4)), current);
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });

      const afterLoss = transitionDiningTable(current, "IssueQr", at(7));
      const lost = command("IssueQr", 27, afterLoss, current.aggregateVersion);
      await assert.rejects(
        service(
          createPostgresDiningTableStore(runner({ loseAck: true }), scope, references),
        ).executeTable(lost),
        (error) => error.code === "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await reader.loadTable(id(4)), afterLoss);
      assert.equal((await service().executeTable(lost)).status, "AlreadyApplied");
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      const auditFailure = command(
        "RevokeQr",
        28,
        transitionDiningTable(afterLoss, "RevokeQr", at(8)),
        afterLoss.aggregateVersion,
      );
      await assert.rejects(
        service(
          createPostgresDiningTableStore(runner({ failAudit: true }), scope, references),
        ).executeTable(auditFailure),
        (error) => error.code === "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(await reader.resolveTableOperation(id(28)), null);
      assert.deepEqual(await reader.loadTable(id(4)), afterLoss);
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      async function race(commands) {
        let arrived = 0;
        let release;
        let timer;
        const gate = new Promise((resolve, reject) => {
          release = resolve;
          timer = setTimeout(() => reject(new Error("synthetic barrier timeout")), 5000);
        });
        const gated = {
          async commitTable(record) {
            if (++arrived === commands.length) {
              clearTimeout(timer);
              release();
            }
            await gate;
            return writer.commitTable(record);
          },
        };
        try {
          return await Promise.allSettled(
            commands.map((input) => service(gated).executeTable(input)),
          );
        } finally {
          clearTimeout(timer);
        }
      }
      const competing = await race(
        ["CLEANING", "MAINTENANCE"].map((reason, index) =>
          command(
            "SetBlock",
            30 + index,
            transitionDiningTable(afterLoss, "SetBlock", at(9), reason),
            afterLoss.aggregateVersion,
          ),
        ),
      );
      assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(
        competing.find((result) => result.status === "rejected").reason.code,
        "DINING_TABLE_VERSION_CONFLICT",
      );
      current = await reader.loadTable(id(4));
      assert.equal(current.aggregateVersion, 9);
      assert.deepEqual(await counts(), { operations: 9, audits: 9 });
      const simultaneous = command(
        "ClearBlock",
        32,
        transitionDiningTable(current, "ClearBlock", at(10)),
        current.aggregateVersion,
      );
      const converged = await race([simultaneous, simultaneous]);
      assert(converged.every((result) => result.status === "fulfilled"));
      assert.deepEqual(converged[0].value.table, converged[1].value.table);
      current = await reader.loadTable(id(4));
      assert.equal(current.aggregateVersion, 10);
      assert.deepEqual(await counts(), { operations: 10, audits: 10 });
      await assert.rejects(
        service().executeTable({
          ...simultaneous,
          candidate: { ...simultaneous.candidate, capacity: 5 },
        }),
        (error) => error.code === "DINING_TABLE_IDEMPOTENCY_CONFLICT",
      );
      assert.deepEqual(await counts(), { operations: 10, audits: 10 });
      for (const field of ["tenantReference", "brandReference", "storeReference"]) {
        const foreign = createPostgresDiningTableStore(
          runner({ readOnly: true }),
          { ...scope, [field]: id(90) },
          references,
        );
        assert.equal(await foreign.loadTable(id(4)), null);
        assert.equal(await foreign.resolveTableOperation(id(20)), null);
      }
      await assert.rejects(
        runner({ readOnly: true }).run((tx) =>
          tx.query("UPDATE rms_dining.dining_table SET version=version+1", []),
        ),
        (error) => ["25006", "42501"].includes(error.code),
      );
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(3)],
          );
          const foreign = { ...initial, tableReference: id(50), storeReference: id(90) };
          return tx.query(
            "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
            [id(50), id(1), id(2), id(90), JSON.stringify(foreign), at(0)],
          );
        }),
        (error) => error.code === "42501",
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_table_operation SET intent_digest=intent_digest",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_dining.dining_table_operation")).rowCount,
        0,
      );
      assert.equal((await admin.query("DELETE FROM rms_dining.dining_table")).rowCount, 0);
      assert.equal(
        (await admin.query("UPDATE rms_dining.dining_table SET version=version+2")).rowCount,
        0,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [
            id(51),
            id(1),
            id(2),
            id(3),
            JSON.stringify({ ...initial, tableReference: id(51), brandReference: null }),
            at(0),
          ],
        ),
        (error) => error.code === "23514",
      );
      assert.deepEqual(await reader.loadTable(id(4)), current);
      assert.deepEqual(await reader.resolveTableOperation(id(20)), original);
      assert.deepEqual(await counts(), { operations: 10, audits: 10 });
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

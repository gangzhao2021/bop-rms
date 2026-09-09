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
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902277-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("regenerates scoped Join generations with atomic history and Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2277_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2277_${context.runId}`;
    assert.match(role, /^wp2277_[a-f0-9]+$/u);
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,rms_dining.dining_join_regeneration_operation,platform_audit.audit_record TO ${role}`,
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
      function service(selectedWriter = regenerationWriter, beforeWrite = async () => undefined) {
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
          guests: { resolve: async () => null },
          abuse: { admit: async () => "Cooldown" },
          store: {
            ...reader,
            start: writer.start,
            ...regenerationReader,
            resolveJoinState: async () => null,
            resolveJoinOperation: async () => null,
            join: async () => {
              throw new Error("synthetic unconfigured Join");
            },
            regenerate: async (input) => {
              await beforeWrite();
              return selectedWriter.regenerate(input);
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
       (SELECT count(*)::integer FROM rms_dining.dining_join_capability) AS capabilities,
       (SELECT count(*)::integer FROM rms_dining.dining_join_regeneration_operation) AS operations,
       (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_JOIN_CREDENTIAL_REGENERATE') AS audits`)
        ).rows[0];
      await configure(20);
      const started = await service().start(command(20, 30));
      assert.equal(started.status, "Issued");
      const sessionId = started.session.diningSessionReference;
      const regenCommand = (operation, version = 1, minute = 2) => ({
        diningSessionReference: sessionId,
        tableReference: id(20),
        expectedAssignmentVersion: 2,
        expectedSessionVersion: 1,
        expectedCapabilityVersion: version,
        operationReference: id(operation),
        requestedAt: at(minute),
      });
      const first = regenCommand(40);
      const result = await service().regenerate(first);
      assert.equal(result.status, "Issued");
      const original = await regenerationReader.resolveRegenerationOperation(id(40));
      assert.equal(original.capability.generation, 2);
      assert.equal(
        (await regenerationReader.resolveActiveJoin(sessionId)).capability.capabilityReference,
        original.capability.capabilityReference,
      );
      assert.equal((await reader.loadSession(sessionId)).version, 1);
      const old = (
        await admin.query(
          "SELECT capability_snapshot FROM rms_dining.dining_join_capability WHERE capability_id=$1",
          [(await reader.resolveStartOperation(id(30))).capability.capabilityReference],
        )
      ).rows[0].capability_snapshot;
      assert.equal(old.status, "Revoked");
      assert.equal(old.version, 2);
      assert.equal((await service().regenerate(first)).status, "AlreadyApplied");
      assert.deepEqual(await counts(), { capabilities: 2, operations: 1, audits: 1 });
      const before = await regenerationReader.resolveActiveJoin(sessionId);
      const broken = createPostgresDiningJoinRegenerationStore(
        runner({ failAudit: true }),
        scope,
        credentials,
      );
      await assert.rejects(
        service(broken).regenerate(regenCommand(41)),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await regenerationReader.resolveActiveJoin(sessionId), before);
      assert.deepEqual(await counts(), { capabilities: 2, operations: 1, audits: 1 });
      const readonly = createPostgresDiningJoinRegenerationStore(
        runner({ readOnly: true }),
        scope,
        credentials,
      );
      await assert.rejects(
        service(readonly).regenerate(regenCommand(42)),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      const lost = createPostgresDiningJoinRegenerationStore(
        runner({ loseAck: true }),
        scope,
        credentials,
      );
      await assert.rejects(
        service(lost).regenerate(regenCommand(43)),
        (e) => e.code === "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal((await service().regenerate(regenCommand(43))).status, "AlreadyApplied");
      assert.deepEqual(await counts(), { capabilities: 3, operations: 2, audits: 2 });
      function barrier() {
        let arrived = 0;
        let release;
        const ready = new Promise((resolve) => {
          release = resolve;
        });
        return async () => {
          if (++arrived === 2) release();
          await ready;
        };
      }
      let wait = barrier();
      const same = await Promise.all([
        service(regenerationWriter, wait).regenerate(regenCommand(44)),
        service(regenerationWriter, wait).regenerate(regenCommand(44)),
      ]);
      assert.deepEqual(same.map((x) => x.status).sort(), ["AlreadyApplied", "Issued"]);
      wait = barrier();
      const competing = await Promise.allSettled([
        service(regenerationWriter, wait).regenerate(regenCommand(45)),
        service(regenerationWriter, wait).regenerate(regenCommand(46)),
      ]);
      assert.equal(competing.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        competing.find((x) => x.status === "rejected").reason.code,
        "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), { capabilities: 5, operations: 4, audits: 4 });
      // Explicit synthetic terminal setup; this is not Guest Join/expiry-job evidence.
      for (const [status, operation, minute] of [
        ["Consumed", 50, 3],
        ["Expired", 51, 20],
      ]) {
        const state = await regenerationReader.resolveActiveJoin(sessionId);
        const terminal = {
          ...state.capability,
          status,
          version: 2,
          consumedAt: status === "Consumed" ? at(2) : null,
        };
        await admin.query(
          "UPDATE rms_dining.dining_join_capability SET version=2,status=$2,capability_snapshot=$3::jsonb WHERE capability_id=$1",
          [
            terminal.capabilityReference,
            status,
            JSON.stringify(terminal).replace(/"generation":([0-9]+)/u, '"generation":$1.0'),
          ],
        );
        assert.equal(
          (await service().regenerate(regenCommand(operation, 2, minute))).status,
          "Issued",
        );
        const persisted = (
          await admin.query(
            "SELECT capability_snapshot FROM rms_dining.dining_join_capability WHERE capability_id=$1",
            [terminal.capabilityReference],
          )
        ).rows[0].capability_snapshot;
        assert.deepEqual(persisted, terminal);
      }
      // Active but elapsed capability also permits an explicitly fresh generation.
      assert.equal((await service().regenerate(regenCommand(52, 1, 40))).status, "Issued");
      assert.deepEqual(await counts(), { capabilities: 8, operations: 7, audits: 7 });
      assert.deepEqual(await regenerationReader.resolveRegenerationOperation(id(40)), original);
      const foreign = createPostgresDiningJoinRegenerationStore(
        runner({ readOnly: true }),
        { ...scope, storeReference: id(90) },
        credentials,
      );
      assert.equal(await foreign.resolveActiveJoin(sessionId), null);
      assert.equal(await foreign.resolveRegenerationOperation(id(40)), null);
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_join_regeneration_operation SET intent_hash=repeat('b',64)",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_dining.dining_join_regeneration_operation")).rowCount,
        0,
      );
      const current = await regenerationReader.resolveActiveJoin(sessionId);
      const duplicate = {
        ...current.capability,
        capabilityReference: id(91),
        status: "Revoked",
        version: 2,
        revokedAt: at(40),
      };
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,2,'Revoked',$6::jsonb)",
          [
            id(91),
            id(1),
            id(2),
            id(3),
            sessionId,
            JSON.stringify(duplicate).replace(/"generation":([0-9]+)/u, '"generation":$1.0'),
          ],
        ),
        (e) => e.code === "23505",
      );
      const rawRecord = {
        ...original,
        operationReference: id(92),
        capability: { ...original.capability, credential: "synthetic-forbidden" },
      };
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_dining.dining_join_regeneration_operation (operation_id,tenant_id,brand_id,store_id,session_id,capability_id,actor_id,intent_hash,record_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
          [
            id(92),
            id(1),
            id(2),
            id(3),
            sessionId,
            original.capability.capabilityReference,
            id(8),
            original.operationIntentHash,
            JSON.stringify(rawRecord),
            original.capability.issuedAt,
          ],
        ),
        (e) => e.code === "23514",
      );
      // State changes after public authorization must still fence the owner transaction.
      const beforeFences = await counts();
      await assert.rejects(
        service(regenerationWriter, async () => {
          const table = await tableReader.loadTable(id(20));
          const blocked = {
            ...table,
            operationalState: "TemporarilyBlocked",
            blockReasonCode: "MAINTENANCE",
            aggregateVersion: table.aggregateVersion + 1,
            observedAt: at(40),
          };
          await admin.query(
            "UPDATE rms_dining.dining_table SET version=$2,table_snapshot=$3::jsonb,observed_at=$4 WHERE table_id=$1",
            [id(20), blocked.aggregateVersion, JSON.stringify(blocked), at(40)],
          );
        }).regenerate(regenCommand(60, 1, 40)),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      const blocked = await tableReader.loadTable(id(20));
      const available = {
        ...blocked,
        operationalState: "Available",
        blockReasonCode: null,
        aggregateVersion: blocked.aggregateVersion + 1,
      };
      await admin.query(
        "UPDATE rms_dining.dining_table SET version=$2,table_snapshot=$3::jsonb WHERE table_id=$1",
        [id(20), available.aggregateVersion, JSON.stringify(available)],
      );
      await assert.rejects(
        service(regenerationWriter, async () => {
          const session = await reader.loadSession(sessionId);
          await admin.query(
            "UPDATE rms_dining.dining_session SET version=2,phase='Closing',session_snapshot=$2::jsonb WHERE session_id=$1",
            [sessionId, JSON.stringify({ ...session, phase: "Closing", version: 2 })],
          );
        }).regenerate(regenCommand(61, 1, 40)),
        (e) => e.code === "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.equal(await regenerationReader.resolveActiveJoin(sessionId), null);
      assert.deepEqual(await counts(), beforeFences);
      await runner({ readOnly: true }).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(90)],
        );
        assert.equal(
          (
            await tx.query(
              "SELECT record_json FROM rms_dining.dining_join_regeneration_operation",
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
            [id(2), id(90)],
          );
          await tx.query(
            "INSERT INTO rms_dining.dining_join_regeneration_operation (operation_id,tenant_id,brand_id,store_id,session_id,capability_id,actor_id,intent_hash,record_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
            [
              id(94),
              id(1),
              id(2),
              id(3),
              sessionId,
              original.capability.capabilityReference,
              id(8),
              original.operationIntentHash,
              JSON.stringify({ ...original, operationReference: id(94) }),
              original.capability.issuedAt,
            ],
          );
        }),
        (e) => e.code === "42501",
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

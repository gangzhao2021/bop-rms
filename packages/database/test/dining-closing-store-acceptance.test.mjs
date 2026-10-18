import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
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
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningClosingStore,
  createDiningClosingService,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902282-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("persists authorized Closing atomically with immutable scoped original results", async () => {
  await withIsolatedDatabase({ caseId: "wp2282_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2282_${context.runId}`;
    assert.match(role, /^wp2282_[a-f0-9]+$/u);
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,rms_dining.dining_join_regeneration_operation,rms_dining.dining_participant,rms_dining.dining_identity_admission,rms_dining.dining_session_join_operation,rms_dining.dining_closing_operation,platform_audit.audit_record TO ${role}`,
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
      function service(selectedWriter = joinWriter, beforeWrite = async () => undefined) {
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
          guests: {
            resolve: async (input) => ({
              guestSessionReference: input.guestSessionReference,
              diningState: "ContextOnly",
              channel: "DineIn",
              storeReference: id(3),
              tableReference: id(20),
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
      let revoked = false;
      let ensuredTasks = 0;
      const closing = (selected = closingWriter, staff = false) =>
        createDiningClosingService({
          store: {
            load: closingReader.load,
            resolveOperation: closingReader.resolveOperation,
            commit: selected.commit,
          },
          hashes,
          authorization: {
            async authorize(input) {
              if (revoked) return null;
              const commonAudit = {
                ...audit(
                  `DINING_SESSION_CLOSING_${input.operation.toUpperCase()}`,
                  sessionId,
                  input.observedAt,
                ),
                targetType: "DiningSession",
              };
              if (staff)
                return {
                  kind: "Staff",
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
                  permission: {
                    effect: "Allow",
                    action: "dining.session.close",
                    scopeKind: "Store",
                  },
                  audit: commonAudit,
                };
              return {
                kind: "Host",
                guestSessionReference: id(80),
                participantReference: joined.participant.participantReference,
                diningSessionReference: sessionId,
                storeReference: id(3),
                status: "CurrentHost",
                observedAt: input.observedAt,
                audit: {
                  ...commonAudit,
                  actor: { type: "System" },
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                },
              };
            },
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
              ensuredTasks++;
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
                  dueAt: at(10),
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
      const request = (operation, version, minute = 3) => ({
        diningSessionReference: sessionId,
        operationReference: id(operation),
        expectedSessionVersion: version,
        requestedAt: at(minute),
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_closing_operation) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code LIKE 'DINING_SESSION_CLOSING_%') AS audits`)
        ).rows[0];
      const sameOperation = await Promise.all([
        closing().begin(request(90, 2)),
        closing().begin(request(90, 2)),
      ]);
      assert(sameOperation.every((value) => value.session.version === 3));
      assert.equal((await counts()).operations, 1);
      assert.equal((await closing().begin(request(90, 2))).status, "AlreadyApplied");
      revoked = true;
      await assert.rejects(closing().begin(request(90, 2)), {
        code: "DINING_CLOSING_PERMISSION_DENIED",
      });
      revoked = false;
      assert.equal(
        (await closing(closingWriter, true).cancel(request(91, 3))).session.phase,
        "Active",
      );
      assert.equal((await closing().begin(request(90, 2))).session.version, 3);
      const competitors = await Promise.allSettled([
        closing().begin(request(92, 4)),
        closing().begin(request(93, 4)),
      ]);
      assert.equal(competitors.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(
        competitors.find((result) => result.status === "rejected").reason.code,
        "DINING_CLOSING_VERSION_CONFLICT",
      );
      await closing().cancel(request(94, 5));
      const lost = createPostgresDiningClosingStore(runner({ loseAck: true }), scope, hashes);
      await assert.rejects(closing(lost).begin(request(95, 6)), {
        code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal((await closing().begin(request(95, 6))).status, "AlreadyApplied");
      assert.equal((await closingReader.load(sessionId)).version, 7);
      await closing().cancel(request(96, 7));
      const beforeFailed = await counts();
      const failing = createPostgresDiningClosingStore(runner({ failAudit: true }), scope, hashes);
      await assert.rejects(closing(failing).begin(request(97, 8)), {
        code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal((await closingReader.load(sessionId)).version, 8);
      assert.equal(await closingReader.resolveOperation(id(97)), null);
      assert.deepEqual(await counts(), beforeFailed);
      await assert.rejects(closing(closingReader).begin(request(98, 8)), {
        code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), beforeFailed);
      const regenerated = await service().regenerate({
        diningSessionReference: sessionId,
        tableReference: id(20),
        expectedAssignmentVersion: 2,
        expectedSessionVersion: 8,
        expectedCapabilityVersion: 2,
        expectedGeneration: 1,
        operationReference: id(99),
        requestedAt: at(4),
      });
      const joinRequest = {
        guestSessionReference: id(81),
        joinCredential: regenerated.joinCredential,
        expectedSessionVersion: 8,
        expectedCapabilityVersion: 1,
        operationReference: id(100),
        requestedAt: at(5),
      };
      await assert.rejects(
        service(joinWriter, async () => {
          await closing().begin(request(101, 8, 5));
        }).join(joinRequest),
        { code: "DINING_SESSION_VERSION_CONFLICT" },
      );
      assert.equal((await closingReader.load(sessionId)).phase, "Closing");
      await closing().cancel(request(102, 9, 6));
      const nextJoin = await service().join({
        ...joinRequest,
        expectedSessionVersion: 10,
        operationReference: id(103),
        requestedAt: at(7),
      });
      assert.equal(nextJoin.session.version, 11);
      await closing().begin(request(104, 11, 8));
      const finalized = await closing().finalize(request(105, 12, 9));
      assert.equal(finalized.session.phase, "Closed");
      assert.equal(finalized.session.version, 13);
      assert.equal((await closing().finalize(request(105, 12, 9))).status, "AlreadyApplied");
      assert.deepEqual(finalized.taskReferences, [id(203)]);
      assert.equal(ensuredTasks, 1);
      assert.equal((await tableReader.loadTable(id(20))).activeDiningSessionReference, sessionId);
      assert.equal((await tableReader.loadTable(id(20))).aggregateVersion, 3);
      assert.equal((await counts()).operations, (await counts()).audits);
      assert.equal((await counts()).operations, 10);
      const foreign = createPostgresDiningClosingStore(
        runner({ readOnly: true }),
        { ...scope, storeReference: id(999) },
        hashes,
      );
      assert.equal(await foreign.load(sessionId), null);
      assert.equal(await foreign.resolveOperation(id(90)), null);
      const otherTenant = createPostgresDiningClosingStore(
        runner({ readOnly: true }),
        { ...scope, tenantReference: id(999) },
        hashes,
      );
      assert.equal(await otherTenant.load(sessionId), null);
      assert.equal(await otherTenant.resolveOperation(id(90)), null);
      const prior = (
        await admin.query(
          "SELECT * FROM rms_dining.dining_closing_operation WHERE operation_id=$1",
          [id(90)],
        )
      ).rows[0];
      await admin.query(`GRANT UPDATE,DELETE ON rms_dining.dining_closing_operation TO ${role}`);
      await runner().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(3)],
        );
        assert.equal(
          (
            await tx.query(
              "UPDATE rms_dining.dining_closing_operation SET intent_hash=$1 WHERE operation_id=$2",
              ["a".repeat(64), id(90)],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await tx.query(
              "DELETE FROM rms_dining.dining_closing_operation WHERE operation_id=$1",
              [id(90)],
            )
          ).rowCount,
          0,
        );
      });
      const insert = (tx, operation, value, storeId = id(3), originalRow = prior) =>
        tx.query(
          "INSERT INTO rms_dining.dining_closing_operation (operation_id,tenant_id,brand_id,store_id,session_id,action,expected_version,intent_hash,requested_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            operation,
            id(1),
            id(2),
            storeId,
            sessionId,
            originalRow.action,
            originalRow.expected_version,
            originalRow.intent_hash,
            originalRow.requested_at,
            JSON.stringify({ ...value, operationReference: operation }),
          ],
        );
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(999)],
          );
          assert.equal(
            (await tx.query("SELECT operation_id FROM rms_dining.dining_closing_operation", []))
              .rows.length,
            0,
          );
          await insert(tx, id(200), prior.record_json);
        }),
        { code: "42501" },
      );
      for (const malformed of [
        { ...prior.record_json, rawCredential: "synthetic-forbidden" },
        {
          ...prior.record_json,
          session: { ...prior.record_json.session, rawGuest: "synthetic-forbidden" },
        },
        { ...prior.record_json, session: { ...prior.record_json.session, phase: "Active" } },
      ])
        await assert.rejects(insert(admin, id(++sequence), malformed), { code: "23514" });
      const finalRow = (
        await admin.query(
          "SELECT * FROM rms_dining.dining_closing_operation WHERE operation_id=$1",
          [id(105)],
        )
      ).rows[0];
      for (const invalidReference of ["invalid", 12, "01902282-0000-4000-8000-000000000001"])
        await assert.rejects(
          insert(
            admin,
            id(++sequence),
            { ...finalRow.record_json, taskReferences: [invalidReference] },
            id(3),
            finalRow,
          ),
          { code: "23514" },
        );
      assert.equal((await closingReader.resolveOperation(id(90))).session.phase, "Closing");
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

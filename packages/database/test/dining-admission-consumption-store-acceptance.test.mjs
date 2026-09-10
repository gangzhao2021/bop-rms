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
  createPostgresDiningSessionJoinStore,
  createPostgresDiningClosingStore,
  createDiningClosingService,
  createPostgresDiningSessionMoveStore,
  createPostgresDiningAdmissionConsumptionStore,
  createDiningAdmissionConsumptionService,
} from "../../rms/dining/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902290-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute) => `2026-09-09T09:${String(minute).padStart(2, "0")}:00.000Z`;
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const tableReferences = {
  hashIntent: (value) => `sha256:${digest(value)}`,
  equals: (a, b) => a === b,
};
it("consumes exact Guest admissions atomically with current Dining fences and immutable recovery", async () => {
  await withIsolatedDatabase({ caseId: "wp2290_start" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2290_${context.runId}`;
    assert.match(role, /^wp2290_[a-f0-9]+$/u);
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
        `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,rms_dining.dining_join_regeneration_operation,rms_dining.dining_participant,rms_dining.dining_identity_admission,rms_dining.dining_session_join_operation,rms_dining.dining_closing_operation,rms_dining.dining_session_move_operation,rms_dining.dining_admission_consumption_operation,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      await admin.query(
        `GRANT UPDATE ON rms_dining.dining_join_capability,rms_dining.dining_session,rms_dining.dining_participant,rms_dining.dining_identity_admission TO ${role}`,
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
      const moveReader = createPostgresDiningSessionMoveStore(
        runner({ readOnly: true }),
        scope,
        tableReferences,
      );
      const moveWriter = createPostgresDiningSessionMoveStore(runner(), scope, tableReferences);
      const guestTables = new Map();
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
          resolveMoveOperation: moveReader.resolveMoveOperation,
          commitMove: moveWriter.commitMove,
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
              tableReference: guestTables.get(input.guestSessionReference) ?? null,
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
      const consumptionAudit = (descriptor) => ({
        ...audit(
          "DINING_IDENTITY_ADMISSION_CONSUME",
          descriptor.admissionReference,
          descriptor.occurredAt,
        ),
        actor: { type: "System" },
        targetType: "DiningIdentityAdmission",
        reasonCode: "AUTHORIZED_DINING_ADMISSION_CONSUMPTION",
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
      });
      const consumptionReader = createPostgresDiningAdmissionConsumptionStore(
        runner({ readOnly: true }),
        scope,
        credentials,
        consumptionAudit,
      );
      const consumptionWriter = createPostgresDiningAdmissionConsumptionStore(
        runner(),
        scope,
        credentials,
        consumptionAudit,
      );
      const closingHashes = { hashIntent: digest, equals: (a, b) => a === b };
      const closingReader = createPostgresDiningClosingStore(
        runner({ readOnly: true }),
        scope,
        closingHashes,
      );
      const closingWriter = createPostgresDiningClosingStore(runner(), scope, closingHashes);
      let guestAllowed = true;
      let savedCommand;
      const consumption = (selected = consumptionWriter, beforeWrite = async () => undefined) =>
        createDiningAdmissionConsumptionService({
          scope: { brandReference: id(2), storeReference: id(3) },
          credentials,
          guests: {
            resolve: async (input) =>
              guestAllowed
                ? {
                    guestSessionReference: input.guestSessionReference,
                    diningState: "ContextOnly",
                    channel: "DineIn",
                    storeReference: id(3),
                    tableReference: guestTables.get(input.guestSessionReference) ?? null,
                    observedAt: input.observedAt,
                  }
                : null,
          },
          store: {
            ...consumptionReader,
            consume: async (input) => {
              savedCommand = input;
              await beforeWrite();
              return selected.consume(input);
            },
          },
        });
      async function firstJoin(table, guest) {
        await configure(table);
        guestTables.set(id(guest), id(table));
        const started = await service().start(command(table, ++sequence));
        const joined = await service().join({
          guestSessionReference: id(guest),
          joinCredential: started.joinCredential,
          expectedSessionVersion: 1,
          expectedCapabilityVersion: 1,
          operationReference: id(++sequence),
          requestedAt: at(2),
        });
        assert.equal(joined.status, "Joined");
        return { table, guest, joined, sessionId: started.session.diningSessionReference };
      }
      async function additional(entry, guest, minute) {
        const state = await regenerationReader.resolveActiveJoin(entry.sessionId);
        const issued = await service().regenerate({
          diningSessionReference: entry.sessionId,
          tableReference: id(entry.table),
          expectedAssignmentVersion: state.session.tableAssignmentVersion,
          expectedSessionVersion: state.session.version,
          expectedCapabilityVersion: state.capability.version,
          expectedGeneration: state.capability.generation,
          operationReference: id(++sequence),
          requestedAt: at(minute),
        });
        guestTables.set(id(guest), id(entry.table));
        const joined = await service().join({
          guestSessionReference: id(guest),
          joinCredential: issued.joinCredential,
          expectedSessionVersion: state.session.version,
          expectedCapabilityVersion: 1,
          operationReference: id(++sequence),
          requestedAt: at(minute + 1),
        });
        assert.equal(joined.status, "Joined");
        assert.equal(
          joined.session.hostParticipantReference,
          entry.joined.session.hostParticipantReference,
        );
        return { ...entry, guest, joined };
      }
      const request = (entry, operation, minute) => ({
        guestSessionReference: id(entry.guest),
        admissionReference: entry.joined.admission.admissionReference,
        operationReference: id(operation),
        requestedAt: at(minute),
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_dining.dining_admission_consumption_operation) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record WHERE action_code='DINING_IDENTITY_ADMISSION_CONSUME') AS audits`)
        ).rows[0];
      const move = async (entry, target, operation, minute) => {
        const current = await reader.loadSession(entry.sessionId);
        return tableService.moveSession({
          operationReference: id(operation),
          diningSessionReference: entry.sessionId,
          sourceTableReference: current.tableReference,
          targetTableReference: id(target),
          expectedSessionVersion: current.version,
          expectedSourceTableVersion: (await tableReader.loadTable(current.tableReference))
            .aggregateVersion,
          expectedTargetTableVersion: (await tableReader.loadTable(id(target))).aggregateVersion,
          partySize: 1,
          observedAt: at(minute),
        });
      };
      const beginClosing = async (entry, operation, minute) => {
        const current = await reader.loadSession(entry.sessionId);
        const closing = createDiningClosingService({
          store: {
            load: closingReader.load,
            resolveOperation: closingReader.resolveOperation,
            commit: closingWriter.commit,
          },
          hashes: closingHashes,
          authorization: {
            authorize: async (input) => ({
              kind: "Host",
              guestSessionReference: id(entry.guest),
              participantReference: entry.joined.participant.participantReference,
              diningSessionReference: entry.sessionId,
              storeReference: id(3),
              status: "CurrentHost",
              observedAt: input.observedAt,
              audit: {
                ...audit("DINING_SESSION_CLOSING_BEGIN", entry.sessionId, input.observedAt),
                targetType: "DiningSession",
                actor: { type: "System" },
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
              },
            }),
          },
          reversibility: { evaluate: async () => "Unavailable" },
          closureEvidence: { resolve: async () => null },
          tasks: {
            ensure: async () => {
              throw new Error("unconfigured synthetic task");
            },
          },
        });
        return closing.begin({
          diningSessionReference: entry.sessionId,
          expectedSessionVersion: current.version,
          operationReference: id(operation),
          requestedAt: at(minute),
        });
      };
      const a = await firstJoin(20, 80);
      const originalJoin = await joinReader.resolveJoinOperation(
        a.joined.admission.operationReference,
      );
      const first = await consumption().consume(request(a, 90, 3));
      assert.equal(first.status, "Consumed");
      assert.equal(first.record.admission.status, "Consumed");
      assert.equal(first.record.admission.version, 2);
      assert.equal((await reader.loadSession(a.sessionId)).version, 2);
      assert.deepEqual(
        await joinReader.resolveJoinOperation(a.joined.admission.operationReference),
        originalJoin,
      );
      assert.deepEqual(await consumption().consume(request(a, 90, 4)), {
        status: "AlreadyApplied",
        record: first.record,
      });
      assert.equal(first.record.admission.consumedAt, at(3));
      await assert.rejects(consumption().consume(request(a, 91, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      guestTables.set(id(99), id(20));
      await assert.rejects(
        consumption().consume({ ...request(a, 90, 4), guestSessionReference: id(99) }),
        { code: "DINING_SESSION_UNAVAILABLE" },
      );
      guestAllowed = false;
      await assert.rejects(consumption().consume(request(a, 90, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      guestAllowed = true;
      assert.deepEqual(await counts(), { operations: 1, audits: 1 });

      const b = await additional(a, 81, 4);
      const beforeFault = await consumptionReader.readCurrent({
        admissionReference: b.joined.admission.admissionReference,
        observedAt: at(6),
      });
      for (const failure of [{ failAudit: true }, { readOnly: true }]) {
        const selected = createPostgresDiningAdmissionConsumptionStore(
          runner(failure),
          scope,
          credentials,
          consumptionAudit,
        );
        await assert.rejects(consumption(selected).consume(request(b, 92, 6)), {
          code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
        });
        assert.deepEqual(
          await consumptionReader.readCurrent({
            admissionReference: b.joined.admission.admissionReference,
            observedAt: at(6),
          }),
          beforeFault,
        );
        assert.deepEqual(await counts(), { operations: 1, audits: 1 });
      }
      const lost = createPostgresDiningAdmissionConsumptionStore(
        runner({ loseAck: true }),
        scope,
        credentials,
        consumptionAudit,
      );
      await assert.rejects(consumption(lost).consume(request(b, 92, 6)), {
        code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal((await consumption().consume(request(b, 92, 6))).status, "AlreadyApplied");
      assert.deepEqual(await counts(), { operations: 2, audits: 2 });
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
      const c = await additional(a, 82, 7);
      let wait = barrier();
      const same = await Promise.all([
        consumption(consumptionWriter, wait).consume(request(c, 93, 9)),
        consumption(consumptionWriter, wait).consume(request(c, 93, 9)),
      ]);
      assert.deepEqual(same.map((value) => value.status).sort(), ["AlreadyApplied", "Consumed"]);
      assert.deepEqual(same[0].record, same[1].record);
      const d = await additional(a, 83, 10);
      wait = barrier();
      const competing = await Promise.allSettled([
        consumption(consumptionWriter, wait).consume(request(d, 94, 12)),
        consumption(consumptionWriter, wait).consume(request(d, 95, 12)),
      ]);
      assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(
        competing.find((result) => result.status === "rejected").reason.code,
        "DINING_SESSION_VERSION_CONFLICT",
      );
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
      const e = await additional(a, 84, 13);
      await assert.rejects(
        consumption(consumptionWriter, () => beginClosing(a, 97, 15)).consume(request(e, 96, 15)),
        { code: "DINING_SESSION_VERSION_CONFLICT" },
      );
      assert.equal(await consumptionReader.resolveOperation(id(96)), null);
      assert.equal(
        (
          await consumptionReader.readCurrent({
            admissionReference: e.joined.admission.admissionReference,
            observedAt: at(15),
          })
        ).admission.status,
        "Active",
      );
      await assert.rejects(consumption().consume(request(e, 96, 15)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      await assert.rejects(consumption().consume(request(a, 90, 15)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });

      const f = await firstJoin(21, 85);
      await configure(22);
      await assert.rejects(
        consumption(consumptionWriter, () => move(f, 22, 99, 3)).consume(request(f, 98, 3)),
        { code: "DINING_SESSION_VERSION_CONFLICT" },
      );
      guestTables.set(id(85), id(22));
      await assert.rejects(consumption().consume(request(f, 98, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      assert.equal(await consumptionReader.resolveOperation(id(98)), null);
      const g = await firstJoin(23, 86);
      const fifth = await consumption().consume(request(g, 100, 3));
      const originalWrite = savedCommand;
      await configure(24);
      await move(g, 24, 101, 4);
      await assert.rejects(consumptionWriter.consume(originalWrite), {
        code: "DINING_SESSION_VERSION_CONFLICT",
      });
      assert.equal(fifth.record.admission.consumedAt, at(3));
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      assert.deepEqual(
        await joinReader.resolveJoinOperation(a.joined.admission.operationReference),
        originalJoin,
      );
      const h = await firstJoin(25, 87);
      for (const foreignScope of [
        { ...scope, storeReference: id(999) },
        { ...scope, tenantReference: id(999) },
      ]) {
        const foreign = createPostgresDiningAdmissionConsumptionStore(
          runner({ readOnly: true }),
          foreignScope,
          credentials,
          consumptionAudit,
        );
        assert.equal(
          await foreign.readCurrent({
            admissionReference: a.joined.admission.admissionReference,
            observedAt: at(16),
          }),
          null,
        );
        assert.equal(await foreign.resolveOperation(id(90)), null);
      }
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_dining.dining_admission_consumption_operation SET intent_hash=repeat('b',64)",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await admin.query("DELETE FROM rms_dining.dining_admission_consumption_operation"))
          .rowCount,
        0,
      );
      const insertHistory = (tx, record, storeId = id(3)) =>
        tx.query(
          "INSERT INTO rms_dining.dining_admission_consumption_operation (operation_id,tenant_id,brand_id,store_id,session_id,participant_id,admission_id,guest_session_id,join_operation_id,intent_hash,record_json,consumed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",
          [
            record.operationReference,
            id(1),
            id(2),
            storeId,
            record.admission.diningSessionReference,
            record.admission.participantReference,
            record.admission.admissionReference,
            record.guestSessionReference,
            record.admission.operationReference,
            record.operationIntentHash,
            JSON.stringify(record),
            record.admission.consumedAt,
          ],
        );
      const synthetic = {
        operationReference: id(102),
        operationIntentHash: digest(
          `ConsumeDiningAdmission:${id(87)}:${h.joined.admission.admissionReference}`,
        ),
        guestSessionReference: id(87),
        admission: { ...h.joined.admission, status: "Consumed", version: 2, consumedAt: at(3) },
      };
      await admin.query("BEGIN");
      try {
        await assert.rejects(
          insertHistory(admin, { ...synthetic, guestSessionReference: id(99) }),
          (error) => error.code === "23503",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      await admin.query("BEGIN");
      try {
        await assert.rejects(
          insertHistory(admin, { ...synthetic, credential: "synthetic-forbidden" }),
          (error) => error.code === "23514",
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      await runner({ readOnly: true }).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(999)],
        );
        assert.equal(
          (
            await tx.query(
              "SELECT record_json FROM rms_dining.dining_admission_consumption_operation",
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
            [id(2), id(999)],
          );
          return insertHistory(tx, synthetic);
        }),
        (error) => error.code === "42501",
      );
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      assert.equal(
        (
          await consumptionReader.readCurrent({
            admissionReference: h.joined.admission.admissionReference,
            observedAt: at(3),
          })
        ).admission.status,
        "Active",
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
});

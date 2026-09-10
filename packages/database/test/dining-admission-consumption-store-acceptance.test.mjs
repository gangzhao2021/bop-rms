import { createCustomerDiningJoinComposition } from "../../../apps/api/src/customer-dining-join-composition.ts";
import { createDiningBindingCoordinator } from "../../../apps/customer-pwa/src/dining/dining-binding-coordinator.ts";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../../../apps/customer-pwa/src/session/customer-transaction-context.ts";
import { createBrowserDiningBindingClient } from "../../../apps/customer-pwa/src/dining/dining-binding-client.ts";
import { createServer } from "node:http";
import { createApp } from "../../../apps/api/src/app.ts";
import {
  CustomerDiningBindingHandler,
  customerDiningBindingRoutes,
} from "../../../apps/api/src/customer-dining-binding.ts";
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
  createPostgresDiningGuestBindingStore,
  createDiningGuestBindingQuery,
  createPostgresDiningParticipationStore,
  createDiningCartParticipationQuery,
} from "../../rms/dining/src/index.ts";
import {
  createGuestSessionRecord,
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  createPostgresGuestDiningBindingStore,
  createGuestDiningBindingCredentialProvider,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { createCustomerDiningBindingComposition } from "../../../apps/api/src/customer-dining-binding-composition.ts";
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
        `GRANT USAGE ON SCHEMA rms_dining,bop_identity,platform_audit,platform_helpers TO ${role}`,
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
      await admin.query(
        `GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation,bop_identity.guest_dining_binding_preparation TO ${role}`,
      );
      await admin.query(
        `GRANT UPDATE (status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO ${role}`,
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
      // WP-2297: actual read-only owner reservation never consumes or appends history/Audit.
      const beforeReservation = await counts();
      const beforeAdmission = await consumptionReader.readCurrent({
        admissionReference: a.joined.admission.admissionReference,
        observedAt: at(3),
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const reservation = await consumption().reserve(request(a, 90, 3));
        assert.deepEqual(reservation, {
          operationReference: id(90),
          admissionReference: a.joined.admission.admissionReference,
          guestSessionReference: id(80),
          brandReference: id(2),
          storeReference: id(3),
          tableReference: id(20),
          tableAssignmentVersion: beforeAdmission.session.tableAssignmentVersion,
          diningSessionReference: a.sessionId,
          participantReference: a.joined.participant.participantReference,
          sessionVersion: 2,
          evaluatedAt: at(3),
        });
      }
      assert.deepEqual(await counts(), beforeReservation);
      assert.deepEqual(
        await consumptionReader.readCurrent({
          admissionReference: a.joined.admission.admissionReference,
          observedAt: at(3),
        }),
        beforeAdmission,
      );
      assert.equal(savedCommand, undefined);
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
      await assert.rejects(consumption().reserve(request(a, 90, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 1, audits: 1 });
      await assert.rejects(consumption().consume(request(a, 91, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      guestTables.set(id(99), id(20));
      await assert.rejects(
        consumption().consume({ ...request(a, 90, 4), guestSessionReference: id(99) }),
        { code: "DINING_SESSION_UNAVAILABLE" },
      );
      await assert.rejects(
        consumption().reserve({ ...request(a, 90, 4), guestSessionReference: id(99) }),
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
      await consumption().reserve(request(e, 96, 15));
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

      await assert.rejects(consumption().reserve(request(e, 96, 15)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
      const f = await firstJoin(21, 85);
      await consumption().reserve(request(f, 98, 3));
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
      await assert.rejects(consumption().reserve(request(f, 98, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
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
      // WP-2291: explicit test-only public mapping and evidence validity, no production adapter.
      const identityScope = { brandReference: id(2), storeReference: id(3) };
      const identityStore = createPostgresGuestSessionEntryStore(runner(), identityScope);
      const identityCredentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
      const identitySelectors = new Map();
      const publicMappings = new Map();
      const makeIdentity = async (table, guest) => {
        const sessionCredential = identityCredentials.generateCredential("Session");
        const csrfCredential = identityCredentials.generateCredential("Csrf");
        const selector = identityCredentials.hashCredential("Session", sessionCredential);
        const publicTable = id(table + 200);
        assert.notEqual(publicTable, id(table));
        publicMappings.set(publicTable, id(table));
        const record = createGuestSessionRecord({
          session: {
            sessionReference: id(guest),
            status: "Active",
            version: 1,
            ...identityScope,
            publicStoreReference: id(200),
            publicTableReference: publicTable,
            channel: "DineIn",
            locale: "en-CA",
            qrReference: id(table + 300),
            qrRevocationVersion: 1,
            diningState: "ContextOnly",
            diningSessionReference: null,
            diningParticipantReference: null,
            createdAt: at(0),
            lastSeenAt: at(0),
            idleExpiresAt: "2026-09-09T13:00:00.000Z",
            absoluteExpiresAt: "2026-09-10T09:00:00.000Z",
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          },
          sessionSelectorHash: selector,
          csrfSelectorHash: identityCredentials.hashCredential("Csrf", csrfCredential),
          operationReference: id(guest + 400),
          operationIntentHash: digest(`synthetic-entry:${guest}`),
        });
        await identityStore.create({ record });
        identitySelectors.set(id(guest), selector);
        return { sessionCredential, csrfCredential, selector, record };
      };
      const currentIdentity = async (guest, observedAt) => {
        const selector = identitySelectors.get(guest);
        if (!selector) return null;
        const record = await identityStore.resolve(selector);
        if (
          !record ||
          record.session.sessionReference !== guest ||
          record.session.status !== "Active" ||
          record.session.channel !== "DineIn" ||
          record.session.diningState !== "ContextOnly" ||
          record.session.idleExpiresAt <= observedAt ||
          record.session.absoluteExpiresAt <= observedAt
        )
          return null;
        return record.session;
      };
      const boundConsumption = createDiningAdmissionConsumptionService({
        scope: identityScope,
        credentials,
        guests: {
          resolve: async ({ guestSessionReference, observedAt }) => {
            const current = await currentIdentity(guestSessionReference, observedAt);
            const tableReference = current && publicMappings.get(current.publicTableReference);
            return current && tableReference
              ? {
                  guestSessionReference,
                  diningState: current.diningState,
                  channel: current.channel,
                  storeReference: current.storeReference,
                  tableReference,
                  observedAt,
                }
              : null;
          },
        },
        store: consumptionWriter,
      });
      let admissionCalls = 0;
      const bridge = {
        consume: async (input) => {
          admissionCalls++;
          const current = await currentIdentity(input.guestSessionReference, input.requestedAt);
          if (!current) return null;
          const receipt = await boundConsumption.consume(input);
          const admission = receipt.record.admission;
          if (publicMappings.get(current.publicTableReference) !== admission.tableReference)
            return null;
          return {
            guestSessionReference: input.guestSessionReference,
            decision: "Allowed",
            admissionReference: admission.admissionReference,
            operationReference: input.operationReference,
            storeReference: admission.storeReference,
            publicTableReference: current.publicTableReference,
            diningSessionReference: admission.diningSessionReference,
            diningParticipantReference: admission.participantReference,
            evaluatedAt: input.requestedAt,
            validUntil: at(10),
          };
        },
      };
      const identityService = (store = identityStore) =>
        new GuestSessionService({
          store,
          credentials: identityCredentials,
          binding: { validate: async () => "Current" },
          admission: { consume: async () => null },
          diningAdmission: bridge,
          now: () => at(3),
        });
      const bindRequest = (identity, entry, operation) => ({
        sessionCredential: identity.sessionCredential,
        expectedVersion: 1,
        diningAdmissionReference: entry.joined.admission.admissionReference,
        operationReference: id(operation),
        requestedAt: at(3),
      });
      const i = await makeIdentity(30, 110);
      const iJoin = await firstJoin(30, 110);
      const wrong = await makeIdentity(33, 113);
      await assert.rejects(identityService().bindDining(bindRequest(wrong, iJoin, 120)), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      const issued = await identityService().bindDining(bindRequest(i, iJoin, 120));
      assert.equal(issued.status, "Issued");
      assert.equal(issued.session.diningState, "DiningBound");
      assert.equal(
        issued.session.diningParticipantReference,
        iJoin.joined.participant.participantReference,
      );
      assert.equal(issued.session.diningSessionReference, iJoin.sessionId);
      assert.equal(issued.session.publicTableReference, i.record.session.publicTableReference);
      assert.notEqual(issued.sessionCredential, i.sessionCredential);
      assert.notEqual(issued.csrfCredential, i.csrfCredential);
      const terminated = (await identityStore.resolve(i.selector)).session;
      assert.equal(terminated.status, "Revoked");
      assert.equal(terminated.revocationReason, "BindingChanged");
      assert.equal(terminated.version, 2);
      const callsBeforeReplay = admissionCalls;
      const replay = await identityService().bindDining(bindRequest(i, iJoin, 120));
      assert.equal(replay.status, "AlreadyApplied");
      assert.deepEqual(replay.session, issued.session);
      assert.equal(admissionCalls, callsBeforeReplay);
      assert.equal(Object.hasOwn(replay, "sessionCredential"), false);
      await assert.rejects(identityService().bindDining(bindRequest(i, iJoin, 121)), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      await assert.rejects(boundConsumption.consume(request(iJoin, 120, 4)), {
        code: "DINING_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 6, audits: 6 });

      const j = await makeIdentity(31, 111);
      const jJoin = await firstJoin(31, 111);
      await assert.rejects(
        identityService({
          ...identityStore,
          rotate: async () => {
            throw new Error("synthetic identity outage before rotate");
          },
        }).bindDining(bindRequest(j, jJoin, 122)),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      assert.deepEqual(await identityStore.resolve(j.selector), j.record);
      assert.equal(await identityStore.resolveOperation(id(122)), null);
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });
      const recovered = await identityService().bindDining(bindRequest(j, jJoin, 122));
      assert.equal(recovered.status, "Issued");
      assert.equal(
        recovered.session.diningParticipantReference,
        jJoin.joined.participant.participantReference,
      );
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });

      const k = await makeIdentity(32, 112);
      const kJoin = await firstJoin(32, 112);
      await assert.rejects(
        identityService({
          ...identityStore,
          rotate: async (command) => {
            await identityStore.rotate(command);
            throw new Error("synthetic identity lost commit acknowledgement");
          },
        }).bindDining(bindRequest(k, kJoin, 123)),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      const savedBinding = await identityStore.resolveOperation(id(123));
      assert.equal(savedBinding.session.diningState, "DiningBound");
      const recoveredAck = await identityService().bindDining(bindRequest(k, kJoin, 123));
      assert.equal(recoveredAck.status, "AlreadyApplied");
      assert.deepEqual(recoveredAck.session, savedBinding.session);
      assert.equal(Object.hasOwn(recoveredAck, "sessionCredential"), false);
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      assert.equal(
        (await identityStore.resolve(k.selector)).session.revocationReason,
        "BindingChanged",
      );
      // WP-2298: real public-port composition, with explicit synthetic current QR mapping only.
      const diningBindingAudit = {
        async append(tx, descriptor) {
          await appendAuditRecordInTransaction(tx, {
            ...audit(
              `IDENTITY_GUEST_DINING_BINDING_${descriptor.action.toUpperCase()}`,
              descriptor.operationReference,
              descriptor.occurredAt,
            ),
            actor: { type: "System" },
            targetType: "GuestDiningBindingPreparation",
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
          });
        },
      };
      const bindingStore = (transactionRunner = runner()) =>
        createPostgresGuestDiningBindingStore(
          transactionRunner,
          identityScope,
          diningBindingAudit,
          identityCredentials.equals,
        );
      let minute = 3;
      const contextRequests = [];
      const compositionOptions = {
        scope: identityScope,
        session: {
          store: identityStore,
          credentials: identityCredentials,
          binding: { validate: async () => "Current" },
        },
        bindings: bindingStore(),
        dining: {
          credentials,
          store: consumptionWriter,
          binding: createPostgresDiningGuestBindingStore(runner({ readOnly: true }), scope),
        },
        contexts: {
          async resolve(input) {
            contextRequests.push(input);
            const table = publicMappings.get(input.session.publicTableReference);
            if (!table) return null;
            return {
              publicStoreReference: input.session.publicStoreReference,
              publicTableReference: input.session.publicTableReference,
              brandReference: id(2),
              storeReference: id(3),
              tableReference: table,
              brandLifecycle: "Active",
              storeLifecycle: "Active",
              tableLifecycle: "Active",
              assignmentState: "Active",
              channel: "DineIn",
              qrState: "Enabled",
              revocationVersion: input.session.qrRevocationVersion,
              contextEvidenceReference: id(900),
              validUntil: at(10),
            };
          },
        },
        recovery: createGuestDiningBindingCredentialProvider(new Uint8Array(32).fill(11)),
        preparationLifetimeSeconds: 300,
        now: () => at(minute),
      };
      const m = await makeIdentity(34, 114);
      const mJoin = await firstJoin(34, 114);
      const composed = createCustomerDiningBindingComposition(compositionOptions);
      const prepared = await composed.prepare({
        sessionCredential: m.sessionCredential,
        csrfCredential: m.csrfCredential,
        operationReference: id(124),
        admissionReference: mJoin.joined.admission.admissionReference,
      });
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      const candidateHash = identityCredentials.hashCredential(
        "Session",
        prepared.sessionCredential,
      );
      assert.equal(await identityStore.resolve(candidateHash), null);
      const activateInput = {
        sessionCredential: m.sessionCredential,
        csrfCredential: m.csrfCredential,
        operationReference: id(124),
        candidateSessionCredential: prepared.sessionCredential,
        candidateCsrfCredential: prepared.csrfCredential,
        recoveryProof: prepared.recoveryProof,
      };
      minute = 4;
      const ownerRollback = createCustomerDiningBindingComposition({
        ...compositionOptions,
        dining: {
          ...compositionOptions.dining,
          store: {
            ...consumptionWriter,
            consume: createPostgresDiningAdmissionConsumptionStore(
              runner({ failAudit: true }),
              scope,
              credentials,
              consumptionAudit,
            ).consume,
          },
        },
      });
      await assert.rejects(ownerRollback.activate(activateInput), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      const identityRollback = createCustomerDiningBindingComposition({
        ...compositionOptions,
        bindings: {
          ...compositionOptions.bindings,
          activate: bindingStore(runner({ failAudit: true })).activate,
        },
      });
      await assert.rejects(identityRollback.activate(activateInput), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 9, audits: 9 });
      assert.equal((await identityStore.resolve(m.selector)).session.status, "Active");
      assert.equal(await identityStore.resolve(candidateHash), null);
      const lostBinding = createCustomerDiningBindingComposition({
        ...compositionOptions,
        bindings: {
          ...compositionOptions.bindings,
          activate: bindingStore(runner({ loseAck: true })).activate,
        },
      });
      await assert.rejects(lostBinding.activate(activateInput), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { operations: 9, audits: 9 });
      const candidate = await identityStore.resolve(candidateHash);
      assert.equal(
        candidate.session.diningParticipantReference,
        mJoin.joined.participant.participantReference,
      );
      assert.equal(candidate.session.diningSessionReference, mJoin.sessionId);
      assert.equal(candidate.session.publicTableReference, m.record.session.publicTableReference);
      assert.notEqual(candidate.session.sessionReference, m.record.session.sessionReference);
      assert.equal(
        (await identityStore.resolve(m.selector)).session.revocationReason,
        "BindingChanged",
      );
      minute = 9;
      assert.ok(at(minute) > prepared.expiresAt);
      const completed = await createCustomerDiningBindingComposition(compositionOptions).complete({
        operationReference: id(124),
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      });
      assert.equal(completed.status, "Activated");
      assert.equal(completed.sessionCredential, prepared.sessionCredential);
      assert.deepEqual(await counts(), { operations: 9, audits: 9 });
      const bindingHistory = (
        await admin.query(
          "SELECT record FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1 ORDER BY revision",
          [id(124)],
        )
      ).rows;
      assert.equal(bindingHistory.length, 3);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE target_type='GuestDiningBindingPreparation' AND target_id=$1",
            [id(124)],
          )
        ).rows[0].n,
        3,
      );
      for (const secret of [
        m.sessionCredential,
        m.csrfCredential,
        prepared.sessionCredential,
        prepared.csrfCredential,
        prepared.recoveryProof,
      ]) {
        assert.equal(JSON.stringify(bindingHistory).includes(secret), false);
        assert.equal(JSON.stringify(contextRequests).includes(secret), false);
      }
      // WP-2299: Closing preserves identity facts, but Cart's independent Active gate stays closed.
      const currentBinding = createPostgresDiningGuestBindingStore(
        runner({ readOnly: true }),
        scope,
      );
      const closingFacts = await createDiningGuestBindingQuery({
        scope: identityScope,
        repository: currentBinding,
        now: () => at(15),
      }).resolve({
        purpose: "GuestSessionBinding",
        diningSessionReference: a.sessionId,
        participantReference: a.joined.participant.participantReference,
        tableReference: id(20),
      });
      assert.equal(closingFacts.phase, "Closing");
      const cartFacts = await createDiningCartParticipationQuery({
        scope: identityScope,
        repository: createPostgresDiningParticipationStore(runner({ readOnly: true }), scope),
        now: () => at(15),
      }).resolve({
        purpose: "Cart",
        diningSessionReference: a.sessionId,
        participantReference: a.joined.participant.participantReference,
      });
      assert.equal(cartFacts, null);
      // Original admission assignment is essential even when a Move returns to the original Table.
      await configure(35);
      await move(mJoin, 35, 125, 9);
      const completionInput = {
        operationReference: id(124),
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      };
      await assert.rejects(
        createCustomerDiningBindingComposition(compositionOptions).complete(completionInput),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      await move(mJoin, 34, 126, 9);
      const movedBack = await reader.loadSession(mJoin.sessionId);
      assert.equal(movedBack.tableReference, id(34));
      assert.notEqual(
        movedBack.tableAssignmentVersion,
        mJoin.joined.admission.tableAssignmentVersion,
      );
      await assert.rejects(
        createCustomerDiningBindingComposition(compositionOptions).complete(completionInput),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(), { operations: 9, audits: 9 });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1",
            [id(124)],
          )
        ).rows[0].n,
        3,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE target_type='GuestDiningBindingPreparation' AND target_id=$1",
            [id(124)],
          )
        ).rows[0].n,
        3,
      );
      // WP-2300: synthetic HTTP cookie boundary with actual owner and Identity persistence.
      const n = await makeIdentity(36, 115);
      const nJoin = await firstJoin(36, 115);
      minute = 3;
      const httpPort = createCustomerDiningBindingComposition({
        ...compositionOptions,
        bindings: {
          ...compositionOptions.bindings,
          activate: bindingStore(runner({ loseAck: true })).activate,
        },
      });
      const origin = "https://customer.example.test";
      const server = createServer(
        createApp({
          customerDiningBinding: new CustomerDiningBindingHandler({
            allowedOrigin: origin,
            port: httpPort,
            now: () => at(minute),
          }),
        }),
      );
      try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const oldCookie = `__Host-bop-guest=${n.sessionCredential}`;
        let browserCookie = oldCookie;
        let latestResponse;
        let clientRequests = 0;
        // WP-2301: synthetic cookie/Fetch Metadata boundary; production client owns request semantics.
        const browser = createBrowserDiningBindingClient({
          online: () => true,
          async fetch(path, init) {
            assert.ok(Object.values(customerDiningBindingRoutes).includes(path));
            assert.equal(init.credentials, "same-origin");
            assert.equal(init.cache, "no-store");
            assert.equal(init.redirect, "error");
            clientRequests++;
            const response = await globalThis.fetch(
              `http://127.0.0.1:${server.address().port}${path}`,
              {
                ...init,
                headers: {
                  ...init.headers,
                  origin,
                  "sec-fetch-site": "same-origin",
                  "sec-fetch-mode": "cors",
                  cookie: browserCookie,
                },
              },
            );
            latestResponse = response.clone();
            return response;
          },
        });
        const stagedName = `__Host-bop-guest-dining-candidate-${id(127)}`;
        const preparationBody = await browser.prepare({
          operationReference: id(127),
          csrfToken: n.csrfCredential,
          admissionReference: nJoin.joined.admission.admissionReference,
        });
        const preparationResponse = latestResponse;
        assert.equal(preparationResponse.status, 200);
        assert.equal(preparationResponse.headers.get("cache-control"), "no-store");
        assert.deepEqual(await preparationResponse.json(), preparationBody);
        const preparationCookies = preparationResponse.headers.getSetCookie();
        assert.equal(preparationCookies.length, 1);
        assert.ok(preparationCookies[0].startsWith(`${stagedName}=`));
        assert.ok(preparationCookies[0].endsWith("; Path=/; Secure; HttpOnly; SameSite=Lax"));
        // Raw candidate is retained only by this synthetic cookie jar, never JSON.
        const stageCookie = preparationCookies[0].split(";")[0];
        const rawCandidate = stageCookie.slice(stagedName.length + 1);
        assert.equal(JSON.stringify(preparationBody).includes(rawCandidate), false);
        assert.deepEqual(await counts(), { operations: 9, audits: 9 });
        minute = 4;
        browserCookie = `${oldCookie}; ${stageCookie}`;
        await assert.rejects(
          browser.activate({
            operationReference: id(127),
            csrfToken: n.csrfCredential,
            candidateCsrfToken: preparationBody.candidateCsrfToken,
            recoveryProof: preparationBody.recoveryProof,
          }),
          { code: "unavailable", message: "dining binding is unavailable" },
        );
        const activationResponse = latestResponse;
        assert.equal(clientRequests, 2);
        assert.equal(activationResponse.status, 503);
        assert.deepEqual(activationResponse.headers.getSetCookie(), []);
        assert.deepEqual(await activationResponse.json(), {
          error: {
            code: "dining_binding_unavailable",
            messageKey: "customer.dining.binding_unavailable",
          },
        });
        assert.deepEqual(await counts(), { operations: 10, audits: 10 });
        assert.equal((await identityStore.resolve(n.selector)).session.status, "Revoked");
        minute = 9;
        assert.ok(at(minute) > preparationBody.expiresAt);
        const completionBody = await browser.complete({
          operationReference: id(127),
          csrfToken: preparationBody.candidateCsrfToken,
        });
        const completionResponse = latestResponse;
        assert.equal(completionResponse.status, 200);
        assert.equal(completionResponse.headers.get("cache-control"), "no-store");
        assert.deepEqual(completionResponse.headers.getSetCookie(), [
          `__Host-bop-guest=${rawCandidate}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          `${stagedName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        ]);
        assert.deepEqual(await completionResponse.json(), completionBody);
        assert.deepEqual(completionBody, {
          status: "Activated",
          operationReference: id(127),
          csrfToken: preparationBody.candidateCsrfToken,
        });
        assert.equal(JSON.stringify(completionBody).includes(rawCandidate), false);
        const publishedCookie = completionResponse.headers.getSetCookie()[0].split(";")[0];
        browserCookie = publishedCookie;
        const repeated = await browser.complete({
          operationReference: id(127),
          csrfToken: preparationBody.candidateCsrfToken,
        });
        assert.deepEqual(repeated, completionBody);
        const alreadyPublished = latestResponse;
        assert.equal(clientRequests, 4);
        assert.equal(alreadyPublished.status, 200);
        assert.deepEqual(await alreadyPublished.json(), completionBody);
        assert.deepEqual(
          alreadyPublished.headers.getSetCookie(),
          completionResponse.headers.getSetCookie(),
        );
        assert.deepEqual(await counts(), { operations: 10, audits: 10 });
        const httpHistory = (
          await admin.query(
            "SELECT record FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1 ORDER BY revision",
            [id(127)],
          )
        ).rows;
        assert.equal(httpHistory.length, 3);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE target_type='GuestDiningBindingPreparation' AND target_id=$1",
              [id(127)],
            )
          ).rows[0].n,
          3,
        );
        for (const secret of [
          n.sessionCredential,
          n.csrfCredential,
          rawCandidate,
          preparationBody.candidateCsrfToken,
          preparationBody.recoveryProof,
        ]) {
          assert.equal(JSON.stringify(httpHistory).includes(secret), false);
          assert.equal(JSON.stringify(contextRequests).includes(secret), false);
        }
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      // WP-2302: production foreground coordinator with real shared context and synthetic cookie jar.
      const o = await makeIdentity(37, 116);
      const oJoin = await firstJoin(37, 116);
      minute = 3;
      const coordinatorServer = createServer(
        createApp({
          customerDiningBinding: new CustomerDiningBindingHandler({
            allowedOrigin: origin,
            now: () => at(minute),
            port: createCustomerDiningBindingComposition({
              ...compositionOptions,
              bindings: {
                ...compositionOptions.bindings,
                activate: bindingStore(runner({ loseAck: true })).activate,
              },
            }),
          }),
        }),
      );
      const cookieJar = new Map([["__Host-bop-guest", o.sessionCredential]]);
      const observations = [];
      let publications = 0,
        generated = 0;
      setCustomerCsrfCredential(o.csrfCredential);
      try {
        await new Promise((resolve) => coordinatorServer.listen(0, "127.0.0.1", resolve));
        const client = createBrowserDiningBindingClient({
          online: () => true,
          async fetch(path, init) {
            assert.ok(Object.values(customerDiningBindingRoutes).includes(path));
            const response = await globalThis.fetch(
              `http://127.0.0.1:${coordinatorServer.address().port}${path}`,
              {
                ...init,
                headers: {
                  ...init.headers,
                  origin,
                  "sec-fetch-site": "same-origin",
                  "sec-fetch-mode": "cors",
                  cookie: [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; "),
                },
              },
            );
            observations.push({
              path,
              status: response.status,
              cookies: response.headers.getSetCookie().length,
            });
            for (const line of response.headers.getSetCookie()) {
              const pair = line.split(";")[0],
                separator = pair.indexOf("=");
              const name = pair.slice(0, separator),
                value = pair.slice(separator + 1);
              if (line.includes("Max-Age=0")) cookieJar.delete(name);
              else cookieJar.set(name, value);
            }
            return response;
          },
        });
        const coordinator = createDiningBindingCoordinator({
          binding: client,
          online: () => true,
          generatePreparationReference: () => {
            generated++;
            return id(129);
          },
          csrf: {
            get: getCustomerCsrfCredential,
            capture: captureCustomerCsrfContext,
            set(value) {
              publications++;
              setCustomerCsrfCredential(value);
            },
          },
        });
        const intent = {
          operationReference: id(128),
          admissionReference: oJoin.joined.admission.admissionReference,
        };
        assert.equal(observations.length, 0);
        await assert.rejects(coordinator.bind(intent), {
          code: "outcome-unknown",
          message: "dining binding is unavailable",
        });
        assert.equal(publications, 0);
        assert.equal(getCustomerCsrfCredential(), o.csrfCredential);
        assert.equal(cookieJar.size, 2);
        assert.deepEqual(await counts(), { operations: 11, audits: 11 });
        assert.equal((await identityStore.resolve(o.selector)).session.status, "Revoked");
        await assert.rejects(coordinator.bind({ ...intent, operationReference: id(130) }), {
          code: "outcome-unknown",
        });
        assert.equal(observations.length, 2);
        minute = 9;
        const result = await coordinator.bind(intent);
        assert.deepEqual(result, { status: "Bound", operationReference: id(128) });
        assert.equal(publications, 1);
        assert.equal(cookieJar.size, 1);
        assert.notEqual(cookieJar.get("__Host-bop-guest"), o.sessionCredential);
        assert.notEqual(getCustomerCsrfCredential(), o.csrfCredential);
        assert.deepEqual(await coordinator.bind(intent), result);
        assert.equal(publications, 1);
        assert.equal(generated, 1);
        assert.deepEqual(observations, [
          { path: customerDiningBindingRoutes.prepare, status: 200, cookies: 1 },
          { path: customerDiningBindingRoutes.activate, status: 503, cookies: 0 },
          { path: customerDiningBindingRoutes.complete, status: 200, cookies: 2 },
          { path: customerDiningBindingRoutes.complete, status: 200, cookies: 2 },
        ]);
        assert.deepEqual(await counts(), { operations: 11, audits: 11 });
        const coordinatorHistory = (
          await admin.query(
            "SELECT record FROM bop_identity.guest_dining_binding_preparation WHERE operation_id=$1 ORDER BY revision",
            [id(129)],
          )
        ).rows;
        assert.equal(coordinatorHistory.length, 3);
        assert.ok(at(minute) > coordinatorHistory[0].record.expiresAt);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE target_type='GuestDiningBindingPreparation' AND target_id=$1",
              [id(129)],
            )
          ).rows[0].n,
          3,
        );
        for (const secret of [
          o.sessionCredential,
          o.csrfCredential,
          cookieJar.get("__Host-bop-guest"),
          getCustomerCsrfCredential(),
        ]) {
          assert.equal(JSON.stringify(result).includes(secret), false);
          assert.equal(JSON.stringify(coordinatorHistory).includes(secret), false);
          assert.equal(JSON.stringify(contextRequests).includes(secret), false);
        }
      } finally {
        setCustomerCsrfCredential(null);
        coordinatorServer.closeAllConnections();
        await new Promise((resolve) => coordinatorServer.close(resolve));
      }
      // WP-2303: owner chooses versions; actual atomic writer still rejects a post-read race.
      await configure(38);
      guestTables.set(id(117), id(38));
      const pStart = await service().start(command(38, 131));
      const currentIntent = {
        guestSessionReference: id(117),
        joinCredential: pStart.joinCredential,
        operationReference: id(132),
        requestedAt: at(2),
      };
      const pJoin = await service().joinCurrent(currentIntent);
      assert.equal(pJoin.status, "Joined");
      assert.deepEqual(await service().joinCurrent({ ...currentIntent, requestedAt: at(3) }), {
        ...pJoin,
        status: "AlreadyApplied",
      });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_JOIN' AND target_id=$1",
            [pStart.session.diningSessionReference],
          )
        ).rows[0].n,
        1,
      );
      await configure(39);
      guestTables.set(id(118), id(39));
      guestTables.set(id(119), id(39));
      const qStart = await service().start(command(39, 133));
      let winner;
      const racing = service(joinWriter, async () => {
        winner = await service().joinCurrent({
          guestSessionReference: id(119),
          joinCredential: qStart.joinCredential,
          operationReference: id(135),
          requestedAt: at(2),
        });
      });
      await assert.rejects(
        racing.joinCurrent({
          guestSessionReference: id(118),
          joinCredential: qStart.joinCredential,
          operationReference: id(134),
          requestedAt: at(2),
        }),
        { code: "DINING_SESSION_VERSION_CONFLICT" },
      );
      assert.equal(winner.status, "Joined");
      assert.equal(await joinReader.resolveJoinOperation(id(134)), null);
      assert.notEqual(await joinReader.resolveJoinOperation(id(135)), null);
      assert.equal((await reader.loadSession(qStart.session.diningSessionReference)).version, 2);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_JOIN' AND target_id=$1",
            [qStart.session.diningSessionReference],
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await counts(), { operations: 11, audits: 11 });
      // WP-2304: current Identity/QR authority plus explicit request-bound synthetic abuse policy.
      const r = await makeIdentity(40, 120);
      await configure(40);
      const rStart = await service().start(command(40, 136));
      minute = 3;
      const joinOptions = {
        scope: identityScope,
        session: compositionOptions.session,
        dining: { store: { ...joinReader, join: joinWriter.join }, credentials, pepperVersion: 1 },
        contexts: compositionOptions.contexts,
        now: () => at(minute),
      };
      const requestAbuse = [];
      let allowJoin = false;
      const requestContext = {
        abuse: {
          async admit(input) {
            requestAbuse.push(input);
            assert.equal(input.guestSessionReference, id(120));
            assert.equal(input.kind, "Invitation");
            return allowJoin ? "Admitted" : "Cooldown";
          },
        },
      };
      const joinInput = {
        sessionCredential: r.sessionCredential,
        csrfCredential: r.csrfCredential,
        joinCredential: rStart.joinCredential,
        operationReference: id(137),
      };
      const guestJoin = createCustomerDiningJoinComposition(joinOptions);
      await assert.rejects(guestJoin.join(joinInput, requestContext), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(await joinReader.resolveJoinOperation(id(137)), null);
      assert.equal((await reader.loadSession(rStart.session.diningSessionReference)).version, 1);
      allowJoin = true;
      const lostJoin = createCustomerDiningJoinComposition({
        ...joinOptions,
        dining: {
          ...joinOptions.dining,
          store: {
            ...joinReader,
            join: createPostgresDiningSessionJoinStore(
              runner({ loseAck: true }),
              scope,
              credentials,
              joinAudit,
            ).join,
          },
        },
      });
      await assert.rejects(lostJoin.join(joinInput, requestContext), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      const joinedRecord = await joinReader.resolveJoinOperation(id(137));
      assert.notEqual(joinedRecord, null);
      assert.equal((await identityStore.resolve(r.selector)).session.status, "Active");
      minute = 4;
      const joinedReceipt = await guestJoin.join(joinInput, requestContext);
      assert.deepEqual(joinedReceipt, {
        status: "Joined",
        operationReference: id(137),
        admissionReference: joinedRecord.admission.admissionReference,
      });
      assert.deepEqual(await guestJoin.join(joinInput, requestContext), joinedReceipt);
      assert.equal(requestAbuse.length, 4);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_JOIN' AND target_id=$1",
            [rStart.session.diningSessionReference],
          )
        ).rows[0].n,
        1,
      );
      await identityStore.revoke({
        selectorHash: r.selector,
        expectedVersion: 1,
        reason: "RiskChanged",
        observedAt: at(4),
        operationReference: id(138),
        operationIntentHash: identityCredentials.hashOperationIntent(
          "synthetic current Join revocation",
        ),
      });
      await assert.rejects(guestJoin.join(joinInput, requestContext), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(requestAbuse.length, 4);
      assert.deepEqual(await counts(), { operations: 11, audits: 11 });
      for (const secret of [r.sessionCredential, r.csrfCredential, rStart.joinCredential]) {
        assert.equal(JSON.stringify(joinedReceipt).includes(secret), false);
        assert.equal(JSON.stringify(joinedRecord).includes(secret), false);
        assert.equal(JSON.stringify(requestAbuse).includes(secret), false);
        assert.equal(JSON.stringify(contextRequests).includes(secret), false);
      }
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
});

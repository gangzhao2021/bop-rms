import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createDiningTable,
  transitionDiningTable,
  createDiningTableService,
  createDiningSessionService,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningSessionJoinStore,
  createPostgresDiningAdmissionConsumptionStore,
  createPostgresDiningGuestBindingStore,
  createPostgresDiningParticipationStore,
  createDiningCartParticipationQuery,
  createDiningGuestBindingQuery,
  assertCurrentDiningGuestTableContext,
} from "../../rms/dining/src/index.ts";
import {
  createPostgresGuestDiningBindingStore,
  createGuestDiningBindingCredentialProvider,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
const { Client } = pg;
// Synthetic local-only Staff, QR mapping and abuse authority. No production provider claims.
export async function seedDining({ admin, context, sessionRole, sessionTransactions, fixture }) {
  const role = `wp2310_d_${context.runId}`;
  assert.match(role, /^wp2310_d_[a-f0-9]+$/u);
  const scope = { tenantReference: id(900), brandReference: id(1), storeReference: id(2) };
  const identityScope = { brandReference: id(1), storeReference: id(2) };
  let sequence = 1000;
  let browsers = 0;
  const key = randomBytes(32);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const credentials = {
    generateReference: () => id(++sequence),
    generateJoinCredential: () => randomBytes(16).toString("base64url"),
    hashJoinCredential: (kind, value) =>
      createHmac("sha256", key).update(`DiningJoin:${kind}:${value}`).digest("hex"),
    hashOperationIntent: digest,
    equals: (a, b) => a === b,
  };
  const tableReferences = {
    hashIntent: (value) => `sha256:${digest(value)}`,
    equals: (a, b) => a === b,
  };
  const audit = (action, target, instant) => ({
    auditId: id(++sequence),
    brandId: id(1),
    storeId: id(2),
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
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await admin.query(`GRANT USAGE ON SCHEMA rms_dining,platform_helpers TO ${role}`);
  await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_participant,rms_dining.dining_identity_admission TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session_start_operation,rms_dining.dining_session_join_operation,rms_dining.dining_admission_consumption_operation TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,INSERT ON bop_identity.guest_dining_binding_preparation TO ${sessionRole}`,
  );
  await admin.query(
    `GRANT UPDATE (status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO ${sessionRole}`,
  );
  for (const selected of [role, sessionRole]) {
    await admin.query(`GRANT USAGE ON SCHEMA platform_audit TO ${selected}`);
    await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${selected}`);
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${selected}`,
    );
  }
  function runner(readOnly = false) {
    return {
      async run(action) {
        const client = new Client({
          ...context.clientConfig,
          query_timeout: 5000,
          connectionTimeoutMillis: 2000,
        });
        await client.connect();
        try {
          await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='5s'");
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          const cleared = await client.query(
            "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
          );
          assert(!cleared.rows[0].brand && !cleared.rows[0].store);
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
  }
  const tableReader = createPostgresDiningTableStore(runner(true), scope, tableReferences);
  const tableWriter = createPostgresDiningTableStore(runner(), scope, tableReferences);
  const reader = createPostgresDiningSessionStartStore(runner(true), scope, credentials);
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
    repository: { ...tableWriter, loadSession: reader.loadSession },
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
      createdAt: at,
      observedAt: at,
    });
    await tableService.executeTable({
      action: "CreateDraft",
      operationReference: id(++sequence),
      candidate: draft,
      expectedAggregateVersion: null,
      observedAt: at,
    });
    const published = transitionDiningTable(draft, "Publish", at);
    await tableService.executeTable({
      action: "Publish",
      operationReference: id(++sequence),
      candidate: published,
      expectedAggregateVersion: 1,
      observedAt: at,
    });
    return published;
  }
  const brand = createBrand({
    brandReference: id(1),
    code: "DINING",
    displayName: "Synthetic Dining",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: id(2),
    brandReference: id(1),
    code: "DINING-1",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });

  const staffService = createDiningSessionService({
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
            brandReference: id(1),
            storeReference: id(2),
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
    store: { ...reader, start: writer.start },
  });
  const contextsByTable = new Map();
  const contexts = {
    resolve: async (input) => contextsByTable.get(input.session.publicTableReference) ?? null,
  };
  const joinAudit = (descriptor) => ({
    ...audit("DINING_SESSION_JOIN", descriptor.diningSessionReference, descriptor.occurredAt),
    actor: { type: "System" },
    targetType: "DiningSession",
    reasonCode: "AUTHORIZED_DINING_JOIN",
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
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
  const bindings = createPostgresGuestDiningBindingStore(
    sessionTransactions,
    identityScope,
    {
      append: async (tx, descriptor) =>
        appendAuditRecordInTransaction(tx, {
          ...audit(
            `IDENTITY_GUEST_DINING_BINDING_${descriptor.action.toUpperCase()}`,
            descriptor.operationReference,
            descriptor.occurredAt,
          ),
          actor: { type: "System" },
          targetType: "GuestDiningBindingPreparation",
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
        }),
    },
    credentials.equals,
  );
  return {
    participation: createDiningCartParticipationQuery({
      scope: identityScope,
      repository: createPostgresDiningParticipationStore(runner(true), scope),
      now: () => at,
    }),
    sessionBinding: {
      async validate(session, observedAt) {
        try {
          if ((await fixture.options.session.binding.validate(session, observedAt)) !== "Current")
            return "Unavailable";
          if (session.diningState === "ContextOnly") return "Current";
          const currentContext = assertCurrentDiningGuestTableContext(
            {
              brandReference: session.brandReference,
              storeReference: session.storeReference,
              publicStoreReference: session.publicStoreReference,
              publicTableReference: session.publicTableReference,
              channel: session.channel,
              qrRevocationVersion: session.qrRevocationVersion,
              observedAt,
            },
            await contexts.resolve({ session, observedAt, purpose: "DiningAdmission" }),
          );
          const current = await createDiningGuestBindingQuery({
            scope: identityScope,
            repository: createPostgresDiningGuestBindingStore(runner(true), scope),
            now: () => at,
          }).resolve({
            purpose: "GuestSessionBinding",
            diningSessionReference: session.diningSessionReference,
            participantReference: session.diningParticipantReference,
            tableReference: currentContext.tableReference,
          });
          return current === null ? "Unavailable" : "Current";
        } catch {
          return "Unavailable";
        }
      },
    },
    options: {
      join: {
        contexts,
        dining: {
          store: createPostgresDiningSessionJoinStore(runner(), scope, credentials, joinAudit),
          credentials,
          pepperVersion: 1,
        },
      },
      binding: {
        contexts,
        bindings,
        dining: {
          credentials,
          store: createPostgresDiningAdmissionConsumptionStore(
            runner(),
            scope,
            credentials,
            consumptionAudit,
          ),
          binding: createPostgresDiningGuestBindingStore(runner(true), scope),
        },
        recovery: createGuestDiningBindingCredentialProvider(key),
        preparationLifetimeSeconds: 300,
      },
      resolveRequestContext: () => ({ abuse: { admit: async () => "Admitted" } }),
    },
    async prepare() {
      const table = 6 + browsers * 10;
      const publicTable = 5 + browsers * 10;
      const qr = 3 + browsers * 10;
      await configure(table);
      const started = await staffService.start({
        tableReference: id(table),
        expectedAssignmentVersion: 2,
        operationReference: id(++sequence),
        joinKind: "Invitation",
        requestedAt: at,
      });
      fixture.payload.publicTableReference = id(publicTable);
      fixture.payload.qrReference = id(qr);
      fixture.context.publicTableReference = id(publicTable);
      fixture.context.tableReference = id(table);
      contextsByTable.set(id(publicTable), { ...fixture.context });
      browsers++;
      return started.joinCredential;
    },
    async verify() {
      for (const [sql, expected] of [
        ["SELECT count(*)::int AS n FROM rms_dining.dining_session_join_operation", browsers],
        [
          "SELECT count(*)::int AS n FROM rms_dining.dining_admission_consumption_operation",
          browsers,
        ],
        [
          "SELECT count(*)::int AS n FROM bop_identity.guest_dining_binding_preparation",
          browsers * 3,
        ],
        [
          "SELECT count(*)::int AS n FROM bop_identity.guest_session WHERE status='Active' AND dining_state='DiningBound'",
          browsers,
        ],
        [
          "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='DINING_SESSION_JOIN'",
          browsers,
        ],
        [
          "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='DINING_IDENTITY_ADMISSION_CONSUME'",
          browsers,
        ],
        [
          "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE target_type='GuestDiningBindingPreparation'",
          browsers * 3,
        ],
      ])
        assert.equal((await admin.query(sql)).rows[0].n, expected);
    },
    close() {
      key.fill(0);
    },
  };
}

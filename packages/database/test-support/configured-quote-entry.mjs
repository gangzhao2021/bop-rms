import assert from "node:assert/strict";
import pg from "pg";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import {
  createDiningTable,
  parseDiningSession,
  parseDiningParticipant,
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import { seedCheckoutCatalog, cartCatalogTables } from "./cart-catalog-seed.mjs";
import { id } from "../../rms/ordering/src/tests/configured-cart-quote.fixture.ts";
const { Client } = pg;

/** Actual owner storage with explicitly synthetic Store/QR, safety and commercial evidence. */
export async function prepareConfiguredQuoteEntry({ context, admin, f, guest, now, references }) {
  const roles = ["i", "c", "d"].map((suffix) => "wp2402_cqe_" + suffix + "_" + context.runId);
  const created = [];
  let active = 0,
    catalogReads = 0;
  const scope = { brandReference: f.cart.brandReference, storeReference: f.cart.storeReference };
  const ownerScope = { tenantReference: id(400001), ...scope };
  const runner = (index) => ({
    async run(action) {
      const client = new Client({
        ...context.clientConfig,
        query_timeout: 5000,
        connectionTimeoutMillis: 2000,
      });
      await client.connect();
      active++;
      if (index === 1) catalogReads++;
      try {
        await client.query(
          index === 1 ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
        );
        await client.query("SET LOCAL ROLE " + roles[index]);
        await client.query("SET LOCAL statement_timeout='5s'");
        const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
        active--;
      }
    },
  });
  const cleanup = async () => {
    assert.equal(active, 0);
    for (const role of created.splice(0).reverse()) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
  };
  try {
    for (const role of roles) {
      assert.match(role, /^wp2402_cqe_[icd]_[a-f0-9]+$/u);
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      created.push(role);
      await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
    }
    await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + roles[0]);
    await admin.query(
      "GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation TO " +
        roles[0],
    );
    await admin.query(
      "GRANT UPDATE(status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO " +
        roles[0],
    );
    await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + roles[1]);
    await admin.query(
      "GRANT SELECT ON " +
        cartCatalogTables.map((name) => "rms_catalog." + name).join(",") +
        " TO " +
        roles[1],
    );
    await admin.query("GRANT USAGE ON SCHEMA rms_dining TO " + roles[2]);
    await admin.query(
      "GRANT SELECT ON rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_participant TO " +
        roles[2],
    );
    const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
    const sessionCredential = credentials.generateCredential("Session");
    const csrfCredential = credentials.generateCredential("Csrf");
    const identity = createPostgresGuestSessionEntryStore(runner(0), scope);
    const record = createGuestSessionRecord({
      session: guest,
      sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
      csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
      operationReference: id(400010),
      operationIntentHash: credentials.hashOperationIntent("synthetic configured customer"),
    });
    if (f.cart.orderType === "DineIn") {
      const parentCredential = credentials.generateCredential("Session");
      const parentCsrf = credentials.generateCredential("Csrf");
      const parentAt = new Date(Date.parse(f.observedAt) - 60000).toISOString();
      const parent = createGuestSessionRecord({
        ...record,
        operationReference: id(400011),
        sessionSelectorHash: credentials.hashCredential("Session", parentCredential),
        csrfSelectorHash: credentials.hashCredential("Csrf", parentCsrf),
        session: {
          ...guest,
          sessionReference: id(400012),
          diningState: "ContextOnly",
          diningSessionReference: null,
          diningParticipantReference: null,
          createdAt: parentAt,
          lastSeenAt: parentAt,
          idleExpiresAt: new Date(Date.parse(parentAt) + 14400000).toISOString(),
          absoluteExpiresAt: new Date(Date.parse(parentAt) + 86400000).toISOString(),
        },
      });
      await identity.create({ record: parent });
      await identity.rotate({
        currentSelectorHash: parent.sessionSelectorHash,
        expectedVersion: 1,
        nextRecord: createGuestSessionRecord({
          ...record,
          session: { ...guest, rotatedFromGuestSessionReference: parent.session.sessionReference },
        }),
        reason: "BindingChanged",
        observedAt: f.observedAt,
      });
      const table = createDiningTable({
        ...ownerScope,
        tableReference: id(81),
        stableLabel: "SYNTHETIC-CONFIGURED",
        areaReference: id(400020),
        areaCode: "ROOM",
        capacity: 4,
        accessibilityAttributes: [],
        lifecycle: "Published",
        qrStatus: "Active",
        qrVersion: 1,
        operationalState: "Available",
        blockReasonCode: null,
        activeDiningSessionReference: id(67),
        aggregateVersion: 1,
        createdAt: parentAt,
        observedAt: f.observedAt,
      });
      const session = parseDiningSession({
        ...scope,
        diningSessionReference: id(67),
        tableReference: id(81),
        tableAssignmentVersion: 1,
        phase: "Active",
        version: 1,
        startedByActorReference: id(400021),
        startedAt: parentAt,
        hostParticipantReference: id(68),
      });
      const participant = parseDiningParticipant({
        participantReference: id(68),
        diningSessionReference: id(67),
        status: "Active",
        version: 1,
        joinedAt: f.observedAt,
        leftAt: null,
      });
      await admin.query(
        "INSERT INTO rms_dining.dining_table(table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES($1,$2,$3,$4,1,$5::jsonb,$6,$7)",
        [
          id(81),
          ownerScope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          JSON.stringify(table),
          parentAt,
          f.observedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_session(session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES($1,$2,$3,$4,$5,1,'Active',$6::jsonb,$7)",
        [
          id(67),
          ownerScope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          id(81),
          JSON.stringify(session),
          parentAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_participant(participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
        [
          id(68),
          ownerScope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          id(67),
          JSON.stringify(participant),
        ],
      );
    } else {
      await identity.create({ record });
      for (const revision of [1, 2])
        await admin.query(
          "INSERT INTO rms_ordering.cart_binding_record(operation_id,revision,brand_id,store_id,cart_id,guest_session_id,predecessor_session_id,acknowledged_at,prepared_at,valid_until,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10)",
          [
            id(400030),
            revision,
            scope.brandReference,
            scope.storeReference,
            f.cart.cartReference,
            guest.sessionReference,
            id(400031),
            f.observedAt,
            new Date(Date.parse(f.observedAt) + 600000).toISOString(),
            revision === 2 ? f.observedAt : null,
          ],
        );
    }
    const { attached, catalogId } = await seedCheckoutCatalog(
      admin,
      id,
      f.observedAt,
      f.cart,
      scope,
    );
    await admin.query(
      "UPDATE rms_catalog.product_version SET tax_classification_id=$1 WHERE product_version_id=$2",
      [f.catalogLines[0].snapshot.taxClassificationReference, attached.productVersionReference],
    );
    await admin.query(
      "UPDATE rms_catalog.option_set_version SET display_style='Quantity',allow_repeated_option=true,maximum_selection=3,per_option_maximum_quantity=3,maximum_total_quantity=3 WHERE option_set_version_id=$1",
      [attached.ruleEvidence[0].optionSetVersionReference],
    );
    await admin.query(
      "UPDATE rms_catalog.product_option_binding SET maximum_selection_override=3 WHERE binding_id=$1",
      [attached.ruleEvidence[0].bindingReference],
    );
    const safety = (request, kind, status) => ({
      kind,
      brandReference: request.brandReference,
      storeReference: request.storeReference,
      sellableReference: request.sellableReference,
      observedAt: request.observedAt,
      expiresAt: new Date(Date.parse(request.observedAt) + 60000).toISOString(),
      status,
      reasonCode: "SYNTHETIC_SAFETY",
    });
    return {
      sessionTransactions: runner(0),
      sessionOptions: { credentials, binding: { validate: async () => "Current" } },
      sessions: new GuestSessionService({
        store: identity,
        credentials,
        binding: { validate: async () => "Current" },
        admission: { consume: async () => null },
        now,
      }), // Store/QR and consumed-admission authority remain explicit synthetic dependencies here.
      participation: createDiningCartParticipationQuery({
        scope,
        now,
        repository: createPostgresDiningParticipationStore(runner(2), ownerScope),
      }),
      sessionCredential,
      csrfCredential,
      cleanup,
      catalogReads: () => catalogReads,
      catalogTransactions: runner(1),
      catalogScope: {
        menuReference: catalogId(1),
        sourceChannel: f.cart.sourceChannel,
        channelCode: attached.catalogChannelCode,
        orderTypeCode: attached.catalogOrderTypeCode,
      },
      catalogSafety: {
        inventory: { loadEvidence: async (request) => safety(request, "Inventory", "Available") },
        killSwitch: { loadEvidence: async (request) => safety(request, "KillSwitch", "Clear") },
      },
      catalogReferences: { generate: references.generateReference, hash: references.hashIntent },
      revoke: async () =>
        identity.revoke({
          selectorHash: record.sessionSelectorHash,
          expectedVersion: 1,
          reason: "RiskChanged",
          observedAt: now(),
          operationReference: id(400040),
          operationIntentHash: credentials.hashOperationIntent("synthetic configured revoke"),
        }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { fixture as entryFixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerCheckoutSessionRead } from "../../../apps/api/src/customer-checkout-session-read.ts";
import { createPostgresCheckoutSessionAllocationStore } from "../../rms/ordering/src/index.ts";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCheckoutSessionStore,
  parseCheckoutSession,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
it("atomically creates checkout sessions and Audit, recovers contention and rejects stale admission", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_session_tx" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_session_" + context.runId;
    assert.match(role, /^wp2402_session_[a-f0-9]+$/u);
    let runtime;
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_ordering,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT,UPDATE ON rms_ordering.cart TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_line TO " + role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.checkout_session_record,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const now = new Date(Date.now() - 1000).toISOString();
      await admin.query(
        `INSERT INTO rms_ordering.cart
    (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
     lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
    VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5,'Active',$6,$7,3600,86400,$5::timestamptz+interval '1 hour',$5::timestamptz+interval '24 hours')`,
        [id(3), id(1), id(2), id(4), now, id(5), "sha256:" + "a".repeat(64)],
      );
      function runner({ failAudit = false, loseAck = false } = {}) {
        return {
          async run(action) {
            const client = new Client({
              ...context.clientConfig,
              query_timeout: 5000,
              connectionTimeoutMillis: 2000,
            });
            await client.connect();
            let committed = false;
            try {
              await client.query("BEGIN");
              await client.query("SET LOCAL ROLE " + role);
              await client.query("SET LOCAL lock_timeout='5s'");
              await client.query("SET LOCAL statement_timeout='5s'");
              const result = await action({
                async query(sql, values) {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              if (loseAck) throw new Error("synthetic lost acknowledgement");
              return result;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        };
      }

      const hash = "sha256:" + "a".repeat(64);
      const until = new Date(Date.parse(now) + 600000).toISOString();
      await admin.query(
        `INSERT INTO rms_ordering.cart_quote_attachment
        (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,
         quote_id,quote_version,quote_input_digest,currency_code,currency_metadata_version,
         currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
         line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,1,$6,'CAD',1,$8,100,0,0,0,100,1,'[]',$9,$10,$9,$9::timestamptz+interval '24 hours')`,
        [id(7), id(1), id(2), id(3), id(4), hash, id(8), id(9), now, until],
      );
      function candidate(n = 20, operation = 21) {
        const binding = {
          ...scope,
          cartReference: id(3),
          cartVersion: 1,
          quoteReference: id(8),
          orderType: "Pickup",
          sourceChannel: "Qr",
        };
        return parseCheckoutSession({
          schemaVersion: 1,
          checkoutSessionReference: id(n),
          createOperationReference: id(operation),
          submissionReference: id(n + 2),
          paymentOperationReference: id(n + 3),
          createdAt: now,
          validation: {
            ...binding,
            validationReference: id(10),
            validationIntentHash: hash,
            guestSessionReference: id(4),
            quoteVersion: 1,
            quoteInputDigest: hash,
            catalogLines: [
              {
                cartItemReference: id(11),
                sellableReference: id(12),
                menuVersionReference: id(13),
                productVersionReference: id(14),
                validatedAt: now,
              },
            ],
            fulfillment: {
              ...binding,
              status: "Accepted",
              evidenceReference: id(15),
              evidenceVersion: 1,
              evidenceDigest: hash,
              checkedAt: now,
              validUntil: until,
            },
            validatedAt: now,
            validUntil: until,
          },
        });
      }
      const authority = {
        ...scope,
        guestSessionReference: id(4),
        checkedAt: now,
        validUntil: until,
        audit: null,
      };
      let permitted = true;
      const gates = {
        async authorize(tx, auth) {
          const result = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
          assert.equal(result.rows[0].store, scope.storeReference);
          return permitted && auth.guestSessionReference === id(4);
        },
        audit(session) {
          return {
            auditId: id(Number.parseInt(session.checkoutSessionReference.slice(-4), 16) + 1000),
            brandId: id(1),
            storeId: id(2),
            actor: { type: "System" },
            actionCode: "ORDERING_CHECKOUT_SESSION_CREATE",
            reasonCode: "AUTHORIZED_CHECKOUT_CREATE",
            targetType: "CheckoutSession",
            targetId: session.checkoutSessionReference,
            occurredAt: now,
            correlationId: id(16),
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          };
        },
      };
      await admin.query(
        "GRANT SELECT,INSERT ON rms_ordering.checkout_session_allocation TO " + role,
      );
      function allocation(n, operation = n + 1) {
        const c = candidate(n, operation);
        return {
          ...scope,
          guestSessionReference: id(4),
          cartReference: id(3),
          cartVersion: 1,
          quoteReference: id(8),
          quoteVersion: 1,
          createOperationReference: c.createOperationReference,
          checkoutSessionReference: c.checkoutSessionReference,
          submissionReference: c.submissionReference,
          paymentOperationReference: c.paymentOperationReference,
          allocatedAt: now,
        };
      }
      const allocationGates = {
        authorize: gates.authorize,
        audit: (a) => ({
          ...gates.audit(a),
          auditId: id(Number.parseInt(a.checkoutSessionReference.slice(-4), 16) + 2000),
          actionCode: "ORDERING_CHECKOUT_SESSION_ALLOCATE",
          occurredAt: a.allocatedAt,
        }),
      };
      const allocations = createPostgresCheckoutSessionAllocationStore(
        runner(),
        scope,
        allocationGates,
      );
      const store = createPostgresCheckoutSessionStore(runner(), scope, gates);
      const first = candidate();
      await assert.rejects(store.create(first, authority), { code: "INTENT_CONFLICT" });
      await allocations.allocate(allocation(20, 21), authority);
      await assert.rejects(
        createPostgresCheckoutSessionStore(runner({ loseAck: true }), scope, gates).create(
          first,
          authority,
        ),
        { code: "DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal((await store.create(candidate(30, 21), authority)).status, "AlreadyCreated");
      assert.deepEqual(await store.load(first.checkoutSessionReference, authority), first);
      const request = {
        createOperationReference: id(21),
        cartReference: id(3),
        cartVersion: 1,
        quoteReference: id(8),
        quoteVersion: 1,
      };
      assert.deepEqual(await store.resolveOperation(request, authority), first);
      await assert.rejects(store.resolveOperation({ ...request, cartVersion: 2 }, authority), {
        code: "INTENT_CONFLICT",
      });
      await allocations.allocate(allocation(40, 41), authority);
      const races = await Promise.all([
        store.create(candidate(40, 41), authority),
        store.create(candidate(50, 41), authority),
      ]);
      assert.deepEqual(races.map((r) => r.status).sort(), ["AlreadyCreated", "Created"]);
      assert.deepEqual(races[0].session, races[1].session);
      await allocations.allocate(allocation(60, 61), authority);
      await assert.rejects(
        store.create({ ...candidate(60, 61), paymentOperationReference: id(69) }, authority),
        { code: "INTENT_CONFLICT" },
      );
      await assert.rejects(
        createPostgresCheckoutSessionStore(runner({ failAudit: true }), scope, gates).create(
          candidate(60, 61),
          authority,
        ),
        { code: "DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await store.load(id(60), authority), null);
      permitted = false;
      await assert.rejects(store.load(id(20), authority), { code: "PERMISSION_DENIED" });
      await assert.rejects(store.create(candidate(70, 71), authority), {
        code: "PERMISSION_DENIED",
      });
      permitted = true;

      await assert.rejects(
        createPostgresCheckoutSessionAllocationStore(
          runner({ loseAck: true }),
          scope,
          allocationGates,
        ).allocate(allocation(150), authority),
        { code: "DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(
        await allocations.allocate(allocation(160, 151), authority),
        allocation(150),
      );
      await assert.rejects(
        allocations.allocate({ ...allocation(160, 151), quoteVersion: 2 }, authority),
        { code: "INTENT_CONFLICT" },
      );
      const allocated = await Promise.all([
        allocations.allocate(allocation(170), authority),
        allocations.allocate(allocation(180, 171), authority),
      ]);
      assert.deepEqual(allocated[0], allocated[1]);
      await assert.rejects(
        createPostgresCheckoutSessionAllocationStore(
          runner({ failAudit: true }),
          scope,
          allocationGates,
        ).allocate(allocation(190), authority),
        { code: "DEPENDENCY_UNAVAILABLE" },
      );
      const allocationCounts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) AS allocations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_CHECKOUT_SESSION_ALLOCATE') AS audits",
      );
      assert.deepEqual(allocationCounts.rows[0], { allocations: 5, audits: 5 });
      // Real persisted Identity and actual crypto; current Store/QR binding and validation
      // remain explicit synthetic ports in this bounded composition test.
      await admin.query("GRANT USAGE ON SCHEMA bop_identity TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation TO " +
          role,
      );
      const credentialProvider = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
      const sessionCredential = credentialProvider.generateCredential("Session");
      const csrfCredential = credentialProvider.generateCredential("Csrf");
      const identityRecord = createGuestSessionRecord({
        session: {
          sessionReference: id(4),
          status: "Active",
          version: 1,
          ...scope,
          publicStoreReference: id(110),
          publicTableReference: null,
          channel: "Pickup",
          locale: "en-CA",
          qrReference: id(111),
          qrRevocationVersion: 1,
          diningState: "ContextOnly",
          diningSessionReference: null,
          diningParticipantReference: null,
          createdAt: now,
          lastSeenAt: now,
          idleExpiresAt: new Date(Date.parse(now) + 4 * 60 * 60 * 1000).toISOString(),
          absoluteExpiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
          orderClosedAt: null,
          closureExpiresAt: null,
          rotatedFromGuestSessionReference: null,
          revocationReason: null,
          revokedAt: null,
        },
        sessionSelectorHash: credentialProvider.hashCredential("Session", sessionCredential),
        csrfSelectorHash: credentialProvider.hashCredential("Csrf", csrfCredential),
        operationReference: id(112),
        operationIntentHash: credentialProvider.hashOperationIntent("synthetic session entry"),
      });
      await createPostgresGuestSessionEntryStore(runner(), scope).create({
        record: identityRecord,
      });
      let reference = 120;
      let validationFailure = true;
      const validationIds = [];
      const compositionOptions = {
        scope,
        transactions: runner(),
        credentials: credentialProvider,
        binding: () => ({ validate: async () => "Current" }),
        now: () => new Date().toISOString(),
        quoteVersion: 1,
        nextReference: () => id(++reference),
        allocationAudit: allocationGates.audit,
        audit: (session, auth) => ({
          ...gates.audit(session, auth),
          occurredAt: session.createdAt,
        }),
        validate: async ({ allocation: assigned }) => {
          validationIds.push([
            assigned.checkoutSessionReference,
            assigned.submissionReference,
            assigned.paymentOperationReference,
          ]);
          if (validationFailure) throw new Error("synthetic validation failure");
          return candidate().validation;
        },
      };
      const composed = createCustomerCheckoutSessionComposition(compositionOptions);
      const command = {
        createOperationReference: id(119),
        cartReference: id(3),
        cartVersion: 1,
        quoteReference: id(8),
        quoteVersion: 1,
      };
      const envelope = { sessionCredential, csrfCredential, command };
      await assert.rejects(
        composed.create({
          ...envelope,
          csrfCredential: credentialProvider.generateCredential("Csrf"),
        }),
        { code: "PERMISSION_DENIED" },
      );
      await assert.rejects(composed.create(envelope), { code: "DEPENDENCY_UNAVAILABLE" });
      validationFailure = false;
      const created = await composed.create(envelope);
      assert.deepEqual(validationIds[0], validationIds[1]);
      assert.equal(created.session.submissionReference, validationIds[0][1]);
      assert.equal(created.status, "Created");
      assert.equal((await composed.create(envelope)).status, "AlreadyCreated");
      const reader = createCustomerCheckoutSessionRead({
        scope,
        transactions: runner(),
        credentials: credentialProvider,
        binding: () => ({ validate: async () => "Current" }),
        now: () => new Date().toISOString(),
      });
      const readInput = {
        sessionCredential,
        csrfCredential,
        checkoutSessionReference: created.session.checkoutSessionReference,
      };
      assert.deepEqual(await reader.read(readInput), created.session);
      await assert.rejects(reader.read({ ...readInput, checkoutSessionReference: id(999) }), {
        code: "PERMISSION_DENIED",
      });
      await assert.rejects(
        reader.read({
          ...readInput,
          csrfCredential: credentialProvider.generateCredential("Csrf"),
        }),
        { code: "PERMISSION_DENIED" },
      );
      const entry = entryFixture().options;
      runtime = createLocalCustomerRuntime({
        scope,
        entry: {
          ...entry,
          session: { ...entry.session, credentials: credentialProvider },
        },
        menuStores: { resolvePublic: async () => null },
        sessionTransactions: runner(),
        menuTransactions: runner(),
        checkoutSessions: compositionOptions,
        allowedOrigin: "https://customer.example",
        now: compositionOptions.now,
        uuidV7Factory: () => id(++reference),
        runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
      });
      await runtime.listen();
      const address = runtime.server.address();
      assert.ok(address && typeof address === "object");
      const base = "http://127.0.0.1:" + address.port;
      const headers = {
        origin: "https://customer.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-csrf-token": csrfCredential,
        cookie: "__Host-bop-guest=" + sessionCredential,
        "idempotency-key": command.createOperationReference,
      };
      const httpCreate = await globalThis.fetch(
        base + "/api/v1/carts/" + id(3) + "/checkout-sessions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ cartVersion: 1, quoteReference: id(8) }),
        },
      );
      assert.equal(httpCreate.status, 200);
      const projected = await httpCreate.json();
      assert.deepEqual(projected, {
        schemaVersion: 1,
        session: {
          checkoutSessionReference: created.session.checkoutSessionReference,
          cartReference: id(3),
          cartVersion: 1,
          quoteReference: id(8),
          quoteVersion: 1,
          createdAt: created.session.createdAt,
        },
      });
      const readUrl =
        base + "/api/v1/checkout-sessions/" + created.session.checkoutSessionReference;
      const httpRead = await globalThis.fetch(readUrl, { headers });
      assert.equal(httpRead.status, 200);
      assert.equal(httpRead.headers.get("cache-control"), "no-store");
      assert.deepEqual(await httpRead.json(), projected);
      await admin.query(
        "UPDATE bop_identity.guest_session SET status='Revoked',version=version+1,revocation_reason='RiskChanged',revoked_at=date_trunc('milliseconds',clock_timestamp()) WHERE guest_session_id=$1",
        [id(4)],
      );
      await assert.rejects(composed.create(envelope), { code: "PERMISSION_DENIED" });
      await assert.rejects(reader.read(readInput), { code: "PERMISSION_DENIED" });
      assert.equal((await globalThis.fetch(readUrl, { headers })).status, 404);
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=2 WHERE cart_id=$1", [
        id(3),
      ]);
      await assert.rejects(store.create(candidate(80, 81), authority), { code: "INTENT_CONFLICT" });
      assert.deepEqual(await store.resolveOperation(request, authority), first);
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_record) AS sessions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_CHECKOUT_SESSION_CREATE') AS audits",
      );
      assert.deepEqual(counts.rows[0], { sessions: 3, audits: 3 });
    } finally {
      if (runtime) await runtime.shutdown("SIGTERM");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});

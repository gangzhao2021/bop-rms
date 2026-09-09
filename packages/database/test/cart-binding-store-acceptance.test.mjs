import { createCustomerCartRemovalComposition } from "../../../apps/api/src/customer-cart-removal-composition.ts";
import { createHash } from "node:crypto";
import { createPickupCartCreationCoordinator } from "../../../apps/customer-pwa/src/cart/pickup-cart-creation.ts";
import { createBrowserCustomerCartClient } from "../../../apps/customer-pwa/src/cart/cart-client.ts";
import { createCustomerCartBindingComposition } from "../../../apps/api/src/customer-cart-binding-composition.ts";
import { createBrowserCartBindingClient } from "../../../apps/customer-pwa/src/cart/cart-binding-client.ts";
import { createCustomerCartReadPort } from "../../../apps/api/src/customer-cart-read-composition.ts";
import { CustomerCartHandler } from "../../../apps/api/src/customer-cart.ts";
import { createServer } from "node:http";
import { createApp } from "../../../apps/api/src/app.ts";
import { CustomerCartBindingHandler } from "../../../apps/api/src/customer-cart-binding.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPickupCartBindingStore,
  createPostgresPickupCartBindingReader,
  createPickupCartReadService,
  createCustomerCartViewQuery,
  createPostgresCartQuoteReader,
  createPostgresCartQueryStore,
  createPostgresCartItemCommandStore,
  createPostgresCartItemOperationStore,
  createCartItemCommandService,
} from "../../rms/ordering/src/index.ts";
import {
  createGuestSessionRecord,
  createGuestBindingService,
  createGuestSessionCredentialProvider,
  createGuestBindingCredentialProvider,
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
  createPostgresGuestBindingStore,
} from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `018f5500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n) => new Date(Date.parse("2026-09-08T12:00:00.000Z") + n * 1000).toISOString();
const scope = { brandReference: id(2), storeReference: id(3) };
function guest(n) {
  return {
    ...scope,
    sessionReference: id(n),
    status: "Active",
    version: 1,
    publicStoreReference: id(4),
    publicTableReference: null,
    channel: "Pickup",
    locale: "en-CA",
    qrReference: id(5),
    qrRevocationVersion: 1,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
    createdAt: at(-60),
    lastSeenAt: at(-60),
    idleExpiresAt: at(14340),
    absoluteExpiresAt: at(86340),
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  };
}
it("composes actual Identity and Ordering stores with atomic, isolated and repeatable binding", async () => {
  await withIsolatedDatabase({ caseId: "wp2237_binding" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const identityRole = `wp2237_i_${context.runId}`;
    const orderingRole = `wp2237_o_${context.runId}`;
    for (const role of [identityRole, orderingRole]) assert.match(role, /^wp2237_[io]_[a-f0-9]+$/u);
    let active = 0;
    let generated = 1000;
    let clock = 0;
    try {
      for (const role of [identityRole, orderingRole]) {
        await admin.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        await admin.query(`GRANT USAGE ON SCHEMA platform_helpers,platform_audit TO ${role}`);
        await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
        );
        await admin.query(`GRANT SELECT,INSERT ON platform_audit.audit_record TO ${role}`);
        await admin.query(
          `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`,
        );
      }
      await admin.query(`GRANT USAGE ON SCHEMA bop_identity TO ${identityRole}`);
      await admin.query(
        `GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation,bop_identity.guest_binding_preparation TO ${identityRole}`,
      );
      await admin.query(
        `GRANT UPDATE (status,revocation_reason,revoked_at,version) ON bop_identity.guest_session TO ${identityRole}`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_ordering TO ${orderingRole}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON rms_ordering.cart TO ${orderingRole}`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO ${orderingRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_ordering.cart_operation_record TO ${orderingRole}`,
      );
      await admin.query(
        `GRANT SELECT ON rms_ordering.cart_line,rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line TO ${orderingRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_ordering.cart_binding_record TO ${orderingRole}`,
      );
      function runner(role, { failAudit = false, loseAck = false } = {}) {
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
              await client.query("BEGIN");
              await client.query(`SET LOCAL ROLE ${role}`);
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
              const cleared = (
                await client.query(
                  "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
                )
              ).rows[0];
              assert.ok(!cleared.brand && !cleared.store);
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
      const auditRecord = (descriptor, identity = false) => ({
        auditId: id(generated++),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: `${identity ? "IDENTITY_GUEST" : "ORDERING_CART"}_BINDING_${descriptor.action.toUpperCase()}`,
        targetType: identity ? "GuestBindingPreparation" : "OrderingCart",
        targetId: identity ? descriptor.operationReference : descriptor.cartReference,
        reasonCode: identity ? "AUTHORIZED_GUEST_BINDING" : "AUTHORIZED_CART_BINDING",
        correlationId: id(999),
        occurredAt: descriptor.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const options = {
        ...scope,
        policy: {
          policyVersionReference: id(10),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 60,
          absoluteTimeoutSeconds: 86400,
          validFrom: at(-60),
          validUntil: at(86400),
        },
        sourceChannel: "Qr",
        generateReference: () => id(generated++),
        now: () => at(clock),
        audit: auditRecord,
      };
      const owner = (behavior = {}) =>
        createPostgresPickupCartBindingStore(runner(orderingRole, behavior), options);
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_ordering.cart) AS carts,
        (SELECT count(*)::integer FROM rms_ordering.cart_binding_record) AS bindings,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const prepare = (n, predecessor = n + 3) => ({
        ...scope,
        operationReference: id(n),
        targetReference: id(n + 1),
        sessionReference: id(n + 2),
        predecessorSessionReference: id(predecessor),
        acknowledgedAt: at(0),
        observedAt: at(1),
        validUntil: at(300),
      });
      const p = prepare(100);
      await assert.rejects(owner({ failAudit: true }).prepare(p), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { carts: 0, bindings: 0, audits: 0 });
      const [first, concurrent] = await Promise.all([
        owner().prepare(p),
        owner().prepare({ ...p, observedAt: at(2) }),
      ]);
      assert.deepEqual(first, concurrent);
      assert.deepEqual(await owner().prepare({ ...p, observedAt: at(3) }), first);
      assert.deepEqual(await counts(), { carts: 1, bindings: 1, audits: 1 });
      assert.equal(await owner().current(guest(102), at(3)), null);
      const reader = createPostgresCartQueryStore(runner(orderingRole), scope);
      const original = await reader.load(id(101));
      assert.equal(original.createdByActorReference, id(102));
      assert.equal(original.items.length, 0);
      assert.equal(
        original.lifecycle.idleExpiresAt,
        at(Date.parse(first.preparedAt) === Date.parse(at(1)) ? 61 : 62),
      );
      for (const change of [
        { targetReference: id(999) },
        { sessionReference: id(999) },
        { predecessorSessionReference: id(999) },
        { acknowledgedAt: at(-1) },
        { validUntil: at(301) },
        { storeReference: id(99) },
      ]) {
        await assert.rejects(owner().prepare({ ...p, ...change }), {
          code: "CART_DEPENDENCY_UNAVAILABLE",
        });
      }
      const completion = {
        ...scope,
        operationReference: id(100),
        targetReference: id(101),
        sessionReference: id(102),
        activatedAt: at(4),
      };
      clock = 5;
      await assert.rejects(owner({ failAudit: true }).activate(completion), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { carts: 1, bindings: 1, audits: 1 });
      await assert.rejects(owner({ loseAck: true }).activate(completion), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(
        await Promise.all([owner().activate(completion), owner().activate(completion)]),
        ["Activated", "Activated"],
      );
      assert.deepEqual(await owner().current(guest(102), at(5)), original);
      assert.equal(
        await owner().reserveTarget({
          session: guest(102),
          operationReference: id(110),
          observedAt: at(5),
        }),
        null,
      );
      assert.equal(await owner().current(guest(103), at(5)), null);
      clock = 301;
      assert.equal(await owner().activate(completion), "Activated");
      assert.deepEqual(await owner().current(guest(102), at(clock)), original);
      await assert.rejects(owner().activate({ ...completion, activatedAt: at(6) }), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), { carts: 1, bindings: 2, audits: 2 });
      // Another candidate can prepare, but cannot publish for the same already-consumed predecessor.
      await owner().prepare(prepare(120, 103));
      await assert.rejects(
        owner().activate({
          ...scope,
          operationReference: id(120),
          targetReference: id(121),
          sessionReference: id(122),
          activatedAt: at(4),
        }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await owner().current(guest(122), at(301)), null);
      // Expired unactivated records do not block a fresh target reservation for the predecessor.
      await owner().prepare(prepare(140));
      assert.ok(
        await owner().reserveTarget({
          session: guest(143),
          operationReference: id(150),
          observedAt: at(301),
        }),
      );
      for (const sql of [
        "UPDATE rms_ordering.cart_binding_record SET prepared_at=prepared_at",
        "DELETE FROM rms_ordering.cart_binding_record",
        "TRUNCATE rms_ordering.cart_binding_record",
      ]) {
        await assert.rejects(admin.query(sql), (error) => error.code === "55000");
      }
      await assert.rejects(
        admin.query(
          `INSERT INTO rms_ordering.cart_binding_record
        (operation_id,revision,brand_id,store_id,cart_id,guest_session_id,predecessor_session_id,acknowledged_at,prepared_at,valid_until,activated_at)
        SELECT operation_id,2,brand_id,store_id,cart_id,$1,predecessor_session_id,acknowledged_at,prepared_at,valid_until,$2
        FROM rms_ordering.cart_binding_record WHERE operation_id=$3 AND revision=1`,
          [id(998), at(4), id(140)],
        ),
        (error) => error.code === "23503",
      );
      await runner(orderingRole).run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(99)],
        );
        assert.deepEqual(
          (await tx.query("SELECT cart_id FROM rms_ordering.cart_binding_record", [])).rows,
          [],
        );
      });
      // A losing candidate cannot leave a second Cart or orphaned Audit; FK checks run at commit.
      const beforeConflict = await counts();
      await assert.rejects(owner().prepare({ ...prepare(160), sessionReference: id(142) }), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await counts(), beforeConflict);
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO rms_ordering.cart_binding_record
        (operation_id,revision,brand_id,store_id,cart_id,guest_session_id,predecessor_session_id,acknowledged_at,prepared_at,valid_until)
        VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id(180), id(2), id(3), id(181), id(182), id(183), at(0), at(1), at(300)],
      );
      await assert.rejects(admin.query("COMMIT"), (error) => error.code === "23503");
      await admin.query("ROLLBACK");
      assert.deepEqual(await counts(), beforeConflict);
      // The roles cannot cross private Domain boundaries, even in a combined application process.
      await assert.rejects(
        runner(orderingRole).run((tx) =>
          tx.query("SELECT guest_session_id FROM bop_identity.guest_session", []),
        ),
        (error) => error.code === "42501",
      );
      await assert.rejects(
        runner(identityRole).run((tx) => tx.query("SELECT cart_id FROM rms_ordering.cart", [])),
        (error) => error.code === "42501",
      );

      const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
      const recovery = createGuestBindingCredentialProvider(new Uint8Array(32).fill(9));
      const sessions = createPostgresGuestSessionEntryStore(runner(identityRole), scope);
      const bindings = createPostgresGuestBindingStore(
        runner(identityRole),
        scope,
        {
          append: (tx, descriptor) =>
            appendAuditRecordInTransaction(tx, auditRecord(descriptor, true)),
        },
        credentials.equals,
      );
      const oldCredential = credentials.generateCredential("Session");
      const oldCsrf = credentials.generateCredential("Csrf");
      const oldRecord = createGuestSessionRecord({
        session: guest(500),
        sessionSelectorHash: credentials.hashCredential("Session", oldCredential),
        csrfSelectorHash: credentials.hashCredential("Csrf", oldCsrf),
        operationReference: id(501),
        operationIntentHash: "a".repeat(64),
      });
      await sessions.create({ record: oldRecord });
      // Store/QR authority is synthetic evidence; credential authorization and both owner stores are real.
      const authorization = new GuestSessionService({
        credentials,
        store: sessions,
        binding: {
          async validate() {
            return "Current";
          },
        },
        admission: {
          async consume() {
            return null;
          },
        },
      });
      const serviceOptions = {
        credentials,
        recovery,
        sessions,
        bindings,
        preparationLifetimeSeconds: 300,
        now: () => at(clock),
        authorization,
        owner: owner(),
      };
      clock = 0;
      const input = {
        operationReference: id(502),
        sessionCredential: oldCredential,
        csrfCredential: oldCsrf,
      };
      const before = await counts();
      const issued = await createGuestBindingService(serviceOptions).prepare(input);
      assert.equal((await counts()).carts, before.carts);
      const activation = {
        ...input,
        candidateSessionCredential: issued.sessionCredential,
        candidateCsrfCredential: issued.csrfCredential,
        recoveryProof: issued.recoveryProof,
      };
      clock = 1;
      const interruptedOwner = owner();
      const interrupted = createGuestBindingService({
        ...serviceOptions,
        owner: {
          ...interruptedOwner,
          activate: (receipt) => owner({ failAudit: true }).activate(receipt),
        },
      });
      await assert.rejects(interrupted.activate(activation), { code: "GUEST_SESSION_UNAVAILABLE" });
      assert.equal(
        (await sessions.resolve(oldRecord.sessionSelectorHash)).session.status,
        "Revoked",
      );
      const candidate = (
        await sessions.resolve(credentials.hashCredential("Session", issued.sessionCredential))
      ).session;
      assert.equal(await owner().current(candidate, at(1)), null);
      await assert.rejects(interrupted.activate(activation), { code: "GUEST_SESSION_UNAVAILABLE" });
      const completedInput = {
        operationReference: id(502),
        sessionCredential: issued.sessionCredential,
        csrfCredential: issued.csrfCredential,
      };
      clock = 301;
      const resumed = createGuestBindingService({ ...serviceOptions, owner: owner() });
      assert.equal((await resumed.complete(completedInput)).status, "Activated");
      const cart = await owner().current(candidate, at(clock));
      assert.equal(cart.createdByActorReference, candidate.sessionReference);
      assert.equal(cart.createdAt, at(1));
      assert.equal(cart.lifecycle.idleExpiresAt, at(61)); // Completion never renews expired Cart lifetime.
      assert.equal((await resumed.complete(completedInput)).status, "Activated");
      assert.deepEqual(await counts(), {
        carts: before.carts + 1,
        bindings: before.bindings + 2,
        audits: before.audits + 5,
      });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::integer AS n FROM bop_identity.guest_binding_preparation",
          )
        ).rows[0].n,
        3,
      );
      const stored = JSON.stringify(
        (await admin.query("SELECT * FROM rms_ordering.cart_binding_record")).rows,
      );
      for (const raw of [
        oldCredential,
        oldCsrf,
        issued.sessionCredential,
        issued.csrfCredential,
        issued.recoveryProof,
      ])
        assert.equal(stored.includes(raw), false);
      // Real HTTP transport over the same real owner stores; browser cookies are supplied explicitly.
      const httpCredential = credentials.generateCredential("Session");
      const httpCsrf = credentials.generateCredential("Csrf");
      await sessions.create({
        record: createGuestSessionRecord({
          session: guest(700),
          sessionSelectorHash: credentials.hashCredential("Session", httpCredential),
          csrfSelectorHash: credentials.hashCredential("Csrf", httpCsrf),
          operationReference: id(701),
          operationIntentHash: "c".repeat(64),
        }),
      });
      const beforeHttp = await counts();
      let failPublication = true;
      const httpOwner = owner();
      const httpService = createCustomerCartBindingComposition({
        scope,
        session: { credentials, binding: { validate: async () => "Current" } },
        sessionTransactions: runner(identityRole),
        orderingTransactions: runner(orderingRole),
        identityAudit: {
          append: (tx, descriptor) =>
            appendAuditRecordInTransaction(tx, auditRecord(descriptor, true)),
        },
        ordering: {
          policy: options.policy,
          sourceChannel: options.sourceChannel,
          generateReference: options.generateReference,
          audit: (descriptor) => {
            if (descriptor.action === "Activated" && failPublication)
              throw new Error("synthetic owner audit unavailable");
            return auditRecord(descriptor);
          },
        },
        recovery,
        preparationLifetimeSeconds: 300,
        now: () => at(clock),
      });
      const displayQuery = createCustomerCartViewQuery({
        reads: createPickupCartReadService({
          sessions: authorization,
          binding: createPostgresPickupCartBindingReader(runner(orderingRole), scope),
          scope,
          now: () => at(clock),
        }),
        // Public Store display is a synthetic owner-port result; no production branding is asserted.
        stores: {
          async getPublicStore(request) {
            assert.equal(request.purpose, "CustomerCart");
            assert.equal(request.publicStoreReference, id(4));
            return {
              status: "Available",
              profile: {
                profileReference: id(810),
                profileVersion: 1,
                releaseReference: id(811),
                contentDigest: "sha256:" + "a".repeat(64),
                defaultLocale: "en-CA",
                selectedLocale: "en-CA",
                currencyCode: "CAD",
                timeZone: "America/Toronto",
                brandDisplayName: "Synthetic Brand",
                storeDisplayName: "Synthetic Store",
                address: {
                  countryCode: "CA",
                  regionCode: "ON",
                  locality: "Exampleville",
                  postalCode: "A1A 1A1",
                  addressLines: ["100 Example Avenue"],
                },
                businessPhone: null,
                website: null,
                logoAssetVersionReference: null,
              },
            };
          },
        },
        catalog: {
          async describeMany(requests) {
            assert.deepEqual(requests, []);
            return [];
          },
        },
        quotes: createPostgresCartQuoteReader(runner(orderingRole), scope),
      });
      const httpServer = createServer(
        createApp({
          customerCart: new CustomerCartHandler({
            allowedOrigin: "https://customer.example.test",
            now: () => at(clock),
            port: createCustomerCartReadPort(displayQuery),
          }),
          customerCartBinding: new CustomerCartBindingHandler({
            allowedOrigin: "https://customer.example.test",
            port: httpService,
            now: () => at(clock),
          }),
        }),
      );
      try {
        await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
        const address = httpServer.address();
        assert.ok(address && typeof address === "object");
        clock = 400;
        const oldCookie = `__Host-bop-guest=${httpCredential}`;
        let browserCookie = oldCookie;
        let latestResponse;
        // Synthetic browser cookie/header boundary; the production client never sees raw Session JSON.
        const browser = createBrowserCartBindingClient({
          online: () => true,
          async fetch(path, init) {
            assert.match(path, /^\/bff\/customer\/cart-binding\/(prepare|activate|complete)$/u);
            const response = await globalThis.fetch(`http://127.0.0.1:${address.port}${path}`, {
              ...init,
              headers: {
                ...init.headers,
                origin: "https://customer.example.test",
                "sec-fetch-site": "same-origin",
                "sec-fetch-mode": "cors",
                cookie: browserCookie,
              },
            });
            latestResponse = response;
            return response;
          },
        });
        const preparedBody = await browser.prepare({
          operationReference: id(702),
          csrfToken: httpCsrf,
        });
        assert.equal(latestResponse.status, 200);
        assert.equal(latestResponse.headers.get("cache-control"), "no-store");
        const pendingCookie = latestResponse.headers.getSetCookie()[0].split(";")[0];
        assert.ok(pendingCookie.startsWith(`__Host-bop-guest-candidate-${id(702)}=`));
        assert.equal(JSON.stringify(preparedBody).includes(pendingCookie.split("=")[1]), false);
        assert.equal((await counts()).carts, beforeHttp.carts);
        browserCookie = `${oldCookie}; ${pendingCookie}`;
        clock = 401;
        await assert.rejects(
          browser.activate({
            operationReference: id(702),
            csrfToken: httpCsrf,
            candidateCsrfToken: preparedBody.candidateCsrfToken,
            recoveryProof: preparedBody.recoveryProof,
          }),
          { code: "unavailable" },
        );
        assert.equal(latestResponse.status, 503);
        assert.deepEqual(latestResponse.headers.getSetCookie(), []);
        assert.equal(
          (await sessions.resolve(credentials.hashCredential("Session", httpCredential))).session
            .status,
          "Revoked",
        );
        failPublication = false;
        clock = 701;
        const completedBody = await browser.complete({
          operationReference: id(702),
          csrfToken: preparedBody.candidateCsrfToken,
        });
        assert.equal(latestResponse.status, 200);
        const publishedCookie = latestResponse.headers.getSetCookie()[0].split(";")[0];
        assert.equal(publishedCookie, `__Host-bop-guest=${pendingCookie.split("=")[1]}`);
        assert.equal(completedBody.csrfToken, preparedBody.candidateCsrfToken);
        assert.equal(JSON.stringify(completedBody).includes(pendingCookie.split("=")[1]), false);
        clock = 702;
        browserCookie = publishedCookie;
        const repeatedBody = await browser.complete({
          operationReference: id(702),
          csrfToken: preparedBody.candidateCsrfToken,
        });
        assert.equal(latestResponse.status, 200);
        const reader = createPickupCartReadService({
          sessions: authorization,
          binding: httpOwner,
          scope,
          now: () => at(clock),
        });
        const readCredential = pendingCookie.split("=")[1];
        const sessionBeforeRead = await sessions.resolve(
          credentials.hashCredential("Session", readCredential),
        );
        const currentRead = await reader.read({ sessionCredential: readCredential });
        assert.ok(currentRead);
        assert.equal(currentRead.effectiveStatus, "Expired");
        assert.equal(currentRead.cart.lifecycle.status, "Active");
        assert.equal(currentRead.cart.createdAt, at(401));
        const getCart = (path, cookie) =>
          globalThis.fetch(`http://127.0.0.1:${address.port}${path}`, {
            headers: { cookie, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
          });
        const viewResponse = await getCart("/bff/customer/cart", publishedCookie);
        assert.equal(viewResponse.status, 200);
        assert.equal(viewResponse.headers.get("cache-control"), "no-store");
        const publicView = await viewResponse.json();
        assert.equal(publicView.cart.cartReference, currentRead.cart.cartReference);
        assert.equal(publicView.cart.lifecycle.status, "Expired");
        assert.deepEqual(publicView.cart.items, []);
        assert.equal(publicView.cart.quote, null);
        for (const privateValue of [
          readCredential,
          scope.brandReference,
          scope.storeReference,
          currentRead.cart.createdByActorReference,
        ])
          assert.equal(JSON.stringify(publicView).includes(privateValue), false);
        assert.equal((await getCart("/api/v1/carts/" + id(9999), publishedCookie)).status, 404);
        assert.equal((await getCart("/bff/customer/cart", oldCookie)).status, 401);
        assert.deepEqual(
          await reader.read({
            sessionCredential: readCredential,
            cartReference: currentRead.cart.cartReference,
          }),
          currentRead,
        );
        assert.equal(
          await reader.read({ sessionCredential: readCredential, cartReference: id(9999) }),
          null,
        );
        await assert.rejects(reader.read({ sessionCredential: httpCredential }), {
          code: "CART_PERMISSION_DENIED",
        });
        assert.deepEqual(
          await sessions.resolve(credentials.hashCredential("Session", readCredential)),
          sessionBeforeRead,
        );
        assert.deepEqual(repeatedBody, completedBody);
        assert.deepEqual(await counts(), {
          carts: beforeHttp.carts + 1,
          bindings: beforeHttp.bindings + 2,
          audits: beforeHttp.audits + 5,
        });
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::integer AS n FROM bop_identity.guest_binding_preparation",
            )
          ).rows[0].n,
          6,
        );
        // Additional coordinator scenario keeps all earlier owner/transport assertions intact.
        const creationCredential = credentials.generateCredential("Session");
        const creationCsrf = credentials.generateCredential("Csrf");
        await sessions.create({
          record: createGuestSessionRecord({
            session: guest(900),
            sessionSelectorHash: credentials.hashCredential("Session", creationCredential),
            csrfSelectorHash: credentials.hashCredential("Csrf", creationCsrf),
            operationReference: id(901),
            operationIntentHash: "d".repeat(64),
          }),
        });
        const beforeCoordinator = await counts();
        const networkFetch = globalThis.fetch;
        const cookieJar = new Map([["__Host-bop-guest", creationCredential]]);
        const paths = [];
        let currentCsrf = creationCsrf;
        const browserFetch = async (path, init = {}) => {
          assert.equal(typeof path, "string");
          assert.match(
            path,
            /^\/bff\/customer\/(?:cart|cart-binding\/(?:prepare|activate|complete))$/u,
          );
          paths.push(path);
          const headers = new globalThis.Headers(init.headers);
          headers.set("origin", "https://customer.example.test");
          headers.set("sec-fetch-site", "same-origin");
          headers.set("sec-fetch-mode", "cors");
          headers.set(
            "cookie",
            [...cookieJar].map(([name, value]) => name + "=" + value).join("; "),
          );
          const response = await networkFetch("http://127.0.0.1:" + address.port + path, {
            ...init,
            headers,
          });
          for (const line of response.headers.getSetCookie()) {
            const cookie = line.split(";")[0];
            const split = cookie.indexOf("=");
            const name = cookie.slice(0, split);
            const value = cookie.slice(split + 1);
            if (line.toLowerCase().includes("max-age=0")) cookieJar.delete(name);
            else cookieJar.set(name, value);
          }
          return response;
        };
        try {
          // Only the test cookie/header adapter sees raw Session cookies; both clients are production code.
          globalThis.fetch = browserFetch;
          const coordinator = createPickupCartCreationCoordinator({
            binding: createBrowserCartBindingClient({ fetch: browserFetch, online: () => true }),
            cart: createBrowserCustomerCartClient(),
            csrf: {
              get: () => currentCsrf,
              set: (value) => {
                currentCsrf = value;
              },
            },
            generatePreparationReference: () => id(903),
            online: () => true,
          });
          clock = 800;
          failPublication = true;
          const creationInput = { operationReference: id(902) };
          await assert.rejects(coordinator.createCart(creationInput), { code: "network_unknown" });
          assert.deepEqual(paths, [
            "/bff/customer/cart",
            "/bff/customer/cart-binding/prepare",
            "/bff/customer/cart-binding/activate",
          ]);
          assert.equal(currentCsrf, creationCsrf);
          assert.equal(
            (await sessions.resolve(credentials.hashCredential("Session", creationCredential)))
              .session.status,
            "Revoked",
          );
          const beforeCompeting = paths.length;
          await assert.rejects(coordinator.createCart({ operationReference: id(904) }), {
            code: "network_unknown",
          });
          assert.equal(paths.length, beforeCompeting);
          clock = 1101;
          failPublication = false;
          const createdView = await coordinator.createCart(creationInput);
          assert.equal(createdView.cart.lifecycle.status, "Expired");
          assert.deepEqual(createdView.cart.items, []);
          assert.notEqual(currentCsrf, creationCsrf);
          assert.deepEqual(paths.slice(beforeCompeting), [
            "/bff/customer/cart-binding/complete",
            "/bff/customer/cart",
          ]);
          const confirmedCounts = await counts();
          assert.deepEqual(confirmedCounts, {
            carts: beforeCoordinator.carts + 1,
            bindings: beforeCoordinator.bindings + 2,
            audits: beforeCoordinator.audits + 5,
          });
          const beforeReplay = paths.length;
          assert.deepEqual(await coordinator.createCart(creationInput), createdView);
          assert.deepEqual(paths.slice(beforeReplay), ["/bff/customer/cart"]);
          assert.deepEqual(await counts(), confirmedCounts);
          assert.equal(cookieJar.size, 1);
          for (const value of [
            creationCredential,
            creationCsrf,
            currentCsrf,
            cookieJar.get("__Host-bop-guest"),
          ])
            assert.equal(JSON.stringify(createdView).includes(value), false);
          assert.equal(
            (
              await admin.query(
                "SELECT count(*)::integer AS n FROM bop_identity.guest_binding_preparation",
              )
            ).rows[0].n,
            9,
          );
        } finally {
          globalThis.fetch = networkFetch;
        }

        // WP-2251: actual authorized removal; Catalog eligibility below is explicitly synthetic seed evidence.
        clock = 1200;
        const removalSession = guest(950);
        const removalCredential = credentials.generateCredential("Session");
        const removalCsrf = credentials.generateCredential("Csrf");
        await sessions.create({
          record: createGuestSessionRecord({
            session: removalSession,
            sessionSelectorHash: credentials.hashCredential("Session", removalCredential),
            csrfSelectorHash: credentials.hashCredential("Csrf", removalCsrf),
            operationReference: id(951),
            operationIntentHash: "e".repeat(64),
          }),
        });
        await httpOwner.prepare({
          ...scope,
          operationReference: id(952),
          targetReference: id(953),
          sessionReference: id(950),
          predecessorSessionReference: id(954),
          acknowledgedAt: at(1199),
          observedAt: at(1200),
          validUntil: at(1500),
        });
        await httpOwner.activate({
          ...scope,
          operationReference: id(952),
          targetReference: id(953),
          sessionReference: id(950),
          activatedAt: at(1200),
        });
        const references = {
          hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          equals: (a, b) => a === b,
        };
        const itemAudit = (descriptor) => ({
          ...auditRecord({ ...descriptor, occurredAt: descriptor.observedAt }),
          actionCode: "ORDERING_CART_ITEM_" + descriptor.action.toUpperCase(),
          reasonCode: "AUTHORIZED_CART_MUTATION",
        });
        const itemReader = createPostgresCartQueryStore(runner(orderingRole), scope);
        const itemWriter = createPostgresCartItemCommandStore(
          runner(orderingRole),
          scope,
          references,
        );
        const itemOperations = createPostgresCartItemOperationStore(runner(orderingRole), scope);
        const seeded = await createCartItemCommandService({
          references: { ...references, generate: () => id(955) },
          authorization: {
            authorize: async (descriptor) => ({
              guestSession: removalSession,
              audit: itemAudit(descriptor),
            }),
          },
          catalog: {
            validateSelection: async (request) => ({
              status: "Accepted",
              ...request,
              menuVersionReference: id(956),
              productVersionReference: id(957),
              catalogChannelCode: "PILOT_CHANNEL",
              catalogOrderTypeCode: "PILOT_ORDER_TYPE",
              ruleEvidence: [],
              validatedAt: request.observedAt,
            }),
          },
          repository: {
            load: itemReader.load,
            resolveOperation: itemOperations.resolveOperation,
            commit: itemWriter.commit,
          },
        }).add({
          cartReference: id(953),
          expectedAggregateVersion: 1,
          sellableReference: id(958),
          quantity: 1,
          optionSelections: [],
          customerNote: null,
          operationReference: id(959),
          requestedAt: at(clock),
        });
        assert.equal(seeded.aggregate.aggregateVersion, 2);
        let failRead = true;
        const removalServer = createServer(
          createApp({
            customerCart: new CustomerCartHandler({
              allowedOrigin: "https://customer.example.test",
              now: () => at(clock),
              port: createCustomerCartRemovalComposition({
                scope,
                session: { credentials, binding: { validate: async () => "Current" } },
                sessionTransactions: runner(identityRole),
                cartTransactions: runner(orderingRole),
                writeTransactions: runner(orderingRole),
                references,
                audit: itemAudit,
                query: {
                  read: async (input) => {
                    if (failRead) throw new Error("synthetic post-commit read outage");
                    return displayQuery.read(input);
                  },
                },
                now: () => at(clock),
              }),
            }),
          }),
        );
        try {
          await new Promise((resolve) => removalServer.listen(0, "127.0.0.1", resolve));
          const removalAddress = removalServer.address();
          assert.equal(typeof removalAddress, "object");
          assert.ok(removalAddress);
          const remove = ({ csrf = removalCsrf, cart = id(953), operation = id(960) } = {}) =>
            networkFetch(
              "http://127.0.0.1:" +
                removalAddress.port +
                "/api/v1/carts/" +
                cart +
                "/items/" +
                id(955),
              {
                method: "DELETE",
                headers: {
                  origin: "https://customer.example.test",
                  "sec-fetch-site": "same-origin",
                  "sec-fetch-mode": "cors",
                  "x-csrf-token": csrf,
                  "if-match": '"2"',
                  "idempotency-key": operation,
                  cookie: "__Host-bop-guest=" + removalCredential,
                },
              },
            );
          const beforeRemoval = await counts();
          const operationsBefore = Number(
            (await admin.query("SELECT count(*) FROM rms_ordering.cart_operation_record")).rows[0]
              .count,
          );
          const denied = await remove({ csrf: credentials.generateCredential("Csrf") });
          assert.equal(denied.status, 401);
          await denied.text();
          const foreign = await remove({ cart: id(961) });
          assert.equal(foreign.status, 404);
          await foreign.text();
          assert.deepEqual(await counts(), beforeRemoval);
          const uncertain = await remove();
          assert.equal(uncertain.status, 503);
          assert.equal(uncertain.headers.get("cache-control"), "no-store");
          await uncertain.text();
          assert.equal((await itemReader.load(id(953))).items.length, 0);
          failRead = false;
          clock = 1201;
          const retry = await remove();
          assert.equal(retry.status, 200);
          const safe = await retry.json();
          assert.equal(safe.cart.version, 3);
          assert.deepEqual(safe.cart.items, []);
          for (const privateValue of [
            removalCredential,
            removalCsrf,
            id(950),
            scope.brandReference,
            scope.storeReference,
          ])
            assert.equal(JSON.stringify(safe).includes(privateValue), false);
          assert.deepEqual(await counts(), { ...beforeRemoval, audits: beforeRemoval.audits + 1 });
          assert.equal(
            Number(
              (await admin.query("SELECT count(*) FROM rms_ordering.cart_operation_record")).rows[0]
                .count,
            ),
            operationsBefore + 1,
          );
          const repeated = await remove();
          assert.equal(repeated.status, 200);
          await repeated.text();
          assert.deepEqual(await counts(), { ...beforeRemoval, audits: beforeRemoval.audits + 1 });
          await sessions.revoke({
            selectorHash: credentials.hashCredential("Session", removalCredential),
            expectedVersion: 1,
            reason: "Rotated",
            observedAt: at(clock),
            operationReference: id(962),
            operationIntentHash: "f".repeat(64),
          });
          const revoked = await remove();
          assert.equal(revoked.status, 401);
          await revoked.text();
          assert.deepEqual(await counts(), { ...beforeRemoval, audits: beforeRemoval.audits + 1 });
        } finally {
          removalServer.closeAllConnections();
          await new Promise((resolve) => removalServer.close(() => resolve()));
        }
      } finally {
        httpServer.closeAllConnections();
        await new Promise((resolve) => httpServer.close(() => resolve()));
      }
      assert.equal(active, 0);
    } finally {
      for (const role of [identityRole, orderingRole]) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});

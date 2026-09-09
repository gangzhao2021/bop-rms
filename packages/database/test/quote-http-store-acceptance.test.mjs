import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createCustomerQuoteComposition } from "../../../apps/api/src/customer-quote-composition.ts";
import { CustomerQuoteHandler } from "../../../apps/api/src/customer-quote.ts";
import { createApp } from "../../../apps/api/src/app.ts";
import {
  createGuestSessionRecord,
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import {
  createPostgresPickupCartBindingStore,
  createPostgresCartQueryStore,
  createPostgresCartItemCommandStore,
  createPostgresCartItemOperationStore,
  createCartItemCommandService,
} from "../../rms/ordering/src/index.ts";
import { createPriceQuote } from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
const { Client } = pg;
const id = (n) => `01902262-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
it("recovers actual Quote HTTP commits across Identity, Ordering, Pricing and Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2262_quote_http" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = ["i", "o", "p"].map((kind) => `wp2262_${kind}_${context.runId}`);
    roles.forEach((role) => assert.match(role, /^wp2262_[iop]_[a-f0-9]+$/u));
    const [identityRole, orderingRole, pricingRole] = roles;
    let active = 0;
    let sequence = 1000;
    let clock = 0;
    let loseAck = "pricing";
    let candidates = 0;
    let server;
    const source = quoteInput();
    const at = (seconds = clock) =>
      new Date(Date.parse(source.createdAt) + seconds * 1000).toISOString();
    const scope = { brandReference: source.brandReference, storeReference: source.storeReference };
    const quotes = [];
    function runner(role, kind = "read") {
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
          let wrote = false;
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL lock_timeout='5s'");
            await client.query("SET LOCAL statement_timeout='5s'");
            const result = await action({
              async query(sql, values) {
                if (
                  (kind === "pricing" &&
                    sql.startsWith("INSERT INTO rms_pricing.price_quote_request")) ||
                  (kind === "attachment" &&
                    sql.startsWith("INSERT INTO rms_ordering.cart_quote_attachment"))
                )
                  wrote = true;
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
            if (wrote && loseAck === kind) {
              loseAck = null;
              throw new Error("synthetic lost commit acknowledgement");
            }
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
    const references = {
      hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
      equals: (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
    };
    const audit = (actionCode, reasonCode, targetType, targetId, occurredAt) => ({
      auditId: id(sequence++),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode,
      reasonCode,
      targetType,
      targetId,
      occurredAt,
      correlationId: id(90),
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    const counts = async () =>
      (
        await admin.query(`SELECT
      (SELECT count(*)::integer FROM rms_pricing.price_quote) AS quotes,
      (SELECT count(*)::integer FROM rms_pricing.price_quote_request) AS requests,
      (SELECT count(*)::integer FROM rms_pricing.price_quote_line) AS lines,
      (SELECT count(*)::integer FROM rms_pricing.price_quote_tax_line) AS taxes,
      (SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment) AS attachments,
      (SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment_line) AS attachment_lines,
      (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
      ).rows[0];
    try {
      for (const role of roles) {
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
        `GRANT SELECT,INSERT ON bop_identity.guest_session,bop_identity.guest_session_operation TO ${identityRole}`,
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
        `GRANT SELECT,INSERT ON rms_ordering.cart_operation_record,rms_ordering.cart_binding_record,rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line TO ${orderingRole}`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_pricing TO ${pricingRole}`);
      await admin.query(
        `GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,rms_pricing.price_quote_request TO ${pricingRole}`,
      );
      for (const [role, table] of [
        [pricingRole, "rms_ordering.cart"],
        [orderingRole, "rms_pricing.price_quote"],
        [identityRole, "rms_pricing.price_quote_request"],
      ]) {
        await admin.query(`SET ROLE ${role}`);
        try {
          await assert.rejects(admin.query(`SELECT * FROM ${table}`), { code: "42501" });
        } finally {
          await admin.query("RESET ROLE");
        }
      }
      const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(9));
      const sessionCredential = credentials.generateCredential("Session");
      const csrfCredential = credentials.generateCredential("Csrf");
      const guest = {
        ...scope,
        sessionReference: id(1),
        status: "Active",
        version: 1,
        publicStoreReference: id(2),
        publicTableReference: null,
        channel: "Pickup",
        locale: "en-CA",
        qrReference: id(3),
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
      const sessions = createPostgresGuestSessionEntryStore(runner(identityRole), scope);
      await sessions.create({
        record: createGuestSessionRecord({
          session: guest,
          sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
          csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
          operationReference: id(4),
          operationIntentHash: "a".repeat(64),
        }),
      });
      const owner = createPostgresPickupCartBindingStore(runner(orderingRole), {
        ...scope,
        policy: {
          policyVersionReference: id(5),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          validFrom: at(-60),
          validUntil: at(86400),
        },
        sourceChannel: "Web",
        generateReference: () => id(sequence++),
        now: () => at(),
        audit: (descriptor) =>
          audit(
            `ORDERING_CART_BINDING_${descriptor.action.toUpperCase()}`,
            "AUTHORIZED_CART_BINDING",
            "OrderingCart",
            descriptor.cartReference,
            descriptor.occurredAt,
          ),
      });
      await owner.prepare({
        ...scope,
        operationReference: id(10),
        targetReference: source.cartReference,
        sessionReference: id(1),
        predecessorSessionReference: id(11),
        acknowledgedAt: at(-1),
        observedAt: at(),
        validUntil: at(300),
      });
      await owner.activate({
        ...scope,
        operationReference: id(10),
        targetReference: source.cartReference,
        sessionReference: id(1),
        activatedAt: at(),
      });
      const carts = createPostgresCartQueryStore(runner(orderingRole), scope);
      const writes = createPostgresCartItemCommandStore(runner(orderingRole), scope, references);
      const operations = createPostgresCartItemOperationStore(runner(orderingRole), scope);
      const line = source.lines[0];
      assert.ok(line);
      const seeded = await createCartItemCommandService({
        references: { ...references, generate: () => line.lineReference },
        authorization: {
          authorize: async (descriptor) => ({
            guestSession: guest,
            audit: audit(
              "ORDERING_CART_ITEM_ADD",
              "AUTHORIZED_CART_MUTATION",
              "OrderingCart",
              source.cartReference,
              descriptor.observedAt,
            ),
          }),
        },
        // Catalog eligibility is a synthetic source fact; all persistence and HTTP code is real.
        catalog: {
          validateSelection: async (request) => ({
            status: "Accepted",
            ...request,
            menuVersionReference: line.menuVersionReference,
            productVersionReference: line.productVersionReference,
            catalogChannelCode: "SYNTHETIC_WEB",
            catalogOrderTypeCode: "SYNTHETIC_PICKUP",
            ruleEvidence: [],
            validatedAt: request.observedAt,
          }),
        },
        repository: {
          load: carts.load,
          resolveOperation: operations.resolveOperation,
          commit: writes.commit,
        },
      }).add({
        cartReference: source.cartReference,
        expectedAggregateVersion: 1,
        sellableReference: line.sellableReference,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        operationReference: id(12),
        requestedAt: at(),
      });
      assert.equal(seeded.aggregate.aggregateVersion, 2);
      const baseline = await counts();
      const port = createCustomerQuoteComposition({
        scope,
        session: { credentials, binding: { validate: async () => "Current" } }, // Synthetic Store/QR authority only.
        sessionTransactions: runner(identityRole),
        cartTransactions: runner(orderingRole),
        attachmentTransactions: runner(orderingRole, "attachment"),
        pricingTransactions: runner(pricingRole, "pricing"),
        references,
        pricingReferences: { ...references, generateReference: () => id(sequence++) },
        audit: (descriptor) =>
          audit(
            "ORDERING_CART_ATTACH_QUOTE",
            "AUTHORIZED_CART_QUOTE",
            "OrderingCart",
            descriptor.cartReference,
            descriptor.observedAt,
          ),
        now: () => at(),
        candidate: async (input) => {
          candidates++;
          const quote = createPriceQuote({
            ...source,
            quoteReference: id(sequence++),
            cartVersion: input.cartVersion,
            createdAt: input.requestedAt,
            expiresAt: new Date(Date.parse(input.requestedAt) + 300000).toISOString(),
            priceBook: {
              ...source.priceBook,
              entries: source.priceBook.entries.map((entry) => ({
                ...entry,
                amount: { ...entry.amount, amountMinor: 9007199254740993n },
              })),
            },
            lines: source.lines.map((item) => ({
              ...item,
              quantity: 1,
              priceContext: { ...item.priceContext, evaluatedAt: input.requestedAt },
              taxContext: { ...item.taxContext, evaluatedAt: input.requestedAt },
            })),
          });
          quotes.push(quote);
          return {
            quote,
            audit: audit(
              "PRICING_QUOTE_CREATE",
              "AUTHORIZED_CART_QUOTE",
              "PricingPriceQuote",
              quote.quoteReference,
              quote.createdAt,
            ),
          };
        },
      });
      server = createServer(
        createApp({
          customerQuote: new CustomerQuoteHandler({
            port,
            allowedOrigin: "https://customer.example.test",
            now: () => at(),
          }),
        }),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const send = ({
        operation = id(30),
        csrf = csrfCredential,
        cart = source.cartReference,
        version = 2,
      } = {}) =>
        globalThis.fetch(`http://127.0.0.1:${address.port}/api/v1/carts/${cart}/quote`, {
          method: "POST",
          headers: {
            origin: "https://customer.example.test",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: `__Host-bop-guest=${sessionCredential}`,
            "x-csrf-token": csrf,
            "idempotency-key": operation,
          },
          body: JSON.stringify({ cartVersion: version }),
        });
      for (const [input, status] of [
        [{ csrf: credentials.generateCredential("Csrf") }, 404],
        [{ cart: id(99) }, 404],
        [{ version: 1 }, 409],
      ]) {
        const response = await send(input);
        assert.equal(response.status, status);
        await response.text();
      }
      assert.deepEqual(await counts(), baseline);
      assert.equal(candidates, 0);
      const uncertainPricing = await send();
      assert.equal(uncertainPricing.status, 503);
      await uncertainPricing.text();
      assert.deepEqual(await counts(), {
        ...baseline,
        quotes: 1,
        requests: 1,
        lines: 1,
        taxes: 1,
        audits: baseline.audits + 1,
      });
      clock = 1;
      const recovered = await send();
      assert.equal(recovered.status, 201);
      assert.equal(recovered.headers.get("cache-control"), "no-store");
      const original = await recovered.json();
      assert.equal(original.quote.total.amountMinor, quotes[0].total.amountMinor.toString());
      assert.ok(BigInt(original.quote.total.amountMinor) > BigInt(Number.MAX_SAFE_INTEGER));
      assert.equal(original.quote.expiresAt, quotes[0].expiresAt);
      assert.equal(candidates, 1);
      const once = {
        ...baseline,
        quotes: 1,
        requests: 1,
        lines: 1,
        taxes: 1,
        attachments: 1,
        attachment_lines: 1,
        audits: baseline.audits + 2,
      };
      assert.deepEqual(await counts(), once);
      const repeated = await Promise.allSettled([send(), send()]);
      for (const result of repeated) {
        assert.equal(result.status, "fulfilled");
        assert.equal(result.value.status, 201);
        assert.deepEqual(await result.value.json(), original);
      }
      assert.deepEqual(await counts(), once);
      assert.equal(candidates, 1);
      clock = 2;
      loseAck = "attachment";
      const uncertainAttachment = await send({ operation: id(31) });
      assert.equal(uncertainAttachment.status, 503);
      await uncertainAttachment.text();
      const twice = {
        ...baseline,
        quotes: 2,
        requests: 2,
        lines: 2,
        taxes: 2,
        attachments: 2,
        attachment_lines: 2,
        audits: baseline.audits + 4,
      };
      assert.deepEqual(await counts(), twice);
      clock = 3;
      const second = await send({ operation: id(31) });
      assert.equal(second.status, 201);
      const secondBody = await second.json();
      assert.equal(secondBody.quote.quoteReference, quotes[1].quoteReference);
      assert.deepEqual(await counts(), twice);
      assert.equal(candidates, 2);
      clock = 301;
      const historical = await send();
      assert.equal(historical.status, 201);
      assert.deepEqual(await historical.json(), original);
      for (const privateValue of [
        sessionCredential,
        csrfCredential,
        id(1),
        scope.brandReference,
        scope.storeReference,
      ])
        assert.equal(JSON.stringify(original).includes(privateValue), false);
      await sessions.revoke({
        selectorHash: credentials.hashCredential("Session", sessionCredential),
        expectedVersion: 1,
        reason: "Rotated",
        observedAt: at(),
        operationReference: id(40),
        operationIntentHash: "f".repeat(64),
      });
      const revoked = await send();
      assert.equal(revoked.status, 404);
      await revoked.text();
      assert.deepEqual(await counts(), twice);
      assert.equal(candidates, 2);
      assert.equal(active, 0);
    } finally {
      if (server !== undefined) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve()));
      }
      try {
        assert.equal(active, 0);
        await admin.query("RESET ROLE");
        for (const role of roles) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await admin.end();
      }
    }
  });
}, 120000);

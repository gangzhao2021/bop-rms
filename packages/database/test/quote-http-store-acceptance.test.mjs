import { createCustomerCartItemComposition } from "../../../apps/api/src/customer-cart-item-composition.ts";
import { CustomerCartHandler } from "../../../apps/api/src/customer-cart.ts";
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
  GuestSessionService,
  createGuestSessionRecord,
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
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
  createPostgresCartQuoteStore,
  createPostgresCartQuoteExpiryStore,
  parseCartQuoteExpiryRecord,
} from "../../rms/ordering/src/index.ts";
import {
  createPriceQuote,
  createPostgresPriceQuoteRequestStore,
} from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
const { Client } = pg;
const id = (n) => `01902262-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
it("recovers actual Quote HTTP commits across Identity, Ordering, Pricing and Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2268_quote_http" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const roles = ["i", "o", "p"].map((kind) => `wp2268_${kind}_${context.runId}`);
    roles.forEach((role) => assert.match(role, /^wp2268_[iop]_[a-f0-9]+$/u));
    const [identityRole, orderingRole, pricingRole] = roles;
    let active = 0;
    let sequence = 1000;
    let clock = 0;
    let loseAck = "pricing";
    let candidates = 0;
    let holdCandidate = null;
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
          let wrote = null;
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL lock_timeout='5s'");
            await client.query("SET LOCAL statement_timeout='5s'");
            const result = await action({
              async query(sql, values) {
                if (
                  kind === "pricing" &&
                  sql.startsWith("INSERT INTO rms_pricing.price_quote_request")
                )
                  wrote = "pricing";
                if (
                  kind === "attachment" &&
                  sql.startsWith("INSERT INTO rms_ordering.cart_quote_attachment")
                )
                  wrote = "attachment";
                if (
                  ["attachment", "expiry"].includes(kind) &&
                  sql.startsWith("INSERT INTO rms_ordering.cart_quote_expiry_record")
                )
                  wrote = "expiry";
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
            if (wrote && loseAck === wrote) {
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
        `GRANT SELECT,INSERT ON rms_ordering.cart_operation_record,rms_ordering.cart_binding_record,rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line,rms_ordering.cart_quote_expiry_record TO ${orderingRole}`,
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
      // Synthetic Store/Catalog descriptions; current authority and reads use actual Identity/Ordering.
      const authorization = new GuestSessionService({
        credentials,
        store: sessions,
        binding: { validate: async () => "Current" },
        admission: { consume: async () => null },
        now: () => at(),
      });
      const cartView = createCustomerCartViewQuery({
        reads: createPickupCartReadService({
          sessions: authorization,
          binding: createPostgresPickupCartBindingReader(runner(orderingRole), scope),
          scope,
          now: () => at(),
        }),
        stores: {
          async getPublicStore(request) {
            assert.equal(request.publicStoreReference, id(2));
            assert.equal(request.purpose, "CustomerCart");
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
            return requests.map((request) => {
              assert.equal(request.sellableReference, line.sellableReference);
              assert.deepEqual(request.optionReferences, []);
              return {
                status: "Found",
                menuVersionReference: request.menuVersionReference,
                productVersionReference: request.productVersionReference,
                sellableReference: request.sellableReference,
                displayName: "Synthetic item",
                options: [],
              };
            });
          },
        },
        quotes: createPostgresCartQuoteReader(runner(orderingRole), scope),
      });
      const itemPort = createCustomerCartItemComposition({
        scope,
        session: { credentials, binding: { validate: async () => "Current" } },
        sessionTransactions: runner(identityRole),
        cartTransactions: runner(orderingRole),
        writeTransactions: runner(orderingRole),
        references: { ...references, generate: () => id(sequence++) },
        audit: (descriptor) =>
          audit(
            "ORDERING_CART_ITEM_" + descriptor.action.toUpperCase(),
            "AUTHORIZED_CART_MUTATION",
            "OrderingCart",
            descriptor.cartReference,
            descriptor.observedAt,
          ),
        catalog: {
          validateSelection: async (request) => ({
            ...request,
            status: "Accepted",
            menuVersionReference: line.menuVersionReference,
            productVersionReference: line.productVersionReference,
            catalogChannelCode: "SYNTHETIC_WEB",
            catalogOrderTypeCode: "SYNTHETIC_PICKUP",
            ruleEvidence: [],
            validatedAt: request.observedAt,
          }),
        },
        query: cartView,
        now: () => at(),
      });
      const baseline = await counts();
      const port = createCustomerQuoteComposition({
        expiryAudit: (record) =>
          audit(
            "ORDERING_CART_QUOTE_EXPIRE",
            "QUOTE_VALIDITY_ENDED",
            "OrderingCart",
            record.cartReference,
            record.expiredAt,
          ),
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
            lines: input.lines.map((item) => {
              const template = source.lines.find(
                (candidate) => candidate.sellableReference === item.sellableReference,
              );
              assert.ok(template);
              assert.deepEqual(item.optionSelections, []);
              return {
                ...template,
                lineReference: item.lineReference,
                quantity: item.quantity,
                priceContext: { ...template.priceContext, evaluatedAt: input.requestedAt },
                taxContext: { ...template.taxContext, evaluatedAt: input.requestedAt },
              };
            }),
          });
          quotes.push(quote);
          if (holdCandidate !== null) await holdCandidate();
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
          customerCart: new CustomerCartHandler({
            port: itemPort,
            allowedOrigin: "https://customer.example.test",
            now: () => at(),
          }),
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
            "sec-fetch-mode": "cors",
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
      // WP-2263: reconcile only original public Pricing evidence; no private cross-owner reads.
      const quoteStore = createPostgresCartQuoteStore(runner(orderingRole), scope, references);
      const expiryStore = createPostgresCartQuoteExpiryStore(runner(orderingRole, "expiry"), scope);
      const requestStore = createPostgresPriceQuoteRequestStore(runner(pricingRole), scope, {
        ...references,
        generateReference: () => id(sequence++),
      });
      const template = await quoteStore.resolveOperation(id(30));
      const expiryAudit = (record) =>
        audit(
          "ORDERING_CART_QUOTE_EXPIRE",
          "QUOTE_VALIDITY_ENDED",
          "OrderingCart",
          record.cartReference,
          record.expiredAt,
        );
      const attachAudit = (value) =>
        audit(
          "ORDERING_CART_ATTACH_QUOTE",
          "AUTHORIZED_CART_QUOTE",
          "OrderingCart",
          value.cartReference,
          value.attachedAt,
        );
      async function pending(operation) {
        loseAck = "pricing";
        const response = await send({ operation });
        assert.equal(response.status, 503);
        await response.text();
        const history = await requestStore.resolve({
          operationReference: operation,
          guestSessionReference: id(1),
          cartReference: source.cartReference,
          cartVersion: 2,
          observedAt: at(),
        });
        assert.ok(history);
        const attachedAt = history.record.createdAt;
        const late = {
          ...template,
          operationReference: operation,
          quoteReference: history.quote.quoteReference,
          quoteInputDigest: history.quote.inputDigest,
          quoteCreatedAt: history.quote.createdAt,
          quoteExpiresAt: history.quote.expiresAt,
          attachedAt,
          idempotencyExpiresAt: new Date(Date.parse(attachedAt) + 86400000).toISOString(),
          operationIntentHash: references.hashIntent(
            "AttachQuote:" +
              JSON.stringify({
                cartReference: source.cartReference,
                expectedCartVersion: 2,
                operationReference: operation,
                requestedAt: attachedAt,
              }),
          ),
        };
        clock += 301;
        const record = parseCartQuoteExpiryRecord({
          ...scope,
          resolutionVersion: 1,
          operationReference: operation,
          guestSessionReference: id(1),
          cartReference: source.cartReference,
          cartVersion: 2,
          quoteReference: history.quote.quoteReference,
          quoteInputDigest: history.quote.inputDigest,
          requestIntentDigest: history.record.intentDigest,
          quoteCreatedAt: history.quote.createdAt,
          quoteExpiresAt: history.quote.expiresAt,
          requestCreatedAt: history.record.createdAt,
          requestExpiresAt: history.record.idempotencyExpiresAt,
          expiredAt: at(),
        });
        return { record, late };
      }
      const firstPending = await pending(id(32));
      const beforeExpiry = await counts();
      loseAck = "expiry";
      await assert.rejects(
        expiryStore.expire({
          record: firstPending.record,
          audit: expiryAudit(firstPending.record),
        }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await expiryStore.resolveOperation(id(32)), firstPending.record);
      const expired = await expiryStore.expire({
        record: firstPending.record,
        audit: expiryAudit(firstPending.record),
      });
      assert.equal(expired.status, "Expired");
      assert.equal((await counts()).audits, beforeExpiry.audits + 1);
      const replayRecord = parseCartQuoteExpiryRecord({
        ...firstPending.record,
        expiredAt: at(clock + 1),
      });
      assert.deepEqual(
        await expiryStore.expire({ record: replayRecord, audit: expiryAudit(replayRecord) }),
        expired,
      );
      await assert.rejects(
        quoteStore.attach({
          attachment: firstPending.late,
          expectedCartVersion: 2,
          audit: attachAudit(firstPending.late),
        }),
        { code: "CART_QUOTE_EXPIRED" },
      );
      assert.equal(await quoteStore.resolveOperation(id(32)), null);
      assert.equal((await counts()).audits, beforeExpiry.audits + 1);
      const changed = parseCartQuoteExpiryRecord({
        ...firstPending.record,
        requestIntentDigest: references.hashIntent("different"),
      });
      await assert.rejects(expiryStore.expire({ record: changed, audit: expiryAudit(changed) }), {
        code: "CART_IDEMPOTENCY_CONFLICT",
      });
      const oldRequest = await requestStore.resolve({
        operationReference: id(30),
        guestSessionReference: id(1),
        cartReference: source.cartReference,
        cartVersion: 2,
        observedAt: at(),
      });
      const alreadyRecord = parseCartQuoteExpiryRecord({
        ...firstPending.record,
        operationReference: id(30),
        quoteReference: template.quoteReference,
        quoteInputDigest: template.quoteInputDigest,
        quoteCreatedAt: template.quoteCreatedAt,
        quoteExpiresAt: template.quoteExpiresAt,
        requestCreatedAt: oldRequest.record.createdAt,
        requestExpiresAt: oldRequest.record.idempotencyExpiresAt,
        requestIntentDigest: oldRequest.record.intentDigest,
      });
      assert.deepEqual(
        await expiryStore.expire({ record: alreadyRecord, audit: expiryAudit(alreadyRecord) }),
        { status: "AlreadyAttached", attachment: template },
      );
      assert.equal(await expiryStore.resolveOperation(id(30)), null);
      const concurrent = await pending(id(33));
      const beforeConcurrent = await counts();
      const raced = await Promise.allSettled([
        quoteStore.attach({
          attachment: concurrent.late,
          expectedCartVersion: 2,
          audit: attachAudit(concurrent.late),
        }),
        expiryStore.expire({ record: concurrent.record, audit: expiryAudit(concurrent.record) }),
      ]);
      assert.equal(raced[1].status, "fulfilled");
      if (raced[1].value.status === "Expired") {
        assert.equal(raced[0].status, "rejected");
        assert.equal(raced[0].reason.code, "CART_QUOTE_EXPIRED");
      } else assert.equal(raced[0].status, "fulfilled");
      assert.equal(
        Number((await quoteStore.resolveOperation(id(33))) !== null) +
          Number((await expiryStore.resolveOperation(id(33))) !== null),
        1,
      );
      assert.equal((await counts()).audits, beforeConcurrent.audits + 1);
      const rollback = await pending(id(34));
      const beforeRollback = await counts();
      const auditHeads = (
        await admin.query(
          "SELECT * FROM platform_audit.audit_chain_head ORDER BY brand_id,store_id",
        )
      ).rows;
      await admin.query(`REVOKE INSERT ON platform_audit.audit_record FROM ${orderingRole}`);
      await assert.rejects(
        expiryStore.expire({ record: rollback.record, audit: expiryAudit(rollback.record) }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await expiryStore.resolveOperation(id(34)), null);
      assert.deepEqual(await counts(), beforeRollback);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT * FROM platform_audit.audit_chain_head ORDER BY brand_id,store_id",
          )
        ).rows,
        auditHeads,
      );
      await admin.query(`GRANT INSERT ON platform_audit.audit_record TO ${orderingRole}`);
      await quoteStore.attach({
        attachment: rollback.late,
        expectedCartVersion: 2,
        audit: attachAudit(rollback.late),
      });
      assert.equal(await expiryStore.resolveOperation(id(34)), null);
      await admin.query(
        "UPDATE rms_ordering.cart_quote_expiry_record SET expired_at=expired_at+interval '1 second'",
      );
      await admin.query("DELETE FROM rms_ordering.cart_quote_expiry_record");
      assert.deepEqual(await expiryStore.resolveOperation(id(32)), expired.record);
      const foreignExpiry = createPostgresCartQuoteExpiryStore(runner(orderingRole), {
        ...scope,
        storeReference: id(99),
      });
      assert.equal(await foreignExpiry.resolveOperation(id(32)), null);
      const expiredHttp = await send({ operation: id(32) });
      assert.equal(expiredHttp.status, 410);
      const terminalBody = await expiredHttp.json();
      assert.deepEqual(terminalBody, {
        schemaVersion: 1,
        error: { code: "quote_operation_expired", messageKey: "customer.quote.operation_expired" },
        resolution: {
          operationReference: id(32),
          cartReference: source.cartReference,
          cartVersion: 2,
        },
      });
      for (const privateValue of [
        sessionCredential,
        csrfCredential,
        id(1),
        scope.brandReference,
        scope.storeReference,
      ])
        assert.equal(JSON.stringify(terminalBody).includes(privateValue), false);
      await pending(id(35));
      const beforeHttpExpiry = await counts();
      loseAck = "expiry";
      const lostExpiry = await send({ operation: id(35) });
      assert.equal(lostExpiry.status, 503);
      await lostExpiry.text();
      assert.equal((await counts()).audits, beforeHttpExpiry.audits + 1);
      const recoveredExpiry = await send({ operation: id(35) });
      assert.equal(recoveredExpiry.status, 410);
      assert.equal(recoveredExpiry.headers.get("cache-control"), "no-store");
      assert.equal((await recoveredExpiry.json()).resolution.operationReference, id(35));
      assert.equal((await counts()).audits, beforeHttpExpiry.audits + 1);
      assert.equal(await quoteStore.resolveOperation(id(35)), null);
      // WP-2268: same authenticated Cart, actual item HTTP writes and version-specific Quote display.
      const currentCart = async () => {
        const response = await globalThis.fetch(
          `http://127.0.0.1:${address.port}/bff/customer/cart`,
          {
            headers: {
              cookie: `__Host-bop-guest=${sessionCredential}`,
              "sec-fetch-site": "same-origin",
              "sec-fetch-mode": "cors",
            },
          },
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        return (await response.json()).cart;
      };
      const updateItem = ({
        quantity = 2,
        version = 2,
        operation = id(51),
        csrf = csrfCredential,
      } = {}) =>
        globalThis.fetch(
          `http://127.0.0.1:${address.port}/api/v1/carts/${source.cartReference}/items/${line.lineReference}`,
          {
            method: "PATCH",
            headers: {
              origin: "https://customer.example.test",
              "sec-fetch-site": "same-origin",
              "sec-fetch-mode": "cors",
              "content-type": "application/json",
              cookie: `__Host-bop-guest=${sessionCredential}`,
              "x-csrf-token": csrf,
              "idempotency-key": operation,
              "if-match": `"${version}"`,
            },
            body: JSON.stringify({ quantity, optionSelections: [], customerNote: null }),
          },
        );
      clock++;
      const freshResponse = await send({ operation: id(50) });
      assert.equal(freshResponse.status, 201);
      const fresh = await freshResponse.json();
      assert.equal((await currentCart()).quote.quoteReference, fresh.quote.quoteReference);
      clock++;
      const changedCart = await updateItem();
      assert.equal(changedCart.status, 200);
      const changedBody = await changedCart.json();
      assert.equal(changedBody.cart.version, 3);
      assert.equal(changedBody.cart.quote, null);
      assert.equal(changedBody.cart.items[0].quantity, 2);
      const afterChange = await counts();
      const oldReplay = await send({ operation: id(50) });
      assert.equal(oldReplay.status, 201);
      assert.deepEqual(await oldReplay.json(), fresh);
      assert.equal((await currentCart()).quote, null);
      assert.deepEqual(await counts(), afterChange);
      const sameUpdate = await updateItem();
      assert.equal(sameUpdate.status, 200);
      await sameUpdate.text();
      assert.deepEqual(await counts(), afterChange);
      const newResponse = await send({ operation: id(52), version: 3 });
      assert.equal(newResponse.status, 201);
      const newQuote = await newResponse.json();
      assert.equal(newQuote.quote.cartVersion, 3);
      assert.equal(newQuote.quote.subtotal.amountMinor, (9007199254740993n * 2n).toString());
      const currentWithQuote = await currentCart();
      assert.equal(currentWithQuote.quote.quoteReference, newQuote.quote.quoteReference);
      assert.equal(currentWithQuote.quote.cartVersion, 3);
      assert.equal(currentWithQuote.items[0].quantity, 2);
      const beforeRace = await counts();
      let candidateReady;
      let releaseCandidate;
      const ready = new Promise((resolve) => {
        candidateReady = resolve;
      });
      const released = new Promise((resolve) => {
        releaseCandidate = resolve;
      });
      holdCandidate = () => {
        holdCandidate = null;
        candidateReady();
        return released;
      };
      clock++;
      const delayed = send({ operation: id(54), version: 3 });
      await Promise.race([
        ready,
        delayed.then((response) => {
          throw new Error(`candidate barrier not reached (HTTP ${response.status})`);
        }),
      ]);
      try {
        const intervening = await updateItem({ quantity: 3, version: 3, operation: id(53) });
        assert.equal(intervening.status, 200);
        const body = await intervening.json();
        assert.equal(body.cart.version, 4);
        assert.equal(body.cart.quote, null);
      } finally {
        releaseCandidate();
      }
      const staleCandidate = await delayed;
      assert.equal(staleCandidate.status, 409);
      await staleCandidate.text();
      assert.equal(await quoteStore.resolveOperation(id(54)), null);
      const afterRace = await counts();
      assert.equal(afterRace.quotes, beforeRace.quotes + 1);
      assert.equal(afterRace.requests, beforeRace.requests + 1);
      assert.equal(afterRace.attachments, beforeRace.attachments);
      assert.equal(afterRace.audits, beforeRace.audits + 2);
      assert.equal((await currentCart()).quote, null);
      const staleReplay = await send({ operation: id(54), version: 3 });
      assert.equal(staleReplay.status, 409);
      await staleReplay.text();
      assert.deepEqual(await counts(), afterRace);
      clock += 301;
      const expiredCandidate = await send({ operation: id(54), version: 3 });
      assert.equal(expiredCandidate.status, 410);
      assert.equal((await expiredCandidate.json()).resolution.cartVersion, 3);
      assert.equal(await quoteStore.resolveOperation(id(54)), null);
      assert.equal((await currentCart()).quote, null);
      assert.equal((await counts()).audits, afterRace.audits + 1);
      const finalCounts = await counts();
      const finalCandidates = candidates;
      await sessions.revoke({
        selectorHash: credentials.hashCredential("Session", sessionCredential),
        expectedVersion: 1,
        reason: "Rotated",
        observedAt: at(),
        operationReference: id(40),
        operationIntentHash: "f".repeat(64),
      });
      const revokedItem = await updateItem({ quantity: 3, version: 3, operation: id(53) });
      assert.equal(revokedItem.status, 401);
      await revokedItem.text();
      const revokedExpiry = await send({ operation: id(35) });
      assert.equal(revokedExpiry.status, 404);
      await revokedExpiry.text();
      const revoked = await send();
      assert.equal(revoked.status, 404);
      await revoked.text();
      assert.deepEqual(await counts(), finalCounts);
      assert.equal(candidates, finalCandidates);
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

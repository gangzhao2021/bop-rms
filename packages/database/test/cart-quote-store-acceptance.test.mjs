import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartQuoteStore,
  createPostgresCartQuoteReader,
  createPostgresCartQueryStore,
  createCartQuoteAttachmentService,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `018f5700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n) => new Date(Date.parse("2026-09-08T12:00:00.000Z") + n * 1000).toISOString();
const scope = { brandReference: id(2), storeReference: id(3) };
const references = {
  hashIntent: (v) => `sha256:${createHash("sha256").update(v).digest("hex")}`,
  equals: (a, b) => a === b,
};
const guest = {
  ...scope,
  sessionReference: id(4),
  status: "Active",
  version: 1,
  publicStoreReference: id(5),
  publicTableReference: null,
  channel: "Pickup",
  locale: "en-CA",
  qrReference: id(6),
  qrRevocationVersion: 1,
  diningState: "ContextOnly",
  diningSessionReference: null,
  diningParticipantReference: null,
  createdAt: at(0),
  lastSeenAt: at(0),
  idleExpiresAt: at(14400),
  absoluteExpiresAt: at(86400),
  orderClosedAt: null,
  closureExpiresAt: null,
  rotatedFromGuestSessionReference: null,
  revocationReason: null,
  revokedAt: null,
};
it("atomically attaches Quotes with exact bigint roundtrip, concurrent replay and Audit rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2239_quote" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2239_${context.runId}`;
    assert.match(role, /^wp2239_[a-f0-9]+$/u);
    let active = 0;
    let generated = 1000;
    let pricingCalls = 0;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_ordering,platform_helpers,platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(`GRANT SELECT,UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart_line TO ${role}`);
      await admin.query(
        `GRANT SELECT,INSERT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      await admin.query(
        `INSERT INTO rms_ordering.cart
        (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
         lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
        VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5,'Active',$6,$7,3600,86400,$8,$9)`,
        [
          id(100),
          id(2),
          id(3),
          id(4),
          at(0),
          id(7),
          `sha256:${"a".repeat(64)}`,
          at(3600),
          at(86400),
        ],
      );
      await admin.query(
        `INSERT INTO rms_ordering.cart_line
        (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at,catalog_selection_evidence_json)
        VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8::jsonb)`,
        [
          id(101),
          id(100),
          id(2),
          id(3),
          id(8),
          id(4),
          at(0),
          JSON.stringify({
            menuVersionReference: id(10),
            productVersionReference: id(11),
            catalogChannelCode: "PILOT_CHANNEL",
            catalogOrderTypeCode: "PILOT_ORDER_TYPE",
            ruleEvidence: [],
            validatedAt: at(0),
          }),
        ],
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
      const reader = createPostgresCartQueryStore(runner(), scope);
      const store = createPostgresCartQuoteStore(runner(), scope, references);
      const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
      function service(writer = store) {
        return createCartQuoteAttachmentService({
          references,
          // Explicit synthetic public Pricing evidence. No Pricing repository or live price is claimed.
          pricing: {
            async quoteCart(input) {
              pricingCalls++;
              const amount = 9007199254740993n;
              return {
                quoteReference: id(generated++),
                quoteVersion: 1,
                ...scope,
                cartReference: input.cartReference,
                cartVersion: input.cartVersion,
                inputDigest: `sha256:${"b".repeat(64)}`,
                currencyMetadata: {
                  currencyCode: "CAD",
                  minorUnitExponent: 2,
                  metadataVersion: 1,
                  metadataVersionReference: id(12),
                  metadataDigest: `sha256:${"c".repeat(64)}`,
                },
                subtotal: money(amount),
                discount: money(0n),
                tax: money(0n),
                fee: money(0n),
                total: money(amount),
                lines: [
                  {
                    lineReference: id(101),
                    sellableReference: id(8),
                    productVersionReference: id(11),
                    menuVersionReference: id(10),
                    quantity: 1,
                    unitPrice: money(amount),
                    subtotal: money(amount),
                    discount: money(0n),
                    tax: money(0n),
                    fee: money(0n),
                    total: money(amount),
                    resolvedPrice: {},
                    taxResolution: {},
                    taxLines: [],
                  },
                ],
                appliedPromotionReferences: [],
                warnings: [],
                blockingReasons: [],
                createdAt: input.requestedAt,
                expiresAt: new Date(Date.parse(input.requestedAt) + 300000).toISOString(),
              };
            },
          },
          authorization: {
            async authorize(input) {
              return {
                guestSession: guest,
                audit: {
                  auditId: id(generated++),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "System" },
                  actionCode: "ORDERING_CART_ATTACH_QUOTE",
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode: "AUTHORIZED_CART_QUOTE",
                  correlationId: id(9),
                  occurredAt: input.observedAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          repository: {
            loadCart: reader.load,
            resolveOperation: store.resolveOperation,
            attach: writer.attach,
          },
        });
      }
      const input = (operation, seconds = 10, version = 1) => ({
        cartReference: id(100),
        operationReference: id(operation),
        expectedCartVersion: version,
        requestedAt: at(seconds),
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment) AS attachments,
        (SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment_line) AS lines,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const original = await reader.load(id(100));
      const first = await service().attach(input(600));
      assert.equal(first.attachment.total.amountMinor, 9007199254740993n);
      const readRequest = {
        cartReference: first.attachment.cartReference,
        cartVersion: first.attachment.cartVersion,
        observedAt: first.attachment.attachedAt,
      };
      const quoteReader = createPostgresCartQuoteReader(runner(), scope);
      assert.deepEqual(Object.keys(quoteReader), ["loadLatest"]);
      const beforeReads = await counts();
      assert.deepEqual(await quoteReader.loadLatest(readRequest), first.attachment);
      assert.deepEqual(
        await quoteReader.loadLatest({
          ...readRequest,
          observedAt: first.attachment.quoteExpiresAt,
        }),
        first.attachment,
      );
      assert.equal(
        await quoteReader.loadLatest({ ...readRequest, cartVersion: readRequest.cartVersion + 1 }),
        null,
      );
      assert.equal(await quoteReader.loadLatest({ ...readRequest, cartReference: id(9999) }), null);
      assert.deepEqual(await counts(), beforeReads);
      assert.equal(
        (
          await admin.query(
            "SELECT total_minor::text AS amount FROM rms_ordering.cart_quote_attachment",
          )
        ).rows[0].amount,
        "9007199254740993",
      );
      assert.equal((await service().attach(input(600, 400))).status, "AlreadyAttached");
      assert.equal(pricingCalls, 1);
      assert.deepEqual(await reader.load(id(100)), original);
      await assert.rejects(
        service(
          createPostgresCartQuoteStore(runner({ failAudit: true }), scope, references),
        ).attach(input(601)),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await store.resolveOperation(id(601)), null);
      assert.deepEqual(await counts(), { attachments: 1, lines: 1, audits: 1 });
      await assert.rejects(
        service(createPostgresCartQuoteStore(runner({ loseAck: true }), scope, references)).attach(
          input(601),
        ),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal((await service().attach(input(601, 11))).status, "AlreadyAttached");
      let arrived = 0;
      let release;
      let timer;
      const gate = new Promise((resolve, reject) => {
        release = resolve;
        timer = setTimeout(() => reject(new Error("synthetic barrier timeout")), 5000);
      });
      const contenders = [];
      const gated = {
        async attach(value) {
          contenders.push(value.attachment);
          if (++arrived === 2) {
            clearTimeout(timer);
            release();
          }
          await gate;
          return store.attach(value);
        },
      };
      const race = await Promise.all([
        service(gated).attach(input(602, 20)),
        service(gated).attach(input(602, 21)),
      ]);
      assert.notEqual(contenders[0].quoteReference, contenders[1].quoteReference);
      assert.deepEqual(race[0].attachment, race[1].attachment);
      assert.deepEqual(await counts(), { attachments: 3, lines: 3, audits: 3 });
      let captured;
      await assert.rejects(
        service({
          async attach(value) {
            captured = value;
            throw new Error("synthetic capture");
          },
        }).attach(input(603, 30)),
      );
      await assert.rejects(
        store.attach({
          ...captured,
          attachment: {
            ...captured.attachment,
            lines: captured.attachment.lines.map((line) => ({
              ...line,
              productVersionReference: id(99),
            })),
          },
        }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        store.attach({ ...captured, audit: { ...captured.audit, targetId: id(99) } }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        createPostgresCartQuoteStore(
          runner(),
          { ...scope, storeReference: id(99) },
          references,
        ).attach(captured),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(
        await createPostgresCartQuoteStore(
          runner(),
          { ...scope, storeReference: id(99) },
          references,
        ).resolveOperation(id(600)),
        null,
      );
      assert.deepEqual(await reader.load(id(100)), original);
      // Simulate an intervening owner mutation after quote computation. The stale attachment cannot commit.
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=2,updated_at=$1 WHERE cart_id=$2",
        [at(25), id(100)],
      );
      await assert.rejects(store.attach(captured), { code: "CART_VERSION_CONFLICT" });
      assert.deepEqual(await counts(), { attachments: 3, lines: 3, audits: 3 });
      assert.equal((await service().attach(input(600, 31))).status, "AlreadyAttached");
      await assert.rejects(service().attach(input(600, 31, 2)), {
        code: "CART_IDEMPOTENCY_CONFLICT",
      });
      const saved = await store.resolveOperation(id(600));
      assert.deepEqual(saved, first.attachment);
      assert.equal(
        (
          await admin.query(
            "SELECT next_sequence::integer AS n FROM platform_audit.audit_chain_head",
          )
        ).rows[0].n,
        4,
      );
      const expiredAt = at(86410);
      const expiredIntent = references.hashIntent(
        `AttachQuote:${JSON.stringify({
          cartReference: id(100),
          expectedCartVersion: 1,
          operationReference: id(600),
          requestedAt: expiredAt,
        })}`,
      );
      await assert.rejects(
        store.attach({
          ...captured,
          attachment: {
            ...captured.attachment,
            operationReference: id(600),
            operationIntentHash: expiredIntent,
            quoteCreatedAt: expiredAt,
            quoteExpiresAt: at(86710),
            attachedAt: expiredAt,
            idempotencyExpiresAt: at(172810),
          },
          audit: { ...captured.audit, occurredAt: expiredAt },
        }),
        { code: "CART_IDEMPOTENCY_CONFLICT" },
      );
      await assert.rejects(service().attach(input(604, 3600, 2)), { code: "CART_EXPIRED" });
      assert.deepEqual(await counts(), { attachments: 3, lines: 3, audits: 3 });
      assert.equal(active, 0);
    } finally {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  });
});

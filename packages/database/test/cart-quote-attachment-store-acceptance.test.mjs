import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createCartQuoteAttachmentService,
  createPostgresCartQuoteAttachmentStore,
  createCustomerCartService,
  createPostgresCustomerCartStore,
} from "../../rms/ordering/src/index.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
function check(value, code) {
  if (!value) throw new Error(`WP2224_${code}`);
}
async function denied(action, code) {
  let result;
  try {
    await action();
  } catch (error) {
    result = error?.code;
  }
  check(result === code, "EXPECTED_CONTROLLED_DENIAL");
}
function guest(session = 4, store = 3, dining = false) {
  return {
    sessionReference: id(session),
    status: "Active",
    version: 1,
    brandReference: id(2),
    storeReference: id(store),
    publicStoreReference: id(5),
    publicTableReference: dining ? id(6) : null,
    channel: dining ? "DineIn" : "Pickup",
    locale: "en-CA",
    qrReference: id(7),
    qrRevocationVersion: 1,
    diningState: dining ? "DiningBound" : "ContextOnly",
    diningSessionReference: dining ? id(8) : null,
    diningParticipantReference: dining ? id(session + 500) : null,
    createdAt: "2026-08-02T13:00:00.000Z",
    lastSeenAt: at,
    idleExpiresAt: "2026-08-02T18:00:00.000Z",
    absoluteExpiresAt: "2026-08-03T13:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  };
}
const command = (n) => ({ operationReference: id(n), requestedAt: at });

it("persists exact Cart quote evidence with bigint precision, replay, history and Audit rollback", async () => {
  await withIsolatedDatabase({ workPackage: "WP-2224" }, async (database) => {
    const admin = new Client(database.clientConfig);
    const pools = [];
    const role = `bop_wp2224_${database.runId}`;
    let roleCreated = false;
    let phase = "SETUP";
    let next = 1000;
    let rolledBackAudit = false;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roleCreated = true;
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_ordering, platform_helpers, platform_audit TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart, rms_ordering.cart_customer_owner, rms_ordering.cart_creation_operation TO ${role}`,
      );
      await admin.query(`GRANT UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON rms_ordering.cart_line TO ${role}`,
      );
      await admin.query(`GRANT SELECT, INSERT ON rms_ordering.cart_operation_record TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON platform_audit.audit_record TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart_quote_attachment, rms_ordering.cart_quote_attachment_line TO ${role}`,
      );
      function runner(store = 3, fail = false) {
        const pool = new Pool({
          ...database.clientConfig,
          max: 4,
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        pools.push(pool);
        const base = createTenantTransactionRunner(
          {
            options: pool.options,
            async connect() {
              const client = await pool.connect();
              try {
                await client.query(`SET ROLE ${role}`);
                return client;
              } catch {
                client.release(true);
                throw new Error("WP2224_ROLE_FAILED");
              }
            },
          },
          { brandId: id(2), storeId: id(store) },
        );
        return {
          run(action) {
            return base.run(async (tx) => {
              let audited = false;
              const result = await action({
                async query(sql, values) {
                  const value = await tx.query(sql, values);
                  if (sql.startsWith("INSERT INTO platform_audit.audit_record")) audited = true;
                  return value;
                },
              });
              if (fail && audited) {
                rolledBackAudit = true;
                throw new Error("WP2224_INJECTED_ROLLBACK");
              }
              return result;
            });
          },
        };
      }
      function service(session = guest(), fail = false) {
        return createCustomerCartService({
          authorization: {
            async authorize() {
              return session;
            },
          },
          policy: {
            async resolve() {
              return {
                policyVersionReference: id(20),
                policyDigest: `sha256:${"a".repeat(64)}`,
                idleTimeoutSeconds: 3600,
                absoluteTimeoutSeconds: 86400,
                sourceChannel: "Qr",
              };
            },
          },
          references: {
            generate: () => id(next++),
            hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
          },
          audit: {
            async prepare(input) {
              return {
                auditId: id(next++),
                brandId: input.owner.brandReference,
                storeId: input.owner.storeReference,
                actor: { type: "System" },
                actionCode: "ORDERING_CART_CREATE",
                targetType: "OrderingCart",
                targetId: input.cartReference,
                reasonCode: "AUTHORIZED_CART_MUTATION",
                correlationId: input.operationReference,
                occurredAt: input.occurredAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              };
            },
          },
          repository: createPostgresCustomerCartStore({
            brandReference: session.brandReference,
            storeReference: session.storeReference,
            runner: runner(Number.parseInt(session.storeReference.slice(-12), 16), fail),
          }),
        });
      }
      const hashIntent = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
      const repo = (store = 3, fail = false) =>
        createPostgresCartQuoteAttachmentStore({
          brandReference: id(2),
          storeReference: id(store),
          runner: runner(store, fail),
        });
      const amount = 9007199254740993n;
      const money = (value) => ({ amountMinor: value, currencyCode: "CAD" });
      let pricingCalls = 0;
      let pricingAvailable = true;
      function quoting(repository = repo()) {
        return createCartQuoteAttachmentService({
          repository,
          references: { hashIntent, equals: (a, b) => a === b },
          authorization: {
            async authorize(input) {
              return {
                guestSession: guest(),
                audit: {
                  auditId: id(next++),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "System" },
                  actionCode: "ORDERING_CART_ATTACH_QUOTE",
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode: "AUTHORIZED_CART_QUOTE",
                  correlationId: input.operationReference,
                  occurredAt: input.observedAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          pricing: {
            async quoteCart(input) {
              if (!pricingAvailable) throw new Error("WP2224_PRICING_MUST_NOT_BE_CALLED");
              pricingCalls++;
              const total = amount * BigInt(input.lines.length);
              return {
                quoteReference: id(next++),
                quoteVersion: 1,
                brandReference: input.brandReference,
                storeReference: input.storeReference,
                cartReference: input.cartReference,
                cartVersion: input.cartVersion,
                inputDigest: hashIntent("synthetic quote"),
                currencyMetadata: {
                  currencyCode: "CAD",
                  minorUnitExponent: 2,
                  metadataVersion: 1,
                  metadataVersionReference: id(60),
                  metadataDigest: hashIntent("synthetic currency"),
                },
                subtotal: money(total),
                discount: money(0n),
                tax: money(0n),
                fee: money(0n),
                total: money(total),
                lines: [...input.lines].reverse().map((line) => ({
                  lineReference: line.lineReference,
                  sellableReference: line.sellableReference,
                  productVersionReference: line.catalogSelectionEvidence.productVersionReference,
                  menuVersionReference: line.catalogSelectionEvidence.menuVersionReference,
                  quantity: line.quantity,
                  unitPrice: money(amount),
                  subtotal: money(amount),
                  discount: money(0n),
                  tax: money(0n),
                  fee: money(0n),
                  total: money(amount),
                  resolvedPrice: {},
                  taxResolution: {},
                  taxLines: [],
                })),
                appliedPromotionReferences: [],
                warnings: ["SYNTHETIC_WARNING"],
                blockingReasons: [],
                createdAt: input.requestedAt,
                expiresAt: "2026-08-02T14:05:00.000Z",
              };
            },
          },
        });
      }
      const stringify = (value) =>
        JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
      const equal = (a, b) => check(stringify(a) === stringify(b), "EXACT_RESULT");
      const cart = (await service().create(command(30))).aggregate;
      // Minimal synthetic Item evidence, without notes or real Store/Pricing facts.
      for (const n of [91, 90]) {
        const evidence = {
          menuVersionReference: id(70),
          productVersionReference: id(71),
          catalogChannelCode: "PICKUP",
          catalogOrderTypeCode: "PICKUP",
          ruleEvidence: [{ bindingReference: id(72), optionSetVersionReference: id(73) }],
          validatedAt: at,
        };
        await admin.query(
          `INSERT INTO rms_ordering.cart_line (brand_id,store_id,cart_id,cart_line_id,sellable_id,quantity,option_selections_json,customer_note,catalog_selection_evidence_json,added_by_actor_id,added_at) VALUES ($1,$2,$3,$4,$5,1,'[]',NULL,$6::jsonb,$7,$8)`,
          [
            id(2),
            id(3),
            cart.cartReference,
            id(n),
            id(n + 10),
            JSON.stringify(evidence),
            id(4),
            at,
          ],
        );
      }
      const originalCart = await repo().loadCart(cart.cartReference);
      const input = {
        cartReference: cart.cartReference,
        expectedCartVersion: 1,
        operationReference: id(31),
        requestedAt: "2026-08-02T14:01:00.000Z",
      };
      let candidate;
      phase = "AUTHORIZED_QUOTE";
      await quoting({
        ...repo(),
        attach: async (value) => {
          candidate = value;
          return value.attachment;
        },
      }).attach(input);
      phase = "CONCURRENT_ATTACH";
      const copies = await Promise.all([repo().attach(candidate), repo().attach(candidate)]);
      equal(copies[0], copies[1]);
      check(copies[0].total.amountMinor === amount * 2n, "BIGINT_PRECISION");
      equal(
        copies[0].lines.map((line) => line.lineReference),
        [id(90), id(91)],
      );
      equal(await repo().loadCart(cart.cartReference), originalCart);
      const counts = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment) AS headers,(SELECT count(*)::integer FROM rms_ordering.cart_quote_attachment_line) AS lines,(SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`,
          )
        ).rows[0];
      equal(await counts(), { headers: 1, lines: 2, audits: 2 });
      phase = "FRESH_SERVICE_REPLAY";
      pricingAvailable = false;
      const replay = await quoting().attach(input);
      check(replay.status === "AlreadyAttached" && pricingCalls === 1, "NO_PRICING_REPLAY");
      equal(replay.attachment, copies[0]);
      const alter = (operation, quote) => ({
        ...candidate,
        attachment: {
          ...candidate.attachment,
          operationReference: id(operation),
          operationIntentHash: hashIntent(String(operation)),
          quoteReference: id(quote),
        },
        audit: { ...candidate.audit, auditId: id(next++), correlationId: id(operation) },
      });
      await denied(
        () =>
          repo().attach({
            ...candidate,
            attachment: { ...candidate.attachment, quoteReference: id(500) },
          }),
        "CART_IDEMPOTENCY_CONFLICT",
      );
      phase = "SCOPE_AND_IMMUTABILITY";
      check((await repo(99).loadCart(cart.cartReference)) === null, "FOREIGN_CART");
      check((await repo(99).resolveOperation(id(31))) === null, "FOREIGN_ATTACHMENT");
      const foreign = await runner(99).run((tx) =>
        tx.query("SELECT operation_id FROM rms_ordering.cart_quote_attachment", []),
      );
      check(foreign.rows.length === 0, "FORCED_RLS");
      await admin.query(
        "UPDATE rms_ordering.cart_quote_attachment SET total_minor=total_minor+1 WHERE operation_id=$1",
        [id(31)],
      );
      await admin.query(
        "DELETE FROM rms_ordering.cart_quote_attachment_line WHERE operation_id=$1",
        [id(31)],
      );
      await admin.query("DELETE FROM rms_ordering.cart_quote_attachment WHERE operation_id=$1", [
        id(31),
      ]);
      equal(await repo().resolveOperation(id(31)), copies[0]);
      phase = "AUDIT_ROLLBACK";
      const rollback = alter(32, 501);
      await denied(() => repo(3, true).attach(rollback), "CART_DEPENDENCY_UNAVAILABLE");
      check(rolledBackAudit, "ROLLBACK_INJECTED");
      equal(await counts(), { headers: 1, lines: 2, audits: 2 });
      equal(await repo().loadCart(cart.cartReference), originalCart);
      phase = "LINE_MISMATCH";
      await denied(
        () =>
          repo().attach({
            ...rollback,
            attachment: {
              ...rollback.attachment,
              lines: rollback.attachment.lines.map((line, index) =>
                index === 0 ? { ...line, quantity: 2 } : line,
              ),
            },
          }),
        "CART_DEPENDENCY_UNAVAILABLE",
      );
      equal(await counts(), { headers: 1, lines: 2, audits: 2 });
      phase = "REQUOTE_HISTORY";
      const requotes = await Promise.all([
        repo().attach(alter(33, 502)),
        repo().attach(alter(34, 503)),
      ]);
      check(requotes.length === 2, "REQUOTE_COUNT");
      equal(await counts(), { headers: 3, lines: 6, audits: 4 });
      equal(await repo().loadCart(cart.cartReference), originalCart);
      phase = "STALE_CART";
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=2,updated_at=$1 WHERE cart_id=$2",
        ["2026-08-02T14:02:00.000Z", cart.cartReference],
      );
      await denied(() => repo().attach(alter(35, 504)), "CART_VERSION_CONFLICT");
      equal((await quoting().attach(input)).attachment, copies[0]);
      check(pricingCalls === 1, "NO_PRICING_AFTER_CART_CHANGE");
      phase = "TERMINAL_CART";
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=3,updated_at=$1,lifecycle_status='Abandoned',terminal_at=$1,terminal_reason='CUSTOMER_ABANDONED' WHERE cart_id=$2",
        ["2026-08-02T14:03:00.000Z", cart.cartReference],
      );
      const terminal = alter(36, 505);
      await denied(
        () =>
          repo().attach({
            ...terminal,
            expectedCartVersion: 3,
            audit: { ...terminal.audit, occurredAt: "2026-08-02T14:04:00.000Z" },
            attachment: {
              ...terminal.attachment,
              cartVersion: 3,
              attachedAt: "2026-08-02T14:04:00.000Z",
              idempotencyExpiresAt: "2026-08-03T14:04:00.000Z",
            },
          }),
        "CART_ABANDONED",
      );
      equal(await counts(), { headers: 3, lines: 6, audits: 4 });
    } catch (error) {
      if (/^WP2224_[A-Z_]+$/.test(error?.message ?? "")) throw error;
      check(false, `${phase}_FAILED`);
    } finally {
      await admin.query("ROLLBACK");
      await Promise.all(pools.map((pool) => pool.end()));
      try {
        if (roleCreated) {
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await admin.end();
      }
    }
  });
});

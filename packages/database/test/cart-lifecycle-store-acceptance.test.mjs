import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartLifecycleStore,
  createPostgresCartQueryStore,
  createCartLifecycleCommandService,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `018f5600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n) => new Date(Date.parse("2026-09-08T12:00:00.000Z") + n * 1000).toISOString();
const scope = { brandReference: id(2), storeReference: id(3) };
const references = {
  hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
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
it("persists lifecycle commands with atomic Audit, stable replay and concurrent version checks", async () => {
  await withIsolatedDatabase({ caseId: "wp2238_lifecycle" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2238_${context.runId}`;
    assert.match(role, /^wp2238_[a-f0-9]+$/u);
    let active = 0;
    let generated = 1000;
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
        `GRANT SELECT,INSERT ON rms_ordering.cart_lifecycle_operation_record,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      async function seed(n, idle = 60, absolute = 120) {
        await admin.query(
          `INSERT INTO rms_ordering.cart
          (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
           lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
          VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5,'Active',$6,$7,$8,$9,$10,$11)`,
          [
            id(n),
            id(2),
            id(3),
            id(4),
            at(0),
            id(7),
            `sha256:${"a".repeat(64)}`,
            idle,
            absolute,
            at(idle),
            at(absolute),
          ],
        );
        await admin.query(
          `INSERT INTO rms_ordering.cart_line
          (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at,customer_note)
          VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8)`,
          [id(n + 1), id(n), id(2), id(3), id(8), id(4), at(0), "Synthetic note"],
        );
      }
      for (const n of [100, 120, 140, 160, 180, 200, 220]) await seed(n);
      await seed(240, 120, 120);
      await admin.query(
        `INSERT INTO rms_ordering.cart_quote_attachment
        (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,quote_id,quote_version,quote_input_digest,
         currency_code,currency_metadata_version,currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
         line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,1,$6,'CAD',1,$8,100,0,0,0,100,1,'[]'::jsonb,$9,$10,$9,$11)`,
        [
          id(500),
          id(2),
          id(3),
          id(100),
          id(4),
          `sha256:${"b".repeat(64)}`,
          id(501),
          id(502),
          at(1),
          at(59),
          at(86401),
        ],
      );
      const quoteBefore = (await admin.query("SELECT * FROM rms_ordering.cart_quote_attachment"))
        .rows;
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
      const store = createPostgresCartLifecycleStore(runner(), scope, references);
      function service(writer = store, authorize = true) {
        return createCartLifecycleCommandService({
          references,
          authorization: {
            async authorize(input) {
              if (!authorize) return null;
              return {
                guestSession: input.action === "Abandon" ? guest : null,
                audit: {
                  auditId: id(generated++),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "System" },
                  actionCode: `ORDERING_CART_${input.action.toUpperCase()}`,
                  targetType: "OrderingCart",
                  targetId: input.cartReference,
                  reasonCode:
                    input.action === "Abandon"
                      ? "AUTHORIZED_CART_ABANDONMENT"
                      : "CART_DEADLINE_REACHED",
                  correlationId: id(9),
                  occurredAt: input.observedAt,
                  sourceChannel: input.action === "Abandon" ? "CUSTOMER_PWA" : "SYSTEM",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          repository: {
            load: reader.load,
            resolveOperation: store.resolveOperation,
            commit: writer.commit,
          },
        });
      }
      const input = (cart, operation, action, seconds) => ({
        cartReference: id(cart),
        operationReference: id(operation),
        expectedAggregateVersion: 1,
        [action === "Abandon" ? "requestedAt" : "evaluatedAt"]: at(seconds),
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_ordering.cart_lifecycle_operation_record) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const original = await reader.load(id(100));
      const first = await service().abandon(input(100, 600, "Abandon", 10));
      assert.equal(first.aggregate.lifecycle.status, "Abandoned");
      assert.deepEqual(first.aggregate.items, original.items);
      assert.deepEqual(
        (await admin.query("SELECT * FROM rms_ordering.cart_quote_attachment")).rows,
        quoteBefore,
      );
      assert.equal(
        (await service().abandon(input(100, 600, "Abandon", 70))).status,
        "AlreadyApplied",
      );
      assert.deepEqual(await counts(), { operations: 1, audits: 1 });
      await assert.rejects(service(store, false).abandon(input(100, 600, "Abandon", 71)), {
        code: "CART_PERMISSION_DENIED",
      });
      await assert.rejects(service().expire(input(120, 601, "Expire", 59)), {
        code: "CART_EXPIRATION_NOT_DUE",
      });
      assert.equal(
        (await service().expire(input(120, 601, "Expire", 60))).aggregate.lifecycle.terminalReason,
        "IDLE_TIMEOUT",
      );
      assert.equal(
        (await service().expire(input(240, 602, "Expire", 120))).aggregate.lifecycle.terminalReason,
        "ABSOLUTE_TIMEOUT",
      );
      await assert.rejects(
        service(
          createPostgresCartLifecycleStore(runner({ failAudit: true }), scope, references),
        ).abandon(input(140, 603, "Abandon", 10)),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal((await reader.load(id(140))).aggregateVersion, 1);
      assert.equal(await store.resolveOperation(id(603)), null);
      assert.deepEqual(await counts(), { operations: 3, audits: 3 });
      await assert.rejects(
        service(
          createPostgresCartLifecycleStore(runner({ loseAck: true }), scope, references),
        ).abandon(input(140, 603, "Abandon", 10)),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(
        (await service().abandon(input(140, 603, "Abandon", 11))).status,
        "AlreadyApplied",
      );
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
      // Both requests load the same source version before either commit. Delayed winner time is canonical.
      async function concurrent(cart, action, sameKey) {
        let arrived = 0;
        let release;
        let timer;
        const gate = new Promise((resolve, reject) => {
          release = resolve;
          timer = setTimeout(() => reject(new Error("synthetic barrier timeout")), 5000);
        });
        const writer = {
          async commit(value) {
            if (++arrived === 2) {
              clearTimeout(timer);
              release();
            }
            await gate;
            return store.commit(value);
          },
        };
        const a = input(cart, cart + 1000, action, action === "Abandon" ? 10 : 60);
        const b = input(
          cart,
          cart + (sameKey ? 1000 : 1001),
          action,
          action === "Abandon" ? 11 : 61,
        );
        return Promise.allSettled([
          action === "Abandon" ? service(writer).abandon(a) : service(writer).expire(a),
          action === "Abandon" ? service(writer).abandon(b) : service(writer).expire(b),
        ]);
      }
      for (const [cart, action] of [
        [160, "Abandon"],
        [180, "Expire"],
      ]) {
        const result = await concurrent(cart, action, true);
        assert.ok(result.every((r) => r.status === "fulfilled"));
        assert.deepEqual(result[0].value.aggregate, result[1].value.aggregate);
        assert.equal((await reader.load(id(cart))).aggregateVersion, 2);
      }
      const race = await concurrent(200, "Abandon", false);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(race.find((r) => r.status === "rejected").reason.code, "CART_VERSION_CONFLICT");
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });
      let captured;
      await assert.rejects(
        service({
          async commit(value) {
            captured = value;
            throw new Error("synthetic capture");
          },
        }).abandon(input(220, 604, "Abandon", 10)),
      );
      await assert.rejects(
        store.commit({
          ...captured,
          record: { ...captured.record, result: { ...captured.record.result, items: [] } },
        }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        store.commit({ ...captured, audit: { ...captured.audit, targetId: id(999) } }),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      await assert.rejects(
        createPostgresCartLifecycleStore(
          runner(),
          { ...scope, storeReference: id(99) },
          references,
        ).commit(captured),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(
        await createPostgresCartLifecycleStore(
          runner(),
          { ...scope, storeReference: id(99) },
          references,
        ).resolveOperation(id(600)),
        null,
      );
      assert.equal((await reader.load(id(220))).aggregateVersion, 1);
      const saved = await store.resolveOperation(id(602));
      await assert.rejects(service().expire(input(240, 602, "Expire", 86520)), {
        code: "CART_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual(await store.resolveOperation(id(602)), saved);
      assert.deepEqual(await counts(), { operations: 7, audits: 7 });
      assert.equal(
        (
          await admin.query(
            "SELECT next_sequence::integer AS n FROM platform_audit.audit_chain_head",
          )
        ).rows[0].n,
        8,
      );
      assert.deepEqual(
        (await admin.query("SELECT * FROM rms_ordering.cart_quote_attachment")).rows,
        quoteBefore,
      );
      assert.equal(active, 0);
    } finally {
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  });
});

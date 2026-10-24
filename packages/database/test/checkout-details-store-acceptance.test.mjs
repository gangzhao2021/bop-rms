import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresCheckoutDetailsStore } from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
it("persists original checkout details with revision contention, lost response, scoped reads and Audit rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_details" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_details_" + context.runId;
    assert.match(role, /^wp2402_details_[a-f0-9]+$/u);
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
        "GRANT SELECT,INSERT ON rms_ordering.checkout_details_record,platform_audit.audit_record TO " +
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
      function input(version = 1, operation = 10) {
        return {
          operationReference: id(operation),
          expectedVersion: version - 1,
          snapshot: {
            schemaVersion: 1,
            detailsReference: id(6),
            detailsVersion: version,
            guestSessionReference: id(4),
            ...scope,
            cartReference: id(3),
            cartVersion: 1,
            quoteReference: id(7),
            quoteVersion: 2,
            orderType: "Pickup",
            pickupContact: { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
            receipt: { choice: "InSession", email: null },
            policies: [],
            recordedAt: now,
          },
          audit: {
            auditId: id(operation + 100),
            brandId: id(1),
            storeId: id(2),
            actor: { type: "System" },
            actionCode: "ORDERING_CHECKOUT_DETAILS_SAVE",
            reasonCode: "AUTHORIZED_CHECKOUT_UPDATE",
            targetType: "CheckoutDetails",
            targetId: id(6),
            occurredAt: now,
            correlationId: id(8),
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        };
      }
      const store = createPostgresCheckoutDetailsStore(runner(), scope);
      assert.equal(await store.loadLatest(id(3), id(4)), null);
      await assert.rejects(
        createPostgresCheckoutDetailsStore(runner({ loseAck: true }), scope).save(input()),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      const recovered = await store.save(input());
      assert.equal(recovered.status, "AlreadySaved");
      assert.deepEqual(recovered.snapshot, input().snapshot);
      const changed = input();
      changed.snapshot.pickupContact.name = "Different synthetic guest";
      await assert.rejects(store.save(changed), { code: "CART_IDEMPOTENCY_CONFLICT" });
      const races = await Promise.allSettled([store.save(input(2, 11)), store.save(input(2, 12))]);
      assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(races.find((r) => r.status === "rejected").reason.code, "CART_VERSION_CONFLICT");
      await assert.rejects(
        createPostgresCheckoutDetailsStore(runner({ failAudit: true }), scope).save(input(3, 13)),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await store.resolveOperation(id(13), id(4)), null);
      assert.deepEqual(await store.loadLatest(id(3), id(4)), input(2, 11).snapshot);
      assert.equal(await store.loadLatest(id(99), id(4)), null);
      assert.equal(await store.loadLatest(id(3), id(99)), null);
      for (const field of ["brandReference", "storeReference"]) {
        const foreign = createPostgresCheckoutDetailsStore(runner(), {
          ...scope,
          [field]: id(99),
        });
        assert.equal(await foreign.loadLatest(id(3), id(4)), null);
      }
      await assert.rejects(store.loadLatest("invalid", id(4)), {
        code: "CART_DEPENDENCY_UNAVAILABLE",
      });

      assert.equal(await store.resolveOperation(id(10), id(99)), null);
      assert.equal(
        await createPostgresCheckoutDetailsStore(runner(), {
          ...scope,
          storeReference: id(99),
        }).resolveOperation(id(10), id(4)),
        null,
      );
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_details_record) AS details,(SELECT count(*)::int FROM platform_audit.audit_record) AS audits",
      );
      assert.deepEqual(counts.rows[0], { details: 2, audits: 2 });
      assert.deepEqual(await store.resolveOperation(id(10), id(4)), input().snapshot);
      await admin.query(
        "UPDATE rms_ordering.checkout_details_record SET snapshot_json='{}'::jsonb",
      );
      assert.deepEqual(await store.resolveOperation(id(10), id(4)), input().snapshot);
      const malformed = input(3, 14);
      malformed.snapshot.cartVersion = 2;
      await assert.rejects(store.save(malformed), { code: "CART_VERSION_CONFLICT" });
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});

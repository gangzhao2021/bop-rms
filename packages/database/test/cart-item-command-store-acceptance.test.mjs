import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import {
  createCartItemCommandService,
  createPostgresCartQueryStore,
  createPostgresCartItemOperationStore,
  createPostgresCartItemCommandStore,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const createdAt = "2026-08-02T14:00:00.000Z";
const at = "2026-08-02T14:01:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
const references = {
  hashIntent: (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
  equals: (a, b) => a === b,
};
const guest = {
  sessionReference: id(4),
  status: "Active",
  version: 1,
  ...scope,
  publicStoreReference: id(5),
  publicTableReference: null,
  channel: "Pickup",
  locale: "en-CA",
  qrReference: id(6),
  qrRevocationVersion: 1,
  diningState: "ContextOnly",
  diningSessionReference: null,
  diningParticipantReference: null,
  createdAt,
  lastSeenAt: createdAt,
  idleExpiresAt: "2026-08-02T18:00:00.000Z",
  absoluteExpiresAt: "2026-08-03T14:00:00.000Z",
  orderClosedAt: null,
  closureExpiresAt: null,
  rotatedFromGuestSessionReference: null,
  revocationReason: null,
  revokedAt: null,
};

it("atomically persists Cart items, history and Audit through the real command service", async () => {
  await withIsolatedDatabase({ caseId: "wp2231_cart_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2231_${context.runId}`;
    assert.match(role, /^wp2231_[a-f0-9]+$/u);
    let active = 0;
    let generated = 1000;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_ordering, platform_audit, platform_helpers TO ${role}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(`GRANT SELECT, UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON rms_ordering.cart_line TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT ON rms_ordering.cart_operation_record, platform_audit.audit_record TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON platform_audit.audit_chain_head TO ${role}`,
      );
      await admin.query(
        `INSERT INTO rms_ordering.cart
        (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at,
         lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
        VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5,'Active',$6,$7,3600,86400,$8,$9)`,
        [
          id(1),
          id(2),
          id(3),
          id(4),
          createdAt,
          id(7),
          `sha256:${"a".repeat(64)}`,
          "2026-08-02T15:00:00.000Z",
          "2026-08-03T14:00:00.000Z",
        ],
      );
      function runner({ readOnly = false, failAudit = false, loseAck = false } = {}) {
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
              await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
              await client.query(`SET LOCAL ROLE ${role}`);
              await client.query("SET LOCAL lock_timeout='5s'");
              await client.query("SET LOCAL statement_timeout='5s'");
              const result = await action({
                query: async (sql, values) => {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              const cleared = await client.query(
                "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
              );
              assert(!cleared.rows[0].brand && !cleared.rows[0].store);
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
      const reader = createPostgresCartQueryStore(runner({ readOnly: true }), scope);
      const operations = createPostgresCartItemOperationStore(runner({ readOnly: true }), scope);
      const writer = createPostgresCartItemCommandStore(runner(), scope, references);
      function service(selectedWriter = writer) {
        return createCartItemCommandService({
          references: {
            generate: () => id(++generated),
            hashIntent: (v) => `sha256:${createHash("sha256").update(v).digest("hex")}`,
            equals: (a, b) => a === b,
          },
          authorization: {
            async authorize(input) {
              return {
                guestSession: guest,
                audit: {
                  auditId: id(++generated),
                  brandId: id(2),
                  storeId: id(3),
                  actor: { type: "System" },
                  actionCode: `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
                  targetType: "OrderingCart",
                  targetId: id(1),
                  reasonCode: "AUTHORIZED_CART_MUTATION",
                  correlationId: id(8),
                  occurredAt: input.observedAt,
                  sourceChannel: "CUSTOMER_PWA",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                },
              };
            },
          },
          catalog: {
            async validateSelection(input) {
              return {
                status: "Accepted",
                ...input,
                menuVersionReference: id(9),
                productVersionReference: id(10),
                catalogChannelCode: "PILOT_CHANNEL",
                catalogOrderTypeCode: "PILOT_ORDER_TYPE",
                ruleEvidence: [],
                validatedAt: input.observedAt,
              };
            },
          },
          repository: {
            load: reader.load,
            resolveOperation: operations.resolveOperation,
            commit: selectedWriter.commit,
          },
        });
      }
      const add = (operation, version) => ({
        cartReference: id(1),
        expectedAggregateVersion: version,
        sellableReference: id(11),
        quantity: 2,
        optionSelections: [],
        customerNote: "Synthetic note",
        operationReference: id(operation),
        requestedAt: at,
      });
      const counts = async () =>
        (
          await admin.query(`SELECT
        (SELECT count(*)::integer FROM rms_ordering.cart_operation_record) AS operations,
        (SELECT count(*)::integer FROM platform_audit.audit_record) AS audits`)
        ).rows[0];
      const first = await service().add(add(30, 1));
      assert.equal(first.aggregate.aggregateVersion, 2);
      assert.equal(first.aggregate.lifecycle.idleExpiresAt, "2026-08-02T15:01:00.000Z");
      const saved = await operations.resolveOperation(id(30));
      const replay = await service().add({
        ...add(30, 1),
        requestedAt: "2026-08-02T14:01:00.010Z",
      });
      assert.equal(replay.status, "AlreadyApplied");
      assert.deepEqual(replay.aggregate, first.aggregate);
      assert.deepEqual(
        await writer.commit({
          record: saved,
          expectedAggregateVersion: 1,
          audit: {
            auditId: id(++generated),
            brandId: id(2),
            storeId: id(3),
            actor: { type: "System" },
            actionCode: "ORDERING_CART_ITEM_ADD",
            targetType: "OrderingCart",
            targetId: id(1),
            reasonCode: "AUTHORIZED_CART_MUTATION",
            correlationId: id(8),
            occurredAt: at,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        }),
        saved,
      );
      assert.deepEqual(await counts(), { operations: 1, audits: 1 });
      const changed = await service().update({
        cartReference: id(1),
        cartItemReference: first.cartItemReference,
        expectedAggregateVersion: 2,
        quantity: 3,
        optionSelections: [],
        customerNote: null,
        operationReference: id(31),
        requestedAt: at,
      });
      assert.equal(changed.aggregate.items[0].quantity, 3);
      assert.equal(changed.aggregate.items[0].addedByActorReference, id(4));
      await service().remove({
        cartReference: id(1),
        cartItemReference: first.cartItemReference,
        expectedAggregateVersion: 3,
        operationReference: id(32),
        requestedAt: at,
      });
      assert.equal((await reader.load(id(1))).items.length, 0);
      assert.deepEqual((await operations.resolveOperation(id(30))).result, first.aggregate);
      const race = await Promise.allSettled([service().add(add(33, 4)), service().add(add(34, 4))]);
      assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(race.find((r) => r.status === "rejected").reason.code, "CART_VERSION_CONFLICT");
      assert.equal((await reader.load(id(1))).aggregateVersion, 5);
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
      await assert.rejects(
        service(
          createPostgresCartItemCommandStore(runner({ failAudit: true }), scope, references),
        ).add(add(35, 5)),
        (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal((await reader.load(id(1))).aggregateVersion, 5);
      assert.equal((await reader.load(id(1))).items.length, 1);
      assert.equal(await operations.resolveOperation(id(35)), null);
      assert.deepEqual(await counts(), { operations: 4, audits: 4 });
      await assert.rejects(
        service(
          createPostgresCartItemCommandStore(runner({ loseAck: true }), scope, references),
        ).add(add(36, 5)),
        (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal((await service().add(add(36, 5))).status, "AlreadyApplied");
      assert.equal((await reader.load(id(1))).aggregateVersion, 6);
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      let captured;
      await assert.rejects(
        service({
          async commit(input) {
            captured = input;
            throw new Error("synthetic capture");
          },
        }).add(add(37, 6)),
      );
      await assert.rejects(
        writer.commit({
          ...captured,
          record: {
            ...captured.record,
            result: { ...captured.record.result, sourceChannel: "Web" },
          },
        }),
        (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
      );
      await assert.rejects(
        createPostgresCartItemCommandStore(
          runner(),
          { ...scope, storeReference: id(99) },
          references,
        ).commit(captured),
        (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal((await reader.load(id(1))).aggregateVersion, 6);
      assert.deepEqual(await counts(), { operations: 5, audits: 5 });
      assert.equal(
        (
          await admin.query(
            "SELECT next_sequence::integer AS sequence FROM platform_audit.audit_chain_head",
          )
        ).rows[0].sequence,
        6,
      );
      async function converge(firstCall, secondCall) {
        let arrived = 0;
        let release;
        let timer;
        const gate = new Promise((resolve, reject) => {
          release = resolve;
          timer = setTimeout(() => reject(new Error("synthetic barrier timeout")), 5000);
        });
        const gated = {
          async commit(input) {
            if (++arrived === 2) {
              clearTimeout(timer);
              release();
            }
            await gate;
            return writer.commit(input);
          },
        };
        const [firstResult, secondResult] = await Promise.all([
          firstCall(service(gated)),
          secondCall(service(gated)),
        ]);
        assert.deepEqual(firstResult.aggregate, secondResult.aggregate);
        assert.equal(firstResult.cartItemReference, secondResult.cartItemReference);
        return firstResult;
      }
      const simultaneousAdd = await converge(
        (s) => s.add({ ...add(38, 6), requestedAt: "2026-08-02T14:02:00.000Z" }),
        (s) => s.add({ ...add(38, 6), requestedAt: "2026-08-02T14:02:00.001Z" }),
      );
      const update = {
        cartReference: id(1),
        cartItemReference: simultaneousAdd.cartItemReference,
        expectedAggregateVersion: 7,
        quantity: 4,
        optionSelections: [],
        customerNote: null,
        operationReference: id(39),
      };
      await converge(
        (s) => s.update({ ...update, requestedAt: "2026-08-02T14:03:00.000Z" }),
        (s) => s.update({ ...update, requestedAt: "2026-08-02T14:03:00.001Z" }),
      );
      const remove = {
        cartReference: id(1),
        cartItemReference: simultaneousAdd.cartItemReference,
        expectedAggregateVersion: 8,
        operationReference: id(40),
      };
      await converge(
        (s) => s.remove({ ...remove, requestedAt: "2026-08-02T14:04:00.000Z" }),
        (s) => s.remove({ ...remove, requestedAt: "2026-08-02T14:04:00.001Z" }),
      );
      assert.equal((await reader.load(id(1))).aggregateVersion, 9);
      assert.deepEqual(await counts(), { operations: 8, audits: 8 });
      await assert.rejects(
        service().add({ ...add(38, 6), quantity: 9, requestedAt: "2026-08-02T14:05:00.000Z" }),
        (error) => error.code === "CART_IDEMPOTENCY_CONFLICT",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT next_sequence::integer AS sequence FROM platform_audit.audit_chain_head",
          )
        ).rows[0].sequence,
        9,
      );
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

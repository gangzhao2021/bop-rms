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
  createDiningCartItemService,
  createPostgresDiningCartCommandQueryStore,
  createPostgresBoundCartItemOperationStore,
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

it.each([1, 999])(
  "atomically persists Cart items, history and Audit from revision %s",
  async (initialVersion) => {
    const revision = (original) => initialVersion + original - 1;
    await withIsolatedDatabase({ caseId: `wp2270_cart_${initialVersion}` }, async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const role = `wp2270_${context.runId}`;
      assert.match(role, /^wp2270_[a-f0-9]+$/u);
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
        VALUES ($1,$2,$3,'Pickup','Qr',$4,$10,$5,$5,'Active',$6,$7,3600,86400,$8,$9)`,
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
            initialVersion,
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
        const first = await service().add(add(30, revision(1)));
        assert.equal(first.aggregate.aggregateVersion, revision(2));
        assert.equal(first.aggregate.lifecycle.idleExpiresAt, "2026-08-02T15:01:00.000Z");
        const saved = await operations.resolveOperation(id(30));
        const replay = await service().add({
          ...add(30, revision(1)),
          requestedAt: "2026-08-02T14:01:00.010Z",
        });
        assert.equal(replay.status, "AlreadyApplied");
        assert.deepEqual(replay.aggregate, first.aggregate);
        assert.deepEqual(
          await writer.commit({
            record: saved,
            expectedAggregateVersion: revision(1),
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
          expectedAggregateVersion: revision(2),
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
          expectedAggregateVersion: revision(3),
          operationReference: id(32),
          requestedAt: at,
        });
        assert.equal((await reader.load(id(1))).items.length, 0);
        assert.deepEqual((await operations.resolveOperation(id(30))).result, first.aggregate);
        const race = await Promise.allSettled([
          service().add(add(33, revision(4))),
          service().add(add(34, revision(4))),
        ]);
        assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(
          race.find((r) => r.status === "rejected").reason.code,
          "CART_VERSION_CONFLICT",
        );
        assert.equal((await reader.load(id(1))).aggregateVersion, revision(5));
        assert.deepEqual(await counts(), { operations: 4, audits: 4 });
        await assert.rejects(
          service(
            createPostgresCartItemCommandStore(runner({ failAudit: true }), scope, references),
          ).add(add(35, revision(5))),
          (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal((await reader.load(id(1))).aggregateVersion, revision(5));
        assert.equal((await reader.load(id(1))).items.length, 1);
        assert.equal(await operations.resolveOperation(id(35)), null);
        assert.deepEqual(await counts(), { operations: 4, audits: 4 });
        await assert.rejects(
          service(
            createPostgresCartItemCommandStore(runner({ loseAck: true }), scope, references),
          ).add(add(36, revision(5))),
          (error) => error.code === "CART_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal((await service().add(add(36, revision(5)))).status, "AlreadyApplied");
        assert.equal((await reader.load(id(1))).aggregateVersion, revision(6));
        assert.deepEqual(await counts(), { operations: 5, audits: 5 });
        let captured;
        await assert.rejects(
          service({
            async commit(input) {
              captured = input;
              throw new Error("synthetic capture");
            },
          }).add(add(37, revision(6))),
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
        assert.equal((await reader.load(id(1))).aggregateVersion, revision(6));
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
          (s) => s.add({ ...add(38, revision(6)), requestedAt: "2026-08-02T14:02:00.000Z" }),
          (s) => s.add({ ...add(38, revision(6)), requestedAt: "2026-08-02T14:02:00.001Z" }),
        );
        const update = {
          cartReference: id(1),
          cartItemReference: simultaneousAdd.cartItemReference,
          expectedAggregateVersion: revision(7),
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
          expectedAggregateVersion: revision(8),
          operationReference: id(40),
        };
        await converge(
          (s) => s.remove({ ...remove, requestedAt: "2026-08-02T14:04:00.000Z" }),
          (s) => s.remove({ ...remove, requestedAt: "2026-08-02T14:04:00.001Z" }),
        );
        assert.equal((await reader.load(id(1))).aggregateVersion, revision(9));
        assert.deepEqual(await counts(), { operations: 8, audits: 8 });
        await assert.rejects(
          service().add({
            ...add(38, revision(6)),
            quantity: 9,
            requestedAt: "2026-08-02T14:05:00.000Z",
          }),
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
        if (initialVersion === 1) {
          // WP-2323: real owner repositories and transactions; Identity/Dining/Catalog are
          // explicitly synthetic current-authority fixtures, not live admission evidence.
          await admin.query(
            `INSERT INTO rms_ordering.cart
            (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,
             aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,
             lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
            VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6,'Active',$7,$8,3600,86400,$9,$10)`,
            [
              id(200),
              id(2),
              id(3),
              id(201),
              id(204),
              createdAt,
              id(7),
              `sha256:${"a".repeat(64)}`,
              "2026-08-02T15:00:00.000Z",
              "2026-08-03T14:00:00.000Z",
            ],
          );
          let allowed = true;
          let ownerReads = 0;
          function dining(actor, participant, selectedWriter = writer) {
            return createDiningCartItemService({
              scope,
              now: () => at,
              sessions: {
                authorize: async (request) => {
                  assert.equal(request.sessionCredential, "a".repeat(43));
                  assert.equal(request.csrfCredential, "b".repeat(43));
                  return {
                    ...guest,
                    sessionReference: id(actor),
                    channel: "DineIn",
                    publicTableReference: id(202),
                    diningState: "DiningBound",
                    diningSessionReference: id(201),
                    diningParticipantReference: id(participant),
                  };
                },
              },
              participation: {
                resolve: async (request) => {
                  assert.deepEqual(request, {
                    purpose: "Cart",
                    diningSessionReference: id(201),
                    participantReference: id(participant),
                  });
                  return allowed
                    ? {
                        schemaVersion: 1,
                        ...scope,
                        diningSessionReference: id(201),
                        participantReference: id(participant),
                        tableReference: id(203),
                        tableAssignmentVersion: 1,
                        diningSessionVersion: 1,
                        participantVersion: 1,
                        observedAt: at,
                      }
                    : null;
                },
              },
              catalog: {
                validateSelection: async (request) => ({
                  ...request,
                  status: "Accepted",
                  menuVersionReference: id(9),
                  productVersionReference: id(10),
                  catalogChannelCode: "PILOT_CHANNEL",
                  catalogOrderTypeCode: "PILOT_ORDER_TYPE",
                  ruleEvidence: [],
                  validatedAt: request.observedAt,
                }),
              },
              references: { ...references, generate: () => id(++generated) },
              audit: (input) => ({
                auditId: id(++generated),
                brandId: id(2),
                storeId: id(3),
                actor: { type: "System" },
                actionCode: `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
                targetType: "OrderingCart",
                targetId: input.cartReference,
                reasonCode: "AUTHORIZED_CART_MUTATION",
                correlationId: input.operationReference,
                occurredAt: input.observedAt,
                sourceChannel: "CUSTOMER_PWA",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
              repository: (bound) => {
                ownerReads++;
                return {
                  load: createPostgresDiningCartCommandQueryStore(runner({ readOnly: true }), bound)
                    .load,
                  resolveOperation: createPostgresBoundCartItemOperationStore(
                    runner({ readOnly: true }),
                    bound,
                  ).resolveOperation,
                  commit: selectedWriter.commit,
                };
              },
            });
          }
          const one = dining(204, 205);
          const two = dining(206, 207);
          const common = {
            sessionCredential: "a".repeat(43),
            csrfCredential: "b".repeat(43),
            cartReference: id(200),
          };
          const addDining = (operation, version) => ({
            ...common,
            operationReference: id(operation),
            expectedAggregateVersion: version,
            sellableReference: id(11),
            quantity: 2,
            optionSelections: [],
            customerNote: "Synthetic Dining note",
          });
          const own = await one.add(addDining(220, 1));
          const other = await two.add(addDining(221, 2));
          await assert.rejects(
            one.update({
              ...common,
              operationReference: id(222),
              expectedAggregateVersion: 3,
              cartItemReference: other.cartItemReference,
              quantity: 3,
              optionSelections: [],
              customerNote: null,
            }),
            { code: "CART_PERMISSION_DENIED" },
          );
          await one.update({
            ...common,
            operationReference: id(223),
            expectedAggregateVersion: 3,
            cartItemReference: own.cartItemReference,
            quantity: 3,
            optionSelections: [],
            customerNote: null,
          });
          await one.remove({
            ...common,
            operationReference: id(224),
            expectedAggregateVersion: 4,
            cartItemReference: own.cartItemReference,
          });
          const lostWriter = createPostgresCartItemCommandStore(
            runner({ loseAck: true }),
            scope,
            references,
          );
          await assert.rejects(dining(204, 205, lostWriter).add(addDining(225, 5)), {
            code: "CART_DEPENDENCY_UNAVAILABLE",
          });
          const recovered = await one.add(addDining(225, 5));
          assert.equal(recovered.status, "AlreadyApplied");
          assert.equal(recovered.aggregateVersion, 6);
          await assert.rejects(two.add(addDining(225, 5)), { code: "CART_IDEMPOTENCY_CONFLICT" });
          allowed = false;
          const beforeDenied = ownerReads;
          await assert.rejects(one.add(addDining(225, 5)), { code: "CART_PERMISSION_DENIED" });
          assert.equal(ownerReads, beforeDenied);
          const final = await reader.load(id(200));
          assert.equal(final.aggregateVersion, 6);
          assert.deepEqual(
            final.items.map((item) => item.addedByParticipantReference).sort(),
            [id(205), id(207)].sort(),
          );
          assert.deepEqual(await counts(), { operations: 13, audits: 13 });
        }
        assert.equal(active, 0);
      } finally {
        await admin.end();
      }
    });
  },
  120_000,
);

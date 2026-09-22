import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresSubmissionFinalValidationStore,
  createPostgresInventoryItemStore,
  createInventoryItem,
  transitionInventoryItem,
  parseSubmissionInventoryFinalValidation,
} from "../../rms/inventory/src/index.ts";
import { finalValidationFixture } from "../../rms/inventory/src/tests/submission-final-validation.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
it("atomically appends final Inventory and Audit, reauthorizes recovery and retains original results", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_inv_writer" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_final_" + context.runId;
    assert.match(role, /^wp2402_final_[a-f0-9]+$/u);
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.submission_final_validation TO " + role,
      );
      await admin.query("GRANT SELECT ON rms_inventory.stock_reservation_set TO " + role);
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation TO " +
          role,
      );
      const raw = finalValidationFixture();
      const record = parseSubmissionInventoryFinalValidation({
        ...raw,
        reservationSet: null,
        items: raw.items.map((item) => ({
          ...item,
          stockTrackingEnabled: false,
          disposition: "NotTracked",
          currentItemVersion: 2,
        })),
      });
      const scope = {
        tenantReference: record.tenantReference,
        brandReference: record.brandReference,
        storeReference: record.storeReference,
      };
      const audit = {
        auditId: record.auditReference,
        brandId: record.brandReference,
        storeId: record.storeReference,
        actor: { type: "User", reference: record.actorReference },
        actionCode: "INVENTORY_SUBMISSION_FINALIZE",
        targetType: "InventoryFinalValidation",
        targetId: record.validationReference,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: record.operationReference,
        occurredAt: record.observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      };
      let allowed = true,
        sourceCalls = 0,
        authorizationCalls = 0;
      let current = record;
      function adapter(options = {}, ownerScope = scope) {
        return createPostgresSubmissionFinalValidationStore(
          {
            async run(work) {
              const client = new Client(context.clientConfig);
              await client.connect();
              let wrote = false;
              try {
                await client.query("BEGIN");
                await client.query("SET LOCAL ROLE " + role);
                await client.query("SET LOCAL lock_timeout='5s'");
                const result = await work({
                  async query(sql, values) {
                    if (
                      options.failAudit &&
                      sql.startsWith("UPDATE platform_audit.audit_chain_head")
                    )
                      throw new Error("synthetic Audit failure");
                    if (sql.startsWith("INSERT INTO rms_inventory.submission_final_validation")) {
                      wrote = true;
                      if (options.failInsert) throw new Error("synthetic record failure");
                      await options.onInsert?.();
                    }
                    return client.query(sql, [...values]);
                  },
                });
                await client.query("COMMIT");
                if (options.loseAck && wrote)
                  throw new Error("synthetic lost commit acknowledgement");
                return result;
              } catch (error) {
                await client.query("ROLLBACK");
                throw error;
              } finally {
                await client.end();
              }
            },
          },
          ownerScope,
          {
            async authorize(_tx, input) {
              authorizationCalls++;
              return allowed && input.actorReference === record.actorReference;
            },
            ...(options.authorizeSystemRelease
              ? { authorizeSystemRelease: options.authorizeSystemRelease }
              : {}),
            // Synthetic Recipe quantities/Workflow authority; actual Item versions are verified below.
            async resolveCurrent() {
              sourceCalls++;
              return {
                record: current,
                contributions: ["1000000", "2000000"].map((quantityNumerator) => ({
                  itemReference: record.items[0].itemReference,
                  configurationOperationReference:
                    record.items[0].configurationOperationReferences[0],
                  unitDimension: record.items[0].unit.dimension,
                  quantityNumerator,
                  quantityDenominator: "10",
                })),
              };
            },
          },
        );
      }
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_inventory.submission_final_validation) AS records,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='INVENTORY_SUBMISSION_FINALIZE') AS audits",
          )
        ).rows[0];
      const unavailable = { code: "INVENTORY_FINAL_VALIDATION_UNAVAILABLE" };
      const input = { record, audit };
      await assert.rejects(adapter().commit(input), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      assert.deepEqual(await counts(), { records: 0, audits: 0 });
      const item = createInventoryItem({
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        itemReference: record.items[0].itemReference,
        internalCode: "SYNTHETIC_FINAL",
        itemType: "RawMaterial",
        localizedNames: { en: "Synthetic untracked ingredient" },
        baseUnit: record.items[0].unit,
        trackingPolicy: {
          stockTrackingEnabled: false,
          lotTrackingMode: "NoLot",
          defaultShelfLifeDays: null,
          expiryWarningDays: null,
          issuePolicy: "FIFO",
          negativeStockPolicy: "Block",
        },
        occurredAt: record.observedAt,
        actorReference: record.actorReference,
      });
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        const itemStore = createPostgresInventoryItemStore(
          { run: async (work) => work({ query: (sql, values) => admin.query(sql, [...values]) }) },
          { tenantReference: scope.tenantReference, brandReference: scope.brandReference },
        );
        const brandAudit = { ...audit };
        delete brandAudit.storeId;
        const operation = record.items[0].configurationOperationReferences[0];
        await itemStore.commit({
          operationReference: "01909997-0000-7000-8000-000000000abd",
          intentHash: "sha256:" + "c".repeat(64),
          action: "Create",
          item,
          outcome: "Applied",
          audit: {
            ...brandAudit,
            auditId: "01909997-0000-7000-8000-000000000abc",
            actionCode: "INVENTORY_ITEM_CREATE",
            targetType: "InventoryItem",
            targetId: item.itemReference,
            correlationId: "01909997-0000-7000-8000-000000000abd",
          },
        });
        await itemStore.commit({
          operationReference: operation,
          intentHash: "sha256:" + "d".repeat(64),
          action: "Activate",
          outcome: "Applied",
          item: transitionInventoryItem(item, "Active", {
            expectedVersion: 1,
            hasOpenWork: false,
            hasNonZeroStock: false,
            occurredAt: record.observedAt,
            actorReference: record.actorReference,
          }),
          audit: {
            ...brandAudit,
            auditId: "01909997-0000-7000-8000-000000000abe",
            actionCode: "INVENTORY_ITEM_ACTIVATE",
            targetType: "InventoryItem",
            targetId: item.itemReference,
            correlationId: operation,
          },
        });
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      current = {
        ...record,
        items: record.items.map((item) => ({ ...item, currentItemVersion: 3 })),
      };
      await assert.rejects(adapter().commit({ record: current, audit }), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      current = { ...record, items: record.items.map((item) => ({ ...item, quantity: "0.2" })) };
      await assert.rejects(adapter().commit({ record: current, audit }), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      current = { ...record, items: [] };
      await assert.rejects(adapter().commit({ record: current, audit }), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      current = record;
      await assert.rejects(adapter({ failAudit: true }).commit(input), unavailable);
      assert.deepEqual(await counts(), { records: 0, audits: 0 });
      await assert.rejects(adapter({ failInsert: true }).commit(input), unavailable);
      assert.deepEqual(await counts(), { records: 0, audits: 0 });
      current = { ...record, workflowVersion: 2 };
      await assert.rejects(adapter().commit(input), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      assert.deepEqual(await counts(), { records: 0, audits: 0 });
      current = record;
      let itemLockObserved = false;
      await assert.rejects(
        adapter({
          loseAck: true,
          async onInsert() {
            await admin.query("BEGIN");
            try {
              await assert.rejects(
                admin.query(
                  "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE NOWAIT",
                  [scope.tenantReference, scope.brandReference, item.itemReference],
                ),
                { code: "55P03" },
              );
              itemLockObserved = true;
            } finally {
              await admin.query("ROLLBACK");
            }
          },
        }).commit(input),
        unavailable,
      );
      assert.equal(itemLockObserved, true);
      assert.deepEqual(await counts(), { records: 1, audits: 1 });
      const beforeReplay = sourceCalls;
      current = null;
      const replay = await adapter().commit(input);
      assert.equal(replay.status, "AlreadyApplied");
      assert.deepEqual(replay.record, record);
      assert.equal(sourceCalls, beforeReplay);
      assert.deepEqual(await counts(), { records: 1, audits: 1 });
      await assert.rejects(
        adapter().commit({ ...input, record: { ...record, workflowVersion: 2 } }),
        {
          code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
        },
      );
      const lookup = {
        submissionReference: record.submissionReference,
        actorReference: record.actorReference,
      };
      assert.deepEqual(await adapter().load(lookup), record);
      const systemLookup = {
        submissionReference: record.submissionReference,
        orderReference: record.orderReference,
        cancellationReference: "01909997-0000-7000-8000-00000000aa01",
        systemActorReference: "01909997-0000-7000-8000-00000000aa02",
        observedAt: record.observedAt,
      };
      await assert.rejects(adapter().loadForSystemRelease(systemLookup), {
        code: "INVENTORY_FINAL_VALIDATION_DENIED",
      });
      let systemChecks = 0,
        systemTx;
      const systemOptions = {
        authorizeSystemRelease: async (tx, value) => {
          systemChecks++;
          assert.deepEqual(value, systemLookup);
          if (systemChecks === 1) systemTx = tx;
          else assert.equal(tx, systemTx);
          return true;
        },
      };
      assert.deepEqual(await adapter(systemOptions).loadForSystemRelease(systemLookup), record);
      assert.equal(systemChecks, 2);
      await assert.rejects(
        adapter({ authorizeSystemRelease: async () => true }).loadForSystemRelease({
          ...systemLookup,
          orderReference: systemLookup.cancellationReference,
        }),
        { code: "INVENTORY_FINAL_VALIDATION_CONFLICT" },
      );
      await assert.rejects(
        adapter({ authorizeSystemRelease: async () => true }).loadForSystemRelease({
          ...systemLookup,
          observedAt: new Date(Date.parse(record.observedAt) - 1).toISOString(),
        }),
        { code: "INVENTORY_FINAL_VALIDATION_CONFLICT" },
      );
      let revoked = 0;
      await assert.rejects(
        adapter({ authorizeSystemRelease: async () => ++revoked === 1 }).loadForSystemRelease(
          systemLookup,
        ),
        { code: "INVENTORY_FINAL_VALIDATION_DENIED" },
      );
      assert.equal(revoked, 2);
      assert.equal(
        await adapter(
          { authorizeSystemRelease: async () => true },
          { ...scope, tenantReference: systemLookup.cancellationReference },
        ).loadForSystemRelease(systemLookup),
        null,
      );
      assert.deepEqual(await counts(), { records: 1, audits: 1 });
      const currentLookup = { ...lookup, observedAt: record.observedAt };
      const observed = await adapter().withCurrent(currentLookup, async (tx, facts) => {
        assert.deepEqual(facts.record, record);
        assert.equal(facts.items[0].aggregateVersion, 2);
        assert.deepEqual(facts.reservations, []);
        const context = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
        assert.equal(context.rows[0].store, scope.storeReference);
        await admin.query("BEGIN");
        try {
          await assert.rejects(
            admin.query(
              "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE NOWAIT",
              [scope.tenantReference, scope.brandReference, item.itemReference],
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("ROLLBACK");
        }
        return facts;
      });
      assert.equal(observed.record.validationReference, record.validationReference);
      const callbackAudit = "01909997-0000-7000-8000-000000009001";
      await assert.rejects(
        adapter().withCurrent(currentLookup, async (tx) => {
          await appendAuditRecordInTransaction(tx, { ...audit, auditId: callbackAudit });
          allowed = false;
        }),
        { code: "INVENTORY_FINAL_VALIDATION_DENIED" },
      );
      allowed = true;
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE audit_id=$1",
            [callbackAudit],
          )
        ).rows[0].n,
        0,
      );
      let callbackCalled = false;
      await assert.rejects(
        adapter().withCurrent(
          {
            ...currentLookup,
            observedAt: new Date(Date.parse(record.observedAt) - 1).toISOString(),
          },
          async () => {
            callbackCalled = true;
          },
        ),
      );
      assert.equal(callbackCalled, false);

      allowed = false;
      await assert.rejects(adapter().commit(input), { code: "INVENTORY_FINAL_VALIDATION_DENIED" });
      await assert.rejects(adapter().load(lookup), { code: "INVENTORY_FINAL_VALIDATION_DENIED" });
      await assert.rejects(
        adapter().withCurrent(currentLookup, async () => {
          callbackCalled = true;
        }),
        { code: "INVENTORY_FINAL_VALIDATION_DENIED" },
      );
      assert.equal(callbackCalled, false);
      allowed = true;
      const foreign = "01909997-0000-7000-8000-000000000fff";
      assert.equal(await adapter({}, { ...scope, tenantReference: foreign }).load(lookup), null);
      assert.equal(
        await adapter({}, { ...scope, tenantReference: foreign }).withCurrent(
          currentLookup,
          async () => {
            callbackCalled = true;
          },
        ),
        null,
      );
      assert.equal(callbackCalled, false);
      await assert.rejects(adapter({}, { ...scope, tenantReference: foreign }).commit(input), {
        code: "INVENTORY_FINAL_VALIDATION_CONFLICT",
      });
      assert.ok(authorizationCalls >= 8);
      assert.deepEqual(await counts(), { records: 1, audits: 1 });
    } finally {
      await admin.query("RESET ROLE");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});

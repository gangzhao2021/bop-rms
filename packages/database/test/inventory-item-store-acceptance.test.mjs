import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
} from "../../bop/audit/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresInventoryItemStore,
  createPostgresSubmissionReservationStore,
  createPostgresSubmissionStockPlanSource,
  createPostgresRecipeStockPlanSource,
  createInventoryReservation,
  createInventoryRecipeItemSource,
  createInventoryRecipeDemandSource,
  createPostgresStockCandidateSource,
  planStockAllocation,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
const { Client } = pg;
const id = (n) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2) };
it("composes Inventory commands with original recovery, current version fencing and atomic Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_inv_store" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_inv_" + context.runId;
    assert.match(role, /^wp2402_inv_[a-f0-9]+$/u);
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      function runner({ failAudit = false, loseAck = false } = {}) {
        return {
          async run(work) {
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
              let wrote = false;
              const result = await work({
                async query(sql, values) {
                  if (sql.startsWith("INSERT INTO rms_inventory.inventory_item_version"))
                    wrote = true;
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              committed = true;
              if (loseAck && wrote) throw new Error("synthetic response loss");
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
      let sequence = 100;
      const now = new Date(Date.now() - 1000).toISOString();
      const create = {
        ...scope,
        actorReference: id(3),
        purpose: "InventoryItemManagement",
        operationReference: id(10),
        occurredAt: now,
        action: "Create",
        payload: {
          internalCode: "SYNTHETIC_ITEM",
          itemType: "RawMaterial",
          localizedNames: { en: "Synthetic item" },
          baseUnit: {
            unitCode: "KG",
            dimension: "Mass",
            displayPrecision: 2,
            ledgerPrecision: 4,
            roundingMode: "HalfEven",
          },
          trackingPolicy: {
            stockTrackingEnabled: true,
            lotTrackingMode: "NoLot",
            defaultShelfLifeDays: null,
            expiryWarningDays: null,
            issuePolicy: "FIFO",
            negativeStockPolicy: "Block",
          },
        },
      };
      function ports(options = {}, otherScope = scope) {
        return {
          authorization: {
            async authorize() {
              return { authorized: true };
            },
          },
          references: {
            generate: () => id(sequence++),
            hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
          },
          audit: {
            async create({ command, after }) {
              return {
                auditId: id(sequence++),
                brandId: command.brandReference,
                actor: { type: "User", reference: command.actorReference },
                actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
                targetType: "InventoryItem",
                targetId: after.itemReference,
                reasonCode: "AUTHORIZED_CHANGE",
                correlationId: command.operationReference,
                occurredAt: command.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "SYNTHETIC_AUDIT",
                retentionPolicyVersion: 1,
              };
            },
          },
          repository: createPostgresInventoryItemStore(runner(options), otherScope),
        };
      }
      await assert.rejects(executeInventoryItemCommand(create, ports({ loseAck: true })), {
        code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      });
      const recovered = await executeInventoryItemCommand(create, ports());
      assert.equal(recovered.outcome, "AlreadyApplied");
      assert.equal(recovered.item.aggregateVersion, 1);
      const repository = ports().repository;
      assert.deepEqual(await repository.load(recovered.item.itemReference), recovered.item);
      const activate = {
        ...create,
        operationReference: id(11),
        action: "Activate",
        payload: {
          itemReference: recovered.item.itemReference,
          expectedVersion: 1,
          reasonCode: "READY",
        },
      };
      const competing = { ...activate, operationReference: id(12) };
      const result = await Promise.allSettled([
        executeInventoryItemCommand(activate, ports()),
        executeInventoryItemCommand(competing, ports()),
      ]);
      assert.equal(result.filter((entry) => entry.status === "fulfilled").length, 1);
      const rejected = result.find((entry) => entry.status === "rejected");
      assert.equal(rejected.reason.code, "INVENTORY_ITEM_CONFLICT");
      assert.equal((await repository.load(recovered.item.itemReference)).aggregateVersion, 2);
      assert.equal(
        (await repository.resolveOperation(create.operationReference)).item.aggregateVersion,
        1,
      );
      await assert.rejects(
        executeInventoryItemCommand(
          { ...create, payload: { ...create.payload, internalCode: "CHANGED" } },
          ports(),
        ),
        { code: "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT" },
      );
      for (const foreign of [
        { ...scope, tenantReference: id(90) },
        { ...scope, brandReference: id(91) },
      ]) {
        const foreignRepo = ports({}, foreign).repository;
        assert.equal(await foreignRepo.load(recovered.item.itemReference), null);
        assert.equal(await foreignRepo.resolveOperation(create.operationReference), null);
      }
      const activeOperation =
        (await repository.resolveOperation(id(11))) === null ? id(12) : id(11);
      const itemSource = createInventoryRecipeItemSource(repository, scope);
      const sourceInput = {
        itemReference: recovered.item.itemReference,
        configurationOperationReference: activeOperation,
        observedAt: now,
      };
      const itemEvidence = await itemSource.resolve(sourceInput);
      assert.equal(itemEvidence.sourceVersionReference, activeOperation);
      assert.equal(itemEvidence.sourceVersionKind, "InventoryItemConfigurationOperation");
      assert.equal(itemEvidence.sourceItemVersion, 2);
      assert.equal(itemEvidence.currentItemVersion, 2);
      assert.equal(itemEvidence.baseUnit.unitCode, "KG");
      assert.equal(itemEvidence.baseUnit.ledgerPrecision, 4);
      assert.equal(
        itemEvidence.sourceAuditReference,
        (await repository.resolveOperation(activeOperation)).audit.auditId,
      );
      const demandSource = createInventoryRecipeDemandSource(repository, scope);
      const contribution = {
        itemReference: sourceInput.itemReference,
        configurationOperationReference: activeOperation,
        unitDimension: "Mass",
        quantityNumerator: "100",
        quantityDenominator: "3",
      };
      const demand = await demandSource.resolve([contribution, contribution, contribution], now);
      assert.equal(demand.length, 1);
      assert.equal(demand[0].quantity, "0.0001");
      assert.equal(demand[0].roundingApplied, false);
      assert.deepEqual(demand[0].contributionIndices, [0, 1, 2]);
      assert.equal(demand[0].sources[0].sourceVersionReference, activeOperation);
      assert.equal(demand[0].currentItemVersion, 2);
      await assert.rejects(
        demandSource.resolve([{ ...contribution, unitDimension: "Volume" }], now),
      );
      await assert.rejects(itemSource.resolve({ ...sourceInput, itemReference: id(999) }));
      await assert.rejects(
        itemSource.resolve({ ...sourceInput, configurationOperationReference: id(999) }),
      );
      await assert.rejects(
        itemSource.resolve({ ...sourceInput, configurationOperationReference: id(10) }),
      );
      await assert.rejects(
        createInventoryRecipeItemSource(repository, { ...scope, tenantReference: id(90) }).resolve(
          sourceInput,
        ),
      );
      await assert.rejects(
        createInventoryRecipeItemSource(
          ports({}, { ...scope, brandReference: id(91) }).repository,
          scope,
        ).resolve(sourceInput),
      );
      const before = await admin.query(
        "SELECT count(*)::int AS n FROM platform_audit.audit_record",
      );
      const deactivate = {
        ...activate,
        operationReference: id(13),
        action: "Deactivate",
        payload: { ...activate.payload, expectedVersion: 2 },
      };
      await assert.rejects(executeInventoryItemCommand(deactivate, ports({ failAudit: true })), {
        code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal((await repository.load(recovered.item.itemReference)).aggregateVersion, 2);
      assert.equal(await repository.resolveOperation(id(13)), null);
      assert.deepEqual(
        (await admin.query("SELECT count(*)::int AS n FROM platform_audit.audit_record")).rows,
        before.rows,
      );
      assert.equal(
        (await executeInventoryItemCommand(deactivate, ports())).item.aggregateVersion,
        3,
      );

      await assert.rejects(itemSource.resolve(sourceInput));
      await assert.rejects(demandSource.resolve([contribution], now));

      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_inventory.stock_account,rms_inventory.stock_balance,rms_inventory.stock_movement TO " +
          role,
      );
      await ensureSyntheticStockPlace(admin, {
        tenantId: id(1),
        brandId: id(2),
        storeId: id(300),
        stockSiteId: id(301),
        locationId: id(302),
        at: now,
      });
      await admin.query(
        "INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,3,'KG',4,$8)",
        [id(1), id(2), id(300), id(301), id(302), id(303), recovered.item.itemReference, now],
      );
      await admin.query(
        "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
        [id(1), id(2), id(300), id(303)],
      );
      const movement = {
        movementReference: id(400),
        tenantReference: id(1),
        brandReference: id(2),
        itemReference: recovered.item.itemReference,
        movementType: "Receive",
        quantityDelta: "1",
        unitCode: "KG",
        baseQuantityDelta: "1",
        baseUnitCode: "KG",
        conversionMultiplier: "1",
        sourceScope: null,
        destinationScope: { scopeType: "Location", scopeReference: id(302) },
        lotReference: null,
        expiryDate: null,
        businessSourceType: "SYNTHETIC_RECEIPT",
        businessSourceReference: id(401),
        reasonCode: "SYNTHETIC_TEST",
        performedBy: id(3),
        occurredAt: now,
        before: {
          onHand: "0",
          reserved: "0",
          available: "0",
          inTransit: "0",
          unitCode: "KG",
          ledgerVersion: 1,
        },
        after: {
          onHand: "1",
          reserved: "0",
          available: "1",
          inTransit: "0",
          unitCode: "KG",
          ledgerVersion: 2,
        },
        auditReference: id(402),
        correctsMovementReference: null,
      };
      async function receive(tx) {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [id(1), id(2), id(300)],
        );
        await tx.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,2,'Receive',1,$6,$7,$8)",
          [id(1), id(2), id(300), id(303), id(400), movement, id(402), now],
        );
        await appendAuditRecordInTransaction(tx, {
          auditId: id(402),
          brandId: id(2),
          storeId: id(300),
          actor: { type: "User", reference: id(3) },
          actionCode: "INVENTORY_RECEIVE",
          targetType: "StockMovement",
          targetId: id(400),
          reasonCode: "SYNTHETIC_TEST",
          correlationId: id(403),
          occurredAt: now,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        });
      }
      await assert.rejects(runner({ failAudit: true }).run(receive));
      assert.equal((await repository.load(recovered.item.itemReference)).aggregateVersion, 3);
      assert.equal((await repository.load(recovered.item.itemReference)).hasMovementHistory, false);
      await runner().run(receive);
      const stocked = await repository.load(recovered.item.itemReference);
      assert.equal(stocked.aggregateVersion, 4);
      assert.equal(stocked.hasMovementHistory, true);
      assert.equal(
        (await repository.resolveOperation(create.operationReference)).item.hasMovementHistory,
        false,
      );
      const update = {
        ...create,
        operationReference: id(404),
        action: "Update",
        payload: {
          itemReference: stocked.itemReference,
          expectedVersion: 4,
          localizedNames: stocked.localizedNames,
          baseUnit: { ...stocked.baseUnit, unitCode: "G" },
          trackingPolicy: stocked.trackingPolicy,
          migrationPlanReference: null,
        },
      };
      await assert.rejects(executeInventoryItemCommand(update, ports()), {
        code: "INVENTORY_ITEM_BASE_UNIT_LOCKED",
      });
      await assert.rejects(
        executeInventoryItemCommand(
          {
            ...update,
            payload: {
              ...update.payload,
              baseUnit: stocked.baseUnit,
              trackingPolicy: {
                ...stocked.trackingPolicy,
                negativeStockPolicy: "AllowWithWarning",
              },
            },
          },
          ports(),
        ),
        { code: "INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED" },
      );
      await assert.rejects(
        admin.query("INSERT INTO rms_inventory.inventory_item_version VALUES ($1,$2,$3,5,$4,$5)", [
          id(1),
          id(2),
          stocked.itemReference,
          { ...stocked, aggregateVersion: 5, hasMovementHistory: false },
          now,
        ]),
        { code: "23514" },
      );
      await admin.query("GRANT SELECT ON rms_inventory.stock_lot_hold_version TO " + role);
      await executeInventoryItemCommand(
        {
          ...activate,
          operationReference: id(450),
          payload: { ...activate.payload, expectedVersion: 4 },
        },
        ports(),
      );
      const candidates = createPostgresStockCandidateSource(runner(), {
        ...scope,
        storeReference: id(300),
      });
      const candidateInput = {
        itemReference: stocked.itemReference,
        stockSiteReference: id(301),
        observedAt: now,
      };
      const stockCandidates = await candidates.list(candidateInput);
      assert.equal(stockCandidates.length, 1);
      assert.equal(stockCandidates[0].accountReference, id(303));
      assert.equal(stockCandidates[0].firstReceivedAt, now);
      assert.equal(stockCandidates[0].lastMovementAt, now);
      assert.equal(stockCandidates[0].available, "1");
      assert.equal(stockCandidates[0].ledgerVersion, 2);
      assert.equal(stockCandidates[0].holdStatus, "Available");
      assert.equal(stockCandidates[0].currentItemVersion, 5);
      const actualPlan = planStockAllocation({
        ...scope,
        storeReference: id(300),
        stockSiteReference: id(301),
        itemReference: stocked.itemReference,
        currentItemVersion: 5,
        unit: stockCandidates[0].unit,
        quantity: "0.75",
        issuePolicy: stockCandidates[0].trackingPolicy.issuePolicy,
        observedAt: now,
        candidates: stockCandidates.map((c) => ({
          tenantReference: c.tenantReference,
          brandReference: c.brandReference,
          storeReference: c.storeReference,
          stockSiteReference: c.stockSiteReference,
          itemReference: c.itemReference,
          currentItemVersion: c.currentItemVersion,
          accountReference: c.accountReference,
          locationReference: c.locationReference,
          ledgerVersion: c.ledgerVersion,
          unitCode: c.unit.unitCode,
          ledgerPrecision: c.unit.ledgerPrecision,
          available: c.available,
          holdStatus: c.holdStatus,
          firstReceivedAt: c.firstReceivedAt,
          observedAt: c.observedAt,
          expiryDate: c.expiryDate,
          expiryCutoff: null,
        })),
      });
      assert.equal(actualPlan.status, "Ready");
      assert.deepEqual(actualPlan.allocations, [
        {
          accountReference: id(303),
          locationReference: id(302),
          expectedLedgerVersion: 2,
          quantity: "0.75",
        },
      ]);

      assert.deepEqual(
        await candidates.list({ ...candidateInput, stockSiteReference: id(999) }),
        [],
      );
      assert.deepEqual(
        await createPostgresStockCandidateSource(runner(), {
          ...scope,
          storeReference: id(999),
        }).list(candidateInput),
        [],
      );
      await assert.rejects(
        createPostgresStockCandidateSource(runner(), {
          ...scope,
          tenantReference: id(999),
          storeReference: id(300),
        }).list(candidateInput),
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.stock_reservation_version,rms_inventory.stock_reservation_set TO " +
          role,
      );
      const submissionScope = { ...scope, storeReference: id(300) };
      let currentDemand = {
        ...submissionScope,
        stockSiteReference: id(301),
        submissionReference: id(600),
        cartReference: id(601),
        cartVersion: 1,
        quoteReference: id(602),
        demandReference: id(603),
        workflowReference: id(604),
        workflowVersion: 1,
        reserveTrigger: "OrderSubmission",
        sourceDigest: "sha256:" + "d".repeat(64),
        contributions: [{ ...contribution, quantityNumerator: "750000", quantityDenominator: "1" }],
      };
      const untracked = await executeInventoryItemCommand(
        {
          ...create,
          operationReference: id(700),
          payload: {
            ...create.payload,
            internalCode: "SYNTHETIC_UNTRACKED",
            trackingPolicy: { ...create.payload.trackingPolicy, stockTrackingEnabled: false },
          },
        },
        ports(),
      );
      await executeInventoryItemCommand(
        {
          ...activate,
          operationReference: id(701),
          payload: { ...activate.payload, itemReference: untracked.item.itemReference },
        },
        ports(),
      );
      const untrackedContribution = {
        itemReference: untracked.item.itemReference,
        configurationOperationReference: id(701),
        unitDimension: "Mass",
        quantityNumerator: "250000",
        quantityDenominator: "1",
      };
      currentDemand = {
        ...currentDemand,
        contributions: [...currentDemand.contributions, untrackedContribution],
      };
      const planSource = createPostgresSubmissionStockPlanSource(runner(), submissionScope, {
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot needs no expiry interpretation");
        },
      });
      const observedPlan = await planSource.resolve(currentDemand, now);
      const observationSource = createPostgresRecipeStockPlanSource(runner(), submissionScope, {
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot needs no expiry interpretation");
        },
      });
      const observationInput = {
        ...submissionScope,
        stockSiteReference: currentDemand.stockSiteReference,
        contributions: currentDemand.contributions,
      };
      const observation = await observationSource.resolve(observationInput, now);
      assert.deepEqual(observation.requirements, observedPlan.requirements);
      assert.deepEqual(observation.allocations, observedPlan.allocations);
      assert.equal(Object.hasOwn(observation.demand, "submissionReference"), false);
      await assert.rejects(
        observationSource.resolve(
          {
            ...observationInput,
            storeReference: id(999),
          },
          now,
        ),
        { code: "STOCK_RESERVATION_CONFLICT" },
      );
      await assert.rejects(
        observationSource.resolve(
          {
            ...observationInput,
            contributions: [
              { ...currentDemand.contributions[0], quantityNumerator: "999999999999999999999999" },
            ],
          },
          now,
        ),
        { code: "STOCK_RESERVATION_INSUFFICIENT" },
      );
      assert.equal(observedPlan.requirements.length, 2);
      assert.equal(observedPlan.allocations.length, 1);
      assert.deepEqual(observedPlan.allocations[0], {
        ...actualPlan.allocations[0],
        itemReference: stocked.itemReference,
        unit: stocked.baseUnit,
        stockSiteReference: id(301),
        lotReference: null,
      });
      const untrackedPlan = await planSource.resolve(
        {
          ...currentDemand,
          contributions: [untrackedContribution],
        },
        now,
      );
      assert.equal(untrackedPlan.requirements[0].quantity, "0.25");
      assert.deepEqual(untrackedPlan.allocations, []);
      await assert.rejects(planSource.resolve({ ...currentDemand, storeReference: id(999) }, now), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      const reservationAudit = {
        auditId: id(610),
        brandId: id(2),
        storeId: id(300),
        actor: { type: "User", reference: id(3) },
        actionCode: "INVENTORY_RESERVATION_RESERVE",
        targetType: "InventoryReservation",
        targetId: id(611),
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(612),
        occurredAt: now,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      };
      function submissionWrite(quantity = observedPlan.allocations[0].quantity) {
        const allocation = observedPlan.allocations[0];
        const reservation = createInventoryReservation({
          reservationReference: id(611),
          unit: allocation.unit,
          quantity,
          occurredAt: now,
          binding: {
            ...submissionScope,
            stockSiteReference: allocation.stockSiteReference,
            locationReference: allocation.locationReference,
            itemReference: allocation.itemReference,
            lotReference: allocation.lotReference,
            submissionReference: id(600),
            cartReference: id(601),
            cartVersion: 1,
            quoteReference: id(602),
            demandReference: id(603),
            demandDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(currentDemand)),
          },
        });
        return {
          setReference: id(613),
          operationReference: id(614),
          workflowReference: id(604),
          workflowVersion: 1,
          writes: [
            {
              operationReference: id(612),
              accountReference: allocation.accountReference,
              action: "Reserve",
              expectedLedgerVersion: allocation.expectedLedgerVersion,
              quantity,
              reservation,
              movementReference: id(615),
              audit: reservationAudit,
            },
          ],
          audit: {
            ...reservationAudit,
            auditId: id(616),
            actionCode: "INVENTORY_RESERVATION_SET",
            targetType: "InventoryReservationSet",
            targetId: id(613),
            correlationId: id(614),
          },
        };
      }
      let authorized = true;
      let resolvedDemands = 0;
      const submissionStore = createPostgresSubmissionReservationStore(runner(), submissionScope, {
        authorize: async () => authorized,
        resolveDemand: async () => {
          resolvedDemands++;
          await admin.query("BEGIN");
          try {
            await assert.rejects(
              admin.query(
                "SELECT item_id FROM rms_inventory.inventory_item WHERE item_id=$1 FOR UPDATE NOWAIT",
                [stocked.itemReference],
              ),
              { code: "55P03" },
            );
          } finally {
            await admin.query("ROLLBACK");
          }
          return currentDemand;
        },
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot does not need expiry interpretation");
        },
      });
      await assert.rejects(submissionStore.commit(submissionWrite("0.5")), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_inventory.stock_reservation_version",
          )
        ).rows[0].n,
        0,
      );
      const validDemand = currentDemand;
      currentDemand = { ...validDemand, reserveTrigger: "KitchenStart" };
      await assert.rejects(submissionStore.commit(submissionWrite()), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      currentDemand = {
        ...validDemand,
        contributions: [
          { ...contribution, quantityNumerator: "1500000", quantityDenominator: "1" },
        ],
      };
      await assert.rejects(submissionStore.commit(submissionWrite()), {
        code: "STOCK_RESERVATION_INSUFFICIENT",
      });
      currentDemand = validDemand;
      const submittedWrite = submissionWrite();
      const submitted = await submissionStore.commit(submittedWrite);
      assert.equal(submitted.status, "Applied");
      assert.equal(submitted.set.entries[0].reservation.originalQuantity, "0.75");
      assert.equal((await candidates.list(candidateInput))[0].available, "0.25");
      const resolutionsAfterCommit = resolvedDemands;
      currentDemand = { ...validDemand, reserveTrigger: "KitchenStart" };
      assert.equal((await submissionStore.commit(submittedWrite)).status, "AlreadyApplied");
      assert.equal(resolvedDemands, resolutionsAfterCommit);
      authorized = false;
      await assert.rejects(submissionStore.commit(submittedWrite), {
        code: "STOCK_RESERVATION_CONFLICT",
      });
      assert.equal(resolvedDemands, resolutionsAfterCommit);
      const denied = ports();
      denied.authorization.authorize = async () => null;
      await assert.rejects(executeInventoryItemCommand(create, denied), {
        code: "INVENTORY_ITEM_PERMISSION_DENIED",
      });
    } finally {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});

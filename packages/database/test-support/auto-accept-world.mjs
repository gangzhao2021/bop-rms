import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { vi } from "vitest";
import {
  createAsapCapacityService,
  createPostgresAsapCapacityStore,
  createPostgresCurrentPickupCapacityStore,
  parseAsapCapacityCommitment,
  sealAsapCapacityCommitment,
} from "../../rms/fulfillment/src/index.ts";
import {
  createPostgresDiningCheckoutCommitmentStore,
  sealDiningCheckoutCommitment,
} from "../../rms/dining/src/index.ts";
import {
  createOrderNumberAllocation,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createPostgresCapturedBatchPaymentSource } from "../../rms/payment/src/index.ts";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { appendEventInTransaction } from "../../bop/eventing/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalPaidOutcome } from "../../../tooling/environment/pilot-paid-outcome.mjs";
import { createInternalMerchantAcceptance } from "../../../tooling/environment/pilot-merchant-acceptance.mjs";
import { withIsolatedDatabase } from "./isolated-database.mjs";
import { seedAcceptanceOrderHistory } from "./acceptance-order-history.mjs";
import { seedAdditionalDiningGuest } from "./additional-dining-guest.mjs";
import { seedSubmissionCart } from "./dining-order-submission-seed.mjs";
import { seedSubmissionInventoryStock } from "./submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "./submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "./submission-inventory-workflow.mjs";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { snapshotBegin, snapshotQuery } from "./snapshot-read-runner.mjs";
import {
  journeyRound,
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyPayment,
  seedJourneyQuote,
} from "./dine-in-journey-seed.mjs";

const { Client } = pg;
const minutes = (n) => n * 60_000;
export const hashText = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: one Store under the rendered pilot ACL, real Orders paid online
 * and the worker's paid outcome as the pilot composes it. Seeds and fixtures run as the owner;
 * everything under test as the restricted NOBYPASSRLS role. One order type per database, because
 * the fixture's workflow is published for one.
 */
export async function withAutoAcceptWorld({ caseId, orderType }, work) {
  await withIsolatedDatabase({ caseId }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_aa_" + context.runId,
      workerRole = "wp2423_aa_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const name of [api, workerRole])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker: workerRole }));
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      let references = 0xa000;
      const fresh = () =>
        Date.now()
          .toString(16)
          .padStart(12, "0")
          .replace(/^(.{8})(.{4})$/u, "$1-$2") +
        "-7000-8000-" +
        (references++).toString(16).padStart(12, "0");
      const clock = { offset: 0 };
      const now = () => new Date(Date.now() + clock.offset).toISOString();
      const transactions = (role = api) => ({
        async run(unit, snapshot = false) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query(snapshot ? snapshotBegin : "BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query("SET LOCAL statement_timeout='30s'");
            const send = (sql, values) => client.query(sql, values === undefined ? [] : values);
            const result = await unit({ query: snapshot ? snapshotQuery(send) : send });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
        runSnapshot(unit) {
          return this.run(unit, true);
        },
      });
      /** The worker's transaction: the Store's context set, as the pilot's resources set it. */
      const worker = () => ({
        run: (unit) =>
          transactions().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenant, scope.brandReference, scope.storeReference],
            );
            return unit(tx);
          }),
      });
      const ownerRunner = () => ({
        async run(unit) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            const result = await unit({ query: (sql, values) => client.query(sql, values) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      });
      const template = journeyRound({
        at: time(-minutes(90)),
        prefix: "01a00001",
        dineIn: orderType === "DineIn",
      });
      const scope = template.f.scope;
      const tenant = scope.brandReference.slice(0, 24) + "000000000900";
      const ownerScope = { tenantReference: tenant, ...scope };
      const guestSession = template.f.request.record.guestSessionReference;
      const provider = "01a6ff00-0000-7000-8000-000000000001";
      const paymentScope = { ...scope, providerAccountReference: provider, environment: "Test" };
      const stock = await seedSubmissionInventoryStock({
        admin,
        runner: ownerRunner,
        ownerScope,
        actorReference: guestSession,
        at: time(-minutes(100)),
      });
      await seedSubmissionInventoryRecipe({
        admin,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(100)),
        cart: template.f.cart,
        stock,
      });
      const inventoryWorkflow = await seedSubmissionInventoryWorkflow({
        runner: ownerRunner,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(100)),
        orderType,
      });
      const inventoryOptions = {
        scope: ownerScope,
        stockSiteReference: stock.stockSiteReference,
        workflow: {
          ...inventoryWorkflow,
          gates: {
            ...inventoryWorkflow.gates,
            authorizeResource: async () => true,
          },
        },
        authorize: async () => true,
        resolveExpiryCutoff: stock.resolveExpiryCutoff,
        generateReference: fresh,
        audit: {
          reasonCode: "SYNTHETIC_SUBMISSION",
          sourceChannel: "CUSTOMER_PWA",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        },
      };
      // ── The worker's paid outcome as the pilot composes it (its own workflows and gates).
      const pilotWorkflow = {
        environment: "InternalTest",
        database: "isolated",
        scope: ownerScope,
        workflow: {
          purposeCode: inventoryWorkflow.payment.purposeCode,
          payment: {
            workflowVersionReference: inventoryWorkflow.payment.workflowVersionReference,
            intactReservationRuleReference:
              inventoryWorkflow.payment.intactReservationRuleReference,
          },
        },
      };
      /** What the Store's operating read says; `read` replaces it (a lock, a failure). */
      const operating = {
        current: { state: "Open", availableServiceModes: ["Pickup", "DineIn"] },
        read: null,
      };
      const resources = {
        scope,
        publicProfile: {
          binding: {
            tenantReference: tenant,
            validUntil: new Date(base + minutes(24 * 60)).toISOString(),
            publicStoreReference: fresh(),
          },
        },
        credentials: { reference: fresh },
        now,
        operatingReader: (tx) => ({
          readCurrent: async () =>
            operating.read === null ? operating.current : operating.read(tx),
        }),
      };
      const systemActor = fresh();
      const paid = await createInternalPaidOutcome(
        resources,
        { persistentWaiting: true },
        {
          loadPickupWorkflow: async () => pilotWorkflow,
          loadDiningWorkflow: async () => pilotWorkflow,
          loadAdditionalWorkflow: async () => pilotWorkflow,
          providerAccountReference: provider,
          actorReference: systemActor,
          quoteVersion: 1,
        },
      );
      const session = async (permissions, prefix) => {
        const actor = fresh();
        return {
          actor,
          ...(await seedMerchantAcceptanceSession({
            admin,
            runner: transactions(),
            scope: ownerScope,
            actor,
            at: now(),
            extraPermissions: permissions,
            ...(prefix === undefined
              ? {}
              : {
                  referencePrefix: prefix,
                  sessionReferencePrefix: "01a9" + prefix.slice(4),
                }),
          })),
        };
      };
      const acceptanceFor = async (staff) =>
        createInternalMerchantAcceptance(
          { scope: ownerScope, credentials: { reference: fresh }, now },
          { ...staff.persistence, now },
          staff.authentication,
          {
            loadPickupWorkflow: async () => pilotWorkflow,
            loadDiningWorkflow: async () => pilotWorkflow,
            expectedDatabaseName: "isolated",
            providerAccountReference: provider,
            quoteVersion: 1,
          },
        );
      const capturedEvent = async (orderReference, orderBatchReference) => {
        const event = (
          await transactions().run((tx) =>
            createPostgresCapturedBatchPaymentSource({
              scope: paymentScope,
              authorize: async () => true,
            }).load(tx, { orderReference, orderBatchReference, observedAt: now() }),
          )
        ).paymentEvent;
        // The event the Payment owner published: the wait workload resumes from the outbox.
        await ownerRunner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await appendEventInTransaction(tx, event);
        });
        return event;
      };
      const payRefs = (n, allocation) => {
        const ref = (m) =>
          "01a7" +
          n.toString(16).padStart(4, "0") +
          "-0000-7000-8000-" +
          m.toString(16).padStart(12, "0");
        return {
          paymentIntent: ref(1),
          attempt: ref(2),
          observation: ref(3),
          webhook: ref(4),
          transaction: ref(5),
          paymentEvent: ref(6),
          projection: ref(7),
          preparation: ref(8),
          commitment: allocation,
          paymentOperation: ref(10),
          providerIntent: "pi_SYNTHETIC" + n,
          providerEvent: "evt_SYNTHETIC" + n,
        };
      };
      const seedOrderHistory = async (round, n) => {
        const r = round.f.request.record,
          items = round.items();
        await seedAcceptanceOrderHistory(admin, {
          ...r,
          items,
          orderNumberAllocation: createOrderNumberAllocation({
            orderReference: r.order.orderReference,
            allocatedAt: r.createdAt,
            sequence: BigInt(n),
            businessDateResolution: round.f.request.businessDateResolution,
          }),
        });
        await seedJourneyQuote({
          runner: ownerRunner,
          scope: ownerScope,
          snapshot: { items, batch: round.batch },
          prefix: "01a8" + n.toString(16).padStart(4, "0"),
        });
        return items;
      };
      const finalizeInventory = (round, items) => {
        const r = round.f.request.record;
        return ownerRunner().run((tx) =>
          createCustomerSubmissionInventoryFinalizer(inventoryOptions).finalize({
            transaction: tx,
            cart: round.f.cart,
            checkoutValidationEvidence: round.f.request.checkoutValidationEvidence,
            observedAt: round.batch.submittedAt,
            record: {
              submissionReference: r.submissionReference,
              guestSessionReference: r.guestSessionReference,
              items,
              order: {
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                orderReference: r.order.orderReference,
                submittedByActorReference: round.batch.submittedByActorReference,
              },
            },
          }),
        );
      };
      // ── Pickup capacity: one slot covering the whole test, as the pickup schedule makes it.
      let capacitySeeded = false;
      const pickupCapacity = async () => {
        if (capacitySeeded) return;
        capacitySeeded = true;
        const slot = fresh();
        await admin.query(
          `INSERT INTO rms_fulfillment.capacity_slot
            (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date)
            VALUES ($1,$2,$3,'Pickup',$4,$5,'America/Toronto',$6)`,
          [
            scope.brandReference,
            scope.storeReference,
            slot,
            time(-minutes(180)),
            time(minutes(180)),
            new Date(base).toISOString().slice(0, 10),
          ],
        );
        await admin.query(
          `INSERT INTO rms_fulfillment.capacity_slot_configuration
            (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,500,$4)`,
          [scope.brandReference, scope.storeReference, slot, time(-minutes(200))],
        );
      };
      const sequenceNumbers = { next: 100 };
      /** A pickup paid `paidMinutesAgo` ago, online, its capacity held and its stock reserved. */
      const seedPaidPickup = async ({ paidMinutesAgo = 1 } = {}) => {
        await pickupCapacity();
        const n = sequenceNumbers.next++;
        const hex = n.toString(16).padStart(4, "0");
        const paidAgo = minutes(paidMinutesAgo);
        const round = journeyRound({
          at: new Date(Date.now() - paidAgo - minutes(1)).toISOString(),
          prefix: "01a2" + hex,
          party: { prefix: "01a3" + hex },
          dineIn: false,
        });
        const items = await seedOrderHistory(round, n);
        const r = round.f.request.record;
        const evidence = round.f.request.checkoutValidationEvidence;
        const allocation = evidence.fulfillment.evidenceReference;
        const pay = payRefs(n, allocation);
        const requestedAt = new Date(Date.now() - paidAgo - 30_000).toISOString();
        const occurredAt = new Date(Date.now() - paidAgo).toISOString();
        // Capacity is written as of now, as checkout writes it; an older payment moves it back below.
        const capacityAt = new Date(Date.now() - 500).toISOString();
        const reader = createPostgresCurrentPickupCapacityStore(ownerRunner(), scope);
        const repository = createPostgresAsapCapacityStore(ownerRunner(), scope, {
          now: () => capacityAt,
        });
        const slotNow = (await reader.resolve(capacityAt)).slot;
        const prepared = parseAsapCapacityCommitment({
          slot: slotNow,
          allocationReference: allocation,
          guestSessionReference: r.guestSessionReference,
          cartReference: round.batch.sourceCartReference,
          quoteReference: round.batch.quoteReference,
          submissionReference: round.batch.submissionReference,
          orderReference: r.order.orderReference,
          orderBatchReference: round.batch.orderBatchReference,
          fulfillmentReference: fresh(),
          paymentOperationReference: pay.paymentOperation,
          cartVersion: round.batch.sourceCartVersion,
          units: 1,
          unitsRuleVersion: 1,
          unitsInputDigest: hashText("units" + n),
          intentDigest: hashText("intent" + n),
          state: "Prepared",
          version: 1,
          preparedAt: capacityAt,
          preparationValidUntil: new Date(Date.parse(capacityAt) + minutes(10)).toISOString(),
          orderingLinkedAt: null,
          paymentRequestedAt: null,
          capacityExpiresAt: null,
          terminalAt: null,
        });
        const capacityAudit = (record) => ({
          auditId: fresh(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase(),
          targetType: "FulfillmentAsapCapacity",
          targetId: record.allocationReference,
          reasonCode: "AUTHORIZED_CHECKOUT_CAPACITY",
          correlationId: record.submissionReference,
          occurredAt: record.paymentRequestedAt ?? record.preparedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_RETENTION",
          retentionPolicyVersion: 1,
        });
        await createAsapCapacityService({
          scope,
          now: () => capacityAt,
          authorization: {
            authorize: async (request) => ({
              guestSessionReference: prepared.guestSessionReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              identityVersion: 1,
              observedAt: request.observedAt,
              validUntil: prepared.preparationValidUntil,
            }),
          },
          current: { resolve: async (_record, at) => reader.resolve(at) },
          repository,
          audit: { prepare: async (value) => capacityAudit(value) },
        }).prepare(prepared);
        const sealed = sealAsapCapacityCommitment(
          prepared,
          {
            allocationReference: prepared.allocationReference,
            guestSessionReference: prepared.guestSessionReference,
            cartReference: prepared.cartReference,
            quoteReference: prepared.quoteReference,
            submissionReference: prepared.submissionReference,
            orderReference: prepared.orderReference,
            orderBatchReference: prepared.orderBatchReference,
            fulfillmentReference: prepared.fulfillmentReference,
            paymentOperationReference: prepared.paymentOperationReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            cartVersion: prepared.cartVersion,
            intentDigest: prepared.intentDigest,
            acknowledgedAt: capacityAt,
          },
          capacityAt,
          capacityAt,
        );
        await repository.append({ record: sealed, audit: capacityAudit(sealed) });
        // The commitment as checkout wrote it when the guest paid (test only: history moved back).
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            "UPDATE rms_fulfillment.capacity_asap_commitment SET prepared_at=LEAST(prepared_at,$2::timestamptz),preparation_valid_until=$2::timestamptz+interval '10 minutes',ordering_linked_at=CASE WHEN ordering_linked_at IS NULL THEN NULL ELSE $2::timestamptz END,payment_requested_at=CASE WHEN payment_requested_at IS NULL THEN NULL ELSE $2::timestamptz END,capacity_expires_at=CASE WHEN capacity_expires_at IS NULL THEN NULL ELSE $2::timestamptz+interval '30 minutes' END WHERE allocation_id=$1",
            [allocation, requestedAt],
          );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        await finalizeInventory(round, items);
        await seedJourneyPayment(admin, {
          scope,
          providerAccountReference: provider,
          round,
          refs: pay,
          outcome: "Succeeded",
          requestedAt,
          occurredAt,
          totalMinor: items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
        });
        const orderReference = r.order.orderReference,
          orderBatchReference = round.batch.orderBatchReference;
        return {
          round,
          items,
          orderReference,
          orderBatchReference,
          submissionReference: round.batch.submissionReference,
          pay,
          requestedAt,
          event: await capturedEvent(orderReference, orderBatchReference),
        };
      };
      /** A table's first round paid online, at a pay-first table with its Host seated. */
      const seedPaidTableRound = async ({
        paidMinutesAgo = 1,
        suffix = "a001",
        ownParty = false,
      } = {}) => {
        const n = sequenceNumbers.next++;
        const hex = n.toString(16).padStart(4, "0");
        const paidAgo = minutes(paidMinutesAgo);
        const round = journeyRound({
          at: new Date(Date.now() - paidAgo - minutes(1)).toISOString(),
          prefix: "01a2" + hex,
          ...(ownParty ? { party: { prefix: "01a3" + hex } } : {}),
        });
        const requestedAt = new Date(Date.now() - paidAgo - 30_000).toISOString();
        const occurredAt = new Date(Date.now() - paidAgo).toISOString();
        const dining = await seedJourneyDining({
          client: admin,
          scope: ownerScope,
          round,
          startedAt: new Date(Date.now() - paidAgo - minutes(3)).toISOString(),
          guestParticipant: "01a4" + hex + "-0000-7000-8000-000000000601",
          table: { suffix, label: "T" + hex, auditBase: 0xb000 + n * 16 },
        });
        await seedAdditionalDiningGuest({
          client: admin,
          runner: ownerRunner,
          f: round.f,
          dining: {
            ...dining,
            participant: dining.host,
            link: { paymentOperationReference: fresh() },
          },
          at: new Date(Date.now() - paidAgo - minutes(2)).toISOString(),
        }).catch(() => undefined);
        const items = await seedOrderHistory(round, n);
        const r = round.f.request.record;
        const allocation = round.f.request.checkoutValidationEvidence.fulfillment.evidenceReference;
        const pay = payRefs(n, allocation);
        await dining.prepare(round, { paymentOperationReference: pay.paymentOperation });
        const commitments = createPostgresDiningCheckoutCommitmentStore(ownerRunner(), ownerScope, {
          now: () => requestedAt,
        });
        const preparedLink = await commitments.loadSubmission(round.batch.submissionReference);
        const sealedLink = sealDiningCheckoutCommitment(
          preparedLink,
          { session: dining.session, participant: dining.host },
          {
            ...Object.fromEntries(
              [
                "commitmentReference",
                "brandReference",
                "storeReference",
                "submissionReference",
                "orderReference",
                "orderBatchReference",
                "cartReference",
                "cartVersion",
                "quoteReference",
                "paymentOperationReference",
                "guestSessionReference",
                "intentHash",
              ].map((key) => [key, preparedLink[key]]),
            ),
            acknowledgedAt: requestedAt,
          },
          requestedAt,
          requestedAt,
        );
        await commitments.append({
          record: sealedLink,
          expectedVersion: 1,
          audit: dining.audit(sealedLink),
        });
        await finalizeInventory(round, items);
        await seedJourneyPayment(admin, {
          scope,
          providerAccountReference: provider,
          round,
          refs: pay,
          outcome: "Succeeded",
          requestedAt,
          occurredAt,
          totalMinor: items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
        });
        const orderReference = r.order.orderReference,
          orderBatchReference = round.batch.orderBatchReference;
        return {
          round,
          items,
          dining,
          orderReference,
          orderBatchReference,
          submissionReference: round.batch.submissionReference,
          pay,
          event: await capturedEvent(orderReference, orderBatchReference),
        };
      };
      /** The table's next round, submitted through the Ordering writer and paid online. */
      const seedPaidLaterRound = async (first) => {
        const n = sequenceNumbers.next++;
        const hex = n.toString(16).padStart(4, "0");
        const guest = "01a5" + hex + "-0000-7000-8000-000000000602";
        // Submitted now: after the first round's acceptance, which moved the Order on.
        const round = journeyRound({
          at: new Date().toISOString(),
          prefix: "01a2" + hex,
          submitter: guest,
        });
        const dining = first.dining;
        await seedAdditionalDiningGuest({
          client: admin,
          runner: ownerRunner,
          f: first.round.f,
          dining: { ...dining, participant: dining.guest },
          at: new Date(Date.now() - minutes(2)).toISOString(),
          second: { idPrefix: "01909993-0000-7000-8000-", sessionReference: guest },
        });
        await seedSubmissionCart(admin, round.f);
        const pay = payRefs(n, null);
        const link = await dining.prepare(round, {
          paymentOperationReference: pay.paymentOperation,
          participant: dining.guest,
        });
        pay.commitment = round.f.request.checkoutValidationEvidence.fulfillment.evidenceReference;
        const evidence = round.evidence(link),
          items = round.items(evidence);
        await seedJourneyCheckout(admin, {
          round,
          evidence,
          link,
          references: {
            createOperation: fresh(),
            checkoutSession: fresh(),
            details: fresh(),
            detailsOperation: fresh(),
          },
        });
        const orderReference = first.orderReference;
        const snapshot = parseAdditionalDiningBatchSnapshot({
          orderReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          diningSessionReference: dining.session.diningSessionReference,
          guestSessionReference: guest,
          originalOrderCreatedAt: first.round.f.request.record.createdAt,
          expectedOrderVersion: first.currentVersion ?? 1,
          batchSequence: 2,
          snapshotVersion: 1,
          batch: round.batch,
          items,
        });
        await seedJourneyQuote({
          runner: ownerRunner,
          scope: ownerScope,
          snapshot,
          prefix: "01a8" + hex,
        });
        const submitted = await transactions().run((tx) =>
          createCustomerAdditionalDiningSubmissionStore({
            ...scope,
            authorize: async () => true,
            audit: async (candidate) => ({
              auditId: fresh(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "ORDERING_ADDITIONAL_BATCH_SUBMIT",
              targetType: "OrderingOrderBatch",
              targetId: candidate.batch.orderBatchReference,
              reasonCode: "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT",
              correlationId: fresh(),
              occurredAt: candidate.batch.submittedAt,
              sourceChannel: "CUSTOMER_PWA",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            }),
            eventReference: fresh,
            // Test-only stand-ins as in the staff round acceptance: no policies required and the
            // Identity/CSRF recheck not composed. Dining gate, Inventory and the seal are real.
            currentPolicies: async (_tx, request) => ({
              ...scope,
              orderType: "DineIn",
              checkedAt: request.observedAt,
              validUntil: new Date(Date.parse(request.observedAt) + minutes(5)).toISOString(),
              required: [],
            }),
            validateCurrent: async () => undefined,
            inventory: inventoryOptions,
            diningSealAudit: async (record) => dining.audit(record),
          }).append({
            transaction: {
              query: (sql, values) =>
                sql === "SELECT clock_timestamp() AS observed_at"
                  ? Promise.resolve({
                      rows: [{ observed_at: new Date(Date.parse(round.batch.submittedAt) + 1000) }],
                      rowCount: 1,
                    })
                  : tx.query(sql, values),
            },
            snapshot,
            capacityLink: link,
            checkoutValidationEvidence: evidence,
          }),
        );
        assert.equal(submitted.status, "Created");
        const submittedAt = Date.parse(round.batch.submittedAt);
        const occurredAt = submittedAt + 2_000;
        await seedJourneyPayment(admin, {
          scope,
          providerAccountReference: provider,
          round,
          refs: pay,
          outcome: "Succeeded",
          requestedAt: new Date(submittedAt + 1_000).toISOString(),
          occurredAt: new Date(occurredAt).toISOString(),
          totalMinor: items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
        });
        // The payment is in the past by the time the worker reads it.
        await delay(Math.max(0, occurredAt - Date.now() + 50));
        const orderBatchReference = round.batch.orderBatchReference;
        return {
          round,
          items,
          orderReference,
          orderBatchReference,
          submissionReference: round.batch.submissionReference,
          pay,
          event: await capturedEvent(orderReference, orderBatchReference),
        };
      };
      const setting = {
        /** The switch through the owner store, as the Store features page saves it. */
        async change({ pickup, dineIn, actor = fresh(), at = now() }) {
          const { changeOrderAutoAcceptanceSetting, loadOrderAutoAcceptanceSetting } =
            await import("../../rms/ordering/src/index.ts");
          return transactions().run(async (tx) => {
            const current = await loadOrderAutoAcceptanceSetting(tx, scope);
            return changeOrderAutoAcceptanceSetting(tx, ownerScope, {
              operationReference: fresh(),
              expectedVersion: current.version,
              pickup,
              dineIn,
              actorReference: actor,
              observedAt: at,
            });
          });
        },
      };
      const kitchenScreen = {
        async seenNow(at = now()) {
          const { recordKitchenScreenPresence } = await import("../../rms/kitchen/src/index.ts");
          await transactions().run((tx) => recordKitchenScreenPresence(tx, scope, at));
        },
      };
      const query = async (sql, values = []) => (await admin.query(sql, values)).rows;
      /**
       * Owner seed of the Kitchen rows of a batch, for what reads them (test only): these reads are
       * about status and steps, so the rows' other columns and checks don't matter here.
       */
      const seedKitchenTicket = async (order, { status = "Queued", step = null } = {}) => {
        const relax = async (table) => {
          const checks = await query(
            "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'",
            [table],
          );
          for (const { conname } of checks)
            await admin.query("ALTER TABLE " + table + ' DROP CONSTRAINT "' + conname + '"');
        };
        const insert = async (table, values) => {
          const columns = await query(
            "SELECT column_name,data_type,domain_name,udt_name FROM information_schema.columns WHERE table_schema||'.'||table_name=$1 AND is_nullable='NO' AND column_default IS NULL",
            [table],
          );
          const row = { ...values };
          for (const column of columns) {
            if (Object.hasOwn(row, column.column_name)) continue;
            row[column.column_name] =
              column.domain_name === "uuid_v7"
                ? fresh()
                : column.data_type.includes("timestamp")
                  ? now()
                  : column.data_type === "integer" || column.data_type === "bigint"
                    ? 1
                    : column.data_type === "boolean"
                      ? false
                      : column.data_type === "jsonb"
                        ? "{}"
                        : column.data_type === "ARRAY"
                          ? []
                          : "x";
          }
          const names = Object.keys(row);
          await admin.query(
            "INSERT INTO " +
              table +
              " (" +
              names.join(",") +
              ") VALUES (" +
              names.map((_, index) => "$" + (index + 1)).join(",") +
              ")",
            names.map((name) => row[name]),
          );
        };
        await admin.query("SET session_replication_role = replica");
        try {
          for (const table of [
            "rms_kitchen.kitchen_ticket",
            "rms_kitchen.kitchen_work_item",
            "rms_kitchen.kitchen_work_lifecycle_operation",
          ])
            await relax(table);
          const common = {
            brand_id: scope.brandReference,
            store_id: scope.storeReference,
            order_id: order.orderReference,
            order_batch_id: order.orderBatchReference,
          };
          const ticket = fresh(),
            item = fresh();
          await insert("rms_kitchen.kitchen_ticket", {
            ...common,
            kitchen_ticket_id: ticket,
            status: "Open",
          });
          await insert("rms_kitchen.kitchen_work_item", {
            ...common,
            kitchen_ticket_id: ticket,
            kitchen_work_item_id: item,
            status,
          });
          if (step !== null)
            await insert("rms_kitchen.kitchen_work_lifecycle_operation", {
              brand_id: scope.brandReference,
              store_id: scope.storeReference,
              kitchen_ticket_id: ticket,
              kitchen_work_item_id: item,
              action_code: step,
              occurred_at: now(),
            });
          return { ticket, item };
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      };
      await work({
        admin,
        api,
        assert,
        clientConfig: context.clientConfig,
        clock,
        fresh,
        inventoryOptions,
        kitchenScreen,
        minutes,
        now,
        operating,
        ownerRunner,
        ownerScope,
        paid,
        paymentScope,
        pilotWorkflow,
        provider,
        query,
        scope,
        seedKitchenTicket,
        seedPaidLaterRound,
        seedPaidPickup,
        seedPaidTableRound,
        session,
        acceptanceFor,
        setting,
        systemActor,
        tenant,
        time,
        transactions,
        worker,
      });
    } finally {
      vi.unstubAllEnvs();
      for (const name of [api, workerRole]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
}

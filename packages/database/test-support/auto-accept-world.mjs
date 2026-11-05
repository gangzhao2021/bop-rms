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
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenWorkLifecycleStore,
} from "../../rms/kitchen/src/index.ts";
import { createPostgresCapturedBatchPaymentSource } from "../../rms/payment/src/index.ts";
import { recordStorePresence } from "../../rms/store/src/index.ts";
import { createCustomerSubmissionInventoryFinalizer } from "../../../apps/api/src/customer-submission-inventory-finalizer.ts";
import { appendEventInTransaction } from "../../bop/eventing/src/index.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { changeProductAlcoholMark } from "../../rms/catalog/src/index.ts";
import { createPersistentEntryOperatingReader } from "../../../apps/api/src/persistent-entry-operating.ts";
import { createSubmissionInventoryRelease } from "../../../apps/api/src/submission-inventory-release.ts";
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
  seedJourneyStorePublication,
} from "./dine-in-journey-seed.mjs";
import { seedStoreKitchenInEffect } from "./kitchen-routing-configuration.mjs";

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
      /**
       * What the Store's operating read says; `read` replaces it (a lock, a failure), and `real` is
       * the pilot's own reader over a published Store (`useRealOperatingReader`).
       */
      const operating = {
        current: { state: "Open", availableServiceModes: ["Pickup", "DineIn"] },
        read: null,
        real: null,
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
        operatingReader: (tx) =>
          operating.real !== null
            ? operating.real(tx)
            : {
                readCurrent: async () =>
                  operating.read === null ? operating.current : operating.read(tx),
              },
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
      const seedPaidPickup = async ({ paidMinutesAgo = 1, quantity } = {}) => {
        await pickupCapacity();
        const n = sequenceNumbers.next++;
        const hex = n.toString(16).padStart(4, "0");
        const paidAgo = minutes(paidMinutesAgo);
        const round = journeyRound({
          at: new Date(Date.now() - paidAgo - minutes(1)).toISOString(),
          prefix: "01a2" + hex,
          party: { prefix: "01a3" + hex },
          dineIn: false,
          ...(quantity === undefined ? {} : { quantity }),
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
       * The ticket Kitchen intake makes for a batch: a real row per order line, every CHECK and
       * trigger in force (owner seed, as the intake's rows have no restricted writer here).
       */
      const seedKitchenTicket = async (order) => {
        const accepted = (
          await query(
            "SELECT accepted_order_version::int AS version,to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
            [order.orderBatchReference],
          )
        )[0];
        const items = await query(
          "SELECT order_item_id::text AS id FROM rms_ordering.order_item WHERE order_batch_id=$1 ORDER BY order_item_id",
          [order.orderBatchReference],
        );
        const ticket = fresh(),
          evidence = fresh(),
          plan = fresh(),
          at = accepted.at;
        await admin.query(
          "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,$8,$9,$10,$11,$12,$13,1,$14,$10,$15,1,$16,$10,1,'Open','System','System',$10,$10)",
          [
            ticket,
            scope.brandReference,
            scope.storeReference,
            order.orderReference,
            order.orderBatchReference,
            fresh(),
            fresh(),
            accepted.version,
            hashText("snapshot" + ticket),
            at,
            fresh(),
            hashText("binding" + ticket),
            evidence,
            hashText("evidence" + ticket),
            plan,
            hashText("plan" + ticket),
          ],
        );
        const workItems = [];
        for (const [index, item] of items.entries()) {
          const workItem = fresh();
          workItems.push({ workItemReference: workItem, orderItemReference: item.id });
          await admin.query(
            "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',1,0,$11,$12,$13,$14,$15::jsonb,'[]'::jsonb,$16,$17,$18,1,$19,$20,1,$21,$22::jsonb,$23,'System','System',$24,$24)",
            [
              workItem,
              scope.brandReference,
              scope.storeReference,
              ticket,
              order.orderReference,
              order.orderBatchReference,
              item.id,
              evidence,
              plan,
              index + 1,
              fresh(),
              fresh(),
              fresh(),
              fresh(),
              JSON.stringify({ "en-CA": "Synthetic item " + (index + 1) }),
              hashText("line" + ticket + index),
              fresh(),
              fresh(),
              hashText("routing" + ticket),
              fresh(),
              hashText("preparation" + ticket),
              JSON.stringify(["Synthetic preparation"]),
              hashText("execution" + ticket + index),
              at,
            ],
          );
        }
        return { ticket, workItems, correlation: fresh(), cook: fresh() };
      };
      /**
       * A kitchen step through the owner's lifecycle service under the restricted role: the rows a
       * board's tap writes. Admission and Expo are synthetic (Expo off: ready on completion).
       */
      const kitchenStep = async (seeded, action, input = {}) => {
        const { workItemReference, orderItemReference } = seeded.workItems[0];
        const references = {
          next: fresh,
          derive: (purpose, identity) => {
            const digest = createHash("sha256")
              .update(purpose + identity)
              .digest("hex");
            return (
              "0198cafe-" +
              digest.slice(0, 4) +
              "-7" +
              digest.slice(4, 7) +
              "-8" +
              digest.slice(7, 10) +
              "-" +
              digest.slice(10, 22)
            );
          },
        };
        const digests = { sha256: hashText };
        const later = new Date(Date.now() + minutes(60)).toISOString();
        const cook = seeded.cook;
        const versions = (
          await query(
            "SELECT t.aggregate_version::text AS ticket,w.version::text AS item FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w ON w.kitchen_ticket_id=t.kitchen_ticket_id WHERE w.kitchen_work_item_id=$1",
            [workItemReference],
          )
        )[0];
        return createKitchenWorkLifecycleService({
          trustedContext: {
            resolveAuthority: async () => ({
              actorReference: cook,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              observedAt: now(),
            }),
          },
          correlationContext: {
            resolve: async () => ({ correlationReference: seeded.correlation }),
          },
          authorization: { authorize: async () => true },
          transactions: {
            withTransaction: (unit) =>
              transactions().run(async (tx) => {
                await tx.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, scope.brandReference, scope.storeReference],
                );
                return unit(tx);
              }),
          },
          tenantContext: { install: async () => undefined },
          idempotency: {
            acquireFence: async ({ transaction, idempotencyKey }) => {
              await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                scope.brandReference + ":" + scope.storeReference + ":" + idempotencyKey,
              ]);
            },
          },
          repository: createPostgresKitchenWorkLifecycleStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            references,
            digests,
            authorize: async () => true,
            validateCurrentSource: async () => true,
          }),
          references,
          digests,
          clock: { now },
          admission: {
            resolve: async ({ command, acceptedOperationReference }) => ({
              decisionReference: fresh(),
              decisionVersion: 1,
              decisionDigest: hashText("synthetic admission"),
              producerContractVersion: 1,
              actorReference: command.actorReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              ticketReference: command.ticketReference,
              workItemReference: command.workItemReference,
              acceptedOperationReference,
              ticketVersion: BigInt(command.expectedTicketVersion),
              workItemVersion: BigInt(command.expectedWorkItemVersion),
              action: "StartKitchenWorkItem",
              purpose: "KitchenWorkExecution",
              outcome: "Allowed",
              evaluatedAt: now(),
              validUntil: later,
            }),
          },
          expo: {
            resolve: async () => ({
              decisionReference: fresh(),
              decisionVersion: 1,
              decisionDigest: hashText("synthetic Expo"),
              producerContractVersion: 1,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              purpose: "KitchenReadiness",
              mode: "Disabled",
              evaluatedAt: now(),
              validUntil: later,
            }),
          },
        }).execute({
          action,
          idempotencyKey: "auto-accept-" + workItemReference + "-" + action + "-" + versions.item,
          actorReference: cook,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          ticketReference: seeded.ticket,
          workItemReference,
          orderItemReference,
          expectedTicketVersion: versions.ticket,
          expectedWorkItemVersion: versions.item,
          correlationReference: seeded.correlation,
          ...input.extra,
        });
      };
      /** The Store's own dish for this order's line, marked as alcohol as the owner marks it. */
      const markAlcohol = async (order, containsAlcohol = true, expectedVersion = 0) => {
        const { catalog } = order.items[0];
        const at = time(-minutes(120));
        const actor = fresh();
        await admin.query("SET session_replication_role = replica");
        try {
          if (expectedVersion === 0) {
            await admin.query(
              "INSERT INTO rms_catalog.product (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'BEER_TEST','PreparedFood','Active',1,$3,$4,$3)",
              [catalog.productReference, scope.brandReference, at, actor],
            );
            await admin.query(
              "INSERT INTO rms_catalog.sku (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES ($1,$2,$3,$4,'BEER_TEST','Active','{}'::jsonb,'[]'::jsonb,$5,'EACH',1,$6,$7)",
              [
                catalog.skuReference,
                catalog.productReference,
                scope.brandReference,
                catalog.productVersionReference,
                hashText("variant"),
                at,
                actor,
              ],
            );
          }
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        return worker().run((tx) =>
          changeProductAlcoholMark(tx, ownerScope, {
            productReference: catalog.productReference,
            operationReference: fresh(),
            expectedVersion,
            containsAlcohol,
            actorReference: actor,
            observedAt: now(),
          }),
        );
      };
      /** Stock no longer held for this order, as a release leaves it (owner fixture). */
      const releaseStock = (order) =>
        ownerRunner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, scope.brandReference, scope.storeReference],
          );
          return createSubmissionInventoryRelease({
            scope: ownerScope,
            systemActorReference: fresh(),
            reasonCode: "STAFF_CANCELLED_BEFORE_PREPARATION",
            now,
          }).release(tx, {
            source: {
              kind: "StaffOrderCancellationInventory/v1",
              reference: fresh(),
              submissionReference: order.submissionReference,
              orderReference: order.orderReference,
              occurredAt: now(),
            },
            releasedAt: now(),
            authorize: async () => true,
          });
        });
      /**
       * TEST-ONLY money fixture: this order's payment recorded on the card machine, the quickest owner
       * fact Payment reads as paid another way. `refundedMinor`: also refunded there already.
       */
      const seedCardMachinePayment = async (order, { refundedMinor = null } = {}) => {
        const intent = (
          await query(
            "SELECT t.payment_intent_id::text AS intent,t.payment_attempt_id::text AS attempt,i.payment_operation_id::text AS operation FROM rms_payment.payment_terminal_fact t JOIN rms_payment.payment_intent i ON i.payment_intent_id=t.payment_intent_id WHERE t.order_id=$1",
            [order.orderReference],
          )
        )[0];
        const payment = fresh();
        const total = order.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
        const at = time(-minutes(40));
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            "INSERT INTO rms_payment.card_machine_payment (tenant_id,brand_id,store_id,card_machine_payment_id,payment_intent_id,payment_attempt_id,payment_operation_id,operation_id,intent_digest,order_id,order_batch_id,submission_id,preparation_json,order_allocation_minor,tip_minor,total_minor,currency_code,payment_environment,slip_reference,recording_reason,taken_at,recorded_at,actor_id,event_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,0,$14,'CAD','Test','AUTH 0001','AtCounter',$15,$15,$16,$17,$18)",
            [
              tenant,
              scope.brandReference,
              scope.storeReference,
              payment,
              intent.intent,
              intent.attempt,
              intent.operation,
              fresh(),
              hashText("card-machine" + payment),
              order.orderReference,
              order.orderBatchReference,
              order.submissionReference,
              JSON.stringify({
                preparationReference: fresh(),
                orderReference: order.orderReference,
                orderBatchReference: order.orderBatchReference,
                submissionReference: order.submissionReference,
                sourceCartReference: fresh(),
                sourceCartVersion: 1,
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                guestSessionReference: fresh(),
                quoteReference: fresh(),
                capacityAllocationReference: fresh(),
                readiness: "PaymentPending",
                transactionBoundary: "OrderSubmissionPaymentPreparation",
                orderAllocation: { amountMinor: String(total), currencyCode: "CAD" },
                tip: { amountMinor: "0", currencyCode: "CAD" },
                total: { amountMinor: String(total), currencyCode: "CAD" },
                committedAt: at,
                capacityExpiresAt: new Date(Date.parse(at) + minutes(30)).toISOString(),
                sourceDigest: hashText("preparation" + payment),
              }),
              total,
              at,
              fresh(),
              fresh(),
              fresh(),
            ],
          );
          if (refundedMinor !== null)
            await admin.query(
              "INSERT INTO rms_payment.card_machine_refund (tenant_id,brand_id,store_id,card_machine_refund_id,card_machine_payment_id,order_id,operation_id,intent_digest,source_kind,source_id,amount_minor,currency_code,slip_reference,refunded_at,recorded_at,actor_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UnfulfillableOrder',$9,$10,'CAD',NULL,$11,$11,$12,$13)",
              [
                tenant,
                scope.brandReference,
                scope.storeReference,
                fresh(),
                payment,
                order.orderReference,
                fresh(),
                hashText("fixture-refund" + payment),
                fresh(),
                refundedMinor === "All" ? total : refundedMinor,
                time(-minutes(35)),
                fresh(),
                fresh(),
              ],
            );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        return { total };
      };
      /** Kitchen's decision for a round it does not make (a bottled drink), as intake records it. */
      const seedNotPrepared = async (order) => {
        const items = await query(
          "SELECT array_agg(order_item_id::uuid) AS items FROM rms_ordering.order_item WHERE order_batch_id=$1",
          [order.orderBatchReference],
        );
        await admin.query(
          "INSERT INTO rms_kitchen.kitchen_batch_preparation_decision (brand_id,store_id,order_id,order_batch_id,source_event_id,confirmation_id,not_prepared_order_item_ids,all_not_prepared,intake_receipt,decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],true,'{\"synthetic\":true}'::jsonb,$8)",
          [
            scope.brandReference,
            scope.storeReference,
            order.orderReference,
            order.orderBatchReference,
            fresh(),
            fresh(),
            items[0].items,
            now(),
          ],
        );
      };
      /**
       * The Order's version moved on since it was accepted, as a line's cancellation moves it: its
       * revision and record (test only: this fixture's order has one line, so the record names another
       * and what is left of the order stays whole; lines and their refunds are the item cancellation's
       * own acceptance). `recordless`: the revision alone, which nothing explains.
       */
      const moveOrderVersion = async (order, { recordless = false } = {}) => {
        const cancellation = fresh();
        const at = (
          await query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        )[0].at.toISOString();
        const latest = (
          await query(
            "SELECT revision_id::text AS revision,version::int AS version FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version DESC LIMIT 1",
            [order.orderReference],
          )
        )[0];
        const paid = (
          await query(
            "SELECT disposition_id::text AS disposition,payment_transaction_id::text AS transaction,payment_intent_id::text AS intent,payment_attempt_id::text AS attempt,payment_event_id::text AS event FROM rms_ordering.order_payment_disposition_record WHERE order_batch_id=$1 AND disposition='Confirmed'",
            [order.orderBatchReference],
          )
        )[0];
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'StaffItemCancellation',$5,$6,$7,NULL,$8)",
            [
              cancellation,
              scope.brandReference,
              scope.storeReference,
              order.orderReference,
              latest.version + 1,
              latest.version,
              latest.revision,
              at,
            ],
          );
          if (!recordless)
            await admin.query(
              "INSERT INTO rms_ordering.order_item_staff_cancellation (cancellation_id,operation_id,brand_id,store_id,order_id,order_batch_id,submission_id,order_type,expected_order_version,cancelled_order_version,expected_source_checkpoint,previous_phase,actor_id,permission_code,reason_code,payment_disposition_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,order_item_ids,kitchen_evidence_digest,refund_request_id,refund_operation_id,refund_amount_minor,currency_code,source_digest,audit_id,cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'Pickup',$8,$9,$10,'Accepted',$11,'ordering.order.cancel','SOLD_OUT',$12,$13,$14,$15,$16,$17::uuid[],$18,$19,$20,100,'CAD',$21,$22,$23)",
              [
                cancellation,
                fresh(),
                scope.brandReference,
                scope.storeReference,
                order.orderReference,
                order.orderBatchReference,
                order.submissionReference,
                latest.version,
                latest.version + 1,
                latest.revision,
                fresh(),
                paid.disposition,
                paid.transaction,
                paid.intent,
                paid.attempt,
                paid.event,
                [fresh()],
                hashText("kitchen" + cancellation),
                fresh(),
                fresh(),
                hashText("source" + cancellation),
                fresh(),
                at,
              ],
            );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      };
      /**
       * The pilot's own operating reader over a published Store, open all day, in whatever
       * transaction the worker gives it. Only the pause history's proof is synthetic.
       */
      const operatingId = (n) => "01a6ab00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const useRealOperatingReader = async () => {
        await session([], "01a6aa20");
        const publishedAt = time(-minutes(24 * 60));
        await seedJourneyStorePublication({
          client: admin,
          scope: ownerScope,
          publishedAt,
          businessDayStart: "00:00:00",
          prefix: "01a6ab00",
          allWeek: true,
        });
        await seedStoreKitchenInEffect({
          admin,
          role: api,
          scope,
          at: time(-minutes(48 * 60)),
          id: (n) => "01a6ab10-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
        });
        const options = {
          ...scope,
          tenantReference: tenant,
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
          authorize: async () => true,
          hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
          timeZone: "America/Toronto",
          verifyPauseOperation: async () => true,
        };
        const binding = {
          ...resources.publicProfile.binding,
          ...scope,
          lookupEvidenceReference: fresh(),
          validFrom: publishedAt,
        };
        operating.real = (transaction) =>
          createPersistentEntryOperatingReader({
            transaction,
            publicStore: { binding, authorize: async () => true },
            operating: options,
          });
      };
      /** The Store's own pause and resume records, as Pause ordering writes them. */
      const pauseOperation = async (kind, content) => {
        const operation = fresh();
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            "INSERT INTO rms_store.store_configuration_operation VALUES ($1,$2,$3,$4,$5,$6,1,2,$7,'STORE.CONFIGURATION',$8,$9,'ConfigurationMetadata')",
            [
              operation,
              scope.brandReference,
              scope.storeReference,
              operatingId(1),
              kind,
              hashText("pause" + operation),
              fresh(),
              fresh(),
              time(-minutes(1)),
            ],
          );
          await content(operation);
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        return operation;
      };
      const pauseStore = () =>
        pauseOperation("PauseService", (operation) =>
          admin.query(
            "INSERT INTO rms_store.store_service_pause_content VALUES ($1,$2,$3,'PauseService',$4,$5,NULL,'ConfigurationMetadata')",
            [
              scope.brandReference,
              scope.storeReference,
              operation,
              time(-minutes(1)),
              new Date(Date.now() + minutes(60)).toISOString(),
            ],
          ),
        );
      const resumeStore = (pause) =>
        pauseOperation("ResumeService", (operation) =>
          admin.query(
            "INSERT INTO rms_store.store_service_resume_content VALUES ($1,$2,$3,'ResumeService',$4,$5,'ConfigurationMetadata')",
            [scope.brandReference, scope.storeReference, operation, pause, now()],
          ),
        );
      /** Staff screens seen at this instant: a presence period, as a signed-in read records it. */
      const staffSeen = (at = now()) =>
        transactions().run((tx) =>
          recordStorePresence(tx, scope, { observedAt: at, newPeriodReference: fresh }),
        );
      /** Staff screens on from this long ago until now, as they poll. */
      const staffOnSince = async (minutesAgo) => {
        for (let ago = minutesAgo; ago > 0; ago -= 4)
          await staffSeen(new Date(Date.now() - minutes(ago)).toISOString());
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
        kitchenStep,
        markAlcohol,
        minutes,
        moveOrderVersion,
        now,
        operating,
        ownerRunner,
        ownerScope,
        paid,
        paymentScope,
        pilotWorkflow,
        provider,
        pauseStore,
        query,
        releaseStock,
        resumeStore,
        scope,
        seedCardMachinePayment,
        seedKitchenTicket,
        seedNotPrepared,
        seedPaidLaterRound,
        seedPaidPickup,
        seedPaidTableRound,
        session,
        staffOnSince,
        staffSeen,
        acceptanceFor,
        setting,
        systemActor,
        tenant,
        time,
        transactions,
        useRealOperatingReader,
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

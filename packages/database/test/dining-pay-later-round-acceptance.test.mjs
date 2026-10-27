import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createOrderNumberAllocation,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderPayLaterConfirmationStore,
  parseAdditionalDiningBatchSnapshot,
} from "../../rms/ordering/src/index.ts";
import { createCustomerAdditionalDiningSubmissionStore } from "../../../apps/api/src/customer-additional-dining-submission-store.ts";
import { createDiningPayLaterRound } from "../../../apps/api/src/dining-pay-later-round.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedAcceptanceOrderHistory } from "../test-support/acceptance-order-history.mjs";
import { seedAdditionalDiningGuest } from "../test-support/additional-dining-guest.mjs";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { seedSubmissionInventoryStock } from "../test-support/submission-inventory-stock.mjs";
import { seedSubmissionInventoryRecipe } from "../test-support/submission-inventory-recipe.mjs";
import { seedSubmissionInventoryWorkflow } from "../test-support/submission-inventory-workflow.mjs";
import {
  journeyRound,
  seedJourneyCheckout,
  seedJourneyDining,
  seedJourneyQuote,
} from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a0fe00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const minutes = (n) => n * 60_000;
let references = 0xa000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER. A table opened "pay later" (the Store's setting when it was
 * opened, captured by Dining). Its first round (a guest's) and a later round (submitted through the
 * actual Ordering additional-round writer) each go straight to the kitchen when sent, under the
 * restricted NOBYPASSRLS API role holding the rendered pilot grants: the published dining
 * workflow's Accept for the System, Ordering's automatic acceptance with its revision and audit,
 * the pay-later confirmation, the OrderConfirmed event the kitchen takes, and the kitchen source
 * that event resolves to (both rounds). Sending again returns the same round; the round is never
 * closed as "not paid in time"; the records are append-only; another Store sees none of it.
 *
 * Not covered here: the guest and staff command steps before the submission (cart, quote,
 * checkout; unit-tested and covered by the dine-in journey and staff round acceptance tests).
 */
it("sends each round of a pay-later table to the kitchen unpaid, once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_paylater" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_plr_" + context.runId,
      worker = "wp2423_plr_w_" + context.runId;
    assert.match(api, /^wp2423_plr_[a-f0-9]+$/u);
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      const R1 = journeyRound({ at: time(-minutes(40)), prefix: "01a00011" });
      const tableGuest = id(0x602);
      const R2 = journeyRound({ at: time(-minutes(5)), prefix: "01a00012", submitter: tableGuest });
      const scope = R1.f.scope;
      const tenant = scope.brandReference.slice(0, 24) + "000000000900";
      const ownerScope = { tenantReference: tenant, ...scope };
      const orderReference = R1.f.request.record.order.orderReference;
      const guestSession = R1.f.request.record.guestSessionReference;

      /** One restricted-role transaction on its own connection (the pilot API's grants). */
      const transactions = ({ guc = false } = {}) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query("SET LOCAL statement_timeout='20s'");
            if (guc)
              await client.query(
                "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                [tenant, scope.brandReference, scope.storeReference],
              );
            const result = await work({ query: (sql, values) => client.query(sql, values) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      });
      const ownerRunner = () => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            const result = await work({ query: (sql, values) => client.query(sql, values) });
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
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── The Store opens tables "pay later" (its Owner's setting); the table is opened after.
      await admin.query(
        "INSERT INTO rms_dining.store_dining_payment_timing (tenant_id,brand_id,store_id,version,payment_timing,operation_id,intent_hash,actor_id,changed_at) VALUES ($1,$2,$3,1,'PayLater',$4,$5,$6,$7)",
        [
          tenant,
          scope.brandReference,
          scope.storeReference,
          id(0x50),
          "a".repeat(64),
          id(0x51),
          time(-minutes(60)),
        ],
      );
      const dining = await seedJourneyDining({
        client: admin,
        scope: ownerScope,
        round: R1,
        startedAt: time(-minutes(50)),
        guestParticipant: id(0x601),
      });
      const sessionReference = dining.session.diningSessionReference;
      assert.deepEqual(
        await rows(
          "SELECT payment_timing FROM rms_dining.dining_session_payment_timing WHERE session_id=$1",
          [sessionReference],
        ),
        [{ payment_timing: "PayLater" }],
      );
      await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: {
          ...dining,
          participant: dining.host,
          link: { paymentOperationReference: id(0x100) },
        },
        at: time(-minutes(45)),
      });
      await seedAdditionalDiningGuest({
        client: admin,
        runner: ownerRunner,
        f: R1.f,
        dining: { ...dining, participant: dining.guest },
        at: time(-minutes(44)),
        second: { idPrefix: "01909993-0000-7000-8000-", sessionReference: tableGuest },
      });
      const stock = await seedSubmissionInventoryStock({
        admin,
        runner: ownerRunner,
        ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
      });
      await seedSubmissionInventoryRecipe({
        admin,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
        cart: R2.f.cart,
        stock,
      });
      // The Store's published dine-in workflow (its Accept is what the System goes through).
      const inventoryWorkflow = await seedSubmissionInventoryWorkflow({
        runner: ownerRunner,
        scope: ownerScope,
        actorReference: guestSession,
        at: time(-minutes(48)),
        orderType: "DineIn",
      });

      // ── Round 1: the guest's first round, submitted (owner-seeded history), not paid.
      const r1 = R1.f.request.record,
        items1 = R1.items();
      await seedAcceptanceOrderHistory(admin, {
        ...r1,
        items: items1,
        orderNumberAllocation: createOrderNumberAllocation({
          orderReference,
          allocatedAt: r1.createdAt,
          sequence: 1n,
          businessDateResolution: R1.f.request.businessDateResolution,
        }),
      });
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: { items: items1, batch: R1.batch },
        prefix: "01a10011",
      });

      // Each round is sent when it is submitted (round 1 at its own time in the fixture's past).
      let clock = time(-minutes(38));
      const payLater = createDiningPayLaterRound({
        scope: ownerScope,
        // The fixture's Orders are priced with Quote v1 (the pilot prices with v2).
        quoteVersion: 1,
        workflow: {
          purposeCode: inventoryWorkflow.payment.purposeCode,
          applicabilityCode: "DineIn",
          workflowVersionReference: inventoryWorkflow.payment.workflowVersionReference,
        },
        now: () => clock,
        generateReference: fresh,
      });
      const send = (submissionReference, actorReference, operationReference = fresh()) =>
        transactions().run((tx) =>
          payLater.confirm(tx, {
            submissionReference,
            actorReference,
            operationReference,
            correlationReference: operationReference,
            authorize: async () => true,
          }),
        );
      assert.equal(
        await transactions().run((tx) => payLater.isPayLater(tx, sessionReference)),
        true,
      );

      // The round is sent: the System's acceptance, its revision, the confirmation and the event.
      const sent1 = await send(r1.submissionReference, guestSession);
      assert.equal(sent1.status, "Confirmed");
      const c1 = sent1.confirmation;
      assert.equal(String(c1.orderBatchReference), R1.batch.orderBatchReference);
      assert.equal(String(c1.diningSessionReference), sessionReference);
      assert.equal(c1.acceptedOrderVersion, 2);
      assert.deepEqual(
        await rows(
          "SELECT actor_type,reason_code,accepted_order_version FROM rms_ordering.order_acceptance_record WHERE acceptance_id=$1",
          [c1.acceptanceReference],
        ),
        [
          {
            actor_type: "System",
            reason_code: "PAY_LATER_SENT_TO_KITCHEN",
            accepted_order_version: 2,
          },
        ],
      );
      assert.deepEqual(
        (
          await rows(
            "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
            [orderReference],
          )
        )[0],
        { version: 2 },
      );
      // Nothing was paid: no payment disposition, and the round still owes its items.
      assert.deepEqual(
        await rows(
          "SELECT 1 FROM rms_ordering.order_payment_disposition_record WHERE order_id=$1",
          [orderReference],
        ),
        [],
      );
      const event1 = await transactions({ guc: true }).run((tx) =>
        loadOutboxEnvelope(tx, c1.orderConfirmedEventReference),
      );
      assert.equal(event1.eventType, "OrderConfirmed");
      assert.equal(event1.causationId, c1.acceptanceReference);
      assert.equal(event1.aggregateVersion, 2n);
      assert.deepEqual(event1.actor, { type: "System" });
      assert.equal(event1.payload.orderBatchReference, R1.batch.orderBatchReference);
      assert.deepEqual(
        (
          await rows(
            "SELECT action_code,actor_type,retention_policy_code FROM platform_audit.audit_record WHERE target_id=$1 AND action_code IN ('ORDER_ACCEPTED','ORDER_PAY_LATER_SENT_TO_KITCHEN') ORDER BY action_code",
            [orderReference],
          )
        ).map((row) => [row.action_code, row.actor_type, row.retention_policy_code]),
        [
          ["ORDER_ACCEPTED", "System", "FINANCIAL_COMPLIANCE"],
          ["ORDER_PAY_LATER_SENT_TO_KITCHEN", "System", "FINANCIAL_COMPLIANCE"],
        ],
      );
      // Sent again (a retry, or another guest's tap): the same round, never a second acceptance.
      const again = await send(r1.submissionReference, guestSession);
      assert.equal(again.status, "AlreadyConfirmed");
      assert.equal(again.confirmation.confirmationReference, c1.confirmationReference);
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record WHERE order_id=$1",
            [orderReference],
          )
        )[0].n,
        1,
      );
      // What the round adds to the table's bill (tax included), from its own items.
      assert.equal(
        await transactions().run((tx) =>
          payLater.roundTotalMinor(tx, {
            orderReference,
            orderBatchReference: R1.batch.orderBatchReference,
            authorize: async () => true,
          }),
        ),
        items1.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n),
      );

      // ── The kitchen takes the round from its OrderConfirmed event (the source it resolves to).
      const kitchenSource = (confirmation, event) =>
        transactions().run((tx) =>
          createPostgresOrderKitchenSourceStore({
            ...scope,
            quoteVersion: 1,
            sha256,
            authorize: async () => true,
          }).resolve({
            transaction: tx,
            query: {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              orderReference,
              orderBatchReference: String(confirmation.orderBatchReference),
              confirmationReference: String(confirmation.confirmationReference),
              sourceEventReference: event.eventId,
              sourceAggregateVersion: event.aggregateVersion,
              sourceSnapshotDigest: String(confirmation.sourceSnapshotDigest),
              observedAt: now(),
            },
          }),
        );
      const source1 = await kitchenSource(c1, event1);
      assert.ok(source1, "the kitchen resolves the first pay-later round");
      assert.equal(String(source1.orderBatchReference), R1.batch.orderBatchReference);

      // ── Round 2: the table guest's later round through the actual Ordering writer.
      await seedSubmissionCart(admin, R2.f);
      const link2 = await dining.prepare(R2, {
        paymentOperationReference: id(0x2010),
        participant: dining.guest,
      });
      const evidence2 = R2.evidence(link2),
        items2 = R2.items(evidence2);
      await seedJourneyCheckout(admin, {
        round: R2,
        evidence: evidence2,
        link: link2,
        references: {
          createOperation: id(0x2101),
          checkoutSession: id(0x2102),
          details: id(0x2103),
          detailsOperation: id(0x2104),
        },
      });
      const snapshot2 = parseAdditionalDiningBatchSnapshot({
        orderReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningSessionReference: sessionReference,
        guestSessionReference: tableGuest,
        originalOrderCreatedAt: r1.createdAt,
        expectedOrderVersion: 2,
        batchSequence: 2,
        snapshotVersion: 1,
        batch: R2.batch,
        items: items2,
      });
      await seedJourneyQuote({
        runner: ownerRunner,
        scope: ownerScope,
        snapshot: snapshot2,
        prefix: "01a10012",
      });
      const submitted = await transactions().run((tx) =>
        createCustomerAdditionalDiningSubmissionStore({
          ...scope,
          authorize: async (_tx, candidate) =>
            [guestSession, tableGuest].includes(candidate.guestSessionReference),
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
          // Test-only stand-ins as in the dine-in journey: no policies required and the
          // Identity/CSRF recheck not composed. Dining gate, Inventory and the seal are real.
          currentPolicies: async (_tx, request) => ({
            ...scope,
            orderType: "DineIn",
            checkedAt: request.observedAt,
            validUntil: new Date(Date.parse(request.observedAt) + minutes(5)).toISOString(),
            required: [],
          }),
          validateCurrent: async () => undefined,
          inventory: {
            scope: ownerScope,
            stockSiteReference: stock.stockSiteReference,
            workflow: {
              ...inventoryWorkflow,
              gates: {
                ...inventoryWorkflow.gates,
                authorizeResource: async (innerTx, request) =>
                  inventoryWorkflow.gates.authorizeResource(innerTx, {
                    ...request,
                    actorReference:
                      request.actorReference === tableGuest ? guestSession : request.actorReference,
                  }),
              },
            },
            authorize: async (_tx, input) =>
              [guestSession, tableGuest].includes(input.actorReference),
            resolveExpiryCutoff: stock.resolveExpiryCutoff,
            generateReference: fresh,
            audit: {
              reasonCode: "SYNTHETIC_SUBMISSION",
              sourceChannel: "CUSTOMER_PWA",
              retentionPolicyCode: "SYNTHETIC_AUDIT",
              retentionPolicyVersion: 1,
            },
          },
          diningSealAudit: async (record) => dining.audit(record),
        }).append({
          // The writer's transaction clock at the round's own instant (test-only clock injection).
          transaction: {
            query: (sql, values) =>
              sql === "SELECT clock_timestamp() AS observed_at"
                ? Promise.resolve({
                    rows: [{ observed_at: new Date(Date.parse(R2.batch.submittedAt) + 1000) }],
                    rowCount: 1,
                  })
                : tx.query(sql, values),
          },
          snapshot: snapshot2,
          capacityLink: link2,
          checkoutValidationEvidence: evidence2,
        }),
      );
      assert.equal(submitted.status, "Created");

      clock = now();
      const sent2 = await send(R2.batch.submissionReference, tableGuest);
      assert.equal(sent2.status, "Confirmed");
      const c2 = sent2.confirmation;
      assert.equal(String(c2.orderBatchReference), R2.batch.orderBatchReference);
      const event2 = await transactions({ guc: true }).run((tx) =>
        loadOutboxEnvelope(tx, c2.orderConfirmedEventReference),
      );
      assert.equal(event2.causationId, c2.acceptanceReference);
      const source2 = await kitchenSource(c2, event2);
      assert.ok(source2, "the kitchen resolves the later pay-later round");
      assert.equal(String(source2.orderBatchReference), R2.batch.orderBatchReference);

      // ── A pay-later round is never closed as "not paid in time" (nor any accepted round).
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) SELECT $1,$2,$3,b.brand_id,b.store_id,b.order_id,b.order_batch_id,b.submission_id,$4,NULL,NULL,3,4,b.submission_id,$5,$6,ARRAY(SELECT i.order_item_id FROM rms_ordering.order_item i WHERE i.order_batch_id=b.order_batch_id),$7,'Cancelled','STAFF_CANCELLED_UNPAID' FROM rms_ordering.order_batch b WHERE b.order_batch_id=$8",
          [
            fresh(),
            fresh(),
            tenant,
            id(0x2010),
            inventoryWorkflow.payment.workflowVersionReference,
            id(0x9999),
            now(),
            R2.batch.orderBatchReference,
          ],
        ),
        /pay-later round cannot expire unpaid/u,
      );

      // ── Append-only, and another Store of the Brand sees none of it.
      await assert.rejects(
        admin.query("UPDATE rms_ordering.order_pay_later_confirmation SET confirmed_at=now()"),
        /append-only/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_ordering.order_pay_later_confirmation"),
        /append-only/u,
      );
      const list = (storeReference) =>
        transactions().run((tx) =>
          createPostgresOrderPayLaterConfirmationStore({
            brandReference: scope.brandReference,
            storeReference,
            quoteVersion: 1,
            sha256,
            authorize: async () => true,
          }).listByOrders({ transaction: tx, orderReferences: [orderReference] }),
        );
      assert.deepEqual(
        (await list(scope.storeReference)).map((entry) => String(entry.orderBatchReference)),
        [R1.batch.orderBatchReference, R2.batch.orderBatchReference],
      );
      assert.deepEqual(await list(id(0x7ff)), []);
    } finally {
      await admin.end();
    }
  });
});

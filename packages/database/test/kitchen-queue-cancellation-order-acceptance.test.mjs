import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createKitchenTicketCreationService,
  createKitchenWorkPlanDigestBinding,
  createPostgresKitchenBatchCancellation,
  createPostgresKitchenQueueReadModel,
  createPostgresKitchenTicketStore,
  parseConfirmedOrderIntakeReceipt,
  parseKitchenWorkPlan,
} from "../../rms/kitchen/src/index.ts";
import {
  createOrderKitchenSourceEvidenceBinding,
  createOrderKitchenSourceLineBinding,
  parseConfirmedOrderKitchenSourceEvidence,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a14e00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const instant = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/**
 * WP-2423 (v15 2026-10-18): the Owner cancelled an order of 11 drinks before the kitchen started
 * it. One staff step wrote 11 Kitchen cancellation rows (ticket versions 2..12). From then on
 * every kitchen board refresh failed: the queue source reader sorted the cancellation rows by
 * their text output column (`result_ticket_version::text`, so "10" < "2" < "9"), took version 9
 * as the latest and refused the ticket (version 12) as inconsistent. The board froze and the
 * KitchenWorkCancelled consumers (which refresh the board) kept retrying.
 *
 * Real owner code under the rendered pilot API and worker grants (NOBYPASSRLS): the Kitchen
 * ticket is created by the Kitchen creation service and Postgres ticket store (worker), cancelled
 * by the Kitchen batch cancellation (API) and the board is refreshed by the Kitchen queue read
 * model with the pilot composition's bounds (API). Test-only stand-ins: the Ordering source
 * evidence and the Kitchen work plan (synthetic, digest-bound like the owners produce them), and
 * the authority decisions.
 */
it("refreshes the kitchen board after one staff step cancels ten or more items of one ticket", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_kq_cancel" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_kqc_" + context.runId,
      worker = "wp2423_kqc_w_" + context.runId;
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

      const tenant = id(1),
        brand = id(2),
        store = id(3);
      let sequence = 0x10000;
      const next = () => id(sequence++);
      const derive = (purpose, identity) => {
        const digest = sha256(purpose + ":" + identity).slice(7);
        return (
          "01a14e01-" +
          digest.slice(0, 4) +
          "-7" +
          digest.slice(4, 7) +
          "-8" +
          digest.slice(7, 10) +
          "-" +
          digest.slice(10, 22)
        );
      };
      const validation = { references: { next, derive }, digests: { sha256 } };

      /** One restricted-role transaction. */
      const as = async (role, work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          const result = await work({
            query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      };

      // ── 1. A confirmed pickup order of 11 drinks becomes one Kitchen ticket of 11 work items.
      const lines = 11;
      const at = {
        captured: instant(-600_000),
        confirmed: instant(-599_000),
        planned: instant(-598_000),
        created: instant(-597_000),
      };
      const receipt = parseConfirmedOrderIntakeReceipt({
        consumerName: "kitchen.confirmed-order:v1",
        consumerVersion: 1,
        sourceEventReference: next(),
        brandReference: brand,
        storeReference: store,
        orderReference: next(),
        orderBatchReference: next(),
        confirmationReference: next(),
        sourceAggregateVersion: 3n,
        sourceSnapshotDigest: sha256("order-snapshot"),
        confirmedAt: at.confirmed,
        correlationReference: next(),
        semanticEventBindingDigest: sha256("semantic-order-confirmed"),
      });
      const items = Array.from({ length: lines }, (_, index) => {
        const draft = {
          orderItemReference: next(),
          orderBatchReference: receipt.orderBatchReference,
          ordinal: index + 1,
          quantity: 1,
          productReference: id(0x500),
          productVersionReference: id(0x501),
          skuReference: id(0x502),
          menuVersionReference: id(0x503),
          localizedDisplayNames: { "en-CA": "TEST Latte" },
          selectedOptions: [],
          customerNote: null,
          lineDigest: sha256("placeholder-line"),
        };
        return { ...draft, lineDigest: sha256(createOrderKitchenSourceLineBinding(draft)) };
      });
      const evidenceDraft = {
        evidenceReference: next(),
        brandReference: brand,
        storeReference: store,
        orderReference: receipt.orderReference,
        orderBatchReference: receipt.orderBatchReference,
        confirmationReference: receipt.confirmationReference,
        sourceEventReference: receipt.sourceEventReference,
        sourceAggregateVersion: receipt.sourceAggregateVersion,
        sourceSnapshotDigest: receipt.sourceSnapshotDigest,
        capturedAt: at.captured,
        evidenceVersion: 1,
        items,
        evidenceDigest: sha256("placeholder-evidence"),
      };
      const evidence = parseConfirmedOrderKitchenSourceEvidence({
        ...evidenceDraft,
        evidenceDigest: sha256(createOrderKitchenSourceEvidenceBinding(evidenceDraft)),
      });
      const station = next(),
        rule = next(),
        preparation = next(),
        plan = next();
      const creation = createKitchenTicketCreationService({
        orderingSource: { resolve: async () => evidence },
        plans: {
          resolve: async ({ source }) => {
            const draftPlan = parseKitchenWorkPlan({
              planReference: plan,
              brandReference: brand,
              storeReference: store,
              orderReference: receipt.orderReference,
              orderBatchReference: receipt.orderBatchReference,
              confirmationReference: receipt.confirmationReference,
              sourceEvidenceDigest: source.sourceEvidenceDigest,
              planVersion: 1,
              generatedAt: at.planned,
              items: source.items.map((item) => ({
                orderItemReference: item.orderItemReference,
                splitOrdinal: 1,
                stationRouting: {
                  stationReference: station,
                  routingRuleReference: rule,
                  routingRuleVersion: 1,
                  routingRuleDigest: sha256("routing-rule"),
                },
                preparation: {
                  preparationReference: preparation,
                  preparationVersion: 1,
                  preparationDigest: sha256("preparation"),
                  instructions: ["Prepare TEST Latte"],
                },
              })),
              planDigest: sha256("placeholder-plan"),
            });
            return parseKitchenWorkPlan({
              ...draftPlan,
              planDigest: sha256(createKitchenWorkPlanDigestBinding(draftPlan)),
            });
          },
        },
        clock: { now: async () => at.created },
        references: { derive },
        digests: { sha256 },
        repository: createPostgresKitchenTicketStore({
          brandReference: brand,
          storeReference: store,
          ...validation,
          authorize: async () => true,
          validateCurrentSource: async () => true,
        }),
      });
      const created = await as(api, (transaction) => creation.create({ receipt, transaction }));
      assert.equal(created.status, "Created");
      const ticket = (
        await admin.query(
          "SELECT kitchen_ticket_id::text AS id,(SELECT count(*)::int FROM rms_kitchen.kitchen_work_item w WHERE w.kitchen_ticket_id=t.kitchen_ticket_id) AS items FROM rms_kitchen.kitchen_ticket t WHERE order_id=$1",
          [receipt.orderReference],
        )
      ).rows[0];
      assert.equal(ticket.items, lines);

      // ── 2. The board as staff see it before the cancellation (pilot composition bounds).
      const lock = (transaction) =>
        transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          brand + ":" + store + ":kitchen_work_queue_v1",
        ]);
      const scope = { brandReference: brand, storeReference: store };
      const board = createPostgresKitchenQueueReadModel({
        source: {
          ...scope,
          maxTickets: 100,
          maxItemsPerTicket: 100,
          maxOperationsPerTicket: 1000,
          retireFinishedAfterMs: 24 * 3_600_000,
          creationValidation: validation,
          lifecycleValidation: validation,
          nextSnapshotReference: next,
          authorize: async () => true,
        },
        maxRows: 10000,
        nextRebuildReference: next,
        authorizeProjection: async () => true,
        authorizeQuery: async () => true,
        ports: {
          authorization: { authorize: async () => true },
          trustedContext: {
            resolveQueryAuthority: async () => ({
              ...scope,
              actorReference: id(0x600),
              observedAt: new Date().toISOString(),
            }),
          },
          transactions: {
            withTransaction: (work) =>
              as(api, async (transaction) => {
                await lock(transaction);
                return work(transaction);
              }),
          },
          tenantContext: { install: async () => undefined },
          locks: { acquireStoreProjection: ({ transaction }) => lock(transaction) },
          references: { nextGenerationReference: next },
          clock: { now: () => new Date().toISOString() },
        },
      });
      assert.equal(await board.refresh(), 1);
      assert.equal(await board.refresh(), 0);

      // ── 3. One staff step cancels all 11 queued items: ticket versions 2..12.
      const manager = id(0x601);
      const cancellation = createPostgresKitchenBatchCancellation({
        ...scope,
        tenantReference: tenant,
        authorize: async (_tx, input) =>
          input.orderReference === receipt.orderReference && input.actorReference === manager,
      });
      const cancelled = await as(api, (transaction) =>
        cancellation.cancel(transaction, {
          orderReference: receipt.orderReference,
          orderBatchReference: receipt.orderBatchReference,
          operationReference: next(),
          orderCancellationReference: next(),
          actorReference: manager,
          cancelledAt: instant(-60_000),
          auditReference: next(),
          eventReference: next(),
          nextReference: next,
        }),
      );
      assert.equal(cancelled.status, "Cancelled");
      assert.equal(cancelled.workItemCount, lines);
      const versions = (
        await admin.query(
          "SELECT array_agg(result_ticket_version::int ORDER BY result_ticket_version) AS v FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
          [ticket.id],
        )
      ).rows[0].v;
      assert.deepEqual(
        versions,
        Array.from({ length: lines }, (_, index) => index + 2),
      );

      // ── 4. The board refreshes (it failed here before the fix) and shows every item cancelled.
      assert.equal(await board.refresh(), 1);
      assert.equal(await board.refresh(), 0);
      const projected = (
        await admin.query(
          "SELECT p.status,count(*)::int AS n FROM rms_kitchen.kitchen_work_queue_projection p JOIN rms_kitchen.kitchen_work_queue_projection_generation g ON g.projection_generation_id=p.projection_generation_id WHERE g.generation_status='Active' AND p.kitchen_ticket_id=$1 GROUP BY 1",
          [ticket.id],
        )
      ).rows;
      assert.deepEqual(projected, [{ status: "Cancelled", n: lines }]);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });
});

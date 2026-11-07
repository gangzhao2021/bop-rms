import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPaymentReconciliationService,
  createPostgresPaymentReconciliationExceptionDetailReader,
  createPostgresPaymentReconciliationExceptionSource,
  createPostgresPaymentReconciliationRepository,
  createPostgresPaymentReconciliationResolvedDifferenceCount,
} from "../../rms/payment/src/index.ts";
import { mapInternalReconciliationSource } from "../../../tooling/environment/pilot-reconciliation-projection.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a2e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
const reasons = ["StateMismatch", "AmountMismatch", "RefundMismatch", "TerminalConflict"];

/**
 * WP-2423 (2026-10-17): a single payment's reconciliation difference (Operational check) is resolved
 * when a later check of the same payment finds the Payment records and the Provider agreeing again;
 * a payment that still differs keeps its difference open, and a payment that differs again after
 * the resolution opens a new, visible difference. Run as the pilot api role (NOBYPASSRLS) under the
 * rendered pilot grants.
 */
it("resolves a payment's difference on a matching re-check, keeps a still-different one open and reopens a new one", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_op_resolution" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_opr_" + context.runId,
      worker = "wp2423_opr_w_" + context.runId;
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
      const run = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query("SET LOCAL lock_timeout='5s'");
          const result = await work({
            query: (sql, values = []) => client.query(sql, [...values]),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const scope = { brandReference: id(2), storeReference: id(3) };
      let sequence = 5000;
      const repository = createPostgresPaymentReconciliationRepository({
        scope,
        transactions: { run },
        authorize: async () => true,
        resolutions: { nextReference: () => id(++sequence) },
      });
      const resolvedDifferences = createPostgresPaymentReconciliationResolvedDifferenceCount({
        scope,
        authorize: async () => true,
      });
      // Payment P1 (refund difference) and P2 (amount difference). The Provider's view per payment.
      const payments = {
        [id(10)]: { attempt: id(11), provider: { captured: 1130n, refunded: 500n } },
        [id(20)]: { attempt: id(21), provider: { captured: 1200n, refunded: 0n } },
      };
      const candidate = (intent, refunded, captured = 1130n) => ({
        ...scope,
        candidateReference: intent,
        paymentIntentReference: intent,
        paymentAttemptReference: payments[intent].attempt,
        orderReference: id(intent === id(10) ? 12 : 22),
        providerAccountReference: id(7),
        providerIntentReference: "pi_TEST_" + intent.slice(-8),
        environment: "Test",
        paymentMethod: "OnlineCard",
        captureMode: "Automatic",
        internalStatus: "Captured",
        requestedAmount: money(captured),
        capturedAmount: money(captured),
        refundedAmount: money(refunded),
        lastObservedAt: new Date(Date.now() - 60_000).toISOString(),
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const reconcile = async (runReference, candidates, scheduledAt = new Date().toISOString()) =>
        createPaymentReconciliationService({
          authorization: { authorize: async () => true },
          lease: { claim: async () => true, release: async () => undefined },
          repository,
          candidates: {
            claimOperational: async () => candidates,
            claimDailySettlement: async () => [],
          },
          provider: {
            retrieveIntent: async (request) => {
              const intent = Object.keys(payments).find(
                (key) => payments[key].attempt === request.context.paymentAttemptReference,
              );
              const p = payments[intent].provider;
              return {
                kind: "Snapshot",
                context: request.context,
                providerIntentReference: request.providerIntentReference,
                providerTransactionReference: "ch_TEST_" + intent.slice(-8),
                paymentMethod: "OnlineCard",
                captureMode: "Automatic",
                status: "Captured",
                requestedAmount: money(p.captured),
                authorizedAmount: money(p.captured),
                capturedAmount: money(p.captured),
                refundedAmount: money(p.refunded),
                observedAt: new Date(Date.now() - 1).toISOString(),
                evidenceDigest: "sha256:" + "a".repeat(64),
              };
            },
          },
          observations: { record: async () => assert.fail("no observation") },
          terminal: {
            occurrence: async () => assert.fail("no terminal"),
            record: async () => assert.fail("no terminal"),
          },
          references: {
            generate: () => id(++sequence),
            // As the pilot runtime: a new identity per earlier resolved difference (generation).
            exceptionFor: async ({ candidateReference, reason }) => {
              const generation = await run((tx) =>
                resolvedDifferences(tx, { candidateReference, reason }),
              );
              return id(
                (candidateReference === id(10) ? 900 : 950) +
                  10 * generation +
                  reasons.indexOf(reason),
              );
            },
          },
          clock: { now: () => new Date().toISOString() },
        }).run({
          runReference,
          ...scope,
          actorReference: null,
          mode: "Operational",
          purpose: "ReconcilePayments",
          scheduledAt,
          cutoffAt: scheduledAt,
          maxCandidates: 5,
        });
      const count = async (table) =>
        (await admin.query("SELECT count(*)::int AS n FROM rms_payment." + table)).rows[0].n;
      const E0 = id(902), // P1 RefundMismatch, generation 0
        E1 = id(912), // P1 RefundMismatch found again after E0 was resolved, generation 1
        A0 = id(951); // P2 AmountMismatch

      // 1. Our records show no refund; the Provider refunded $5.00: a difference is opened.
      const first = await reconcile(id(800), [candidate(id(10), 0n)]);
      assert.equal(first.result.checks[0].outcome, "Difference");
      assert.equal(first.result.checks[0].differenceReason, "RefundMismatch");
      assert.equal(first.result.exceptions[0].exceptionReference, E0);
      // A Difference check can never resolve it, even written past the owner writer.
      await assert.rejects(
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query(
            "INSERT INTO rms_payment.payment_reconciliation_resolution VALUES ($1,$2,$3,$4,'MatchedOnRecheck',$5,$6,$7,$8)",
            [
              E0,
              scope.brandReference,
              scope.storeReference,
              id(10),
              id(800),
              first.result.checks[0].checkReference,
              first.result.checks[0].checkedAt,
              id(4999),
            ],
          );
        }),
        (error) => error.code === "23514",
      );

      // 2. Checked again, still different (and P2 differs in amount): both stay open.
      await sleep(5);
      const still = await reconcile(id(801), [candidate(id(10), 0n), candidate(id(20), 0n, 1100n)]);
      assert.deepEqual(
        still.result.checks.map((c) => [c.candidateReference, c.outcome, c.differenceReason]),
        [
          [id(10), "Difference", "RefundMismatch"],
          [id(20), "Difference", "AmountMismatch"],
        ],
      );
      assert.equal(still.result.checks[0].exceptionReference, E0);
      assert.equal(await count("payment_reconciliation_exception"), 2);
      assert.equal(await count("payment_reconciliation_resolution"), 0);

      // 3. Our records caught up (the refund was recorded): P1 matches and is resolved by this
      // check; P2 still differs in the same run and stays open.
      await sleep(5);
      const matched = await reconcile(id(802), [
        candidate(id(10), 500n),
        candidate(id(20), 0n, 1100n),
      ]);
      const matchCheck = matched.result.checks.find((c) => c.candidateReference === id(10));
      assert.equal(matched.status, "Created");
      assert.equal(matchCheck.outcome, "Matched");
      const resolutions = await admin.query(
        "SELECT s.reconciliation_exception_id::text AS exception,s.reconciliation_check_id::text AS check_id,s.resolved_at,s.resolution,a.action_code,a.target_id::text AS target,a.reason_code FROM rms_payment.payment_reconciliation_resolution s JOIN platform_audit.audit_record a ON a.audit_id=s.audit_id",
      );
      assert.deepEqual(
        resolutions.rows.map(({ resolved_at, ...row }) => ({
          ...row,
          resolvedAt: resolved_at.toISOString(),
        })),
        [
          {
            exception: E0,
            check_id: matchCheck.checkReference,
            resolution: "MatchedOnRecheck",
            action_code: "PAYMENT_RECONCILIATION_DIFFERENCE_RESOLVED",
            target: E0,
            reason_code: "MATCHED_ON_RECHECK",
            resolvedAt: matchCheck.checkedAt,
          },
        ],
      );
      // The same run again is a duplicate and changes nothing; history stays append-only.
      assert.equal(
        (
          await reconcile(
            id(802),
            [candidate(id(10), 500n), candidate(id(20), 0n, 1100n)],
            matched.result.run.scheduledAt,
          )
        ).status,
        "Duplicate",
      );
      assert.equal(await count("payment_reconciliation_resolution"), 1);
      await assert.rejects(
        run((tx) =>
          tx.query(
            "UPDATE rms_payment.payment_reconciliation_resolution SET resolution='MatchedOnRecheck'",
          ),
        ),
      );

      // The Payment owner's exception source, the order-exception projection and the card detail.
      const ownerSources = () =>
        run(async (tx) => {
          const page = await createPostgresPaymentReconciliationExceptionSource({
            scope,
            authorize: async () => true,
          })(tx, { afterExceptionReference: null, limit: 10 });
          const projected = [];
          for (const source of page.items)
            projected.push(
              await mapInternalReconciliationSource(
                source,
                { tenantReference: id(1), ...scope },
                tx,
              ),
            );
          const details = await createPostgresPaymentReconciliationExceptionDetailReader({
            scope,
            authorize: async () => true,
          })(
            tx,
            page.items.map((item) => item.exceptionReference),
          );
          return { items: page.items, projected, details };
        });
      let owner = await ownerSources();
      const byReference = (list, key, reference) => list.find((x) => x[key] === reference);
      assert.deepEqual(
        owner.items.map((item) => [item.exceptionReference, item.state]),
        [
          [E0, "Closed"],
          [A0, "Open"],
        ],
      );
      assert.equal(
        byReference(owner.items, "exceptionReference", E0).closedAt,
        matchCheck.checkedAt,
      );
      assert.equal(
        byReference(owner.items, "exceptionReference", E0).operationsDisposition,
        "Reconciled",
      );
      const projectedE0 = byReference(owner.projected, "sourceReference", E0);
      assert.equal(projectedE0.sourceStatus, "Final");
      assert.equal(projectedE0.resolutionEvidenceReference, matchCheck.checkReference);
      assert.equal(byReference(owner.projected, "sourceReference", A0).sourceStatus, "Open");
      assert.deepEqual(owner.details.get(E0), {
        exceptionReference: E0,
        kind: "Payment",
        openingCheck: null,
        resolution: { resolvedAt: matchCheck.checkedAt, runReference: id(802) },
      });
      assert.equal(owner.details.get(A0).resolution, null);

      // 4. Later a refund is made directly at the Provider ($3.00 more): P1 differs again. That is
      // a new difference (generation 1), open and visible; the resolved one stays history.
      payments[id(10)].provider.refunded = 800n;
      await sleep(5);
      const again = await reconcile(id(803), [candidate(id(10), 500n)]);
      assert.equal(again.result.checks[0].outcome, "Difference");
      assert.equal(again.result.checks[0].exceptionReference, E1);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT reconciliation_exception_id::text AS id,generation FROM rms_payment.payment_reconciliation_exception WHERE candidate_id=$1 ORDER BY generation",
            [id(10)],
          )
        ).rows,
        [
          { id: E0, generation: 0 },
          { id: E1, generation: 1 },
        ],
      );
      owner = await ownerSources();
      assert.equal(byReference(owner.items, "exceptionReference", E0).state, "Closed");
      assert.equal(byReference(owner.items, "exceptionReference", E1).state, "Open");
      assert.equal(byReference(owner.projected, "sourceReference", E1).sourceStatus, "Open");
      assert.equal(owner.details.get(E1).resolution, null);
      // While it is open, no second difference of the same payment and reason can be opened.
      await assert.rejects(
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query(
            "INSERT INTO rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at) VALUES ($1,$2,$3,$4,'RefundMismatch','Error','Open',now())",
            [id(4998), scope.brandReference, scope.storeReference, id(10)],
          );
        }),
        (error) =>
          error.code === "23505" &&
          error.constraint === "payment_reconciliation_exception_stable_unique",
      );
      // A re-check that still differs keeps it open and adds no resolution.
      await sleep(5);
      await reconcile(id(804), [candidate(id(10), 500n)]);
      assert.equal(await count("payment_reconciliation_resolution"), 1);
      assert.equal(await count("payment_reconciliation_exception"), 3);

      // Another Store sees none of it.
      await run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, id(999)],
        );
        for (const table of [
          "payment_reconciliation_resolution",
          "payment_reconciliation_exception",
        ])
          assert.equal(
            (await tx.query("SELECT count(*)::int AS n FROM rms_payment." + table)).rows[0].n,
            0,
          );
      });
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});

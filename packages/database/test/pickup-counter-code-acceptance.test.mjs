import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupCredentialProvider,
  createPickupFulfillmentService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
  createPostgresPickupHandoffStore,
  createPostgresPickupProofIssuer,
  createPostgresPickupProofStore,
  validatePickupProof,
} from "../../rms/fulfillment/src/index.ts";
import { parseKitchenItemReadyEnvelope } from "../../rms/kitchen/src/index.ts";
import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  listStoreCounterOrders,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a0f050-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const derive = (prefix) => (purpose, identity) => {
  const digest = createHash("sha256")
    .update(purpose + identity)
    .digest("hex");
  return (
    prefix +
    "-" +
    digest.slice(0, 4) +
    "-7" +
    digest.slice(4, 7) +
    "-8" +
    digest.slice(7, 10) +
    "-" +
    digest.slice(10, 22)
  );
};
const minutes = (base, n) => new Date(Date.parse(base) + n * 60_000).toISOString();

/**
 * WP-2423 DEC-PICKUP-COUNTER-CODE: a guest reads a six-digit pickup code that staff type at the
 * counter. Owner issuance, checks, lockout and the in-person fallback run as a restricted
 * NOBYPASSRLS role holding exactly the rendered pilot API grants (matrix + Owner-approved
 * additions). Test-only stand-ins: Ordering confirmation evidence and Kitchen ready events are
 * synthetic and applied by the owner client (their own suites cover them); the clock is a
 * controlled past instant so pickup windows can be crossed without waiting; one derivation is
 * forced to repeat a live code to prove the collision guard.
 */
it("issues a unique six-digit code, accepts it once typed, records and locks wrong codes without the code, rejects other stores and expired days, allows the in-person check once locked, and issues no code for a counter order", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_pcode" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_pc_" + context.runId,
      worker = "wp2423_pc_w_" + context.runId;
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

      const brand = id(1),
        storeA = id(2),
        storeB = id(3);
      const t0 = new Date(Math.floor((Date.now() - 4 * 3_600_000) / 1000) * 1000).toISOString();
      let clock = t0;
      const now = () => clock;
      let sequence = 0x10000;
      const reference = () => id(sequence++);

      const transaction = async (role, store, work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          if (role) await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
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
      const asOwner = (store, work) => transaction(null, store, work);
      const asApi = (store, work) => transaction(api, store, work);

      /**
       * Synthetic confirmed pickup Order and Kitchen ready event, applied by the owner services.
       * With `channel`, Ordering's own Order header row (test-only stand-in written by the owner
       * client) says how the order was taken: `Pos` is staff at the counter, `Qr` a guest.
       */
      async function readyPickup(store, n, readyAt, channel = null) {
        const scope = { brandReference: brand, storeReference: store };
        const order = id(0x1000 * n + 1),
          batch = id(0x1000 * n + 2),
          confirmation = id(0x1000 * n + 3),
          eventId = id(0x1000 * n + 4),
          item = id(0x1000 * n + 5);
        const confirmedAt = minutes(readyAt, -10);
        if (channel !== null)
          await asOwner(store, async (tx) => {
            const day = confirmedAt.slice(0, 10);
            await tx.query(
              "INSERT INTO rms_ordering.order_number_allocation (order_id,brand_id,store_id,business_date," +
                "sequence,order_number,allocated_at,business_date_configuration_id," +
                "business_date_configuration_version,business_date_content_digest,time_zone," +
                "business_day_start,business_date_boundary_at,boundary_disambiguation) " +
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00:00',$7,'Exact')",
              [order, brand, store, day, n, String(n), confirmedAt, id(0x1000 * n + 14), sha("d")],
            );
            await tx.query(
              "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date," +
                "order_number,order_type,source_channel,dining_session_id,created_by_actor_id," +
                "submitted_by_actor_id,aggregate_version,canonical_phase,closure_status," +
                "payment_status,created_at) VALUES ($1,$2,$3,$4,$5,'Pickup',$6,NULL,$7,$7,1," +
                "'Submitted','Open','NotReported',$8)",
              [order, brand, store, day, String(n), channel, id(0x1000 * n + 15), confirmedAt],
            );
          });
        const event = parseOrderConfirmedEnvelope({
          eventId,
          eventType: "OrderConfirmed",
          schemaVersion: 1,
          occurredAt: confirmedAt,
          producerModule: "@rms/ordering",
          tenantId: brand,
          storeId: store,
          aggregateType: "Order",
          aggregateId: order,
          aggregateVersion: 2n,
          correlationId: id(0x1000 * n + 6),
          causationId: id(0x1000 * n + 7),
          actor: { type: "System" },
          payload: {
            confirmationReference: confirmation,
            orderReference: order,
            orderBatchReference: batch,
            sourceSnapshotDigest: sha("order" + n),
            confirmedAt,
          },
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        });
        const line = { orderItemReference: item, ordinal: 1, quantity: 1, lineDigest: sha("x") };
        line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
        const raw = {
          evidenceReference: id(0x1000 * n + 8),
          ...scope,
          orderReference: order,
          orderBatchReference: batch,
          confirmationReference: confirmation,
          sourceEventReference: eventId,
          sourceAggregateVersion: 2n,
          sourceSnapshotDigest: sha("order" + n),
          orderType: "Pickup",
          capturedAt: confirmedAt,
          evidenceVersion: 1,
          items: [line],
          evidenceDigest: sha("x"),
        };
        raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
        const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
        const audit = {
          append: ({ record, transaction: tx }) => appendAuditRecordInTransaction(tx, record),
        };
        const created = await asOwner(store, (tx) =>
          createPickupFulfillmentService({
            authorization: { authorize: async () => true },
            orderingSource: { resolve: async () => source },
            references: { derive: derive("01a0f051") },
            digests: { sha256: sha },
            repository: createPostgresPickupFulfillmentStore({
              ...scope,
              sha256: sha,
              authorize: async () => true,
              validateCurrentSource: async () => true,
            }),
            audit,
          }).consume(tx, event),
        );
        assert.equal(created.status, "Created");
        const aggregate = created.effect.aggregate;
        const readiness = createPostgresFulfillmentReadinessStore({
          ...scope,
          sha256: sha,
          now,
          authorize: async () => true,
          validateCurrentSource: async () => true,
        });
        const applied = await asOwner(store, (tx) =>
          createFulfillmentReadinessService({
            authorization: { authorize: async () => true },
            repository: readiness,
            digests: { sha256: sha },
            references: { derive: derive("01a0f052") },
            audit,
          }).consume(
            tx,
            parseKitchenItemReadyEnvelope({
              eventId: id(0x1000 * n + 9),
              eventType: "KitchenItemReady",
              schemaVersion: 1,
              occurredAt: readyAt,
              producerModule: "@rms/kitchen",
              tenantId: brand,
              storeId: store,
              aggregateType: "KitchenOrderItemReadyResult",
              aggregateId: id(0x1000 * n + 10),
              aggregateVersion: 1n,
              correlationId: id(0x1000 * n + 11),
              causationId: id(0x1000 * n + 12),
              actor: { type: "System" },
              payload: {
                kitchenTicketReference: id(0x1000 * n + 13),
                orderReference: order,
                orderBatchReference: batch,
                orderItemReference: aggregate.items[0].orderItemReference,
                readyResultReference: id(0x1000 * n + 10),
                readyQuantity: 1,
                requiredQuantity: 1,
                readyAt,
              },
              redactionClassification: "indirect_identifier",
              replayMetadata: { replaySafe: true },
            }),
          ),
        );
        assert.equal(applied.status, "Applied");
        return { scope, order, fulfillment: aggregate.fulfillmentReference };
      }

      const credentialKeys = [
        { version: 1, derivationKey: randomBytes(32), selectorKey: randomBytes(32) },
      ];
      const credentials = createPickupCredentialProvider(credentialKeys);
      const actor = reference();
      const storeOptions = (store) => ({
        brandReference: brand,
        storeReference: store,
        sha256: sha,
        now,
        authorize: async () => true,
        validateCurrentSource: async () => true,
        appendAudit: (tx, fact) =>
          appendAuditRecordInTransaction(tx, {
            auditId: reference(),
            brandId: brand,
            storeId: store,
            actor: { type: "User", reference: actor },
            actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
            targetType: "Fulfillment",
            targetId: fact.fulfillmentReference,
            beforeSummary: null,
            afterSummary: { operation: fact.kind },
            reasonCode: "PICKUP_PROOF",
            correlationId: fact.correlationReference,
            occurredAt: fact.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Confidential",
            retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
            retentionPolicyVersion: 1,
          }),
      });
      /** Forces the first candidate of the next issue to repeat `code` (collision stand-in). */
      let forcedFirst = null;
      const issuerCredentials = {
        ...credentials,
        deriveCounterCode: (input) =>
          input.index === 0 && forcedFirst !== null
            ? forcedFirst
            : credentials.deriveCounterCode(input),
      };
      const issue = (pickup) =>
        asApi(pickup.scope.storeReference, (tx) =>
          createPostgresPickupProofIssuer({
            store: storeOptions(pickup.scope.storeReference),
            credentials: issuerCredentials,
            pepperVersion: 1,
            nextReference: reference,
            publicOrderReference: () => randomBytes(16).toString("base64url"),
          }).ensureIssued({
            transaction: tx,
            orderReference: pickup.order,
            idempotencyReference: reference(),
            correlationReference: reference(),
          }),
        );
      const proofStore = (store) => createPostgresPickupProofStore(storeOptions(store));
      /** What the customer's order page shows: the code re-derived from its saved row. */
      const guestCode = (pickup) =>
        asApi(pickup.scope.storeReference, async (tx) => {
          const store = proofStore(pickup.scope.storeReference);
          const current = await store.lockByOrder({
            transaction: tx,
            orderReference: pickup.order,
          });
          const saved = await store.currentCounterCode({
            transaction: tx,
            orderReference: pickup.order,
          });
          return saved
            ? credentials.recoverCounterCode({
                brandReference: brand,
                capability: current.capability,
                counterCode: saved,
                observedAt: now(),
              })
            : null;
        });
      /** Staff "Check code", as the Merchant API composes it (the owner store decides). */
      const check = (pickup, typed, idempotencyReference = reference(), store = undefined) =>
        asApi(store ?? pickup.scope.storeReference, async (tx) => {
          const owner = proofStore(store ?? pickup.scope.storeReference);
          const current = await owner.lockByOrder({
            transaction: tx,
            orderReference: pickup.order,
          });
          const selectorHash = credentials.hashCredential({
            brandReference: brand,
            storeReference: store ?? pickup.scope.storeReference,
            fulfillmentReference: pickup.fulfillment,
            purpose: "PickupHandoff",
            kind: "HumanCode",
            pepperVersion: current.capability.pepperVersion,
            credential: typed,
          });
          const record = validatePickupProof({
            source: current.source,
            capability: current.capability,
            selectorHash: current.capability.selectorHash,
            generation: current.capability.generation,
            expectedCapabilityVersion: 1,
            observedAt: now(),
            verificationReference: reference(),
            operationReference: reference(),
            idempotencyReference,
            correlationReference: reference(),
          });
          return owner.verify({
            transaction: tx,
            orderReference: pickup.order,
            selectorHash,
            record: { ...record, verificationMethod: "HumanCode" },
            rejection: { actorReference: actor },
          });
        });
      const codeRows = (fulfillment) =>
        admin
          .query("SELECT * FROM rms_fulfillment.pickup_counter_code WHERE fulfillment_id=$1", [
            fulfillment,
          ])
          .then((result) => result.rows);

      // ── Issue: one code per proof, never repeating a code still valid at the same Store.
      const a1 = await readyPickup(storeA, 1, t0);
      const a2 = await readyPickup(storeA, 2, t0);
      const b1 = await readyPickup(storeB, 3, t0);
      clock = minutes(t0, 1);
      assert.equal((await issue(a1)).status, "Issued");
      const codeA1 = await guestCode(a1);
      assert.match(codeA1, /^[0-9]{6}$/u);
      assert.equal((await codeRows(a1.fulfillment))[0].derivation_index, 0);
      forcedFirst = codeA1;
      assert.equal((await issue(a2)).status, "Issued");
      assert.equal((await issue(b1)).status, "Issued");
      forcedFirst = null;
      // A2's first candidate repeated A1's live code at Store A: it took the next candidate.
      assert.equal((await codeRows(a2.fulfillment))[0].derivation_index, 1);
      const codeA2 = await guestCode(a2);
      assert.notEqual(codeA2, codeA1);
      // Store B may hold the same digits (the collision guard is per Store).
      assert.equal((await codeRows(b1.fulfillment))[0].derivation_index, 0);
      const codeB1 = codeA1;
      // The guard is in the database too: a second live row with the same Store hash is refused.
      const a1Row = (await codeRows(a1.fulfillment))[0];
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_fulfillment.pickup_counter_code SELECT brand_id,store_id,fulfillment_id," +
            "capability_id,generation,derivation_index,pepper_version,$2,$3,issued_at,expires_at," +
            "data_classification FROM rms_fulfillment.pickup_counter_code WHERE fulfillment_id=$1",
          [a2.fulfillment, "f".repeat(64), a1Row.lookup_hash],
        ),
        (error) => error.code === "23505" && error.message === "PICKUP_COUNTER_CODE_COLLISION",
      );
      // Only keyed hashes are stored: no column holds the code.
      for (const row of [...(await codeRows(a1.fulfillment)), ...(await codeRows(a2.fulfillment))])
        assert.equal(Object.values(row).map(String).includes(codeA1), false);

      // ── Typed code: accepted for its own order (spaces/dashes are stripped by the API).
      clock = minutes(t0, 2);
      const accepted = await check(a1, codeA1);
      assert.equal(accepted.status, "Applied");
      assert.equal(accepted.record.verificationMethod, "HumanCode");

      // ── Wrong codes on A2: four rejected and counted, a replay not counted, the fifth locks.
      clock = minutes(t0, 3);
      const wrong = String((Number(codeA2) + 500_001) % 1_000_000).padStart(6, "0");
      for (let n = 1; n <= 4; n++) {
        const result = await check(a2, wrong);
        assert.deepEqual(result, { status: "Rejected", rejections: n, locked: false });
      }
      const replayKey = reference();
      assert.deepEqual(await check(a2, wrong, replayKey), {
        status: "Rejected",
        rejections: 5,
        locked: true,
      });
      assert.deepEqual(await check(a2, wrong, replayKey), {
        status: "Rejected",
        rejections: 5,
        locked: true,
      });
      // A1's code (another order at the same Store) is a wrong code for A2, and the right code is
      // now refused too: staff check the customer in person.
      await assert.rejects(check(a2, codeA2), (error) => error.code === "PICKUP_PROOF_LOCKED");
      assert.deepEqual(await check(a2, codeA1), {
        status: "Rejected",
        rejections: 5,
        locked: true,
      });
      const rejections = (
        await admin.query(
          "SELECT * FROM rms_fulfillment.pickup_code_check_rejection WHERE fulfillment_id=$1 ORDER BY rejection_number",
          [a2.fulfillment],
        )
      ).rows;
      assert.deepEqual(
        rejections.map((row) => [row.rejection_number, row.entry_method, row.checked_by_actor_id]),
        [1, 2, 3, 4, 5].map((n) => [n, "HumanCode", actor]),
      );
      const audits = (
        await admin.query(
          "SELECT action_code,after_summary_json::text AS after,before_summary_json::text AS before FROM platform_audit.audit_record WHERE target_id=$1 AND action_code IN ('PICKUP_PROOF_REJECTED','PICKUP_PROOF_LOCKED') ORDER BY occurred_at,action_code",
          [a2.fulfillment],
        )
      ).rows;
      assert.deepEqual(audits.map((row) => row.action_code).sort(), [
        "PICKUP_PROOF_LOCKED",
        "PICKUP_PROOF_REJECTED",
        "PICKUP_PROOF_REJECTED",
        "PICKUP_PROOF_REJECTED",
        "PICKUP_PROOF_REJECTED",
      ]);
      // The audit says what happened, never the code; a rejection row has no place for one.
      for (const row of audits) {
        assert.match(row.after, /^\{"operation": "(Rejected|Locked)"\}$/u);
        for (const code of [wrong, codeA2, codeA1])
          assert.equal((row.after + row.before).includes(code), false);
      }
      assert.deepEqual(Object.keys(rejections[0]).sort(), [
        "brand_id",
        "capability_id",
        "checked_by_actor_id",
        "correlation_id",
        "data_classification",
        "entry_method",
        "fulfillment_id",
        "generation",
        "pickup_code_check_rejection_id",
        "rejected_at",
        "rejection_number",
        "store_id",
      ]);
      await assert.rejects(
        admin.query(
          "UPDATE rms_fulfillment.pickup_code_check_rejection SET rejection_number=1 WHERE fulfillment_id=$1",
          [a2.fulfillment],
        ),
        /append-only/u,
      );

      // ── Locked: the queue says so, and the in-person check (reason CodeLocked) hands it over.
      const queue = await asApi(storeA, (tx) =>
        createPostgresFulfillmentReadinessStore({
          ...storeOptions(storeA),
          authorizeQueue: async () => true,
        }).listPickupQueue({
          transaction: tx,
          afterFulfillmentReference: null,
          limit: 10,
          includeCompleted: false,
        }),
      );
      const queued = new Map(queue.items.map((item) => [item.fulfillmentReference, item]));
      assert.equal(queued.get(a2.fulfillment)?.codeChecksLocked, true);
      assert.equal("codeChecksLocked" in (queued.get(a1.fulfillment) ?? {}), false);
      const deviceReference = reference(),
        pickupLocationReference = reference();
      const handoffStore = (store) =>
        createPostgresPickupHandoffStore({
          brandReference: brand,
          storeReference: store,
          actorReference: actor,
          sha256: sha,
          now,
          validateCurrentSource: async () => true,
          deriveCompletionReference: (kind, identity) => derive("01a0f053")(kind, identity),
          authorize: async () => true,
          admit: async (_tx, command) =>
            command.deviceReference === deviceReference &&
            command.pickupLocationReference === pickupLocationReference,
          appendAudit: (tx, audit) =>
            appendAuditRecordInTransaction(tx, {
              auditId: audit.auditReference,
              brandId: brand,
              storeId: store,
              actor: { type: "User", reference: audit.actorReference },
              actionCode: audit.actionCode,
              targetType: "Fulfillment",
              targetId: audit.fulfillmentReference,
              afterSummary: { action: "CompletePickupHandoff" },
              reasonCode: "PICKUP_HANDOFF",
              correlationId: audit.correlationReference,
              occurredAt: audit.occurredAt,
              sourceChannel: "MERCHANT_WEB",
              dataClassification: "Confidential",
              retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
              retentionPolicyVersion: 1,
            }),
        });
      const handOver = (pickup, verification) =>
        asApi(pickup.scope.storeReference, async (tx) => {
          const store = handoffStore(pickup.scope.storeReference);
          const current = await store.lockByOrder({
            transaction: tx,
            orderReference: pickup.order,
          });
          return store.complete({
            transaction: tx,
            orderReference: pickup.order,
            command: {
              fulfillmentReference: pickup.fulfillment,
              brandReference: brand,
              storeReference: pickup.scope.storeReference,
              expectedAggregateVersion: current.source.aggregateVersion,
              purpose: "CompletePickupHandoff",
              actorReference: actor,
              actorPermissions: ["fulfillment.pickup.complete"],
              verification: verification(current),
              recipientType: "Customer",
              recipientDisplayMask: "S***",
              pickupLocationReference,
              deviceReference,
              quantities: current.source.items.map((item) => ({
                fulfillmentItemReference: item.fulfillmentItemReference,
                quantity: item.readyQuantity,
              })),
              handoffReference: reference(),
              operationReference: reference(),
              auditReference: reference(),
              idempotencyReference: reference(),
              correlationReference: reference(),
              handedOverAt: now(),
            },
          });
        });
      const inPerson = (pickup, reason) => (current) => {
        assert.equal(current.codeChecksLocked, pickup === a2);
        return {
          verificationReference: reference(),
          correlationReference: reference(),
          fulfillmentReference: pickup.fulfillment,
          brandReference: brand,
          storeReference: pickup.scope.storeReference,
          verificationMethod: "InPerson",
          identityCheck: "OrderNumberAndName",
          reason,
          verifiedByActorReference: actor,
          verifiedAt: now(),
        };
      };
      clock = minutes(t0, 4);
      await assert.rejects(
        handOver(a2, inPerson(a2, "ProofExpired")),
        (error) => error.code === "PICKUP_HANDOFF_VERIFICATION_FAILED",
      );
      assert.equal((await handOver(a2, inPerson(a2, "CodeLocked"))).status, "Applied");
      assert.equal(
        (
          await admin.query(
            "SELECT reason FROM rms_fulfillment.pickup_in_person_verification WHERE fulfillment_id=$1",
            [a2.fulfillment],
          )
        ).rows[0].reason,
        "CodeLocked",
      );
      // A1 (not locked) still refuses an in-person check while its code is valid, and its typed-code
      // verification hands it over.
      await assert.rejects(
        handOver(a1, inPerson(a1, "CodeLocked")),
        (error) => error.code === "PICKUP_HANDOFF_VERIFICATION_FAILED",
      );
      assert.equal((await handOver(a1, () => accepted.record)).status, "Applied");

      // ── Other Store: Store A's rows are invisible there and Store A cannot reach Store B's order.
      clock = minutes(t0, 6);
      assert.equal(
        await asApi(
          storeB,
          async (tx) =>
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_fulfillment.pickup_counter_code WHERE fulfillment_id=$1",
                [a1.fulfillment],
              )
            ).rows[0].n,
        ),
        0,
      );
      await assert.rejects(check(b1, codeB1, reference(), storeA));
      assert.notEqual(
        credentials.hashCredential({
          brandReference: brand,
          storeReference: storeA,
          fulfillmentReference: b1.fulfillment,
          purpose: "PickupHandoff",
          kind: "HumanCode",
          pepperVersion: 1,
          credential: codeB1,
        }),
        (await codeRows(b1.fulfillment))[0].selector_hash,
      );

      // ── Another day: after the pickup window the right code is refused and nothing is counted.
      clock = minutes(t0, 61);
      await assert.rejects(check(b1, codeB1), (error) => error.code === "PICKUP_PROOF_UNAVAILABLE");
      await assert.rejects(guestCode(b1));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_fulfillment.pickup_code_check_rejection WHERE fulfillment_id=$1",
            [b1.fulfillment],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await handOver(b1, inPerson(b1, "ProofExpired"))).status, "Applied");

      // ── A code is free again once the order holding it can no longer use it.
      clock = minutes(t0, 66);
      const a3 = await readyPickup(storeA, 4, minutes(t0, 65));
      forcedFirst = codeA1;
      assert.equal((await issue(a3)).status, "Issued");
      forcedFirst = null;
      assert.equal((await codeRows(a3.fulfillment))[0].derivation_index, 0);

      // ── Counter order (WP-2423): staff took it at the counter, so when it is ready the owner
      // issues no guest code and staff hand it over in person at once; a guest's QR order still
      // gets its code.
      clock = minutes(t0, 70);
      const counter = await readyPickup(storeA, 5, minutes(t0, 69), "Pos");
      const guest = await readyPickup(storeA, 6, minutes(t0, 69), "Qr");
      assert.deepEqual(
        await asApi(storeA, (tx) =>
          listStoreCounterOrders(tx, counter.scope, [counter.order, guest.order]),
        ),
        new Set([counter.order]),
      );
      assert.deepEqual(await issue(counter), { status: "NotApplicable", reason: "CounterOrder" });
      // A replayed ready event is the same no-op.
      assert.equal((await issue(counter)).status, "NotApplicable");
      assert.equal((await issue(guest)).status, "Issued");
      assert.match(await guestCode(guest), /^[0-9]{6}$/u);
      assert.deepEqual(await codeRows(counter.fulfillment), []);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_fulfillment.pickup_proof_generation WHERE fulfillment_id=$1",
            [counter.fulfillment],
          )
        ).rows[0].n,
        0,
      );
      // The queue shows no code for it, and the in-person handover (no code issued) completes it
      // immediately, with no wait for a code to lock or expire.
      const counterQueue = await asApi(storeA, (tx) =>
        createPostgresFulfillmentReadinessStore({
          ...storeOptions(storeA),
          authorizeQueue: async () => true,
        }).listPickupQueue({
          transaction: tx,
          afterFulfillmentReference: null,
          limit: 10,
          includeCompleted: false,
        }),
      );
      const counterItem = counterQueue.items.find(
        (value) => value.fulfillmentReference === counter.fulfillment,
      );
      assert.equal(counterItem?.phase, "Ready");
      assert.equal(counterItem?.proof, null);
      const handedOver = await handOver(counter, inPerson(counter, "ProofNotIssued"));
      assert.equal(handedOver.status, "Applied");
      assert.equal(handedOver.effect.nextPhase, "Completed");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_fulfillment.fulfillment_completion_publication WHERE fulfillment_id=$1",
            [counter.fulfillment],
          )
        ).rows[0].n,
        1,
      );
      // The guest's QR order still refuses an in-person check while its code is valid.
      await assert.rejects(
        handOver(guest, inPerson(guest, "ProofNotIssued")),
        (error) => error.code === "PICKUP_HANDOFF_VERIFICATION_FAILED",
      );
    } finally {
      await admin.end();
    }
  });
});

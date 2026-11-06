import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createDiningCheckoutService,
  createDiningTable,
  createPostgresDiningCheckoutCommitmentStore,
  createPostgresDiningCheckoutHoldSource,
  createPostgresDiningGuestBindingStore,
  parseDiningIdentityAdmission,
} from "../../rms/dining/src/index.ts";
import {
  createPaymentTipSelectionService,
  createPostgresPaymentTipSelectionStore,
} from "../../rms/payment/src/index.ts";
import { createMerchantDiningTableMove } from "../../../apps/api/src/merchant-dining-table-move.ts";
import { createTableMovedLatch } from "../../../apps/api/src/customer-dining-table-moved.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { journeyRound, seedJourneyDining } from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
let references = 0xc000;
/** Fresh UUIDv7 whose timestamp prefix is the current instant. */
const fresh = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2") +
  "-7000-8000-" +
  (references++).toString(16).padStart(12, "0");
const now = () => new Date().toISOString();
const minutes = (n) => n * 60_000;

/**
 * WP-2423 table-move-send (v15 fabf0261, 2026-11-06, Lane Dessert): a guest started paying for a
 * round at Table 6, staff moved the party to Table 2, and every payment try answered "payment
 * unavailable" (503, 14 times) until the checkout lapsed; another guest at the new table would
 * also have been told someone else was paying for a minute. Under the restricted NOBYPASSRLS API
 * role holding the rendered pilot grants, with the merchant Move command:
 * - Dining's checkout service refuses the round prepared at the old table as "table moved";
 * - Payment's tip selection, asking Dining from its authorization port through the API's latch
 *   (as `customer-dining-tip-selection-composition` wires it), refuses with the same meaning and
 *   writes no tip selection and no audit row, also when the Move lands between Payment's two checks
 *   (after it built its audit record in memory, before it writes);
 * - the round's commitment history stays exactly [Prepared v1]; it has no payment, so it lapses;
 * - another guest at the new table checks out the same Cart version at once (no hold), while the
 *   same round still holds the Cart before any move (the hold is not weakened).
 * The API's tip composition and order submission paths over these owners are unit-tested in
 * apps/api (customer-dining-tip-selection-composition.test.ts,
 * customer-dining-order-submission-composition.test.ts).
 */
it("a round prepared at a table the party then leaves is refused as table moved, nothing is written, and the table checks out again at once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_mvsend" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_mvs_" + context.runId,
      worker = "wp2423_mvs_w_" + context.runId;
    assert.match(api, /^wp2423_mvs_[a-f0-9]+$/u);
    vi.stubEnv("NODE_ENV", "development");
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
      const R = journeyRound({ at: time(-minutes(10)), prefix: "01a00011" });
      const scope = R.f.scope;
      const tenant = scope.brandReference.slice(0, 24) + "000000000900";
      const ownerScope = { tenantReference: tenant, ...scope };
      const one = async (sql, values = []) => (await admin.query(sql, values)).rows;

      /** One restricted-role transaction on its own connection (the pilot's grants). */
      const transactions = () => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query("SET LOCAL statement_timeout='20s'");
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : values),
            });
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

      // ── Table A: the Host and a second guest, each admitted at A (owner seeds).
      const dining = await seedJourneyDining({
        client: admin,
        scope: ownerScope,
        round: R,
        startedAt: time(-minutes(30)),
        guestParticipant: scope.storeReference.slice(0, 24) + "000000000601",
      });
      const tableA = dining.table.tableReference;
      const guestSessions = new Map([
        [dining.host.participantReference, fresh()],
        [dining.guest.participantReference, fresh()],
      ]);
      for (const participant of [dining.host, dining.guest]) {
        const admission = parseDiningIdentityAdmission({
          admissionReference: fresh(),
          diningSessionReference: dining.session.diningSessionReference,
          participantReference: participant.participantReference,
          storeReference: scope.storeReference,
          tableReference: tableA,
          tableAssignmentVersion: dining.session.tableAssignmentVersion,
          operationReference: fresh(),
          operationIntentHash: "a".repeat(64),
          status: "Consumed",
          version: 2,
          issuedAt: participant.joinedAt,
          consumedAt: time(-minutes(29)),
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,2,'Consumed',$7::jsonb)",
          [
            admission.admissionReference,
            tenant,
            scope.brandReference,
            scope.storeReference,
            admission.diningSessionReference,
            admission.participantReference,
            JSON.stringify(admission),
          ],
        );
      }
      // ── The Store's other free tables (owner seed, TEST labels).
      const freeTable = async (suffix, label) => {
        const reference = scope.storeReference.slice(0, 24) + "0000000" + suffix;
        const table = createDiningTable({
          ...ownerScope,
          tableReference: reference,
          stableLabel: label,
          areaReference: dining.table.areaReference,
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle: "Published",
          qrStatus: "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: null,
          aggregateVersion: 1,
          createdAt: time(-minutes(60)),
          observedAt: time(-minutes(60)),
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [
            reference,
            tenant,
            scope.brandReference,
            scope.storeReference,
            JSON.stringify(table),
            time(-minutes(60)),
          ],
        );
        return reference;
      };
      const tableB = await freeTable("0b001", "TEST-B");
      const tableC = await freeTable("0c001", "TEST-C");

      // ── Staff (front of house) move the party with the merchant Move command.
      const staffSession = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions(),
        scope: ownerScope,
        actor: scope.storeReference.slice(0, 24) + "000000000700",
        at: now(),
        extraPermissions: ["dining.operate"],
      });
      const tableVersion = async (table) =>
        Number(
          (await one("SELECT version FROM rms_dining.dining_table WHERE table_id=$1", [table]))[0]
            .version,
        );
      // TEST-ONLY dining credentials (the pilot's are internal, keyed per environment).
      const joinKey = randomBytes(32);
      const move = async (from, to) => {
        const result = await createMerchantDiningTableMove({
          persistence: { ...staffSession.persistence, now },
          authentication: staffSession.authentication,
          newReference: fresh,
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          credentials: {
            generateReference: fresh,
            generateJoinCredential: (kind) =>
              kind === "HumanCode"
                ? String(randomInt(0, 1000000)).padStart(6, "0")
                : randomBytes(16).toString("base64url"),
            hashJoinCredential: (kind, value) =>
              createHmac("sha256", joinKey).update(`DiningJoin:${kind}:${value}`).digest("hex"),
            hashOperationIntent: (value) => createHash("sha256").update(value).digest("hex"),
            equals: (a, b) => a === b,
          },
          pepperVersion: 1,
        })({
          sessionCookie: staffSession.sessionCookie,
          csrf: staffSession.csrf,
          command: {
            action: "Move",
            operationReference: fresh(),
            tableReference: from,
            expectedTableVersion: await tableVersion(from),
            targetTableReference: to,
            expectedTargetTableVersion: await tableVersion(to),
          },
        });
        assert.equal(result.status, "Applied");
        assert.equal(result.tableReference, to);
      };

      // ── Dining's checkout service as the API composes it, under the pilot role. The guest's
      // phone follows its party (Identity's QR context names the table the session sits at).
      const seatedTable = async () =>
        (
          await one("SELECT table_id FROM rms_dining.dining_session WHERE session_id=$1", [
            dining.session.diningSessionReference,
          ])
        )[0].table_id;
      const diningAudit = ({ record, observedAt }) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DINING_CHECKOUT_PREPARE",
        targetType: "DiningCheckoutCommitment",
        targetId: record.commitmentReference,
        reasonCode: "AUTHORIZED_DINING_CHECKOUT",
        correlationId: record.commitmentReference,
        occurredAt: observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const checkout = (participant) =>
        createDiningCheckoutService({
          scope,
          now,
          hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
          authorization: {
            authorize: async (request) => ({
              guestSessionReference: guestSessions.get(participant.participantReference),
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              diningSessionReference: dining.session.diningSessionReference,
              participantReference: participant.participantReference,
              tableReference: await seatedTable(),
              identityVersion: 2,
              expiresAt: time(minutes(120)),
              observedAt: request.observedAt,
            }),
          },
          current: createPostgresDiningGuestBindingStore(transactions(), ownerScope),
          repository: createPostgresDiningCheckoutCommitmentStore(transactions(), ownerScope, {
            now,
          }),
          audit: { create: async (request) => diningAudit(request) },
        });
      const cartReference = R.batch.sourceCartReference,
        cartVersion = R.batch.sourceCartVersion;
      const round = (participant) => ({
        commitmentReference: fresh(),
        guestSessionReference: guestSessions.get(participant.participantReference),
        diningSessionReference: dining.session.diningSessionReference,
        participantReference: participant.participantReference,
        cartReference,
        cartVersion,
        quoteReference: fresh(),
        submissionReference: fresh(),
        orderReference: R.f.request.record.order.orderReference,
        orderBatchReference: fresh(),
        paymentOperationReference: fresh(),
        sourceValidUntil: time(minutes(5)),
      });
      const holdFor = (participant) =>
        createPostgresDiningCheckoutHoldSource(transactions(), ownerScope).read({
          diningSessionReference: dining.session.diningSessionReference,
          cartReference,
          cartVersion,
          participantReference: participant.participantReference,
          observedAt: now(),
        });

      // ── Payment's tip selection, asking Dining from its authorization port through the latch.
      const tipAudit = (record) => ({
        auditId: fresh(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TIP_SELECT",
        targetType: "PaymentTipSelection",
        targetId: record.selectionReference,
        reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
        correlationId: record.submissionReference,
        occurredAt: record.selectedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const selectTip = async (participant, command, { duringAudit = async () => {} } = {}) => {
        const tableMoved = createTableMovedLatch();
        try {
          return await createPaymentTipSelectionService({
            scope,
            clock: { now },
            repository: createPostgresPaymentTipSelectionStore(transactions(), scope, { now }),
            audit: {
              create: async (record) => {
                await duringAudit();
                return tipAudit(record);
              },
            },
            authorization: {
              async authorize(request) {
                if (request.action === "SelectPaymentTip") {
                  const prepared = await tableMoved.watchOrNull(() =>
                    checkout(participant).prepareForOrdering(command),
                  );
                  if (prepared === null) return null;
                }
                return {
                  ...scope,
                  guestSessionReference: command.guestSessionReference,
                  sessionVersion: 2,
                  validUntil: time(minutes(120)),
                };
              },
            },
          }).select({
            selectionReference: fresh(),
            paymentOperationReference: command.paymentOperationReference,
            submissionReference: command.submissionReference,
            cartReference: command.cartReference,
            cartVersion: command.cartVersion,
            quoteReference: command.quoteReference,
            tip: { amountMinor: 0n, currencyCode: "CAD" },
          });
        } catch (error) {
          return tableMoved.rethrow(error);
        }
      };
      const written = async () =>
        (
          await one(
            "SELECT (SELECT count(*)::int FROM rms_payment.payment_tip_selection) AS tips,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_TIP_SELECT') AS tip_audits",
          )
        )[0];
      const historyOf = async (commitmentReference) =>
        (
          await one(
            "SELECT version::int AS version,state,record_json->>'tableReference' AS table FROM rms_dining.dining_checkout_commitment WHERE commitment_id=$1 ORDER BY version",
            [commitmentReference],
          )
        ).map((row) => [row.version, row.state, row.table]);

      // ── The second guest starts paying for the table's round at A.
      const guestRound = round(dining.guest);
      const prepared = await checkout(dining.guest).prepareForOrdering(guestRound);
      assert.equal(prepared.status, "Created");
      assert.equal(prepared.record.tableReference, tableA);
      // Before any move the round holds the table's Cart version against the Host (unchanged).
      await assert.rejects(checkout(dining.host).prepareForOrdering(round(dining.host)), {
        code: "DINING_CHECKOUT_HELD",
      });
      assert.notEqual(await holdFor(dining.host), null);

      // ── Staff move the party from A to B.
      await move(tableA, tableB);
      const before = await written();

      // Dining: the round can't be sent from the table its party left; it says so.
      await assert.rejects(checkout(dining.guest).prepareForOrdering(guestRound), {
        name: "DiningCheckoutServiceError",
        code: "DINING_CHECKOUT_TABLE_MOVED",
      });
      // Payment: choosing the tip answers "table moved" (409 payment_table_moved at the route),
      // not "payment unavailable"; nothing is written.
      await assert.rejects(selectTip(dining.guest, guestRound), {
        name: "OrderCreationError",
        code: "ORDER_CREATE_TABLE_MOVED",
      });
      assert.deepEqual(await written(), before);
      assert.deepEqual(await historyOf(guestRound.commitmentReference), [[1, "Prepared", tableA]]);

      // ── The Host checks out the same Cart version at B at once: no one else is paying.
      const hostRound = round(dining.host);
      const hostPrepared = await checkout(dining.host).prepareForOrdering(hostRound);
      assert.equal(hostPrepared.status, "Created");
      assert.equal(hostPrepared.record.tableReference, tableB);
      // Cart edits and quotes (the advisory hold read) see no other guest paying either.
      assert.equal(await holdFor(dining.host), null);
      // ... and that round, current at B, does hold the Cart against the guest.
      assert.notEqual(await holdFor(dining.guest), null);

      // ── Staff move the party again while Payment is between its two checks (it has built its
      // audit record in memory, it has not written): still refused, still nothing written.
      let movedDuringAudit = false;
      await assert.rejects(
        selectTip(dining.host, hostRound, {
          duringAudit: async () => {
            movedDuringAudit = true;
            await move(tableB, tableC);
          },
        }),
        { name: "OrderCreationError", code: "ORDER_CREATE_TABLE_MOVED" },
      );
      assert.equal(movedDuringAudit, true);
      assert.deepEqual(await written(), before);
      assert.deepEqual(await historyOf(hostRound.commitmentReference), [[1, "Prepared", tableB]]);
      // No payment exists for either abandoned round: nothing can be charged; they lapse.
      assert.deepEqual(
        await one(
          "SELECT count(*)::int AS intents FROM rms_payment.payment_intent WHERE payment_operation_id = ANY($1::uuid[])",
          [[guestRound.paymentOperationReference, hostRound.paymentOperationReference]],
        ),
        [{ intents: 0 }],
      );
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createGuestSession } from "../../bop/identity/src/index.ts";
import {
  createDiningTable,
  parseDiningParticipant,
  parseDiningSession,
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  CartError,
  createDiningCartSelectionService,
  createPostgresDiningCartReplacementStore,
  createPostgresDiningCartSelectionStore,
  createPostgresDiningCartSuccessionSource,
} from "../../rms/ordering/src/index.ts";
import {
  EARLIER_CART_ITEMS_CLEARED,
  createCustomerDiningCartPort,
} from "../../../apps/api/src/customer-dining-cart-composition.ts";
import { fenceDiningCartReplacement } from "../../../apps/api/src/dining-cart-replacement-authorization.ts";
import { createDiningCartReplacementSettlement } from "../../../apps/api/src/dining-cart-replacement-settlement.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a7c3-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const [tenant, brand, store] = [1, 2, 3].map(id);
const scope = { tenantReference: tenant, brandReference: brand, storeReference: store };
const ownerScope = { brandReference: brand, storeReference: store };
const minutes = (n) => n * 60_000;
const credential = (n) => "G".repeat(40) + String(n).padStart(3, "0");

/**
 * WP-2423 (coordinator decision 2026-10-11): a dine-in table whose shared Cart timed out keeps
 * ordering. Selection, the succession read, the replacement writer, the Dining participant/Host
 * fences and settlement run as a restricted NOBYPASSRLS role holding exactly the rendered pilot API
 * grants. Test-only stand-ins: Guest Identity (credential -> current guest record) and the Cart
 * display read (catalog presentation); seeded Dining/Cart facts are written by the database owner
 * with triggers and foreign keys skipped (CHECK constraints still apply).
 */
it("replaces a timed-out table Cart for any current participant, once, and keeps Abandoned/closed refusals", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cart_cont" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_cc_" + context.runId,
      worker = "wp2423_cc_w_" + context.runId;
    assert.match(role, /^wp2423_cc_[a-f0-9]+$/u);
    try {
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (offset) => new Date(base + offset).toISOString();
      let last = base;
      const now = () => {
        last = Math.max(last, Date.now());
        return new Date(last).toISOString();
      };
      let sequence = 5000;
      const reference = () => id(++sequence);

      // Dining facts: S1 (host H, participant P, former participant R), S2 (Abandoned Cart,
      // host H2, participant P2), S3 closed (participant P3), S4 (only a former participant R4).
      const startedAt = time(-minutes(180));
      const seedSession = async (n, phase, host, participants) => {
        const session = parseDiningSession({
          diningSessionReference: id(n + 1),
          brandReference: brand,
          storeReference: store,
          tableReference: id(n),
          tableAssignmentVersion: 1,
          phase,
          version: 2,
          startedByActorReference: id(n + 9),
          startedAt,
          hostParticipantReference: host,
        });
        const table = createDiningTable({
          ...scope,
          tableReference: id(n),
          stableLabel: "SYNTHETIC-" + n,
          areaReference: id(900),
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle: "Published",
          qrStatus: "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: phase === "Active" ? session.diningSessionReference : null,
          aggregateVersion: 1,
          createdAt: startedAt,
          observedAt: startedAt,
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [table.tableReference, tenant, brand, store, JSON.stringify(table), startedAt],
        );
        await admin.query(
          "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,$6,$7::jsonb,$8)",
          [
            session.diningSessionReference,
            tenant,
            brand,
            store,
            table.tableReference,
            phase,
            JSON.stringify(session),
            startedAt,
          ],
        );
        for (const [participantReference, status] of participants) {
          const participant = parseDiningParticipant({
            participantReference,
            diningSessionReference: session.diningSessionReference,
            status,
            version: status === "Left" ? 2 : 1,
            joinedAt: startedAt,
            leftAt: status === "Left" ? time(-minutes(150)) : null,
          });
          await admin.query(
            "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,$8,$6,$7::jsonb)",
            [
              participantReference,
              tenant,
              brand,
              store,
              session.diningSessionReference,
              status,
              JSON.stringify(participant),
              participant.version,
            ],
          );
        }
        return session.diningSessionReference;
      };
      const [H, P, R, H2, P2, H3, P3, H4, R4] = [12, 13, 14, 22, 23, 32, 33, 42, 44].map(id);
      // Cart timed out an hour after its last change (recorded by the expiry owner), or abandoned.
      const createdAt = time(-minutes(150)),
        idleAt = time(-minutes(90)),
        expiredAt = time(-minutes(85)),
        abandonedAt = time(-minutes(100));
      const seedCart = async (cart, session, status, lines, addedBy = null) => {
        await admin.query(
          `INSERT INTO rms_ordering.cart (cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at,terminal_at,terminal_reason)
           VALUES ($1,$2,$3,'DineIn','Qr',$4,$5,3,$6,$7,$8,$9,$10,3600,86400,$11,$12,$7,$13)`,
          [
            cart,
            brand,
            store,
            session,
            id(800),
            createdAt,
            status === "Expired" ? expiredAt : abandonedAt,
            status,
            id(801),
            "sha256:" + "a".repeat(64),
            idleAt,
            time(-minutes(150) + minutes(1440)),
            status === "Expired" ? "IDLE_TIMEOUT" : "CUSTOMER_ABANDONED",
          ],
        );
        for (let line = 0; line < lines; line += 1)
          await admin.query(
            `INSERT INTO rms_ordering.cart_line (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at,customer_note,catalog_selection_evidence_json)
             VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$9,$7,NULL,$8::jsonb)`,
            [
              id(cart === id(100) ? 110 + line : 120 + line),
              cart,
              brand,
              store,
              id(802),
              id(800),
              createdAt,
              JSON.stringify({
                menuVersionReference: id(803),
                productVersionReference: id(804),
                catalogChannelCode: "CUSTOMER_PWA",
                catalogOrderTypeCode: "DINE_IN",
                ruleEvidence: [],
                validatedAt: createdAt,
              }),
              addedBy,
            ],
          );
      };
      await admin.query("SET session_replication_role = replica");
      let S1, S2, S3, S4;
      try {
        S1 = await seedSession(10, "Active", H, [
          [H, "Active"],
          [P, "Active"],
          [R, "Left"],
        ]);
        S2 = await seedSession(20, "Active", H2, [
          [H2, "Active"],
          [P2, "Active"],
        ]);
        S3 = await seedSession(30, "Closed", H3, [
          [H3, "Active"],
          [P3, "Active"],
        ]);
        S4 = await seedSession(40, "Active", H4, [
          [H4, "Active"],
          [R4, "Left"],
        ]);
        await seedCart(id(100), S1, "Expired", 2, H);
        await seedCart(id(200), S2, "Abandoned", 0);
        await seedCart(id(300), S3, "Expired", 0);
        await seedCart(id(400), S4, "Expired", 1, H4);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            await client.query("SET LOCAL lock_timeout='5s'");
            await client.query("SET LOCAL statement_timeout='10s'");
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const audit = (actionCode, reasonCode) => (d) => ({
        auditId: reference(),
        brandId: brand,
        storeId: store,
        actor: { type: "System" },
        actionCode: actionCode ?? "ORDERING_DINING_CART_" + d.action.toUpperCase(),
        targetType: "OrderingCart",
        targetId: d.cartReference,
        reasonCode,
        correlationId: d.operationReference,
        occurredAt: d.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const policy = {
        policyVersionReference: id(801),
        policyDigest: "sha256:" + "a".repeat(64),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: time(-minutes(1440)),
        validUntil: time(minutes(1440)),
      };
      // Test-only Identity stand-in: credential -> current Dining-bound guest record.
      const guests = new Map();
      const guest = (n, session, participant) => {
        guests.set(credential(n), {
          sessionReference: id(600 + n),
          status: "Active",
          version: 1,
          brandReference: brand,
          storeReference: store,
          publicStoreReference: id(700),
          publicTableReference: id(701),
          channel: "DineIn",
          locale: "en-CA",
          qrReference: id(702),
          qrRevocationVersion: 1,
          diningState: "DiningBound",
          diningSessionReference: session,
          diningParticipantReference: participant,
          createdAt: time(-minutes(170)),
          lastSeenAt: time(-minutes(1)),
          idleExpiresAt: time(-minutes(1) + minutes(240)),
          absoluteExpiresAt: time(-minutes(170) + minutes(1440)),
          orderClosedAt: null,
          closureExpiresAt: null,
          rotatedFromGuestSessionReference: null,
          revocationReason: null,
          revokedAt: null,
        });
        return credential(n);
      };
      const selection = createDiningCartSelectionService({
        scope: ownerScope,
        now,
        sessions: {
          resolve: async (input) => {
            const record = guests.get(input.sessionCredential);
            if (record === undefined) throw new CartError("CART_PERMISSION_DENIED");
            return createGuestSession(record);
          },
        },
        participation: createDiningCartParticipationQuery({
          scope: ownerScope,
          repository: createPostgresDiningParticipationStore(runner, scope),
          now,
        }),
        selection: createPostgresDiningCartSelectionStore(runner, {
          scope: ownerScope,
          sourceChannel: "Qr",
          policy,
          generateReference: reference,
          now,
          audit: audit(null, "AUTHORIZED_CART_SELECTION"),
        }),
      });
      const settlement = createDiningCartReplacementSettlement({
        scope: { ...ownerScope, providerAccountReference: id(703), environment: "Test" },
        now,
        authorize: async () => true,
      });
      const writer = createPostgresDiningCartReplacementStore(runner, {
        scope: ownerScope,
        policy,
        generateReference: reference,
        now,
        audit: audit("ORDERING_DINING_CART_REPLACE", "AUTHORIZED_CART_REPLACEMENT"),
        authorizeAndFence: (tx, command) =>
          fenceDiningCartReplacement({ run: (work) => work(tx) }, scope, command, now()),
        settlementClear: (tx, cart, at) => settlement.clear(tx, cart, at),
      });
      const replaceAs = (cred, input) => {
        const record = guests.get(cred);
        return writer.replace({
          ...ownerScope,
          operationReference: input.operationReference,
          diningSessionReference: record.diningSessionReference,
          guestSessionReference: record.sessionReference,
          participantReference: record.diningParticipantReference,
          previousCartReference: input.previousCartReference,
          expectedCartVersion: input.expectedCartVersion,
          observedAt: now(),
        });
      };
      const succession = createPostgresDiningCartSuccessionSource(runner, ownerScope);
      const port = createCustomerDiningCartPort({
        selection: {
          select: (command) =>
            selection.select({
              sessionCredential: command.sessionCredential,
              operationReference: command.operationReference,
            }),
        },
        // Test-only presentation stand-in: the receipt's Cart as an empty Active view.
        query: {
          read: async ({ cartReference }) => ({
            schemaVersion: 1,
            cart: {
              cartReference,
              version: 1,
              orderType: "DineIn",
              serviceMode: "DineIn",
              context: { brandName: "Synthetic", storeName: "Synthetic" },
              lifecycle: { status: "Active", idleExpiresAt: time(60), absoluteExpiresAt: time(60) },
              items: [],
              quote: null,
              warnings: [],
            },
          }),
        },
        continuation: {
          previous: async ({ sessionCredential }) =>
            succession.previous({
              diningSessionReference: guests.get(sessionCredential).diningSessionReference,
            }),
          replacement: {
            replace: (input) => replaceAs(input.sessionCredential, input),
          },
        },
      });
      const create = (cred, operation) =>
        port.createCart({
          guestCredential: cred,
          csrfCredential: "C".repeat(43),
          operationReference: id(operation),
          requestedAt: now(),
        });
      const replacements = async (session) =>
        (
          await admin.query(
            "SELECT previous_cart_id,cart_id,participant_id FROM rms_ordering.dining_cart_replacement WHERE dining_session_id=$1",
            [session],
          )
        ).rows;

      // The timed-out Cart is visible to the succession read with its unordered lines.
      assert.deepEqual(await succession.previous({ diningSessionReference: S1 }), {
        cartReference: id(100),
        cartVersion: 3,
        lifecycleStatus: "Expired",
        itemCount: 2,
      });

      // Two guests at the table at once (a non-Host participant and the Host): one successor.
      const [fromP, fromH] = await Promise.all([
        create(guest(1, S1, P), 1001),
        create(guest(2, S1, H), 1002),
      ]);
      for (const result of [fromP, fromH])
        assert.ok(["Applied", "Current"].includes(result.status));
      assert.equal(fromP.view.cart.cartReference, fromH.view.cart.cartReference);
      const [successor] = await replacements(S1);
      assert.equal((await replacements(S1)).length, 1);
      assert.equal(successor.previous_cart_id, id(100));
      assert.equal(successor.cart_id, fromP.view.cart.cartReference);
      // Exactly the replacing guest is told once that unordered items were cleared.
      assert.equal(
        [fromP, fromH].filter((result) =>
          result.view.cart.warnings.includes(EARLIER_CART_ITEMS_CLEARED),
        ).length,
        1,
      );
      // The successor is an empty Active Cart for the same Session; nothing was copied or deleted.
      const state = (
        await admin.query(
          "SELECT c.cart_id,c.lifecycle_status,c.aggregate_version,(SELECT count(*)::int FROM rms_ordering.cart_line l WHERE l.cart_id=c.cart_id) AS lines FROM rms_ordering.cart c WHERE c.dining_session_id=$1 ORDER BY c.created_at",
          [S1],
        )
      ).rows;
      assert.deepEqual(state, [
        { cart_id: id(100), lifecycle_status: "Expired", aggregate_version: 3, lines: 2 },
        { cart_id: successor.cart_id, lifecycle_status: "Active", aggregate_version: 1, lines: 0 },
      ]);
      assert.deepEqual(await succession.previous({ diningSessionReference: S1 }), {
        cartReference: successor.cart_id,
        cartVersion: 1,
        lifecycleStatus: "Active",
        itemCount: 0,
      });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='ORDERING_DINING_CART_REPLACE' AND target_id=$1",
            [successor.cart_id],
          )
        ).rows[0].n,
        1,
      );
      // Replay of the same selection operation returns the same Cart and replaces nothing more.
      const replay = await create(credential(1), 1001);
      assert.equal(replay.view.cart.cartReference, successor.cart_id);
      assert.equal((await replacements(S1)).length, 1);

      // A former participant cannot replace a timed-out Cart.
      guest(4, S4, R4);
      await assert.rejects(
        replaceAs(credential(4), {
          operationReference: id(4001),
          previousCartReference: id(400),
          expectedCartVersion: 3,
        }),
        (error) => error instanceof CartError && error.code === "CART_REPLACEMENT_FORBIDDEN",
      );
      assert.deepEqual((await create(credential(4), 4002)).status, "SessionExpired");
      assert.equal((await replacements(S4)).length, 0);

      // Abandoned stays Host-only: a participant is refused, the Host may replace.
      guest(5, S2, P2);
      assert.deepEqual(await create(credential(5), 5001), { status: "LifecycleAbandoned" });
      await assert.rejects(
        replaceAs(credential(5), {
          operationReference: id(5002),
          previousCartReference: id(200),
          expectedCartVersion: 3,
        }),
        (error) => error instanceof CartError && error.code === "CART_REPLACEMENT_FORBIDDEN",
      );
      assert.equal((await replacements(S2)).length, 0);
      guest(6, S2, H2);
      const hostReplaced = await replaceAs(credential(6), {
        operationReference: id(6001),
        previousCartReference: id(200),
        expectedCartVersion: 3,
      });
      assert.equal(hostReplaced.previousCartReference, id(200));
      assert.equal((await replacements(S2)).length, 1);

      // A closed Session is refused on both paths.
      guest(7, S3, P3);
      assert.deepEqual((await create(credential(7), 7001)).status, "SessionExpired");
      await assert.rejects(
        replaceAs(credential(7), {
          operationReference: id(7002),
          previousCartReference: id(300),
          expectedCartVersion: 3,
        }),
        (error) => error instanceof CartError && error.code === "CART_REPLACEMENT_FORBIDDEN",
      );
      assert.equal((await replacements(S3)).length, 0);

      // WP-2423 settlement: checkouts on the timed-out Cart that can no longer create an order or a
      // charge do not hold the table back; one that still could makes the guest retry shortly.
      const evidence = JSON.parse(
        JSON.stringify(
          orderWriteFixture({ at: time(-minutes(140)), dineIn: true }).request
            .checkoutValidationEvidence,
        ),
      );
      const allocatedAt = time(-minutes(140));
      const seedCheckout = async (n, cart, kind) => {
        const ref = (k) => id(n * 10 + k);
        const guestSession = id(800 + n);
        const validatedAt = kind === "open" ? time(-minutes(2)) : allocatedAt;
        const validUntil = kind === "open" ? time(minutes(30)) : time(-minutes(120));
        const createdAt = kind === "open" ? time(-minutes(1)) : allocatedAt;
        await admin.query(
          "INSERT INTO rms_ordering.checkout_session_allocation (brand_id,store_id,create_operation_id,guest_session_id,cart_id,cart_version,quote_id,quote_version,checkout_session_id,submission_id,payment_operation_id,allocated_at) VALUES ($1,$2,$3,$4,$5,2,$6,1,$7,$8,$9,$10)",
          [brand, store, ref(1), guestSession, cart, ref(2), ref(3), ref(4), ref(5), createdAt],
        );
        const session = {
          schemaVersion: 1,
          checkoutSessionReference: ref(3),
          createOperationReference: ref(1),
          submissionReference: ref(4),
          paymentOperationReference: ref(5),
          validation: {
            ...evidence,
            guestSessionReference: guestSession,
            brandReference: brand,
            storeReference: store,
            cartReference: cart,
            cartVersion: 2,
            quoteReference: ref(2),
            orderType: "DineIn",
            sourceChannel: "Qr",
            catalogLines: evidence.catalogLines.map((line) => ({ ...line, validatedAt })),
            fulfillment: {
              ...evidence.fulfillment,
              brandReference: brand,
              storeReference: store,
              cartReference: cart,
              cartVersion: 2,
              quoteReference: ref(2),
              orderType: "DineIn",
              sourceChannel: "Qr",
              checkedAt: validatedAt,
              validUntil,
            },
            validatedAt,
            validUntil,
          },
          createdAt,
        };
        await admin.query(
          "INSERT INTO rms_ordering.checkout_session_record (brand_id,store_id,checkout_session_id,create_operation_id,submission_id,payment_operation_id,guest_session_id,cart_id,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
          [
            brand,
            store,
            ref(3),
            ref(1),
            ref(4),
            ref(5),
            guestSession,
            cart,
            JSON.stringify(session),
            createdAt,
          ],
        );
        if (kind === "paid" || kind === "failed") {
          const submittedAt = time(-minutes(139));
          await admin.query(
            "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,2,$8,$9)",
            [
              ref(4),
              brand,
              store,
              ref(6),
              guestSession,
              "sha256:" + "b".repeat(64),
              cart,
              ref(2),
              submittedAt,
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9,$10)",
            [ref(7), brand, store, ref(6), ref(4), cart, ref(8), ref(2), guestSession, submittedAt],
          );
        }
        if (kind === "inflight") {
          const intentAt = time(-minutes(10));
          await admin.query(
            "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,$10,$11,$12,$13,$13,1130,0,1130,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$14,$15,$14)",
            [
              ref(9),
              brand,
              store,
              ref(5),
              ref(6),
              ref(7),
              ref(4),
              guestSession,
              cart,
              ref(2),
              id(n * 10 + 100),
              id(n * 10 + 101),
              "sha256:" + "d".repeat(64),
              intentAt,
              new Date(Date.parse(intentAt) + minutes(30)).toISOString(),
            ],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
            [id(n * 10 + 102), brand, store, ref(9), "sha256:" + "e".repeat(64), intentAt],
          );
          await admin.query(
            "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [ref(5), brand, store, ref(9), guestSession, "sha256:" + "d".repeat(64), intentAt],
          );
        }
      };
      const [H5, H6, H7] = [52, 62, 72].map(id);
      await admin.query("SET session_replication_role = replica");
      let S5, S6, S7;
      try {
        S5 = await seedSession(50, "Active", H5, [[H5, "Active"]]);
        S6 = await seedSession(60, "Active", H6, [[H6, "Active"]]);
        S7 = await seedSession(70, "Active", H7, [[H7, "Active"]]);
        await seedCart(id(500), S5, "Expired", 0);
        await seedCart(id(600), S6, "Expired", 0);
        await seedCart(id(700), S7, "Expired", 0);
        // S5: a paid submitted round, a failed-payment round and an abandoned intent-less attempt.
        await seedCheckout(51, id(500), "paid");
        await seedCheckout(52, id(500), "failed");
        await seedCheckout(53, id(500), "expired");
        // S6: a payment intent with no outcome and no order yet. S7: a checkout still usable.
        await seedCheckout(61, id(600), "inflight");
        await seedCheckout(71, id(700), "open");
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const settledReplace = await create(guest(8, S5, H5), 8001);
      assert.ok(["Applied", "Current"].includes(settledReplace.status), settledReplace.status);
      assert.equal((await replacements(S5)).length, 1);
      for (const [n, session, host, previous] of [
        [9, S6, H6, id(600)],
        [10, S7, H7, id(700)],
      ]) {
        const cred = guest(n, session, host);
        assert.deepEqual(await create(cred, 9000 + n), {
          status: "OrderProcessing",
          retryAfterSeconds: 10,
        });
        await assert.rejects(
          replaceAs(cred, {
            operationReference: id(9100 + n),
            previousCartReference: previous,
            expectedCartVersion: 3,
          }),
          (error) =>
            error instanceof CartError && error.code === "CART_REPLACEMENT_CHECKOUT_PENDING",
        );
        assert.equal((await replacements(session)).length, 0);
      }
    } finally {
      await admin.end();
    }
  });
});

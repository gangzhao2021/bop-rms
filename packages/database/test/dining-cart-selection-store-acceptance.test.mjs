import { createCustomerDiningCartComposition } from "../../../apps/api/src/customer-dining-cart-composition.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresDiningCartSelectionStore,
  createDiningCartSelectionService,
  createPostgresDiningCartReadStore,
} from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => `018f2316-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (seconds = 0) =>
  new Date(Date.parse("2026-09-09T12:00:00.000Z") + seconds * 1000).toISOString();
const scope = { brandReference: id(2), storeReference: id(3) };
const command = (operation, session = 30, guest = 40, participant = 50) => ({
  ...scope,
  operationReference: id(operation),
  diningSessionReference: id(session),
  guestSessionReference: id(guest),
  participantReference: id(participant),
  observedAt: at(),
});

it("atomically selects one initial shared Dining Cart with immutable replay and Audit", async () => {
  await withIsolatedDatabase({ caseId: "wp2316_cart_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = `wp2316_${context.runId}`;
    assert.match(role, /^wp2316_[a-f0-9]+$/u);
    let active = 0;
    let transactions = 0;
    let authorityReads = 0;
    let participationAllowed = true;
    let generated = 1000;
    let creations = 0;
    let clock = 0;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA platform_helpers,platform_audit,rms_ordering TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_ordering.cart,rms_ordering.dining_cart_operation,platform_audit.audit_record TO ${role}`,
      );
      // PostgreSQL requires an UPDATE column grant for FOR SHARE; the adapter issues no Cart UPDATE.
      await admin.query(`GRANT UPDATE (aggregate_version) ON rms_ordering.cart TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart_line TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      function runner({ failAudit = false, loseAck = false, afterHistory } = {}) {
        return {
          async run(action) {
            const client = new Client({
              ...context.clientConfig,
              connectionTimeoutMillis: 2000,
              query_timeout: 5000,
            });
            await client.connect();
            active++;
            transactions++;
            let committed = false;
            try {
              await client.query("BEGIN");
              await client.query(`SET LOCAL ROLE ${role}`);
              await client.query("SET LOCAL lock_timeout='5s'");
              await client.query("SET LOCAL statement_timeout='5s'");
              const result = await action({
                query: async (sql, values) => {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  const result = await client.query(sql, [...values]);
                  if (afterHistory && sql.includes("LIMIT 2 FOR SHARE")) await afterHistory();
                  return result;
                },
              });
              await client.query("COMMIT");
              committed = true;
              const cleared = (
                await client.query(
                  "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
                )
              ).rows[0];
              assert(!cleared.brand && !cleared.store);
              if (loseAck) throw new Error("synthetic lost commit acknowledgement");
              return result;
            } catch (error) {
              if (!committed) await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
              active--;
            }
          },
        };
      }
      // These are explicit synthetic already-authorized owner commands and policy, not Identity or Dining evidence.
      const options = {
        scope,
        sourceChannel: "Qr",
        policy: {
          policyVersionReference: id(8),
          policyDigest: `sha256:${"a".repeat(64)}`,
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 7200,
          validFrom: at(-3600),
          validUntil: at(86400),
        },
        now: () => at(clock),
        generateReference: () => {
          creations++;
          return id(generated++);
        },
        audit: (d) => ({
          auditId: id(generated++),
          brandId: d.brandReference,
          storeId: d.storeReference,
          actor: { type: "System" },
          actionCode: `ORDERING_DINING_CART_${d.action.toUpperCase()}`,
          targetType: "OrderingCart",
          targetId: d.cartReference,
          reasonCode: "AUTHORIZED_CART_SELECTION",
          correlationId: d.operationReference,
          occurredAt: d.occurredAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      };
      const store = createPostgresDiningCartSelectionStore(runner(), options);
      // WP-2317 composes the actual application guard and writer with explicit synthetic current providers.
      function authorities(intent) {
        const table = Number.parseInt(intent.diningSessionReference.slice(-12), 16);
        return {
          scope,
          now: () => at(clock),
          sessions: {
            resolve: async () => {
              authorityReads++;
              return {
                sessionReference: intent.guestSessionReference,
                status: "Active",
                version: 1,
                brandReference: id(2),
                storeReference: id(3),
                publicStoreReference: id(7),
                publicTableReference: id(10000 + table),
                channel: "DineIn",
                locale: "en-CA",
                qrReference: id(30000 + table),
                qrRevocationVersion: 1,
                diningState: "DiningBound",
                diningSessionReference: intent.diningSessionReference,
                diningParticipantReference: intent.participantReference,
                createdAt: at(-120),
                lastSeenAt: at(-60),
                idleExpiresAt: at(14340),
                absoluteExpiresAt: at(86280),
                orderClosedAt: null,
                closureExpiresAt: null,
                rotatedFromGuestSessionReference: null,
                revocationReason: null,
                revokedAt: null,
              };
            },
          },
          participation: {
            resolve: async (query) => {
              assert.deepEqual(query, {
                purpose: "Cart",
                diningSessionReference: intent.diningSessionReference,
                participantReference: intent.participantReference,
              });
              return participationAllowed
                ? {
                    schemaVersion: 1,
                    brandReference: id(2),
                    storeReference: id(3),
                    diningSessionReference: intent.diningSessionReference,
                    participantReference: intent.participantReference,
                    tableReference: id(20000 + table),
                    tableAssignmentVersion: 1,
                    diningSessionVersion: 1,
                    participantVersion: 1,
                    observedAt: at(clock),
                  }
                : null;
            },
          },
        };
      }
      function authorized(intent, selection = store) {
        return createDiningCartSelectionService({ ...authorities(intent), selection });
      }
      const commands = [command(10), command(11, 30, 41, 51)];
      const results = await Promise.all(
        commands.map((value, index) =>
          authorized(value).select({
            sessionCredential: (index === 0 ? "a" : "b").repeat(43),
            operationReference: value.operationReference,
          }),
        ),
      );
      assert.equal(authorityReads, 8);
      assert.deepEqual(results.map((value) => value.action).sort(), ["Create", "Select"]);
      assert.equal(results[0].cartReference, results[1].cartReference);
      assert.equal(creations, 1);
      const created = results.find((value) => value.action === "Create");
      const createdCommand = commands.find(
        (value) => value.operationReference === created.operationReference,
      );
      const root = (
        await admin.query(
          "SELECT created_by_actor_id,aggregate_version FROM rms_ordering.cart WHERE cart_id=$1",
          [created.cartReference],
        )
      ).rows[0];
      assert.equal(root.created_by_actor_id, created.guestSessionReference);
      assert.equal(root.aggregate_version, 1);
      const originalRequest = {
        sessionCredential: "a".repeat(43),
        operationReference: created.operationReference,
      };
      participationAllowed = false;
      const beforeDenied = transactions;
      await assert.rejects(authorized(createdCommand).select(originalRequest), {
        code: "CART_PERMISSION_DENIED",
      });
      assert.equal(transactions, beforeDenied);
      participationAllowed = true;
      assert.deepEqual(await authorized(createdCommand).select(originalRequest), created);

      const count = async (table) =>
        Number((await admin.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
      assert.equal(await count("rms_ordering.dining_cart_operation"), 2);
      assert.equal(await count("platform_audit.audit_record"), 2);
      const repeated = await Promise.all([store.select(command(12)), store.select(command(12))]);
      assert.deepEqual(repeated[0], repeated[1]);
      assert.equal(await count("rms_ordering.dining_cart_operation"), 3);
      assert.equal(await count("platform_audit.audit_record"), 3);
      assert.equal(creations, 1);
      const current = await createPostgresDiningCartReadStore(runner(), scope).current({
        ...scope,
        diningSessionReference: id(30),
        observedAt: at(),
      });
      assert.equal(current.cartReference, created.cartReference);
      assert.equal(current.createdByActorReference, created.guestSessionReference);
      for (const change of [
        { guestSessionReference: id(99) },
        { participantReference: id(99) },
        { diningSessionReference: id(99) },
      ])
        await assert.rejects(store.select({ ...createdCommand, ...change }), {
          code: "CART_IDEMPOTENCY_CONFLICT",
        });
      await assert.rejects(store.select({ ...command(13), storeReference: id(99) }), {
        code: "CART_INPUT_INVALID",
      });

      const lost = command(21, 31);
      await assert.rejects(
        createPostgresDiningCartSelectionStore(runner({ loseAck: true }), options).select(lost),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      const afterLoss = await count("platform_audit.audit_record");
      const recovered = await store.select(lost);
      assert.equal(recovered.action, "Create");
      assert.equal(await count("platform_audit.audit_record"), afterLoss);
      assert.deepEqual(await store.select(lost), recovered);
      const beforeFailure = {
        carts: await count("rms_ordering.cart"),
        operations: await count("rms_ordering.dining_cart_operation"),
        audit: await count("platform_audit.audit_record"),
      };
      await assert.rejects(
        createPostgresDiningCartSelectionStore(runner({ failAudit: true }), options).select(
          command(22, 32),
        ),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(
        {
          carts: await count("rms_ordering.cart"),
          operations: await count("rms_ordering.dining_cart_operation"),
          audit: await count("platform_audit.audit_record"),
        },
        beforeFailure,
      );

      const changedAuthorityCommand = command(185, 85, 45, 55);
      const changedAuthorityRequest = {
        sessionCredential: "c".repeat(43),
        operationReference: id(185),
      };
      const beforePostEffect = {
        carts: await count("rms_ordering.cart"),
        operations: await count("rms_ordering.dining_cart_operation"),
        audit: await count("platform_audit.audit_record"),
      };
      let committedReceipt;
      const changingAuthority = authorized(changedAuthorityCommand, {
        select: async (value) => {
          committedReceipt = await store.select(value);
          participationAllowed = false;
          return committedReceipt;
        },
      });
      await assert.rejects(changingAuthority.select(changedAuthorityRequest), {
        code: "CART_PERMISSION_DENIED",
      });
      assert.ok(committedReceipt);
      assert.deepEqual(
        {
          carts: await count("rms_ordering.cart"),
          operations: await count("rms_ordering.dining_cart_operation"),
          audit: await count("platform_audit.audit_record"),
        },
        {
          carts: beforePostEffect.carts + 1,
          operations: beforePostEffect.operations + 1,
          audit: beforePostEffect.audit + 1,
        },
      );
      participationAllowed = true;
      assert.deepEqual(
        await authorized(changedAuthorityCommand).select(changedAuthorityRequest),
        committedReceipt,
      );
      assert.equal(await count("platform_audit.audit_record"), beforePostEffect.audit + 1);

      // WP-2319: real API/Ordering composition, synthetic current Identity/Dining/profile providers.
      let profileAvailable = true;
      let csrfChecks = 0;
      function apiFor(intent, enableItems = false) {
        const current = authorities(intent);
        return createCustomerDiningCartComposition({
          scope,
          now: () => at(clock),
          participation: current.participation,
          sessions: {
            resolve: current.sessions.resolve,
            authorize: async (request) => {
              csrfChecks++;
              assert.equal(request.csrfCredential, "s".repeat(43));
              return current.sessions.resolve(request);
            },
          },
          cartTransactions: runner(),
          selectionTransactions: runner(),
          selection: {
            sourceChannel: options.sourceChannel,
            policy: options.policy,
            generateReference: options.generateReference,
            audit: options.audit,
          },
          ...(enableItems
            ? {
                items: {
                  writeTransactions: runner(),
                  references: {
                    generate: () => id(++generated),
                    hashIntent: (value) =>
                      `sha256:${createHash("sha256").update(value).digest("hex")}`,
                    equals: (a, b) => a === b,
                  },
                  catalog: {
                    validateSelection: async (request) => ({
                      ...request,
                      status: "Accepted",
                      menuVersionReference: id(960),
                      productVersionReference: id(961),
                      catalogChannelCode: "PILOT_CHANNEL",
                      catalogOrderTypeCode: "PILOT_ORDER_TYPE",
                      ruleEvidence: [],
                      validatedAt: request.observedAt,
                    }),
                  },
                  audit: (input) => ({
                    auditId: id(++generated),
                    brandId: id(2),
                    storeId: id(3),
                    actor: { type: "System" },
                    actionCode: `ORDERING_CART_ITEM_${input.action.toUpperCase()}`,
                    targetType: "OrderingCart",
                    targetId: input.cartReference,
                    reasonCode: "AUTHORIZED_CART_MUTATION",
                    correlationId: input.operationReference,
                    occurredAt: input.observedAt,
                    sourceChannel: "CUSTOMER_PWA",
                    dataClassification: "Restricted",
                    retentionPolicyCode: "AUDIT_DEFAULT",
                    retentionPolicyVersion: 1,
                  }),
                },
              }
            : {}),
          catalog: {
            describeMany: async (requests) =>
              requests.map((request) => ({
                status: "Found",
                menuVersionReference: request.menuVersionReference,
                productVersionReference: request.productVersionReference,
                sellableReference: request.sellableReference,
                displayName: "Synthetic dish",
                options: [],
              })),
          },
          stores: {
            getPublicStore: async (request) => {
              if (!profileAvailable) throw new Error("synthetic profile unavailable");
              assert.equal(request.publicStoreReference, id(7));
              assert.equal(request.purpose, "CustomerCart");
              return {
                status: "Available",
                profile: {
                  profileReference: id(950),
                  profileVersion: 1,
                  releaseReference: id(951),
                  contentDigest: `sha256:${"e".repeat(64)}`,
                  defaultLocale: "en-CA",
                  selectedLocale: "en-CA",
                  currencyCode: "CAD",
                  timeZone: "America/Toronto",
                  brandDisplayName: "Synthetic Brand",
                  storeDisplayName: "Synthetic Store",
                  address: {
                    countryCode: "CA",
                    regionCode: "ON",
                    locality: "Exampleville",
                    postalCode: "A1A 1A1",
                    addressLines: ["100 Example Avenue"],
                  },
                  businessPhone: null,
                  website: null,
                  logoAssetVersionReference: null,
                },
              };
            },
          },
        });
      }
      const apiIntent = command(186, 86, 46, 56);
      const api = apiFor(apiIntent);
      const apiRequest = {
        guestCredential: "d".repeat(43),
        csrfCredential: "s".repeat(43),
        operationReference: id(186),
        requestedAt: at(),
      };
      const beforeCsrfDenied = transactions;
      assert.deepEqual(await api.createCart({ ...apiRequest, csrfCredential: "t".repeat(43) }), {
        status: "SessionExpired",
      });
      assert.equal(transactions, beforeCsrfDenied);
      const beforeApi = {
        carts: await count("rms_ordering.cart"),
        audits: await count("platform_audit.audit_record"),
      };
      const checksBeforeCreate = csrfChecks;
      const apiCreated = await api.createCart(apiRequest);
      assert.equal(apiCreated.status, "Applied");
      assert.equal(csrfChecks, checksBeforeCreate + 4);
      assert.equal(apiCreated.view.cart.orderType, "DineIn");
      assert.deepEqual(apiCreated.view.cart.items, []);
      assert.equal(apiCreated.view.cart.quote, null);
      for (const secret of [
        apiRequest.guestCredential,
        apiRequest.csrfCredential,
        id(46),
        id(56),
        id(86),
      ])
        assert.equal(JSON.stringify(apiCreated).includes(secret), false);
      const secondApi = apiFor(command(187, 86, 47, 57));
      const apiSelected = await secondApi.createCart({
        ...apiRequest,
        operationReference: id(187),
      });
      assert.equal(apiSelected.status, "Current");
      assert.equal(apiSelected.view.cart.cartReference, apiCreated.view.cart.cartReference);
      assert.equal(await count("rms_ordering.cart"), beforeApi.carts + 1);
      assert.equal(await count("platform_audit.audit_record"), beforeApi.audits + 2);
      assert.deepEqual(
        await api.getCurrentCart({
          guestCredential: apiRequest.guestCredential,
          requestedAt: at(),
        }),
        { status: "Found", view: apiCreated.view },
      );
      const unknownRequest = { ...apiRequest, operationReference: id(188) };
      profileAvailable = false;
      assert.deepEqual(await api.createCart(unknownRequest), { status: "Unavailable" });
      const afterUnknown = await count("platform_audit.audit_record");
      assert.equal(afterUnknown, beforeApi.audits + 3);
      profileAvailable = true;
      assert.equal((await api.createCart(unknownRequest)).status, "Current");
      assert.equal(await count("platform_audit.audit_record"), afterUnknown);
      participationAllowed = false;
      const beforeRevoked = transactions;
      assert.deepEqual(await api.createCart(apiRequest), { status: "SessionExpired" });
      assert.equal(transactions, beforeRevoked);
      participationAllowed = true;

      async function seed(cart, session, kind = "Active") {
        if (kind === "Legacy") {
          await admin.query(
            "INSERT INTO rms_ordering.cart(cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at) VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6)",
            [id(cart), id(2), id(3), id(session), id(90), at(-3600)],
          );
          return;
        }
        await admin.query(
          `INSERT INTO rms_ordering.cart(cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at,lifecycle_status,lifecycle_policy_version_id,lifecycle_policy_digest,idle_timeout_seconds,absolute_timeout_seconds,idle_expires_at,absolute_expires_at)
          VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6,'Active',$7,$8,3600,7200,$9,$10)`,
          [
            id(cart),
            id(2),
            id(3),
            id(session),
            id(90),
            at(-3600),
            id(8),
            `sha256:${"a".repeat(64)}`,
            kind === "Expired" ? at(-1) : at(3600),
            at(7200),
          ],
        );
        if (kind === "Abandoned")
          await admin.query(
            "UPDATE rms_ordering.cart SET lifecycle_status='Abandoned',terminal_at=$2,terminal_reason='CUSTOMER_ABANDONED',updated_at=$2,aggregate_version=2 WHERE cart_id=$1",
            [id(cart), at(-1)],
          );
      }
      for (const [index, kind, code] of [
        [60, "Expired", "CART_EXPIRED"],
        [61, "Abandoned", "CART_ABANDONED"],
        [62, "Legacy", "CART_LIFECYCLE_UNAVAILABLE"],
      ]) {
        await seed(6000 + index, index, kind);
        const before = await count("rms_ordering.cart");
        await assert.rejects(store.select(command(100 + index, index)), { code });
        assert.equal(await count("rms_ordering.cart"), before);
      }
      await seed(6070, 70);
      await seed(6071, 70);
      await assert.rejects(store.select(command(170, 70)), { code: "CART_DEPENDENCY_UNAVAILABLE" });
      await seed(6080, 80);
      for (const [line, guest, participant] of [
        [7001, 40, 50],
        [7002, 41, 51],
      ])
        await admin.query(
          "INSERT INTO rms_ordering.cart_line(cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_by_participant_id,added_at) VALUES($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8)",
          [id(line), id(6080), id(2), id(3), id(8), id(guest), id(participant), at(-1)],
        );
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=4,updated_at=$2 WHERE cart_id=$1",
        [id(6080), at()],
      );
      const existingBefore = await createPostgresDiningCartReadStore(runner(), scope).current({
        ...scope,
        diningSessionReference: id(80),
        observedAt: at(),
      });
      const selected = await store.select(command(180, 80));
      assert.equal(selected.action, "Select");
      assert.equal(selected.cartVersion, 4);
      const existingAfter = await createPostgresDiningCartReadStore(runner(), scope).current({
        ...scope,
        diningSessionReference: id(80),
        observedAt: at(),
      });
      assert.deepEqual(existingAfter, existingBefore);
      assert.equal(existingAfter.createdByActorReference, id(90));
      assert.deepEqual(
        existingAfter.items.map((item) => item.addedByParticipantReference),
        [id(50), id(51)],
      );

      let release;
      let entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const locked = new Promise((resolve) => {
        entered = resolve;
      });
      const pending = createPostgresDiningCartSelectionStore(
        runner({
          afterHistory: async () => {
            entered();
            await gate;
          },
        }),
        options,
      ).select(command(181, 80));
      await locked;
      const update = admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=5 WHERE cart_id=$1",
        [id(6080)],
      );
      try {
        assert.equal(
          await Promise.race([update.then(() => "updated"), delay(40, "locked")]),
          "locked",
        );
      } finally {
        release();
      }
      assert.equal((await pending).cartVersion, 4);
      await update;
      assert.deepEqual(await store.select(command(180, 80)), selected);

      for (const sql of [
        "UPDATE rms_ordering.dining_cart_operation SET cart_version=cart_version",
        "DELETE FROM rms_ordering.dining_cart_operation",
        "TRUNCATE rms_ordering.dining_cart_operation",
      ])
        await assert.rejects(admin.query(sql), (error) => error.code === "55000");
      await assert.rejects(
        admin.query(
          `INSERT INTO rms_ordering.dining_cart_operation
        SELECT brand_id,store_id,$1,dining_session_id,guest_session_id,participant_id,action_code,cart_id,cart_version,occurred_at,expires_at
        FROM rms_ordering.dining_cart_operation WHERE operation_id=$2`,
          [id(900), created.operationReference],
        ),
        (error) => error.code === "23505",
      );
      for (const [session, version] of [
        [id(999), 1],
        [id(30), 99],
      ])
        await assert.rejects(
          admin.query(
            `INSERT INTO rms_ordering.dining_cart_operation
          SELECT brand_id,store_id,$1,$2,guest_session_id,participant_id,'Select',cart_id,$3,occurred_at,expires_at
          FROM rms_ordering.dining_cart_operation WHERE operation_id=$4`,
            [id(901), session, version, created.operationReference],
          ),
          (error) => error.code === "23514",
        );
      await runner().run(async (tx) => {
        assert.equal(
          Number(
            (await tx.query("SELECT count(*) AS count FROM rms_ordering.dining_cart_operation", []))
              .rows[0].count,
          ),
          0,
        );
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(2), id(99)],
        );
        assert.equal(
          Number(
            (await tx.query("SELECT count(*) AS count FROM rms_ordering.dining_cart_operation", []))
              .rows[0].count,
          ),
          0,
        );
      });
      await assert.rejects(
        runner().run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(2), id(99)],
          );
          await tx.query(
            "INSERT INTO rms_ordering.cart(cart_id,brand_id,store_id,order_type,source_channel,dining_session_id,created_by_actor_id,aggregate_version,created_at,updated_at) VALUES($1,$2,$3,'DineIn','Qr',$4,$5,1,$6,$6)",
            [id(902), id(2), id(3), id(30), id(40), at()],
          );
        }),
        (error) => error.code === "42501",
      );
      const constraints = await admin.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_ordering.dining_cart_operation'::regclass",
      );
      assert.deepEqual(constraints.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
      // WP-2324: actual API command/view composition with explicit synthetic public providers.
      await admin.query(`GRANT UPDATE ON rms_ordering.cart TO ${role}`);
      await admin.query(`GRANT INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT ON rms_ordering.cart_operation_record TO ${role}`);
      clock = 0;
      profileAvailable = true;
      participationAllowed = true;
      const beforeItemAudit = await count("platform_audit.audit_record");
      const beforeItemOperations = await count("rms_ordering.cart_operation_record");
      const itemIntent = command(4200, 4100, 4101, 4102);
      const itemApi = apiFor(itemIntent, true);
      const partnerApi = apiFor(command(4201, 4100, 4103, 4104), true);
      const transport = {
        guestCredential: "d".repeat(43),
        csrfCredential: "s".repeat(43),
        requestedAt: at(),
      };
      const itemCart = await itemApi.createCart({ ...transport, operationReference: id(4200) });
      assert.equal(itemCart.status, "Applied");
      const cartReference = itemCart.view.cart.cartReference;
      const itemCommon = { ...transport, cartReference };
      const addInput = {
        ...itemCommon,
        expectedCartVersion: 1,
        operationReference: id(4202),
        sellableReference: id(962),
        quantity: 2,
        optionSelections: [],
        customerNote: "Synthetic owned note",
      };
      const added = await itemApi.addItem(addInput);
      assert.equal(added.status, "Applied");
      assert.equal(added.view.cart.version, 2);
      const ownItem = added.view.cart.items[0].cartItemReference;
      const partnered = await partnerApi.addItem({
        ...addInput,
        expectedCartVersion: 2,
        operationReference: id(4203),
        customerNote: "Synthetic other note",
      });
      assert.equal(partnered.status, "Applied");
      const otherItem = partnered.view.cart.items.find(
        (item) => item.cartItemReference !== ownItem,
      ).cartItemReference;
      const ownerView = await itemApi.getCart({
        guestCredential: transport.guestCredential,
        requestedAt: at(),
        cartReference,
      });
      assert.equal(
        ownerView.view.cart.items.find((item) => item.cartItemReference === ownItem).customerNote,
        "Synthetic owned note",
      );
      const foreignItem = ownerView.view.cart.items.find(
        (item) => item.cartItemReference === otherItem,
      );
      assert.equal(foreignItem.customerNote, null);
      assert(foreignItem.warnings.includes("OTHER_PARTICIPANT_ITEM"));
      assert.deepEqual(
        await itemApi.removeItem({
          ...itemCommon,
          expectedCartVersion: 3,
          operationReference: id(4204),
          cartItemReference: otherItem,
        }),
        { status: "SessionExpired" },
      );
      const updateInput = {
        ...itemCommon,
        expectedCartVersion: 3,
        operationReference: id(4205),
        cartItemReference: ownItem,
        quantity: 3,
        optionSelections: [],
        customerNote: null,
      };
      profileAvailable = false;
      assert.deepEqual(await itemApi.updateItem(updateInput), { status: "Unavailable" });
      const afterUnknownAudit = await count("platform_audit.audit_record");
      profileAvailable = true;
      const restored = await itemApi.updateItem(updateInput);
      assert.equal(restored.status, "Applied");
      assert.equal(restored.view.cart.version, 4);
      assert.equal(await count("platform_audit.audit_record"), afterUnknownAudit);
      const removed = await itemApi.removeItem({
        ...itemCommon,
        expectedCartVersion: 4,
        operationReference: id(4206),
        cartItemReference: ownItem,
      });
      assert.equal(removed.status, "Applied");
      assert.equal(removed.view.cart.version, 5);
      assert.equal(removed.view.cart.items.length, 1);
      assert.equal(removed.view.cart.items[0].cartItemReference, otherItem);
      assert.equal(await count("platform_audit.audit_record"), beforeItemAudit + 5);
      assert.equal(await count("rms_ordering.cart_operation_record"), beforeItemOperations + 4);
      for (const privateValue of [
        transport.guestCredential,
        transport.csrfCredential,
        id(4101),
        id(4102),
        id(4103),
        id(4104),
        "Synthetic other note",
      ])
        assert(!JSON.stringify(removed).includes(privateValue));
      clock = 8000;
      const oldPolicyStore = createPostgresDiningCartSelectionStore(runner(), {
        ...options,
        policy: { ...options.policy, validUntil: at(1) },
      });
      assert.deepEqual(await oldPolicyStore.select(createdCommand), created);
      assert.deepEqual(
        await authorized(createdCommand, oldPolicyStore).select(originalRequest),
        created,
      );
      clock = 86400;
      const beforeExpiredGuest = transactions;
      await assert.rejects(authorized(createdCommand).select(originalRequest), {
        code: "CART_PERMISSION_DENIED",
      });
      assert.equal(transactions, beforeExpiredGuest);

      await assert.rejects(store.select(createdCommand), { code: "CART_IDEMPOTENCY_CONFLICT" });
      await assert.rejects(store.select(command(903, 903)), { code: "CART_LIFECYCLE_UNAVAILABLE" });
      assert.equal(active, 0);
    } finally {
      await admin.end();
    }
  });
}, 120_000);

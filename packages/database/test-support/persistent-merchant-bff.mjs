import { createMerchantBrandScope } from "../../../apps/api/src/merchant-brand-scope.ts";
import { verifyMerchantConfigurationCommand } from "./merchant-configuration-command.mjs";
import process from "node:process";
import { createMerchantServiceControl } from "../../../apps/api/src/merchant-service-control.ts";
import { seedStorePublication } from "./store-publication-seed.mjs";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
} from "../../bop/audit/src/index.ts";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { verifyPersistentMerchantBffHttp } from "./persistent-merchant-bff-http.mjs";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { createPersistentMerchantOrderExceptions } from "../../../apps/api/src/persistent-merchant-order-exceptions.ts";
import { createMerchantRuntime } from "../../../apps/api/src/merchant-runtime.ts";
import { orderQueryFixture } from "../../rms/ordering/src/tests/order-creation-query.fixture.ts";
import { seedAcceptanceOrderHistory } from "./acceptance-order-history.mjs";
import { createDiningTable } from "../../rms/dining/src/index.ts";
import { buildKitchenQueueGeneration, buildKitchenQueueRows } from "../../rms/kitchen/src/index.ts";
import { parseDiningHash } from "../../rms/dining/src/domain/dining-session.ts";
import {
  parseDiningJoinInvitationCredential,
  parseDiningJoinHumanCode,
  parsePublicCapabilitySelectorHash,
} from "../../bop/public-capability/src/index.ts";
import * as f from "../../bop/permission/src/tests/current-policy.fixture.ts";

export async function verifyPersistentMerchantBff({
  admin,
  client,
  role,
  pickupReady,
  fixtureClock,
}) {
  const clock = fixtureClock ?? { from: f.FROM, at: f.AT, until: f.UNTIL };
  const businessWeekday = fixtureClock?.businessWeekday ?? 2;
  const businessDate = fixtureClock?.businessDate ?? "2026-07-28";
  const targetBusinessDate = fixtureClock?.targetBusinessDate ?? "2026-07-27";
  const initialServiceWindow = fixtureClock?.initialServiceWindow ?? {
    start: "08:00:00",
    end: "17:00:00",
  };
  const targetServiceWindow = fixtureClock?.targetServiceWindow ?? {
    start: "09:00:00",
    end: "17:00:00",
  };
  await admin.query("GRANT USAGE ON SCHEMA bop_task TO " + role);
  await admin.query("GRANT SELECT ON bop_task.task_version TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA rms_store TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_store.store_configuration_authoring_operation,rms_store.store_configuration_version TO " +
      role,
  );
  for (const [configurationId, storeId, start] of [
    [f.uuid("910"), f.STORE, "04:00:00"],
    [f.uuid("920"), f.uuid("610"), "09:00:00"],
  ].filter(([, storeId]) => !pickupReady || storeId !== f.STORE)) {
    await admin.query(
      "INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto',$5,$6,$7,$8,$9,$10,NULL,ARRAY['DineIn','Pickup'],$11,NULL,NULL,'PILOT_CONFIGURATION',$12,$13,$14,$15,$16,$11,$11,'ConfigurationMetadata')",
      [
        configurationId,
        f.BRAND,
        storeId,
        f.uuid("930"),
        start,
        f.uuid("931"),
        f.uuid("932"),
        f.uuid("933"),
        f.uuid("934"),
        f.uuid("935"),
        clock.from,
        f.uuid("936"),
        f.uuid("937"),
        f.uuid(storeId === f.STORE ? "938" : "1938"),
        f.uuid(storeId === f.STORE ? "939" : "1939"),
        f.uuid("940"),
      ],
    );
    const content = createStoreConfigurationVersion({
      configurationReference: configurationId,
      brandReference: f.BRAND,
      storeReference: storeId,
      configurationVersion: 1,
      lifecycle: "Published",
      source: "StoreOverride",
      brandBaseVersionReference: f.uuid("930"),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      businessDayStartLocalTime: start,
      addressReference: f.uuid("931"),
      contactReference: f.uuid("932"),
      receiptReference: f.uuid("933"),
      taxConfigurationReference: f.uuid("934"),
      paymentConfigurationReference: f.uuid("935"),
      capacityConfigurationReference: null,
      enabledServiceModes: ["DineIn", "Pickup"],
      weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
        isoWeekday: index + 1,
        intervals:
          index === businessWeekday - 1
            ? [
                {
                  startLocalTime:
                    storeId === f.STORE ? initialServiceWindow.start : targetServiceWindow.start,
                  endLocalTime:
                    storeId === f.STORE ? initialServiceWindow.end : targetServiceWindow.end,
                  endsNextDay: false,
                  serviceModes: ["Pickup"],
                  orderCutoffSeconds: 0,
                  leadTimeSeconds: 600,
                },
              ]
            : [],
      })),
      exceptions: [],
      effectiveFrom: clock.from,
      effectiveUntil: null,
      supersedesConfigurationReference: null,
      reasonCode: "PILOT_CONFIGURATION",
      authoredByReference: f.uuid("936"),
      approvedByReference: f.uuid("937"),
      approvalEvidenceReference: f.uuid(storeId === f.STORE ? "938" : "1938"),
      publicationReference: f.uuid(storeId === f.STORE ? "939" : "1939"),
      liveGateEvidenceReference: f.uuid("940"),
      createdAt: clock.from,
      updatedAt: clock.from,
      dataClassification: "ConfigurationMetadata",
    });
    const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(content));
    const publicationId = (n) =>
      f.uuid(String(n === 90 ? 90 : n + (storeId === f.STORE ? 1000 : 2000)));
    await admin.query(
      "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
      [f.BRAND, storeId, configurationId, publicationId(70), digest, content, clock.from],
    );
    await seedStorePublication(
      admin,
      publicationId,
      content,
      digest,
      undefined,
      undefined,
      new Date(Date.parse(clock.until) + 7 * 86400000).toISOString(),
    );
  }
  await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE ON bop_publishing.publishing_mutation_record,bop_publishing.live_gate_version,bop_publishing.live_gate_requirement,rms_store.store_configuration_publication_content TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_store.store_weekly_service_period,rms_store.store_service_exception,rms_store.store_service_exception_content,rms_store.store_service_exception_interval,rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
      role,
  );
  if (!pickupReady) {
    await admin.query(
      "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,$5,1,$6,$7,false,ARRAY['Pickup'],0,600,'ConfigurationMetadata')",
      [
        f.uuid("941"),
        f.BRAND,
        f.STORE,
        f.uuid("910"),
        businessWeekday,
        initialServiceWindow.start,
        initialServiceWindow.end,
      ],
    );
  }
  await admin.query(
    "INSERT INTO rms_store.store_weekly_service_period VALUES ($1,$2,$3,$4,$5,1,$6,$7,false,ARRAY['Pickup'],0,600,'ConfigurationMetadata')",
    [
      f.uuid("942"),
      f.BRAND,
      f.uuid("610"),
      f.uuid("920"),
      businessWeekday,
      targetServiceWindow.start,
      targetServiceWindow.end,
    ],
  );
  const ensurePermission = async (reference, action) => {
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3) ON CONFLICT (action_code) DO NOTHING",
      [reference, action, clock.from],
    );
    const result = await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
      [action],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0].permission_id;
  };
  const accessPermission = await ensurePermission(f.uuid("870"), "merchant.access");
  const diningOperatePermission = await ensurePermission(f.uuid("3150"), "dining.operate");
  const kitchenOperatePermission = await ensurePermission(f.uuid("3159"), "kitchen.operate");
  const workflowOperatePermission = await ensurePermission(f.uuid("3161"), "workflow.operate");
  const orderingOperatePermission = await ensurePermission(f.uuid("3170"), "ordering.operate");
  const fulfillmentOperatePermission = await ensurePermission(
    f.uuid("3195"),
    "fulfillment.operate",
  );
  const orderExceptionManagePermission = await ensurePermission(
    f.uuid("3196"),
    "operations.order-exception.manage",
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [f.uuid("871"), f.STORE_ROLE, accessPermission, f.BRAND, f.STORE, clock.from, clock.until],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3151"),
      f.STORE_ROLE,
      diningOperatePermission,
      f.BRAND,
      f.STORE,
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3160"),
      f.STORE_ROLE,
      kitchenOperatePermission,
      f.BRAND,
      f.STORE,
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3162"),
      f.STORE_ROLE,
      workflowOperatePermission,
      f.BRAND,
      f.STORE,
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3171"),
      f.STORE_ROLE,
      orderingOperatePermission,
      f.BRAND,
      f.STORE,
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3196"),
      f.STORE_ROLE,
      fulfillmentOperatePermission,
      f.BRAND,
      f.STORE,
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.role VALUES ($1,$2,$3,'synthetic_second_operator','Active',$4,$5,1,$4,$4)",
    [f.uuid("872"), f.BRAND, f.uuid("610"), clock.from, clock.until],
  );
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES ($1,$2,$3,$4,$5,$6,$7,'Active',$8,$9,1,$8,$8)",
    [
      f.uuid("873"),
      f.uuid("872"),
      f.MEMBERSHIP,
      f.uuid("611"),
      f.ACTOR,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("874"),
      f.uuid("872"),
      accessPermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("875"),
      f.uuid("872"),
      orderingOperatePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("876"),
      f.uuid("872"),
      kitchenOperatePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("877"),
      f.uuid("872"),
      diningOperatePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3197"),
      f.uuid("872"),
      fulfillmentOperatePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3198"),
      f.uuid("872"),
      orderExceptionManagePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [
      f.uuid("3199"),
      f.uuid("872"),
      workflowOperatePermission,
      f.BRAND,
      f.uuid("610"),
      clock.from,
      clock.until,
    ],
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_fulfillment.fulfillment,rms_fulfillment.fulfillment_item,rms_fulfillment.fulfillment_creation_operation,rms_fulfillment.fulfillment_item_ready_result,rms_fulfillment.fulfillment_ready_operation,rms_fulfillment.pickup_handoff_operation,rms_fulfillment.pickup_handoff_record,rms_fulfillment.pickup_handoff_item,rms_fulfillment.pickup_proof_operation,rms_fulfillment.pickup_proof_generation,rms_fulfillment.pickup_proof_invalidation,rms_fulfillment.pickup_proof_verification TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_ordering TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_ordering.order_header,rms_ordering.order_submission_record,rms_ordering.order_batch,rms_ordering.order_number_allocation,rms_ordering.order_item,rms_ordering.order_revision,rms_ordering.order_acceptance_record,rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record TO " +
      role,
  );
  await admin.query(
    "GRANT UPDATE ON rms_ordering.order_header,rms_ordering.order_batch TO " + role,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT has_table_privilege($1,'rms_ordering.order_header','UPDATE') AS header_allowed,has_table_privilege($1,'rms_ordering.order_batch','UPDATE') AS batch_allowed",
        [role],
      )
    ).rows[0]?.header_allowed,
    true,
  );
  assert.equal(
    (
      await admin.query(
        "SELECT has_table_privilege($1,'rms_ordering.order_batch','UPDATE') AS allowed",
        [role],
      )
    ).rows[0]?.allowed,
    true,
  );
  let nextOrderReference = 3180;
  const orderFixture = orderQueryFixture({ instantOffsetMs: -6 * 24 * 60 * 60 * 1000 }).record;
  const seedOrder = async (storeReference, sequence) => {
    const ids = new Map();
    const remap = (value) => {
      if (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
      ) {
        if (value === orderFixture.order.brandReference) return f.BRAND;
        if (value === orderFixture.order.storeReference) return storeReference;
        if (!ids.has(value)) ids.set(value, f.uuid(String(nextOrderReference++)));
        return ids.get(value);
      }
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
      return value;
    };
    const seeded = remap(orderFixture);
    seeded.orderNumberAllocation.sequence = BigInt(sequence);
    seeded.orderNumberAllocation.orderNumber = String(sequence);
    await seedAcceptanceOrderHistory(admin, seeded);
    return seeded.orderNumberAllocation.orderNumber;
  };
  const firstStoreOrderNumber = await seedOrder(f.STORE, 9001);
  const secondStoreOrderNumber = await seedOrder(f.uuid("610"), 9002);
  const key = randomBytes(32),
    pepper = randomBytes(32);
  let nextReference = 800,
    authorization;
  let denyWorkspace = false,
    wrongWorkspace = false,
    associationActive = true;
  const scope = { tenantReference: f.uuid("90"), brandReference: f.BRAND, storeReference: f.STORE };
  const targetReference = f.uuid("610");
  const credentials = {
    generate: () => randomBytes(32).toString("base64url"),
    generateUuidV7: () => f.uuid(String(nextReference++)),
  };
  const challenge = (value) => createHash("sha256").update(value).digest("base64url");
  let transactionTail = Promise.resolve();
  const options = {
    identity: {
      configuration: {
        issuer: "https://provider.example.test",
        clientId: "synthetic-client",
        redirectUri: "https://merchant.example.test/callback",
        environment: "synthetic",
        allowedPostLoginPaths: ["/operations/order-exceptions"],
      },
      credentials,
      hasher: {
        hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
        equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
      },
      pkce: { challenge },
      provider: {
        async createAuthorizationUrl(input) {
          authorization = input;
          return "https://provider.example.test/authorize";
        },
        async exchangeCode(input) {
          assert.equal(input.nonce, authorization.nonce);
          assert.equal(challenge(input.codeVerifier), authorization.codeChallenge);
          return { actor: f.actor, tokenBundle: "synthetic-provider-token-bundle" };
        },
        async revokeOrLogout() {
          return "unknown";
        },
      },
      envelopes: {
        async encrypt(plaintext, encryptionContext) {
          const nonce = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(encryptionContext));
          const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference: "ephemeral-test-key",
            encryptionContext,
            ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url"),
          };
        },
        async decrypt(envelope, encryptionContext) {
          assert.equal(envelope.encryptionContext, encryptionContext);
          const raw = Buffer.from(envelope.ciphertext, "base64url");
          const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
          decipher.setAAD(Buffer.from(encryptionContext));
          decipher.setAuthTag(raw.subarray(12, 28));
          return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
            "utf8",
          );
        },
      },
    },
    transactions: {
      async run(work) {
        const previous = transactionTail;
        let release;
        transactionTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({
              query: (sql, values) => client.query(sql, [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        } finally {
          release();
        }
      },
    },
    publication: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    },
    currentActor: async () => f.actor,
    now: () => clock.at,
    validateAssociation: async (_tx, session) => {
      return session.actor.actorReference === f.ACTOR && associationActive;
    },
    initialScope: async () => scope,
    targetScope: async (_tx, _session, storeReference) => ({ ...scope, storeReference }),
    // Synthetic metadata/candidate navigation; actual Permission policy is enforced by service.
    workspace: async (_tx, { context }) => {
      if (denyWorkspace) throw new Error("synthetic current access denied");
      const selectedScope = {
        brandLabel: context.brand.displayName,
        storeLabel: context.store.displayName,
        storeReference: wrongWorkspace ? f.STORE : context.store.storeReference,
      };
      return {
        screenId: "HOME-OVERVIEW",
        selectedScope,
        authorizedStores: [f.STORE, targetReference].map((storeReference) => ({
          brandLabel: "Untrusted candidate label",
          storeLabel: "Untrusted candidate label",
          storeReference,
        })),
        businessDate: "2099-01-01",
        storeStatus: "Unavailable",
        freshness: "Stale",
        dashboardAvailability: "UnavailableUntilWP1905",
        navigation: [
          {
            screenId: "CAT-PRODUCT-LIST",
            label: "Products",
            href: "/app/commerce/products",
            permission: "catalog.manage",
          },
          {
            screenId: "HOME-OVERVIEW",
            label: "Overview",
            href: "/app",
            permission: "merchant.access",
          },
          {
            screenId: "OPS-ORDER-EXCEPTION",
            label: "Exceptions",
            href: "/operations/order-exceptions",
            permission: "operations.order-exception.manage",
          },
        ],
      };
    },
  };
  const service = () => createPersistentMerchantBffService(options);
  const start = await service().start("/operations/order-exceptions");
  const loginInput = {
    code: credentials.generate(),
    state: authorization.state,
    authCookie: start.cookie.value,
  };
  const login = await service().callback(loginInput);
  await assert.rejects(service().callback(loginInput));
  const cookie = login.cookies.find((value) => !value.clear);
  assert(cookie);
  const initial = await service().bootstrap(cookie.value);
  assert.equal(initial.workspace.selectedScope.storeReference, f.STORE);
  assert.equal(initial.workspace.navigation.length, 2);
  assert.equal(initial.workspace.businessDate, businessDate);
  assert.equal(initial.workspace.storeStatus, "Open");
  assert.equal(initial.workspace.freshness, "Current");
  assert.deepEqual(
    initial.workspace.authorizedStores.map((entry) => entry.storeLabel),
    ["Synthetic Store", "Synthetic Second Store"],
  );
  assert.equal(initial.workspace.selectedScope.storeLabel, "Synthetic Store");
  const productPermission = f.uuid("9100"),
    storeProductGrant = f.uuid("9101"),
    brandProductRole = f.uuid("9102"),
    brandProductAssignment = f.uuid("9103"),
    brandProductGrant = f.uuid("9104");
  await admin.query(
    "INSERT INTO bop_permission.permission_definition VALUES($1,'catalog.product.manage','Active',1,$2,$2)",
    [productPermission, f.FROM],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
    [storeProductGrant, f.STORE_ROLE, productPermission, f.BRAND, f.STORE, f.FROM, f.UNTIL],
  );
  let navigationAllowed = true,
    navigationFailure = false,
    navigationCalls = 0;
  options.catalogProductNavigation = {
    async holdUntilTransactionCompletes(tx, input) {
      navigationCalls++;
      assert.equal(input.tenantReference, scope.tenantReference);
      assert.equal(input.brandReference, f.BRAND);
      assert.equal(input.storeReference, f.STORE);
      assert.equal(input.actorReference, f.ACTOR);
      assert.equal(input.sessionReference, initial.session.sessionReference);
      assert.equal(input.observedAt, f.AT);
      assert.equal(input.screenId, "CAT-PRODUCT-LIST");
      assert.equal(input.permission, "catalog.manage");
      assert.equal(input.action, "catalog.product.manage");
      assert.equal(input.capability, "catalog.cat_product_list");
      assert.equal(input.purposeCode, "CATALOG_PRODUCT_LIST");
      assert.equal(input.requiredFields.length, 16);
      assert(input.requiredFields.includes("skuLocalizedNames"));
      assert(Object.isFrozen(input.requiredFields));
      if (navigationFailure) await tx.query("SELECT 1/0", []);
      if (!navigationAllowed) throw new Error("synthetic unavailable field/Phase authority");
    },
  };
  const hasProduct = (result) =>
    result.workspace.navigation.some((item) => item.screenId === "CAT-PRODUCT-LIST");
  assert.equal(hasProduct(await service().bootstrap(cookie.value)), false); // Store grant never Brand grant.
  const currentBrandDecision = () =>
    options.transactions.run(async (tx) =>
      (
        await createMerchantBrandScope(options)(tx, cookie.value, initial.session.sessionReference)
      ).authorizeAction("catalog.product.manage"),
    );
  assert.equal((await currentBrandDecision()).effect, "Deny");
  await admin.query(
    "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_brand_product','Active',$3,$4,1,$3,$3)",
    [brandProductRole, f.BRAND, f.FROM, f.UNTIL],
  );
  await admin.query(
    "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
    [brandProductAssignment, brandProductRole, f.MEMBERSHIP, f.ACTOR, f.BRAND, f.FROM, f.UNTIL],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
    [brandProductGrant, brandProductRole, productPermission, f.BRAND, f.FROM, f.UNTIL],
  );
  const readGrants = [];
  for (const [permission, grant, action] of [
    [f.uuid("9105"), f.uuid("9115"), "catalog.manage"],
    [f.uuid("9106"), f.uuid("9116"), "catalog.product.read"],
    [f.uuid("9107"), f.uuid("9117"), "catalog.sku.read"],
  ]) {
    assert.equal(
      hasProduct(await service().bootstrap(cookie.value)),
      false,
      "generic Brand product manage alone cannot advertise source fields",
    );
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
      [permission, action, f.FROM],
    );
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
      [grant, brandProductRole, permission, f.BRAND, f.FROM, f.UNTIL],
    );
    readGrants.push(grant);
  }
  assert.equal(hasProduct(await service().bootstrap(cookie.value)), true);
  for (const grant of readGrants) {
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    assert.equal(
      hasProduct(await service().bootstrap(cookie.value)),
      false,
      "revoked fine read/Screen grant hides entry",
    );
    await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Active',role_id=$2,store_id=$3,version=version+1 WHERE grant_id=$1",
      [grant, f.STORE_ROLE, f.STORE],
    );
    assert.equal(
      hasProduct(await service().bootstrap(cookie.value)),
      false,
      "Store-only fine read does not replace Brand grant",
    );
    await admin.query(
      "UPDATE bop_permission.permission_grant SET role_id=$2,store_id=NULL,version=version+1 WHERE grant_id=$1",
      [grant, brandProductRole],
    );
    assert.equal(hasProduct(await service().bootstrap(cookie.value)), true);
  }

  assert.equal((await currentBrandDecision()).effect, "Allow");
  navigationAllowed = false;
  assert.equal(hasProduct(await service().bootstrap(cookie.value)), false);
  navigationAllowed = true;
  navigationFailure = true;
  const failedNavigation = await service().bootstrap(cookie.value);
  assert.equal(hasProduct(failedNavigation), false);
  assert.equal(failedNavigation.workspace.storeStatus, "Open");
  navigationFailure = false;
  await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=2 WHERE grant_id=$1",
    [brandProductGrant],
  );
  assert.equal(hasProduct(await service().bootstrap(cookie.value)), false);
  assert.equal((await currentBrandDecision()).effect, "Deny");
  assert(navigationCalls >= 5);
  delete options.catalogProductNavigation;
  await admin.query(
    "UPDATE bop_permission.role_assignment SET lifecycle='Ended',version=2 WHERE assignment_id=$1",
    [brandProductAssignment],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("878"),
      accessPermission,
      f.ACTOR,
      f.BRAND,
      targetReference,
      f.REASON,
      f.CORRELATION,
      clock.from,
      clock.until,
    ],
  );
  const restricted = await service().bootstrap(cookie.value);
  assert.deepEqual(
    restricted.workspace.authorizedStores.map((entry) => entry.storeReference),
    [f.STORE],
  );
  await assert.rejects(
    service().switchStore({
      sessionCookie: cookie.value,
      csrf: initial.csrf,
      targetStoreReference: targetReference,
    }),
  );
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("878")],
  );

  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("876"),
      accessPermission,
      f.ACTOR,
      f.BRAND,
      f.STORE,
      f.REASON,
      f.CORRELATION,
      clock.from,
      clock.until,
    ],
  );
  await assert.rejects(service().bootstrap(cookie.value));
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("876")],
  );

  const switchInput = {
    sessionCookie: cookie.value,
    csrf: initial.csrf,
    targetStoreReference: targetReference,
  };
  await assert.rejects(service().switchStore({ ...switchInput, csrf: credentials.generate() }));
  const nextRows = async () =>
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM bop_identity.authentication_session WHERE rotated_from_session_id=$1",
        [login.session.sessionReference],
      )
    ).rows[0].count;
  denyWorkspace = true;
  await assert.rejects(service().switchStore(switchInput));
  assert.equal(await nextRows(), 0);
  denyWorkspace = false;
  wrongWorkspace = true;
  await assert.rejects(service().switchStore(switchInput));
  assert.equal(await nextRows(), 0);
  wrongWorkspace = false;
  assert.equal(
    (await service().bootstrap(cookie.value)).workspace.selectedScope.storeReference,
    f.STORE,
  );
  const switched = await service().switchStore(switchInput);
  assert.equal(switched.workspace.selectedScope.storeReference, targetReference);
  assert.equal(switched.workspace.businessDate, targetBusinessDate);
  assert.equal(switched.workspace.storeStatus, "Closed");
  assert.equal(switched.workspace.freshness, "Current");
  assert.deepEqual(
    switched.workspace.navigation.map((entry) => entry.screenId),
    ["HOME-OVERVIEW", "OPS-ORDER-EXCEPTION"],
  );
  assert.equal(await nextRows(), 1);
  await assert.rejects(service().bootstrap(cookie.value));
  const refreshed = await service().bootstrap(switched.cookie.value);
  assert.notEqual(refreshed.csrf, initial.csrf);
  assert.equal(refreshed.workspace.selectedScope.storeReference, targetReference);
  await assert.rejects(
    service().authorize({ sessionCookie: switched.cookie.value, csrf: initial.csrf }),
  );
  associationActive = false;
  await assert.rejects(service().bootstrap(switched.cookie.value));
  associationActive = true;
  assert.equal((await service().logout(switched.cookie.value)).clear, true);
  await assert.rejects(service().bootstrap(switched.cookie.value));
  const gateLoginStart = await service().start("/operations/order-exceptions");
  const gateLogin = await service().callback({
    code: credentials.generate(),
    state: authorization.state,
    authCookie: gateLoginStart.cookie.value,
  });
  const gateCookie = gateLogin.cookies.find((value) => !value.clear);
  assert(gateCookie);
  const controlBootstrap = await service().bootstrap(gateCookie.value);
  await admin.query("GRANT USAGE ON SCHEMA rms_dining,platform_audit,platform_helpers TO " + role);
  await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
  await admin.query(
    "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_dining.dining_table TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_dining.dining_table_operation,rms_dining.dining_session,rms_dining.dining_join_capability,rms_dining.dining_session_start_operation,platform_audit.audit_record TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA rms_kitchen TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_kitchen.kitchen_work_queue_projection_generation,rms_kitchen.kitchen_work_queue_projection TO " +
      role,
  );
  const queueDigest = (value) => "sha256:" + sha256Hex(value);
  const seedTargetStoreEmptyGeneration = async () => {
    const generation = buildKitchenQueueGeneration({
      generationReference: f.uuid("3185"),
      generationStatus: "Active",
      feed: {
        brandReference: f.BRAND,
        storeReference: f.uuid("610"),
        sourceCheckpointReference: f.uuid("3186"),
        asOfUtc: clock.at,
        coverageStatus: "CompleteThroughCheckpoint",
        tickets: [],
      },
      rows: [],
      projectedAt: clock.at,
      lastRebuiltAt: clock.at,
      rebuildRequest: {
        action: "RebuildKitchenQueueProjection",
        purpose: "ProjectionRecovery",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        brandReference: f.BRAND,
        storeReference: f.uuid("610"),
        expectedActiveGenerationReference: null,
        rebuildReference: f.uuid("3187"),
        requestedAt: clock.at,
      },
      sha256: queueDigest,
    });
    await admin.query(
      "INSERT INTO rms_kitchen.kitchen_work_queue_projection_generation (projection_generation_id,brand_id,store_id,projection_name,projection_version,generation_status,source_checkpoint_reference,source_event_binding_digest,queue_snapshot_digest,ticket_count,work_item_count,initialized_empty,as_of_utc,projected_at,last_rebuilt_at,freshness_status,rebuild_reference,rebuild_request_digest,rebuild_requested_at,expected_prior_generation_id,snapshot_binding_version) VALUES ($1,$2,$3,'kitchen_work_queue_v1',1,'Active',$4,$5,$6,$7,$8,$9,$10,$11,$12,'Fresh',$13,$14,$15,$16,$17)",
      [
        generation.projectionGenerationReference,
        generation.brandReference,
        generation.storeReference,
        generation.sourceCheckpointReference,
        generation.sourceEventBindingDigest,
        generation.queueSnapshotDigest,
        generation.ticketCount,
        generation.workItemCount,
        generation.initializedEmpty,
        generation.asOfUtc,
        generation.projectedAt,
        generation.lastRebuiltAt,
        generation.rebuildReference,
        generation.rebuildRequestDigest,
        generation.rebuildRequestedAt,
        generation.expectedPriorGenerationReference,
        2,
      ],
    );
  };
  let ticketReference, workItemReference, orderReference, stationReference;
  let pickupExpectedFulfillmentReferences = [];
  let pickupExpectedInitialOrderNumbers;
  let kitchenExpectedOwnerRows;
  if (!pickupReady) {
    ticketReference = f.uuid("3164");
    workItemReference = f.uuid("3165");
    orderReference = f.uuid("3166");
    const batchReference = f.uuid("3167");
    const orderItemReference = f.uuid("3168");
    stationReference = f.uuid("3169");
    const sourceEvent = {
      eventId: f.uuid("3170"),
      eventType: "KitchenWorkCreated",
      schemaVersion: 1,
      occurredAt: clock.at,
      producerModule: "@rms/kitchen",
      tenantId: f.BRAND,
      storeId: f.STORE,
      aggregateType: "KitchenTicket",
      aggregateId: ticketReference,
      aggregateVersion: 1n,
      correlationId: f.uuid("3171"),
      causationId: f.uuid("3172"),
      actor: { type: "System" },
      payload: {
        kitchenTicketReference: ticketReference,
        orderReference,
        orderBatchReference: batchReference,
        confirmationReference: f.uuid("3173"),
        workItemCount: 1,
        aggregateVersion: 1,
        createdAt: clock.at,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    };
    const ticket = {
      brandReference: f.BRAND,
      storeReference: f.STORE,
      ticketReference,
      orderReference,
      orderBatchReference: batchReference,
      ticketAggregateVersion: 1n,
      ticketStatus: "Open",
      sourceEvent,
      items: [
        {
          ticketReference,
          workItemReference,
          orderReference,
          orderBatchReference: batchReference,
          orderItemReference,
          sourceItemOrdinal: 1,
          ticketAggregateVersion: 1n,
          workItemVersion: 1n,
          status: "Queued",
          requiredQuantity: 2,
          completedQuantity: 0,
          localizedDisplayNames: { "en-CA": "Synthetic noodles" },
          selectedOptions: [],
          stationReference,
          workItemCreatedAt: clock.at,
          acceptedAt: null,
          orderItemReadyAt: null,
          catalogSnapshotControlled: true,
        },
      ],
    };
    const feed = {
      brandReference: f.BRAND,
      storeReference: f.STORE,
      sourceCheckpointReference: f.uuid("3174"),
      asOfUtc: clock.at,
      coverageStatus: "CompleteThroughCheckpoint",
      tickets: [ticket],
    };
    const generationReference = f.uuid("3175");
    const queueRows = buildKitchenQueueRows({ generationReference, feed, sha256: queueDigest });
    await admin.query(
      "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,3,$8,$9,$10,$11,$12,2,$13,$9,$14,4,$15,$9,1,'Open','System','System',$9,$9)",
      [
        ticketReference,
        f.BRAND,
        f.STORE,
        orderReference,
        batchReference,
        f.uuid("3176"),
        sourceEvent.eventId,
        queueDigest("d"),
        clock.at,
        sourceEvent.correlationId,
        queueDigest("e"),
        f.uuid("3177"),
        queueDigest("f"),
        f.uuid("3178"),
        queueDigest("1"),
      ],
    );
    await admin.query(
      "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,1,'Queued',2,0,$10,$11,$12,$13,$14::jsonb,'[]'::jsonb,$15,$16,$17,2,$18,$19,5,$20,'[null]'::jsonb,$21,'System','System',$22,$22)",
      [
        workItemReference,
        f.BRAND,
        f.STORE,
        ticketReference,
        orderReference,
        batchReference,
        orderItemReference,
        f.uuid("3177"),
        f.uuid("3178"),
        f.uuid("3179"),
        f.uuid("3180"),
        f.uuid("3181"),
        f.uuid("3182"),
        JSON.stringify({ "en-CA": "Synthetic noodles" }),
        queueDigest("2"),
        stationReference,
        f.uuid("3183"),
        queueDigest("3"),
        f.uuid("3184"),
        queueDigest("4"),
        queueDigest("5"),
        clock.at,
      ],
    );
    const queueGeneration = buildKitchenQueueGeneration({
      generationReference,
      generationStatus: "Active",
      feed: {
        brandReference: f.BRAND,
        storeReference: f.STORE,
        sourceCheckpointReference: f.uuid("3162"),
        asOfUtc: clock.at,
        coverageStatus: "CompleteThroughCheckpoint",
        tickets: [ticket],
      },
      rows: queueRows,
      projectedAt: clock.at,
      lastRebuiltAt: clock.at,
      rebuildRequest: {
        action: "RebuildKitchenQueueProjection",
        purpose: "ProjectionRecovery",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        brandReference: f.BRAND,
        storeReference: f.STORE,
        expectedActiveGenerationReference: null,
        rebuildReference: f.uuid("3163"),
        requestedAt: clock.at,
      },
      sha256: queueDigest,
    });
    await admin.query(
      "INSERT INTO rms_kitchen.kitchen_work_queue_projection_generation (projection_generation_id,brand_id,store_id,projection_name,projection_version,generation_status,source_checkpoint_reference,source_event_binding_digest,queue_snapshot_digest,ticket_count,work_item_count,initialized_empty,as_of_utc,projected_at,last_rebuilt_at,freshness_status,rebuild_reference,rebuild_request_digest,rebuild_requested_at,expected_prior_generation_id,snapshot_binding_version) VALUES ($1,$2,$3,'kitchen_work_queue_v1',1,'Active',$4,$5,$6,1,1,false,$7,$7,$8,'Fresh',$9,$10,$11,$12,$13)",
      [
        queueGeneration.projectionGenerationReference,
        queueGeneration.brandReference,
        queueGeneration.storeReference,
        queueGeneration.sourceCheckpointReference,
        queueGeneration.sourceEventBindingDigest,
        queueGeneration.queueSnapshotDigest,
        queueGeneration.asOfUtc,
        queueGeneration.lastRebuiltAt,
        queueGeneration.rebuildReference,
        queueGeneration.rebuildRequestDigest,
        queueGeneration.rebuildRequestedAt,
        queueGeneration.expectedPriorGenerationReference,
        2,
      ],
    );
    await seedTargetStoreEmptyGeneration();
    const [queueRow] = queueRows;
    await admin.query(
      "INSERT INTO rms_kitchen.kitchen_work_queue_projection (projection_generation_id,brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_id,order_batch_id,order_item_id,source_item_ordinal,ticket_aggregate_version,work_item_version,status,required_quantity,completed_quantity,localized_display_names_json,selected_options_json,station_id,original_source_event_id,source_event_semantic_digest,source_event_occurred_at,work_item_created_at,accepted_at,order_item_ready_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22,$23)",
      [
        queueRow.projectionGenerationReference,
        queueRow.brandReference,
        queueRow.storeReference,
        queueRow.ticketReference,
        queueRow.workItemReference,
        queueRow.orderReference,
        queueRow.orderBatchReference,
        queueRow.orderItemReference,
        queueRow.sourceItemOrdinal,
        queueRow.ticketAggregateVersion,
        queueRow.workItemVersion,
        queueRow.status,
        queueRow.requiredQuantity,
        queueRow.completedQuantity,
        JSON.stringify(queueRow.localizedDisplayNames),
        JSON.stringify(queueRow.selectedOptions),
        queueRow.stationReference,
        queueRow.originalSourceEventReference,
        queueRow.sourceEventSemanticDigest,
        queueRow.sourceEventOccurredAt,
        queueRow.workItemCreatedAt,
        queueRow.acceptedAt,
        queueRow.orderItemReadyAt,
      ],
    );
  } else {
    const ownerOrderReference = pickupReady.creation.aggregate.orderReference;
    const ownerQueue = await admin.query(
      'SELECT p.kitchen_ticket_id AS "ticketReference",p.kitchen_work_item_id AS "workItemReference",p.order_id AS "orderReference",p.ticket_aggregate_version::text AS "ticketAggregateVersion",p.work_item_version::text AS "workItemVersion",p.status,p.required_quantity AS "requiredQuantity",p.completed_quantity AS "completedQuantity",p.localized_display_names_json AS "localizedDisplayNames",p.station_id AS "stationReference" FROM rms_kitchen.kitchen_work_queue_projection p JOIN rms_kitchen.kitchen_work_queue_projection_generation g ON g.projection_generation_id=p.projection_generation_id AND g.brand_id=p.brand_id AND g.store_id=p.store_id WHERE p.store_id=$1 AND p.order_id=$2 AND g.generation_status=\'Active\' ORDER BY p.kitchen_ticket_id,p.kitchen_work_item_id',
      [f.STORE, ownerOrderReference],
    );
    assert(ownerQueue.rowCount > 0);
    kitchenExpectedOwnerRows = ownerQueue.rows;
    await seedTargetStoreEmptyGeneration();
    const ownerFulfillment = await admin.query(
      "SELECT fulfillment_id FROM rms_fulfillment.fulfillment WHERE store_id=$1 AND order_id=$2 AND fulfillment_type='Pickup'",
      [f.STORE, ownerOrderReference],
    );
    assert.equal(ownerFulfillment.rowCount, 1);
    pickupExpectedFulfillmentReferences = [ownerFulfillment.rows[0].fulfillment_id];
    const ownerOrderNumber = await admin.query(
      "SELECT order_number FROM rms_ordering.order_number_allocation WHERE order_id=$1",
      [ownerOrderReference],
    );
    assert.equal(ownerOrderNumber.rowCount, 1);
    pickupExpectedInitialOrderNumbers = [
      ownerOrderNumber.rows[0].order_number,
      firstStoreOrderNumber,
    ];
  }
  const tableReference = f.uuid("3152");
  const table = createDiningTable({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    tableReference,
    stableLabel: "T01",
    areaReference: f.uuid("3153"),
    areaCode: "MAIN",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: clock.from,
    observedAt: clock.at,
  });
  await admin.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7)",
    [
      tableReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      JSON.stringify(table),
      table.createdAt,
      table.observedAt,
    ],
  );
  const targetStoreTableReference = f.uuid("3188");
  const targetStoreTable = createDiningTable({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: f.uuid("610"),
    tableReference: targetStoreTableReference,
    stableLabel: "S2-T01",
    areaReference: f.uuid("3189"),
    areaCode: "MAIN",
    capacity: 2,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: null,
    aggregateVersion: 1,
    createdAt: clock.from,
    observedAt: clock.at,
  });
  await admin.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7)",
    [
      targetStoreTableReference,
      scope.tenantReference,
      scope.brandReference,
      f.uuid("610"),
      JSON.stringify(targetStoreTable),
      targetStoreTable.createdAt,
      targetStoreTable.observedAt,
    ],
  );
  const unusedConfiguration = async () => {
    throw new Error("unused in Dining command acceptance");
  };
  await admin.query("GRANT USAGE ON SCHEMA platform_projection TO " + role);
  await admin.query("GRANT SELECT ON platform_projection.order_exception_source TO " + role);
  const orderExceptions = createPersistentMerchantOrderExceptions({
    persistence: options,
    metadata: async (_tx, { scope, storeLabel }) => {
      if (
        scope.tenantReference !== f.uuid("90") ||
        scope.brandReference !== f.BRAND ||
        ![f.STORE, f.uuid("610")].includes(scope.storeReference)
      )
        throw new Error("synthetic exception metadata scope mismatch");
      return {
        storeLabel,
        businessDate: scope.storeReference === f.STORE ? businessDate : targetBusinessDate,
        checkpointReference: scope.storeReference === f.STORE ? f.uuid("3201") : f.uuid("3202"),
        projectedAt: clock.at,
        freshnessStatus: "Stale",
      };
    },
  });
  const merchantRuntime = createMerchantRuntime({
    persistence: options,
    exactOrigin: "https://merchant.example.test",
    acceptedHost: "merchant.example.test",
    serviceAudit: {
      reasonCode: "SYNTHETIC_SERVICE_CONTROL",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
    configuration: {
      actionPermissions: {
        saveDraft: "store.service.save-draft",
        validate: "store.service.validate",
        submit: "store.service.submit",
        approve: "store.service.approve",
        publish: "store.service.publish",
      },
      configure: unusedConfiguration,
      review: { validate: unusedConfiguration, snapshotAudit: unusedConfiguration },
    },
    diningTableCommand: {
      newReference: () => credentials.generateUuidV7(),
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
    diningSessionStart: {
      credentials: {
        generateReference: () => credentials.generateUuidV7(),
        generateJoinCredential: (kind) =>
          kind === "Invitation"
            ? parseDiningJoinInvitationCredential("AQEBAQEBAQEBAQEBAQEBAQ")
            : parseDiningJoinHumanCode("123456"),
        hashJoinCredential: (kind, credential) =>
          parsePublicCapabilitySelectorHash(
            createHash("sha256").update(`${kind}:${credential}`).digest("hex"),
          ),
        hashOperationIntent: (intent) =>
          parseDiningHash(createHash("sha256").update(intent).digest("hex")),
        equals: (left, right) => left === right,
      },
      pepperVersion: 1,
      newReference: () => credentials.generateUuidV7(),
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
    kitchenQuery: {
      sha256: (value) => "sha256:" + sha256Hex(value),
    },
    orderExceptions,
    taskInbox: {
      queue: {
        tenantReference: f.uuid("90"),
        brandReference: f.BRAND,
        storeReference: f.STORE,
        queueReference: f.uuid("3190"),
        effectiveFrom: clock.from,
        effectiveUntil: clock.until,
      },
      additionalQueues: [
        {
          tenantReference: f.uuid("90"),
          brandReference: f.BRAND,
          storeReference: f.uuid("610"),
          queueReference: f.uuid("3203"),
          effectiveFrom: clock.from,
          effectiveUntil: clock.until,
        },
      ],
    },
    orderQueue: { quoteVersion: 1 },
    pickupQuery: {
      store: {
        sha256: (value) => "sha256:" + sha256Hex(value),
        validateCurrentSource: async (transaction, orderReference) => {
          if (!pickupReady) return false;
          const current = await pickupReady.source.resolve({
            transaction,
            query: { ...pickupReady.query, orderReference },
          });
          return (
            current.orderType === "Pickup" &&
            current.orderReference === pickupReady.creation.aggregate.orderReference
          );
        },
      },
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [selected.brandReference, selected.storeReference],
        );
      },
    },
  });
  const tableCommand = merchantRuntime.diningTableCommand;
  assert.equal(typeof tableCommand, "function");
  const tableCounts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_dining.dining_table_operation WHERE table_id=$1) AS operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1 AND action_code IN ('DINING_TABLE_SETBLOCK','DINING_TABLE_CLEARBLOCK')) AS audits",
        [tableReference],
      )
    ).rows[0];
  const setBlock = {
    sessionCookie: gateCookie.value,
    csrf: controlBootstrap.csrf,
    command: {
      action: "SetBlock",
      tableReference,
      expectedAggregateVersion: 1,
      operationReference: f.uuid("3154"),
      reasonCode: "CLEANING",
    },
  };
  const clearBlock = {
    ...setBlock,
    command: {
      action: "ClearBlock",
      tableReference,
      expectedAggregateVersion: 2,
      operationReference: f.uuid("3155"),
      reasonCode: null,
    },
  };
  await verifyPersistentMerchantBffHttp({
    service: merchantRuntime.service,
    authorization: () => authorization,
    credentials,
    initialStore: f.STORE,
    targetStore: targetReference,
    diningTables: merchantRuntime.diningTables,
    diningTableListInput: { afterTableReference: null, limit: 50 },
    diningExpectedTableReferences: [tableReference, targetStoreTableReference],
    diningTableCommand: tableCommand,
    diningTableInput: setBlock.command,
    diningTableClearInput: clearBlock?.command,
    ...(kitchenExpectedOwnerRows ? { kitchenExpectedOwnerRows } : {}),
    kitchenQuery: merchantRuntime.kitchenQuery,
    kitchenListInput: {
      kind: "List",
      filters: {
        orderReference: null,
        ticketReference: pickupReady ? null : ticketReference,
        workItemReference: null,
        stationReference: null,
        status: null,
      },
      cursor: null,
      limit: 50,
    },
    ...(pickupReady ? { kitchenExpectedOwnerRows } : {}),
    taskInbox: merchantRuntime.taskInbox,
    taskInboxObservedAt: clock.at,
    ...(pickupReady
      ? {}
      : {
          kitchenOrderListInput: {
            kind: "List",
            filters: {
              orderReference,
              ticketReference: null,
              workItemReference: null,
              stationReference: null,
              status: null,
            },
            cursor: null,
            limit: 50,
          },
          kitchenGetInput: { kind: "Get", workItemReference },
          kitchenExpectedWorkItemReference: workItemReference,
          kitchenExpectedStationReference: stationReference,
        }),
    orderQueue: merchantRuntime.orderQueue,
    expectedOrderNumbers: [firstStoreOrderNumber, secondStoreOrderNumber],
    ...(pickupExpectedInitialOrderNumbers ? { pickupExpectedInitialOrderNumbers } : {}),
    pickupQuery: merchantRuntime.pickupQuery,
    pickupExpectedFulfillmentReferences,
    pickupListInput: {
      afterFulfillmentReference: null,
      limit: 50,
      includeCompleted: false,
    },
    orderExceptions: merchantRuntime.orderExceptions,
    orderExceptionsTargetBusinessDate: targetBusinessDate,
  });
  if (pickupReady) return;
  const blocked = await tableCommand(setBlock);
  assert.deepEqual(blocked, {
    status: "AlreadyApplied",
    tableReference,
    operationalState: "TemporarilyBlocked",
    aggregateVersion: 2,
  });
  assert.equal((await tableCommand(setBlock)).status, "AlreadyApplied");
  assert.deepEqual(await tableCounts(), { operations: 2, audits: 2 });
  assert.deepEqual(
    (
      await admin.query(
        "SELECT table_snapshot->>'operationalState' AS state,table_snapshot->>'aggregateVersion' AS version FROM rms_dining.dining_table WHERE table_id=$1",
        [tableReference],
      )
    ).rows[0],
    { state: "Available", version: "3" },
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT record_json->'event'->>'eventType' AS event_type FROM rms_dining.dining_table_operation WHERE table_id=$1",
        [tableReference],
      )
    ).rows,
    [
      { event_type: "DiningTableOperationalStateChanged" },
      { event_type: "DiningTableOperationalStateChanged" },
    ],
  );
  const cleared = await tableCommand(clearBlock);
  assert.deepEqual(cleared, {
    status: "AlreadyApplied",
    tableReference,
    operationalState: "Available",
    aggregateVersion: 3,
  });
  assert.deepEqual(await tableCounts(), { operations: 2, audits: 2 });
  assert.deepEqual(
    (
      await admin.query(
        "SELECT table_snapshot->>'operationalState' AS state,table_snapshot->>'aggregateVersion' AS version FROM rms_dining.dining_table WHERE table_id=$1",
        [tableReference],
      )
    ).rows[0],
    { state: "Available", version: "3" },
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT record_json->'event'->>'eventType' AS event_type FROM rms_dining.dining_table_operation WHERE table_id=$1 ORDER BY result_version",
        [tableReference],
      )
    ).rows,
    [
      { event_type: "DiningTableOperationalStateChanged" },
      { event_type: "DiningTableOperationalStateChanged" },
    ],
  );
  await admin.query(
    "INSERT INTO bop_permission.permission_override VALUES ($1,$2,$3,$4,$5,'Deny','Active',$6,$7,$8,$9,1,$8,$8)",
    [
      f.uuid("3156"),
      diningOperatePermission,
      f.ACTOR,
      f.BRAND,
      f.STORE,
      f.REASON,
      f.CORRELATION,
      clock.from,
      clock.until,
    ],
  );
  await assert.rejects(
    tableCommand({
      command: {
        action: "SetBlock",
        tableReference,
        expectedAggregateVersion: 3,
        operationReference: f.uuid("3157"),
        reasonCode: "CLEANING",
      },
      sessionCookie: gateCookie.value,
      csrf: controlBootstrap.csrf,
    }),
  );
  await admin.query(
    "UPDATE bop_permission.permission_override SET lifecycle='Revoked',version=2 WHERE override_id=$1",
    [f.uuid("3156")],
  );
  const startSession = {
    tableReference,
    expectedAssignmentVersion: 3,
    operationReference: f.uuid("3158"),
    joinKind: "Invitation",
  };
  await verifyPersistentMerchantBffHttp({
    service: merchantRuntime.service,
    authorization: () => authorization,
    credentials,
    initialStore: f.STORE,
    targetStore: targetReference,
    diningTableCommand: tableCommand,
    diningSessionStart: merchantRuntime.diningSessionStart,
    diningSessionStartInput: startSession,
  });
  assert.deepEqual(
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_dining.dining_session WHERE table_id=$1) AS sessions,(SELECT count(*)::int FROM rms_dining.dining_join_capability WHERE session_id IN (SELECT session_id FROM rms_dining.dining_session WHERE table_id=$1)) AS capabilities,(SELECT count(*)::int FROM rms_dining.dining_session_start_operation WHERE session_id IN (SELECT session_id FROM rms_dining.dining_session WHERE table_id=$1)) AS starts",
        [tableReference],
      )
    ).rows[0],
    { sessions: 1, capabilities: 1, starts: 1 },
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT table_snapshot->>'operationalState' AS state,table_snapshot->>'aggregateVersion' AS version,table_snapshot->>'activeDiningSessionReference' AS session FROM rms_dining.dining_table WHERE table_id=$1",
        [tableReference],
      )
    ).rows[0],
    {
      state: "Available",
      version: "4",
      session: (
        await admin.query(
          "SELECT session_id::text AS reference FROM rms_dining.dining_session WHERE table_id=$1",
          [tableReference],
        )
      ).rows[0].reference,
    },
  );
  assert.deepEqual(await tableCounts(), { operations: 2, audits: 2 });
  let controlAt = clock.at;
  const control = createMerchantServiceControl({
    persistence: { ...options, now: () => controlAt },
    authentication: service(),
    audit: {
      reasonCode: "SYNTHETIC_SERVICE_CONTROL",
      retentionPolicyCode: "STORE_SERVICE_AUDIT",
      retentionPolicyVersion: 1,
    },
  });
  await admin.query(
    "GRANT INSERT ON rms_store.store_configuration_operation,rms_store.store_service_pause_content,rms_store.store_service_resume_content TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
  await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO " + role);
  const controlRequest = {
    sessionCookie: gateCookie.value,
    csrf: controlBootstrap.csrf,
    command: {
      command: "PauseService",
      operationReference: f.uuid("3100"),
      configurationReference: f.uuid("910"),
      expectedVersion: 0,
      auditReference: f.uuid("3101"),
      content: { effectiveUntil: clock.until, serviceModes: ["Pickup"] },
    },
  };
  await assert.rejects(control(controlRequest), /STORE_SERVICE_PERMISSION_DENIED/u);
  await assert.rejects(control.read(gateCookie.value));
  for (const [code, number] of [
    ["store.service.pause", 3110],
    ["store.service.read", 3140],
    ["store.service.resume", 3120],
  ]) {
    await admin.query(
      "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
      [f.uuid(String(number)), code, clock.from],
    );
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [
        f.uuid(String(number + 1)),
        f.STORE_ROLE,
        f.uuid(String(number)),
        f.BRAND,
        f.STORE,
        clock.from,
        clock.until,
      ],
    );
  }
  const configurationService = await verifyMerchantConfigurationCommand({
    admin,
    role,
    options: { ...options, now: () => controlAt },
    service: service(),
    cookie: gateCookie.value,
    csrf: controlBootstrap.csrf,
  });
  await assert.rejects(control({ ...controlRequest, csrf: credentials.generate() }));
  await assert.rejects(
    control({ ...controlRequest, command: { ...controlRequest.command, actorReference: f.ACTOR } }),
    /STORE_SERVICE_COMMAND_INVALID/u,
  );
  const beforeControl = await control.read(gateCookie.value);
  assert.equal(beforeControl.configurationReference, f.uuid("910"));
  assert.equal(beforeControl.expectedVersion, 0);
  assert.deepEqual(beforeControl.activePauses, []);
  assert.deepEqual(await control(controlRequest), { status: "Applied", resultingVersion: 1 });
  const duringControl = await control.read(gateCookie.value);
  assert.equal(duringControl.expectedVersion, 1);
  assert.equal(duringControl.activePauses[0].closureReference, f.uuid("3100"));

  assert.deepEqual(await control(controlRequest), {
    status: "AlreadyApplied",
    resultingVersion: 1,
  });
  assert.equal((await service().bootstrap(gateCookie.value)).workspace.storeStatus, "Paused");
  controlAt = new Date(Date.parse(clock.at) + 60000).toISOString();
  assert.deepEqual(
    await control({
      ...controlRequest,
      command: {
        command: "ResumeService",
        operationReference: f.uuid("3130"),
        configurationReference: f.uuid("910"),
        expectedVersion: 1,
        auditReference: f.uuid("3131"),
        content: { pauseOperationReference: f.uuid("3100") },
      },
    }),
    { status: "Applied", resultingVersion: 2 },
  );
  const afterControl = await control.read(gateCookie.value);
  assert.equal(afterControl.expectedVersion, 2);
  assert.deepEqual(afterControl.activePauses, []);
  const laterService = createPersistentMerchantBffService({ ...options, now: () => controlAt });
  assert.equal((await laterService.bootstrap(gateCookie.value)).workspace.storeStatus, "Open");
  if (process.env.BOP_MERCHANT_SERVICE_BROWSER === "1") {
    const { verifyMerchantServiceBrowser } = await import("./merchant-service-browser.mjs");
    await verifyMerchantServiceBrowser({
      control,
      configuration: configurationService,
      assertConfigurationAudit: async (command) => {
        const persisted = await admin.query(
          "SELECT actor_reference,configuration_json FROM rms_store.store_configuration_authoring_operation WHERE operation_id=$1",
          [command.operationReference],
        );
        assert.equal(persisted.rowCount, 1);
        assert.equal(persisted.rows[0].actor_reference, f.ACTOR);
        if (command.command === "Approve") {
          assert.notEqual(persisted.rows[0].configuration_json.authoredByReference, f.ACTOR);
          assert.equal(persisted.rows[0].configuration_json.approvedByReference, f.ACTOR);
          assert.equal(
            persisted.rows[0].configuration_json.approvalEvidenceReference,
            command.operationReference,
          );
        } else assert.equal(persisted.rows[0].configuration_json.authoredByReference, f.ACTOR);
        assert.equal(persisted.rows[0].configuration_json.businessDayStartLocalTime, "05:00:00");
        assert.equal(
          (
            await admin.query("SELECT * FROM platform_audit.audit_record WHERE audit_id=$1", [
              command.auditReference,
            ])
          ).rowCount,
          1,
        );
      },
      cookie: gateCookie.value,
      store: f.STORE,
      now: () => controlAt,
      advance: () => {
        controlAt = new Date(Date.parse(controlAt) + 60000).toISOString();
      },
    });
  }

  const auditGapState = await control.read(gateCookie.value);
  const auditGapVersion = auditGapState.expectedVersion;
  const auditGapCommand = {
    brandReference: f.BRAND,
    storeReference: f.STORE,
    command: "PauseService",
    operationReference: f.uuid("3350"),
    configurationReference: auditGapState.configurationReference,
    actorReference: f.ACTOR,
    purposeCode: "STORE_SERVICE",
    expectedVersion: auditGapVersion,
    auditReference: f.uuid("3351"),
    content: { effectiveUntil: clock.until, serviceModes: ["Pickup"] },
  };
  const auditGapDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(auditGapCommand));
  await admin.query(
    "INSERT INTO rms_store.store_configuration_operation VALUES($1,$2,$3,$4,'PauseService',$5,$6,$7,$8,'STORE_SERVICE',$9,$10,'ConfigurationMetadata')",
    [
      auditGapCommand.operationReference,
      f.BRAND,
      f.STORE,
      auditGapState.configurationReference,
      auditGapDigest,
      auditGapVersion,
      auditGapVersion + 1,
      f.ACTOR,
      f.uuid("3351"),
      controlAt,
    ],
  );
  await admin.query(
    "INSERT INTO rms_store.store_service_pause_content VALUES($1,$2,$3,'PauseService',$4,$5,ARRAY['Pickup'],'ConfigurationMetadata')",
    [f.BRAND, f.STORE, auditGapCommand.operationReference, controlAt, clock.until],
  );
  await assert.rejects(control.read(gateCookie.value), /STORE_PAUSE_HISTORY_UNAVAILABLE/u);
  await options.transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      f.BRAND,
      f.STORE,
    ]);
    await appendAuditRecordInTransaction(tx, {
      auditId: f.uuid("3351"),
      brandId: f.BRAND,
      storeId: f.STORE,
      actor: { type: "User", reference: f.ACTOR },
      actionCode: "STORE_SERVICE_PAUSED",
      targetType: "StoreServiceControl",
      targetId: f.uuid("3350"),
      correlationId: f.uuid("3350"),
      reasonCode: "SYNTHETIC_AUDIT_BINDING",
      occurredAt: controlAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "STORE_SERVICE_AUDIT",
      retentionPolicyVersion: 1,
      afterSummary: {
        intentDigest: auditGapDigest,
        expectedVersion: auditGapVersion,
        resultingVersion: auditGapVersion + 1,
      },
    });
  });
  assert.equal((await control.read(gateCookie.value)).expectedVersion, auditGapVersion + 1);
  if (process.env.BOP_MERCHANT_SERVICE_BROWSER !== "1")
    await configurationService.verifyPublication();
  await admin.query(
    "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-STORE-LIVE-GATE',$2,$3,$4,2,'Production','Reopened',$5,$6,NULL,NULL,NULL,$7,'ConfigurationMetadata')",
    [f.uuid("1080"), f.uuid("90"), f.BRAND, f.STORE, f.uuid("937"), f.uuid("936"), clock.at],
  );
  await assert.rejects(service().bootstrap(gateCookie.value));
  await service().logout(gateCookie.value);
}

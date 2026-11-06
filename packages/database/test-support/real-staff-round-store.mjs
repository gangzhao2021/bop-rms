import assert from "node:assert/strict";
import { confirmedMenuPrices } from "./menu-price-confirmation.mjs";
import process from "node:process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createTenantTransactionRunner } from "../src/index.ts";
import {
  createAllergenRegistryVersion,
  recordIngredientAllergenDeclaration,
  staffAllergenDeclarationSource,
} from "../../rms/catalog/src/index.ts";
import {
  changeDiningTeaChargeSetting,
  loadDiningTeaChargeSetting,
} from "../../rms/dining/src/index.ts";
import { changeKitchenNotPreparedProduct } from "../../rms/kitchen/src/index.ts";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantCombos } from "../../../apps/api/src/merchant-combos.ts";
import { createMerchantDishAllergens } from "../../../apps/api/src/merchant-dish-allergens.ts";
import { createMerchantMenus } from "../../../apps/api/src/merchant-menus.ts";
import { createMerchantOneStoreDishes } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import { createMerchantOptionPrices } from "../../../apps/api/src/merchant-option-prices.ts";
import { createMerchantOptionRecipes } from "../../../apps/api/src/merchant-option-recipes.ts";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createMerchantDiningTableQr } from "../../../apps/api/dist/merchant-dining-table-qr.js";
import { createInternalCredentialLoaders } from "../../../tooling/environment/pilot-credentials.mjs";
import { createInternalCounterOrder } from "../../../tooling/environment/pilot-counter-order.mjs";
import { composeCustomerDependencies } from "../../../tooling/environment/pilot-customer-composition.mjs";
import { createInternalCustomerEntry } from "../../../tooling/environment/pilot-customer-entry.mjs";
import { createInternalDiningCredentialLoaders } from "../../../tooling/environment/pilot-dining-credentials.mjs";
import { createIssuedDiningEntries } from "../../../tooling/environment/pilot-dining-issued-entry.mjs";
import { createInternalDiningSession } from "../../../tooling/environment/pilot-dining-session.mjs";
import { createInternalPickupEntry } from "../../../tooling/environment/pilot-entry.mjs";
import { createInternalPricingPolicy } from "../../../tooling/environment/pilot-pricing-policy.mjs";
import { provisionPilotCredentials } from "../../../tooling/environment/pilot-provision-credentials.mjs";
import { createInternalQrLoaders } from "../../../tooling/environment/pilot-qr.mjs";
import { createInternalTestResources } from "../../../tooling/environment/pilot-resources.mjs";
import { alignProcessClockToDatabase } from "../../../tooling/environment/pilot-database-clock.mjs";
import { prepareCurrentEntryProfile } from "./current-entry-profile.mjs";
import { prepareEntryDiningTable } from "./entry-dining-table.mjs";
import { prepareEntryOperatingPublication } from "./entry-operating-publication.mjs";
import { seedStoreKitchenInEffect } from "./kitchen-routing-configuration.mjs";
import { syntheticMerchantBrandScope } from "./merchant-brand-scope.mjs";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { seedBrand, seedBrandMember, seedBrandRole } from "./sole-operator-brand-gate.mjs";
import { seedSubmissionInventoryRecipe } from "./submission-inventory-recipe.mjs";
import { seedSubmissionInventoryStock } from "./submission-inventory-stock.mjs";
import { seedSubmissionInventoryWorkflow } from "./submission-inventory-workflow.mjs";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";

// WP-2423 M71: the price list "List it" confirms (read as the review reads it).
let menuPrices;

const { Client, Pool } = pg;
const idsOf = (merchant) => (n) =>
  (0x01a7ee00 + merchant).toString(16).padStart(8, "0") +
  "-0000-7000-8000-" +
  n.toString(16).padStart(12, "0");
const uuidTime = () =>
  Date.now()
    .toString(16)
    .padStart(12, "0")
    .replace(/^(.{8})(.{4})$/u, "$1-$2");

/**
 * WP-2423 item 10: one Store that takes real dine-in rounds in an isolated database, with the
 * production composition of a staff round on top: `createInternalCounterOrder` (the pilot's own
 * tooling/environment wiring: table QR entry, Join, Dining binding, the table's Cart, configured
 * Quote v2 with tax, checkout details, checkout, first-or-later round submission, pay-later send).
 * Everything under test runs on the pilot's transaction runner as the restricted NOBYPASSRLS API
 * role holding only the rendered pilot ACL (the caller creates and grants it).
 *
 * Real: table and its issued QR code (Merchant QR command, TEST-ONLY key file from the pilot's own
 * provisioning), Store publication and profile (Publishing/Store owners), menu, prices, recipes and
 * the tea dish (the one-page menu commands an Owner uses), stock (Inventory command), staff sessions
 * (membership, role, encrypted Session).
 *
 * Owner-seeded TEST facts, each a stand-in for approvals or configuration that is not what these
 * tests prove: Store publication approvals and Live Gate; the tax rate (the pilot's own TEST-ONLY
 * tax fixture); the Store's published workflow and the kitchen line; the soup's published recipe and
 * received stock (DEC: authoring of a stock recipe has its own acceptance); the menu authors' Brand
 * scope (`syntheticMerchantBrandScope`). The guest-entry abuse budget is not composed: a staff round
 * never reads it. No Provider is ever reached: the pilot's staff round composes a Provider that
 * throws when called.
 */
export async function prepareRealStaffRoundStore({
  admin,
  context,
  api,
  /** "PayLater": tables pay once at the end. "PayNow": each round is charged on the card machine. */
  paymentTiming = "PayLater",
  /** 1 and up: another merchant in the same database, with its own synthetic identities. */
  merchant = 0,
}) {
  const id = idsOf(merchant);
  const fixtureIds = (n) => (0x01a80000 + merchant * 0x100 + n).toString(16).padStart(8, "0");
  const another = merchant === 0 ? null : (n) => fixtureIds(n);
  const tenantReference = id(1),
    brandReference = id(2),
    storeReference = id(3),
    owner = id(4),
    taxClassificationReference = id(5);
  const ownerScope = { tenantReference, brandReference, storeReference };
  const scope = { brandReference, storeReference };
  const now = () => new Date().toISOString();
  let sequence = 0x10000 + merchant * 0x1000000;
  const reference = () => uuidTime() + "-7000-8000-" + (sequence++).toString(16).padStart(12, "0");
  const start = Date.parse(
    (await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")).rows[0].at,
  );
  const at = new Date(start - 3 * 3600_000).toISOString();
  const database = context.clientConfig.database;

  // Setup helpers also grant step by step to a role of theirs: never the role under test.
  const seedRole = "wp2423_rsr_seed" + merchant + "_" + context.runId;
  await admin.query(
    "CREATE ROLE " + seedRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
  );
  // TEST-ONLY setup runs as the database owner, as the skill says.
  const ownerRun = async (work) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenantReference, brandReference, storeReference],
      );
      const value = await work({ query: (sql, values) => client.query(sql, values) });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };
  // One restricted transaction as the pilot's API (its connection pool, its runner).
  const pool = new Pool({
    ...context.clientConfig,
    max: 8,
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
    statement_timeout: 8000,
    lock_timeout: 5000,
  });
  // As the served pilot does (compose.pilot.yaml), when the test asks for it.
  if (process.env.PILOT_CLOCK_FROM_DATABASE === "1")
    await alignProcessClockToDatabase((sql) => pool.query(sql));
  const restrictedPool = {
    options: pool.options,
    async connect() {
      const client = await pool.connect();
      await client.query("SET ROLE " + api);
      return client;
    },
  };
  const applicationDatabase = {
    transactions: (selected) => createTenantTransactionRunner(restrictedPool, selected),
    acquire: () => restrictedPool.connect(),
    close: () => pool.end(),
  };
  const restricted = applicationDatabase.transactions({
    brandId: brandReference,
    storeId: storeReference,
  });
  // A tenant-scoped restricted transaction, for the owner functions that name the Tenant.
  const asApi = async (work) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + api);
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenantReference, brandReference, storeReference],
      );
      const value = await work({ query: (sql, values) => client.query(sql, values) });
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };

  // ── The Store: organization facts, published profile, the pilot's installation files.
  await seedBrand(admin, {
    brandReference,
    policyReference: id(6),
    from: at,
    ...(merchant === 0 ? {} : { code: "SYNTHETIC_MERCHANT_" + merchant }),
  });
  await admin.query(
    "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'REAL_ROUND','Synthetic real round Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [storeReference, brandReference, at],
  );
  const publicOptions = await prepareCurrentEntryProfile({
    admin,
    role: seedRole,
    run: ownerRun,
    at,
    tenantReference,
    brandReference,
    storeReference,
    existingOrganizationFacts: true,
    ...(another === null ? {} : { idPrefix: another(1) }),
  });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bop-real-staff-round-")));
  await chmod(directory, 0o700);
  const menu = {
    environment: "InternalTest",
    database,
    menuReference: id(0x499),
    // The pricing policy's own (unused) TEST price book names one item; the Store's own prices are
    // the ones the Owner saves below and the Quote reads.
    skuReference: id(0x498),
    taxClassificationReference,
  };
  const profile = {
    environment: "InternalTest",
    database,
    createdAt: at,
    binding: publicOptions.binding,
    // Another merchant's own synthetic tax identities, as a served TEST Store has.
    ...(another === null ? {} : { storeTaxConfiguration: { createdAt: at } }),
  };
  const loadProfile = async () => profile,
    loadMenu = async () => menu;
  const profileFile = join(directory, "internal-test-profile.json");
  await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  assert.equal(
    (await provisionPilotCredentials({ directory, expectedDatabaseName: database })).status,
    "Ready",
  );

  // ── The Store's tax (the pilot's own TEST-ONLY fixture), named by its published configuration.
  const policy = await createInternalPricingPolicy({
    loadProfile,
    loadMenu,
    expectedDatabaseName: database,
  });
  await seedTaxConfiguration(admin, policy.taxConfiguration, owner);
  await prepareEntryOperatingPublication({
    admin,
    role: seedRole,
    binding: publicOptions.binding,
    at,
    currentWindow: true,
    taxConfigurationReference: policy.taxConfiguration.configurationReference,
    ...(another === null ? {} : { idPrefix: another(2) }),
  });
  await seedStoreKitchenInEffect({ admin, role: seedRole, scope, at, id: (n) => id(0x2000 + n) });

  // Stock, the Store's published dine-in workflow and how its tables pay.
  const stock = await seedSubmissionInventoryStock({
    admin,
    runner: () => ({ run: ownerRun }),
    ownerScope,
    actorReference: owner,
    at,
    ...(another === null ? {} : { idPrefix: another(3) }),
  });
  const workflow = await seedSubmissionInventoryWorkflow({
    runner: () => ({ run: ownerRun }),
    scope: ownerScope,
    actorReference: owner,
    at,
    orderType: "DineIn",
    ...(another === null ? {} : { idPrefix: another(4) }),
  });
  if (paymentTiming === "PayLater")
    await admin.query(
      "INSERT INTO rms_dining.store_dining_payment_timing (tenant_id,brand_id,store_id,version,payment_timing,operation_id,intent_hash,actor_id,changed_at) VALUES ($1,$2,$3,1,'PayLater',$4,$5,$6,$7)",
      [tenantReference, brandReference, storeReference, id(7), "a".repeat(64), owner, at],
    );

  // ── The menu, through the one-page menu commands an Owner uses (restricted role).
  const dishes = await listRealMenu({
    id,
    admin,
    context,
    api,
    ownerRun,
    ownerScope,
    owner,
    at,
    start,
    menuReference: menu.menuReference,
    currencyMetadata: policy.currencyMetadata,
    taxClassificationReference,
    stock,
    bindRecipe: (soupSku) =>
      seedSubmissionInventoryRecipe({
        admin,
        scope: ownerScope,
        actorReference: owner,
        at,
        cart: { items: [{ sellableReference: soupSku, optionSelections: [] }] },
        stock,
        allergenDeclarationReference: id(0x65),
        ...(another === null ? {} : { idPrefix: another(5) }),
      }),
    asApi,
    reference,
  });

  // ── The table and the code staff print for it (real Merchant QR command).
  const table = await prepareEntryDiningTable({
    admin,
    role: seedRole,
    run: ownerRun,
    binding: publicOptions.binding,
    at,
    idOffset: merchant * 1000,
  });
  const qr = createInternalQrLoaders({
    file: join(directory, "internal-test-qr-key.pem"),
    loadProfile,
    expectedDatabaseName: database,
  });

  // ── The installation as the pilot composes it from its files.
  const installation = {
    database,
    loadProfile,
    loadMenu,
    loadWorkflow: async () => ({
      environment: "InternalTest",
      database,
      scope: ownerScope,
      // TEST-ONLY: this installation has only the dine-in workflow; no pickup is placed here.
      workflow,
    }),
    loadCustomerData: async (file) => {
      assert.equal(file, "internal-test-inventory.json");
      return {
        environment: "InternalTest",
        database,
        scope: { ...ownerScope, stockSiteReference: stock.stockSiteReference },
      };
    },
  };
  const config = {
    scope: ownerScope,
    providerAccountReference: id(0x10),
    controlReference: id(0x11),
    cart: {
      policyVersionReference: id(0x12),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
    },
  };
  const credentials = createInternalCredentialLoaders({
    file: join(directory, "internal-test-keys.json"),
    loadProfile,
    expectedDatabaseName: database,
  });
  const diningCredentials = createInternalDiningCredentialLoaders({
    path: join(directory, "internal-test-dining-key"),
  });
  const resources = await createInternalTestResources({
    createApplicationDatabase: async () => applicationDatabase,
    createInternalTestCredentials: credentials.createInternalTestCredentials,
    // The customer app's request budget: no staff round reads it.
    createCustomerRequestAdmission: async () => null,
    loadProfile,
    loadMenu,
    expectedDatabaseName: database,
  });

  /** A staff member with a real Session (membership, role, permission grants). */
  let sessions = 0;
  const staff = (actor, extraPermissions) => {
    sessions += 1;
    const base = 0x01a7e000 + merchant * 0x1000 + sessions * 2;
    const prefix = base.toString(16).padStart(8, "0");
    const sessionPrefix = (base + 1).toString(16).padStart(8, "0");
    return seedMerchantAcceptanceSession({
      admin,
      runner: { run: asApi },
      scope: ownerScope,
      actor,
      at: now(),
      extraPermissions,
      referencePrefix: prefix,
      sessionReferencePrefix: sessionPrefix,
    });
  };

  const persistenceOf = (who) => ({ ...who.persistence, now });

  // The code is issued by a staff member who manages table codes.
  const qrManager = await staff(id(0x20), ["dining.table.qr.manage"]);
  const qrPort = createMerchantDiningTableQr({
    persistence: persistenceOf(qrManager),
    authentication: qrManager.authentication,
    newReference: reference,
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    signer: {
      sign: async (payload) => (await qr.loadIssuedTableQrKeys(profile)).signer.sign(payload),
    },
    publicStore: async (selected) =>
      selected === storeReference
        ? { publicStoreReference: profile.binding.publicStoreReference, locale: "en-CA" }
        : null,
    customerOrigin: "https://127.0.0.1:4443",
  });
  const qrCall = { sessionCookie: qrManager.sessionCookie, csrf: qrManager.csrf };
  const row = (await qrPort.list({ ...qrCall, query: {} })).items.find(
    (item) => item.tableReference === table.tableReference,
  );
  assert.ok(row, "the table is on the Store's table code list");
  await qrPort.command({
    ...qrCall,
    command: {
      action: "Issue",
      tableReference: row.tableReference,
      expectedAggregateVersion: row.aggregateVersion,
      operationReference: reference(),
    },
  });

  /** The pilot's staff round command, composed for this staff member's session. */
  const composed = new Map();
  const customerFor = (who) => {
    const merchant = { authentication: who.authentication, persistence: persistenceOf(who) };
    return {
      ...composeCustomerDependencies(directory, installation, config),
      // As the pilot's own, with this test's staff session in place of the sign-in provider's.
      createInternalCustomerEntry: (r) =>
        createInternalCustomerEntry(r, {
          createInternalPickupEntry: (res) =>
            createInternalPickupEntry(res, { loadProfile, loadQr: qr.loadInternalPickupQr }),
          createInternalDiningEntries: (res) =>
            createIssuedDiningEntries(res, { loadProfile, loadKeys: qr.loadIssuedTableQrKeys }),
          createInternalDiningSession: (res, m) =>
            createInternalDiningSession(res, m, {
              loadCredentials: diningCredentials.createInternalDiningCredentials,
            }),
          createInternalMerchantSession: async () => merchant,
        }),
    };
  };
  const counterFor = async (who, extra = {}) => {
    if (composed.has(who)) return composed.get(who);
    const counter = await createInternalCounterOrder(
      resources,
      persistenceOf(who),
      who.authentication,
      {
        customer: customerFor(who),
        loadPickupWorkflow: () => installation.loadWorkflow("Pickup"),
        loadDiningWorkflow: () => installation.loadWorkflow("DineIn"),
        loadPickupQrToken: async () => (await qr.loadInternalPickupQr(profile)).token(),
        expectedDatabaseName: database,
        ...extra,
      },
    );
    composed.set(who, counter);
    return counter;
  };

  return {
    ...dishes,
    scope,
    ownerScope,
    tenantReference,
    tableReference: table.tableReference,
    stock,
    workflow,
    resources,
    now,
    reference,
    staff,
    asApi,
    restricted,
    persistenceOf,
    counterFor,
    /**
     * Staff seat a party at the table on the Tables page (Dining's own start command, as the pilot
     * composes it for this staff member); its session and the code issued for the party.
     */
    async seatTable(who, tableReference = table.tableReference) {
      const entry = await customerFor(who).createInternalCustomerEntry(resources);
      const current = await entry.diningOwner.stores.table.loadTable(tableReference);
      return entry.diningOwner.start({
        sessionCookie: who.sessionCookie,
        csrf: who.csrf,
        command: {
          tableReference,
          expectedAssignmentVersion: current.aggregateVersion,
          operationReference: reference(),
          joinKind: "HumanCode",
        },
      });
    },
    /** Marks the tea as the Store's tea charge, under the restricted role. */
    setTeaCharge: () =>
      asApi(async (tx) => {
        const before = await loadDiningTeaChargeSetting(tx, ownerScope);
        return changeDiningTeaChargeSetting(tx, ownerScope, {
          operationReference: reference(),
          expectedVersion: before.version,
          teaSellableReference: dishes.tea.skuReference,
          actorReference: owner,
          observedAt: now(),
        });
      }),
    async close() {
      await dishes.owner.close();
      await resources.close();
      await rm(directory, { recursive: true, force: true });
      await admin.query("DROP OWNED BY " + seedRole).catch(() => undefined);
      await admin.query("DROP ROLE " + seedRole).catch(() => undefined);
    },
  };
}

/**
 * The Store's listed menu through the Owner's one-page menu commands: a soup with a published stock
 * recipe, and the tea, "a charge, no stock ingredients", marked not prepared by the kitchen.
 */
async function listRealMenu({
  id,
  admin,
  context,
  api,
  ownerRun,
  ownerScope,
  owner,
  at,
  start,
  menuReference,
  currencyMetadata,
  taxClassificationReference,
  stock,
  bindRecipe,
  asApi,
  reference,
}) {
  const { tenantReference, brandReference, storeReference } = ownerScope;
  const recipeActions = [
    "recipe.read",
    "recipe.update",
    "recipe.approve",
    "recipe.publish",
    "catalog.allergen.declare",
    "inventory.item.create",
    "inventory.item.activate",
    "catalog.menu.read",
    "catalog.menu.update",
    "catalog.menu.submit",
    "catalog.menu.approve",
    "catalog.menu.publish",
    "catalog.menu.manage",
    "publishing.draft.create",
    "publishing.review.submit",
    "publishing.review.approve",
  ];
  const approver = await seedBrandRole(admin, {
    id,
    brandReference,
    roleId: id(0x310),
    code: "brand_owner",
    actions: ["pricing.price-book.approve", "pricing.price-book.manage", ...recipeActions],
    from: at,
  });
  await seedBrandMember(admin, {
    id,
    base: 0x400,
    brandReference,
    storeReference,
    actorReference: owner,
    name: "Sam",
    roles: [approver],
    from: at,
    enrolledAt: new Date(start - 2 * 3600_000).toISOString(),
  });
  const allergenAt = new Date(start - 3600_000).toISOString();
  await ownerRun((tx) =>
    createAllergenRegistryVersion(tx, ownerScope, {
      registryVersionReference: id(0x63),
      jurisdictionCode: "CA",
      policyDocument: "TEST-ONLY synthetic allergen list",
      entries: [
        { allergenReference: id(0x60), code: "PEANUT", localizedNames: { "en-CA": "Peanuts" } },
      ],
      actorReference: owner,
      at: allergenAt,
      auditReference: id(0x64),
    }),
  );
  // The soup's stock ingredient carries no allergen (TEST-ONLY): the listing review asks for this.
  await ownerRun((tx) =>
    recordIngredientAllergenDeclaration(tx, ownerScope, {
      evidenceReference: id(0x65),
      itemReference: stock.itemReference,
      itemVersionReference: stock.configurationOperationReference,
      registryVersionReference: id(0x63),
      allergens: [],
      sourceKind: staffAllergenDeclarationSource,
      documentReference: "TEST-ONLY declared for the soup's ingredient",
      note: null,
      validUntil: new Date(start + 86_400_000).toISOString(),
      actorReference: owner,
      at: allergenAt,
      auditReference: id(0x66),
    }),
  );
  // The authoring commands use one connection of their own, as the restricted role. It stays open
  // for the Owner's later changes; `atCommit` holds a step of a listing just before its COMMIT.
  const authoring = new Client(context.clientConfig);
  await authoring.connect();
  const hooks = { atCommit: null, onStatement: null };
  const send = authoring.query.bind(authoring);
  authoring.query = (...call) => {
    hooks.onStatement?.(call[0], call[1]);
    return send(...call);
  };
  try {
    const persistence = {
      now: () => new Date().toISOString(),
      transactions: {
        async run(work) {
          await authoring.query("BEGIN");
          try {
            await authoring.query("SET LOCAL ROLE " + api);
            await authoring.query("SET LOCAL lock_timeout='2s'");
            await authoring.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
            const value = await work(authoring);
            if (hooks.atCommit !== null) await hooks.atCommit();
            await authoring.query("COMMIT");
            return value;
          } catch (error) {
            await authoring.query("ROLLBACK");
            throw error;
          }
        },
      },
    };
    const grants = syntheticMerchantBrandScope({
      tenantReference,
      brandReference,
      storeReference,
      policyReference: id(6),
      grants: {
        [owner]: [
          "catalog.product.read",
          "catalog.product.create",
          "catalog.product.update",
          "catalog.product.manage",
          "catalog.product.publish",
          "catalog.sku.create",
          "catalog.sku.activate",
          "catalog.sku.availability.manage",
          "catalog.sku.read",
          "catalog.option_set.read",
          "catalog.option_set.manage",
          "pricing.price_book.read",
          "pricing.price-book.manage",
          "pricing.price-book.approve",
          "pricing.price_book.approve",
          ...recipeActions,
        ],
      },
    });
    const op = reference;
    const common = {
      persistence,
      authentication: { authorize: async () => ({ sessionReference: id(0x7) }) },
      locale: "en-CA",
      resolveScope: async (tx, ...rest) => {
        const resolved = await grants.resolveScope(tx, ...rest);
        const decided = new Map();
        return {
          ...resolved,
          authorizeAction: async (action) => {
            if (!decided.has(action)) decided.set(action, await resolved.authorizeAction(action));
            return decided.get(action);
          },
        };
      },
      references: { next: op },
    };
    // The Store's one menu draft, as Brand setup leaves it; the rest runs through its commands.
    const menuVersion = id(0x500);
    await admin.query("INSERT INTO rms_catalog.menu VALUES($1,$2,'TEST_MENU',1,$3,$4,$3)", [
      menuReference,
      brandReference,
      at,
      owner,
    ]);
    await admin.query(
      "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
      [menuVersion, menuReference, brandReference, JSON.stringify({ "en-CA": "TEST menu" }), at],
    );
    await admin.query("INSERT INTO rms_catalog.menu_version_store VALUES($1,$2,$3,$4)", [
      menuVersion,
      menuReference,
      brandReference,
      storeReference,
    ]);
    await admin.query("INSERT INTO rms_catalog.menu_version_channel VALUES($1,$2,$3,$4)", [
      menuVersion,
      menuReference,
      brandReference,
      "CUSTOMER_PWA",
    ]);
    await admin.query("INSERT INTO rms_catalog.menu_version_order_type VALUES($1,$2,$3,$4)", [
      menuVersion,
      menuReference,
      brandReference,
      "DINE_IN",
    ]);
    await admin.query("INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,$5,$6,$7)", [
      id(0x501),
      menuVersion,
      menuReference,
      brandReference,
      "SOUPS",
      JSON.stringify({ "en-CA": "Soups (TEST)", "zh-Hans": "汤" }),
      0,
    ]);
    const menus = createMerchantMenus({ ...common, currencyMetadata });
    const dishAllergens = createMerchantDishAllergens({ ...common, references: { next: op } });
    const optionSets = createMerchantOptionSets(common);
    const optionRecipes = createMerchantOptionRecipes(common);
    const commands = createMerchantOneStoreDishes({
      products: createMerchantProducts(common),
      prices: (menuPrices = createMerchantPrices({ ...common, currencyMetadata })),
      optionPrices: createMerchantOptionPrices({ ...common, currencyMetadata }),
      menus,
      dishAllergens,
      optionRecipes,
      availability: createMerchantAvailability(common),
      combos: createMerchantCombos(common),
      optionSets,
      now: () => new Date().toISOString(),
    });
    grants.as(owner);
    const session = { sessionCookie: "cookie", csrf: "csrf" };
    const saveDish = (
      name,
      nameZh,
      priceMinor,
      productReference = null,
      allergens = null,
      choiceGroups = [],
    ) =>
      commands.command({
        ...session,
        body: {
          action: "SaveDish",
          operationReference: op(),
          menuReference,
          productReference,
          sectionCode: "SOUPS",
          name,
          nameZh,
          description: "",
          descriptionZh: "",
          taxClassificationReference,
          priceMinor,
          // WP-2423 M70: the Brand price, for every Store (the one-Store menu has one).
          priceScope: priceMinor === null ? null : "AllStores",
          expectedPriceMinor: null,
          choiceGroups,
          allergens,
        },
      });
    const teaDish = await saveDish("Tea charge (TEST)", "茶位", "150");
    await saveDish("Tea charge (TEST)", "茶位", "150", teaDish.productReference, "NoIngredients");
    await asApi((tx) =>
      changeKitchenNotPreparedProduct(tx, ownerScope, {
        productReference: teaDish.productReference,
        operationReference: op(),
        expectedVersion: 0,
        notPrepared: true,
        actorReference: owner,
        observedAt: new Date().toISOString(),
      }),
    );
    const soupDish = await saveDish("Hot and sour soup (TEST)", "酸辣汤", "650");
    await bindRecipe(soupDish.skuReference);
    const listAll = async () =>
      commands.command({
        ...session,
        body: {
          action: "ListAll",
          operationReference: op(),
          menuReference,
          confirmedPriceBook: await confirmedMenuPrices(menuPrices),
        },
      });
    await listAll();
    return {
      tea: {
        skuReference: teaDish.skuReference,
        productReference: teaDish.productReference,
        priceMinor: 150n,
      },
      soup: {
        skuReference: soupDish.skuReference,
        productReference: soupDish.productReference,
        priceMinor: 650n,
      },
      owner: {
        hooks,
        saveDish,
        listAll,
        /** The Owner's choice groups (option sets), through the same commands. */
        optionSets,
        /** The Owner's option recipes (what a choice changes), through the same commands. */
        optionRecipes,
        /** The Store's stock item (staff declared, no allergens), for a choice that adds it. */
        stockItemReference: stock.itemReference,
        /** The connection the Owner's commands run on, for a test watching what waits on them. */
        backendPid: () => authoring.processID,
        close: () => authoring.end(),
      },
    };
  } catch (error) {
    await authoring.end();
    throw error;
  }
}

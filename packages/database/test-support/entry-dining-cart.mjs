import { publishEntryCartRecipe } from "./entry-cart-recipe-publication.mjs";
import {
  prepareEntryDiningQuote,
  syntheticDiningTaxClassification,
} from "./entry-dining-quote.mjs";
import { createHash } from "node:crypto";
import { seedCartCatalog, cartCatalogTables } from "./cart-catalog-seed.mjs";
import { seedCartRecipeInventory } from "./cart-recipe-inventory.mjs";
import assert from "node:assert/strict";
import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  createCatalogSelectionDisplayQuery,
  createPostgresPublishedMenuQueryStore,
} from "../../rms/catalog/src/index.ts";
import { createCustomerDiningCartWithCatalogInventoryComposition } from "../../../apps/api/src/customer-dining-cart-composition.ts";
import { CustomerCartHandler } from "../../../apps/api/src/customer-cart.ts";
import { createPersistentPublicStoreProfileReader } from "../../../apps/api/src/persistent-public-store-profile.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

export async function prepareEntryDiningCart({
  admin,
  role,
  run,
  scope,
  sessions,
  publicOptions,
  at,
}) {
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.dining_cart_operation TO " + role);
  await admin.query("GRANT SELECT ON rms_ordering.dining_cart_replacement TO " + role);
  let sequence = 50000;
  const reference = () => id(++sequence);
  const catalogId = (n) =>
    n === 2 ? scope.brandReference : n === 20 ? scope.storeReference : id(70000 + n);
  await seedCartCatalog(
    { query: (sql, values) => admin.query(sql.replaceAll("PICKUP", "DINE_IN"), values) },
    catalogId,
    at,
    { taxClassificationReference: syntheticDiningTaxClassification },
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + role);
  await admin.query(
    "GRANT SELECT ON " +
      cartCatalogTables.map((name) => "rms_catalog." + name).join(",") +
      " TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.cart_operation_record TO " + role);
  const inventoryId = (n) =>
    n === 2 ? scope.brandReference : n === 29990 ? scope.tenantReference : id(80000 + n);
  const inventoryScope = await seedCartRecipeInventory({
    publishRecipe: publishEntryCartRecipe,
    admin,
    role,
    runner: { run },
    id: inventoryId,
    at,
    skuReference: catalogId(13),
    storeReference: scope.storeReference,
  });
  const reads = {
    run: (work) =>
      run(async (tx) => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
        return work(tx);
      }),
  };
  const evidence = (request, kind, status) => ({
    kind,
    status,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
    sellableReference: request.sellableReference,
    observedAt: request.observedAt,
    expiresAt: new Date(Date.parse(at) + 60000).toISOString(),
    reasonCode: "SYNTHETIC_SAFETY",
  });
  const catalogOptions = {
    catalogScope: {
      menuReference: catalogId(1),
      sourceChannel: "Qr",
      channelCode: "CUSTOMER_PWA",
      orderTypeCode: "DINE_IN",
    },
    catalogSafety: {
      killSwitch: { loadEvidence: async (request) => evidence(request, "KillSwitch", "Clear") },
      inventory: { loadEvidence: async (request) => evidence(request, "Inventory", "Available") },
    },
  };
  const port = createCustomerDiningCartWithCatalogInventoryComposition({
    scope: identityScope,
    catalogTransactions: reads,
    ...catalogOptions,
    selectedInventory: {
      scope: inventoryScope,
      transactions: reads,
      resolveExpiryCutoff: async () => {
        throw new Error("NoLot fixture");
      },
    },
    items: {
      writeTransactions: { run },
      references: {
        generate: reference,
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
      audit: (record) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDERING_CART_ITEM_" + record.action.toUpperCase(),
        targetType: "OrderingCart",
        targetId: record.cartReference,
        reasonCode: "AUTHORIZED_CART_MUTATION",
        correlationId: record.operationReference,
        occurredAt: record.observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
    sessions,
    now: () => at,
    participation: createDiningCartParticipationQuery({
      scope: identityScope,
      repository: createPostgresDiningParticipationStore({ run }, scope),
      now: () => at,
    }),
    cartTransactions: { run },
    selectionTransactions: { run },
    selection: {
      sourceChannel: "Qr",
      generateReference: reference,
      policy: {
        policyVersionReference: reference(),
        policyDigest: "sha256:" + "a".repeat(64),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: new Date(Date.parse(at) - 86400000).toISOString(),
        validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
      },
      audit: (record) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDERING_DINING_CART_" + record.action.toUpperCase(),
        targetType: "OrderingCart",
        targetId: record.cartReference,
        reasonCode: "AUTHORIZED_CART_SELECTION",
        correlationId: record.operationReference,
        occurredAt: record.occurredAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
    catalog: createCatalogSelectionDisplayQuery(
      createPostgresPublishedMenuQueryStore({ run }, identityScope),
    ),
    stores: createPersistentPublicStoreProfileReader({ ...publicOptions, transactions: { run } }),
  });
  return {
    checkoutSources: { reads, catalogOptions, inventoryScope },
    handler: new CustomerCartHandler({
      port,
      now: () => at,
      allowedOrigin: "https://customer.invalid",
    }),
    quote: await prepareEntryDiningQuote({
      admin,
      role,
      run,
      scope,
      sessions,
      at,
      ...catalogOptions,
      skuReference: catalogId(13),
    }),
  };
}

export async function exerciseEntryDiningCart({
  base,
  cookie,
  csrfToken,
  oldCookie,
  admin,
  scope,
  diningSessionReference,
}) {
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
  };
  const create = (operation) =>
    globalThis.fetch(base + "/api/v1/carts", {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "idempotency-key": operation,
      },
      body: "{}",
    });
  const first = await create(id(59000));
  assert.equal(first.status, 201);
  const view = await first.json();
  assert.equal(view.cart.orderType, "DineIn");
  assert.deepEqual(view.cart.items, []);
  assert.equal(view.cart.lifecycle.status, "Active");
  assert.equal(Object.hasOwn(view.cart, "diningSessionReference"), false);
  const again = await create(id(59001));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).cart.cartReference, view.cart.cartReference);
  const read = (selectedCookie, path = "/bff/customer/cart") =>
    globalThis.fetch(base + path, { headers: { ...headers, cookie: selectedCookie } });
  const current = await read(cookie);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).cart.cartReference, view.cart.cartReference);
  const old = await read(oldCookie);
  assert.equal(old.status, 401);
  await old.text();
  const other = await read(cookie, "/api/v1/carts/" + id(59999));
  assert.equal(other.status, 404);
  await other.text();
  const rows = await admin.query(
    "SELECT cart_id,dining_session_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3",
    [scope.brandReference, scope.storeReference, diningSessionReference],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].cart_id, view.cart.cartReference);
  const facts = async () => ({
    cart: (
      await admin.query("SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1", [
        view.cart.cartReference,
      ])
    ).rows,
    lines: (
      await admin.query(
        "SELECT cart_line_id,quantity FROM rms_ordering.cart_line WHERE cart_id=$1",
        [view.cart.cartReference],
      )
    ).rows,
    operations: (
      await admin.query("SELECT count(*)::int n FROM rms_ordering.cart_operation_record")
    ).rows[0].n,
    audits: (await admin.query("SELECT count(*)::int n FROM platform_audit.audit_record")).rows[0]
      .n,
    reservations: (
      await admin.query("SELECT count(*)::int n FROM rms_inventory.stock_reservation_version")
    ).rows[0].n,
  });
  const add = (quantity, operation, selectedCookie = cookie, version = 1) =>
    globalThis.fetch(base + "/api/v1/carts/" + view.cart.cartReference + "/items", {
      method: "POST",
      headers: {
        ...headers,
        cookie: selectedCookie,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "idempotency-key": operation,
        "if-match": '"' + version + '"',
      },
      body: JSON.stringify({
        sellableReference: id(70013),
        quantity,
        optionSelections: [],
        customerNote: null,
      }),
    });
  const before = await facts();
  const shortage = await add(100, id(59002));
  assert.equal(shortage.status, 422);
  assert.equal((await shortage.json()).error.code, "cart_selection_invalid");
  assert.deepEqual(await facts(), before);
  const accepted = await add(2, id(59003));
  assert.equal(accepted.status, 200);
  const added = await accepted.json();
  assert.equal(added.cart.version, 2);
  assert.equal(added.cart.items[0].quantity, 2);
  const committed = await facts();
  assert.equal(committed.operations, before.operations + 1);
  assert.equal(committed.audits, before.audits + 1);
  assert.equal(committed.reservations, before.reservations);
  const replay = await add(2, id(59003));
  assert.equal(replay.status, 200);
  await replay.text();
  assert.deepEqual(await facts(), committed);
  const oldAdd = await add(1, id(59004), oldCookie, 2);
  assert.equal(oldAdd.status, 401);
  await oldAdd.text();
  assert.deepEqual(await facts(), committed);
}

export async function exerciseSharedDiningMember({
  base,
  admin,
  scope,
  firstCookie,
  cookie,
  csrfToken,
  diningSessionReference,
  guestSessionReference,
  participantReference,
}) {
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
  };
  const shared = await globalThis.fetch(base + "/bff/customer/cart", {
    headers: { ...headers, cookie },
  });
  assert.equal(shared.status, 200);
  const view = await shared.json();
  assert.equal(view.cart.version, 2);
  const result = await globalThis.fetch(
    base + "/api/v1/carts/" + view.cart.cartReference + "/items",
    {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "idempotency-key": id(59010),
        "if-match": '"2"',
      },
      body: JSON.stringify({
        sellableReference: id(70013),
        quantity: 3,
        optionSelections: [],
        customerNote: null,
      }),
    },
  );
  assert.equal(result.status, 200);
  const updated = await result.json();
  assert.equal(updated.cart.version, 3);
  assert.equal(updated.cart.items.length, 2);
  const rows = await admin.query(
    "SELECT c.created_by_actor_id,c.dining_session_id,l.added_by_actor_id,l.added_by_participant_id FROM rms_ordering.cart c JOIN rms_ordering.cart_line l ON l.cart_id=c.cart_id AND l.brand_id=c.brand_id AND l.store_id=c.store_id WHERE c.brand_id=$1 AND c.store_id=$2 AND c.cart_id=$3 AND l.quantity=3",
    [scope.brandReference, scope.storeReference, view.cart.cartReference],
  );
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].created_by_actor_id, guestSessionReference);
  assert.equal(rows.rows[0].dining_session_id, diningSessionReference);
  assert.equal(rows.rows[0].added_by_actor_id, guestSessionReference);
  assert.equal(rows.rows[0].added_by_participant_id, participantReference);
  const first = await globalThis.fetch(base + "/bff/customer/cart", {
    headers: { ...headers, cookie: firstCookie },
  });
  assert.equal(first.status, 200);
  const firstView = (await first.json()).cart;
  const content = (cart) => ({
    ...cart,
    items: cart.items.map((item) => {
      const copy = { ...item };
      delete copy.warnings;
      return copy;
    }),
  });
  assert.deepEqual(content(firstView), content(updated.cart));
  assert.deepEqual(
    firstView.items.map((item) => item.warnings),
    [[], ["OTHER_PARTICIPANT_ITEM"]],
  );
  assert.deepEqual(
    updated.cart.items.map((item) => item.warnings),
    [["OTHER_PARTICIPANT_ITEM"], []],
  );
  return updated.cart;
}

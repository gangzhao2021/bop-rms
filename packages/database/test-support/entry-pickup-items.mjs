import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { seedCartCatalog, cartCatalogTables } from "./cart-catalog-seed.mjs";
import { seedCartRecipeInventory } from "./cart-recipe-inventory.mjs";
import { publishEntryCartRecipe } from "./entry-cart-recipe-publication.mjs";
import { syntheticDiningTaxClassification } from "./entry-dining-quote.mjs";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Actual Catalog/Recipe/Inventory persistence; commercial/publication approvals
 * are explicit synthetic inputs, never a claim of operator-authorized publication.
 */
export async function prepareEntryPickupItems({ admin, role, run, scope, at, sellableNames }) {
  const catalogId = (n) =>
    n === 2 ? scope.brandReference : n === 20 ? scope.storeReference : id(70000 + n);
  await seedCartCatalog(admin, catalogId, at, {
    taxClassificationReference: syntheticDiningTaxClassification,
    ...(sellableNames === undefined ? {} : { sellableNames }),
  });
  await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + role);
  await admin.query(
    "GRANT SELECT ON " +
      cartCatalogTables.map((table) => "rms_catalog." + table).join(",") +
      " TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.cart_line TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.cart_operation_record TO " + role);
  const inventoryScope = await seedCartRecipeInventory({
    publishRecipe: publishEntryCartRecipe,
    admin,
    role,
    runner: { run },
    id: (n) =>
      n === 2 ? scope.brandReference : n === 29990 ? scope.tenantReference : id(80000 + n),
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
  let sequence = 50000;
  const reference = () => id(++sequence);
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
  return {
    catalogCartItems: {
      catalogTransactions: reads,
      catalogScope: {
        menuReference: catalogId(1),
        sourceChannel: "Qr",
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
      },
      catalogSafety: {
        killSwitch: { loadEvidence: async (request) => evidence(request, "KillSwitch", "Clear") },
        inventory: { loadEvidence: async (request) => evidence(request, "Inventory", "Available") },
      },
      selectedInventory: {
        scope: inventoryScope,
        transactions: reads,
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      },
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
  };
}
export async function exerciseEntryPickupItems({ base, pickup, admin, chineseName = "Latte" }) {
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "content-type": "application/json",
    "x-csrf-token": pickup.csrfToken,
  };
  const facts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.cart_operation_record) operations,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM rms_inventory.stock_reservation_version) reservations",
      )
    ).rows[0];
  const add = (quantity, operation, cookie = pickup.cookie, optionSelections = []) =>
    globalThis.fetch(base + "/api/v1/carts/" + pickup.cart.cartReference + "/items", {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        "idempotency-key": operation,
        "if-match": '"' + pickup.cart.version + '"',
      },
      body: JSON.stringify({
        sellableReference: id(70013),
        quantity,
        optionSelections,
        customerNote: null,
      }),
    });
  const before = await facts();
  const shortage = await add(100, id(59002));
  assert.equal(shortage.status, 422);
  // WP-2423: the Store's stock (100 kg, 2 kg each) makes 50, and the guest is told so.
  assert.deepEqual(stockAnswer(await shortage.json()), {
    code: "cart_selection_invalid",
    issueCodes: ["ITEM_SHORT"],
    available: 50,
  });
  assert.deepEqual(await facts(), before);
  // A refusal that is not about stock keeps its own answer.
  const unoffered = await add(1, id(59005), pickup.cookie, [
    { optionReference: id(79999), quantity: 1 },
  ]);
  assert.equal(unoffered.status, 422);
  assert.deepEqual(stockAnswer(await unoffered.json()), {
    code: "cart_selection_invalid",
    issueCodes: ["CATALOG_SELECTION_REJECTED"],
  });
  assert.deepEqual(await facts(), before);
  const accepted = await add(2, id(59003));
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.cart.cartReference, pickup.cart.cartReference);
  assert.equal(body.cart.version, pickup.cart.version + 1);
  assert.equal(body.cart.items[0].quantity, 2);
  assert.equal(body.cart.items[0].displayName, "Latte");
  // Owner 2026-10-23: the guest who chose Chinese reads the Cart's names in Chinese, and an item
  // without a Chinese name in the menu language (never an empty name); the session's locale and
  // the Cart itself are unchanged.
  for (const path of [
    "/bff/customer/cart?locale=zh-Hans-CA",
    "/api/v1/carts/" + pickup.cart.cartReference + "?locale=zh-Hans-CA",
  ]) {
    const chinese = await globalThis.fetch(base + path, {
      headers: { ...headers, cookie: pickup.cookie },
    });
    assert.equal(chinese.status, 200, path);
    const read = await chinese.json();
    assert.equal(read.cart.version, body.cart.version);
    assert.equal(read.cart.items[0].displayName, chineseName);
  }
  const english = await globalThis.fetch(base + "/bff/customer/cart", {
    headers: { ...headers, cookie: pickup.cookie },
  });
  assert.equal((await english.json()).cart.items[0].displayName, "Latte");
  const malformed = await globalThis.fetch(base + "/bff/customer/cart?locale=zh_CN", {
    headers: { ...headers, cookie: pickup.cookie },
  });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const after = await facts();
  assert.equal(after.operations, before.operations + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reservations, before.reservations);
  const replay = await add(2, id(59003));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).cart.version, body.cart.version);
  assert.deepEqual(await facts(), after);
  // WP-2423: "+" on the line (a quantity change) past the stock says how many it can make.
  const more = await globalThis.fetch(
    base +
      "/api/v1/carts/" +
      pickup.cart.cartReference +
      "/items/" +
      body.cart.items[0].cartItemReference,
    {
      method: "PATCH",
      headers: {
        ...headers,
        cookie: pickup.cookie,
        "idempotency-key": id(59006),
        "if-match": '"' + body.cart.version + '"',
      },
      body: JSON.stringify({ quantity: 51, optionSelections: [], customerNote: null }),
    },
  );
  assert.equal(more.status, 422);
  assert.deepEqual(stockAnswer(await more.json()), {
    code: "cart_selection_invalid",
    issueCodes: ["ITEM_SHORT"],
    available: 50,
  });
  assert.deepEqual(await facts(), after);
  const denied = await add(1, id(59004), pickup.oldCookie);
  assert.equal(denied.status, 401);
  await denied.text();
  assert.deepEqual(await facts(), after);
  return { ...pickup, cart: body.cart };
}

/** The Cart refusal the guest's screen reads: error code, issue codes and (stock only) the count. */
export function stockAnswer(body) {
  const { code, issueCodes, available } = body.error;
  return available === undefined ? { code, issueCodes } : { code, issueCodes, available };
}

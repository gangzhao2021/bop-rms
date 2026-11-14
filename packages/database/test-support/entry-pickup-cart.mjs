import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createGuestBindingCredentialProvider } from "../../bop/identity/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";

/** Real owner persistence and Audit. Lifecycle policy and registration approval
 * remain synthetic; the entry fixture supplies current Tenant/QR binding reads. */
export async function prepareEntryPickupCart({
  admin,
  role,
  run,
  scope,
  at = "2026-01-15T12:00:00.000Z",
}) {
  await admin.query("GRANT SELECT,INSERT ON bop_identity.guest_binding_preparation TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA rms_ordering TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_ordering.cart TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_ordering.cart_line,rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_ordering.cart_binding_record TO " + role);
  let sequence = 20000;
  const reference = () => id(++sequence);
  const audit = (action, targetType, targetId, record) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: action,
    targetType,
    targetId,
    occurredAt: record.occurredAt,
    correlationId: record.operationReference,
    reasonCode: "AUTHORIZED_CART_BINDING",
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  return {
    cartTransactions: { run },
    cartBinding: {
      orderingTransactions: { run },
      identityAudit: {
        append: (tx, record) =>
          appendAuditRecordInTransaction(
            tx,
            audit(
              "IDENTITY_GUEST_BINDING_" + record.action.toUpperCase(),
              "GuestBindingPreparation",
              record.operationReference,
              record,
            ),
          ),
      },
      ordering: {
        policy: {
          policyVersionReference: reference(),
          policyDigest: "sha256:" + "a".repeat(64),
          idleTimeoutSeconds: 3600,
          absoluteTimeoutSeconds: 86400,
          validFrom: new Date(Date.parse(at) - 86400000).toISOString(),
          validUntil: new Date(Date.parse(at) + 86400000).toISOString(),
        },
        sourceChannel: "Qr",
        generateReference: reference,
        audit: (record) =>
          audit(
            "ORDERING_CART_BINDING_" + record.action.toUpperCase(),
            "OrderingCart",
            record.cartReference,
            record,
          ),
      },
      recovery: createGuestBindingCredentialProvider(randomBytes(32)),
      preparationLifetimeSeconds: 300,
    },
  };
}

export async function exerciseEntryPickupCart({
  base,
  entryResponse,
  entryBody,
  admin,
  scope,
  setRegistrationAllowed,
}) {
  const originalCookie = entryResponse.headers.getSetCookie()[0].split(";")[0];
  const operation = id(29000);
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
  };
  const post = (action, cookie, csrf, body = {}) =>
    globalThis.fetch(base + "/bff/customer/cart-binding/" + action, {
      method: "POST",
      headers: {
        ...headers,
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": operation,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const carts = async () =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2",
        [scope.brandReference, scope.storeReference],
      )
    ).rows[0].n;
  const before = await carts();
  const denied = await post("prepare", originalCookie, "x".repeat(43));
  assert.equal(denied.status, 503);
  await denied.text();
  assert.equal(denied.headers.getSetCookie().length, 0);
  assert.equal(await carts(), before);
  const prepared = await post("prepare", originalCookie, entryBody.csrfToken);
  assert.equal(prepared.status, 200);
  const preparation = await prepared.json();
  assert.equal(preparation.status, "Prepared");
  assert.equal(Object.hasOwn(preparation, "sessionCredential"), false);
  const candidate = prepared.headers.getSetCookie()[0].split(";")[0];
  const activated = await post("activate", originalCookie + "; " + candidate, entryBody.csrfToken, {
    candidateCsrfToken: preparation.candidateCsrfToken,
    recoveryProof: preparation.recoveryProof,
  });
  assert.equal(activated.status, 200);
  const activation = await activated.json();
  assert.equal(activation.status, "Activated");
  const currentCookie = activated.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-bop-guest="))
    .split(";")[0];
  assert.notEqual(currentCookie, originalCookie);
  assert.equal(await carts(), before + 1);
  const read = (cookie) =>
    globalThis.fetch(base + "/bff/customer/cart", { headers: { ...headers, cookie } });
  const current = await read(currentCookie);
  assert.equal(current.status, 200);
  const view = await current.json();
  assert.equal(view.cart.orderType, "Pickup");
  assert.deepEqual(view.cart.items, []);
  assert.equal(view.cart.lifecycle.status, "Active");
  assert.equal(Object.hasOwn(view.cart, "brandReference"), false);
  const old = await read(originalCookie);
  assert.equal(old.status, 401);
  await old.text();
  const reread = await read(currentCookie);
  assert.equal(reread.status, 200);
  assert.equal((await reread.json()).cart.cartReference, view.cart.cartReference);
  assert.equal(await carts(), before + 1);
  setRegistrationAllowed(false);
  const withdrawn = await read(currentCookie);
  assert.equal(withdrawn.status, 401);
  await withdrawn.text();
  setRegistrationAllowed(true);
  const restored = await read(currentCookie);
  assert.equal(restored.status, 200);
  await restored.text();
  return {
    cookie: currentCookie,
    oldCookie: originalCookie,
    csrfToken: activation.csrfToken,
    cart: view.cart,
  };
}

import { createRefundReceiptIssuance } from "../../../apps/api/src/refund-receipt-issuance.ts";
import { exerciseReceiptTemplate } from "./receipt-template.mjs";
import { createOriginalReceiptIssuance } from "../../../apps/api/src/original-receipt-issuance.ts";
import assert from "node:assert/strict";
import { createPostgresReceiptOrderSource } from "../../rms/ordering/src/index.ts";
import { parseReceiptView } from "../../../apps/customer-pwa/src/receipt/receipt-controller.ts";

// Drain all concurrent transactions before failure reaches isolated database cleanup.
async function together(promises) {
  const results = await Promise.allSettled(promises);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => result.value);
}

/** Persisted retrieval proof. Issuer/template names are explicit synthetic fixture inputs. */
export async function exerciseCustomerReceiptRead({
  server,
  admin,
  runner,
  role,
  scope,
  preparation,
  sessionPayment,
  paymentScope,
  paymentFreshAfter,
  ordinaryRefundFixture,
}) {
  const id = (n) => "0190ec06-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const at = new Date().toISOString(),
    orderReference = preparation.orderReference;
  const ownerScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.digital_receipt_record TO " + role);
  await admin.query(
    "GRANT SELECT,UPDATE(order_id) ON rms_ordering.order_submission_record TO " + role,
  );
  // Explicit synthetic legal facts, persisted through the actual owner schema.
  await admin.query(
    "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic fixture issuer','Synthetic Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
    [id(3), id(10), id(11), id(12), id(13), id(14), at],
  );
  await admin.query(
    "INSERT INTO bop_operating_entity.brand_operating_entity_assignment(assignment_id,brand_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,'SalesReceiptIssuer','Active',$4,NULL,1,$4,$4)",
    [id(15), scope.brandReference, id(3), at],
  );
  await admin.query(
    "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
    [id(16), scope.brandReference, scope.storeReference, id(3), at],
  );
  await admin.query("GRANT USAGE ON SCHEMA bop_operating_entity TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_operating_entity.operating_entity,bop_operating_entity.store_operating_entity_assignment,bop_operating_entity.brand_operating_entity_assignment TO " +
      role,
  );
  await admin.query(
    "GRANT UPDATE(version) ON bop_operating_entity.operating_entity,bop_operating_entity.store_operating_entity_assignment TO " +
      role,
  );
  await admin.query(
    "INSERT INTO bop_tenant.brand(brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES($1,'SYNTHETIC_RECEIPT_BRAND','Synthetic Receipt Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
    [scope.brandReference, at],
  );
  await admin.query(
    "INSERT INTO bop_tenant.store(store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES($1,$2,'SYNTHETIC_RECEIPT_STORE','Synthetic Receipt Store','America/Toronto','en-CA','CAD','Active',1,$3,$3) ON CONFLICT (store_id) DO NOTHING",
    [scope.storeReference, scope.brandReference, at],
  );
  await admin.query("GRANT SELECT,UPDATE(order_batch_id) ON rms_ordering.order_batch TO " + role);
  await admin.query("GRANT SELECT,UPDATE(order_item_id) ON rms_ordering.order_item TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.store TO " + role);
  let mode = "Valid";
  let sourceAllowed = true;
  const templateSource = await exerciseReceiptTemplate({
    admin,
    runner,
    role,
    scope: ownerScope,
    at,
  });
  const sourceOptions = {
    scope: { ...paymentScope, tenantReference: scope.tenantReference },
    authorize: async (_tx, request) => sourceAllowed && request.orderReference === orderReference,
    order: async (tx, request) => {
      const order = await createPostgresReceiptOrderSource({
        ...ownerScope,
        authorize: async () => sourceAllowed,
      })(tx, request);
      return mode === "MissingBatch" ? { ...order, batches: [] } : order;
    },
    template: async (tx) => {
      if (mode === "MissingTemplate") return null;
      const result = await templateSource(tx);
      if (mode === "FinalRevoked") sourceAllowed = false;
      return result;
    },
  };
  let identityCalls = 0,
    auditCalls = 0;
  const issue = createOriginalReceiptIssuance({
    sources: sourceOptions,
    authorize: async (_tx, access) => sourceAllowed && access.orderReference === orderReference,
    identities: () => {
      identityCalls++;
      return { recordReference: id(1), receiptReference: id(2), operationReference: id(4) };
    },
    audit: async (record, operationReference) => {
      auditCalls++;
      return {
        auditId: id(5),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "DIGITAL_RECEIPT_APPEND",
        targetType: "DigitalReceipt",
        targetId: record.recordReference,
        reasonCode: "SYNTHETIC_RECEIPT_RETRIEVAL",
        correlationId: operationReference,
        occurredAt: record.recordedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      };
    },
  });
  const request = {
    orderReference,
    observedAt: at,
    freshAfter: paymentFreshAfter,
  };
  for (const invalid of ["MissingTemplate", "MissingBatch", "FinalRevoked"]) {
    mode = invalid;
    sourceAllowed = true;
    await assert.rejects(
      runner.run((tx) => issue(tx, request)),
      {
        code:
          invalid === "FinalRevoked"
            ? "DIGITAL_RECEIPT_PERMISSION_DENIED"
            : invalid === "MissingBatch"
              ? "DIGITAL_RECEIPT_INPUT_INVALID"
              : "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE",
      },
    );
  }
  assert.equal(
    (
      await admin.query("SELECT * FROM rms_ordering.digital_receipt_record WHERE order_id=$1", [
        orderReference,
      ])
    ).rowCount,
    0,
  );
  mode = "Valid";
  sourceAllowed = true;
  // These are the lock modes required by FK insertion and item mutation.
  // Do not mutate append-only history merely to test its receipt read fence.
  const lockProbes = [
    "SELECT order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR KEY SHARE",
    "SELECT order_batch_id FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR KEY SHARE",
    "SELECT order_item_id FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
  ];
  const probe = (sql) =>
    runner.run(async (tx) => {
      await tx.query("SET LOCAL lock_timeout='100ms'", []);
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(sql, [
        scope.brandReference,
        scope.storeReference,
        orderReference,
      ]);
      assert(result.rows.length > 0, "lock probe must address existing scoped rows");
    });
  identityCalls = 0;
  auditCalls = 0;
  const attempt = () =>
    runner.run(async (transaction) => {
      const result = await issue(transaction, request);
      if (result.status === "Created") {
        for (const sql of lockProbes) await assert.rejects(probe(sql), { code: "55P03" });
      }
      return result;
    });
  const issued = await together([attempt(), attempt()]);
  assert.deepEqual(issued.map((result) => result.status).sort(), ["Created", "Existing"]);
  assert.deepEqual(issued[0].record, issued[1].record);
  assert.equal(identityCalls, 1, "concurrent issuance allocates only the winning identity set");
  assert.equal(auditCalls, 1, "concurrent issuance appends Audit only once");
  for (const sql of lockProbes) await probe(sql);
  mode = "MissingTemplate";
  const recovered = await runner.run((tx) => issue(tx, request));
  assert.equal(recovered.status, "Existing");
  assert.deepEqual(recovered.record, issued[0].record);
  assert.equal(identityCalls, 1, "replay must not evaluate changed source configuration");
  assert.equal(auditCalls, 1);
  sourceAllowed = false;
  await assert.rejects(
    runner.run((tx) => issue(tx, request)),
    { code: "DIGITAL_RECEIPT_PERMISSION_DENIED" },
  );
  sourceAllowed = true;
  mode = "Valid";
  assert.equal(server.listening, true, "shared customer runtime remains active");
  {
    const url =
      "http://127.0.0.1:" + server.address().port + "/api/v1/orders/" + orderReference + "/receipt";
    const headers = {
      "sec-fetch-site": "same-origin",
      cookie: "__Host-bop-guest=" + sessionPayment.input.sessionCredential,
      "x-csrf-token": sessionPayment.input.csrfCredential,
    };
    const response = await globalThis.fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = await response.json();
    const view = parseReceiptView(body.receipt, orderReference);
    assert.equal(view.records[0].snapshot.total.amountMinor, preparation.total.amountMinor);
    assert.equal(view.records[0].snapshot.tip.amountMinor, preparation.tip.amountMinor);
    assert.equal(view.records[0].snapshot.operatingEntityDisplayName, "Synthetic fixture issuer");
    assert.equal(view.freshnessStatus, "Stale");
    assert.equal(view.deliveryStatus, "Unavailable");
    const serialized = JSON.stringify(body);
    for (const field of [
      "guestSessionReference",
      "operatingEntityReference",
      "brandReference",
      "storeReference",
      "templateVersion",
    ])
      assert.equal(serialized.includes(field), false);
    assert.equal(
      (await globalThis.fetch(url, { headers: { ...headers, "x-csrf-token": "x".repeat(43) } }))
        .status,
      404,
    );
    assert.equal(
      (await globalThis.fetch(url.replace(orderReference, id(99)), { headers })).status,
      404,
    );
    assert.equal((await globalThis.fetch(url, { headers })).status, 200);
    if (ordinaryRefundFixture) {
      await admin.query("GRANT INSERT ON rms_payment.ordinary_refund_request TO " + role);
      assert.equal((await ordinaryRefundFixture.commitRequest()).status, "Created");
      let refundIdentities = 0;
      const refundOptions = {
        scope: { ...paymentScope, tenantReference: scope.tenantReference },
        authorize: async () => sourceAllowed,
        authorizeSources: async () => sourceAllowed,
        authorizeOrder: async () => sourceAllowed,
        identities: () => {
          refundIdentities++;
          return {
            recordReference: id(28 + refundIdentities * 3),
            operationReference: id(29 + refundIdentities * 3),
          };
        },
        audit: async (record, operationReference) => ({
          auditId: id(30 + refundIdentities * 3),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "DIGITAL_RECEIPT_APPEND",
          targetType: "DigitalReceipt",
          targetId: record.recordReference,
          reasonCode: "PAYMENT_REFUND_STATUS_CHANGED",
          correlationId: operationReference,
          occurredAt: record.recordedAt,
          sourceChannel: "PAYMENT_RECONCILIATION",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
      };
      const refundIssue = createRefundReceiptIssuance(refundOptions);
      const issueRequest = () => ({
        orderReference,
        observedAt: new Date().toISOString(),
        freshAfter: paymentFreshAfter,
      });
      // Same observed instant for the concurrent idempotency probe: transaction
      // acquisition order must not turn this into a backdated-observation test.
      const pendingRequest = issueRequest();
      const pair = await together([
        runner.run((tx) => refundIssue(tx, pendingRequest)),
        runner.run((tx) => refundIssue(tx, pendingRequest)),
      ]);
      assert.deepEqual(pair.map((result) => result.status).sort(), ["Created", "Existing"]);
      assert.equal(refundIdentities, 1);
      assert.equal((await runner.run((tx) => refundIssue(tx, issueRequest()))).status, "Existing");
      assert.equal(refundIdentities, 1);
      sourceAllowed = false;
      await assert.rejects(runner.run((tx) => refundIssue(tx, issueRequest())));
      sourceAllowed = true;
      const amendedResponse = await globalThis.fetch(url, { headers });
      assert.equal(amendedResponse.status, 200);
      const amendedBody = await amendedResponse.json();
      const amended = parseReceiptView(amendedBody.receipt, orderReference);
      assert.equal(amended.records.length, 2);
      assert.deepEqual(amended.records[0], view.records[0]);
      assert.equal(amended.records[1].kind, "Refund");
      assert.equal(amended.records[1].snapshot.paymentStatus, "RefundPending");
      assert.equal(amended.records[1].snapshot.refundedTotal.amountMinor, 0n);
      assert.equal(amended.records[1].snapshot.total.amountMinor, preparation.total.amountMinor);
      // This role remains a non-owner subject to RLS inside the isolated DB.
      // Grant access needed by the existing real authority/dispatch fixture.
      for (const schema of [
        "rms_payment",
        "bop_identity",
        "bop_tenant",
        "bop_membership",
        "bop_permission",
        "rms_store",
        "bop_publishing",
      ]) {
        await admin.query("GRANT USAGE ON SCHEMA " + schema + " TO " + role);
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA " + schema + " TO " + role,
        );
      }
      await ordinaryRefundFixture.completeRefund(refundOptions);
      const completedRequest = issueRequest();
      const completedPair = await together([
        runner.run((tx) => refundIssue(tx, completedRequest)),
        runner.run((tx) => refundIssue(tx, completedRequest)),
      ]);
      assert.deepEqual(completedPair.map((result) => result.status).sort(), [
        "Existing",
        "Existing",
      ]);
      assert.equal(refundIdentities, 2);
      assert.equal((await runner.run((tx) => refundIssue(tx, issueRequest()))).status, "Existing");
      assert.equal(refundIdentities, 2);
      const completedResponse = await globalThis.fetch(url, { headers });
      assert.equal(completedResponse.status, 200);
      const completedBody = await completedResponse.json();
      const completed = parseReceiptView(completedBody.receipt, orderReference);
      assert.equal(completed.records.length, 3);
      assert.deepEqual(completed.records.slice(0, 2), amended.records);
      assert.equal(completed.records[2].kind, "Refund");
      assert.equal(completed.records[2].snapshot.paymentStatus, "Refunded");
      assert.equal(
        completed.records[2].snapshot.refundedTotal.amountMinor,
        preparation.total.amountMinor,
      );
    }
    const count = await admin.query(
      "SELECT count(*)::int AS count FROM rms_ordering.digital_receipt_record WHERE order_id=$1",
      [orderReference],
    );
    assert.equal(
      count.rows[0].count,
      ordinaryRefundFixture ? 3 : 1,
      "retrieval must not issue or rewrite receipts",
    );
  }
}

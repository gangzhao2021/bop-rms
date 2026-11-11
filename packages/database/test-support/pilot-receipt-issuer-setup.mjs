import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPersistentReceiptRuntime } from "../../../apps/api/dist/persistent-receipt-runtime.js";
import { createMerchantStoreReceiptProfile } from "../../../apps/api/dist/merchant-store-receipt-profile.js";
import { createInternalReceiptTemplateOptions } from "../../../tooling/environment/pilot-receipt.mjs";
import { createPaidPickupOrderSeeder } from "./ordinary-refund-paid-pickup-order.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const minutes = (n) => n * 60_000;
// Synthetic test-only prices and 13% exclusive tax: 90.40 + 22.60, tip 3.00 = CAD 116.00.
const LINES = [
  {
    unitAmountMinor: 2000,
    quantity: 4,
    localizedNames: { "en-CA": "Synthetic noodles", "fr-CA": "Nouilles synthétiques" },
  },
  {
    unitAmountMinor: 1000,
    quantity: 2,
    localizedNames: { "en-CA": "Synthetic tea", "fr-CA": "Thé synthétique" },
  },
];

/**
 * v15 2026-11-01 (coordinator): store 2's paid orders got no receipt — it had no receipt issuer,
 * and "Receipts and privacy" saved with every number empty answered `no_change` and recorded
 * nothing. On the Store published by `exercisePilotStoreSetupPublication` (published name, address
 * and receipt template), as the restricted NOBYPASSRLS role holding exactly the rendered pilot API
 * grants, through the actual merchant BFF route and the pilot receipt runtime:
 *
 * 1. Before the Owner saves "Receipts and privacy", a paid order's receipt is refused with
 *    DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE (the v15 failure) and nothing is written.
 * 2. The section offers the Brand's name as the business; the Owner saves it with every number and
 *    the privacy link empty: recorded (version 1, an audit for the details and one for the issuer).
 * 3. The same paid order's receipt is now issued by the normal retry (no repair): it names that
 *    business as the seller and prints no registration number.
 * 4. Saving again unchanged changes nothing (409 no_change); a new business name ends the current
 *    issuer and the next receipt names the new one, the issued receipt keeps the old one.
 * 5. Another Store's issuer (store 1 here) is not touched.
 *
 * Owner-seeded TEST-ONLY facts: the paid pickup Orders and the other Store's issuer.
 */
export async function exercisePilotReceiptIssuerSetup(context) {
  const { admin, scope, store, owner, next, now, transactions, resources, listen, id } = context;
  const brand = scope.brandReference,
    tenant = scope.tenantReference;
  const base = Date.now();
  const time = (offset) => new Date(base + offset).toISOString();
  const ownerRunner = {
    async run(work) {
      const client = new (await import("pg")).default.Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
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
    },
  };
  const issuerRows = async (storeReference) =>
    (
      await admin.query(
        "SELECT a.assignment_id,a.version,a.lifecycle,a.effective_from,a.effective_until,e.operating_entity_id,e.legal_name,e.lifecycle entity_lifecycle,e.jurisdiction_code,e.evidence_reference FROM bop_operating_entity.store_operating_entity_assignment a JOIN bop_operating_entity.operating_entity e USING (operating_entity_id) WHERE a.store_id=$1 AND a.business_function='SalesReceiptIssuer' ORDER BY a.created_at,a.assignment_id",
        [storeReference],
      )
    ).rows;
  // Another Store's issuer (owner-seeded TEST-ONLY), to show it is untouched.
  const otherStore = id(0x9f000),
    otherEntity = id(0x9f001);
  await admin.query(
    "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic store 1 issuer',NULL,'CA-ON',$2,'Active',1,$3,$3)",
    [otherEntity, id(0x9f003), time(-minutes(120))],
  );
  await admin.query(
    "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
    [id(0x9f002), brand, otherStore, otherEntity, time(-minutes(120))],
  );
  const otherBefore = await issuerRows(otherStore);
  // The Owner's Store setup permissions for this section (owner-seeded Permission facts, as the
  // harness seeds its own): reading it, and changing the Store's legal facts.
  const ownerRole = "01902431-0000-7000-8000-000000000004";
  const from = time(-minutes(60)),
    until = time(minutes(60));
  for (const [n, action] of ["organization.store.read", "organization.store.publish"].entries()) {
    const definition = await admin.query(
      "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
      [action],
    );
    let permission = definition.rows[0]?.permission_id;
    if (permission === undefined) {
      permission = id(0x9f010 + n);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(0x9f020 + n), ownerRole, permission, brand, store, from, until],
    );
  }
  assert.deepEqual(await issuerRows(store), []);

  // Paid pickup Orders (owner-seeded TEST-ONLY facts).
  const provider = next();
  const orderId = (n) => "01a9e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const seedOrder = createPaidPickupOrderSeeder({
    admin,
    ownerRunner,
    scope,
    id: orderId,
    hash,
    fresh: next,
    time,
    minutes,
    acceptorReference: owner,
    provider,
    lines: LINES,
    tipMinor: 300n,
    capturedMinor: 11600n,
  });
  const paid = await seedOrder(1000),
    later = await seedOrder(2000);
  const authorize = async (_tx, request) =>
    request.brandReference === brand && request.storeReference === store;
  const runtime = createPersistentReceiptRuntime({
    transactions,
    sources: {
      scope: { ...scope, providerAccountReference: provider, environment: "Test" },
      authorize,
    },
    template: createInternalReceiptTemplateOptions(resources, tenant, () => true, authorize),
    authorize,
    authorizeOrder: authorize,
    identities: () => ({
      recordReference: next(),
      receiptReference: next(),
      operationReference: next(),
    }),
    audit: async (record, operationReference) => ({
      auditId: next(),
      brandId: brand,
      storeId: store,
      actor: { type: "System" },
      actionCode: "DIGITAL_RECEIPT_APPEND",
      targetType: "DigitalReceipt",
      targetId: record.recordReference,
      reasonCode: "INTERNAL_TEST_RECEIPT",
      correlationId: operationReference,
      occurredAt: record.recordedAt,
      sourceChannel: "SYSTEM",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
  const issue = (order) =>
    runtime.issueOriginal({
      orderReference: order.order,
      observedAt: now(),
      freshAfter: seedOrder.paidAt,
    });
  const receiptsOf = async (order) =>
    (
      await admin.query(
        "SELECT version,receipt_record_json FROM rms_ordering.digital_receipt_record WHERE order_id=$1 ORDER BY version",
        [order.order],
      )
    ).rows;
  const audits = async (code) =>
    (
      await admin.query(
        "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code=$1 AND store_id=$2",
        [code, store],
      )
    ).rows[0].n;

  // 1. No receipt issuer yet: the v15 failure, nothing written.
  await assert.rejects(issue(paid), { code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE" });
  assert.deepEqual(await receiptsOf(paid), []);

  const receiptRoutes = (persistence, authentication) => ({
    storeReceiptProfile: createMerchantStoreReceiptProfile({ persistence, authentication }),
  });
  await listen(
    context.session,
    async (send) => {
      // 2. The Brand's name is offered; the Owner saves with every number and the link empty.
      const opened = await send("store/receipt-profile");
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.version, 0);
      assert.equal(opened.body.issuer.businessName, null);
      const businessName = opened.body.issuer.suggestedBusinessName;
      assert.equal(typeof businessName, "string");
      const empty = {
        gstHstNumber: null,
        qstNumber: null,
        pstNumber: null,
        privacyNoticeUrl: null,
      };
      const first = await send("store/receipt-profile", {
        expectedVersion: 0,
        operationReference: next(),
        details: { ...empty, businessName },
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, "Recorded");
      assert.equal(first.body.version, 1);
      assert.equal(await audits("STORE_RECEIPT_PROFILE_CHANGED"), 1);
      assert.equal(await audits("STORE_RECEIPT_ISSUER_RECORDED"), 1);
      const recorded = await issuerRows(store);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].legal_name, businessName);
      assert.equal(recorded[0].lifecycle, "Active");
      assert.equal(recorded[0].entity_lifecycle, "Active");
      assert.equal(recorded[0].effective_until, null);
      assert.notEqual(recorded[0].evidence_reference, null);
      assert.equal((await send("store/receipt-profile")).body.issuer.businessName, businessName);

      // 3. The waiting receipt is issued by the normal retry: the business, no registration.
      const receipt = await issue(paid);
      assert.equal(receipt.status, "Created");
      assert.equal(receipt.record.snapshot.operatingEntityDisplayName, businessName);
      assert.equal(receipt.record.snapshot.total.amountMinor, 11600n);
      assert.deepEqual(receipt.record.snapshot.taxDetails?.taxRegistrations ?? [], []);
      const issued = await receiptsOf(paid);
      assert.equal(issued.length, 1);

      // 4. Unchanged: nothing recorded. A new name ends the issuer; issued receipts keep theirs.
      const again = await send("store/receipt-profile", {
        expectedVersion: 1,
        operationReference: next(),
        details: { ...empty, businessName },
      });
      assert.equal(again.status, 409);
      assert.deepEqual(again.body, { error: "no_change" });
      const renamed = await send("store/receipt-profile", {
        expectedVersion: 1,
        operationReference: next(),
        details: { ...empty, businessName: "Synthetic Kitchen Operating Inc." },
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(renamed.body.status, "Recorded");
      assert.equal(renamed.body.version, 1);
      const history = await issuerRows(store);
      assert.equal(history.length, 2);
      assert.notEqual(history[0].effective_until, null);
      assert.equal(history[0].version, 2);
      assert.equal(history[1].legal_name, "Synthetic Kitchen Operating Inc.");
      assert.equal(history[1].effective_until, null);
      const next1 = await issue(later);
      assert.equal(next1.status, "Created");
      assert.equal(
        next1.record.snapshot.operatingEntityDisplayName,
        "Synthetic Kitchen Operating Inc.",
      );
      assert.deepEqual(await receiptsOf(paid), issued);
    },
    receiptRoutes,
  );

  // 5. The other Store's issuer is untouched.
  assert.deepEqual(await issuerRows(otherStore), otherBefore);
}

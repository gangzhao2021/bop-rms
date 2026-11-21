import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createPersistentReceiptRuntime } from "../../../apps/api/dist/persistent-receipt-runtime.js";
import {
  createInternalReceiptTemplateOptions,
  readInternalReceiptTemplateReadiness,
} from "../../../tooling/environment/pilot-receipt.mjs";
import {
  evaluateAlertConditions,
  renderAlert,
} from "../../../tooling/environment/pilot-alerts.mjs";
import { createPaidPickupOrderSeeder } from "./ordinary-refund-paid-pickup-order.mjs";
import { seedStepUp } from "./sole-operator-brand-gate.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const minutes = (n) => n * 60_000;
// Two lines, synthetic test-only prices and 13% exclusive tax: 90.40 + 22.60, tip 3.00 = CAD 116.00.
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
const TIP_MINOR = 300n,
  CAPTURED_MINOR = 11600n;

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION (receipt issuance follows the published Store configuration),
 * run on the Store published by `exercisePilotStoreSetupPublication` (sole operator in effect for
 * the Owner), through the pilot composition as the restricted NOBYPASSRLS role holding exactly the
 * rendered pilot API grants:
 *
 * 1. The Owner writes a receipt template, sends it, approves it alone as sole operator and publishes
 *    it (actual Store setup BFF), then publishes a Store configuration naming it (step 8). A new
 *    paid pickup Order gets a receipt issued with that template (version code and exact version
 *    recorded on the receipt), by the pilot receipt template composition.
 * 2. Switching back to the installed template (published the same way) issues the next receipt
 *    with it; the earlier receipt is unchanged.
 * 3. When the named template can no longer be proven (its Publishing release archived), issuance is
 *    refused with DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE (nothing written, no fallback to another
 *    template) and the operations check reports it, raising "Receipts are not being issued".
 *
 * Owner-seeded TEST-ONLY facts: the paid pickup Orders (Pricing quote, Ordering and Payment rows),
 * the receipt issuer, the second person's withdrawn Owner access, step-up evidence and the archive
 * of the installed template's release.
 */
export async function exercisePilotReceiptTemplateIssuance(context) {
  const {
    admin,
    clientConfig,
    api,
    scope,
    store,
    owner,
    next,
    now,
    transactions,
    resources,
    listen,
    command,
    workspaceOf,
    saveSetup,
    materialize,
    liveReceipt,
    receiptInstaller,
    storeLocale,
    id,
  } = context;
  const brand = scope.brandReference,
    tenant = scope.tenantReference;
  const base = Date.now();
  const time = (offset) => new Date(base + offset).toISOString();
  const ownerRunner = {
    async run(work) {
      const client = new pg.Client(clientConfig);
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
  let stepUps = 0;
  const freshStepUp = () =>
    seedStepUp(admin, {
      id: (n) => id(0x9d800 + n),
      n: 10 * stepUps++,
      brandReference: brand,
      storeReference: store,
      actorReference: owner,
    });

  // The second person's Owner access at this Store is withdrawn (owner-seeded Permission fact), so
  // sole operator is in effect for the Owner's receipt template as well.
  const withdrawn = await admin.query(
    "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND store_id=$2 AND lifecycle='Active' AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage')",
    ["01902433-0000-7000-8000-000000000004", store],
  );
  assert.equal(withdrawn.rowCount, 1);

  // 1a. The Owner writes, sends, approves alone and publishes a receipt template (the presets of a
  // template the harness published reused).
  const presets = (
    await admin.query(
      "SELECT version_json->>'layoutDefinitionReference' layout,version_json->>'complianceRuleReference' compliance FROM rms_device.digital_receipt_template_version WHERE store_id=$1 AND template_id<>$2 ORDER BY published_at DESC LIMIT 1",
      [store, liveReceipt.templateReference],
    )
  ).rows[0];
  assert(presets, "the harness published a receipt template");
  let draft;
  await listen(context.session, async (send) => {
    const saved = await send("store-setup/receipt-template-draft", {
      command: "SaveDraft",
      operationReference: next(),
      templateReference: null,
      expectedVersionReference: null,
      expectedRevision: 0,
      fields: {
        locale: storeLocale,
        layoutDefinitionReference: presets.layout,
        complianceRuleReference: presets.compliance,
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    draft = saved.body.snapshot;
    const sent = await send("store-setup/receipt-template-submit", {
      command: "SubmitReview",
      operationReference: next(),
      templateReference: draft.content.templateReference,
      expectedVersionReference: draft.content.versionReference,
      expectedRevision: draft.revision,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const reviewPath =
      "store-setup/receipt-template-review?storeReference=" +
      store +
      "&templateReference=" +
      draft.content.templateReference;
    const lifecycle = (review, commandName, extra = {}) => ({
      command: commandName,
      operationReference: next(),
      templateReference: draft.content.templateReference,
      expectedVersionReference: draft.content.versionReference,
      expectedRevision: draft.revision,
      reviewLifecycleReference: review.lifecycle.lifecycleReference,
      expectedReviewVersion: review.lifecycle.version,
      expectedReviewOperationReference: review.lifecycle.latestMutationOperationReference,
      ...extra,
    });
    await freshStepUp();
    let review = (await send(reviewPath)).body;
    const approved = await send(
      "store-setup/receipt-template-lifecycle",
      lifecycle(review, "Approve", { approvalMode: "SoleOperator" }),
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.result.approvedByReference, owner);
    review = (await send(reviewPath)).body;
    const published = await send(
      "store-setup/receipt-template-lifecycle",
      lifecycle(review, "Publish"),
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.result.state, "Published");
  });
  const authored = draft.content;
  assert.notEqual(authored.templateReference, liveReceipt.templateReference);

  // The Owner publishes the Store setup naming a receipt template (step 5 choice, step 8 publish,
  // approved alone as sole operator).
  const publishWithTemplate = async (templateReference) => {
    let published;
    await listen(context.session, async (send, selected) => {
      const saved = await saveSetup(send, {
        receiptReference: { state: "Configured", value: templateReference },
      });
      let workspace = await workspaceOf(send);
      const created = await materialize(send, selected, workspace.body.expectedHead, saved);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      workspace = await workspaceOf(send);
      assert(
        workspace.body.publicationChecks.checks.every((c) => c.outcome === "Pass"),
        JSON.stringify(workspace.body.publicationChecks),
      );
      const sent = await send("store-configuration/ordinary-command", {
        command: command(selected, "Submit", workspace.body.expectedHead),
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      workspace = await workspaceOf(send);
      await freshStepUp();
      const approved = await send("store-configuration/ordinary-command", {
        command: command(selected, "Approve", workspace.body.expectedHead),
        approvalMode: "SoleOperator",
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      workspace = await workspaceOf(send);
      const result = await send("store-configuration/ordinary-command", {
        command: command(selected, "Publish", workspace.body.expectedHead),
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      workspace = await workspaceOf(send);
      published = workspace.body.current;
      assert.equal(published.lifecycle, "Published");
      assert.equal(published.receiptReference, templateReference);
    });
    return published;
  };

  // Paid pickup Orders and the receipt issuer (owner-seeded TEST-ONLY facts).
  const provider = next();
  const orderId = (n) => "01a9d000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
    tipMinor: TIP_MINOR,
    capturedMinor: CAPTURED_MINOR,
  });
  const orders = [];
  for (const n of [1000, 2000, 3000]) orders.push(await seedOrder(n));
  const issuer = next();
  await admin.query(
    "INSERT INTO bop_operating_entity.operating_entity(operating_entity_id,kind,legal_name,trade_name,jurisdiction_code,registration_reference,tax_registration_reference,billing_identity_reference,settlement_reference,evidence_reference,lifecycle,version,created_at,updated_at) VALUES($1,'LegalEntity','Synthetic test issuer','Synthetic Kitchen','CA-ON',$2,$3,$4,$5,$6,'Active',1,$7,$7)",
    [issuer, next(), next(), next(), next(), next(), time(-minutes(120))],
  );
  await admin.query(
    "INSERT INTO bop_operating_entity.store_operating_entity_assignment(assignment_id,brand_id,store_id,operating_entity_id,business_function,lifecycle,effective_from,effective_until,version,created_at,updated_at) VALUES($1,$2,$3,$4,'SalesReceiptIssuer','Active',$5,NULL,1,$5,$5)",
    [next(), brand, store, issuer, time(-minutes(120))],
  );

  // The pilot receipt runtime with the pilot's receipt template composition (template from the
  // published Store configuration). Receipt details (address, registrations) are composed and
  // accepted separately (receipt-tax-privacy); none are needed here.
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
  const readiness = () =>
    readInternalReceiptTemplateReadiness({
      ...resources,
      publicProfile: {
        binding: {
          tenantReference: tenant,
          validUntil: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    });
  // Before any change the Store issues with the installed template it uses today.
  assert.deepEqual(await readiness(), {
    ready: true,
    templateReference: liveReceipt.templateReference,
    versionReference: liveReceipt.versionReference,
    versionCode: "RECEIPT_V1",
  });

  // 1b. The Store now names the Owner's template: a new paid pickup Order's receipt uses it.
  await publishWithTemplate(authored.templateReference);
  assert.deepEqual(await readiness(), {
    ready: true,
    templateReference: authored.templateReference,
    versionReference: authored.versionReference,
    versionCode: authored.versionCode,
  });
  const first = await issue(orders[0]);
  assert.equal(first.status, "Created");
  assert.equal(first.record.snapshot.templateVersion, authored.versionCode);
  assert.equal(first.record.snapshot.templateVersionReference, authored.versionReference);
  assert.equal(first.record.snapshot.locale, storeLocale);
  assert.equal(first.record.snapshot.total.amountMinor, CAPTURED_MINOR);
  assert.deepEqual(
    first.record.snapshot.lines.map((line) => line.displayName),
    LINES.map((line) => line.localizedNames[storeLocale]),
  );
  const firstRows = await receiptsOf(orders[0]);
  assert.equal(firstRows.length, 1);
  assert.equal(
    firstRows[0].receipt_record_json.snapshot.templateVersionReference,
    authored.versionReference,
  );

  // 2. Back to the installed template: the next receipt uses it; the earlier one is unchanged.
  await publishWithTemplate(liveReceipt.templateReference);
  const second = await issue(orders[1]);
  assert.equal(second.status, "Created");
  assert.equal(second.record.snapshot.templateVersion, "RECEIPT_V1");
  assert.equal(second.record.snapshot.templateVersionReference, liveReceipt.versionReference);
  assert.deepEqual(await receiptsOf(orders[0]), firstRows);
  // A retry of the first Order returns its receipt as issued (no reissue with the new template).
  const replay = await issue(orders[0]);
  assert.equal(replay.status, "Existing");
  assert.equal(replay.record.snapshot.templateVersionReference, authored.versionReference);

  // 3. The named template can no longer be proven (TEST-ONLY: its Publishing release archived).
  await ownerRunner.run((tx) => receiptInstaller.archive(tx));
  const before = (
    await admin.query(
      "SELECT (SELECT count(*) FROM rms_ordering.digital_receipt_record)::int receipts,(SELECT count(*) FROM platform_audit.audit_record WHERE action_code='DIGITAL_RECEIPT_APPEND')::int audits",
    )
  ).rows[0];
  await assert.rejects(issue(orders[2]), { code: "DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE" });
  assert.deepEqual(await receiptsOf(orders[2]), []);
  assert.deepEqual(
    (
      await admin.query(
        "SELECT (SELECT count(*) FROM rms_ordering.digital_receipt_record)::int receipts,(SELECT count(*) FROM platform_audit.audit_record WHERE action_code='DIGITAL_RECEIPT_APPEND')::int audits",
      )
    ).rows[0],
    before,
  );
  const refused = await readiness();
  assert.deepEqual(refused, { ready: false, reason: "TemplateNotProven" });
  // The operations monitor's rule for that observation: the staff alert on the Home.
  const conditions = evaluateAlertConditions({
    now: Date.now(),
    business: { receiptTemplate: refused },
  });
  const alert = conditions.get("receipts.template");
  assert.equal(alert.severity, "critical");
  const text = renderAlert("receipts.template", alert.params);
  assert.equal(text.title, "Receipts are not being issued");
  assert.match(text.summary, /receipt template chosen in Store setup cannot be used/u);
  // Issued receipts never change.
  assert.deepEqual(await receiptsOf(orders[0]), firstRows);
  assert.equal((await receiptsOf(orders[1])).length, 1);
  void api;
  return { authored, orders };
}

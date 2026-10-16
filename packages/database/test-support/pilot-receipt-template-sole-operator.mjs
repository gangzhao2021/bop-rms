import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { createIdentityActor } from "../../bop/identity/src/index.ts";
import { digitalReceiptRequiredFields } from "../../rms/printing-device/src/index.ts";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
import { createMerchantStoreConfigurationReferenceSources } from "../../../apps/api/dist/merchant-store-configuration-reference-sources.js";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalStoreSetupDraftBff } from "../../../tooling/environment/pilot-store-setup.mjs";
import { prepareReceiptTemplatePublication } from "./receipt-template-publication.mjs";
import { seedSoleOperatorSetting, seedStepUp } from "./sole-operator-brand-gate.mjs";

const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/**
 * WP-2423 (Owner decision 2026-10-16, Store configuration publication including the receipt
 * template), through the pilot composition as a restricted NOBYPASSRLS role holding exactly the
 * rendered pilot API grants:
 *
 * 1. The receipt template the Store uses today, as the installer published it (RECEIPT_V1: a
 *    Publishing release whose digest is the full version envelope, no authored submission), is
 *    read by the merchant published read and by the Store configuration reference source.
 * 2. An Owner who wrote and sent a receipt template approves it alone only while sole operator is
 *    in effect for them, with a second factor at most 15 minutes old; refusals say why; the
 *    approval is marked (append-only), audited and then published, and every reader accepts it.
 * 3. Database guards: a self-approval without its mark, and a mark without a real approval, are
 *    refused; the mark cannot be changed or removed.
 *
 * The installer-shaped template and its Publishing history, the sole-operator setting, the step-up
 * evidence and the withdrawal of the second person's access are owner-seeded TEST-ONLY facts.
 */
export async function exercisePilotReceiptTemplateSoleOperator(input) {
  const { admin, clientConfig, runId, session, manager, scope, id } = input;
  const store = scope.storeReference,
    owner = scope.actorReference;
  const api = "wp2423_rtso_" + runId,
    worker = "wp2423_rtso_w_" + runId;
  for (const name of [api, worker])
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  try {
    const root = new URL("../../../docs/spec/", import.meta.url);
    const matrices = await Promise.all(
      ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
        JSON.parse(await readFile(new URL(file, root), "utf8")),
      ),
    );
    await admin.query(renderPilotAclSql(matrices, { api, worker }));
    let allocated = 0x9d000;
    const next = () => id(allocated++);
    const now = () => new Date().toISOString();
    const client = async () => {
      const c = new pg.Client({
        ...clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 15000,
      });
      await c.connect();
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await c.query("SET LOCAL ROLE " + api);
      await c.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, store],
      );
      return c;
    };
    const transactions = {
      async run(work) {
        const c = await client();
        try {
          const result = await work({ query: (sql, values = []) => c.query(sql, values) });
          await c.query("COMMIT");
          return result;
        } catch (error) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await c.end();
        }
      },
    };
    // Identity roster double (pilot `currentActor`): an active workforce actor per reference, so
    // the sole-operator gate evaluates each Store member as an approval would (TEST-ONLY).
    const currentActor = async (_tx, reference, authenticatedAt) =>
      createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    const persistenceFor = (reader) => ({
      ...reader.persistence,
      currentActor,
      transactions,
      now,
    });
    const listen = async (reader, work) => {
      const bff = createInternalStoreSetupDraftBff({
        persistence: persistenceFor(reader),
        authentication: reader.authentication,
        nextReference: next,
      });
      const app = express();
      app.use(
        "/merchant",
        createMerchantBffRouter({
          service: reader.authentication,
          exactOrigin: "https://merchant.invalid",
          acceptedHost: "merchant.invalid",
          ...bff,
        }),
      );
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const selected = { ...scope, actorReference: reader === session ? owner : id(9) };
      const send = (path, body) =>
        new Promise((resolve, reject) => {
          const bytes = body === undefined ? null : JSON.stringify(body);
          const req = request(
            {
              host: "127.0.0.1",
              port: server.address().port,
              method: bytes === null ? "GET" : "POST",
              path: "/merchant/" + path,
              headers: {
                host: "merchant.invalid",
                origin: "https://merchant.invalid",
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-merchant=" + reader.sessionCookie,
                "x-bop-store-setup-scope": Buffer.from(canonicalizeRfc8785(selected)).toString(
                  "base64url",
                ),
                ...(bytes === null
                  ? {}
                  : {
                      "x-bop-csrf": reader.csrf,
                      "content-type": "application/json",
                      "content-length": Buffer.byteLength(bytes),
                    }),
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.once("end", () =>
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                }),
              );
            },
          );
          req.setTimeout(20000, () => req.destroy(new Error("PILOT_RECEIPT_SOLE_HTTP_TIMEOUT")));
          req.once("error", reject);
          req.end(bytes ?? undefined);
        });
      try {
        return await work(send, selected);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    };
    const storeLocale = (
      await admin.query("SELECT locale FROM bop_tenant.store WHERE store_id=$1", [store])
    ).rows[0].locale;

    // 1. The template in use today, as the installer published it (TEST-ONLY seed): a Publishing
    // CreateDraft/Submit/Approve/Publish by one synthetic installer actor, the release digest over
    // the full version envelope, the version row, and no authored submission.
    const installedAt = new Date(Date.now() - 3600000).toISOString();
    const installed = {
      templateReference: next(),
      versionReference: next(),
      versionNumber: 1,
      versionCode: "RECEIPT_V1",
      brandReference: scope.brandReference,
      storeReference: store,
      locale: storeLocale,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      layoutDefinitionReference: next(),
      complianceRuleReference: next(),
      requiredFields: [...digitalReceiptRequiredFields],
      publicationReference: next(),
      publishedAt: installedAt,
      effectiveFrom: installedAt,
      effectiveUntil: null,
    };
    const installedDigest = hash(installed);
    const installer = await prepareReceiptTemplatePublication({
      admin,
      // Its fixture grants go to the unused worker role, never the API role under test.
      role: worker,
      scope: { brandReference: scope.brandReference, storeReference: store },
      version: installed,
      digest: installedDigest,
      tenantReference: scope.tenantReference,
    });
    await installer.publish();
    await admin.query(
      "INSERT INTO rms_device.digital_receipt_template_version(version_id,brand_id,store_id,template_id,version_number,version_code,operation_id,audit_id,publication_id,publication_digest,published_at,version_json,data_classification) VALUES($1,$2,$3,$4,1,'RECEIPT_V1',$5,$6,$7,$8,$9,$10::jsonb,'Confidential')",
      [
        installed.versionReference,
        scope.brandReference,
        store,
        installed.templateReference,
        next(),
        next(),
        installed.publicationReference,
        installedDigest,
        installedAt,
        JSON.stringify(installed),
      ],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM rms_device.digital_receipt_template_submission WHERE version_id=$1",
          [installed.versionReference],
        )
      ).rows[0].n,
      0,
    );
    const startedWithPath =
      "store-setup/receipt-template-published?storeReference=" +
      store +
      "&installed=true&locale=" +
      storeLocale;
    const publishedPath = (template) =>
      "store-setup/receipt-template-published?storeReference=" +
      store +
      "&templateReference=" +
      template +
      "&locale=" +
      storeLocale;
    await listen(session, async (send) => {
      const read = await send(publishedPath(installed.templateReference));
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual(read.body.currentVersion, installed);
      assert.equal(read.body.templateReference, installed.templateReference);
      // WP-2423 (2026-10-16): Store setup finds the template the Store started with by itself.
      const started = await send(startedWithPath);
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.templateReference, installed.templateReference);
      assert.deepEqual(started.body.currentVersion, installed);
    });
    // The Store configuration reference source (what Store setup re-reads when it creates, sends,
    // approves and publishes a configuration naming this template).
    const referenceRead = async (reader, template) => {
      const c = await client();
      const before = [],
        after = [];
      try {
        const tx = { query: (sql, values = []) => c.query(sql, values) };
        const persistence = persistenceFor(reader);
        const selected = await createMerchantStoreScope(persistence)(
          tx,
          reader.sessionCookie,
          "organization.manage",
        );
        const origin = now();
        const sources = createMerchantStoreConfigurationReferenceSources({
          persistence,
          sessionCookie: reader.sessionCookie,
          transaction: tx,
          scope: selected,
          sourceHost: {
            registerBeforeCommit: async (actual, guard, final) => {
              assert.equal(actual, tx);
              before.push({ guard, final });
            },
            registerAfterCommit: (actual, assertFinalized) => {
              assert.equal(actual, tx);
              after.push(assertFinalized);
            },
          },
          originalObservedAt: origin,
          originalValidUntil: new Date(Date.parse(origin) + 5000).toISOString(),
        });
        const value = await sources.receipt(template);
        for (const hook of before) await hook.guard();
        for (const hook of before) hook.final();
        await c.query("COMMIT");
        for (const finalize of after) finalize();
        return value;
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await c.end();
      }
    };
    assert.deepEqual(await referenceRead(session, installed.templateReference), installed);
    // Superseded or unknown references still prove nothing (no fallback beyond the current one).
    await assert.rejects(referenceRead(session, next()));

    // 2. The Owner writes and sends a new receipt template (the presets of the template the
    // harness published reused).
    const presets = (
      await admin.query(
        "SELECT version_json->>'layoutDefinitionReference' layout,version_json->>'complianceRuleReference' compliance FROM rms_device.digital_receipt_template_version WHERE template_id<>$1 ORDER BY published_at DESC LIMIT 1",
        [installed.templateReference],
      )
    ).rows[0];
    assert(presets, "the harness published a receipt template");
    let draft;
    await listen(session, async (send) => {
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
      assert.equal(draft.authoredByReference, owner);
      const sent = await send("store-setup/receipt-template-submit", {
        command: "SubmitReview",
        operationReference: next(),
        templateReference: draft.content.templateReference,
        expectedVersionReference: draft.content.versionReference,
        expectedRevision: draft.revision,
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
    });
    const reviewPath = () =>
      "store-setup/receipt-template-review?storeReference=" +
      store +
      "&templateReference=" +
      draft.content.templateReference;
    const approve = (review, extra = {}) => ({
      command: "Approve",
      operationReference: next(),
      templateReference: draft.content.templateReference,
      expectedVersionReference: draft.content.versionReference,
      expectedRevision: draft.revision,
      reviewLifecycleReference: review.lifecycle.lifecycleReference,
      expectedReviewVersion: review.lifecycle.version,
      expectedReviewOperationReference: review.lifecycle.latestMutationOperationReference,
      ...extra,
    });
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*) FROM rms_device.digital_receipt_template_lifecycle_operation)::int lifecycle,(SELECT count(*) FROM rms_device.digital_receipt_template_sole_operator_approval)::int marks,(SELECT count(*) FROM bop_publishing.publishing_mutation_record)::int publishing,(SELECT count(*) FROM platform_audit.audit_record)::int audits",
        )
      ).rows[0];
    const refusedUnchanged = async (attempt, status, error) => {
      const before = await counts();
      const reply = await attempt();
      assert.equal(reply.status, status, JSON.stringify(reply.body));
      if (error !== undefined) assert.deepEqual(reply.body, { error });
      assert.deepEqual(await counts(), before);
    };
    const gatePath = "store-setup/receipt-template-sole-operator";
    // Sole operator off: told so; asking alone is refused with the reason; not asking is the
    // ordinary refusal of approving your own template.
    await listen(session, async (send) => {
      const review = (await send(reviewPath())).body;
      assert.equal(review.lifecycle.state, "InReview");
      assert.equal(review.submission.submittedByReference, owner);
      const gate = await send(gatePath);
      assert.equal(gate.status, 200, JSON.stringify(gate.body));
      assert.equal(gate.body.soleOperator.status, "NotSet");
      await refusedUnchanged(
        () =>
          send(
            "store-setup/receipt-template-lifecycle",
            approve(review, { approvalMode: "SoleOperator" }),
          ),
        403,
        "sole_operator_off",
      );
      await refusedUnchanged(
        () => send("store-setup/receipt-template-lifecycle", approve(review)),
        409,
      );
      await refusedUnchanged(
        () =>
          send(
            "store-setup/receipt-template-lifecycle",
            approve(review, { approvalMode: "Independent" }),
          ),
        400,
      );
    });
    // Setting on (owner-seeded Organization fact), but the second person also holds Owner access.
    const sid = (n) => id(0x9e800 + n);
    await seedSoleOperatorSetting(admin, {
      id: sid,
      n: 0,
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: owner,
      state: "On",
      version: 1,
    });
    await listen(session, async (send) => {
      const review = (await send(reviewPath())).body;
      const gate = await send(gatePath);
      assert.equal(gate.body.soleOperator.status, "OtherApprovers");
      assert.equal(gate.body.soleOperator.otherApprovers.length, 1);
      await refusedUnchanged(
        () =>
          send(
            "store-setup/receipt-template-lifecycle",
            approve(review, { approvalMode: "SoleOperator" }),
          ),
        403,
        "sole_operator_not_in_effect",
      );
    });
    // The second person's Owner access at this Store is withdrawn (owner-seeded Permission fact).
    const withdrawn = await admin.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE role_id=$1 AND store_id=$2 AND lifecycle='Active' AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='organization.manage')",
      ["01902433-0000-7000-8000-000000000004", store],
    );
    assert.equal(withdrawn.rowCount, 1);
    let approvedReceipt, stepUpAt;
    await listen(session, async (send) => {
      let review = (await send(reviewPath())).body;
      const gate = await send(gatePath);
      assert.deepEqual(gate.body.soleOperator, {
        status: "Effective",
        otherApprovers: [],
        verifiedUntil: null,
      });
      // In effect but never verified, or verified more than 15 minutes ago: refused.
      await refusedUnchanged(
        () =>
          send(
            "store-setup/receipt-template-lifecycle",
            approve(review, { approvalMode: "SoleOperator" }),
          ),
        403,
        "sole_operator_needs_verification",
      );
      await seedStepUp(admin, {
        id: sid,
        n: 10,
        brandReference: scope.brandReference,
        storeReference: store,
        actorReference: owner,
        ageMs: 20 * 60000,
      });
      await refusedUnchanged(
        () =>
          send(
            "store-setup/receipt-template-lifecycle",
            approve(review, { approvalMode: "SoleOperator" }),
          ),
        403,
        "sole_operator_needs_verification",
      );
      stepUpAt = await seedStepUp(admin, {
        id: sid,
        n: 20,
        brandReference: scope.brandReference,
        storeReference: store,
        actorReference: owner,
      });
      assert.equal(
        (await send(gatePath)).body.soleOperator.verifiedUntil,
        new Date(Date.parse(stepUpAt) + 15 * 60000).toISOString(),
      );
      // Not asked as sole operator: still refused (never implied).
      await refusedUnchanged(
        () => send("store-setup/receipt-template-lifecycle", approve(review)),
        409,
      );
      const before = await counts();
      const approved = await send(
        "store-setup/receipt-template-lifecycle",
        approve(review, { approvalMode: "SoleOperator" }),
      );
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      approvedReceipt = approved.body;
      assert.equal(approvedReceipt.outcome, "Committed");
      assert.equal(approvedReceipt.result.approvedByReference, owner);
      const after = await counts();
      assert.equal(after.lifecycle, before.lifecycle + 1);
      assert.equal(after.marks, before.marks + 1);
      // Published by the same Owner (no sole-operator request needed; the mark is checked).
      review = (await send(reviewPath())).body;
      assert.equal(review.lifecycle.state, "Approved");
      const published = await send("store-setup/receipt-template-lifecycle", {
        command: "Publish",
        operationReference: next(),
        templateReference: draft.content.templateReference,
        expectedVersionReference: draft.content.versionReference,
        expectedRevision: draft.revision,
        reviewLifecycleReference: review.lifecycle.lifecycleReference,
        expectedReviewVersion: review.lifecycle.version,
        expectedReviewOperationReference: review.lifecycle.latestMutationOperationReference,
      });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal(published.body.result.state, "Published");
      // Every reader accepts the self-approval only through its mark: the merchant published read.
      const read = await send(publishedPath(draft.content.templateReference));
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.currentVersion.versionReference, draft.content.versionReference);
      // The Owner's own template is never "the one the Store started with"; that stays the
      // installed one, so they can go back to it from Store setup.
      const started = await send(startedWithPath);
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(started.body.templateReference, installed.templateReference);
    });
    // ... and the Store configuration reference source.
    const own = await referenceRead(session, draft.content.templateReference);
    assert.equal(own.versionReference, draft.content.versionReference);
    // Recorded as sole operator: the mark (second factor, time, operation, Publishing audit) and
    // the audit saying so.
    const marks = (
      await admin.query(
        "SELECT template_id::text template,version_id::text version,operation_id::text operation,approval_evidence_id::text evidence,approval_mode,actor_id::text actor,actor_mfa_at,approved_at,audit_id::text audit FROM rms_device.digital_receipt_template_sole_operator_approval",
      )
    ).rows;
    assert.equal(marks.length, 1);
    const mark = marks[0];
    assert.equal(mark.template, draft.content.templateReference);
    assert.equal(mark.version, draft.content.versionReference);
    assert.equal(mark.operation, approvedReceipt.operationReference);
    assert.equal(mark.evidence, approvedReceipt.result.approvalEvidenceReference);
    assert.equal(mark.approval_mode, "SoleOperator");
    assert.equal(mark.actor, owner);
    assert.equal(mark.actor_mfa_at.toISOString(), stepUpAt);
    assert.equal(mark.approved_at.toISOString(), approvedReceipt.result.approvedAt);
    assert.equal(mark.audit, approvedReceipt.auditReference);
    const soleAudits = (
      await admin.query(
        "SELECT actor_reference::text actor,reason_code,after_summary_json,correlation_id::text correlation FROM platform_audit.audit_record WHERE action_code='RECEIPT_TEMPLATE_SOLE_OPERATOR_APPROVED'",
      )
    ).rows;
    assert.equal(soleAudits.length, 1);
    assert.deepEqual(soleAudits[0], {
      actor: owner,
      reason_code: "SOLE_OPERATOR_APPROVAL",
      after_summary_json: { approvalMode: "SoleOperator" },
      correlation: approvedReceipt.operationReference,
    });

    // 3. Database guards, written directly as the restricted pilot API role.
    const approvalRow = (
      await admin.query(
        "SELECT * FROM rms_device.digital_receipt_template_lifecycle_operation WHERE operation_id=$1",
        [approvedReceipt.operationReference],
      )
    ).rows[0];
    const copy = (operation, audit, evidence) => {
      const receipt = {
        ...approvalRow.receipt_json,
        operationReference: operation,
        auditReference: audit,
        result: {
          ...approvalRow.receipt_json.result,
          mutationOperationReference: operation,
          approvalEvidenceReference: evidence,
        },
      };
      return [
        operation,
        approvalRow.tenant_id,
        approvalRow.brand_id,
        approvalRow.store_id,
        approvalRow.actor_id,
        approvalRow.action,
        approvalRow.template_id,
        approvalRow.expected_version_id,
        approvalRow.expected_revision,
        approvalRow.review_lifecycle_id,
        approvalRow.expected_review_version,
        approvalRow.expected_review_operation_id,
        approvalRow.intent_digest,
        approvalRow.outcome,
        hash(receipt.result),
        audit,
        approvalRow.occurred_at,
        JSON.stringify(receipt),
        hash(receipt),
      ];
    };
    const insertLifecycle =
      "INSERT INTO rms_device.digital_receipt_template_lifecycle_operation(operation_id,tenant_id,brand_id,store_id,actor_id,action,template_id,expected_version_id,expected_revision,review_lifecycle_id,expected_review_version,expected_review_operation_id,intent_digest,outcome,result_digest,audit_reference,occurred_at,receipt_json,receipt_digest,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,'Confidential')";
    const insertMark =
      "INSERT INTO rms_device.digital_receipt_template_sole_operator_approval (tenant_id,brand_id,store_id,template_id,version_id,review_lifecycle_id,operation_id,approval_evidence_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SoleOperator',$9,$10,$11,$12,'Confidential')";
    const markValues = (operation, audit, evidence) => [
      approvalRow.tenant_id,
      approvalRow.brand_id,
      approvalRow.store_id,
      approvalRow.template_id,
      approvalRow.expected_version_id,
      approvalRow.review_lifecycle_id,
      operation,
      evidence,
      owner,
      stepUpAt,
      approvalRow.occurred_at,
      audit,
    ];
    const direct = async (work) => {
      const c = await client();
      try {
        await work(c);
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await c.end();
      }
    };
    const unchanged = async (work, code) => {
      const before = await counts();
      await assert.rejects(direct(work), (error) => error.code === code);
      assert.deepEqual(await counts(), before);
    };
    // The Owner's approval of their own template without its mark is refused.
    await unchanged((c) => c.query(insertLifecycle, copy(next(), next(), next())), "23514");
    // A mark naming no committed approval rolls back at COMMIT.
    await unchanged((c) => c.query(insertMark, markValues(next(), next(), next())), "23514");
    // A mark outside the 15-minute second-factor window is refused.
    await unchanged(async (c) => {
      const op = next(),
        audit = next(),
        evidence = next();
      const values = markValues(op, audit, evidence);
      values[9] = new Date(
        Date.parse(approvalRow.occurred_at.toISOString()) - 16 * 60000,
      ).toISOString();
      await c.query(insertMark, values);
      await c.query(insertLifecycle, copy(op, audit, evidence));
    }, "23514");
    // Positive control: the same approval with its matching mark is accepted (then rolled back).
    {
      const c = await client();
      try {
        const op = next(),
          audit = next(),
          evidence = next();
        await c.query(insertMark, markValues(op, audit, evidence));
        await c.query(insertLifecycle, copy(op, audit, evidence));
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    }
    // Append-only: the API role holds no UPDATE/DELETE; even the owner cannot change the mark.
    await unchanged(
      (c) =>
        c.query(
          "UPDATE rms_device.digital_receipt_template_sole_operator_approval SET approval_mode='SoleOperator'",
        ),
      "42501",
    );
    for (const sql of [
      "UPDATE rms_device.digital_receipt_template_sole_operator_approval SET approval_mode='SoleOperator'",
      "DELETE FROM rms_device.digital_receipt_template_sole_operator_approval",
      "TRUNCATE rms_device.digital_receipt_template_sole_operator_approval",
    ])
      await assert.rejects(admin.query(sql), { code: "55000" });
    assert.equal((await counts()).marks, 1);
    // The second person never reads a mark from another Store scope (forced RLS).
    {
      const c = await client();
      try {
        await c.query("SELECT set_config('bop.store_id',$1,true)", [id(0x9eeee)]);
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int n FROM rms_device.digital_receipt_template_sole_operator_approval",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    }
    void manager;
    return { installed, draft, approvedReceipt };
  } finally {
    for (const name of [api, worker]) {
      await admin.query("DROP OWNED BY " + name).catch(() => undefined);
      await admin.query("DROP ROLE " + name).catch(() => undefined);
    }
  }
}

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantStoreSetup } from "../../../apps/api/src/merchant-store-setup.ts";
import { createMerchantStoreSetupReferences } from "../../../apps/api/src/merchant-store-setup-references.ts";
import { createMerchantStorePaymentConfiguration } from "../../../apps/api/src/merchant-store-payment-configuration.ts";
import { createMerchantReceiptTemplateDraft } from "../../../apps/api/src/merchant-receipt-template-draft.ts";
import { createMerchantReceiptTemplateArtifacts } from "../../../apps/api/src/merchant-receipt-template-artifacts.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import {
  StoreSetupOperationError,
  createUnconfiguredStoreSetupDraftContent,
} from "../../rms/store/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalStoreSetupBff } from "../../../tooling/environment/pilot-store-setup.mjs";
import { createMerchantBffRouter } from "../../../apps/api/dist/merchant-bff.js";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client } = pg;
const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
const id = (n) => "01a7e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q15/Q16: the Owner opens Store setup (where Receipts and privacy lives). The read runs as
 * a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (pilot ACL matrix +
 * additions): an Owner (organization.manage, plus the Brand Owner template at Brand scope) gets the
 * Store, its setup and every Store setup sub-read (address/contact, payment configuration, receipt
 * template drafts and presets, fee classification choices); a Store Manager without it is refused
 * (403, not 503).
 */
it("WP-2423: the Owner reads Store setup under the pilot API grants", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_setup_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_ss_" + context.runId,
      worker = "wp2423_ss_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '20s'");
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
      const scope = { tenantReference: id(3), brandReference: id(1), storeReference: id(2) };
      const now = () => new Date().toISOString();
      let next = 0x100;
      const setupFor = (session) =>
        createMerchantStoreSetup({
          persistence: session.persistence,
          authentication: session.authentication,
          nextReference: () => id(next++),
        });
      const read = (session) =>
        setupFor(session).read({
          sessionCookie: session.sessionCookie,
          expectedStoreReference: scope.storeReference,
        });
      const owner = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: id(10),
        at: now(),
        extraPermissions: ["organization.manage"],
      });
      // The Owner's Brand role (Brand Owner template at Brand scope) carries what the fee
      // classification registry checks; v13 and earlier did not hold catalog.tax-classification.read.
      const brandActions = brandRoleTemplateActions("brand-owner");
      for (const action of ["catalog.manage", "catalog.tax-classification.read"])
        assert.ok(brandActions.includes(action), action);
      {
        const membership = (
          await admin.query(
            "SELECT membership_id FROM bop_membership.membership WHERE actor_id=$1",
            [id(10)],
          )
        ).rows[0].membership_id;
        const from = new Date(Date.now() - 60000).toISOString(),
          until = new Date(Date.now() + 3600000).toISOString();
        await admin.query(
          "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_brand_owner','Active',$3,$4,1,$3,$3)",
          [id(0x900), scope.brandReference, from, until],
        );
        await admin.query(
          "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
          [id(0x901), id(0x900), membership, id(10), scope.brandReference, from, until],
        );
        let n = 0x910;
        for (const action of ["catalog.manage", "catalog.tax-classification.read"]) {
          let permission = (
            await admin.query(
              "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
              [action],
            )
          ).rows[0]?.permission_id;
          if (!permission) {
            permission = id(n++);
            await admin.query(
              "INSERT INTO bop_permission.permission_definition VALUES ($1,$2,'Active',1,$3,$3)",
              [permission, action, from],
            );
          }
          await admin.query(
            "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
            [id(n++), id(0x900), permission, scope.brandReference, from, until],
          );
        }
      }
      // Before the store_setup_draft_* api grants this read failed as 503 (permission denied for
      // table store_setup_draft_revision behind STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE).
      const value = await read(owner);
      assert.equal(value.profile, "StoreSetupWorkspaceV1");
      assert.equal(value.store.storeReference, scope.storeReference);
      assert.equal(value.scope.actorReference, id(10));
      assert.equal(value.setup.snapshot, null);

      // Store setup sub-reads. Before the WP-2423 Q15/Q16 additions each failed as 503 on a
      // missing api grant (permission denied for table store_setup_reference_version,
      // store_payment_configuration_version, digital_receipt_template_draft_revision,
      // digital_receipt_template_artifact_version, product_tax_classification_registry_record).
      const ports = (session) => ({
        persistence: session.persistence,
        authentication: session.authentication,
        nextReference: () => id(next++),
      });
      const input = {
        sessionCookie: owner.sessionCookie,
        expectedStoreReference: scope.storeReference,
      };
      const references = await createMerchantStoreSetupReferences(ports(owner)).read(input);
      assert.equal(references.profile, "StoreSetupReferencesCurrentV1");
      assert.equal(references.address, null);
      assert.equal(references.contact, null);
      const payment = await createMerchantStorePaymentConfiguration(ports(owner)).read(input);
      assert.equal(payment.profile, "StorePaymentConfigurationCurrentV1");
      assert.equal(payment.snapshot, null);
      const drafts = await createMerchantReceiptTemplateDraft(ports(owner)).list({
        ...input,
        afterTemplate: null,
      });
      assert.equal(drafts.profile, "DigitalReceiptTemplateDraftRosterV1");
      assert.deepEqual(drafts.entries, []);
      const artifacts = await createMerchantReceiptTemplateArtifacts(ports(owner)).read(input);
      assert.equal(artifacts.profile, "DigitalReceiptTemplateArtifactsCurrentV1");
      assert.equal(artifacts.layout, null);
      assert.equal(artifacts.compliance, null);
      // No Brand tax classifications yet: a plain answer (404 in the BFF), not an outage.
      await assert.rejects(
        setupFor(owner).classifications(input),
        (error) =>
          error instanceof StoreSetupOperationError &&
          error.code === "STORE_SETUP_OPERATION_CLASSIFICATIONS_NOT_REGISTERED",
      );

      // The same reads through the pilot merchant BFF composition. On v15 both answered 503: the
      // pilot composed no storeSetupClock (step 5) and no Store configuration publication (step 8).
      {
        const app = express();
        app.use(
          "/merchant",
          createMerchantBffRouter({
            service: owner.authentication,
            exactOrigin: "https://merchant.invalid",
            acceptedHost: "merchant.invalid",
            ...createInternalStoreSetupBff({
              persistence: owner.persistence,
              authentication: owner.authentication,
              nextReference: () => id(next++),
            }),
          }),
        );
        const server = app.listen(0, "127.0.0.1");
        try {
          await new Promise((resolve) => server.once("listening", resolve));
          const get = (path) =>
            new Promise((resolve, reject) => {
              const outgoing = httpRequest(
                new URL(path, "http://127.0.0.1:" + server.address().port),
                {
                  headers: {
                    host: "merchant.invalid",
                    origin: "https://merchant.invalid",
                    "sec-fetch-site": "same-origin",
                    cookie: "__Host-bop-merchant=" + owner.sessionCookie,
                    "x-bop-store-setup-scope": Buffer.from(
                      JSON.stringify({ ...scope, actorReference: id(10) }),
                    ).toString("base64url"),
                  },
                },
                (response) => {
                  const chunks = [];
                  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                  response.once("error", reject);
                  response.once("end", () =>
                    resolve({
                      status: response.statusCode,
                      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    }),
                  );
                },
              );
              outgoing.once("error", reject);
              outgoing.end();
            });
          assert.deepEqual(
            await get(
              "/merchant/store-setup/fee-context-classifications?storeReference=" +
                scope.storeReference,
            ),
            { status: 404, body: { error: "store_setup_classifications_not_registered" } },
          );
          assert.deepEqual(
            await get(
              "/merchant/store-configuration/ordinary?expectedStoreReference=" +
                scope.storeReference,
            ),
            { status: 404, body: { error: "store_configuration_publication_not_offered" } },
          );
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }

      // Step 7: the Owner saves the Store contact and reads it back.
      const contact = {
        contactName: "Synthetic Store contact",
        businessPhone: "+14165550100",
        website: "https://example.invalid/",
      };
      await createMerchantStoreSetupReferences(ports(owner)).write({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        expectedScope: { ...scope, actorReference: id(10) },
        kind: "Contact",
        command: {
          command: "SaveReference",
          operationReference: id(41),
          expectedReference: null,
          expectedRevision: 0,
          content: contact,
        },
      });
      const savedReferences = await createMerchantStoreSetupReferences(ports(owner)).read(input);
      assert.equal(savedReferences.contact.revision, 1);
      assert.deepEqual(savedReferences.contact.content, contact);

      // The Owner saves a draft on the same page and reads it back.
      const content = {
        ...createUnconfiguredStoreSetupDraftContent(),
        timeZone: { state: "Configured", value: "America/Toronto" },
      };
      const saved = await setupFor(owner).write({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        expectedScope: { ...scope, actorReference: id(10) },
        command: {
          command: "SaveDraft",
          operationReference: id(40),
          expectedSetupReference: null,
          expectedRevision: 0,
          content,
        },
      });
      assert.equal(saved.snapshot.revision, 1);
      const reread = await read(owner);
      assert.equal(reread.setup.snapshot.revision, 1);
      assert.deepEqual(reread.setup.snapshot.content, content);

      const manager = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: id(11),
        at: now(),
        referencePrefix: "01909969",
        sessionReferencePrefix: "01909966",
      });
      await assert.rejects(
        read(manager),
        (error) =>
          error instanceof StoreSetupOperationError &&
          error.code === "STORE_SETUP_OPERATION_PERMISSION_DENIED",
      );
    } finally {
      vi.unstubAllEnvs();
      await admin.end();
    }
  });
});

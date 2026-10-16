import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createCurrentStoreCapabilityService,
  createEmptyStoreCapabilityDependencySource,
  createPostgresFeatureControlAdministrationQueryStore,
  createPricingStoreCapabilityBindings,
} from "../../bop/feature-control/src/index.ts";
import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

/** WP-2423 (v15 run 2026-10-16): every staff session read evaluates the Store capability of
 * the Tax page through the owning Feature Control read. The pilot api role had no schema
 * USAGE, so Postgres logged 42501 on each read. The evaluation runs as a NOBYPASSRLS role holding
 * the rendered pilot runtime ACL (docs/spec/pilot-acl-*.json): read only, forced RLS. */
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-16T21:40:00.000Z";

/** The pilot runtime ACL (matrix plus Owner-approved additions) rendered by the pilot tooling,
 * optionally without this fix's Feature Control entries (the v15 state before the grant). */
async function pilotAcl({ withFeatureControlRead }) {
  const [matrix, additions] = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(path.join(root, "docs/spec", file), "utf8")),
    ),
  );
  const feature = (entry) => entry.schema === "bop_feature_control";
  assert.equal(matrix.entries.filter(feature).length, 0);
  const entries = additions.entries.filter(feature);
  // Minimal: schema USAGE plus SELECT on the two tables the owning read uses. No writes,
  // no operation history, no kill switch.
  assert.deepEqual(
    entries.map((entry) => [entry.principal, entry.type, entry.object, entry.privilege]).sort(),
    [
      ["api", "schema", null, "USAGE"],
      ["api", "table", "control_dependency", "SELECT"],
      ["api", "table", "control_version", "SELECT"],
    ],
  );
  for (const entry of entries)
    assert.match(entry.approval, /^Owner standing approval 2026-10-14 \(WP-2423 /u);
  return [
    matrix,
    withFeatureControlRead
      ? additions
      : { ...additions, entries: additions.entries.filter((entry) => !feature(entry)) },
  ];
}

function tenantContext(brandReference, storeReference) {
  const actor = {
    actorType: "User",
    accountKind: "Workforce",
    actorReference: id(8),
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: at,
    recentMfaAt: null,
  };
  const brand = createBrand({
    brandReference,
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference,
    brandReference,
    code: "SYNTHETIC",
    displayName: "Synthetic Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  return createTenantContext(actor, brand, store, at);
}

/** The Tax capability evaluation the api runs on each session read, as the restricted role. */
async function evaluateTaxCapability(context, role, brandReference, storeReference, failures) {
  const runner = {
    async run(work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await work({
          async query(sql, values) {
            try {
              return await client.query(sql, [...values]);
            } catch (error) {
              failures.push(error.code);
              throw error;
            }
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const scope = { brandReference, storeReference };
  const definitions = createPostgresFeatureControlAdministrationQueryStore(runner, scope, {
    async withAuthorizedDefinitionsScope(input, work) {
      assert.equal(input.purposeCode, "STORE_CAPABILITY_EVALUATION");
      assert.equal(input.key, "pricing.taxconfig.authoring");
      return work();
    },
  });
  const service = createCurrentStoreCapabilityService(
    {
      clock: { now: () => at },
      bindings: createPricingStoreCapabilityBindings(),
      dependencies: createEmptyStoreCapabilityDependencySource(),
      definitions,
      authority: {
        async withCurrentStoreScope(_input, work) {
          return work(tenantContext(brandReference, storeReference));
        },
      },
    },
    scope,
  );
  return service.withCurrentCapability("pricing.tax_config", async (decision) => decision);
}

async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2423_fc_${context.runId}`,
    before = `wp2423_fcb_${context.runId}`,
    roles = [role, role + "_w", before, before + "_w"];
  await admin.connect();
  try {
    for (const name of roles)
      await admin.query(
        `CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    await admin.query(
      renderPilotAclSql(await pilotAcl({ withFeatureControlRead: false }), {
        api: before,
        worker: before + "_w",
      }),
    );
    await admin.query(
      renderPilotAclSql(await pilotAcl({ withFeatureControlRead: true }), {
        api: role,
        worker: role + "_w",
      }),
    );

    // Defect (v15 before the grant): the evaluation fails on the schema, every session read.
    const refused = [];
    await assert.rejects(evaluateTaxCapability(context, before, id(2), id(3), refused));
    assert.deepEqual(refused, ["42501"]);

    // The pilot has no Feature Control rows: the decision is a clean, fail-closed Unavailable.
    const empty = [];
    const unavailable = await evaluateTaxCapability(context, role, id(2), id(3), empty);
    assert.deepEqual(empty, []);
    assert.equal(unavailable.reason, "Unavailable");
    assert.equal(unavailable.backendExecution, "Deny");
    assert.equal(unavailable.frontendVisibility, "Hide");

    // A published Brand definition is read through forced RLS for its own Brand only.
    await admin.query(
      `INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,'pricing.taxconfig.authoring',1,'Synthetic tax authoring',$3,'TAX_CONFIG','BrandOverride','Disabled','Enabled','Published',false,$4,NULL,$5,NULL,$6,$7,$8,$9,$4,'ConfigurationMetadata')`,
      [
        id(1),
        id(2),
        id(4),
        "2026-10-01T00:00:00.000Z",
        "2026-12-01T00:00:00.000Z",
        id(5),
        id(6),
        id(7),
        id(9),
      ],
    );
    const enabled = await evaluateTaxCapability(context, role, id(2), id(3), []);
    assert.equal(enabled.reason, "Enabled");
    assert.equal(enabled.controlReference, id(1));
    const otherBrand = await evaluateTaxCapability(context, role, id(20), id(30), []);
    assert.equal(otherBrand.reason, "Unavailable");

    // Read only: the api role cannot write definitions or read operation history.
    const privileges = (
      await admin.query(
        `SELECT has_table_privilege($1,'bop_feature_control.control_version','INSERT') AS version_insert,
                has_table_privilege($1,'bop_feature_control.control_dependency','INSERT') AS dependency_insert,
                has_table_privilege($1,'bop_feature_control.control_operation','SELECT') AS operation_select,
                has_table_privilege($1,'bop_feature_control.kill_switch_version','SELECT') AS kill_switch_select`,
        [role],
      )
    ).rows[0];
    assert.deepEqual(privileges, {
      version_insert: false,
      dependency_insert: false,
      operation_select: false,
      kill_switch_select: false,
    });
  } finally {
    for (const name of roles) {
      await admin.query(`DROP OWNED BY ${name}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
    }
    await admin.end();
  }
}

it("lets the pilot api role evaluate Store capabilities with a read-only Feature Control grant", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_fc_read", root }, prove);
}, 180_000);

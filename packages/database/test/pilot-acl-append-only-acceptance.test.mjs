import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import pg from "pg";
import { it } from "vitest";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

/**
 * WP-2423 (open item 2026-10-07): the rendered pilot ACL gives the api and worker roles no
 * UPDATE, DELETE or TRUNCATE on an append-only table, except the documented allow-list (entries
 * carrying a `justification`). Append-only means: classified `append-only-record` in a module's
 * database-access manifest, the platform audit history, or a table whose BEFORE UPDATE trigger
 * rejects every UPDATE. Run against every migration with restricted NOBYPASSRLS roles.
 */
const repository = new URL("../../../", import.meta.url);
const mutating = ["UPDATE", "DELETE", "TRUNCATE"];
const platformAppendOnly = [
  "platform_audit.audit_record",
  "platform_audit.platform_actor_audit_record",
];

async function manifestAppendOnlyTables() {
  const tables = new Set();
  for (const layer of ["packages/bop", "packages/rms"]) {
    const root = fileURLToPath(new URL(layer + "/", repository));
    for (const name of await readdir(root)) {
      const base = path.join(root, name, "src");
      const access = path.join(base, "infrastructure/persistence/database-access.manifest.ts");
      const owned = await import(pathToFileURL(path.join(base, "module.manifest.ts")).href).catch(
        () => null,
      );
      const manifest = await import(pathToFileURL(access).href).catch(() => null);
      const schema = owned?.moduleManifest?.ownedDatabase?.schema;
      if (!manifest || !schema) continue;
      for (const table of (manifest.default ?? manifest.databaseAccessManifest).tables)
        if (table.classification === "append-only-record") tables.add(`${schema}.${table.table}`);
    }
  }
  assert.ok(tables.size > 100, "manifest append-only tables were not discovered");
  return tables;
}

// A BEFORE UPDATE row trigger without WHEN whose function only raises, or raises for any
// operation other than INSERT, makes the table append-only regardless of its classification.
const triggerAppendOnlySql = `SELECT DISTINCT n.nspname||'.'||c.relname AS name
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE NOT t.tgisinternal AND t.tgqual IS NULL AND (t.tgtype & 1)=1 AND (t.tgtype & 2)=2
    AND (t.tgtype & 16)=16
    AND (p.prosrc ~* '^\\s*BEGIN\\s+RAISE\\s+EXCEPTION[^;]*;\\s*END;?\\s*$'
      OR p.prosrc ~* 'BEGIN\\s+IF\\s+TG_OP\\s*<>\\s*''INSERT''\\s+THEN\\s+RAISE')`;

async function renderedAcl(admin, runId) {
  const roles = { api: "wp2423_aoa_" + runId, worker: "wp2423_aow_" + runId };
  for (const name of Object.values(roles))
    await admin.query(
      "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
    );
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
      JSON.parse(await readFile(new URL("docs/spec/" + file, repository), "utf8")),
    ),
  );
  await admin.query(renderPilotAclSql(matrices, roles));
  return { roles, entries: matrices.flatMap((matrix) => matrix.entries) };
}

it("gives the pilot api and worker roles no data-changing privilege on append-only tables beyond the justified allow-list", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_acl_append" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const { roles, entries } = await renderedAcl(admin, context.runId);
    try {
      const appendOnly = await manifestAppendOnlyTables();
      for (const name of platformAppendOnly) appendOnly.add(name);
      const fromTriggers = (await admin.query(triggerAppendOnlySql)).rows.map((row) => row.name);
      assert.ok(fromTriggers.includes("rms_inventory.stock_reservation_version"));
      for (const name of fromTriggers) appendOnly.add(name);
      const existing = new Set(
        (
          await admin.query(
            "SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')",
          )
        ).rows.map((row) => row.name),
      );
      const tables = [...appendOnly].filter((name) => existing.has(name)).sort();
      assert.ok(tables.length > 150, "append-only tables were not found in the migrated schema");

      const allowed = new Set();
      for (const entry of entries)
        if (
          entry.revoke !== true &&
          mutating.includes(entry.privilege) &&
          appendOnly.has(`${entry.schema}.${entry.object}`)
        ) {
          const key = `${entry.principal}|${entry.schema}.${entry.object}|${entry.column ?? ""}|${entry.privilege}`;
          assert.equal(
            typeof entry.justification === "string" && entry.justification.length > 20,
            true,
            `${key} keeps a data-changing privilege on an append-only table without a justification`,
          );
          allowed.add(key);
        }

      const held = [];
      for (const [principal, role] of Object.entries(roles)) {
        const { rows } = await admin.query(
          `SELECT t.name, p.privilege, NULL::text AS column_name FROM unnest($2::text[]) t(name)
             CROSS JOIN unnest($3::text[]) p(privilege)
             WHERE has_table_privilege($1, t.name, p.privilege)
           UNION ALL
           SELECT t.name, 'UPDATE', a.attname FROM unnest($2::text[]) t(name)
             JOIN pg_attribute a ON a.attrelid=t.name::regclass AND a.attnum>0 AND NOT a.attisdropped
             WHERE NOT has_table_privilege($1, t.name, 'UPDATE')
               AND has_column_privilege($1, t.name, a.attname, 'UPDATE')`,
          [role, tables, mutating],
        );
        for (const row of rows)
          held.push(`${principal}|${row.name}|${row.column_name ?? ""}|${row.privilege}`);
      }
      const unexpected = held.filter((key) => !allowed.has(key)).sort();
      assert.deepEqual(unexpected, [], "append-only tables with unjustified data-changing grants");
      assert.deepEqual(
        [...allowed].filter((key) => !held.includes(key)).sort(),
        [],
        "justified allow-list entries that the rendered ACL does not hold",
      );
      assert.ok(held.length < 15, "the allow-list stays small: " + held.join(", "));

      // What the api can and cannot do with the narrowed grants (WHERE false: privileges only).
      const api = new pg.Client(context.clientConfig);
      await api.connect();
      const attempt = async (sql) => {
        await api.query("BEGIN");
        try {
          await api.query("SET LOCAL ROLE " + roles.api);
          await api.query(sql);
          return "ok";
        } catch (error) {
          return error.code;
        } finally {
          await api.query("ROLLBACK");
        }
      };
      try {
        for (const [sql, expected] of [
          ["UPDATE platform_audit.audit_record SET reason_code=reason_code WHERE false", "42501"],
          // kitchen_creation_record's DO INSTEAD NOTHING rules hide the privilege check; its
          // UPDATE/DELETE withdrawal is asserted by the catalog check above.
          ["DELETE FROM platform_audit.audit_record WHERE false", "42501"],
          [
            "UPDATE rms_inventory.stock_reservation_version SET store_id=store_id WHERE false",
            "42501",
          ],
          [
            "UPDATE rms_store.store_configuration_version SET store_id=store_id WHERE false",
            "42501",
          ],
          [
            "UPDATE bop_permission.permission_definition SET lifecycle=lifecycle WHERE false",
            "42501",
          ],
          ["UPDATE rms_fulfillment.capacity_slot SET store_id=store_id WHERE false", "42501"],
          ["UPDATE platform_audit.audit_chain_head SET brand_id=brand_id WHERE false", "42501"],
          ["TRUNCATE platform_audit.audit_record", "42501"],
          ["LOCK TABLE rms_store.store_configuration_version IN SHARE MODE", "ok"],
          [
            "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
            "ok",
          ],
          ["SELECT slot_id FROM rms_fulfillment.capacity_slot WHERE false FOR UPDATE", "ok"],
          ["SELECT item_id FROM rms_inventory.inventory_item WHERE false FOR KEY SHARE", "ok"],
          [
            "SELECT permission_id FROM bop_permission.permission_definition WHERE false FOR SHARE",
            "ok",
          ],
          [
            "UPDATE platform_audit.audit_chain_head SET next_sequence=next_sequence WHERE false",
            "ok",
          ],
        ])
          assert.equal(await attempt(sql), expected, sql);
      } finally {
        await api.end();
      }
    } finally {
      for (const name of Object.values(roles)) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

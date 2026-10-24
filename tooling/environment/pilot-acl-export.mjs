import console from "node:console";
import process from "node:process";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createApplicationDatabase } from "./pilot-connections.mjs";

// Read-only catalog queries. Every row names the grantee role; roles are mapped to principal classes.
const queries = {
  schema: `SELECT n.nspname AS schema, NULL AS object, NULL AS column_name, a.privilege_type AS privilege, r.rolname AS grantee
    FROM pg_namespace n, aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = ANY($1)`,
  relation: `SELECT n.nspname AS schema, c.relname AS object, NULL AS column_name, a.privilege_type AS privilege, r.rolname AS grantee,
      c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = ANY($1)`,
  column: `SELECT n.nspname AS schema, c.relname AS object, t.attname AS column_name, a.privilege_type AS privilege, r.rolname AS grantee
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
      aclexplode(t.attacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = ANY($1) AND t.attnum > 0 AND NOT t.attisdropped`,
  routine: `SELECT n.nspname AS schema, p.oid::regprocedure::text AS object, NULL AS column_name, a.privilege_type AS privilege, r.rolname AS grantee
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE r.rolname = ANY($1) AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  membership: `SELECT NULL AS schema, g.rolname AS object, NULL AS column_name, 'MEMBER' AS privilege, m.rolname AS grantee
    FROM pg_auth_members x JOIN pg_roles g ON g.oid = x.roleid JOIN pg_roles m ON m.oid = x.member
    WHERE m.rolname = ANY($1)`,
};

const kinds = { r: "table", p: "table", v: "view", m: "view", S: "sequence", f: "table" };

/** Maps installation role names to principal classes and returns a stable, role-neutral matrix. */
export function normalizePilotAcl(rowsByType, roles) {
  const principal = new Map([
    [roles.api, "api"],
    [roles.worker, "worker"],
  ]);
  const entries = [];
  for (const [type, rows] of Object.entries(rowsByType))
    for (const row of rows) {
      const grantee = principal.get(row.grantee);
      if (!grantee) throw Error("PILOT_ACL_EXPORT_UNKNOWN_GRANTEE");
      if (type === "membership" && Object.values(roles).includes(row.object))
        throw Error("PILOT_ACL_EXPORT_ROLE_CHAIN");
      entries.push({
        type: type === "relation" ? (kinds[row.kind] ?? "relation") : type,
        schema: row.schema ?? null,
        object: row.object ?? null,
        column: row.column_name ?? null,
        privilege: row.privilege,
        principal: grantee,
      });
    }
  const key = (e) =>
    [e.principal, e.type, e.schema, e.object, e.column, e.privilege].map(String).join("\u0000");
  entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { schemaVersion: 1, entries };
}

export async function exportPilotAcl(directory) {
  const installation = await loadPilotInstallation(directory);
  const roles = {
    api: installation.connection.user("api"),
    worker: installation.connection.user("worker"),
  };
  const database = await createApplicationDatabase("api", installation.connection);
  try {
    const client = await database.acquire();
    try {
      await client.query("BEGIN READ ONLY");
      const rowsByType = {};
      for (const [type, sql] of Object.entries(queries))
        rowsByType[type] = (await client.query(sql, [[roles.api, roles.worker]])).rows;
      await client.query("ROLLBACK");
      return normalizePilotAcl(rowsByType, roles);
    } finally {
      client.release();
    }
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [runtime, output] = process.argv.slice(2);
    if (!output || !/^[a-z0-9_./-]+\.json$/u.test(output)) throw Error("PILOT_ACL_EXPORT_USAGE");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const matrix = await exportPilotAcl(path.join(root, parsePilotRuntimeDirectory(runtime)));
    await writeFile(path.join(root, output), `${JSON.stringify(matrix, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`PILOT_ACL_EXPORTED entries=${matrix.entries.length}`);
  } catch (error) {
    console.error(
      error instanceof Error && /^PILOT_ACL/u.test(error.message)
        ? error.message
        : "PILOT_ACL_EXPORT_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}

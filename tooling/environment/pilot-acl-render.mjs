import console from "node:console";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pilotApiRoleConnectionLimit } from "./pilot-connection-budget.mjs";

// WP-2423 P3: render the role-neutral pilot runtime ACL (exported v14 matrix plus Owner-approved
// additions) as GRANT SQL for one installation's api/worker role names. Least privilege only:
// no schema-wide or future grants, and no role names in migrations (Section 95.4).
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
// Argument types may be schema-qualified (e.g. platform_helpers.uuid_v7 domains) or one of
// PostgreSQL's fixed multi-word type names (e.g. timestamp with time zone).
const multiWordType =
  "(?:timestamp with(?:out)? time zone|time with(?:out)? time zone|double precision|character varying|bit varying)";
const argumentType = `(?:${multiWordType}|[a-z_][a-z0-9_]{0,62}(?:\\.[a-z_][a-z0-9_]{0,62})?)`;
const routine = new RegExp(
  `^[a-z_][a-z0-9_]{0,62}\\.[a-z_][a-z0-9_]{0,62}\\((?:${argumentType}(?:, ?(?=[a-z_]))?)*\\)$`,
  "u",
);
const privileges = {
  schema: ["USAGE"],
  table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"],
  view: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  sequence: ["USAGE", "SELECT", "UPDATE"],
  column: ["SELECT", "INSERT", "UPDATE", "REFERENCES"],
  routine: ["EXECUTE"],
};
const invalid = () => {
  throw new Error("PILOT_ACL_RENDER_INVALID");
};
const quote = (value) => (identifier.test(value) ? '"' + value + '"' : invalid());

export function renderPilotAclSql(matrices, roles) {
  if (
    !roles ||
    !identifier.test(roles.api ?? "") ||
    !identifier.test(roles.worker ?? "") ||
    roles.api === roles.worker
  )
    invalid();
  const statements = new Set();
  for (const matrix of matrices) {
    if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.entries)) invalid();
    for (const entry of matrix.entries) {
      const grantee = quote(roles[entry.principal] ?? invalid());
      if (!privileges[entry.type]?.includes(entry.privilege)) invalid();
      const schema = quote(entry.schema);
      if (entry.type === "schema") statements.add(`GRANT USAGE ON SCHEMA ${schema} TO ${grantee};`);
      else if (entry.type === "routine") {
        if (!routine.test(entry.object) || !entry.object.startsWith(entry.schema + ".")) invalid();
        statements.add(`GRANT EXECUTE ON FUNCTION ${entry.object} TO ${grantee};`);
      } else if (entry.type === "column")
        statements.add(
          `GRANT ${entry.privilege} (${quote(entry.column)}) ON TABLE ${schema}.${quote(entry.object)} TO ${grantee};`,
        );
      else
        statements.add(
          `GRANT ${entry.privilege} ON ${entry.type === "sequence" ? "SEQUENCE" : "TABLE"} ${schema}.${quote(entry.object)} TO ${grantee};`,
        );
    }
  }
  // WP-2423: every supervised service's pool must fit the api role at once (pilot-connections).
  const roleSettings = `ALTER ROLE ${quote(roles.api)} CONNECTION LIMIT ${pilotApiRoleConnectionLimit};`;
  return "BEGIN;\n" + [...statements].sort().join("\n") + "\n" + roleSettings + "\nCOMMIT;\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [apiRole, workerRole, ...files] = process.argv.slice(2);
    if (files.length === 0) invalid();
    const matrices = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(file, "utf8"))),
    );
    process.stdout.write(renderPilotAclSql(matrices, { api: apiRole, worker: workerRole }));
  } catch {
    console.error("PILOT_ACL_RENDER_INVALID");
    process.exitCode = 1;
  }
}

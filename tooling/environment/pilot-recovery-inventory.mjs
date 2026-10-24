import { createHash } from "node:crypto";
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
export async function inventory(client) {
  const tables = (
    await client.query(
      "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY 1,2",
    )
  ).rows;
  const out = {};
  for (const t of tables) {
    out[t.schema + "." + t.name] = (
      await client.query(
        "SELECT count(*)::text AS count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM " +
          quote(t.schema) +
          "." +
          quote(t.name) +
          " t",
      )
    ).rows[0];
  }
  return out;
}
export function sqliteInventory(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const out = {};
  for (const { name } of tables) {
    const stmt = db.prepare("SELECT * FROM " + quote(name));
    stmt.setReadBigInts(true);
    const rows = stmt
      .all()
      .map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
      .sort();
    out[name] = {
      count: rows.length,
      digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }
  return out;
}

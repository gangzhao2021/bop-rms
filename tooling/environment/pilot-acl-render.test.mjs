import { describe, expect, it } from "vitest";
import { renderPilotAclSql } from "./pilot-acl-render.mjs";

const roles = { api: "pilot_api", worker: "pilot_worker" };
const matrix = (entries) => ({ schemaVersion: 1, entries });
const entry = (type, schema, object, privilege, principal = "api", column = null) => ({
  type,
  schema,
  object,
  column,
  privilege,
  principal,
});

describe("renderPilotAclSql", () => {
  it("renders exact object, column and routine grants in one transaction", () => {
    const sql = renderPilotAclSql(
      [
        matrix([
          entry("schema", "rms_kitchen", null, "USAGE"),
          entry("table", "rms_kitchen", "kitchen_ticket", "SELECT", "worker"),
          entry("column", "bop_identity", "guest_session", "UPDATE", "api", "revoked_at"),
          entry("routine", "platform_helpers", "platform_helpers.current_store_id()", "EXECUTE"),
        ]),
        matrix([entry("table", "rms_kitchen", "kitchen_ticket", "SELECT", "worker")]),
      ],
      roles,
    );
    expect(sql.split("\n")).toEqual([
      "BEGIN;",
      'GRANT EXECUTE ON FUNCTION platform_helpers.current_store_id() TO "pilot_api";',
      'GRANT SELECT ON TABLE "rms_kitchen"."kitchen_ticket" TO "pilot_worker";',
      'GRANT UPDATE ("revoked_at") ON TABLE "bop_identity"."guest_session" TO "pilot_api";',
      'GRANT USAGE ON SCHEMA "rms_kitchen" TO "pilot_api";',
      // WP-2423: all supervised pools (7 x 5) plus operator headroom fit the api role at once.
      'ALTER ROLE "pilot_api" CONNECTION LIMIT 45;',
      "COMMIT;",
      "",
    ]);
  });
  it.each([
    ["an unknown principal", entry("table", "s", "t", "SELECT", "owner")],
    ["a schema-wide privilege", entry("schema", "s", null, "CREATE")],
    ["an injected identifier", entry("table", "s", 't"; DROP TABLE x; --', "SELECT")],
    ["a routine outside its schema", entry("routine", "s", "other.f()", "EXECUTE")],
    ["ALL privileges", entry("table", "s", "t", "ALL")],
    ["an injected argument type", entry("routine", "s", "s.f(uuid); DROP TABLE x)", "EXECUTE")],
    ["a dangling argument separator", entry("routine", "s", "s.f(uuid,)", "EXECUTE")],
  ])("rejects %s", (_name, bad) => {
    expect(() => renderPilotAclSql([matrix([bad])], roles)).toThrow("PILOT_ACL_RENDER_INVALID");
  });
  it("renders routines whose argument types are schema-qualified domains", () => {
    const sql = renderPilotAclSql(
      [
        matrix([
          entry(
            "routine",
            "rms_pricing",
            "rms_pricing.f(platform_helpers.uuid_v7,platform_helpers.uuid_v7)",
            "EXECUTE",
          ),
        ]),
      ],
      roles,
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION rms_pricing.f(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO "pilot_api";',
    );
  });
  it("WP-2423: renders routines with PostgreSQL multi-word argument types only", () => {
    const object =
      "security.consume_abuse_budget(text,bytea,timestamp with time zone,integer,integer,timestamp with time zone)";
    expect(
      renderPilotAclSql([matrix([entry("routine", "security", object, "EXECUTE")])], roles),
    ).toContain(`GRANT EXECUTE ON FUNCTION ${object} TO "pilot_api";`);
    for (const bad of ["security.f(uuid drop table x)", "security.f(timestamp with zone)"])
      expect(() =>
        renderPilotAclSql([matrix([entry("routine", "security", bad, "EXECUTE")])], roles),
      ).toThrow("PILOT_ACL_RENDER_INVALID");
  });
  it("rejects shared or unsafe role names", () => {
    expect(() => renderPilotAclSql([matrix([])], { api: "x", worker: "x" })).toThrow();
    expect(() => renderPilotAclSql([matrix([])], { api: 'x"', worker: "y" })).toThrow();
  });
});

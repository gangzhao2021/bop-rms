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
  it("rejects shared or unsafe role names", () => {
    expect(() => renderPilotAclSql([matrix([])], { api: "x", worker: "x" })).toThrow();
    expect(() => renderPilotAclSql([matrix([])], { api: 'x"', worker: "y" })).toThrow();
  });
});

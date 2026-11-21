import { describe, expect, it } from "vitest";
import { normalizePilotAcl } from "./pilot-acl-export.mjs";

const roles = { api: "pilot_api_x", worker: "pilot_worker_x" };

describe("normalizePilotAcl", () => {
  it("replaces role names with principal classes and sorts stably", () => {
    const matrix = normalizePilotAcl(
      {
        relation: [
          {
            schema: "rms_order",
            object: "orders",
            privilege: "SELECT",
            grantee: "pilot_worker_x",
            kind: "r",
          },
          {
            schema: "rms_order",
            object: "order_seq",
            privilege: "USAGE",
            grantee: "pilot_api_x",
            kind: "S",
          },
        ],
        column: [
          {
            schema: "bop_identity",
            object: "employee",
            column_name: "actor_id",
            privilege: "UPDATE",
            grantee: "pilot_api_x",
          },
        ],
        schema: [{ schema: "rms_order", privilege: "USAGE", grantee: "pilot_api_x" }],
      },
      roles,
    );
    expect(matrix.schemaVersion).toBe(1);
    expect(
      matrix.entries.map((e) => `${e.principal}:${e.type}:${e.object}:${e.privilege}`),
    ).toEqual([
      "api:column:employee:UPDATE",
      "api:schema:null:USAGE",
      "api:sequence:order_seq:USAGE",
      "worker:table:orders:SELECT",
    ]);
    expect(JSON.stringify(matrix)).not.toContain("pilot_api_x");
  });

  it("refuses grantees outside the installation roles", () => {
    expect(() =>
      normalizePilotAcl(
        { schema: [{ schema: "x", privilege: "USAGE", grantee: "postgres" }] },
        roles,
      ),
    ).toThrow("PILOT_ACL_EXPORT_UNKNOWN_GRANTEE");
  });
});

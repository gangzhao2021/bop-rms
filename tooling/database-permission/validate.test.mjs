import { describe, expect, it } from "vitest";

import { inspectMigrationPermissions } from "./validate.mjs";

const migration = (sql) => [{ relativePath: "migrations/1000-test/1000_001_create_test.sql", sql }];
const valid = `
CREATE SCHEMA rms_test;
REVOKE ALL ON SCHEMA rms_test FROM PUBLIC;
CREATE TABLE rms_test.record (
  record_id uuid PRIMARY KEY,
  brand_id uuid NOT NULL,
  store_id uuid NOT NULL
);
ALTER TABLE rms_test.record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_test.record FORCE ROW LEVEL SECURITY;
CREATE POLICY record_scope ON rms_test.record
USING (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id())
WITH CHECK (brand_id = platform_helpers.current_brand_id() AND store_id = platform_helpers.current_store_id());
REVOKE ALL ON TABLE rms_test.record FROM PUBLIC;
CREATE FUNCTION rms_test.reject_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
REVOKE ALL ON FUNCTION rms_test.reject_update() FROM PUBLIC;
`;

describe("Database Permission Migration Test", () => {
  it("accepts a forced, scoped and PUBLIC-revoked Tenant table", () => {
    expect(inspectMigrationPermissions(migration(valid))).toEqual([]);
  });

  it.each([
    ["SCHEMA_PUBLIC_NOT_REVOKED", "REVOKE ALL ON SCHEMA rms_test FROM PUBLIC;"],
    ["RLS_NOT_ENABLED", "ALTER TABLE rms_test.record ENABLE ROW LEVEL SECURITY;"],
    ["RLS_NOT_FORCED", "ALTER TABLE rms_test.record FORCE ROW LEVEL SECURITY;"],
    ["RLS_POLICY_MISSING", /CREATE POLICY[\s\S]*?current_store_id\(\)\);/u],
    ["TABLE_PUBLIC_NOT_REVOKED", "REVOKE ALL ON TABLE rms_test.record FROM PUBLIC;"],
    ["FUNCTION_PUBLIC_NOT_REVOKED", "REVOKE ALL ON FUNCTION rms_test.reject_update() FROM PUBLIC;"],
  ])("rejects %s", (code, removed) => {
    const sql =
      typeof removed === "string" ? valid.replace(removed, "") : valid.replace(removed, "");
    expect(inspectMigrationPermissions(migration(sql)).map((item) => item.code)).toContain(code);
  });

  it("rejects missing Store scope, unconditional policies, PUBLIC grants and RLS weakening", () => {
    const unsafe = valid
      .replaceAll("store_id = platform_helpers.current_store_id()", "true")
      .concat(
        "CREATE POLICY record_open ON rms_test.record USING (true) WITH CHECK (true);\n",
        "GRANT SELECT ON TABLE rms_test.record TO PUBLIC;\n",
        "ALTER TABLE rms_test.record DISABLE ROW LEVEL SECURITY;\n",
      );
    const codes = inspectMigrationPermissions(migration(unsafe)).map((item) => item.code);
    expect(codes).toContain("RLS_STORE_SCOPE_MISSING");
    expect(codes).toContain("RLS_POLICY_OPEN");
    expect(codes).toContain("PUBLIC_GRANT");
    expect(codes).toContain("RLS_WEAKENED");
  });
});

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

  it("accepts PostgreSQL table REVOKE with the optional TABLE keyword omitted", () => {
    expect(
      inspectMigrationPermissions(
        migration(
          valid.replace(
            "REVOKE ALL ON TABLE rms_test.record FROM PUBLIC;",
            "REVOKE ALL ON rms_test.record FROM PUBLIC;",
          ),
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    "REVOKE ALL ON SCHEMA rms_test.record FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION rms_test.record() FROM PUBLIC;",
    "REVOKE SELECT ON rms_test.record FROM PUBLIC;",
    "REVOKE ALL ON rms_test.other FROM PUBLIC;",
  ])("does not accept a different REVOKE as the table revoke: %s", (replacement) => {
    expect(
      inspectMigrationPermissions(
        migration(valid.replace("REVOKE ALL ON TABLE rms_test.record FROM PUBLIC;", replacement)),
      ).map((d) => d.code),
    ).toContain("TABLE_PUBLIC_NOT_REVOKED");
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

const identityPredicate =
  "session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid";
const identitySelection = [
  "CREATE SCHEMA bop_identity;",
  "REVOKE ALL ON SCHEMA bop_identity FROM PUBLIC;",
  "CREATE TABLE bop_identity.browser_session_selection (",
  "  session_id uuid PRIMARY KEY, actor_id uuid NOT NULL, brand_id uuid NOT NULL, store_id uuid NOT NULL,",
  "  FOREIGN KEY (session_id, actor_id) REFERENCES bop_identity.authentication_session (session_id, actor_id)",
  ");",
  "ALTER TABLE bop_identity.browser_session_selection ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE bop_identity.browser_session_selection FORCE ROW LEVEL SECURITY;",
  "CREATE POLICY browser_session_selection_current_session ON bop_identity.browser_session_selection",
  "USING (" + identityPredicate + ") WITH CHECK (" + identityPredicate + ");",
  "REVOKE ALL ON TABLE bop_identity.browser_session_selection FROM PUBLIC;",
].join("\n");

describe("pre-Tenant Identity selection isolation", () => {
  it("requires a forced session-and-Actor policy instead of self-authorizing selected Brand/Store", () => {
    expect(inspectMigrationPermissions(migration(identitySelection))).toEqual([]);
  });
  it.each([
    [
      "session",
      (sql) =>
        sql.replaceAll(
          "session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid",
          "true",
        ),
    ],
    [
      "actor",
      (sql) =>
        sql.replaceAll(
          "actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid",
          "true",
        ),
    ],
    ["check", (sql) => sql.replace("WITH CHECK (" + identityPredicate + ")", "WITH CHECK (true)")],
    [
      "extra policy",
      (sql) =>
        sql + "\nCREATE POLICY another ON bop_identity.browser_session_selection USING (true);",
    ],
    [
      "parent binding",
      (sql) =>
        sql.replace(
          "REFERENCES bop_identity.authentication_session (session_id, actor_id)",
          "REFERENCES bop_identity.authentication_session (session_id)",
        ),
    ],
  ])("rejects a weakened %s", (_case, mutate) => {
    expect(
      inspectMigrationPermissions(migration(mutate(identitySelection))).map((d) => d.code),
    ).toContain("RLS_IDENTITY_SESSION_SCOPE_INVALID");
  });
  it.each([
    [
      "RLS_NOT_ENABLED",
      "ALTER TABLE bop_identity.browser_session_selection ENABLE ROW LEVEL SECURITY;",
    ],
    [
      "RLS_NOT_FORCED",
      "ALTER TABLE bop_identity.browser_session_selection FORCE ROW LEVEL SECURITY;",
    ],
    [
      "TABLE_PUBLIC_NOT_REVOKED",
      "REVOKE ALL ON TABLE bop_identity.browser_session_selection FROM PUBLIC;",
    ],
  ])("retains %s for the pre-Tenant table", (code, removed) => {
    expect(
      inspectMigrationPermissions(migration(identitySelection.replace(removed, ""))).map(
        (d) => d.code,
      ),
    ).toContain(code);
  });
  it("does not exempt other Identity tables from Brand/Store isolation", () => {
    const codes = inspectMigrationPermissions(
      migration(identitySelection.replaceAll("browser_session_selection", "other_selection")),
    ).map((d) => d.code);
    expect(codes).toContain("RLS_BRAND_SCOPE_MISSING");
    expect(codes).toContain("RLS_STORE_SCOPE_MISSING");
  });
});

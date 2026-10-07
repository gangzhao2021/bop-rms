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

const brandIdentitySelection = identitySelection
  .replaceAll("browser_session_selection", "browser_brand_session_selection")
  .replace(", store_id uuid NOT NULL", "");
describe("exact Brand-only pre-Tenant selection isolation", () => {
  it("requires the current Session and Actor with the genuine parent binding", () => {
    expect(inspectMigrationPermissions(migration(brandIdentitySelection))).toEqual([]);
  });
  it.each([
    [
      "session",
      (s) =>
        s.replaceAll(
          "session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid",
          "true",
        ),
    ],
    [
      "Actor",
      (s) =>
        s.replaceAll(
          "actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid",
          "true",
        ),
    ],
    ["write", (s) => s.replace("WITH CHECK (" + identityPredicate + ")", "WITH CHECK (true)")],
    [
      "parent",
      (s) =>
        s.replace(
          "REFERENCES bop_identity.authentication_session (session_id, actor_id)",
          "REFERENCES bop_identity.authentication_session (session_id)",
        ),
    ],
    [
      "extra policy",
      (s) =>
        s + "\nCREATE POLICY another ON bop_identity.browser_brand_session_selection USING (true);",
    ],
  ])("rejects weakened %s isolation", (_name, mutate) => {
    expect(
      inspectMigrationPermissions(migration(mutate(brandIdentitySelection))).map((d) => d.code),
    ).toContain("RLS_IDENTITY_SESSION_SCOPE_INVALID");
  });
  it.each([
    [
      "RLS_NOT_ENABLED",
      "ALTER TABLE bop_identity.browser_brand_session_selection ENABLE ROW LEVEL SECURITY;",
    ],
    [
      "RLS_NOT_FORCED",
      "ALTER TABLE bop_identity.browser_brand_session_selection FORCE ROW LEVEL SECURITY;",
    ],
    [
      "TABLE_PUBLIC_NOT_REVOKED",
      "REVOKE ALL ON TABLE bop_identity.browser_brand_session_selection FROM PUBLIC;",
    ],
  ])("retains %s for Brand selection", (code, statement) => {
    expect(
      inspectMigrationPermissions(migration(brandIdentitySelection.replace(statement, ""))).map(
        (d) => d.code,
      ),
    ).toContain(code);
  });
});

const onboardingCall =
  "bop_identity.workforce_onboarding_scope(operator_id,actor_id,brand_id,membership_id,environment,issuer,client_id)";
const onboarding = `
CREATE SCHEMA bop_identity;
REVOKE ALL ON SCHEMA bop_identity FROM PUBLIC;
CREATE TABLE bop_identity.workforce_onboarding_operation (
 operation_id uuid NOT NULL,
 operator_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 brand_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 environment text NOT NULL,
 issuer text NOT NULL,
 client_id text NOT NULL,
 selector_hash text NOT NULL
);
CREATE FUNCTION bop_identity.workforce_onboarding_scope(p_operator uuid,p_actor uuid,p_brand uuid,p_member uuid,p_environment text,p_issuer text,p_client text) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
 SELECT COALESCE(p_operator::text=current_setting('bop.platform_actor_id',true)
 AND current_setting('bop.platform_purpose',true)='WORKFORCE_ONBOARDING'
 AND p_actor::text=current_setting('bop.onboarding_actor_id',true)
 AND p_brand::text=current_setting('bop.onboarding_brand_id',true)
 AND p_member::text=current_setting('bop.onboarding_member_id',true)
 AND p_environment=current_setting('bop.onboarding_environment',true)
 AND p_issuer=current_setting('bop.onboarding_issuer',true)
 AND p_client=current_setting('bop.onboarding_client_id',true),false);
$$;
REVOKE ALL ON FUNCTION bop_identity.workforce_onboarding_scope(uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC;
ALTER TABLE bop_identity.workforce_onboarding_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bop_identity.workforce_onboarding_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY workforce_onboarding_operation_read ON bop_identity.workforce_onboarding_operation FOR SELECT USING(${onboardingCall});
CREATE POLICY workforce_onboarding_operation_insert ON bop_identity.workforce_onboarding_operation FOR INSERT WITH CHECK(${onboardingCall});
CREATE POLICY workforce_onboarding_invitation_read ON bop_identity.workforce_onboarding_operation FOR SELECT USING (
 current_setting('bop.onboarding_invitation_purpose',true)='WORKFORCE_ONBOARDING_INVITATION'
 AND selector_hash=current_setting('bop.onboarding_invitation_selector_hash',true)
 AND environment=current_setting('bop.onboarding_environment',true)
 AND issuer=current_setting('bop.onboarding_issuer',true)
 AND client_id=current_setting('bop.onboarding_client_id',true)
);
REVOKE ALL ON TABLE bop_identity.workforce_onboarding_operation FROM PUBLIC;
`;
describe("exact platform-operated Workforce onboarding isolation", () => {
  it("accepts the closed operator, Actor, Brand, Membership and client scope", () => {
    expect(inspectMigrationPermissions(migration(onboarding))).toEqual([]);
  });
  it.each([
    [
      "Brand binding",
      (s) =>
        s.replace("AND p_brand::text=current_setting('bop.onboarding_brand_id',true)", "AND true"),
    ],
    ["fail-closed default", (s) => s.replace(",false);", ",true);")],
    [
      "read policy",
      (s) => s.replace(`FOR SELECT USING(${onboardingCall})`, "FOR SELECT USING(true)"),
    ],
    [
      "extra policy",
      (s) =>
        s + "\nCREATE POLICY another ON bop_identity.workforce_onboarding_operation USING (true);",
    ],
    [
      "scope redefinition",
      (s) =>
        s +
        "\nCREATE OR REPLACE FUNCTION bop_identity.workforce_onboarding_scope(p_operator uuid,p_actor uuid,p_brand uuid,p_member uuid,p_environment text,p_issuer text,p_client text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true; $$;",
    ],
    [
      "Store column",
      (s) =>
        s.replace(
          " selector_hash text NOT NULL\n",
          " selector_hash text NOT NULL,\n store_id uuid\n",
        ),
    ],
    [
      "invitation selector binding",
      (s) =>
        s.replace(
          "AND selector_hash=current_setting('bop.onboarding_invitation_selector_hash',true)",
          "",
        ),
    ],
  ])("rejects weakened %s", (_name, mutate) => {
    expect(inspectMigrationPermissions(migration(mutate(onboarding))).map((d) => d.code)).toContain(
      "RLS_ONBOARDING_SCOPE_INVALID",
    );
  });
  it("does not extend the onboarding contract to other Identity tables", () => {
    expect(
      inspectMigrationPermissions(
        migration(onboarding.replaceAll("workforce_onboarding_operation", "other_operation")),
      ).map((d) => d.code),
    ).toContain("RLS_BRAND_SCOPE_MISSING");
  });
});

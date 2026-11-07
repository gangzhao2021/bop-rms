import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readMigrationCatalog } from "../../packages/database/src/catalog.ts";

const tenantSchema = /^(?:bop|rms)_[a-z][a-z0-9_]*$/u;
const qualifiedName = /^(?:bop|rms)_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

const diagnostic = (code, file, object, message) => ({ code, file, object, message });
const formatted = (item) => `${item.file} [${item.code}] ${item.object}: ${item.message}`;
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function inspectMigrationPermissions(migrations) {
  const diagnostics = [];
  const completeSql = migrations.map((migration) => migration.sql).join("\n");
  const statements = completeSql
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const sourceFor = (offset) => {
    let consumed = 0;
    for (const migration of migrations) {
      const end = consumed + migration.sql.length + 1;
      if (offset < end) return migration.relativePath;
      consumed = end;
    }
    return "migrations";
  };

  for (const statement of statements)
    if (/\bGRANT\b[\s\S]*\bTO\s+PUBLIC\b/iu.test(statement))
      diagnostics.push(
        diagnostic("PUBLIC_GRANT", "migrations", "PUBLIC", "PUBLIC grants are prohibited"),
      );
  if (
    /\bALTER\s+TABLE\b[\s\S]*\b(?:DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY)\b/iu.test(
      completeSql,
    )
  )
    diagnostics.push(
      diagnostic("RLS_WEAKENED", "migrations", "RLS", "migration weakens row-level security"),
    );

  for (const match of completeSql.matchAll(
    /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\b/giu,
  )) {
    const schema = match[1];
    if (!tenantSchema.test(schema)) continue;
    if (
      !statements.some((statement) =>
        new RegExp(`^REVOKE ALL ON SCHEMA ${escaped(schema)} FROM PUBLIC$`, "iu").test(statement),
      )
    )
      diagnostics.push(
        diagnostic(
          "SCHEMA_PUBLIC_NOT_REVOKED",
          sourceFor(match.index ?? 0),
          schema,
          "tenant schema must revoke PUBLIC",
        ),
      );
  }

  for (const match of completeSql.matchAll(
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:bop|rms)_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\(([\s\S]*?)^\);/gimu,
  )) {
    const table = match[1];
    const body = match[2] ?? "";
    if (!qualifiedName.test(table) || !/\bbrand_id\b/iu.test(body)) continue;
    const file = sourceFor(match.index ?? 0);
    const tablePattern = escaped(table);
    for (const [code, clause] of [
      ["RLS_NOT_ENABLED", "ENABLE ROW LEVEL SECURITY"],
      ["RLS_NOT_FORCED", "FORCE ROW LEVEL SECURITY"],
    ])
      if (!new RegExp(`\\bALTER TABLE ${tablePattern} ${clause}\\b`, "iu").test(completeSql))
        diagnostics.push(
          diagnostic(code, file, table, `tenant table requires ${clause.toLowerCase()}`),
        );
    const policies = [
      ...completeSql.matchAll(
        new RegExp(`\\bCREATE POLICY [^;]*? ON ${tablePattern}([\\s\\S]*?);`, "giu"),
      ),
    ]
      .map((item) => item[1] ?? "")
      .join("\n");
    if (!policies)
      diagnostics.push(
        diagnostic("RLS_POLICY_MISSING", file, table, "tenant table requires an explicit policy"),
      );
    else {
      if (
        table === "bop_identity.browser_session_selection" ||
        table === "bop_identity.browser_brand_session_selection"
      ) {
        // Pre-Tenant Identity child: selected Brand/Store cannot authorize their own lookup.
        // This is a closed contract, not an Identity-wide exemption from forced RLS.
        const predicate =
          "session_id = NULLIF(current_setting('bop.identity_session_id', true), '')::uuid AND actor_id = NULLIF(current_setting('bop.identity_actor_id', true), '')::uuid";
        const expected = "USING (" + predicate + ") WITH CHECK (" + predicate + ")";
        const normalized = policies.replace(/\s+/gu, " ").trim();
        const parentBinding =
          /FOREIGN KEY\s*\(session_id,\s*actor_id\)\s*REFERENCES bop_identity\.authentication_session\s*\(session_id,\s*actor_id\)/iu;
        if (normalized !== expected || !parentBinding.test(body))
          diagnostics.push(
            diagnostic(
              "RLS_IDENTITY_SESSION_SCOPE_INVALID",
              file,
              table,
              "selection requires the exact session-and-Actor policy and composite authentication-session binding",
            ),
          );
      } else if (table === "bop_identity.workforce_onboarding_operation") {
        // Platform-operated Workforce onboarding precedes any Brand Session. This closed contract
        // binds operator, purpose, onboarding Actor, Brand, Membership and Provider client exactly,
        // plus the invitee's read by high-entropy invitation selector hash before a Brand is known.
        // It is not an Identity-wide exemption from Brand/Store isolation.
        const compact = (value) => value.replace(/\s+/gu, "");
        const call =
          "bop_identity.workforce_onboarding_scope(operator_id,actor_id,brand_id,membership_id,environment,issuer,client_id)";
        const scopeDefinitions = [
          ...completeSql.matchAll(
            /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+bop_identity\.workforce_onboarding_scope\b[\s\S]*?\$\$[\s\S]*?\$\$/giu,
          ),
        ].map((item) => compact(item[0]));
        const expectedScope = compact(`CREATE FUNCTION bop_identity.workforce_onboarding_scope(
          p_operator uuid,p_actor uuid,p_brand uuid,p_member uuid,p_environment text,p_issuer text,p_client text
        ) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
          SELECT COALESCE(p_operator::text=current_setting('bop.platform_actor_id',true)
          AND current_setting('bop.platform_purpose',true)='WORKFORCE_ONBOARDING'
          AND p_actor::text=current_setting('bop.onboarding_actor_id',true)
          AND p_brand::text=current_setting('bop.onboarding_brand_id',true)
          AND p_member::text=current_setting('bop.onboarding_member_id',true)
          AND p_environment=current_setting('bop.onboarding_environment',true)
          AND p_issuer=current_setting('bop.onboarding_issuer',true)
          AND p_client=current_setting('bop.onboarding_client_id',true),false); $$`);
        if (
          compact(policies) !==
            compact(`FOR SELECT USING(${call}) FOR INSERT WITH CHECK(${call})
              FOR SELECT USING (
                current_setting('bop.onboarding_invitation_purpose',true)='WORKFORCE_ONBOARDING_INVITATION'
                AND selector_hash=current_setting('bop.onboarding_invitation_selector_hash',true)
                AND environment=current_setting('bop.onboarding_environment',true)
                AND issuer=current_setting('bop.onboarding_issuer',true)
                AND client_id=current_setting('bop.onboarding_client_id',true)
              )`) ||
          scopeDefinitions.length !== 1 ||
          scopeDefinitions[0] !== expectedScope ||
          /\bstore_id\b/iu.test(body)
        )
          diagnostics.push(
            diagnostic(
              "RLS_ONBOARDING_SCOPE_INVALID",
              file,
              table,
              "onboarding requires the exact operator, purpose, Actor, Brand, Membership and client scope",
            ),
          );
      } else {
        if (!/platform_helpers\.current_brand_id\(\)/u.test(policies))
          diagnostics.push(
            diagnostic("RLS_BRAND_SCOPE_MISSING", file, table, "policy must bind current Brand"),
          );
        if (
          /\bstore_id\b/iu.test(body) &&
          !/platform_helpers\.current_store_id\(\)/u.test(policies)
        )
          diagnostics.push(
            diagnostic(
              "RLS_STORE_SCOPE_MISSING",
              file,
              table,
              "Store table policy must bind current Store",
            ),
          );
      }
      if (/\b(?:USING|WITH CHECK)\s*\(\s*true\s*\)/iu.test(policies))
        diagnostics.push(
          diagnostic("RLS_POLICY_OPEN", file, table, "unconditional tenant policy is prohibited"),
        );
    }
    const revoked = statements.some(
      (statement) =>
        /^REVOKE ALL ON (?:TABLE )?[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(?:, ?[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)* FROM PUBLIC$/iu.test(
          statement,
        ) &&
        new RegExp(`(?:^|[, ])${tablePattern}(?:$|[, ])`, "iu").test(statement) &&
        / FROM PUBLIC$/iu.test(statement),
    );
    if (!revoked)
      diagnostics.push(
        diagnostic("TABLE_PUBLIC_NOT_REVOKED", file, table, "tenant table must revoke PUBLIC"),
      );
  }

  for (const match of completeSql.matchAll(
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:bop|rms)_[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\(/giu,
  )) {
    const routine = match[1];
    const revoked = statements.some((statement) =>
      new RegExp(`\\bREVOKE ALL ON FUNCTION ${escaped(routine)}\\(`, "iu").test(statement),
    );
    if (!revoked)
      diagnostics.push(
        diagnostic(
          "FUNCTION_PUBLIC_NOT_REVOKED",
          sourceFor(match.index ?? 0),
          routine,
          "tenant function must revoke PUBLIC execute",
        ),
      );
  }

  diagnostics.sort((left, right) => formatted(left).localeCompare(formatted(right), "en"));
  return diagnostics;
}

export async function validateDatabasePermissions({ root = process.cwd() } = {}) {
  root = resolve(root);
  const catalog = await readMigrationCatalog(root);
  const diagnostics = [
    ...catalog.diagnostics.map((item) =>
      diagnostic(item.code, item.file ?? "migrations", "catalog", item.message),
    ),
    ...inspectMigrationPermissions(catalog.migrations),
  ];
  diagnostics.sort((left, right) => formatted(left).localeCompare(formatted(right), "en"));
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    output: diagnostics.map(formatted).join("\n"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await validateDatabasePermissions();
  if (result.valid) process.stdout.write("Database permissions valid\n");
  else {
    process.stderr.write(`${result.output}\n`);
    process.exitCode = 1;
  }
}

import type { Client as PgClient } from "pg";

const expectedSchemas = [
  "platform_audit",
  "platform_core",
  "platform_eventing",
  "platform_jobs",
] as const;
const acceptedLaterSchemas = new Set(["platform_helpers"]);
const acceptedLaterObjects = new Set([
  "platform_eventing.outbox_event:table",
  "platform_eventing.outbox_event_tenant_scope:policy",
]);

export type FoundationDiagnosticCode =
  | "FOUNDATION_SCHEMA_MISSING"
  | "FOUNDATION_SCHEMA_UNEXPECTED"
  | "FOUNDATION_SCHEMA_OWNER_MISMATCH"
  | "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE"
  | "FOUNDATION_OBJECT_UNEXPECTED"
  | "FOUNDATION_CORE_HISTORY_MISSING"
  | "FOUNDATION_CORE_OBJECT_UNEXPECTED"
  | "FOUNDATION_CONFIG_UNSAFE"
  | "FOUNDATION_CONNECTION_FAILED"
  | "FOUNDATION_INTERNAL";

export interface FoundationDiagnostic {
  readonly code: FoundationDiagnosticCode;
  readonly message: string;
  readonly target: string;
}

export interface FoundationSchemaState {
  readonly name: string;
  readonly owner: string;
  readonly publicDefaultPrivilege: boolean;
  readonly publicSchemaPrivilege: boolean;
}

export interface FoundationObjectState {
  readonly kind: string;
  readonly name: string;
  readonly schema: string;
}

export interface FoundationSnapshot {
  readonly globalPublicDefaultPrivilege: boolean;
  readonly objects: readonly FoundationObjectState[];
  readonly schemas: readonly FoundationSchemaState[];
}

export interface FoundationVerificationResult {
  readonly diagnostics: readonly FoundationDiagnostic[];
  readonly status: "compliant" | "violation";
}

export function compareFoundationDiagnostics(
  left: FoundationDiagnostic,
  right: FoundationDiagnostic,
): number {
  return (
    left.target.localeCompare(right.target, "en") ||
    left.code.localeCompare(right.code, "en") ||
    left.message.localeCompare(right.message, "en")
  );
}

export function formatFoundationDiagnostic(diagnostic: FoundationDiagnostic): string {
  return `foundation:${diagnostic.target} [${diagnostic.code}] ${diagnostic.message}`;
}

function diagnostic(
  target: string,
  code: FoundationDiagnosticCode,
  message: string,
): FoundationDiagnostic {
  return { code, message, target };
}

export function evaluateFoundationSnapshot(
  snapshot: FoundationSnapshot,
  expectedOwner: string,
): FoundationVerificationResult {
  const diagnostics: FoundationDiagnostic[] = [];
  const schemas = new Map(snapshot.schemas.map((schema) => [schema.name, schema]));

  for (const name of expectedSchemas) {
    const schema = schemas.get(name);
    if (!schema) {
      diagnostics.push(diagnostic(name, "FOUNDATION_SCHEMA_MISSING", "expected schema is missing"));
      continue;
    }
    if (schema.owner !== expectedOwner)
      diagnostics.push(
        diagnostic(
          name,
          "FOUNDATION_SCHEMA_OWNER_MISMATCH",
          "schema owner does not match the configured migration role",
        ),
      );
    if (
      schema.publicSchemaPrivilege ||
      schema.publicDefaultPrivilege ||
      snapshot.globalPublicDefaultPrivilege
    )
      diagnostics.push(
        diagnostic(
          name,
          "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE",
          "PUBLIC retains schema or effective default privileges",
        ),
      );
  }

  for (const schema of snapshot.schemas)
    if (
      schema.name.startsWith("platform_") &&
      !expectedSchemas.includes(schema.name as never) &&
      !acceptedLaterSchemas.has(schema.name)
    )
      diagnostics.push(
        diagnostic(
          schema.name,
          "FOUNDATION_SCHEMA_UNEXPECTED",
          "unexpected platform schema exists",
        ),
      );

  const history = snapshot.objects.filter(
    (object) =>
      object.schema === "platform_core" &&
      object.name === "migration_history" &&
      object.kind === "table",
  );
  if (history.length !== 1)
    diagnostics.push(
      diagnostic(
        "platform_core.migration_history",
        "FOUNDATION_CORE_HISTORY_MISSING",
        "exact migration history table is missing",
      ),
    );

  for (const object of snapshot.objects) {
    if (
      object.schema === "platform_core" &&
      object.name === "migration_history" &&
      object.kind === "table"
    )
      continue;
    const target = `${object.schema}.${object.name}`;
    if (acceptedLaterObjects.has(`${target}:${object.kind}`)) continue;
    diagnostics.push(
      diagnostic(
        target,
        object.schema === "platform_core"
          ? "FOUNDATION_CORE_OBJECT_UNEXPECTED"
          : "FOUNDATION_OBJECT_UNEXPECTED",
        `unexpected ${object.kind} exists in a foundation schema`,
      ),
    );
  }

  diagnostics.sort(compareFoundationDiagnostics);
  return { diagnostics, status: diagnostics.length ? "violation" : "compliant" };
}

export async function readFoundationSnapshot(client: PgClient): Promise<FoundationSnapshot> {
  const schemas = await client.query<{
    name: string;
    owner: string;
    public_default_privilege: boolean;
    public_schema_privilege: boolean;
  }>(`SELECT namespace.nspname AS name,
      pg_get_userbyid(namespace.nspowner) AS owner,
      EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        WHERE defaults.defaclrole = namespace.nspowner
          AND defaults.defaclnamespace = namespace.oid
          AND privilege.grantee = 0
      ) AS public_default_privilege,
      EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type IN ('USAGE', 'CREATE')
      ) AS public_schema_privilege
    FROM pg_namespace AS namespace
    WHERE namespace.nspname LIKE 'platform\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname`);

  const globalDefaults = await client.query<{ unsafe: boolean }>(`WITH owner AS (
      SELECT role_record.oid
      FROM pg_roles AS role_record
      WHERE role_record.rolname = current_user
    ), kinds(kind) AS (
      VALUES ('r'::"char"), ('S'::"char"), ('f'::"char"), ('T'::"char")
    )
    SELECT EXISTS (
      SELECT 1
      FROM owner
      CROSS JOIN kinds
      CROSS JOIN LATERAL aclexplode(COALESCE(
        (SELECT defaults.defaclacl
         FROM pg_default_acl AS defaults
         WHERE defaults.defaclrole = owner.oid
           AND defaults.defaclnamespace = 0
           AND defaults.defaclobjtype = kinds.kind),
        acldefault(kinds.kind, owner.oid)
      )) AS privilege
      WHERE privilege.grantee = 0
    ) AS unsafe`);

  const relations = await client.query<{
    kind: string;
    name: string;
    schema: string;
  }>(`SELECT namespace.nspname AS schema,
      relation.relname AS name,
      CASE relation.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'partitioned-table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized-view'
        WHEN 'S' THEN 'sequence'
        WHEN 'f' THEN 'foreign-table'
      END AS kind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    ORDER BY namespace.nspname, relation.relname, relation.relkind`);

  const routines = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema,
      routine.proname || '(' || pg_get_function_identity_arguments(routine.oid) || ')' AS name,
      'routine' AS kind
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    ORDER BY namespace.nspname, routine.proname, routine.oid`);

  const types = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema, type_record.typname AS name, 'type' AS kind
    FROM pg_type AS type_record
    JOIN pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
      AND type_record.typelem = 0
      AND NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        WHERE relation.oid = type_record.typrelid
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      )
    ORDER BY namespace.nspname, type_record.typname, type_record.oid`);

  const triggers = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema, trigger_record.tgname AS name, 'trigger' AS kind
    FROM pg_trigger AS trigger_record
    JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
      AND NOT trigger_record.tgisinternal
    ORDER BY namespace.nspname, trigger_record.tgname, trigger_record.oid`);

  const policies = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema, policy_record.polname AS name, 'policy' AS kind
    FROM pg_policy AS policy_record
    JOIN pg_class AS relation ON relation.oid = policy_record.polrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    ORDER BY namespace.nspname, policy_record.polname, policy_record.oid`);

  const extensions = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema, extension_record.extname AS name, 'extension' AS kind
    FROM pg_extension AS extension_record
    JOIN pg_namespace AS namespace ON namespace.oid = extension_record.extnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    ORDER BY namespace.nspname, extension_record.extname`);

  const miscellaneous = await client.query<{ kind: string; name: string; schema: string }>(`SELECT
      namespace.nspname AS schema, collation_record.collname AS name, 'collation' AS kind
    FROM pg_collation AS collation_record
    JOIN pg_namespace AS namespace ON namespace.oid = collation_record.collnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, conversion_record.conname, 'conversion'
    FROM pg_conversion AS conversion_record
    JOIN pg_namespace AS namespace ON namespace.oid = conversion_record.connamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, operator_record.oprname, 'operator'
    FROM pg_operator AS operator_record
    JOIN pg_namespace AS namespace ON namespace.oid = operator_record.oprnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, operator_class.opcname, 'operator-class'
    FROM pg_opclass AS operator_class
    JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, operator_family.opfname, 'operator-family'
    FROM pg_opfamily AS operator_family
    JOIN pg_namespace AS namespace ON namespace.oid = operator_family.opfnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, statistics_record.stxname, 'extended-statistics'
    FROM pg_statistic_ext AS statistics_record
    JOIN pg_namespace AS namespace ON namespace.oid = statistics_record.stxnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, config_record.cfgname, 'text-search-configuration'
    FROM pg_ts_config AS config_record
    JOIN pg_namespace AS namespace ON namespace.oid = config_record.cfgnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, dictionary_record.dictname, 'text-search-dictionary'
    FROM pg_ts_dict AS dictionary_record
    JOIN pg_namespace AS namespace ON namespace.oid = dictionary_record.dictnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, parser_record.prsname, 'text-search-parser'
    FROM pg_ts_parser AS parser_record
    JOIN pg_namespace AS namespace ON namespace.oid = parser_record.prsnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    UNION ALL
    SELECT namespace.nspname, template_record.tmplname, 'text-search-template'
    FROM pg_ts_template AS template_record
    JOIN pg_namespace AS namespace ON namespace.oid = template_record.tmplnamespace
    WHERE namespace.nspname IN ('platform_core', 'platform_eventing', 'platform_audit', 'platform_jobs')
    ORDER BY schema, name, kind`);

  return {
    globalPublicDefaultPrivilege: globalDefaults.rows[0]?.unsafe === true,
    objects: [
      ...relations.rows,
      ...routines.rows,
      ...types.rows,
      ...triggers.rows,
      ...policies.rows,
      ...extensions.rows,
      ...miscellaneous.rows,
    ],
    schemas: schemas.rows.map((schema) => ({
      name: schema.name,
      owner: schema.owner,
      publicDefaultPrivilege: schema.public_default_privilege,
      publicSchemaPrivilege: schema.public_schema_privilege,
    })),
  };
}

export async function verifyFoundation(
  client: PgClient,
  expectedOwner: string,
): Promise<FoundationVerificationResult> {
  return evaluateFoundationSnapshot(await readFoundationSnapshot(client), expectedOwner);
}

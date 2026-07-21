import type { Client as PgClient } from "pg";

export type HelperDiagnosticCode =
  | "HELPER_SCHEMA_MISSING"
  | "HELPER_SCHEMA_OWNER_MISMATCH"
  | "HELPER_PUBLIC_PRIVILEGE"
  | "HELPER_OBJECT_MISSING"
  | "HELPER_OBJECT_UNEXPECTED"
  | "HELPER_OBJECT_CONTRACT_MISMATCH"
  | "HELPER_CONFIG_UNSAFE"
  | "HELPER_CONNECTION_FAILED"
  | "HELPER_INTERNAL";

export interface HelperDiagnostic {
  readonly code: HelperDiagnosticCode;
  readonly message: string;
  readonly target: string;
}

export interface HelperObjectState {
  readonly identity: string;
  readonly kind: "domain" | "function";
  readonly owner: string;
  readonly parallel: string | null;
  readonly publicPrivilege: boolean;
  readonly securityDefiner: boolean | null;
  readonly strict: boolean | null;
  readonly volatility: string | null;
  readonly configuration: readonly string[];
}

export interface HelperSnapshot {
  readonly objects: readonly HelperObjectState[];
  readonly schema: {
    readonly exists: boolean;
    readonly owner: string | null;
    readonly publicDefaultPrivilege: boolean;
    readonly publicPrivilege: boolean;
  };
}

const expectedObjects = new Map<string, Omit<HelperObjectState, "owner" | "publicPrivilege">>([
  [
    "function:is_uuid_v7(uuid)",
    {
      configuration: ["search_path=pg_catalog"],
      identity: "function:is_uuid_v7(uuid)",
      kind: "function",
      parallel: "safe",
      securityDefiner: false,
      strict: true,
      volatility: "immutable",
    },
  ],
  [
    "function:is_iana_time_zone(text)",
    {
      configuration: ["search_path=pg_catalog"],
      identity: "function:is_iana_time_zone(text)",
      kind: "function",
      parallel: "safe",
      securityDefiner: false,
      strict: true,
      volatility: "stable",
    },
  ],
  ...["current_brand_id()", "current_store_id()"].map(
    (name) =>
      [
        `function:${name}`,
        {
          configuration: ["search_path=pg_catalog"],
          identity: `function:${name}`,
          kind: "function" as const,
          parallel: "safe",
          securityDefiner: false,
          strict: false,
          volatility: "stable",
        },
      ] as const,
  ),
  ...["uuid_v7", "amount_minor", "currency_code", "iana_time_zone", "local_date", "local_time"].map(
    (name) =>
      [
        `domain:${name}`,
        {
          configuration: [],
          identity: `domain:${name}`,
          kind: "domain" as const,
          parallel: null,
          securityDefiner: null,
          strict: null,
          volatility: null,
        },
      ] as const,
  ),
]);

function diagnostic(target: string, code: HelperDiagnosticCode, message: string): HelperDiagnostic {
  return { code, message, target };
}

export function compareHelperDiagnostics(left: HelperDiagnostic, right: HelperDiagnostic): number {
  return (
    left.target.localeCompare(right.target, "en") ||
    left.code.localeCompare(right.code, "en") ||
    left.message.localeCompare(right.message, "en")
  );
}

export function formatHelperDiagnostic(item: HelperDiagnostic): string {
  return `helpers:${item.target} [${item.code}] ${item.message}`;
}

export function evaluateHelperSnapshot(
  snapshot: HelperSnapshot,
  expectedOwner: string,
): readonly HelperDiagnostic[] {
  const diagnostics: HelperDiagnostic[] = [];
  if (!snapshot.schema.exists)
    diagnostics.push(diagnostic("platform_helpers", "HELPER_SCHEMA_MISSING", "schema is missing"));
  else {
    if (snapshot.schema.owner !== expectedOwner)
      diagnostics.push(
        diagnostic(
          "platform_helpers",
          "HELPER_SCHEMA_OWNER_MISMATCH",
          "schema owner does not match the configured migration role",
        ),
      );
    if (snapshot.schema.publicPrivilege || snapshot.schema.publicDefaultPrivilege)
      diagnostics.push(
        diagnostic(
          "platform_helpers",
          "HELPER_PUBLIC_PRIVILEGE",
          "PUBLIC retains schema or effective default privileges",
        ),
      );
  }

  const actual = new Map(snapshot.objects.map((object) => [object.identity, object]));
  for (const [identity, expected] of expectedObjects) {
    const object = actual.get(identity);
    if (!object) {
      diagnostics.push(diagnostic(identity, "HELPER_OBJECT_MISSING", "expected object is missing"));
      continue;
    }
    if (object.owner !== expectedOwner)
      diagnostics.push(
        diagnostic(identity, "HELPER_OBJECT_CONTRACT_MISMATCH", "object owner is incorrect"),
      );
    if (object.publicPrivilege)
      diagnostics.push(
        diagnostic(identity, "HELPER_PUBLIC_PRIVILEGE", "PUBLIC retains object privilege"),
      );
    if (
      object.kind !== expected.kind ||
      object.volatility !== expected.volatility ||
      object.strict !== expected.strict ||
      object.parallel !== expected.parallel ||
      object.securityDefiner !== expected.securityDefiner ||
      object.configuration.join("\n") !== expected.configuration.join("\n")
    )
      diagnostics.push(
        diagnostic(
          identity,
          "HELPER_OBJECT_CONTRACT_MISMATCH",
          "object properties do not match the accepted contract",
        ),
      );
  }
  for (const identity of actual.keys())
    if (!expectedObjects.has(identity))
      diagnostics.push(
        diagnostic(identity, "HELPER_OBJECT_UNEXPECTED", "unexpected helper object exists"),
      );
  return diagnostics.sort(compareHelperDiagnostics);
}

export async function readHelperSnapshot(client: PgClient): Promise<HelperSnapshot> {
  const schemaResult = await client.query<{
    exists: boolean;
    owner: string | null;
    public_default_privilege: boolean;
    public_privilege: boolean;
  }>(`SELECT namespace.oid IS NOT NULL AS exists,
      pg_get_userbyid(namespace.nspowner) AS owner,
      COALESCE(has_schema_privilege('public', namespace.oid, 'USAGE'), false)
        OR COALESCE(has_schema_privilege('public', namespace.oid, 'CREATE'), false) AS public_privilege,
      EXISTS (
        SELECT 1 FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        WHERE defaults.defaclrole = namespace.nspowner
          AND defaults.defaclnamespace = namespace.oid
          AND privilege.grantee = 0
      ) AS public_default_privilege
    FROM (SELECT to_regnamespace('platform_helpers') AS oid) AS target
    LEFT JOIN pg_namespace AS namespace ON namespace.oid = target.oid`);

  const functions = await client.query<{
    configuration: string[] | null;
    identity: string;
    owner: string;
    parallel: string;
    public_privilege: boolean;
    security_definer: boolean;
    strict: boolean;
    volatility: string;
  }>(`SELECT 'function:' || routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')' AS identity,
      pg_get_userbyid(routine.proowner) AS owner,
      CASE routine.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
      routine.proisstrict AS strict,
      CASE routine.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' ELSE 'unsafe' END AS parallel,
      routine.prosecdef AS security_definer,
      COALESCE(routine.proconfig, ARRAY[]::text[]) AS configuration,
      has_function_privilege('public', routine.oid, 'EXECUTE') AS public_privilege
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'platform_helpers'
    ORDER BY identity`);

  const domains = await client.query<{
    identity: string;
    owner: string;
    public_privilege: boolean;
  }>(`SELECT 'domain:' || type_record.typname AS identity,
      pg_get_userbyid(type_record.typowner) AS owner,
      has_type_privilege('public', type_record.oid, 'USAGE') AS public_privilege
    FROM pg_type AS type_record
    JOIN pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
    WHERE namespace.nspname = 'platform_helpers' AND type_record.typtype = 'd'
    ORDER BY identity`);

  const schema = schemaResult.rows[0] ?? {
    exists: false,
    owner: null,
    public_default_privilege: false,
    public_privilege: false,
  };
  return {
    schema: {
      exists: schema.exists,
      owner: schema.owner,
      publicDefaultPrivilege: schema.public_default_privilege,
      publicPrivilege: schema.public_privilege,
    },
    objects: [
      ...functions.rows.map((item) => ({
        configuration: item.configuration ?? [],
        identity: item.identity,
        kind: "function" as const,
        owner: item.owner,
        parallel: item.parallel,
        publicPrivilege: item.public_privilege,
        securityDefiner: item.security_definer,
        strict: item.strict,
        volatility: item.volatility,
      })),
      ...domains.rows.map((item) => ({
        configuration: [],
        identity: item.identity,
        kind: "domain" as const,
        owner: item.owner,
        parallel: null,
        publicPrivilege: item.public_privilege,
        securityDefiner: null,
        strict: null,
        volatility: null,
      })),
    ],
  };
}

export async function verifyHelpers(
  client: PgClient,
  expectedOwner: string,
): Promise<readonly HelperDiagnostic[]> {
  return evaluateHelperSnapshot(await readHelperSnapshot(client), expectedOwner);
}

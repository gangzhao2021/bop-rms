import type { Client as PgClient } from "pg";
import { describe, expect, it } from "vitest";
import { parseHelpersArguments } from "./helpers-cli.ts";
import {
  evaluateHelperSnapshot,
  formatHelperDiagnostic,
  readHelperSnapshot,
  type HelperObjectState,
  type HelperSnapshot,
} from "./helpers.ts";

const owner = "synthetic_migration_owner";
const fn = (identity: string, volatility: string, strict: boolean): HelperObjectState => ({
  configuration: ["search_path=pg_catalog"],
  identity,
  kind: "function",
  owner,
  parallel: "safe",
  publicPrivilege: false,
  securityDefiner: false,
  strict,
  volatility,
});
const domain = (name: string): HelperObjectState => ({
  configuration: [],
  identity: `domain:${name}`,
  kind: "domain",
  owner,
  parallel: null,
  publicPrivilege: false,
  securityDefiner: null,
  strict: null,
  volatility: null,
});
const compliant = (): HelperSnapshot => ({
  objects: [
    fn("function:is_uuid_v7(uuid)", "immutable", true),
    fn("function:is_iana_time_zone(text)", "stable", true),
    fn("function:current_brand_id()", "stable", false),
    fn("function:current_store_id()", "stable", false),
    ...[
      "uuid_v7",
      "amount_minor",
      "currency_code",
      "iana_time_zone",
      "local_date",
      "local_time",
    ].map(domain),
  ],
  schema: {
    exists: true,
    owner,
    publicDefaultPrivilege: false,
    publicPrivilege: false,
  },
});

describe("database helper verifier", () => {
  it("accepts the exact closed helper contract", () => {
    expect(evaluateHelperSnapshot(compliant(), owner)).toEqual([]);
  });

  it("reports deterministic owner, privilege, property, missing, and unexpected drift", () => {
    const snapshot = compliant();
    const [uuidFunction, ...remainingObjects] = snapshot.objects;
    expect(uuidFunction).toBeDefined();
    if (!uuidFunction) throw new Error("synthetic UUID helper fixture is missing");
    const diagnostics = evaluateHelperSnapshot(
      {
        objects: [
          { ...uuidFunction, securityDefiner: true },
          ...remainingObjects.slice(1),
          domain("unexpected"),
        ],
        schema: { ...snapshot.schema, owner: "wrong_owner", publicPrivilege: true },
      },
      owner,
    );
    expect(diagnostics.map((item) => item.code)).toEqual([
      "HELPER_OBJECT_UNEXPECTED",
      "HELPER_OBJECT_MISSING",
      "HELPER_OBJECT_CONTRACT_MISMATCH",
      "HELPER_PUBLIC_PRIVILEGE",
      "HELPER_SCHEMA_OWNER_MISMATCH",
    ]);
    expect(diagnostics.map(formatHelperDiagnostic)).toEqual(
      [...diagnostics].map(formatHelperDiagnostic).sort((a, b) => a.localeCompare(b, "en")),
    );
  });

  it("reads function identities by argument type without PostgreSQL argument names", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql.trim());
        if (sql.includes("FROM (SELECT to_regnamespace"))
          return {
            rows: [
              {
                exists: true,
                owner,
                public_default_privilege: false,
                public_privilege: false,
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as PgClient;
    await readHelperSnapshot(client);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("pg_catalog.oidvectortypes(routine.proargtypes)");
    expect(statements[1]).not.toContain("pg_get_function_identity_arguments");
    expect(statements.every((statement) => statement.startsWith("SELECT"))).toBe(true);
  });

  it("parses only the closed read-only CLI arguments", () => {
    expect(parseHelpersArguments(["--", "--env-file", ".env.test", "--json"])).toEqual({
      envFile: ".env.test",
      json: true,
    });
    expect(parseHelpersArguments(["--help"])).toBeNull();
    expect(() => parseHelpersArguments(["--repair"])).toThrow("unknown argument");
  });
});

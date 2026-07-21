import type { Client as PgClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  evaluateFoundationSnapshot,
  formatFoundationDiagnostic,
  readFoundationSnapshot,
  verifyFoundation,
  type FoundationSnapshot,
} from "./foundation.ts";
import { foundationUsage, parseFoundationArguments } from "./foundation-cli.ts";

const owner = "bop_rms_wp0021_runner";
const compliant: FoundationSnapshot = {
  globalPublicDefaultPrivilege: false,
  objects: [{ kind: "table", name: "migration_history", schema: "platform_core" }],
  schemas: ["platform_audit", "platform_core", "platform_eventing", "platform_jobs"].map(
    (name) => ({
      name,
      owner,
      publicDefaultPrivilege: false,
      publicSchemaPrivilege: false,
    }),
  ),
};

describe("foundation verifier", () => {
  it("accepts the exact schema-only foundation state", () => {
    expect(evaluateFoundationSnapshot(compliant, owner)).toEqual({
      diagnostics: [],
      status: "compliant",
    });
  });

  it("delegates the accepted platform_helpers schema to the WP-0022 verifier", () => {
    expect(
      evaluateFoundationSnapshot(
        {
          ...compliant,
          schemas: [
            ...compliant.schemas,
            {
              name: "platform_helpers",
              owner,
              publicDefaultPrivilege: false,
              publicSchemaPrivilege: false,
            },
          ],
        },
        owner,
      ),
    ).toEqual({ diagnostics: [], status: "compliant" });
  });

  it("reports missing, unexpected, owner, privilege, and object violations deterministically", () => {
    const result = evaluateFoundationSnapshot(
      {
        globalPublicDefaultPrivilege: true,
        objects: [
          { kind: "table", name: "job", schema: "platform_jobs" },
          { kind: "view", name: "other", schema: "platform_core" },
        ],
        schemas: [
          {
            name: "platform_core",
            owner: "wrong_owner",
            publicDefaultPrivilege: false,
            publicSchemaPrivilege: true,
          },
          {
            name: "platform_eventing",
            owner,
            publicDefaultPrivilege: false,
            publicSchemaPrivilege: false,
          },
          {
            name: "platform_jobs",
            owner,
            publicDefaultPrivilege: false,
            publicSchemaPrivilege: false,
          },
          {
            name: "platform_projection",
            owner,
            publicDefaultPrivilege: false,
            publicSchemaPrivilege: false,
          },
        ],
      },
      owner,
    );
    expect(result.status).toBe("violation");
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "FOUNDATION_SCHEMA_MISSING",
      "FOUNDATION_SCHEMA_OWNER_MISMATCH",
      "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE",
      "FOUNDATION_CORE_HISTORY_MISSING",
      "FOUNDATION_CORE_OBJECT_UNEXPECTED",
      "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE",
      "FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE",
      "FOUNDATION_OBJECT_UNEXPECTED",
      "FOUNDATION_SCHEMA_UNEXPECTED",
    ]);
    expect(result.diagnostics.map(formatFoundationDiagnostic)).toEqual(
      [...result.diagnostics.map(formatFoundationDiagnostic)].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    );
  });

  it("uses catalog reads only and evaluates their bounded snapshot", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql.trim());
        if (
          sql.includes("FROM pg_namespace AS namespace") &&
          sql.includes("public_schema_privilege")
        )
          return {
            rows: compliant.schemas.map((schema) => ({
              name: schema.name,
              owner: schema.owner,
              public_default_privilege: false,
              public_schema_privilege: false,
            })),
          };
        if (sql.includes("WITH owner AS")) return { rows: [{ unsafe: false }] };
        if (sql.includes("CASE relation.relkind") && sql.includes("relation.relkind IN"))
          return { rows: compliant.objects };
        return { rows: [] };
      },
    } as unknown as PgClient;
    expect(await readFoundationSnapshot(client)).toEqual(compliant);
    expect(await verifyFoundation(client, owner)).toEqual({ diagnostics: [], status: "compliant" });
    expect(statements).toHaveLength(18);
    expect(statements.every((statement) => /^(?:SELECT|WITH)\b/u.test(statement))).toBe(true);
    expect(statements.join("\n").replaceAll(/'[^']*'/gu, "''")).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\b/iu,
    );
  });

  it("keeps the CLI separate with help and exit-2 usage behavior", () => {
    expect(parseFoundationArguments(["--", "--env-file", ".env", "--json"])).toEqual({
      envFile: ".env",
      json: true,
    });
    expect(() =>
      parseFoundationArguments(["postgres://user:secret@example.invalid/database"]),
    ).toThrow(/^unknown argument$/u);
    expect(foundationUsage).toContain("BOP-RMS Foundation Verifier");
  });
});

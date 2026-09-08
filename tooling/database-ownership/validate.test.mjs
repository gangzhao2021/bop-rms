import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateDatabaseOwnership } from "./validate.mjs";

const roots = [];
const toolRoot = dirname(fileURLToPath(import.meta.url));
const platformSource = await readFile(join(toolRoot, "platform-database.manifest.ts"), "utf8");
const identity = (layer, name) => ({
  moduleName: name,
  packageName: `@${layer.toLowerCase()}/${name}`,
  layer,
});
const governance = (table, packageName, overrides = {}) => ({
  table,
  classification: "aggregate-root",
  writeOwner: { kind: "module", id: packageName },
  allowedReadPatterns: ["owner-repository"],
  retentionCategory: "transactional",
  piiClassification: ["none"],
  ...overrides,
});
const access = (module, id, operation, schema, table, overrides = {}) => ({
  id,
  operation,
  mechanism: "repository",
  target: { schema, table },
  principal: { kind: "module", id: module.packageName },
  readPattern: operation === "read" ? "owner-repository" : null,
  source: `packages/${module.layer.toLowerCase()}/${module.moduleName}/src/tests/access-source.ts`,
  ...overrides,
});
async function writePlatform(root) {
  const path = join(root, "tooling/database-ownership/platform-database.manifest.ts");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, platformSource);
}
async function writeModule(root, layer, name, schema, tables = [], evidenceOverride) {
  const module = identity(layer, name);
  const moduleRoot = join(root, "packages", layer.toLowerCase(), name);
  const manifest = {
    ...module,
    lifecycle: "Later",
    publicExports: ["."],
    allowedSynchronousDependencies: [],
    consumedEvents: [],
    publishedEvents: [],
    ownedDatabase: { schema, tables },
    ownedJobs: [],
    featureFlags: [],
    killSwitches: [],
    piiClassification: {
      classes: ["none"],
      handling: {
        logs: "redacted",
        urls: "prohibited",
        analytics: "deidentified",
        fixtures: "synthetic-only",
      },
    },
    moduleOwner: { role: "Synthetic Test Owner" },
  };
  await mkdir(join(moduleRoot, "src/tests"), { recursive: true });
  await writeFile(
    join(moduleRoot, "src/tests/access-source.ts"),
    "export const synthetic = true;\n",
  );
  await writeFile(
    join(moduleRoot, "src/module.manifest.ts"),
    `const moduleManifestInput = ${JSON.stringify(manifest, null, 2)} as const;\nexport default moduleManifestInput;\n`,
  );
  await writeFile(
    join(moduleRoot, "package.json"),
    `${JSON.stringify({ name: module.packageName, type: "module", exports: { ".": "./src/index.ts" } }, null, 2)}\n`,
  );
  await writeFile(join(moduleRoot, "src/index.ts"), "export const synthetic = true;\n");
  if (evidenceOverride !== null && (tables.length || evidenceOverride)) {
    const base = {
      version: 1,
      module,
      tables: tables.map((table) => governance(table, module.packageName)),
      accesses: [],
    };
    const evidence =
      typeof evidenceOverride === "function"
        ? evidenceOverride(base, module)
        : (evidenceOverride ?? base);
    const path = join(moduleRoot, "src/infrastructure/persistence/database-access.manifest.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `const databaseAccessManifestInput = ${JSON.stringify(evidence, null, 2)} as const;\nexport default databaseAccessManifestInput;\n`,
    );
  }
  return { module, moduleRoot };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bop-database-ownership-"));
  roots.push(root);
  await writePlatform(root);
  return root;
}
const resultCodes = async (root) =>
  (await validateDatabaseOwnership({ root })).diagnostics.map((item) => item.code);

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Database Schema Ownership Architecture Test", () => {
  it("registers the default-denied platform helper schema under migration authority", () => {
    expect(platformSource).toContain('schema: "platform_helpers"');
    expect(platformSource).toContain('technicalOwner: "shared-infrastructure/helpers"');
  });

  it("accepts owner read/write and legal shared event Projection access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "synthetic-ordering", "rms_synthetic_ordering", [
      "order_header",
    ]);
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/database-access.manifest.ts",
    );
    const evidence = {
      version: 1,
      module: context.module,
      tables: [governance("order_header", context.module.packageName)],
      accesses: [
        access(
          context.module,
          "ordering.order.read",
          "read",
          "rms_synthetic_ordering",
          "order_header",
        ),
        access(
          context.module,
          "ordering.order.write",
          "write",
          "rms_synthetic_ordering",
          "order_header",
        ),
        access(context.module, "ordering.events.read", "read", "platform_eventing", "event_feed", {
          mechanism: "projection",
          principal: { kind: "projection-builder", id: "ordering.projection-builder" },
          readPattern: "event-projection",
        }),
      ],
    };
    await writeFile(
      file,
      `const databaseAccessManifestInput = ${JSON.stringify(evidence, null, 2)} as const;\n`,
    );
    expect(await validateDatabaseOwnership({ root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });
  });

  it("accepts only @bop/eventing writing through the exact shared Eventing authority", async () => {
    const root = await fixture();
    const eventing = await writeModule(root, "BOP", "eventing", null, [], (base) => ({
      ...base,
      accesses: [
        access(base.module, "append-outbox-event", "write", "platform_eventing", "outbox_event", {
          mechanism: "raw-sql",
          principal: { kind: "shared-infrastructure", id: "eventing-infrastructure" },
        }),
      ],
    }));
    expect(await validateDatabaseOwnership({ root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });

    const other = await writeModule(root, "BOP", "synthetic-other", null, [], (base) => ({
      ...base,
      accesses: [
        access(base.module, "append-outbox-event", "write", "platform_eventing", "outbox_event", {
          mechanism: "raw-sql",
          principal: { kind: "shared-infrastructure", id: "eventing-infrastructure" },
        }),
      ],
    }));
    expect(eventing.module.packageName).toBe("@bop/eventing");
    expect(other.module.packageName).toBe("@bop/synthetic-other");
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("accepts only @bop/audit writing through the exact shared Audit authority", async () => {
    const root = await fixture();
    const audit = await writeModule(root, "BOP", "audit", null, [], (base) => ({
      ...base,
      accesses: [
        access(base.module, "append-audit-record", "write", "platform_audit", "audit_record", {
          mechanism: "raw-sql",
          principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
        }),
      ],
    }));
    expect(await validateDatabaseOwnership({ root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });

    const other = await writeModule(root, "BOP", "synthetic-audit-writer", null, [], (base) => ({
      ...base,
      accesses: [
        access(base.module, "append-audit-record", "write", "platform_audit", "audit_record", {
          mechanism: "raw-sql",
          principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
        }),
      ],
    }));
    expect(audit.module.packageName).toBe("@bop/audit");
    expect(other.module.packageName).toBe("@bop/synthetic-audit-writer");
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("accepts only @bop/audit advancing the Audit chain head", async () => {
    const root = await fixture();
    const audit = await writeModule(root, "BOP", "audit", null, [], (base) => ({
      ...base,
      accesses: [
        access(
          base.module,
          "advance-audit-chain-head",
          "write",
          "platform_audit",
          "audit_chain_head",
          {
            mechanism: "raw-sql",
            principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
          },
        ),
      ],
    }));
    expect(await validateDatabaseOwnership({ root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });

    const other = await writeModule(root, "BOP", "synthetic-chain-writer", null, [], (base) => ({
      ...base,
      accesses: [
        access(
          base.module,
          "advance-audit-chain-head",
          "write",
          "platform_audit",
          "audit_chain_head",
          {
            mechanism: "raw-sql",
            principal: { kind: "shared-infrastructure", id: "audit-infrastructure" },
          },
        ),
      ],
    }));
    expect(audit.module.packageName).toBe("@bop/audit");
    expect(other.module.packageName).toBe("@bop/synthetic-chain-writer");
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("accepts a named Reconciliation Job reading an approved source view", async () => {
    const root = await fixture();
    await writeModule(
      root,
      "BOP",
      "synthetic-source",
      "bop_synthetic_source",
      ["approved_view"],
      (base) => ({
        ...base,
        tables: [
          governance("approved_view", base.module.packageName, {
            allowedReadPatterns: ["approved-source-view"],
          }),
        ],
      }),
    );
    await writeModule(
      root,
      "BOP",
      "synthetic-reconciliation",
      "bop_synthetic_reconciliation",
      ["result"],
      (base, module) => ({
        ...base,
        accesses: [
          access(
            module,
            "reconciliation.source.read",
            "read",
            "bop_synthetic_source",
            "approved_view",
            {
              mechanism: "projection",
              principal: {
                kind: "reconciliation-job",
                id: "synthetic-reconciliation-job",
              },
              readPattern: "approved-source-view",
            },
          ),
        ],
      }),
    );
    expect(await validateDatabaseOwnership({ root })).toMatchObject({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects a Projection Builder writing an Aggregate table", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base, module) => ({
      ...base,
      accesses: [
        access(module, "projection.aggregate.write", "write", "bop_owner", "record", {
          mechanism: "projection",
          principal: { kind: "projection-builder", id: "synthetic-projection-builder" },
        }),
      ],
    }));
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("rejects a read pattern not approved by table governance", async () => {
    const root = await fixture();
    await writeModule(root, "RMS", "synthetic-owner", "rms_owner", ["record"], (base, module) => ({
      ...base,
      tables: [
        governance("record", module.packageName, {
          allowedReadPatterns: ["owner-read-view"],
        }),
      ],
      accesses: [access(module, "owner.record.read", "read", "rms_owner", "record")],
    }));
    expect(await resultCodes(root)).toContain("INVALID_READ_PATTERN");
  });

  it("rejects evidence when the Manifest schema is null", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", null, [], (base) => base);
    expect(await resultCodes(root)).toContain("DATABASE_TARGET_UNDECLARED");
  });

  it("rejects unknown fields in the evidence Module identity", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base) => ({
      ...base,
      module: { ...base.module, extra: "not-allowed" },
    }));
    expect(await resultCodes(root)).toContain("MODULE_IDENTITY_MISMATCH");
  });

  it("rejects symlinked intermediate access-source directories", async () => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      "synthetic-owner",
      "bop_owner",
      ["record"],
      (base, module) => ({
        ...base,
        accesses: [
          access(module, "owner.record.write", "write", "bop_owner", "record", {
            source: "packages/bop/synthetic-owner/src/tests/access-link/source.ts",
          }),
        ],
      }),
    );
    const realDirectory = join(context.moduleRoot, "src/tests/access-real");
    await mkdir(realDirectory, { recursive: true });
    await writeFile(join(realDirectory, "source.ts"), "export const synthetic = true;\n");
    await symlink(realDirectory, join(context.moduleRoot, "src/tests/access-link"));
    expect(await resultCodes(root)).toContain("SYMLINK_PATH");
  });

  it("fails closed on migration SQL", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "synthetic-owner", null, []);
    const migration = join(context.moduleRoot, "migrations/001_synthetic.sql");
    await mkdir(dirname(migration), { recursive: true });
    await writeFile(migration, "select 1;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("rejects cross-Module writes", async () => {
    const root = await fixture();
    await writeModule(root, "RMS", "synthetic-ordering", "rms_synthetic_ordering", [
      "order_header",
    ]);
    await writeModule(
      root,
      "RMS",
      "synthetic-payment",
      "rms_synthetic_payment",
      ["payment"],
      (base, module) => ({
        ...base,
        accesses: [
          access(module, "payment.order.write", "write", "rms_synthetic_ordering", "order_header"),
        ],
      }),
    );
    expect(await resultCodes(root)).toContain("CROSS_MODULE_WRITE");
  });

  it("rejects writes to an unowned target", async () => {
    const root = await fixture();
    await writeModule(
      root,
      "BOP",
      "synthetic-owner",
      "bop_synthetic_owner",
      ["record"],
      (base, module) => ({
        ...base,
        accesses: [access(module, "owner.ghost.write", "write", "bop_missing", "ghost")],
      }),
    );
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("rejects reserved business schema claims", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "platform_audit", ["record"]);
    expect(await resultCodes(root)).toContain("RESERVED_SCHEMA_CLAIM");
  });

  it("rejects duplicate schema ownership", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-one", "bop_shared", ["one"]);
    await writeModule(root, "BOP", "synthetic-two", "bop_shared", ["two"]);
    expect(await resultCodes(root)).toContain("DUPLICATE_SCHEMA_OWNER");
  });

  it("rejects duplicate fully-qualified table ownership", async () => {
    const root = await fixture();
    await writeModule(root, "RMS", "synthetic-one", "rms_shared", ["record"]);
    await writeModule(root, "RMS", "synthetic-two", "rms_shared", ["record"]);
    expect(await resultCodes(root)).toContain("DUPLICATE_TABLE_OWNER");
  });

  it("rejects missing table governance", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], null);
    expect(await resultCodes(root)).toContain("TABLE_METADATA_MISSING");
  });

  it("rejects evidence identity mismatch", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base) => ({
      ...base,
      module: { ...base.module, packageName: "@bop/wrong" },
    }));
    expect(await resultCodes(root)).toContain("MODULE_IDENTITY_MISMATCH");
  });

  it("rejects case-folded ownership conflicts", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-one", "bop_owner", ["record"]);
    await writeModule(root, "BOP", "synthetic-two", "BOP_OWNER", ["record"]);
    expect(await resultCodes(root)).toContain("CASE_CONFLICT");
  });

  it("rejects non-literal dynamic evidence", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"]);
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/database-access.manifest.ts",
    );
    await writeFile(
      file,
      "const schema = 'bop_owner';\nconst databaseAccessManifestInput = { version: 1, module: {}, tables: [], accesses: [{ target: { schema, table: 'record' } }] };\n",
    );
    expect(await resultCodes(root)).toContain("DYNAMIC_DATABASE_TARGET");
  });

  it("rejects source path escape", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base, module) => ({
      ...base,
      accesses: [
        access(module, "owner.record.write", "write", "bop_owner", "record", {
          source: "../outside.ts",
        }),
      ],
    }));
    expect(await resultCodes(root)).toContain("PATH_ESCAPE");
  });

  it("rejects symlinked access sources", async () => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      "synthetic-owner",
      "bop_owner",
      ["record"],
      (base, module) => ({
        ...base,
        accesses: [
          access(module, "owner.record.write", "write", "bop_owner", "record", {
            source: "packages/bop/synthetic-owner/src/tests/access-link.ts",
          }),
        ],
      }),
    );
    await symlink(
      join(context.moduleRoot, "src/tests/access-source.ts"),
      join(context.moduleRoot, "src/tests/access-link.ts"),
    );
    expect(await resultCodes(root)).toContain("SYMLINK_PATH");
  });

  it("rejects Public Query Contracts carrying foreign table targets", async () => {
    const root = await fixture();
    await writeModule(root, "RMS", "synthetic-source", "rms_source", ["record"]);
    await writeModule(
      root,
      "RMS",
      "synthetic-reader",
      "rms_reader",
      ["result"],
      (base, module) => ({
        ...base,
        accesses: [
          access(module, "reader.source.read", "read", "rms_source", "record", {
            readPattern: "public-query-contract",
          }),
        ],
      }),
    );
    expect(await resultCodes(root)).toContain("INVALID_READ_PATTERN");
  });

  it("rejects unauthorized shared infrastructure writes", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base, module) => ({
      ...base,
      accesses: [access(module, "owner.audit.write", "write", "platform_audit", "audit_record")],
    }));
    expect(await resultCodes(root)).toContain("UNDECLARED_OWNER_WRITE");
  });

  it("rejects public table access", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "bop_owner", ["record"], (base, module) => ({
      ...base,
      accesses: [access(module, "owner.public.read", "read", "public", "record")],
    }));
    expect(await resultCodes(root)).toContain("RESERVED_SCHEMA_CLAIM");
  });

  it("fails closed on real persistence assets and Drizzle imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "synthetic-owner", null, []);
    const persistence = join(context.moduleRoot, "src/infrastructure/persistence/repository.ts");
    await mkdir(dirname(persistence), { recursive: true });
    await writeFile(persistence, 'import { sql } from "drizzle-orm";\nexport { sql };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2209 Identity entry asset and still rejects adjacent files and drivers", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "identity", "bop_identity", ["guest_session"]);
    const path = join(
      context.moduleRoot,
      "src/infrastructure/persistence/guest-session-entry-store.ts",
    );
    await writeFile(path, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(path, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(path, "export const synthetic = true;\n");
    await writeFile(join(dirname(path), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    ["other-owner", "bop_identity", ["guest_session"]],
    ["identity", "bop_other", ["guest_session"]],
    ["identity", "bop_identity", ["other_table"]],
  ])(
    "does not transfer WP-2209 acceptance to a different owner/schema/table",
    async (name, schema, tables) => {
      const root = await fixture();
      const context = await writeModule(root, "BOP", name, schema, tables);
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/guest-session-entry-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2219 Catalog reader, retaining adjacent-asset and driver rejection", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "catalog", "rms_catalog", [
      "published_menu_projection_generation",
      "published_menu_projection",
      "published_menu_projection_section",
      "published_menu_projection_sellable",
      "published_menu_projection_checkpoint",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/published-menu-query-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "owner",
    "schema",
    ...[
      "published_menu_projection_generation",
      "published_menu_projection",
      "published_menu_projection_section",
      "published_menu_projection_sellable",
      "published_menu_projection_checkpoint",
    ],
  ])("does not transfer WP-2219 acceptance with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "published_menu_projection_generation",
        "published_menu_projection",
        "published_menu_projection_section",
        "published_menu_projection_sellable",
        "published_menu_projection_checkpoint",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/published-menu-query-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("sorts diagnostics and repeats identical output", async () => {
    const root = await fixture();
    await writeModule(root, "BOP", "synthetic-owner", "platform_audit", ["Record"], null);
    const first = await validateDatabaseOwnership({ root });
    const second = await validateDatabaseOwnership({ root });
    expect(second).toEqual(first);
    expect(first.output.split("\n")).toEqual(
      [...first.output.split("\n")].sort((a, b) => a.localeCompare(b, "en")),
    );
  });

  it("publishes help and uses exit code 2 for invalid CLI usage", () => {
    const cli = join(toolRoot, "validate.mjs");
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("database-ownership:check");
    const invalid = spawnSync(process.execPath, [cli, "--unknown"], { encoding: "utf8" });
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Database Ownership error:");
  });
});

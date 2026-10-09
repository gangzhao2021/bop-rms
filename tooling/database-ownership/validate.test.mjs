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
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "product_operation_record",
    "product_operation_snapshot",
    "product_source_commit",
    "product_authoring_operation_abandonment",
  ])("bounds authoring resolution owner asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "product_operation_record",
        "product_operation_snapshot",
        "product_source_commit",
        "product_authoring_operation_abandonment",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-authoring-store.ts" : "product-authoring-resolution-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "selling_unit_registry_record",
    "selling_unit_registration_abandonment",
    "sku",
    "product_operation_record",
    "product_operation_snapshot",
    "product",
  ])("bounds selling unit registry owner asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "selling_unit_registry_record",
        "selling_unit_registration_abandonment",
        "sku",
        "product",
        "product_operation_record",
        "product_operation_snapshot",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-unit-store.ts" : "selling-unit-registry-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "option_set",
    "option_set_version",
    "option",
    "option_conflict",
    "option_set_operation_record",
    "option_set_draft_content_snapshot",
  ])("bounds full Option Draft asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "option_set",
        "option_set_version",
        "option",
        "option_conflict",
        "option_set_operation_record",
        "option_set_draft_content_snapshot",
      ].filter((t) => t !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-option-store.ts" : "option-set-full-draft-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  for (const source of [
    {
      layer: "RMS",
      owner: "catalog",
      schema: "rms_catalog",
      path: "option-set-history-store.ts",
      tables: [
        "option_set",
        "option_set_version",
        "option_set_operation_record",
        "option_set_draft_content_snapshot",
        "option_set_publication_content",
      ],
    },
    {
      layer: "BOP",
      owner: "publishing",
      schema: "bop_publishing",
      path: "option-set-publication-history-store.ts",
      tables: ["publishing_mutation_record"],
    },
  ]) {
    it.each(["valid", "owner", "schema", "driver", "path", ...source.tables])(
      "bounds exact history owning asset " + source.owner + ": %s",
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          source.layer,
          changed === "owner" ? "other-owner" : source.owner,
          changed === "schema" ? "other_schema" : source.schema,
          source.tables.filter((table) => table !== changed),
        );
        const asset = join(
          context.moduleRoot,
          "src/infrastructure/persistence/",
          changed === "path" ? "other-history.ts" : source.path,
        );
        await mkdir(dirname(asset), { recursive: true });
        await writeFile(
          asset,
          changed === "driver"
            ? 'import pg from "pg"; export {pg};\n'
            : "export const synthetic=true;\n",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }
  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "option_set_review_content",
    "option_set_publication_release",
    "option_set_draft_content_snapshot",
    "option_set_publication_content",
  ])("bounds Option review/release owning asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "option_set_review_content",
        "option_set_publication_release",
        "option_set_draft_content_snapshot",
        "option_set_publication_content",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-option-store.ts" : "option-set-review-content-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "option_set",
    "option_set_version",
    "option",
    "option_conflict",
    "product_option_binding",
  ])("bounds Option List owning reader asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "option_set",
        "option_set_version",
        "option",
        "option_conflict",
        "product_option_binding",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-option-list.ts" : "option-set-list-query-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  describe.each(["option-set-authoring-resolution-store.ts", "option-set-authoring-identity.ts"])(
    "Option authoring source %s",
    (assetName) => {
      it.each([
        "valid",
        "owner",
        "schema",
        "driver",
        "path",
        "option_set_authoring_identity",
        "option_set_authoring_abandonment",
        "option_set_draft_content_snapshot",
        "option_set_operation_record",
      ])("bounds Option authoring recovery owning asset: %s", async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "RMS",
          changed === "owner" ? "other-owner" : "catalog",
          changed === "schema" ? "rms_other" : "rms_catalog",
          [
            "option_set_authoring_identity",
            "option_set_authoring_abandonment",
            "option_set_draft_content_snapshot",
            "option_set_operation_record",
          ].filter((table) => table !== changed),
        );
        const asset = join(
          context.moduleRoot,
          "src/infrastructure/persistence/",
          changed === "path" ? "other-option-store.ts" : assetName,
        );
        await mkdir(dirname(asset), { recursive: true });
        await writeFile(
          asset,
          changed === "driver"
            ? 'import pg from "pg"; export {pg};\n'
            : "export const synthetic=true;\n",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      });
    },
  );
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "allergen_registry_version",
    "allergen_registry_entry",
  ])("bounds Product editor allergen reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      ["allergen_registry_version", "allergen_registry_entry"].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path"
        ? "other-editor-allergen-source.ts"
        : "product-editor-allergen-registry-source.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(
    ["content", "tax-classification"].flatMap((kind) =>
      ["valid", "owner", "schema", "path", "driver", "table"].map((changed) => [kind, changed]),
    ),
  )("bounds WP-2421 %s registry asset: %s", async (kind, changed) => {
    const root = await fixture();
    const table =
      kind === "content"
        ? "product_content_registry_record"
        : "product_tax_classification_registry_record";
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      changed === "table" ? [] : [table],
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-registry-store.ts" : `product-${kind}-registry-store.ts`,
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export {pg};\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "menu_reference_generation",
    "menu_review_content",
    "menu_publication_revision",
    "menu_publication_release",
    "menu_release_effective_period",
  ])("bounds WP-2415 Menu source asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "menu_reference_generation",
        "menu_review_content",
        "menu_publication_revision",
        "menu_publication_release",
        "menu_release_effective_period",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "menu-reference-source-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "bundle_reference_generation",
    "bundle",
    "bundle_version",
    "bundle_component_group",
    "bundle_component_sellable",
  ])("bounds WP-2414 Bundle source asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "bundle_reference_generation",
        "bundle",
        "bundle_version",
        "bundle_component_group",
        "bundle_component_sellable",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "bundle-reference-source-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic=true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "availability_rule",
    "availability_reference_generation",
  ])("bounds WP-2413 Availability source asset: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      ["availability_rule", "availability_reference_generation"].filter(
        (table) => table !== changed,
      ),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "availability-reference-source-store.ts",
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
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

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "menu_publication_revision",
    "menu_publication_release",
    "menu_release_effective_period",
    "menu_version_store",
    "menu_version_channel",
    "menu_version_order_type",
  ])("bounds WP-2402 current menu release reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "menu_publication_revision",
        "menu_publication_release",
        "menu_release_effective_period",
        "menu_version_store",
        "menu_version_channel",
        "menu_version_order_type",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "current-menu-release-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "menu",
    "menu_version",
    "menu_section",
    "sellable_placement",
    "sku",
  ])("bounds WP-2402 current menu placement reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      ["menu", "menu_version", "menu_section", "sellable_placement", "sku"].filter(
        (table) => table !== changed,
      ),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "current-menu-placement-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "availability_rule",
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "menu_publication_revision",
    "menu_publication_release",
    "menu_release_effective_period",
    "menu_version_store",
    "menu_version_channel",
    "menu_version_order_type",
    "published_menu_projection_generation",
    "published_menu_projection",
    "published_menu_projection_section",
    "published_menu_projection_sellable",
    "published_menu_projection_checkpoint",
    "product",
    "product_version",
    "sku",
    "option_set",
    "option_set_version",
    "option",
    "option_conflict",
    "product_option_binding",
    "product_option_binding_option",
    "product_option_binding_sku_scope",
    "product_option_binding_channel",
  ])("bounds WP-2402 coherent selection facts reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "availability_rule",
        "menu_publication_revision",
        "menu_publication_release",
        "menu_release_effective_period",
        "menu_version_store",
        "menu_version_channel",
        "menu_version_order_type",
        "published_menu_projection_generation",
        "published_menu_projection",
        "published_menu_projection_section",
        "published_menu_projection_sellable",
        "published_menu_projection_checkpoint",
        "product",
        "product_version",
        "sku",
        "option_set",
        "option_set_version",
        "option",
        "option_conflict",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "current-selection-facts-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["valid", "owner", "schema", "driver", "path", "kill_switch_version"])(
    "bounds WP-2402 Kill Switch reader admission: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "feature-control",
        changed === "schema" ? "rms_other" : "bop_feature_control",
        ["kill_switch_version"].filter((table) => table !== changed),
      );
      const asset = join(
        context.moduleRoot,
        "src/infrastructure/persistence/",
        changed === "path" ? "other-store.ts" : "kill-switch-query-store.ts",
      );
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(
        asset,
        changed === "driver"
          ? 'import pg from "pg"; export { pg };\n'
          : "export const synthetic = true;\n",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each(["valid", "owner", "schema", "driver", "path", "control_version", "control_dependency"])(
    "bounds WP-2406 administration reader admission: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "feature-control",
        changed === "schema" ? "rms_other" : "bop_feature_control",
        ["control_version", "control_dependency"].filter((table) => table !== changed),
      );
      const asset = join(
        context.moduleRoot,
        "src/infrastructure/persistence/",
        changed === "path" ? "other-store.ts" : "administration-query-store.ts",
      );
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(
        asset,
        changed === "driver"
          ? 'import pg from "pg"; export { pg };\n'
          : "export const synthetic = true;\n",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each(["valid", "owner", "schema", "driver", "path", "product", "product_version", "sku"])(
    "bounds WP-2402 current SKU reader admission: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "catalog",
        changed === "schema" ? "rms_other" : "rms_catalog",
        ["product", "product_version", "sku"].filter((table) => table !== changed),
      );
      const asset = join(
        context.moduleRoot,
        "src/infrastructure/persistence/",
        changed === "path" ? "other-store.ts" : "current-sku-store.ts",
      );
      await writeFile(
        asset,
        changed === "driver"
          ? 'import pg from "pg"; export { pg };\n'
          : "export const synthetic = true;\n",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "product_search_generation",
    "product_search_row",
    "product_search_activation",
    "product_source_head",
  ])("bounds WP-2407 Product list reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "product_search_generation",
        "product_search_row",
        "product_search_activation",
        "product_source_head",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "product-list-query-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "product_source_head",
    "product_source_commit",
    "product_operation_record",
  ])("bounds WP-2407 Product source producer admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      ["product_source_head", "product_source_commit", "product_operation_record"].filter(
        (table) => table !== changed,
      ),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "product-source-producer.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "product",
    "product_version",
    "product_version_category_assignment",
    "sku",
    "product_source_head",
    "product_source_commit",
    "product_operation_snapshot",
    "product_option_binding",
    "product_option_binding_option",
    "product_option_binding_sku_scope",
    "product_option_binding_channel",
    "product_search_generation",
    "product_search_row",
    "product_search_activation",
  ])("bounds WP-2407 Product generation builder admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "product",
        "product_version",
        "product_version_category_assignment",
        "sku",
        "product_source_head",
        "product_source_commit",
        "product_operation_snapshot",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_search_generation",
        "product_search_row",
        "product_search_activation",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "product-search-generation-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "driver",
    "path",
    "sku",
    "product_version",
    "option_set",
    "option_set_version",
    "option",
    "option_conflict",
    "product_option_binding",
    "product_option_binding_option",
    "product_option_binding_sku_scope",
    "product_option_binding_channel",
  ])("bounds WP-2402 current option binding reader admission: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "sku",
        "product_version",
        "option_set",
        "option_set_version",
        "option",
        "option_conflict",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
      ].filter((table) => table !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/",
      changed === "path" ? "other-store.ts" : "current-option-bindings-store.ts",
    );
    await writeFile(
      asset,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };\n'
        : "export const synthetic = true;\n",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("accepts only the WP-2334 Catalog availability reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "catalog", "rms_catalog", ["availability_rule"]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/availability-query-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "table"])(
    "does not transfer WP-2334 admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "catalog",
        changed === "schema" ? "rms_other" : "rms_catalog",
        changed === "table" ? ["other_table"] : ["availability_rule"],
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/availability-query-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2347 Fulfillment capacity writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_hold",
      "capacity_allocation_terminal",
      "capacity_allocation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/capacity-allocation-terminal-store.ts",
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
    "capacity_slot",
    "capacity_hold",
    "capacity_allocation_terminal",
    "capacity_allocation",
  ])("does not transfer WP-2347 writer admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      [
        "capacity_slot",
        "capacity_hold",
        "capacity_allocation_terminal",
        "capacity_allocation",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/capacity-allocation-terminal-store.ts",
      ),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2344 Fulfillment capacity writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_hold",
      "capacity_hold_terminal",
      "capacity_allocation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/capacity-hold-transition-store.ts",
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
    "capacity_slot",
    "capacity_hold",
    "capacity_hold_terminal",
    "capacity_allocation",
  ])("does not transfer WP-2344 writer admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      ["capacity_slot", "capacity_hold", "capacity_hold_terminal", "capacity_allocation"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/capacity-hold-transition-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2402 Fulfillment capacity writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_asap_commitment",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/asap-capacity-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "capacity_slot", "capacity_asap_commitment"])(
    "does not transfer WP-2402 writer admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "fulfillment",
        changed === "schema" ? "rms_other" : "rms_fulfillment",
        ["capacity_slot", "capacity_asap_commitment"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/asap-capacity-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2343 Fulfillment capacity writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_hold",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/capacity-hold-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "capacity_slot", "capacity_hold"])(
    "does not transfer WP-2343 writer admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "fulfillment",
        changed === "schema" ? "rms_other" : "rms_fulfillment",
        ["capacity_slot", "capacity_hold"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/capacity-hold-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2402 current Pickup Fulfillment capacity reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_slot_configuration",
      "capacity_asap_commitment",
      "capacity_hold",
      "capacity_hold_terminal",
      "capacity_allocation",
      "capacity_allocation_terminal",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/current-pickup-capacity-store.ts",
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
    "capacity_slot",
    "capacity_hold",
    "capacity_hold_terminal",
    "capacity_allocation",
    "capacity_allocation_terminal",
  ])(
    "does not transfer WP-2402 current Pickup reader admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "fulfillment",
        changed === "schema" ? "rms_other" : "rms_fulfillment",
        [
          "capacity_slot",
          "capacity_slot_configuration",
          "capacity_asap_commitment",
          "capacity_hold",
          "capacity_hold_terminal",
          "capacity_allocation",
          "capacity_allocation_terminal",
        ].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/current-pickup-capacity-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("accepts only the WP-2340 Fulfillment capacity reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "capacity_slot",
      "capacity_hold",
      "capacity_hold_terminal",
      "capacity_allocation",
      "capacity_allocation_terminal",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/capacity-query-store.ts",
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
    "capacity_slot",
    "capacity_hold",
    "capacity_hold_terminal",
    "capacity_allocation",
    "capacity_allocation_terminal",
  ])("does not transfer WP-2340 reader admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      [
        "capacity_slot",
        "capacity_hold",
        "capacity_hold_terminal",
        "capacity_allocation",
        "capacity_allocation_terminal",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/capacity-query-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2350 scoped Order reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_submission_record",
      "order_header",
      "order_batch",
      "order_item",
      "order_number_allocation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-creation-query-store.ts",
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
    "order_submission_record",
    "order_header",
    "order_batch",
    "order_item",
    "order_number_allocation",
  ])("does not transfer WP-2350 admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_submission_record",
        "order_header",
        "order_batch",
        "order_item",
        "order_number_allocation",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/order-creation-query-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("accepts only the WP-2352/2402 scoped Order writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "order_number_counter",
      "order_submission_record",
      "order_revision",
      "order_header",
      "order_batch",
      "order_item",
      "order_number_allocation",
      "order_capacity_link",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-creation-store.ts",
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
    "cart",
    "cart_line",
    "order_number_counter",
    "order_submission_record",
    "order_revision",
    "order_header",
    "order_batch",
    "order_item",
    "order_number_allocation",
    "order_capacity_link",
  ])("does not transfer WP-2352/2402 admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "cart",
        "cart_line",
        "order_number_counter",
        "order_submission_record",
        "order_revision",
        "order_header",
        "order_batch",
        "order_item",
        "order_number_allocation",
        "order_capacity_link",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/order-creation-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("accepts only the WP-2256 Pricing history reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "pricing", "rms_pricing", ["price_quote"]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/price-quote-query-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "table"])(
    "does not transfer WP-2256 admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "pricing",
        changed === "schema" ? "rms_other" : "rms_pricing",
        changed === "table" ? ["other_table"] : ["price_quote"],
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/price-quote-query-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2257 Pricing append adapter without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "pricing", "rms_pricing", [
      "price_quote",
      "price_quote_line",
      "price_quote_tax_line",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/price-quote-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "price_quote", "price_quote_line", "price_quote_tax_line"])(
    "does not transfer WP-2257 admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "pricing",
        changed === "schema" ? "rms_other" : "rms_pricing",
        ["price_quote", "price_quote_line", "price_quote_tax_line"].filter(
          (table) => table !== changed,
        ),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/price-quote-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2258 Pricing request adapter without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "pricing", "rms_pricing", [
      "price_quote_request",
      "price_quote",
      "price_quote_line",
      "price_quote_tax_line",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/price-quote-request-store.ts",
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
    "price_quote_request",
    "price_quote",
    "price_quote_line",
    "price_quote_tax_line",
  ])("does not transfer WP-2258 admission with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "pricing",
      changed === "schema" ? "rms_other" : "rms_pricing",
      ["price_quote_request", "price_quote", "price_quote_line", "price_quote_tax_line"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/price-quote-request-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the WP-2284 Move owner transaction without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_session_move_operation",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/dining-move-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "dining_table", "dining_session", "dining_session_move_operation"])(
    "rejects WP-2284 changed %s admission",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_table", "dining_session", "dining_session_move_operation"].filter(
          (table) => table !== changed,
        ),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-move-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the WP-2290 admission consumption owner without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_participant",
      "dining_identity_admission",
      "dining_session_join_operation",
      "dining_admission_consumption_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-admission-consumption-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_table",
    "dining_session",
    "dining_participant",
    "dining_identity_admission",
    "dining_session_join_operation",
    "dining_admission_consumption_operation",
  ])("rejects WP-2290 changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      [
        "dining_table",
        "dining_session",
        "dining_participant",
        "dining_identity_admission",
        "dining_session_join_operation",
        "dining_admission_consumption_operation",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/dining-admission-consumption-store.ts",
      ),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the WP-2286 moved Join owner transaction without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_session_move_operation",
      "dining_join_capability",
      "dining_join_regeneration_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-moved-join-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_table",
    "dining_session",
    "dining_session_move_operation",
    "dining_join_capability",
    "dining_join_regeneration_operation",
  ])("rejects WP-2286 changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      [
        "dining_table",
        "dining_session",
        "dining_session_move_operation",
        "dining_join_capability",
        "dining_join_regeneration_operation",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-moved-join-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the WP-2402 Dining commitment owner adapter without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_participant",
      "dining_checkout_commitment",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-checkout-commitment-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export { pg };');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_table",
    "dining_session",
    "dining_participant",
    "dining_checkout_commitment",
  ])("rejects WP-2402 changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      ["dining_table", "dining_session", "dining_participant", "dining_checkout_commitment"].filter(
        (t) => t !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/dining-checkout-commitment-store.ts",
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the Payment Intent owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_attempt",
      "payment_intent_operation_record",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-intent-creation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_intent",
    "payment_attempt",
    "payment_intent_operation_record",
    "payment_provider_observation",
  ])("rejects Payment Intent adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_intent",
        "payment_attempt",
        "payment_intent_operation_record",
        "payment_provider_observation",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-intent-creation-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment terminal source owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_attempt",
      "provider_webhook_record",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-terminal-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_intent",
    "payment_attempt",
    "provider_webhook_record",
    "payment_provider_observation",
  ])("rejects Payment terminal source adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_intent",
        "payment_attempt",
        "provider_webhook_record",
        "payment_provider_observation",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-terminal-source.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen routing configuration owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_routing_configuration",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-routing-configuration-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "kitchen_routing_configuration"])(
    "rejects Kitchen routing configuration with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "kitchen",
        changed === "schema" ? "rms_other" : "rms_kitchen",
        ["kitchen_routing_configuration"].filter((v) => v !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "kitchen-routing-configuration-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Ordering item inventory link reader without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_item",
      "order_batch",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-item-inventory-link-reader.ts",
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "order_item", "order_batch"])(
    "rejects the Ordering item inventory link reader with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["order_item", "order_batch"].filter((v) => v !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-item-inventory-link-reader.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Inventory stock place owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "inventory", "rms_inventory", [
      "stock_site",
      "stock_site_version",
      "storage_location",
      "storage_location_version",
      "stock_place_operation",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/stock-place-store.ts");
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "storage_location"])(
    "rejects the Inventory stock place store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "inventory",
        changed === "schema" ? "rms_other" : "rms_inventory",
        [
          "stock_site",
          "stock_site_version",
          "storage_location",
          "storage_location_version",
          "stock_place_operation",
        ].filter((v) => v !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "stock-place-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Inventory order-line consumption owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "inventory", "rms_inventory", [
      "stock_balance",
      "stock_reservation_version",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-line-consumption-store.ts",
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "stock_balance", "stock_reservation_version"])(
    "rejects the Inventory order-line consumption store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "inventory",
        changed === "schema" ? "rms_other" : "rms_inventory",
        ["stock_balance", "stock_reservation_version"].filter((v) => v !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-line-consumption-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Kitchen KDS operator shift owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kds_operator_shift_event",
      "kds_operator_handover",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kds-operator-shift-store.ts",
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "kds_operator_shift_event", "kds_operator_handover"])(
    "rejects the Kitchen KDS operator shift store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "kitchen",
        changed === "schema" ? "rms_other" : "rms_kitchen",
        ["kds_operator_shift_event", "kds_operator_handover"].filter((v) => v !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "kds-operator-shift-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Fulfillment readiness store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "fulfillment",
      "fulfillment_item",
      "fulfillment_creation_operation",
      "fulfillment_item_ready_result",
      "fulfillment_ready_operation",
      "pickup_handoff_record",
      "pickup_handoff_item",
      "pickup_handoff_operation",
      "pickup_proof_generation",
      "pickup_proof_invalidation",
      "pickup_proof_operation",
      "pickup_proof_verification",
      "pickup_in_person_verification",
      "pickup_not_collected_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/fulfillment-readiness-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "fulfillment",
    "fulfillment_item",
    "fulfillment_creation_operation",
    "fulfillment_item_ready_result",
    "fulfillment_ready_operation",
    "pickup_handoff_record",
    "pickup_handoff_item",
    "pickup_handoff_operation",
    "pickup_proof_generation",
    "pickup_proof_invalidation",
    "pickup_proof_operation",
    "pickup_proof_verification",
    "pickup_in_person_verification",
    "pickup_not_collected_record",
  ])("rejects Fulfillment readiness store with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      [
        "fulfillment",
        "fulfillment_item",
        "fulfillment_creation_operation",
        "fulfillment_item_ready_result",
        "fulfillment_ready_operation",
        "pickup_handoff_record",
        "pickup_handoff_item",
        "pickup_handoff_operation",
        "pickup_proof_generation",
        "pickup_proof_invalidation",
        "pickup_proof_operation",
        "pickup_proof_verification",
        "pickup_in_person_verification",
        "pickup_not_collected_record",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "fulfillment-readiness-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["pickup-proof-store.ts", "pickup-proof-history.ts", "pickup-proof-issuer.ts"])(
    "admits only Pickup proof owner asset %s",
    async (file) => {
      const root = await fixture();
      const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
        "fulfillment",
        "pickup_proof_generation",
        "pickup_proof_invalidation",
        "pickup_proof_operation",
        "pickup_proof_verification",
      ]);
      const asset = join(context.moduleRoot, "src/infrastructure/persistence", file);
      await writeFile(asset, "export const synthetic = true;");
      expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      await writeFile(asset, 'import pg from "pg"; export {pg};');
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each([
    "owner",
    "schema",
    "path",
    "fulfillment",
    "pickup_proof_generation",
    "pickup_proof_invalidation",
    "pickup_proof_operation",
    "pickup_proof_verification",
  ])("rejects Pickup proof owner asset with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      [
        "fulfillment",
        "pickup_proof_generation",
        "pickup_proof_invalidation",
        "pickup_proof_operation",
        "pickup_proof_verification",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other.ts" : "pickup-proof-store.ts",
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["pickup-handoff-store.ts", "pickup-handoff-history.ts"])(
    "admits only Pickup handoff owner asset %s",
    async (file) => {
      const root = await fixture();
      const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
        "fulfillment",
        "pickup_handoff_record",
        "pickup_handoff_item",
        "pickup_handoff_operation",
        "fulfillment_completion_publication",
        "pickup_in_person_verification",
        "pickup_not_collected_record",
      ]);
      const asset = join(context.moduleRoot, "src/infrastructure/persistence", file);
      await writeFile(asset, "export const synthetic = true;");
      expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      await writeFile(asset, 'import pg from "pg"; export {pg};');
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each([
    "owner",
    "schema",
    "path",
    "fulfillment",
    "pickup_handoff_record",
    "pickup_handoff_item",
    "pickup_handoff_operation",
    "fulfillment_completion_publication",
    "pickup_in_person_verification",
    "pickup_not_collected_record",
  ])("rejects Pickup handoff owner asset with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      [
        "fulfillment",
        "pickup_handoff_record",
        "pickup_handoff_item",
        "pickup_handoff_operation",
        "fulfillment_completion_publication",
        "pickup_in_person_verification",
        "pickup_not_collected_record",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other.ts" : "pickup-handoff-store.ts",
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Fulfillment completion publication owner asset", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "fulfillment_completion_publication",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/fulfillment-completion-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects Fulfillment completion publication with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "fulfillment",
        changed === "schema" ? "rms_other" : "rms_fulfillment",
        changed === "table" ? [] : ["fulfillment_completion_publication"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other.ts" : "fulfillment-completion-store.ts",
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Pickup fulfillment store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "fulfillment", "rms_fulfillment", [
      "fulfillment",
      "fulfillment_item",
      "fulfillment_creation_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/pickup-fulfillment-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "fulfillment",
    "fulfillment_item",
    "fulfillment_creation_operation",
  ])("rejects Pickup fulfillment store with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "fulfillment",
      changed === "schema" ? "rms_other" : "rms_fulfillment",
      ["fulfillment", "fulfillment_item", "fulfillment_creation_operation"].filter(
        (v) => v !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "pickup-fulfillment-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen lifecycle rows owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_work_lifecycle_operation",
      "kitchen_order_item_ready_result",
      "kitchen_ready_publication",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-work-lifecycle-rows.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_work_lifecycle_operation",
    "kitchen_order_item_ready_result",
    "kitchen_ready_publication",
  ])("rejects Kitchen lifecycle rows with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      [
        "kitchen_work_lifecycle_operation",
        "kitchen_order_item_ready_result",
        "kitchen_ready_publication",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-work-lifecycle-rows.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen queue query owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_work_queue_projection",
      "kitchen_work_queue_projection_generation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-queue-queries.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_work_queue_projection",
    "kitchen_work_queue_projection_generation",
  ])("rejects Kitchen queue query asset with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      ["kitchen_work_queue_projection", "kitchen_work_queue_projection_generation"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-queue-queries.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen queue store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_work_queue_projection",
      "kitchen_work_queue_projection_generation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-queue-projection-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_work_queue_projection",
    "kitchen_work_queue_projection_generation",
  ])("rejects Kitchen queue store asset with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      ["kitchen_work_queue_projection", "kitchen_work_queue_projection_generation"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-queue-projection-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen queue source owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_ticket",
      "kitchen_work_item",
      "kitchen_creation_record",
      "kitchen_work_lifecycle_operation",
      "kitchen_order_item_ready_result",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-queue-source-reader.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_ticket",
    "kitchen_work_item",
    "kitchen_creation_record",
    "kitchen_work_lifecycle_operation",
    "kitchen_order_item_ready_result",
  ])("rejects Kitchen queue source asset with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      [
        "kitchen_ticket",
        "kitchen_work_item",
        "kitchen_creation_record",
        "kitchen_work_lifecycle_operation",
        "kitchen_order_item_ready_result",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-queue-source-reader.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen lifecycle store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_ticket",
      "kitchen_work_item",
      "kitchen_work_lifecycle_operation",
      "kitchen_order_item_ready_result",
      "kitchen_ready_publication",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-work-lifecycle-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_ticket",
    "kitchen_work_item",
    "kitchen_work_lifecycle_operation",
    "kitchen_order_item_ready_result",
    "kitchen_ready_publication",
  ])("rejects Kitchen lifecycle store with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      [
        "kitchen_ticket",
        "kitchen_work_item",
        "kitchen_work_lifecycle_operation",
        "kitchen_order_item_ready_result",
        "kitchen_ready_publication",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-work-lifecycle-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "recipe",
    "recipe_version",
    "recipe_scope_binding",
    "recipe_modifier_version",
    "recipe_reference_generation",
    "recipe_reference_binding",
  ])("keeps Recipe Catalog reference admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe",
        "recipe_version",
        "recipe_scope_binding",
        "recipe_modifier_version",
        "recipe_reference_generation",
        "recipe_reference_binding",
      ].filter((t) => t !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "recipe-reference-source-store.ts"),
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "recipe",
    "recipe_version",
    "recipe_ingredient_requirement",
    "recipe_modifier_version",
    "recipe_reference_generation",
  ])("keeps Recipe Inventory reference admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe",
        "recipe_version",
        "recipe_ingredient_requirement",
        "recipe_modifier_version",
        "recipe_reference_generation",
      ].filter((t) => t !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "recipe-inventory-reference-source-store.ts"),
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "inventory_item",
    "inventory_item_version",
    "inventory_item_operation",
    "configuration_reference_generation",
  ])("keeps Inventory configuration reference admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      [
        "inventory_item",
        "inventory_item_version",
        "inventory_item_operation",
        "configuration_reference_generation",
      ].filter((t) => t !== changed),
    );
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "configuration-reference-source-store.ts"),
    );
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(
      asset,
      changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  describe.each(["inventory-sku-mapping-store.ts", "sku-mapping-reference-source-store.ts"])(
    "exact Inventory mapping asset %s",
    (assetName) => {
      it.each([
        "valid",
        "owner",
        "schema",
        "path",
        "driver",
        "inventory_item",
        "inventory_item_version",
        "inventory_item_operation",
        "item_sku_mapping_version",
        "configuration_reference_generation",
      ])("keeps admission bounded: %s", async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "RMS",
          changed === "owner" ? "other" : "inventory",
          changed === "schema" ? "rms_other" : "rms_inventory",
          [
            "inventory_item",
            "inventory_item_version",
            "inventory_item_operation",
            "item_sku_mapping_version",
            "configuration_reference_generation",
          ].filter((table) => table !== changed),
        );
        const asset = join(
          context.moduleRoot,
          "src/infrastructure/persistence/" + (changed === "path" ? "other.ts" : assetName),
        );
        await mkdir(dirname(asset), { recursive: true });
        await writeFile(
          asset,
          changed === "driver"
            ? 'import pg from "pg"; export {pg};'
            : "export const synthetic = true;",
        );
        const codes = await resultCodes(root);
        if (
          changed === "valid" ||
          (assetName === "inventory-sku-mapping-store.ts" &&
            changed === "configuration_reference_generation")
        )
          expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      });
    },
  );
  it("admits only the Recipe preparation content owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "recipe", "rms_recipe", [
      "recipe",
      "recipe_version",
      "recipe_operation_record",
      "recipe_modifier_version",
      "recipe_preparation_content",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/recipe-preparation-content-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "recipe",
    "recipe_version",
    "recipe_operation_record",
    "recipe_modifier_version",
    "recipe_preparation_content",
  ])("rejects Recipe preparation content with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe",
        "recipe_version",
        "recipe_operation_record",
        "recipe_modifier_version",
        "recipe_preparation_content",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "recipe-preparation-content-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Kitchen ticket owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "kitchen", "rms_kitchen", [
      "kitchen_ticket",
      "kitchen_work_item",
      "kitchen_action_record",
      "kitchen_creation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/kitchen-ticket-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "kitchen_ticket",
    "kitchen_work_item",
    "kitchen_action_record",
    "kitchen_creation_record",
  ])("rejects Kitchen ticket with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "kitchen",
      changed === "schema" ? "rms_other" : "rms_kitchen",
      [
        "kitchen_ticket",
        "kitchen_work_item",
        "kitchen_action_record",
        "kitchen_creation_record",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "kitchen-ticket-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering fulfillment source owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_payment_disposition_record",
      "order_header",
      "order_batch",
      "order_item",
      "order_submission_record",
      "order_acceptance_record",
      "order_termination_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-fulfillment-source-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_payment_disposition_record",
    "order_header",
    "order_batch",
    "order_item",
    "order_submission_record",
    "order_acceptance_record",
    "order_termination_record",
  ])("rejects Ordering fulfillment source with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_payment_disposition_record",
        "order_header",
        "order_batch",
        "order_item",
        "order_submission_record",
        "order_acceptance_record",
        "order_termination_record",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-fulfillment-source-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering Kitchen source owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_payment_disposition_record",
      "order_header",
      "order_batch",
      "order_item",
      "order_submission_record",
      "order_acceptance_record",
      "order_termination_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-kitchen-source-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_payment_disposition_record",
    "order_header",
    "order_batch",
    "order_item",
    "order_submission_record",
    "order_acceptance_record",
    "order_termination_record",
  ])("rejects Ordering Kitchen source with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_payment_disposition_record",
        "order_header",
        "order_batch",
        "order_item",
        "order_submission_record",
        "order_acceptance_record",
        "order_termination_record",
      ].filter((v) => v !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-kitchen-source-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering acceptance owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_termination_record",
      "order_revision",
      "order_acceptance_record",
      "order_batch",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-acceptance-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_acceptance_record",
    "order_batch",
    "order_termination_record",
    "order_revision",
  ])("rejects Ordering acceptance adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_acceptance_record",
        "order_batch",
        "order_termination_record",
        "order_revision",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-acceptance-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering termination owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_termination_record",
      "order_revision",
      "order_fulfillment_completion_record",
      "order_header",
      "order_acceptance_record",
      "order_batch",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-termination-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_acceptance_record",
    "order_batch",
    "order_termination_record",
    "order_revision",
    "order_fulfillment_completion_record",
    "order_header",
  ])("rejects Ordering termination adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_acceptance_record",
        "order_batch",
        "order_termination_record",
        "order_revision",
        "order_fulfillment_completion_record",
        "order_header",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-termination-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the receipt template store owner without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "printing-device", "rms_device", [
      "digital_receipt_template_version",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/digital-receipt-template-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects receipt template store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "printing-device",
        changed === "schema" ? "rms_other" : "rms_device",
        changed === "table" ? [] : ["digital_receipt_template_version"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other.ts" : "digital-receipt-template-store.ts",
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Ordering receipt order source without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_header",
      "order_submission_record",
      "order_batch",
      "order_item",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/receipt-order-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_header",
    "order_submission_record",
    "order_batch",
    "order_item",
  ])("rejects receipt order source with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["order_header", "order_submission_record", "order_batch", "order_item"].filter(
        (table) => table !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other.ts" : "receipt-order-source.ts",
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering digital receipt owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "digital_receipt_record",
      "order_header",
      "order_submission_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/digital-receipt-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "digital_receipt_record",
    "order_header",
    "order_submission_record",
  ])("rejects Ordering digital receipt adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["digital_receipt_record", "order_header", "order_submission_record"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "digital-receipt-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Operating Entity receipt issuer owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "operating-entity", "bop_operating_entity", [
      "store_operating_entity_assignment",
      "operating_entity",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/receipt-issuer-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "store_operating_entity_assignment", "operating_entity"])(
    "rejects Operating Entity receipt issuer adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other" : "operating-entity",
        changed === "schema" ? "bop_other" : "bop_operating_entity",
        ["store_operating_entity_assignment", "operating_entity"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "receipt-issuer-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Operating Entity TaxRegistrant owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "operating-entity", "bop_operating_entity", [
      "store_operating_entity_assignment",
      "operating_entity",
      "operating_entity_profile_version",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/tax-registrant-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "store_operating_entity_assignment",
    "operating_entity",
    "operating_entity_profile_version",
  ])("rejects Operating Entity TaxRegistrant adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "operating-entity",
      changed === "schema" ? "bop_other" : "bop_operating_entity",
      [
        "store_operating_entity_assignment",
        "operating_entity",
        "operating_entity_profile_version",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "tax-registrant-source.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Tenant receipt Store identity adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "tenant", "bop_tenant", ["store"]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/receipt-store-identity-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "store"])(
    "rejects receipt Store identity adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other" : "tenant",
        changed === "schema" ? "bop_other" : "bop_tenant",
        changed === "store" ? [] : ["store"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "receipt-store-identity-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment compensation operations owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_operations",
      "payment_compensation_case_history",
      "payment_compensation_refund",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-operations-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_compensation_operations",
    "payment_compensation_case_history",
    "payment_compensation_refund",
  ])("rejects Payment compensation operations adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_compensation_operations",
        "payment_compensation_case_history",
        "payment_compensation_refund",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-operations-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation evidence owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_operations",
      "payment_compensation_refund",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-evidence-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_compensation_operations",
    "payment_compensation_refund",
  ])("rejects Payment compensation evidence adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["payment_compensation_operations", "payment_compensation_refund"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-evidence-source.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation provider evidence owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_provider_observation",
      "payment_intent",
      "payment_attempt",
      "payment_terminal_fact",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-provider-evidence.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_provider_observation",
    "payment_intent",
    "payment_attempt",
    "payment_terminal_fact",
  ])("rejects Payment compensation provider evidence adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_provider_observation",
        "payment_intent",
        "payment_attempt",
        "payment_terminal_fact",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-provider-evidence.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation position owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_action_history",
      "payment_compensation_refund",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-refund-position-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_compensation_action_history",
    "payment_compensation_refund",
  ])("rejects Payment compensation position adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["payment_compensation_action_history", "payment_compensation_refund"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-refund-position-source.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation source owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_intent", "payment_provider_observation"])(
    "rejects Payment compensation source adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_intent", "payment_provider_observation"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-compensation-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment compensation refund owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_case_history",
      "payment_compensation_refund",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-refund-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_compensation_case_history",
    "payment_compensation_refund",
  ])("rejects Payment compensation refund adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["payment_compensation_case_history", "payment_compensation_refund"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-refund-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation action owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_case_history",
      "payment_compensation_action_history",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-action-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_compensation_case_history",
    "payment_compensation_action_history",
  ])("rejects Payment compensation action adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["payment_compensation_case_history", "payment_compensation_action_history"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-compensation-action-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation case owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_case_history",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-case-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_compensation_case_history"])(
    "rejects Payment compensation case adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_compensation_case_history"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-compensation-case-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Provider capture exception owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "provider_capture_exception_evidence",
      "payment_reconciliation_exception",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/provider-capture-exception-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "provider_capture_exception_evidence",
    "payment_reconciliation_exception",
  ])("rejects Provider capture exception adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["provider_capture_exception_evidence", "payment_reconciliation_exception"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "provider-capture-exception-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Reconciliation follow-up owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "reconciliation_follow_up_history",
      "payment_reconciliation_exception",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/reconciliation-follow-up-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "reconciliation_follow_up_history",
    "payment_reconciliation_exception",
  ])("rejects Reconciliation follow-up adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["reconciliation_follow_up_history", "payment_reconciliation_exception"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "reconciliation-follow-up-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the owning Media upload storage adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "media", "bop_media", [
      "upload_session",
      "asset",
      "asset_version",
      "operation_record",
    ]);
    const file = join(context.moduleRoot, "src/infrastructure/persistence/media-upload-store.ts");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(file, 'import pg from "pg"; export { pg };');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "asset",
    "asset_version",
    "image_processing_intent",
    "image_processing_completion",
    "image_rendition",
    "image_scan_admission",
    "upload_object_binding",
  ])("bounds the owning Media publication reader: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      [
        "asset",
        "asset_version",
        "image_processing_intent",
        "image_processing_completion",
        "image_rendition",
        "image_scan_admission",
        "upload_object_binding",
      ].filter((table) => table !== changed),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other-publication-read.ts" : "media-publication-read-store.ts"),
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };'
        : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "image_scan_admission",
    "image_processing_intent",
  ])("bounds the owning Media scan admission store: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      ["image_scan_admission", "image_processing_intent"].filter((table) => table !== changed),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other-scan-admission.ts" : "media-image-scan-admission-store.ts"),
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };'
        : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "driver",
    "query",
    "query-alias",
    "computed-query",
    "sql",
    "image_scan_admission",
    "image_processing_intent",
    "image_processing_completion",
  ])("bounds the SQL-free Media Worker composition: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      ["image_scan_admission", "image_processing_intent", "image_processing_completion"].filter(
        (table) => table !== changed,
      ),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other-worker-runtime.ts" : "media-image-worker-runtime.ts"),
    );
    await mkdir(dirname(file), { recursive: true });
    const mutations = {
      driver: 'import pg from "pg"; export { pg };',
      query: "export const run = (tx, text) => tx.query(text, []);",
      "query-alias":
        "export const run = (tx, text) => { const { query: send } = tx; return send(text, []); };",
      "computed-query": 'export const run = (tx, text) => tx["query"](text, []);',
      sql: 'export const sql = "SELECT * FROM bop_media.image_scan_admission";',
    };
    await writeFile(file, mutations[changed] ?? "export const synthetic = true;");
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(
    [
      [
        "store",
        [
          "asset",
          "asset_version",
          "image_processing_intent",
          "image_processing_completion",
          "image_rendition",
        ],
      ],
      [
        "source",
        [
          "upload_session",
          "asset",
          "asset_version",
          "operation_record",
          "upload_object_binding",
          "finalized_object_binding",
        ],
      ],
      [
        "transaction",
        ["image_processing_intent", "image_processing_completion", "image_rendition"],
      ],
    ].flatMap(([kind, tables]) =>
      ["valid", "owner", "schema", "path", "driver", ...tables].map((changed) => [
        kind,
        tables,
        changed,
      ]),
    ),
  )("bounds owning Media image processing %s: %s %s", async (kind, tables, changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      tables.filter((table) => table !== changed),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other-image-processing.ts" : `media-image-processing-${kind}.ts`),
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      changed === "driver"
        ? 'import pg from "pg"; export { pg };'
        : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the owning Media S3 object binding runtime without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "media", "bop_media", [
      "upload_session",
      "operation_record",
      "upload_object_binding",
      "finalized_object_binding",
    ]);
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/s3-image-upload-runtime.ts",
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(file, 'import pg from "pg"; export { pg };');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "upload_session",
    "operation_record",
    "upload_object_binding",
    "finalized_object_binding",
  ])("rejects Media object binding runtime with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      [
        "upload_session",
        "operation_record",
        "upload_object_binding",
        "finalized_object_binding",
      ].filter((table) => table !== changed),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "s3-image-upload-runtime.ts"),
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export const synthetic = true;");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "upload_session",
    "asset",
    "asset_version",
    "operation_record",
  ])("rejects Media upload storage with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other" : "media",
      changed === "schema" ? "bop_other" : "bop_media",
      ["upload_session", "asset", "asset_version", "operation_record"].filter(
        (table) => table !== changed,
      ),
    );
    const file = join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "media-upload-store.ts"),
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export const synthetic = true;");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment compensation operation owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_operation_history",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-operation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_compensation_operation_history"])(
    "rejects Payment compensation operation adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_compensation_operation_history"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-compensation-operation-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment compensation lease owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_lease_history",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-lease-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_compensation_lease_history"])(
    "rejects Payment compensation lease adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_compensation_lease_history"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-compensation-lease-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment receipt coverage owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-receipt-coverage-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_intent", "payment_provider_observation"])(
    "rejects Payment receipt coverage adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_intent", "payment_provider_observation"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-receipt-coverage-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each([
    [
      "price-book-repository.ts",
      "pricing",
      ["price_book", "price_book_version", "price_entry", "price_book_operation_record"],
    ],
    [
      "product-publication-validation-report-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_version_category_assignment",
        "product_publication_revision",
        "product_publication_validation_report",
        "product_publication_content",
        "product_operation_record",
        "product_operation_snapshot",
        "product_source_commit",
        "product_source_head",
        "product_scope_retirement_header",
        "product_scope_retirement",
        "product_approval_receipt",
      ],
    ],
    [
      "product-publication-validation-report-store.ts",
      "catalog",
      ["product_publication_revision", "product_publication_validation_report"],
    ],
    [
      "product-publication-warning-acknowledgement-record.ts",
      "catalog",
      ["product_publication_warning_acknowledgement"],
    ],
    [
      "product-publication-resolution-store.ts",
      "catalog",
      [
        "product",
        "product_operation_record",
        "product_operation_snapshot",
        "product_publication_revision",
        "product_publication_operation_abandonment",
      ],
    ],
    [
      "product-publication-warning-acknowledgement-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "product_publication_revision",
        "product_publication_validation_report",
        "product_publication_warning_acknowledgement",
      ],
    ],
    [
      "product-scope-retirement-store.ts",
      "catalog",
      [
        "product",
        "product_publication_revision",
        "product_publication_content",
        "product_operation_record",
        "product_operation_snapshot",
        "product_source_commit",
        "product_source_head",
        "product_scope_retirement_header",
        "product_scope_retirement",
        "product_approval_receipt",
      ],
    ],
    [
      "merchant-order-item-labels.ts",
      "ordering",
      ["order_item", "order_batch", "order_submission_record", "additional_dining_batch_record"],
    ],
    [
      "merchant-order-index.ts",
      "ordering",
      ["order_header", "order_submission_record", "order_batch"],
    ],
    [
      "order-batch-identity-source.ts",
      "ordering",
      ["order_header", "order_submission_record", "order_batch"],
    ],
    ["payment-intent-binding-source.ts", "payment", ["payment_intent"]],
    ["captured-batch-payment-source.ts", "payment", ["payment_intent", "payment_terminal_fact"]],
    [
      "allergen-review-facts-store.ts",
      "catalog",
      [
        "allergen_registry_version",
        "allergen_registry_entry",
        "allergen_source_evidence",
        "allergen_source_assertion",
      ],
    ],
    ["menu-review-product-source.ts", "catalog", ["sku", "product", "product_version"]],
    [
      "menu-review-option-source.ts",
      "catalog",
      [
        "sku",
        "product_version",
        "option_set",
        "option_set_version",
        "option",
        "option_conflict",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
      ],
    ],
    ["menu-publication-evidence-source.ts", "catalog", []],
    [
      "menu-review-content-store.ts",
      "catalog",
      ["menu_review_content", "menu_publication_release", "menu_publication_operation_snapshot"],
    ],
    [
      "menu-publication-repository.ts",
      "catalog",
      [
        "menu_publication_revision",
        "menu_publication_release",
        "menu_release_effective_period",
        "menu_publication_operation_record",
        "menu_publication_operation_snapshot",
      ],
    ],
    [
      "product-reference-history-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "product_operation_record",
        "product_operation_snapshot",
        "product_publication_revision",
        "product_source_commit",
      ],
    ],
    [
      "inventory-sku-reference-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_version_category_assignment",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_source_head",
      ],
    ],
    [
      "product-pricing-binding-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_version_category_assignment",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
      ],
    ],
    [
      "promotion-reference-source-store.ts",
      "pricing",
      ["promotion", "promotion_version", "promotion_eligibility_reference"],
    ],
    [
      "tax-configuration-reference-source-store.ts",
      "pricing",
      ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"],
    ],
    [
      "option-price-reference-source-store.ts",
      "pricing",
      ["option_price_rule", "option_price_rule_version"],
    ],
    [
      "tax-config-authoring-store.ts",
      "pricing",
      [
        "tax_configuration",
        "tax_configuration_version",
        "tax_configuration_rule",
        "tax_configuration_operation_record",
        "tax_config_authoring_operation",
      ],
    ],
    [
      "tax-config-candidate-store.ts",
      "pricing",
      [
        "tax_config_publication_candidate",
        "tax_config_candidate_rule",
        "tax_config_candidate_operation",
      ],
    ],
    [
      "tax-config-material-store.ts",
      "pricing",
      ["tax_config_material", "tax_config_material_version", "tax_config_material_operation"],
    ],
    [
      "option-price-authoring-store.ts",
      "pricing",
      ["option_price_rule", "option_price_rule_version", "option_price_authoring_operation"],
    ],
    [
      "price-book-reference-source-store.ts",
      "pricing",
      ["price_book", "price_book_version", "price_entry"],
    ],
    [
      "product-menu-source-store.ts",
      "catalog",
      [
        "product",
        "sku",
        "product_version",
        "menu_review_content",
        "menu_publication_revision",
        "menu_publication_release",
        "menu_release_effective_period",
      ],
    ],
    [
      "product-bundle-source-store.ts",
      "catalog",
      [
        "product",
        "sku",
        "bundle",
        "bundle_version",
        "bundle_component_group",
        "bundle_component_sellable",
      ],
    ],
    ["product-availability-source-store.ts", "catalog", ["product", "sku", "availability_rule"]],
    [
      "menu-category-source-store.ts",
      "catalog",
      [
        "menu",
        "menu_version",
        "menu_section",
        "menu_section_category",
        "menu_review_content",
        "menu_publication_revision",
      ],
    ],
    [
      "menu-draft-source.ts",
      "catalog",
      [
        "menu",
        "menu_version",
        "menu_version_store",
        "menu_version_channel",
        "menu_version_order_type",
        "menu_section",
        "menu_section_category",
        "sellable_placement",
      ],
    ],
    [
      "menu-pricing-facts-source.ts",
      "catalog",
      [
        "menu",
        "menu_version",
        "menu_version_store",
        "menu_version_channel",
        "menu_version_order_type",
        "menu_section",
        "sellable_placement",
        "sku",
        "product",
        "product_version",
      ],
    ],
    [
      "category-repository.ts",
      "catalog",
      [
        "category",
        "category_operation_record",
        "category_operation_snapshot",
        "category_source_head",
        "category_source_commit",
      ],
    ],
    [
      "category-source-store.ts",
      "catalog",
      [
        "category",
        "category_operation_record",
        "category_operation_snapshot",
        "category_source_head",
        "category_source_commit",
      ],
    ],
    [
      "category-source-consumer.ts",
      "catalog",
      [
        "category",
        "category_operation_record",
        "category_operation_snapshot",
        "category_source_head",
        "category_source_commit",
      ],
    ],
    [
      "product-option-price-context-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_version_category_assignment",
      ],
    ],
    [
      "product-editor-source-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_version_category_assignment",
        "product_source_head",
      ],
    ],
    [
      "product-whole-scope-replacement-store.ts",
      "catalog",
      [
        "product",
        "product_publication_revision",
        "product_scope_journal",
        "product_source_head",
        "product_source_commit",
        "product_operation_record",
        "product_operation_snapshot",
      ],
    ],
    [
      "product-lifecycle-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "product_version_category_assignment",
        "sku",
        "product_operation_record",
        "product_operation_snapshot",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
        "product_publication_revision",
        "product_source_head",
        "product_source_commit",
      ],
    ],
    [
      "product-draft-baseline-store.ts",
      "catalog",
      [
        "product",
        "product_version",
        "sku",
        "product_version_category_assignment",
        "product_option_binding",
        "product_option_binding_option",
        "product_option_binding_sku_scope",
        "product_option_binding_channel",
      ],
    ],
    [
      "product-category-assignment.ts",
      "catalog",
      ["category", "product_version", "product_version_category_assignment"],
    ],
  ])("checks pilot publication adapter %s", async (filename, owner, tables) => {
    for (const changed of ["valid", "owner", "schema", "path", ...tables]) {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : owner,
        changed === "schema" ? "rms_other" : "rms_" + owner,
        tables.filter((table) => table !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      const asset = join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other.ts" : filename,
      );
      await writeFile(asset, "export const synthetic = true;");
      if (changed === "valid") {
        expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        await writeFile(asset, 'import pg from "pg"; export {pg};');
        expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
      } else expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    }
  });
  it.each([
    [
      "order-submitted-consumer.ts",
      ["order_status_projection", "order_status_projection_generation"],
    ],
    [
      "order-submitted-history-source.ts",
      [
        "order_revision",
        "order_acceptance_record",
        "additional_dining_batch_record",
        "order_header",
        "order_submission_record",
        "order_batch",
        "order_item",
      ],
    ],
  ])("checks submitted owner adapter %s", async (filename, tables) => {
    for (const changed of ["valid", "owner", "schema", "path", ...tables]) {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        tables.filter((table) => table !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      const asset = join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other.ts" : filename,
      );
      await writeFile(asset, "export const synthetic = true;");
      if (changed === "valid") {
        expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        await writeFile(asset, 'import pg from "pg"; export {pg};');
        expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
      } else expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    }
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "path",
    "additional_dining_batch_record",
    "order_header",
    "order_revision",
    "order_batch",
    "order_item",
    "order_submission_record",
  ])("checks additional Dining Batch adapter boundary %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "additional_dining_batch_record",
        "order_header",
        "order_revision",
        "order_batch",
        "order_item",
        "order_submission_record",
      ].filter((table) => table !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence",
      changed === "path" ? "other.ts" : "additional-dining-batch-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    if (changed === "valid") {
      expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      await writeFile(asset, 'import pg from "pg"; export {pg};');
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    } else expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering fulfillment completion owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_fulfillment_completion_record",
      "order_header",
      "order_revision",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-fulfillment-completion-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_fulfillment_completion_record",
    "order_header",
    "order_revision",
  ])("rejects Ordering fulfillment completion adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["order_fulfillment_completion_record", "order_header", "order_revision"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-fulfillment-completion-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering status projection owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_status_projection",
      "order_status_projection_generation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-status-projection-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_status_projection",
    "order_status_projection_generation",
  ])("rejects Ordering status projection adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["order_status_projection", "order_status_projection_generation"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-status-projection-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering payment disposition owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_payment_disposition_record",
      "order_batch",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-payment-disposition-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "order_payment_disposition_record", "order_batch"])(
    "rejects Ordering payment disposition adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["order_payment_disposition_record", "order_batch"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-payment-disposition-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Ordering payment acceptance wait owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_payment_acceptance_wait",
      "order_payment_disposition_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-payment-acceptance-wait-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_payment_acceptance_wait",
    "order_payment_disposition_record",
  ])("rejects Ordering payment acceptance wait adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["order_payment_acceptance_wait", "order_payment_disposition_record"].filter(
        (t) => t !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "order-payment-acceptance-wait-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Task version store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "task", "bop_task", ["task_version"]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/task-store.ts");
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "task_version"])(
    "rejects Task version store adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other" : "task",
        changed === "schema" ? "bop_other" : "bop_task",
        ["task_version"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" + (changed === "path" ? "other.ts" : "task-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Dining exception task store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_exception_task",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-exception-task-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "dining_exception_task"])(
    "rejects Dining exception task store adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_exception_task"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "dining-exception-task-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Ordering Dining session lookup owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", ["order_header"]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-session-order-lookup.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "order_header"])(
    "rejects Ordering Dining session lookup adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["order_header"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "dining-session-order-lookup.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Ordering Dining session inventory owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_header",
      "order_batch",
      "order_submission_record",
      "order_amendment",
      "order_amendment_state_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-session-order-inventory.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "order_header",
    "order_batch",
    "order_submission_record",
    "order_amendment",
    "order_amendment_state_record",
  ])("rejects Ordering Dining session inventory adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "order_header",
        "order_batch",
        "order_submission_record",
        "order_amendment",
        "order_amendment_state_record",
      ].filter((t) => t !== changed),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "dining-session-order-inventory.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Ordering payment failure owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_payment_failure_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-payment-failure-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "order_payment_failure_record"])(
    "rejects Ordering payment failure adapter with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["order_payment_failure_record"].filter((t) => t !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-payment-failure-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment Provider observation owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_attempt",
      "payment_intent_operation_record",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-provider-observation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_intent",
    "payment_attempt",
    "payment_intent_operation_record",
    "payment_provider_observation",
  ])("rejects Payment Provider observation adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_intent",
        "payment_attempt",
        "payment_intent_operation_record",
        "payment_provider_observation",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-provider-observation-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment terminal store owner adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_attempt",
      "provider_webhook_record",
      "payment_terminal_fact",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-terminal-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_intent",
    "payment_attempt",
    "provider_webhook_record",
    "payment_terminal_fact",
    "payment_provider_observation",
  ])("rejects Payment terminal store adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      [
        "payment_intent",
        "payment_attempt",
        "provider_webhook_record",
        "payment_terminal_fact",
        "payment_provider_observation",
      ].filter((t) => t !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-terminal-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it("admits only the Payment tip owner store without a database driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_tip_selection",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-tip-selection-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export { pg };');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "table", "path"])(
    "rejects tip store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        [changed === "table" ? "other" : "payment_tip_selection"],
      );
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-tip-selection-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the WP-2282 Closing owner transaction without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_session",
      "dining_closing_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-closing-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "dining_session", "dining_closing_operation"])(
    "rejects WP-2282 changed %s admission",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_session", "dining_closing_operation"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-closing-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the WP-2402 Closing admission fence without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_closing_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-closing-fence.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "dining_table", "dining_session", "dining_closing_operation"])(
    "rejects WP-2402 changed %s admission",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_table", "dining_session", "dining_closing_operation"].filter(
          (table) => table !== changed,
        ),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-closing-fence.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the WP-2402 Table release owner store without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table_release_operation",
      "dining_table",
      "dining_session",
      "dining_closing_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-table-release-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_table_release_operation",
    "dining_table",
    "dining_session",
    "dining_closing_operation",
  ])("rejects WP-2402 release changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      [
        "dining_table_release_operation",
        "dining_table",
        "dining_session",
        "dining_closing_operation",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-table-release-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the WP-2402 Host transfer owner store without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_host_transfer_operation",
      "dining_table",
      "dining_session",
      "dining_participant",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-host-transfer-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_host_transfer_operation",
    "dining_table",
    "dining_session",
    "dining_participant",
  ])("rejects WP-2402 Host transfer changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      [
        "dining_host_transfer_operation",
        "dining_table",
        "dining_session",
        "dining_participant",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-host-transfer-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the WP-2280 owner participation reader without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_participant",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-participation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "dining_table", "dining_session", "dining_participant"])(
    "rejects WP-2280 changed %s admission",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_table", "dining_session", "dining_participant"].filter(
          (table) => table !== changed,
        ),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-participation-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the WP-2299 owner binding reader without driver access", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_participant",
      "dining_identity_admission",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-guest-binding-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "dining_table",
    "dining_session",
    "dining_participant",
    "dining_identity_admission",
  ])("rejects WP-2299 changed %s admission", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "dining",
      changed === "schema" ? "rms_other" : "rms_dining",
      ["dining_table", "dining_session", "dining_participant", "dining_identity_admission"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-guest-binding-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2278 Guest Join adapter without broadening driver admission", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_join_capability",
      "dining_participant",
      "dining_identity_admission",
      "dining_session_join_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-session-join-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "dining_table",
    "dining_session",
    "dining_join_capability",
    "dining_participant",
    "dining_identity_admission",
    "dining_session_join_operation",
  ])("rejects WP-2278 admission without %s ownership", async (missing) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      "dining",
      "rms_dining",
      [
        "dining_table",
        "dining_session",
        "dining_join_capability",
        "dining_participant",
        "dining_identity_admission",
        "dining_session_join_operation",
      ].filter((table) => table !== missing),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-session-join-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2277 Join regeneration adapter without broadening driver admission", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_join_capability",
      "dining_join_regeneration_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-join-regeneration-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "dining_table",
    "dining_session",
    "dining_join_capability",
    "dining_join_regeneration_operation",
  ])("rejects WP-2277 admission without %s ownership", async (missing) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      "dining",
      "rms_dining",
      [
        "dining_table",
        "dining_session",
        "dining_join_capability",
        "dining_join_regeneration_operation",
      ].filter((table) => table !== missing),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-join-regeneration-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2275 initial Session adapter without broadening driver admission", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_session",
      "dining_join_capability",
      "dining_session_start_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-session-start-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "dining_table",
    "dining_session",
    "dining_join_capability",
    "dining_session_start_operation",
  ])("rejects WP-2275 admission without %s ownership", async (missing) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      "dining",
      "rms_dining",
      [
        "dining_table",
        "dining_session",
        "dining_join_capability",
        "dining_session_start_operation",
      ].filter((table) => table !== missing),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-session-start-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only WP-2272 Dining Table storage without widening driver or sibling admission", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "dining", "rms_dining", [
      "dining_table",
      "dining_table_operation",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/dining-table-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "dining_table", "dining_table_operation"])(
    "does not transfer WP-2272 admission with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "dining",
        changed === "schema" ? "rms_other" : "rms_dining",
        ["dining_table", "dining_table_operation"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-table-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2223 owned Cart reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/cart-query-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["owner", "schema", "cart", "cart_line"])(
    "does not transfer WP-2223 acceptance with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/cart-query-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2314 owned current Dining Cart reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "dining_cart_replacement",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-cart-read-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["owner", "schema", "cart", "cart_line", "dining_cart_replacement"])(
    "does not transfer WP-2314 acceptance with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line", "dining_cart_replacement"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-cart-read-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2402 replacement owned current Dining Cart reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "dining_cart_replacement",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-cart-replacement-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-store.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["owner", "schema", "cart", "cart_line", "dining_cart_replacement"])(
    "does not transfer WP-2402 replacement acceptance with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line", "dining_cart_replacement"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/dining-cart-replacement-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2316 owned atomic Dining Cart selection writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "dining_cart_replacement",
      "dining_cart_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/dining-cart-selection-store.ts",
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
    "cart",
    "cart_line",
    "dining_cart_operation",
    "dining_cart_replacement",
  ])("does not transfer WP-2316 acceptance with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["cart", "cart_line", "dining_cart_operation", "dining_cart_replacement"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/dining-cart-selection-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2230 owned operation reader without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart_operation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/cart-item-operation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(
      join(dirname(asset), "other-operation-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "cart_operation_record"])(
    "does not transfer WP-2230 acceptance with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_operation_record"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/cart-item-operation-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2231 owned Cart writer without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "cart_operation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/cart-item-command-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "cart", "cart_line", "cart_operation_record"])(
    "does not transfer WP-2231 acceptance with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line", "cart_operation_record"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/cart-item-command-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2295 owned Guest binding store without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "identity", "bop_identity", [
      "guest_dining_binding_preparation",
      "guest_session",
      "guest_session_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/guest-dining-binding-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "guest_dining_binding_preparation",
    "guest_session",
    "guest_session_operation",
  ])("does not transfer WP-2295 acceptance with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other-owner" : "identity",
      changed === "schema" ? "bop_other" : "bop_identity",
      ["guest_dining_binding_preparation", "guest_session", "guest_session_operation"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/guest-dining-binding-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2235 owned Guest binding store without driver imports", async () => {
    const root = await fixture();
    const context = await writeModule(root, "BOP", "identity", "bop_identity", [
      "guest_binding_preparation",
      "guest_session",
      "guest_session_operation",
    ]);
    const asset = join(context.moduleRoot, "src/infrastructure/persistence/guest-binding-store.ts");
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "guest_binding_preparation",
    "guest_session",
    "guest_session_operation",
  ])("does not transfer WP-2235 acceptance with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other-owner" : "identity",
      changed === "schema" ? "bop_other" : "bop_identity",
      ["guest_binding_preparation", "guest_session", "guest_session_operation"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/guest-binding-store.ts"),
      "export const synthetic = true;\n",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("accepts only the WP-2237 owner asset without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "cart_binding_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/pickup-cart-binding-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "cart", "cart_line", "cart_binding_record"])(
    "keeps WP-2237 restricted when %s changes",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line", "cart_binding_record"].filter((table) => table !== changed),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/pickup-cart-binding-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("accepts only the WP-2238 owner asset without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "cart",
      "cart_line",
      "cart_lifecycle_operation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/cart-lifecycle-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;\n");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, "export const synthetic = true;\n");
    await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "cart", "cart_line", "cart_lifecycle_operation_record"])(
    "keeps WP-2238 restricted when %s changes",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["cart", "cart_line", "cart_lifecycle_operation_record"].filter(
          (table) => table !== changed,
        ),
      );
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence/cart-lifecycle-store.ts"),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["cart-quote-store.ts", "cart-quote-expiry-store.ts"])(
    "accepts only the WP-2263 owner asset %s without a driver",
    async (filename) => {
      const root = await fixture();
      const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
        "cart",
        "cart_line",
        "cart_quote_attachment",
        "cart_quote_attachment_line",
        "cart_quote_expiry_record",
      ]);
      const asset = join(context.moduleRoot, "src/infrastructure/persistence", filename);
      await writeFile(asset, "export const synthetic = true;\n");
      expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      await writeFile(asset, 'import pg from "pg";\nexport { pg };\n');
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
      await writeFile(asset, "export const synthetic = true;\n");
      await writeFile(join(dirname(asset), "other-writer.ts"), "export const synthetic = true;\n");
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each([
    "owner",
    "schema",
    "cart",
    "cart_line",
    "cart_quote_attachment",
    "cart_quote_attachment_line",
    "cart_quote_expiry_record",
  ])("keeps WP-2239 restricted when %s changes", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "cart",
        "cart_line",
        "cart_quote_attachment",
        "cart_quote_attachment_line",
        "cart_quote_expiry_record",
      ].filter((table) => table !== changed),
    );
    for (const file of ["cart-quote-store.ts", "cart-quote-expiry-store.ts"]) {
      await writeFile(
        join(context.moduleRoot, "src/infrastructure/persistence", file),
        "export const synthetic = true;\n",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    }
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "allergen_registry_version",
    "allergen_registry_entry",
    "allergen_source_evidence",
    "allergen_source_assertion",
    "recipe_allergen_source_capture",
    "driver",
    "path",
  ])("keeps Catalog Allergen source admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "catalog",
      changed === "schema" ? "rms_other" : "rms_catalog",
      [
        "allergen_registry_version",
        "allergen_registry_entry",
        "allergen_source_evidence",
        "allergen_source_assertion",
        "recipe_allergen_source_capture",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-source.ts" : "recipe-allergen-coverage-source.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "inventory_item",
    "inventory_item_version",
    "inventory_item_operation",
    "driver",
    "path",
  ])("keeps Inventory Item SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      ["inventory_item", "inventory_item_version", "inventory_item_operation"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "inventory-item-store.ts",
      ),
      changed === "driver"
        ? 'import pg from "pg"; export { pg };'
        : "export const synthetic = true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "inventory_item",
    "inventory_item_version",
    "stock_account",
    "stock_balance",
    "stock_movement",
    "stock_reservation_version",
    "stock_reservation_set",
    "stock_lot_hold_version",
    "driver",
    "path",
  ])("keeps Stock Reservation SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      [
        "inventory_item",
        "inventory_item_version",
        "stock_account",
        "stock_balance",
        "stock_movement",
        "stock_reservation_version",
        "stock_reservation_set",
        "stock_lot_hold_version",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "stock-reservation-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "inventory_item",
    "stock_account",
    "stock_balance",
    "stock_lot_hold_version",
    "driver",
    "path",
  ])("keeps Lot Hold SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      ["inventory_item", "stock_account", "stock_balance", "stock_lot_hold_version"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "lot-hold-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  for (const source of [
    "workforce-account-binding-provisioner.ts",
    "workforce-account-read-kernel.ts",
    "current-workforce-account-source.ts",
    "workforce-authentication-source.ts",
  ]) {
    it.each([
      "valid",
      "owner",
      "schema",
      "workforce_account_binding",
      "workforce_invitation",
      "driver",
      "path",
      "nested-path",
    ])(`keeps Workforce account binding SQL admission exact for ${source}: %s`, async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        ["workforce_account_binding", "workforce_invitation"].filter((table) => table !== changed),
      );
      const directory = join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "nested-path" ? "unapproved" : "",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, changed === "path" ? "other-writer.ts" : source),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    });
  }

  for (const source of [
    "platform-actor-directory-store.ts",
    "platform-actor-directory-provisioner.ts",
  ]) {
    it.each([
      "valid",
      "owner",
      "schema",
      "platform_actor_directory_head",
      "platform_actor_directory_revision",
      "authentication_session",
      "driver",
      "path",
    ])(`keeps Platform Actor Directory SQL admission exact for ${source}: %s`, async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        [
          "platform_actor_directory_head",
          "platform_actor_directory_revision",
          "authentication_session",
        ].filter((table) => table !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : source,
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    });
  }

  it.each([
    "valid",
    "owner",
    "schema",
    "platform_template_publishing_head",
    "platform_template_publishing_operation",
    "driver",
    "path",
  ])("keeps Platform Template Publishing SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other-owner" : "publishing",
      changed === "schema" ? "bop_other" : "bop_publishing",
      ["platform_template_publishing_head", "platform_template_publishing_operation"].filter(
        (table) => table !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "platform-publishing-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  for (const source of ["platform-permission-store.ts", "platform-permission-provisioner.ts"]) {
    it.each([
      "valid",
      "owner",
      "schema",
      "platform_permission_policy_head",
      "platform_permission_policy_revision",
      "driver",
      "path",
    ])(`keeps Platform Permission SQL admission exact for ${source}: %s`, async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "permission",
        changed === "schema" ? "bop_other" : "bop_permission",
        ["platform_permission_policy_head", "platform_permission_policy_revision"].filter(
          (table) => table !== changed,
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : source,
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    });
  }

  for (const source of [
    "system-media-image-promotion-authorization-store.ts",
    "system-media-image-promotion-provisioner.ts",
  ]) {
    it.each([
      "valid",
      "owner",
      "schema",
      "system_media_image_promotion_authorization",
      "system_media_image_promotion_authorization_decision",
      "driver",
      "path",
    ])(
      `keeps fixed System Media Permission SQL admission exact for ${source}: %s`,
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "BOP",
          changed === "owner" ? "other-owner" : "permission",
          changed === "schema" ? "bop_other" : "bop_permission",
          [
            "system_media_image_promotion_authorization",
            "system_media_image_promotion_authorization_decision",
          ].filter((table) => table !== changed),
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-writer.ts" : source,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe",
    "recipe_version",
    "recipe_operation_record",
    "driver",
    "path",
  ])("keeps Recipe query SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      ["recipe", "recipe_version", "recipe_operation_record", "stock_lot_hold_version"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-query-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_admin_projection",
    "recipe_admin_projection_generation",
    "recipe_admin_projection_checkpoint",
    "driver",
    "path",
  ])("keeps Recipe admin query SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe_admin_projection",
        "recipe_admin_projection_generation",
        "recipe_admin_projection_checkpoint",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-admin-query-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe",
    "recipe_version",
    "recipe_scope_binding",
    "driver",
    "path",
  ])("keeps Recipe binding SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      ["recipe", "recipe_version", "recipe_scope_binding", "stock_lot_hold_version"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-binding-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Workflow definition SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "workflow",
        changed === "schema" ? "bop_other" : "bop_workflow",
        changed === "table" ? [] : ["workflow_definition_version"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "workflow-definition-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Publishing mutation SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "publishing",
        changed === "schema" ? "bop_other" : "bop_publishing",
        changed === "table" ? [] : ["publishing_mutation_record"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "publishing-mutation-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "mutation-table", "terminal-table", "driver", "path"])(
    "keeps Option publication original operation SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "publishing",
        changed === "schema" ? "bop_other" : "bop_publishing",
        [
          ...(changed === "mutation-table" ? [] : ["publishing_mutation_record"]),
          ...(changed === "terminal-table" ? [] : ["option_set_publication_operation"]),
        ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "option-set-publication-operation-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "mutation-table", "terminal-table", "driver", "path"])(
    "keeps OptionPrice review original operation SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "publishing",
        changed === "schema" ? "bop_other" : "bop_publishing",
        [
          ...(changed === "mutation-table" ? [] : ["publishing_mutation_record"]),
          ...(changed === "terminal-table" ? [] : ["option_price_review_operation"]),
        ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "option-price-review-operation-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Inventory final validation SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "inventory",
        changed === "schema" ? "rms_other" : "rms_inventory",
        changed === "table" ? [] : ["submission_final_validation"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "submission-final-validation-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "revision", "operation", "brand", "driver", "path"])(
    "keeps Tenant topology Draft SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const tables = [
        "brand",
        "brand_store_topology_draft_revision",
        "brand_store_topology_draft_operation",
      ].filter(
        (table) =>
          table !==
          {
            revision: "brand_store_topology_draft_revision",
            operation: "brand_store_topology_draft_operation",
            brand: "brand",
          }[changed],
      );
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "tenant",
        changed === "schema" ? "bop_other" : "bop_tenant",
        tables,
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "brand-store-topology-draft-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each([
    "valid",
    "owner",
    "schema",
    "revision",
    "operation",
    "brand",
    "configuration",
    "driver",
    "path",
  ])("keeps Tenant Brand configuration authoring SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const tables = [
      "brand",
      "brand_configuration_version",
      "brand_configuration_authoring_revision",
      "brand_configuration_authoring_operation",
    ].filter(
      (table) =>
        table !==
        {
          revision: "brand_configuration_authoring_revision",
          operation: "brand_configuration_authoring_operation",
          brand: "brand",
          configuration: "brand_configuration_version",
        }[changed],
    );
    const context = await writeModule(
      root,
      "BOP",
      changed === "owner" ? "other-owner" : "tenant",
      changed === "schema" ? "bop_other" : "bop_tenant",
      tables,
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "brand-configuration-authoring-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  for (const spec of [
    {
      layer: "BOP",
      module: "tenant",
      schema: "bop_tenant",
      tables: ["platform_brand_template_revision", "platform_brand_template_operation"],
      file: "platform-brand-template-store.ts",
    },
    {
      layer: "BOP",
      module: "tenant",
      schema: "bop_tenant",
      tables: ["platform_brand_template_revision", "platform_brand_template_operation"],
      file: "platform-brand-template-reference-source.ts",
    },
    {
      layer: "BOP",
      module: "tenant",
      schema: "bop_tenant",
      tables: ["platform_brand_template_revision", "platform_brand_template_operation"],
      file: "platform-brand-template-read-kernel.ts",
    },
    {
      layer: "BOP",
      module: "publishing",
      schema: "bop_publishing",
      tables: ["platform_template_publishing_head", "platform_template_publishing_operation"],
      file: "platform-template-brand-reference-source.ts",
    },
    {
      layer: "BOP",
      module: "publishing",
      schema: "bop_publishing",
      tables: ["platform_template_publishing_head", "platform_template_publishing_operation"],
      file: "platform-publishing-read-kernel.ts",
    },
    {
      layer: "RMS",
      module: "catalog",
      schema: "rms_catalog",
      tables: ["brand_catalog_source", "brand_catalog_source_operation"],
      file: "brand-catalog-source-store.ts",
    },
    {
      layer: "BOP",
      module: "identity",
      schema: "bop_identity",
      tables: ["authentication_session", "browser_brand_session_selection"],
      file: "browser-brand-session-selection-store.ts",
    },
  ]) {
    it.each(["valid", "owner", "schema", "first-table", "second-table", "driver", "path"])(
      `keeps ${spec.file} SQL admission exact: %s`,
      async (changed) => {
        const root = await fixture();
        const tables = spec.tables.filter(
          (_, index) =>
            !(changed === "first-table" && index === 0) &&
            !(changed === "second-table" && index === 1),
        );
        const context = await writeModule(
          root,
          spec.layer,
          changed === "owner" ? "other-owner" : spec.module,
          changed === "schema" ? "other_schema" : spec.schema,
          tables,
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-writer.ts" : spec.file,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps merchant organization source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "tenant",
        changed === "schema" ? "bop_other" : "bop_tenant",
        changed === "table" ? [] : ["brand", "store"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "merchant-organization-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Tenant complete Store reference source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "tenant",
        changed === "schema" ? "bop_other" : "bop_tenant",
        changed === "table"
          ? []
          : ["brand", "store_reference_generation", "store_reference_projection"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "store-reference-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps selected Tax reference source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "pricing",
        changed === "schema" ? "rms_other" : "rms_pricing",
        changed === "table"
          ? []
          : ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "tax-configuration-reference-source-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Brand Tax reference source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "pricing",
        changed === "schema" ? "rms_other" : "rms_pricing",
        changed === "table" ? [] : ["tax_reference_generation", "tax_reference_scope"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "brand-tax-reference-source-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store business date source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : ["store_configuration_version", "store_configuration_authoring_operation"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "business-date-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store exception content source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : [
              "store_configuration_version",
              "store_service_exception",
              "store_service_exception_content",
              "store_service_exception_interval",
            ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "exception-content-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store weekly schedule source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table" ? [] : ["store_configuration_version", "store_weekly_service_period"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "weekly-schedule-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps current Live Gate source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "publishing",
        changed === "schema" ? "bop_other" : "bop_publishing",
        changed === "table" ? [] : ["live_gate_version", "live_gate_requirement"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "current-live-gate-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store publication content source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : ["store_configuration_version", "store_configuration_publication_content"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "publication-content-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store pause history source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : [
              "store_configuration_operation",
              "store_service_pause_content",
              "store_service_resume_content",
            ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "pause-history-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store review snapshot SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table" ? [] : ["store_configuration_review_snapshot"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "review-snapshot-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps public Store profile SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table" ? [] : ["public_store_profile_version"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "public-store-profile-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Guest entry admission SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        changed === "table" ? [] : ["guest_entry_admission"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "guest-entry-admission-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps public Store profile timing SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table" ? [] : ["public_store_profile_timing"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "public-store-profile-timing-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "sku-table", "retirement-table", "driver", "path"])(
    "keeps Catalog complete Tax coverage source SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "catalog",
        changed === "schema" ? "rms_other" : "rms_catalog",
        [
          "product",
          "product_version",
          "sku",
          "product_option_binding",
          "product_option_binding_option",
          "product_option_binding_sku_scope",
          "product_option_binding_channel",
          "product_version_category_assignment",
          "product_publication_revision",
          "product_source_head",
          "product_operation_record",
          "product_operation_snapshot",
          "product_source_commit",
          "product_publication_content",
          "product_scope_retirement_header",
          "product_scope_retirement",
        ].filter(
          (table) =>
            !(changed === "sku-table" && table === "sku") &&
            !(changed === "retirement-table" && table === "product_scope_retirement"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "product-tax-coverage-source-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "authoring-table", "terminal-table", "driver", "path"])(
    "keeps Store configuration original SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        [
          "store_configuration_authoring_operation",
          "store_configuration_original_operation",
        ].filter(
          (table) =>
            !(
              changed === "authoring-table" && table === "store_configuration_authoring_operation"
            ) &&
            !(changed === "terminal-table" && table === "store_configuration_original_operation"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "store-configuration-original-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each(
    ["valid", "owner", "schema", "revision-table", "operation-table", "driver", "path"].flatMap(
      (changed) =>
        ["store-setup-draft-store.ts", "publication-setup-basis.ts"].map((filename) => [
          changed,
          filename,
        ]),
    ),
  )("keeps Store immutable setup SQL admission exact: %s %s", async (changed, filename) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "store",
      changed === "schema" ? "rms_other" : "rms_store",
      ["store_setup_draft_revision", "store_setup_draft_operation"].filter(
        (table) =>
          !(changed === "revision-table" && table === "store_setup_draft_revision") &&
          !(changed === "operation-table" && table === "store_setup_draft_operation"),
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : filename,
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["valid", "owner", "schema", "revision-table", "operation-table", "driver", "path"])(
    "keeps Store setup reference SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        ["store_setup_reference_version", "store_setup_reference_operation"].filter(
          (table) =>
            !(changed === "revision-table" && table === "store_setup_reference_version") &&
            !(changed === "operation-table" && table === "store_setup_reference_operation"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "store-setup-reference-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "revision-table", "operation-table", "driver", "path"])(
    "keeps Store payment configuration SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["store_payment_configuration_version", "store_payment_configuration_operation"].filter(
          (table) =>
            !(changed === "revision-table" && table === "store_payment_configuration_version") &&
            !(changed === "operation-table" && table === "store_payment_configuration_operation"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "store-payment-configuration-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "revision-table", "operation-table", "driver", "path"])(
    "keeps Receipt Template artifact SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "printing-device",
        changed === "schema" ? "rms_other" : "rms_device",
        [
          "digital_receipt_template_artifact_version",
          "digital_receipt_template_artifact_operation",
        ].filter(
          (table) =>
            !(
              changed === "revision-table" && table === "digital_receipt_template_artifact_version"
            ) &&
            !(
              changed === "operation-table" &&
              table === "digital_receipt_template_artifact_operation"
            ),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "digital-receipt-template-artifact-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "revision-table", "operation-table", "driver", "path"])(
    "keeps Receipt Template Draft SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "printing-device",
        changed === "schema" ? "rms_other" : "rms_device",
        [
          "digital_receipt_template_draft_revision",
          "digital_receipt_template_draft_operation",
        ].filter(
          (table) =>
            !(
              changed === "revision-table" && table === "digital_receipt_template_draft_revision"
            ) &&
            !(
              changed === "operation-table" && table === "digital_receipt_template_draft_operation"
            ),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "digital-receipt-template-draft-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "revision-table", "submission-table", "driver", "path"])(
    "keeps Receipt Template Submission SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "printing-device",
        changed === "schema" ? "rms_other" : "rms_device",
        ["digital_receipt_template_draft_revision", "digital_receipt_template_submission"].filter(
          (table) =>
            !(
              changed === "revision-table" && table === "digital_receipt_template_draft_revision"
            ) &&
            !(changed === "submission-table" && table === "digital_receipt_template_submission"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "digital-receipt-template-submission-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "operation-table", "submission-table", "driver", "path"])(
    "keeps Receipt Template Submit SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "printing-device",
        changed === "schema" ? "rms_other" : "rms_device",
        ["digital_receipt_template_submit_operation", "digital_receipt_template_submission"].filter(
          (table) =>
            !(
              changed === "operation-table" && table === "digital_receipt_template_submit_operation"
            ) &&
            !(changed === "submission-table" && table === "digital_receipt_template_submission"),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "digital-receipt-template-submit-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each([
    "valid",
    "owner",
    "schema",
    "operation-table",
    "submission-table",
    "published-table",
    "driver",
    "path",
  ])("keeps Receipt Template lifecycle SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const required = [
      "digital_receipt_template_lifecycle_operation",
      "digital_receipt_template_submission",
      "digital_receipt_template_version",
    ];
    const omitted = {
      "operation-table": required[0],
      "submission-table": required[1],
      "published-table": required[2],
    };
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "printing-device",
      changed === "schema" ? "rms_other" : "rms_device",
      required.filter((table) => table !== omitted[changed]),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "digital-receipt-template-lifecycle-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store configuration authoring SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table" ? [] : ["store_configuration_authoring_operation"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "configuration-authoring-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store publication materializer SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : [
              "store_configuration_version",
              "store_weekly_service_period",
              "store_service_exception",
              "store_service_exception_content",
              "store_service_exception_interval",
              "store_configuration_publication_content",
            ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "publication-materializer.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Store service control writer SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "store",
        changed === "schema" ? "rms_other" : "rms_store",
        changed === "table"
          ? []
          : [
              "store_configuration_operation",
              "store_service_pause_content",
              "store_service_resume_content",
            ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "service-control-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps browser session selection store SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        changed === "table" ? [] : ["authentication_session", "browser_session_selection"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "browser-session-selection-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps browser session lifecycle store SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        changed === "table" ? [] : ["authentication_session", "oidc_authorization_transaction"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "browser-session-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps OIDC authorization store SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        changed === "table" ? [] : ["oidc_authorization_transaction"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "oidc-authorization-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  for (const source of [
    "current-browser-session-source.ts",
    "current-platform-browser-session-source.ts",
  ]) {
    it.each(["valid", "owner", "schema", "table", "driver", "path"])(
      `keeps ${source} SQL admission exact: %s`,
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "BOP",
          changed === "owner" ? "other-owner" : "identity",
          changed === "schema" ? "bop_other" : "bop_identity",
          changed === "table" ? [] : ["authentication_session"],
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-writer.ts" : source,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps current workforce MFA reader SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "identity",
        changed === "schema" ? "bop_other" : "bop_identity",
        changed === "table" ? [] : ["workforce_mfa_status"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "current-workforce-mfa-source.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  for (const source of [
    "current-workforce-invitation-source.ts",
    "workforce-invitation-store.ts",
  ]) {
    it.each(["valid", "owner", "schema", "table", "driver", "orm", "path"])(
      `keeps ${source} SQL admission exact: %s`,
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "BOP",
          changed === "owner" ? "other-owner" : "identity",
          changed === "schema" ? "bop_other" : "bop_identity",
          changed === "table" ? ["workforce_mfa_status"] : ["workforce_invitation"],
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-reader.ts" : source,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : changed === "orm"
              ? 'import { sql } from "drizzle-orm"; export { sql };'
              : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  for (const source of [
    "workforce-onboarding-operation-store.ts",
    "workforce-onboarding-invitation-source.ts",
  ]) {
    it.each(["valid", "owner", "schema", "operation", "invitation", "driver", "orm", "path"])(
      `keeps ${source} Workforce onboarding SQL admission exact: %s`,
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "BOP",
          changed === "owner" ? "other-owner" : "identity",
          changed === "schema" ? "bop_other" : "bop_identity",
          changed === "operation"
            ? ["workforce_invitation"]
            : changed === "invitation"
              ? ["workforce_onboarding_operation"]
              : ["workforce_onboarding_operation", "workforce_invitation"],
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-writer.ts" : source,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : changed === "orm"
              ? 'import { sql } from "drizzle-orm"; export { sql };'
              : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  for (const source of [
    "initial-brand-membership-store.ts",
    "approved-workforce-membership-store.ts",
  ]) {
    it.each(["valid", "owner", "schema", "membership", "driver", "orm", "path"])(
      `keeps ${source} Membership writer SQL admission exact: %s`,
      async (changed) => {
        const root = await fixture();
        const context = await writeModule(
          root,
          "BOP",
          changed === "owner" ? "other-owner" : "membership",
          changed === "schema" ? "bop_other" : "bop_membership",
          // Valid admission requires membership alone, never StoreAssignment.
          changed === "membership" ? ["store_assignment"] : ["membership"],
        );
        await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), {
          recursive: true,
        });
        await writeFile(
          join(
            context.moduleRoot,
            "src/infrastructure/persistence",
            changed === "path" ? "other-writer.ts" : source,
          ),
          changed === "driver"
            ? 'import pg from "pg"; export { pg };'
            : changed === "orm"
              ? 'import { sql } from "drizzle-orm"; export { sql };'
              : "export const synthetic=true;",
        );
        const codes = await resultCodes(root);
        if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
        else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
      },
    );
  }

  it.each(["valid", "owner", "schema", "membership", "driver", "orm", "path"])(
    "keeps actor-bound Brand discovery reader SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "membership",
        changed === "schema" ? "bop_other" : "bop_membership",
        // Valid admission requires membership alone, never StoreAssignment.
        changed === "membership" ? ["store_assignment"] : ["membership"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "brand-discovery-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : changed === "orm"
            ? 'import { sql } from "drizzle-orm"; export { sql };'
            : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  for (const source of ["brand-initial-policy-store.ts", "approved-workforce-policy-store.ts"]) {
    it.each([
      "valid",
      "owner",
      "schema",
      "policy_state",
      "permission_definition",
      "role",
      "role_assignment",
      "permission_grant",
      "permission_override",
      "driver",
      "orm",
      "path",
    ])(`keeps ${source} Permission writer SQL admission exact: %s`, async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "permission",
        changed === "schema" ? "bop_other" : "bop_permission",
        [
          "policy_state",
          "permission_definition",
          "role",
          "role_assignment",
          "permission_grant",
          "permission_override",
        ].filter((table) => table !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : source,
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : changed === "orm"
            ? 'import { sql } from "drizzle-orm"; export { sql };'
            : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    });
  }

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps current Membership reader SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "membership",
        changed === "schema" ? "bop_other" : "bop_membership",
        changed === "table" ? [] : ["membership", "store_assignment"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "current-membership-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps current Permission policy SQL admission exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "BOP",
        changed === "owner" ? "other-owner" : "permission",
        changed === "schema" ? "bop_other" : "bop_permission",
        changed === "table"
          ? []
          : [
              "policy_state",
              "permission_definition",
              "role",
              "role_assignment",
              "permission_grant",
              "permission_override",
            ],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "current-policy-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe",
    "recipe_version",
    "recipe_scope_binding",
    "recipe_modifier_version",
    "driver",
    "path",
  ])("keeps Recipe demand SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      ["recipe", "recipe_version", "recipe_scope_binding", "recipe_modifier_version"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-demand-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_version",
    "recipe_ingredient_requirement",
    "recipe_allergen_evidence",
    "recipe_preparation_step",
    "driver",
    "path",
  ])("keeps Recipe version SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe_version",
        "recipe_ingredient_requirement",
        "recipe_allergen_evidence",
        "recipe_preparation_step",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-version-write.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "inventory_item",
    "inventory_item_version",
    "inventory_item_operation",
    "recipe_configuration_source_version",
    "recipe_configuration_source_capture",
    "driver",
    "path",
  ])("keeps Inventory Recipe configuration source admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      [
        "inventory_item",
        "inventory_item_version",
        "inventory_item_operation",
        "recipe_configuration_source_version",
        "recipe_configuration_source_capture",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-source.ts" : "recipe-configuration-coverage-source.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "recipe",
    "recipe_version",
    "recipe_preparation_content",
    "recipe_modifier_version",
    "recipe_scope_binding",
    "recipe_admin_source_capture",
    "driver",
    "path",
  ])("keeps Recipe owner source coverage admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe",
        "recipe_version",
        "recipe_preparation_content",
        "recipe_modifier_version",
        "recipe_scope_binding",
        "recipe_admin_source_capture",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-source.ts" : "recipe-owner-coverage-source.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_admin_source_generation",
    "recipe_admin_source_checkpoint",
    "recipe_admin_source_binding",
    "driver",
    "path",
  ])("keeps Recipe coverage publication SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe_admin_source_generation",
        "recipe_admin_source_checkpoint",
        "recipe_admin_source_binding",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-coverage-publication-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_admin_core_generation",
    "recipe_admin_core_row",
    "recipe_admin_core_checkpoint",
    "driver",
    "path",
  ])("keeps Recipe core publication SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe_admin_core_generation",
        "recipe_admin_core_row",
        "recipe_admin_core_checkpoint",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-core-publication-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_admin_core_checkpoint",
    "recipe_admin_core_generation",
    "recipe_admin_core_row",
    "recipe_admin_source_generation",
    "driver",
    "path",
  ])("keeps Recipe core query admission exact: %s", async (changed) => {
    const root = await fixture(),
      context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "recipe",
        changed === "schema" ? "rms_other" : "rms_recipe",
        [
          "recipe_admin_core_checkpoint",
          "recipe_admin_core_generation",
          "recipe_admin_core_row",
          "recipe_admin_source_generation",
        ].filter((table) => table !== changed),
      );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-reader.ts" : "recipe-core-query-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe_admin_source_checkpoint",
    "recipe_admin_source_generation",
    "recipe_admin_core_checkpoint",
    "recipe_admin_core_generation",
    "recipe_admin_core_row",
    "driver",
    "path",
  ])("keeps Recipe rebuild state SQL admission exact: %s", async (changed) => {
    const root = await fixture(),
      context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "recipe",
        changed === "schema" ? "rms_other" : "rms_recipe",
        [
          "recipe_admin_source_checkpoint",
          "recipe_admin_source_generation",
          "recipe_admin_core_checkpoint",
          "recipe_admin_core_generation",
          "recipe_admin_core_row",
        ].filter((table) => table !== changed),
      );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-reader.ts" : "recipe-core-rebuild-state-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each([
    "valid",
    "owner",
    "schema",
    "recipe",
    "recipe_version",
    "recipe_ingredient_requirement",
    "recipe_allergen_evidence",
    "recipe_preparation_step",
    "recipe_operation_record",
    "recipe_review_record",
    "driver",
    "path",
  ])("keeps Recipe transaction SQL admission exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "recipe",
      changed === "schema" ? "rms_other" : "rms_recipe",
      [
        "recipe",
        "recipe_version",
        "recipe_ingredient_requirement",
        "recipe_allergen_evidence",
        "recipe_preparation_step",
        "recipe_operation_record",
        "recipe_review_record",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-writer.ts" : "recipe-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it.each(["valid", "owner", "schema", "table", "driver", "path"])(
    "keeps Recipe modifier SQL exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "recipe",
        changed === "schema" ? "rms_other" : "rms_recipe",
        changed === "table" ? ["other_table"] : ["recipe_modifier_version"],
      );
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "recipe-modifier-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each(["valid", "owner", "schema", "table", "recipe", "recipe_version", "driver", "path"])(
    "keeps Recipe modifier writer SQL exact: %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other-owner" : "recipe",
        changed === "schema" ? "rms_other" : "rms_recipe",
        ["recipe", "recipe_version", "recipe_modifier_version"].filter(
          (table) => table !== (changed === "table" ? "recipe_modifier_version" : changed),
        ),
      );
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence",
          changed === "path" ? "other-writer.ts" : "recipe-modifier-write-store.ts",
        ),
        changed === "driver"
          ? 'import pg from "pg"; export { pg };'
          : "export const synthetic=true;",
      );
      const codes = await resultCodes(root);
      if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
      else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it.each([
    "valid",
    "owner",
    "schema",
    "inventory_item_version",
    "stock_account",
    "stock_balance",
    "stock_movement",
    "stock_lot_hold_version",
    "driver",
    "path",
  ])("Inventory stock candidate SQL exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "inventory",
      changed === "schema" ? "rms_other" : "rms_inventory",
      [
        "inventory_item_version",
        "stock_account",
        "stock_balance",
        "stock_movement",
        "stock_lot_hold_version",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-reader.ts" : "stock-candidate-source.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "cart",
    "cart_quote_attachment",
    "checkout_session_record",
    "checkout_session_allocation",
    "driver",
    "path",
  ])("Checkout Session SQL exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      [
        "cart",
        "cart_quote_attachment",
        "checkout_session_record",
        "checkout_session_allocation",
      ].filter((table) => table !== changed),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-session.ts" : "checkout-session-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "valid",
    "owner",
    "schema",
    "cart",
    "checkout_session_allocation",
    "order_submission_record",
    "order_batch",
    "driver",
    "path",
  ])("Checkout Session allocation SQL exact: %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other-owner" : "ordering",
      changed === "schema" ? "rms_other" : "rms_ordering",
      ["cart", "checkout_session_allocation", "order_submission_record", "order_batch"].filter(
        (table) => table !== changed,
      ),
    );
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence",
        changed === "path" ? "other-session.ts" : "checkout-session-allocation-store.ts",
      ),
      changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
    );
    const codes = await resultCodes(root);
    if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
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

  it("admits only the Order refund basis reader without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_batch",
      "order_item",
      "order_submission_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-refund-basis-reader.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "order_batch", "order_item", "order_submission_record"])(
    "rejects Order refund basis reader with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        ["order_batch", "order_item", "order_submission_record"].filter(
          (table) => table !== changed,
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-refund-basis-reader.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the ordinary refund capture source without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_intent",
      "payment_provider_observation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/ordinary-refund-capture-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "payment_intent", "payment_provider_observation"])(
    "rejects ordinary refund capture source with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_intent", "payment_provider_observation"].filter((table) => table !== changed),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "ordinary-refund-capture-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the batch checkout expiry store without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "ordering", "rms_ordering", [
      "order_batch_checkout_expiry",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/order-batch-checkout-expiry-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects batch checkout expiry store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "ordering",
        changed === "schema" ? "rms_other" : "rms_ordering",
        changed === "table" ? [] : ["order_batch_checkout_expiry"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "order-batch-checkout-expiry-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the ordinary refund request store without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "ordinary_refund_request",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/ordinary-refund-request-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects ordinary refund request store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        changed === "table" ? [] : ["ordinary_refund_request"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "ordinary-refund-request-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the ordinary refund operation store without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "ordinary_refund_operation",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/ordinary-refund-operation-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects ordinary refund operation store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        changed === "table" ? [] : ["ordinary_refund_operation"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "ordinary-refund-operation-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the ordinary refund approval store without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "ordinary_refund_approval",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/ordinary-refund-approval-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects ordinary refund approval store with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        changed === "table" ? [] : ["ordinary_refund_approval"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "ordinary-refund-approval-store.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );

  it("admits only the Payment refund status adapter without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_refund_status_projection",
      "payment_compensation_refund",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-refund-status-store.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each([
    "owner",
    "schema",
    "path",
    "payment_refund_status_projection",
    "payment_compensation_refund",
  ])("rejects Payment refund status adapter with changed %s", async (changed) => {
    const root = await fixture();
    const context = await writeModule(
      root,
      "RMS",
      changed === "owner" ? "other" : "payment",
      changed === "schema" ? "rms_other" : "rms_payment",
      ["payment_refund_status_projection", "payment_compensation_refund"].filter(
        (table) => table !== changed,
      ),
    );
    await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
    await writeFile(
      join(
        context.moduleRoot,
        "src/infrastructure/persistence/" +
          (changed === "path" ? "other.ts" : "payment-refund-status-store.ts"),
      ),
      "export const synthetic = true;",
    );
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });

  it("admits only the Payment compensation exception source without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_compensation_case_history",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-compensation-exception-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table"])(
    "rejects Payment compensation exception source with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        changed === "table" ? [] : ["payment_compensation_case_history"],
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-compensation-exception-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment reconciliation exception source without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_reconciliation_exception",
      "payment_reconciliation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-reconciliation-exception-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table", "record-table"])(
    "rejects Payment reconciliation exception source with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        ["payment_reconciliation_exception", "payment_reconciliation_record"].filter(
          (table) =>
            table !==
            (changed === "table"
              ? "payment_reconciliation_exception"
              : changed === "record-table"
                ? "payment_reconciliation_record"
                : ""),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-reconciliation-exception-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
  it("admits only the Payment reconciliation run source without a driver", async () => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "payment", "rms_payment", [
      "payment_reconciliation_run",
      "payment_reconciliation_exception",
      "payment_reconciliation_record",
    ]);
    const asset = join(
      context.moduleRoot,
      "src/infrastructure/persistence/payment-reconciliation-run-source.ts",
    );
    await writeFile(asset, "export const synthetic = true;");
    expect(await resultCodes(root)).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    await writeFile(asset, 'import pg from "pg"; export {pg};');
    expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
  });
  it.each(["owner", "schema", "path", "table", "record-table", "run-table"])(
    "rejects Payment reconciliation run source with changed %s",
    async (changed) => {
      const root = await fixture();
      const context = await writeModule(
        root,
        "RMS",
        changed === "owner" ? "other" : "payment",
        changed === "schema" ? "rms_other" : "rms_payment",
        [
          "payment_reconciliation_run",
          "payment_reconciliation_exception",
          "payment_reconciliation_record",
        ].filter(
          (table) =>
            table !==
            (changed === "table"
              ? "payment_reconciliation_exception"
              : changed === "record-table"
                ? "payment_reconciliation_record"
                : changed === "run-table"
                  ? "payment_reconciliation_run"
                  : ""),
        ),
      );
      await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
      await writeFile(
        join(
          context.moduleRoot,
          "src/infrastructure/persistence/" +
            (changed === "path" ? "other.ts" : "payment-reconciliation-run-source.ts"),
        ),
        "export const synthetic = true;",
      );
      expect(await resultCodes(root)).toContain("UNSUPPORTED_DATABASE_ASSET");
    },
  );
});

it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "order_batch_checkout_cancellation",
  "order_batch",
  "order_revision",
  "order_item",
])("bounds cancelled amount source admission: %s", async (changed) => {
  const root = await fixture();
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "ordering",
    changed === "schema" ? "rms_other" : "rms_ordering",
    ["order_batch_checkout_cancellation", "order_batch", "order_revision", "order_item"].filter(
      (table) => table !== changed,
    ),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "order-cancelled-amount-source.ts"),
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic = true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "payment_intent",
  "payment_attempt",
  "payment_reconciliation_record",
  "payment_terminal_fact",
])("bounds reconciliation candidates admission: %s", async (changed) => {
  const root = await fixture();
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "payment",
    changed === "schema" ? "rms_other" : "rms_payment",
    [
      "payment_intent",
      "payment_attempt",
      "payment_reconciliation_record",
      "payment_terminal_fact",
    ].filter((table) => table !== changed),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "payment-reconciliation-candidates.ts"),
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic = true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "payment_compensation_refund",
  "payment_compensation_action_history",
  "payment_terminal_fact",
])("bounds confirmed compensation source admission: %s", async (changed) => {
  const root = await fixture();
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "payment",
    changed === "schema" ? "rms_other" : "rms_payment",
    [
      "payment_compensation_refund",
      "payment_compensation_action_history",
      "payment_terminal_fact",
    ].filter((table) => table !== changed),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence/" +
        (changed === "path" ? "other.ts" : "payment-compensation-refund-source.ts"),
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic=true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "isolation",
  "scope",
  "combined",
  "wrong-binding",
  "extra-binding",
  "literal-binding",
  "changed-timeout",
  "changed-store",
  "duplicate",
  "aliased-receiver",
  "driver",
])("keeps WP2421 validation candidate setup SQL exact: %s", async (kind) => {
  const root = await fixture(),
    context = await writeModule(root, "RMS", "catalog", "rms_catalog", [
      "product",
      "product_version",
      "sku",
      "product_version_category_assignment",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ]);
  const isolation = "SELECT current_setting('transaction_isolation') AS isolation",
    scope =
      "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true),set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
    timeout =
      "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)";
  let source;
  if (kind === "isolation")
    source = `export const read=tx=>tx.query(${JSON.stringify(isolation)},[]);`;
  else if (kind === "combined")
    source = `export const read=(tx,tenant,brand)=>{tx.query(${JSON.stringify(timeout)},[]);tx.query(${JSON.stringify(isolation)},[]);return tx.query(${JSON.stringify(scope)},[tenant,brand]);};`;
  else if (kind === "duplicate")
    source = `export const read=tx=>{tx.query(${JSON.stringify(isolation)},[]);return tx.query(${JSON.stringify(isolation)},[]);};`;
  else if (kind === "driver") source = 'import pg from "pg"; export {pg};';
  else if (kind === "aliased-receiver")
    source = `export const read=other=>other.query(${JSON.stringify(isolation)},[]);`;
  else {
    const sql =
      kind === "changed-timeout"
        ? scope.replace("60000", "0")
        : kind === "changed-store"
          ? scope.replace("bop.store_id", "bop.other_id")
          : scope;
    const args =
      kind === "wrong-binding"
        ? "[brand,tenant]"
        : kind === "extra-binding"
          ? "[tenant,brand,actor]"
          : kind === "literal-binding"
            ? '["tenant","brand"]'
            : "[tenant,brand]";
    source = `export const read=(tx,tenant,brand,actor)=>tx.query(${JSON.stringify(sql)},${args});`;
  }
  await writeFile(
    join(context.moduleRoot, "src/infrastructure/persistence/product-draft-baseline-store.ts"),
    source,
  );
  const codes = await resultCodes(root);
  if (["isolation", "scope", "combined"].includes(kind))
    expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each(["timeout", "owner-table", "foreign-table", "dynamic", "alias", "element"])(
  "keeps WP2409 Draft baseline direct SQL empty: %s",
  async (kind) => {
    const root = await fixture();
    const context = await writeModule(root, "RMS", "catalog", "rms_catalog", [
      "product",
      "product_version",
      "sku",
      "product_version_category_assignment",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ]);
    const sql =
      "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)";
    const source =
      kind === "timeout"
        ? `export const read=(tx)=>tx.query(${JSON.stringify(sql)},[]);`
        : kind === "owner-table"
          ? 'export const read=(tx)=>tx.query("SELECT * FROM rms_catalog.product",[]);'
          : kind === "foreign-table"
            ? 'export const read=(tx)=>tx.query("SELECT * FROM rms_inventory.item",[]);'
            : kind === "dynamic"
              ? "export const read=(tx,sql)=>tx.query(sql,[]);"
              : kind === "alias"
                ? 'export const read=(tx)=>{const q=tx.query;return q("SELECT 1",[]);};'
                : 'export const read=(tx)=>tx["query"]("SELECT 1",[]);';
    await writeFile(
      join(context.moduleRoot, "src/infrastructure/persistence/product-draft-baseline-store.ts"),
      source,
    );
    const codes = await resultCodes(root);
    if (kind === "timeout") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
    else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
  },
);

it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "configuration_reference_generation",
  "price_book",
  "option_price_rule",
  "promotion",
])("integrated Pricing configuration reference adapter changed %s", async (changed) => {
  const root = await fixture(),
    tables = ["configuration_reference_generation", "price_book", "option_price_rule", "promotion"];
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "pricing",
    changed === "schema" ? "rms_other" : "rms_pricing",
    tables.filter((t) => t !== changed),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence",
      changed === "path" ? "other.ts" : "configuration-reference-source-store.ts",
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic=true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

// WP-2421: finite Inventory-owned current unit source; preserve other rejections.
it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "inventory_item",
  "inventory_item_version",
  "inventory_item_operation",
  "configuration_reference_generation",
])("Inventory consumption unit adapter changed %s", async (changed) => {
  const root = await fixture(),
    tables = [
      "inventory_item",
      "inventory_item_version",
      "inventory_item_operation",
      "configuration_reference_generation",
    ];
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "inventory",
    changed === "schema" ? "rms_other" : "rms_inventory",
    tables.filter((t) => t !== changed),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence",
      changed === "path" ? "other.ts" : "option-consumption-unit-source-store.ts",
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic=true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

// WP-2421: finite Recipe-owned current yield source; preserve other rejections.
it.each([
  "valid",
  "owner",
  "schema",
  "path",
  "driver",
  "recipe",
  "recipe_version",
  "recipe_scope_binding",
  "recipe_modifier_version",
  "recipe_reference_generation",
  "recipe_reference_binding",
])("Recipe consumption yield adapter changed %s", async (changed) => {
  const root = await fixture(),
    tables = [
      "recipe",
      "recipe_version",
      "recipe_scope_binding",
      "recipe_modifier_version",
      "recipe_reference_generation",
      "recipe_reference_binding",
    ];
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other" : "recipe",
    changed === "schema" ? "rms_other" : "rms_recipe",
    tables.filter((t) => t !== changed),
  );
  await mkdir(join(context.moduleRoot, "src/infrastructure/persistence"), { recursive: true });
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence",
      changed === "path" ? "other.ts" : "option-consumption-yield-source-store.ts",
    ),
    changed === "driver" ? 'import pg from "pg"; export {pg};' : "export const synthetic=true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "valid",
  "owner",
  "schema",
  "recipe",
  "recipe_version",
  "recipe_operation_record",
  "recipe_review_record",
  "recipe_measurement_content",
  "driver",
  "path",
])("keeps complete Published V2 graph owner admission exact: %s", async (changed) => {
  const root = await fixture();
  const context = await writeModule(
    root,
    "RMS",
    changed === "owner" ? "other-owner" : "recipe",
    changed === "schema" ? "rms_other" : "rms_recipe",
    [
      "recipe",
      "recipe_version",
      "recipe_operation_record",
      "recipe_review_record",
      "recipe_measurement_content",
    ].filter((table) => table !== changed),
  );
  await writeFile(
    join(
      context.moduleRoot,
      "src/infrastructure/persistence",
      changed === "path"
        ? "other-measurement-source.ts"
        : "current-published-recipe-measurement-graph-source.ts",
    ),
    changed === "driver" ? 'import pg from "pg"; export { pg };' : "export const synthetic=true;",
  );
  const codes = await resultCodes(root);
  if (changed === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "valid",
  "foreign-table",
  "unbounded",
  "wrong-brand",
  "wrong-code",
  "extra",
  "outside-candidate",
  "dynamic",
  "alias",
  "duplicate",
])("keeps WP2421 current candidate code SQL exact: %s", async (kind) => {
  const root = await fixture(),
    context = await writeModule(root, "RMS", "catalog", "rms_catalog", [
      "product",
      "product_version",
      "sku",
      "product_version_category_assignment",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ]);
  let sql =
    "SELECT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$3 AND internal_code=$2) AS candidate_matches,NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND internal_code=$2 AND product_id<>$3) AS internal_code_unique";
  if (kind === "foreign-table") sql = sql.replaceAll("rms_catalog.product", "rms_inventory.item");
  if (kind === "unbounded") sql = sql.replace("brand_id=$1 AND ", "");
  const args =
    kind === "wrong-brand"
      ? "[tenant,aggregate.internalCode,aggregate.productReference]"
      : kind === "wrong-code"
        ? "[brand,aggregate.productReference,aggregate.internalCode]"
        : kind === "extra"
          ? "[brand,aggregate.internalCode,aggregate.productReference,actor]"
          : "[brand,aggregate.internalCode,aggregate.productReference]";
  const query = `tx.query(${kind === "dynamic" ? "sql" : JSON.stringify(sql)},${args})`;
  const body =
    kind === "alias"
      ? `const q=tx.query;return q(${JSON.stringify(sql)},${args});`
      : kind === "duplicate"
        ? `${query};return ${query};`
        : `return ${query};`;
  const source = `export function ${kind === "outside-candidate" ? "createPostgresProductDraftBaselineStore" : "createPostgresProductValidationCandidateSource"}(tx,brand,aggregate,tenant,actor,sql){${body}}`;
  await writeFile(
    join(context.moduleRoot, "src/infrastructure/persistence/product-draft-baseline-store.ts"),
    source,
  );
  const codes = await resultCodes(root);
  if (kind === "valid") expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

it.each([
  "valid",
  "actual-source",
  "export-kernel",
  "export-alias",
  "default-export",
  "kernel-alias",
  "third-call",
  "missing-v2",
  "duplicate-v2",
  "v2-v1-parser",
  "v2-v1-binder",
  "v2-v1-fields",
  "dynamic-protocol",
  "spread-protocol",
  "duplicate-protocol",
  "facade-extra-statement",
  "wrong-options",
  "facade-not-exported",
  "kernel-default-protocol",
  "query-other-function",
  "sql-wrong-parameter",
  "sql-changed",
  "sql-alias",
  "sql-element",
  "sql-duplicate",
])("admits only the fixed private current-candidate kernel: %s", async (kind) => {
  const root = await fixture(),
    context = await writeModule(root, "RMS", "catalog", "rms_catalog", [
      "product",
      "product_version",
      "sku",
      "product_version_category_assignment",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ]);
  const sql =
      "SELECT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$3 AND internal_code=$2) AS candidate_matches,NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND internal_code=$2 AND product_id<>$3) AS internal_code_unique",
    query = `tx.query(${JSON.stringify(sql)},[brand,aggregate.internalCode,aggregate.productReference])`,
    v1 =
      "export function createPostgresProductValidationCandidateSource(options){return createCandidateSource(options,{parseCommand:parseProductPublicationCommand,bindCandidate:bindCatalogProductValidationCandidate,fields:productValidationCandidateFields});}",
    v2 =
      "export function createPostgresProductValidationCandidateSourceV2(options){return createCandidateSource(options,{parseCommand:parseProductPublicationCommandV2,bindCandidate:bindCatalogProductValidationCandidateV2,fields:productValidationCandidateFieldsV2});}",
    kernel = `function createCandidateSource(options,protocol){return {withCurrentCandidate(value,work){const codeUnique=()=>${query};return codeUnique();}};}`,
    original = `${v1}\n${v2}\n${kernel}`;
  let source = original;
  if (kind === "actual-source")
    source = await readFile(
      join(
        toolRoot,
        "../../packages/rms/catalog/src/infrastructure/persistence/product-draft-baseline-store.ts",
      ),
      "utf8",
    );
  if (kind === "export-kernel") source = source.replace(kernel, "export " + kernel);
  if (kind === "export-alias") source += "\nexport {createCandidateSource as unsafeSource};";
  if (kind === "default-export") source += "\nexport default createCandidateSource;";
  if (kind === "kernel-alias") source += "\nconst unsafeSource=createCandidateSource;";
  if (kind === "third-call")
    source += "\nexport const unsafeSource=createCandidateSource(options,protocol);";
  if (kind === "missing-v2") source = source.replace(v2, "");
  if (kind === "duplicate-v2") source += "\n" + v2;
  if (kind === "v2-v1-parser")
    source = source.replace(
      "parseCommand:parseProductPublicationCommandV2",
      "parseCommand:parseProductPublicationCommand",
    );
  if (kind === "v2-v1-binder")
    source = source.replace(
      "bindCandidate:bindCatalogProductValidationCandidateV2",
      "bindCandidate:bindCatalogProductValidationCandidate",
    );
  if (kind === "v2-v1-fields")
    source = source.replace(
      "fields:productValidationCandidateFieldsV2",
      "fields:productValidationCandidateFields",
    );
  if (kind === "dynamic-protocol")
    source = source.replace(
      v2,
      "export function createPostgresProductValidationCandidateSourceV2(options){return createCandidateSource(options,options.protocol);}",
    );
  if (kind === "spread-protocol")
    source = source.replace(
      "{parseCommand:parseProductPublicationCommandV2",
      "{...options.protocol,parseCommand:parseProductPublicationCommandV2",
    );
  if (kind === "duplicate-protocol")
    source = source.replace(
      "fields:productValidationCandidateFieldsV2",
      "parseCommand:parseProductPublicationCommandV2",
    );
  if (kind === "facade-extra-statement")
    source = source.replace(v2, v2.replace("{return", "{options.protocol=unsafeProtocol;return"));
  if (kind === "wrong-options")
    source = source.replace(
      v2,
      v2.replace("createCandidateSource(options,", "createCandidateSource(other,"),
    );
  if (kind === "facade-not-exported") source = source.replace(v2, v2.replace("export ", ""));
  if (kind === "kernel-default-protocol")
    source = source.replace(
      "function createCandidateSource(options,protocol)",
      "function createCandidateSource(options,protocol=unsafeProtocol)",
    );
  if (kind === "query-other-function")
    source = source.replace(query, "null") + `\nfunction other(){return ${query};}`;
  if (kind === "sql-wrong-parameter")
    source = source.replace(
      "[brand,aggregate.internalCode,aggregate.productReference]",
      "[tenant,aggregate.internalCode,aggregate.productReference]",
    );
  if (kind === "sql-changed")
    source = source.replace("brand_id=$1 AND product_id=$3", "product_id=$3");
  if (kind === "sql-alias")
    source = source.replace(
      query,
      `(()=>{const q=tx.query;return q(${JSON.stringify(sql)},[brand,aggregate.internalCode,aggregate.productReference]);})()`,
    );
  if (kind === "sql-element") source = source.replace("tx.query(", 'tx["query"](');
  if (kind === "sql-duplicate") source = source.replace(query, `(${query},${query})`);
  if (kind !== "valid" && kind !== "actual-source") expect(source).not.toBe(original);
  await writeFile(
    join(context.moduleRoot, "src/infrastructure/persistence/product-draft-baseline-store.ts"),
    source,
  );
  const codes = await resultCodes(root);
  if (kind === "valid" || kind === "actual-source")
    expect(codes).not.toContain("UNSUPPORTED_DATABASE_ASSET");
  else expect(codes).toContain("UNSUPPORTED_DATABASE_ASSET");
});

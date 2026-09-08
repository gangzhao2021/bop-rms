import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  canonicalPlatformDatabaseManifest,
  databaseMechanisms,
  databaseOperations,
  databasePrincipalKinds,
  databaseReadPatterns,
  retentionCategories,
  tableClassifications,
} from "./contract.ts";
import { piiClasses } from "../module-manifest/module.manifest.ts";
import { discoverModules } from "../import-boundary/validate.mjs";
import { readMigrationCatalog } from "../../packages/database/src/catalog.ts";

const evidencePath = "src/infrastructure/persistence/database-access.manifest.ts";
const platformPath = "tooling/database-ownership/platform-database.manifest.ts";
const ignored = new Set([".git", ".turbo", "build", "coverage", "dist", "node_modules"]);
const codeExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const snakeCase = /^[a-z][a-z0-9_]*$/u;
const principalId = /^[a-z0-9@][a-z0-9@/._-]*$/u;
const accessId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const sharedAuthorityModules = new Map([
  ["platform_audit", "@bop/audit"],
  ["platform_eventing", "@bop/eventing"],
]);

export const databaseOwnershipUsage = `BOP-RMS Database Schema Ownership Architecture Test

Usage:
  pnpm database-ownership:check
  node tooling/database-ownership/validate.mjs [--root <repository-root>]

Validates canonical Module ownership, pure-literal access evidence, and the
finite shared-infrastructure registry. Real persistence assets fail closed.
`;

export class DatabaseOwnershipError extends Error {}
const diag = (code, file, message, line = 1) => ({
  code,
  file: file.replaceAll("\\", "/"),
  line,
  message,
});
const format = (item) => `${item.file}:${item.line} [${item.code}] ${item.message}`;
const duplicateValues = (values) => {
  const seen = new Set();
  return values.filter((value) => (seen.has(value) ? true : (seen.add(value), false)));
};
async function state(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
function literal(node, parsed) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((value) => literal(value, parsed));
  if (ts.isObjectLiteralExpression(node)) {
    const result = {};
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      )
        throw new DatabaseOwnershipError("declaration must use explicit property assignments");
      result[property.name.text] = literal(property.initializer, parsed);
    }
    return result;
  }
  const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  throw new DatabaseOwnershipError(
    `declaration contains non-literal ${ts.SyntaxKind[node.kind]} at line ${line}`,
  );
}
async function readDeclaration(path, variableName) {
  const source = await readFile(path, "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let candidate;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === variableName &&
      node.initializer
    )
      candidate = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!candidate) throw new DatabaseOwnershipError(`${variableName} literal is missing`);
  return literal(candidate, parsed);
}
function objectShape(value, allowed, diagnostics, file, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(diag(code, file, `${label} must be an object`));
    return false;
  }
  const missing = allowed.filter((key) => !(key in value));
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (missing.length || unknown.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(", ")}`);
    if (unknown.length) parts.push(`unknown ${unknown.join(", ")}`);
    diagnostics.push(diag(code, file, `${label} has ${parts.join("; ")}`));
    return false;
  }
  return true;
}
async function isExactFile(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  let current = root;
  for (const segment of rel.split(sep)) {
    if (!(await readdir(current)).includes(segment)) return false;
    current = join(current, segment);
  }
  return (await state(target))?.isFile() ?? false;
}
async function scanUnsupported(root, module, diagnostics) {
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(directory, entry.name);
      const file = relative(root, path);
      if (entry.isSymbolicLink()) {
        diagnostics.push(diag("SYMLINK_PATH", file, "database scan path is symbolic"));
      } else if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(path);
      } else if (entry.isFile() && !file.endsWith(evidencePath)) {
        const moduleRelative = relative(module.root, path).replaceAll("\\", "/");
        // WP-2209 accepts only this owner-scoped entry adapter; driver imports remain checked below.
        const acceptedGuestBindingAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["guest_binding_preparation", "guest_session", "guest_session_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/guest-binding-store.ts";
        const acceptedGuestEntryAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("guest_session") &&
          moduleRelative === "src/infrastructure/persistence/guest-session-entry-store.ts";
        // WP-2219 accepts only the Catalog candidate reader over its complete owned projection set.
        const acceptedPublishedMenuAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "published_menu_projection_generation",
            "published_menu_projection",
            "published_menu_projection_section",
            "published_menu_projection_sellable",
            "published_menu_projection_checkpoint",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/published-menu-query-store.ts";
        // WP-2223 accepts only the Ordering reader over its existing Cart and line tables.
        const acceptedCartQueryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/cart-query-store.ts";
        // WP-2230 accepts only the reader of existing Ordering operation history.
        const acceptedCartOperationAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          module.manifest.ownedDatabase?.tables?.includes("cart_operation_record") &&
          moduleRelative === "src/infrastructure/persistence/cart-item-operation-store.ts";
        // WP-2231 accepts one writer over the existing Cart/line/operation tables.
        const acceptedCartItemWriterAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "cart_operation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/cart-item-command-store.ts";
        if (
          (moduleRelative.startsWith("src/infrastructure/persistence/") ||
            moduleRelative.startsWith("migrations/") ||
            extname(path).toLowerCase() === ".sql") &&
          ![...sharedAuthorityModules.values()].includes(module.packageName) &&
          !acceptedGuestEntryAsset &&
          !acceptedGuestBindingAsset &&
          !acceptedPublishedMenuAsset &&
          !acceptedCartQueryAsset &&
          !acceptedCartOperationAsset &&
          !acceptedCartItemWriterAsset
        )
          diagnostics.push(
            diag(
              "UNSUPPORTED_DATABASE_ASSET",
              file,
              "real persistence assets are blocked until WP-0020 or the first Persistence Work Package",
            ),
          );
        else if (codeExtensions.has(extname(path).toLowerCase())) {
          const text = await readFile(path, "utf8");
          if (
            /from\s+["'](?:drizzle-orm(?:\/[^"']*)?|pg)["']|require\(\s*["'](?:drizzle-orm(?:\/[^"']*)?|pg)["']\s*\)/u.test(
              text,
            )
          )
            diagnostics.push(
              diag(
                "UNSUPPORTED_DATABASE_ASSET",
                file,
                "Drizzle or pg use is blocked until the accepted persistence contract",
              ),
            );
        }
      }
    }
  }
  await walk(module.root);
}
function validatePrincipal(value, file, diagnostics, label) {
  if (!objectShape(value, ["kind", "id"], diagnostics, file, "DYNAMIC_DATABASE_TARGET", label))
    return false;
  if (!databasePrincipalKinds.includes(value.kind) || !principalId.test(value.id ?? "")) {
    diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, `invalid ${label}`));
    return false;
  }
  return true;
}
function validateTable(record, module, file, diagnostics) {
  if (
    !objectShape(
      record,
      [
        "table",
        "classification",
        "writeOwner",
        "allowedReadPatterns",
        "retentionCategory",
        "piiClassification",
      ],
      diagnostics,
      file,
      "TABLE_METADATA_MISSING",
      "table record",
    )
  )
    return;
  if (!snakeCase.test(record.table ?? ""))
    diagnostics.push(diag("CASE_CONFLICT", file, `invalid table name ${String(record.table)}`));
  if (!tableClassifications.includes(record.classification))
    diagnostics.push(
      diag("TABLE_METADATA_MISSING", file, `invalid classification for ${record.table}`),
    );
  if (!retentionCategories.includes(record.retentionCategory))
    diagnostics.push(
      diag("TABLE_METADATA_MISSING", file, `invalid retentionCategory for ${record.table}`),
    );
  const reads = Array.isArray(record.allowedReadPatterns) ? record.allowedReadPatterns : [];
  if (
    reads.length === 0 ||
    reads.some((value) => !databaseReadPatterns.includes(value)) ||
    duplicateValues(reads).length
  )
    diagnostics.push(
      diag("INVALID_READ_PATTERN", file, `invalid allowedReadPatterns for ${record.table}`),
    );
  const classes = Array.isArray(record.piiClassification) ? record.piiClassification : [];
  if (
    classes.length === 0 ||
    classes.some((value) => !piiClasses.includes(value)) ||
    duplicateValues(classes).length
  )
    diagnostics.push(
      diag("TABLE_METADATA_MISSING", file, `invalid PII classification for ${record.table}`),
    );
  if (!validatePrincipal(record.writeOwner, file, diagnostics, "writeOwner")) return;
  const validOwner =
    record.classification === "projection-read-model"
      ? record.writeOwner.kind === "projection-builder"
      : record.writeOwner.kind === "module" && record.writeOwner.id === module.packageName;
  if (!validOwner)
    diagnostics.push(
      diag("UNDECLARED_OWNER_WRITE", file, `invalid writeOwner for ${record.table}`),
    );
}
function validateAccess(access, file, diagnostics) {
  if (
    !objectShape(
      access,
      ["id", "operation", "mechanism", "target", "principal", "readPattern", "source"],
      diagnostics,
      file,
      "DYNAMIC_DATABASE_TARGET",
      "access record",
    )
  )
    return false;
  if (!accessId.test(access.id ?? ""))
    diagnostics.push(
      diag("DYNAMIC_DATABASE_TARGET", file, `invalid access id ${String(access.id)}`),
    );
  if (!databaseOperations.includes(access.operation))
    diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, `invalid operation for ${access.id}`));
  if (!databaseMechanisms.includes(access.mechanism))
    diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, `invalid mechanism for ${access.id}`));
  if (
    !objectShape(
      access.target,
      ["schema", "table"],
      diagnostics,
      file,
      "DYNAMIC_DATABASE_TARGET",
      "target",
    )
  )
    return false;
  if (!snakeCase.test(access.target.schema ?? "") || !snakeCase.test(access.target.table ?? ""))
    diagnostics.push(diag("CASE_CONFLICT", file, `invalid target for ${access.id}`));
  if (!validatePrincipal(access.principal, file, diagnostics, "principal")) return false;
  if (access.operation === "read") {
    if (!databaseReadPatterns.includes(access.readPattern))
      diagnostics.push(
        diag("INVALID_READ_PATTERN", file, `read access ${access.id} requires a readPattern`),
      );
  } else if (access.readPattern !== null)
    diagnostics.push(
      diag(
        "INVALID_READ_PATTERN",
        file,
        `${access.operation} access ${access.id} requires readPattern null`,
      ),
    );
  return true;
}
async function validateSource(root, module, access, file, diagnostics) {
  if (
    typeof access.source !== "string" ||
    isAbsolute(access.source) ||
    access.source.split(/[\\/]/u).includes("..")
  ) {
    diagnostics.push(
      diag("PATH_ESCAPE", file, `source for ${access.id} must be repository-relative`),
    );
    return;
  }
  const target = resolve(root, access.source);
  if (target !== module.root && !target.startsWith(`${module.root}${sep}`)) {
    diagnostics.push(diag("PATH_ESCAPE", file, `source for ${access.id} escapes its Module`));
    return;
  }
  let current = root;
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment);
    const componentState = await state(current);
    if (componentState?.isSymbolicLink()) {
      diagnostics.push(
        diag("SYMLINK_PATH", relative(root, current), "database access source path is symbolic"),
      );
      return;
    }
    if (!componentState) break;
  }
  const targetState = await state(target);
  if (!targetState)
    diagnostics.push(diag("PATH_ESCAPE", file, `source for ${access.id} is missing`));
  else if (!(await isExactFile(root, target)))
    diagnostics.push(diag("CASE_CONFLICT", file, `source for ${access.id} is not exact-case`));
}
function accessRules(access, module, owners, platforms, file, diagnostics) {
  const key = `${access.target.schema}.${access.target.table}`;
  const owner = owners.get(key);
  const shared = platforms.get(access.target.schema);
  if (access.target.schema === "public") {
    diagnostics.push(
      diag("RESERVED_SCHEMA_CLAIM", file, `public table access is prohibited for ${access.id}`),
    );
    return;
  }
  if (access.operation !== "read") {
    if (owner) {
      if (owner.module !== module)
        diagnostics.push(
          diag(
            "CROSS_MODULE_WRITE",
            file,
            `${module.packageName} cannot ${access.operation} ${key}`,
          ),
        );
      else if (
        !owner.governance ||
        access.principal.kind !== owner.governance.writeOwner.kind ||
        access.principal.id !== owner.governance.writeOwner.id
      )
        diagnostics.push(
          diag("UNDECLARED_OWNER_WRITE", file, `principal is not the writeOwner of ${key}`),
        );
    } else if (shared) {
      const allowed =
        shared.allowedWriteAuthority === "projection-builder"
          ? access.principal.kind === "projection-builder"
          : access.principal.kind === "shared-infrastructure" &&
            access.principal.id === shared.allowedWriteAuthority &&
            sharedAuthorityModules.get(access.target.schema) === module.packageName;
      if (!allowed)
        diagnostics.push(
          diag(
            "UNDECLARED_OWNER_WRITE",
            file,
            `principal cannot ${access.operation} shared target ${key}`,
          ),
        );
    } else diagnostics.push(diag("UNDECLARED_OWNER_WRITE", file, `${key} has no declared owner`));
    return;
  }
  if (owner) {
    const foreign = owner.module !== module;
    if (!owner.governance?.allowedReadPatterns.includes(access.readPattern))
      diagnostics.push(
        diag("INVALID_READ_PATTERN", file, `${access.readPattern} is not approved for ${key}`),
      );
    if (
      access.readPattern === "owner-repository" &&
      (foreign ||
        access.principal.kind !== "module" ||
        access.principal.id !== module.packageName ||
        access.mechanism !== "repository")
    )
      diagnostics.push(
        diag(
          "INVALID_READ_PATTERN",
          file,
          `owner-repository requires the owning Module Repository for ${key}`,
        ),
      );
    if (foreign && access.readPattern === "public-query-contract")
      diagnostics.push(
        diag(
          "INVALID_READ_PATTERN",
          file,
          "public-query-contract cannot carry a foreign table target",
        ),
      );
    if (
      access.readPattern === "owner-read-view" &&
      (access.principal.kind !== "module" || access.mechanism !== "repository")
    )
      diagnostics.push(
        diag("INVALID_READ_PATTERN", file, "owner-read-view requires a Module Repository"),
      );
    if (
      foreign &&
      ["approved-source-view", "event-projection"].includes(access.readPattern) &&
      !["projection-builder", "reconciliation-job"].includes(access.principal.kind)
    )
      diagnostics.push(
        diag(
          "INVALID_READ_PATTERN",
          file,
          `${access.readPattern} requires an approved builder/job`,
        ),
      );
    if (access.readPattern === "event-projection")
      diagnostics.push(
        diag(
          "INVALID_READ_PATTERN",
          file,
          "event-projection may read only the platform_eventing Event Feed",
        ),
      );
  } else if (
    !(
      shared &&
      access.target.schema === "platform_eventing" &&
      access.readPattern === "event-projection" &&
      access.principal.kind === "projection-builder"
    ) &&
    !(shared && access.principal.kind === "shared-infrastructure")
  )
    diagnostics.push(
      diag(
        shared ? "INVALID_READ_PATTERN" : "DATABASE_TARGET_UNDECLARED",
        file,
        shared
          ? `shared target ${key} requires approved infrastructure access`
          : `${key} has no declared owner`,
      ),
    );
}
async function evidenceFor(root, module, diagnostics) {
  const absolute = join(module.root, evidencePath);
  const file = relative(root, absolute);
  const fileState = await state(absolute);
  if (!fileState) return null;
  if (fileState.isSymbolicLink()) {
    diagnostics.push(diag("SYMLINK_PATH", file, "database evidence file is symbolic"));
    return null;
  }
  try {
    return await readDeclaration(absolute, "databaseAccessManifestInput");
  } catch (error) {
    diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, error.message));
    return null;
  }
}
export async function validateDatabaseOwnership({ root = process.cwd() } = {}) {
  root = await realpath(root);
  const diagnostics = [];
  if (await state(join(root, "migrations"))) {
    const catalog = await readMigrationCatalog(root);
    for (const item of catalog.diagnostics)
      diagnostics.push(diag(item.code, item.file ?? "migrations", item.message, item.line ?? 1));
  }
  let platformManifest;
  try {
    platformManifest = await readDeclaration(
      join(root, platformPath),
      "platformDatabaseManifestInput",
    );
    if (JSON.stringify(platformManifest) !== JSON.stringify(canonicalPlatformDatabaseManifest))
      diagnostics.push(
        diag(
          "RESERVED_SCHEMA_CLAIM",
          platformPath,
          "platform registry must equal the Section 92 registry",
        ),
      );
  } catch (error) {
    diagnostics.push(diag("RESERVED_SCHEMA_CLAIM", platformPath, error.message));
    platformManifest = canonicalPlatformDatabaseManifest;
  }
  const platforms = new Map(platformManifest.schemas.map((value) => [value.schema, value]));
  const modules = await discoverModules(root, diagnostics);
  const schemaOwners = new Map();
  const foldedSchemas = new Map();
  const owners = new Map();
  const foldedTables = new Map();
  const pendingAccesses = [];
  for (const module of modules) {
    const owned = module.manifest.ownedDatabase ?? { schema: null, tables: [] };
    if (owned.schema === null) continue;
    const file = relative(root, join(module.root, "src/module.manifest.ts"));
    if (/^(?:platform_|public$)/u.test(owned.schema))
      diagnostics.push(
        diag("RESERVED_SCHEMA_CLAIM", file, `${module.packageName} cannot claim ${owned.schema}`),
      );
    if (schemaOwners.has(owned.schema))
      diagnostics.push(
        diag(
          "DUPLICATE_SCHEMA_OWNER",
          file,
          `${owned.schema} is already owned by ${schemaOwners.get(owned.schema).packageName}`,
        ),
      );
    else schemaOwners.set(owned.schema, module);
    const foldedSchema = String(owned.schema).toLowerCase();
    if (foldedSchemas.has(foldedSchema) && foldedSchemas.get(foldedSchema) !== owned.schema)
      diagnostics.push(
        diag(
          "CASE_CONFLICT",
          file,
          `${owned.schema} conflicts with ${foldedSchemas.get(foldedSchema)}`,
        ),
      );
    else foldedSchemas.set(foldedSchema, owned.schema);
    for (const table of owned.tables ?? []) {
      const key = `${owned.schema}.${table}`;
      const folded = key.toLowerCase();
      if (owners.has(key))
        diagnostics.push(
          diag(
            "DUPLICATE_TABLE_OWNER",
            file,
            `${key} is already owned by ${owners.get(key).module.packageName}`,
          ),
        );
      else owners.set(key, { module, table });
      if (foldedTables.has(folded) && foldedTables.get(folded) !== key)
        diagnostics.push(
          diag("CASE_CONFLICT", file, `${key} conflicts with ${foldedTables.get(folded)}`),
        );
      else foldedTables.set(folded, key);
    }
  }
  for (const module of modules.sort((a, b) => a.packageName.localeCompare(b.packageName, "en"))) {
    const file = relative(root, join(module.root, evidencePath));
    const evidence = await evidenceFor(root, module, diagnostics);
    const ownedTables = [...(module.manifest.ownedDatabase?.tables ?? [])].sort();
    if (!evidence) {
      if (ownedTables.length)
        diagnostics.push(
          diag(
            "TABLE_METADATA_MISSING",
            file,
            `${module.packageName} owns tables but has no evidence`,
          ),
        );
      await scanUnsupported(root, module, diagnostics);
      continue;
    }
    if (
      module.manifest.ownedDatabase?.schema === null &&
      (!["@bop/audit", "@bop/eventing"].includes(module.packageName) ||
        (Array.isArray(evidence.tables) && evidence.tables.length > 0))
    ) {
      diagnostics.push(
        diag(
          "DATABASE_TARGET_UNDECLARED",
          file,
          `${module.packageName} has schema null and cannot declare this database evidence`,
        ),
      );
    }
    if (
      !objectShape(
        evidence,
        ["version", "module", "tables", "accesses"],
        diagnostics,
        file,
        "DYNAMIC_DATABASE_TARGET",
        "database evidence",
      )
    )
      continue;
    if (evidence.version !== 1)
      diagnostics.push(
        diag("DYNAMIC_DATABASE_TARGET", file, "database evidence version must be 1"),
      );
    if (
      !objectShape(
        evidence.module,
        ["moduleName", "packageName", "layer"],
        diagnostics,
        file,
        "MODULE_IDENTITY_MISMATCH",
        "database evidence module",
      )
    )
      diagnostics.push(
        diag("MODULE_IDENTITY_MISMATCH", file, "database evidence module shape is invalid"),
      );
    if (
      !evidence.module ||
      evidence.module.moduleName !== module.moduleName ||
      evidence.module.packageName !== module.packageName ||
      evidence.module.layer !== module.layer
    )
      diagnostics.push(
        diag(
          "MODULE_IDENTITY_MISMATCH",
          file,
          "database evidence identity must match canonical Module identity",
        ),
      );
    if (!Array.isArray(evidence.tables))
      diagnostics.push(diag("TABLE_METADATA_MISSING", file, "tables must be an array"));
    const records = Array.isArray(evidence.tables) ? evidence.tables : [];
    const names = records.map((record) => record?.table);
    for (const record of records) {
      validateTable(record, module, file, diagnostics);
      const owner = owners.get(`${module.manifest.ownedDatabase?.schema}.${record?.table}`);
      if (owner?.module === module) owner.governance = record;
    }
    for (const table of ownedTables)
      if (names.filter((value) => value === table).length !== 1)
        diagnostics.push(
          diag("TABLE_METADATA_MISSING", file, `${table} requires exactly one governance record`),
        );
    for (const table of names)
      if (!ownedTables.includes(table))
        diagnostics.push(
          diag(
            "DATABASE_TARGET_UNDECLARED",
            file,
            `table evidence ${table} is not owned by ${module.packageName}`,
          ),
        );
    for (const table of duplicateValues(names))
      diagnostics.push(diag("DUPLICATE_TABLE_OWNER", file, `duplicate governance record ${table}`));
    if (!Array.isArray(evidence.accesses))
      diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, "accesses must be an array"));
    const accesses = Array.isArray(evidence.accesses) ? evidence.accesses : [];
    for (const id of duplicateValues(accesses.map((access) => access?.id)))
      diagnostics.push(diag("DYNAMIC_DATABASE_TARGET", file, `duplicate access id ${id}`));
    for (const access of accesses) {
      if (!validateAccess(access, file, diagnostics)) continue;
      await validateSource(root, module, access, file, diagnostics);
      pendingAccesses.push({ access, module, file });
    }
    await scanUnsupported(root, module, diagnostics);
  }
  diagnostics.sort((left, right) => format(left).localeCompare(format(right), "en"));
  for (const pending of pendingAccesses)
    accessRules(pending.access, pending.module, owners, platforms, pending.file, diagnostics);
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    output: diagnostics.map(format).join("\n"),
  };
}
function options(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (argv.length === 0) return { root: process.cwd() };
  if (argv.length === 2 && argv[0] === "--root") return { root: resolve(argv[1]) };
  throw new DatabaseOwnershipError("expected --root <repository-root> or --help");
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = options(process.argv.slice(2));
    if (parsed.help) process.stdout.write(databaseOwnershipUsage);
    else {
      const result = await validateDatabaseOwnership(parsed);
      if (result.valid) process.stdout.write("Database ownership valid\n");
      else {
        process.stderr.write(`${result.output}\n`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`Database Ownership error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

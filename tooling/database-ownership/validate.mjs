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
// WP-2409/WP-2421: this exact owner facade composes the owning reader;
// direct SQL permits fixed setup and one exact current-candidate code boolean read.
function productDraftOwnerCompositionSqlOnly(text, file) {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const codeSql =
    "SELECT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$3 AND internal_code=$2) AS candidate_matches,NOT EXISTS(SELECT 1 FROM rms_catalog.product WHERE brand_id=$1 AND internal_code=$2 AND product_id<>$3) AS internal_code_unique";
  const allowed = new Map([
    [codeSql, ["brand", "aggregate.internalCode", "aggregate.productReference"]],
    [
      "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
      [],
    ],
    ["SELECT current_setting('transaction_isolation') AS isolation", []],
    [
      "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true),set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      ["tenant", "brand"],
    ],
  ]);
  // V1's original direct facade remains legal. The shared V1/V2 implementation
  // is admitted only through its two fixed, closed protocol selections; a name
  // match alone must not expose an arbitrary protocol or another SQL caller.
  function fixedCandidateKernel() {
    const named = (node, name) => ts.isIdentifier(node) && node.text === name;
    const declarations = (name) =>
      parsed.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
    const kernels = declarations("createCandidateSource");
    if (kernels.length === 0) return undefined;
    if (kernels.length !== 1) return false;
    const kernel = kernels[0];
    const parameter = (node, name) =>
      named(node.name, name) && !node.initializer && !node.dotDotDotToken && !node.questionToken;
    if (
      kernel.modifiers?.length ||
      !kernel.body ||
      kernel.asteriskToken ||
      kernel.parameters.length !== 2 ||
      !parameter(kernel.parameters[0], "options") ||
      !parameter(kernel.parameters[1], "protocol")
    )
      return false;
    const admittedReferences = new Set([kernel.name]);
    const protocols = [
      [
        "createPostgresProductValidationCandidateSource",
        {
          parseCommand: "parseProductPublicationCommand",
          bindCandidate: "bindCatalogProductValidationCandidate",
          fields: "productValidationCandidateFields",
        },
      ],
      [
        "createPostgresProductValidationCandidateSourceV2",
        {
          parseCommand: "parseProductPublicationCommandV2",
          bindCandidate: "bindCatalogProductValidationCandidateV2",
          fields: "productValidationCandidateFieldsV2",
        },
      ],
    ];
    for (const [name, protocol] of protocols) {
      const facades = declarations(name);
      if (facades.length !== 1) return false;
      const facade = facades[0];
      if (
        facade.modifiers?.length !== 1 ||
        facade.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
        facade.asteriskToken ||
        facade.parameters.length !== 1 ||
        !parameter(facade.parameters[0], "options") ||
        facade.body?.statements.length !== 1
      )
        return false;
      const statement = facade.body.statements[0];
      if (
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isCallExpression(statement.expression)
      )
        return false;
      const call = statement.expression;
      if (
        !named(call.expression, "createCandidateSource") ||
        call.arguments.length !== 2 ||
        !named(call.arguments[0], "options") ||
        !ts.isObjectLiteralExpression(call.arguments[1])
      )
        return false;
      const properties = call.arguments[1].properties;
      if (
        properties.length !== 3 ||
        properties.some(
          (property) =>
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name) ||
            !Object.hasOwn(protocol, property.name.text) ||
            !named(property.initializer, protocol[property.name.text]),
        ) ||
        new Set(properties.map((property) => property.name.text)).size !== 3
      )
        return false;
      admittedReferences.add(call.expression);
    }
    let privateOnly = true;
    function references(node) {
      if (named(node, "createCandidateSource") && !admittedReferences.has(node))
        privateOnly = false;
      ts.forEachChild(node, references);
    }
    references(parsed);
    return privateOnly ? kernel : false;
  }
  const kernel = fixedCandidateKernel();
  function insideCurrentCandidate(node) {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isFunctionDeclaration(ancestor))
        return (
          ancestor === kernel ||
          ancestor.name?.text === "createPostgresProductValidationCandidateSource"
        );
    }
    return false;
  }
  let valid = kernel !== false;
  const seen = new Set();
  function visit(node) {
    if (ts.isElementAccessExpression(node)) valid = false;
    if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(parsed) === "query")
      valid = false;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "query") {
      const call = node.parent;
      if (
        !ts.isCallExpression(call) ||
        call.expression !== node ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== "tx" ||
        call.arguments.length !== 2 ||
        !(
          ts.isStringLiteral(call.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(call.arguments[0])
        ) ||
        !ts.isArrayLiteralExpression(call.arguments[1])
      )
        valid = false;
      else {
        const sql = call.arguments[0].text,
          expected = allowed.get(sql),
          values = call.arguments[1].elements;
        if (
          !expected ||
          seen.has(sql) ||
          values.length !== expected.length ||
          values.some((v, i) => v.getText(parsed) !== expected[i]) ||
          (sql === codeSql && !insideCurrentCandidate(call))
        )
          valid = false;
        seen.add(sql);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return valid;
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
// This exact Media entry forwards ports to owning factories; it gains no SQL
// exception. Catch direct query access/aliases and embedded SQL independently
// of the existing driver prohibition below.
function mediaWorkerCompositionOnly(text, file) {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let valid = true;
  function visit(node) {
    if (ts.isIdentifier(node) && ["query", "execute", "prepare"].includes(node.text)) valid = false;
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (
        /^(?:query|execute|prepare)$/u.test(node.text) ||
        /\b(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|SAVEPOINT|COMMIT|ROLLBACK)\b|\bbop_media\./iu.test(
          node.text,
        )
      )
        valid = false;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return valid;
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
        const acceptedGuestDiningBindingAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["guest_dining_binding_preparation", "guest_session", "guest_session_operation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/guest-dining-binding-store.ts";
        const acceptedGuestBindingAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["guest_binding_preparation", "guest_session", "guest_session_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/guest-binding-store.ts";
        const acceptedGuestEntryAdmissionAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("guest_entry_admission") &&
          moduleRelative === "src/infrastructure/persistence/guest-entry-admission-store.ts";
        const acceptedGuestEntryAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("guest_session") &&
          moduleRelative === "src/infrastructure/persistence/guest-session-entry-store.ts";
        // WP-2409: exact owner reader composition, no direct business-table SQL.
        const acceptedProductDraftBaselineAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "product",
            "product_version",
            "sku",
            "product_version_category_assignment",
            "product_option_binding",
            "product_option_binding_option",
            "product_option_binding_sku_scope",
            "product_option_binding_channel",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/product-draft-baseline-store.ts";
        // WP-2421: exact Catalog registered-content configuration asset, no broader exception.
        const acceptedProductContentRegistryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          module.manifest.ownedDatabase?.tables?.includes("product_content_registry_record") &&
          moduleRelative === "src/infrastructure/persistence/product-content-registry-store.ts";
        const acceptedMediaUploadAsset =
          module.packageName === "@bop/media" &&
          module.manifest.ownedDatabase?.schema === "bop_media" &&
          ["upload_session", "asset", "asset_version", "operation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/media-upload-store.ts";
        const acceptedMediaObjectBindingAsset =
          module.packageName === "@bop/media" &&
          module.manifest.ownedDatabase?.schema === "bop_media" &&
          [
            "upload_session",
            "operation_record",
            "upload_object_binding",
            "finalized_object_binding",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/s3-image-upload-runtime.ts";
        const mediaProcessingTables = {
          "src/infrastructure/persistence/media-publication-read-store.ts": [
            "asset",
            "asset_version",
            "image_processing_intent",
            "image_processing_completion",
            "image_rendition",
            "image_scan_admission",
            "upload_object_binding",
          ],
          "src/infrastructure/persistence/media-image-scan-admission-store.ts": [
            "image_scan_admission",
            "image_processing_intent",
          ],
          "src/infrastructure/persistence/media-image-processing-store.ts": [
            "asset",
            "asset_version",
            "image_processing_intent",
            "image_processing_completion",
            "image_rendition",
          ],
          "src/infrastructure/persistence/media-image-processing-source.ts": [
            "upload_session",
            "asset",
            "asset_version",
            "operation_record",
            "upload_object_binding",
            "finalized_object_binding",
          ],
          "src/infrastructure/persistence/media-image-processing-transaction.ts": [
            "image_processing_intent",
            "image_processing_completion",
            "image_rendition",
          ],
        }[moduleRelative];
        const acceptedMediaImageProcessingAsset =
          module.packageName === "@bop/media" &&
          module.manifest.ownedDatabase?.schema === "bop_media" &&
          mediaProcessingTables !== undefined &&
          mediaProcessingTables.every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          );
        const acceptedMediaWorkerCompositionAsset =
          module.packageName === "@bop/media" &&
          module.manifest.ownedDatabase?.schema === "bop_media" &&
          ["image_scan_admission", "image_processing_intent", "image_processing_completion"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/media-image-worker-runtime.ts";
        const acceptedProductTaxClassificationRegistryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          module.manifest.ownedDatabase?.tables?.includes(
            "product_tax_classification_registry_record",
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/product-tax-classification-registry-store.ts";
        const acceptedSellingUnitRegistryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "selling_unit_registry_record",
            "selling_unit_registration_abandonment",
            "sku",
            "product",
            "product_operation_record",
            "product_operation_snapshot",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/selling-unit-registry-store.ts";
        const acceptedFullOptionDraftAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "option_set",
            "option_set_version",
            "option",
            "option_conflict",
            "option_set_operation_record",
            "option_set_draft_content_snapshot",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/option-set-full-draft-store.ts";
        const acceptedOptionHistoryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "option_set",
            "option_set_version",
            "option_set_operation_record",
            "option_set_draft_content_snapshot",
            "option_set_publication_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/option-set-history-store.ts";
        const acceptedOptionReviewReleaseAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "option_set_review_content",
            "option_set_publication_release",
            "option_set_draft_content_snapshot",
            "option_set_publication_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/option-set-review-content-store.ts";
        // WP-2420: Catalog's Product publication owner repository and frozen content.
        const acceptedProductPublicationAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "product",
            "product_version",
            "sku",
            "product_option_binding",
            "product_version_category_assignment",
            "product_operation_record",
            "product_operation_snapshot",
            "product_publication_revision",
            "product_publication_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/product-publication-store.ts";
        const acceptedProductCategoryAssignmentAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          ["category", "product_version", "product_version_category_assignment"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/product-category-assignment.ts";
        // WP-2408: Category owner repository over this complete exact table set.
        const acceptedCategoryRepositoryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "category",
            "category_operation_record",
            "category_operation_snapshot",
            "category_source_head",
            "category_source_commit",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/category-repository.ts",
            "src/infrastructure/persistence/category-source-store.ts",
            "src/infrastructure/persistence/category-source-consumer.ts",
          ].includes(moduleRelative);
        // WP-2219/WP-2402 admit the Catalog projection reader and registered builder over this exact owned set.
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
        // WP-2334 admits only the Catalog-owned SKU availability rule reader.
        const acceptedCurrentOptionBindingsAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
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
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-option-bindings-store.ts";
        const acceptedCurrentMenuPlacementAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          ["menu", "menu_version", "menu_section", "sellable_placement", "sku"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-menu-placement-store.ts";
        const acceptedCurrentSelectionFactsAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
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
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-selection-facts-store.ts";
        const acceptedCatalogProductPublicationSourceAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "product",
            "product_version",
            "product_publication_revision",
            "product_publication_content",
            "product_operation_record",
            "product_operation_snapshot",
            "product_source_commit",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/product-publication-source-store.ts";
        const acceptedCatalogProductTaxCoverageSourceAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
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
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/product-tax-coverage-source-store.ts";
        const acceptedFeatureControlAdministrationQueryAsset =
          module.packageName === "@bop/feature-control" &&
          module.manifest.ownedDatabase?.schema === "bop_feature_control" &&
          ["control_version", "control_dependency"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/administration-query-store.ts";
        const acceptedKillSwitchQueryAsset =
          module.packageName === "@bop/feature-control" &&
          module.manifest.ownedDatabase?.schema === "bop_feature_control" &&
          module.manifest.ownedDatabase?.tables?.includes("kill_switch_version") &&
          moduleRelative === "src/infrastructure/persistence/kill-switch-query-store.ts";
        const acceptedCatalogProductListAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "product_search_generation",
            "product_search_row",
            "product_search_activation",
            "product_source_head",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/product-list-query-store.ts";
        const acceptedCurrentSkuAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          ["product", "product_version", "sku"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-sku-store.ts";
        const acceptedCurrentMenuReleaseAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "menu_publication_revision",
            "menu_publication_release",
            "menu_release_effective_period",
            "menu_version_store",
            "menu_version_channel",
            "menu_version_order_type",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-menu-release-store.ts";
        const acceptedBundleReferenceSourceAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "bundle_reference_generation",
            "bundle",
            "bundle_version",
            "bundle_component_group",
            "bundle_component_sellable",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/bundle-reference-source-store.ts";
        const acceptedMenuReferenceSourceAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "menu_reference_generation",
            "menu_review_content",
            "menu_publication_revision",
            "menu_publication_release",
            "menu_release_effective_period",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/menu-reference-source-store.ts";
        const acceptedAvailabilityQueryAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          module.manifest.ownedDatabase?.tables?.includes("availability_rule") &&
          moduleRelative === "src/infrastructure/persistence/availability-query-store.ts";
        // WP-2347 admits only the owner Allocation terminal adapter.
        const acceptedCapacityAllocationTerminalAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          [
            "capacity_slot",
            "capacity_hold",
            "capacity_allocation",
            "capacity_allocation_terminal",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/capacity-allocation-terminal-store.ts";
        // WP-2344 admits only the owner Scheduled Hold transition adapter.
        const acceptedCapacityHoldTransitionAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          ["capacity_slot", "capacity_hold", "capacity_hold_terminal", "capacity_allocation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/capacity-hold-transition-store.ts";
        // WP-2402 current Pickup occupancy remains a read-only owner repository.
        const acceptedCurrentPickupCapacityAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          [
            "capacity_slot",
            "capacity_slot_configuration",
            "capacity_hold",
            "capacity_hold_terminal",
            "capacity_allocation",
            "capacity_allocation_terminal",
            "capacity_asap_commitment",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-pickup-capacity-store.ts";
        // WP-2402 admits the exact Fulfillment owner ASAP history/Audit adapter.
        const acceptedRecipePreparationContentAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_operation_record",
            "recipe_modifier_version",
            "recipe_preparation_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-preparation-content-store.ts";
        const acceptedRecipeReferenceAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_scope_binding",
            "recipe_modifier_version",
            "recipe_reference_generation",
            "recipe_reference_binding",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          (moduleRelative === "src/infrastructure/persistence/recipe-reference-source-store.ts" ||
            moduleRelative ===
              "src/infrastructure/persistence/option-consumption-yield-source-store.ts");
        const acceptedRecipeInventoryReferenceAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_ingredient_requirement",
            "recipe_modifier_version",
            "recipe_reference_generation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/recipe-inventory-reference-source-store.ts";
        // WP-2423 / DEC-RECIPE-AUTHORING: Merchant recipe drafts, reviews and SKU bindings.
        const acceptedRecipeAuthoringAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_version_presentation",
            "recipe_authoring_review",
            "recipe_scope_binding",
            "recipe_scope_binding_end",
            "recipe_preparation_content",
            "recipe_reference_binding",
            "recipe_ingredient_requirement",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          (moduleRelative === "src/infrastructure/persistence/recipe-authoring-store.ts" ||
            // WP-2423 slice 4.4: option recipe changes, expanded into modifier rules.
            (moduleRelative === "src/infrastructure/persistence/option-recipe-change-store.ts" &&
              [
                "option_recipe_change",
                "option_recipe_change_review",
                "option_recipe_change_publication",
                "recipe_modifier_version",
              ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table))));
        const acceptedRecipeStoreAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_ingredient_requirement",
            "recipe_allergen_evidence",
            "recipe_preparation_step",
            "recipe_operation_record",
            "recipe_review_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-store.ts";
        const acceptedRecipeVersionAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_version",
            "recipe_ingredient_requirement",
            "recipe_allergen_evidence",
            "recipe_preparation_step",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-version-write.ts";
        const acceptedRecipeModifierAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          module.manifest.ownedDatabase?.tables?.includes("recipe_modifier_version") &&
          (moduleRelative === "src/infrastructure/persistence/recipe-modifier-store.ts" ||
            (moduleRelative === "src/infrastructure/persistence/recipe-modifier-write-store.ts" &&
              ["recipe", "recipe_version"].every((table) =>
                module.manifest.ownedDatabase?.tables?.includes(table),
              )));
        const acceptedRecipeDemandAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          ["recipe", "recipe_version", "recipe_scope_binding", "recipe_modifier_version"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/recipe-demand-store.ts";
        const acceptedRecipeBindingAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          ["recipe", "recipe_version", "recipe_scope_binding"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/recipe-binding-store.ts";
        const acceptedRecipeAdminQueryAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_admin_projection",
            "recipe_admin_projection_generation",
            "recipe_admin_projection_checkpoint",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-admin-query-store.ts";
        // WP-2404 admits the exact Recipe owner source capture path and tables.
        const acceptedRecipeOwnerCoverageAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe",
            "recipe_version",
            "recipe_preparation_content",
            "recipe_modifier_version",
            "recipe_scope_binding",
            "recipe_admin_source_capture",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-owner-coverage-source.ts";
        // WP-2404 admits only the Recipe owner coverage publication adapter.
        const acceptedRecipeCoveragePublicationAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_admin_source_generation",
            "recipe_admin_source_checkpoint",
            "recipe_admin_source_binding",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-coverage-publication-store.ts";
        const acceptedRecipeCorePublicationAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_admin_core_generation",
            "recipe_admin_core_row",
            "recipe_admin_core_checkpoint",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-core-publication-store.ts";
        const acceptedRecipeCoreQueryAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_admin_core_checkpoint",
            "recipe_admin_core_generation",
            "recipe_admin_core_row",
            "recipe_admin_source_generation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-core-query-store.ts";
        const acceptedRecipeCoreRebuildStateAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          [
            "recipe_admin_source_checkpoint",
            "recipe_admin_source_generation",
            "recipe_admin_core_checkpoint",
            "recipe_admin_core_generation",
            "recipe_admin_core_row",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-core-rebuild-state-store.ts";
        const acceptedRecipeQueryAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          ["recipe", "recipe_version", "recipe_operation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          (moduleRelative === "src/infrastructure/persistence/recipe-query-store.ts" ||
            (moduleRelative ===
              "src/infrastructure/persistence/recipe-measurement-draft-store.ts" &&
              module.manifest.ownedDatabase?.tables?.includes("recipe_measurement_content")) ||
            (moduleRelative ===
              "src/infrastructure/persistence/current-published-recipe-measurement-graph-source.ts" &&
              ["recipe_measurement_content", "recipe_review_record"].every((table) =>
                module.manifest.ownedDatabase?.tables?.includes(table),
              )) ||
            ([
              "src/infrastructure/persistence/current-published-recipe-content-source.ts",
              "src/infrastructure/persistence/current-published-recipe-dependency-graph-source.ts",
            ].includes(moduleRelative) &&
              module.manifest.ownedDatabase?.tables?.includes("recipe_review_record")));
        const acceptedInventoryConfigurationReferenceAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item",
            "inventory_item_version",
            "inventory_item_operation",
            "configuration_reference_generation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          (moduleRelative ===
            "src/infrastructure/persistence/configuration-reference-source-store.ts" ||
            moduleRelative ===
              "src/infrastructure/persistence/option-consumption-unit-source-store.ts" ||
            moduleRelative ===
              "src/infrastructure/persistence/recipe-ingredient-unit-source-store.ts");
        const acceptedInventorySkuMappingAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item",
            "inventory_item_version",
            "inventory_item_operation",
            "item_sku_mapping_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          (moduleRelative === "src/infrastructure/persistence/inventory-sku-mapping-store.ts" ||
            (moduleRelative ===
              "src/infrastructure/persistence/sku-mapping-reference-source-store.ts" &&
              module.manifest.ownedDatabase?.tables?.includes(
                "configuration_reference_generation",
              )));
        const acceptedLotHoldAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          ["inventory_item", "stock_account", "stock_balance", "stock_lot_hold_version"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/lot-hold-store.ts";
        const acceptedBrowserSessionSelectionAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["authentication_session", "browser_session_selection"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/browser-session-selection-store.ts";
        const acceptedBrandCatalogSourceAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          ["brand_catalog_source", "brand_catalog_source_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/brand-catalog-source-store.ts";
        const acceptedBrowserBrandSessionSelectionAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["authentication_session", "browser_brand_session_selection"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/browser-brand-session-selection-store.ts";
        const acceptedPlatformBrandTemplateAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          ["platform_brand_template_revision", "platform_brand_template_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/platform-brand-template-store.ts",
            "src/infrastructure/persistence/platform-brand-template-reference-source.ts",
            "src/infrastructure/persistence/platform-brand-template-read-kernel.ts",
          ].includes(moduleRelative);
        const acceptedBrandConfigurationAuthoringAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          [
            "brand",
            "brand_configuration_version",
            "brand_configuration_authoring_revision",
            "brand_configuration_authoring_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/brand-configuration-authoring-store.ts";
        const acceptedBrandStoreTopologyDraftAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          [
            "brand",
            "brand_store_topology_draft_revision",
            "brand_store_topology_draft_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/brand-store-topology-draft-store.ts";
        const acceptedBrandLifecycleAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          ["brand", "brand_admin_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/brand-lifecycle-store.ts";
        // WP-2410 admits only the owning complete metadata reference reader.
        const acceptedBrandTaxReferenceAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["tax_reference_generation", "tax_reference_scope"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/brand-tax-reference-source-store.ts";
        const acceptedSelectedTaxReferenceAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/tax-configuration-reference-source-store.ts";
        const acceptedTenantStoreReferenceAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          ["brand", "store_reference_generation", "store_reference_projection"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/store-reference-source.ts";
        const acceptedMerchantOrganizationAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          ["brand", "store"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/merchant-organization-source.ts";
        const acceptedBrowserSessionStoreAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["authentication_session", "oidc_authorization_transaction"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/browser-session-store.ts";
        const acceptedOidcAuthorizationAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("oidc_authorization_transaction") &&
          moduleRelative === "src/infrastructure/persistence/oidc-authorization-store.ts";
        const acceptedCurrentBrowserSessionAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("authentication_session") &&
          [
            "src/infrastructure/persistence/current-browser-session-source.ts",
            "src/infrastructure/persistence/current-platform-browser-session-source.ts",
          ].includes(moduleRelative);
        const acceptedCurrentWorkforceMfaAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("workforce_mfa_status") &&
          moduleRelative === "src/infrastructure/persistence/current-workforce-mfa-source.ts";
        const acceptedCurrentWorkforceInvitationAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("workforce_invitation") &&
          moduleRelative ===
            "src/infrastructure/persistence/current-workforce-invitation-source.ts";
        const acceptedWorkforceInvitationStoreAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("workforce_invitation") &&
          moduleRelative === "src/infrastructure/persistence/workforce-invitation-store.ts";
        const acceptedPlatformActorDirectoryAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          [
            "platform_actor_directory_head",
            "platform_actor_directory_revision",
            "authentication_session",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/platform-actor-directory-store.ts",
            "src/infrastructure/persistence/platform-actor-directory-provisioner.ts",
          ].includes(moduleRelative);
        const acceptedWorkforceAccountBindingAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["workforce_account_binding", "workforce_invitation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/workforce-account-binding-provisioner.ts",
            "src/infrastructure/persistence/workforce-account-read-kernel.ts",
            "src/infrastructure/persistence/current-workforce-account-source.ts",
            "src/infrastructure/persistence/workforce-authentication-source.ts",
          ].includes(moduleRelative);
        const acceptedWorkforceOnboardingOperationAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          ["workforce_onboarding_operation", "workforce_invitation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/workforce-onboarding-operation-store.ts",
            "src/infrastructure/persistence/workforce-onboarding-invitation-source.ts",
          ].includes(moduleRelative);
        const acceptedPlatformTemplatePublishingAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          ["platform_template_publishing_head", "platform_template_publishing_operation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/platform-publishing-store.ts",
            "src/infrastructure/persistence/platform-template-brand-reference-source.ts",
            "src/infrastructure/persistence/platform-publishing-read-kernel.ts",
          ].includes(moduleRelative);
        const acceptedStoreExceptionContentAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          [
            "store_configuration_version",
            "store_service_exception",
            "store_service_exception_content",
            "store_service_exception_interval",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/exception-content-source.ts";
        const acceptedStorePauseHistoryAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          [
            "store_configuration_operation",
            "store_service_pause_content",
            "store_service_resume_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/pause-history-source.ts";
        const acceptedStorePublicationContentAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          ["store_configuration_version", "store_configuration_publication_content"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/publication-content-source.ts";
        const acceptedStorePublicationMaterializerAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          [
            "store_configuration_version",
            "store_weekly_service_period",
            "store_service_exception",
            "store_service_exception_content",
            "store_service_exception_interval",
            "store_configuration_publication_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/publication-materializer.ts";
        const acceptedPublicStoreProfileTimingAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          module.manifest.ownedDatabase?.tables?.includes("public_store_profile_timing") &&
          moduleRelative === "src/infrastructure/persistence/public-store-profile-timing-store.ts";
        const acceptedPublicStoreProfileAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          module.manifest.ownedDatabase?.tables?.includes("public_store_profile_version") &&
          moduleRelative === "src/infrastructure/persistence/public-store-profile-store.ts";
        const acceptedStoreReviewSnapshotAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          module.manifest.ownedDatabase?.tables?.includes("store_configuration_review_snapshot") &&
          moduleRelative === "src/infrastructure/persistence/review-snapshot-store.ts";
        const acceptedStoreSetupDraftAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          ["store_setup_draft_revision", "store_setup_draft_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/store-setup-draft-store.ts",
            "src/infrastructure/persistence/publication-setup-basis.ts",
          ].includes(moduleRelative);
        const acceptedStoreSetupReferenceAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          ["store_setup_reference_version", "store_setup_reference_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/store-setup-reference-store.ts";
        const acceptedStorePaymentConfigurationAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["store_payment_configuration_version", "store_payment_configuration_operation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/store-payment-configuration-store.ts";
        const acceptedStoreAuthoringAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          module.manifest.ownedDatabase?.tables?.includes(
            "store_configuration_authoring_operation",
          ) &&
          moduleRelative === "src/infrastructure/persistence/configuration-authoring-store.ts";
        const acceptedStoreConfigurationOriginalAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          [
            "store_configuration_authoring_operation",
            "store_configuration_original_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/store-configuration-original-store.ts";
        const acceptedStoreServiceControlAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          [
            "store_configuration_operation",
            "store_service_pause_content",
            "store_service_resume_content",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/service-control-store.ts";
        const acceptedStoreWeeklyScheduleAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          ["store_configuration_version", "store_weekly_service_period"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/weekly-schedule-source.ts";
        const acceptedStoreBusinessDateAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          ["store_configuration_version", "store_configuration_authoring_operation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/business-date-source.ts";
        const acceptedCurrentMembershipAsset =
          module.packageName === "@bop/membership" &&
          module.manifest.ownedDatabase?.schema === "bop_membership" &&
          ["membership", "store_assignment"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/current-membership-store.ts",
            // WP-2423: public Store member scope confirmation.
            "src/infrastructure/persistence/store-member-scope-source.ts",
            // WP-2423: Store staff directory and member display names.
            "src/infrastructure/persistence/member-directory-store.ts",
          ].includes(moduleRelative);
        // WP-2421 initialize-only Membership leaf owns no StoreAssignment fact.
        const acceptedMembershipBrandDiscoveryAsset =
          module.packageName === "@bop/membership" &&
          module.manifest.ownedDatabase?.schema === "bop_membership" &&
          module.manifest.ownedDatabase?.tables?.includes("membership") &&
          moduleRelative === "src/infrastructure/persistence/brand-discovery-store.ts";
        const acceptedInitialBrandMembershipAsset =
          module.packageName === "@bop/membership" &&
          module.manifest.ownedDatabase?.schema === "bop_membership" &&
          module.manifest.ownedDatabase?.tables?.includes("membership") &&
          moduleRelative === "src/infrastructure/persistence/initial-brand-membership-store.ts";
        const acceptedApprovedWorkforceMembershipAsset =
          module.packageName === "@bop/membership" &&
          module.manifest.ownedDatabase?.schema === "bop_membership" &&
          module.manifest.ownedDatabase?.tables?.includes("membership") &&
          moduleRelative ===
            "src/infrastructure/persistence/approved-workforce-membership-store.ts";
        const acceptedCurrentPermissionAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "policy_state",
            "permission_definition",
            "role",
            "role_assignment",
            "permission_grant",
            "permission_override",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-policy-store.ts";
        // WP-2421 initial Brand policy uses existing owning facts only.
        const acceptedInitialBrandPermissionAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "policy_state",
            "permission_definition",
            "role",
            "role_assignment",
            "permission_grant",
            "permission_override",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/brand-initial-policy-store.ts",
            "src/infrastructure/persistence/approved-workforce-policy-store.ts",
          ].includes(moduleRelative);
        // WP-2423 / DEC-PERM-CATALOG: release-time Store permission catalog installation.
        const acceptedPermissionCatalogAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          ["permission_definition", "permission_catalog_revision"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/permission-catalog-synchronizer.ts";
        const acceptedPlatformPermissionAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          ["platform_permission_policy_head", "platform_permission_policy_revision"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/platform-permission-store.ts",
            "src/infrastructure/persistence/platform-permission-provisioner.ts",
          ].includes(moduleRelative);
        const acceptedSystemMediaPromotionPermissionAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "system_media_image_promotion_authorization",
            "system_media_image_promotion_authorization_decision",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/system-media-image-promotion-authorization-store.ts",
            "src/infrastructure/persistence/system-media-image-promotion-provisioner.ts",
          ].includes(moduleRelative);
        const acceptedWorkflowDefinitionAsset =
          module.packageName === "@bop/workflow" &&
          module.manifest.ownedDatabase?.schema === "bop_workflow" &&
          module.manifest.ownedDatabase?.tables?.includes("workflow_definition_version") &&
          moduleRelative === "src/infrastructure/persistence/workflow-definition-store.ts";
        const acceptedCurrentLiveGateAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          ["live_gate_version", "live_gate_requirement"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-live-gate-source.ts";
        const acceptedPublishingMutationAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          module.manifest.ownedDatabase?.tables?.includes("publishing_mutation_record") &&
          moduleRelative === "src/infrastructure/persistence/publishing-mutation-store.ts";
        const acceptedOptionPublicationHistoryAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          module.manifest.ownedDatabase?.tables?.includes("publishing_mutation_record") &&
          moduleRelative ===
            "src/infrastructure/persistence/option-set-publication-history-store.ts";
        const acceptedOptionPublicationOperationAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          ["publishing_mutation_record", "option_set_publication_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/option-set-publication-operation-store.ts";
        const acceptedOptionPriceReviewOperationAsset =
          module.packageName === "@bop/publishing" &&
          module.manifest.ownedDatabase?.schema === "bop_publishing" &&
          ["publishing_mutation_record", "option_price_review_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/option-price-review-operation-store.ts";
        const acceptedInventoryFinalValidationAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          module.manifest.ownedDatabase?.tables?.includes("submission_final_validation") &&
          moduleRelative === "src/infrastructure/persistence/submission-final-validation-store.ts";
        const acceptedStockReservationAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item",
            "inventory_item_version",
            "stock_account",
            "stock_balance",
            "stock_movement",
            "stock_reservation_version",
            "stock_reservation_set",
            "stock_lot_hold_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/stock-reservation-store.ts";
        const acceptedOrderLineConsumptionAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          ["stock_balance", "stock_reservation_version"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-line-consumption-store.ts";
        // WP-2423: shared ledger posting steps and Store direct receipts (DEC-INV-DIRECT-RECEIPT).
        const acceptedLedgerPostingAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "stock_lot",
            "stock_account",
            "stock_balance",
            "stock_movement",
            "store_receipt",
            "store_receipt_void",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/ledger-posting.ts",
            "src/infrastructure/persistence/store-receipt-store.ts",
          ].includes(moduleRelative);
        // WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Product list/detail reads and the Store's tax classes.
        const acceptedProductAdministrationAsset =
          (module.packageName === "@rms/catalog" &&
            module.manifest.ownedDatabase?.schema === "rms_catalog" &&
            ["product", "product_version", "sku"].every((table) =>
              module.manifest.ownedDatabase?.tables?.includes(table),
            ) &&
            [
              "src/infrastructure/persistence/product-admin-read-store.ts",
              "src/infrastructure/persistence/menu-draft-store.ts",
              "src/infrastructure/persistence/allergen-declaration-store.ts",
              "src/infrastructure/persistence/menu-admin-read-store.ts",
              "src/infrastructure/persistence/availability-rule-store.ts",
              "src/infrastructure/persistence/option-set-store.ts",
            ].includes(moduleRelative)) ||
          (module.packageName === "@rms/pricing" &&
            module.manifest.ownedDatabase?.schema === "rms_pricing" &&
            ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"].every(
              (table) => module.manifest.ownedDatabase?.tables?.includes(table),
            ) &&
            [
              "src/infrastructure/persistence/store-tax-classification-store.ts",
              "src/infrastructure/persistence/store-price-book-assignment-store.ts",
            ].includes(moduleRelative));
        // WP-2423 / DEC-INV-STOCK-COUNT and DEC-INV-WASTE: Store counts and waste on the ledger.
        const acceptedStockCountWasteAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "stock_count",
            "stock_count_version",
            "stock_count_operation",
            "store_waste",
            "store_waste_review",
            "stock_lot",
            "stock_account",
            "stock_balance",
            "stock_movement",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/stock-count-store.ts",
            "src/infrastructure/persistence/store-waste-store.ts",
          ].includes(moduleRelative);
        // WP-2423 / DEC-INV-OPENING: Store opening count posting to the ledger.
        const acceptedOpeningCountAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "opening_count",
            "opening_count_version",
            "opening_count_posting",
            "stock_lot",
            "stock_account",
            "stock_balance",
            "stock_movement",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/opening-count-store.ts";
        const acceptedStockPlaceAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "stock_site",
            "stock_site_version",
            "storage_location",
            "storage_location_version",
            "stock_place_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/stock-place-store.ts";
        const acceptedStockCandidateAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item_version",
            "stock_account",
            "stock_balance",
            "stock_movement",
            "stock_lot_hold_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/stock-candidate-source.ts";
        const acceptedCatalogAllergenCoverageAsset =
          module.packageName === "@rms/catalog" &&
          module.manifest.ownedDatabase?.schema === "rms_catalog" &&
          [
            "allergen_registry_version",
            "allergen_registry_entry",
            "allergen_source_evidence",
            "allergen_source_assertion",
            "recipe_allergen_source_capture",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/recipe-allergen-coverage-source.ts";
        const acceptedInventoryRecipeCoverageAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item",
            "inventory_item_version",
            "inventory_item_operation",
            "recipe_configuration_source_version",
            "recipe_configuration_source_capture",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/recipe-configuration-coverage-source.ts";
        // WP-2423 / DEC-RECIPE-AUTHORING: Item pins, units and latest Store unit cost for recipes.
        const acceptedInventoryRecipeFactsAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          [
            "inventory_item",
            "inventory_item_version",
            "inventory_item_operation",
            "stock_movement",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/inventory-recipe-facts-store.ts";
        const acceptedInventoryItemAsset =
          module.packageName === "@rms/inventory" &&
          module.manifest.ownedDatabase?.schema === "rms_inventory" &&
          ["inventory_item", "inventory_item_version", "inventory_item_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/inventory-item-store.ts";
        const acceptedAsapCapacityAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          ["capacity_slot", "capacity_asap_commitment"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/asap-capacity-store.ts";
        // WP-2343 admits only the scoped Fulfillment Hold append adapter.
        const acceptedCapacityHoldWriterAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          ["capacity_slot", "capacity_hold"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/capacity-hold-store.ts";
        // WP-2340 admits only the Fulfillment owner capacity history reader.
        const acceptedCapacityQueryAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          [
            "capacity_slot",
            "capacity_hold",
            "capacity_hold_terminal",
            "capacity_allocation",
            "capacity_allocation_terminal",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/capacity-query-store.ts";
        // WP-2256 admits only the Pricing owner reader of complete Quote history.
        const acceptedCurrentQuoteServiceAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          [
            "price_book",
            "price_book_version",
            "price_entry",
            "tax_configuration",
            "tax_configuration_version",
            "tax_configuration_rule",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-quote-service.ts";
        const acceptedCurrentConfiguredQuoteServiceAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          [
            "price_book",
            "price_book_version",
            "price_entry",
            "tax_configuration",
            "tax_configuration_version",
            "tax_configuration_rule",
            "option_price_rule",
            "option_price_rule_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/current-configured-quote-service.ts";
        const acceptedCurrentTaxConfigurationAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-tax-configuration-store.ts";
        const acceptedCurrentOptionPriceAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["option_price_rule", "option_price_rule_version"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-option-price-store.ts";
        const pilotPublicationAsset = {
          "src/infrastructure/persistence/option-set-list-query-store.ts": {
            owner: "catalog",
            tables: [
              "option_set",
              "option_set_version",
              "option",
              "option_conflict",
              "product_option_binding",
            ],
          },
          "src/infrastructure/persistence/option-set-authoring-identity.ts": {
            owner: "catalog",
            tables: [
              "option_set_authoring_identity",
              "option_set_authoring_abandonment",
              "option_set_operation_record",
              "option_set_draft_content_snapshot",
            ],
          },
          "src/infrastructure/persistence/option-set-authoring-resolution-store.ts": {
            owner: "catalog",
            tables: [
              "option_set_authoring_identity",
              "option_set_authoring_abandonment",
              "option_set_operation_record",
              "option_set_draft_content_snapshot",
            ],
          },
          "src/infrastructure/persistence/product-authoring-resolution-store.ts": {
            owner: "catalog",
            tables: [
              "product_operation_record",
              "product_operation_snapshot",
              "product_source_commit",
              "product_authoring_operation_abandonment",
            ],
          },
          "src/infrastructure/persistence/product-publication-resolution-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_operation_record",
              "product_operation_snapshot",
              "product_publication_revision",
              "product_publication_operation_abandonment",
            ],
          },
          "src/infrastructure/persistence/product-publication-warning-acknowledgement-record.ts": {
            owner: "catalog",
            tables: ["product_publication_warning_acknowledgement"],
          },
          "src/infrastructure/persistence/product-publication-warning-acknowledgement-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_version",
              "product_publication_revision",
              "product_publication_validation_report",
              "product_publication_warning_acknowledgement",
            ],
          },
          "src/infrastructure/persistence/product-publication-validation-report-source-store.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/product-publication-validation-report-store.ts": {
            owner: "catalog",
            tables: ["product_publication_revision", "product_publication_validation_report"],
          },
          "src/infrastructure/persistence/product-scope-retirement-store.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/menu-review-option-source.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/menu-review-product-source.ts": {
            owner: "catalog",
            tables: ["sku", "product", "product_version"],
          },
          "src/infrastructure/persistence/allergen-review-facts-store.ts": {
            owner: "catalog",
            tables: [
              "allergen_registry_version",
              "allergen_registry_entry",
              "allergen_source_evidence",
              "allergen_source_assertion",
            ],
          },
          "src/infrastructure/persistence/product-search-generation-store.ts": {
            owner: "catalog",
            tables: [
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
            ],
          },
          "src/infrastructure/persistence/product-source-producer.ts": {
            owner: "catalog",
            tables: ["product_source_head", "product_source_commit", "product_operation_record"],
          },
          "src/infrastructure/persistence/category-repository.ts": {
            owner: "catalog",
            tables: [
              "category",
              "category_operation_record",
              "category_operation_snapshot",
              "category_source_head",
              "category_source_commit",
            ],
          },
          "src/infrastructure/persistence/category-source-store.ts": {
            owner: "catalog",
            tables: [
              "category",
              "category_operation_record",
              "category_operation_snapshot",
              "category_source_head",
              "category_source_commit",
            ],
          },
          "src/infrastructure/persistence/category-source-consumer.ts": {
            owner: "catalog",
            tables: [
              "category",
              "category_operation_record",
              "category_operation_snapshot",
              "category_source_head",
              "category_source_commit",
            ],
          },
          "src/infrastructure/persistence/product-category-assignment.ts": {
            owner: "catalog",
            tables: ["category", "product_version", "product_version_category_assignment"],
          },
          // WP-2421 milestones40/41: exact owning public compositions, no broad exemption.
          // WP-2421: exact Catalog-owned readonly Pricing Binding source.
          "src/infrastructure/persistence/product-option-price-context-source-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_version",
              "sku",
              "product_option_binding",
              "product_option_binding_option",
              "product_option_binding_sku_scope",
              "product_option_binding_channel",
              "product_version_category_assignment",
            ],
          },
          "src/infrastructure/persistence/product-editor-source-store.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/product-whole-scope-replacement-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_publication_revision",
              "product_scope_journal",
              "product_source_head",
              "product_source_commit",
              "product_operation_record",
              "product_operation_snapshot",
            ],
          },
          "src/infrastructure/persistence/product-lifecycle-store.ts": {
            owner: "catalog",
            tables: [
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
          },
          // Public Publishing owner composition; this facade contains no direct SQL.
          "src/infrastructure/persistence/menu-publication-evidence-source.ts": {
            owner: "catalog",
            tables: [],
          },
          "src/infrastructure/persistence/menu-review-content-store.ts": {
            owner: "catalog",
            tables: [
              "menu_review_content",
              "menu_publication_release",
              "menu_publication_operation_snapshot",
            ],
          },
          "src/infrastructure/persistence/menu-publication-repository.ts": {
            owner: "catalog",
            tables: [
              "menu_publication_revision",
              "menu_publication_release",
              "menu_release_effective_period",
              "menu_publication_operation_record",
              "menu_publication_operation_snapshot",
            ],
          },
          // WP-2409: complete reviewed Menu Product reference source.
          "src/infrastructure/persistence/product-menu-source-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "sku",
              "product_version",
              "menu_review_content",
              "menu_publication_revision",
              "menu_publication_release",
              "menu_release_effective_period",
            ],
          },
          // WP-2409: complete Product/SKU Bundle reference statement source.
          "src/infrastructure/persistence/product-bundle-source-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "sku",
              "bundle",
              "bundle_version",
              "bundle_component_group",
              "bundle_component_sellable",
            ],
          },
          // WP-2409: complete Product/SKU Availability reference statement source.
          "src/infrastructure/persistence/availability-reference-source-store.ts": {
            owner: "catalog",
            tables: ["availability_reference_generation", "availability_rule"],
          },
          "src/infrastructure/persistence/product-availability-source-store.ts": {
            owner: "catalog",
            tables: ["product", "sku", "availability_rule"],
          },
          // WP-2409: complete Brand Menu Category reference statement source only.
          "src/infrastructure/persistence/menu-category-source-store.ts": {
            owner: "catalog",
            tables: [
              "menu",
              "menu_version",
              "menu_section",
              "menu_section_category",
              "menu_review_content",
              "menu_publication_revision",
            ],
          },
          "src/infrastructure/persistence/menu-draft-source.ts": {
            owner: "catalog",
            tables: [
              "menu",
              "menu_version",
              "menu_version_store",
              "menu_version_channel",
              "menu_version_order_type",
              "menu_section",
              "menu_section_category",
              "sellable_placement",
            ],
          },
          "src/infrastructure/persistence/menu-pricing-facts-source.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/product-reference-history-source-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_version",
              "product_operation_record",
              "product_operation_snapshot",
              "product_publication_revision",
              "product_source_commit",
            ],
          },
          "src/infrastructure/persistence/product-editor-allergen-registry-source.ts": {
            owner: "catalog",
            tables: ["allergen_registry_version", "allergen_registry_entry"],
          },
          "src/infrastructure/persistence/inventory-sku-reference-source-store.ts": {
            owner: "catalog",
            tables: [
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
          },
          "src/infrastructure/persistence/product-pricing-binding-source-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_version",
              "sku",
              "product_version_category_assignment",
              "product_option_binding",
              "product_option_binding_option",
              "product_option_binding_sku_scope",
              "product_option_binding_channel",
            ],
          },
          "src/infrastructure/persistence/promotion-reference-source-store.ts": {
            owner: "pricing",
            tables: ["promotion", "promotion_version", "promotion_eligibility_reference"],
          },
          "src/infrastructure/persistence/tax-configuration-reference-source-store.ts": {
            owner: "pricing",
            tables: ["tax_configuration", "tax_configuration_version", "tax_configuration_rule"],
          },
          "src/infrastructure/persistence/option-price-reference-source-store.ts": {
            owner: "pricing",
            tables: ["option_price_rule", "option_price_rule_version"],
          },
          "src/infrastructure/persistence/tax-config-authoring-store.ts": {
            owner: "pricing",
            tables: [
              "tax_configuration",
              "tax_configuration_version",
              "tax_configuration_rule",
              "tax_configuration_operation_record",
              "tax_config_authoring_operation",
            ],
          },
          "src/infrastructure/persistence/tax-config-candidate-store.ts": {
            owner: "pricing",
            tables: [
              "tax_config_publication_candidate",
              "tax_config_candidate_rule",
              "tax_config_candidate_operation",
            ],
          },
          "src/infrastructure/persistence/tax-config-material-store.ts": {
            owner: "pricing",
            tables: [
              "tax_config_material",
              "tax_config_material_version",
              "tax_config_material_operation",
            ],
          },
          "src/infrastructure/persistence/option-price-authoring-store.ts": {
            owner: "pricing",
            tables: [
              "option_price_rule",
              "option_price_rule_version",
              "option_price_authoring_operation",
            ],
          },
          // WP-2409: Pricing-owned complete PriceBook entry reference profile.
          "src/infrastructure/persistence/price-book-reference-source-store.ts": {
            owner: "pricing",
            tables: ["price_book", "price_book_version", "price_entry"],
          },
          "src/infrastructure/persistence/configuration-reference-source-store.ts": {
            owner: "pricing",
            tables: [
              "configuration_reference_generation",
              "price_book",
              "option_price_rule",
              "promotion",
            ],
          },
          "src/infrastructure/persistence/price-book-repository.ts": {
            owner: "pricing",
            tables: [
              "price_book",
              "price_book_version",
              "price_entry",
              "price_book_operation_record",
            ],
          },
          "src/infrastructure/persistence/merchant-order-item-labels.ts": {
            owner: "ordering",
            tables: [
              "order_item",
              "order_batch",
              "order_submission_record",
              "additional_dining_batch_record",
            ],
          },
          "src/infrastructure/persistence/merchant-order-index.ts": {
            owner: "ordering",
            tables: ["order_header", "order_submission_record", "order_batch"],
          },
          "src/infrastructure/persistence/order-batch-identity-source.ts": {
            owner: "ordering",
            tables: ["order_header", "order_submission_record", "order_batch"],
          },
          "src/infrastructure/persistence/order-payment-attempt-position.ts": {
            owner: "payment",
            tables: ["payment_intent", "payment_attempt", "payment_terminal_fact"],
          },
          "src/infrastructure/persistence/payment-intent-binding-source.ts": {
            owner: "payment",
            tables: ["payment_intent"],
          },
          "src/infrastructure/persistence/captured-batch-payment-source.ts": {
            owner: "payment",
            tables: ["payment_intent", "payment_terminal_fact"],
          },
        }[moduleRelative];
        const acceptedPilotPublicationAsset =
          pilotPublicationAsset !== undefined &&
          module.packageName === "@rms/" + pilotPublicationAsset.owner &&
          module.manifest.ownedDatabase?.schema === "rms_" + pilotPublicationAsset.owner &&
          pilotPublicationAsset.tables.every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          );
        const acceptedCurrentPriceBookAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["price_book", "price_book_version", "price_entry"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/current-price-book-store.ts";
        const acceptedPriceQuoteQueryAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          module.manifest.ownedDatabase?.tables?.includes("price_quote") &&
          moduleRelative === "src/infrastructure/persistence/price-quote-query-store.ts";
        // WP-2257 admits one append adapter over the existing complete Quote aggregate.
        const acceptedPriceQuoteWriterAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["price_quote", "price_quote_line", "price_quote_tax_line"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/price-quote-store.ts";
        // WP-2258 admits one scoped request-history coordinator over owned Quote persistence.
        const acceptedPriceQuoteRequestAsset =
          module.packageName === "@rms/pricing" &&
          module.manifest.ownedDatabase?.schema === "rms_pricing" &&
          ["price_quote_request", "price_quote", "price_quote_line", "price_quote_tax_line"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/price-quote-request-store.ts";
        // WP-2272 admits only the scoped Dining Table configuration adapter.
        const acceptedDiningTableAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          ["dining_table", "dining_table_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-table-store.ts";
        // WP-2275 admits only the initial Session transaction over Dining-owned storage.
        const acceptedDiningSessionStartAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_join_capability",
            "dining_session_start_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-session-start-store.ts";
        // WP-2277 admits only the scoped Join regeneration transaction.
        const acceptedDiningJoinRegenerationAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_join_capability",
            "dining_join_regeneration_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-join-regeneration-store.ts";
        // WP-2278 admits only the scoped Guest Join owner transaction.
        const acceptedDiningSessionJoinAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_join_capability",
            "dining_participant",
            "dining_identity_admission",
            "dining_session_join_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-session-join-store.ts";
        // WP-2290 admits only the scoped admission-consumption owner transaction.
        const acceptedPaymentIntentCreationAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_intent",
            "payment_attempt",
            "payment_intent_operation_record",
            "payment_provider_observation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-intent-creation-store.ts";
        const acceptedPaymentTerminalSourceAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_intent",
            "payment_attempt",
            "provider_webhook_record",
            "payment_provider_observation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-terminal-source.ts";
        const acceptedPaymentProviderObservationAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_intent",
            "payment_attempt",
            "payment_intent_operation_record",
            "payment_provider_observation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-provider-observation-store.ts";
        const acceptedPaymentStatusStoreAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("payment_status_projection") &&
          moduleRelative === "src/infrastructure/persistence/payment-status-store.ts";
        const acceptedPaymentTerminalStoreAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_intent",
            "payment_attempt",
            "provider_webhook_record",
            "payment_terminal_fact",
            "payment_provider_observation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-terminal-store.ts";
        const acceptedOrderExceptionSourceAsset =
          module.packageName === "@bop/projection" &&
          module.manifest.ownedDatabase?.schema === null &&
          module.manifest.ownedDatabase?.tables?.length === 0 &&
          moduleRelative === "src/infrastructure/persistence/order-exception-source-store.ts";
        const acceptedOrderCancelledAmountAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_batch_checkout_cancellation",
            "order_batch",
            "order_revision",
            "order_item",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-cancelled-amount-source.ts";
        const acceptedPaymentReconciliationCandidatesAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_intent",
            "payment_attempt",
            "payment_reconciliation_record",
            "payment_terminal_fact",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-reconciliation-candidates.ts";
        const acceptedPaymentReconciliationRunAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_reconciliation_run",
            "payment_reconciliation_exception",
            "payment_reconciliation_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-reconciliation-run-source.ts";
        const acceptedReconciliationFollowUpAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["reconciliation_follow_up_history", "payment_reconciliation_exception"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/reconciliation-follow-up-store.ts";
        // WP-2423 P6: full refund of a Provider capture that matches no payment or Order.
        const acceptedUnmatchedCaptureRefundAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "provider_capture_exception_evidence",
            "unmatched_capture_refund_request",
            "unmatched_capture_refund_approval",
            "unmatched_capture_refund_outcome",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/unmatched-capture-refund-store.ts";
        const acceptedProviderCaptureExceptionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["provider_capture_exception_evidence", "payment_reconciliation_exception"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/provider-capture-exception-store.ts";
        const acceptedPaymentReconciliationExceptionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_reconciliation_exception", "payment_reconciliation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-reconciliation-exception-source.ts";
        const acceptedPaymentCompensationExceptionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("payment_compensation_case_history") &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-exception-source.ts";
        const acceptedOrdinaryRefundCaptureAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_intent", "payment_provider_observation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/ordinary-refund-capture-source.ts";
        const acceptedOrdinaryRefundRequestAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("ordinary_refund_request") &&
          moduleRelative === "src/infrastructure/persistence/ordinary-refund-request-store.ts";
        const acceptedOrdinaryRefundOperationAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("ordinary_refund_operation") &&
          moduleRelative === "src/infrastructure/persistence/ordinary-refund-operation-store.ts";
        const acceptedOrdinaryRefundApprovalAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("ordinary_refund_approval") &&
          moduleRelative === "src/infrastructure/persistence/ordinary-refund-approval-store.ts";
        const acceptedPaymentRefundStatusAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_refund_status_projection", "payment_compensation_refund"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/payment-refund-status-store.ts";
        const acceptedPaymentCompensationOperationsAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_compensation_operations",
            "payment_compensation_refund",
            "payment_compensation_case_history",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-operations-store.ts";
        const acceptedPaymentCompensationProviderEvidenceAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_provider_observation",
            "payment_intent",
            "payment_attempt",
            "payment_terminal_fact",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-provider-evidence.ts";
        const acceptedPaymentCompensationEvidenceAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_compensation_refund", "payment_compensation_operations"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-evidence-source.ts";
        const acceptedConfirmedCompensationRefundAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          [
            "payment_compensation_refund",
            "payment_compensation_action_history",
            "payment_terminal_fact",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-refund-source.ts";
        const acceptedPaymentCompensationPositionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_compensation_refund", "payment_compensation_action_history"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-refund-position-source.ts";
        const acceptedPaymentCompensationSourceAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_intent", "payment_provider_observation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-source.ts";
        const acceptedPaymentCompensationRefundAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_compensation_refund", "payment_compensation_case_history"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-refund-store.ts";
        const acceptedPaymentCompensationActionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_compensation_action_history", "payment_compensation_case_history"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-action-store.ts";
        const acceptedPaymentCompensationCaseAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("payment_compensation_case_history") &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-case-store.ts";
        const acceptedPaymentCompensationOperationAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes(
            "payment_compensation_operation_history",
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/payment-compensation-operation-store.ts";
        const acceptedPaymentCompensationLeaseAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("payment_compensation_lease_history") &&
          moduleRelative === "src/infrastructure/persistence/payment-compensation-lease-store.ts";
        const acceptedPaymentTipSelectionAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("payment_tip_selection") &&
          moduleRelative === "src/infrastructure/persistence/payment-tip-selection-store.ts";
        const acceptedDiningCheckoutCommitmentAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_participant",
            "dining_checkout_commitment",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-checkout-commitment-store.ts";
        const acceptedDiningItemServiceAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          module.manifest.ownedDatabase?.tables?.includes("dining_item_service_record") &&
          [
            "src/infrastructure/persistence/dining-item-service-store.ts",
            "src/infrastructure/persistence/dining-item-service-reader.ts",
          ].includes(moduleRelative);
        const acceptedDiningAdmissionConsumptionAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_participant",
            "dining_identity_admission",
            "dining_session_join_operation",
            "dining_admission_consumption_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-admission-consumption-store.ts";
        // WP-2286 admits only fresh Join generation backed by a committed Dining Move.
        const acceptedDiningMovedJoinAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_join_capability",
            "dining_join_regeneration_operation",
            "dining_session_move_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-moved-join-store.ts";
        // WP-2284 admits only the scoped Move owner transaction.
        const acceptedDiningMoveAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          ["dining_table", "dining_session", "dining_session_move_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-move-store.ts";
        // WP-2282 admits only the scoped Closing owner transaction.
        const acceptedDiningExceptionTaskAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          module.manifest.ownedDatabase?.tables?.includes("dining_exception_task") &&
          moduleRelative === "src/infrastructure/persistence/dining-exception-task-store.ts";
        // WP-2402: exact scoped Host-transfer store; normal SQL/driver checks still apply.
        const acceptedDiningHostTransferAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_participant",
            "dining_host_transfer_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-host-transfer-store.ts";
        const acceptedDiningClosingAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          ["dining_session", "dining_closing_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          (moduleRelative === "src/infrastructure/persistence/dining-closing-store.ts" ||
            (moduleRelative === "src/infrastructure/persistence/dining-table-release-store.ts" &&
              module.manifest.ownedDatabase?.tables?.includes("dining_table_release_operation") &&
              module.manifest.ownedDatabase?.tables?.includes("dining_table")) ||
            (moduleRelative === "src/infrastructure/persistence/dining-closing-fence.ts" &&
              module.manifest.ownedDatabase?.tables?.includes("dining_table")));
        // WP-2280 admits only the coherent owner participation reader.
        const acceptedDiningParticipationAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          ["dining_table", "dining_session", "dining_participant"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-participation-store.ts";
        // WP-2299 admits only the coherent owner binding reader with original admission.
        const acceptedDiningGuestBindingAsset =
          module.packageName === "@rms/dining" &&
          module.manifest.ownedDatabase?.schema === "rms_dining" &&
          [
            "dining_table",
            "dining_session",
            "dining_participant",
            "dining_identity_admission",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-guest-binding-store.ts";
        // WP-2352 admits only the owner atomic Order writer with its current Cart dependencies.
        const acceptedOrderAcceptanceAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_acceptance_record",
            "order_batch",
            "order_termination_record",
            "order_revision",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-acceptance-store.ts";
        const acceptedFulfillmentReadinessStoreAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
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
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/fulfillment-readiness-store.ts";
        const acceptedPickupHandoffStoreAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          [
            "fulfillment",
            "pickup_handoff_record",
            "pickup_handoff_item",
            "pickup_handoff_operation",
            "fulfillment_completion_publication",
            // WP-2423: in-person verification when the pickup proof expired or was never issued,
            // and closing a pickup nobody collected.
            "pickup_in_person_verification",
            "pickup_not_collected_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/pickup-handoff-store.ts",
            "src/infrastructure/persistence/pickup-handoff-history.ts",
          ].includes(moduleRelative);
        const acceptedFulfillmentCompletionStoreAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          module.manifest.ownedDatabase?.tables?.includes("fulfillment_completion_publication") &&
          moduleRelative === "src/infrastructure/persistence/fulfillment-completion-store.ts";
        const acceptedPickupProofStoreAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          [
            "fulfillment",
            "pickup_proof_generation",
            "pickup_proof_invalidation",
            "pickup_proof_operation",
            "pickup_proof_verification",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/pickup-proof-store.ts",
            "src/infrastructure/persistence/pickup-proof-history.ts",
            "src/infrastructure/persistence/pickup-proof-issuer.ts",
          ].includes(moduleRelative);
        const acceptedPickupFulfillmentStoreAsset =
          module.packageName === "@rms/fulfillment" &&
          module.manifest.ownedDatabase?.schema === "rms_fulfillment" &&
          ["fulfillment", "fulfillment_item", "fulfillment_creation_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/pickup-fulfillment-store.ts";
        const acceptedKitchenLifecycleRowsAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          [
            "kitchen_work_lifecycle_operation",
            "kitchen_order_item_ready_result",
            "kitchen_ready_publication",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/kitchen-work-lifecycle-rows.ts";
        const acceptedKitchenLifecycleStoreAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          [
            "kitchen_ticket",
            "kitchen_work_item",
            "kitchen_work_lifecycle_operation",
            "kitchen_order_item_ready_result",
            "kitchen_ready_publication",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/kitchen-work-lifecycle-store.ts";
        const acceptedKitchenQueueSourceAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          [
            "kitchen_ticket",
            "kitchen_work_item",
            "kitchen_creation_record",
            "kitchen_work_lifecycle_operation",
            "kitchen_order_item_ready_result",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/kitchen-queue-source-reader.ts";
        const acceptedKitchenQueueQueriesAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          ["kitchen_work_queue_projection", "kitchen_work_queue_projection_generation"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/kitchen-queue-queries.ts",
            "src/infrastructure/persistence/kitchen-queue-projection-store.ts",
          ].includes(moduleRelative);
        const acceptedKitchenCustomerStatusAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          ["kitchen_ticket", "kitchen_work_item", "kitchen_order_item_ready_result"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/kitchen-customer-status-reader.ts";
        const acceptedKitchenRoutingConfigurationAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          module.manifest.ownedDatabase?.tables?.includes("kitchen_routing_configuration") &&
          moduleRelative ===
            "src/infrastructure/persistence/kitchen-routing-configuration-store.ts";
        const acceptedKdsOperatorShiftAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          ["kds_operator_shift_event", "kds_operator_handover"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/kds-operator-shift-store.ts";
        const acceptedKitchenTicketAsset =
          module.packageName === "@rms/kitchen" &&
          module.manifest.ownedDatabase?.schema === "rms_kitchen" &&
          [
            "kitchen_ticket",
            "kitchen_work_item",
            "kitchen_action_record",
            "kitchen_creation_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/kitchen-ticket-store.ts";
        const acceptedOrderFulfillmentSourceAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_payment_disposition_record",
            "order_header",
            "order_batch",
            "order_item",
            "order_submission_record",
            "order_acceptance_record",
            "order_termination_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-fulfillment-source-store.ts";
        const acceptedOrderItemInventoryLinkAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_item", "order_batch"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-item-inventory-link-reader.ts";
        const acceptedOrderKitchenSourceAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_payment_disposition_record",
            "order_header",
            "order_batch",
            "order_item",
            "order_submission_record",
            "order_acceptance_record",
            "order_termination_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-kitchen-source-store.ts";
        const acceptedPaymentReceiptCoverageAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          ["payment_intent", "payment_provider_observation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/payment-receipt-coverage-source.ts";
        // WP-2423: Tenant owner's Store opening scope confirmation.
        const acceptedStoreOpeningScopeAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          module.manifest.ownedDatabase?.tables?.includes("store") &&
          moduleRelative === "src/infrastructure/persistence/store-opening-scope-source.ts";
        // WP-2423: Store staff role assignment (IAM-USER-DETAIL).
        const acceptedRoleAssignmentAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "role_assignment",
            "role_assignment_change",
            "role_assignment_change_decision",
            "role",
            "role_administration_version",
            "policy_state",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/role-assignment-store.ts";
        // WP-2423: Store role administration (IAM-ROLE-LIST / IAM-ROLE-EDITOR).
        const acceptedRoleAdministrationAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "role_administration_version",
            "role_administration_permission",
            "role_administration_decision",
            "role_administration_operation",
            "role",
            "role_assignment",
            "permission_definition",
            "permission_grant",
            "policy_state",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/role-administration-store.ts";
        // WP-2423 / DEC-PERM-CATALOG: signed Store opening role provisioning.
        const acceptedStoreRoleProvisioningAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "store_role_provisioning",
            "permission_catalog_revision",
            "policy_state",
            "permission_definition",
            "role",
            "role_assignment",
            "permission_grant",
            "role_administration_version",
            "role_administration_permission",
            "role_administration_decision",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/store-role-provisioning-store.ts";
        // WP-2423 / DEC-PERM-BRAND-ROLES: signed Brand role provisioning.
        const acceptedBrandRoleProvisioningAsset =
          module.packageName === "@bop/permission" &&
          module.manifest.ownedDatabase?.schema === "bop_permission" &&
          [
            "brand_role_provisioning",
            "permission_catalog_revision",
            "policy_state",
            "permission_definition",
            "role",
            "role_assignment",
            "permission_grant",
            "role_administration_version",
            "role_administration_permission",
            "role_administration_decision",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/brand-role-provisioning-store.ts";
        const acceptedReceiptStoreIdentityAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          module.manifest.ownedDatabase?.tables?.includes("store") &&
          moduleRelative === "src/infrastructure/persistence/receipt-store-identity-source.ts";
        const acceptedReceiptIssuerAsset =
          module.packageName === "@bop/operating-entity" &&
          module.manifest.ownedDatabase?.schema === "bop_operating_entity" &&
          ["store_operating_entity_assignment", "operating_entity"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/receipt-issuer-source.ts";
        const acceptedTaxRegistrantSourceAsset =
          module.packageName === "@bop/operating-entity" &&
          module.manifest.ownedDatabase?.schema === "bop_operating_entity" &&
          [
            "store_operating_entity_assignment",
            "operating_entity",
            "operating_entity_profile_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/tax-registrant-source.ts";
        const acceptedReceiptTemplateAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          module.manifest.ownedDatabase?.tables?.includes("digital_receipt_template_version") &&
          moduleRelative === "src/infrastructure/persistence/digital-receipt-template-store.ts";
        const acceptedReceiptTemplateArtifactAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          [
            "digital_receipt_template_artifact_version",
            "digital_receipt_template_artifact_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/digital-receipt-template-artifact-store.ts";
        const acceptedReceiptTemplateDraftAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          [
            "digital_receipt_template_draft_revision",
            "digital_receipt_template_draft_operation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/digital-receipt-template-draft-store.ts";
        const acceptedReceiptTemplateSubmissionAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          ["digital_receipt_template_draft_revision", "digital_receipt_template_submission"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/digital-receipt-template-submission-store.ts";
        const acceptedReceiptTemplateSubmitAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          [
            "digital_receipt_template_submit_operation",
            "digital_receipt_template_submission",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/digital-receipt-template-submit-store.ts";
        const acceptedReceiptTemplateLifecycleAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          [
            "digital_receipt_template_lifecycle_operation",
            "digital_receipt_template_submission",
            "digital_receipt_template_version",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative ===
            "src/infrastructure/persistence/digital-receipt-template-lifecycle-store.ts";
        const acceptedReceiptOrderAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_header", "order_submission_record", "order_batch", "order_item"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          [
            "src/infrastructure/persistence/receipt-order-source.ts",
            "src/infrastructure/persistence/submitted-order-amount-source.ts",
          ].includes(moduleRelative);
        const acceptedDigitalReceiptAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["digital_receipt_record", "order_header", "order_submission_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/digital-receipt-store.ts";
        const submittedTables = {
          "src/infrastructure/persistence/order-submitted-consumer.ts": [
            "order_status_projection",
            "order_status_projection_generation",
          ],
          "src/infrastructure/persistence/order-submitted-history-source.ts": [
            "order_revision",
            "order_acceptance_record",
            "additional_dining_batch_record",
            "order_header",
            "order_submission_record",
            "order_batch",
            "order_item",
          ],
        }[moduleRelative];
        const acceptedSubmittedOwnerAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          submittedTables !== undefined &&
          submittedTables.every((table) => module.manifest.ownedDatabase?.tables?.includes(table));
        const acceptedOrderRefundBasisAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_batch", "order_item", "order_submission_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-refund-basis-reader.ts";
        const acceptedAdditionalDiningBatchAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "additional_dining_batch_record",
            "order_header",
            "order_revision",
            "order_batch",
            "order_item",
            "order_submission_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/additional-dining-batch-store.ts",
            "src/infrastructure/persistence/additional-dining-execution-reader.ts",
            "src/infrastructure/persistence/dining-order-item-state-reader.ts",
          ].includes(moduleRelative);
        const acceptedOrderFulfillmentCompletionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_fulfillment_completion_record", "order_header", "order_revision"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-fulfillment-completion-store.ts";
        const acceptedOrderStatusProjectionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_status_projection", "order_status_projection_generation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-status-projection-store.ts";
        const acceptedOrderTerminationAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_termination_record",
            "order_revision",
            "order_fulfillment_completion_record",
            "order_acceptance_record",
            "order_header",
            "order_batch",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-termination-store.ts";
        const acceptedOrderPaymentDispositionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_payment_disposition_record", "order_batch"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-payment-disposition-store.ts";
        const acceptedTaskStoreAsset =
          module.packageName === "@bop/task" &&
          module.manifest.ownedDatabase?.schema === "bop_task" &&
          module.manifest.ownedDatabase?.tables?.includes("task_version") &&
          moduleRelative === "src/infrastructure/persistence/task-store.ts";
        const acceptedOrderSettledFinalityAsset =
          module.packageName === "@rms/payment" &&
          module.manifest.ownedDatabase?.schema === "rms_payment" &&
          module.manifest.ownedDatabase?.tables?.includes("order_settled_finality") &&
          moduleRelative === "src/infrastructure/persistence/order-settled-finality-store.ts";
        const acceptedBatchCheckoutExpiryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          module.manifest.ownedDatabase?.tables?.includes("order_batch_checkout_expiry") &&
          moduleRelative === "src/infrastructure/persistence/order-batch-checkout-expiry-store.ts";
        const acceptedOrderClosurePositionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          module.manifest.ownedDatabase?.tables?.includes("order_closure_version") &&
          [
            "src/infrastructure/persistence/order-closure-position.ts",
            "src/infrastructure/persistence/order-closure-store.ts",
          ].includes(moduleRelative);
        const acceptedOrderRevisionPositionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_header",
            "order_batch",
            "order_revision",
            "order_submission_record",
            "additional_dining_batch_record",
            "order_acceptance_record",
            "order_termination_record",
            "order_fulfillment_completion_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-revision-position.ts";
        const acceptedOrderCancellationRequestAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_header", "order_cancellation_request_version"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/order-cancellation-request-store.ts";
        const acceptedDiningSessionOrderInventoryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_header",
            "order_batch",
            "order_submission_record",
            "order_amendment",
            "order_amendment_state_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/dining-session-order-inventory.ts";
        const acceptedDiningSessionOrderLookupAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          module.manifest.ownedDatabase?.tables?.includes("order_header") &&
          moduleRelative === "src/infrastructure/persistence/dining-session-order-lookup.ts";
        const acceptedOrderPaymentWaitAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["order_payment_acceptance_wait", "order_payment_disposition_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative ===
            "src/infrastructure/persistence/order-payment-acceptance-wait-store.ts";
        const acceptedOrderPaymentFailureAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          module.manifest.ownedDatabase?.tables?.includes("order_payment_failure_record") &&
          moduleRelative === "src/infrastructure/persistence/order-payment-failure-store.ts";
        const acceptedOrderCreationWriterAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "cart",
            "cart_line",
            "order_number_counter",
            "order_number_allocation",
            "order_header",
            "order_submission_record",
            "order_revision",
            "order_batch",
            "order_item",
            "order_capacity_link",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-creation-store.ts";
        // WP-2350 admits only the scoped immutable Order submission reader.
        const acceptedOrderCreationQueryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "order_submission_record",
            "order_header",
            "order_batch",
            "order_item",
            "order_number_allocation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/order-creation-query-store.ts";
        // WP-2223 accepts only the Ordering reader over its existing Cart and line tables.
        const acceptedCartQueryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/cart-query-store.ts";
        // WP-2314 admits only the current shared Dining Cart reader using the owned aggregate reader.
        const acceptedDiningCartQueryAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "dining_cart_replacement"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-cart-read-store.ts";
        // WP-2316 admits only the atomic owner writer with its operation and Cart tables.
        const acceptedDiningCartSelectionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "dining_cart_operation", "dining_cart_replacement"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-cart-selection-store.ts";
        // WP-2402 accepts only the scoped replacement writer with its owned association.
        const acceptedDiningCartReplacementAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "dining_cart_replacement"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/dining-cart-replacement-store.ts";
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
        const acceptedCartQuoteAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "cart",
            "cart_line",
            "cart_quote_attachment",
            "cart_quote_attachment_line",
            "cart_quote_expiry_record",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          [
            "src/infrastructure/persistence/cart-quote-store.ts",
            "src/infrastructure/persistence/cart-quote-expiry-store.ts",
          ].includes(moduleRelative);
        const acceptedCheckoutSessionAllocationAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "checkout_session_allocation", "order_submission_record", "order_batch"].every(
            (table) => module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/checkout-session-allocation-store.ts";
        const acceptedCheckoutSessionAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          [
            "cart",
            "cart_quote_attachment",
            "checkout_session_record",
            "checkout_session_allocation",
          ].every((table) => module.manifest.ownedDatabase?.tables?.includes(table)) &&
          moduleRelative === "src/infrastructure/persistence/checkout-session-store.ts";
        const acceptedCheckoutDetailsAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "checkout_details_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/checkout-details-store.ts";
        const acceptedCartLifecycleAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "cart_lifecycle_operation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/cart-lifecycle-store.ts";
        const acceptedPickupBindingAsset =
          module.packageName === "@rms/ordering" &&
          module.manifest.ownedDatabase?.schema === "rms_ordering" &&
          ["cart", "cart_line", "cart_binding_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/pickup-cart-binding-store.ts";
        if (
          (moduleRelative.startsWith("src/infrastructure/persistence/") ||
            moduleRelative.startsWith("migrations/") ||
            extname(path).toLowerCase() === ".sql") &&
          ![...sharedAuthorityModules.values()].includes(module.packageName) &&
          !acceptedGuestEntryAdmissionAsset &&
          !acceptedGuestEntryAsset &&
          !acceptedGuestBindingAsset &&
          !acceptedGuestDiningBindingAsset &&
          !acceptedPublishedMenuAsset &&
          !acceptedCategoryRepositoryAsset &&
          !acceptedProductCategoryAssignmentAsset &&
          !acceptedProductDraftBaselineAsset &&
          !acceptedProductPublicationAsset &&
          !acceptedProductContentRegistryAsset &&
          !acceptedProductTaxClassificationRegistryAsset &&
          !acceptedSellingUnitRegistryAsset &&
          !acceptedMediaUploadAsset &&
          !acceptedMediaObjectBindingAsset &&
          !acceptedMediaImageProcessingAsset &&
          !acceptedMediaWorkerCompositionAsset &&
          !acceptedFullOptionDraftAsset &&
          !acceptedOptionReviewReleaseAsset &&
          !acceptedOptionHistoryAsset &&
          !acceptedAvailabilityQueryAsset &&
          !acceptedMenuReferenceSourceAsset &&
          !acceptedBundleReferenceSourceAsset &&
          !acceptedCurrentMenuReleaseAsset &&
          !acceptedCurrentMenuPlacementAsset &&
          !acceptedCurrentSelectionFactsAsset &&
          !acceptedKillSwitchQueryAsset &&
          !acceptedCatalogProductListAsset &&
          !acceptedFeatureControlAdministrationQueryAsset &&
          !acceptedCatalogProductPublicationSourceAsset &&
          !acceptedCatalogProductTaxCoverageSourceAsset &&
          !acceptedCurrentSkuAsset &&
          !acceptedCurrentOptionBindingsAsset &&
          !acceptedCapacityQueryAsset &&
          !acceptedCapacityHoldWriterAsset &&
          !acceptedAsapCapacityAsset &&
          !acceptedInventoryItemAsset &&
          !acceptedInventoryRecipeFactsAsset &&
          !acceptedCatalogAllergenCoverageAsset &&
          !acceptedInventoryRecipeCoverageAsset &&
          !acceptedStockCandidateAsset &&
          !acceptedInventoryFinalValidationAsset &&
          !acceptedStockReservationAsset &&
          !acceptedOrderLineConsumptionAsset &&
          !acceptedStockPlaceAsset &&
          !acceptedOpeningCountAsset &&
          !acceptedStockCountWasteAsset &&
          !acceptedProductAdministrationAsset &&
          !acceptedLedgerPostingAsset &&
          !acceptedOrderItemInventoryLinkAsset &&
          !acceptedBrowserSessionSelectionAsset &&
          !acceptedBrowserBrandSessionSelectionAsset &&
          !acceptedBrandCatalogSourceAsset &&
          !acceptedBrandTaxReferenceAsset &&
          !acceptedSelectedTaxReferenceAsset &&
          !acceptedTenantStoreReferenceAsset &&
          !acceptedMerchantOrganizationAsset &&
          !acceptedBrandLifecycleAsset &&
          !acceptedBrandConfigurationAuthoringAsset &&
          !acceptedPlatformBrandTemplateAsset &&
          !acceptedBrandStoreTopologyDraftAsset &&
          !acceptedBrowserSessionStoreAsset &&
          !acceptedOidcAuthorizationAsset &&
          !acceptedCurrentBrowserSessionAsset &&
          !acceptedPlatformActorDirectoryAsset &&
          !acceptedWorkforceAccountBindingAsset &&
          !acceptedWorkforceOnboardingOperationAsset &&
          !acceptedPlatformTemplatePublishingAsset &&
          !acceptedCurrentWorkforceMfaAsset &&
          !acceptedCurrentWorkforceInvitationAsset &&
          !acceptedWorkforceInvitationStoreAsset &&
          !acceptedStoreExceptionContentAsset &&
          !acceptedStorePauseHistoryAsset &&
          !acceptedStorePublicationContentAsset &&
          !acceptedStorePublicationMaterializerAsset &&
          !acceptedStoreSetupDraftAsset &&
          !acceptedStoreSetupReferenceAsset &&
          !acceptedStorePaymentConfigurationAsset &&
          !acceptedStoreAuthoringAsset &&
          !acceptedStoreConfigurationOriginalAsset &&
          !acceptedStoreReviewSnapshotAsset &&
          !acceptedPublicStoreProfileTimingAsset &&
          !acceptedPublicStoreProfileAsset &&
          !acceptedStoreServiceControlAsset &&
          !acceptedStoreWeeklyScheduleAsset &&
          !acceptedStoreBusinessDateAsset &&
          !acceptedCurrentMembershipAsset &&
          !acceptedInitialBrandMembershipAsset &&
          !acceptedApprovedWorkforceMembershipAsset &&
          !acceptedMembershipBrandDiscoveryAsset &&
          !acceptedCurrentPermissionAsset &&
          !acceptedInitialBrandPermissionAsset &&
          !acceptedPlatformPermissionAsset &&
          !acceptedPermissionCatalogAsset &&
          !acceptedSystemMediaPromotionPermissionAsset &&
          !acceptedWorkflowDefinitionAsset &&
          !acceptedCurrentLiveGateAsset &&
          !acceptedPublishingMutationAsset &&
          !acceptedOptionPublicationOperationAsset &&
          !acceptedOptionPriceReviewOperationAsset &&
          !acceptedOptionPublicationHistoryAsset &&
          !acceptedRecipeReferenceAsset &&
          !acceptedRecipeInventoryReferenceAsset &&
          !acceptedRecipeStoreAsset &&
          !acceptedRecipeAuthoringAsset &&
          !acceptedRecipePreparationContentAsset &&
          !acceptedRecipeVersionAsset &&
          !acceptedRecipeModifierAsset &&
          !acceptedRecipeDemandAsset &&
          !acceptedRecipeBindingAsset &&
          !acceptedRecipeOwnerCoverageAsset &&
          !acceptedRecipeCoveragePublicationAsset &&
          !acceptedRecipeCorePublicationAsset &&
          !acceptedRecipeCoreQueryAsset &&
          !acceptedRecipeCoreRebuildStateAsset &&
          !acceptedRecipeQueryAsset &&
          !acceptedRecipeAdminQueryAsset &&
          !acceptedLotHoldAsset &&
          !acceptedInventoryConfigurationReferenceAsset &&
          !acceptedInventorySkuMappingAsset &&
          !acceptedCurrentPickupCapacityAsset &&
          !acceptedCapacityHoldTransitionAsset &&
          !acceptedCapacityAllocationTerminalAsset &&
          !acceptedCurrentQuoteServiceAsset &&
          !acceptedCurrentConfiguredQuoteServiceAsset &&
          !acceptedCurrentTaxConfigurationAsset &&
          !acceptedCurrentPriceBookAsset &&
          !acceptedPilotPublicationAsset &&
          !acceptedCurrentOptionPriceAsset &&
          !acceptedPriceQuoteQueryAsset &&
          !acceptedPriceQuoteWriterAsset &&
          !acceptedPriceQuoteRequestAsset &&
          !acceptedDiningTableAsset &&
          !acceptedDiningSessionStartAsset &&
          !acceptedDiningJoinRegenerationAsset &&
          !acceptedDiningSessionJoinAsset &&
          !acceptedDiningParticipationAsset &&
          !acceptedDiningGuestBindingAsset &&
          !acceptedDiningExceptionTaskAsset &&
          !acceptedDiningClosingAsset &&
          !acceptedDiningHostTransferAsset &&
          !acceptedDiningMoveAsset &&
          !acceptedDiningMovedJoinAsset &&
          !acceptedDiningAdmissionConsumptionAsset &&
          !acceptedDiningCheckoutCommitmentAsset &&
          !acceptedDiningItemServiceAsset &&
          !acceptedPaymentTipSelectionAsset &&
          !acceptedPaymentCompensationLeaseAsset &&
          !acceptedPaymentCompensationOperationAsset &&
          !acceptedPaymentCompensationCaseAsset &&
          !acceptedOrderExceptionSourceAsset &&
          !acceptedPaymentCompensationExceptionAsset &&
          !acceptedOrderCancelledAmountAsset &&
          !acceptedPaymentReconciliationCandidatesAsset &&
          !acceptedPaymentReconciliationRunAsset &&
          !acceptedReconciliationFollowUpAsset &&
          !acceptedUnmatchedCaptureRefundAsset &&
          !acceptedProviderCaptureExceptionAsset &&
          !acceptedPaymentReconciliationExceptionAsset &&
          !acceptedOrdinaryRefundCaptureAsset &&
          !acceptedOrdinaryRefundRequestAsset &&
          !acceptedOrdinaryRefundOperationAsset &&
          !acceptedOrdinaryRefundApprovalAsset &&
          !acceptedPaymentRefundStatusAsset &&
          !acceptedPaymentCompensationOperationsAsset &&
          !acceptedPaymentCompensationProviderEvidenceAsset &&
          !acceptedPaymentCompensationEvidenceAsset &&
          !acceptedPaymentCompensationPositionAsset &&
          !acceptedConfirmedCompensationRefundAsset &&
          !acceptedPaymentCompensationSourceAsset &&
          !acceptedPaymentCompensationRefundAsset &&
          !acceptedPaymentCompensationActionAsset &&
          !acceptedPaymentIntentCreationAsset &&
          !acceptedPaymentTerminalSourceAsset &&
          !acceptedPaymentProviderObservationAsset &&
          !acceptedPaymentStatusStoreAsset &&
          !acceptedPaymentTerminalStoreAsset &&
          !acceptedCartQueryAsset &&
          !acceptedOrderCreationQueryAsset &&
          !acceptedOrderCreationWriterAsset &&
          !acceptedOrderPaymentFailureAsset &&
          !acceptedOrderAcceptanceAsset &&
          !acceptedOrderTerminationAsset &&
          !acceptedOrderStatusProjectionAsset &&
          !acceptedPaymentReceiptCoverageAsset &&
          !acceptedReceiptStoreIdentityAsset &&
          !acceptedStoreOpeningScopeAsset &&
          !acceptedStoreRoleProvisioningAsset &&
          !acceptedBrandRoleProvisioningAsset &&
          !acceptedRoleAdministrationAsset &&
          !acceptedRoleAssignmentAsset &&
          !acceptedReceiptIssuerAsset &&
          !acceptedTaxRegistrantSourceAsset &&
          !acceptedDigitalReceiptAsset &&
          !acceptedReceiptTemplateAsset &&
          !acceptedReceiptTemplateArtifactAsset &&
          !acceptedReceiptTemplateDraftAsset &&
          !acceptedReceiptTemplateSubmissionAsset &&
          !acceptedReceiptTemplateSubmitAsset &&
          !acceptedReceiptTemplateLifecycleAsset &&
          !acceptedReceiptOrderAsset &&
          !acceptedOrderFulfillmentCompletionAsset &&
          !acceptedSubmittedOwnerAsset &&
          !acceptedOrderRefundBasisAsset &&
          !acceptedAdditionalDiningBatchAsset &&
          !acceptedOrderKitchenSourceAsset &&
          !acceptedOrderFulfillmentSourceAsset &&
          !acceptedKitchenTicketAsset &&
          !acceptedKitchenLifecycleRowsAsset &&
          !acceptedPickupFulfillmentStoreAsset &&
          !acceptedFulfillmentReadinessStoreAsset &&
          !acceptedPickupProofStoreAsset &&
          !acceptedPickupHandoffStoreAsset &&
          !acceptedFulfillmentCompletionStoreAsset &&
          !acceptedKitchenLifecycleStoreAsset &&
          !acceptedKitchenQueueQueriesAsset &&
          !acceptedKitchenQueueSourceAsset &&
          !acceptedKitchenCustomerStatusAsset &&
          !acceptedKitchenRoutingConfigurationAsset &&
          !acceptedKdsOperatorShiftAsset &&
          !acceptedOrderPaymentDispositionAsset &&
          !acceptedOrderPaymentWaitAsset &&
          !acceptedTaskStoreAsset &&
          !acceptedOrderSettledFinalityAsset &&
          !acceptedBatchCheckoutExpiryAsset &&
          !acceptedOrderClosurePositionAsset &&
          !acceptedOrderRevisionPositionAsset &&
          !acceptedOrderCancellationRequestAsset &&
          !acceptedDiningSessionOrderInventoryAsset &&
          !acceptedDiningSessionOrderLookupAsset &&
          !acceptedDiningCartQueryAsset &&
          !acceptedDiningCartSelectionAsset &&
          !acceptedDiningCartReplacementAsset &&
          !acceptedCartOperationAsset &&
          !acceptedCartItemWriterAsset &&
          !acceptedPickupBindingAsset &&
          !acceptedCartLifecycleAsset &&
          !acceptedCartQuoteAsset &&
          !acceptedCheckoutSessionAllocationAsset &&
          !acceptedCheckoutSessionAsset &&
          !acceptedCheckoutDetailsAsset
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
          if (acceptedMediaWorkerCompositionAsset && !mediaWorkerCompositionOnly(text, file))
            diagnostics.push(
              diag(
                "UNSUPPORTED_DATABASE_ASSET",
                file,
                "Media Worker composition forwards owning factories only; direct SQL/query access is not permitted",
              ),
            );
          if (acceptedProductDraftBaselineAsset && !productDraftOwnerCompositionSqlOnly(text, file))
            diagnostics.push(
              diag(
                "UNSUPPORTED_DATABASE_ASSET",
                file,
                "Draft owner composition permits only exact setup SQL and the owning current-candidate code boolean read via direct tx.query",
              ),
            );

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
    !(
      shared &&
      access.target.schema === "platform_projection" &&
      access.target.table === "order_exception_source" &&
      access.principal.kind === "projection-builder" &&
      access.principal.id === "@bop/projection.order-exception.v1" &&
      access.source ===
        "packages/bop/projection/src/infrastructure/persistence/order-exception-source-store.ts" &&
      access.readPattern === "public-query-contract"
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
      ((!["@bop/audit", "@bop/eventing"].includes(module.packageName) &&
        !(
          module.packageName === "@bop/projection" &&
          Array.isArray(evidence.accesses) &&
          evidence.accesses.every(
            (access) =>
              access.target?.schema === "platform_projection" &&
              access.target?.table === "order_exception_source" &&
              access.principal?.kind === "projection-builder" &&
              access.principal?.id === "@bop/projection.order-exception.v1" &&
              access.source ===
                "packages/bop/projection/src/infrastructure/persistence/order-exception-source-store.ts",
          )
        )) ||
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

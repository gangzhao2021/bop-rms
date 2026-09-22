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
        const acceptedKillSwitchQueryAsset =
          module.packageName === "@bop/feature-control" &&
          module.manifest.ownedDatabase?.schema === "bop_feature_control" &&
          module.manifest.ownedDatabase?.tables?.includes("kill_switch_version") &&
          moduleRelative === "src/infrastructure/persistence/kill-switch-query-store.ts";
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
        const acceptedRecipeQueryAsset =
          module.packageName === "@rms/recipe" &&
          module.manifest.ownedDatabase?.schema === "rms_recipe" &&
          ["recipe", "recipe_version", "recipe_operation_record"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/recipe-query-store.ts";
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
        const acceptedBrandLifecycleAsset =
          module.packageName === "@bop/tenant" &&
          module.manifest.ownedDatabase?.schema === "bop_tenant" &&
          ["brand", "brand_admin_operation"].every((table) =>
            module.manifest.ownedDatabase?.tables?.includes(table),
          ) &&
          moduleRelative === "src/infrastructure/persistence/brand-lifecycle-store.ts";
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
          moduleRelative === "src/infrastructure/persistence/current-browser-session-source.ts";
        const acceptedCurrentWorkforceMfaAsset =
          module.packageName === "@bop/identity" &&
          module.manifest.ownedDatabase?.schema === "bop_identity" &&
          module.manifest.ownedDatabase?.tables?.includes("workforce_mfa_status") &&
          moduleRelative === "src/infrastructure/persistence/current-workforce-mfa-source.ts";
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
        const acceptedStoreAuthoringAsset =
          module.packageName === "@rms/store" &&
          module.manifest.ownedDatabase?.schema === "rms_store" &&
          module.manifest.ownedDatabase?.tables?.includes(
            "store_configuration_authoring_operation",
          ) &&
          moduleRelative === "src/infrastructure/persistence/configuration-authoring-store.ts";
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
          moduleRelative === "src/infrastructure/persistence/current-membership-store.ts";
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
          "src/infrastructure/persistence/product-lifecycle-store.ts": {
            owner: "catalog",
            tables: [
              "product",
              "product_version",
              "sku",
              "product_operation_record",
              "product_operation_snapshot",
              "product_option_binding",
              "product_option_binding_option",
              "product_option_binding_sku_scope",
              "product_option_binding_channel",
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
        const acceptedReceiptTemplateAsset =
          module.packageName === "@rms/printing-device" &&
          module.manifest.ownedDatabase?.schema === "rms_device" &&
          module.manifest.ownedDatabase?.tables?.includes("digital_receipt_template_version") &&
          moduleRelative === "src/infrastructure/persistence/digital-receipt-template-store.ts";
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
          !acceptedAvailabilityQueryAsset &&
          !acceptedCurrentMenuReleaseAsset &&
          !acceptedCurrentMenuPlacementAsset &&
          !acceptedCurrentSelectionFactsAsset &&
          !acceptedKillSwitchQueryAsset &&
          !acceptedCurrentSkuAsset &&
          !acceptedCurrentOptionBindingsAsset &&
          !acceptedCapacityQueryAsset &&
          !acceptedCapacityHoldWriterAsset &&
          !acceptedAsapCapacityAsset &&
          !acceptedInventoryItemAsset &&
          !acceptedStockCandidateAsset &&
          !acceptedInventoryFinalValidationAsset &&
          !acceptedStockReservationAsset &&
          !acceptedBrowserSessionSelectionAsset &&
          !acceptedMerchantOrganizationAsset &&
          !acceptedBrandLifecycleAsset &&
          !acceptedBrowserSessionStoreAsset &&
          !acceptedOidcAuthorizationAsset &&
          !acceptedCurrentBrowserSessionAsset &&
          !acceptedCurrentWorkforceMfaAsset &&
          !acceptedStoreExceptionContentAsset &&
          !acceptedStorePauseHistoryAsset &&
          !acceptedStorePublicationContentAsset &&
          !acceptedStorePublicationMaterializerAsset &&
          !acceptedStoreAuthoringAsset &&
          !acceptedStoreReviewSnapshotAsset &&
          !acceptedPublicStoreProfileTimingAsset &&
          !acceptedPublicStoreProfileAsset &&
          !acceptedStoreServiceControlAsset &&
          !acceptedStoreWeeklyScheduleAsset &&
          !acceptedStoreBusinessDateAsset &&
          !acceptedCurrentMembershipAsset &&
          !acceptedCurrentPermissionAsset &&
          !acceptedWorkflowDefinitionAsset &&
          !acceptedCurrentLiveGateAsset &&
          !acceptedPublishingMutationAsset &&
          !acceptedRecipeStoreAsset &&
          !acceptedRecipePreparationContentAsset &&
          !acceptedRecipeVersionAsset &&
          !acceptedRecipeModifierAsset &&
          !acceptedRecipeDemandAsset &&
          !acceptedRecipeBindingAsset &&
          !acceptedRecipeQueryAsset &&
          !acceptedLotHoldAsset &&
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
          !acceptedReceiptIssuerAsset &&
          !acceptedDigitalReceiptAsset &&
          !acceptedReceiptTemplateAsset &&
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

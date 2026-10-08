import { cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findCaseFoldConflicts, readMigrationCatalog } from "./catalog.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join("/tmp", "bop-rms-wp0020-catalog-"));
  roots.push(root);
  await cp(path.join(repositoryRoot, "migrations"), path.join(root, "migrations"), {
    recursive: true,
  });
  return root;
}

const migrationPath = (root: string) =>
  path.join(root, "migrations", "0000-platform", "0000_001_create_migration_history.sql");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("migration catalog", () => {
  it("extends only the existing Option action checks for exact historical reads", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(catalog.diagnostics).toEqual([]);
    const previous = catalog.migrations.find(
      (value) => value.id === "0300_008_alter_option_publication_action_identifier",
    );
    const migration = catalog.migrations.find(
      (value) => value.id === "0300_009_alter_option_history_action_identifier",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@bop/permission",
      schema: "bop_permission",
      phase: "expand",
      risk: "medium",
      recovery: "forward-fix",
    });
    const body = (sql: string) => sql.slice(sql.indexOf("ALTER TABLE"));
    if (!migration || !previous) throw new Error("Missing canonical Option action migration");
    expect(migration.sql).toContain("-- transaction: required");
    expect(body(migration.sql)).toBe(
      body(previous.sql).replaceAll(
        "'catalog.option_set.publish'",
        "'catalog.option_set.publish', 'catalog.option_set.history.read'",
      ),
    );
    expect(migration?.sql).not.toMatch(
      /^\s*(?:GRANT|INSERT|UPDATE|DELETE|CREATE|DISABLE|SECURITY\s+DEFINER)\b/imu,
    );
  });

  it("registers immutable scan admissions and requires them only for new processing intents", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(catalog.diagnostics).toEqual([]);
    const migration = catalog.migrations.find(
      (value) => value.id === "0400_013_create_media_image_scan_admission",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/media", schema: "bop_media" });
    for (const text of [
      "CREATE TABLE bop_media.image_scan_admission",
      "UNIQUE(provider_account,region,event_id)",
      "ADD COLUMN scan_admission_id platform_helpers.uuid_v7",
      "CHECK (scan_admission_id IS NOT NULL) NOT VALID",
      "media_image_processing_admission_origin AFTER INSERT",
      "media_image_scan_admission_origin AFTER INSERT",
      "DEFERRABLE INITIALLY DEFERRED",
      "BEFORE INSERT OR UPDATE OR DELETE",
      "BEFORE TRUNCATE",
      "admission_row.workload_id<>NEW.system_actor_id",
      "admission_row.snapshot_json->'scanEvent' IS DISTINCT FROM NEW.intent_json#>'{source,scanEvent}'",
      "a.store_id IS NOT DISTINCT FROM NEW.store_id",
      "ALTER TABLE bop_media.image_scan_admission FORCE ROW LEVEL SECURITY",
      "REVOKE ALL ON TABLE bop_media.image_scan_admission FROM PUBLIC",
    ])
      expect(migration?.sql).toContain(text);
    expect(migration?.sql).not.toMatch(
      /\b(?:GRANT|CREATE\s+(?:ROLE|USER)|SECURITY\s+DEFINER|VALIDATE\s+CONSTRAINT)\b/iu,
    );
    expect(migration?.sql).not.toMatch(
      /(?:UPDATE|DELETE\s+FROM)\s+bop_media\.image_processing_intent/iu,
    );
    expect(migration?.sql).not.toContain("REFERENCES bop_audit.");
  });
  it("registers immutable Media processing provenance and guarded promoted versions", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(catalog.diagnostics).toEqual([]);
    const migration = catalog.migrations.find(
      (value) => value.id === "0400_012_create_media_image_processing",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/media", schema: "bop_media" });
    for (const table of [
      "image_processing_intent",
      "image_processing_completion",
      "image_rendition",
    ]) {
      expect(migration?.sql).toContain(`CREATE TABLE bop_media.${table}`);
      expect(migration?.sql).toContain(`ALTER TABLE bop_media.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration?.sql).toContain(`REVOKE ALL ON TABLE bop_media.${table} FROM PUBLIC`);
    }
    for (const text of [
      "CREATE OR REPLACE FUNCTION bop_media.assert_media_upload_origin()",
      "IF NEW.version>1 THEN RETURN NEW; END IF;",
      "IF NEW.version=1 THEN RETURN NEW; END IF;",
      "UNIQUE(source_asset_version_id,scan_event_id)",
      "media_asset_version_number UNIQUE(asset_id,version)",
      "media_promoted_asset_origin AFTER UPDATE",
      "media_promoted_version_origin AFTER INSERT",
      "MEDIA_IMAGE_PROCESSING_RENDITIONS_REQUIRED",
      "DEFERRABLE INITIALLY DEFERRED",
      "BEFORE TRUNCATE",
    ])
      expect(migration?.sql).toContain(text);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER)|SECURITY\s+DEFINER)\b/iu);
  });
  it("registers immutable Media object bindings only for explicitly prepared operations", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(catalog.diagnostics).toEqual([]);
    const migration = catalog.migrations.find(
      (value) => value.id === "0400_011_create_media_object_binding",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/media", schema: "bop_media" });
    for (const table of ["upload_object_binding", "finalized_object_binding"]) {
      expect(migration?.sql).toContain(`CREATE TABLE bop_media.${table}`);
      expect(migration?.sql).toContain(`ALTER TABLE bop_media.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration?.sql).toContain(`REVOKE ALL ON TABLE bop_media.${table} FROM PUBLIC`);
    }
    expect(migration?.sql).toContain(
      "ADD COLUMN object_binding_required boolean NOT NULL DEFAULT false",
    );
    expect(migration?.sql).toContain("IF NOT NEW.object_binding_required THEN RETURN NEW; END IF;");
    expect(migration?.sql).toContain(
      "CREATE CONSTRAINT TRIGGER media_operation_object_binding_required",
    );
    expect(migration?.sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration?.sql).toContain("BEFORE TRUNCATE");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER)|SECURITY\s+DEFINER)\b/iu);
  });
  it("registers owning Media quarantine storage with scoped immutable history", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(catalog.diagnostics).toEqual([]);
    const migration = catalog.migrations.find(
      (value) => value.id === "0400_010_create_media_upload_storage",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/media", schema: "bop_media" });
    for (const table of ["upload_session", "asset", "asset_version", "operation_record"]) {
      expect(migration?.sql).toContain(`CREATE TABLE bop_media.${table}`);
      expect(migration?.sql).toContain(`ALTER TABLE bop_media.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration?.sql).toContain(`REVOKE ALL ON TABLE bop_media.${table} FROM PUBLIC`);
    }
    expect(migration?.sql).toContain("Quarantined");
    expect(migration?.sql).toContain("BEFORE INSERT OR UPDATE OR DELETE");
    expect(migration?.sql).toContain("BEFORE TRUNCATE");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });
  it("registers permanent publication operation fences with scoped bidirectional exclusion", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (value) => value.id === "1100_014_create_product_publication_resolution",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const text of [
      "CREATE TABLE rms_catalog.product_publication_operation_abandonment",
      "FORCE ROW LEVEL SECURITY",
      "SECURITY DEFINER",
      "SET search_path = pg_catalog",
      "SET row_security = off",
      "BEFORE INSERT ON rms_catalog.product_operation_record",
      "BEFORE INSERT ON rms_catalog.product_publication_warning_acknowledgement",
      "BEFORE UPDATE OR DELETE",
      "BEFORE TRUNCATE",
      "REVOKE ALL ON FUNCTION",
    ])
      expect(migration?.sql).toContain(text);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });
  it("registers forward Product selector retirement with required operation coverage", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1100_010_create_product_scope_retirement",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const table of ["product_scope_retirement_header", "product_scope_retirement"]) {
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
      expect(migration?.sql).toContain(`ALTER TABLE rms_catalog.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration?.sql).toContain(`REVOKE ALL ON TABLE rms_catalog.${table} FROM PUBLIC`);
    }
    for (const fact of [
      "product_scope_retirement_once UNIQUE(tenant_id,brand_id,product_id,previous_operation_id,previous_selector_index)",
      "product_publication_retirement_profile_guard",
      "product_publication_retirement_commit_guard",
      "product_scope_retirement_header_commit_guard",
      "product_scope_retirement_header_no_truncate",
      "product_scope_retirement_no_truncate",
      "DEFERRABLE INITIALLY DEFERRED",
      "CatalogProductScopeRetirementHeaderV1",
      "CatalogProductExactStoreSelectorRetirementV1",
      "CatalogProductPublicationVersionV2",
      "CatalogProductApprovalReceiptV2",
      "CatalogProductPublicationApprovalV2",
      "PRODUCT_SCOPE_RETIREMENT_V2_REQUIRED",
      "PRODUCT_SCOPE_RETIREMENT_COVERAGE_MISSING",
    ])
      expect(migration?.sql).toContain(fact);
    expect(migration?.sql).not.toContain("INSERT INTO");
    expect(migration?.sql).not.toContain("UPDATE rms_catalog");
  });
  it("registers immutable own-source Product search generations and scoped activation", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1100_004_create_product_search_generation",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const fact of [
      "product_search_generation_no_update",
      "product_search_row_no_delete",
      "list_json jsonb NOT NULL",
      "list_digest text NOT NULL",
      "CatalogProductDraftV1",
      "is_partial IS TRUE",
      "FOREIGN KEY(generation_id,brand_id,source_revision,source_digest)",
      "FORCE ROW LEVEL SECURITY",
      "REVOKE ALL",
    ])
      expect(migration?.sql).toContain(fact);
    expect(migration?.sql).not.toContain("INSERT INTO");
  });
  it("registers new Product source commit sequencing without historical backfill", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1100_003_create_product_source_commit",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const fact of [
      "product_source_head_guard",
      "product_source_commit_no_update",
      "product_source_commit_no_delete",
      "FORCE ROW LEVEL SECURITY",
      "REVOKE ALL",
      "UNIQUE(brand_id,source_revision)",
    ])
      expect(migration?.sql).toContain(fact);
    expect(migration?.sql).not.toContain("INSERT INTO");
  });
  it("admits only the canonical Workflow owner for the new version table", async () => {
    const root = await fixture();
    const file = path.join(
      root,
      "migrations/0300-bop-governance/0300_003_create_workflow_definition.sql",
    );
    const catalog = await readMigrationCatalog(root);
    expect(catalog.diagnostics).toEqual([]);
    expect(
      catalog.migrations.find((m) => m.id === "0300_003_create_workflow_definition")?.metadata
        .owner,
    ).toBe("@bop/workflow");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("-- owner: @bop/workflow", "-- owner: @rms/store"),
    );
    expect(
      (await readMigrationCatalog(root)).diagnostics.some(
        (d) => d.code === "MIGRATION_OWNER_MISMATCH",
      ),
    ).toBe(true);
  });

  it("registers WP-2348 immutable Order Item ordinal without invented backfill", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1300_013_alter_order_item_ordinal",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/ordering", schema: "rms_ordering" });
    expect(migration?.sql).toContain("order_item_batch_ordinal_unique");
    expect(migration?.sql).toContain("ordinal IS NULL OR ordinal BETWEEN 1 AND 100");
    expect(migration?.sql).not.toContain("UPDATE rms_ordering.order_item");
  });
  it("registers WP-2316 scoped immutable initial Dining Cart operations", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1300_012_create_dining_cart_operation",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/ordering", schema: "rms_ordering" });
    for (const expected of [
      "dining_cart_initial_create_unique",
      "cart_customer_session_history_idx",
      "cart_dining_association_unique",
      "dining_cart_operation_no_mutation",
      "dining_cart_operation_no_truncate",
      "dining_cart_operation_validate",
      "FORCE ROW LEVEL SECURITY",
      "IS TRUE",
    ])
      expect(migration?.sql).toContain(expected);
  });

  it("registers WP-2277 immutable regeneration and unique scoped generation", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1001_003_create_dining_join_regeneration",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/dining", schema: "rms_dining" });
    expect(migration?.sql).toContain("CREATE UNIQUE INDEX dining_join_capability_generation_idx");
    expect(migration?.sql).toContain("dining_join_regeneration_operation_no_update");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).toContain("IS TRUE");
  });

  it("registers WP-2275 scoped Session, capability and append-only start history", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1001_002_create_dining_session_start",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/dining", schema: "rms_dining" });
    for (const table of [
      "dining_session",
      "dining_join_capability",
      "dining_session_start_operation",
    ])
      expect(migration?.sql).toContain(`ALTER TABLE rms_dining.${table} FORCE ROW LEVEL SECURITY`);
    expect(migration?.sql).toContain("dining_session_open_table_idx");
    expect(migration?.sql).toContain("dining_session_start_operation_no_update");
    expect(migration?.sql).toContain("IS TRUE");
  });

  it("declares only the WP-2272 scoped Dining Table and immutable operation storage", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const migration = catalog.migrations.find(
      (value) => value.id === "1001_001_create_dining_table",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/dining", schema: "rms_dining" });
    for (const table of ["dining_table", "dining_table_operation"]) {
      expect(migration?.sql).toContain(`CREATE TABLE rms_dining.${table}`);
      expect(migration?.sql).toContain(`ALTER TABLE rms_dining.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration?.sql).toContain(`REVOKE ALL ON TABLE rms_dining.${table} FROM PUBLIC`);
    }
    expect(migration?.sql).toContain("version bigint NOT NULL");
    expect(migration?.sql).toContain("IS TRUE");
    expect(migration?.sql).toContain("dining_table_operation_no_update");
    expect(migration?.sql).toContain("dining_table_operation_no_delete");
  });

  it("loads the committed Canonical catalog deterministically", async () => {
    const first = await readMigrationCatalog(repositoryRoot);
    const second = await readMigrationCatalog(repositoryRoot);
    expect(first.diagnostics).toEqual([]);
    expect(first).toEqual(second);
    expect(first.migrations.map((migration) => migration.id)).toEqual([
      "0000_001_create_migration_history",
      "0000_002_alter_platform_core",
      "0000_003_create_platform_eventing",
      "0000_004_create_platform_audit",
      "0000_005_create_platform_jobs",
      "0000_006_create_platform_helpers",
      "0000_007_create_uuid_money_helpers",
      "0000_008_create_time_helpers",
      "0000_009_create_tenant_scope_helpers",
      "0000_010_create_outbox_event",
      "0000_011_alter_outbox_dispatch",
      "0000_012_create_consumer_inbox",
      "0000_013_create_retry_dead_letter",
      "0000_014_create_audit_record",
      "0000_015_alter_audit_hash_chain",
      "0000_016_create_security_abuse_bucket",
      "0000_017_create_order_exception_source",
      "0000_018_create_manual_outbox_recovery",
      "0000_019_create_platform_actor_audit",
      "0000_020_alter_platform_permission_audit_binding",
      "0000_021_alter_platform_actor_directory_audit_binding",
      "0000_022_alter_platform_template_publishing_audit_binding",
      "0000_023_alter_workforce_account_binding_audit",
      "0000_024_alter_workforce_onboarding_audit",
      "0200_001_create_tenant_organization",
      "0200_002_create_operating_entity",
      "0200_003_create_membership",
      "0200_004_create_identity_session",
      "0200_005_create_workforce_identity_security",
      "0200_006_create_guest_session",
      "0200_007_alter_guest_dining_binding",
      "0200_008_create_api_client",
      "0200_009_create_operating_entity_administration",
      "0200_010_create_brand_administration",
      "0200_011_create_platform_tenant_administration",
      "0200_012_create_guest_session_operation",
      "0200_013_create_guest_binding_preparation",
      "0200_014_create_guest_dining_binding_preparation",
      "0200_015_alter_organization_revision_trigger",
      "0200_016_create_browser_session_selection",
      "0200_017_alter_browser_session_selection_isolation",
      "0200_018_create_guest_entry_admission",
      "0200_019_alter_brand_admin_artifact_snapshot",
      "0200_020_create_store_reference_projection",
      "0200_021_alter_tax_registrant_source_barrier",
      "0200_022_create_brand_store_topology_draft",
      "0200_023_alter_store_reference_labels",
      "0200_024_create_brand_configuration_authoring",
      "0200_025_create_browser_brand_session_selection",
      "0200_026_create_platform_brand_template",
      "0200_027_create_platform_actor_directory",
      "0200_028_create_workforce_account_binding",
      "0200_029_alter_workforce_account_authentication_read",
      "0200_030_create_brand_template_reference_read",
      "0200_031_create_membership_brand_discovery_read",
      "0200_032_create_workforce_onboarding_operation",
      "0200_033_alter_workforce_account_binding_acceptance",
      "0200_034_create_workforce_onboarding_invitation_read",
      "0300_001_create_permission",
      "0300_002_create_role_administration",
      "0300_003_create_workflow_definition",
      "0300_004_alter_permission_action_identifiers",
      "0300_005_alter_option_read_action_identifier",
      "0300_006_create_system_media_image_promotion_authorization",
      "0300_007_alter_option_authoring_action_identifiers",
      "0300_008_alter_option_publication_action_identifier",
      "0300_009_alter_option_history_action_identifier",
      "0300_010_create_platform_permission",
      "0400_001_create_feature_control_administration",
      "0400_002_create_live_gate_workflow",
      "0400_003_create_support_case",
      "0400_004_create_kill_switch_version",
      "0400_005_alter_kill_switch_operation_digest",
      "0400_006_create_publishing_mutation",
      "0400_007_alter_publishing_history_guard",
      "0400_008_create_task_version",
      "0400_009_alter_feature_control_dependency_scope",
      "0400_010_create_media_upload_storage",
      "0400_011_create_media_object_binding",
      "0400_012_create_media_image_processing",
      "0400_013_create_media_image_scan_admission",
      "0400_014_alter_option_set_policy_waiver_guard",
      "0400_015_alter_option_set_current_qualification_guard",
      "0400_016_create_option_set_publication_operation",
      "0400_017_create_option_price_review_operation",
      "0400_018_create_platform_publishing_mutation",
      "0400_019_create_brand_template_publication_read",
      "1000_001_create_store_configuration",
      "1000_002_create_store_exception_content",
      "1000_003_create_store_service_pause_content",
      "1000_004_create_store_publication_content",
      "1000_005_create_store_configuration_authoring",
      "1000_006_create_store_review_snapshot",
      "1000_007_create_public_store_profile",
      "1000_008_create_public_store_profile_timing",
      "1000_009_create_store_setup_draft",
      "1000_010_create_store_setup_reference",
      "1000_011_alter_store_setup_fee_context",
      "1000_012_alter_store_publication_setup_basis",
      "1000_013_create_store_configuration_original",
      "1001_001_create_dining_table",
      "1001_002_create_dining_session_start",
      "1001_003_create_dining_join_regeneration",
      "1001_004_create_dining_session_join",
      "1001_005_create_dining_closing_operation",
      "1001_006_create_dining_move_operation",
      "1001_007_alter_moved_join_regeneration",
      "1001_008_create_dining_admission_consumption",
      "1001_009_create_dining_checkout_commitment",
      "1001_010_create_dining_item_service",
      "1001_011_create_dining_exception_task",
      "1001_012_create_dining_table_release_operation",
      "1001_013_create_dining_host_transfer_operation",
      "1100_001_create_product_aggregate",
      "1100_002_create_product_operation_snapshot",
      "1100_003_create_product_source_commit",
      "1100_004_create_product_search_generation",
      "1100_005_create_product_publication",
      "1100_006_alter_product_editor_content",
      "1100_007_create_product_scope_journal",
      "1100_008_create_product_content_registry",
      "1100_009_create_product_approval_receipt",
      "1100_010_create_product_scope_retirement",
      "1100_011_create_product_tax_classification_registry",
      "1100_012_create_product_publication_validation_report",
      "1100_013_create_product_publication_warning_acknowledgement",
      "1100_014_create_product_publication_resolution",
      "1100_015_create_selling_unit_registry",
      "1100_016_create_product_authoring_resolution",
      "1100_017_create_selling_unit_registration_resolution",
      "1100_018_create_brand_catalog_source",
      "1101_001_create_category_menu_structure",
      "1101_002_create_category_source_commit",
      "1101_003_create_product_category_classification",
      "1102_001_create_option_set_binding",
      "1102_002_create_product_binding_successor_guard",
      "1102_003_create_option_set_draft_content",
      "1102_004_create_option_set_publication_content",
      "1102_005_create_option_set_review_release",
      "1102_006_alter_option_set_publication_envelope_budget",
      "1102_007_create_option_set_authoring_resolution",
      "1102_008_alter_option_set_release_chronology",
      "1103_001_create_availability_rule",
      "1103_002_create_availability_reference_generation",
      "1104_001_create_menu_publication",
      "1104_002_create_menu_publication_snapshot",
      "1104_003_create_menu_review_content",
      "1104_004_create_menu_reference_generation",
      "1105_001_create_published_menu_projection",
      "1106_001_create_allergen_provenance",
      "1106_002_alter_catalog_function_permissions",
      "1106_003_create_recipe_allergen_source",
      "1107_001_create_bundle_aggregate",
      "1107_002_alter_availability_workbench",
      "1107_003_create_bundle_reference_generation",
      "1200_001_create_tax_configuration",
      "1200_002_create_price_book",
      "1200_003_create_price_quote",
      "1200_004_create_price_book_admin_projection",
      "1200_005_create_tax_config_admin_projection",
      "1200_006_create_promotion_management",
      "1200_007_alter_price_quote_snapshot",
      "1200_008_alter_price_quote_line_source",
      "1200_009_create_price_quote_request",
      "1200_010_alter_price_quote_configured",
      "1200_011_create_option_price_rule",
      "1200_012_create_tax_reference_scope",
      "1200_013_create_configuration_reference_generation",
      "1200_014_create_option_price_authoring_operation",
      "1200_015_create_tax_config_authoring_operation",
      "1200_016_create_tax_config_material",
      "1200_017_create_tax_config_publication_candidate",
      "1250_001_create_recipe_management",
      "1250_002_alter_recipe_snapshot",
      "1250_003_alter_recipe_child_identity",
      "1250_004_create_recipe_modifier",
      "1250_005_create_recipe_preparation_content",
      "1250_006_create_recipe_source_coverage",
      "1250_007_create_recipe_core_projection",
      "1250_008_create_recipe_reference_projection",
      "1250_009_alter_recipe_inventory_reference_fence",
      "1250_010_create_recipe_measurement_content",
      "1300_001_create_cart_aggregate",
      "1300_002_alter_cart_item_commands",
      "1300_003_alter_cart_selection_evidence",
      "1300_004_create_cart_quote_attachment",
      "1300_005_alter_cart_lifecycle",
      "1300_006_create_order_number_allocation",
      "1300_007_create_order_submission",
      "1300_008_create_order_status_projection",
      "1300_009_create_order_amendment",
      "1300_010_create_cart_binding_record",
      "1300_011_create_cart_quote_expiry",
      "1300_012_create_dining_cart_operation",
      "1300_013_alter_order_item_ordinal",
      "1300_014_create_order_capacity_link",
      "1300_015_alter_order_capacity_link_owner",
      "1300_016_alter_cart_quote_configured",
      "1300_017_create_checkout_details",
      "1300_018_create_order_checkout_details_link",
      "1300_019_create_checkout_session",
      "1300_020_create_checkout_session_allocation",
      "1300_021_create_order_payment_failure",
      "1300_022_create_order_payment_disposition",
      "1300_023_create_order_acceptance_record",
      "1300_024_create_order_termination_record",
      "1300_025_create_order_fulfillment_completion_record",
      "1300_026_create_digital_receipt_record",
      "1300_027_alter_order_submission_kind",
      "1300_028_create_order_revision",
      "1300_029_create_additional_dining_batch_record",
      "1300_030_alter_order_submission_cardinality",
      "1300_031_create_order_payment_acceptance_wait",
      "1300_032_create_dining_cart_replacement",
      "1300_033_create_order_cancellation_request_version",
      "1300_034_create_order_closure_version",
      "1300_035_create_order_batch_checkout_expiry",
      "1300_036_create_order_batch_checkout_cancellation",
      "1400_001_create_payment_intent",
      "1400_002_create_provider_webhook_inbox",
      "1400_003_create_payment_terminal_fact",
      "1400_004_create_payment_status_projection",
      "1400_005_create_payment_reconciliation",
      "1400_006_create_payment_tip_selection",
      "1400_007_create_payment_compensation_lease_history",
      "1400_008_create_payment_compensation_operation_history",
      "1400_009_create_payment_compensation_case_history",
      "1400_010_create_payment_compensation_action_history",
      "1400_011_create_payment_compensation_refund",
      "1400_012_create_payment_compensation_operations",
      "1400_013_create_payment_refund_status_projection",
      "1400_014_create_ordinary_refund_request",
      "1400_015_create_ordinary_refund_approval",
      "1400_016_create_ordinary_refund_operation",
      "1400_017_create_ordinary_refund_dispatch",
      "1400_018_create_ordinary_refund_observation",
      "1400_019_alter_ordinary_refund_observation",
      "1400_020_create_order_settled_finality",
      "1400_021_alter_daily_reconciliation_amounts",
      "1400_022_create_provider_capture_exception_evidence",
      "1400_023_create_reconciliation_follow_up_history",
      "1400_024_create_store_payment_configuration",
      "1500_001_create_kitchen_ticket_aggregate",
      "1500_002_create_kitchen_work_queue_projection",
      "1500_003_create_kitchen_work_lifecycle",
      "1500_004_create_kitchen_ready_publication",
      "1500_005_create_kitchen_allergen_safety",
      "1500_006_create_kds_continuity",
      "1500_007_create_production_batch",
      "1500_008_create_kitchen_creation_record",
      "1500_009_create_kitchen_routing_configuration",
      "1500_010_alter_kitchen_lifecycle_effect_record",
      "1500_011_create_kds_operator_shift_event",
      "1600_001_create_device_management",
      "1600_002_create_kds_profile_management",
      "1600_003_create_digital_receipt_template",
      "1600_004_create_digital_receipt_template_artifact",
      "1600_005_create_digital_receipt_template_draft",
      "1600_006_create_digital_receipt_template_submission",
      "1600_007_create_digital_receipt_template_submit_operation",
      "1600_008_create_digital_receipt_template_lifecycle_operation",
      "1700_001_create_pickup_fulfillment",
      "1700_002_create_fulfillment_readiness",
      "1700_003_create_pickup_proof",
      "1700_004_create_pickup_handoff",
      "1700_005_create_fulfillment_completion_publication",
      "1700_006_create_capacity_hold",
      "1700_007_create_capacity_allocation",
      "1700_008_create_asap_capacity_commitment",
      "1700_009_alter_pickup_fulfillment_record",
      "1700_010_alter_fulfillment_ready_record",
      "1700_011_alter_pickup_handoff_record",
      "1700_012_alter_pickup_proof_operation",
      "1800_001_create_report_definition",
      "1800_002_create_report_run",
      "1800_003_create_metric_definition",
      "1800_004_create_data_quality_reconciliation",
      "1800_005_create_pipeline_run",
      "1800_006_create_export_job",
      "1900_001_create_inventory_item",
      "1900_002_alter_inventory_item_operation_audit",
      "1900_003_create_stock_ledger",
      "1900_004_create_stock_reservation",
      "1900_005_create_item_stock_history",
      "1900_006_create_lot_hold",
      "1900_007_create_reservation_set",
      "1900_008_create_submission_final_validation",
      "1900_009_alter_submission_validation_cardinality",
      "1900_010_create_recipe_configuration_source",
      "1900_012_create_configuration_reference_generation",
      "1900_013_create_item_sku_mapping",
      "1900_014_alter_stock_reservation_order_line",
      "1900_015_alter_stock_movement_operations",
      "1900_016_create_stock_site_location",
      "2000_001_alter_permission_catalog_identifiers",
      "2000_002_create_permission_catalog_revision",
      "2000_003_create_store_role_provisioning",
      "2000_004_alter_store_role_provisioning_upgrade",
      "2000_005_create_member_profile",
      "2000_006_create_role_assignment_change",
      "2000_007_create_item_stock_exposure",
      "2000_008_create_opening_stock_count",
      "2000_009_create_store_receipt",
      "2000_010_create_brand_role_provisioning",
      "2000_011_create_recipe_authoring",
      "2000_012_create_stock_count_and_waste",
      "2000_013_create_store_price_book_assignment",
      "2000_014_alter_menu_current_version",
      "2000_015_alter_allergen_declarations",
      "2000_016_alter_recipe_requirement_allergen_declaration",
      "2000_017_create_menu_release_effective_end",
      "2000_018_create_availability_rule_operation_snapshot",
    ]);
    expect(
      first.migrations.every((migration) => /^[0-9a-f]{64}$/u.test(migration.checksumSha256)),
    ).toBe(true);
  });

  it("registers the exact WP-2180 Device management migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1600_001_create_device_management",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@rms/printing-device",
      schema: "rms_device",
    });
    for (const table of [
      "device",
      "device_capability_version",
      "device_assignment",
      "device_health_signal",
      "device_health_current",
      "device_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_device.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
    expect(migration?.sql).not.toMatch(/(?:credential|secret|token)_(?:value|bytes|text)/iu);
  });

  it("registers the exact WP-2195 role administration migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0300_002_create_role_administration",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@bop/permission",
      schema: "bop_permission",
    });
    expect(migration?.sql).toContain("CREATE TABLE bop_permission.role_administration_version");
    expect(migration?.sql).toContain("CREATE TABLE bop_permission.role_administration_decision");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).toContain("append-only");
  });

  it("registers fixed System Media authorization without seeding or granting Allow", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0300_006_create_system_media_image_promotion_authorization",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@bop/permission",
      schema: "bop_permission",
    });
    for (const table of [
      "system_media_image_promotion_authorization",
      "system_media_image_promotion_authorization_decision",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE bop_permission.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(migration?.sql).toContain("lock_token smallint NOT NULL DEFAULT 0 CHECK (lock_token=0)");
    expect(migration?.sql).toContain("NEW.version<>OLD.version+1");
    expect(migration?.sql).toContain("SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_IMMUTABLE");
    expect(migration?.sql).toContain("SYSTEM_MEDIA_PROMOTION_AUTHORIZATION_ORIGIN_INVALID");
    expect(migration?.sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration?.sql).toContain("tenant_id::text=current_setting('bop.tenant_id',true)");
    expect(migration?.sql).not.toContain("platform_helpers.current_tenant_id()");
    expect(migration?.sql).toContain(
      "store_id IS NOT DISTINCT FROM platform_helpers.current_store_id()",
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER)|INSERT\s+INTO)\b/iu);
    expect(migration?.sql).not.toMatch(/SECURITY\s+DEFINER|row_security\s*=\s*off/iu);
    expect(migration?.sql).not.toContain("platform_audit.");
  });

  it("registers the exact WP-2196 Export Job migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1800_006_create_export_job",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@rms/business-intelligence",
      schema: "rms_reporting",
    });
    for (const table of [
      "export_job",
      "export_job_state_record",
      "export_artifact",
      "export_access_grant",
      "export_grant_consumption",
      "export_revocation",
      "export_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_reporting.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(7);
    expect(migration?.sql).not.toMatch(/(?:presigned|object_key|recipient|filename)/iu);
  });

  it("registers the exact WP-2197 Platform Tenant administration migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0200_011_create_platform_tenant_administration",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/tenant", schema: "bop_tenant" });
    for (const table of [
      "tenant_administration_version",
      "tenant_capability_metadata_reference",
      "tenant_administration_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE bop_tenant.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
    expect(migration?.sql).toContain("bop.platform_support_case_id");
    expect(migration?.sql).not.toMatch(/(?:secret|credential|token|database_query)/iu);
  });

  it("registers the exact WP-2192 Store configuration migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1000_001_create_store_configuration",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/store", schema: "rms_store" });
    for (const table of [
      "store_configuration_version",
      "store_weekly_service_period",
      "store_service_exception",
      "store_configuration_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_store.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(4);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2193 Feature Control administration migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0400_001_create_feature_control_administration",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@bop/feature-control",
      schema: "bop_feature_control",
    });
    for (const table of ["control_version", "control_dependency", "control_operation"])
      expect(migration?.sql).toContain(`CREATE TABLE bop_feature_control.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  });

  it("registers the exact WP-2194 Live Gate workflow migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0400_002_create_live_gate_workflow",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@bop/publishing",
      schema: "bop_publishing",
    });
    for (const table of ["live_gate_version", "live_gate_requirement", "live_gate_operation"])
      expect(migration?.sql).toContain(`CREATE TABLE bop_publishing.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  });

  it("registers the exact WP-2198 Support Case migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "0400_003_create_support_case",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@bop/task", schema: "bop_task" });
    for (const table of [
      "support_case_version",
      "diagnostic_access_grant",
      "diagnostic_access_revocation",
      "support_action_record",
      "support_case_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE bop_task.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(migration?.sql).toContain("interval '15 minutes'");
    expect(migration?.sql).toContain("bop.platform_support_case_id");
    expect(migration?.sql).not.toMatch(/(?:command_text|query_text|secret|credential_value)/iu);
  });

  it("registers the exact WP-2181 KDS Profile and UAT migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1600_002_create_kds_profile_management",
    );
    expect(migration?.metadata).toMatchObject({
      owner: "@rms/printing-device",
      schema: "rms_device",
    });
    for (const table of [
      "kds_profile",
      "kds_profile_version",
      "kds_profile_assignment",
      "kds_uat_run",
      "kds_uat_check_result",
      "kds_profile_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_device.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
    expect(migration?.sql).not.toMatch(/(?:credential|secret|token)_(?:value|bytes|text)/iu);
  });

  it("registers the WP-2005 Catalog function PUBLIC-execute revocation", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1106_002_alter_catalog_function_permissions",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    expect(migration?.sql.match(/REVOKE ALL ON FUNCTION rms_catalog\./gu)).toHaveLength(4);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2100 Bundle aggregate migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1107_001_create_bundle_aggregate",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const table of [
      "bundle",
      "bundle_version",
      "bundle_component_group",
      "bundle_component_sellable",
      "bundle_availability_rule",
      "bundle_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("sellable_type IN ('Product', 'Sku')");
    expect(migration?.sql).toContain("numeric(30,0)");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(6);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2102 Price Book Admin projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_004_create_price_book_admin_projection",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/pricing", schema: "rms_pricing" });
    for (const table of [
      "price_book_admin_projection_generation",
      "price_book_admin_projection",
      "price_book_entry_projection",
      "price_book_admin_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.sql).toContain("amount_minor = trunc(amount_minor)");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(4);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2103 Tax Config Admin projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_005_create_tax_config_admin_projection",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/pricing", schema: "rms_pricing" });
    for (const table of [
      "tax_config_admin_projection_generation",
      "tax_config_admin_projection",
      "tax_config_rule_projection",
      "tax_config_receipt_fixture_projection",
      "tax_config_admin_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.sql).toContain("tax_amount_minor = trunc(tax_amount_minor)");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2104 Promotion management migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_006_create_promotion_management",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/pricing", schema: "rms_pricing" });
    for (const table of [
      "promotion",
      "promotion_version",
      "promotion_eligibility_reference",
      "promotion_operation_record",
      "promotion_admin_projection_generation",
      "promotion_admin_projection",
      "promotion_admin_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.sql).toContain("usage_minor <= budget_minor");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(7);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers append-only Inventory direct SKU mapping ownership and static enforcement", async () => {
    const m = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (c) => c.id === "1900_013_create_item_sku_mapping",
    );
    expect(m?.metadata).toMatchObject({ owner: "@rms/inventory", schema: "rms_inventory" });
    expect(m?.sql).toContain("CREATE TABLE rms_inventory.item_sku_mapping_version");
    expect(m?.sql).toContain("SELECT DISTINCT ON (item_id)");
    expect(m?.sql).toContain(
      "CREATE OR REPLACE FUNCTION rms_inventory.advance_configuration_reference_generation()",
    );
    expect(m?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(m?.sql).toContain("item_sku_mapping_version_immutable");
    expect(m?.sql).toContain("REVOKE ALL ON FUNCTION");
    expect(m?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b|rms_catalog\./iu);
  });
  it("registers the owning Inventory configuration reference source fence", async () => {
    const m = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (c) => c.id === "1900_012_create_configuration_reference_generation",
    );
    expect(m?.metadata).toMatchObject({ owner: "@rms/inventory", schema: "rms_inventory" });
    expect(m?.sql).toContain("CREATE TABLE rms_inventory.configuration_reference_generation");
    for (const t of ["inventory_item", "inventory_item_version", "inventory_item_operation"])
      expect(m?.sql).toContain(`AFTER INSERT ON rms_inventory.${t}`);
    expect(m?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(m?.sql).toContain("SECURITY DEFINER");
    expect(m?.sql).toContain("REVOKE ALL ON FUNCTION");
    expect(m?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });
  it("registers the owning Recipe Ingredient reference fence addendum", async () => {
    const m = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (c) => c.id === "1250_009_alter_recipe_inventory_reference_fence",
    );
    expect(m?.metadata).toMatchObject({ owner: "@rms/recipe", schema: "rms_recipe" });
    expect(m?.sql).toContain(
      "CREATE OR REPLACE FUNCTION rms_recipe.maintain_recipe_reference_projection()",
    );
    expect(m?.sql).toContain("ON rms_recipe.recipe_ingredient_requirement");
    expect(m?.sql).toContain("SECURITY DEFINER");
    expect(m?.sql).toContain("REVOKE ALL ON FUNCTION");
    expect(m?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });
  it("registers the exact WP-2105 Recipe management migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1250_001_create_recipe_management",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/recipe", schema: "rms_recipe" });
    for (const table of [
      "recipe",
      "recipe_version",
      "recipe_ingredient_requirement",
      "recipe_allergen_evidence",
      "recipe_preparation_step",
      "recipe_scope_binding",
      "recipe_review_record",
      "recipe_operation_record",
      "recipe_admin_projection_generation",
      "recipe_admin_projection",
      "recipe_admin_ingredient_projection",
      "recipe_admin_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_recipe.${table}`);
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(12);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1603 Pickup Handoff migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1700_004_create_pickup_handoff",
    );
    expect(migration?.metadata.owner).toBe("@rms/fulfillment");
    for (const table of [
      "pickup_handoff_record",
      "pickup_handoff_item",
      "pickup_handoff_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_fulfillment.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1604 Fulfillment completion publication migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1700_005_create_fulfillment_completion_publication",
    );
    expect(migration?.metadata.owner).toBe("@rms/fulfillment");
    expect(migration?.sql).toContain(
      "CREATE TABLE rms_fulfillment.fulfillment_completion_publication",
    );
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1023 Availability Rule migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1103_001_create_availability_rule",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    expect(migration?.sql).toContain("CREATE TABLE rms_catalog.availability_rule");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-2101 Availability Workbench migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1107_002_alter_availability_workbench",
    );
    expect(migration?.metadata).toMatchObject({ owner: "@rms/catalog", schema: "rms_catalog" });
    for (const table of [
      "availability_workbench_projection_generation",
      "availability_workbench_projection",
      "availability_workbench_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("sellable_type IN ('Product', 'Sku', 'Bundle')");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1024 Menu publication migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1104_001_create_menu_publication",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    for (const table of [
      "menu_publication_revision",
      "menu_publication_release",
      "menu_release_effective_period",
      "menu_publication_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("reject_menu_effective_overlap");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1025 Published Menu projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1105_001_create_published_menu_projection",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    for (const table of [
      "published_menu_projection_generation",
      "published_menu_projection",
      "published_menu_projection_section",
      "published_menu_projection_sellable",
      "published_menu_projection_checkpoint",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("enforce_published_menu_checkpoint_order");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("registers the exact WP-1028 allergen provenance migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1106_001_create_allergen_provenance",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    for (const table of [
      "allergen_registry_version",
      "allergen_registry_entry",
      "allergen_source_evidence",
      "allergen_source_assertion",
      "menu_allergen_validation_evidence",
      "menu_sellable_allergen_disclosure",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1101 Store Tax Configuration migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_001_create_tax_configuration",
    );
    expect(migration?.metadata.owner).toBe("@rms/pricing");
    expect(migration?.metadata.schema).toBe("rms_pricing");
    for (const table of [
      "tax_configuration",
      "tax_configuration_version",
      "tax_configuration_rule",
      "tax_configuration_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1102 Price Resolution migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_002_create_price_book",
    );
    expect(migration?.metadata.owner).toBe("@rms/pricing");
    for (const table of [
      "price_book",
      "price_book_version",
      "price_entry",
      "price_book_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1103 Price Quote migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1200_003_create_price_quote",
    );
    for (const table of ["price_quote", "price_quote_line", "price_quote_tax_line"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_pricing.${table}`);
    expect(migration?.metadata.owner).toBe("@rms/pricing");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1200 Cart aggregate migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_001_create_cart_aggregate",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    for (const table of ["cart", "cart_line"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_ordering.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1201 Cart Item command migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_002_alter_cart_item_commands",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    expect(migration?.sql).toContain("ALTER TABLE rms_ordering.cart_line");
    expect(migration?.sql).toContain("CREATE TABLE rms_ordering.cart_operation_record");
    expect(migration?.sql).toContain("interval '24 hours'");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1202 Cart selection evidence migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_003_alter_cart_selection_evidence",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    expect(migration?.metadata.phase).toBe("expand");
    expect(migration?.sql).toContain("catalog_selection_evidence_json jsonb");
    expect(migration?.sql).toContain("catalog_selection_evidence_json IS NULL");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1203 Cart Quote attachment migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_004_create_cart_quote_attachment",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    for (const table of ["cart_quote_attachment", "cart_quote_attachment_line"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_ordering.${table}`);
    expect(migration?.sql).toContain("interval '24 hours'");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1204 Cart lifecycle migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_005_alter_cart_lifecycle",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    expect(migration?.sql).toContain("ADD COLUMN lifecycle_status");
    expect(migration?.sql).toContain("CREATE TABLE rms_ordering.cart_lifecycle_operation_record");
    expect(migration?.sql).toContain("interval '24 hours'");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1223 Order Number allocation migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_006_create_order_number_allocation",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    for (const table of ["order_number_counter", "order_number_allocation"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_ordering.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1224 atomic Order submission migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_007_create_order_submission",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    expect(migration?.metadata.schema).toBe("rms_ordering");
    for (const table of ["order_header", "order_submission_record", "order_batch", "order_item"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_ordering.${table}`);
    expect(migration?.sql).toContain("order_header_number_allocation_fk");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1225 Order status projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1300_008_create_order_status_projection",
    );
    expect(migration?.metadata.owner).toBe("@rms/ordering");
    for (const table of ["order_status_projection_generation", "order_status_projection"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_ordering.${table}`);
    expect(migration?.sql).toContain("order_status_projection_generation_store_scope_policy");
    expect(migration?.sql).toContain("enforce_order_status_projection_advance");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1302 Payment Intent creation migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1400_001_create_payment_intent",
    );
    expect(migration?.metadata.owner).toBe("@rms/payment");
    expect(migration?.metadata.schema).toBe("rms_payment");
    for (const table of [
      "payment_intent",
      "payment_attempt",
      "payment_intent_operation_record",
      "payment_provider_observation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_payment.${table}`);
    expect(migration?.sql).toContain("payment_provider_observation_shape_check");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1304 Payment webhook Inbox migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1400_002_create_provider_webhook_inbox",
    );
    expect(migration?.metadata.owner).toBe("@rms/payment");
    expect(migration?.metadata.schema).toBe("rms_payment");
    for (const table of [
      "provider_webhook_record",
      "provider_webhook_raw_evidence",
      "provider_webhook_processing_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_payment.${table}`);
    expect(migration?.sql).toContain("provider_webhook_record_provider_event_unique");
    expect(migration?.sql).toContain("provider_webhook_raw_evidence_no_early_delete");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1305 Payment terminal fact migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1400_003_create_payment_terminal_fact",
    );
    expect(migration?.metadata.owner).toBe("@rms/payment");
    expect(migration?.metadata.schema).toBe("rms_payment");
    expect(migration?.sql).toContain("CREATE TABLE rms_payment.payment_terminal_fact");
    expect(migration?.sql).toContain("payment_terminal_fact_intent_terminal_unique");
    expect(migration?.sql).toContain("payment_terminal_fact_no_update");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1306 Payment status projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1400_004_create_payment_status_projection",
    );
    expect(migration?.metadata.owner).toBe("@rms/payment");
    expect(migration?.metadata.schema).toBe("rms_payment");
    expect(migration?.sql).toContain("CREATE TABLE rms_payment.payment_status_projection");
    expect(migration?.sql).toContain("payment_status_projection_active_intent_unique");
    expect(migration?.sql).toContain("enforce_payment_status_projection_update");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1307 Payment reconciliation migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1400_005_create_payment_reconciliation",
    );
    expect(migration?.metadata.owner).toBe("@rms/payment");
    expect(migration?.metadata.schema).toBe("rms_payment");
    for (const table of [
      "payment_reconciliation_run",
      "payment_reconciliation_exception",
      "payment_reconciliation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_payment.${table}`);
    expect(migration?.sql).toContain("payment_terminal_fact_authoritative_source_shape_check");
    expect(migration?.sql).toContain("payment_reconciliation_exception_stable_unique");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1401 Kitchen Ticket aggregate migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_001_create_kitchen_ticket_aggregate",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    for (const table of ["kitchen_ticket", "kitchen_work_item", "kitchen_action_record"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_kitchen.${table}`);
    expect(migration?.sql).toContain("kitchen_work_item_ticket_fk");
    expect(migration?.sql).toContain("kitchen_action_record_ticket_fk");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql.match(/SECURITY INVOKER/gu)).toHaveLength(3);
    expect(migration?.sql.match(/SET search_path = pg_catalog/gu)).toHaveLength(3);
    expect(migration?.sql.match(/REVOKE ALL ON FUNCTION rms_kitchen\./gu)).toHaveLength(3);
    expect(migration?.sql).toContain("source_evidence_captured_at <= confirmed_at");
    expect(migration?.sql).toContain("kitchen_action_record_actor_shape_check");
    expect(migration?.sql).not.toMatch(/CREATE RULE\s+\w+no_update/iu);
    expect(migration?.sql).not.toMatch(
      /station_configuration|recipe_id|recipe_version|routing_rule_version_id/iu,
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1403 Kitchen queue projection migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_002_create_kitchen_work_queue_projection",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    for (const table of [
      "kitchen_work_queue_projection_generation",
      "kitchen_work_queue_projection",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_kitchen.${table}`);
    expect(migration?.sql).toContain("kitchen_work_queue_generation_one_active_unique");
    expect(migration?.sql).toContain("kitchen_work_queue_projection_generation_fk");
    expect(migration?.sql).toContain("kitchen_work_queue_projection_work_item_fk");
    expect(migration?.sql).toContain("source_event_semantic_digest");
    expect(migration?.sql).toContain("source_event_binding_digest");
    expect(migration?.sql).toContain("queue_snapshot_digest");
    expect(migration?.sql).toContain("rebuild_request_digest");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(migration?.sql.match(/SECURITY INVOKER/gu)).toHaveLength(2);
    expect(migration?.sql.match(/SET search_path = pg_catalog/gu)).toHaveLength(2);
    expect(migration?.sql.match(/REVOKE ALL ON FUNCTION rms_kitchen\./gu)).toHaveLength(2);
    expect(migration?.sql).not.toMatch(
      /customer_note|allergen|health|preparation|routing|source_line|execution|work_plan/iu,
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1404 Kitchen work lifecycle migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_003_create_kitchen_work_lifecycle",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    for (const table of ["kitchen_work_lifecycle_operation", "kitchen_order_item_ready_result"])
      expect(migration?.sql).toContain(`CREATE TABLE rms_kitchen.${table}`);
    expect(migration?.sql).toContain("snapshot_binding_version");
    expect(migration?.sql).toContain("accepted_at");
    expect(migration?.sql).toContain("order_item_ready_at");
    expect(migration?.sql).toContain("kitchen_work_item_lifecycle_quantity_check");
    expect(migration?.sql).toContain("kitchen_work_queue_projection_lifecycle_quantity_check");
    expect(migration?.sql).toContain("kitchen_work_lifecycle_operation_idempotency_unique");
    expect(migration?.sql).toContain("kitchen_order_item_ready_result_causal_operation_fk");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(migration?.sql.match(/SECURITY INVOKER/gu)).toHaveLength(2);
    expect(migration?.sql.match(/SET search_path = pg_catalog/gu)).toHaveLength(2);
    expect(migration?.sql).not.toMatch(/CREATE RULE\s+\w+no_update/iu);
    expect(migration?.sql).not.toMatch(/customer_note|allergen|health|payment|provider/iu);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1406 Kitchen Ready publication migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_004_create_kitchen_ready_publication",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    expect(migration?.sql).toContain("CREATE TABLE rms_kitchen.kitchen_ready_publication");
    expect(migration?.sql).toContain("kitchen_ready_publication_ready_result_fk");
    expect(migration?.sql).toContain("kitchen_ready_publication_causation_fk");
    expect(migration?.sql).toContain("kitchen_ready_publication_order_event_shape_check");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).toContain("reject_kitchen_work_lifecycle_append_only_update");
    expect(migration?.sql).not.toMatch(/customer|note|allergen|health|payment|provider/iu);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1407 Kitchen allergen safety migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_005_create_kitchen_allergen_safety",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    for (const table of [
      "kitchen_allergen_review",
      "kitchen_allergen_acknowledgement",
      "kitchen_allergen_incident_link",
    ]) {
      expect(migration?.sql).toContain(`CREATE TABLE rms_kitchen.${table}`);
    }
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
    expect(migration?.sql.match(/reject_kitchen_work_lifecycle_append_only_update/gu)).toHaveLength(
      3,
    );
    expect(migration?.sql).not.toMatch(/medical|symptom|customer_note|free_text/iu);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1408 KDS continuity migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1500_006_create_kds_continuity",
    );
    expect(migration?.metadata.owner).toBe("@rms/kitchen");
    expect(migration?.metadata.schema).toBe("rms_kitchen");
    expect(migration?.sql).toContain("CREATE TABLE rms_kitchen.kds_operator_handover");
    expect(migration?.sql).toContain("CREATE TABLE rms_kitchen.kds_recovery_reconciliation");
    expect(migration?.sql).toContain("command_replay_count = 0");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(migration?.sql.match(/reject_kitchen_work_lifecycle_append_only_update/gu)).toHaveLength(
      2,
    );
    expect(migration?.sql).not.toMatch(
      /\b(?:credential|token|pan|cvv|customer|health|payment|provider)\b/iu,
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1600 Pickup Fulfillment migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1700_001_create_pickup_fulfillment",
    );
    expect(migration?.metadata.owner).toBe("@rms/fulfillment");
    expect(migration?.metadata.schema).toBe("rms_fulfillment");
    expect(migration?.sql).toContain("CREATE TABLE rms_fulfillment.fulfillment");
    expect(migration?.sql).toContain("CREATE TABLE rms_fulfillment.fulfillment_item");
    expect(migration?.sql).toContain("CREATE TABLE rms_fulfillment.fulfillment_creation_operation");
    expect(migration?.sql).toContain("fulfillment_order_unique");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
    expect(migration?.sql.match(/reject_fulfillment_append_only_update/gu)).toHaveLength(5);
    expect(migration?.sql).not.toMatch(
      /\b(?:customer|note|price|payment|provider|credential|token|pan|cvv|health)\b/iu,
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1601 Fulfillment readiness migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1700_002_create_fulfillment_readiness",
    );
    expect(migration?.metadata.owner).toBe("@rms/fulfillment");
    expect(migration?.metadata.schema).toBe("rms_fulfillment");
    expect(migration?.sql).toContain("CREATE TABLE rms_fulfillment.fulfillment_item_ready_result");
    expect(migration?.sql).toContain("CREATE TABLE rms_fulfillment.fulfillment_ready_operation");
    expect(migration?.sql).toContain("fulfillment_ready_operation_version_unique");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
    expect(migration?.sql.match(/reject_fulfillment_append_only_update/gu)).toHaveLength(2);
    expect(migration?.sql).not.toMatch(
      /\b(?:customer|note|price|payment|provider|credential|token|pan|cvv|health)\b/iu,
    );
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1602 Pickup Proof migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1700_003_create_pickup_proof",
    );
    expect(migration?.metadata.owner).toBe("@rms/fulfillment");
    expect(migration?.metadata.schema).toBe("rms_fulfillment");
    for (const table of [
      "pickup_proof_generation",
      "pickup_proof_invalidation",
      "pickup_proof_verification",
      "pickup_proof_operation",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_fulfillment.${table}`);
    expect(migration?.sql).toContain("expires_at <= ready_at + interval '60 minutes'");
    expect(migration?.sql).toContain("selector_hash ~ '^[0-9a-f]{64}$'");
    expect(migration?.sql.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(4);
    expect(migration?.sql.match(/reject_fulfillment_append_only_update/gu)).toHaveLength(4);
    expect(migration?.sql).not.toMatch(/\b(?:raw_proof|human_code|opaque_proof|pin|otp)\b/iu);
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1022 Option Set and Product Binding migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1102_001_create_option_set_binding",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    expect(migration?.metadata.schema).toBe("rms_catalog");
    for (const table of [
      "option_set",
      "option_set_version",
      "option",
      "option_conflict",
      "product_option_binding",
      "option_set_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1020 Catalog aggregate migration authority", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1100_001_create_product_aggregate",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    expect(migration?.metadata.schema).toBe("rms_catalog");
    expect(migration?.sql).toContain("CREATE TABLE rms_catalog.product");
    expect(migration?.sql).toContain("CREATE TABLE rms_catalog.product_version");
    expect(migration?.sql).toContain("CREATE TABLE rms_catalog.sku");
    expect(migration?.sql).toContain("CREATE TABLE rms_catalog.product_operation_record");
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-1021 Category and Menu structure migration", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (candidate) => candidate.id === "1101_001_create_category_menu_structure",
    );
    expect(migration?.metadata.owner).toBe("@rms/catalog");
    expect(migration?.metadata.schema).toBe("rms_catalog");
    for (const table of [
      "category",
      "category_operation_record",
      "menu",
      "menu_version",
      "menu_section",
      "sellable_placement",
      "menu_operation_record",
    ])
      expect(migration?.sql).toContain(`CREATE TABLE rms_catalog.${table}`);
    expect(migration?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration?.sql).toContain("enforce_category_tree");
    expect(migration?.sql).toContain("enforce_menu_inheritance");
    expect(migration?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers exact WP-2408 Category original-result/source tables and forced RLS", async () => {
    const entry = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (row) => row.id === "1101_002_create_category_source_commit",
    );
    expect(entry?.metadata.owner).toBe("@rms/catalog");
    expect(entry?.metadata.schema).toBe("rms_catalog");
    for (const name of [
      "category_operation_snapshot",
      "category_source_head",
      "category_source_commit",
    ]) {
      expect(entry?.sql).toContain(`CREATE TABLE rms_catalog.${name}`);
      expect(entry?.sql).toContain(`ALTER TABLE rms_catalog.${name} FORCE ROW LEVEL SECURITY`);
    }
    expect(entry?.sql).toContain("category_source_head_guard");
    expect(entry?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("keeps WP-0021 schema-only with the exact owner and schema sequence", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(
      catalog.migrations
        .slice(1, 5)
        .map((migration) => [migration.id, migration.metadata.owner, migration.metadata.schema]),
    ).toEqual([
      ["0000_002_alter_platform_core", "shared-infrastructure/platform-core", "platform_core"],
      ["0000_003_create_platform_eventing", "shared-infrastructure/eventing", "platform_eventing"],
      ["0000_004_create_platform_audit", "shared-infrastructure/audit", "platform_audit"],
      ["0000_005_create_platform_jobs", "shared-infrastructure/jobs", "platform_jobs"],
    ]);
    const wp0021Sql = catalog.migrations
      .slice(1, 5)
      .map((migration) => migration.sql)
      .join("\n");
    expect(wp0021Sql).not.toMatch(
      /\bCREATE\s+(?:TABLE|VIEW|MATERIALIZED|SEQUENCE|FUNCTION|TRIGGER|EXTENSION|ROLE|USER|POLICY)\b/iu,
    );
    expect(wp0021Sql).not.toContain("platform_projection");
  });

  it("registers the exact WP-0022 helper migration authority", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    expect(
      catalog.migrations
        .slice(5, 9)
        .map((migration) => [migration.id, migration.metadata.owner, migration.metadata.schema]),
    ).toEqual([
      ["0000_006_create_platform_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_007_create_uuid_money_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_008_create_time_helpers", "shared-infrastructure/helpers", "platform_helpers"],
      ["0000_009_create_tenant_scope_helpers", "shared-infrastructure/helpers", "platform_helpers"],
    ]);
  });

  it("registers the exact WP-0030 and WP-0031 Eventing migrations", async () => {
    const catalog = await readMigrationCatalog(repositoryRoot);
    const outbox = catalog.migrations.find(
      (migration) => migration.id === "0000_010_create_outbox_event",
    );
    const dispatcher = catalog.migrations.find(
      (migration) => migration.id === "0000_011_alter_outbox_dispatch",
    );
    const inbox = catalog.migrations.find(
      (migration) => migration.id === "0000_012_create_consumer_inbox",
    );
    const retry = catalog.migrations.find(
      (migration) => migration.id === "0000_013_create_retry_dead_letter",
    );
    expect(outbox).toMatchObject({
      id: "0000_010_create_outbox_event",
      metadata: {
        owner: "shared-infrastructure/eventing",
        schema: "platform_eventing",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(outbox?.sql).toContain("platform_helpers.uuid_v7");
    expect(outbox?.sql).toContain("platform_helpers.current_brand_id()");
    expect(outbox?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(dispatcher).toMatchObject({
      id: "0000_011_alter_outbox_dispatch",
      metadata: {
        owner: "shared-infrastructure/eventing",
        schema: "platform_eventing",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(dispatcher?.sql).toContain("lease_token platform_helpers.uuid_v7");
    expect(dispatcher?.sql).toContain("outbox_event_dispatch_claim_idx");
    expect(inbox).toMatchObject({
      id: "0000_012_create_consumer_inbox",
      metadata: { owner: "shared-infrastructure/eventing", schema: "platform_eventing" },
    });
    expect(inbox?.sql).toContain("consumer_inbox_tenant_scope");
    expect(retry).toMatchObject({
      id: "0000_013_create_retry_dead_letter",
      metadata: { owner: "shared-infrastructure/eventing", schema: "platform_eventing" },
    });
    expect(retry?.sql).toContain("CREATE TABLE platform_eventing.delivery_attempt");
    expect(retry?.sql).toContain("CREATE TABLE platform_eventing.dead_letter_item");
    expect(retry?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(`${outbox?.sql}\n${dispatcher?.sql}\n${inbox?.sql}\n${retry?.sql}`).not.toMatch(
      /\b(?:GRANT|CREATE ROLE|CREATE USER)\b/iu,
    );
  });

  it.each([
    "0000_019_create_platform_actor_audit",
    "0000_020_alter_platform_permission_audit_binding",
    "0000_021_alter_platform_actor_directory_audit_binding",
    "0000_022_alter_platform_template_publishing_audit_binding",
    "0000_023_alter_workforce_account_binding_audit",
    "0000_024_alter_workforce_onboarding_audit",
  ])("keeps %s under shared Audit infrastructure ownership", async (id) => {
    const audit = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (migration) => migration.id === id,
    );
    expect(audit).toMatchObject({
      metadata: {
        owner: "shared-infrastructure/audit",
        schema: "platform_audit",
        phase: "expand",
        risk: "high",
      },
    });
    expect(audit?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers immutable Workforce identity linkage without a mutable lifecycle or runtime table grants", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (value) => value.id === "0200_028_create_workforce_account_binding",
    );
    if (!migration) throw new Error("Missing Workforce binding migration");
    expect(migration.metadata).toMatchObject({
      owner: "@bop/identity",
      schema: "bop_identity",
      risk: "high",
    });
    for (const fragment of [
      "CREATE TABLE bop_identity.workforce_account_binding",
      "actor_id platform_helpers.uuid_v7 PRIMARY KEY",
      "UNIQUE(environment,issuer,subject_hash)",
      "UNIQUE(recorded_by,operation_id)",
      "audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE",
      "REFERENCES bop_identity.workforce_invitation(invitation_id)",
      "FORCE ROW LEVEL SECURITY",
      "CREATE FUNCTION bop_identity.workforce_account_binding_read(p_actor uuid,p_subject text,p_issuer text,p_environment text)",
      "CREATE FUNCTION bop_identity.workforce_account_invitation_read(p_actor uuid,p_invitation uuid)",
      "CREATE FUNCTION bop_identity.workforce_account_binding_import_admit(p_operator uuid,p_actor uuid,p_operation uuid,p_subject text)",
      "FOR SHARE OF i",
      "WITH CHECK(false)",
      "BEFORE UPDATE OR DELETE",
      "BEFORE TRUNCATE",
      "DEFERRABLE INITIALLY DEFERRED",
      "platform_audit.matches_workforce_account_binding_audit",
      "NEW.writer_transaction_id<>txid_current()",
      "REVOKE ALL ON TABLE bop_identity.workforce_account_binding FROM PUBLIC",
    ])
      expect(migration.sql).toContain(fragment);
    expect(migration.sql.match(/CREATE TABLE/gu)).toHaveLength(1);
    expect(migration.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
    expect(migration.sql).not.toMatch(/FROM\s+platform_audit\./iu);
    expect(migration.sql).not.toMatch(
      /(?:email_digest|selector_hash|authentication_session|current_status|CREATE\s+TABLE\s+[^;]*_head)/iu,
    );
  });
  it("binds Workforce import Audit to the actual operator, target, intent and top transaction", async () => {
    const migration = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (value) => value.id === "0000_023_alter_workforce_account_binding_audit",
    );
    if (!migration) throw new Error("Missing Workforce binding Audit migration");
    for (const fragment of [
      "p_purpose='WORKFORCE_ACCOUNT_BINDING'",
      "r.action_code='WORKFORCE_ACCOUNT_BOUND'",
      "r.target_type='WorkforceAccountBinding' AND r.target_id=p_actor",
      "current_setting('bop.platform_actor_id',true)",
      "current_setting('bop.platform_purpose',true)",
      "r.writer_transaction_id=pg_catalog.txid_current()",
      "r.retention_policy_code='CONFIGURATION_AUDIT' AND r.retention_policy_version=1",
      "p_audit IS NOT NULL AND p_operator IS NOT NULL",
      "p_occurred_at IS NOT NULL AND p_reason IS NOT NULL",
      "SET search_path = pg_catalog\nAS $$",
      "REVOKE ALL ON FUNCTION platform_audit.matches_workforce_account_binding_audit(uuid,uuid,text,uuid,uuid,text,timestamptz,text) FROM PUBLIC",
    ])
      expect(migration.sql).toContain(fragment);
    expect(migration.sql.match(/CREATE FUNCTION/gu)).toHaveLength(1);
    expect(migration.sql).not.toMatch(/\b(?:CREATE\s+TABLE|GRANT|INSERT|UPDATE|DELETE)\b/iu);
  });

  it("registers the exact WP-0042 Audit migration authority", async () => {
    const audit = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (migration) => migration.id === "0000_014_create_audit_record",
    );
    expect(audit).toMatchObject({
      id: "0000_014_create_audit_record",
      metadata: {
        owner: "shared-infrastructure/audit",
        schema: "platform_audit",
        phase: "expand",
        risk: "medium",
      },
    });
    expect(audit?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(audit?.sql).toContain("corrects_audit_id");
    expect(audit?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-0046 Audit integrity migration authority", async () => {
    const integrity = (await readMigrationCatalog(repositoryRoot)).migrations.find(
      (migration) => migration.id === "0000_015_alter_audit_hash_chain",
    );
    expect(integrity).toMatchObject({
      id: "0000_015_alter_audit_hash_chain",
      metadata: {
        owner: "shared-infrastructure/audit",
        schema: "platform_audit",
        phase: "expand",
        risk: "high",
      },
    });
    expect(integrity?.sql).toContain("requires an empty audit_record table");
    expect(integrity?.sql).toContain("CREATE TABLE platform_audit.audit_chain_head");
    expect(integrity?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(integrity?.sql).toContain("AUDIT_CHAIN_V1");
    expect(integrity?.sql).not.toMatch(/\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu);
  });

  it("registers the exact WP-0101, WP-0102, WP-0105, WP-0107 and WP-0108 business migration authorities", async () => {
    const migrations = (await readMigrationCatalog(repositoryRoot)).migrations.filter(
      (migration) =>
        migration.namespace === 200 ||
        migration.namespace === 300 ||
        migration.metadata.schema === "bop_permission",
    );
    expect(
      migrations.map((migration) => [
        migration.id,
        migration.metadata.owner,
        migration.metadata.schema,
      ]),
    ).toEqual([
      ["0200_001_create_tenant_organization", "@bop/tenant", "bop_tenant"],
      ["0200_002_create_operating_entity", "@bop/operating-entity", "bop_operating_entity"],
      ["0200_003_create_membership", "@bop/membership", "bop_membership"],
      ["0200_004_create_identity_session", "@bop/identity", "bop_identity"],
      ["0200_005_create_workforce_identity_security", "@bop/identity", "bop_identity"],
      ["0200_006_create_guest_session", "@bop/identity", "bop_identity"],
      ["0200_007_alter_guest_dining_binding", "@bop/identity", "bop_identity"],
      ["0200_008_create_api_client", "@bop/identity", "bop_identity"],
      [
        "0200_009_create_operating_entity_administration",
        "@bop/operating-entity",
        "bop_operating_entity",
      ],
      ["0200_010_create_brand_administration", "@bop/tenant", "bop_tenant"],
      ["0200_011_create_platform_tenant_administration", "@bop/tenant", "bop_tenant"],
      ["0200_012_create_guest_session_operation", "@bop/identity", "bop_identity"],
      ["0200_013_create_guest_binding_preparation", "@bop/identity", "bop_identity"],
      ["0200_014_create_guest_dining_binding_preparation", "@bop/identity", "bop_identity"],
      ["0200_015_alter_organization_revision_trigger", "@bop/tenant", "bop_tenant"],
      ["0200_016_create_browser_session_selection", "@bop/identity", "bop_identity"],
      ["0200_017_alter_browser_session_selection_isolation", "@bop/identity", "bop_identity"],
      ["0200_018_create_guest_entry_admission", "@bop/identity", "bop_identity"],
      ["0200_019_alter_brand_admin_artifact_snapshot", "@bop/tenant", "bop_tenant"],
      ["0200_020_create_store_reference_projection", "@bop/tenant", "bop_tenant"],
      [
        "0200_021_alter_tax_registrant_source_barrier",
        "@bop/operating-entity",
        "bop_operating_entity",
      ],
      ["0200_022_create_brand_store_topology_draft", "@bop/tenant", "bop_tenant"],
      ["0200_023_alter_store_reference_labels", "@bop/tenant", "bop_tenant"],
      ["0200_024_create_brand_configuration_authoring", "@bop/tenant", "bop_tenant"],
      ["0200_025_create_browser_brand_session_selection", "@bop/identity", "bop_identity"],
      ["0200_026_create_platform_brand_template", "@bop/tenant", "bop_tenant"],
      ["0200_027_create_platform_actor_directory", "@bop/identity", "bop_identity"],
      ["0200_028_create_workforce_account_binding", "@bop/identity", "bop_identity"],
      ["0200_029_alter_workforce_account_authentication_read", "@bop/identity", "bop_identity"],
      ["0200_030_create_brand_template_reference_read", "@bop/tenant", "bop_tenant"],
      ["0200_031_create_membership_brand_discovery_read", "@bop/membership", "bop_membership"],
      ["0200_032_create_workforce_onboarding_operation", "@bop/identity", "bop_identity"],
      ["0200_033_alter_workforce_account_binding_acceptance", "@bop/identity", "bop_identity"],
      ["0200_034_create_workforce_onboarding_invitation_read", "@bop/identity", "bop_identity"],
      ["0300_001_create_permission", "@bop/permission", "bop_permission"],
      ["0300_002_create_role_administration", "@bop/permission", "bop_permission"],
      ["0300_003_create_workflow_definition", "@bop/workflow", "bop_workflow"],
      ["0300_004_alter_permission_action_identifiers", "@bop/permission", "bop_permission"],
      ["0300_005_alter_option_read_action_identifier", "@bop/permission", "bop_permission"],
      [
        "0300_006_create_system_media_image_promotion_authorization",
        "@bop/permission",
        "bop_permission",
      ],
      ["0300_007_alter_option_authoring_action_identifiers", "@bop/permission", "bop_permission"],
      ["0300_008_alter_option_publication_action_identifier", "@bop/permission", "bop_permission"],
      ["0300_009_alter_option_history_action_identifier", "@bop/permission", "bop_permission"],
      ["0300_010_create_platform_permission", "@bop/permission", "bop_permission"],
      ["2000_001_alter_permission_catalog_identifiers", "@bop/permission", "bop_permission"],
      ["2000_002_create_permission_catalog_revision", "@bop/permission", "bop_permission"],
      ["2000_003_create_store_role_provisioning", "@bop/permission", "bop_permission"],
      ["2000_004_alter_store_role_provisioning_upgrade", "@bop/permission", "bop_permission"],
      ["2000_006_create_role_assignment_change", "@bop/permission", "bop_permission"],
      ["2000_010_create_brand_role_provisioning", "@bop/permission", "bop_permission"],
    ]);
    const permission = migrations.find(
      (migration) => migration.id === "0300_001_create_permission",
    );
    expect(permission?.sql).toContain("CREATE TABLE bop_permission.policy_state");
    expect(permission?.sql).toContain("CREATE TABLE bop_permission.permission_override");
    expect(permission?.sql).toContain("FORCE ROW LEVEL SECURITY");
    const workforceSecurity = migrations.find(
      (migration) => migration.id === "0200_005_create_workforce_identity_security",
    );
    expect(workforceSecurity?.sql).toContain("CREATE TABLE bop_identity.workforce_invitation");
    expect(workforceSecurity?.sql).toContain(
      "CREATE TABLE bop_identity.session_revocation_request",
    );
    const guestSession = migrations.find(
      (migration) => migration.id === "0200_006_create_guest_session",
    );
    expect(guestSession?.sql).toContain("CREATE TABLE bop_identity.guest_session");
    expect(guestSession?.sql).toContain("FORCE ROW LEVEL SECURITY");
    const apiClient = migrations.find((migration) => migration.id === "0200_008_create_api_client");
    expect(apiClient?.sql).toContain("CREATE TABLE bop_identity.api_client");
    expect(apiClient?.sql).toContain("CREATE TABLE bop_identity.api_client_credential_metadata");
    expect(apiClient?.sql).toContain("FORCE ROW LEVEL SECURITY");
    const entityAdmin = migrations.find(
      (migration) => migration.id === "0200_009_create_operating_entity_administration",
    );
    expect(entityAdmin?.sql).toContain(
      "CREATE TABLE bop_operating_entity.operating_entity_profile_version",
    );
    expect(entityAdmin?.sql).toContain(
      "CREATE TABLE bop_operating_entity.business_function_assignment_decision",
    );
    expect(entityAdmin?.sql).toContain("FORCE ROW LEVEL SECURITY");
    const brandAdmin = migrations.find(
      (migration) => migration.id === "0200_010_create_brand_administration",
    );
    expect(brandAdmin?.sql).toContain("CREATE TABLE bop_tenant.brand_configuration_version");
    expect(brandAdmin?.sql).toContain("CREATE TABLE bop_tenant.brand_store_membership_record");
    expect(brandAdmin?.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(migrations.map((migration) => migration.sql).join("\n")).not.toMatch(
      /\b(?:GRANT|CREATE\s+(?:ROLE|USER))\b/iu,
    );
  });

  it("rejects any non-allowlisted foreign helper reference", async () => {
    const root = await fixture();
    const file = path.join(root, "migrations", "0000-platform", "0000_010_create_outbox_event.sql");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}SELECT platform_helpers.unapproved_helper();\n`,
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_SCHEMA_MISMATCH",
    );
  });

  it.each([
    "private-table",
    "other-function",
    "bare-relation",
    "other-permission-migration",
    "other-owner",
  ])(
    "keeps the Platform Permission Audit public function admission narrow: %s",
    async (changed) => {
      const root = await fixture();
      const permissionFile = path.join(
        root,
        "migrations/0300-bop-governance/0300_010_create_platform_permission.sql",
      );
      const file =
        changed === "other-owner"
          ? path.join(
              root,
              "migrations/0200-bop-identity-tenancy/0200_026_create_platform_brand_template.sql",
            )
          : changed === "other-permission-migration"
            ? path.join(root, "migrations/0300-bop-governance/0300_001_create_permission.sql")
            : permissionFile;
      const reference =
        changed === "private-table"
          ? "platform_audit.platform_actor_audit_record"
          : changed === "other-function"
            ? "platform_audit.other_predicate()"
            : changed === "bare-relation"
              ? "platform_audit.matches_platform_permission_audit"
              : "platform_audit.matches_platform_permission_audit(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";
      await writeFile(file, `${await readFile(file, "utf8")}\nSELECT ${reference};\n`);
      expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
        "MIGRATION_SCHEMA_MISMATCH",
      );
    },
  );
  it.each([
    "private-table",
    "other-function",
    "bare-relation",
    "other-identity-migration",
    "other-owner",
  ])(
    "keeps the Platform Actor Directory Audit public function admission narrow: %s",
    async (changed) => {
      const root = await fixture();
      const permissionFile = path.join(
        root,
        "migrations/0200-bop-identity-tenancy/0200_027_create_platform_actor_directory.sql",
      );
      const file =
        changed === "other-owner"
          ? path.join(
              root,
              "migrations/0200-bop-identity-tenancy/0200_026_create_platform_brand_template.sql",
            )
          : changed === "other-identity-migration"
            ? path.join(
                root,
                "migrations/0200-bop-identity-tenancy/0200_004_create_identity_session.sql",
              )
            : permissionFile;
      const reference =
        changed === "private-table"
          ? "platform_audit.platform_actor_audit_record"
          : changed === "other-function"
            ? "platform_audit.other_predicate()"
            : changed === "bare-relation"
              ? "platform_audit.matches_platform_actor_directory_audit"
              : "platform_audit.matches_platform_actor_directory_audit(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";
      await writeFile(file, `${await readFile(file, "utf8")}\nSELECT ${reference};\n`);
      expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
        "MIGRATION_SCHEMA_MISMATCH",
      );
    },
  );
  for (const [source, predicate] of [
    [
      "migrations/0200-bop-identity-tenancy/0200_028_create_workforce_account_binding.sql",
      "platform_audit.matches_workforce_account_binding_audit",
    ],
    [
      "migrations/0200-bop-identity-tenancy/0200_033_alter_workforce_account_binding_acceptance.sql",
      "platform_audit.matches_workforce_account_binding_audit",
    ],
    [
      "migrations/0200-bop-identity-tenancy/0200_032_create_workforce_onboarding_operation.sql",
      "platform_audit.matches_workforce_onboarding_operation_audit",
    ],
  ] as const) {
    it.each([
      "valid",
      "private-table",
      "other-function",
      "bare-relation",
      "other-identity-migration",
      "other-owner",
      "other-schema",
    ])(source + " public Audit function admission stays narrow: %s", async (changed) => {
      const root = await fixture();
      const file = path.join(
        root,
        changed === "other-identity-migration"
          ? "migrations/0200-bop-identity-tenancy/0200_027_create_platform_actor_directory.sql"
          : source,
      );
      let sql = await readFile(file, "utf8");
      if (changed === "other-owner")
        sql = sql.replace("-- owner: @bop/identity", "-- owner: @bop/tenant");
      if (changed === "other-schema")
        sql = sql.replace("-- schema: bop_identity", "-- schema: bop_tenant");
      const reference =
        changed === "private-table"
          ? "platform_audit.platform_actor_audit_record"
          : changed === "other-function"
            ? "platform_audit.matches_platform_actor_directory_audit(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)"
            : changed === "bare-relation"
              ? predicate
              : predicate + "(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";
      await writeFile(file, `${sql}\nSELECT ${reference};\n`);
      const codes = (await readMigrationCatalog(root)).diagnostics.map((item) => item.code);
      if (changed === "valid") expect(codes).not.toContain("MIGRATION_SCHEMA_MISMATCH");
      else expect(codes).toContain("MIGRATION_SCHEMA_MISMATCH");
    });
  }

  it.each([
    "private-table",
    "other-function",
    "bare-relation",
    "other-publishing-migration",
    "other-owner",
  ])(
    "keeps the Platform Template Publishing Audit public function admission narrow: %s",
    async (changed) => {
      const root = await fixture();
      const permissionFile = path.join(
        root,
        "migrations/0400-bop-operations/0400_018_create_platform_publishing_mutation.sql",
      );
      const file =
        changed === "other-owner"
          ? path.join(
              root,
              "migrations/0200-bop-identity-tenancy/0200_026_create_platform_brand_template.sql",
            )
          : changed === "other-publishing-migration"
            ? path.join(
                root,
                "migrations/0400-bop-operations/0400_006_create_publishing_mutation.sql",
              )
            : permissionFile;
      const reference =
        changed === "private-table"
          ? "platform_audit.platform_actor_audit_record"
          : changed === "other-function"
            ? "platform_audit.other_predicate()"
            : changed === "bare-relation"
              ? "platform_audit.matches_platform_template_publishing_audit"
              : "platform_audit.matches_platform_template_publishing_audit(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";
      await writeFile(file, `${await readFile(file, "utf8")}\nSELECT ${reference};\n`);
      expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
        "MIGRATION_SCHEMA_MISMATCH",
      );
    },
  );

  it.each(["1800-rms-reporting", "1900-rms-inventory"])(
    "rejects a changed namespace registry: %s",
    async (directory) => {
      const root = await fixture();
      const registry = path.join(root, "migrations", "namespaces.json");
      await writeFile(
        registry,
        (await readFile(registry, "utf8")).replace(directory, directory + "-changed"),
      );
      expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
        "MIGRATION_NAMESPACE_UNKNOWN",
      );
    },
  );

  it("rejects metadata order and values", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, (await readFile(file, "utf8")).replace("-- risk: low", "-- phase: low"));
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("rejects CRLF and missing final newline bytes", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("\n", "\r\n").trimEnd());
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("rejects a platform owner mismatch", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "shared-infrastructure/platform-core",
        "shared-infrastructure/eventing",
      ),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_OWNER_MISMATCH",
    );
  });

  it("rejects runner-owned or non-transactional SQL", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}COMMIT;\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_TRANSACTION_UNSUPPORTED",
    );
  });

  it("allows only a fixed pg_catalog search path inside a function definition", async () => {
    const clean = await readMigrationCatalog(repositoryRoot);
    expect(clean.diagnostics).toEqual([]);
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}SET search_path = pg_catalog;\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_TRANSACTION_UNSUPPORTED",
    );
  });

  it.each(["CREATE", "CREATE OR REPLACE"])(
    "does not confuse a %s PL/pgSQL block with runner-owned transaction control",
    async (declaration) => {
      const root = await fixture();
      const file = migrationPath(root);
      await writeFile(
        file,
        `${await readFile(file, "utf8")}
${declaration} FUNCTION platform_core.wp1021_trigger_probe() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN NEW;
END;
$$;
`,
      );
      expect((await readMigrationCatalog(root)).diagnostics).toEqual([]);
    },
  );

  it("still rejects transaction control hidden in a non-function dollar quote", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}
DO $unsafe$
BEGIN
  COMMIT;
END;
$unsafe$;
`,
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_TRANSACTION_UNSUPPORTED",
    );
  });

  it("rejects database, role, tablespace, or extension DDL", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}CREATE EXTENSION pg_trgm;\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_METADATA_INVALID",
    );
  });

  it("does not confuse a PostgreSQL cast with template substitution", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}SELECT 1::integer;\n`);
    expect((await readMigrationCatalog(root)).diagnostics).toEqual([]);
  });

  it("WP-2282 accepts quoted Closing data, date formats and CASE END expressions", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}SELECT 'Begin', 'END', 'HH24:MI:SS', CASE WHEN true THEN 'Closing' ELSE 'Active' END;\n`,
    );
    expect((await readMigrationCatalog(root)).diagnostics).toEqual([]);
  });
  it.each([
    "SELECT 'Begin'; COMMIT;",
    "SELECT '餐厅'; COMMIT;",
    "SELECT CASE WHEN true THEN CASE WHEN false THEN 1 ELSE 2 END ELSE 3 END; COMMIT;",
    "SELECT 'can''t hide'; ROLLBACK;",
    "-- 'quoted comment\nCOMMIT;",
    "/* outer ' /* nested */ */ BEGIN;",
    "SELECT CASE WHEN true THEN 1 ELSE 2 END; END TRANSACTION;",
    "DO $unsafe$ BEGIN COMMIT; END; $unsafe$;",
    "DO 'BEGIN COMMIT; END';",
    "END",
    "END /* comment */ WORK",
  ])("WP-2282 still rejects executable transaction SQL: %s", async (sql) => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(file, `${await readFile(file, "utf8")}${sql}\n`);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_TRANSACTION_UNSUPPORTED",
    );
  });
  it.each(["SELECT :placeholder;", "SELECT '${value}';", "SELECT '{{value}}';"])(
    "WP-2282 retains substitution denial: %s",
    async (sql) => {
      const root = await fixture();
      const file = migrationPath(root);
      await writeFile(file, `${await readFile(file, "utf8")}${sql}\n`);
      expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
        "MIGRATION_METADATA_INVALID",
      );
    },
  );

  it("rejects duplicate global order", async () => {
    const root = await fixture();
    const directory = path.dirname(migrationPath(root));
    const source = await readFile(migrationPath(root));
    await writeFile(path.join(directory, "0000_001_alter_migration_history.sql"), source);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_DUPLICATE_ORDER",
    );
  });

  it("rejects case-fold-colliding migration filenames", async () => {
    expect(
      findCaseFoldConflicts([
        "0000_001_create_migration_history.sql",
        "0000_001_CREATE_MIGRATION_HISTORY.sql",
      ]),
    ).toEqual(
      new Map([["0000_001_CREATE_MIGRATION_HISTORY.sql", "0000_001_create_migration_history.sql"]]),
    );
  });

  it("rejects an unqualified DDL target", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "CREATE TABLE platform_core.migration_history",
        "CREATE TABLE migration_history",
      ),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_SCHEMA_MISMATCH",
    );
  });

  it("closes module namespaces and admits later migrations only in the release namespace", async () => {
    const root = await fixture();
    const source = path.join(
      root,
      "migrations/2000-release-001/2000_002_create_permission_catalog_revision.sql",
    );
    const sql = (await readFile(source, "utf8")).replaceAll(
      "permission_catalog_revision",
      "permission_catalog_probe",
    );
    await writeFile(
      path.join(
        root,
        "migrations/0300-bop-governance/0300_011_create_permission_catalog_probe.sql",
      ),
      sql,
    );
    expect(
      (await readMigrationCatalog(root)).diagnostics.map((item) => [item.code, item.file]),
    ).toContainEqual([
      "MIGRATION_NAMESPACE_CLOSED",
      "migrations/0300-bop-governance/0300_011_create_permission_catalog_probe.sql",
    ]);
    await rm(
      path.join(
        root,
        "migrations/0300-bop-governance/0300_011_create_permission_catalog_probe.sql",
      ),
    );
    await writeFile(
      path.join(root, "migrations/2000-release-001/2000_900_create_permission_catalog_probe.sql"),
      sql,
    );
    const catalog = await readMigrationCatalog(root);
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.migrations.at(-1)?.id).toBe("2000_900_create_permission_catalog_probe");
  });

  it("rejects a symbolic namespace registry", async () => {
    const root = await fixture();
    const registry = path.join(root, "migrations", "namespaces.json");
    const outside = path.join(root, "outside-namespaces.json");
    await writeFile(outside, await readFile(registry));
    await rm(registry);
    await symlink(outside, registry);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects a symbolic root migration catalog", async () => {
    const root = await fixture();
    const catalog = path.join(root, "migrations");
    const outside = path.join(root, "outside-migrations");
    await rename(catalog, outside);
    await symlink(outside, catalog);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects symbolic migration files", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    const outside = path.join(root, "outside.sql");
    await writeFile(outside, await readFile(file));
    await rm(file);
    await symlink(outside, file);
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "SYMLINK_PATH",
    );
  });

  it("rejects unknown namespace entries and case-fold collisions", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "migrations", "0000-platform-unknown"));
    const codes = (await readMigrationCatalog(root)).diagnostics.map((item) => item.code);
    expect(codes).toContain("MIGRATION_NAMESPACE_UNKNOWN");
    expect(findCaseFoldConflicts(["0000-platform", "0000-Platform"])).toEqual(
      new Map([["0000-Platform", "0000-platform"]]),
    );
  });
});

it("registers version-local immutable Recipe V2 measurement content", async () => {
  const catalog = await readMigrationCatalog(repositoryRoot);
  const migration = catalog.migrations.find(
    (value) => value.id === "1250_010_create_recipe_measurement_content",
  );
  expect(migration?.metadata).toMatchObject({
    owner: "@rms/recipe",
    schema: "rms_recipe",
    phase: "expand",
  });
  const sql = await readFile(
    path.join(
      repositoryRoot,
      "migrations/1250-rms-recipe/1250_010_create_recipe_measurement_content.sql",
    ),
    "utf8",
  );
  for (const clause of [
    "-- transaction: required",
    "FORCE ROW LEVEL SECURITY",
    "recipe_measurement_version_fk",
    "RecipeCatalogReferenceV1:",
    "actual_snapshot IS DISTINCT FROM NEW.content_json->'snapshot'",
    "DO INSTEAD NOTHING",
    "recipe_measurement_no_truncate",
    "REVOKE ALL ON TABLE",
  ])
    expect(sql).toContain(clause);
  expect(sql).not.toMatch(
    /ALTER TABLE rms_recipe.recipe_version|UPDATE rms_recipe.recipe_version|INSERT INTO rms_recipe.recipe_measurement_content/,
  );
});

it("registers a forward Permission fix for only the accepted Section88 Option read action", async () => {
  const result = await readMigrationCatalog(repositoryRoot);
  const migration = result.migrations.find(
    (m) => m.id === "0300_005_alter_option_read_action_identifier",
  );
  expect(result.diagnostics).toEqual([]);
  expect(migration?.metadata).toMatchObject({
    owner: "@bop/permission",
    schema: "bop_permission",
    phase: "expand",
    recovery: "forward-fix",
    lockTimeoutMs: 5000,
    statementTimeoutMs: 60000,
  });
  expect(migration?.sql).toContain("-- transaction: required");
  expect(migration?.sql.match(/action_code = 'catalog\.option_set\.read'/gu)).toHaveLength(2);
  expect(migration?.sql).not.toMatch(/\b(?:GRANT|INSERT|CREATE\s+(?:ROLE|USER))\b/iu);
});

it("registers the forward Option release chronology fix while preserving the complete immutable source guard", async () => {
  const catalog = await readMigrationCatalog(repositoryRoot);
  expect(catalog.diagnostics).toEqual([]);
  const migration = catalog.migrations.find(
    (candidate) => candidate.id === "1102_008_alter_option_set_release_chronology",
  );
  expect(migration?.metadata).toMatchObject({
    owner: "@rms/catalog",
    schema: "rms_catalog",
    phase: "expand",
    risk: "medium",
    recovery: "forward-fix",
    lockTimeoutMs: 5000,
    statementTimeoutMs: 60000,
  });
  if (!migration) throw new Error("Missing Option release chronology migration");
  const oldSql = await readFile(
    path.join(
      repositoryRoot,
      "migrations/1102-rms-catalog-option-set/1102_005_create_option_set_review_release.sql",
    ),
    "utf8",
  );
  const originalBody = oldSql.slice(
    oldSql.indexOf("DECLARE source_row rms_catalog.option_set_draft_content_snapshot%ROWTYPE;"),
    oldSql.indexOf("CREATE CONSTRAINT TRIGGER option_set_review_source_coherent"),
  );
  const replacementBody = migration.sql.slice(
    migration.sql.indexOf(
      "DECLARE source_row rms_catalog.option_set_draft_content_snapshot%ROWTYPE;",
    ),
  );
  // The only predicate change is the real three-event chronology. All original
  // Review/Release tuple, digest, full-content and lifecycle checks stay exact.
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  expect(normalize(replacementBody)).toBe(
    normalize(
      originalBody.replace(
        "sealed_row.sealed_at=NEW.recorded_at",
        "review_row.recorded_at<=sealed_row.sealed_at AND sealed_row.sealed_at<=NEW.recorded_at",
      ),
    ),
  );
  expect(migration.sql).toContain(
    "CREATE OR REPLACE FUNCTION rms_catalog.option_set_review_release_coherent()",
  );
  expect(migration.sql).toContain("SET search_path = pg_catalog\nAS $$");
  expect(migration.sql).toContain(
    "review_row.recorded_at<=sealed_row.sealed_at AND sealed_row.sealed_at<=NEW.recorded_at",
  );
  expect(migration.sql).not.toContain("sealed_row.sealed_at=NEW.recorded_at");
  expect(migration.sql).toContain(
    "REVOKE ALL ON FUNCTION rms_catalog.option_set_review_release_coherent() FROM PUBLIC;",
  );
  expect(migration.sql).not.toMatch(
    /\b(?:GRANT|UPDATE|DELETE|INSERT|ALTER|DROP|CREATE\s+(?:TABLE|TRIGGER|ROLE|USER))\b/iu,
  );
});

it("extends only fixed Workforce authentication helper admission without runtime table grants", async () => {
  const catalog = await readMigrationCatalog(repositoryRoot);
  expect(catalog.diagnostics).toEqual([]);
  const migration = catalog.migrations.find(
    (value) => value.id === "0200_029_alter_workforce_account_authentication_read",
  );
  if (!migration) throw new Error("Missing Workforce authentication read migration");
  expect(migration.metadata).toMatchObject({
    owner: "@bop/identity",
    schema: "bop_identity",
    phase: "expand",
    risk: "high",
    recovery: "forward-fix",
  });
  for (const fragment of [
    "ALTER POLICY workforce_account_binding_read",
    "ALTER POLICY workforce_account_binding_lock",
    "CREATE OR REPLACE FUNCTION bop_identity.workforce_account_binding_read(p_actor uuid,p_subject text,p_issuer text,p_environment text)",
    "CREATE OR REPLACE FUNCTION bop_identity.workforce_account_invitation_read(p_actor uuid,p_invitation uuid)",
    "(p_actor IS NULL)=(p_subject IS NULL)",
    "current_setting('bop.workforce_account_purpose',true) NOT IN ('WORKFORCE_ACCOUNT_BINDING','WORKFORCE_AUTHENTICATION')",
    "b.original_membership_id=i.membership_id AND b.provider_evidence_id=i.provider_evidence_id",
    "FOR SHARE OF b",
    "FOR SHARE OF i",
    "WITH CHECK(false)",
    "SET search_path = pg_catalog\nAS $$",
    "REVOKE ALL ON FUNCTION bop_identity.workforce_account_binding_read(uuid,text,text,text) FROM PUBLIC;",
    "REVOKE ALL ON FUNCTION bop_identity.workforce_account_invitation_read(uuid,uuid) FROM PUBLIC;",
  ])
    expect(migration.sql).toContain(fragment);
  expect(migration.sql.match(/CREATE OR REPLACE FUNCTION/gu)).toHaveLength(2);
  expect(migration.sql).not.toMatch(
    /\b(?:GRANT|INSERT|DELETE|TRUNCATE|CREATE\s+(?:TABLE|TRIGGER|ROLE|USER))\b/iu,
  );
  expect(migration.sql).not.toMatch(
    /platform_audit|authentication_session|platform_actor_directory|email_digest|selector_hash/iu,
  );
});

describe.each([
  [
    "0200-bop-identity-tenancy",
    "0200_030_create_brand_template_reference_read",
    "@bop/tenant",
    "bop_tenant",
  ],
  [
    "0200-bop-identity-tenancy",
    "0200_031_create_membership_brand_discovery_read",
    "@bop/membership",
    "bop_membership",
  ],
  [
    "0400-bop-operations",
    "0400_019_create_brand_template_publication_read",
    "@bop/publishing",
    "bop_publishing",
  ],
])("Brand Template UUID helper admission: %s", (directory, id, owner, schema) => {
  it.each([
    "valid",
    "other-file",
    "other-owner",
    "other-schema",
    "other-function",
    "bare-relation",
  ])("retains the exact public call boundary: %s", async (changed) => {
    const root = await fixture();
    let file = path.join(root, "migrations", directory, `${id}.sql`);
    let sql = await readFile(file, "utf8");
    if (changed === "other-file") {
      const replacement = file.replace("_create_", "_create_other_");
      await rename(file, replacement);
      file = replacement;
    }
    if (changed === "other-owner")
      sql = sql.replace(`-- owner: ${owner}`, "-- owner: @bop/identity");
    if (changed === "other-schema")
      sql = sql.replace(`-- schema: ${schema}`, "-- schema: bop_identity");
    const reference =
      changed === "other-function"
        ? "platform_helpers.other_uuid_check(NULL)"
        : changed === "bare-relation"
          ? "platform_helpers.is_uuid_v7"
          : "platform_helpers.is_uuid_v7(NULL)";
    await writeFile(file, `${sql}\nSELECT ${reference};\n`);
    const diagnostics = (await readMigrationCatalog(root)).diagnostics;
    if (changed === "valid") expect(diagnostics).toEqual([]);
    else expect(diagnostics.map((item) => item.code)).toContain("MIGRATION_SCHEMA_MISMATCH");
  });
});

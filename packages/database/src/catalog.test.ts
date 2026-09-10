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
      "0300_001_create_permission",
      "0300_002_create_role_administration",
      "0400_001_create_feature_control_administration",
      "0400_002_create_live_gate_workflow",
      "0400_003_create_support_case",
      "1000_001_create_store_configuration",
      "1001_001_create_dining_table",
      "1001_002_create_dining_session_start",
      "1001_003_create_dining_join_regeneration",
      "1001_004_create_dining_session_join",
      "1001_005_create_dining_closing_operation",
      "1001_006_create_dining_move_operation",
      "1001_007_alter_moved_join_regeneration",
      "1001_008_create_dining_admission_consumption",
      "1100_001_create_product_aggregate",
      "1101_001_create_category_menu_structure",
      "1102_001_create_option_set_binding",
      "1103_001_create_availability_rule",
      "1104_001_create_menu_publication",
      "1105_001_create_published_menu_projection",
      "1106_001_create_allergen_provenance",
      "1106_002_alter_catalog_function_permissions",
      "1107_001_create_bundle_aggregate",
      "1107_002_alter_availability_workbench",
      "1200_001_create_tax_configuration",
      "1200_002_create_price_book",
      "1200_003_create_price_quote",
      "1200_004_create_price_book_admin_projection",
      "1200_005_create_tax_config_admin_projection",
      "1200_006_create_promotion_management",
      "1200_007_alter_price_quote_snapshot",
      "1200_008_alter_price_quote_line_source",
      "1200_009_create_price_quote_request",
      "1250_001_create_recipe_management",
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
      "1400_001_create_payment_intent",
      "1400_002_create_provider_webhook_inbox",
      "1400_003_create_payment_terminal_fact",
      "1400_004_create_payment_status_projection",
      "1400_005_create_payment_reconciliation",
      "1500_001_create_kitchen_ticket_aggregate",
      "1500_002_create_kitchen_work_queue_projection",
      "1500_003_create_kitchen_work_lifecycle",
      "1500_004_create_kitchen_ready_publication",
      "1500_005_create_kitchen_allergen_safety",
      "1500_006_create_kds_continuity",
      "1500_007_create_production_batch",
      "1600_001_create_device_management",
      "1600_002_create_kds_profile_management",
      "1700_001_create_pickup_fulfillment",
      "1700_002_create_fulfillment_readiness",
      "1700_003_create_pickup_proof",
      "1700_004_create_pickup_handoff",
      "1700_005_create_fulfillment_completion_publication",
      "1800_001_create_report_definition",
      "1800_002_create_report_run",
      "1800_003_create_metric_definition",
      "1800_004_create_data_quality_reconciliation",
      "1800_005_create_pipeline_run",
      "1800_006_create_export_job",
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
      (migration) => migration.namespace === 200 || migration.namespace === 300,
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
      ["0300_001_create_permission", "@bop/permission", "bop_permission"],
      ["0300_002_create_role_administration", "@bop/permission", "bop_permission"],
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

  it("rejects a changed namespace registry", async () => {
    const root = await fixture();
    const registry = path.join(root, "migrations", "namespaces.json");
    await writeFile(
      registry,
      (await readFile(registry, "utf8")).replace("1800-rms-reporting", "1800-rms-report"),
    );
    expect((await readMigrationCatalog(root)).diagnostics.map((item) => item.code)).toContain(
      "MIGRATION_NAMESPACE_UNKNOWN",
    );
  });

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

  it("does not confuse a PL/pgSQL block with runner-owned transaction control", async () => {
    const root = await fixture();
    const file = migrationPath(root);
    await writeFile(
      file,
      `${await readFile(file, "utf8")}
CREATE FUNCTION platform_core.wp1021_trigger_probe() RETURNS trigger
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
  });

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

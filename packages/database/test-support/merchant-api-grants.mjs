/** The grants the pilot API role holds for Brand Products (docs/spec/pilot-acl-additions.json). */
export const productApiGrants = [
  "GRANT USAGE ON SCHEMA rms_catalog,rms_pricing,platform_audit,platform_helpers,platform_eventing TO ROLE_",
  "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_version TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.sku TO ROLE_",
  "GRANT SELECT,DELETE ON rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head TO ROLE_",
  "GRANT SELECT ON rms_catalog.product_publication_revision TO ROLE_",
  "GRANT SELECT ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO ROLE_",
  "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
  "GRANT INSERT ON platform_eventing.outbox_event TO ROLE_",
];

/** The pilot API role's grants for Brand option sets and product bindings (pilot-acl-additions.json). */
export const optionSetApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option TO ROLE_",
  "GRANT SELECT,INSERT,DELETE ON rms_catalog.option_conflict TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_operation_snapshot TO ROLE_",
  "GRANT INSERT ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO ROLE_",
];

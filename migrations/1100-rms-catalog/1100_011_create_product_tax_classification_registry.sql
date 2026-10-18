-- bop-rms-migration: 1
-- owner: @rms/catalog
-- schema: rms_catalog
-- phase: expand
-- risk: medium
-- transaction: required
-- lock-timeout-ms: 5000
-- statement-timeout-ms: 60000
-- recovery: forward-fix
-- Stable Catalog classification identities and explicit Brand defaults only.
-- Rates, treatments, registrations and legal conclusions belong to their owners.
CREATE TABLE rms_catalog.product_tax_classification_registry_record (
 operation_id platform_helpers.uuid_v7 PRIMARY KEY,
 tenant_id platform_helpers.uuid_v7 NOT NULL,
 brand_id platform_helpers.uuid_v7 NOT NULL,
 registry_id platform_helpers.uuid_v7 NOT NULL,
 version_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 registry_version integer NOT NULL CHECK(registry_version>0),
 actor_id platform_helpers.uuid_v7 NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL CHECK(date_trunc('milliseconds',occurred_at)=occurred_at),
 command_json jsonb NOT NULL CHECK(jsonb_typeof(command_json)='object' AND octet_length(command_json::text)<=1114112),
 snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object' AND octet_length(snapshot_json::text)<=1048576),
 event_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 audit_id platform_helpers.uuid_v7 NOT NULL UNIQUE,
 data_classification text NOT NULL DEFAULT 'ConfigurationMetadata' CHECK(data_classification='ConfigurationMetadata'),
 UNIQUE(tenant_id,brand_id,registry_version),
 UNIQUE(registry_id,registry_version),
 CHECK((snapshot_json->>'profile') IS NOT DISTINCT FROM 'CatalogProductTaxClassificationRegistryV1'),
 CHECK((snapshot_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((snapshot_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((snapshot_json->>'registryReference') IS NOT DISTINCT FROM registry_id::text),
 CHECK((snapshot_json->>'versionReference') IS NOT DISTINCT FROM version_id::text),
 CHECK((snapshot_json->'registryVersion') IS NOT DISTINCT FROM to_jsonb(registry_version)),
 CHECK((jsonb_typeof(snapshot_json->'definitions')='array' AND jsonb_array_length(snapshot_json->'definitions')<=1000) IS TRUE),
 CHECK(snapshot_json ? 'defaultClassificationReference'),
 CHECK((snapshot_json->'defaultClassificationReference'='null'::jsonb OR
   (jsonb_typeof(snapshot_json->'defaultClassificationReference')='string' AND
    jsonb_path_exists(snapshot_json,'$.definitions[*] ? (@.classificationReference == $reference && @.lifecycle == "Active")',
      jsonb_build_object('reference',snapshot_json->'defaultClassificationReference')))) IS TRUE),
 CHECK((command_json->'registry') IS NOT DISTINCT FROM snapshot_json),
 CHECK((command_json->>'purposeCode') IS NOT DISTINCT FROM 'CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY'),
 CHECK((command_json->>'actorKind') IS NOT DISTINCT FROM 'User'),
 CHECK((command_json->>'tenantReference') IS NOT DISTINCT FROM tenant_id::text),
 CHECK((command_json->>'brandReference') IS NOT DISTINCT FROM brand_id::text),
 CHECK((command_json->>'actorReference') IS NOT DISTINCT FROM actor_id::text),
 CHECK((command_json->>'operationReference') IS NOT DISTINCT FROM operation_id::text),
 CHECK((command_json->'expectedRegistryVersion') IS NOT DISTINCT FROM to_jsonb(registry_version-1)),
 CHECK((command_json->>'occurredAt') IS NOT DISTINCT FROM to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CHECK((snapshot_json->>'registeredAt') IS NOT DISTINCT FROM (command_json->>'occurredAt'))
);
CREATE TRIGGER product_tax_classification_registry_immutable
 BEFORE UPDATE OR DELETE ON rms_catalog.product_tax_classification_registry_record
 FOR EACH ROW EXECUTE FUNCTION rms_catalog.product_publication_immutable();
ALTER TABLE rms_catalog.product_tax_classification_registry_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE rms_catalog.product_tax_classification_registry_record FORCE ROW LEVEL SECURITY;
CREATE POLICY product_tax_classification_registry_scope ON rms_catalog.product_tax_classification_registry_record
 USING (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL)
 WITH CHECK (tenant_id::text=current_setting('bop.tenant_id',true) AND brand_id=platform_helpers.current_brand_id() AND platform_helpers.current_store_id() IS NULL);
REVOKE ALL ON TABLE rms_catalog.product_tax_classification_registry_record FROM PUBLIC;
